// src/components/ChatBot.pins.test.jsx — what the chat's Retry, its enabled composer and its status line must not
// move, pinned through the whole chat on the tree before them and after: one chat write per reply (at its end or its
// failure, none at a placeholder or a chunk); a reply that fails behind a closed chat is stored with its question and
// partial and shows with its error line on reopen; a double-click on Send sends once and leaves the reply running; a
// ticker change away and back, or a reload of the store, leaves no error line and no Retry, since an error bubble is
// never stored. Every test is a pin: green before the change and after it. The mechanics are the stream pin file's.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatBot from './ChatBot.jsx';
import { emitStoreChanged, setChatHistory } from '../lib/store.js';
import { withContexts } from '../test/contexts.jsx';
import { installFetchRecorder } from '../../test/helpers/fetch.js';

const dataFor = (ticker) => ({ ticker, kpis: {}, gexByStrike: [], flowHistory: [] });

const chat = ({ data = dataFor('AVGO'), isOpen = true } = {}) => (
  <StrictMode>
    {withContexts(
      <ChatBot isOpen={isOpen} onClose={() => {}} onOpenSettings={() => {}} costBasis={90} shares={100} />,
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
const FAILED = 'Failed to get analysis: Overloaded (ref req-1)';

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

const user = (content) => ({ role: 'user', content });
const reply = (content) => ({ role: 'assistant', content });
const box = () => screen.getByPlaceholderText('Ask about the flow...');
const stored = (ticker = 'AVGO') => JSON.parse(localStorage.getItem(`chat_history_${ticker}`) ?? 'null');
const chatWrites = (setItem) => setItem.mock.calls.filter(([key]) => key.startsWith('chat_history_'));
const composerBack = () => screen.findByLabelText('Send message');

async function send(text) {
  const n = rec.calls.length + 1;
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(rec.calls).toHaveLength(n));
}
const deliver = (chunk, i) => act(async () => { streams[i].push(chunk); await tick(); });

describe('ChatBot: what Retry, the composer and the status line must not move', () => {
  it('Pin: one chat write per reply, at its failure or its end; none at a placeholder or a chunk', async () => {
    setChatHistory('AVGO', [user('u0'), reply('a0')]);
    render(chat());
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const writes = () => chatWrites(setItem).length;

    await send('Q1');
    expect(writes()).toBe(0);
    await deliver(sse.text('Part'), 0);
    frames.run();
    expect(writes()).toBe(0);
    await deliver(sse.error, 0);
    await screen.findByText(FAILED);
    await composerBack();
    expect(writes()).toBe(1);
    expect(stored()).toEqual([user('u0'), reply('a0'), user('Q1'), reply('Part')]);

    await send('Q2');
    expect(writes()).toBe(1);
    await deliver(sse.text('A2') + sse.stop('end_turn') + sse.end, 1);
    act(() => { streams[1].close(); });
    await composerBack();
    expect(writes()).toBe(2);
    expect(stored()).toEqual([user('u0'), reply('a0'), user('Q1'), reply('Part'), user('Q2'), reply('A2')]);
  });

  it('Pin: a reply that fails behind a closed chat is stored with its question and partial; reopened, the chat shows them and the error line', async () => {
    const view = render(chat());
    await send('Q');
    await deliver(sse.text('Part'), 0);
    frames.run();

    view.rerender(chat({ isOpen: false }));
    await deliver(sse.text(' more') + sse.error, 0);
    await waitFor(() => expect(stored()).toEqual([user('Q'), reply('Part more')]));

    view.rerender(chat());
    expect(screen.getByText('Part more')).toBeInTheDocument();
    expect(screen.getByText(FAILED)).toBeInTheDocument();
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
  });

  it('Pin: a double-click on Send sends once and leaves the reply it started running', async () => {
    const pointer = userEvent.setup();
    render(chat());
    fireEvent.change(box(), { target: { value: 'Q' } });
    await pointer.dblClick(screen.getByLabelText('Send message'));
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    await act(async () => { await tick(); });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].init.signal.aborted).toBe(false);
    expect(screen.getByLabelText('Stop generating')).toBeInTheDocument();

    await deliver(sse.text('A') + sse.stop('end_turn') + sse.end, 0);
    act(() => { streams[0].close(); });
    await composerBack();
    expect(stored()).toEqual([user('Q'), reply('A')]);
  });

  it('Pin: a ticker change away and back, or a reload of the store, leaves no error line and no Retry', async () => {
    const view = render(chat());
    await send('Q');
    await deliver(sse.error, 0);
    await screen.findByText(FAILED);
    await composerBack();

    view.rerender(chat({ data: dataFor('NVDA') }));
    view.rerender(chat());
    expect(screen.getByText('Q')).toBeInTheDocument();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry this request' })).toBeNull();

    await send('Q2');
    await deliver(sse.error, 1);
    await composerBack();
    expect(screen.getByText(FAILED)).toBeInTheDocument();
    act(() => { emitStoreChanged({ kind: 'chat', id: 'AVGO' }); });
    expect(screen.getByText('Q2')).toBeInTheDocument();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry this request' })).toBeNull();
    expect(stored()).toEqual([user('Q'), user('Q2')]);
  });
});
