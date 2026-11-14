// src/components/settings/SettingsDialog.test.jsx — the Settings dialog as a modal dialog over a tab list, through
// AppSettings in a host that opens it from a button and unmounts it from onClose, as App does, under StrictMode as
// main.jsx renders the app (its effects run twice on mount: the second showModal() must not throw, and focus must
// still return to the button). It opens modally, named by its heading, with focus on the selected tab; each way out
// (Escape at the focused element, the close button, a press outside the panel) puts focus back on the button that
// opened it. The tab bar is a tab list: the selected tab alone in the tab order, every tab naming the one panel, which
// its selected tab labels; Left and Right move to and select the neighbouring tab, wrapping, Home and End the first and
// the last, and an arrow-key switch stores a key edit still in its 800 ms debounce, as a click does, because the tab
// left unmounts. The strategic context editor opened from the Backup tab returns focus to its button inside Settings,
// and Escape there closes the editor alone. axe runs once per tab shown, on the whole body (its `region` rule judges
// only from there), the AI tab excepted: its model select gets its name in another commit of this branch.
// Every test answers getModels, which the AI tab requests as the dialog opens, and waits for the list before it moves
// on. The tests named "Pin:" pass on the dialog before it became a modal dialog; the others were red there.
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import AppSettings from '../AppSettings.js';
import { server } from '../../test/setup.js';
import { withContexts } from '../../test/contexts.jsx';
import { expectNoAxeViolations } from '../../test/a11y.js';

const FN = 'http://localhost:3000/.netlify/functions';
const MODELS = [
  { id: 'claude-a', name: 'Claude A', provider: 'anthropic' },
  { id: 'claude-b', name: 'Claude B', provider: 'anthropic' },
];

const serveModels = () => server.use(http.get(`${FN}/getModels`, () => (
  HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' })
)));

const TABS = ['AI', 'Data', 'Account', 'Backup'];

/** A field or a button that only that tab shows (on the free tier, with no provider chosen). */
const ONLY_IN = {
  AI: () => screen.queryByPlaceholderText('sk-ant-...'),
  Data: () => screen.queryByPlaceholderText('Paste for real-time data...'),
  Account: () => screen.queryByPlaceholderText('Paste access token...'),
  Backup: () => screen.queryByRole('button', { name: 'Reset all settings' }),
};

/** The tabs whose content is on screen. */
const shownTabs = () => TABS.filter((name) => ONLY_IN[name]() !== null);

/** A preference as the store keeps it (JSON in localStorage); null while there is none. */
const stored = (name) => JSON.parse(localStorage.getItem(name));

/** Types into a key field in one synchronous change, which starts its 800 ms debounce. */
const typeKey = (placeholder, value) => {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
};

/** App's shape around the dialog: a button that opens it, and an onClose that unmounts it. */
function Host({ onClosed }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <AppSettings isOpen={open} onClose={() => { setOpen(false); onClosed(); }} />
    </>
  );
}

/**
 * Renders the host, focuses its button and clicks it, as a keyboard or a mouse does, then waits for the AI tab's
 * model list; returns the button and the onClose spy.
 */
async function openSettings() {
  const onClosed = vi.fn();
  render(<StrictMode>{withContexts(<Host onClosed={onClosed} />)}</StrictMode>);
  const opener = screen.getByRole('button', { name: 'Open settings' });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole('combobox');
  return { opener, onClosed };
}

const settings = () => screen.getByRole('dialog', { name: 'Settings' });
const tab = (name) => screen.getByRole('tab', { name });

/** A press outside the panel: down, up and click on the dialog element itself, where ::backdrop clicks land. */
function pressOutside(dialog) {
  fireEvent.pointerDown(dialog);
  fireEvent.pointerUp(dialog);
  fireEvent.click(dialog);
}

