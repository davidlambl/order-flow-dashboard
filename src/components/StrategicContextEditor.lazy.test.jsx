// src/components/StrategicContextEditor.lazy.test.jsx — the strategic context editor around its dialog, which it
// loads on demand (StrategicContextDialog.tsx). Closed, it renders nothing and asks for nothing. Open while the import
// is held, it is a modal of its own over the page, a spinner on a backdrop in the top layer, and once the dialog
// is in it shows the stored text, the dialog's closes saving first as before. A failed import shows the failure card
// in a dialog-shaped box over the backdrop, and Try again loads the dialog. While loading and after a failure, Escape
// and the backdrop close the editor alone: Escape is stopped in the capture phase, so a window listener in the bubble
// phase (the Settings dialog's, under the editor its Backup tab opens) never sees it. The idle preload loads the
// dialog. This file opts out of the setup's preload and holds each test's import with an importGate
// (src/test/lazy.js), so every test starts with the dialog not loaded; every import a test starts is settled before it
// ends, since one still held would keep the next test's import of the module from reaching its gate. Every render is
// under StrictMode, as main.jsx renders the app.
import { StrictMode, useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StrategicContextEditor from './StrategicContextEditor.js';
import { getPreference, setPreference } from '../lib/store.js';
import { scheduleIdlePreload } from '../lib/lazyWithPreload.js';
import { importGate, skipLazyPreload } from '../test/lazy.js';
import { isOpenModal } from '../test/standins.js';

skipLazyPreload();

const OFFLINE = 'Failed to fetch dynamically imported module: /assets/StrategicContextDialog-1a2b3c.js';

let dialog;
beforeEach(() => {
  dialog = importGate();
  vi.doMock('./StrategicContextDialog.js', dialog.factory);
});

const removers = [];
afterEach(() => {
  removers.splice(0).forEach((remove) => remove());
});

/** The editor as its parents hold it: open until its onClose, which also tells the test. */
function Host({ onClosed = () => {} }) {
  const [open, setOpen] = useState(true);
  return (
    <StrictMode>
      <StrategicContextEditor isOpen={open} onClose={() => { setOpen(false); onClosed(); }} />
    </StrictMode>
  );
}

const queryEditor = () => screen.queryByPlaceholderText(/Paste your strategic context/);
const spinner = () => screen.queryByRole('status', { name: 'Loading the strategic context editor' });
/** The full-screen layer a modal sits in, around `el`. */
const layerOf = (el) => el.closest('.fixed');
/** React reports what a boundary catches; the failure tests fail the import on purpose. */
const silenceCaughtErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});
/** Real time for an import asked for to reach its gate: it takes a few event-loop turns, a few milliseconds at most. */
const timeForAnImport = () => act(() => new Promise((resolve) => setTimeout(resolve, 100)));

/** A window keydown listener in the bubble phase, as the Settings dialog's, for the rest of the test. */
function listenAsSettings() {
  const keydown = vi.fn();
  window.addEventListener('keydown', keydown);
  removers.push(() => window.removeEventListener('keydown', keydown));
  return keydown;
}

// First: nothing has loaded the dialog before this test, so its first opening also shows that importing the editor
// does not load it.
it('closed, renders nothing and asks for nothing; the first opening asks for the dialog', async () => {
  const at = (isOpen) => <StrictMode><StrategicContextEditor isOpen={isOpen} onClose={() => {}} /></StrictMode>;
  const { container, rerender } = render(at(false));
  expect(container).toBeEmptyDOMElement();
  expect(document.body.children).toHaveLength(1);
  await timeForAnImport();
  expect(dialog.imports).toBe(0);

  rerender(at(true));
  expect(spinner()).toBeInTheDocument();
  await vi.waitFor(() => expect(dialog.imports).toBe(1));
  await act(() => dialog.resolve());
  expect(queryEditor()).toBeInTheDocument();
});

it('open while the dialog loads: a spinner on a backdrop in the top layer, over the page, none of it in place', async () => {
  const { container } = render(<Host />);
  const loading = spinner();
  expect(loading).toBeInTheDocument();
  const layer = layerOf(loading);
  expect(isOpenModal(layer)).toBe(true);
  expect(layer).toHaveClass('inset-0', 'open:flex', 'items-center', 'justify-center');
  expect(layer.parentElement).toBe(document.body);
  expect(within(layer).getByRole('status').parentElement).toBe(layer);
  expect(layer).toHaveClass('backdrop:bg-black/70', 'backdrop:backdrop-blur-sm');
  expect(container).toBeEmptyDOMElement();
  expect(queryEditor()).toBeNull();
  await vi.waitFor(() => expect(dialog.imports).toBe(1));

  await act(() => dialog.resolve());
  expect(queryEditor()).toBeInTheDocument();
});

