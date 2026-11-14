// src/components/ModalDialog.test.jsx — the shared modal dialog on <dialog>, driven through a host that mounts it from
// a button and unmounts it on onDismiss or on a second button, as its parents do, under StrictMode (main.jsx). It opens
// with showModal(), never the open attribute alone, named by a heading or by a name of its own, described and marked
// busy on request; focus goes to initialFocus, else to the dialog itself, and comes back to the opener when it
// unmounts, the close running while the dialog is still in the document. StrictMode's mount, cleanup and mount again
// open it twice without a throw, and the close event of that cleanup changes nothing. `cancel` is always prevented:
// with onDismiss it calls onDismiss, without it nothing happens. A press outside the panel (down, up and click on the
// dialog element) dismisses; a click in the panel, or a press that begins or ends in it, does not. A dialog nobody may
// dismiss carries closedby="none" and opens again when the browser closes it anyway, but not once it has been
// unmounted; a dismissable one that the browser closed calls onDismiss. The <dialog> stand-in is src/test/standins.js:
// the focus trap and the inert page are not emulated there, and are checked in a browser.
import { StrictMode, useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ModalDialog from './ModalDialog.js';
import { requestDialogClose } from '../test/standins.js';
import { expectNoAxeViolations } from '../test/a11y.js';

/** Mounts the dialog from "Open", unmounts it from "Unmount" or onDismiss (when dismissable), counts dismissals. */
function Host({ dismissable = true, focusSecond = false, onDismissed = () => {}, name = { labelledBy: 'title' }, ...props }) {
  const [open, setOpen] = useState(false);
  const second = useRef(null);
  const onDismiss = dismissable ? () => { onDismissed(); setOpen(false); } : undefined;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <button type="button" onClick={() => setOpen(false)}>Unmount</button>
      {open && (
        <ModalDialog
          {...name}
          {...props}
          initialFocus={focusSecond ? second : undefined}
          onDismiss={onDismiss}
          backdropClassName="backdrop:bg-black/60"
        >
          <div data-testid="panel">
            <h2 id="title">Settings</h2>
            <p id="description">Two buttons to choose from.</p>
            <button type="button">First</button>
            <button type="button" ref={second}>Second</button>
          </div>
        </ModalDialog>
      )}
    </>
  );
}

/** Renders the host under StrictMode, focuses "Open" and clicks it; returns the opener, the dialog and onDismissed. */
function open(props = {}) {
  const onDismissed = vi.fn();
  render(<StrictMode><Host onDismissed={onDismissed} {...props} /></StrictMode>);
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: document.querySelector('dialog'), onDismissed };
}

const unmount = () => fireEvent.click(screen.getByRole('button', { name: 'Unmount' }));
const panelButton = () => screen.getByRole('button', { name: 'First' });

/** A press outside the panel: down, up and click on the dialog element itself, where ::backdrop clicks land. */
function pressOutside(dialog) {
  fireEvent.pointerDown(dialog);
  fireEvent.pointerUp(dialog);
  fireEvent.click(dialog);
}

/** Lets a `close` event (queued after a close()) be handled, and what it set off render. */
const closeEventHandled = () => act(async () => {});

let showModal;
beforeEach(() => {
  showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
});

describe('opening', () => {
  it('opens with showModal(), named by its heading, described on request; StrictMode opens it twice without a throw', async () => {
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close');
    const { dialog, onDismissed } = open({ describedBy: 'description' });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog);
    expect(dialog.open).toBe(true);
    // StrictMode: the effect, its cleanup, the effect again, all on this one dialog.
    expect(showModal).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(showModal.mock.contexts).toEqual([dialog, dialog]);
    expect(dialog).toHaveAccessibleDescription('Two buttons to choose from.');
    expect(dialog).not.toHaveAttribute('aria-busy');

    // The close event of that cleanup arrives with the dialog open again: nothing happens.
    await closeEventHandled();
    expect(dialog.open).toBe(true);
    expect(onDismissed).not.toHaveBeenCalled();
    expect(showModal).toHaveBeenCalledTimes(2);
  });

  it('takes a name of its own where no heading names it, and says when its content is busy', () => {
    const { dialog } = open({ name: { label: 'Sync your data' }, busy: true });
    expect(screen.getByRole('dialog', { name: 'Sync your data' })).toBe(dialog);
    expect(dialog).toHaveAttribute('aria-busy', 'true');
  });

  it('focuses initialFocus once open', () => {
    open({ focusSecond: true });
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
  });

  it('focuses the dialog itself without initialFocus, and keeps it out of the tab order', () => {
    const { dialog } = open();
    expect(dialog).toHaveFocus();
    expect(dialog.tabIndex).toBe(-1);
  });

  it('has no axe violations', async () => {
    open({ describedBy: 'description' });
    await expectNoAxeViolations(document.body, { bestPractices: true });
  });
});

