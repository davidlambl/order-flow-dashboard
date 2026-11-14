// src/components/chat/TypingIndicator.a11y.test.jsx — the reply's place while no text of it has arrived, for a screen
// reader: its only text is "The assistant is typing", visually hidden, read where the reply will be; it is no live
// region (the chat's status line announces the reply, ChatBot.status.test.jsx); the avatar and the three pulsing dots
// are decoration (the dots keep their class, which the ChatBot tests count). axe finds nothing.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import TypingIndicator from './TypingIndicator.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

describe('TypingIndicator', () => {
  it('Pin: says the assistant is typing in visually hidden text, with the avatar and the dots hidden from the tree', () => {
    const { container } = render(<TypingIndicator />);
    const indicator = container.firstElementChild;
    expect(indicator).toHaveTextContent(/^The assistant is typing$/);
    expect(screen.getByText('The assistant is typing')).toHaveClass('sr-only');

    expect(container.querySelector('.lucide-bot').parentElement).toHaveAttribute('aria-hidden', 'true');
    const dots = container.querySelectorAll('.pulse-glow');
    expect(dots).toHaveLength(3);
    expect(dots[0].parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it('Pin: axe finds nothing', async () => {
    const { container } = render(<TypingIndicator />);
    await expectNoAxeViolations(container);
  });
});
