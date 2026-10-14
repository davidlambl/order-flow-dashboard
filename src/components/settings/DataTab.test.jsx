// src/components/settings/DataTab.test.jsx — the Data tab, through the whole Settings dialog: the banner that names
// MarketContext's data source, the Tradier and Finnhub keys (loaded from the store, saved trimmed once the typing stops
// or the dialog closes, every save followed by one data-source-changed, the Finnhub key's reaching a store reader as
// App's research flag reads it), the hint under each key and the reveal toggles. Written against the one-file
// AppSettings before settings/ existed, as the contract its decomposition into a dialog over one tab at a time must
// keep, so every test is a pin. That dialog mounts a tab only while it shows and its onClose no longer saves by
// itself, so nothing here is asserted across a tab switch or about when a switch saves, and the close is driven
// through a host that flips isOpen, as App does, asserting only what holds once the dialog is gone. Opening the
// dialog loads the AI tab's model list whatever tab a test is about, so every test serves getModels. The fake clock
// also moves with real time (MSW and waitFor need it), so an edit's "not saved yet" is asserted in the same tick as
// the edit, never at a boundary.
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import AppSettings from '../AppSettings.jsx';
import { useStoreValue } from '../../hooks/useStoreValue.js';
import { getPreference, setPreference } from '../../lib/store.js';
import { server } from '../../test/setup.js';
import { withContexts } from '../../test/contexts.jsx';

const FN = 'http://localhost:3000/.netlify/functions';
const MODELS = [
  { id: 'claude-a', name: 'Claude A', provider: 'anthropic' },
  { id: 'claude-b', name: 'Claude B', provider: 'anthropic' },
];
let requests;
/** The getModels handler of every settings pin file; the Data tab's pins never read what it received. */
const serveModels = (reply) => server.use(http.get(`${FN}/getModels`, ({ request }) => {
  requests.push(request);
  return reply ? reply(request) : HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' });
}));

// Each save of a data key dispatches data-source-changed, on which the market-data, quote and research hooks refetch;
// counted from before the dialog opens, so an event on opening would count too.
let dataSourceChanges;
const countDataSourceChange = () => { dataSourceChanges += 1; };

/** The tab's two keys: the label's name, the input's placeholder, the preference, and the hint with and without one. */
const TRADIER = {
  name: 'Tradier', pref: 'data_tradier_key', placeholder: 'Paste for real-time data...',
  saved: 'Key saved — data will use Tradier on next refresh.',
  none: 'A free sandbox key works for testing — get one at tradier.com.',
};
const FINNHUB = {
  name: 'Finnhub', pref: 'data_finnhub_key', placeholder: 'Paste for news, earnings, analyst data...',
  saved: 'Key saved — enables news, earnings, analyst ratings, and technicals.',
  none: 'Free API key from finnhub.io. Powers the Research panel and AI Co-Pilot context.',
};
/** The Tradier hint without a key of the user's while the data already comes from Tradier. */
const SERVER_KEY = 'Currently using server-configured Tradier key.';

/** The four data sources App reports, with the banner's title, sentence, box colours and dot colour for each. */
const BANNERS = [
  ['cboe', 'CBOE Delayed Quotes',
    'Options data is ~15 minutes delayed. Add a Tradier API key below for real-time data.',
    ['border-[var(--color-accent)]/30', 'bg-[var(--color-accent)]/5'], 'bg-[var(--color-accent)]'],
  ['tradier', 'Tradier Real-Time',
    'Live options chain data via Tradier brokerage API. GEX, Max Pain, and all metrics are real-time.',
    ['border-[var(--color-bull)]/30', 'bg-[var(--color-bull-bg)]'], 'bg-[var(--color-bull)]'],
  ['tradier-sandbox', 'Tradier Sandbox',
    'Delayed data from Tradier sandbox. Upgrade to a brokerage account for real-time feeds.',
    ['border-[var(--color-cyan)]/30', 'bg-[var(--color-cyan-bg)]'], 'bg-[var(--color-cyan)]'],
  ['mock', 'Demo Data', 'Simulated data for demonstration. Deploy to Netlify for live CBOE data.',
    ['border-[var(--color-warn-border-muted)]', 'bg-[var(--color-warn-bg)]'], 'bg-[var(--color-warn)]'],
];

/** The dialog as App renders it while open, under both contexts; `dataSource` is MarketContext's. */
const dialog = (dataSource = 'cboe', onClose = vi.fn()) => withContexts(
  <AppSettings isOpen onClose={onClose} />,
  { market: { dataSource } },
);

/** App's shape: onClose flips isOpen, so a close unmounts whatever the dialog rendered. */
function Stateful({ onClosed }) {
  const [open, setOpen] = useState(true);
  return <AppSettings isOpen={open} onClose={() => { setOpen(false); onClosed(); }} />;
}

// App turns research on from the stored Finnhub key with this very reader (useStoreValue over getPreference), so a
// key saved or emptied in Settings has to reach it through the store bus while the dialog is still open.
const readHasFinnhubKey = () => Boolean(getPreference('data_finnhub_key'));
function ResearchFlag() {
  return <p>{useStoreValue(readHasFinnhubKey) ? 'research on' : 'research off'}</p>;
}

