// src/components/SettingsPlaceholder.tsx
// The Settings dialog's frame without the dialog, which AppSettings shows while settings/SettingsDialog's chunk loads
// and if it fails to: a modal dialog (ModalDialog) named "Settings" like the dialog's, with the panel and the header
// (the title and the close button) in the dialog's own classes, a spinner on the tab list's line while the chunk loads,
// or the failure card in the body once it has failed (Try again imports again; Reload is the way out for a tab whose
// old files a deploy removed). It holds focus itself, having nothing to offer but the close button. A click on Settings
// answers at once with it, and once the chunk is in this dialog closes and the loaded one opens in the same commit,
// remembering the same opener, so the only movement is the panel growing to fit the body. A press outside the panel,
// the close button and Escape call onClose, as on the dialog, Escape heard on window in the bubble phase, so the
// strategic context editor's capture-phase listener still takes an Escape first. It lives outside settings/, the chunk
// it stands in for, and loads with the entry.
//
// The card sits here and not in the boundary's place: a boundary's `failed` UI replaces its default card, and the frame
// has to be the failed UI, not the boundary's parent, since the dialog brings a frame of its own once it loads.
// AppSettings.lazy.test.jsx keeps this frame alike with the dialog's.
import { useEffect, useId } from 'react';
import { LoaderCircle, Settings, X } from 'lucide-react';
import ChunkFailureCard from './ChunkFailureCard.js';
import ModalDialog from './ModalDialog.js';

interface SettingsPlaceholderProps {
  onClose: () => void;
  /** ChunkBoundary's failure once the dialog's chunk has failed to load: the body shows the card, retry its Try again. */
  failure?: { retry: () => void };
}

export default function SettingsPlaceholder({ onClose, failure }: SettingsPlaceholderProps) {
  const titleId = `${useId()}-title`;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <ModalDialog
      labelledBy={titleId}
      onDismiss={onClose}
      backdropClassName="backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="relative w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl">
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
          {!failure && (
            <div className="flex gap-1 -mt-1 pt-1 px-6 pb-3 overflow-x-auto scroll-px-6">
              {/* A tab button's box (text-xs, py-1.5, a 1px border), so the header is as tall as it is with the tabs. */}
              <p role="status" className="flex items-center gap-1.5 px-3 py-1.5 border border-transparent text-xs font-medium text-[var(--color-text-muted)]">
                <LoaderCircle size={12} className="animate-spin" />
                Loading…
              </p>
            </div>
          )}
        </div>

        {failure && (
          <div className="p-6">
            <ChunkFailureCard retry={failure.retry} />
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
