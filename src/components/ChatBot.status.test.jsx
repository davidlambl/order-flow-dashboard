// src/components/ChatBot.status.test.jsx — the chat's one status line, through the whole chat. It is in the tree from
// the chat's first render, empty and the chat's only status (the typing indicator is no status of its own); it says
// "The assistant is replying." while a reply is in flight and, when the reply ends, how: "Reply complete.", "Reply
// stopped.", or "Reply cut off." for any other end (the token limit, the stream closing early); it changes at every
// start, so a second reply's "Reply complete." is a change a live region announces; a failure leaves it empty for the
// error bubble's alert; and a reply cut off for a chat it no longer belongs to (a ticker change) ends with it empty.
// Every query is scoped to the chat's container. The mechanics are the stream pin file's: StrictMode, askLLM answered
// through the fetch recorder with a body the test drives, real timers, requestAnimationFrame a manual queue.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ChatBot from './ChatBot.jsx';
import { withContexts } from '../test/contexts.jsx';
import { installFetchRecorder } from '../../test/helpers/fetch.js';

const dataFor = (ticker) => ({ ticker, kpis: {}, gexByStrike: [], flowHistory: [] });

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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sse = {
  text: (t) => (
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`
  ),
  stop: (reason) => `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } })}\n\n`,
  error: `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
  end: 'data: {"type":"message_stop"}\n\n',
};
const HEADERS = { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic', 'X-Request-Id': 'req-1' };

function controlledStream() {
  let ctl;
  const body = new ReadableStream({ start(c) { ctl = c; } });
  return {
    response: () => new Response(body, { status: 200, headers: HEADERS }),
    push: (chunk) => ctl.enqueue(encoder.encode(chunk)),
    close: () => ctl.close(),
  };
}

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
const composerBack = () => screen.findByLabelText('Send message');
/** The typing indicator's dots. */
const dots = () => document.querySelectorAll('.pulse-glow').length;

async function send(text) {
  const n = rec.calls.length + 1;
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(rec.calls).toHaveLength(n));
}

/** End the i-th reply's body with `chunks` (raw SSE), then wait for Send. */
async function finish(i, chunks) {
  await act(async () => {
    for (const c of chunks) streams[i].push(c);
    streams[i].close();
    await tick();
  });
  await composerBack();
}
const ended = (text) => [sse.text(text), sse.stop('end_turn'), sse.end];

describe('ChatBot: the status line', () => {
  it('is in the chat from its first render, empty, and is its only status, while the typing indicator shows too', async () => {
    const { container } = render(chat());
    const line = within(container).getByRole('status');
    expect(line).toBeEmptyDOMElement();
    expect(line).toHaveClass('sr-only');

    await send('Q');
    expect(dots()).toBe(3);
    expect(within(container).getAllByRole('status')).toEqual([line]);
    expect(line).toHaveTextContent(/^The assistant is replying\.$/);

    await finish(0, ended('A'));
    expect(within(container).getAllByRole('status')).toEqual([line]);
    expect(line).toHaveTextContent(/^Reply complete\.$/);
  });

  it("changes at every start, so a second reply's \"Reply complete.\" is a change and is announced", async () => {
    const { container } = render(chat());
    const line = within(container).getByRole('status');
    const seen = [];
    const observer = new MutationObserver(() => {
      if (seen[seen.length - 1] !== line.textContent) seen.push(line.textContent);
    });
    observer.observe(line, { childList: true, characterData: true, subtree: true });

    await send('Q1');
    await finish(0, ended('A1'));
    await send('Q2');
    await finish(1, ended('A2'));
    await act(async () => { await tick(); });
    observer.disconnect();

    expect(seen).toEqual([
      'The assistant is replying.', 'Reply complete.', 'The assistant is replying.', 'Reply complete.',
    ]);
  });

  it.each([
    ['the token limit', [sse.text('Long'), sse.stop('max_tokens')], 'Reply cut off.'],
    ['the stream closing without a stop reason', [sse.text('Half')], 'Reply cut off.'],
    ['another stop reason (pause_turn)', [sse.text('Paused'), sse.stop('pause_turn')], 'Reply cut off.'],
  ])('a reply that ends on %s does not say "complete"', async (_, body, sentence) => {
    const { container } = render(chat());
    await send('Q');
    await finish(0, body);
    expect(within(container).getByRole('status')).toHaveTextContent(new RegExp(`^${sentence.replace('.', '\\.')}$`));
  });

  it('Stop ends the reply with "Reply stopped."', async () => {
    const { container } = render(chat());
    await send('Q');
    await act(async () => { streams[0].push(sse.text('Part')); await tick(); });
    frames.run();
    await act(async () => { fireEvent.click(screen.getByLabelText('Stop generating'), { detail: 1 }); });
    await composerBack();
    expect(within(container).getByRole('status')).toHaveTextContent(/^Reply stopped\.$/);
  });

  it("a failure leaves the line empty: the error bubble's alert says it", async () => {
    const { container } = render(chat());
    await send('Q1');
    await finish(0, ended('A1'));
    await send('Q2');
    await act(async () => { streams[1].push(sse.error); await tick(); });
    await composerBack();
    expect(within(container).getByRole('alert')).toHaveTextContent('Failed to get analysis: Overloaded (ref req-1)');
    expect(within(container).getByRole('status')).toBeEmptyDOMElement();
  });

  it('a reply cut off by a ticker change sets no sentence: the line is empty once the old reply has wound down', async () => {
    const { container, rerender } = render(chat());
    await send('Q1');
    await finish(0, ended('A1'));
    await send('Q2');
    await act(async () => { streams[1].push(sse.text('Part')); await tick(); });
    frames.run();

    rerender(chat({ data: dataFor('NVDA') }));
    await composerBack();
    await act(async () => { await tick(); });
    expect(within(container).getByRole('status')).toBeEmptyDOMElement();
  });
});
