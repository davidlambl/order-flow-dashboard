// src/components/ChatBot.jsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, AlertCircle, MessageSquare, X, Sparkles, Settings } from 'lucide-react';
import { askLLM, fetchModels } from '../lib/api';
import { formatDollar, formatPct, formatRatio, formatPrice } from '../lib/format';

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
function buildFinancialContext(data) {
  if (!data) return 'Dashboard data not yet loaded.';

  const { ticker, kpis, gexByStrike, flowHistory, lastUpdated } = data;
  const k = kpis || {};

  // Top GEX strikes
  const topGex = [...(gexByStrike || [])]
    .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
    .slice(0, 5)
    .map((s) => `  Strike $${s.strike}: Net GEX ${s.gex > 0 ? '+' : ''}${(s.gex / 1e6).toFixed(1)}M (Call: ${(s.callGex / 1e6).toFixed(1)}M, Put: ${(s.putGex / 1e6).toFixed(1)}M)`)
    .join('\n');

  // Recent flow
  const recentFlow = (flowHistory || []).slice(-5)
    .map((f) => `  ${f.date}: Net ${formatDollar(f.netPremium)}, Cum ${formatDollar(f.cumPremium)}, Calls ${f.callVolume}, Puts ${f.putVolume}`)
    .join('\n');

  return `TICKER: ${ticker}
LAST UPDATED: ${lastUpdated}

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
        <div className="whitespace-pre-wrap">{msg.content}</div>
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

export default function ChatBot({ data, isOpen, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-20250514');
  const [availableModels, setAvailableModels] = useState(DEFAULT_MODELS);
  const [loadingModels, setLoadingModels] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

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
    } else {
      sessionStorage.removeItem('anthropic_api_key');
    }
    sessionStorage.setItem('anthropic_model', selectedModel);
    setShowSettings(false);
  }, [apiKey, selectedModel]);

  const clearSettings = useCallback(() => {
    sessionStorage.removeItem('anthropic_api_key');
    sessionStorage.removeItem('anthropic_model');
    setApiKey('');
    setSelectedModel('claude-sonnet-4-20250514');
    setShowSettings(false);
  }, []);

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
    setSending(true);

    try {
      const financialContext = buildFinancialContext(data);
      const apiMessages = newMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-10);

      const userApiKey = sessionStorage.getItem('anthropic_api_key');
      const userModel = sessionStorage.getItem('anthropic_model') || selectedModel;

      const result = await askLLM(
        apiMessages,
        financialContext,
        data?.ticker || 'UNKNOWN',
        userApiKey,
        userModel
      );
      setMessages((prev) => [...prev, { role: 'assistant', content: result.message }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: `Failed to get analysis: ${err.message}` },
      ]);
    } finally {
      setSending(false);
    }
  }, [messages, sending, data, selectedModel]);

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  if (!isOpen) return null;

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
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-..."
              className="w-full bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
            />
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
              Claude · {data?.ticker || '—'} context
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={openSettings}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            aria-label="Settings"
          >
            <Settings size={14} />
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

        {sending && <TypingIndicator />}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-3 py-2.5 border-t border-[var(--color-border-subtle)]"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the flow..."
          className="flex-1 bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
          disabled={sending}
        />
        <button
          type="submit"
          disabled={!input.trim() || sending}
          className="p-2 rounded-lg bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Send message"
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}
