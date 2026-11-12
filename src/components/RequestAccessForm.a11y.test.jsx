// src/components/RequestAccessForm.a11y.test.jsx — the request-access form as a screen reader and a pointer meet it,
// rendered bare, stacked as in Settings and side by side as on a premium gate (`compact`): its three fields are named
// by visible labels, each focusing its own field, and the name and e-mail fields tell the browser what they hold
// (autocomplete, WCAG 1.3.5); a request the server refuses is announced as an alert, one it takes as a status; one
// axe run per state. Each field is still found by its placeholder (Pin). MSW answers the form's POST to the site root
// (Netlify Forms) as a test sets it.
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { expectLabelledControls, expectNoAxeViolations } from '../test/a11y.js';
import RequestAccessForm from './RequestAccessForm.jsx';

const SITE = 'http://localhost:3000/';
const PLACEHOLDERS = {
  Name: 'Your name',
  'Email address': 'your@email.com',
  'Message (optional)': "Why you'd like access (optional)",
};

/** Fills in the two required fields (found by placeholder, as before the labels) and sends the form. */
async function send(user) {
  await user.type(screen.getByPlaceholderText('Your name'), 'Ada');
  await user.type(screen.getByPlaceholderText('your@email.com'), 'ada@example.com');
  await user.click(screen.getByRole('button', { name: 'Request Access' }));
}

describe('RequestAccessForm', () => {
  it.each([
    ['stacked, as in Settings', false],
    ['side by side, as on a premium gate', true],
  ])('names its three fields with visible labels, %s, with nothing missing for axe', async (_, compact) => {
    const { container } = render(<RequestAccessForm compact={compact} />);
    expectLabelledControls(container);
    for (const [label, placeholder] of Object.entries(PLACEHOLDERS)) {
      expect(screen.getByLabelText(label)).toBe(screen.getByPlaceholderText(placeholder));
    }
    await expectNoAxeViolations(container);
  });

  it('focuses each field when its own label is clicked', async () => {
    const user = userEvent.setup();
    render(<RequestAccessForm compact />);
    for (const [label, placeholder] of Object.entries(PLACEHOLDERS)) {
      await user.click(screen.getByText(label));
      expect(screen.getByPlaceholderText(placeholder)).toHaveFocus();
    }
  });

  it('tells the browser which fields hold a name and an e-mail address', () => {
    render(<RequestAccessForm compact={false} />);
    expect(screen.getByPlaceholderText('Your name')).toHaveAttribute('autocomplete', 'name');
    expect(screen.getByPlaceholderText('your@email.com')).toHaveAttribute('autocomplete', 'email');
  });

  it('announces a request the server refuses as an alert, with nothing missing for axe', async () => {
    server.use(http.post(SITE, () => new HttpResponse('Form not found', { status: 404 })));
    const user = userEvent.setup();
    const { container } = render(<RequestAccessForm compact={false} />);
    await send(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server returned 404: Form not found');
    await expectNoAxeViolations(container);
  });

  it('announces a request the server takes as a status, with nothing missing for axe', async () => {
    server.use(http.post(SITE, () => new HttpResponse(null, { status: 200 })));
    const user = userEvent.setup();
    const { container } = render(<RequestAccessForm compact />);
    await send(user);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Request sent — you'll hear back soon."));
    await expectNoAxeViolations(container);
  });

  it('Pin: each field is still found by its placeholder', () => {
    render(<RequestAccessForm compact />);
    expect(screen.getByPlaceholderText('Your name')).toHaveAttribute('type', 'text');
    expect(screen.getByPlaceholderText('your@email.com')).toHaveAttribute('type', 'email');
    expect(screen.getByPlaceholderText("Why you'd like access (optional)").tagName).toBe('TEXTAREA');
  });
});
