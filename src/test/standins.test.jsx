// src/test/standins.test.jsx — the stand-ins setup.js installs for what jsdom 30 lacks: <dialog> and pointer capture
// (src/test/standins.js) and matchMedia (src/test/viewport.js). The dialog as the platform has it, no friendlier:
// showModal() opens, remembers the focused element and moves focus to the [autofocus] descendant, else the first one
// that can take focus, else nowhere, and throws InvalidStateError on an open dialog (modal or not) and on a detached
// one; close() restores focus (to body when the opener has left), fires `close` a microtask later, never
// synchronously, keeps or sets returnValue and does nothing on a closed dialog; requestDialogClose() is Escape: a
// cancelable `cancel`, a preventDefault() keeping the dialog open, Chromium's non-cancelable second Escape, nothing for
// a non-modal dialog; React's onCancel and onClose props hear both events. matchMedia: a desktop by default, `change`
// only on the lists that flipped, removed listeners never called, resetViewport() back to a desktop with every listener
// dropped, an unknown feature false. Pointer capture: set, has, release, one element per pointer, refused on a
// detached element. Last, the install guards: what is installed are the stand-ins (red once a jsdom brings its own),
// and an install leaves an API the environment has alone.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { STAND_IN, installDialog, installPointerCapture, requestDialogClose } from './standins.js';
import { DESKTOP_WIDTH, PHONE_WIDTH, installMatchMedia, resetViewport, setViewportWidth } from './viewport.js';

/** What `fn` threw, or null. */
function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

/** An opener and a closed dialog holding `children`, as a component renders them; returns both. */
function renderDialog(children) {
  render(
    <>
      <button type="button">Open settings</button>
      <dialog aria-label="Settings">{children}</dialog>
    </>,
  );
  return { opener: screen.getByRole('button', { name: 'Open settings' }), dialog: document.querySelector('dialog') };
}

/** Lets queued microtasks run: the stand-in's `close` event is one. */
const microtask = () => Promise.resolve();

