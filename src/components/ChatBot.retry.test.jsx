// src/components/ChatBot.retry.test.jsx — Retry on a failed request's error bubble, through the whole chat: it asks
// the same request again in ONE request that ends on the user's question (or on the suggestions' prompt) and carries
// no partial reply; the question is stored once, every partial reply that arrived stays on screen and in the store,
// and the reply follows them; a retry that fails again leaves one retryable bubble, whichever attempts had text; Retry
// shows on the last message alone and never while a reply streams; a Retry clicked twice in one act starts one
// request; a reload that lands between the click and the placeholder still stores the question with its reply; a
// question deleted while a retry streams leaves no Retry; a change of the whole store while a retry streams drops it
// unwritten and leaves no Retry, while a change to this chat alone is ignored as for any reply; a retry that fails
// while its request is built puts up a new alert node; one chat write per reply on the retry path; and no error bubble,
// retry record or pending flag reaches localStorage, the outbox, the account or an export on any write path.
// The mechanics are the stream pin file's: StrictMode, as main.jsx renders App; askLLM answered through the fetch
// recorder with a fresh body the test drives per request; streams on real timers; requestAnimationFrame a manual queue
// (restoreMocks puts the real one back, and window.confirm, before the next test).
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ChatBot from './ChatBot.jsx';
import { LocalStorageBackend, emitStoreChanged, exportAll, setBackend, setChatHistory } from '../lib/store.js';
import { SupabaseBackend } from '../lib/SupabaseBackend.js';
import { CONTEXT_UPDATE_PROMPT } from '../lib/chatMessages.js';
import { withContexts } from '../test/contexts.jsx';
import { installFetchRecorder } from '../../test/helpers/fetch.js';
import { fakeSupabase } from '../../test/helpers/fakeSupabase.js';

/** Market data the context builds from without a throw: the ticker and empty collections. */
const dataFor = (ticker) => ({ ticker, kpis: {}, gexByStrike: [], flowHistory: [] });
/** Market data the context builder throws on (a missing callVolume): the request fails while it is built. */
const THROWING = {
  ...dataFor('AVGO'),
  flowHistory: [
    { date: '2026-09-24', netPremium: 800_000, cumPremium: 800_000, callVolume: 450, putVolume: 380 },
    { date: '2026-09-25', netPremium: 1_250_000, cumPremium: 2_050_000, callVolume: undefined, putVolume: 410 },
  ],
};

/** The chat as App renders it: open, premium, on AVGO's data unless `data` says otherwise, under StrictMode. */
const chat = ({ data = dataFor('AVGO') } = {}) => (
  <StrictMode>
    {withContexts(
      <ChatBot isOpen={true} onClose={() => {}} onOpenSettings={() => {}} costBasis={90} shares={100} />,
      { market: { data }, auth: { isPremium: true } },
    )}
  </StrictMode>
);

const encoder = new TextEncoder();
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Anthropic SSE frames as askLLM relays them: X-Provider picks the parser, X-Request-Id is a stream error's ref. */
const sse = {
  text: (t) => (
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`
  ),
  stop: (reason) => `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } })}\n\n`,
  error: `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
  end: 'data: {"type":"message_stop"}\n\n',
};
const HEADERS = { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic', 'X-Request-Id': 'req-1' };

/** One askLLM reply the test drives: push() enqueues raw SSE, close() ends the body; state.cancelled records a cancel. */
function controlledStream() {
  let ctl;
  const state = { cancelled: null };
  const body = new ReadableStream({
    start(c) { ctl = c; },
    cancel(reason) { state.cancelled = reason ?? 'cancelled'; },
  });
  return {
    state,
    response: () => new Response(body, { status: 200, headers: HEADERS }),
    push: (chunk) => ctl.enqueue(encoder.encode(chunk)),
    close: () => ctl.close(),
  };
}

/** requestAnimationFrame as a manual queue: a frame runs only when the test calls run(). */
function manualFrames() {
  const queue = new Map();
  let next = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    const id = next++;
    queue.set(id, cb);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { queue.delete(id); });
  return {
    run: () => act(() => {
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(performance.now());
    }),
  };
}

