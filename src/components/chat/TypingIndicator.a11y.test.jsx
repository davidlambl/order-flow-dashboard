// src/components/chat/TypingIndicator.a11y.test.jsx — the reply's place while no text of it has arrived, for a screen
// reader: a status region whose only text is "The assistant is typing", in visually hidden text, so it is said once
// when the indicator shows; the avatar and the three pulsing dots are decoration (the dots keep their class, which the
// ChatBot tests count). axe finds nothing.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import TypingIndicator from './TypingIndicator.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

describe('TypingIndicator', () => {
  it('is a status that says the assistant is typing, with the avatar and the dots hidden from the tree', () => {
    const { container } = render(<TypingIndicator />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/^The assistant is typing$/);
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
