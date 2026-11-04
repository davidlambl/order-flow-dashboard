// src/components/ChatBot.history.test.jsx — the chat history's writes, through the whole chat: what is stored for a
// ticker, and when (roadmap D10). A stored history shows at mount; a delete and a reply that settles are persist
// points, written once each; Clear asks first and removes the stored history; a ticker change saves the old ticker's
// chat as far as the reply got, buffered text included, and drops the rest of the reply (F6); a pagehide or an
// unmount mid-reply saves it the same way, and after a pagehide the reply carries on; a whole-store change (an event
// with no detail) reloads the chat and drops a reply in flight unwritten, while this chat's own change reloads it
// only when no reply streams; before the first market data nothing is written under any key; the chat's own writes
// emit nothing. Written against the one-file ChatBot.jsx on be2421f, before the shell used chat/, as the contract its decomposition (a
// shell over chat/*.tsx leaves and the useChatStream and useChatHistory hooks) must keep: every test is a pin that
// drives the component through the shell, rendered under StrictMode as main.jsx renders App, so the dev-only unmount
// and remount at mount runs in every test.
// The recipes are the PR 3 attack report's (.claude/phase-5d/attack-chat-report.md, the history and tests lenses).
// Each reply is a body the test feeds by hand, a fresh one per request through installFetchRecorder, on real timers;
// the animation frames that flush streamed text to the screen run only when a test runs them, so a test can hold text
// in the chunk buffer, which is where a save that reads only the rendered messages loses it.
// Not pinned, because the two designs differ there or both keep a gap from today: a chat-detail event right after a
// ticker change (today ignores it while the detached reply finishes, the hooks reload), a pagehide or a ticker change
// between a frame's flush and React's commit (that frame's text is lost), and this chat's reload between a reply's
// settle and its commit (the reply is dropped).
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatBot from './ChatBot.jsx';
import { emitStoreChanged, setChatHistory } from '../lib/store.js';
import { subscribeStore } from '../lib/storeEvents.js';
import { withContexts } from '../test/contexts.jsx';
import { installFetchRecorder } from '../../test/helpers/fetch.js';

/** Market data as far as the history reads it: the ticker (the context builder copes with the rest missing). */
const dataFor = (ticker) => ({ ticker, kpis: {}, gexByStrike: [], flowHistory: [] });

/** The open, premium chat under StrictMode, on AVGO's data unless `data` says otherwise (null: none loaded yet). */
const chatUi = ({ data = dataFor('AVGO'), market = {} } = {}) => (
  <StrictMode>
    {withContexts(
      <ChatBot isOpen={true} onClose={() => {}} onOpenSettings={() => {}} costBasis={90} shares={100} />,
      { market: { data, ...market }, auth: { isPremium: true } },
    )}
  </StrictMode>
);

const encoder = new TextEncoder();
const textEv = (t) => `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`;
const stopEv = (r) => `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: r } })}\n\n`;
const errorEv = (type, message) => `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`;

/** One upstream reply the test feeds by hand: chunk(text), end(stop reason), raw(SSE frame); a cancel is recorded. */
function liveStream() {
  let ctrl;
  const state = { cancelled: null };
  const body = new ReadableStream({
    start(c) { ctrl = c; },
    cancel(reason) { state.cancelled = reason ?? 'cancelled'; },
  });
  return {
    state,
    response: () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic', 'X-Request-Id': 'req-1' },
    }),
    chunk: (t) => ctrl.enqueue(encoder.encode(textEv(t))),
    end: (r = 'end_turn') => { ctrl.enqueue(encoder.encode(stopEv(r))); ctrl.close(); },
    raw: (frame) => ctrl.enqueue(encoder.encode(frame)),
  };
}

/**
 * requestAnimationFrame and cancelAnimationFrame as a queue the test runs: both designs call the globals, and under
 * Vitest's jsdom `window` is the global object. restoreMocks puts the real ones back before the next test.
 */
function manualFrames() {
  const queue = new Map();
  let next = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { const id = next++; queue.set(id, cb); return id; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { queue.delete(id); });
  return {
    pending: () => queue.size,
    run: () => act(() => { const due = [...queue.values()]; queue.clear(); due.forEach((cb) => cb(performance.now())); }),
  };
}

