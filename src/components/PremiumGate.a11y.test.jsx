// src/components/PremiumGate.a11y.test.jsx — the lock in front of a premium feature, under the two app contexts
// (src/test/contexts.jsx) with a free-tier auth value, one axe run per state: the lock's token field named by a
// visible "Access token" label; the request-access form its link opens, side by side, its three fields named by their
// labels. Every field is still found by its placeholder (Pin).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withContexts } from '../test/contexts.jsx';
import { expectLabelledControls, expectNoAxeViolations } from '../test/a11y.js';
import PremiumGate from './PremiumGate.js';

const locked = () => withContexts(
  <PremiumGate featureName="Ticker Research"><p>The feature</p></PremiumGate>,
  { auth: { isPremium: false } },
);

describe('PremiumGate', () => {
  it("names the lock's token field with a visible label, with nothing missing for axe", async () => {
    const { container } = render(locked());
    expectLabelledControls(container);
    expect(screen.getByLabelText('Access token')).toBe(screen.getByPlaceholderText('Paste token...'));
    await expectNoAxeViolations(container);
  });

  it('names the fields of the request-access form its link opens, with nothing missing for axe', async () => {
    const user = userEvent.setup();
    const { container } = render(locked());
    await user.click(screen.getByRole('button', { name: /Request access/ }));
    expectLabelledControls(container);
    expect(screen.getByLabelText('Name')).toBe(screen.getByPlaceholderText('Your name'));
    expect(screen.getByLabelText('Email address')).toBe(screen.getByPlaceholderText('your@email.com'));
    expect(screen.getByLabelText('Message (optional)')).toBe(screen.getByPlaceholderText("Why you'd like access (optional)"));
    await expectNoAxeViolations(container);
  });

  it('Pin: every field of the lock is still found by its placeholder', async () => {
    const user = userEvent.setup();
    render(locked());
    expect(screen.getByPlaceholderText('Paste token...')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: /Request access/ }));
    expect(screen.getByPlaceholderText('Your name')).toHaveValue('');
    expect(screen.getByPlaceholderText('your@email.com')).toHaveValue('');
    expect(screen.getByPlaceholderText("Why you'd like access (optional)")).toHaveValue('');
  });
});
