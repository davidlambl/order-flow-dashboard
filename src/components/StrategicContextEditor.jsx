// src/components/StrategicContextEditor.jsx
// Full-screen modal editor for the Strategic Context document.
import { useState, useEffect, useCallback, useRef } from 'react';
import { X, FileText, Check } from 'lucide-react';
import { getPreference, setPreference } from '../lib/store';
import useAutoSave from '../hooks/useAutoSave';

export default function StrategicContextEditor({ isOpen, onClose }) {
  const [content, setContent] = useState('');
  const textareaRef = useRef(null);

  const save = useCallback((val) => {
    setPreference('strategic_context', val?.trim() || null);
  }, []);

  const { saved, reset, flush } = useAutoSave(content, save, 1000);

  const handleClose = useCallback(() => {
    flush();
    onClose();
  }, [flush, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setContent(getPreference('strategic_context') ?? '');
    reset();
    // Focus textarea after mount
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [isOpen, reset]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); handleClose(); }
    };
    window.addEventListener('keydown', handleKeyDown, true); // capture phase to beat AppSettings
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const charCount = content.length;
  const lineCount = content ? content.split('\n').length : 0;

  return (
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
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste your strategic context here — macro thesis, position notes, earnings expectations, decision rules, trim ladders, etc. This is appended to every AI Co-Pilot conversation as context."
            spellCheck={false}
            className="w-full h-full min-h-0 bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] font-mono leading-relaxed rounded-lg px-4 py-3 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors resize-none"
          />
        </div>
      </div>
    </div>
  );
}
