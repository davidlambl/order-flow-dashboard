// src/components/settings/SettingsDialog.tsx
// The Settings dialog, which AppSettings mounts only while open: a modal dialog (ModalDialog) named by its heading,
// the header with its close button, the tab list and the tab it shows. Every open starts on the AI tab, with focus on
// it; Left and Right move to and select the neighbouring tab, wrapping, Home and End the first and the last, as a click
// on a tab does. Escape, a press outside the panel and the close button call onClose and nothing else: the parent then
// unmounts the dialog, the browser puts focus back on whatever opened it, and the tab saves its pending edits as it
// goes.
//
// Exactly one tab is mounted at a time, and the dialog relies on it. Each tab reads the store when it mounts and owns
// its autosaves, which flush in their unmount cleanup, so a key edit still inside its debounce is saved when the user
// switches tabs (by a click or a key) or closes the dialog, and every tab starts fresh from the store on each switch.
// It is also why Sign out and Sign in, on the Account tab, never run with a key edit pending: the AI and Data tabs
// flushed as the Account tab replaced them, so no save can land after the sign-out has cleared this browser's keys and
// write one back. If a second tab is ever kept mounted (hidden, say), the hand flush before signOut has to come back.
// The one tab panel is a single element that every tab controls, labelled by the selected tab.
// The panel scrolls under its sticky header (the title and the tab list): its scroll padding, 8rem and more than the
// header's height, is what a browser leaves above a control it scrolls into view for focus, so Shift+Tab never puts the
// focused control under the header (WCAG 2.4.11). SettingsPlaceholder's panel carries the same classes.
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Cpu, Database, HardDrive, KeyRound, Settings, X } from 'lucide-react';
import ModalDialog from '../ModalDialog.js';
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

/** The tab a key moves to from the tab at `index`, or null for a key the tab list does not handle. */
function tabFor(key: string, index: number): number | null {
  switch (key) {
    case 'ArrowRight': return (index + 1) % TABS.length;
    case 'ArrowLeft': return (index - 1 + TABS.length) % TABS.length;
    case 'Home': return 0;
    case 'End': return TABS.length - 1;
    default: return null;
  }
}

interface SettingsDialogProps {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<TabId>('ai');
  const id = useId();
  const titleId = `${id}-title`;
  const panelId = `${id}-panel`;
  const tabId = (tab: TabId) => `${id}-tab-${tab}`;
  const selectedTab = useRef<HTMLButtonElement>(null);

  // Bubble phase on window: the strategic context editor's capture-phase listener runs first and stops an Escape that
  // closes it, so one Escape never closes both.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleTabKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = tabFor(e.key, index);
    if (next === null) return;
    e.preventDefault();
    setActiveTab(TABS[next].id);
    document.getElementById(tabId(TABS[next].id))?.focus();
  };

  return (
    <ModalDialog
      labelledBy={titleId}
      initialFocus={selectedTab}
      onDismiss={onClose}
      backdropClassName="backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="relative w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto scroll-pt-32 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl">
        {/* Header + Tab bar */}
        <div className="sticky top-0 z-10 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-2.5">
              <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--color-purple-bg)]">
                <Settings size={14} className="text-[var(--color-purple)]" />
              </div>
              <h2 id={titleId} className="text-sm font-semibold text-[var(--color-text-primary)]">Settings</h2>
            </div>
            <button
              onClick={() => onClose()}
              aria-label="Close settings"
              className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          {/* The row scrolls sideways where it does not fit (it fits a 375 px screen with nothing to spare); the top
              padding, taken back by the negative margin, keeps a focused tab's outline clear of the scroll clip. */}
          <div role="tablist" aria-label="Settings sections" className="flex gap-1 -mt-1 pt-1 px-6 pb-3 overflow-x-auto scroll-px-6">
            {TABS.map((tab, index) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={active ? selectedTab : undefined}
                  type="button"
                  role="tab"
                  id={tabId(tab.id)}
                  aria-selected={active}
                  aria-controls={panelId}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, index)}
                  className={`flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
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

        <div role="tabpanel" id={panelId} aria-labelledby={tabId(activeTab)}>
          {activeTab === 'ai' && <AITab />}
          {activeTab === 'data' && <DataTab />}
          {activeTab === 'account' && <AccountTab />}
          {activeTab === 'backup' && <BackupTab />}
        </div>
      </div>
    </ModalDialog>
  );
}
