// src/components/settings/AccountTab.a11y.test.jsx — the Account tab rendered alone under the two app contexts
// (src/test/contexts.jsx; it reads AuthContext), one axe run per state: on the free tier, the access-token field named
// by the tab's "Activate Token" label (a click on it focuses the field) and described by the hint under it; the
// request-access form that Request opens, its three fields named by their labels; signed in with a premium token, no
// field and nothing missing for axe (Pin). The token field is still found by its placeholder (Pin).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withContexts } from '../../test/contexts.jsx';
import { expectLabelledControls, expectNoAxeViolations } from '../../test/a11y.js';
import AccountTab from './AccountTab.js';

const PLACEHOLDER = 'Paste access token...';
const HINT = 'Unlocks premium features: AI Co-Pilot, Position Analysis, and Ticker Research.';

/** The tab under an auth value with `auth`'s overrides (the free tier, signed out, by default). */
const renderTab = (auth) => render(withContexts(<AccountTab />, { auth }));

describe('AccountTab', () => {
  it('names the access-token field with the "Activate Token" label and describes it with the hint, with nothing missing for axe', async () => {
    const { container } = renderTab();
    expectLabelledControls(container);
    const field = screen.getByLabelText('Activate Token');
    expect(field).toBe(screen.getByPlaceholderText(PLACEHOLDER));
    expect(field).toHaveAccessibleDescription(HINT);
    await expectNoAxeViolations(container);
  });

  it('focuses the access-token field when its label is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByText('Activate Token'));
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveFocus();
  });

  it('names the fields of the request-access form that Request opens, with nothing missing for axe', async () => {
    const user = userEvent.setup();
    const { container } = renderTab();
    await user.click(screen.getByRole('button', { name: 'Request' }));
    expectLabelledControls(container);
    expect(screen.getByLabelText('Name')).toBe(screen.getByPlaceholderText('Your name'));
    expect(screen.getByLabelText('Email address')).toBe(screen.getByPlaceholderText('your@email.com'));
    expect(screen.getByLabelText('Message (optional)')).toBe(screen.getByPlaceholderText("Why you'd like access (optional)"));
    await expectNoAxeViolations(container);
  });

  it('Pin: signed in with a premium token, the tab holds no field and nothing is missing for axe', async () => {
    const { container } = renderTab({ userEmail: 'a@b.c', signedIn: true, isPremium: true, tokenTier: 'pro', daysLeft: 12 });
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
    await expectNoAxeViolations(container);
  });

  it('Pin: the access-token field is still found by its placeholder', () => {
    renderTab();
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue('');
  });
});
