// src/components/settings/BackupTab.test.jsx — the Backup tab through the whole settings dialog, written before
// settings/ existed: the strategic-context preview read from the store (its first four lines and its size), Clear
// behind a confirm, the editor the tab opens (a portal) with its 1000 ms autosave and the preview that follows it,
// Escape closing that editor before the dialog, Export (the file handed to the download link, and its name), Import
// behind a confirm (the report and the settings it skipped, a "no", a file the store refuses) and Reset all settings
// behind a confirm. The dialog is about to become a shell over one tab at a time, each mounted only while shown, with
// the editor mounted only while open and the preview following the store's events instead of being re-read when the
// editor closes, so every test is a pin that must pass on both trees: it asserts what the user sees and what the store
// holds once an action has settled (and the editor's 1000 ms debounce, which both keep), never the order of a write
// and a close, how many getModels requests the dialog sends, or what a tab keeps across a switch. Reset is pinned up
// to its eight cleared settings and its data-source-changed: today it also reloads the default model list, whose
// fallback writes ai_model again, and the decomposed tab leaves that to the AI tab's next mount.
// Rendered under StrictMode in a host that owns isOpen, as App does, so a close unmounts the dialog. The dialog opens
// on the AI tab, which loads the model list: every test serves getModels (MSW would otherwise log an error and show
// it in the model area) and waits for the list before it shows Backup. Fake timers run with shouldAdvanceTime, so
// waitFor, MSW and the FileReader keep working.
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import AppSettings from '../AppSettings.jsx';
import { getPosition, getPreference, setChatHistory, setPosition, setPreference } from '../../lib/store.js';
import { server } from '../../test/setup.js';
import { withContexts } from '../../test/contexts.jsx';

const FN = 'http://localhost:3000/.netlify/functions';
const MODELS = [{ id: 'claude-a', name: 'Claude A', provider: 'anthropic' }, { id: 'claude-b', name: 'Claude B', provider: 'anthropic' }];

