// src/components/settings/AITab.a11y.test.jsx — the AI tab rendered alone (it reads no context) in the states a
// screen reader meets, one axe run per state: the model list in, with the key field, the model select and the provider
// picker labelled (a click on the Model label focuses the select; the picker is a named group of toggles, the provider
// in use pressed); Test checking a key, its button still named; a key that lists models, announced as a status; a key
// refused, announced as an alert, the key field marked invalid until the next edit. Each result is the key field's
// description, before its hint. The key field and the select are still found as the pin files find them (Pin).
// MSW answers getModels with the list for every request but the stored key's second, which is Test's (the first is the
// list the tab loads for the saved key); a test passes the reply for that one.
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup.js';
import { expectLabelledControls, expectNoAxeViolations } from '../../test/a11y.js';
import { setPreference } from '../../lib/store.js';
import AITab from './AITab.js';

const FN = 'http://localhost:3000/.netlify/functions';
const MODELS = [
  { id: 'claude-a', name: 'Claude A', provider: 'anthropic' },
  { id: 'claude-b', name: 'Claude B', provider: 'anthropic' },
];
const LISTED = () => HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' });
const STORED = 'sk-ant-stored';
/** The hint under the Anthropic key field, which needs no key of the user's. */
const KEY_HINT = 'Stored locally in your browser. Optional — server key used if empty.';
const VALID = 'Key valid — models loaded.';
const REFUSED = 'Anthropic rejected the key';

/** getModels: the list, except the stored key's second request (Test's), which `testReply` answers when given. */
function serveModels(testReply) {
  const seen = new Map();
  server.use(http.get(`${FN}/getModels`, ({ request }) => {
    const key = request.headers.get('x-api-key') ?? '';
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return key === STORED && n === 2 && testReply ? testReply() : LISTED();
  }));
}

/** The tab, with `stored` as the saved Anthropic key, once its model list is in. */
async function renderTab({ stored } = {}) {
  if (stored) setPreference('ai_key_anthropic', stored);
  const user = userEvent.setup();
  const view = render(<AITab />);
  await screen.findByRole('combobox');
  return { user, ...view };
}

const keyField = () => screen.getByLabelText('Anthropic API Key');

/**
 * A description that is `text` and nothing else, but for leading space: the field names Test's status region before
 * the hint, empty until there is a result, and dom-accessibility-api joins the parts with a space without trimming the
 * result, where a browser trims it.
 */
const only = (text) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

describe('AITab', () => {
  it('labels the key field and the model select, with nothing missing for axe', async () => {
    serveModels();
    const { container } = await renderTab();
    expectLabelledControls(container);
    expect(keyField()).toBe(screen.getByPlaceholderText('sk-ant-...'));
    expect(keyField()).toHaveAccessibleDescription(only(KEY_HINT));
    expect(keyField()).not.toBeInvalid();
    expect(screen.getByLabelText('Model')).toBe(screen.getByRole('combobox'));
    await expectNoAxeViolations(container);
  });

  it('focuses the model select when its label is clicked', async () => {
    serveModels();
    const { user } = await renderTab();
    await user.click(screen.getByText('Model'));
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('names the provider picker and marks the provider in use as pressed', async () => {
    serveModels();
    const { user } = await renderTab();
    const picker = screen.getByRole('group', { name: 'AI provider' });
    expect(within(picker).getAllByRole('button').map((button) => [button.textContent, button.getAttribute('aria-pressed')]))
      .toEqual([['Anthropic', 'true'], ['Gemini', 'false'], ['OpenAI', 'false']]);

    // OpenAI needs a key of the user's, so the switch sends no request.
    await user.click(within(picker).getByRole('button', { name: 'OpenAI' }));
    expect(within(picker).getByRole('button', { name: 'OpenAI', pressed: true })).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: 'Anthropic', pressed: false })).toBeInTheDocument();
  });

  it('keeps a name on the Test button while it checks the key, with nothing missing for axe', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    serveModels(async () => { await held; return LISTED(); });
    const { user, container } = await renderTab({ stored: STORED });

    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(screen.getByRole('button', { name: 'Testing key' })).toBeDisabled();
    await expectNoAxeViolations(container);

    release();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(VALID));
  });

  it('announces a key that lists models as a status that describes the key field, the button still named Test', async () => {
    serveModels(LISTED);
    const { user, container } = await renderTab({ stored: STORED });

    await user.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(VALID));
    expect(keyField()).toHaveAccessibleDescription(`${VALID} ${KEY_HINT}`);
    expect(keyField()).not.toBeInvalid();
    expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled();
    await expectNoAxeViolations(container);
  });

  it('announces a refused key as an alert that describes the key field, marks it invalid, and clears both on the next edit', async () => {
    serveModels(() => HttpResponse.json({ error: REFUSED, code: 'UPSTREAM_ERROR', requestId: 'r2' }, { status: 502 }));
    const { user, container } = await renderTab({ stored: STORED });

    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED);
    expect(keyField()).toHaveAccessibleDescription(`${REFUSED} ${KEY_HINT}`);
    expect(keyField()).toBeInvalid();
    expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled();
    await expectNoAxeViolations(container);

    await user.type(keyField(), 'x');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(keyField()).not.toBeInvalid();
    expect(keyField()).toHaveAccessibleDescription(only(KEY_HINT));
  });

  it('Pin: the key field is still found by its placeholder and the model select by its role', async () => {
    serveModels();
    await renderTab();
    expect(screen.getByPlaceholderText('sk-ant-...')).toHaveAttribute('type', 'password');
    expect(within(screen.getByRole('combobox')).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['Claude A', 'Claude B']);
  });
});