describe('closing', () => {
  it('closes as it unmounts, while still in the document, and focus goes back to the opener', async () => {
    const { opener, dialog, onDismissed } = open();
    expect(dialog).toContainElement(document.activeElement);
    const realClose = HTMLDialogElement.prototype.close;
    const connectedAtClose = [];
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function recordConnected(...args) {
      connectedAtClose.push(this.isConnected);
      return realClose.apply(this, args);
    });

    unmount();
    expect(document.querySelector('dialog')).toBeNull();
    expect(connectedAtClose).toEqual([true]);
    expect(opener).toHaveFocus();
    await closeEventHandled();
    expect(onDismissed).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });

  it("prevents the browser's cancel and asks onDismiss instead, which closes it", () => {
    const { opener, dialog, onDismissed } = open();
    const cancel = new Event('cancel', { cancelable: true });
    act(() => { dialog.dispatchEvent(cancel); });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('dismisses on a press outside the panel, never on a click in it or a press that begins or ends in it', () => {
    const { dialog, onDismissed } = open();
    fireEvent.pointerDown(panelButton());
    fireEvent.pointerUp(panelButton());
    fireEvent.click(panelButton());
    // A selection dragged out of the panel: the click lands on the dialog, the common ancestor.
    fireEvent.pointerDown(panelButton());
    fireEvent.pointerUp(dialog);
    fireEvent.click(dialog);
    // A press outside released in the panel.
    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(panelButton());
    fireEvent.click(dialog);
    // A click with no press before it (a synthetic one).
    fireEvent.click(dialog);
    expect(onDismissed).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);

    pressOutside(dialog);
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('calls onDismiss when the browser closes it anyway, so React follows', async () => {
    const { dialog, onDismissed } = open();
    let closed;
    act(() => { closed = requestDialogClose(dialog, { cancelable: false }); });
    expect(closed).toBe(true);
    expect(onDismissed).toHaveBeenCalledTimes(1); // its cancel, which could not be prevented
    await closeEventHandled();
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('dialog')).toBeNull();
  });
});

describe('without onDismiss', () => {
  it('nothing dismisses it: its cancel is prevented, a press outside does nothing, and it asks for closedby none', async () => {
    const { dialog } = open({ dismissable: false });
    expect(dialog).toHaveAttribute('closedby', 'none');
    expect(requestDialogClose(dialog)).toBe(false);
    pressOutside(dialog);
    await closeEventHandled();
    expect(dialog.open).toBe(true);
    expect(dialog).toContainElement(document.activeElement);
  });

  it('opens again, focus inside, when the browser closes it anyway; not once it has been unmounted', async () => {
    const { opener, dialog } = open({ dismissable: false, focusSecond: true });
    const second = screen.getByRole('button', { name: 'Second' });
    expect(requestDialogClose(dialog, { cancelable: false })).toBe(true);
    expect(dialog.open).toBe(false);
    await closeEventHandled();
    expect(dialog.open).toBe(true);
    expect(second).toHaveFocus();

    act(() => dialog.close());
    await closeEventHandled();
    expect(dialog.open).toBe(true);
    expect(second).toHaveFocus();

    const opened = showModal.mock.calls.length;
    unmount();
    expect(opener).toHaveFocus();
    await closeEventHandled();
    expect(showModal.mock.calls.length).toBe(opened);
    expect(dialog.open).toBe(false);
  });
});
