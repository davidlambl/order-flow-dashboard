// src/components/ChatBot.tsx
// The AI Co-Pilot, the chat in App's sidebar: a shell over the leaves in components/chat/ and two hooks. useChatStream
// runs a reply (one request at a time, its text handed on once per animation frame) and useChatHistory holds the
// messages and is the one writer of their stored history. The shell builds the model context, gives each reply sinks
// over the history's setters, and owns the draft, the inspector and editor toggles, the textarea (focused when the
// chat opens, its height reset after a send), the status line and the scroll.
//
// App keeps the chat mounted while it is closed, and every hook runs before the two early returns: a reply keeps
// streaming while the chat is closed or locked, settles and is stored behind it, and shows on reopen or unlock.
// Mounted only while open, as Settings is, the chat would cut such a reply down to its partial: the unmount saves a
// live reply as far as it got, then detaches it.
//
// A failed request leaves an error bubble whose Retry asks the same request again (lib/chatMessages.ts's failReply,
// retryBase and retryPlaceholder): the question and any partial reply stay on screen and in the store, the partial
// replies are left out of the request, which ends on the user's question (or on the suggestions' prompt), and the
// error bubble, which is never stored, is the only message a Retry removes. The textarea stays enabled while a reply
// streams, so a draft can be typed ahead; a send then is refused by start(), which keeps the draft. A start from a
// button that then hides (Retry, Suggest updates, a suggestion of the empty state) puts focus in the composer. One
// visually hidden status line, in the tree for as long as the chat is open and unlocked, says when a reply starts and
// how it ended; a failure is the error bubble's alert to say.

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
  CONTEXT_UPDATE_PROMPT, appendReplyText, conversationWindow, failReply, isTurn, retryBase, retryPlaceholder,
  settleReply, withBufferedText,
} from '../lib/chatMessages.js';
import type { RetryKind } from '../lib/chatMessages.js';
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

/** How each kind of request's error line opens. */
const FAIL_PREFIX: Record<RetryKind, string> = {
  send: 'Failed to get analysis',
  suggest: 'Failed to get suggestions',
};

/** A send's or a suggestions request's placeholder: what goes up with it (`lead`), then the empty pending reply. */
const appendPlaceholder = (prev: ChatMsg[], lead: ChatMsg[]): ChatMsg[] => (
  [...prev, ...lead, { role: 'assistant', content: '', pending: true }]
);

/** The status line while a reply is in flight. */
const REPLYING = 'The assistant is replying.';

/**
 * The status line once a reply has ended, from its stop marker: complete when it ended normally, stopped by the Stop
 * button (useChatStream's '*(stopped)*'), cut off when it ended any other way (the token limit, the stream closing
 * early, the model stopping for another reason).
 */
function replyEnded(marker: string): string {
  if (!marker) return 'Reply complete.';
  return marker === '*(stopped)*' ? 'Reply stopped.' : 'Reply cut off.';
}

/**
 * An error bubble's key: one per bubble object, which the fail sink creates and nothing changes afterwards (settleReply
 * and appendReplyText touch a pending assistant tail only). The bubble of a Retry that fails again is then a new
 * element even where it takes its predecessor's place, in the same batch when the request fails while it is built, so
 * its alert is announced again; an index key would keep the old node, unchanged and silent. A WeakMap: a bubble that
 * leaves the chat leaves the map.
 */
