// src/components/dashboard/SyncChoiceLayer.tsx
// Where the sync choice shows while its module loads or after it failed to (App puts a spinner or the failure card in
// it). SyncChoice is blocking on purpose, and so is this: a modal dialog (ModalDialog) over the whole page, dimmed like
// the choice's own, that nothing dismisses (App unmounts it), so nothing underneath can be clicked or typed into while
// the conflict waits for a choice. Like the choice it is named "Sync your data", and it holds focus itself as it opens.
import type { ReactNode } from 'react';
import ModalDialog from '../ModalDialog.js';

interface SyncChoiceLayerProps {
  /** The dialog's module is still loading: the layer is marked busy. */
  loading?: boolean;
  children: ReactNode;
}

export default function SyncChoiceLayer({ loading = false, children }: SyncChoiceLayerProps) {
  return (
    <ModalDialog label="Sync your data" busy={loading} backdropClassName="backdrop:bg-black/60 backdrop:backdrop-blur-sm">
      <div className="relative w-full max-w-sm mx-4">{children}</div>
    </ModalDialog>
  );
}
