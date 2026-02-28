// src/components/ChatBot.jsx
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Bot, User, AlertCircle, MessageSquare, X, Sparkles, Settings, Check, Loader2, Lock, KeyRound, ShieldCheck } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { askLLMStream, fetchModels } from '../lib/api';
import { formatDollar, formatPct, formatRatio, formatPrice } from '../lib/format';
import { setToken, validateToken as validateTokenApi } from '../lib/auth';

const DEFAULT_MODELS = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Latest)' },
  { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
];

/**
 * Serializes the current dashboard state into a plain-text context block
 * that gets injected into the LLM system prompt.
 */
function buildFinancialContext(data, costBasis, shares) {
  if (!data) return 'Dashboard data not yet loaded.';

  const { ticker, kpis, gexByStrike, flowHistory, lastUpdated, spotPrice } = data;
  const k = kpis || {};

  const topGex = [...(gexByStrike || [])]
    .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
    .slice(0, 5)
    .map((s) => `  Strike $${s.strike}: Net GEX ${s.gex > 0 ? '+' : ''}${(s.gex / 1e6).toFixed(1)}M (Call: ${(s.callGex / 1e6).toFixed(1)}M, Put: ${(s.putGex / 1e6).toFixed(1)}M)`)
    .join('\n');

  const recentFlow = (flowHistory || []).slice(-5)
    .map((f) => `  ${f.date}: Net ${formatDollar(f.netPremium)}, Cum ${formatDollar(f.cumPremium)}, Calls ${f.callVolume}, Puts ${f.putVolume}`)
    .join('\n');

  let positionBlock = '';
  if (costBasis && spotPrice) {
    const pnlPct = ((spotPrice - costBasis) / costBasis * 100).toFixed(2);
    const pnlDollars = shares ? (spotPrice - costBasis) * shares : null;
    positionBlock = `
USER POSITION:
  Cost Basis: ${formatPrice(costBasis)}
  Shares: ${shares || 'not specified'}
  Unrealized P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct}%${pnlDollars != null ? ` (${formatDollar(pnlDollars)})` : ''}
  Current Spot: ${formatPrice(spotPrice)}
`;
  }

  return `TICKER: ${ticker}
LAST UPDATED: ${lastUpdated}
${positionBlock}
KPI SUMMARY:
  Net Premium: ${formatDollar(k.netPremium)} (${k.netPremium >= 0 ? 'BULLISH' : 'BEARISH'})
    Call Premium: ${formatDollar(k.callPremium)}
    Put Premium: ${formatDollar(k.putPremium)}
  Dark Pool Volume: ${formatPct(k.darkPoolPct)}
  Max Pain (Weekly): ${formatPrice(k.maxPain)}
  Put/Call Ratio: ${formatRatio(k.putCallRatio)} (${k.putCallRatio > 1 ? 'Bearish' : k.putCallRatio < 0.7 ? 'Bullish' : 'Neutral'})

TOP 5 GEX STRIKES (by magnitude):
${topGex || '  No GEX data'}

RECENT NET PREMIUM FLOW (last 5 sessions):
${recentFlow || '  No flow history'}`;
}

