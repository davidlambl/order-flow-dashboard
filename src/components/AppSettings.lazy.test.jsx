// src/components/AppSettings.lazy.test.jsx — the Settings dialog loaded on demand. Closed, AppSettings renders nothing
// and asks for nothing; the first open asks for the chunk. While it loads, SettingsPlaceholder stands in (the heading,
// the close button and a spinner where the tabs go) and closes as the dialog does, on Escape, the backdrop or the
// button, but not on an Escape that a capture-phase listener stopped, as the strategic context editor stops its own.
// The dialog then takes its place in the same frame, on the AI tab; a reopen shows it at once, and a close still
// unmounts it and saves a pending key edit. The idle preload brings it in before the first open. A failed chunk shows
// ChunkBoundary's failure card (the same markup) in the stand-in's body: the stand-in still closes, and asks for
// nothing once closed; Try again and the next open import again; Reload reloads.
// The file opts out of the setup's preload and holds each test's import of the dialog with an importGate
// (src/test/lazy.js), so every test starts with nothing loaded; AppSettings.test.jsx and the pin files of settings/ see
// the dialog loaded, as the setup leaves it. Every import a test asks for is answered before it ends: one left held
// would stay pending in the module loader, and the next test's import of the dialog would wait on it instead of
// reaching that test's gate. A test that fails before it answers has its import answered after it, so that only the
// failing test reports.
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import AppSettings from './AppSettings.js';
import ChunkBoundary from './ChunkBoundary.js';
import { ChunkLoadError, scheduleIdlePreload } from '../lib/lazyWithPreload.js';
import { importGate, skipLazyPreload } from '../test/lazy.js';
import { server } from '../test/setup.js';
import { withContexts } from '../test/contexts.jsx';

skipLazyPreload();

const FN = 'http://localhost:3000/.netlify/functions';
const MODELS = [
  { id: 'claude-a', name: 'Claude A', provider: 'anthropic' },
  { id: 'claude-b', name: 'Claude B', provider: 'anthropic' },
];

/** getModels, which the AI tab asks for as the dialog mounts: every test that shows the dialog serves it. */
const serveModels = () => server.use(http.get(`${FN}/getModels`, () => (
  HttpResponse.json({ models: MODELS, provider: 'anthropic', requestId: 'r1' })
)));

const OFFLINE = 'Failed to fetch dynamically imported module: /assets/SettingsDialog-1a2b3c.js';
const TABS = ['AI', 'Data', 'Account', 'Backup'];

let dialog;
beforeEach(() => {
  dialog = importGate();
  vi.doMock('./settings/SettingsDialog.js', dialog.factory);
});

/** AppSettings under both contexts, as App renders it. */
const settings = (isOpen, onClose = vi.fn()) => withContexts(<AppSettings isOpen={isOpen} onClose={onClose} />);

/** App's shape: onClose flips the isOpen it passes down, so a close unmounts whatever AppSettings rendered. */
function Stateful({ onClosed }) {
  const [open, setOpen] = useState(true);
  return <AppSettings isOpen={open} onClose={() => { setOpen(false); onClosed(); }} />;
}

/** The stand-in's loading line, or null once the dialog or the failure card has taken its place. */
const loading = () => screen.queryByRole('status');

/** The tab bar's labels, in document order: the dialog's own, which the stand-in has none of. */
const tabBar = () => screen.queryAllByRole('button')
  .map((button) => button.textContent)
  .filter((label) => TABS.includes(label));

/** The frame around whatever is open, the stand-in or the dialog: the parts that must not move between them. */
function frame() {
  const heading = screen.getByRole('heading', { name: 'Settings' });
  const container = heading.closest('div.fixed');
  const [backdrop, panel] = container.children;
  const header = panel.firstElementChild;
  const [titleRow, tabLine] = header.children;
  return {
    container: container.className,
    backdrop: backdrop.className,
    panel: panel.className,
    header: header.className,
    titleRow: titleRow.outerHTML,
    tabLine: tabLine.className,
  };
}

/** The open frame's panel: the box the failure card must sit in. */
const panel = () => screen.getByRole('heading', { name: 'Settings' }).closest('div.fixed').children[1];

