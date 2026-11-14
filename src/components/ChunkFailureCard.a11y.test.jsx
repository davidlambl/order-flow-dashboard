// src/components/ChunkFailureCard.a11y.test.jsx — the card a lazily loaded part shows when its module could not load,
// for a screen reader: an alert, so the failure is announced where it appears, holding its sentence and its two
// buttons by their own names (Try again runs the boundary's retry); its icon is decoration. axe finds nothing.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChunkFailureCard from './ChunkFailureCard.js';
import { expectNoAxeViolations } from '../test/a11y.js';

describe('ChunkFailureCard', () => {
  it('Pin: is an alert with its sentence, its icon hidden, and Try again and Reload by name', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { container } = render(<ChunkFailureCard retry={retry} />);
    const alert = screen.getByRole('alert');
    expect(alert).toBe(container.firstChild);
    expect(alert).toHaveTextContent('This part of the dashboard could not load.');
    expect(container.querySelector('.lucide-circle-alert')).toHaveAttribute('aria-hidden', 'true');
    expect(within(alert).getAllByRole('button').map((b) => b.textContent)).toEqual(['Try again', 'Reload']);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('Pin: axe finds nothing', async () => {
    const { container } = render(<ChunkFailureCard retry={vi.fn()} />);
    await expectNoAxeViolations(container);
  });
});
