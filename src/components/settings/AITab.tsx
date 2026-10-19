// src/components/settings/AITab.tsx
// The AI tab: the provider picker, the provider's API key (saved trimmed 800 ms after the last edit, and tested on
// demand) and the model, each kept in the store, where the chat reads them for every message it sends (getAISettings).
//
// The model list comes from useAIModels on the SAVED key, so it reloads when a key is saved, not on every keystroke:
// the one-file dialog requested it twice per open and once per keystroke. Test and Refresh models act on the key in
// the field: a successful Test saves it, and Refresh saves it before it reloads, so the list follows the field.
import { useCallback, useEffect, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, RefreshCw, Star } from 'lucide-react';
import { getPreference } from '../../lib/store.js';
import { savePreference } from '../../lib/storeEvents.js';
import { AI_PROVIDERS, KEY_PREF, isLlmProvider, providerMeta } from '../../lib/aiSettings.js';
import { useAutoSave } from '../../hooks/useAutoSave.js';
import { useStoreValue } from '../../hooks/useStoreValue.js';
import { useAIModels } from '../../hooks/useAIModels.js';
import { useKeyTester } from '../../hooks/useKeyTester.js';
import SecretInput from './SecretInput.js';

// The store's AI settings as this tab reads them: an import or a cloud row can hold any JSON under a known name, and
// an object would come back as a fresh object on every read, which loops useSyncExternalStore. A stored provider id
// outside the picker's is kept as the chat sends it (getAISettings), with no button lit.

/** The stored provider id; 'anthropic' when none is stored. */
function readProvider(): string {
  const value = getPreference('ai_provider');
  return typeof value === 'string' && value ? value : 'anthropic';
}

/** The stored model id; '' for none (the server's default). */
function readModel(): string {
  const value = getPreference('ai_model');
  return typeof value === 'string' ? value : '';
}

/**
 * A provider's stored key, '' for none. A picker id reads its typed preference (KEY_PREF); any other stored id (an
 * import can write one) reads the name getAISettings builds, so the tab and the chat agree on the key for every id.
 */
function readKey(provider: string): string {
  const value = isLlmProvider(provider) ? getPreference(KEY_PREF[provider]) : getPreference(`ai_key_${provider}`);
  return typeof value === 'string' ? value : '';
}

