// src/components/AppSettings.jsx
import { useState, useEffect, useCallback } from 'react';
import {
  X, Settings, Check, Loader2, AlertCircle, KeyRound, ShieldCheck,
  RefreshCw, Database, Cpu,
} from 'lucide-react';
import { fetchModels } from '../lib/api';
import { setToken, validateToken as validateTokenApi, getToken, clearToken, hasValidToken, getTokenTier, daysRemaining } from '../lib/auth';

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', hint: 'sk-ant-...', color: 'var(--color-accent)' },
  { id: 'openai', label: 'OpenAI', hint: 'sk-...', color: '#10a37f' },
  { id: 'gemini', label: 'Gemini', hint: 'AIza...', color: '#4285f4' },
];

const DEFAULT_MODELS = {
  anthropic: [
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Latest)', provider: 'anthropic' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic' },
    { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', provider: 'anthropic' },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
    { id: 'o3-mini', name: 'o3 Mini', provider: 'openai' },
  ],
  gemini: [
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini' },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'gemini' },
  ],
};

function migrateOldKeys() {
  const oldKey = sessionStorage.getItem('anthropic_api_key');
  const oldModel = sessionStorage.getItem('anthropic_model');
  if (oldKey && !sessionStorage.getItem('ai_key_anthropic')) {
    sessionStorage.setItem('ai_key_anthropic', oldKey);
    sessionStorage.setItem('ai_provider', 'anthropic');
    sessionStorage.removeItem('anthropic_api_key');
  }
  if (oldModel && !sessionStorage.getItem('ai_model')) {
    sessionStorage.setItem('ai_model', oldModel);
    sessionStorage.removeItem('anthropic_model');
  }
}

export function getAISettings() {
  migrateOldKeys();
  return {
    provider: sessionStorage.getItem('ai_provider') || 'anthropic',
    model: sessionStorage.getItem('ai_model') || 'claude-sonnet-4-20250514',
    modelName: sessionStorage.getItem('ai_model_name') || 'Claude Sonnet 4 (Latest)',
    apiKey: sessionStorage.getItem(`ai_key_${sessionStorage.getItem('ai_provider') || 'anthropic'}`) || '',
  };
}