/** A preference as the store keeps it (JSON in localStorage); null while there is none. */
const stored = (name) => JSON.parse(localStorage.getItem(name));

/** React reports what a boundary catches with console.error; the failure tests fail an import on purpose. */
const silenceCaughtErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});

/**
 * An import asked for reaches the gate within a turn or two of the event loop; this waits far longer, so an import a
 * render asked for shows in dialog.imports afterwards. It proves an absence, so it can let a request through under
 * heavy load, never fail a correct tree.
 */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 100));

/** Unmounts the tree, then answers the import its open asked for (see the header). */
async function answerHeld(view) {
  view.unmount();
  await act(() => dialog.resolve());
}

// A failed test may leave the lazy's one outstanding import held at the gate or still on its way there: once the tree
// is gone it is answered, now or as it arrives (gate.resolve answers the next import either way), and given time to
// arrive.
afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return;
  cleanup();
  void dialog.resolve();
  await quiet();
});

/** The three ways out of the dialog, each of which the stand-in offers too. */
const WAYS_OUT = [
  ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
  ['the backdrop', () => fireEvent.click(document.querySelector('.backdrop-blur-sm'))],
  ['"Close settings"', () => fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))],
];

describe('closed', () => {
  it('renders nothing and asks for nothing; the first open asks for the chunk, once', async () => {
    const view = render(settings(false));
    expect(view.container).toBeEmptyDOMElement();
    await quiet();
    expect(dialog.imports).toBe(0);

    view.rerender(settings(true));
    expect(loading()).toBeInTheDocument();
    await waitFor(() => expect(dialog.imports).toBe(1));
    await quiet();
    expect(dialog.imports).toBe(1);
    await answerHeld(view);
  });
});

describe('while the chunk loads', () => {
  it('stands in at once with the heading, the close button and a spinner where the tabs go', async () => {
    const view = render(settings(true));

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeInTheDocument();
    expect(loading()).toHaveTextContent('Loading…');
    expect(tabBar()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    await answerHeld(view);
  });

  it.each(WAYS_OUT)('%s closes the stand-in, calling onClose once', async (_, close) => {
    const onClosed = vi.fn();
    const view = render(withContexts(<Stateful onClosed={onClosed} />));
    expect(loading()).toBeInTheDocument();

    close();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(view.container).toBeEmptyDOMElement();
    await answerHeld(view);
  });

  // The strategic context editor listens on window in the capture phase and stops the Escape that closes it; the
  // stand-in listens in the bubble phase, as the dialog does, so that Escape never reaches it.
  it('stays open on an Escape that a capture-phase listener on window stopped; the next Escape closes it', async () => {
    const onClosed = vi.fn();
    const view = render(withContexts(<Stateful onClosed={onClosed} />));
    const stopEscape = (e) => {
      if (e.key === 'Escape') e.stopPropagation();
    };
    window.addEventListener('keydown', stopEscape, true);
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', stopEscape, true);
    }
    expect(onClosed).not.toHaveBeenCalled();
    expect(loading()).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(view.container).toBeEmptyDOMElement();
    await answerHeld(view);
  });
});

