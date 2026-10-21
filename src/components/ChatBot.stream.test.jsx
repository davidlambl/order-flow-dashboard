// src/components/ChatBot.stream.test.jsx — the chat's streamed reply, pinned THROUGH the shell: a send shows the
// question and the typing indicator until a frame flushes the first text; the reply grows chunk by chunk and is stored
// under chat_history_<ticker> once it settles, as role and content alone; a reply that did not end normally keeps its
// marker; Stop, after and before the response headers; the error bubbles, shown and never stored; the context-update
// suggestions; the conversation window and what the request carries; one reply at a time; and a reply that goes on
// streaming, and is stored, behind a closed or a re-locked chat. Written on be2421f, before the shell used chat/, against the one-file
// ChatBot.jsx, as the contract its decomposition (a shell over chat/*.tsx leaves, useChatStream and useChatHistory)
// must keep green unchanged, so every test is a pin. The recipes (the driven body, the manual frames, the SSE bodies
// and the expected strings) come from the PR 3 attack report, .claude/phase-5d/attack-chat-report.md. Deliberately not
// pinned: a Stop while a non-ok response's JSON body is still being read, where the two trees differ by design (the
// error bubble wins today, the Stop after the decomposition); the context's text beyond its first line and the spot
// price, which the context builder's snapshots own (its TIMESTAMP reads the clock); and what a ticker change, an
// unmount, a page hide or a store reset saves, which the history pins own. Here a ticker change only shows that a send
// is refused until the old reply has wound down.
// Rendered under StrictMode, as main.jsx renders App. Streams and aborts run on real timers. The askLLM body is a
// stream the test drives, served through the fetch recorder rather than MSW, which tees the response so that an abort
// never reaches the handler's stream: one fresh body per request (a body can be read only once), and its
// state.cancelled shows that an abort released it. requestAnimationFrame is a manual queue (restoreMocks puts the real
// one back before the next test): jsdom's frames would fold the chunks into one flush, so text reaches the screen only
// on a frame the test runs, or on the settle. After a detach, a test awaits the Send button, so the aborted reply's
// finally lands inside waitFor.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatBot from './ChatBot.jsx';
import { setChatHistory, setPreference } from '../lib/store.js';
import { withContexts } from '../test/contexts.jsx';
import { installFetchRecorder } from '../../test/helpers/fetch.js';

/** Market data the context builds from without a throw: the ticker and empty collections. */
const DATA = { ticker: 'AVGO', kpis: {}, gexByStrike: [], flowHistory: [] };

/** The chat as App renders it, open and premium unless a test says otherwise. */
const chat = ({ data = DATA, isOpen = true, isPremium = true } = {}) => (
  <StrictMode>
    {withContexts(
      <ChatBot isOpen={isOpen} onClose={() => {}} onOpenSettings={() => {}} costBasis={90} shares={100} />,
      { market: { data }, auth: { isPremium } },
    )}
  </StrictMode>
);

