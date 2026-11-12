// src/components/position/PositionInputs.a11y.test.jsx — the position's two number inputs, rendered bare (the leaf
// reads no context): each is named by a visually hidden label (an icon and a placeholder are the design, so the label
// takes no room: Tailwind's sr-only, which jsdom does not apply, hence the class is asserted), and nothing is missing
// for axe. Each input is still found by its placeholder (Pin).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { expectLabelledControls, expectNoAxeViolations } from '../../test/a11y.js';
import PositionInputs from './PositionInputs.js';

const renderInputs = () => render(
  <PositionInputs costBasis={90} shares={10} onCostChange={vi.fn()} onSharesChange={vi.fn()} />,
);

describe('PositionInputs', () => {
  it('names both inputs with visually hidden labels, with nothing missing for axe', async () => {
    const { container } = renderInputs();
    expectLabelledControls(container);
    expect(screen.getByLabelText('Average cost per share')).toBe(screen.getByPlaceholderText('Avg cost'));
    expect(screen.getByLabelText('Number of shares')).toBe(screen.getByPlaceholderText('Shares'));
    expect(screen.getByText('Average cost per share')).toHaveClass('sr-only');
    expect(screen.getByText('Number of shares')).toHaveClass('sr-only');
    await expectNoAxeViolations(container);
  });

  it('Pin: each input is still found by its placeholder', () => {
    renderInputs();
    expect(screen.getByPlaceholderText('Avg cost')).toHaveValue(90);
    expect(screen.getByPlaceholderText('Shares')).toHaveValue(10);
  });
});
