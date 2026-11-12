// src/components/StrategicContextEditor.dialog.test.jsx — what stands in for the strategic context editor's dialog
// while its chunk loads and after it failed to, as a modal dialog. Opened from a button in a host that unmounts it from
// onClose, under StrictMode: while the import is held the stand-in is a modal dialog named "Strategic Context" that
// holds focus (nothing in it can take focus but the dialog itself), and axe finds nothing in it; once the import lands
// the loaded dialog takes its place with focus in its textarea, and closing it puts focus back on the button. A failed
// import leaves the stand-in with the failure card, still a named modal dialog holding focus, and axe finds nothing.
// The file opts out of the setup's preload and holds each test's import with an importGate (src/test/lazy.js); every
// import a test starts is answered before it ends, and a failed test's after it.
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StrategicContextEditor from './StrategicContextEditor.js';
import { importGate, skipLazyPreload } from '../test/lazy.js';
import { expectNoAxeViolations } from '../test/a11y.js';

skipLazyPreload();

const OFFLINE = 'Failed to fetch dynamically imported module: /assets/StrategicContextDialog-1a2b3c.js';

let gate;
beforeEach(() => {
  gate = importGate();
  vi.doMock('./StrategicContextDialog.js', gate.factory);
});

/** Real time for an import asked for to reach its gate: a few event-loop turns. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 100));

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return;
  cleanup();
  void gate.resolve();
  await quiet();
});

/** The editor as the chat and the Backup tab hold it: a button opens it, onClose unmounts it. */
function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Edit strategic context</button>
      <StrategicContextEditor isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Renders the host, focuses its button and clicks it; returns the button. */
function openEditor() {
  render(<StrictMode><Host /></StrictMode>);
  const opener = screen.getByRole('button', { name: 'Edit strategic context' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

const editorDialog = () => screen.getByRole('dialog', { name: 'Strategic Context' });
const textarea = () => screen.queryByPlaceholderText(/Paste your strategic context/);

describe('while the dialog loads', () => {
  it('stands in as a modal dialog named Strategic Context holding focus, then the dialog takes its place; closing returns focus', async () => {
    const opener = openEditor();
    const standIn = editorDialog();
    expect(standIn).toBeInstanceOf(HTMLDialogElement);
    expect(standIn.open).toBe(true);
    expect(standIn).toHaveFocus();
    expect(within(standIn).getByRole('status', { name: 'Loading the strategic context editor' })).toBeInTheDocument();
    await expectNoAxeViolations(document.body, { bestPractices: true });

    await vi.waitFor(() => expect(gate.imports).toBe(1));
    await act(() => gate.resolve());
    const dialog = editorDialog();
    expect(dialog).not.toBe(standIn);
    expect(dialog.open).toBe(true);
    expect(textarea()).toHaveFocus();

    fireEvent.keyDown(textarea(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe('a dialog that failed to load', () => {
  it('leaves the failure card in a modal dialog named Strategic Context holding focus; Escape returns focus', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const opener = openEditor();
    await vi.waitFor(() => expect(gate.imports).toBe(1));
    await act(() => gate.reject(new TypeError(OFFLINE)));

    const standIn = editorDialog();
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