export default function AppSettings({ isOpen, onClose, onAuthChange, dataSource }) {
  const [provider, setProvider] = useState('anthropic');
  const [keys, setKeys] = useState({ anthropic: '', openai: '', gemini: '' });
  const [models, setModels] = useState(DEFAULT_MODELS.anthropic);
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-20250514');
  const [loadingModels, setLoadingModels] = useState(false);
  const [keyTestStatus, setKeyTestStatus] = useState(null);

  const [tokenInput, setTokenInput] = useState('');
  const [tokenStatus, setTokenStatus] = useState(null);
  const [tokenError, setTokenError] = useState('');
  const isPremium = hasValidToken();
  const tier = getTokenTier();
  const days = daysRemaining();

  useEffect(() => {
    if (!isOpen) return;
    migrateOldKeys();
    const savedProvider = sessionStorage.getItem('ai_provider') || 'anthropic';
    setProvider(savedProvider);
    setKeys({
      anthropic: sessionStorage.getItem('ai_key_anthropic') || '',
      openai: sessionStorage.getItem('ai_key_openai') || '',
      gemini: sessionStorage.getItem('ai_key_gemini') || '',
    });
    const savedModel = sessionStorage.getItem('ai_model') || 'claude-sonnet-4-20250514';
    setSelectedModel(savedModel);
    setKeyTestStatus(null);
    setTokenInput('');
    setTokenStatus(null);
    setTokenError('');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const key = keys[provider];
    if (key) {
      loadModelsForProvider(provider, key);
    } else {
      setModels(DEFAULT_MODELS[provider] || []);
      const defaults = DEFAULT_MODELS[provider];
      if (defaults?.length && !defaults.find((m) => m.id === selectedModel)) {
        setSelectedModel(defaults[0].id);
      }
    }
  }, [provider, isOpen]);

  const loadModelsForProvider = useCallback(async (prov, key) => {
    if (!key) {
      setModels(DEFAULT_MODELS[prov] || []);
      return;
    }
    setLoadingModels(true);
    try {
      const result = await fetchModels(key, prov);
      if (result.models?.length > 0) {
        setModels(result.models);
        if (!result.models.find((m) => m.id === selectedModel)) {
          setSelectedModel(result.models[0].id);
        }
      } else {
        setModels(DEFAULT_MODELS[prov] || []);
      }
    } catch {
      setModels(DEFAULT_MODELS[prov] || []);
    } finally {
      setLoadingModels(false);
    }
  }, [selectedModel]);

  const testKey = useCallback(async () => {
    const key = keys[provider]?.trim();
    if (!key) return;
    setKeyTestStatus('testing');
    try {
      const result = await fetchModels(key, provider);
      if (result.models?.length > 0) {
        setKeyTestStatus('success');
        setModels(result.models);
        if (!result.models.find((m) => m.id === selectedModel)) {
          setSelectedModel(result.models[0].id);
        }
      } else {
        setKeyTestStatus('error');
      }
    } catch {
      setKeyTestStatus('error');
    }
  }, [keys, provider, selectedModel]);

  const handleSave = useCallback(() => {
    sessionStorage.setItem('ai_provider', provider);
    for (const [prov, key] of Object.entries(keys)) {
      if (key.trim()) {
        sessionStorage.setItem(`ai_key_${prov}`, key.trim());
      } else {
        sessionStorage.removeItem(`ai_key_${prov}`);
      }
    }
    sessionStorage.setItem('ai_model', selectedModel);
    const modelObj = models.find((m) => m.id === selectedModel);
    sessionStorage.setItem('ai_model_name', modelObj?.name || selectedModel);
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    onClose();
  }, [provider, keys, selectedModel, models, onClose]);

  const handleReset = useCallback(() => {
    for (const prov of ['anthropic', 'openai', 'gemini']) {
      sessionStorage.removeItem(`ai_key_${prov}`);
    }
    sessionStorage.removeItem('ai_provider');
    sessionStorage.removeItem('ai_model');
    sessionStorage.removeItem('ai_model_name');
    setProvider('anthropic');
    setKeys({ anthropic: '', openai: '', gemini: '' });
    setSelectedModel('claude-sonnet-4-20250514');
    setModels(DEFAULT_MODELS.anthropic);
    setKeyTestStatus(null);
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
  }, []);

  const handleActivateToken = useCallback(async (e) => {
    e.preventDefault();
    const raw = tokenInput.trim();
    if (!raw) return;
    setTokenStatus('validating');
    setTokenError('');
    try {
      const result = await validateTokenApi(raw);
      if (result.valid) {
        setToken(raw);
        setTokenStatus('success');
        onAuthChange?.();
      } else {
        setTokenStatus('error');
        setTokenError(result.error || 'Invalid token');
      }
    } catch {
      setTokenStatus('error');
      setTokenError('Could not validate token.');
    }
  }, [tokenInput, onAuthChange]);

  const handleRevokeToken = useCallback(() => {
    clearToken();
    setTokenStatus(null);
    onAuthChange?.();
  }, [onAuthChange]);

  if (!isOpen) return null;

  const currentKey = keys[provider] || '';
  const providerMeta = PROVIDERS.find((p) => p.id === provider);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--color-purple-bg)]">
              <Settings size={14} className="text-[var(--color-purple)]" />
            </div>
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* ── AI Provider ── */}
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
              <Cpu size={12} />
              AI Provider
            </div>

            <div className="flex gap-1.5 p-1 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)]">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setProvider(p.id); setKeyTestStatus(null); }}
                  className={`flex-1 text-xs font-medium py-2 rounded-lg transition-all duration-150 ${
                    provider === p.id
                      ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-sm border border-[var(--color-border-subtle)]'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* API Key */}
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                {providerMeta?.label} API Key
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={currentKey}
                  onChange={(e) => { setKeys({ ...keys, [provider]: e.target.value }); setKeyTestStatus(null); }}
                  placeholder={providerMeta?.hint || 'API key...'}
                  className="flex-1 bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
                />
                <button
                  onClick={testKey}
                  disabled={!currentKey.trim() || keyTestStatus === 'testing'}
                  className="px-3 py-2 text-xs font-medium rounded-lg border transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-[var(--color-surface-2)] border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
                >
                  {keyTestStatus === 'testing' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : keyTestStatus === 'success' ? (
                    <Check size={12} className="text-[var(--color-bull)]" />
                  ) : keyTestStatus === 'error' ? (
                    <AlertCircle size={12} className="text-[var(--color-bear)]" />
                  ) : (
                    'Test'
                  )}
                </button>
              </div>
              <p className="text-[10px] text-[var(--color-text-muted)] mt-1.5 leading-relaxed">
                Session only — cleared when browser closes.
                {provider !== 'anthropic' && ' Required for this provider (no server default).'}
                {provider === 'anthropic' && ' Optional — server key used if empty.'}
              </p>
            </div>

            {/* Model */}
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                Model
              </label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={loadingModels}
                className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors cursor-pointer disabled:opacity-50"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              <div className="flex items-center gap-2 mt-1.5">
                {loadingModels && (
                  <span className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" /> Fetching models...
                  </span>
                )}
                {!loadingModels && currentKey && (
                  <button
                    onClick={() => loadModelsForProvider(provider, currentKey.trim())}
                    className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors flex items-center gap-1"
                  >
                    <RefreshCw size={10} /> Refresh models
                  </button>
                )}
              </div>
            </div>
          </section>

          <hr className="border-[var(--color-border-subtle)]" />

          {/* ── Access Token ── */}
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
              <KeyRound size={12} />
              Access Token
            </div>

            {isPremium ? (
              <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)]">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={14} className="text-[var(--color-bull)]" />
                  <span className="text-xs font-medium text-[var(--color-text-primary)]">
                    {tier === 'pro' ? 'PRO' : 'TRIAL'} — {days} day{days !== 1 ? 's' : ''} remaining
                  </span>
                </div>
                <button
                  onClick={handleRevokeToken}
                  className="text-[10px] text-[var(--color-bear)] hover:text-[var(--color-bear)]/80 transition-colors"
                >
                  Revoke
                </button>
              </div>
            ) : (
              <form onSubmit={handleActivateToken} className="space-y-2">
                <div className="flex gap-2">
                  <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] focus-within:border-[var(--color-accent)] transition-colors">
                    <KeyRound size={12} className="text-[var(--color-text-muted)] shrink-0" />
                    <input
                      type="text"
                      value={tokenInput}
                      onChange={(e) => { setTokenInput(e.target.value); setTokenStatus(null); setTokenError(''); }}
                      placeholder="Paste access token..."
                      spellCheck={false}
                      className="flex-1 bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none font-mono"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={!tokenInput.trim() || tokenStatus === 'validating'}
                    className="px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  >
                    {tokenStatus === 'validating' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : tokenStatus === 'success' ? (
                      <ShieldCheck size={14} />
                    ) : (
                      'Activate'
                    )}
                  </button>
                </div>
                {tokenError && (
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-bear)]">
                    <AlertCircle size={10} className="shrink-0" />
                    <span>{tokenError}</span>
                  </div>
                )}
                <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                  Unlocks premium features: AI Co-Pilot and Position Analysis.
                </p>
              </form>
            )}
          </section>

          <hr className="border-[var(--color-border-subtle)]" />

          {/* ── Data Source ── */}
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
              <Database size={12} />
              Data Source
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)] space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor: dataSource === 'tradier' ? 'var(--color-bull)'
                      : dataSource === 'mock' ? 'var(--color-warn)' : 'var(--color-accent)',
                  }}
                />
                <span className="text-xs font-medium text-[var(--color-text-primary)]">
                  {dataSource === 'tradier' ? 'Tradier (real-time)'
                    : dataSource === 'tradier-sandbox' ? 'Tradier Sandbox (delayed)'
                    : dataSource === 'mock' ? 'Demo Data (simulated)'
                    : 'CBOE Delayed Quotes'}
                </span>
              </div>
              {dataSource !== 'tradier' && dataSource !== 'mock' && (
                <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                  Prices are from CBOE's delayed quotes feed (roughly 15 minutes behind).
                  The spot price may differ from Yahoo Finance or your broker, which use
                  real-time or official closing prices.
                  Add a <span className="font-mono">TRADIER_API_KEY</span> env var for real-time data.
                </p>
              )}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 flex gap-2 px-6 py-4 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
          <button
            onClick={handleSave}
            className="flex-1 px-4 py-2.5 text-xs font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] rounded-lg transition-colors"
          >
            Save Settings
          </button>
          <button
            onClick={handleReset}
            className="px-4 py-2.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)] rounded-lg border border-[var(--color-border-subtle)] transition-colors"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
