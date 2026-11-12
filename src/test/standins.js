// src/test/standins.js — stand-ins for two browser APIs jsdom 30 lacks and Phase 6's code calls: the <dialog> methods
// (showModal, show, close, returnValue) and pointer capture. setup.js installs both once per test file; each install
// does nothing where the environment already has the API, so a later jsdom takes over by itself (standins.test.jsx
// fails when that happens, so that dropping a stand-in is a decision). ./viewport.js holds the third, matchMedia.
//
// The dialog follows the HTML standard's steps, simplified:
// - showModal() throws an InvalidStateError DOMException on a dialog that is already open, however it was opened, or
//   that is not in the document. (The current standard returns silently from showModal() on a dialog that is already
//   modal and throws only when it is open non-modally; engines from before that change throw in both cases. This
//   throws in both, the stricter, so code that relies on the silent return fails here: open with `if (!d.open)`.)
//   Otherwise it sets `open`, remembers document.activeElement and moves focus to the first focusable descendant
//   carrying the autofocus ATTRIBUTE, else to the first focusable descendant, else leaves it where it was (a browser
//   focuses the dialog itself there: assert neither). React's autoFocus prop renders no attribute (React calls focus()
//   at mount, which a closed dialog refuses), so showModal() passes it over, as a browser does.
// - close(returnValue) does nothing on a closed dialog. Otherwise it puts focus back on the remembered element if
//   that is still in the document, else takes it off whatever inside the dialog held it (the browser's focus fixup,
//   which jsdom does not run for a hidden element), removes `open`, stores returnValue when one is given, and fires
//   `close` in a microtask. The browser queues a task: code must never rely on `close` arriving synchronously, and a
//   test awaits it (`await act(async () => {})`). Focus moves just before `open` goes, not just after: jsdom will not
//   blur an element that is no longer rendered.
// - show() sets `open` and nothing else (a browser also moves focus into the dialog; nothing here opens one that way).
// - NOT emulated, so a test must never assert any of them (they are proven in a real browser): the top layer,
//   ::backdrop, the inertness of everything outside a modal dialog (so there is no focus trap: Tab is not even
//   simulated), the :modal selector, the toggle events, and Escape. requestDialogClose() below stands for Escape.
//
// Pointer capture records, per pointer id, the one element holding it (capturing on a second element takes it from the
// first, as in a browser) and throws the browser's InvalidStateError on an element that is not in the document. It
// retargets nothing: a test dispatches the later pointermove and pointerup on the capturing element itself. Not
// emulated: the got/lostpointercapture events, the implicit release after pointerup or pointercancel (release it in
// the code, or in the test), the NotFoundError for a pointer id that is not active, and a browser ignoring the call
// for a pointer with no button pressed (capture from pointerdown).

/** The mark on every function installed here or by ./viewport.js: tells a stand-in from an API the environment has. */
export const STAND_IN = Symbol('jsdom stand-in');

/** `fn`, marked as a stand-in. */
export function markStandIn(fn) {
  return Object.defineProperty(fn, STAND_IN, { value: true });
}

// ── <dialog> ──

/** Per open dialog: the element focused before it opened, and whether showModal() opened it. */
const opened = new WeakMap();
/** Per dialog: its returnValue ('' until one is set). */
const returnValues = new WeakMap();

/** Elements that can take focus, before jsdom's own check (disabled, rendered, tabindex) and the one below. */
const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]';

/** Whether `el` sits in a subtree of `dialog` that cannot take focus where jsdom does not know it: inert or hidden. */
function outOfReach(el, dialog) {
  for (let node = el; node && node !== dialog; node = node.parentElement) {
    if (node.hasAttribute('inert') || node.hasAttribute('hidden')) return true;
  }
  return false;
}

/** The dialog focusing steps, simplified: the first focusable [autofocus] descendant, else the first focusable one. */
function focusInside(dialog) {
  const candidates = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => !outOfReach(el, dialog));
  for (const el of [...candidates.filter((c) => c.hasAttribute('autofocus')), ...candidates]) {
    el.focus(); // jsdom refuses what is disabled or not rendered, and focus stays put
    if (dialog.ownerDocument.activeElement === el) return;
  }
}

