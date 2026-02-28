// src/components/AppSettings.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, Settings, Check, Loader2, AlertCircle, KeyRound, ShieldCheck,
  RefreshCw, Database, Cpu, Star,
} from 'lucide-react';
import { fetchModels } from '../lib/api';
import { setToken, validateToken as validateTokenApi, getToken, clearToken, hasValidToken, getTokenTier, daysRemaining } from '../lib/auth';
import RequestAccessForm from './RequestAccessForm';

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', hint: 'sk-ant-...', needsKey: false, recommended: true },
  { id: 'gemini', label: 'Gemini', hint: 'AIza...', needsKey: true },
  { id: 'openai', label: 'OpenAI', hint: 'sk-...', needsKey: true },
];

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
  const provider = sessionStorage.getItem('ai_provider') || 'anthropic';
  return {
    provider,
    model: sessionStorage.getItem('ai_model') || '',
    modelName: sessionStorage.getItem('ai_model_name') || 'Default',
    apiKey: sessionStorage.getItem(`ai_key_${provider}`) || '',
  };
}

export default function AppSettings({ isOpen, onClose, onAuthChange, dataSource }) {
  const [provider, setProvider] = useState('anthropic');
  const [keys, setKeys] = useState({ anthropic: '', openai: '', gemini: '' });
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState(null);
  const [keyTestStatus, setKeyTestStatus] = useState(null);
  const [keyTestError, setKeyTestError] = useState('');
  const fetchIdRef = useRef(0);

  const [tradierKey, setTradierKey] = useState('');

  const [tokenInput, setTokenInput] = useState('');
  const [tokenStatus, setTokenStatus] = useState(null);
  const [tokenError, setTokenError] = useState('');
  const [showRequest, setShowRequest] = useState(false);
  const isPremium = hasValidToken();
  const tier = getTokenTier();
  const days = daysRemaining();

  const loadModelsForProvider = useCallback(async (prov, key) => {
    const provMeta = PROVIDERS.find((p) => p.id === prov);
    if (provMeta?.needsKey && !key) {
      setModels([]);
      setModelError(`Enter your ${provMeta.label} API key to load models.`);
      return;
    }

    const id = ++fetchIdRef.current;
    setLoadingModels(true);
    setModelError(null);

    try {
      const result = await fetchModels(key || null, prov);
      if (id !== fetchIdRef.current) return;

      if (result.models?.length > 0) {
        setModels(result.models);
        const savedModel = sessionStorage.getItem('ai_model');
        const match = result.models.find((m) => m.id === savedModel);
        if (!match) setSelectedModel(result.models[0].id);
        setModelError(null);
      } else {
        setModels([]);
        setModelError(result.error || 'No models returned.');
      }
    } catch (err) {
      if (id !== fetchIdRef.current) return;
      setModels([]);
      setModelError(err.message || 'Failed to fetch models.');
    } finally {
      if (id === fetchIdRef.current) setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    migrateOldKeys();
    const savedProvider = sessionStorage.getItem('ai_provider') || 'anthropic';
    setProvider(savedProvider);
    const loadedKeys = {
      anthropic: sessionStorage.getItem('ai_key_anthropic') || '',
      openai: sessionStorage.getItem('ai_key_openai') || '',
      gemini: sessionStorage.getItem('ai_key_gemini') || '',
    };
    setKeys(loadedKeys);
    setSelectedModel(sessionStorage.getItem('ai_model') || '');
    setKeyTestStatus(null);
    setKeyTestError('');
    setTradierKey(sessionStorage.getItem('data_tradier_key') || '');
    setTokenInput('');
    setTokenStatus(null);
    setTokenError('');

    loadModelsForProvider(savedProvider, loadedKeys[savedProvider]);
  }, [isOpen, loadModelsForProvider]);

  useEffect(() => {
    if (!isOpen) return;
    loadModelsForProvider(provider, keys[provider]);
  }, [provider]);

  const testKey = useCallback(async () => {
    const key = keys[provider]?.trim();
    if (!key) return;
    setKeyTestStatus('testing');
    setKeyTestError('');
    try {
      const result = await fetchModels(key, provider);
      if (result.models?.length > 0) {
        setKeyTestStatus('success');
        setKeyTestError('');
        setModels(result.models);
        setModelError(null);
        const match = result.models.find((m) => m.id === selectedModel);
        if (!match) setSelectedModel(result.models[0].id);
      } else {
        setKeyTestStatus('error');
        setKeyTestError(result.error || 'Key returned no models — check that it is valid.');
      }
    } catch (err) {
      setKeyTestStatus('error');
      setKeyTestError(err.message || 'Could not validate key. Check the format and try again.');
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
    if (selectedModel) {
      sessionStorage.setItem('ai_model', selectedModel);
      const modelObj = models.find((m) => m.id === selectedModel);
      sessionStorage.setItem('ai_model_name', modelObj?.name || selectedModel);
    }
    const oldTradier = sessionStorage.getItem('data_tradier_key') || '';
    if (tradierKey.trim()) {
      sessionStorage.setItem('data_tradier_key', tradierKey.trim());
    } else {
      sessionStorage.removeItem('data_tradier_key');
    }
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    if (tradierKey.trim() !== oldTradier) {
      window.dispatchEvent(new CustomEvent('data-source-changed'));
    }
    onClose();
  }, [provider, keys, selectedModel, models, tradierKey, onClose]);

  const handleReset = useCallback(() => {
    for (const prov of ['anthropic', 'openai', 'gemini']) {
      sessionStorage.removeItem(`ai_key_${prov}`);
    }
    sessionStorage.removeItem('ai_provider');
    sessionStorage.removeItem('ai_model');
    sessionStorage.removeItem('ai_model_name');
    const hadTradier = Boolean(sessionStorage.getItem('data_tradier_key'));
    sessionStorage.removeItem('data_tradier_key');
    setProvider('anthropic');
    setKeys({ anthropic: '', openai: '', gemini: '' });
    setSelectedModel('');
    setModels([]);
    setTradierKey('');
    setKeyTestStatus(null);
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    if (hadTradier) window.dispatchEvent(new CustomEvent('data-source-changed'));
    loadModelsForProvider('anthropic', '');
  }, [loadModelsForProvider]);

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
  const hasModels = models.length > 0;

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
                  onClick={() => { setProvider(p.id); setKeyTestStatus(null); setKeyTestError(''); }}
                  className={`flex-1 text-xs font-medium py-2 rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 ${
                    provider === p.id
                      ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-sm border border-[var(--color-border-subtle)]'
                      : p.id === 'openai'
                        ? 'text-[var(--color-text-muted)]/60 hover:text-[var(--color-text-muted)]'
                        : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                  }`}
                  style={p.id === 'openai' && provider !== 'openai' ? { fontSize: '11px' } : undefined}
                >
                  {p.recommended && <Star size={10} className="text-[var(--color-accent)] shrink-0" />}
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
                  onChange={(e) => { setKeys({ ...keys, [provider]: e.target.value }); setKeyTestStatus(null); setKeyTestError(''); }}
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
              {keyTestStatus === 'error' && keyTestError && (
                <div className="flex items-start gap-1.5 mt-1.5 text-[11px] text-[var(--color-bear)] leading-relaxed">
                  <AlertCircle size={11} className="shrink-0 mt-px" />
                  <span>{keyTestError}</span>
                </div>
              )}
              {keyTestStatus === 'success' && (
                <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-[var(--color-bull)]">
                  <Check size={11} className="shrink-0" />
                  <span>Key valid — models loaded.</span>
                </div>
              )}
              <p className="text-[10px] text-[var(--color-text-muted)] mt-1.5 leading-relaxed">
                Session only — cleared when browser closes.
                {providerMeta?.needsKey ? ' Required for this provider (no server default).' : ' Optional — server key used if empty.'}
              </p>
            </div>

            {/* Model */}
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                Model
              </label>
              {loadingModels ? (
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-muted)]">
                  <Loader2 size={12} className="animate-spin" /> Fetching available models...
                </div>
              ) : hasModels ? (
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors cursor-pointer"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-muted)]">
                  <AlertCircle size={12} className="shrink-0" />
                  {modelError || 'No models loaded.'}
                </div>
              )}
              {!loadingModels && (
                <div className="flex items-center gap-2 mt-1.5">
                  <button
                    onClick={() => loadModelsForProvider(provider, currentKey.trim())}
                    disabled={providerMeta?.needsKey && !currentKey.trim()}
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

            {!isPremium && (
              showRequest ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <hr className="flex-1 border-[var(--color-border-subtle)]" />
                    <span className="text-[10px] text-[var(--color-text-muted)]">or request access</span>
                    <hr className="flex-1 border-[var(--color-border-subtle)]" />
                  </div>
                  <RequestAccessForm />
                </div>
              ) : (
                <button
                  onClick={() => setShowRequest(true)}
                  className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                >
                  Don't have a token? <span className="underline">Request access</span>
                </button>
              )
            )}
          </section>

          <hr className="border-[var(--color-border-subtle)]" />

          {/* ── Data Source ── */}
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
              <Database size={12} />
              Data Source
            </div>

            <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)]">
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
                  : 'CBOE Delayed Quotes (~15 min delay)'}
              </span>
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                Tradier API Key
              </label>
              <input
                type="password"
                value={tradierKey}
                onChange={(e) => setTradierKey(e.target.value)}
                placeholder="Paste for real-time data..."
                className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
              />
              <p className="text-[10px] text-[var(--color-text-muted)] mt-1.5 leading-relaxed">
                {tradierKey.trim()
                  ? 'Tradier key will be used on next data refresh for real-time options data.'
                  : dataSource === 'tradier'
                    ? 'Currently using server-configured Tradier key.'
                    : 'Without a Tradier key, prices come from CBOE delayed quotes (~15 min behind). A free sandbox key works for testing — get one at tradier.com.'}
              </p>
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
