// src/components/AppSettings.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, Settings, Check, Loader2, AlertCircle, KeyRound, ShieldCheck,
  RefreshCw, Database, Cpu, Star, Eye, EyeOff, Download, Upload, FileText, HardDrive, RotateCcw, Pencil,
} from 'lucide-react';
import { fetchModels } from '../lib/api';
import { setToken, validateToken as validateTokenApi, clearToken, hasValidToken, getTokenTier, daysRemaining } from '../lib/auth';
import { exportAll, importAll, getPreference, setPreference, migrateSessionToLocal } from '../lib/store';
import RequestAccessForm from './RequestAccessForm';
import StrategicContextEditor from './StrategicContextEditor';

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', hint: 'sk-ant-...', needsKey: false, recommended: true },
  { id: 'gemini', label: 'Gemini', hint: 'AIza...', needsKey: true },
  { id: 'openai', label: 'OpenAI', hint: 'sk-...', needsKey: true },
];

const TABS = [
  { id: 'ai', label: 'AI', icon: Cpu },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'account', label: 'Account', icon: KeyRound },
  { id: 'backup', label: 'Backup', icon: HardDrive },
];

// ── Shared export: read AI settings from the store abstraction ──
export function getAISettings() {
  const provider = getPreference('ai_provider') || 'anthropic';
  return {
    provider,
    model: getPreference('ai_model') || '',
    modelName: getPreference('ai_model_name') || 'Default',
    apiKey: getPreference(`ai_key_${provider}`) || '',
  };
}

// ── Auto-save hook: debounces writes and shows brief "Saved" indicator ──
function useAutoSave(value, saveFn, delay = 600) {
  const [saved, setSaved] = useState(false);
  const timeoutRef = useRef(null);
  const fadeRef = useRef(null);
  const initialRef = useRef(true);
  const pendingRef = useRef(null); // tracks { value, saveFn } when a timer is queued

  useEffect(() => {
    // Clear any in-flight timers first
    clearTimeout(timeoutRef.current);
    clearTimeout(fadeRef.current);

    // Skip initial mount — don't save the value loaded from storage
    if (initialRef.current) { initialRef.current = false; pendingRef.current = null; return; }
    setSaved(false);

    pendingRef.current = { value, saveFn };
    timeoutRef.current = setTimeout(() => {
      pendingRef.current = null;
      saveFn(value);
      setSaved(true);
      fadeRef.current = setTimeout(() => setSaved(false), 1500);
    }, delay);

    return () => { clearTimeout(timeoutRef.current); clearTimeout(fadeRef.current); };
  }, [value, saveFn, delay]);

  // Reset initial flag when the hook is re-mounted (modal reopen)
  const reset = useCallback(() => {
    clearTimeout(timeoutRef.current);
    clearTimeout(fadeRef.current);
    pendingRef.current = null;
    initialRef.current = true;
    setSaved(false);
  }, []);

  // Flush any pending debounced save immediately (call on close/unmount)
  const flush = useCallback(() => {
    if (pendingRef.current) {
      clearTimeout(timeoutRef.current);
      clearTimeout(fadeRef.current);
      pendingRef.current.saveFn(pendingRef.current.value);
      pendingRef.current = null;
    }
  }, []);

  return { saved, reset, flush };
}

function SavedIndicator({ show }) {
  if (!show) return null;
  return (
    <span className="text-[10px] text-[var(--color-bull)] fade-in flex items-center gap-1">
      <Check size={10} /> Saved
    </span>
  );
}

