// src/components/ChatBot.memo.test.jsx — the bubbles stay memoised with Retry on screen: a keystroke in the composer
// renders no bubble again, the retryable one included, because onRetry goes to the last bubble alone and keeps one
// identity while the messages stay the same. Renders are counted where a bubble draws: ReactMarkdown for a reply (as
// ChatMessage.test.jsx counts it) and the Retry button's icon for the error bubble, both wrapped by a module mock, so
// StrictMode's double render counts twice the same before and after the keystrokes.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatBot from './ChatBot.jsx';
import { setChatHistory } from '../lib/store.js';
import { withContexts } from '../test/contexts.jsx';
import { installFetchRecorder } from '../../test/helpers/fetch.js';

const counts = vi.hoisted(() => ({ markdown: 0, retryIcon: 0 }));
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal();
  const Real = actual.default;
  return { ...actual, default: (props) => { counts.markdown += 1; return <Real {...props} />; } };
});
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal();
  const Real = actual.RotateCcw;
  return { ...actual, RotateCcw: (props) => { counts.retryIcon += 1; return <Real {...props} />; } };
});

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
const SSE_ERROR = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`;

let rec;
let streams;
beforeEach(() => {
  streams = [];
  rec = installFetchRecorder();
  rec.setFetch(() => {
    let ctl;
    const body = new ReadableStream({ start(c) { ctl = c; } });
    streams.push({ push: (chunk) => ctl.enqueue(encoder.encode(chunk)) });
    return Promise.resolve(new Response(body, {
      status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic', 'X-Request-Id': 'req-1' },
    }));
  });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  counts.markdown = 0;
  counts.retryIcon = 0;
});
afterEach(() => rec.uninstall());

const box = () => screen.getByPlaceholderText('Ask about the flow...');

describe('ChatBot: the bubbles stay memoised with Retry on screen', () => {
  it('a keystroke in the composer renders no bubble again, the retryable one included', async () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'u0' }, { role: 'assistant', content: 'a0' }]);
    render(chat());
    fireEvent.change(box(), { target: { value: 'Q' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    await act(async () => { streams[0].push(SSE_ERROR); await tick(); });
    await screen.findByLabelText('Send message');
    expect(screen.getByRole('button', { name: 'Retry this request' })).toBeInTheDocument();
    const before = { ...counts };
    expect(before.markdown).toBeGreaterThan(0);
    expect(before.retryIcon).toBeGreaterThan(0);

    fireEvent.change(box(), { target: { value: 'a' } });
    fireEvent.change(box(), { target: { value: 'ab' } });
    expect(box()).toHaveValue('ab');
    expect(counts).toEqual(before);
  });
});
