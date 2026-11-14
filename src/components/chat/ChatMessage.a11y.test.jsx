// src/components/chat/ChatMessage.a11y.test.jsx — what one bubble gives a keyboard, a touch screen and a screen reader.
// Copy and Delete are on screen at rest, dimmed, and at full strength on hover or while one of them has the keyboard's
// focus: a phone has no hover, and a keyboard user must see what they tab onto. jsdom applies no stylesheet, so the
// classes that decide it are what is asserted; the buttons' size and contrast are measured in a browser. Each bubble
// says who is speaking ("You", "Assistant", "Error") in visually hidden text placed first in the bubble, outside the
// message's own text block, so it is markup only: Copy puts the message's content alone on the clipboard. The avatar is
// decoration. An error line is an alert; a question and a reply are not, and a reply holds no live region, so a
// streamed reply is never read out frame by frame. axe finds nothing in a question's, a reply's or an error's bubble.
// Bubbles render bare and outside StrictMode, as in ChatMessage.test.jsx.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatMessage from './ChatMessage.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

const QUESTION = { role: 'user', content: 'Is the flow bullish?' };
const REPLY = { role: 'assistant', content: '**Bullish** above 95.\n\n- calls lead' };
const ERROR = { role: 'error', content: 'Failed to get analysis: Overloaded (ref req-1)' };

const bubble = (msg) => render(<ChatMessage msg={msg} index={0} onDelete={vi.fn()} />);

/** The row of actions under the bubble. */
const actions = () => screen.getByRole('button', { name: 'Copy message' }).parentElement;
/** The message's text box: the role's colours sit on it (as ChatMessage.test.jsx finds it). */
const boxOf = (el) => el.closest('.rounded-xl');
/** The box of the one bubble on screen, found from the visible text of its message. */
const boxShowing = (text) => boxOf(screen.getByText(text));

describe('ChatMessage: the actions', () => {
  it('are on screen at rest, dimmed, and at full strength on hover or while one of them has focus', () => {
    bubble(QUESTION);
    const row = actions();
    expect(row).not.toHaveClass('opacity-0');
    expect(row).toHaveClass('opacity-75', 'group-hover/msg:opacity-100', 'focus-within:opacity-100');
  });

  it('Pin: keep their names, Copy then Delete, for every role', () => {
    for (const msg of [QUESTION, REPLY, ERROR]) {
      const { unmount } = bubble(msg);
      expect(within(actions()).getAllByRole('button').map((b) => b.getAttribute('aria-label')))
        .toEqual(['Copy message', 'Delete message']);
      unmount();
    }
  });
});

describe('ChatMessage: who is speaking', () => {
  it.each([
    ['a question', QUESTION, 'Is the flow bullish?', 'You'],
    ['a reply', REPLY, 'Bullish', 'Assistant'],
    ['an error line', ERROR, ERROR.content, 'Error'],
  ])('%s says its author first, in visually hidden text outside the message text', (_, msg, shown, author) => {
    bubble(msg);
    const box = boxShowing(shown);
    const label = within(box).getByText(author);
    expect(label).toHaveClass('sr-only');
    expect(box.firstElementChild).toBe(label);
    expect(label.closest('.whitespace-pre-wrap')).toBeNull();
    expect(box).toHaveTextContent(new RegExp(`^${author}`));
  });

  it('Pin: the author is markup only: Copy puts the content alone on the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    for (const msg of [QUESTION, REPLY, ERROR]) {
      const { unmount } = bubble(msg);
      await user.click(screen.getByRole('button', { name: 'Copy message' }));
      unmount();
    }
    expect(writeText.mock.calls).toEqual([[QUESTION.content], [REPLY.content], [ERROR.content]]);
  });

  it('the avatar is decoration, hidden from the accessibility tree', () => {
    for (const [msg, icon] of [[QUESTION, '.lucide-user'], [REPLY, '.lucide-bot'], [ERROR, '.lucide-circle-alert']]) {
      const { container, unmount } = bubble(msg);
      expect(container.querySelector(icon).parentElement).toHaveAttribute('aria-hidden', 'true');
      unmount();
    }
  });
});

describe('ChatMessage: what is announced', () => {
  it('an error line is an alert, its author and text inside; a question and a reply are not', () => {
    const { unmount } = bubble(ERROR);
    const alert = screen.getByRole('alert');
    expect(alert).toBe(boxShowing(ERROR.content));
    expect(alert).toHaveTextContent(`Error${ERROR.content}`);
    unmount();

    for (const msg of [QUESTION, REPLY]) {
      const { unmount: done } = bubble(msg);
      expect(screen.queryByRole('alert')).toBeNull();
      done();
    }
  });

  it('Pin: a reply streaming in holds no live region, so its frames are not read out', () => {
    const { container, rerender } = render(
      <ChatMessage msg={{ role: 'assistant', content: 'Part', pending: true }} index={0} onDelete={vi.fn()} />,
    );
    rerender(<ChatMessage msg={{ role: 'assistant', content: 'Part two', pending: true }} index={0} onDelete={vi.fn()} />);
    expect(screen.getByText('Part two')).toBeInTheDocument();
    expect(container.querySelector('[aria-live], [role="alert"], [role="status"], [role="log"]')).toBeNull();
  });
});

describe('ChatMessage: axe', () => {
  it.each([
    ["a question's bubble", QUESTION],
    ["a reply's bubble", REPLY],
    ["an error's bubble", ERROR],
  ])('Pin: finds nothing in %s', async (_, msg) => {
    const { container } = bubble(msg);
    await expectNoAxeViolations(container);
  });
});
