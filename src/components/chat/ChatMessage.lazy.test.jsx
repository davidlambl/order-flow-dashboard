// src/components/chat/ChatMessage.lazy.test.jsx — a reply's bubble around its markdown renderer, which ChatMessage
// loads on demand (ChatMarkdown, with react-markdown and remark-gfm). While the import is held, a reply shows its raw
// text in the block a question renders in, rebuilt from every frame's content; once the renderer is in, the same bubble
// renders the markdown, its Copy state kept, and a bubble mounted after renders it at once; a renderer that cannot load
// leaves the raw text with no failure card, asks for nothing more, and gives way to the markdown when a later reply's
// import brings it in; a question and an error line never go through the renderer; the idle preload loads it; a bubble
// unmounted while the renderer loads (the chat closed) leaves its next mount to import again, one that fell back is no
// longer told once it has gone, and a reply streaming while the renderer loads falls back after its one import. This
// file opts out of the setup's preload and holds each test's import with an importGate (src/test/lazy.js), so every
// test starts with the renderer not loaded; every import a test starts is settled before it ends, since one still held
// would keep the next test's import of the module from reaching its gate. Bubbles render bare and outside StrictMode,
// as in ChatMessage.test.jsx.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import ChatMessage from './ChatMessage.js';
import ChunkBoundary from '../ChunkBoundary.js';
import { scheduleIdlePreload } from '../../lib/lazyWithPreload.js';
import { importGate, skipLazyPreload } from '../../test/lazy.js';

skipLazyPreload();

const OFFLINE = 'Failed to fetch dynamically imported module: /assets/ChatMarkdown-1a2b3c.js';

let renderer;
beforeEach(() => {
  renderer = importGate();
  vi.doMock('./ChatMarkdown.js', renderer.factory);
});

const reply = (content) => ({ role: 'assistant', content });
const question = (content) => ({ role: 'user', content });
const noop = () => {};

/** The shell's message list as it reaches the bubbles: one onDelete for every bubble, the index as the key. */
function Thread({ messages }) {
  return messages.map((msg, i) => <ChatMessage key={i} index={i} msg={msg} onDelete={noop} />);
}

/** The plain-text blocks on screen, in order: a question's, an error line's and a raw reply's. */
const rawTexts = () => [...document.querySelectorAll('.whitespace-pre-wrap')].map((el) => el.textContent);
/** The message's text box: the role's colours sit on it. */
const bubbleOf = (el) => el.closest('.rounded-xl');
/** React reports what a boundary catches; the failure tests fail the import on purpose. */
const silenceCaughtErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});
/** Real time for an import asked for to reach its gate: it takes a few event-loop turns, a few milliseconds at most. */
const timeForAnImport = () => act(() => new Promise((resolve) => setTimeout(resolve, 100)));

