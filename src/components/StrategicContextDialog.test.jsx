// src/components/StrategicContextDialog.test.jsx — the strategic context editor's dialog as a modal dialog, through
// StrategicContextEditor in a host that opens it from a button and unmounts it from onClose, as the chat and the Backup
// tab do, under StrictMode as main.jsx renders the app. It opens modally, named by its heading, with focus already in
// its textarea (no animation frame to wait for), which the heading names too; each way out (the close button, Escape in
// the textarea, a press outside the panel) puts focus back on the button that opened it; a press that starts in the
// text and ends outside the panel (a selection dragged past its edge) leaves it open, as it did when the backdrop was
// an element of its own; axe finds nothing. The dialog is loaded here (the setup preloads every lazy): its stand-in
// while it loads is StrategicContextEditor.dialog.test.jsx's. The test named "Pin:" passes on the editor before it
// became a modal dialog; the others were red there.
import { StrictMode, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import StrategicContextEditor from './StrategicContextEditor.js';
import { expectLabelledControls, expectNoAxeViolations } from '../test/a11y.js';

/** The editor as the chat and the Backup tab hold it: a button opens it, onClose unmounts it. */
function Host({ onClosed }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Edit strategic context</button>
      <StrategicContextEditor isOpen={open} onClose={() => { setOpen(false); onClosed(); }} />
    </>
  );
}

/** Renders the host, focuses its button and clicks it; returns the button and the onClose spy. */
function openEditor() {
  const onClosed = vi.fn();
  render(<StrictMode><Host onClosed={onClosed} /></StrictMode>);
  const opener = screen.getByRole('button', { name: 'Edit strategic context' });
  opener.focus();
  fireEvent.click(opener);
  return { opener, onClosed };
}

const editorDialog = () => screen.getByRole('dialog', { name: 'Strategic Context' });
const textarea = () => screen.getByPlaceholderText(/Paste your strategic context/);
const queryTextarea = () => screen.queryByPlaceholderText(/Paste your strategic context/);

/** A press outside the panel: down, up and click on the dialog element itself, where ::backdrop clicks land. */
function pressOutside(dialog) {
  fireEvent.pointerDown(dialog);
  fireEvent.pointerUp(dialog);
  fireEvent.click(dialog);
}

let showModal;
beforeEach(() => {
  showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
});

describe('the strategic context editor', () => {
  it('opens modally, named by its heading, with focus in its textarea, which the heading names too', () => {
    openEditor();
    const dialog = editorDialog();
    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect(dialog.open).toBe(true);
    expect(showModal.mock.contexts).toContain(dialog);
    expect(textarea()).toHaveFocus();
    expect(textarea()).toHaveAccessibleName('Strategic Context');
    expectLabelledControls(dialog);
  });

  it.each([
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close strategic context editor' }))],
    ['Escape in the textarea', () => fireEvent.keyDown(textarea(), { key: 'Escape' })],
    ['a press outside the panel', () => pressOutside(editorDialog())],
  ])('closing it with %s puts focus back on the button that opened it', (_, close) => {
    const { opener, onClosed } = openEditor();
    expect(editorDialog()).toContainElement(document.activeElement);

    close();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(queryTextarea()).toBeNull();
    expect(opener).toHaveFocus();
  });

  // The layer is the element a click outside the panel lands on: the backdrop's parent before, the dialog now. A press
  // that starts in the text and ends there makes a click on that layer, which must not close the editor.
  it('Pin: a press that starts in the text and ends outside the panel leaves it open', () => {
    const { onClosed } = openEditor();
    const layer = textarea().closest('dialog, .fixed');
    fireEvent.pointerDown(textarea());
    fireEvent.mouseDown(textarea());
    fireEvent.pointerUp(layer);
    fireEvent.mouseUp(layer);
    fireEvent.click(layer);
    expect(onClosed).not.toHaveBeenCalled();
    expect(textarea()).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    openEditor();
    await expectNoAxeViolations(document.body, { bestPractices: true });
  });
});
