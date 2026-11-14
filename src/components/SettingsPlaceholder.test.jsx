// src/components/SettingsPlaceholder.test.jsx — what stands in for the Settings dialog while its chunk loads and after
// it failed to, as a modal dialog. Opened from a button in a host that unmounts it from onClose, as App does, under
// StrictMode: while the import is held the stand-in is a modal dialog named "Settings" holding focus itself, and axe
// finds nothing in it; once the import lands the dialog takes its place, open, with focus on its selected tab, and
// closing it puts focus back on the button. A failed import leaves the stand-in with the failure card, still a named
// modal dialog holding focus, and axe finds nothing there either. The file opts out of the setup's preload and holds
// each test's import with an importGate (src/test/lazy.js); every import a test starts is answered before it ends,
// and a failed test's after it.
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import AppSettings from './AppSettings.js';
import { importGate, skipLazyPreload } from '../test/lazy.js';
import { server } from '../test/setup.js';
import { withContexts } from '../test/contexts.jsx';
import { expectNoAxeViolations } from '../test/a11y.js';

skipLazyPreload();

const FN = 'http://localhost:3000/.netlify/functions';
const OFFLINE = 'Failed to fetch dynamically imported module: /assets/SettingsDialog-1a2b3c.js';

let gate;
beforeEach(() => {
  gate = importGate();
  vi.doMock('./settings/SettingsDialog.js', gate.factory);
  server.use(http.get(`${FN}/getModels`, () => HttpResponse.json({
    models: [{ id: 'claude-a', name: 'Claude A', provider: 'anthropic' }], provider: 'anthropic', requestId: 'r1',
  })));
});

/** Real time for an import asked for to reach its gate: a few event-loop turns. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 100));

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return;
  cleanup();
  void gate.resolve();
  await quiet();
});

/** App's shape around the dialog: a button that opens it, and an onClose that unmounts it. */
function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <AppSettings isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Renders the host, focuses its button and clicks it; returns the button. */
function openSettings() {
  render(<StrictMode>{withContexts(<Host />)}</StrictMode>);
  const opener = screen.getByRole('button', { name: 'Open settings' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

const settings = () => screen.getByRole('dialog', { name: 'Settings' });

describe('while the chunk loads', () => {
  it('stands in as a modal dialog named Settings holding focus, then the dialog takes its place; closing returns focus', async () => {
    const opener = openSettings();
    const standIn = settings();
    expect(standIn).toBeInstanceOf(HTMLDialogElement);
    expect(standIn.open).toBe(true);
    expect(standIn).toHaveFocus();
    expect(within(standIn).getByRole('status')).toHaveTextContent('Loading…');
    await expectNoAxeViolations(document.body, { bestPractices: true });

    await vi.waitFor(() => expect(gate.imports).toBe(1));
    await act(() => gate.resolve());
    const dialog = settings();
    expect(dialog).not.toBe(standIn);
    expect(dialog.open).toBe(true);
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveFocus();
    await screen.findByRole('combobox');

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe('a chunk that failed to load', () => {
  it('leaves the failure card in a modal dialog named Settings holding focus; Escape returns focus', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const opener = openSettings();
    await vi.waitFor(() => expect(gate.imports).toBe(1));
    await act(() => gate.reject(new TypeError(OFFLINE)));

    const standIn = settings();
    expect(standIn).toBeInstanceOf(HTMLDialogElement);
    expect(standIn.open).toBe(true);
    expect(within(standIn).getByRole('alert')).toBeInTheDocument();
    expect(standIn).toHaveFocus();
    await expectNoAxeViolations(document.body, { bestPractices: true });

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});