let rec;
/** The askLLM replies, one per request, in request order. */
let streams;
let frames;
beforeEach(() => {
  streams = [];
  rec = installFetchRecorder();
  rec.setFetch(() => { const s = controlledStream(); streams.push(s); return Promise.resolve(s.response()); });
  frames = manualFrames();
});
afterEach(() => {
  rec.uninstall();
  setBackend(new LocalStorageBackend()); // disposes a SupabaseBackend a test set
});

const user = (content) => ({ role: 'user', content });
const reply = (content) => ({ role: 'assistant', content });
const U0 = user('u0');
const A0 = reply('a0');
const QUESTION = user('Q');
const PROMPT = user(CONTEXT_UPDATE_PROMPT);
const FAILED = 'Failed to get analysis: Overloaded (ref req-1)';
const SUGGESTIONS_FAILED = 'Failed to get suggestions: Overloaded (ref req-1)';

const box = () => screen.getByPlaceholderText('Ask about the flow...');
const stored = (ticker = 'AVGO') => JSON.parse(localStorage.getItem(`chat_history_${ticker}`) ?? 'null');
const chatKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('chat_history_')).sort();
/** The chat-history writes a Storage.prototype.setItem spy has seen. */
const chatWrites = (setItem) => setItem.mock.calls.filter(([key]) => key.startsWith('chat_history_'));
/** The JSON body of the i-th askLLM request. */
const requestBody = (i) => JSON.parse(rec.calls[i].init.body);
/** The bubbles showing exactly `text` (the textarea's own value excluded). */
const bubbles = (text) => screen.queryAllByText(text).filter((el) => el.tagName !== 'TEXTAREA');
/** The Delete button of the one bubble showing `text`. */
const deleteOf = (text) => within(bubbles(text)[0].closest('[class*="group/msg"]')).getByRole('button', { name: 'Delete message' });
const retryButton = () => screen.queryByRole('button', { name: 'Retry' });
/** The typing indicator's dots. */
const dots = () => document.querySelectorAll('.pulse-glow').length;
/** The reply has settled, failed, or wound down after a detach: the composer shows Send again. */
const composerBack = () => screen.findByLabelText('Send message');

/** Type `text` and press Enter; resolves once its askLLM request is out. */
async function send(text) {
  const n = rec.calls.length + 1;
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(rec.calls).toHaveLength(n));
}

/** Hand the reader raw SSE for the i-th reply; its text waits in the chunk buffer for a frame or the reply's end. */
const deliver = (chunk, i) => act(async () => { streams[i].push(chunk); await tick(); });

/**
 * The i-th reply streams `text` (none when ''), on screen by a frame, then fails; resolves once the chat is idle with
 * its error line last on screen (an older bubble may show the same line).
 */
async function failWith(i, text, line = FAILED) {
  if (text) {
    await deliver(sse.text(text), i);
    frames.run();
  }
  await deliver(sse.error, i);
  await composerBack();
  const bubblesShown = document.querySelectorAll('[class*="group/msg"]');
  expect(bubblesShown[bubblesShown.length - 1]).toHaveTextContent(`Error${line}`);
}

/** The i-th reply ends normally with `text`. */
async function finishReply(i, text) {
  await act(async () => { streams[i].push(sse.text(text) + sse.stop('end_turn') + sse.end); streams[i].close(); await tick(); });
  await composerBack();
}

/** Click the Retry on screen; resolves once the n-th request is out. */
async function clickRetry(n) {
  fireEvent.click(retryButton());
  await waitFor(() => expect(rec.calls).toHaveLength(n));
}

