// src/components/ChatBot.wiring.test.jsx — branches of the chat shell's send paths that the three pin files
// (ChatBot.test.jsx, ChatBot.stream.test.jsx, ChatBot.history.test.jsx) leave open, each kept from the one-file
// ChatBot.jsx where the decomposition split its one guard between the shell and useChatStream's start(): Enter on a
// blank draft sends nothing; until the reply has text, the typing indicator stands for it and its empty placeholder
// gets no bubble; Suggest updates carries the conversation window, as a send does; and a send that start() refuses
// while a reply streams keeps the draft and the composer's height; a request after a failed reply carries only user
// and assistant turns; before the first market data the empty state says 'the' order flow. Every test is a pin, green
// on the shell and on the old ChatBot.jsx, and each is red on the shell mutant named above it (the PR 3 reviews of the
// shell and of the whole PR, which found that removing any of these branches left the pin files and App.test.jsx green).
// The mechanics are the stream pin file's: StrictMode, as main.jsx renders App; askLLM answered through the fetch
// recorder with a fresh body the test drives per request; streams on real timers; requestAnimationFrame a manual
// queue, so streamed text reaches the screen only on a frame the test runs or on the settle (restoreMocks puts the
// real one back, and window.confirm, before the next test).
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatBot from './ChatBot.jsx';
import { setChatHistory } from '../lib/store.js';
import { CONTEXT_UPDATE_PROMPT } from '../lib/chatMessages.js';
import { withContexts } from '../test/contexts.jsx';
import { installFetchRecorder } from '../../test/helpers/fetch.js';

/** Market data the context builds from without a throw: the ticker and empty collections. */
const DATA = { ticker: 'AVGO', kpis: {}, gexByStrike: [], flowHistory: [] };

/** The chat as App renders it: open, premium, on DATA (or the market data given), under StrictMode. */
const chat = (data = DATA) => (
  <StrictMode>
    {withContexts(
      <ChatBot isOpen={true} onClose={() => {}} onOpenSettings={() => {}} costBasis={90} shares={100} />,
      { market: { data }, auth: { isPremium: true } },
    )}
  </StrictMode>
);

