// src/components/LoginForm.status.test.jsx
// The sign-in screen's "Check your email" is a result said by a status region, so the region has to be in the
// accessibility tree BEFORE its text: a live region announces a change inside it, and one inserted together with its
// text is not read by every screen reader. The region mounts, empty and visually hidden, when the link is requested and
// is the same node that then holds the two lines. Idle, the screen has no status at all, which the App tests of the
// session check rely on to tell "no notice" from a notice.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../test/a11y.js';
import LoginForm from './LoginForm.jsx';

const holder = vi.hoisted(() => ({ client: null }));
vi.mock('../lib/supabase.js', () => ({
  get supabase() { return holder.client; },
}));

/** A client whose signInWithOtp stays pending until the test settles it. */
function heldClient() {
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  holder.client = { auth: { signInWithOtp: vi.fn(() => pending) } };
  return { answer: (result) => act(async () => { settle(result); await pending; }) };
}

async function sendTo(user, address) {
  await user.type(screen.getByPlaceholderText('you@example.com'), address);
  await user.click(screen.getByRole('button', { name: 'Send magic link' }));
}

describe('LoginForm: the status region of the link it sends', () => {
  afterEach(() => {
    holder.client = null;
  });

  it('Pin: idle, the screen has no status', () => {
    heldClient();
    render(<LoginForm onSkip={vi.fn()} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('has the region in the tree, empty and visually hidden, while the link is requested, and fills that same node', async () => {
    const request = heldClient();
    const user = userEvent.setup();
    const { baseElement } = render(<LoginForm onSkip={vi.fn()} />);

    await sendTo(user, 'trader@example.com');
    expect(screen.getByRole('button', { name: 'Sending...' })).toBeDisabled(); // the request is still out
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    expect(region.parentElement).toHaveClass('sr-only'); // takes no room beside the form, which is still shown
    expect(region.parentElement.className).toBe('sr-only');
    await expectNoAxeViolations(baseElement);

    await request.answer({ error: null });
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Check your email');
    expect(region).toHaveTextContent('We sent a magic link to trader@example.com. Click it to sign in.');
    expect(region).not.toHaveTextContent('Try a different email');
    expect(region.parentElement).not.toHaveClass('sr-only');
    expect(region.parentElement).toHaveClass('rounded-lg', 'p-6', 'text-center'); // the card the result always had
    expect(screen.queryByRole('button', { name: 'Send magic link' })).toBeNull(); // the form is gone
    await expectNoAxeViolations(baseElement);
  });

  it('takes the empty region away again when the link is refused: the alert speaks', async () => {
    const request = heldClient();
    const user = userEvent.setup();
    render(<LoginForm onSkip={vi.fn()} />);

    await sendTo(user, 'trader@example.com');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    await request.answer({ error: { message: 'Email rate limit exceeded' } });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Email rate limit exceeded');
  });

  it('Pin: "Try a different email" brings the form back and leaves no status', async () => {
    const request = heldClient();
    const user = userEvent.setup();
    render(<LoginForm onSkip={vi.fn()} />);

    await sendTo(user, 'trader@example.com');
    await request.answer({ error: null });
    await user.click(screen.getByRole('button', { name: 'Try a different email' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send magic link' })).toBeInTheDocument();
  });
});
