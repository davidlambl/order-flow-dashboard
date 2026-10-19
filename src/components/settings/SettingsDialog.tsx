// src/components/settings/SettingsDialog.tsx
// The Settings dialog, which AppSettings mounts only while open: the backdrop, the header with its close button, the
// tab bar and the tab it shows. Every open starts on the AI tab. Escape, the backdrop and the close button call
// onClose and nothing else: the parent then unmounts the dialog, and the tab saves its pending edits as it goes.
//
// Exactly one tab is mounted at a time, and the dialog relies on it. Each tab reads the store when it mounts and owns
// its autosaves, which flush in their unmount cleanup, so a key edit still inside its debounce is saved when the user
// switches tabs or closes the dialog, and every tab starts fresh from the store on each switch. It is also why Sign out
// and Sign in, on the Account tab, never run with a key edit pending: the AI and Data tabs flushed as the Account tab
// replaced them, so no save can land after the sign-out has cleared this browser's keys and write one back. If a second
// tab is ever kept mounted (hidden, say), the hand flush before signOut has to come back.
import { useEffect, useState } from 'react';
import { Cpu, Database, HardDrive, KeyRound, Settings, X } from 'lucide-react';
import AITab from './AITab.js';
import DataTab from './DataTab.js';
import AccountTab from './AccountTab.js';
import BackupTab from './BackupTab.js';

const TABS = [
  { id: 'ai', label: 'AI', icon: Cpu },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'account', label: 'Account', icon: KeyRound },
  { id: 'backup', label: 'Backup', icon: HardDrive },
] as const;

type TabId = (typeof TABS)[number]['id'];

interface SettingsDialogProps {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<TabId>('ai');

  // Bubble phase on window: the strategic context editor's capture-phase listener runs first and stops an Escape that
  // closes it, so one Escape never closes both.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => onClose()} />

      <div className="relative w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl">
        {/* Header + Tab bar */}
        <div className="sticky top-0 z-10 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-2.5">
              <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--color-purple-bg)]">
                <Settings size={14} className="text-[var(--color-purple)]" />
              </div>
              <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Settings</h2>
            </div>
            <button
              onClick={() => onClose()}
              aria-label="Close settings"
              className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex gap-1 px-6 pb-3">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
                    active
                      ? 'bg-[var(--color-surface-2)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] shadow-sm'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'
                  }`}
                >
                  <Icon size={12} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {activeTab === 'ai' && <AITab />}
        {activeTab === 'data' && <DataTab />}
        {activeTab === 'account' && <AccountTab />}
        {activeTab === 'backup' && <BackupTab />}
      </div>
    </div>
  );
}