/** Every getModels request, as in the other pin files; the Backup tab's pins never count them. */
let requests;
const serveModels = (reply) => server.use(http.get(`${FN}/getModels`, ({ request }) => { requests.push(request); return reply ? reply(request) : HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' }); }));

/** App's shape: the host owns isOpen and closes the dialog from onClose; onClosed counts the closes. */
function Stateful({ onClosed }) {
  const [open, setOpen] = useState(true);
  return <AppSettings isOpen={open} onClose={() => { setOpen(false); onClosed(); }} />;
}

/** The dialog, open, under StrictMode as main.jsx renders App; `auth` overrides authValue (signed out by default). */
function renderSettings({ auth } = {}) {
  const onClosed = vi.fn();
  render(<StrictMode>{withContexts(<Stateful onClosed={onClosed} />, { auth })}</StrictMode>);
  return { onClosed };
}

/** Wait for the AI tab's model list (the dialog opens there), then show the Backup tab. */
async function openBackup(user) {
  await screen.findByRole('combobox');
  await user.click(screen.getByRole('button', { name: 'Backup' }));
}

/** The editor's textarea (a portal to document.body), or null while the editor is closed. */
const editor = () => screen.queryByPlaceholderText(/Paste your strategic context/);

/** The button shown in place of the preview while no context is stored, or null. */
const addButton = () => screen.queryByRole('button', { name: 'Add strategic context for the AI Co-Pilot' });

/** The preview's text block, found by its text with the line breaks collapsed, as getByText reads it. */
const previewShowing = (text) => screen.getByText(text.replace(/\n/g, ' '));

const fileInput = () => document.querySelector('input[type="file"]');
const backupFile = (backup) => new File([JSON.stringify(backup)], 'b.json', { type: 'application/json' });

/** A backup as exportAll() writes it, with an API key and an unknown name a hand edit could add. */
const BACKUP = {
  version: 2,
  exportedAt: '2026-10-01T12:00:00.000Z',
  positions: { NVDA: { costBasis: 100, shares: 5 } },
  chatHistories: {},
  preferences: { ai_provider: 'openai', ai_key_openai: 'secret', bogus: 1 },
};

/** The import's question, signed out and signed in (signed in, an import also replaces the account's copy). */
const IMPORT_QUESTION = 'Import replaces the positions, chat histories and settings on this device. '
  + 'API keys on this device are kept. Continue?';
const IMPORT_QUESTION_SIGNED_IN = 'Import replaces the positions, chat histories and settings on this device and in '
  + 'your cloud account. API keys on this device are kept. Continue?';
const RESET_QUESTION = 'Reset all settings? This will clear your API keys, model selection, and data source keys. '
  + 'This cannot be undone.';

/** What the user writes for the AI Co-Pilot: five lines, so the preview shows the first four and a marker. */
const NOTES = [
  'Thesis: AI capex keeps rising', 'Add below 160', 'Trim a third above 200', 'Earnings Dec 11', 'Stop below 140',
].join('\n');
const NOTES_PREVIEW = 'Thesis: AI capex keeps rising\nAdd below 160\nTrim a third above 200\nEarnings Dec 11 …';

const CHAT = [{ role: 'user', content: 'Hold or trim?' }, { role: 'assistant', content: 'Hold into earnings.' }];

/** The eight settings Reset clears, each set; the model is one the list holds, so no fallback rewrites it. */
const SETTINGS = {
  ai_provider: 'openai', ai_model: 'claude-b', ai_model_name: 'Claude B',
  ai_key_anthropic: 'sk-ant-1', ai_key_openai: 'sk-1', ai_key_gemini: 'AIza-1',
  data_tradier_key: 'trd-1', data_finnhub_key: 'fh-1',
};
const storedSettings = () => Object.fromEntries(Object.keys(SETTINGS).map((name) => [name, getPreference(name)]));

describe('the Backup tab', () => {
  beforeEach(() => {
    requests = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Pin: the preview shows the stored context\'s first four lines and its size, and opens the editor on the whole text', async () => {
    setPreference('strategic_context', NOTES);
    serveModels();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings();
    await openBackup(user);

    const preview = previewShowing(NOTES_PREVIEW);
    expect(preview.textContent).toBe(NOTES_PREVIEW);
    expect(screen.queryByText(/Stop below 140/)).toBeNull();
    expect(screen.getByText('97 characters · 5 lines')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(addButton()).toBeNull();
    expect(editor()).toBeNull();

    await user.click(preview);
    expect(editor()).toHaveValue(NOTES);
  });

  it('Pin: with no context the add button opens the editor, an edit is saved after 1000 ms, and the preview shows it once the editor closes', async () => {
    serveModels();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings();
    await openBackup(user);
    expect(screen.queryByText(/ characters · /)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();

    await user.click(addButton());
    expect(editor()).toHaveValue('');
    await user.type(editor(), 'Buy the dip{Enter}Trim at 200');
    expect(getPreference('strategic_context')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getPreference('strategic_context')).toBe('Buy the dip\nTrim at 200');

    await user.click(screen.getByLabelText('Close strategic context editor'));
    expect(editor()).toBeNull();
    expect(previewShowing('Buy the dip\nTrim at 200').textContent).toBe('Buy the dip\nTrim at 200');
    expect(screen.getByText('23 characters · 2 lines')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(addButton()).toBeNull();
  });

  it('Pin: an edit still inside the debounce window when the editor closes is saved, and the preview shows it', async () => {
    const edited = 'Long AVGO into earnings\nTrim above 200';
    setPreference('strategic_context', 'Long AVGO into earnings');
    serveModels();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings();
    await openBackup(user);

    await user.click(previewShowing('Long AVGO into earnings'));
    expect(editor()).toHaveValue('Long AVGO into earnings');
    await user.type(editor(), '{Enter}Trim above 200');
    expect(getPreference('strategic_context')).toBe('Long AVGO into earnings');

    await user.click(screen.getByLabelText('Close strategic context editor'));
    expect(editor()).toBeNull();
    expect(getPreference('strategic_context')).toBe(edited);
    expect(previewShowing(edited).textContent).toBe(edited);
    expect(screen.getByText('38 characters · 2 lines')).toBeInTheDocument();
  });

  it('Pin: Clear asks first: a "no" keeps the context, a "yes" removes it from the store and the preview', async () => {
    setPreference('strategic_context', 'Long AVGO into earnings');
    serveModels();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings();
    await openBackup(user);

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(confirm).toHaveBeenCalledWith('Clear all strategic context?');
    expect(getPreference('strategic_context')).toBe('Long AVGO into earnings');
    expect(screen.getByText('Long AVGO into earnings')).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(getPreference('strategic_context')).toBeNull();
    expect(screen.queryByText('Long AVGO into earnings')).toBeNull();
    expect(screen.queryByText(/ characters · /)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(addButton()).toBeInTheDocument();
  });

  it('Pin: Escape in the open editor closes the editor and not Settings; the next Escape closes Settings', async () => {
    serveModels();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onClosed } = renderSettings();
    await openBackup(user);
    await user.click(addButton());
    expect(editor()).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(editor()).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset all settings' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('Pin: Export downloads ofd-backup-<date>.json holding the positions, chats and settings, and no API key', async () => {
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    setPosition('AVGO', { costBasis: 150, shares: 10 });
    setChatHistory('AVGO', CHAT);
    setPreference('strategic_context', 'Long AVGO into earnings');
    setPreference('ai_key_anthropic', 'sk-ant-secret');
    serveModels();
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicks.push({ href: this.href, download: this.download }); });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings();
    await openBackup(user);

    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(clicks).toEqual([{ href: 'blob:x', download: 'ofd-backup-2026-10-13.json' }]);
    expect(created).toHaveBeenCalledTimes(1);
    const file = created.mock.calls[0][0];
    expect(file.type).toBe('application/json');
    const text = await file.text();
    expect(text).not.toContain('sk-ant-secret');
    const backup = JSON.parse(text);
    expect(backup.positions).toEqual({ AVGO: { costBasis: 150, shares: 10 } });
    expect(backup.chatHistories).toEqual({ AVGO: CHAT });
    expect(backup.preferences).toMatchObject({ strategic_context: 'Long AVGO into earnings' });
    expect(backup.preferences).not.toHaveProperty('ai_key_anthropic');
  });

  it('Pin: Import asks first, then replaces the data, keeps this device\'s API keys and reports what it imported and the settings it did not', async () => {
    setPosition('AVGO', { costBasis: 150, shares: 10 });
    setPreference('strategic_context', 'Long AVGO into earnings');
    setPreference('ai_key_openai', 'sk-device');
    serveModels();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings();
    await openBackup(user);
    expect(screen.getByText('Long AVGO into earnings')).toBeInTheDocument();

    fireEvent.change(fileInput(), { target: { files: [backupFile(BACKUP)] } });
    const status = await screen.findByRole('status');
    expect(within(status).getByText('Imported 1 position, 0 chats, 1 setting.')).toBeInTheDocument();
    expect(within(status).getByText('Not imported: ai_key_openai, bogus')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(IMPORT_QUESTION);
    expect(getPosition('NVDA')).toEqual({ costBasis: 100, shares: 5 });
    expect(getPosition('AVGO')).toEqual({ costBasis: null, shares: null });
    expect(getPreference('ai_provider')).toBe('openai');
    expect(getPreference('ai_key_openai')).toBe('sk-device');
    // The backup holds no strategic context: the import removed this device's, and the preview follows.
    expect(getPreference('strategic_context')).toBeNull();
    expect(screen.queryByText('Long AVGO into earnings')).toBeNull();
    expect(addButton()).toBeInTheDocument();
  });

  it('Pin: a "no" to the import changes nothing and clears an earlier report; signed in, the question names the cloud account', async () => {
    serveModels();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings({ auth: { userEmail: 'a@b.c', signedIn: true } });
    await openBackup(user);
    fireEvent.change(fileInput(), { target: { files: [backupFile(BACKUP)] } });
    expect(await screen.findByRole('status')).toHaveTextContent('Imported 1 position, 0 chats, 1 setting.');

    confirm.mockReturnValue(false);
    const other = {
      ...BACKUP, positions: { AMD: { costBasis: 120, shares: 8 } }, preferences: { ai_provider: 'gemini' },
    };
    fireEvent.change(fileInput(), { target: { files: [backupFile(other)] } });
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenLastCalledWith(IMPORT_QUESTION_SIGNED_IN);
    expect(screen.queryByRole('status')).toBeNull();
    expect(getPosition('NVDA')).toEqual({ costBasis: 100, shares: 5 });
    expect(getPosition('AMD')).toEqual({ costBasis: null, shares: null });
    expect(getPreference('ai_provider')).toBe('openai');
  });

  it('Pin: a backup the store refuses shows its reason and changes nothing', async () => {
    setPosition('AVGO', { costBasis: 150, shares: 10 });
    serveModels();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings();
    await openBackup(user);

    const unversioned = { positions: { NVDA: { costBasis: 100, shares: 5 } } };
    fireEvent.change(fileInput(), { target: { files: [backupFile(unversioned)] } });
    expect(await screen.findByText('Missing schema version.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(getPosition('AVGO')).toEqual({ costBasis: 150, shares: 10 });
    expect(getPosition('NVDA')).toEqual({ costBasis: null, shares: null });
  });

  it('Pin: Reset all settings asks first, then clears the eight settings and dispatches data-source-changed, keeping the context and the positions', async () => {
    for (const [name, value] of Object.entries(SETTINGS)) setPreference(name, value);
    setPreference('strategic_context', 'Long AVGO into earnings');
    setPosition('AVGO', { costBasis: 150, shares: 10 });
    serveModels();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const sourceChanges = vi.fn();
    window.addEventListener('data-source-changed', sourceChanges);
    onTestFinished(() => window.removeEventListener('data-source-changed', sourceChanges));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSettings();
    await openBackup(user);
    // Today's Reset also reloads the default model list, whose fallback writes ai_model when the list lands (the
    // decomposed tab leaves that to the AI tab's next mount). From here getModels never answers, so that write cannot
    // land in this test or after it, in the next test's storage.
    serveModels(() => new Promise(() => {}));

    await user.click(screen.getByRole('button', { name: 'Reset all settings' }));
    expect(confirm).toHaveBeenCalledWith(RESET_QUESTION);
    expect(storedSettings()).toEqual(SETTINGS);
    expect(sourceChanges).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Reset all settings' }));
    expect(storedSettings()).toEqual(Object.fromEntries(Object.keys(SETTINGS).map((name) => [name, null])));
    expect(sourceChanges).toHaveBeenCalledTimes(1);
    expect(getPreference('strategic_context')).toBe('Long AVGO into earnings');
    expect(getPosition('AVGO')).toEqual({ costBasis: 150, shares: 10 });
  });
});