describe('while the renderer loads', () => {
  // First: nothing has loaded the renderer before this test, so its import through the gate also shows that importing
  // ChatMessage does not load it.
  it("shows a reply's raw text in the block a question renders in, rebuilt from every frame's content", async () => {
    const { container, rerender } = render(<Thread messages={[reply('**Levels** at 95')]} />);
    const raw = container.querySelector('.whitespace-pre-wrap');
    expect(raw.outerHTML).toBe('<div class="whitespace-pre-wrap">**Levels** at 95</div>');
    expect(bubbleOf(raw)).toHaveClass('bg-[var(--color-surface-3)]', 'border-[var(--color-border-subtle)]');
    expect(container.querySelector('.lucide-bot')).not.toBeNull();
    expect(container.querySelector('strong')).toBeNull();

    // Streaming frames: the same bubble, a new message object each time.
    rerender(<Thread messages={[reply('**Levels** at 95, then')]} />);
    expect(rawTexts()).toEqual(['**Levels** at 95, then']);
    rerender(<Thread messages={[reply('**Levels** at 95, then 100')]} />);
    expect(rawTexts()).toEqual(['**Levels** at 95, then 100']);
    expect(container.querySelector('strong')).toBeNull();
    await vi.waitFor(() => expect(renderer.imports).toBe(1));

    await act(() => renderer.resolve());
    expect(screen.getByText('Levels').tagName).toBe('STRONG');
  });

  it("then renders the markdown in the same bubble, bold and a GFM table, with Copy's 'Copied!' kept", async () => {
    // setTimeout alone is faked, and never advanced, so 'Copied!' cannot run out while the import is held. user-event
    // only installs its clipboard (jsdom has none): its click would wait on a timeout of Testing Library's.
    userEvent.setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const content = '**Levels**\n\n| Strike | GEX |\n|---|---|\n| 95 | -2.0M |';
    const { container } = render(<Thread messages={[reply(content)]} />);
    const copy = screen.getByLabelText('Copy message');
    fireEvent.click(copy);
    expect(copy).toHaveAttribute('title', 'Copied!');
    expect(rawTexts()).toEqual([content]);

    await act(() => renderer.resolve());
    expect(rawTexts()).toEqual([]);
    expect(screen.getByText('Levels').tagName).toBe('STRONG');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '-2.0M' })).toBeInTheDocument();
    expect(screen.getByLabelText('Copy message')).toBe(copy);
    expect(copy).toHaveAttribute('title', 'Copied!');
    expect(container.querySelector('.lucide-check')).not.toBeNull();
  });

  it('a question and an error line never go through it: plain text, before and after it loads', async () => {
    const thread = [question('**Q**'), { role: 'error', content: '**E**' }];
    const { rerender } = render(<Thread messages={thread} />);
    expect(rawTexts()).toEqual(['**Q**', '**E**']);
    await timeForAnImport();
    expect(renderer.imports).toBe(0);

    // A reply asks for it, and loads a stand-in that would show wherever the renderer rendered.
    rerender(<Thread messages={[...thread, reply('**R**')]} />);
    await vi.waitFor(() => expect(renderer.imports).toBe(1));
    await act(() => renderer.resolve({ default: ({ content }) => <p>rendered {content}</p> }));
    expect(screen.getAllByText(/^rendered /).map((p) => p.textContent)).toEqual(['rendered **R**']);
    expect(rawTexts()).toEqual(['**Q**', '**E**']);
  });
});

describe('once the renderer is in', () => {
  it('a bubble mounted after renders the markdown at once, and nothing is imported again', async () => {
    const { rerender } = render(<Thread messages={[reply('**First**')]} />);
    await act(() => renderer.resolve());

    rerender(<Thread messages={[reply('**First**'), question('Q2'), reply('**Second**')]} />);
    expect(screen.getByText('Second').tagName).toBe('STRONG');
    expect(rawTexts()).toEqual(['Q2']);
    expect(renderer.imports).toBe(1);
  });
});

