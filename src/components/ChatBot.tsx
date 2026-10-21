// src/components/ChatBot.tsx
// The AI Co-Pilot, the chat in App's sidebar: a shell over the leaves in components/chat/ and two hooks. useChatStream
// runs a reply (one request at a time, its text handed on once per animation frame) and useChatHistory holds the
// messages and is the one writer of their stored history. The shell builds the model context, gives each reply sinks
// over the history's setters, and owns the draft, the inspector and editor toggles, the textarea (focused when the
// chat opens, its height reset after a send) and the scroll.
//
// App keeps the chat mounted while it is closed, and every hook runs before the two early returns: a reply keeps
// streaming while the chat is closed or locked, settles and is stored behind it, and shows on reopen or unlock.
// Mounted only while open, as Settings is, the chat would cut such a reply down to its partial: the unmount saves a
// live reply as far as it got, then detaches it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMarket } from '../contexts/MarketContext.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useStoreValue } from '../hooks/useStoreValue.js';
import { useChatStream } from '../hooks/useChatStream.js';
import type { StreamSinks } from '../hooks/useChatStream.js';
import { useChatHistory } from '../hooks/useChatHistory.js';
import { getPreference } from '../lib/store.js';
import type { ChatMessage as ChatMsg } from '../lib/store.js';
import type { LLMMessage } from '../lib/api.js';
import { getAISettings, readAiModelName } from '../lib/aiSettings.js';
import { buildFinancialContext } from '../lib/financialContext.js';
import type { FinancialContextInput } from '../lib/financialContext.js';
import {
  CONTEXT_UPDATE_PROMPT, appendReplyText, conversationWindow, isTurn, settleReply, withBufferedText,
} from '../lib/chatMessages.js';
import ChatHeader from './chat/ChatHeader.js';
import ContextInspector from './chat/ContextInspector.js';
import ChatEmptyState from './chat/ChatEmptyState.js';
import ChatMessage from './chat/ChatMessage.js';
import TypingIndicator from './chat/TypingIndicator.js';
import ChatComposer from './chat/ChatComposer.js';
import ChatLockScreen from './chat/ChatLockScreen.js';
import StrategicContextEditor from './StrategicContextEditor.js';

interface ChatBotProps {
  /** The sidebar shows the chat. Closed, it renders nothing, and a reply in flight runs on. */
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  /** The ticker's position, for the model context. */
  costBasis: FinancialContextInput['costBasis'];
  shares: FinancialContextInput['shares'];
}

/**
 * The stored strategic context as text, guarded as BackupTab and the editor read it: an import or a cloud row can
 * hold a number, which the context leaves out anyway, or an object, a fresh value per read that would loop
 * useSyncExternalStore.
 */
function readStrategicContext(): string {
  const value = getPreference('strategic_context');
  return typeof value === 'string' ? value : '';
}

