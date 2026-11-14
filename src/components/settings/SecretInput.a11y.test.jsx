// src/components/settings/SecretInput.a11y.test.jsx — the API key field of the settings tabs, rendered bare (it reads
// no context), as a screen reader and a pointer meet it: the visible label names the input and a click on it focuses
// the input; the hint under it describes the input, after the status lines a parent passes (the AI tab's key test),
// and a parent that reports the key rejected marks the input invalid; two fields on one screen, as on the Data tab,
// keep their own ids. The placeholder stays a hint and still finds the input (Pin).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectLabelledControls, expectNoAxeViolations } from '../../test/a11y.js';
import SecretInput from './SecretInput.js';

const HINT = 'A free sandbox key works for testing — get one at tradier.com.';

/** The Data tab's Tradier field, overridable prop by prop. */
const field = (props = {}) => (
  <SecretInput
    label="Tradier API Key"
    value=""
    onChange={vi.fn()}
    placeholder="Paste for real-time data..."
    saved={false}
    {...props}
  >
    {HINT}
  </SecretInput>
);

describe('SecretInput', () => {
  it('names its input with the visible label, with nothing missing for axe', async () => {
    const { container } = render(field({ value: 'tr-key' }));
    expectLabelledControls(container);
    expect(screen.getByLabelText('Tradier API Key')).toBe(screen.getByPlaceholderText('Paste for real-time data...'));
    await expectNoAxeViolations(container);
  });

  it('focuses the input when its label is clicked', async () => {
    const user = userEvent.setup();
    render(field());
    await user.click(screen.getByText('Tradier API Key'));
    expect(screen.getByPlaceholderText('Paste for real-time data...')).toHaveFocus();
  });

  it('describes the input with the hint under it', () => {
    render(field());
    const input = screen.getByPlaceholderText('Paste for real-time data...');
    expect(input).toHaveAccessibleDescription(HINT);
    expect(input).not.toBeInvalid();
  });

  it("describes the input with the parent's status lines before the hint, and marks it invalid when told", () => {
    render(field({ status: <div role="alert">Key returned no models</div>, invalid: true }));
    const input = screen.getByPlaceholderText('Paste for real-time data...');
    expect(input).toHaveAccessibleDescription(`Key returned no models ${HINT}`);
    expect(input).toBeInvalid();
  });

  it('keeps each label on its own input when two fields show at once, as on the Data tab', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        {field()}
        {field({ label: 'Finnhub API Key', placeholder: 'Paste for news, earnings, analyst data...' })}
      </>,
    );
    const tradier = screen.getByLabelText('Tradier API Key');
    const finnhub = screen.getByLabelText('Finnhub API Key');
    expect(tradier).toBe(screen.getByPlaceholderText('Paste for real-time data...'));
    expect(finnhub).toBe(screen.getByPlaceholderText('Paste for news, earnings, analyst data...'));
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);

    await user.click(screen.getByText('Finnhub API Key'));
    expect(finnhub).toHaveFocus();
  });

  it('Pin: the input is still found by its placeholder, and the reveal toggle still states its action', async () => {
    const user = userEvent.setup();
    render(field({ value: 'tr-key' }));
    const input = screen.getByPlaceholderText('Paste for real-time data...');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Reveal key' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide key' })).toBeInTheDocument();
  });
});
