// src/hooks/useResizableSidebar.handle.test.jsx — what the resize handle does beyond the drag that
// useResizableSidebar.test.jsx pins: its value for assistive technology, the keyboard, and the pointers a drag does not
// take. The handle sits on the sidebar's left edge, so ArrowLeft widens the sidebar by 16 px and ArrowRight narrows
// it, Home and End go to 280 and 640, and the width follows the keys at once but is stored only when the key is
// released or the handle loses focus: sidebarWidth syncs, and a held key would otherwise queue a write per repeat.
// A drag holds the pointer's capture on the handle until it ends; a pointercancel ends it with nothing stored and the
// stored width back; only the primary button starts one, and a second pointer during a drag is ignored; a drag whose
// handle goes away (App shows none below md) goes on to the pointer's release, which document still hears. The host
// renders the handle as App does and logs every render's [width, isResizing]; src/test/setup.js clears localStorage
// after each test and installs the pointer-capture stand-in, which retargets nothing (the tests fire a drag's events
// on the handle, where a browser sends them).
import { StrictMode, useState } from 'react';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useResizableSidebar } from './useResizableSidebar.js';

/** The sidebarWidth preference's localStorage key. */
const KEY = 'chat_sidebar_w';
const stored = () => localStorage.getItem(KEY);

/** Every render's [width, isResizing], StrictMode's second render included. */
let log = [];

/** The handle as App wires it, focusable as App's is. */
function Host() {
  const { width, isResizing, handleProps } = useResizableSidebar();
  log.push([width, isResizing]);
  return <div data-testid="handle" tabIndex={0} {...handleProps} />;
}

/** The handle shown or not while the hook stays mounted, as App drops the handle below md. */
function NarrowingHost() {
  const [shown, setShown] = useState(true);
  const { width, isResizing, handleProps } = useResizableSidebar();
  log.push([width, isResizing]);
  return (
    <>
      <button type="button" onClick={() => setShown(false)}>Narrow</button>
      {shown && <div data-testid="handle" tabIndex={0} {...handleProps} />}
    </>
  );
}

const handle = () => screen.getByTestId('handle');
const last = () => log.at(-1);
const bodyStyles = () => [document.body.style.cursor, document.body.style.userSelect];

/** The detail of every store-changed from here to the end of the test. */
function storeEvents() {
  const details = [];
  const onEvent = (e) => { details.push(e.detail ?? null); };
  window.addEventListener('store-changed', onEvent);
  onTestFinished(() => { window.removeEventListener('store-changed', onEvent); });
  return details;
}

const PREF = { kind: 'pref', id: 'sidebarWidth' };

/** A key pressed on the handle; held, it repeats. Returns false when the handle prevented the key's default. */
const press = (key, init = {}) => fireEvent.keyDown(handle(), { key, ...init });
const release = (key) => fireEvent.keyUp(handle(), { key });

const renderHost = () => render(<StrictMode><Host /></StrictMode>);

