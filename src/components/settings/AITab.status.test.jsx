// src/components/settings/AITab.status.test.jsx — the AI tab's status region for Test's result is in the tree before
// the result: a live region announces a change inside it, and one inserted together with its text is not read by every
// screen reader. The tab renders it from its first render, empty and visually hidden (sr-only alone, none of the
// result's classes), and a valid key fills that same node; a refused key is still an alert, inserted with its text.
// The key field's description is what a user gets: the hint alone while the region is empty, the result before the
// hint once there is one. One axe run per state. Role queries are scoped to the tab's container.
// MSW answers getModels with the list for every request but the stored key's second, which is Test's (the first is the
// list the tab loads for the saved key); a test passes the reply for that one.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup.js';
import { expectNoAxeViolations } from '../../test/a11y.js';
import { setPreference } from '../../lib/store.js';
import AITab from './AITab.js';

const FN = 'http://localhost:3000/.netlify/functions';
const MODELS = [{ id: 'claude-a', name: 'Claude A', provider: 'anthropic' }];
const LISTED = () => HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' });
const STORED = 'sk-ant-stored';
const KEY_HINT = 'Stored locally in your browser. Optional — server key used if empty.';
const VALID = 'Key valid — models loaded.';
const REFUSED = 'Anthropic rejected the key';
/** The classes the valid key's line has while it shows. */
const SHOWN = ['flex', 'items-center', 'gap-1.5', 'mt-1.5', 'text-[11px]', 'text-[var(--color-bull)]'];

/** getModels: the list, except the stored key's second request (Test's), which `testReply` answers. */
function serveModels(testReply) {
  const seen = new Map();
  server.use(http.get(`${FN}/getModels`, ({ request }) => {
    const key = request.headers.get('x-api-key') ?? '';
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return key === STORED && n === 2 ? testReply() : LISTED();
  }));
}

/** The tab with a stored key, once its model list is in. */
async function renderTab() {
  setPreference('ai_key_anthropic', STORED);
  const user = userEvent.setup();
  const view = render(<AITab />);
  await screen.findByRole('combobox');
  return { user, ...view };
}

const keyField = () => screen.getByLabelText('Anthropic API Key');

/**
 * A description that is `text` and nothing else, but for leading space: the field names the empty region first, and
 * dom-accessibility-api joins the parts with a space without trimming the result, where a browser trims it.
 */
const only = (text) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

describe('AITab: the status region for Test', () => {
  it('is there, empty and visually hidden, before Test, and the hint alone describes the key field', async () => {
    serveModels(LISTED);
    const { container } = await renderTab();
    const status = within(container).getByRole('status');
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveClass('sr-only', { exact: true });
    expect(keyField()).toHaveAccessibleDescription(only(KEY_HINT));
    await expectNoAxeViolations(container);
  });

  it('holds the valid key\'s line in the same node, with the classes it shows with, before the hint', async () => {
    serveModels(LISTED);
    const { user, container } = await renderTab();
    const status = within(container).getByRole('status');

    await user.click(screen.getByRole('button', { name: 'Test' }));
    await within(container).findByText(VALID);
    expect(within(container).getByRole('status')).toBe(status);
    expect(status).toHaveTextContent(VALID);
    expect(status).toHaveClass(...SHOWN);
    expect(status).not.toHaveClass('sr-only');
    expect(keyField()).toHaveAccessibleDescription(`${VALID} ${KEY_HINT}`);
    await expectNoAxeViolations(container);
  });

  it('stays, empty, beside the alert of a refused key, which describes the key field', async () => {
    serveModels(() => HttpResponse.json({ error: REFUSED, code: 'UPSTREAM_ERROR', requestId: 'r2' }, { status: 502 }));
    const { user, container } = await renderTab();
    const status = within(container).getByRole('status');

    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await within(container).findByRole('alert')).toHaveTextContent(REFUSED);
    expect(within(container).getByRole('status')).toBe(status);
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveClass('sr-only', { exact: true });
    expect(keyField()).toHaveAccessibleDescription(`${REFUSED} ${KEY_HINT}`);
    expect(keyField()).toBeInvalid();
  });
});
