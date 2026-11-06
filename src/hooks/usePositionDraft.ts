// src/hooks/usePositionDraft.ts
// The position inputs' draft and its one writer (roadmap D10): the shown ticker's position as the inputs show it, the
// last edit typed or else the stored position, and the debounced save that stores the edit. It holds the saver, the
// edit, the store listener and the pagehide and unmount flushes. A save is written through whichever backend the
// store holds when it runs (at its timer or a flush), so whatever changes the backend or must see the stored position
// flushes first: flush() before the backend changes (an account switch, a sign-out), settle() at a ticker change. No
// save emits `store-changed`.

import { useCallback, useEffect, useState } from 'react';
import { getPosition, setPosition as storeSetPosition } from '../lib/store.js';
import type { Position } from '../lib/store.js';
import { subscribeStore } from '../lib/storeEvents.js';
import { createSaver } from '../lib/debouncedSaver.js';
import { useStoreObject } from './useStoreValue.js';

// Position edits are written once typing pauses, not per keystroke: each write is a localStorage
// write and, signed in, a cloud upsert (roadmap D10).
const POSITION_SAVE_DELAY_MS = 300;

/** An edit as typed: the two fields and the ticker they were typed for. */
interface PositionEdit extends Position {
  ticker: string;
}

// The value carries its ticker, so a save that runs after a ticker change still lands on the
// ticker it was typed for.
const savePosition = ({ ticker, costBasis, shares }: PositionEdit) => storeSetPosition(ticker, { costBasis, shares });

/** What usePositionDraft returns. */
export interface PositionDraft {
  /**
   * The average cost the inputs show: the last edit typed for this ticker, until the store changes under it or
   * settle() drops it; else the ticker's stored position.
   */
  costBasis: Position['costBasis'];
  /** The share count, from the same place. */
  shares: Position['shares'];
  /** The whole draft after an edit to either field: shown at once, stored once typing pauses. */
  update: (costBasis: number | null, shares: number | null) => void;
  /** Stores an edit still inside its debounce now, through the backend in use; the edit stays shown. */
  flush: () => void;
  /**
   * flush(), then the edit is dropped. For a ticker change, in the same handler as the new ticker: alone it shows the
   * stored position as last read, since a flush writes without telling the store's readers.
   */
  settle: () => void;
}

/**
 * The draft of `ticker`'s position. flush and settle keep one identity for the hook's life, so an effect or a memo can
 * list them: an effect that switches the account's backend depends on flush (a new one per render would re-run it on
 * every render), and the ticker change that calls settle goes into the market context's value.
 */
export function usePositionDraft(ticker: string): PositionDraft {
  // Position edits wait here until typing pauses (see update). One saver per mount; its pending
  // save is flushed before anything that must see the stored position or that changes the backend.
  const [positionSaver] = useState(() => createSaver<PositionEdit>({ delay: POSITION_SAVE_DELAY_MS }));

  // This ticker's stored position, re-read when it or the whole store changes. The inputs follow every keystroke
  // of an edit; the store (and through it the cloud) gets the value once typing pauses (roadmap D10).
  const storedPosition = useStoreObject(() => getPosition(ticker), ticker, 'position', ticker);
  // { ticker, costBasis, shares } while an edit is being typed
  const [edit, setEdit] = useState<PositionEdit | null>(null);
  const position = edit && edit.ticker === ticker ? edit : storedPosition;
  const { costBasis, shares } = position;

  const update = useCallback((newCost: number | null, newShares: number | null) => {
    setEdit({ ticker, costBasis: newCost, shares: newShares });
    positionSaver.schedule({ ticker, costBasis: newCost, shares: newShares }, savePosition);
  }, [ticker, positionSaver]);

  // A whole-store change (a cloud pull, an import, a sign-out) or this ticker's position changing elsewhere (another
  // tab) shows the stored position; an edit still inside its debounce is written first, so the inputs never jump
  // back while the store gets the new value. A detail for another item (a preference save, another ticker) does
  // nothing: with an unfiltered listener the same-value setEdit(null) alone re-rendered the caller, the whole App, on
  // every section toggle.
  useEffect(() => subscribeStore((detail) => {
    if (detail !== null && !(detail.kind === 'position' && detail.id === ticker)) return;
    positionSaver.flush();
    setEdit(null);
  }), [positionSaver, ticker]);

  // Closing the tab or unmounting inside the debounce saves the edit instead of dropping it.
  useEffect(() => {
    const onPageHide = () => { positionSaver.flush(); };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      positionSaver.flush();
    };
  }, [positionSaver]);

  const flush = useCallback(() => { positionSaver.flush(); }, [positionSaver]);

  const settle = useCallback(() => {
    positionSaver.flush(); // the old ticker's edit is stored before the new ticker's position shows
    setEdit(null);
  }, [positionSaver]);

  return { costBasis, shares, update, flush, settle };
}