let rec;
/** The upstream replies of the test, one per askLLM request, in request order. */
let streams;
let frames;

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const box = () => screen.getByPlaceholderText('Ask about the flow...');
/** A ticker's stored history, parsed; null while it has none. */
const stored = (ticker = 'AVGO') => JSON.parse(localStorage.getItem(`chat_history_${ticker}`) ?? 'null');
const chatKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('chat_history_')).sort();
/** The chat-history writes a Storage.prototype.setItem spy has seen. */
const chatWrites = (setItem) => setItem.mock.calls.filter(([key]) => key.startsWith('chat_history_'));

/** Types `text` and presses Enter, then waits for its askLLM request. */
async function send(text) {
  const n = rec.calls.length + 1;
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(rec.calls).toHaveLength(n));
}

/** Streams `text` into the chunk buffer: a frame is then due, and the text is not on screen until it runs. */
async function deliver(stream, text) {
  await act(async () => { stream.chunk(text); await tick(); });
}

/** Ends the reply and waits until the chat is idle again (the Send button back). */
async function end(stream, reason = 'end_turn') {
  await act(async () => { stream.end(reason); await tick(); });
  await screen.findByLabelText('Send message');
}

describe('ChatBot chat history', () => {
  beforeEach(() => {
    streams = [];
    rec = installFetchRecorder();
    rec.setFetch(async () => {
      const s = liveStream();
      streams.push(s);
      return s.response();
    });
    frames = manualFrames();
  });

  afterEach(() => rec.uninstall());

  it('Pin: a stored history is shown at mount', () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }]);
    render(chatUi());
    expect(screen.getByText('Earlier question')).toBeInTheDocument();
    expect(screen.getByText('Earlier answer')).toBeInTheDocument();
    expect(screen.queryByText('Ask questions about AVGO order flow, gamma, or positioning.')).toBeNull();
  });

  it('Pin: Delete message removes that message from the screen and from the stored history', () => {
    setChatHistory('AVGO', [
      { role: 'user', content: 'm0' }, { role: 'assistant', content: 'm1' }, { role: 'user', content: 'm2' },
    ]);
    render(chatUi());
    fireEvent.click(screen.getAllByLabelText('Delete message')[1]);
    expect(screen.queryByText('m1')).toBeNull();
    expect(stored()).toEqual([{ role: 'user', content: 'm0' }, { role: 'user', content: 'm2' }]);

    fireEvent.click(screen.getAllByLabelText('Delete message')[0]);
    expect(stored()).toEqual([{ role: 'user', content: 'm2' }]);
  });

  it('Pin: Clear asks first; a yes removes the stored history, a no keeps it', () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'Keep me?' }]);
    render(chatUi());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByLabelText('Clear chat history'));
    expect(confirm).toHaveBeenCalledWith('Clear all chat history for AVGO? This cannot be undone.');
    expect(screen.getByText('Keep me?')).toBeInTheDocument();
    expect(stored()).toEqual([{ role: 'user', content: 'Keep me?' }]);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByLabelText('Clear chat history'));
    expect(localStorage.getItem('chat_history_AVGO')).toBeNull();
    expect(screen.queryByText('Keep me?')).toBeNull();
    expect(screen.getByText('Ask questions about AVGO order flow, gamma, or positioning.')).toBeInTheDocument();
  });

  it('Pin: a ticker change mid-reply stores the old chat with its buffered text and drops the rest of the reply', async () => {
    setChatHistory('NVDA', [{ role: 'user', content: 'n1' }, { role: 'assistant', content: 'n2' }]);
    const view = render(chatUi());
    await send('Q');
    await deliver(streams[0], 'A');
    frames.run();
    expect(screen.getByText('A')).toBeInTheDocument();
    await deliver(streams[0], 'B');
    expect(frames.pending()).toBe(1); // 'B' is in the chunk buffer, not on screen

    view.rerender(chatUi({ data: dataFor('NVDA') }));
    expect(stored('AVGO')).toEqual([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'AB' }]);
    expect(screen.getByText('n1')).toBeInTheDocument();
    await screen.findByLabelText('Send message');
    expect(streams[0].state.cancelled).toBeTruthy();

    // Whatever was left of the old reply never reaches NVDA's chat, on screen or in the store.
    frames.run();
    await act(async () => { await tick(); await tick(); });
    expect(screen.getByText('n2')).toBeInTheDocument();
    expect(screen.queryByText('B')).toBeNull();
    expect(screen.queryByText('AB')).toBeNull();
    expect(screen.queryByText(/stopped/)).toBeNull();
    expect(stored('NVDA')).toEqual([{ role: 'user', content: 'n1' }, { role: 'assistant', content: 'n2' }]);
    expect(stored('AVGO')).toEqual([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'AB' }]);
  });

  // The stream's end and the market data's update can land in one batch: the old ticker's chat must not be written
  // under the new ticker by the persist the settle raised.
  it('Pin: a reply that settles in the same commit as a ticker change is stored under the old ticker only', async () => {
    const view = render(chatUi());
    await send('Q1');
    await deliver(streams[0], 'Hello');
    frames.run();
    await act(async () => {
      streams[0].end('end_turn');
      view.rerender(chatUi({ data: dataFor('NVDA') }));
      await tick(10);
    });
    expect(stored('AVGO')).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'Hello' }]);
    expect(localStorage.getItem('chat_history_NVDA')).toBeNull();
    expect(screen.queryByText('Hello')).toBeNull();
  });

  // Deleting the streaming bubble leaves no assistant tail; the text after it re-creates the reply without the
  // pending flag, so the settle changes nothing on screen and only the always-new array gets its write committed.
  it('Pin: a reply whose bubble was deleted mid-stream is stored as re-created when it settles', async () => {
    render(chatUi());
    await send('Q1');
    await deliver(streams[0], 'Hello');
    frames.run();
    fireEvent.click(screen.getAllByLabelText('Delete message')[1]);
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }]);

    await deliver(streams[0], ' world');
    frames.run();
    expect(screen.getByText('world')).toBeInTheDocument();
    await end(streams[0]);
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: ' world' }]);
  });

  it('Pin: a whole-store change (no detail) reloads the chat while no reply streams', () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'before' }]);
    render(chatUi());
    setChatHistory('AVGO', [{ role: 'user', content: 'imported' }]);
    act(() => { emitStoreChanged(); });
    expect(screen.getByText('imported')).toBeInTheDocument();
    expect(screen.queryByText('before')).toBeNull();

    // A plain Event carries no detail either.
    setChatHistory('AVGO', [{ role: 'user', content: 'rewritten' }]);
    act(() => { window.dispatchEvent(new Event('store-changed')); });
    expect(screen.getByText('rewritten')).toBeInTheDocument();
  });

  it('Pin: a whole-store change mid-reply drops the reply, shows the store and writes nothing', async () => {
    render(chatUi());
    await send('Q1');
    await deliver(streams[0], 'Second');
    frames.run();
    await deliver(streams[0], ' buffered');
    expect(frames.pending()).toBe(1);
    setChatHistory('AVGO', [{ role: 'user', content: 'imported' }]);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    act(() => { emitStoreChanged(); });
    expect(screen.getByText('imported')).toBeInTheDocument();
    expect(screen.queryByText('Q1')).toBeNull();
    expect(screen.queryByText(/Second/)).toBeNull();
    await screen.findByLabelText('Send message');
    expect(streams[0].state.cancelled).toBeTruthy();

    frames.run();
    await act(async () => { await tick(); });
    expect(screen.queryByText(/buffered/)).toBeNull();
    expect(chatWrites(setItem)).toEqual([]);
    expect(stored()).toEqual([{ role: 'user', content: 'imported' }]);
  });

  it("Pin: this chat's own change (kind chat, this ticker) reloads it while no reply streams", () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'one' }]);
    render(chatUi());
    setChatHistory('AVGO', [{ role: 'user', content: 'two' }]);
    act(() => { emitStoreChanged({ kind: 'chat', id: 'AVGO' }); });
    expect(screen.getByText('two')).toBeInTheDocument();
    expect(screen.queryByText('one')).toBeNull();
  });

  it("Pin: this chat's own change while a reply streams is ignored, and the settled reply is stored over it", async () => {
    render(chatUi());
    await send('Q1');
    await deliver(streams[0], 'Hello');
    frames.run();
    setChatHistory('AVGO', [{ role: 'user', content: 'elsewhere' }]);

    act(() => { emitStoreChanged({ kind: 'chat', id: 'AVGO' }); });
    expect(screen.queryByText('elsewhere')).toBeNull();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(streams[0].state.cancelled).toBeNull();

    await end(streams[0]);
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'Hello' }]);
  });

  it("Pin: another ticker's chat, a position or a preference changing leaves this chat as it is shown", () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'shown' }]);
    render(chatUi());
    setChatHistory('AVGO', [{ role: 'user', content: 'written without an event' }]);
    act(() => { emitStoreChanged({ kind: 'chat', id: 'NVDA' }); });
    act(() => { emitStoreChanged({ kind: 'position', id: 'AVGO' }); });
    act(() => { emitStoreChanged({ kind: 'pref', id: 'ai_model' }); });
    expect(screen.getByText('shown')).toBeInTheDocument();
    expect(screen.queryByText('written without an event')).toBeNull();
  });

  it('Pin: an unmount mid-reply stores the question and the reply as far as it got, buffered text included', async () => {
    const view = render(chatUi());
    await send('Q');
    await deliver(streams[0], 'A');
    frames.run();
    await deliver(streams[0], 'B');
    expect(frames.pending()).toBe(1);

    view.unmount();
    expect(stored()).toEqual([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'AB' }]);
    await act(async () => { await tick(); });
    expect(streams[0].state.cancelled).toBeTruthy();
  });

  it('Pin: a pagehide mid-reply stores the reply as far as it got, buffered text included, and the reply carries on', async () => {
    render(chatUi());
    await send('Q');
    await deliver(streams[0], 'A');
    expect(frames.pending()).toBe(1); // 'A' is buffered, the reply's bubble still empty

    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(stored()).toEqual([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);
    expect(frames.pending()).toBe(1);

    frames.run();
    await deliver(streams[0], ' more');
    frames.run();
    await end(streams[0]);
    expect(screen.getByText('A more')).toBeInTheDocument();
    expect(stored()).toEqual([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A more' }]);
  });

  // Sign-out clears the store and emits a no-detail change, and App's account-keyed remount unmounts the chat: in
  // one batch, the unmount runs while the dropped reply is still on screen and its stream not yet finished.
  it('Pin: a whole-store reset and an unmount in one batch, as at sign-out, leave no chat history behind', async () => {
    const view = render(chatUi());
    await send('Q');
    await deliver(streams[0], 'Part');
    frames.run();

    act(() => {
      localStorage.clear();
      emitStoreChanged();
      view.unmount();
    });
    expect(chatKeys()).toEqual([]);
    await act(async () => { await tick(); });
    expect(chatKeys()).toEqual([]);
  });

  it("Pin: the first market data loads its ticker's chat, and nothing is stored before it", async () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'AVGO history' }]);
    const view = render(chatUi({ data: null }));
    expect(screen.getByText('Default · — context')).toBeInTheDocument();
    await send('early');
    await deliver(streams[0], 'reply');
    frames.run();
    await end(streams[0]);
    expect(screen.getByText('reply')).toBeInTheDocument();
    expect(chatKeys()).toEqual(['chat_history_AVGO']);

    view.rerender(chatUi());
    expect(screen.getByText('AVGO history')).toBeInTheDocument();
    expect(screen.queryByText('early')).toBeNull();
    expect(chatKeys()).toEqual(['chat_history_AVGO']);
    expect(stored()).toEqual([{ role: 'user', content: 'AVGO history' }]);
  });

  it('Pin: before any market data, a reply in flight is stored under no key: not on pagehide, not on unmount', async () => {
    const view = render(chatUi({ data: null }));
    await send('early');
    expect(JSON.parse(rec.calls[0].init.body).ticker).toBe('UNKNOWN');
    await deliver(streams[0], 'partial');
    frames.run();

    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(chatKeys()).toEqual([]);
    view.unmount();
    expect(chatKeys()).toEqual([]);
  });

  // App moves the context's ticker as soon as a search is submitted; the data, and the chat with it, follow when
  // the new ticker's data lands.
  it("Pin: the chat follows the market data's ticker, not the context's", () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'AVGO chat' }]);
    const view = render(chatUi({ market: { ticker: 'NVDA' } }));
    expect(screen.getByText('Default · AVGO context')).toBeInTheDocument();
    expect(screen.getByText('AVGO chat')).toBeInTheDocument();

    view.rerender(chatUi({ market: { ticker: 'TSLA' } }));
    expect(screen.getByText('Default · AVGO context')).toBeInTheDocument();
    expect(screen.getByText('AVGO chat')).toBeInTheDocument();
  });

  it('Pin: under StrictMode, mounting writes nothing and a settled reply is written once', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(chatUi());
    expect(chatWrites(setItem)).toEqual([]);
    await send('Q1');
    await deliver(streams[0], 'Hello');
    frames.run();
    await end(streams[0]);
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'Hello' }]);
    expect(chatWrites(setItem).map(([key]) => key)).toEqual(['chat_history_AVGO']);
  });

  // Today's behaviour, kept as it is: Clear leaves the reply streaming, and its settle stores what came after the
  // Clear. Whether Clear should drop the reply instead is an open question, not this decomposition's to answer.
  it('Pin (known): Clear mid-reply lets the reply run on, and the rest of it is stored as a lone assistant turn', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(chatUi());
    await send('Q1');
    await deliver(streams[0], 'Hello');
    frames.run();
    fireEvent.click(screen.getByLabelText('Clear chat history'));
    expect(localStorage.getItem('chat_history_AVGO')).toBeNull();

    await deliver(streams[0], ' world');
    frames.run();
    await end(streams[0]);
    expect(stored()).toEqual([{ role: 'assistant', content: ' world' }]);
  });

  it('Pin: text after a deleted streaming bubble re-creates the reply, saved as one message at pagehide and at its settle', async () => {
    render(chatUi());
    await send('Q1');
    await deliver(streams[0], 'Hello');
    frames.run();
    fireEvent.click(screen.getAllByLabelText('Delete message')[1]);
    await deliver(streams[0], ' world');
    frames.run(); // the reply again, now without the pending flag
    await deliver(streams[0], ' more');
    expect(frames.pending()).toBe(1);

    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: ' world more' }]);
    frames.run();
    await end(streams[0]);
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: ' world more' }]);
  });

  it("Pin: no stored message carries the pending flag or the role 'error'", async () => {
    const unstorable = () => chatKeys()
      .flatMap((key) => JSON.parse(localStorage.getItem(key)))
      .filter((m) => 'pending' in m || m.role === 'error');
    render(chatUi());
    await send('Q1');
    act(() => { window.dispatchEvent(new Event('pagehide')); }); // the reply's bubble is still an empty placeholder
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }]);

    await deliver(streams[0], 'Part');
    frames.run();
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'Part' }]);

    await act(async () => { streams[0].raw(errorEv('overloaded_error', 'Overloaded')); await tick(); });
    await screen.findByLabelText('Send message');
    expect(screen.getByText('Failed to get analysis: Overloaded (ref req-1)')).toBeInTheDocument();
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'Part' }]);

    fireEvent.click(screen.getAllByLabelText('Delete message')[0]); // a persist point with the error bubble shown
    expect(screen.getByText('Failed to get analysis: Overloaded (ref req-1)')).toBeInTheDocument();
    expect(stored()).toEqual([{ role: 'assistant', content: 'Part' }]);
    expect(unstorable()).toEqual([]);
  });

  // Nothing tells the chat about its own writes: a reload after each would wipe an error bubble, which is shown and
  // never stored.
  it("Pin: the chat's own writes (a settle, a delete, a clear) emit no store-changed", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const seen = [];
    onTestFinished(subscribeStore((detail) => { seen.push(detail); }));
    render(chatUi());
    await send('Q1');
    await deliver(streams[0], 'Hello');
    frames.run();
    await end(streams[0]);
    expect(stored()).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'Hello' }]);
    fireEvent.click(screen.getAllByLabelText('Delete message')[0]);
    expect(stored()).toEqual([{ role: 'assistant', content: 'Hello' }]);
    fireEvent.click(screen.getByLabelText('Clear chat history'));
    expect(localStorage.getItem('chat_history_AVGO')).toBeNull();
    expect(seen).toEqual([]);
  });

  // A reload only reads the store. Here a delete's persist is still pending in the same batch, as a reply's settle can
  // be when an import lands: the store's history wins, and the pending persist must not write it back.
  it('Pin: a reload from the store writes nothing, even over a persist still pending', () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'm0' }, { role: 'assistant', content: 'm1' }]);
    render(chatUi());
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    act(() => {
      fireEvent.click(screen.getAllByLabelText('Delete message')[1]);
      emitStoreChanged();
    });
    expect(screen.getByText('m1')).toBeInTheDocument();
    expect(chatWrites(setItem)).toEqual([]);
    expect(stored()).toEqual([{ role: 'user', content: 'm0' }, { role: 'assistant', content: 'm1' }]);
  });

  // Clear writes the empty history itself, once: a persist still pending in its batch is superseded, so text that
  // reaches the screen after the Clear in that batch is not written until a later persist point stores it.
  it('Pin: Clear supersedes a persist still pending in its batch', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(chatUi());
    await send('Q1');
    await deliver(streams[0], 'Hello');
    frames.run();
    await deliver(streams[0], ' world');

    act(() => {
      fireEvent.click(screen.getAllByLabelText('Delete message')[0]);
      fireEvent.click(screen.getByLabelText('Clear chat history'));
      frames.run();
    });
    expect(screen.getByText('world')).toBeInTheDocument();
    expect(localStorage.getItem('chat_history_AVGO')).toBeNull();
    await end(streams[0]); // the reply's settle is that later persist point
  });
});