describe('a renderer that cannot load', () => {
  it('leaves the raw text, with no failure card, still rebuilt from every frame', async () => {
    silenceCaughtErrors();
    const { rerender } = render(<Thread messages={[reply('**Part** one')]} />);

    await act(() => renderer.reject(new TypeError(OFFLINE)));
    expect(rawTexts()).toEqual(['**Part** one']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    rerender(<Thread messages={[reply('**Part** one, two')]} />);
    expect(rawTexts()).toEqual(['**Part** one, two']);
  });

  it('asks for nothing more while no other import brings the renderer in', async () => {
    silenceCaughtErrors();
    render(<Thread messages={[reply('**Part**')]} />);
    await act(() => renderer.reject(new TypeError(OFFLINE)));

    await timeForAnImport();
    expect(renderer.imports).toBe(1);
    expect(rawTexts()).toEqual(['**Part**']);
  });

  it("a bubble that fell back takes the markdown up in place once a later reply's import brings the renderer in", async () => {
    silenceCaughtErrors();
    const { rerender } = render(<Thread messages={[reply('**First**')]} />);
    await act(() => renderer.reject(new TypeError(OFFLINE)));
    const firstCopy = screen.getByLabelText('Copy message');

    // The next reply imports again: until it lands, both replies are raw text.
    rerender(<Thread messages={[reply('**First**'), question('Q2'), reply('**Second**')]} />);
    expect(rawTexts()).toEqual(['**First**', 'Q2', '**Second**']);
    await vi.waitFor(() => expect(renderer.imports).toBe(2));

    await act(() => renderer.resolve());
    expect(screen.getByText('Second').tagName).toBe('STRONG');
    expect(screen.getByText('First').tagName).toBe('STRONG');
    expect(rawTexts()).toEqual(['Q2']);
    expect(screen.getAllByLabelText('Copy message')[0]).toBe(firstCopy);
    expect(renderer.imports).toBe(2);
  });
});

describe('the idle preload', () => {
  it('loads the renderer, so the first reply renders its markdown at once', async () => {
    const idle = [];
    scheduleIdlePreload({
      requestIdleCallback: (run) => idle.push(run),
      cancelIdleCallback: noop,
      setTimeout,
      clearTimeout,
      navigator: {},
    });
    expect(idle).toHaveLength(1);

    idle[0]();
    await vi.waitFor(() => expect(renderer.imports).toBe(1));
    await act(() => renderer.resolve());
    render(<Thread messages={[reply('**Ready**')]} />);

    expect(screen.getByText('Ready').tagName).toBe('STRONG');
    expect(rawTexts()).toEqual([]);
    expect(renderer.imports).toBe(1);
  });
});

// ChatBot renders nothing while closed: closing the chat unmounts every bubble, as deleting a reply unmounts a bubble's boundary.
describe('a bubble that unmounts while the renderer loads', () => {
  it('leaves nothing behind: mounted again after the import failed, it imports again, then shows markdown', async () => {
    silenceCaughtErrors();
    const { rerender } = render(<Thread messages={[reply('**Levels** at 95')]} />);
    await vi.waitFor(() => expect(renderer.imports).toBe(1));
    rerender(<Thread messages={[]} />);
    await act(() => renderer.reject(new TypeError(OFFLINE)));

    rerender(<Thread messages={[reply('**Levels** at 95')]} />);
    expect(rawTexts()).toEqual(['**Levels** at 95']);
    await vi.waitFor(() => expect(renderer.imports).toBe(2));
    await act(() => renderer.resolve());
    expect(screen.getByText('Levels').tagName).toBe('STRONG');
    expect(rawTexts()).toEqual([]);
  });
});

describe('a bubble that fell back, once it is gone', () => {
  it('Pin: is no longer told when a later import brings the renderer in, while one still on screen is', async () => {
    silenceCaughtErrors();
    const boundaryRenders = vi.spyOn(ChunkBoundary.prototype, 'render');
    const { rerender } = render(<Thread messages={[reply('**Kept**'), reply('**Gone**')]} />);
    // The renderer's lazy, as a bubble hands it to its boundary: a bubble that fell back is told through its preload().
    const told = vi.spyOn(boundaryRenders.mock.contexts[0].props.children.type, 'preload');
    await act(() => renderer.reject(new TypeError(OFFLINE)));
    expect(rawTexts()).toEqual(['**Kept**', '**Gone**']);

    rerender(<Thread messages={[reply('**Kept**')]} />);
    rerender(<Thread messages={[reply('**Kept**'), question('Q2'), reply('**Next**')]} />);
    await vi.waitFor(() => expect(renderer.imports).toBe(2));
    await act(() => renderer.resolve());

    expect(screen.getByText('Kept').tagName).toBe('STRONG');
    expect(screen.getByText('Next').tagName).toBe('STRONG');
    expect(rawTexts()).toEqual(['Q2']);
    expect(told).toHaveBeenCalledTimes(1);
  });
});

// Every frame of a streaming reply renders its bubble's boundary again: a release reached that way would retry the
// import for as long as the reply streams.
describe('a reply that streams while the renderer loads', () => {
  it('Pin: falls back after its one import when that fails, however many frames rendered its bubble', async () => {
    silenceCaughtErrors();
    const { rerender } = render(<Thread messages={[reply('**Part**')]} />);
    rerender(<Thread messages={[reply('**Part** one')]} />);
    rerender(<Thread messages={[reply('**Part** one, two')]} />);
    await vi.waitFor(() => expect(renderer.imports).toBe(1));

    await act(() => renderer.reject(new TypeError(OFFLINE)));
    rerender(<Thread messages={[reply('**Part** one, two, three')]} />);
    await timeForAnImport();
    expect(renderer.imports).toBe(1);
    expect(rawTexts()).toEqual(['**Part** one, two, three']);
  });
});