/** Renders `ui` (the dialog opens on its AI tab) and clicks the Data tab; returns the user and render's result. */
async function openDataTab(ui = dialog()) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = render(ui);
  await user.click(screen.getByRole('button', { name: 'Data' }));
  return { user, ...view };
}

const input = (key) => screen.getByPlaceholderText(key.placeholder);

/** The reveal toggle inside a key's input box, or null while the box shows none. */
const toggleOf = (key) => within(input(key).parentElement).queryByRole('button');

/** The row with a key's label, where its Saved flash shows. */
const labelRow = (key) => screen.getByText(`${key.name} API Key`).parentElement;

/** The banner: the box around a data source's title. */
const banner = (title) => screen.getByText(title).closest('.rounded-lg');

describe('AppSettings: the Data tab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    requests = [];
    dataSourceChanges = 0;
    window.addEventListener('data-source-changed', countDataSourceChange);
  });

  afterEach(() => {
    window.removeEventListener('data-source-changed', countDataSourceChange);
    vi.useRealTimers();
  });

  it('Pin: the banner names each of the four data sources, says what it means and wears its colours', async () => {
    serveModels();
    const onClose = vi.fn();
    const { rerender } = await openDataTab(dialog('cboe', onClose));

    for (const [dataSource, title, sentence, box, dot] of BANNERS) {
      rerender(dialog(dataSource, onClose));
      expect(within(banner(title)).getByText(sentence)).toBeInTheDocument();
      expect(banner(title)).toHaveClass(...box);
      expect(banner(title).querySelector('.rounded-full')).toHaveClass(dot);
      for (const [, other] of BANNERS) {
        if (other !== title) expect(screen.queryByText(other)).toBeNull();
      }
    }
  });

  it('Pin: stored keys load into hidden inputs with their toggles and saved hints, and opening writes neither back', async () => {
    serveModels();
    setPreference(TRADIER.pref, 'tr-stored');
    setPreference(FINNHUB.pref, 'fh-stored');
    await openDataTab();

    for (const [key, value] of [[TRADIER, 'tr-stored'], [FINNHUB, 'fh-stored']]) {
      expect(input(key)).toHaveValue(value);
      expect(input(key)).toHaveAttribute('type', 'password');
      expect(toggleOf(key)).toHaveAccessibleName('Reveal key');
      expect(screen.getByText(key.saved)).toBeInTheDocument();
    }

    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(dataSourceChanges).toBe(0);
    expect(screen.queryByText('Saved')).toBeNull();
    expect(getPreference(TRADIER.pref)).toBe('tr-stored');
    expect(getPreference(FINNHUB.pref)).toBe('fh-stored');
  });

  it.each([TRADIER, FINNHUB])(
    'Pin: the $name key is saved trimmed 800 ms after an edit and removed once emptied, each save flashing Saved and dispatching data-source-changed',
    async (key) => {
      serveModels();
      const other = key === TRADIER ? FINNHUB : TRADIER;
      await openDataTab();

      fireEvent.change(input(key), { target: { value: '  key-123  ' } });
      expect(getPreference(key.pref)).toBeNull();
      expect(dataSourceChanges).toBe(0);

      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(getPreference(key.pref)).toBe('key-123');
      expect(dataSourceChanges).toBe(1);
      expect(within(labelRow(key)).getByText('Saved')).toBeInTheDocument();
      expect(within(labelRow(other)).queryByText('Saved')).toBeNull();
      expect(getPreference(other.pref)).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(screen.queryByText('Saved')).toBeNull();

      fireEvent.change(input(key), { target: { value: '' } });
      expect(getPreference(key.pref)).toBe('key-123');
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(getPreference(key.pref)).toBeNull();
      expect(dataSourceChanges).toBe(2);
    },
  );

  it('Pin: each hint follows its input as typed: saved while it holds a key, else what the key is for or, on Tradier data, the server\'s', async () => {
    serveModels();
    const onClose = vi.fn();
    const { rerender } = await openDataTab(dialog('cboe', onClose));
    expect(screen.getByText(TRADIER.none)).toBeInTheDocument();
    expect(screen.getByText(FINNHUB.none)).toBeInTheDocument();

    for (const dataSource of ['tradier-sandbox', 'mock']) {
      rerender(dialog(dataSource, onClose));
      expect(screen.getByText(TRADIER.none)).toBeInTheDocument();
      expect(screen.queryByText(SERVER_KEY)).toBeNull();
    }
    rerender(dialog('tradier', onClose));
    expect(screen.getByText(SERVER_KEY)).toBeInTheDocument();
    expect(screen.queryByText(TRADIER.none)).toBeNull();
    expect(screen.getByText(FINNHUB.none)).toBeInTheDocument();

    // In the same tick as the edit: the hint reads the input, not the store.
    fireEvent.change(input(TRADIER), { target: { value: 'tr-1' } });
    fireEvent.change(input(FINNHUB), { target: { value: 'fh-1' } });
    expect(screen.getByText(TRADIER.saved)).toBeInTheDocument();
    expect(screen.getByText(FINNHUB.saved)).toBeInTheDocument();
    expect(screen.queryByText(SERVER_KEY)).toBeNull();
    expect(screen.queryByText(FINNHUB.none)).toBeNull();

    // Blank is no key: whitespace as much as nothing.
    fireEvent.change(input(TRADIER), { target: { value: '   ' } });
    fireEvent.change(input(FINNHUB), { target: { value: '' } });
    expect(screen.getByText(SERVER_KEY)).toBeInTheDocument();
    expect(screen.getByText(FINNHUB.none)).toBeInTheDocument();
    expect(screen.queryByText(TRADIER.saved)).toBeNull();
    expect(screen.queryByText(FINNHUB.saved)).toBeNull();
  });

  it('Pin: a key\'s reveal toggle shows while its input holds something, and reveals and hides that key alone', async () => {
    serveModels();
    const { user } = await openDataTab();
    expect(toggleOf(TRADIER)).toBeNull();
    expect(toggleOf(FINNHUB)).toBeNull();

    await user.type(input(TRADIER), 'tr-1');
    expect(input(TRADIER)).toHaveAttribute('type', 'password');
    expect(toggleOf(TRADIER)).toHaveAccessibleName('Reveal key');
    expect(toggleOf(FINNHUB)).toBeNull();
    await user.click(toggleOf(TRADIER));
    expect(input(TRADIER)).toHaveAttribute('type', 'text');
    expect(toggleOf(TRADIER)).toHaveAccessibleName('Hide key');

    await user.type(input(FINNHUB), 'fh-1');
    expect(input(FINNHUB)).toHaveAttribute('type', 'password');
    await user.click(toggleOf(FINNHUB));
    expect(input(FINNHUB)).toHaveAttribute('type', 'text');
    expect(input(TRADIER)).toHaveAttribute('type', 'text');

    await user.click(toggleOf(TRADIER));
    expect(input(TRADIER)).toHaveAttribute('type', 'password');
    expect(toggleOf(TRADIER)).toHaveAccessibleName('Reveal key');
    expect(input(FINNHUB)).toHaveAttribute('type', 'text');

    await user.clear(input(FINNHUB));
    expect(toggleOf(FINNHUB)).toBeNull();
    expect(toggleOf(TRADIER)).toHaveAccessibleName('Reveal key');
  });

  it('Pin: a Finnhub key saved or emptied in the tab reaches a store reader, as App\'s research flag reads it', async () => {
    serveModels();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(withContexts(<><AppSettings isOpen onClose={vi.fn()} /><ResearchFlag /></>));
    // The AI tab's list has landed and its fallback model is stored, so no later write of the dialog's own moves the
    // reader and only the key's save can.
    await screen.findByRole('combobox');
    await user.click(screen.getByRole('button', { name: 'Data' }));
    expect(screen.getByText('research off')).toBeInTheDocument();

    fireEvent.change(input(FINNHUB), { target: { value: 'fh-1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(screen.getByText('research on')).toBeInTheDocument();

    fireEvent.change(input(FINNHUB), { target: { value: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(screen.getByText('research off')).toBeInTheDocument();
  });

  it('Pin: Tradier and Finnhub edits still inside the debounce are stored, trimmed, once the dialog has closed', async () => {
    serveModels();
    const onClosed = vi.fn();
    await openDataTab(withContexts(<Stateful onClosed={onClosed} />));
    fireEvent.change(input(TRADIER), { target: { value: ' tr-closing ' } });
    fireEvent.change(input(FINNHUB), { target: { value: ' fh-closing ' } });
    expect(getPreference(TRADIER.pref)).toBeNull();
    expect(getPreference(FINNHUB.pref)).toBeNull();

    fireEvent.click(screen.getByLabelText('Close settings'));
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Close settings')).toBeNull();
    expect(getPreference(TRADIER.pref)).toBe('tr-closing');
    expect(getPreference(FINNHUB.pref)).toBe('fh-closing');
    expect(dataSourceChanges).toBe(2);
  });

  // Appended after the decomposition: each loaded key is its autosave's baseline from the mount (useAutoSave's third
  // argument), so an edit that ends where it started writes nothing and refetches nothing. Green on the one-file dialog
  // too, which primed the loaded keys in its open effect.
  it('Pin: retyping a stored key writes nothing and dispatches no data-source-changed', async () => {
    serveModels();
    setPreference(TRADIER.pref, 'tr-stored');
    setPreference(FINNHUB.pref, 'fh-stored');
    const { user } = await openDataTab();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockClear();
    await user.type(input(TRADIER), 'x{Backspace}');
    await user.type(input(FINNHUB), 'y{Backspace}');
    expect(input(TRADIER)).toHaveValue('tr-stored');
    expect(input(FINNHUB)).toHaveValue('fh-stored');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(setItem.mock.calls.filter(([key]) => key === TRADIER.pref || key === FINNHUB.pref)).toHaveLength(0);
    expect(dataSourceChanges).toBe(0);
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
