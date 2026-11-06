// src/components/dashboard/SyncChoiceLayer.tsx
// Where the sync choice shows while its module loads or after it failed to (App puts a spinner or the failure card in
// it). SyncChoice is blocking on purpose, and so is this: a layer over the whole page, dimmed like the dialog's own, so
// nothing underneath can be clicked while the conflict waits for a choice. Like the dialog it is modal, named "Sync
// your data" and takes the focus as it opens, so nothing underneath is typed into either.
import type { ReactNode } from 'react';

interface SyncChoiceLayerProps {
  /** The dialog's module is still loading: the layer is marked busy. */
  loading?: boolean;
  children: ReactNode;
}

/** Moves the focus into the element as it mounts. Module level, so that a re-render does not call it again. */
const focusOnMount = (element: HTMLElement | null) => { element?.focus(); };

export default function SyncChoiceLayer({ loading = false, children }: SyncChoiceLayerProps) {
  return (
    <div
      ref={focusOnMount}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Sync your data"
      aria-busy={loading || undefined}
      className="fixed inset-0 z-[120] flex items-center justify-center outline-none"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-sm mx-4">{children}</div>
    </div>
  );
}
