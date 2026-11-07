// src/components/StrategicContextEditor.tsx
// Full-screen modal editor for the Strategic Context document, which the chat and Settings' Backup tab open. It
// renders only while open, and the dialog itself (StrategicContextDialog.tsx: the text, its autosave, the closes that
// save first) is loaded on demand, on the first opening or before it in the idle preload. Until the dialog is in, and
// if it cannot load, the editor is still a modal over whatever opened it: a backdrop at the dialog's z-index with a
// spinner, or the failure card, whose Try again imports the dialog again. The boundary's default card would render
// where the boundary sits, in the opener's layout, so the card is put in the modal through `failed`.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle } from 'lucide-react';
import { lazyWithPreload } from '../lib/lazyWithPreload.js';
import ChunkBoundary from './ChunkBoundary.js';
import ChunkFailureCard from './ChunkFailureCard.js';

const StrategicContextDialog = lazyWithPreload(() => import('./StrategicContextDialog.js'), { idle: true });

interface StrategicContextEditorProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The modal around what stands in for the dialog: the backdrop and Escape close the editor alone, Escape in the capture
 * phase and stopped, as the dialog stops it, so the Settings dialog's window listener under it never sees the key.
 */
function EditorModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => onClose()} />
      {children}
    </div>,
    document.body,
  );
}

export default function StrategicContextEditor({ isOpen, onClose }: StrategicContextEditorProps) {
  if (!isOpen) return null;
  return (
    <ChunkBoundary
      fallback={(
        <EditorModal onClose={onClose}>
          <div role="status" aria-label="Loading the strategic context editor" className="relative">
            <LoaderCircle size={24} className="animate-spin text-[var(--color-accent)]" />
          </div>
        </EditorModal>
      )}
      failed={({ retry }) => (
        <EditorModal onClose={onClose}>
          <div className="relative w-full max-w-sm mx-4 rounded-xl shadow-2xl">
            <ChunkFailureCard retry={retry} />
          </div>
        </EditorModal>
      )}
    >
      <StrategicContextDialog onClose={onClose} />
    </ChunkBoundary>
  );
}
