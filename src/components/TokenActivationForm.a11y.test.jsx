// src/components/TokenActivationForm.a11y.test.jsx — the access-token form as a screen reader and a pointer meet it,
// rendered bare (it reads no context; TokenActivationForm.test.jsx pins what it does): a visible label names the input,
// "Access token" unless the parent passes its own, and a click on it focuses the input; two forms on one screen (two
// premium gates, or a gate beside the chat's lock) keep their own ids, so each label and each error stays with its
// own input; a refusal is an alert that describes the input, after which the hint follows, and marks the input invalid
// until the next edit; the submit button keeps a name while it spins and once it shows the shield. One axe run per
// state. The input is still found by its placeholder (Pin). MSW answers validateToken per token from `verdicts`
// (any other token is valid); `held` makes it wait for release().
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { expectLabelledControls, expectNoAxeViolations } from '../test/a11y.js';
import TokenActivationForm from './TokenActivationForm.js';

const FN = 'http://localhost:3000/.netlify/functions';
const VALID = { valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-11-01T00:00:00.000Z', requestId: 'v1' };
const HINT = 'Unlocks premium features: AI Co-Pilot, Position Analysis, and Ticker Research.';

/** validateToken's refusals by token: a 401 with the reason, as the function sends it. */
const verdicts = {
  'bad-a': 'Token expired',
  'bad-b': 'Token revoked',
};

let held;
let release;

beforeEach(() => {
  held = null;
  server.use(http.post(`${FN}/validateToken`, async ({ request }) => {
    const { token } = await request.json();
    if (token === 'held') await held;
    return verdicts[token]
      ? HttpResponse.json({ valid: false, error: verdicts[token], code: 'TOKEN_INVALID', requestId: 'v2' }, { status: 401 })
      : HttpResponse.json(VALID);
  }));
});

/** The form's text field (there is one per form). */
const inputOf = (form) => form.querySelector('input');

describe('TokenActivationForm', () => {
  it('names its input with a visible "Access token" label by default, with nothing missing for axe', async () => {
    const { container } = render(<TokenActivationForm placeholder="Paste token..." />);
    expectLabelledControls(container);
    expect(screen.getByLabelText('Access token')).toBe(screen.getByPlaceholderText('Paste token...'));
    await expectNoAxeViolations(container);
  });

  it("takes the label its parent passes, the Account tab's \"Activate Token\", and the hint describes the input", () => {
    const { container } = render(<TokenActivationForm label="Activate Token" placeholder="Paste access token..." hint={HINT} />);
    expectLabelledControls(container);
    const input = screen.getByLabelText('Activate Token');
    expect(input).toBe(screen.getByPlaceholderText('Paste access token...'));
    expect(input).toHaveAccessibleDescription(HINT);
    expect(screen.queryByText('Access token')).toBeNull();
  });

  it('focuses the input when its label is clicked', async () => {
    const user = userEvent.setup();
    render(<TokenActivationForm placeholder="Paste token..." />);
    await user.click(screen.getByText('Access token'));
    expect(screen.getByPlaceholderText('Paste token...')).toHaveFocus();
  });

  it('keeps each label and each error with its own input when two forms show at once', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <TokenActivationForm placeholder="Paste token..." />
        <TokenActivationForm placeholder="Paste access token..." />
      </>,
    );
    const [first, second] = container.querySelectorAll('form');
    expect(screen.getAllByLabelText('Access token')).toEqual([inputOf(first), inputOf(second)]);
    expect(screen.getAllByText('Access token').map((label) => label.control)).toEqual([inputOf(first), inputOf(second)]);

    await user.type(inputOf(first), 'bad-a{Enter}');
    await user.type(inputOf(second), 'bad-b{Enter}');
    expect(await screen.findAllByRole('alert')).toHaveLength(2);
    expect(inputOf(first)).toHaveAccessibleDescription('Token expired');
    expect(inputOf(second)).toHaveAccessibleDescription('Token revoked');
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('announces a refusal as an alert that describes the input, marks the input invalid, and clears both on the next edit', async () => {
    const user = userEvent.setup();
    const { container } = render(<TokenActivationForm placeholder="Paste access token..." hint={HINT} />);
    const input = screen.getByPlaceholderText('Paste access token...');
    expect(input).toHaveAccessibleDescription(HINT);
    expect(input).not.toBeInvalid();

    await user.type(input, 'bad-a{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Token expired');
    expect(input).toHaveAccessibleDescription(`Token expired ${HINT}`);
    expect(input).toBeInvalid();
    await expectNoAxeViolations(container);

    await user.type(input, '!');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input).not.toBeInvalid();
    expect(input).toHaveAccessibleDescription(HINT);
  });

  it('keeps a name on the submit button while it spins and once it shows the shield, with nothing missing for axe', async () => {
    held = new Promise((resolve) => { release = resolve; });
    const user = userEvent.setup();
    const { container } = render(<TokenActivationForm placeholder="Paste token..." />);

    await user.type(screen.getByPlaceholderText('Paste token...'), 'held');
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(screen.getByRole('button', { name: 'Activating' })).toBeDisabled();
    await expectNoAxeViolations(container);

    release();
    const done = await screen.findByRole('button', { name: 'Activated' });
    expect(done.querySelector('.lucide-shield-check')).not.toBeNull();
  });

  it('Pin: the input is still found by its placeholder', () => {
    render(<TokenActivationForm placeholder="Paste token..." />);
    expect(screen.getByPlaceholderText('Paste token...')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Activate' })).toBeDisabled();
  });
});