export default function AITab() {
  const provider = useStoreValue(readProvider);
  const savedModel = useStoreValue(readModel);
  const readSavedKey = useCallback(() => readKey(provider), [provider]);
  const savedKey = useStoreValue(readSavedKey);
  const meta = providerMeta(provider);

  // The text in each provider's key field, read once as the tab mounts. The store holds each one trimmed, after the
  // debounce; the field keeps what was typed.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({
    anthropic: readKey('anthropic'),
    openai: readKey('openai'),
    gemini: readKey('gemini'),
  }));
  const draft = drafts[provider] ?? '';

  const saveKey = useCallback((value: string) => {
    savePreference(`ai_key_${provider}`, value.trim() || null);
  }, [provider]);
  // Primed with the key as loaded (the third argument is read once, at mount), so a loaded key is never written back;
  // a provider switch primes the next provider's.
  const { saved, prime, schedule, flush } = useAutoSave(saveKey, 800, draft);
  const { status: testStatus, error: testError, test, reset: resetTest } = useKeyTester();
  const { models, loading, error: modelError, refresh } = useAIModels(provider, savedKey || null);
  const hasModels = models.length > 0;

  // A stored model the list does not offer (none yet, another provider's, a retired one) gives way to the list's
  // first, as the one-file dialog did whenever a list loaded. Only the store is written, and the select follows it.
  // The store is checked as well as the closure, so the effect is idempotent: a repeated run with a stale savedModel,
  // as StrictMode can produce, writes nothing.
  useEffect(() => {
    if (models.length === 0 || models.some((m) => m.id === savedModel)) return;
    const fallback = models[0];
    if (getPreference('ai_model') === fallback.id) return;
    savePreference('ai_model', fallback.id);
    if (fallback.name) savePreference('ai_model_name', fallback.name);
  }, [models, savedModel]);

  const handleProviderChange = (id: string) => {
    // Save a pending key edit under the provider it was typed for, then compare edits with the new provider's key
    flush();
    prime(drafts[id] ?? '');
    resetTest();
    savePreference('ai_provider', id);
  };

  const handleKeyChange = (value: string) => {
    setDrafts((current) => ({ ...current, [provider]: value }));
    schedule(value);
    resetTest();
  };

  // A key that lists models is saved at once: the list moves onto it from the cache the test seeded, with no second
  // request and no wait for the debounce. An edit or a provider switch during the test resolves it false.
  const handleTest = async () => {
    if (await test(provider, draft)) flush();
  };

  // The draft is saved first and named to refresh, so the list reloads for the key in the field, even one typed a
  // moment ago, with no request for the key it replaced.
  const handleRefresh = () => {
    flush();
    refresh(draft.trim());
  };

  const handleModelChange = (modelId: string) => {
    savePreference('ai_model', modelId);
    const modelObj = models.find((m) => m.id === modelId);
    savePreference('ai_model_name', modelObj?.name || modelId);
  };

  return (
    <div className="p-6 space-y-4 fade-in">
      {/* Provider picker */}
      <div className="flex gap-1.5 p-1 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)]">
        {AI_PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => handleProviderChange(p.id)}
            className={`flex-1 text-xs font-medium py-2 rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 ${
              provider === p.id
                ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-sm border border-[var(--color-border-subtle)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
            }`}
          >
            {p.recommended && <Star size={10} className="text-[var(--color-accent)] shrink-0" />}
            {p.label}
          </button>
        ))}
      </div>

      {/* API Key: keyed on the provider, so a switch shows the next key hidden */}
      <SecretInput
        key={provider}
        label={`${meta?.label ?? ''} API Key`}
        value={draft}
        onChange={handleKeyChange}
        placeholder={meta?.hint || 'API key...'}
        saved={saved}
        action={(
          <button
            onClick={() => { void handleTest(); }}
            disabled={!draft.trim() || testStatus === 'testing'}
            className="px-3 py-2 text-xs font-medium rounded-lg border transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-[var(--color-surface-2)] border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
          >
            {testStatus === 'testing' ? (
              <LoaderCircle size={12} className="animate-spin" />
            ) : testStatus === 'success' ? (
              <Check size={12} className="text-[var(--color-bull)]" />
            ) : testStatus === 'error' ? (
              <CircleAlert size={12} className="text-[var(--color-bear)]" />
            ) : (
              'Test'
            )}
          </button>
        )}
        status={(
          <>
            {testStatus === 'error' && testError && (
              <div className="flex items-start gap-1.5 mt-1.5 text-[11px] text-[var(--color-bear)] leading-relaxed">
                <CircleAlert size={11} className="shrink-0 mt-px" />
                <span>{testError}</span>
              </div>
            )}
            {testStatus === 'success' && (
              <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-[var(--color-bull)]">
                <Check size={11} className="shrink-0" />
                <span>Key valid — models loaded.</span>
              </div>
            )}
          </>
        )}
      >
        Stored locally in your browser.
        {meta?.needsKey ? ' Required for this provider (no server default).' : ' Optional — server key used if empty.'}
      </SecretInput>

      {/* Model */}
      <div>
        <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
          Model
        </label>
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-muted)]">
            <LoaderCircle size={12} className="animate-spin" /> Fetching available models...
          </div>
        ) : hasModels ? (
          <select
            value={savedModel}
            onChange={(e) => handleModelChange(e.target.value)}
            className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors cursor-pointer"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-muted)]">
            <CircleAlert size={12} className="shrink-0" />
            {modelError || 'No models loaded.'}
          </div>
        )}
        {!loading && (
          <div className="flex items-center gap-2 mt-1.5">
            <button
              onClick={handleRefresh}
              disabled={meta?.needsKey && !draft.trim()}
              className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] disabled:text-[var(--color-text-muted)] disabled:cursor-not-allowed transition-colors flex items-center gap-1"
            >
              <RefreshCw size={10} /> Refresh models
            </button>
            {hasModels && (
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {models.length} model{models.length !== 1 ? 's' : ''} available
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