let showModal;
beforeEach(() => {
  serveModels();
  showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Settings dialog', () => {
  it('opens modally, named by its heading, with focus on its selected tab', async () => {
    await openSettings();
    const dialog = settings();
    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect(dialog.open).toBe(true);
    expect(showModal.mock.contexts).toContain(dialog);
    expect(dialog).toHaveAttribute('aria-labelledby', screen.getByRole('heading', { name: 'Settings' }).id);
    expect(tab('AI')).toHaveFocus();
  });

  it.each([
    ['Escape at the focused element', () => fireEvent.keyDown(document.activeElement, { key: 'Escape' })],
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))],
    ['a press outside the panel', () => pressOutside(settings())],
  ])('closing it with %s puts focus back on the button that opened it', async (_, close) => {
    const { opener, onClosed } = await openSettings();
    expect(settings()).toContainElement(document.activeElement);

    close();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe('the tab bar', () => {
  it('is a named tab list whose selected tab alone is in the tab order and labels the one panel every tab controls', async () => {
    await openSettings();
    const list = screen.getByRole('tablist', { name: 'Settings sections' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(TABS);

    const panel = screen.getByRole('tabpanel', { name: 'AI' });
    expect(panel).toContainElement(ONLY_IN.AI());
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(tabs.map((t) => t.getAttribute('aria-controls'))).toEqual(TABS.map(() => panel.id));

    fireEvent.click(tab('Data'));
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(screen.getByRole('tabpanel', { name: 'Data' })).toContainElement(ONLY_IN.Data());
    // jsdom has no layout: whether the row fits at 375 px is measured in a browser. This class lets it scroll.
    expect(list).toHaveClass('overflow-x-auto');
  });

  it('Right and Left select and focus the neighbouring tab, wrapping; Home and End the first and the last', async () => {
    await openSettings();
    const press = (key) => fireEvent.keyDown(document.activeElement, { key });
    const at = (name) => {
      expect(tab(name)).toHaveFocus();
      expect(tab(name)).toHaveAttribute('aria-selected', 'true');
      expect(shownTabs()).toEqual([name]);
    };

    press('ArrowRight');
    at('Data');
    press('ArrowRight');
    at('Account');
    press('ArrowLeft');
    at('Data');
    press('End');
    at('Backup');
    press('ArrowRight');
    at('AI');
    press('ArrowLeft');
    at('Backup');
    press('Home');
    at('AI');

    // Other keys are not the tab list's: nothing moves.
    press('ArrowDown');
    press('a');
    at('AI');
  });

  it('an arrow-key switch stores a key edit still pending on the tab it leaves', async () => {
    await openSettings();
    typeKey('sk-ant-...', 'sk-ant-typed');
    expect(stored('ai_key_anthropic')).toBeNull();

    fireEvent.keyDown(tab('AI'), { key: 'ArrowRight' });
    expect(shownTabs()).toEqual(['Data']);
    expect(stored('ai_key_anthropic')).toBe('sk-ant-typed');

    typeKey('Paste for real-time data...', 'tradier-typed');
    expect(stored('data_tradier_key')).toBeNull();
    fireEvent.keyDown(tab('Data'), { key: 'End' });
    expect(shownTabs()).toEqual(['Backup']);
    expect(stored('data_tradier_key')).toBe('tradier-typed');
  });

  // Found by their text, so the same lookup finds the tab buttons before they had the tab role.
  it('Pin: one tab is mounted at a time, and a key edit still pending on the tab a click leaves is in the store', async () => {
    await openSettings();
    const tabButton = (name) => screen.getByText(name, { selector: 'button' });
    expect(shownTabs()).toEqual(['AI']);
    typeKey('sk-ant-...', 'sk-ant-typed');
    expect(stored('ai_key_anthropic')).toBeNull();

    fireEvent.click(tabButton('Data'));
    expect(shownTabs()).toEqual(['Data']);
    expect(stored('ai_key_anthropic')).toBe('sk-ant-typed');

    typeKey('Paste for news, earnings, analyst data...', 'finnhub-typed');
    fireEvent.click(tabButton('Account'));
    expect(shownTabs()).toEqual(['Account']);
    expect(stored('data_finnhub_key')).toBe('finnhub-typed');
  });

  it.each([
    ['Data', []],
    ['Account', []],
    ['Backup', []],
  ])('has no axe violations with the %s tab shown', async (name, disable) => {
    await openSettings();
    fireEvent.click(screen.getByText(name, { selector: 'button' }));
    expect(shownTabs()).toEqual([name]);
    await expectNoAxeViolations(document.body, { bestPractices: true, disable });
  });
});

describe('the strategic context editor over Settings', () => {
  /** Opens Settings, shows the Backup tab and opens the editor from its button; returns that button. */
  async function openEditor() {
    await openSettings();
    fireEvent.click(screen.getByText('Backup', { selector: 'button' }));
    const add = screen.getByRole('button', { name: 'Add strategic context for the AI Co-Pilot' });
    add.focus();
    fireEvent.click(add);
    expect(await screen.findByPlaceholderText(/Paste your strategic context/)).toBeInTheDocument();
    return add;
  }

  it('Pin: Escape at the focused element closes the editor alone; the next Escape closes Settings', async () => {
    await openEditor();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/Paste your strategic context/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset all settings' })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  });

  it('closing the editor puts focus back on the Backup tab button that opened it, Settings still open', async () => {
    const add = await openEditor();
    const editor = screen.getByRole('dialog', { name: 'Strategic Context' });
    expect(editor).toContainElement(document.activeElement);

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Strategic Context' })).toBeNull();
    expect(settings().open).toBe(true);
    expect(add).toHaveFocus();
  });
});
