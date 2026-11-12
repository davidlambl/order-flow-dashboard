// src/components/chat/ChatLockScreen.a11y.test.jsx — the chat panel while no premium token is stored, rendered bare
// (it reads no context): its token field is named by a visible "Access token" label, which focuses the field when
// clicked, and nothing is missing for axe. The field is still found by its placeholder (Pin).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectLabelledControls, expectNoAxeViolations } from '../../test/a11y.js';
import ChatLockScreen from './ChatLockScreen.js';

describe('ChatLockScreen', () => {
  it('names the token field with a visible label, with nothing missing for axe', async () => {
    const { container } = render(<ChatLockScreen onClose={vi.fn()} />);
    expectLabelledControls(container);
    expect(screen.getByLabelText('Access token')).toBe(screen.getByPlaceholderText('Paste access token...'));
    await expectNoAxeViolations(container);
  });

  it('focuses the token field when its label is clicked', async () => {
    const user = userEvent.setup();
    render(<ChatLockScreen onClose={vi.fn()} />);
    await user.click(screen.getByText('Access token'));
    expect(screen.getByPlaceholderText('Paste access token...')).toHaveFocus();
  });

  it('Pin: the token field is still found by its placeholder', () => {
    render(<ChatLockScreen onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText('Paste access token...')).toHaveValue('');
  });
});