// ── Main Component ──
export default function AppSettings({ isOpen, onClose, onAuthChange, dataSource }) {
  const [activeTab, setActiveTab] = useState('ai');

  // AI state
  const [provider, setProvider] = useState('anthropic');
  const [keys, setKeys] = useState({ anthropic: '', openai: '', gemini: '' });
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState(null);
  const [keyTestStatus, setKeyTestStatus] = useState(null);
  const [keyTestError, setKeyTestError] = useState('');
  const fetchIdRef = useRef(0);
  const [showApiKey, setShowApiKey] = useState(false);

  // Data source state
  const [showTradierKey, setShowTradierKey] = useState(false);
  const [tradierKey, setTradierKey] = useState('');
  const [showFinnhubKey, setShowFinnhubKey] = useState(false);
  const [finnhubKey, setFinnhubKey] = useState('');

  // Account state
  const [tokenInput, setTokenInput] = useState('');
  const [tokenStatus, setTokenStatus] = useState(null);
  const [tokenError, setTokenError] = useState('');
  const [showRequest, setShowRequest] = useState(false);

  // Backup state
  const fileInputRef = useRef(null);
  const [importStatus, setImportStatus] = useState(null);
  const [importError, setImportError] = useState('');
  const [contextEditorOpen, setContextEditorOpen] = useState(false);
  const [contextPreview, setContextPreview] = useState('');

  const isPremium = hasValidToken();
  const tier = getTokenTier();
  const days = daysRemaining();

  // ── Auto-save wiring ──
  const saveAiKey = useCallback((val) => {
    setPreference(`ai_key_${provider}`, val?.trim() || null);
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
  }, [provider]);

  const saveTradierKey = useCallback((val) => {
    setPreference('data_tradier_key', val?.trim() || null);
    window.dispatchEvent(new CustomEvent('data-source-changed'));
  }, []);

  const saveFinnhubKey = useCallback((val) => {
    setPreference('data_finnhub_key', val?.trim() || null);
    window.dispatchEvent(new CustomEvent('data-source-changed'));
  }, []);

  const currentKey = keys[provider] || '';
  const aiKeySave = useAutoSave(currentKey, saveAiKey, 800);
  const tradierSave = useAutoSave(tradierKey, saveTradierKey, 800);
  const finnhubSave = useAutoSave(finnhubKey, saveFinnhubKey, 800);

  // ── Model loading ──
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
        const savedModel = getPreference('ai_model');
        const match = result.models.find((m) => m.id === savedModel);
        if (!match) {
          const fallback = result.models[0];
          setSelectedModel(fallback.id);
          setPreference('ai_model', fallback.id);
          if (fallback.name) setPreference('ai_model_name', fallback.name);
        }
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

  // ── Load state from store on open ──
  useEffect(() => {
    if (!isOpen) return;
    migrateSessionToLocal();
    const savedProvider = getPreference('ai_provider') || 'anthropic';
    setProvider(savedProvider);
    const loadedKeys = {
      anthropic: getPreference('ai_key_anthropic') || '',
      openai: getPreference('ai_key_openai') || '',
      gemini: getPreference('ai_key_gemini') || '',
    };
    setKeys(loadedKeys);
    setSelectedModel(getPreference('ai_model') || '');
    setKeyTestStatus(null);
    setKeyTestError('');
    setShowApiKey(false);
    setShowTradierKey(false);
    setTradierKey(getPreference('data_tradier_key') || '');
    setShowFinnhubKey(false);
    setFinnhubKey(getPreference('data_finnhub_key') || '');
    setTokenInput('');
    setTokenStatus(null);
    setTokenError('');
    setImportStatus(null);
    setImportError('');
    setContextPreview(getPreference('strategic_context') ?? '');
    setContextEditorOpen(false);
    setActiveTab('ai');
    setShowRequest(false);

    // Reset auto-save hooks so they don't fire on the loaded values
    aiKeySave.reset();
    tradierSave.reset();
    finnhubSave.reset();

    loadModelsForProvider(savedProvider, loadedKeys[savedProvider]);
  }, [isOpen, loadModelsForProvider, aiKeySave, tradierSave, finnhubSave]);

  // Reload models when provider/key changes
  const currentProviderKey = keys[provider];
  useEffect(() => {
    if (!isOpen) return;
    loadModelsForProvider(provider, currentProviderKey);
  }, [isOpen, provider, currentProviderKey, loadModelsForProvider]);

  // ── Flush pending saves and close ──
  const handleClose = useCallback(() => {
    aiKeySave.flush();
    tradierSave.flush();
    finnhubSave.flush();
    onClose();
  }, [aiKeySave, tradierSave, finnhubSave, onClose]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); handleClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  // ── Immediate-save helpers (no debounce needed) ──
  const handleProviderChange = useCallback((id) => {
    setProvider(id);
    setKeyTestStatus(null);
    setKeyTestError('');
    setShowApiKey(false);
    setPreference('ai_provider', id);
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
  }, []);

  const handleModelChange = useCallback((modelId) => {
    setSelectedModel(modelId);
    setPreference('ai_model', modelId);
    const modelObj = models.find((m) => m.id === modelId);
    setPreference('ai_model_name', modelObj?.name || modelId);
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
  }, [models]);

  // ── Test key ──
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
        if (!match) {
          const fallback = result.models[0];
          setSelectedModel(fallback.id);
          setPreference('ai_model', fallback.id);
          if (fallback.name) setPreference('ai_model_name', fallback.name);
        }
      } else {
        setKeyTestStatus('error');
        setKeyTestError(result.error || 'Key returned no models — check that it is valid.');
      }
    } catch (err) {
      setKeyTestStatus('error');
      setKeyTestError(err.message || 'Could not validate key. Check the format and try again.');
    }
  }, [keys, provider, selectedModel]);

  // ── Token handlers ──
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

  // ── Reset all settings ──
  const handleReset = useCallback(() => {
    if (!window.confirm('Reset all settings? This will clear your API keys, model selection, and data source keys. This cannot be undone.')) return;
    const settingKeys = [
      'ai_provider', 'ai_model', 'ai_model_name',
      'ai_key_anthropic', 'ai_key_openai', 'ai_key_gemini',
      'data_tradier_key', 'data_finnhub_key',
    ];
    for (const key of settingKeys) setPreference(key, null);
    setProvider('anthropic');
    setKeys({ anthropic: '', openai: '', gemini: '' });
    setSelectedModel('');
    setModels([]);
    setTradierKey('');
    setFinnhubKey('');
    setKeyTestStatus(null);
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    window.dispatchEvent(new CustomEvent('data-source-changed'));
    loadModelsForProvider('anthropic', '');
  }, [loadModelsForProvider]);

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

  const handleImport = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        importAll(data);
        setImportStatus('success');
        setImportError('');
        // Reload strategic context preview from newly imported data
        setContextPreview(getPreference('strategic_context') ?? '');
      } catch (err) {
        setImportStatus('error');
        setImportError(err.message || 'Invalid file format.');
      }
    };
    reader.onerror = () => {
      setImportStatus('error');
      setImportError('Failed to read file.');
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  if (!isOpen) return null;

  const providerMeta = PROVIDERS.find((p) => p.id === provider);
  const hasModels = models.length > 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />

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
              onClick={handleClose}
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

        {/* ════════════════════════════════════════════ */}
        {/* TAB: AI                                     */}
        {/* ════════════════════════════════════════════ */}
        {activeTab === 'ai' && (
          <div className="p-6 space-y-4 fade-in">
            {/* Provider picker */}
            <div className="flex gap-1.5 p-1 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)]">
              {PROVIDERS.map((p) => (
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

            {/* API Key */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                  {providerMeta?.label} API Key
                </label>
                <SavedIndicator show={aiKeySave.saved} />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={currentKey}
                    onChange={(e) => { setKeys({ ...keys, [provider]: e.target.value }); setKeyTestStatus(null); setKeyTestError(''); }}
                    placeholder={providerMeta?.hint || 'API key...'}
                    className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg pl-3 pr-9 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
                  />
                  {currentKey && (
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
                      aria-label={showApiKey ? 'Hide key' : 'Reveal key'}
                    >
                      {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  )}
                </div>
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
                Stored locally in your browser.
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
                  onChange={(e) => handleModelChange(e.target.value)}
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
          </div>
        )}

        {/* ════════════════════════════════════════════ */}
        {/* TAB: Data                                   */}
        {/* ════════════════════════════════════════════ */}
        {activeTab === 'data' && (
          <div className="p-6 space-y-4 fade-in">
            {/* Data source status banner */}
            <div className={`p-4 rounded-lg border ${
              dataSource === 'tradier'
                ? 'border-[var(--color-bull)]/30 bg-[var(--color-bull-bg)]'
                : dataSource === 'tradier-sandbox'
                  ? 'border-[var(--color-cyan)]/30 bg-[var(--color-cyan-bg)]'
                  : dataSource === 'mock'
                    ? 'border-[var(--color-warn-border-muted)] bg-[var(--color-warn-bg)]'
                    : 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5'
            }`}>
              <div className="flex items-center gap-2.5 mb-1.5">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  dataSource === 'tradier' ? 'bg-[var(--color-bull)]'
                    : dataSource === 'tradier-sandbox' ? 'bg-[var(--color-cyan)]'
                    : dataSource === 'mock' ? 'bg-[var(--color-warn)]'
                    : 'bg-[var(--color-accent)]'
                }`} />
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {dataSource === 'tradier' ? 'Tradier Real-Time'
                    : dataSource === 'tradier-sandbox' ? 'Tradier Sandbox'
                    : dataSource === 'mock' ? 'Demo Data'
                    : 'CBOE Delayed Quotes'}
                </span>
              </div>
              <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed pl-5">
                {dataSource === 'tradier'
                  ? 'Live options chain data via Tradier brokerage API. GEX, Max Pain, and all metrics are real-time.'
                  : dataSource === 'tradier-sandbox'
                    ? 'Delayed data from Tradier sandbox. Upgrade to a brokerage account for real-time feeds.'
                    : dataSource === 'mock'
                      ? 'Simulated data for demonstration. Deploy to Netlify for live CBOE data.'
                      : 'Options data is ~15 minutes delayed. Add a Tradier API key below for real-time data.'}
              </p>
            </div>

            {/* Tradier key */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                  Tradier API Key
                </label>
                <SavedIndicator show={tradierSave.saved} />
              </div>
              <div className="relative">
                <input
                  type={showTradierKey ? 'text' : 'password'}
                  value={tradierKey}
                  onChange={(e) => setTradierKey(e.target.value)}
                  placeholder="Paste for real-time data..."
                  className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg pl-3 pr-9 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
                />
                {tradierKey && (
                  <button
                    type="button"
                    onClick={() => setShowTradierKey((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
                    aria-label={showTradierKey ? 'Hide key' : 'Reveal key'}
                  >
                    {showTradierKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
              </div>
              <p className="text-[10px] text-[var(--color-text-muted)] mt-1.5 leading-relaxed">
                {tradierKey.trim()
                  ? 'Key saved — data will use Tradier on next refresh.'
                  : dataSource === 'tradier'
                    ? 'Currently using server-configured Tradier key.'
                    : 'A free sandbox key works for testing — get one at tradier.com.'}
              </p>
            </div>

            {/* Finnhub key */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                  Finnhub API Key
                </label>
                <SavedIndicator show={finnhubSave.saved} />
              </div>
              <div className="relative">
                <input
                  type={showFinnhubKey ? 'text' : 'password'}
                  value={finnhubKey}
                  onChange={(e) => setFinnhubKey(e.target.value)}
                  placeholder="Paste for news, earnings, analyst data..."
                  className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg pl-3 pr-9 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
                />
                {finnhubKey && (
                  <button
                    type="button"
                    onClick={() => setShowFinnhubKey((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
                    aria-label={showFinnhubKey ? 'Hide key' : 'Reveal key'}
                  >
                    {showFinnhubKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
              </div>
              <p className="text-[10px] text-[var(--color-text-muted)] mt-1.5 leading-relaxed">
                {finnhubKey.trim()
                  ? 'Key saved — enables news, earnings, analyst ratings, and technicals.'
                  : 'Free API key from finnhub.io. Powers the Research panel and AI Co-Pilot context.'}
              </p>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════ */}
        {/* TAB: Account                                */}
        {/* ════════════════════════════════════════════ */}
        {activeTab === 'account' && (
          <div className="p-6 space-y-4 fade-in">
            {isPremium ? (
              <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4 space-y-3">
                {/* Tier + expiry */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={16} className="text-[var(--color-bull)]" />
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                      tier === 'pro'
                        ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10 border-[var(--color-accent)]/20'
                        : 'text-[var(--color-purple)] bg-[var(--color-purple-bg)] border-[var(--color-purple)]/20'
                    }`}>
                      {tier === 'pro' ? 'PRO' : 'TRIAL'}
                    </span>
                  </div>
                  <span className="text-xs text-[var(--color-text-secondary)] tabular-nums">
                    {days} day{days !== 1 ? 's' : ''} remaining
                  </span>
                </div>

                {/* Feature list */}
                <ul className="text-[11px] text-[var(--color-text-secondary)] space-y-1.5 pl-1">
                  <li className="flex items-center gap-1.5">
                    <Check size={10} className="text-[var(--color-bull)] shrink-0" />
                    AI Co-Pilot with streaming analysis
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Check size={10} className="text-[var(--color-bull)] shrink-0" />
                    Position Analysis with P&L tracking
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Check size={10} className="text-[var(--color-bull)] shrink-0" />
                    Ticker Research (earnings, analysts, technicals)
                  </li>
                </ul>

                {/* Revoke */}
                <div className="pt-2 border-t border-[var(--color-border-subtle)]">
                  <button
                    onClick={handleRevokeToken}
                    className="text-[10px] text-[var(--color-bear)] hover:text-[var(--color-bear)]/80 transition-colors"
                  >
                    Revoke token
                  </button>
                </div>
              </div>
            ) : (
              <>
                <form onSubmit={handleActivateToken} className="space-y-2">
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                    Activate Token
                  </label>
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
                    Unlocks premium features: AI Co-Pilot, Position Analysis, and Ticker Research.
                  </p>
                </form>

                {/* Request access */}
                {showRequest ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <hr className="flex-1 border-[var(--color-border-subtle)]" />
                      <span className="text-[10px] text-[var(--color-text-muted)]">or request access</span>
                      <hr className="flex-1 border-[var(--color-border-subtle)]" />
                    </div>
                    <RequestAccessForm />
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border-subtle)]">
                    <Star size={14} className="text-[var(--color-accent)] shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-[var(--color-text-primary)]">Don't have a token?</p>
                      <p className="text-[10px] text-[var(--color-text-muted)]">Request early access to premium features.</p>
                    </div>
                    <button
                      onClick={() => setShowRequest(true)}
                      className="px-3 py-1.5 text-[11px] font-medium rounded-lg border border-[var(--color-accent)]/30 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors shrink-0"
                    >
                      Request
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════ */}
        {/* TAB: Backup                                 */}
        {/* ════════════════════════════════════════════ */}
        {activeTab === 'backup' && (
          <div className="p-6 space-y-5 fade-in">
            {/* Strategic Context */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                  <FileText size={12} />
                  Strategic Context
                </div>
                <div className="flex items-center gap-2">
                  {contextPreview?.trim() && (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Clear all strategic context?')) {
                          setPreference('strategic_context', null);
                          setContextPreview('');
                        }
                      }}
                      className="text-[10px] text-[var(--color-bear)] hover:text-[var(--color-bear)]/80 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {contextPreview?.trim() ? (
                <button
                  type="button"
                  onClick={() => setContextEditorOpen(true)}
                  className="w-full text-left rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3 hover:border-[var(--color-text-muted)] transition-colors group"
                >
                  <div className="relative overflow-hidden" style={{ maxHeight: 100 }}>
                    <pre className="text-[11px] text-[var(--color-text-secondary)] font-mono leading-relaxed whitespace-pre-wrap break-words m-0">
                      {contextPreview.slice(0, 300)}
                    </pre>
                    <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--color-surface-2)] to-transparent pointer-events-none" />
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

            <StrategicContextEditor
              isOpen={contextEditorOpen}
              onClose={() => {
                setContextEditorOpen(false);
                // Refresh preview from store (editor auto-saved)
                setContextPreview(getPreference('strategic_context') ?? '');
              }}
            />

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

              {importStatus === 'success' && (
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-bull)]">
                  <Check size={11} className="shrink-0" />
                  <span>Data imported successfully.</span>
                </div>
              )}
              {importStatus === 'error' && (
                <div className="flex items-start gap-1.5 text-[11px] text-[var(--color-bear)] leading-relaxed">
                  <AlertCircle size={11} className="shrink-0 mt-px" />
                  <span>{importError}</span>
                </div>
              )}

              <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                Exports positions, chat histories, and preferences as JSON.
                API keys are{' '}
                <strong className="font-medium text-[var(--color-text-secondary)]">not</strong>{' '}
                included for security. Import overwrites existing data.
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
        )}
      </div>
    </div>
  );
}