export default function ChatBot({ isOpen, onClose, onOpenSettings, costBasis, shares }: ChatBotProps) {
  const { data, tickerContext, marketOpen, optionsMarketOpen, liveQuote } = useMarket();
  const { isPremium } = useAuth();
  // The chat belongs to the market data's ticker, never to the context's, which moves ahead of the data while a search
  // loads: the history, the chat a reply belongs to, the header and the empty state all follow this one.
  const ticker = data?.ticker;
  // The stream first, since the history takes its controls. React runs a component's cleanups in the order its hooks
  // were declared, which is why the stream registers none: the history's unmount cleanup saves a live reply as far as
  // it got, and only then detaches it.
  const stream = useChatStream();
  const { messages, setMessages, setMessagesAndPersist, deleteMessage, clearHistory } = useChatHistory(ticker, stream);
  const { sending, start, stop, bufferedText } = stream;
  const [input, setInput] = useState('');
  const [showContext, setShowContext] = useState(false);
  const [contextEditorOpen, setContextEditorOpen] = useState(false);
  const modelName = useStoreValue(readAiModelName);
  const strategicContext = useStoreValue(readStrategicContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // On open only: the lock lifting leaves isOpen as it was, and the composer it reveals is not focused.
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // The model context as of `now`, one function for a send and for the inspector, so the inspector shows what a send
  // carries. Memoised on what the context reads: the inspector caches its text on this identity, so a changed input
  // (the strategic context included) rebuilds it at once, and a keystroke or a streamed frame does not.
  const buildContext = useCallback((now: number) => buildFinancialContext({
    data, costBasis, shares, tickerContext, strategicContext, marketOpen, optionsMarketOpen, liveQuote, now,
  }), [data, costBasis, shares, tickerContext, strategicContext, marketOpen, optionsMarketOpen, liveQuote]);

  // Where a reply goes: over the history's setters, which are stable, so one object serves every reply. The text
  // streams in unstored; the settle (done, stopped or failed) is the persist point (D10), once per reply.
  const sinks = useMemo<StreamSinks>(() => ({
    placeholder: (lead) => setMessages((prev) => [...prev, ...lead, { role: 'assistant', content: '', pending: true }]),
    append: (text) => setMessages((prev) => appendReplyText(prev, text)),
    settle: (marker) => setMessagesAndPersist((prev) => settleReply(prev, marker)),
    // Stored: the question and any partial reply. The error bubble is shown, not stored (storableMessages).
    fail: (content) => setMessagesAndPersist((prev) => [...settleReply(prev, ''), { role: 'error', content }]),
  }), [setMessages, setMessagesAndPersist]);

  // One reply into this chat; false when start() refused it because a reply is in flight, and then nothing went up.
  // The request is built inside the run, after the placeholder: a context that fails to build becomes the reply's
  // error line with the question kept, and the clock and the AI settings are read at the send.
  const run = useCallback((turns: LLMMessage[], failPrefix: string, lead: ChatMsg[]) => start({
    ticker,
    buildParams: () => {
      const settings = getAISettings();
      return {
        messages: turns,
        financialContext: buildContext(Date.now()),
        ticker: ticker || 'UNKNOWN',
        userApiKey: settings.apiKey || null,
        model: settings.model,
        provider: settings.provider,
      };
    },
    failPrefix,
    lead,
    sinks,
  }), [start, ticker, buildContext, sinks]);

  const sendMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    const userMsg: LLMMessage = { role: 'user', content: text.trim() };
    // The question goes up with the reply's placeholder, so a send refused while a reply is in flight shows nothing
    // and keeps the draft. The turns are the chat as far as it has got (the text still waiting for its frame
    // included), then the question.
    const turns = conversationWindow([...withBufferedText(messages, bufferedText()).filter(isTurn), userMsg]);
    if (!run(turns, 'Failed to get analysis', [userMsg])) return;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
  }, [messages, bufferedText, run]);

  // The prompt is the request's last turn, never shown or stored; the reply comes in a bubble of its own (F7).
  const requestContextSuggestions = useCallback(() => {
    run([
      ...conversationWindow(withBufferedText(messages, bufferedText()).filter(isTurn)),
      { role: 'user', content: CONTEXT_UPDATE_PROMPT },
    ], 'Failed to get suggestions', []);
  }, [messages, bufferedText, run]);

  // Stable: the open editor's Escape listener is an effect on it, and the shell renders on every streamed frame.
  const closeContextEditor = useCallback(() => setContextEditorOpen(false), []);

  if (!isOpen) return null;

  if (!isPremium) {
    return <ChatLockScreen onClose={onClose} />;
  }

  return (
    <div className="flex flex-col h-full border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] w-full">
      <ChatHeader
        modelName={modelName}
        ticker={ticker}
        showContext={showContext}
        onToggleContext={() => setShowContext((v) => !v)}
        onEditContext={() => setContextEditorOpen(true)}
        hasMessages={messages.length > 0}
        onClearHistory={clearHistory}
        onOpenSettings={onOpenSettings}
        onClose={onClose}
      />

      {showContext && <ContextInspector buildContext={buildContext} />}

      {!showContext && <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 space-y-3"
        style={{ overscrollBehavior: 'contain' }}
      >
        {messages.length === 0 && <ChatEmptyState ticker={ticker} onSuggest={sendMessage} />}

        {messages.map((msg, i) => (msg.pending && !msg.content ? null : (
          <ChatMessage key={i} index={i} msg={msg} onDelete={deleteMessage} />
        )))}

        {sending && !messages[messages.length - 1]?.content && <TypingIndicator />}
      </div>}

      <ChatComposer
        ref={inputRef}
        value={input}
        onChange={setInput}
        onSend={sendMessage}
        sending={sending}
        onStop={stop}
        canSuggest={messages.some((m) => m.role === 'assistant')}
        onSuggest={requestContextSuggestions}
      />

      <StrategicContextEditor isOpen={contextEditorOpen} onClose={closeContextEditor} />
    </div>
  );
}