describe('useResizableSidebar: the handle', () => {
  beforeEach(() => {
    log = [];
  });

  it("gives the handle its value: aria-valuenow is the width shown, within aria-valuemin 280 and aria-valuemax 640", () => {
    localStorage.setItem(KEY, '500');
    renderHost();
    expect(handle()).toHaveAttribute('aria-valuenow', '500');
    expect(handle()).toHaveAttribute('aria-valuemin', '280');
    expect(handle()).toHaveAttribute('aria-valuemax', '640');

    fireEvent.pointerDown(handle(), { clientX: 1000 });
    fireEvent.pointerMove(handle(), { clientX: 900 });
    expect(handle()).toHaveAttribute('aria-valuenow', '600'); // the dragged width, live
    press('ArrowLeft'); // a drag owns the width: the key changes nothing
    expect(handle()).toHaveAttribute('aria-valuenow', '600');
    fireEvent.pointerUp(handle());
    expect(handle()).toHaveAttribute('aria-valuenow', '600');
  });

  it('ArrowLeft held three times widens by 48 px at once, stores nothing while held, and stores once on release', () => {
    renderHost();
    const events = storeEvents();
    expect(press('ArrowLeft')).toBe(false); // prevented: an arrow scrolls nothing behind the handle
    expect(last()).toEqual([400, false]); // at once; the drag's isResizing stays false, so the aside keeps its transition
    expect(press('ArrowLeft', { repeat: true })).toBe(false);
    expect(press('ArrowLeft', { repeat: true })).toBe(false);
    expect(last()).toEqual([432, false]);
    expect(handle()).toHaveAttribute('aria-valuenow', '432');
    expect(stored()).toBeNull();
    expect(events).toEqual([]);

    const before = log.length;
    release('ArrowLeft');
    expect(stored()).toBe('432');
    expect(events).toEqual([PREF]);
    // Rendered again, and never with the old 384 between the keys' 432 and the stored one.
    const renders = log.slice(before);
    expect(renders.length).toBeGreaterThan(0);
    expect(renders).toEqual(renders.map(() => [432, false]));

    // Released, there is nothing left to store.
    release('ArrowLeft');
    fireEvent.blur(handle());
    expect(events).toEqual([PREF]);
  });

  it('ArrowRight narrows by 16 px, Home goes to 280 and End to 640, each stored on release; at a bound a step moves nothing and stores nothing', () => {
    localStorage.setItem(KEY, '500');
    renderHost();
    const events = storeEvents();

    press('ArrowRight');
    expect(last()[0]).toBe(484);
    release('ArrowRight');
    expect(stored()).toBe('484');

    expect(press('End')).toBe(false); // prevented: End would scroll the page
    expect(last()[0]).toBe(640);
    release('End');
    expect(stored()).toBe('640');
    expect(events).toHaveLength(2);
    press('ArrowLeft'); // already the widest
    press('End');
    release('End');
    expect(last()[0]).toBe(640);
    expect(events).toHaveLength(2);

    expect(press('Home')).toBe(false);
    expect(last()[0]).toBe(280);
    release('Home');
    expect(stored()).toBe('280');
    press('ArrowRight'); // already the narrowest
    release('ArrowRight');
    expect(last()[0]).toBe(280);
    expect(events).toEqual([PREF, PREF, PREF]);
  });

  it('stores what the keys moved when the handle loses focus with a key still held', () => {
    renderHost();
    const events = storeEvents();
    handle().focus();
    press('ArrowLeft');
    press('ArrowLeft', { repeat: true });
    expect(stored()).toBeNull();

    fireEvent.blur(handle()); // Tab pressed while the arrow is held, or the window losing focus
    expect(stored()).toBe('416');
    expect(events).toEqual([PREF]);
    expect(last()).toEqual([416, false]);
    release('ArrowLeft'); // the key's release, heard elsewhere or here, stores nothing more
    expect(events).toEqual([PREF]);
  });

  it('Pin: leaves alone the keys it does not use, and an arrow with Alt, Ctrl or Meta: not prevented, nothing moves', () => {
    renderHost();
    const events = storeEvents();
    for (const init of [
      { key: 'ArrowUp' }, { key: 'ArrowDown' }, { key: 'Tab' }, { key: 'Enter' }, { key: 'a' },
      { key: 'ArrowLeft', altKey: true }, { key: 'ArrowLeft', ctrlKey: true }, { key: 'ArrowRight', metaKey: true },
      { key: 'Home', metaKey: true },
    ]) {
      expect(fireEvent.keyDown(handle(), init)).toBe(true);
      fireEvent.keyUp(handle(), { key: init.key });
    }
    expect(last()).toEqual([384, false]);
    expect(events).toEqual([]);
  });

  it('a pointercancel mid-drag stores nothing, shows the stored width again and gives the page back', () => {
    localStorage.setItem(KEY, '500');
    renderHost();
    const events = storeEvents();
    fireEvent.pointerDown(handle(), { clientX: 1000, pointerId: 7 });
    fireEvent.pointerMove(handle(), { clientX: 900, pointerId: 7 });
    expect(last()).toEqual([600, true]);

    fireEvent.pointerCancel(handle(), { pointerId: 7 }); // the browser took the touch for a gesture, say
    expect(last()).toEqual([500, false]);
    expect(stored()).toBe('500');
    expect(events).toEqual([]);
    expect(bodyStyles()).toEqual(['', '']);
    expect(handle().hasPointerCapture(7)).toBe(false);

    // The drag is over: the pointer moves nothing and its release stores nothing.
    const settled = log.length;
    fireEvent.pointerMove(handle(), { clientX: 700, pointerId: 7 });
    fireEvent.pointerUp(handle(), { pointerId: 7 });
    expect(log).toHaveLength(settled);
    expect(events).toEqual([]);
  });

  it("holds the pointer's capture on the handle from the pointerdown to the drag's end", () => {
    renderHost();
    fireEvent.pointerDown(handle(), { clientX: 1000, pointerId: 3 });
    expect(handle().hasPointerCapture(3)).toBe(true);
    fireEvent.pointerMove(handle(), { clientX: 990, pointerId: 3 });
    expect(handle().hasPointerCapture(3)).toBe(true);
    fireEvent.pointerUp(handle(), { pointerId: 3 });
    expect(handle().hasPointerCapture(3)).toBe(false);
    expect(stored()).toBe('394');
  });

  it('a finger drags as the mouse does', () => {
    renderHost();
    const events = storeEvents();
    expect(fireEvent.pointerDown(handle(), { clientX: 300, pointerId: 11, pointerType: 'touch' })).toBe(false);
    fireEvent.pointerMove(handle(), { clientX: 250, pointerId: 11, pointerType: 'touch' });
    expect(last()).toEqual([434, true]);
    fireEvent.pointerUp(handle(), { clientX: 250, pointerId: 11, pointerType: 'touch' });
    expect(stored()).toBe('434');
    expect(events).toEqual([PREF]);
  });

  it('Pin: only the primary button starts a drag: a right or middle press is left alone', () => {
    renderHost();
    const events = storeEvents();
    for (const button of [1, 2]) {
      expect(fireEvent.pointerDown(handle(), { clientX: 1000, button })).toBe(true);
      fireEvent.pointerMove(handle(), { clientX: 900, button });
      fireEvent.pointerUp(handle(), { clientX: 900, button });
    }
    expect(log.every(([width, isResizing]) => width === 384 && !isResizing)).toBe(true);
    expect(bodyStyles()).toEqual(['', '']);
    expect(events).toEqual([]);
  });

  it('a second pointer pressed on the handle mid-drag is ignored: its moves and its release do nothing', () => {
    renderHost();
    const events = storeEvents();
    fireEvent.pointerDown(handle(), { clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 900, pointerId: 1 });
    expect(last()).toEqual([484, true]);

    expect(fireEvent.pointerDown(handle(), { clientX: 500, pointerId: 2 })).toBe(true);
    fireEvent.pointerMove(handle(), { clientX: 0, pointerId: 2 });
    fireEvent.pointerUp(handle(), { clientX: 0, pointerId: 2 });
    fireEvent.pointerCancel(handle(), { pointerId: 2 });
    expect(last()).toEqual([484, true]);
    expect(events).toEqual([]);
    expect(handle().hasPointerCapture(2)).toBe(false);

    fireEvent.pointerMove(handle(), { clientX: 950, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 950, pointerId: 1 });
    expect(last()).toEqual([434, false]);
    expect(stored()).toBe('434');
    expect(events).toEqual([PREF]);
  });

  it('a drag whose handle goes away (the window narrowed under md) follows the pointer on and ends at its release', () => {
    render(<StrictMode><NarrowingHost /></StrictMode>);
    const events = storeEvents();
    fireEvent.pointerDown(handle(), { clientX: 1000 });
    fireEvent.pointerMove(handle(), { clientX: 900 });
    fireEvent.click(screen.getByText('Narrow'));
    expect(screen.queryByTestId('handle')).toBeNull();
    expect(last()).toEqual([484, true]);

    // The capture went with the handle: the pointer's events reach what is under it, and bubble to document.
    fireEvent.pointerMove(document.body, { clientX: 950 });
    expect(last()).toEqual([434, true]);
    fireEvent.pointerUp(document.body);
    expect(last()).toEqual([434, false]);
    expect(stored()).toBe('434');
    expect(events).toEqual([PREF]);
    expect(bodyStyles()).toEqual(['', '']);
  });

  it('a drag that starts while the keys hold a width takes over from it: its release alone is stored', () => {
    renderHost();
    const events = storeEvents();
    press('ArrowLeft');
    expect(last()).toEqual([400, false]);

    fireEvent.pointerDown(handle(), { clientX: 1000 }); // from the width shown
    fireEvent.pointerMove(handle(), { clientX: 900 });
    expect(last()).toEqual([500, true]);
    release('ArrowLeft'); // during the drag: the keys have nothing left to store
    expect(events).toEqual([]);
    fireEvent.pointerUp(handle());
    expect(last()).toEqual([500, false]);
    expect(stored()).toBe('500');
    expect(events).toEqual([PREF]);
  });
});