const errorKeys = new WeakMap<ChatMsg, string>();
let errorCount = 0;
function errorKey(msg: ChatMsg): string {
  let key = errorKeys.get(msg);
  if (key === undefined) {
    errorCount += 1;
    key = `error-${errorCount}`;
    errorKeys.set(msg, key);
  }
  return key;
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
  // How the last reply ended, for the status line once nothing is in flight. Back to '' at every start, so a reply
  // that fails, or is cut off for a chat it no longer belongs to, leaves the line empty rather than the last sentence.
  const [replyEnd, setReplyEnd] = useState('');
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

  // Where a reply goes: over the history's setters, which are stable. The text streams in unstored and only into the
  // request's own reply (appendReplyText, settleReply); the settle (done, stopped or failed) is the persist point
  // (D10), once per reply. Every start builds its own sinks with its kind, its placeholder and `after`, its anchor:
  // the message the request was asked after (a send's question, the suggestions' last message at the click, a retry's
  // last message of the chat its first attempt was asked on). failReply counts every attempt's partial replies after
  // it, and leaves a bubble that cannot be retried once it is gone.
  const makeSinks = useCallback((
    kind: RetryKind,
    placeholder: (prev: ChatMsg[], lead: ChatMsg[]) => ChatMsg[],
    after: ChatMsg | undefined,
  ): StreamSinks => ({
    placeholder: (lead) => {
      setReplyEnd('');
      setMessages((prev) => placeholder(prev, lead));
    },
    append: (text) => setMessages((prev) => appendReplyText(prev, text)),
    settle: (marker) => {
      setMessagesAndPersist((prev) => settleReply(prev, marker));
      setReplyEnd(replyEnded(marker));
    },
    // Stored: the question and any partial reply. The error bubble is shown, not stored (storableMessages).
    fail: (content) => setMessagesAndPersist((prev) => failReply(prev, content, kind, after)),
  }), [setMessages, setMessagesAndPersist]);

  // One reply into this chat; false when start() refused it because a reply is in flight, and then nothing went up.
  // The request is built inside the run, after the placeholder: a context that fails to build becomes the reply's
  // error line with the question kept, and the clock and the AI settings are read at the send.
  const run = useCallback((turns: LLMMessage[], kind: RetryKind, lead: ChatMsg[], sinks: StreamSinks) => start({
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
    failPrefix: FAIL_PREFIX[kind],
    lead,
    sinks,
  }), [start, ticker, buildContext]);

  // True when the send went up.
  const sendMessage = useCallback((text: string): boolean => {
    if (!text.trim()) return false;
    const userMsg: LLMMessage = { role: 'user', content: text.trim() };
    // The question goes up with the reply's placeholder, so a send refused while a reply is in flight shows nothing
    // and keeps the draft. The turns are the chat as far as it has got (the text still waiting for its frame
    // included), then the question.
    const turns = conversationWindow([...withBufferedText(messages, bufferedText()).filter(isTurn), userMsg]);
    if (!run(turns, 'send', [userMsg], makeSinks('send', appendPlaceholder, userMsg))) return false;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    return true;
  }, [messages, bufferedText, run, makeSinks]);

  // A suggestion of the empty state sends as if typed. Once it is accepted the empty state goes, the pressed button
  // with it, and focus would fall to the page: the composer takes it. (Here and below, a refused start leaves it.)
  const sendSuggestion = useCallback((text: string) => {
    if (sendMessage(text)) inputRef.current?.focus();
  }, [sendMessage]);

  // The prompt is the request's last turn, never shown or stored; the reply comes in a bubble of its own (F7). The
  // button hides while the reply streams, so focus goes to the composer.
  const requestContextSuggestions = useCallback(() => {
    const accepted = run([
      ...conversationWindow(withBufferedText(messages, bufferedText()).filter(isTurn)),
      { role: 'user', content: CONTEXT_UPDATE_PROMPT },
    ], 'suggest', [], makeSinks('suggest', appendPlaceholder, messages[messages.length - 1]));
    if (accepted) inputRef.current?.focus();
  }, [messages, bufferedText, run, makeSinks]);

  // What the last message's Retry would ask again, or null when it cannot be asked (lib/chatMessages.ts's retryBase).
  const retryable = useMemo(() => retryBase(messages), [messages]);

  // Retry: the failed request again, on the chat it was asked on, its partial replies left out (they stay on screen and
  // in the store). The turns are the ones the click saw; the placeholder lands on the messages as they stand then
  // (retryPlaceholder): in the error bubble's place, or after the clicked question if the chat was reloaded in between.
  // The bubble goes with the start, the Retry button with it: focus goes to the composer.
  const retry = useCallback(() => {
    if (!retryable) return;
    const { base, kind } = retryable;
    const recent = conversationWindow(base.filter(isTurn));
    const turns: LLMMessage[] = kind === 'send' ? recent : [...recent, { role: 'user', content: CONTEXT_UPDATE_PROMPT }];
    const lead = kind === 'send' ? base.slice(-1) : [];
    const sinks = makeSinks(kind, (prev) => retryPlaceholder(prev, lead), base[base.length - 1]);
    if (run(turns, kind, [], sinks)) inputRef.current?.focus();
  }, [retryable, makeSinks, run]);

  // Stable: the open editor's Escape listener is an effect on it, and the shell renders on every streamed frame.
  const closeContextEditor = useCallback(() => setContextEditorOpen(false), []);

  if (!isOpen) return null;

  if (!isPremium) {
    return <ChatLockScreen onClose={onClose} />;
  }

  // Offered on the last message alone, and not while a reply is in flight (start() would refuse it).
  const canRetry = !sending && retryable !== null;

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
        {messages.length === 0 && <ChatEmptyState ticker={ticker} onSuggest={sendSuggestion} />}

        {messages.map((msg, i) => (msg.pending && !msg.content ? null : (
          <ChatMessage
            key={msg.role === 'error' ? errorKey(msg) : i}
            index={i}
            msg={msg}
            onDelete={deleteMessage}
            onRetry={canRetry && i === messages.length - 1 ? retry : undefined}
          />
        )))}

        {sending && !messages[messages.length - 1]?.content && <TypingIndicator />}
      </div>}

      {/* The chat's one status line: visually hidden, and in the tree from the open chat's first render (a closed or
          locked chat renders none of this, so one reopened mid-reply mounts the line already saying so), since a live
          region announces a change inside it; it changes at every start, so the same closing sentence is said every
          time. */}
      <div role="status" className="sr-only">{sending ? REPLYING : replyEnd}</div>

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
