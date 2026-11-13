// src/components/LoginForm.a11y.test.jsx — the sign-in screen rendered alone, the Supabase client module mocked with
// the fake client of test/helpers/fakeSupabase.js (its signInWithOtp returns `otpError`): the screen is one main
// landmark under one h1, judged by axe as a whole page; the e-mail field is named by a visible label, which focuses it
// when clicked, and tells the browser it holds an e-mail address (autocomplete, WCAG 1.3.5); a refused address is an
// alert that describes the field and marks it invalid; the link sent is announced as a status, without the button
// beside it. The field is still found by its placeholder, and the skip still skips (Pin).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeSupabase } from '../../test/helpers/fakeSupabase.js';
import { expectLabelledControls, expectNoAxeViolations } from '../test/a11y.js';
import LoginForm from './LoginForm.jsx';

const holder = vi.hoisted(() => ({ client: null }));
vi.mock('../lib/supabase.js', () => ({
  get supabase() { return holder.client; },
}));

const PLACEHOLDER = 'you@example.com';
const REFUSED = 'Unable to validate email address: invalid format';

/** axe over the whole page, best practices included: the page rules (landmark-one-main, page-has-heading-one,
 * region) judge only from the root. */
const expectNoPageViolations = () => expectNoAxeViolations(document.documentElement, {
  bestPractices: true,
  // jsdom's blank page has no <title> and no lang on <html>; index.html gives the real page both.
  disable: ['document-title', 'html-has-lang'],
});

/** Types `address` into the field (found by placeholder, as before the label) and sends the form. */
async function sendTo(user, address) {
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), address);
  await user.click(screen.getByRole('button', { name: 'Send magic link' }));
}

describe('LoginForm', () => {
  afterEach(() => {
    holder.client = null;
  });

  it('lays the screen out as one main landmark under one h1, with nothing missing for axe as a page', async () => {
    holder.client = fakeSupabase();
    render(<LoginForm onSkip={vi.fn()} />);
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Order Flow');
    await expectNoPageViolations();
  });

  it('names the e-mail field with a visible label, which focuses the field when clicked', async () => {
    holder.client = fakeSupabase();
    const user = userEvent.setup();
    const { container } = render(<LoginForm onSkip={vi.fn()} />);
    expectLabelledControls(container);
    const field = screen.getByLabelText('Email address');
    expect(field).toBe(screen.getByPlaceholderText(PLACEHOLDER));

    act(() => field.blur()); // the field takes focus as the screen opens
    expect(field).not.toHaveFocus();
    await user.click(screen.getByText('Email address'));
    expect(field).toHaveFocus();
  });

  it('tells the browser that the field holds an e-mail address', () => {
    holder.client = fakeSupabase();
    render(<LoginForm onSkip={vi.fn()} />);
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveAttribute('autocomplete', 'email');
  });

  it('announces a refused address as an alert that describes the field and marks it invalid, with nothing missing for axe as a page', async () => {
    holder.client = fakeSupabase({ otpError: { message: REFUSED } });
    const user = userEvent.setup();
    render(<LoginForm onSkip={vi.fn()} />);
    const field = screen.getByPlaceholderText(PLACEHOLDER);
    expect(field).not.toBeInvalid();

    await sendTo(user, 'trader@example.com');
    expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED);
    expect(field).toHaveAccessibleDescription(REFUSED);
    expect(field).toBeInvalid();
    await expectNoPageViolations();
  });

  it('announces the link it sent as a status, without the button beside it, with nothing missing for axe as a page', async () => {
    holder.client = fakeSupabase();
    const user = userEvent.setup();
    render(<LoginForm onSkip={vi.fn()} />);

    await sendTo(user, 'trader@example.com');
    // The region is there, empty, from the moment the link is requested (LoginForm.status.test.jsx): wait for its text.
    await screen.findByText('Check your email');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Check your email');
    expect(status).toHaveTextContent('We sent a magic link to trader@example.com. Click it to sign in.');
    expect(status).not.toHaveTextContent('Try a different email');
    expect(screen.getByRole('button', { name: 'Try a different email' })).toBeInTheDocument();
    await expectNoPageViolations();
  });

  it('Pin: the e-mail field is still found by its placeholder, and the skip still skips', async () => {
    holder.client = fakeSupabase();
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(<LoginForm onSkip={onSkip} />);
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveAttribute('type', 'email');
    await user.click(screen.getByRole('button', { name: 'Continue without signing in' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
