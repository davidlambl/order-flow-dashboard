// src/components/SyncChoice.test.jsx — the sync choice as a modal dialog that nothing but a choice closes. In a host
// that holds the conflict as App does (a choice clears it, which unmounts the dialog), under StrictMode: it opens
// modally, named by its heading and described by its sentence, with focus on the recommended choice. Escape (the
// browser's `cancel`, prevented) and a press outside leave it open; a close the browser forces anyway (Chromium's
// second Escape without a user activation in between, whose `cancel` cannot be prevented, or any other close()) is
// undone once its `close` event has been handled, with focus back inside; `closedby="none"` asks the browsers that
// support it not to try. A choice unmounts it for good: its own close is not undone. The test named "Pin:" passes on
// the dialog before it became a native modal dialog; the others were red there.
import { StrictMode, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SyncChoice from './SyncChoice.jsx';
import { requestDialogClose } from '../test/standins.js';
import { expectNoAxeViolations } from '../test/a11y.js';

const REPORT = { local: { positions: 1, chats: 0, prefs: 0 }, cloud: { positions: 2, chats: 0, prefs: 3 } };

/** App's shape: the conflict until a choice is made, then nothing. */
function Host({ onChoose }) {
  const [conflict, setConflict] = useState(REPORT);
  return (
    <>
      <button type="button">Behind</button>
      {conflict && (
        <SyncChoice report={conflict} busy={false} onChoose={(choice) => { onChoose(choice); setConflict(null); }} />
      )}
    </>
  );
}

function renderChoice() {
  const onChoose = vi.fn();
  render(<StrictMode><Host onChoose={onChoose} /></StrictMode>);
  return { onChoose, dialog: screen.getByRole('dialog', { name: 'Sync your data' }) };
}

const merge = () => screen.getByRole('button', { name: /^Merge/ });

/** Lets the `close` event (queued after a close()) be handled, and what it set off render. */
const closeEventHandled = () => act(async () => {});

let showModal;
beforeEach(() => {
  showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
});

describe('SyncChoice', () => {
  it('opens modally, named by its heading and described by its sentence, with focus on the recommended choice', () => {
    const { dialog } = renderChoice();
    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect(dialog.open).toBe(true);
    expect(showModal.mock.contexts).toContain(dialog);
    expect(dialog).toHaveAccessibleDescription('This browser and your account both have saved data. Choose what to keep.');
    expect(dialog).toHaveTextContent('This browser: 1 position · 0 chats · 0 settings');
    expect(dialog).toHaveTextContent('Your account: 2 positions · 0 chats · 3 settings');
    expect(merge()).toHaveFocus();
  });

  it('Escape and a press outside leave it open; a close the browser forces is undone; a choice closes it for good', async () => {
    const { dialog, onChoose } = renderChoice();
    expect(dialog).toHaveAttribute('closedby', 'none');

    expect(requestDialogClose(dialog)).toBe(false);
    expect(dialog.open).toBe(true);
    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(dialog);
    fireEvent.click(dialog);
    expect(dialog.open).toBe(true);
    expect(onChoose).not.toHaveBeenCalled();

    // Chromium's second Escape: its cancel cannot be prevented, and the dialog closes.
    expect(requestDialogClose(dialog, { cancelable: false })).toBe(true);
    expect(dialog.open).toBe(false);
    await closeEventHandled();
    expect(dialog.open).toBe(true);
    expect(merge()).toHaveFocus();

    act(() => dialog.close());
    await closeEventHandled();
    expect(dialog.open).toBe(true);
    expect(merge()).toHaveFocus();

    const opened = showModal.mock.calls.length;
    fireEvent.click(merge());
    expect(onChoose).toHaveBeenCalledWith('merge');
    expect(screen.queryByRole('dialog')).toBeNull();
    await closeEventHandled();
    expect(showModal.mock.calls.length).toBe(opened);
    expect(dialog.open).toBe(false);
  });

  it('Pin: has no axe violations', async () => {
    renderChoice();
    await expectNoAxeViolations(document.body, { bestPractices: true });
  });
});
