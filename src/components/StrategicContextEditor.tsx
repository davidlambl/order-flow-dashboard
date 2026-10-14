// src/components/StrategicContextEditor.tsx
// Full-screen modal editor for the Strategic Context document. The dialog mounts only while open, so each opening
// starts from the stored text without an effect copying it into state; it saves through savePreference, so a component
// following the preference through the store events (usePreference) shows each save.
import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, FileText, Check } from 'lucide-react';
import { getPreference } from '../lib/store.js';
import { savePreference } from '../lib/storeEvents.js';
import { useAutoSave } from '../hooks/useAutoSave.js';

interface StrategicContextEditorProps {
  isOpen: boolean;
  onClose: () => void;
}

/** The stored document as text: a hand-edited import or cloud row can hold a number, which has no .split(). */
function readStrategicContext(): string {
  const value = getPreference('strategic_context');
  return typeof value === 'string' ? value : '';
}

/** Stored trimmed; an emptied document removes the preference. */
function saveStrategicContext(value: string): void {
  savePreference('strategic_context', value.trim() || null);
}

function EditorDialog({ onClose }: { onClose: () => void }) {
  // Read once per opening: the textarea's first value and the autosave's baseline, so it is never written back.
  const [loaded] = useState(readStrategicContext);
  const [content, setContent] = useState(loaded);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { schedule, flush, saved } = useAutoSave(saveStrategicContext, 1000, loaded);

  // Flushed before onClose, not left to the unmount: the parent's onClose may read the store.
  const handleClose = useCallback(() => {
    flush();
    onClose();
  }, [flush, onClose]);

  // Focus textarea after mount
  useEffect(() => {
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // Escape to close, in the capture phase: this runs before the Settings dialog's window listener, and
  // stopPropagation keeps that one from closing Settings on the same key.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); handleClose(); }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleClose]);

  const charCount = content.length;
  const lineCount = content ? content.split('\n').length : 0;

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative w-full max-w-3xl mx-4 h-[75vh] max-h-[90vh] min-h-[300px] flex flex-col rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl overflow-hidden sm:resize">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border-subtle)] shrink-0">
          <div className="flex items-center gap-2.5">
            <FileText size={14} className="text-[var(--color-accent)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Strategic Context</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums">
              {charCount.toLocaleString()} chars · {lineCount} lines
            </span>
            {saved && (
              <span className="text-[10px] text-[var(--color-bull)] fade-in flex items-center gap-1">
                <Check size={10} /> Saved
              </span>
            )}
            <button
              onClick={handleClose}
              aria-label="Close strategic context editor"
              className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 min-h-0 p-4">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => { setContent(e.target.value); schedule(e.target.value); }}
            placeholder="Paste your strategic context here — macro thesis, position notes, earnings expectations, decision rules, trim ladders, etc. This is appended to every AI Co-Pilot conversation as context."
            spellCheck={false}
            className="w-full h-full min-h-0 bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] font-mono leading-relaxed rounded-lg px-4 py-3 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors resize-none"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function StrategicContextEditor({ isOpen, onClose }: StrategicContextEditorProps) {
  return isOpen ? <EditorDialog onClose={onClose} /> : null;
}