const invalidState = (method, why) => new DOMException(
  `Failed to execute '${method}' on 'HTMLDialogElement': ${why}`,
  'InvalidStateError',
);

function showModal() {
  if (this.open) {
    throw invalidState('showModal', "The element already has an 'open' attribute, and therefore cannot be opened modally.");
  }
  if (!this.isConnected) throw invalidState('showModal', 'The element is not in a Document.');
  opened.set(this, { previous: this.ownerDocument.activeElement, modal: true });
  this.setAttribute('open', '');
  focusInside(this);
}

function show() {
  if (this.open) return;
  opened.set(this, { previous: null, modal: false });
  this.setAttribute('open', '');
}

function close(returnValue) {
  if (!this.open) return;
  const doc = this.ownerDocument;
  const previous = opened.get(this)?.previous;
  opened.delete(this);
  if (previous && previous !== doc.body && previous.isConnected) previous.focus();
  if (this.contains(doc.activeElement)) doc.activeElement.blur();
  this.removeAttribute('open');
  if (returnValue !== undefined) returnValues.set(this, String(returnValue));
  queueMicrotask(() => this.dispatchEvent(new Event('close')));
}

/** Installs showModal(), show() and close() on HTMLDialogElement when the environment has none. setup.js calls it. */
export function installDialog() {
  if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal === 'function') return;
  const proto = HTMLDialogElement.prototype;
  for (const [name, fn] of Object.entries({ showModal, show, close })) {
    Object.defineProperty(proto, name, { value: markStandIn(fn), writable: true, configurable: true, enumerable: true });
  }
  if (!('returnValue' in proto)) {
    Object.defineProperty(proto, 'returnValue', {
      get() { return returnValues.get(this) ?? ''; },
      set(value) { returnValues.set(this, String(value)); },
      configurable: true,
      enumerable: true,
    });
  }
}

/**
 * What the browser does when the user presses Escape in a modal dialog, or its close watcher fires: dispatches a
 * cancelable `cancel` event on the dialog and, unless a listener prevented it, closes the dialog. A dialog that is
 * closed, or open but not modal (show(), or the `open` attribute alone), has no close watcher: nothing happens.
 * `{ cancelable: false }` is the second Escape with no user activation in between, for which Chromium makes `cancel`
 * not cancelable: a listener's preventDefault() is then ignored and the dialog closes (plan D2's SyncChoice case).
 * @param {HTMLDialogElement} dialog
 * @param {{ cancelable?: boolean }} [options]
 * @returns {boolean} true when the dialog closed
 */
export function requestDialogClose(dialog, { cancelable = true } = {}) {
  if (!dialog.open || opened.get(dialog)?.modal !== true) return false;
  if (dialog.dispatchEvent(new Event('cancel', { cancelable }))) dialog.close();
  return !dialog.open;
}

// ── Pointer capture ──

/** Per pointer id, the element that holds its capture. */
const captures = new Map();

function setPointerCapture(pointerId) {
  if (!this.isConnected) {
    throw new DOMException("Failed to execute 'setPointerCapture' on 'Element': The element is not connected.", 'InvalidStateError');
  }
  captures.set(Number(pointerId), this);
}

function releasePointerCapture(pointerId) {
  if (captures.get(Number(pointerId)) === this) captures.delete(Number(pointerId));
}

function hasPointerCapture(pointerId) {
  return captures.get(Number(pointerId)) === this;
}

/** Installs setPointerCapture(), releasePointerCapture() and hasPointerCapture() on Element when missing. */
export function installPointerCapture() {
  if (typeof Element.prototype.setPointerCapture === 'function') return;
  for (const [name, fn] of Object.entries({ setPointerCapture, releasePointerCapture, hasPointerCapture })) {
    Object.defineProperty(Element.prototype, name, { value: markStandIn(fn), writable: true, configurable: true, enumerable: true });
  }
}