const markdownComponents = {
  strong: ({ children }) => (
    <strong className="text-[var(--color-accent)] font-semibold">{children}</strong>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  code: ({ children }) => (
    <code className="bg-[var(--color-surface-2)] px-1 py-0.5 rounded text-[12px] font-mono">{children}</code>
  ),
  h3: ({ children }) => (
    <h3 className="text-xs font-semibold text-[var(--color-text-primary)] mt-3 mb-1">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-xs font-medium text-[var(--color-text-secondary)] mt-2 mb-1">{children}</h4>
  ),
};

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';

  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''} fade-in`}>
      <div
        className={`flex items-center justify-center w-6 h-6 rounded-lg shrink-0 mt-0.5 ${
          isUser
            ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
            : isError
            ? 'bg-[var(--color-bear-bg)] text-[var(--color-bear)]'
            : 'bg-[var(--color-purple-bg)] text-[var(--color-purple)]'
        }`}
      >
        {isUser ? <User size={12} /> : isError ? <AlertCircle size={12} /> : <Bot size={12} />}
      </div>
      <div
        className={`max-w-[85%] text-[13px] leading-relaxed rounded-xl px-3 py-2 ${
          isUser
            ? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)] border border-[var(--color-accent)]/20'
            : isError
            ? 'bg-[var(--color-bear-bg)] text-[var(--color-bear)] border border-[var(--color-bear)]/20'
            : 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)]'
        }`}
      >
        {isUser || isError ? (
          <div className="whitespace-pre-wrap">{msg.content}</div>
        ) : (
          <ReactMarkdown components={markdownComponents}>{msg.content}</ReactMarkdown>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-2.5 fade-in">
      <div className="flex items-center justify-center w-6 h-6 rounded-lg shrink-0 bg-[var(--color-purple-bg)] text-[var(--color-purple)]">
        <Bot size={12} />
      </div>
      <div className="bg-[var(--color-surface-3)] border border-[var(--color-border-subtle)] rounded-xl px-3 py-2">
        <div className="flex gap-1 items-center h-5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '200ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '400ms' }} />
        </div>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  'What does the GEX profile suggest?',
  'Is the flow bullish or bearish?',
  'Where are key support/resistance levels?',
  'Summarize the dark pool activity.',
];

function ChatLockScreen({ onClose, onUnlock }) {
  const [tokenInput, setTokenInput] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  const handleActivate = async (e) => {
    e.preventDefault();
    const raw = tokenInput.trim();
    if (!raw) return;
    setStatus('validating');
    setError('');
    try {
      const result = await validateTokenApi(raw);
      if (result.valid) {
        setToken(raw);
        setStatus('success');
        setTimeout(() => onUnlock?.(), 400);
      } else {
        setStatus('error');
        setError(result.error || 'Invalid token');
      }
    } catch {
      setStatus('error');
      setError('Could not validate token.');
    }
  };

  return (
    <div className="flex flex-col h-full border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] w-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--color-purple-bg)]">
            <Sparkles size={12} className="text-[var(--color-purple)]" />
          </div>
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">AI Co-Pilot</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          aria-label="Close chat"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5">
        <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/20">
          <Lock size={24} className="text-[var(--color-accent)]" />
        </div>

        <div className="text-center">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Premium Feature
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-1.5 leading-relaxed max-w-[220px]">
            The AI Co-Pilot provides institutional-grade analysis of options flow and gamma exposure.
          </p>
        </div>

        <form onSubmit={handleActivate} className="w-full max-w-xs space-y-2">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] focus-within:border-[var(--color-accent)] transition-colors">
              <KeyRound size={12} className="text-[var(--color-text-muted)] shrink-0" />
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => { setTokenInput(e.target.value); setStatus(null); setError(''); }}
                placeholder="Paste access token..."
                spellCheck={false}
                className="flex-1 bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={!tokenInput.trim() || status === 'validating'}
              className="px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {status === 'validating' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : status === 'success' ? (
                <ShieldCheck size={14} />
              ) : (
                'Activate'
              )}
            </button>
          </div>
          {error && (
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-bear)]">
              <AlertCircle size={10} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default function ChatBot({ data, isOpen, onClose, costBasis, shares, isPremium, onUnlock }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-20250514');
  const [availableModels, setAvailableModels] = useState(DEFAULT_MODELS);
  const [loadingModels, setLoadingModels] = useState(false);
  const [hasSavedKey, setHasSavedKey] = useState(() => Boolean(sessionStorage.getItem('anthropic_api_key')));
  const [keyTestStatus, setKeyTestStatus] = useState(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const modelDisplayName = useMemo(() => {
    const found = availableModels.find((m) => m.id === selectedModel)
      || DEFAULT_MODELS.find((m) => m.id === selectedModel);
    return found?.name || selectedModel;
  }, [availableModels, selectedModel]);

  useEffect(() => {
    const savedKey = sessionStorage.getItem('anthropic_api_key');
    const savedModel = sessionStorage.getItem('anthropic_model');
    if (savedKey) setApiKey(savedKey);
    if (savedModel) setSelectedModel(savedModel);
  }, []);

  const loadModels = useCallback(async (keyOverride) => {
    const key = keyOverride ?? sessionStorage.getItem('anthropic_api_key');
    if (!key) return;
    setLoadingModels(true);
    try {
      const result = await fetchModels(key);
      if (result.models && result.models.length > 0) {
        setAvailableModels(result.models);
      } else {
        setAvailableModels(DEFAULT_MODELS);
      }
    } catch (err) {
      console.error('Failed to load models:', err);
      setAvailableModels(DEFAULT_MODELS);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const openSettings = useCallback(() => {
    setShowSettings(true);
    const savedKey = sessionStorage.getItem('anthropic_api_key');
    if (savedKey) loadModels(savedKey);
  }, [loadModels]);

  const saveSettings = useCallback(() => {
    if (apiKey.trim()) {
      sessionStorage.setItem('anthropic_api_key', apiKey.trim());
      setHasSavedKey(true);
    } else {
      sessionStorage.removeItem('anthropic_api_key');
      setHasSavedKey(false);
    }
    sessionStorage.setItem('anthropic_model', selectedModel);
    setShowSettings(false);
  }, [apiKey, selectedModel]);

  const clearSettings = useCallback(() => {
    sessionStorage.removeItem('anthropic_api_key');
    sessionStorage.removeItem('anthropic_model');
    setApiKey('');
    setSelectedModel('claude-sonnet-4-20250514');
    setHasSavedKey(false);
    setKeyTestStatus(null);
    setShowSettings(false);
  }, []);

  const testApiKey = useCallback(async () => {
    if (!apiKey.trim()) return;
    setKeyTestStatus('testing');
    try {
      const result = await fetchModels(apiKey.trim());
      if (result.models && result.models.length > 0) {
        setKeyTestStatus('success');
        setAvailableModels(result.models);
      } else {
        setKeyTestStatus('error');
      }
    } catch {
      setKeyTestStatus('error');
    }
  }, [apiKey]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || sending) return;

    const userMsg = { role: 'user', content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setSending(true);

    try {
      const financialContext = buildFinancialContext(data, costBasis, shares);
      const apiMessages = newMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-10);

      const userApiKey = sessionStorage.getItem('anthropic_api_key');
      const userModel = sessionStorage.getItem('anthropic_model') || selectedModel;

      await askLLMStream(
        apiMessages,
        financialContext,
        data?.ticker || 'UNKNOWN',
        userApiKey,
        userModel,
        (chunk) => {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              const updated = [...prev];
              updated[updated.length - 1] = { ...last, content: last.content + chunk };
              return updated;
            }
            return [...prev, { role: 'assistant', content: chunk }];
          });
        }
      );
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: `Failed to get analysis: ${err.message}` },
      ]);
    } finally {
      setSending(false);
    }
  }, [messages, sending, data, selectedModel, costBasis, shares]);

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const autoResize = useCallback((el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  if (!isOpen) return null;

  if (!isPremium) {
    return <ChatLockScreen onClose={onClose} onUnlock={onUnlock} />;
  }

  if (showSettings) {
    return (
      <div className="flex flex-col h-full border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] w-full">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-subtle)]">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--color-purple-bg)]">
              <Settings size={12} className="text-[var(--color-purple)]" />
            </div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              AI Settings
            </h3>
          </div>
          <button
            onClick={() => setShowSettings(false)}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            aria-label="Close settings"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              Anthropic API Key (optional)
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setKeyTestStatus(null); }}
                placeholder="sk-ant-..."
                className="flex-1 bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
              />
              <button
                onClick={testApiKey}
                disabled={!apiKey.trim() || keyTestStatus === 'testing'}
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
              Stored in session storage (cleared when browser closes). If not provided, uses server default.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={loadingModels}
              className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {availableModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            {loadingModels && (
              <p className="text-[10px] text-[var(--color-text-muted)] mt-1.5">
                Loading models...
              </p>
            )}
            {!loadingModels && apiKey && (
              <button
                onClick={() => loadModels(apiKey.trim())}
                className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] mt-1.5 transition-colors"
              >
                Refresh models
              </button>
            )}
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={saveSettings}
              className="flex-1 px-4 py-2 text-xs font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] rounded-lg transition-colors"
            >
              Save Settings
            </button>
            <button
              onClick={clearSettings}
              className="px-4 py-2 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)] rounded-lg border border-[var(--color-border-subtle)] transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] w-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--color-purple-bg)]">
            <Sparkles size={12} className="text-[var(--color-purple)]" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)] leading-none">
              AI Co-Pilot
            </h3>
            <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
              {modelDisplayName} · {data?.ticker || '—'} context
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={openSettings}
            className="relative p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            aria-label="Settings"
          >
            <Settings size={14} />
            {hasSavedKey && (
              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--color-bull)]" />
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            aria-label="Close chat"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 space-y-3"
        style={{ overscrollBehavior: 'contain' }}
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-2">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-purple-bg)]">
              <MessageSquare size={18} className="text-[var(--color-purple)]" />
            </div>
            <p className="text-xs text-[var(--color-text-muted)] max-w-[200px]">
              Ask questions about {data?.ticker || 'the'} order flow, gamma, or positioning.
            </p>
            <div className="flex flex-col gap-1.5 w-full mt-1">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="text-left text-xs text-[var(--color-text-secondary)] px-3 py-2 rounded-lg border border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border)] transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}

        {sending && messages[messages.length - 1]?.role !== 'assistant' && <TypingIndicator />}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex items-end gap-2 px-3 py-2.5 border-t border-[var(--color-border-subtle)]"
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); autoResize(e.target); }}
          onKeyDown={handleKeyDown}
          placeholder="Ask about the flow..."
          rows={1}
          className="flex-1 bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors resize-none leading-relaxed"
          disabled={sending}
        />
        <button
          type="submit"
          disabled={!input.trim() || sending}
          className="p-2 rounded-lg bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
          aria-label="Send message"
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}
