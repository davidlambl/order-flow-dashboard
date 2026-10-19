// src/components/settings/BackupTab.tsx
// The Backup tab: the strategic context (a preview of the stored document, the editor it opens, Clear), then exporting
// everything but the API keys to a JSON file and importing one behind a confirm, then Reset all settings.
import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Check, CircleAlert, Download, FileText, HardDrive, Pencil, RotateCcw, Upload } from 'lucide-react';
import { exportAll, getPreference, importAll } from '../../lib/store.js';
import { savePreference } from '../../lib/storeEvents.js';
import { useStoreValue } from '../../hooks/useStoreValue.js';
import { useAuth } from '../../contexts/AuthContext.js';
import StrategicContextEditor from '../StrategicContextEditor.js';

/** What an import wrote, and the settings in the file it did not take, for the report under the buttons. */
interface ImportReport {
  positions: number;
  chats: number;
  prefs: number;
  skipped: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The stored document as text, guarded as the editor reads it: a hand-edited import or cloud row can hold a number,
 * which has no .trim(). The preview follows it through the store events, so the editor's saves, Clear and an import
 * all show without a re-read here.
 */
function readStrategicContext(): string {
  const value = getPreference('strategic_context');
  return typeof value === 'string' ? value : '';
}

export default function BackupTab() {
  const { userEmail } = useAuth();
  const contextPreview = useStoreValue(readStrategicContext);
  const [contextEditorOpen, setContextEditorOpen] = useState(false);
  const closeContextEditor = useCallback(() => setContextEditorOpen(false), []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus] = useState<'success' | 'error' | null>(null);
  const [importError, setImportError] = useState('');
  const [importReport, setImportReport] = useState<ImportReport | null>(null);

  // ── Reset all settings ──
  // No key edit can land after the reset: the AI and Data tabs, where the keys are typed, are not mounted while this
  // one shows, and they flushed their edits when it replaced them. The model list reloads, and its fallback stores a
  // model again, when the AI tab next mounts.
  const handleReset = useCallback(() => {
    if (!window.confirm('Reset all settings? This will clear your API keys, model selection, and data source keys. This cannot be undone.')) return;
    const settingKeys = [
      'ai_provider', 'ai_model', 'ai_model_name',
      'ai_key_anthropic', 'ai_key_openai', 'ai_key_gemini',
      'data_tradier_key', 'data_finnhub_key',
    ];
    for (const key of settingKeys) savePreference(key, null);
    window.dispatchEvent(new CustomEvent('data-source-changed'));
  }, []);

  // ── Export / Import ──
  const handleExport = useCallback(() => {
    const blob = exportAll();
    const json = JSON.stringify(blob, null, 2);
    const file = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ofd-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleImport = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data: unknown = JSON.parse(reader.result as string); // readAsText: a string once loaded
        // An import replaces what is here (and, signed in, the account's copy): ask first. A "no"
        // changes nothing and shows nothing.
        const where = userEmail ? ' and in your cloud account' : '';
        if (!window.confirm(`Import replaces the positions, chat histories and settings on this device${where}. API keys on this device are kept. Continue?`)) {
          setImportStatus(null);
          setImportError('');
          setImportReport(null);
          return;
        }
        const result = importAll(data);
        setImportReport({
          positions: result.imported.positions,
          chats: result.imported.chats,
          prefs: result.imported.prefs,
          skipped: result.skipped,
        });
        setImportStatus('success');
        setImportError('');
        // The preview follows on its own: importAll dispatches store-changed.
      } catch (err) {
        setImportStatus('error');
        setImportError((err as Error).message || 'Invalid file format.');
      }
    };
    reader.onerror = () => {
      setImportStatus('error');
      setImportError('Failed to read file.');
    };
    reader.readAsText(file);
    e.target.value = ''; // reset now, so picking the same file again (after a "no") fires onChange
  }, [userEmail]);

  return (
    <div className="p-6 space-y-5 fade-in">
      {/* Strategic Context */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
            <FileText size={12} />
            Strategic Context
          </div>
          <div className="flex items-center gap-2">
            {contextPreview.trim() && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Clear all strategic context?')) {
                    savePreference('strategic_context', null);
                  }
                }}
                className="text-[10px] text-[var(--color-bear)] hover:text-[var(--color-bear)]/80 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {contextPreview.trim() ? (
          <button
            type="button"
            onClick={() => setContextEditorOpen(true)}
            className="w-full text-left rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3 hover:border-[var(--color-text-muted)] transition-colors group"
          >
            <div className="text-[11px] text-[var(--color-text-secondary)] font-mono leading-relaxed whitespace-pre-wrap break-words">
              {contextPreview.split('\n').slice(0, 4).join('\n')}{contextPreview.split('\n').length > 4 ? ' …' : ''}
            </div>
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-[var(--color-border-subtle)]">
              <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums">
                {contextPreview.length.toLocaleString()} characters · {contextPreview.split('\n').length} lines
              </span>
              <span className="text-[11px] text-[var(--color-accent)] group-hover:text-[var(--color-accent-hover)] flex items-center gap-1 font-medium">
                <Pencil size={11} /> Edit
              </span>
            </div>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setContextEditorOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-4 text-xs font-medium rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]/30 transition-colors"
          >
            <FileText size={14} />
            Add strategic context for the AI Co-Pilot
          </button>
        )}

        <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
          Appended to every AI conversation. Use for macro thesis, position notes, earnings expectations, decision rules.
        </p>
      </section>

      <StrategicContextEditor isOpen={contextEditorOpen} onClose={closeContextEditor} />

      <hr className="border-[var(--color-border-subtle)]" />

      {/* Data Management */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
          <HardDrive size={12} />
          Data Management
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleExport}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          >
            <Download size={12} /> Export
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          >
            <Upload size={12} /> Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </div>

        {importStatus === 'success' && importReport && (
          <div role="status" className="flex items-start gap-1.5 text-[11px] leading-relaxed">
            <Check size={11} className="shrink-0 mt-px text-[var(--color-bull)]" />
            <div className="min-w-0">
              <p className="text-[var(--color-bull)]">
                Imported {plural(importReport.positions, 'position')}, {plural(importReport.chats, 'chat')}, {plural(importReport.prefs, 'setting')}.
              </p>
              {importReport.skipped.length > 0 && (
                <p className="text-[10px] text-[var(--color-text-muted)] break-words">
                  Not imported: {importReport.skipped.join(', ')}
                </p>
              )}
            </div>
          </div>
        )}
        {importStatus === 'error' && (
          <div className="flex items-start gap-1.5 text-[11px] text-[var(--color-bear)] leading-relaxed">
            <CircleAlert size={11} className="shrink-0 mt-px" />
            <span>{importError}</span>
          </div>
        )}

        <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
          Exports positions, chat histories and settings as JSON. API keys are{' '}
          <strong className="font-medium text-[var(--color-text-secondary)]">never</strong>{' '}
          exported, and an import keeps the ones on this device. An import replaces the data on this device
          {userEmail ? ' and in your cloud account' : ''}.
        </p>
      </section>

      <hr className="border-[var(--color-border-subtle)]" />

      {/* Reset */}
      <button
        onClick={handleReset}
        className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-bear)] transition-colors"
      >
        <RotateCcw size={11} />
        Reset all settings
      </button>
    </div>
  );
}