describe('ChatBot: Retry asks the failed request again', () => {
  it('a send that failed before any text: one request ending on the question; the question stored once, then the reply', async () => {
    setChatHistory('AVGO', [U0, A0]);
    render(chat());
    await send('Q');
    await failWith(0, '');
    expect(stored()).toEqual([U0, A0, QUESTION]);

    await clickRetry(2);
    expect(requestBody(1).messages).toEqual([U0, A0, QUESTION]);
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(bubbles('Q')).toHaveLength(1);
    expect(dots()).toBe(3);

    await finishReply(1, 'A');
    expect(stored()).toEqual([U0, A0, QUESTION, reply('A')]);
    expect(bubbles('Q')).toHaveLength(1);
    expect(rec.calls).toHaveLength(2);
  });

  it('a send that failed with a partial reply: the request leaves the partial out; it stays on screen and in the store', async () => {
    setChatHistory('AVGO', [U0, A0]);
    render(chat());
    await send('Q');
    await failWith(0, 'Part');
    expect(stored()).toEqual([U0, A0, QUESTION, reply('Part')]);

    await clickRetry(2);
    expect(requestBody(1).messages).toEqual([U0, A0, QUESTION]);
    expect(screen.getByText('Part')).toBeInTheDocument();
    expect(dots()).toBe(3);

    await finishReply(1, 'A');
    expect(stored()).toEqual([U0, A0, QUESTION, reply('Part'), reply('A')]);
    expect(screen.getByText('Part')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it.each([
    ['with text', 'with text', 'Par', 'Xx'],
    ['with text', 'without text', 'Par', ''],
    ['without text', 'with text', '', 'Xx'],
    ['without text', 'without text', '', ''],
  ])('a retry that fails again leaves one retryable bubble, the first failure %s and the second %s: the second and third requests end on the question, and the store keeps every partial', async (_first, _second, firstText, secondText) => {
    const partials = [firstText, secondText].filter(Boolean).map(reply);
    setChatHistory('AVGO', [U0, A0]);
    render(chat());
    await send('Q');
    await failWith(0, firstText);
    await clickRetry(2);
    expect(requestBody(1).messages).toEqual([U0, A0, QUESTION]);

    await failWith(1, secondText);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(stored()).toEqual([U0, A0, QUESTION, ...partials]);

    await clickRetry(3);
    expect(requestBody(2).messages).toEqual([U0, A0, QUESTION]);
    await finishReply(2, 'Final');
    expect(stored()).toEqual([U0, A0, QUESTION, ...partials, reply('Final')]);
    expect(bubbles('Q')).toHaveLength(1);
    expect(retryButton()).toBeNull();
  });

  it('a retried suggestions request ends on the prompt; failing again keeps its kind, and the third request still ends on the prompt with no partial', async () => {
    setChatHistory('AVGO', [U0, A0]);
    render(chat());
    fireEvent.click(screen.getByLabelText('Suggest updates to Strategic Context'));
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    await failWith(0, 'Sp', SUGGESTIONS_FAILED);
    expect(stored()).toEqual([U0, A0, reply('Sp')]);

    await clickRetry(2);
    expect(requestBody(1).messages).toEqual([U0, A0, PROMPT]);
    await failWith(1, '', SUGGESTIONS_FAILED);
    await clickRetry(3);
    expect(requestBody(2).messages).toEqual([U0, A0, PROMPT]);

    await finishReply(2, 'S');
    expect(stored()).toEqual([U0, A0, reply('Sp'), reply('S')]);
    expect(screen.queryByText(/Review our conversation/)).toBeNull();
  });
});

describe('ChatBot: when Retry is offered', () => {
  it('on the last message alone, never while a reply streams, and again once what followed the bubble is deleted', async () => {
    render(chat());
    await send('Q');
    await failWith(0, '');
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);

    await send('Q2');
    expect(retryButton()).toBeNull();
    await finishReply(1, 'A2');
    expect(retryButton()).toBeNull();
    expect(screen.getByText(FAILED)).toBeInTheDocument();

    fireEvent.click(deleteOf('A2'));
    fireEvent.click(deleteOf('Q2'));
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(stored()).toEqual([QUESTION]);
  });

  it('two Retry clicks in one act start one request; the second, refused by start(), changes nothing', async () => {
    render(chat());
    await send('Q');
    await failWith(0, '');
    const button = retryButton();
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(rec.calls).toHaveLength(2));
    await act(async () => { await tick(); });
    expect(rec.calls).toHaveLength(2);
    expect(dots()).toBe(3);
    expect(bubbles('Q')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Stop generating')).toBeInTheDocument();

    await finishReply(1, 'A');
    expect(stored()).toEqual([QUESTION, reply('A')]);
  });
});

describe('ChatBot: a retry and the store', () => {
  // Lens 1's race: a reload queued outside act before the click (another tab cleared this chat) and rendered after it.
  // The request is the one the click saw; the placeholder lands on the reloaded chat, where the bubble is gone.
  it('a reload that lands between the click and the placeholder stores the question with its reply', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // the reload is rendered outside act, on purpose
    setChatHistory('AVGO', [U0, A0]);
    render(chat());
    await send('Q');
    await failWith(0, '');
    expect(stored()).toEqual([U0, A0, QUESTION]);

    localStorage.removeItem('chat_history_AVGO');
    emitStoreChanged({ kind: 'chat', id: 'AVGO' });
    await clickRetry(2);
    expect(requestBody(1).messages).toEqual([U0, A0, QUESTION]);
    await finishReply(1, 'Answer to Q');
    expect(stored()).toEqual([QUESTION, reply('Answer to Q')]);
  });

  it('the question deleted while a retry streams: its failure offers no Retry, and nothing else is removed', async () => {
    setChatHistory('AVGO', [U0, A0]);
    render(chat());
    await send('Q');
    await failWith(0, 'Par');
    await clickRetry(2);
    fireEvent.click(deleteOf('Q'));
    expect(stored()).toEqual([U0, A0, reply('Par')]);

    await failWith(1, 'Xx');
    expect(retryButton()).toBeNull();
    expect(stored()).toEqual([U0, A0, reply('Par'), reply('Xx')]);
  });

  // A whole-store change (an import, a sync, a sign-out's reset) drops a reply in flight, a retry as any other
  // (useChatHistory), so the identity a retried request is counted by never meets the store's new objects.
  it('a whole-store change while a retry streams drops it unwritten: the store\'s chat shows, with no bubble and no Retry', async () => {
    setChatHistory('AVGO', [U0, A0]);
    render(chat());
    await send('Q');
    await failWith(0, 'Par');
    await clickRetry(2);
    await deliver(sse.text('Xx'), 1);
    frames.run();
    expect(screen.getByText('Xx')).toBeInTheDocument();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    act(() => { emitStoreChanged(); });
    expect(screen.queryByText('Xx')).toBeNull();
    expect(screen.getByText('Par')).toBeInTheDocument();
    expect(bubbles('Q')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    await composerBack();
    expect(streams[1].state.cancelled).toBeTruthy();
    expect(retryButton()).toBeNull();
    expect(chatWrites(setItem)).toEqual([]);
    expect(stored()).toEqual([U0, A0, QUESTION, reply('Par')]);
  });

  it("a change to this chat alone while a retry streams is ignored, and the retry's failure is retryable on the same request", async () => {
    setChatHistory('AVGO', [U0, A0]);
    render(chat());
    await send('Q');
    await failWith(0, 'Par');
    await clickRetry(2);
    setChatHistory('AVGO', [user('elsewhere')]);
    act(() => { emitStoreChanged({ kind: 'chat', id: 'AVGO' }); });
    expect(screen.queryByText('elsewhere')).toBeNull();

    await failWith(1, '');
    await clickRetry(3);
    expect(requestBody(2).messages).toEqual([U0, A0, QUESTION]);
    await finishReply(2, 'A');
    expect(stored()).toEqual([U0, A0, QUESTION, reply('Par'), reply('A')]);
  });

  it('one chat write per reply on the retry path: at each failure and at the end, none at a Retry or a chunk', async () => {
    setChatHistory('AVGO', [U0, A0]);
    render(chat());
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const writes = [];
    const count = () => writes.push(chatWrites(setItem).length);
    await send('Q');
    count();
    await failWith(0, 'Par');
    count();
    await clickRetry(2);
    count();
    await deliver(sse.text('Xx'), 1);
    frames.run();
    count();
    await failWith(1, '');
    count();
    await clickRetry(3);
    count();
    await finishReply(2, 'Final');
    count();
    expect(writes).toEqual([0, 1, 1, 1, 2, 2, 3]);
    expect(stored()).toEqual([U0, A0, QUESTION, reply('Par'), reply('Xx'), reply('Final')]);
  });

  it('no error bubble, retry record or pending flag reaches the store, the outbox, the account or an export, on any write path', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fake = fakeSupabase();
    setBackend(new SupabaseBackend(new LocalStorageBackend(), 'u1', fake, { storage: localStorage }));
    setChatHistory('AVGO', [U0, A0]);
    const view = render(chat());
    await send('Q');
    await failWith(0, 'Part'); // the fail's write, a bubble with its record on screen
    fireEvent.click(deleteOf('u0')); // a delete's write with the bubble on screen
    act(() => { window.dispatchEvent(new Event('pagehide')); }); // nothing live: nothing written
    await send('Q2');
    await failWith(1, ''); // a second bubble
    await clickRetry(3);
    act(() => { window.dispatchEvent(new Event('pagehide')); }); // the retry saved mid-reply
    await failWith(2, ''); // the retry fails again
    view.rerender(chat({ data: dataFor('NVDA') })); // the ticker change's save, with bubbles on screen
    view.rerender(chat());
    await send('Q3');
    view.unmount(); // the unmount's save mid-reply
    await act(async () => { await tick(10); });

    const unstorable = (m) => m.role === 'error' || 'retry' in m || 'pending' in m;
    const local = chatKeys().flatMap((key) => JSON.parse(localStorage.getItem(key)));
    const cloud = fake.upserts
      .filter((u) => u.table === 'chat_histories')
      .flatMap((u) => u.rows.flatMap((row) => row.messages ?? []));
    const outbox = Object.keys(localStorage).filter((k) => k.startsWith('sync_outbox_')).map((k) => localStorage.getItem(k));
    expect(local.length).toBeGreaterThan(0);
    expect(cloud.length).toBeGreaterThan(0);
    expect(local.filter(unstorable)).toEqual([]);
    expect(cloud.filter(unstorable)).toEqual([]);
    expect(outbox.join('')).not.toMatch(/"retry"|"pending"|"role":"error"/);
    expect(JSON.stringify(exportAll())).not.toMatch(/"retry"|"pending"|"role":"error"/);
    expect(stored()).toEqual([A0, QUESTION, reply('Part'), user('Q2'), user('Q3')]);
  });
});

describe('ChatBot: a retry that fails while its request is built', () => {
  it('puts up a new alert node, so the failure is announced again, and stays retryable with nothing sent', async () => {
    render(chat({ data: THROWING }));
    fireEvent.change(box(), { target: { value: 'Q' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    const first = await screen.findByRole('alert');
    await composerBack();
    expect(first).toHaveTextContent(/Failed to get analysis: Cannot read properties of undefined/);

    fireEvent.click(retryButton());
    const second = screen.getByRole('alert');
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(second).toHaveTextContent(first.textContent);
    expect(retryButton()).not.toBeNull();
    expect(rec.calls).toHaveLength(0);
    expect(stored()).toEqual([QUESTION]);
  });
});