it('shows the dialog with the stored text once it is in, in the spinner\'s place, and its Escape saves before onClose', async () => {
  setPreference('strategic_context', 'Long AVGO into earnings');
  const seen = [];
  render(<Host onClosed={() => seen.push(getPreference('strategic_context'))} />);

  await act(() => dialog.resolve());
  expect(queryEditor()).toHaveValue('Long AVGO into earnings');
  expect(spinner()).toBeNull();
  expect(document.querySelectorAll('dialog')).toHaveLength(1);

  fireEvent.change(queryEditor(), { target: { value: 'Trim 10% above 400' } });
  fireEvent.keyDown(queryEditor(), { key: 'Escape' });
  expect(seen).toEqual(['Trim 10% above 400']);
  expect(queryEditor()).toBeNull();
});

describe.each([
  ['while the dialog loads', {
    reach: async () => {},
    // The import is still held: it lands after the close, and shows nothing.
    land: () => act(() => dialog.resolve()),
  }],
  ['after the dialog failed to load', {
    reach: async () => {
      silenceCaughtErrors();
      await act(() => dialog.reject(new TypeError(OFFLINE)));
      expect(screen.getByRole('alert')).toBeInTheDocument();
    },
    land: async () => {},
  }],
])('%s', (_, { reach, land }) => {
  it('Escape closes the editor alone: stopped in the capture phase, a window listener in the bubble phase never sees it', async () => {
    const settingsKeydown = listenAsSettings();
    const onClosed = vi.fn();
    render(<Host onClosed={onClosed} />);
    await reach();

    fireEvent.keyDown(document.body, { key: 'a' }); // any other key is not the editor's
    expect(settingsKeydown).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(false); // its default prevented
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(settingsKeydown).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.fixed')).toBeNull();

    fireEvent.keyDown(document.body, { key: 'Escape' }); // with the editor gone, the next Escape is the dialog's
    expect(settingsKeydown).toHaveBeenCalledTimes(2);
    expect(onClosed).toHaveBeenCalledTimes(1);

    await land();
    expect(document.querySelector('.fixed')).toBeNull();
  });

  it('a click on the backdrop closes the editor', async () => {
    const onClosed = vi.fn();
    render(<Host onClosed={onClosed} />);
    await reach();

    const layer = screen.getByRole('dialog', { name: 'Strategic Context' });
    fireEvent.pointerDown(layer);
    fireEvent.pointerUp(layer);
    fireEvent.click(layer);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.fixed')).toBeNull();

    await land();
    expect(document.querySelector('.fixed')).toBeNull();
  });
});

describe('a failed import', () => {
  it('shows the failure card in a box over the backdrop; Try again loads the dialog', async () => {
    silenceCaughtErrors();
    setPreference('strategic_context', 'Stored notes');
    const { container } = render(<Host />);

    await act(() => dialog.reject(new TypeError(OFFLINE)));
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('This part of the dashboard could not load.');
    expect(within(card).getAllByRole('button').map((button) => button.textContent)).toEqual(['Try again', 'Reload']);
    const box = card.parentElement;
    expect(box).toHaveClass('relative', 'max-w-sm', 'shadow-2xl');
    const layer = layerOf(card);
    expect(isOpenModal(layer)).toBe(true);
    expect(layer).toHaveClass('inset-0');
    expect(layer.parentElement).toBe(document.body);
    expect(box.parentElement).toBe(layer);
    expect(layer).toHaveClass('backdrop:bg-black/70', 'backdrop:backdrop-blur-sm');
    expect(container).toBeEmptyDOMElement();
    expect(spinner()).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(spinner()).toBeInTheDocument();
    await act(() => dialog.resolve());
    expect(queryEditor()).toHaveValue('Stored notes');
    expect(dialog.imports).toBe(2);
  });

  it('Reload reloads the page, for a tab whose old files a deploy removed', async () => {
    silenceCaughtErrors();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<Host />);
    await act(() => dialog.reject(new TypeError(OFFLINE)));

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dialog.imports).toBe(1);
  });
});

it('the idle preload loads the dialog, so the first opening shows it at once', async () => {
  const idle = [];
  scheduleIdlePreload({
    requestIdleCallback: (run) => idle.push(run),
    cancelIdleCallback: () => {},
    setTimeout,
    clearTimeout,
    navigator: {},
  });
  expect(idle).toHaveLength(1);

  idle[0]();
  await vi.waitFor(() => expect(dialog.imports).toBe(1));
  await act(() => dialog.resolve());
  render(<Host />);

  expect(queryEditor()).toBeInTheDocument();
  expect(spinner()).toBeNull();
  expect(dialog.imports).toBe(1);
});
