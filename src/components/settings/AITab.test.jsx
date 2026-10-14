// src/components/settings/AITab.test.jsx — the settings dialog's AI tab, pinned THROUGH the whole dialog: AppSettings
// opens on it, so no test clicks a tab. It covers the provider picker and what it stores, the key field (placeholder,
// hint, reveal toggle, the trimmed autosave 800 ms after the last edit and its Saved flash), Test and its two outcomes,
// the model list (the options, the fallback to the first model, the selection's two preferences), the sentence for a
// provider still waiting for its key, and Refresh models (with a just-pasted key, with a stored one, and when it
// fails). Written before settings/ existed, against the one-file AppSettings, as the contract its decomposition must
// keep (a dialog that mounts one tab at a time, the list from a query on the SAVED key, a separate key tester), so
// every test is a pin: it asserts what the user sees, what the store keeps and what a request carries. Deliberately not
// pinned, because the two designs differ there: how many getModels requests an open or a keystroke sends (two per open
// and one per keystroke today, one per saved key after), except that a provider waiting for its key sends none and that
// Refresh models sends one; anything across a tab switch; and an open on a stored Gemini or OpenAI provider without its
// key, where today a stale Anthropic load wins the race and lists Anthropic's models.
// Fake timers with shouldAdvanceTime keep waitFor and MSW running but also move with real time, so "not saved yet" is
// asserted only right after an edit, and a save only after advancing past the 800 ms debounce.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import AppSettings from '../AppSettings.jsx';
import { getPreference, setPreference } from '../../lib/store.js';
import { server } from '../../test/setup.js';
import { withContexts } from '../../test/contexts.jsx';

const FN = 'http://localhost:3000/.netlify/functions';
const MODELS = [
  { id: 'claude-a', name: 'Claude A', provider: 'anthropic' },
  { id: 'claude-b', name: 'Claude B', provider: 'anthropic' },
];
let requests;
/** Every test serves getModels: the dialog asks for the list on open, whatever the test is about. */
const serveModels = (reply) => server.use(http.get(`${FN}/getModels`, ({ request }) => {
  requests.push(request);
  return reply ? reply(request) : HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' });
}));

const KEY_REQUIRED = 'No API key provided for anthropic. Add your key in Settings.';
const keyRequired = () => HttpResponse.json({
  models: [], provider: 'anthropic', requestId: 'r2', error: KEY_REQUIRED, code: 'KEY_REQUIRED',
});
const UPSTREAM_ERROR = 'Could not list anthropic models';
const upstreamError = () => HttpResponse.json(
  { error: UPSTREAM_ERROR, code: 'UPSTREAM_ERROR', requestId: 'r4' },
  { status: 502 },
);

/** Lists only one key or one provider gets, so a test can tell which request the list came from. */
const CLAUDE_X = [{ id: 'claude-x', name: 'Claude X', provider: 'anthropic' }];
const GEMINI = [{ id: 'gemini-a', name: 'Gemini A', provider: 'gemini' }];

const providerOf = (request) => new URL(request.url).searchParams.get('provider');
const keyOf = (request) => request.headers.get('x-api-key');

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** The whole dialog, open on its AI tab, under both contexts; the user's waits move the fake clock. */
function openSettings() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(withContexts(<AppSettings isOpen onClose={vi.fn()} />));
  return user;
}

/** The model select's option labels, in order. */
const options = () => within(screen.getByRole('combobox')).getAllByRole('option').map((o) => o.textContent);

/** No model list is loading any more. */
const listSettled = () => waitFor(() => expect(screen.queryByText('Fetching available models...')).toBeNull());