const encoder = new TextEncoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Anthropic SSE frames as askLLM relays them (X-Provider picks the parser). */
const sse = {
  text: (t) => (
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`
  ),
  stop: (reason) => `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } })}\n\n`,
  end: 'data: {"type":"message_stop"}\n\n',
};
const HEADERS = { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic', 'X-Request-Id': 'req-1' };

/** One askLLM reply the test drives: push() enqueues raw SSE, end() ends the reply normally. */
function controlledStream() {
  let ctl;
  const body = new ReadableStream({ start(c) { ctl = c; } });
  const push = (chunk) => ctl.enqueue(encoder.encode(chunk));
  return {
    response: () => new Response(body, { status: 200, headers: HEADERS }),
    push,
    end: () => { push(sse.stop('end_turn') + sse.end); ctl.close(); },
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
afterEach(() => rec.uninstall());

const EMPTY_STATE = 'Ask questions about AVGO order flow, gamma, or positioning.';
const turn = (role, content) => ({ role, content });
const box = () => screen.getByPlaceholderText('Ask about the flow...');
/** The message bubbles on screen: each carries its own Delete. */
const bubbleCount = () => screen.queryAllByLabelText('Delete message').length;
/** The typing indicator's dots. */
const dots = () => document.querySelectorAll('.pulse-glow').length;
/** The JSON body of the i-th askLLM request. */
const requestBody = (i = 0) => JSON.parse(rec.calls[i].init.body);

/** Hand the reader raw SSE for the i-th reply; its text waits in the chunk buffer for a frame or the settle. */
const deliver = (chunk, i = 0) => act(async () => { streams[i].push(chunk); await tick(); });

/** End the i-th reply with `text`, then wait for Send, so the reply's last updates land inside the wait. */
async function finish(text, i = 0) {
  await act(async () => { streams[i].push(sse.text(text)); streams[i].end(); await tick(); });
  await screen.findByLabelText('Send message');
}

describe("ChatBot: the shell's send paths", () => {
  // Mutant: sendMessage without its blank guard. The composer hands on the text as typed, and Send's disabled state,
  // which ChatBot.test.jsx pins, does not cover Enter.
  it('Pin: Enter on a blank draft sends nothing and shows nothing, and the draft stays', async () => {
    render(chat());
    fireEvent.change(box(), { target: { value: '   ' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await act(async () => { await tick(); });

    expect(rec.calls).toHaveLength(0);
    expect(bubbleCount()).toBe(0);
    expect(dots()).toBe(0);
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
    expect(box()).toHaveValue('   ');
    expect(box()).toBeEnabled();
  });

  // Mutant: the bubbles rendered without the pending filter, which shows the empty placeholder as a reply bubble,
  // Copy and Delete included, beside the typing indicator.
  it('Pin: until the reply has text, the typing indicator stands for it and its empty placeholder gets no bubble', async () => {
    render(chat());
    fireEvent.change(box(), { target: { value: 'Q' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(dots()).toBe(3);
    expect(bubbleCount()).toBe(1); // the question's
    expect(screen.getAllByLabelText('Copy message')).toHaveLength(1);

    await deliver(sse.text('Hel'));
    expect(bubbleCount()).toBe(1); // the text waits for its frame
    frames.run();
    expect(dots()).toBe(0);
    expect(bubbleCount()).toBe(2); // the reply's bubble comes with its first text
    expect(screen.getByText('Hel')).toBeInTheDocument();

    await finish('lo');
    expect(bubbleCount()).toBe(2);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  // u0 a0 u1 a1 … u5 a5: the last ten open on u1, a user turn.
  const ALTERNATING = Array.from({ length: 12 }, (_, i) => (
    turn(i % 2 ? 'assistant' : 'user', `${i % 2 ? 'a' : 'u'}${Math.floor(i / 2)}`)
  ));
  // A stored suggestions reply is an assistant turn of its own (s2): the last ten open on a1, trimmed to u2.
  const WITH_SUGGESTION = [...ALTERNATING.slice(0, 6), turn('assistant', 's2'), ...ALTERNATING.slice(6)];

  // Mutants: the suggestions' turns sent without the window (the whole history); the prompt put inside the window, as
  // a send's question is (red on the first row); the last ten sent without the trim to a user turn (red on the second).
  it.each([
    ['twelve alternating turns: the last ten, which open on a user turn', ALTERNATING, ALTERNATING.slice(2)],
    ['a history whose last ten open on an assistant turn: from the user turn after it', WITH_SUGGESTION, WITH_SUGGESTION.slice(4)],
  ])('Pin: Suggest updates carries the conversation window, then its prompt, as a send does: %s', async (_, history, expected) => {
    setChatHistory('AVGO', history);
    render(chat());
    fireEvent.click(screen.getByLabelText('Suggest updates to Strategic Context'));
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(requestBody().messages).toEqual([...expected, turn('user', CONTEXT_UPDATE_PROMPT)]);
    await finish('S');
  });

  // Mutants: the draft cleared, or the composer's height reset, before start() is asked. A send refused that way needs
  // a draft while a reply streams: one typed before Suggest updates stays in the disabled composer, and a Clear
  // mid-reply brings the empty state back, whose suggestions still send while the reply runs on.
  it('Pin: a send that start() refuses while a reply streams keeps the draft and the composer\'s height, and shows nothing', async () => {
    setChatHistory('AVGO', [turn('user', 'u0'), turn('assistant', 'a0')]);
    render(chat());
    fireEvent.change(box(), { target: { value: 'DRAFT' } });
    const height = box().style.height; // jsdom has no layout: the draft leaves '0px', where a send sets 'auto'
    expect(height).not.toBe('auto');

    fireEvent.click(screen.getByLabelText('Suggest updates to Strategic Context'));
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(box()).toBeDisabled();
    expect(box()).toHaveValue('DRAFT');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByLabelText('Clear chat history'));
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Is the flow bullish or bearish?' }));
    await act(async () => { await tick(); });
    expect(rec.calls).toHaveLength(1);
    expect(bubbleCount()).toBe(0);
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
    expect(box()).toHaveValue('DRAFT');
    expect(box().style.height).toBe(height);

    await finish('S');
    expect(rec.calls).toHaveLength(1);
    expect(box()).toBeEnabled();
    expect(box()).toHaveValue('DRAFT');
  });

  /** A provider error mid-reply, as askLLM relays it: the reply fails with the response's request id. */
  const SSE_ERROR = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`;
  const FAILED = 'Failed to get analysis: Overloaded (ref req-1)';
  /** A turn a provider accepts: a user's or the assistant's, with text, and no `pending` flag. */
  const providerTurn = (m) => (m.role === 'user' || m.role === 'assistant') && m.content !== '' && !('pending' in m);

  // Mutants: sendMessage's turns taken without the isTurn filter, so the error bubble goes upstream as a turn; the fail
  // sink without settleReply, so the reply's empty placeholder goes upstream, pending and all. Neither shows on screen
  // or in storage, because storableMessages strips both; only the next request carries them.
  it('Pin: after a reply failed before any text, the next send carries the question and the new one only', async () => {
    render(chat());
    fireEvent.change(box(), { target: { value: 'q1' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    await deliver(SSE_ERROR);
    await screen.findByText(FAILED);
    await screen.findByLabelText('Send message');

    fireEvent.change(box(), { target: { value: 'q2' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(rec.calls).toHaveLength(2));
    const sent = requestBody(1).messages;
    expect(sent).toEqual([turn('user', 'q1'), turn('user', 'q2')]);
    expect(sent.every(providerTurn)).toBe(true);
    await finish('A', 1);
  });

  // Mutant: the suggestions' turns taken without the isTurn filter (the error bubble upstream); the fail sink without
  // settleReply also fails it, since the partial reply would keep its `pending` flag.
  it('Pin: after a partial reply failed, Suggest updates carries the question and the partial reply, then its prompt', async () => {
    render(chat());
    fireEvent.change(box(), { target: { value: 'q1' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    await deliver(sse.text('Part'));
    frames.run();
    await deliver(SSE_ERROR);
    await screen.findByText(FAILED);
    await screen.findByLabelText('Send message');

    fireEvent.click(screen.getByLabelText('Suggest updates to Strategic Context'));
    await waitFor(() => expect(rec.calls).toHaveLength(2));
    const sent = requestBody(1).messages;
    expect(sent).toEqual([turn('user', 'q1'), turn('assistant', 'Part'), turn('user', CONTEXT_UPDATE_PROMPT)]);
    expect(sent.every(providerTurn)).toBe(true);
    await finish('S', 1);
  });

  // Mutant: the empty state's fallback dropped ("Ask questions about  order flow"). Kept from the one-file ChatBot.
  it("Pin: before the first market data the empty state asks about 'the' order flow", () => {
    render(chat(null));
    expect(screen.getByText('Ask questions about the order flow, gamma, or positioning.')).toBeInTheDocument();
    expect(screen.getByText('Default · — context')).toBeInTheDocument();
  });
});
