// src/hooks/useChatHistory.ts
// The chat's messages and the one writer of its stored history (roadmap D10): ChatBot's messages state, its persist
// flag and the effects around them, moved into a hook as they were. The history is read at mount and at a ticker
// change, and written at the persist points (a reply settling, a message deleted), by a Clear, for the old ticker at a
// ticker change, and as far as a reply has got when the page is hidden or the chat unmounts mid-reply. A reload from
// the store never writes, and no write emits: a reload after the chat's own write would wipe an error bubble, which is
// shown and never stored. The stream arrives as three of its controls, and this hook is the only caller of detach():
// a ticker change, a whole-store reset, the unmount. The store's events come through storeEvents.ts's subscribeStore;
// ChatBot's window listener of its own was the last one outside it.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { getChatHistory, setChatHistory } from '../lib/store.js';
import type { ChatMessage } from '../lib/store.js';
import { subscribeStore } from '../lib/storeEvents.js';
import { storableMessages, withBufferedText } from '../lib/chatMessages.js';
import type { StreamControls } from './useChatStream.js';

/** What useChatHistory returns. */
export interface ChatHistory {
  /** The chat on screen: the stored history and what the stream and the user add to it, an error bubble included. */
  messages: ChatMessage[];
  /** Sets the messages and stores nothing: the stream's placeholder and text, which the reply's settle stores. */
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  /**
   * A persist point, for a reply settling (done, stopped or failed): `update` runs as a state updater, and the messages
   * it commits are stored, even when it returns `prev` itself. Stable.
   */
  setMessagesAndPersist: (update: (prev: ChatMessage[]) => ChatMessage[]) => void;
  /** Removes the message at `index` and stores the rest. Stable, so a memo'd bubble takes it as its onDelete. */
  deleteMessage: (index: number) => void;
  /** Asks first, then empties the chat and removes its stored history; a reply still streaming runs on. */
  clearHistory: () => void;
}

// The history of no ticker (before the first market data) is empty: nothing is stored under none (setChatHistory's
// no-op), and getChatHistory takes a string.
const readChat = (ticker: string | undefined): ChatMessage[] => (ticker ? getChatHistory(ticker) : []);

/**
 * The chat history of `ticker`: the market data's (data?.ticker), undefined until the first data arrives, and never the
 * context's ticker, which moves ahead of the data while a search loads.
 *
 * The stream's controls are destructured here, never held as the object that carries `sending`, and their identity is
 * an invariant: the effects below depend on them and on saveLive, which is built on them alone, so those deps never
 * change. A change would run the unmount cleanup mid-reply, which saves the reply and then detaches it (a handle
 * carrying `sending` aborted every reply at its first render, with the lint clean).
 */
