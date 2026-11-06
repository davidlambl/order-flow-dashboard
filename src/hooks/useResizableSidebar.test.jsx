// src/hooks/useResizableSidebar.test.jsx — the chat sidebar's width as App's aside and resize handle use it, through a
// host that renders the handle and logs every render's [width, isResizing]. A stored width counts only in range and as
// a number, and one saved elsewhere shows at once. A drag follows the mouse from the width shown, clamped to 280-640,
// with the body's cursor and selection set and nothing stored; the mouseup stores the dragged width with one `pref`
// event, renders no other width on the way, ends the drag and leaves the mouse moving nothing; the next drag starts
// from the stored width. An unmount mid-drag removes the drag's listeners, restores the body and stores nothing. The
// mouse events go to document, where the drag listens; src/test/setup.js clears localStorage after each test.
import { StrictMode, useState } from 'react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { emitStoreChanged } from '../lib/store.js';
import { savePreference } from '../lib/storeEvents.js';
import { useResizableSidebar } from './useResizableSidebar.js';

/** The sidebarWidth preference's localStorage key. */
const KEY = 'chat_sidebar_w';
const stored = () => localStorage.getItem(KEY);

/** Every render's [width, isResizing], StrictMode's second render included. */
let log = [];

/** The handle as App wires it. */
function Host() {
  const { width, isResizing, onResizeStart } = useResizableSidebar();
  log.push([width, isResizing]);
  return <div data-testid="handle" onMouseDown={onResizeStart} />;
}

/** The host behind a toggle: hiding it unmounts the hook while the rest of the tree stays. */
function Toggle() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setShown(false)}>Hide</button>
      {shown && <Host />}
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

describe('useResizableSidebar', () => {
  beforeEach(() => {
    log = [];
  });

  it('reads a stored width only in range and as a number; anything else, or none, is the default 384', () => {
    const cases = [
      [null, 384], ['500', 500], ['280', 280], ['640', 640], ['279', 384], ['641', 384], ['"500"', 384],
      ['{"a":1}', 384], ['abc', 384],
    ];
    const read = cases.map(([raw]) => {
      localStorage.clear();
      if (raw !== null) localStorage.setItem(KEY, raw);
      const { result, unmount } = renderHook(() => useResizableSidebar());
      const { width, isResizing } = result.current;
      unmount();
      return [raw, width, isResizing];
    });
    expect(read).toEqual(cases.map(([raw, width]) => [raw, width, false]));
  });

  it('follows a width saved elsewhere at once, and re-reads it on a whole-store change', () => {
    const { result } = renderHook(() => useResizableSidebar());
    expect(result.current.width).toBe(384);

    act(() => { savePreference('sidebarWidth', 500); });
    expect(result.current.width).toBe(500);

    // An import or a cloud pull rewrites storage, then emits without a detail.
    localStorage.setItem(KEY, '300');
    act(() => { emitStoreChanged(); });
    expect(result.current.width).toBe(300);
  });

  it('drags from the width shown, following the mouse within 280-640, with the body styled and nothing stored', () => {
    localStorage.setItem(KEY, '500');
    render(<StrictMode><Host /></StrictMode>);
    const events = storeEvents();
    // The default is prevented, so the press starts no text selection.
    expect(fireEvent.mouseDown(handle(), { clientX: 1000 })).toBe(false);
    expect(last()).toEqual([500, true]);
    expect(bodyStyles()).toEqual(['col-resize', 'none']);

    fireEvent.mouseMove(document, { clientX: 900 }); // the aside is on the right: a move to the left widens it
    expect(last()).toEqual([600, true]);
    fireEvent.mouseMove(document, { clientX: 0 });
    expect(last()).toEqual([640, true]);
    fireEvent.mouseMove(document, { clientX: 5000 });
    expect(last()).toEqual([280, true]);
    fireEvent.mouseMove(document, { clientX: 1050 });
    expect(last()).toEqual([450, true]);

    expect(events).toEqual([]);
    expect(stored()).toBe('500');
    expect(bodyStyles()).toEqual(['col-resize', 'none']);
  });

  it('the mouseup stores the dragged width with one pref event, renders no other width on the way and ends the drag', () => {
    render(<StrictMode><Host /></StrictMode>);
    const events = storeEvents();
    fireEvent.mouseDown(handle(), { clientX: 1000 });
    fireEvent.mouseMove(document, { clientX: 900 });
    expect(last()).toEqual([484, true]);

    const before = log.length;
    fireEvent.mouseUp(document);
    const renders = log.slice(before);
    // Rendered again, and never with the old stored 384 between the dragged 484 and the stored one.
    expect(renders.length).toBeGreaterThan(0);
    expect(renders).toEqual(renders.map(() => [484, false]));
    expect(stored()).toBe('484');
    expect(events).toEqual([{ kind: 'pref', id: 'sidebarWidth' }]);
    expect(bodyStyles()).toEqual(['', '']);

    // The drag's listeners are gone: the mouse moves nothing, and another mouseup stores nothing.
    const settled = log.length;
    fireEvent.mouseMove(document, { clientX: 500 });
    fireEvent.mouseUp(document);
    expect(log).toHaveLength(settled);
    expect(events).toHaveLength(1);
    expect(stored()).toBe('484');
  });

  it('starts the next drag from the width the last one stored', () => {
    render(<Host />);
    fireEvent.mouseDown(handle(), { clientX: 1000 });
    fireEvent.mouseMove(document, { clientX: 900 });
    fireEvent.mouseUp(document);
    expect(last()).toEqual([484, false]);

    fireEvent.mouseDown(handle(), { clientX: 1000 });
    expect(last()).toEqual([484, true]);
    fireEvent.mouseMove(document, { clientX: 950 });
    expect(last()).toEqual([534, true]);
    fireEvent.mouseUp(document);
    expect(stored()).toBe('534');
  });

  it("an unmount mid-drag removes the drag's listeners and restores the body, and the mouse then stores nothing", () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    render(<Toggle />);
    const events = storeEvents();
    fireEvent.mouseDown(handle(), { clientX: 1000 });
    fireEvent.mouseMove(document, { clientX: 900 });
    expect(bodyStyles()).toEqual(['col-resize', 'none']);
    const drag = added.mock.calls.filter(([type]) => type === 'mousemove' || type === 'mouseup');
    expect(drag.map(([type]) => type)).toEqual(['mousemove', 'mouseup']);

    fireEvent.click(screen.getByText('Hide'));
    expect(screen.queryByTestId('handle')).toBeNull();
    expect(bodyStyles()).toEqual(['', '']);
    // React 19 drops an update to an unmounted component silently: a mousemove listener left behind shows only here.
    for (const [type, listener] of drag) expect(removed).toHaveBeenCalledWith(type, listener);
    fireEvent.mouseMove(document, { clientX: 800 });
    fireEvent.mouseUp(document);
    expect(stored()).toBeNull();
    expect(events).toEqual([]);
  });
});