const encoder = new TextEncoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Anthropic SSE frames as askLLM relays them: X-Provider picks the parser, X-Request-Id is a stream error's ref. */
const sse = {
  text: (t) => (
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`
  ),
  stop: (reason) => `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } })}\n\n`,
  error: (type, message) => `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`,
  start: 'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
  end: 'data: {"type":"message_stop"}\n\n',
};
const HEADERS = { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic', 'X-Request-Id': 'req-1' };

/**
 * One askLLM reply the test drives: push() enqueues raw SSE, close() ends the body, end() ends the reply normally;
 * state.cancelled records a cancel.
 */
function controlledStream() {
  let ctl;
  const state = { cancelled: null };
  const body = new ReadableStream({
    start(c) { ctl = c; },
    cancel(reason) { state.cancelled = reason ?? 'cancelled'; },
  });
  const push = (chunk) => ctl.enqueue(encoder.encode(chunk));
  return {
    state,
    response: () => new Response(body, { status: 200, headers: HEADERS }),
    push,
    close: () => ctl.close(),
    end: (reason = 'end_turn') => { push(sse.stop(reason) + sse.end); ctl.close(); },
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
    pending: () => queue.size,
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
afterEach(() => rec.uninstall());

const box = () => screen.getByPlaceholderText('Ask about the flow...');
const stored = (ticker = 'AVGO') => JSON.parse(localStorage.getItem(`chat_history_${ticker}`) ?? 'null');
/** The question most tests send, and a reply, as the store keeps them. */
const QUESTION = { role: 'user', content: 'Q' };
const reply = (content) => ({ role: 'assistant', content });
/** The JSON body of the i-th askLLM request. */
const requestBody = (i = 0) => JSON.parse(rec.calls[i].init.body);
/** The bubbles showing exactly `text` (the textarea's own value excluded). */
const bubbles = (text) => screen.queryAllByText(text).filter((el) => el.tagName !== 'TEXTAREA');
/** The typing indicator's dots. */
const dots = () => document.querySelectorAll('.pulse-glow').length;
/** The reply has settled, or wound down after a detach: the composer shows Send again. */
const composerBack = () => screen.findByLabelText('Send message');

/** Type `text` and press Enter; resolves once its askLLM request is out. */
async function send(text) {
  const n = rec.calls.length + 1;
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(rec.calls).toHaveLength(n));
}

/** Hand the reader raw SSE for the i-th reply; its text waits in the chunk buffer for a frame or the settle. */
const deliver = (chunk, i = 0) => act(async () => { streams[i].push(chunk); await tick(); });

/** End the i-th reply's body: `chunks` (raw SSE), then the close. */
const finish = (chunks, i = 0) => act(async () => {
  for (const c of chunks) streams[i].push(c);
  streams[i].close();
  await tick();
});

describe('ChatBot: the streamed reply', () => {
  it('Pin: a send shows the question at once, and the typing indicator until a frame flushes the first text', async () => {
    render(chat());
    await send('Q');
    expect(bubbles('Q')).toHaveLength(1);
    expect(dots()).toBe(3);
    expect(screen.getByLabelText('Stop generating')).toBeInTheDocument();

    await deliver(sse.text('Hel'));
    expect(frames.pending()).toBe(1);
    expect(dots()).toBe(3);
    expect(screen.queryByText('Hel')).toBeNull();

    frames.run();
    expect(screen.getByText('Hel')).toBeInTheDocument();
    expect(dots()).toBe(0);
  });

  it('Pin: the reply grows chunk by chunk and is stored once it settles, as role and content alone', async () => {
    render(chat());
    await send('Q');
    await deliver(sse.text('Hel'));
    frames.run();
    expect(screen.getByText('Hel')).toBeInTheDocument();
    await deliver(sse.text('lo there'));
    frames.run();
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(stored()).toBeNull(); // never written per chunk

    await finish([sse.stop('end_turn'), sse.end]);
    await composerBack();
    expect(stored()).toStrictEqual([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'Hello there' }]);
    expect(screen.getByText('Hello there')).toBeInTheDocument();
  });

  it('Pin: a last chunk and the end in one tick, with a frame still pending, settle with all the text', async () => {
    render(chat());
    await send('Q');
    await deliver(sse.text('A'));
    expect(frames.pending()).toBe(1);

    await act(async () => { streams[0].push(sse.text('B')); streams[0].end(); await tick(); await tick(); });
    await composerBack();
    expect(stored()).toEqual([QUESTION, reply('AB')]);
    expect(screen.getByText('AB')).toBeInTheDocument();

    frames.run(); // a frame left over finds nothing to add
    expect(screen.getByText('AB')).toBeInTheDocument();
    expect(stored()).toEqual([QUESTION, reply('AB')]);
  });

  it.each([
    ['the token limit', [sse.text('Long'), sse.stop('max_tokens')],
      'Long\n\n*(cut off at the token limit)*', '(cut off at the token limit)'],
    ['no stop reason, the body just closing', [sse.text('Half')],
      'Half\n\n*(response ended early)*', '(response ended early)'],
    ['another stop reason (pause_turn)', [sse.text('Paused'), sse.stop('pause_turn')],
      'Paused\n\n*(the model stopped here: other)*', '(the model stopped here: other)'],
    ['a refusal after some text', [sse.text('Some'), sse.stop('refusal')],
      'Some\n\n*(the model stopped here: refusal)*', '(the model stopped here: refusal)'],
  ])('Pin: a reply that ends on %s keeps its text and is stored and shown with its marker', async (_, body, content, marker) => {
    render(chat());
    await send('Q');
    await finish(body);
    await composerBack();
    expect(stored()).toEqual([QUESTION, reply(content)]);
    expect(screen.getByText(marker).tagName).toBe('EM');
  });

  it('Pin: Stop settles the text so far with "*(stopped)*", aborting the request and its body; a double-click\'s second click does not', async () => {
    render(chat());
    await send('Q');
    await deliver(sse.text('Part'));
    frames.run();
    await deliver(sse.text('ial')); // still in the chunk buffer when Stop lands

    fireEvent.click(screen.getByLabelText('Stop generating'), { detail: 2 });
    await act(async () => { await tick(); });
    expect(rec.calls[0].init.signal.aborted).toBe(false);
    expect(streams[0].state.cancelled).toBeNull();
    expect(screen.queryByText('(stopped)')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByLabelText('Stop generating'), { detail: 1 }); });
    expect(await screen.findByText('(stopped)')).toBeInTheDocument();
    await composerBack();
    expect(stored()).toEqual([QUESTION, reply('Partial\n\n*(stopped)*')]);
    expect(rec.calls[0].init.signal.aborted).toBe(true);
    expect(streams[0].state.cancelled).toBeTruthy();
  });

  it('Pin: Stop before the response headers settles the reply as "*(stopped)*" alone', async () => {
    // A request that never answers must honour its signal, or the reply (and the Stop button) would hang.
    rec.setFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    render(chat());
    await send('Q');
    await act(async () => { fireEvent.click(screen.getByLabelText('Stop generating'), { detail: 1 }); });
    await composerBack();
    expect(stored()).toEqual([QUESTION, reply('*(stopped)*')]);
    expect(screen.getByText('(stopped)')).toBeInTheDocument();
  });
});

describe('ChatBot: a reply that fails', () => {
  it('Pin: a provider error mid-reply shows its bubble with the request ref, never stores it, and stores the text so far', async () => {
    render(chat());
    await send('Q');
    await deliver(sse.text('Part'));
    frames.run();
    await deliver(sse.text('ial') + sse.error('overloaded_error', 'Overloaded') + sse.text(' never'));
    expect(await screen.findByText('Failed to get analysis: Overloaded (ref req-1)')).toBeInTheDocument();
    await composerBack();
    expect(stored()).toEqual([QUESTION, reply('Partial')]);
    expect(screen.getByText('Partial')).toBeInTheDocument();
    expect(screen.queryByText(/never/)).toBeNull();
  });

  it.each([
    ['no text at all', [sse.start, sse.end],
      'Failed to get analysis: The model returned an empty response (ref req-1)'],
    ['a refusal before any text', [sse.stop('refusal')],
      'Failed to get analysis: The model declined to answer (refusal) (ref req-1)'],
  ])('Pin: a reply with %s becomes an error bubble, with no empty reply shown or stored', async (_, body, bubble) => {
    render(chat());
    await send('Q');
    await finish(body);
    expect(await screen.findByText(bubble)).toBeInTheDocument();
    await composerBack();
    expect(stored()).toEqual([QUESTION]);
    expect(screen.getAllByLabelText('Delete message')).toHaveLength(2); // the question's bubble and the error's
    expect(dots()).toBe(0);
  });

  it('Pin: a function error shows its message with the ref from its JSON body, and only the question is stored', async () => {
    rec.setFetch(async () => new Response(
      JSON.stringify({ error: 'Too many requests', code: 'RATE_LIMITED', requestId: 'r4' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    ));
    render(chat());
    await send('Q');
    expect(await screen.findByText('Failed to get analysis: Too many requests (ref r4)')).toBeInTheDocument();
    await composerBack();
    expect(stored()).toEqual([QUESTION]);
  });

  it('Pin: a context that fails to build becomes the error bubble, with the question stored and no request sent', async () => {
    const data = {
      ...DATA,
      flowHistory: [
        { date: '2026-09-24', netPremium: 800_000, cumPremium: 800_000, callVolume: 450, putVolume: 380 },
        { date: '2026-09-25', netPremium: 1_250_000, cumPremium: 2_050_000, callVolume: undefined, putVolume: 410 },
      ],
    };
    render(chat({ data }));
    fireEvent.change(box(), { target: { value: 'Q' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText(/Failed to get analysis: Cannot read properties of undefined/)).toBeInTheDocument();
    await composerBack();
    expect(stored()).toEqual([QUESTION]);
    expect(rec.calls).toHaveLength(0);
  });
});

describe('ChatBot: the suggestions request', () => {
  const HISTORY = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }];
  const PROMPT = 'Review our conversation and suggest specific updates to my Strategic Context document';

  it('Pin: it sends its prompt as the last message, never shows or stores it, and answers in a bubble of its own', async () => {
    setChatHistory('AVGO', HISTORY);
    render(chat());
    fireEvent.click(screen.getByLabelText('Suggest updates to Strategic Context'));
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    const { messages } = requestBody();
    expect(messages).toHaveLength(3);
    expect(messages.slice(0, 2)).toEqual(HISTORY);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content.startsWith(PROMPT)).toBe(true);

    await finish([sse.text('Suggestion one'), sse.stop('end_turn'), sse.end]);
    await composerBack();
    expect(screen.getByText('a1')).toBeInTheDocument();
    expect(screen.getByText('Suggestion one')).toBeInTheDocument();
    expect(screen.queryByText(/Review our conversation/)).toBeNull();
    expect(stored()).toEqual([...HISTORY, reply('Suggestion one')]);
  });

  it('Pin: a failed one says "Failed to get suggestions" with the ref, and stores nothing of it', async () => {
    setChatHistory('AVGO', HISTORY);
    render(chat());
    fireEvent.click(screen.getByLabelText('Suggest updates to Strategic Context'));
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    await finish([sse.error('api_error', 'Boom')]);
    expect(await screen.findByText('Failed to get suggestions: Boom (ref req-1)')).toBeInTheDocument();
    await composerBack();
    expect(stored()).toEqual(HISTORY);
  });
});

describe('ChatBot: the request', () => {
  it('Pin: a send carries the last ten turns, its question included, trimmed to open on a user turn: nine messages', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => (
      { role: i % 2 ? 'assistant' : 'user', content: `${i % 2 ? 'a' : 'u'}${Math.floor(i / 2)}` }
    ));
    setChatHistory('AVGO', turns);
    render(chat());
    await send('Q');
    const { messages } = requestBody();
    expect(messages.map((m) => m.content)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5', 'Q']);
    expect(messages).toEqual([...turns.slice(4), QUESTION]);
  });

  it('Pin: it carries the context built from the market data and the AI preferences as they stand at the send', async () => {
    const view = render(chat());
    view.rerender(chat({ data: { ...DATA, spotPrice: 101.5 } }));
    await send('Q1');
    const first = requestBody(0);
    expect(first).toMatchObject({
      messages: [{ role: 'user', content: 'Q1' }],
      ticker: 'AVGO',
      provider: 'anthropic',
      model: '',
      userApiKey: null,
      stream: true,
    });
    expect(first.financialContext.startsWith('TICKER: AVGO\n')).toBe(true);
    expect(first.financialContext).toContain('\nSPOT PRICE: $101.50');
    await finish([sse.text('A1'), sse.stop('end_turn'), sse.end]);
    await composerBack();

    setPreference('ai_provider', 'openai');
    setPreference('ai_model', 'gpt-x');
    setPreference('ai_key_openai', 'sk-1');
    await send('Q2');
    const second = requestBody(1);
    expect(second).toMatchObject({
      ticker: 'AVGO', provider: 'openai', model: 'gpt-x', userApiKey: 'sk-1', stream: true,
    });
    expect(second.financialContext.startsWith('TICKER: AVGO\n')).toBe(true);
  });
});

describe('ChatBot: one reply at a time', () => {
  it('Pin: two Enters in one act send one request and show the question once', async () => {
    render(chat());
    fireEvent.change(box(), { target: { value: 'Q' } });
    act(() => {
      fireEvent.keyDown(box(), { key: 'Enter' });
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    await act(async () => { await tick(); });
    expect(rec.calls).toHaveLength(1);
    expect(bubbles('Q')).toHaveLength(1);

    await finish([sse.text('A'), sse.stop('end_turn'), sse.end]);
    await composerBack();
    expect(stored()).toEqual([QUESTION, reply('A')]);
  });

  it('Pin: a send right after a ticker change, while the old reply winds down, is refused: no request, no bubble', async () => {
    const suggestion = () => screen.getByRole('button', { name: 'Is the flow bullish or bearish?' });
    const view = render(chat());
    await send('Q');
    await deliver(sse.text('A'));
    view.rerender(chat({ data: { ...DATA, ticker: 'NVDA' } }));
    fireEvent.click(suggestion()); // NVDA has no history: its empty state offers the suggestions
    expect(rec.calls).toHaveLength(1);
    expect(suggestion()).toBeInTheDocument(); // still the empty state: no bubble went up

    await composerBack();
    expect(rec.calls).toHaveLength(1);
    expect(suggestion()).toBeInTheDocument();
    expect(stored('NVDA')).toBeNull();
  });
});

describe('ChatBot: behind a closed or locked chat', () => {
  it('Pin: closed mid-reply, the reply goes on streaming, settles and is stored in full; reopened, the chat shows it', async () => {
    const view = render(chat());
    await send('Q');
    await deliver(sse.text('Part'));
    frames.run();
    expect(screen.getByText('Part')).toBeInTheDocument();

    view.rerender(chat({ isOpen: false }));
    expect(screen.queryByText('Part')).toBeNull();
    expect(screen.queryByPlaceholderText('Ask about the flow...')).toBeNull();
    expect(rec.calls[0].init.signal.aborted).toBe(false);
    expect(streams[0].state.cancelled).toBeNull();
    await deliver(sse.text(' two'));
    frames.run();
    await finish([sse.stop('end_turn'), sse.end]);
    await waitFor(() => expect(stored()).toEqual([QUESTION, reply('Part two')]));
    expect(rec.calls[0].init.signal.aborted).toBe(false);

    view.rerender(chat());
    expect(screen.getByText('Part two')).toBeInTheDocument();
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
  });

  it('Pin: re-locked mid-reply, the reply goes on behind the lock, settles and is stored in full; unlocked, the chat shows it', async () => {
    const view = render(chat());
    await send('Q');
    await deliver(sse.text('Part'));
    frames.run();
    expect(screen.getByText('Part')).toBeInTheDocument();

    view.rerender(chat({ isPremium: false }));
    expect(screen.getByText('Premium Feature')).toBeInTheDocument();
    expect(screen.queryByText('Part')).toBeNull();
    expect(rec.calls[0].init.signal.aborted).toBe(false);
    expect(streams[0].state.cancelled).toBeNull();
    await deliver(sse.text(' two'));
    frames.run();
    await finish([sse.stop('end_turn'), sse.end]);
    await waitFor(() => expect(stored()).toEqual([QUESTION, reply('Part two')]));
    expect(rec.calls[0].init.signal.aborted).toBe(false);

    view.rerender(chat());
    expect(screen.getByText('Part two')).toBeInTheDocument();
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
  });
});
