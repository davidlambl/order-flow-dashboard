// src/components/position/PositionInputs.test.jsx — the position's two number inputs, rendered bare (the leaf reads
// no context): each shows its prop, a null as an empty field, and follows a new one; a typed value, a zero included,
// goes to its own field's callback as a number and never to the other's, a cleared field sends null, and letters send
// nothing. A number input never reports letters (jsdom, like a browser, drops them), so the leaf's guard against text
// that parses to no number is reached through a field switched to type="text".
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PositionInputs from './PositionInputs.js';

const costInput = () => screen.getByPlaceholderText('Avg cost');
const sharesInput = () => screen.getByPlaceholderText('Shares');

/** The inputs over a 90 × 10 position with a spy for each callback; `props` overrides the position. */
function renderInputs(props = {}) {
  const callbacks = { onCostChange: vi.fn(), onSharesChange: vi.fn() };
  const ui = (next) => <PositionInputs costBasis={90} shares={10} {...callbacks} {...next} />;
  const { rerender } = render(ui(props));
  return { ...callbacks, rerender: (next) => rerender(ui(next)) };
}

describe('PositionInputs', () => {
  it('shows the position it is given, a null as an empty field, and follows a new one', () => {
    const { rerender } = renderInputs();
    expect(costInput()).toHaveValue(90);
    expect(sharesInput()).toHaveValue(10);

    rerender({ costBasis: null, shares: null });
    expect(costInput()).toHaveValue(null);
    expect(costInput().value).toBe('');
    expect(sharesInput()).toHaveValue(null);
    expect(sharesInput().value).toBe('');

    rerender({ costBasis: 95.5, shares: 2.5 });
    expect(costInput()).toHaveValue(95.5);
    expect(sharesInput()).toHaveValue(2.5);
  });

  it('sends a typed average cost as a number, a zero included, to onCostChange alone', () => {
    const { onCostChange, onSharesChange } = renderInputs();
    fireEvent.change(costInput(), { target: { value: '95.5' } });
    fireEvent.change(costInput(), { target: { value: '0' } }); // what a zero basis means is the panel's call
    expect(onCostChange.mock.calls).toEqual([[95.5], [0]]);
    expect(onSharesChange).not.toHaveBeenCalled();
  });

  it('sends null when the average cost is cleared', () => {
    const { onCostChange, onSharesChange } = renderInputs();
    fireEvent.change(costInput(), { target: { value: '' } });
    expect(onCostChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(onSharesChange).not.toHaveBeenCalled();
  });

  it('sends nothing for letters typed into the average cost', async () => {
    // Typed, not fireEvent.change: a number input never reports 'abc' (jsdom sanitises the value to '', which reads
    // as a cleared field), and user-event drops the letters as Chrome does.
    const user = userEvent.setup();
    const { onCostChange, onSharesChange } = renderInputs();
    await user.type(costInput(), 'abc');
    expect(onCostChange).not.toHaveBeenCalled();
    expect(costInput()).toHaveValue(90);

    await user.type(costInput(), '5'); // a digit does go through: 90 → 905
    expect(onCostChange).toHaveBeenCalledExactlyOnceWith(905);
    expect(onSharesChange).not.toHaveBeenCalled();
  });

  it('sends typed shares as a number, a zero included, to onSharesChange alone', () => {
    const { onCostChange, onSharesChange } = renderInputs();
    fireEvent.change(sharesInput(), { target: { value: '2.5' } });
    fireEvent.change(sharesInput(), { target: { value: '0' } });
    expect(onSharesChange.mock.calls).toEqual([[2.5], [0]]);
    expect(onCostChange).not.toHaveBeenCalled();
  });

  it('sends null when the shares are cleared', () => {
    const { onCostChange, onSharesChange } = renderInputs();
    fireEvent.change(sharesInput(), { target: { value: '' } });
    expect(onSharesChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(onCostChange).not.toHaveBeenCalled();
  });

  it('sends nothing for letters typed into the shares', async () => {
    const user = userEvent.setup();
    const { onCostChange, onSharesChange } = renderInputs();
    await user.type(sharesInput(), 'abc');
    expect(onSharesChange).not.toHaveBeenCalled();
    expect(sharesInput()).toHaveValue(10);

    await user.type(sharesInput(), '5'); // 10 → 105
    expect(onSharesChange).toHaveBeenCalledExactlyOnceWith(105);
    expect(onCostChange).not.toHaveBeenCalled();
  });

  it('sends nothing for text that parses to no number, from either field', () => {
    const { onCostChange, onSharesChange } = renderInputs();
    for (const input of [costInput(), sharesInput()]) {
      input.type = 'text'; // as a number input it would sanitise 'abc' to '' before the leaf saw it
      fireEvent.change(input, { target: { value: 'abc' } });
    }
    expect(onCostChange).not.toHaveBeenCalled();
    expect(onSharesChange).not.toHaveBeenCalled();
  });
});
