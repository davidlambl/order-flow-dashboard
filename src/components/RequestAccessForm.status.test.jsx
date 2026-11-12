// src/components/RequestAccessForm.status.test.jsx — the request-access form's status region for a sent request is in
// the tree before the request is sent: a live region announces a change inside it, and one inserted together with its
// text is not read by every screen reader. The region is the form's sibling from the first render, empty and visually
// hidden (sr-only alone, none of the sent line's classes), and a sent request fills that same node as the form goes;
// no element wraps the two. One axe run per state. MSW answers the form's POST to the site root (Netlify Forms).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup.js';
import { expectNoAxeViolations } from '../test/a11y.js';
import RequestAccessForm from './RequestAccessForm.jsx';

const SITE = 'http://localhost:3000/';
const SENT = "Request sent — you'll hear back soon.";
/** The classes the sent line has while it shows. */
const SHOWN = ['flex', 'items-center', 'gap-2', 'py-3', 'px-3', 'rounded-lg', 'border'];

describe.each([
  ['stacked, as in Settings', false],
  ['side by side, as on a premium gate', true],
])('RequestAccessForm, %s: the status region for a sent request', (_, compact) => {
  it('is there, empty and visually hidden, beside the form, with no element around the two', async () => {
    const { container } = render(<RequestAccessForm compact={compact} />);
    const status = within(container).getByRole('status');
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveClass('sr-only', { exact: true });
    expect(status.parentElement).toBe(container);
    expect(container.querySelector('form').parentElement).toBe(container);
    await expectNoAxeViolations(container);
  });

  it('holds the sent line in the same node, with the classes it shows with, once the form is gone', async () => {
    server.use(http.post(SITE, () => new HttpResponse(null, { status: 200 })));
    const user = userEvent.setup();
    const { container } = render(<RequestAccessForm compact={compact} />);
    const status = within(container).getByRole('status');

    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Email address'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Request Access' }));
    await within(container).findByText(SENT);
    expect(within(container).getByRole('status')).toBe(status);
    expect(status).toHaveTextContent(SENT);
    expect(status).toHaveClass(...SHOWN);
    expect(status).not.toHaveClass('sr-only');
    expect(container.querySelector('form')).toBeNull();
    await expectNoAxeViolations(container);
  });
});