describe('AI tab', () => {
  beforeEach(() => {
    requests = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Pin: the key field: its placeholder and hint, the trimmed save 800 ms after the last edit, the Saved flash, the reveal toggle', async () => {
    serveModels();
    const user = openSettings();
    await screen.findByRole('combobox');
    const input = screen.getByPlaceholderText('sk-ant-...');
    expect(screen.getByText('Anthropic API Key')).toBeInTheDocument();
    expect(screen.getByText(/Optional — server key used if empty\./)).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('button', { name: 'Reveal key' })).toBeNull(); // nothing to reveal yet

    await user.type(input, '  sk-ant-new  ');
    expect(getPreference('ai_key_anthropic')).toBeNull();
    expect(screen.queryByText('Saved')).toBeNull();
    await advance(800);
    expect(getPreference('ai_key_anthropic')).toBe('sk-ant-new');
    expect(screen.getByText('Saved')).toBeInTheDocument();
    await advance(1500);
    expect(screen.queryByText('Saved')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Reveal key' }));
    expect(input).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide key' }));
    expect(input).toHaveAttribute('type', 'password');
    await listSettled();
  });

  it('Pin: picking a provider stores it, saves a pending key under the provider it was typed for, and takes the new provider\'s key as the baseline', async () => {
    setPreference('ai_key_openai', 'sk-open-stored');
    serveModels();
    const user = openSettings();
    await screen.findByRole('combobox');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const writesTo = (key) => setItem.mock.calls.filter(([written]) => written === key).length;

    await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-typed');
    await user.click(screen.getByRole('button', { name: 'OpenAI' }));
    expect(getPreference('ai_provider')).toBe('openai');
    expect(getPreference('ai_key_anthropic')).toBe('sk-ant-typed');
    expect(screen.getByText('OpenAI API Key')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('sk-...');
    expect(input).toHaveValue('sk-open-stored');

    // Back to the stored key by way of an empty field: the edit ends where it started, so nothing is written.
    await user.clear(input);
    await user.type(input, 'sk-open-stored');
    await advance(800);
    expect(writesTo('ai_key_openai')).toBe(0);
    expect(getPreference('ai_key_openai')).toBe('sk-open-stored');

    await user.type(input, '-2');
    await advance(800);
    expect(getPreference('ai_key_openai')).toBe('sk-open-stored-2');
    expect(getPreference('ai_key_anthropic')).toBe('sk-ant-typed');
    await listSettled();
  });

  it('Pin: switching provider hides a revealed key and clears the test result', async () => {
    setPreference('ai_key_anthropic', 'sk-ant-stored');
    setPreference('ai_key_openai', 'sk-open-stored');
    serveModels();
    const user = openSettings();
    await screen.findByRole('combobox');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Key valid — models loaded.');
    await user.click(screen.getByRole('button', { name: 'Reveal key' }));
    expect(screen.getByPlaceholderText('sk-ant-...')).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'OpenAI' }));
    const input = screen.getByPlaceholderText('sk-...');
    expect(input).toHaveValue('sk-open-stored');
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Reveal key' })).toBeInTheDocument();
    expect(screen.queryByText('Key valid — models loaded.')).toBeNull();
    await listSettled();
  });

  // The list follows the tested key at once: the autosave alone would move it only 800 ms after the paste.
  it('Pin: Test reports a valid key and lists its models at once; the next edit clears the result', async () => {
    serveModels((request) => (keyOf(request) === 'sk-ant-pasted'
      ? HttpResponse.json({ models: CLAUDE_X, provider: 'anthropic', requestId: 'r3' })
      : HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' })));
    const user = openSettings();
    await screen.findByRole('combobox');
    expect(options()).toEqual(['Claude A', 'Claude B']);
    const input = screen.getByPlaceholderText('sk-ant-...');
    await user.click(input);
    const pastedAt = Date.now();
    await user.paste('sk-ant-pasted');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Key valid — models loaded.');
    await waitFor(() => expect(options()).toEqual(['Claude X']));
    expect(Date.now() - pastedAt).toBeLessThan(800);

    await user.type(input, 'x');
    expect(screen.queryByText('Key valid — models loaded.')).toBeNull();
    await listSettled();
  });

  // The key is stored before the open, so the model area already shows the body's sentence on both designs and the
  // Test adds exactly one more; a typed key would reload per keystroke today and only after the save in the new tab.
  it('Pin: Test shows the error a KEY_REQUIRED body carries', async () => {
    setPreference('ai_key_anthropic', 'sk-ant-stored');
    serveModels(() => keyRequired());
    const user = openSettings();
    expect(await screen.findAllByText(KEY_REQUIRED)).toHaveLength(1); // the model area
    await listSettled();

    await user.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(screen.getAllByText(KEY_REQUIRED)).toHaveLength(2));
    expect(screen.queryByText('Key valid — models loaded.')).toBeNull();
  });

  it('Pin: a stored model that is in the list stays selected, and picking another stores its id and name', async () => {
    setPreference('ai_model', 'claude-b');
    setPreference('ai_model_name', 'Claude B');
    serveModels();
    const user = openSettings();
    const select = await screen.findByRole('combobox');
    await advance(100); // past any effect the list's arrival runs
    expect(options()).toEqual(['Claude A', 'Claude B']);
    expect(select).toHaveValue('claude-b');
    expect(getPreference('ai_model')).toBe('claude-b');
    expect(getPreference('ai_model_name')).toBe('Claude B');

    await user.selectOptions(select, 'claude-a');
    expect(select).toHaveValue('claude-a');
    expect(getPreference('ai_model')).toBe('claude-a');
    expect(getPreference('ai_model_name')).toBe('Claude A');
  });

  it('Pin: a stored model missing from the list falls back to the first, in both preferences', async () => {
    setPreference('ai_model', 'claude-retired');
    setPreference('ai_model_name', 'Claude Retired');
    serveModels();
    openSettings();
    const select = await screen.findByRole('combobox');
    await waitFor(() => {
      expect(select).toHaveValue('claude-a');
      expect(getPreference('ai_model')).toBe('claude-a');
      expect(getPreference('ai_model_name')).toBe('Claude A');
    });
  });

  it('Pin: Gemini without a key asks for one, keeps Refresh models disabled and sends no Gemini request', async () => {
    serveModels();
    const user = openSettings();
    await screen.findByRole('combobox');

    await user.click(screen.getByRole('button', { name: 'Gemini' }));
    expect(screen.getByPlaceholderText('AIza...')).toHaveValue('');
    expect(screen.getByText('Gemini API Key')).toBeInTheDocument();
    expect(screen.getByText(/Required for this provider \(no server default\)\./)).toBeInTheDocument();
    expect((await screen.findAllByText('Enter your Gemini API key to load models.')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: /Refresh models/ })).toBeDisabled();
    await advance(1000);
    expect(requests.filter((request) => providerOf(request) === 'gemini')).toHaveLength(0);
    expect(screen.getAllByText('Enter your Gemini API key to load models.').length).toBeGreaterThan(0);
  });

  // Today the paste itself reloads the list with the draft (and hides the button until that lands), so the count is
  // taken once the button is back. The click must send the key at once: the autosave would send it only 800 ms after
  // the paste, so a request made that late means Refresh waited for the save instead of saving the draft itself.
  it('Pin: Refresh models right after a Gemini key is pasted requests the list with that key at once', async () => {
    const sent = [];
    serveModels((request) => {
      sent.push({ provider: providerOf(request), key: keyOf(request), at: Date.now() });
      return providerOf(request) === 'gemini'
        ? HttpResponse.json({ models: GEMINI, provider: 'gemini', requestId: 'g1' })
        : HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' });
    });
    const withKey = () => sent.filter((s) => s.provider === 'gemini' && s.key === 'AIza-pasted');
    const user = openSettings();
    await screen.findByRole('combobox');
    await user.click(screen.getByRole('button', { name: 'Gemini' }));

    await user.click(screen.getByPlaceholderText('AIza...'));
    const pastedAt = Date.now();
    await user.paste('AIza-pasted');
    const refresh = await screen.findByRole('button', { name: /Refresh models/ });
    const before = withKey().length;
    await user.click(refresh);
    await waitFor(() => expect(withKey()).toHaveLength(before + 1));
    expect(withKey().at(-1).at - pastedAt).toBeLessThan(800);
    await waitFor(() => expect(options()).toEqual(['Gemini A']));
  });

  it('Pin: Refresh models with a stored key sends one more request, carrying that key', async () => {
    setPreference('ai_key_anthropic', 'sk-ant-stored');
    serveModels();
    const user = openSettings();
    await screen.findByRole('combobox');
    await advance(100); // every request of the open has landed
    const settled = requests.length;

    await user.click(screen.getByRole('button', { name: /Refresh models/ }));
    await waitFor(() => expect(requests).toHaveLength(settled + 1));
    expect(providerOf(requests.at(-1))).toBe('anthropic');
    expect(keyOf(requests.at(-1))).toBe('sk-ant-stored');
    await screen.findByRole('combobox');
    await advance(100);
    expect(requests).toHaveLength(settled + 1);
  });

  it('Pin: a Refresh that fails takes the list away and shows why', async () => {
    setPreference('ai_key_anthropic', 'sk-ant-stored');
    let failing = false;
    serveModels(() => (failing
      ? upstreamError()
      : HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' })));
    const user = openSettings();
    await screen.findByRole('combobox');
    await advance(100); // every request of the open has landed

    failing = true;
    await user.click(screen.getByRole('button', { name: /Refresh models/ }));
    expect(await screen.findByText(UPSTREAM_ERROR)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/models? available/)).toBeNull();
  });
});
