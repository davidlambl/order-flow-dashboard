// src/components/chat/ChatHeader.a11y.test.jsx — the chat header's buttons for a screen reader and speech input. The
// context inspector's button shows or hides a view: its name stays "Inspect model context" and aria-pressed says
// whether the inspector is shown (one pattern per toggle; a button whose name states its action, such as Clear chat
// history, keeps that name and takes no aria-pressed). Every icon button has a name, and a tooltip, where it has one,
// that says the same, so what a mouse user reads is what a speech-input user can say. axe finds nothing with the
// messages shown or with the inspector open. Rendered bare: the header reads no context.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatHeader from './ChatHeader.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

const INSPECT = 'Inspect model context';

/** The header with spies for its five callbacks; `props` overrides the rest. */
const header = (props = {}) => (
  <ChatHeader
    modelName="Default"
    ticker="AVGO"
    showContext={false}
    onToggleContext={vi.fn()}
    onEditContext={vi.fn()}
    hasMessages
    onClearHistory={vi.fn()}
    onOpenSettings={vi.fn()}
    onClose={vi.fn()}
    {...props}
  />
);

describe('ChatHeader: the inspector toggle', () => {
  it('keeps its name and says with aria-pressed whether the inspector shows', () => {
    const { rerender } = render(header());
    const toggle = screen.getByRole('button', { name: INSPECT });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    rerender(header({ showContext: true }));
    expect(screen.getByRole('button', { name: INSPECT })).toBe(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    rerender(header());
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('Pin: the buttons that state their action take no aria-pressed', () => {
    render(header({ showContext: true }));
    for (const name of ['Edit strategic context', 'Clear chat history', 'Settings', 'Close chat']) {
      expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-pressed');
    }
  });
});

describe('ChatHeader: names and tooltips', () => {
  it('every button has a name, and a tooltip, where it has one, that says the same', () => {
    render(header());
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label')))
      .toEqual([INSPECT, 'Edit strategic context', 'Clear chat history', 'Settings', 'Close chat']);
    for (const button of buttons.filter((b) => b.hasAttribute('title'))) {
      expect(button.getAttribute('title').toLowerCase()).toBe(button.getAttribute('aria-label').toLowerCase());
    }
  });
});

describe('ChatHeader: axe', () => {
  it('Pin: finds nothing with the messages shown', async () => {
    const { container } = render(header());
    await expectNoAxeViolations(container);
  });

  it('Pin: finds nothing with the inspector open and no history', async () => {
    const { container } = render(header({ showContext: true, hasMessages: false }));
    await expectNoAxeViolations(container);
  });
});
