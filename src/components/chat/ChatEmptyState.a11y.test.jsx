// src/components/chat/ChatEmptyState.a11y.test.jsx — an empty chat for a screen reader and a keyboard: each starter
// question is a button named by its own text, which a click sends as the question, and axe finds nothing.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatEmptyState from './ChatEmptyState.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

const SUGGESTIONS = [
  'What does the GEX profile suggest?',
  'Is the flow bullish or bearish?',
  'Where are key support/resistance levels?',
  'Summarize the dark pool activity.',
];

describe('ChatEmptyState', () => {
  it('Pin: each suggestion is a button named by its text, and sends that text', async () => {
    const user = userEvent.setup();
    const onSuggest = vi.fn();
    render(<ChatEmptyState ticker="AVGO" onSuggest={onSuggest} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(SUGGESTIONS);

    for (const suggestion of SUGGESTIONS) {
      expect(screen.getByRole('button', { name: suggestion })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: SUGGESTIONS[2] }));
    expect(onSuggest.mock.calls).toEqual([[SUGGESTIONS[2]]]);
  });

  it('Pin: axe finds nothing', async () => {
    const { container } = render(<ChatEmptyState ticker="AVGO" onSuggest={vi.fn()} />);
    await expectNoAxeViolations(container);
  });
});