describe('<dialog> stand-in', () => {
  it('showModal() sets open and focuses the descendant carrying the autofocus attribute', () => {
    const { opener, dialog } = renderDialog(<><button type="button">Close</button><input aria-label="API key" /></>);
    const key = screen.getByRole('textbox', { hidden: true });
    key.setAttribute('autofocus', '');
    opener.focus();
    dialog.showModal();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(key);
  });

  it('showModal() otherwise focuses the first descendant that can take focus, passing over what cannot', () => {
    const { opener, dialog } = renderDialog(
      <>
        <p>Settings sync across your devices.</p>
        <button type="button" disabled>Disabled</button>
        <div hidden><button type="button">Hidden</button></div>
        <div inert><button type="button">Inert</button></div>
        <button type="button">Close</button>
      </>,
    );
    opener.focus();
    dialog.showModal();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  // React renders no autofocus attribute for the autoFocus prop: it calls focus() at mount, which an element inside a
  // closed dialog refuses. So, as in a browser, showModal() focuses the first focusable descendant.
  it("showModal() passes over React's autoFocus prop, which renders no attribute", () => {
    const { opener, dialog } = renderDialog(<><button type="button">Close</button><input aria-label="API key" autoFocus /></>);
    expect(screen.getByRole('textbox', { hidden: true }).hasAttribute('autofocus')).toBe(false);
    opener.focus();
    dialog.showModal();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('showModal() leaves focus where it was when nothing inside can take focus', () => {
    const { opener, dialog } = renderDialog(<p>Syncing…</p>);
    opener.focus();
    dialog.showModal();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('showModal() throws InvalidStateError on an open dialog and on one that is not in the document', () => {
    const { dialog } = renderDialog(<button type="button">Close</button>);
    dialog.showModal();
    const twice = thrown(() => dialog.showModal());
    expect(twice).toBeInstanceOf(DOMException);
    expect(twice.name).toBe('InvalidStateError');

    const shown = document.createElement('dialog');
    document.body.append(shown);
    shown.show();
    expect(shown.open).toBe(true);
    expect(thrown(() => shown.showModal())?.name).toBe('InvalidStateError'); // open non-modally: the platform throws too
    shown.remove();

    const detached = document.createElement('dialog');
    expect(thrown(() => detached.showModal())?.name).toBe('InvalidStateError');
    expect(detached.open).toBe(false);
  });

  it('close() removes open, puts focus back on the opener and fires close after a microtask, not synchronously', async () => {
    const { opener, dialog } = renderDialog(<button type="button">Close</button>);
    const onClose = vi.fn();
    dialog.addEventListener('close', onClose);
    opener.focus();
    dialog.showModal();
    dialog.close();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(onClose).not.toHaveBeenCalled();
    await microtask();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close() does nothing on a closed dialog', async () => {
    const { opener, dialog } = renderDialog(<button type="button">Close</button>);
    const onClose = vi.fn();
    dialog.addEventListener('close', onClose);
    opener.focus();
    dialog.close();
    await microtask();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it('close() does not put focus back on an opener that has left the document', () => {
    const { dialog } = renderDialog(<button type="button">Close</button>);
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    dialog.showModal();
    opener.remove();
    dialog.close();
    expect(document.activeElement).toBe(document.body); // not left on the closed dialog's button either
  });

  it('close(returnValue) stores it, and close() keeps the one stored', () => {
    const { dialog } = renderDialog(<button type="button">Close</button>);
    expect(dialog.returnValue).toBe('');
    dialog.showModal();
    dialog.close('merge');
    expect(dialog.returnValue).toBe('merge');
    dialog.showModal();
    dialog.close();
    expect(dialog.returnValue).toBe('merge');
  });

  it('show() sets open and moves no focus', () => {
    const { opener, dialog } = renderDialog(<button type="button">Close</button>);
    opener.focus();
    dialog.show();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(opener);
  });
});

describe('requestDialogClose', () => {
  it('fires a cancelable cancel and closes the dialog, returning true', async () => {
    const { opener, dialog } = renderDialog(<button type="button">Close</button>);
    const events = [];
    dialog.addEventListener('cancel', (event) => events.push(`cancel cancelable=${event.cancelable} bubbles=${event.bubbles}`));
    dialog.addEventListener('close', () => events.push('close'));
    opener.focus();
    dialog.showModal();
    expect(requestDialogClose(dialog)).toBe(true);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(opener);
    await microtask();
    expect(events).toEqual(['cancel cancelable=true bubbles=false', 'close']);
  });

  it('leaves the dialog open, returning false, when a cancel listener prevents it', async () => {
    const { dialog } = renderDialog(<button type="button">Close</button>);
    const onClose = vi.fn();
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    expect(requestDialogClose(dialog)).toBe(false);
    expect(dialog.open).toBe(true);
    await microtask();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes despite preventDefault() with { cancelable: false }, Chromium's second Escape", () => {
    const { dialog } = renderDialog(<button type="button">Close</button>);
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    dialog.showModal();
    expect(requestDialogClose(dialog, { cancelable: false })).toBe(true);
    expect(dialog.open).toBe(false);
  });

  it('does nothing to a dialog that is not open modally', () => {
    const { dialog } = renderDialog(<button type="button">Close</button>);
    const onCancel = vi.fn();
    dialog.addEventListener('cancel', onCancel);
    expect(requestDialogClose(dialog)).toBe(false); // closed
    dialog.show();
    expect(requestDialogClose(dialog)).toBe(false); // open, not modal: no close watcher
    expect(dialog.open).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("reaches React's onCancel and onClose props", async () => {
    const onCancel = vi.fn();
    const onClose = vi.fn();
    render(<dialog aria-label="Sync" onCancel={onCancel} onClose={onClose}><button type="button">Merge</button></dialog>);
    const dialog = document.querySelector('dialog');
    dialog.showModal();
    requestDialogClose(dialog);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await microtask();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('matchMedia stand-in', () => {
  it('answers (min-width: 48rem) as a desktop by default and as a phone at PHONE_WIDTH', () => {
    const md = window.matchMedia('(min-width: 48rem)');
    expect(md.media).toBe('(min-width: 48rem)');
    expect(md.matches).toBe(true);
    setViewportWidth(PHONE_WIDTH);
    expect(md.matches).toBe(false);
    expect(window.matchMedia('(min-width: 48rem)').matches).toBe(false);
  });

  it('reads px, rem and em, alone or joined by and', () => {
    const tablet = window.matchMedia('(min-width: 768px) and (max-width: 1023.98px)');
    expect(tablet.matches).toBe(false); // 1280
    setViewportWidth(1000);
    expect(tablet.matches).toBe(true);
    expect(window.matchMedia('(max-width: 62.5em)').matches).toBe(true); // 1000px
    expect(window.matchMedia('(MIN-WIDTH:63rem)').matches).toBe(false);
  });

  it('fires change only on the lists whose matches flipped, with matches and media on the event', () => {
    const calls = [];
    const listen = (query) => window.matchMedia(query).addEventListener('change', (event) => calls.push([query, event.matches, event.media]));
    listen('(min-width: 48rem)');
    listen('(min-width: 200px)');
    listen('(max-width: 47.99rem)');
    setViewportWidth(PHONE_WIDTH);
    expect(calls).toEqual([['(min-width: 48rem)', false, '(min-width: 48rem)'], ['(max-width: 47.99rem)', true, '(max-width: 47.99rem)']]);
    setViewportWidth(PHONE_WIDTH + 1); // nothing flips
    expect(calls).toHaveLength(2);
  });

  it('never calls a removed listener, whichever way it was added', () => {
    const md = window.matchMedia('(min-width: 48rem)');
    const viaEvent = vi.fn();
    const viaLegacy = vi.fn();
    const viaProperty = vi.fn();
    md.addEventListener('change', viaEvent);
    md.addListener(viaLegacy);
    md.onchange = viaProperty;
    expect(md.onchange).toBe(viaProperty);
    md.removeEventListener('change', viaEvent);
    md.removeListener(viaLegacy);
    md.onchange = null;
    setViewportWidth(PHONE_WIDTH);
    expect([viaEvent, viaLegacy, viaProperty].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('calls addListener and onchange listeners like addEventListener ones', () => {
    const md = window.matchMedia('(min-width: 48rem)');
    const viaLegacy = vi.fn();
    const viaProperty = vi.fn();
    md.addListener(viaLegacy);
    md.onchange = viaProperty;
    setViewportWidth(PHONE_WIDTH);
    expect(viaLegacy).toHaveBeenCalledWith(expect.objectContaining({ type: 'change', matches: false }));
    expect(viaProperty).toHaveBeenCalledTimes(1);
  });

  it('resetViewport() restores the desktop width', () => {
    const md = window.matchMedia('(min-width: 48rem)');
    setViewportWidth(PHONE_WIDTH);
    resetViewport();
    expect(window.matchMedia(`(min-width: ${DESKTOP_WIDTH}px)`).matches).toBe(true);
    expect(md.matches).toBe(true);
  });

  it('resetViewport() drops every listener: one left at the end of a test never hears the next test resize', () => {
    const onChange = vi.fn();
    window.matchMedia('(min-width: 48rem)').addEventListener('change', onChange); // as an unmounted hook might leave it
    resetViewport(); // the end of that test, in setup.js
    setViewportWidth(PHONE_WIDTH); // the next test goes to a phone
    expect(onChange).not.toHaveBeenCalled();
  });

  it('answers any other feature, a media type or a range with false', () => {
    for (const query of ['(prefers-reduced-motion: reduce)', '(hover: hover)', 'screen and (min-width: 1px)', '(width >= 48rem)']) {
      expect(window.matchMedia(query).matches).toBe(false);
    }
  });

  it('refuses a width that is not a positive number of px', () => {
    expect(() => setViewportWidth('375px')).toThrow(TypeError);
    expect(() => setViewportWidth(0)).toThrow(TypeError);
  });
});

describe('pointer capture stand-in', () => {
  it('sets, reports and releases a capture per element and pointer', () => {
    render(<><div role="separator" aria-label="Resize chat" tabIndex={0} /><div data-testid="other" /></>);
    const handle = screen.getByRole('separator');
    const other = screen.getByTestId('other');
    handle.setPointerCapture(1);
    expect(handle.hasPointerCapture(1)).toBe(true);
    expect(handle.hasPointerCapture(2)).toBe(false);
    other.setPointerCapture(1); // one element holds a pointer: the second takes it
    expect(handle.hasPointerCapture(1)).toBe(false);
    expect(other.hasPointerCapture(1)).toBe(true);
    handle.releasePointerCapture(1); // not the holder: nothing changes
    expect(other.hasPointerCapture(1)).toBe(true);
    other.releasePointerCapture(1);
    expect(other.hasPointerCapture(1)).toBe(false);
  });

  it('throws InvalidStateError on an element that is not in the document', () => {
    const detached = document.createElement('div');
    expect(thrown(() => detached.setPointerCapture(1))?.name).toBe('InvalidStateError');
    expect(detached.hasPointerCapture(1)).toBe(false);
  });
});

describe('the install guards', () => {
  // jsdom 30.1.3 has none of the three. When this fails, an upgraded jsdom brought its own and the install skipped the
  // stand-in: whether to keep it, and these tests, is then a decision.
  it('what setup.js installed are the stand-ins: jsdom has no dialog methods, matchMedia or pointer capture', () => {
    expect(HTMLDialogElement.prototype.showModal[STAND_IN]).toBe(true);
    expect(HTMLDialogElement.prototype.close[STAND_IN]).toBe(true);
    expect(window.matchMedia[STAND_IN]).toBe(true);
    expect(Element.prototype.setPointerCapture[STAND_IN]).toBe(true);
  });

  it('an install leaves an API the environment has alone', () => {
    const own = () => {};
    const dialogProto = HTMLDialogElement.prototype;
    const saved = {
      showModal: Object.getOwnPropertyDescriptor(dialogProto, 'showModal'),
      matchMedia: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
      setPointerCapture: Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture'),
    };
    try {
      dialogProto.showModal = own;
      window.matchMedia = own;
      Element.prototype.setPointerCapture = own;
      installDialog();
      installMatchMedia();
      installPointerCapture();
      expect([dialogProto.showModal, window.matchMedia, Element.prototype.setPointerCapture]).toEqual([own, own, own]);
    } finally {
      Object.defineProperty(dialogProto, 'showModal', saved.showModal);
      Object.defineProperty(window, 'matchMedia', saved.matchMedia);
      Object.defineProperty(Element.prototype, 'setPointerCapture', saved.setPointerCapture);
    }
  });
});
