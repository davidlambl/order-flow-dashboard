// src/components/chat/ContextInspector.test.jsx — the chat's context inspector, rendered bare (it takes only the
// shell's buildContext): the <pre> shows what buildContext returns for the clock's time and the header counts its
// characters; the text is built once per buildContext and minute: a parent re-render with the same function does not
// render the leaf (memo), its own Copy re-render reuses the text, a new function rebuilds it at once and the minute
// tick with the later time; Copy writes the text shown and reads Copied for 1.5 s from the last click; an unmount with
// the flash pending leaves no timer behind. useNow is the real hook behind a call count, one call per render of the
// leaf. Each clock test installs its own fake timers (Date alone for the frozen render, shouldAdvanceTime where the
// clock must move, as useCountdown.test.jsx does) and afterEach restores the real ones; userEvent.setup() comes before
// the clipboard spy, since it installs a clipboard of its own over any defined earlier.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContextInspector from './ContextInspector.js';

const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../hooks/useNow.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNow: (intervalMs) => { renders.count += 1; return actual.useNow(intervalMs); } };
});

const START = new Date('2026-09-25T15:00:00Z');

/** A builder in the context's shape that counts its calls; its TIMESTAMP line follows `now`. */
const counting = (ticker = 'AVGO') => vi.fn((now) => `TICKER: ${ticker}\nTIMESTAMP: ${new Date(now).toISOString()}\n`);

const pre = () => document.querySelector('pre');
const copyButton = () => screen.getByRole('button', { name: 'Copy' });
const copiedButton = () => screen.getByRole('button', { name: 'Copied' });

/** Move the fake clock inside act, firing every timer due on the way. */
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('ContextInspector', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows buildContext's text for the current time and counts its characters", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const rows = 'ROW\n'.repeat(300);
    const build = vi.fn((now) => `TICKER: AVGO\nTIMESTAMP: ${new Date(now).toISOString()}\n${rows}`);
    render(<ContextInspector buildContext={build} />);

    expect(build.mock.calls).toEqual([[START.getTime()]]);
    const text = `TICKER: AVGO\nTIMESTAMP: 2026-09-25T15:00:00.000Z\n${rows}`;
    expect(pre().textContent).toBe(text);
    expect(screen.getByText(`Model Context (${text.length.toLocaleString()} chars)`)).toBeInTheDocument();
  });

  it('builds once per buildContext: a parent re-render with the same function skips the leaf, its Copy re-render reuses the text, a new function rebuilds', async () => {
    const user = userEvent.setup();
    const build = counting();
    renders.count = 0;
    const { rerender } = render(<ContextInspector buildContext={build} />);
    expect(renders.count).toBe(1);
    expect(build).toHaveBeenCalledTimes(1);
    const shown = pre().textContent;

    rerender(<ContextInspector buildContext={build} />);
    expect(renders.count).toBe(1);

    await user.click(copyButton());
    expect(copiedButton()).toBeInTheDocument();
    expect(renders.count).toBe(2);
    expect(build).toHaveBeenCalledTimes(1);
    expect(pre().textContent).toBe(shown);

    const next = counting('NVDA');
    rerender(<ContextInspector buildContext={next} />);
    expect(next).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(pre().textContent).toMatch(/^TICKER: NVDA\n/);
  });

  it('rebuilds with the later time when the minute ticks, and not before', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(START);
    const build = counting();
    render(<ContextInspector buildContext={build} />);
    expect(build).toHaveBeenCalledTimes(1);
    const first = build.mock.calls[0][0];

    await advance(30_000);
    expect(build).toHaveBeenCalledTimes(1);

    await advance(30_000);
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[1][0] - first).toBeGreaterThanOrEqual(60_000);
    expect(pre().textContent).toBe(build.mock.results[1].value);
    expect(pre().textContent).toMatch(/^TICKER: AVGO\nTIMESTAMP: 2026-09-25T15:01:/);
  });

  it('Copy writes the text shown to the clipboard and reads Copied, then Copy again after 1.5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<ContextInspector buildContext={counting()} />);

    await user.click(copyButton());
    expect(writeText.mock.calls).toEqual([[pre().textContent]]);
    expect(copiedButton()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();

    await advance(1_500);
    expect(copyButton()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('a second Copy during the flash starts its 1.5 s again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<ContextInspector buildContext={counting()} />);

    await user.click(copyButton());
    await advance(1_000);
    await user.click(copiedButton());
    expect(writeText).toHaveBeenCalledTimes(2);

    await advance(1_000);
    expect(copiedButton()).toBeInTheDocument();
    await advance(500);
    expect(copyButton()).toBeInTheDocument();
  });

  // React 19 drops a late update to an unmounted component without a word, so the timer count is what shows the
  // cleanup ran.
  it('leaves no timer behind when it unmounts with the flash pending, and nothing is reported', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const error = vi.spyOn(console, 'error');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<ContextInspector buildContext={counting()} />);
    await user.click(copyButton());
    expect(copiedButton()).toBeInTheDocument();

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(1_500);
    expect(error).not.toHaveBeenCalled();
  });
});