describe('once the chunk is in', () => {
  it('the dialog takes the stand-in\'s place in the same frame, open on the AI tab', async () => {
    serveModels();
    render(settings(true));
    const standIn = frame();

    await act(() => dialog.resolve());
    expect(loading()).toBeNull();
    expect(screen.getAllByRole('heading', { name: 'Settings' })).toHaveLength(1);
    expect(tabBar()).toEqual(TABS);
    expect(screen.getByPlaceholderText('sk-ant-...')).toBeInTheDocument();
    expect(frame()).toEqual(standIn);
    await screen.findByRole('combobox');
  });

  it('a reopen shows the dialog at once, with no stand-in and no second import', async () => {
    serveModels();
    const view = render(settings(true));
    await act(() => dialog.resolve());
    await screen.findByRole('combobox');

    view.rerender(settings(false));
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(settings(true));
    expect(loading()).toBeNull();
    expect(tabBar()).toEqual(TABS);
    await screen.findByRole('combobox');
    expect(dialog.imports).toBe(1);
  });

  // A first open before the idle preload mounts the dialog through the pending import: a close must still unmount it,
  // which is what saves a tab's edits (SettingsDialog's header).
  it('a close still unmounts the dialog, and a key edit pending in its debounce is in the store once it has closed', async () => {
    serveModels();
    const onClosed = vi.fn();
    const view = render(withContexts(<Stateful onClosed={onClosed} />));
    await act(() => dialog.resolve());
    await screen.findByRole('combobox');
    fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), { target: { value: 'sk-ant-typed' } });
    expect(stored('ai_key_anthropic')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(view.container).toBeEmptyDOMElement();
    expect(stored('ai_key_anthropic')).toBe('sk-ant-typed');
  });

  it('the idle preload brings the chunk in before the first open, which then shows the dialog at once', async () => {
    serveModels();
    let whenIdle = () => {};
    scheduleIdlePreload({
      requestIdleCallback: (run) => {
        whenIdle = run;
        return 1;
      },
      cancelIdleCallback: () => {},
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle),
      navigator: {},
    });

    whenIdle();
    await waitFor(() => expect(dialog.imports).toBe(1));
    await act(() => dialog.resolve());
    render(settings(true));

    expect(loading()).toBeNull();
    expect(tabBar()).toEqual(TABS);
    await screen.findByRole('combobox');
    expect(dialog.imports).toBe(1);
  });
});

describe('a chunk that failed to load', () => {
  it('shows the failure card in the stand-in\'s body; Try again imports again and the dialog fills the frame', async () => {
    silenceCaughtErrors();
    serveModels();
    const onClose = vi.fn();
    render(settings(true, onClose));

    await act(() => dialog.reject(new TypeError(OFFLINE)));
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('This part of the dashboard could not load.');
    expect(within(card).getAllByRole('button').map((button) => button.textContent)).toEqual(['Try again', 'Reload']);
    expect(panel()).toContainElement(card);
    expect(loading()).toBeNull();
    expect(tabBar()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(loading()).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(() => dialog.resolve());
    expect(tabBar()).toEqual(TABS);
    expect(dialog.imports).toBe(2);
    await screen.findByRole('combobox');
  });

  it.each(WAYS_OUT)('%s still closes the stand-in, calling onClose once, and the close asks for nothing', async (_, close) => {
    silenceCaughtErrors();
    const onClosed = vi.fn();
    const view = render(withContexts(<Stateful onClosed={onClosed} />));
    await act(() => dialog.reject(new TypeError(OFFLINE)));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    close();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(view.container).toBeEmptyDOMElement();
    // The failure is forgotten once shown, so the next open imports again; a closed AppSettings still must not.
    await quiet();
    expect(dialog.imports).toBe(1);
  });

  it('Reload reloads the page, for a tab whose old files a deploy removed', async () => {
    silenceCaughtErrors();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(settings(true));
    await act(() => dialog.reject(new TypeError(OFFLINE)));

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(dialog.imports).toBe(1);
  });

  // The stand-in writes the card out again (its header says why): this keeps the two copies alike.
  it('the card is ChunkBoundary\'s own failure card, word for word and class for class', async () => {
    silenceCaughtErrors();
    function Offline() {
      throw new ChunkLoadError(new TypeError(OFFLINE));
    }
    const boundary = render(<ChunkBoundary fallback={null}><Offline /></ChunkBoundary>);
    const boundaryCard = screen.getByRole('alert').outerHTML;
    boundary.unmount();

    render(settings(true));
    await act(() => dialog.reject(new TypeError(OFFLINE)));
    expect(screen.getByRole('alert').outerHTML).toBe(boundaryCard);
  });

  it('closed after the failure, the next open imports again and shows the dialog', async () => {
    silenceCaughtErrors();
    serveModels();
    const view = render(settings(true));
    await act(() => dialog.reject(new TypeError(OFFLINE)));
    view.rerender(settings(false));
    expect(view.container).toBeEmptyDOMElement();

    view.rerender(settings(true));
    expect(loading()).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(() => dialog.resolve());
    expect(tabBar()).toEqual(TABS);
    expect(dialog.imports).toBe(2);
    await screen.findByRole('combobox');
  });
});
