// src/hooks/useResizableSidebar.ts
// The chat sidebar's width for App's aside and the resize handle beside it: the stored width, followed through
// useStoreValue, or the mouse's while the handle is dragged. Nothing is stored until the mouseup, which saves the
// dragged width through savePreference (one `store-changed`, with a `pref` detail); an unmount mid-drag removes the
// drag's document listeners and the body's drag styles, and stores nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { getPreference } from '../lib/store.js';
import { savePreference } from '../lib/storeEvents.js';
import { useStoreValue } from './useStoreValue.js';

const SIDEBAR_DEFAULT = 384;
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 640;

// The stored sidebar width when this layout can show it; the default otherwise. Module level: a snapshot function
// with a new identity per render costs React a passive effect to re-check it.
const readSidebarWidth = (): number => {
  const n = getPreference('sidebarWidth');
  return typeof n === 'number' && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : SIDEBAR_DEFAULT;
};

/** What useResizableSidebar returns. */
export interface ResizableSidebar {
  /** The aside's width in px: the dragged width during a drag, else the stored one, else the default. */
  width: number;
  /** A drag is under way: App drops the aside's transition and lights the handle. */
  isResizing: boolean;
  /** The handle's onMouseDown: starts a drag from the width shown. */
  onResizeStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
}

export function useResizableSidebar(): ResizableSidebar {
  // The sidebar is as wide as the store says, except during a drag, when it follows the mouse.
  const savedWidth = useStoreValue(readSidebarWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null); // the width under the mouse during a drag
  const isResizing = dragWidth !== null;
  const width = dragWidth ?? savedWidth;

  const dragCleanupRef = useRef<(() => void) | null>(null);

  // A new handler whenever the width changes (it starts a drag from it): the handle is a plain div, so nothing
  // memoises on its identity.
  const onResizeStart = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    setDragWidth(startW);

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + delta));
      setDragWidth(w);
    };
    // The mouseup stores the dragged width, then hands the aside back to the store. The order is defensive: React
    // batches the two updates into one render whichever comes first, and that one render is what keeps the width
    // from moving.
    const cleanup = () => {
      savePreference('sidebarWidth', w);
      setDragWidth(null);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', cleanup);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', cleanup);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', cleanup);
  }, [width]);

  useEffect(() => {
    return () => { if (dragCleanupRef.current) dragCleanupRef.current(); };
  }, []);

  return { width, isResizing, onResizeStart };
}