export function useChatHistory(
  ticker: string | undefined,
  { detach, live, bufferedText }: StreamControls,
): ChatHistory {
  const prevTickerRef = useRef(ticker);
  // D10: the chat is stored at a few persist points, never per streamed chunk (that was a localStorage write
  // and a whole-history cloud upsert on every animation frame of a reply). The persist points are a reply
  // settling (done, stopped or failed) and a message deleted, through setMessagesAndPersist, which raises this
  // flag; the persist effect writes the state they committed. Clearing the history writes directly, a ticker
  // change saves the old ticker's chat directly, and a page hidden or an unmount mid-reply saves it as far
  // as it got (saveLive). A reload from the store (ticker change, store-changed) never writes.
  const persistOnCommitRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => readChat(ticker));
  // The committed messages, for saveLive and the ticker change: through a ref, so saveLive does not change with every
  // commit (its identity is the unmount cleanup's dep).
  const messagesRef = useRef(messages);
  useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);

  // A persist point: raise the flag, then set the messages; the persist effect writes what was committed.
  // The update always yields a new array, so that commit (and the write) happens even when nothing changes
  // on screen: a reply whose bubble was deleted mid-stream can end with text the store does not have yet.
  const setMessagesAndPersist = useCallback((update: (prev: ChatMessage[]) => ChatMessage[]) => {
    persistOnCommitRef.current = true;
    setMessages((prev) => {
      const next = update(prev);
      return next === prev ? [...prev] : next;
    });
  }, []);

  // Save a reply that is still streaming as far as it got (the question and the text so far, the text still waiting
  // for its frame included), for the page being hidden or the chat unmounting, where no settle follows. Nothing when no
  // reply is live: after a settle the store already holds the latest, and writing this hook's copy back then could
  // restore data a sign-out has just cleared. A reply detached by a ticker change or a reset is not live either. It is
  // written under the reply's own ticker, so a reply sent before the first market data is stored nowhere.
  const saveLive = useCallback(() => {
    const reply = live();
    if (reply) setChatHistory(reply.ticker, storableMessages(withBufferedText(messagesRef.current, bufferedText())));
  }, [live, bufferedText]);

  useEffect(() => {
    if (ticker && ticker !== prevTickerRef.current) {
      // The `ticker &&` half keeps today's guard: a ticker going from a value to none (which useMarketData's kept data
      // never produces) neither detaches the reply nor writes.
      // A reply still streaming belongs to the old ticker: cut it off, and keep what arrived there (the detach hands
      // back the text still waiting for its frame).
      const buffered = detach('ticker');
      // The old ticker's chat as it stands. When market data first arrives there is no old ticker, and
      // setChatHistory writes nothing for a falsy one.
      setChatHistory(prevTickerRef.current, storableMessages(withBufferedText(messagesRef.current, buffered)));
      prevTickerRef.current = ticker;
      // The save above covers a persist still pending; the reload below only reads the store.
      persistOnCommitRef.current = false;
      setMessages(getChatHistory(ticker));
    }
  }, [ticker, detach]);

  // The persist effect. Declared after the ticker-change effect: in a commit that also changes the ticker,
  // that effect saves the old chat and lowers the flag first, so old messages never land under the new ticker.
  useEffect(() => {
    if (!persistOnCommitRef.current) return;
    persistOnCommitRef.current = false;
    setChatHistory(ticker, storableMessages(messages));
  }, [messages, ticker]);

  // Keyed on live(), not on a request in flight: a reply detached by a ticker change is not live though its request
  // may not have ended yet, so the new ticker's chat changing in that window reloads at once (ChatBot's listener,
  // keyed on the request, ignored that event and kept the stale chat).
  useEffect(() => subscribeStore((detail) => {
    if (detail && !(detail.kind === 'chat' && detail.id === ticker)) return; // another item changed
    if (live()) {
      if (detail) return; // this chat changed elsewhere while a reply streams here: keep the on-screen one
      // No detail: everything changed (an import, hydrate, conflict resolution, sign-out, account switch).
      // The store is authoritative: the reply in flight is dropped and nothing of it is written.
      detach('reset');
    }
    persistOnCommitRef.current = false; // a reload only reads the store
    setMessages(readChat(ticker));
  }), [ticker, live, detach]);

  // A tab closed or navigated away mid-reply keeps the question and the partial answer.
  useEffect(() => {
    window.addEventListener('pagehide', saveLive);
    return () => window.removeEventListener('pagehide', saveLive);
  }, [saveLive]);

  // The unmount, and only the unmount: these deps never change (the stream's functions keep one identity, and saveLive
  // is built on two of them); a change would run this cleanup mid-reply, saving the reply and cutting it off.
  // StrictMode runs it once at mount, with no reply live, when both calls do nothing.
  useEffect(() => () => {
    saveLive(); // before the detach: a detached reply neither settles nor persists, and the detach takes the buffer
    detach('unmount');
  }, [saveLive, detach]);

  const deleteMessage = useCallback((index: number) => {
    setMessagesAndPersist((prev) => prev.filter((_, i) => i !== index));
  }, [setMessagesAndPersist]);

  const clearHistory = useCallback(() => {
    const tickerLabel = ticker || 'this ticker';
    if (!window.confirm(`Clear all chat history for ${tickerLabel}? This cannot be undone.`)) {
      return;
    }
    // Written here, once: the empty history supersedes a persist still pending, so the flag is lowered.
    persistOnCommitRef.current = false;
    setMessages([]);
    setChatHistory(ticker, []);
  }, [ticker]);

  return { messages, setMessages, setMessagesAndPersist, deleteMessage, clearHistory };
}
