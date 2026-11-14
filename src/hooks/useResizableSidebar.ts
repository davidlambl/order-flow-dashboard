// src/hooks/useResizableSidebar.ts
// The chat sidebar's width for App, and the resize handle beside it: a separator that a pointer (a mouse, a finger or
// a pen) drags and the keyboard steps. The width is the stored one, followed through useStoreValue, except while it
// moves.
// - A drag follows the pointer, which the handle captures so that its moves and its release come to the handle
//   wherever the pointer goes, and stores nothing until the pointerup, which saves the dragged width through
//   savePreference (one `store-changed`, with a `pref` detail). A pointercancel (a touch the browser took for a
//   gesture) ends the drag with nothing stored and the stored width back. Only the primary button (a mouse's left
//   button, a finger, a pen's tip) starts a drag, and only one at a time. The drag listens on document, where the
//   captured events bubble and where the release still arrives if the handle goes away mid-drag (a window narrowed
//   under md, where App shows no handle); an unmount mid-drag removes those listeners and the body's drag styles, and
//   stores nothing. A move that leaves the width where it is (a vertical move, a move past a bound, a sub-pixel move
//   rounded away) keeps the same state, so React skips the render: App and every child it does not memoise would
//   otherwise render once per pointermove.
// - The keys: the handle sits on the sidebar's left edge, so ArrowLeft widens it by 16 px and ArrowRight narrows it;
//   Home and End go to the bounds. The width follows each key at once and is stored once, when a key is released or
//   the handle loses focus: sidebarWidth syncs, and storing on every repeat of a held key would queue a cloud write per
//   repeat. An arrow with Alt, Ctrl or Meta is the browser's (history, word moves), and is left alone.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { getPreference } from '../lib/store.js';
import { savePreference } from '../lib/storeEvents.js';
import { useStoreValue } from './useStoreValue.js';

const SIDEBAR_DEFAULT = 384;
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 640;
/** How far one arrow key moves the handle, in px. */
const KEY_STEP = 16;

const clampWidth = (w: number): number => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));

// The stored sidebar width when this layout can show it; the default otherwise. Module level: a snapshot function
// with a new identity per render costs React a passive effect to re-check it.
const readSidebarWidth = (): number => {
  const n = getPreference('sidebarWidth');
  return typeof n === 'number' && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : SIDEBAR_DEFAULT;
};

/** Where `key` takes the width from `w`, or null for a key the handle does not use. */
function keyedWidth(key: string, w: number): number | null {
  switch (key) {
    case 'ArrowLeft': return clampWidth(w + KEY_STEP);
    case 'ArrowRight': return clampWidth(w - KEY_STEP);
    case 'Home': return SIDEBAR_MIN;
    case 'End': return SIDEBAR_MAX;
    default: return null;
  }
}

/** A width shown but not stored yet: a drag's, or the keys' until a key is released. */
interface Unstored {
  width: number;
  by: 'pointer' | 'keys';
}

/** What App spreads on the handle, next to its role, name, aria-controls and tabIndex. */
export interface SidebarHandleProps {
  /** Starts a drag from the width shown: the primary button only, one drag at a time. */
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  /** Left and Right step the width by 16 px, Home and End take it to the bounds, at once and unstored. */
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  /** A key's release stores what the keys moved. */
  onKeyUp: () => void;
  /** So does the handle losing focus with a key still held. */
  onBlur: () => void;
  /** The width shown, and its bounds: the separator's value. */
  'aria-valuenow': number;
  /** The width shown in words ("384 pixels"), so a screen reader does not read a bare number. */
  'aria-valuetext': string;
  'aria-valuemin': number;
  'aria-valuemax': number;
}

/** What useResizableSidebar returns. */
export interface ResizableSidebar {
  /** The sidebar's width in px: the dragged or keyed width while it is unstored, else the stored one, else the default. */
  width: number;
  /** A drag is under way: App drops the sidebar's transition and lights the handle. The keys leave the transition on. */
  isResizing: boolean;
  /** The handle's event handlers and value. */
  handleProps: SidebarHandleProps;
}

export function useResizableSidebar(): ResizableSidebar {
  // The sidebar is as wide as the store says, except while a drag or the keys move it.
  const savedWidth = useStoreValue(readSidebarWidth);
  const [unstored, setUnstored] = useState<Unstored | null>(null);
  const width = unstored?.width ?? savedWidth;
  const isResizing = unstored?.by === 'pointer';

  /** Ends the drag under way, storing nothing: set while one is. */
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // New handlers on every render: they start from the width shown, and the handle is a plain element that nothing
  // memoises on.
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || dragCleanupRef.current) return;
    e.preventDefault(); // no text selection or native drag from the handle
    const handle = e.currentTarget;
    const { pointerId } = e;
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    handle.setPointerCapture(pointerId);
    setUnstored({ width: startW, by: 'pointer' }); // a width the keys held but had not stored is the drag's from here

    // Another pointer's events (a second finger) are not this drag's.
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      w = clampWidth(Math.round(startW + startX - ev.clientX)); // the sidebar is on the right: leftwards widens it
      // This move's width, not `w` itself: React may run the updater later, after more moves have changed `w`. The
      // same state back when the width is unchanged lets React skip the render.
      const next = w;
      setUnstored((shown) => (shown?.by === 'pointer' && shown.width === next ? shown : { width: next, by: 'pointer' }));
    };
    // The pointerup stores the dragged width, then hands the sidebar back to the store. The order is defensive: React
    // batches the two updates into one render whichever comes first, and that one render is what keeps the width
    // from moving.
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      savePreference('sidebarWidth', w);
      setUnstored(null);
      end();
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      setUnstored(null);
      end();
    };
    const end = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      // The browser releases the capture itself after a pointerup or a pointercancel; an unmount mid-drag releases it.
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = end;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (isResizing || e.altKey || e.ctrlKey || e.metaKey) return;
    const next = keyedWidth(e.key, width);
    if (next === null) return;
    e.preventDefault(); // Home and End would scroll the page, an arrow a scrolling ancestor
    if (next !== width) setUnstored({ width: next, by: 'keys' });
  };

  const storeKeyedWidth = () => {
    if (unstored?.by !== 'keys') return;
    savePreference('sidebarWidth', unstored.width);
    setUnstored(null);
  };

  useEffect(() => {
    return () => { if (dragCleanupRef.current) dragCleanupRef.current(); };
  }, []);

  return {
    width,
    isResizing,
    handleProps: {
      onPointerDown,
      onKeyDown,
      onKeyUp: storeKeyedWidth,
      onBlur: storeKeyedWidth,
      'aria-valuenow': width,
      'aria-valuetext': `${width} pixels`,
      'aria-valuemin': SIDEBAR_MIN,
      'aria-valuemax': SIDEBAR_MAX,
    },
  };
}
