// src/components/ChatBot.composer.test.jsx — the composer while a reply streams, and where focus goes, through the
// whole chat with userEvent (fireEvent reaches a disabled textarea in React, and jsdom leaves focus on a textarea that
// turns disabled, so neither could show the change). The textarea stays enabled and focused after a send by Enter and
// takes what is typed while the reply streams; Enter then sends nothing and keeps the draft and its height, and the
// draft goes once the reply has ended. A start from a button that then unmounts or hides puts focus in the composer:
// Retry, Suggest updates and a suggestion of the empty state. The mechanics are the stream pin file's: StrictMode,
// askLLM answered through the fetch recorder with a body the test drives, real timers, frames a manual queue.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatBot from './ChatBot.jsx';
import { setChatHistory } from '../lib/store.js';
import { withContexts } from '../test/contexts.jsx';
import { expectNoAxeViolations } from '../test/a11y.js';
import { installFetchRecorder } from '../../test/helpers/fetch.js';

const DATA = { ticker: 'AVGO', kpis: {}, gexByStrike: [], flowHistory: [] };

const chat = () => (
  <StrictMode>
    {withContexts(
      <ChatBot isOpen={true} onClose={() => {}} onOpenSettings={() => {}} costBasis={90} shares={100} />,
      { market: { data: DATA }, auth: { isPremium: true } },
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

let rec;
let streams;
beforeEach(() => {
  streams = [];
  rec = installFetchRecorder();
  rec.setFetch(() => { const s = controlledStream(); streams.push(s); return Promise.resolve(s.response()); });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1); // frames never run: text waits for the end
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => rec.uninstall());

const box = () => screen.getByRole('textbox', { name: 'Message the AI Co-Pilot' });
const composerBack = () => screen.findByLabelText('Send message');
const requestBody = (i) => JSON.parse(rec.calls[i].init.body);

/** The i-th reply ends normally with `text`. */
async function finish(i, text) {
  await act(async () => { streams[i].push(sse.text(text) + sse.stop('end_turn') + sse.end); streams[i].close(); await tick(); });
  await composerBack();
}

describe('ChatBot: the composer while a reply streams', () => {
  it('stays enabled and focused after a send by Enter, and takes what is typed while the reply streams', async () => {
    const user = userEvent.setup();
    const { container } = render(chat());
    await user.click(box());
    await user.type(box(), 'Q{Enter}');
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(screen.getByLabelText('Stop generating')).toBeInTheDocument();
    expect(box()).toBeEnabled();
    expect(document.activeElement).toBe(box());

    await user.type(box(), 'Next question');
    expect(box()).toHaveValue('Next question');
    await expectNoAxeViolations(container); // the composer enabled, with a draft, while the reply streams
    await finish(0, 'A');
  });

  it('Enter while a reply streams sends nothing and keeps the draft and its height; once the reply ends, Enter sends it', async () => {
    const user = userEvent.setup();
    render(chat());
    await user.type(box(), 'Q{Enter}');
    await waitFor(() => expect(rec.calls).toHaveLength(1));

    await user.type(box(), 'NEXT');
    const height = box().style.height; // jsdom has no layout: a typed draft leaves '0px', where a send sets 'auto'
    expect(height).not.toBe('auto');
    await user.keyboard('{Enter}');
    await act(async () => { await tick(); });
    expect(rec.calls).toHaveLength(1);
    expect(box()).toHaveValue('NEXT');
    expect(box().style.height).toBe(height);
    expect(screen.queryAllByText('NEXT').filter((el) => el.tagName !== 'TEXTAREA')).toHaveLength(0);

    await finish(0, 'A');
    expect(box()).toHaveValue('NEXT');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(rec.calls).toHaveLength(2));
    expect(requestBody(1).messages.at(-1)).toEqual({ role: 'user', content: 'NEXT' });
    expect(box()).toHaveValue('');
    await finish(1, 'B');
  });
});

describe('ChatBot: focus after a start from a button that goes', () => {
  it('Retry: the composer has focus', async () => {
    const user = userEvent.setup();
    render(chat());
    await user.type(box(), 'Q{Enter}');
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    await act(async () => { streams[0].push(sse.error); await tick(); });
    await composerBack();

    await user.click(screen.getByRole('button', { name: 'Retry this request' }));
    await waitFor(() => expect(rec.calls).toHaveLength(2));
    expect(document.activeElement).toBe(box());
    await finish(1, 'A');
  });

  it('Suggest updates: the composer has focus', async () => {
    const user = userEvent.setup();
    setChatHistory('AVGO', [{ role: 'user', content: 'u0' }, { role: 'assistant', content: 'a0' }]);
    render(chat());
    await user.click(screen.getByRole('button', { name: 'Suggest updates to Strategic Context' }));
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(document.activeElement).toBe(box());
    await finish(0, 'S');
  });

  it('a suggestion of the empty state: the composer has focus', async () => {
    const user = userEvent.setup();
    render(chat());
    await user.click(screen.getByRole('button', { name: 'Is the flow bullish or bearish?' }));
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(document.activeElement).toBe(box());
    await finish(0, 'A');
  });
});
