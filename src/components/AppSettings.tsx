// src/components/AppSettings.tsx
// The Settings dialog as App renders it: nothing while closed, settings/SettingsDialog while open. Mounted only while
// open, the dialog and the tab it shows read the store as they mount, so every open starts from what is stored with no
// effect copying it into state (the one-file dialog's two react-hooks/set-state-in-effect findings), and a tab's
// pending key edits are saved as it unmounts (SettingsDialog says why that is enough).
import SettingsDialog from './settings/SettingsDialog.js';

interface AppSettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AppSettings({ isOpen, onClose }: AppSettingsProps) {
  return isOpen ? <SettingsDialog onClose={onClose} /> : null;
}
