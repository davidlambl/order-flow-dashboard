// src/components/AppSettings.tsx
// The Settings dialog as App renders it: nothing while closed, settings/SettingsDialog while open. Mounted only while
// open, the dialog and the tab it shows read the store as they mount, so every open starts from what is stored with no
// effect copying it into state (the one-file dialog's two react-hooks/set-state-in-effect findings), and a tab's
// pending key edits are saved as it unmounts (SettingsDialog says why that is enough). The boundary around the dialog
// is mounted only while open too, so a close unmounts the dialog and its tab, whatever its chunk was doing.
//
// The dialog is a chunk of its own, loaded on demand: its four tabs and their hooks are code most visits never run. The
// idle preload App starts once the dashboard is up fetches it in the background, and an open that comes first fetches
// it then; a closed AppSettings requests nothing. Until the chunk is in, SettingsPlaceholder stands in for the dialog,
// its frame with a spinner where the tabs go, so the click answers at once and the dialog then fills that frame in
// place; a chunk that failed to load shows the same frame with the failure card, and it closes as the dialog does.
import ChunkBoundary from './ChunkBoundary.js';
import SettingsPlaceholder from './SettingsPlaceholder.js';
import { lazyWithPreload } from '../lib/lazyWithPreload.js';

const SettingsDialog = lazyWithPreload(() => import('./settings/SettingsDialog.js'), { idle: true });

interface AppSettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AppSettings({ isOpen, onClose }: AppSettingsProps) {
  if (!isOpen) return null;
  return (
    <ChunkBoundary
      fallback={<SettingsPlaceholder onClose={onClose} />}
      failed={(failure) => <SettingsPlaceholder onClose={onClose} failure={failure} />}
    >
      <SettingsDialog onClose={onClose} />
    </ChunkBoundary>
  );
}
