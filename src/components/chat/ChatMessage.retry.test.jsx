// src/components/chat/ChatMessage.retry.test.jsx — the Retry button of one bubble, rendered bare and outside StrictMode
// as ChatMessage.test.jsx renders it. An error bubble given onRetry shows Retry first in its row of actions (Retry,
// Copy, Delete), outside the alert, which still says the error alone; a click calls onRetry, and axe finds nothing in
// that state. Retry is named by its word, its icon hidden, and is at least 24 px high by its classes (jsdom has no
// layout: the size is measured in a browser). No Retry shows on an error bubble without onRetry, nor on a question or
// a reply given one.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatMessage from './ChatMessage.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

const ERROR = { role: 'error', content: 'Failed to get analysis: Overloaded (ref req-1)' };
const QUESTION = { role: 'user', content: 'Is the flow bullish?' };
const REPLY = { role: 'assistant', content: 'Bullish above 95.' };

/** The row of actions under the bubble. */
const actions = () => screen.getByRole('button', { name: 'Copy message' }).parentElement;

describe('ChatMessage: Retry', () => {
  it('an error bubble given onRetry shows Retry first in its actions, outside the alert; a click calls it', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { container } = render(<ChatMessage msg={ERROR} index={2} onDelete={vi.fn()} onRetry={onRetry} />);
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(within(actions()).getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label')))
      .toEqual(['Retry', 'Copy message', 'Delete message']);
    const alert = screen.getByRole('alert');
    expect(alert).not.toContainElement(retry);
    expect(alert).toHaveTextContent(`Error${ERROR.content}`);

    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith();
    await expectNoAxeViolations(container);
  });

  it('is named by its word, its icon hidden, and is at least 24 px high around its 11 px icon', () => {
    render(<ChatMessage msg={ERROR} index={0} onDelete={vi.fn()} onRetry={vi.fn()} />);
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toHaveAttribute('type', 'button');
    expect(retry).toHaveClass('min-h-6');
    const icon = retry.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('width', '11');
  });

  it('Pin: no Retry on an error bubble without onRetry, nor on a question or a reply given one', () => {
    for (const [msg, onRetry] of [[ERROR, undefined], [QUESTION, vi.fn()], [REPLY, vi.fn()]]) {
      const { unmount } = render(<ChatMessage msg={msg} index={0} onDelete={vi.fn()} onRetry={onRetry} />);
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(within(actions()).getAllByRole('button')).toHaveLength(2);
      unmount();
    }
  });
});
