// src/components/chat/ChatMessage.test.jsx — one bubble of the chat, rendered bare (it reads no context) and outside
// StrictMode, so each render counts once. The memo boundary first: ReactMarkdown is wrapped to count its renders, and a
// thread rendered again with the same message objects (as a keystroke in the composer renders the shell) renders no
// markdown again, while a streaming frame, a new array whose last reply is a new object, renders that reply alone. Then
// the roles: a question and an error line as plain text in their own colours, a reply as markdown (a fenced block as a
// block, inline code as a pill, a table in its scrolling wrapper). Copy puts the raw markdown on the clipboard: every
// test that clicks it calls userEvent.setup() first, which installs user-event's clipboard (jsdom has none), and spies
// on it after. 'Copied!' lasts 1.5 s, on a fake clock of that test's own that also moves with real time, so the title
// is read well before the reset and after it, never at the boundary. Delete hands the bubble's index back.
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatMessage from './ChatMessage.js';

const counts = vi.hoisted(() => ({ markdown: 0 }));
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal();
  const Real = actual.default;
  return { ...actual, default: (props) => { counts.markdown += 1; return <Real {...props} />; } };
});

const reply = (n) => ({ role: 'assistant', content: `**Reply ${n}**\n\n- point a\n- point b` });

/** The shell's message list as it reaches the bubbles: one onDelete for every bubble, the index as the key. */
function Thread({ messages, onDelete }) {
  return messages.map((msg, i) => <ChatMessage key={i} index={i} msg={msg} onDelete={onDelete} />);
}

/** The message's text box: the role's colours sit on it, and on a plain-text message it wraps the text. */
const bubbleOf = (el) => el.closest('.rounded-xl');

describe('ChatMessage', () => {
  beforeEach(() => {
    counts.markdown = 0;
  });

  it('renders the markdown again only for a new message object: a frame renders the reply it extends alone', () => {
    const onDelete = vi.fn();
    const thread = [reply(1), { role: 'user', content: 'Q2' }, reply(3), { role: 'assistant', content: 'Part', pending: true }];
    const { rerender } = render(<Thread messages={thread} onDelete={onDelete} />);
    expect(counts.markdown).toBe(3); // the three replies; the question is plain text

    // The shell renders again with the same message objects, as on a keystroke in the composer.
    rerender(<Thread messages={[...thread]} onDelete={onDelete} />);
    expect(counts.markdown).toBe(3);

    // A frame appends to the streaming reply: a new array, and a new object for that reply only.
    rerender(<Thread messages={[...thread.slice(0, -1), { ...thread[3], content: 'Part two' }]} onDelete={onDelete} />);
    expect(counts.markdown).toBe(4);
    expect(screen.getByText('Part two')).toBeInTheDocument();
    expect(screen.getByText('Reply 1')).toBeInTheDocument();
  });

  it("shows the user's question as plain text in the accent colours, on the right", () => {
    const content = 'Is **this** a `pin`?\nSecond line';
    const { container } = render(<ChatMessage msg={{ role: 'user', content }} index={0} onDelete={vi.fn()} />);
    const text = container.querySelector('.whitespace-pre-wrap');
    expect(text.textContent).toBe(content);
    expect(text.children).toHaveLength(0);
    expect(bubbleOf(text)).toHaveClass('bg-[var(--color-accent)]/10', 'border-[var(--color-accent)]/20');
    expect(container.firstChild).toHaveClass('flex-row-reverse');
    expect(container.querySelector('.lucide-user')).not.toBeNull();
    expect(counts.markdown).toBe(0);
  });

  it('shows an error line as plain text in the bear colours, beside the alert icon', () => {
    const content = 'Failed to get analysis: Overloaded (ref req-1)';
    const { container } = render(<ChatMessage msg={{ role: 'error', content }} index={0} onDelete={vi.fn()} />);
    const text = screen.getByText(content);
    expect(text).toHaveClass('whitespace-pre-wrap');
    expect(bubbleOf(text)).toHaveClass('bg-[var(--color-bear-bg)]', 'text-[var(--color-bear)]', 'border-[var(--color-bear)]/20');
    expect(container.firstChild).not.toHaveClass('flex-row-reverse');
    expect(container.querySelector('.lucide-circle-alert')).not.toBeNull();
    expect(counts.markdown).toBe(0);
  });

  it('renders a reply as markdown: a fenced block as a block, inline code as a pill, a table in its scrolling wrapper, a link in a new tab', () => {
    const content = '### Levels\n\nThe `pin` is **100**. See [site](https://example.com/x).\n\n```\nGEX flip 97.5\n```\n\n| Strike | GEX |\n|---|---|\n| 95 | -2.0M |';
    const { container } = render(<ChatMessage msg={{ role: 'assistant', content }} index={0} onDelete={vi.fn()} />);
    expect(counts.markdown).toBe(1);
    expect(container.querySelector('.whitespace-pre-wrap')).toBeNull();
    expect(container.querySelector('.lucide-bot')).not.toBeNull();

    const block = container.querySelector('pre > code.font-mono.whitespace-pre');
    expect(block.textContent).toBe('GEX flip 97.5\n');
    expect(block.className).toBe('font-mono whitespace-pre');
    const inline = screen.getByText('pin');
    expect(inline.tagName).toBe('CODE');
    expect(inline).toHaveClass('bg-[var(--color-surface-2)]', 'px-1', 'rounded', 'font-mono');
    const table = container.querySelector('table');
    expect(table).toHaveClass('min-w-full');
    expect(table.parentElement).toHaveClass('overflow-x-auto', 'mb-2', '-mx-1');
    expect(screen.getByRole('cell', { name: '-2.0M' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Levels' })).toBeInTheDocument();
    expect(screen.getByText('100').tagName).toBe('STRONG');
    const link = screen.getByRole('link', { name: 'site' });
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(bubbleOf(block)).toHaveClass('bg-[var(--color-surface-3)]', 'border-[var(--color-border-subtle)]');
  });

  it('Copy puts the raw markdown on the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const content = '**Bold** reply with `code`';
    render(<ChatMessage msg={{ role: 'assistant', content }} index={0} onDelete={vi.fn()} />);

    await user.click(screen.getByLabelText('Copy message'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(content);
    expect(await navigator.clipboard.readText()).toBe(content);
  });

  it("reads 'Copied!' for 1.5 s after a copy, then 'Copy markdown' again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => { vi.useRealTimers(); });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ChatMessage msg={{ role: 'user', content: 'Q' }} index={0} onDelete={vi.fn()} />);
    const copy = screen.getByLabelText('Copy message');
    expect(copy).toHaveAttribute('title', 'Copy markdown');

    await user.click(copy);
    expect(copy).toHaveAttribute('title', 'Copied!');
    expect(copy.querySelector('.lucide-check')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(copy).toHaveAttribute('title', 'Copied!');
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(copy).toHaveAttribute('title', 'Copy markdown');
    expect(copy.querySelector('.lucide-copy')).not.toBeNull();
  });

  it('Delete hands the bubble its index back', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<Thread messages={[reply(1), { role: 'user', content: 'Q2' }, { role: 'error', content: 'E3' }]} onDelete={onDelete} />);

    await user.click(screen.getAllByLabelText('Delete message')[1]);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(1);
  });
});
