// src/hooks/useChatHistory.test.jsx — the chat history's writer through renderHook, on a fake stream the test drives
// and the real store under jsdom's localStorage. What is stored for a ticker, and when (roadmap D10): a reply's settle
// and a delete are persist points, each written once as committed, even when the update returns the same array; a
// ticker change saves the old chat, with the text still waiting for its frame, under the old ticker only, also when a
// settle lands in the same commit (the effects' order); before the first market data nothing is stored under any key;
// a pagehide or an unmount mid-reply saves the reply as far as it got, the unmount before it detaches; a whole-store
// change detaches a live reply and writes nothing, this chat's change is ignored while a reply is live, any other item's is
// ignored; Clear asks first and supersedes a persist pending in its batch; nothing stored carries `pending` or an error
// bubble, and no write emits. The stream's controls keep their identity, so a new handle object carrying the same three
// functions runs no cleanup. Under StrictMode the mount's extra cleanup detaches nothing live and writes nothing; the
// order of the fake's calls is never asserted there. The recipes are the PR 3 attack report's (the history lens).
import { StrictMode } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { emitStoreChanged, setChatHistory } from '../lib/store.js';
import { subscribeStore } from '../lib/storeEvents.js';
import { appendReplyText, settleReply } from '../lib/chatMessages.js';
import { useChatHistory } from './useChatHistory.js';

/**
 * A stream's three controls, driven by the test: begin(ticker) makes a reply live, buffer(text) adds streamed text no
 * frame has handed on yet, end() finishes the reply (its request has ended). detach(reason) is recorded in `calls`; it
 * cuts a live reply off and hands back its buffered text, and returns '' when nothing is live, as useChatStream's does.
 * Created once per test, outside renderHook, so its functions keep one identity, as the stream's do.
 */
function fakeStream() {
  let current = null; // the live reply: { ticker }
  let buf = '';
  const calls = [];
  const handle = {
    detach: (reason) => {
      calls.push(reason);
      if (!current) return '';
      current = null;
      const text = buf;
      buf = '';
      return text;
    },
    live: () => current,
    bufferedText: () => buf,
  };
  return {
    calls,
    handle,
    begin: (ticker) => { current = { ticker }; },
    buffer: (text) => { buf += text; },
    end: () => { current = null; buf = ''; },
  };
}

/** The hook on `f`'s controls, the ticker a prop passed as it is: undefined stays undefined (no default to fill it). */
const mountOn = (f, ticker, options = {}) => renderHook(
  ({ t }) => useChatHistory(t, f.handle),
  { initialProps: { t: ticker }, ...options },
);

const Q1 = { role: 'user', content: 'Q1' };
const Q2 = { role: 'user', content: 'Q2' };
const reply = (content) => ({ role: 'assistant', content });
/** The streaming reply's bubble; the placeholder while its content is ''. */
const pending = (content) => ({ role: 'assistant', content, pending: true });

/** A ticker's stored history, parsed; null while it has none. */
const stored = (ticker = 'AVGO') => JSON.parse(localStorage.getItem(`chat_history_${ticker}`) ?? 'null');
const chatKeys = () => Object.keys(localStorage).filter((key) => key.startsWith('chat_history_')).sort();
const pagehide = () => act(() => { window.dispatchEvent(new Event('pagehide')); });

/**
 * The chat-history writes from here on, as [method, key], a removal included (setChatHistory with [] removes the key).
 * restoreMocks puts the real Storage methods back before the next test.
 */
function recordChatWrites() {
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
  return () => [
    ...setItem.mock.calls.map(([key]) => ['set', key]),
    ...removeItem.mock.calls.map(([key]) => ['remove', key]),
  ].filter(([, key]) => key.startsWith('chat_history_'));
}

describe('useChatHistory', () => {
  it('shows the stored history at mount and writes nothing; it hands back five members, saveLive stays inside', () => {
    setChatHistory('AVGO', [Q1, reply('A1')]);
    const writes = recordChatWrites();
    const f = fakeStream();
    const { result } = mountOn(f, 'AVGO');
    expect(result.current.messages).toEqual([Q1, reply('A1')]);
    expect(Object.keys(result.current).sort())
      .toEqual(['clearHistory', 'deleteMessage', 'messages', 'setMessages', 'setMessagesAndPersist']);

    // The stream's placeholder and text go through setMessages, which stores nothing.
    act(() => { result.current.setMessages((prev) => [...prev, Q2, pending('')]); });
    act(() => { result.current.setMessages((prev) => appendReplyText(prev, 'Hel')); });
    expect(result.current.messages).toEqual([Q1, reply('A1'), Q2, pending('Hel')]);
    expect(writes()).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("loads the first market data's chat; before it, a persist point and the switch store nothing", () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'AVGO history' }]);
    const f = fakeStream();
    const { result, rerender } = mountOn(f, undefined);
    expect(result.current.messages).toEqual([]);
    act(() => { result.current.setMessagesAndPersist(() => [{ role: 'user', content: 'early' }, reply('answer')]); });
    expect(result.current.messages).toEqual([{ role: 'user', content: 'early' }, reply('answer')]);
    expect(chatKeys()).toEqual(['chat_history_AVGO']);

    rerender({ t: 'AVGO' });
    expect(result.current.messages).toEqual([{ role: 'user', content: 'AVGO history' }]);
    expect(localStorage.getItem('chat_history_undefined')).toBeNull();
    expect(chatKeys()).toEqual(['chat_history_AVGO']);
    expect(stored()).toEqual([{ role: 'user', content: 'AVGO history' }]);
  });

  it('a reply sent before any market data is stored nowhere: at pagehide, the first ticker or the unmount', () => {
    const f = fakeStream();
    const { result, rerender, unmount } = mountOn(f, undefined);
    act(() => { result.current.setMessages([{ role: 'user', content: 'early' }, pending('par')]); });
    f.begin(undefined); // the reply's ticker is the data's at the send: none yet (its request says 'UNKNOWN')
    f.buffer('tial');
    pagehide();
    expect(chatKeys()).toEqual([]);
    expect(f.calls).toEqual([]);

    rerender({ t: 'AVGO' });
    expect(f.calls).toEqual(['ticker']);
    expect(f.handle.live()).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(chatKeys()).toEqual([]);

    unmount();
    expect(chatKeys()).toEqual([]);
  });

  it('a ticker change cuts the reply off, saves the old chat with its buffered text, then loads the new one', () => {
    const n1 = { role: 'user', content: 'n1' };
    const n2 = reply('n2');
    setChatHistory('NVDA', [n1, n2]);
    const f = fakeStream();
    const { result, rerender } = mountOn(f, 'AVGO');
    act(() => { result.current.setMessages([Q1, pending('Hel')]); });
    f.begin('AVGO');
    f.buffer('lo');
    const writes = recordChatWrites();

    rerender({ t: 'NVDA' });
    expect(f.calls).toEqual(['ticker']);
    expect(f.handle.live()).toBeNull();
    expect(stored('AVGO')).toEqual([Q1, reply('Hello')]);
    expect(result.current.messages).toEqual([n1, n2]);
    expect(writes()).toEqual([['set', 'chat_history_AVGO']]); // the reload only read NVDA's
    expect(stored('NVDA')).toEqual([n1, n2]);

    // The reply is not NVDA's: a pagehide after the change saves nothing of it, and a persist point writes NVDA's.
    pagehide();
    expect(writes()).toEqual([['set', 'chat_history_AVGO']]);
    act(() => { result.current.deleteMessage(0); });
    expect(stored('NVDA')).toEqual([n2]);
    expect(stored('AVGO')).toEqual([Q1, reply('Hello')]);

    // The next change saves NVDA's chat under NVDA, the ticker it now follows.
    act(() => { result.current.setMessages((prev) => [...prev, Q2]); });
    rerender({ t: 'TSLA' });
    expect(stored('NVDA')).toEqual([n2, Q2]);
    expect(stored('AVGO')).toEqual([Q1, reply('Hello')]);
    expect(result.current.messages).toEqual([]);
  });

  // The stream's end and the market data's update can land in one batch: the ticker change's save, declared first,
  // lowers the flag the settle raised, so the persist effect does not write the old chat under the new ticker.
  it('a reply that settles in the same commit as a ticker change is stored under the old ticker only', () => {
    const f = fakeStream();
    const { result, rerender } = mountOn(f, 'AVGO');
    act(() => { result.current.setMessages([Q1, pending('Hello')]); });
    f.begin('AVGO');
    act(() => {
      f.end(); // the reply's request has ended; its settle and the new market data land in one batch
      result.current.setMessagesAndPersist((prev) => settleReply(prev, ''));
      rerender({ t: 'NVDA' });
    });
    expect(stored('AVGO')).toEqual([Q1, reply('Hello')]);
    expect(stored('NVDA')).toBeNull();
    expect(result.current.messages).toEqual([]);
  });

  // Deleting the streaming bubble leaves no assistant tail; the text after it re-creates the reply without the pending
  // flag, so the settle (no marker) returns the array it was given, and only the always-new array commits the write.
  it('a persist point stores what it commits even when its update returns the same array', () => {
    const f = fakeStream();
    const { result } = mountOn(f, 'AVGO');
    act(() => { result.current.setMessages([Q1, pending('Hello')]); });
    f.begin('AVGO');
    act(() => { result.current.deleteMessage(1); });
    expect(stored()).toEqual([Q1]);
    act(() => { result.current.setMessages((prev) => appendReplyText(prev, ' world')); });
    expect(stored()).toEqual([Q1]);

    f.end();
    const before = result.current.messages;
    act(() => { result.current.setMessagesAndPersist((prev) => settleReply(prev, '')); });
    expect(result.current.messages).not.toBe(before);
    expect(result.current.messages).toEqual([Q1, reply(' world')]);
    expect(stored()).toEqual([Q1, reply(' world')]);
  });

  describe('store-changed', () => {
    it('a whole-store change (no detail) reloads the chat while no reply is live, and writes nothing', () => {
      setChatHistory('AVGO', [{ role: 'user', content: 'before' }]);
      const f = fakeStream();
      const { result } = mountOn(f, 'AVGO');
      setChatHistory('AVGO', [{ role: 'user', content: 'imported' }]);
      act(() => { window.dispatchEvent(new Event('store-changed')); }); // a plain Event carries no detail either
      expect(result.current.messages).toEqual([{ role: 'user', content: 'imported' }]);

      setChatHistory('AVGO', [{ role: 'user', content: 'rewritten' }]);
      const writes = recordChatWrites();
      act(() => { emitStoreChanged(); });
      expect(result.current.messages).toEqual([{ role: 'user', content: 'rewritten' }]);
      expect(writes()).toEqual([]);
      expect(f.calls).toEqual([]);
    });

    it('a whole-store change mid-reply detaches it for reset, shows the store and writes none of it', () => {
      const f = fakeStream();
      const { result, unmount } = mountOn(f, 'AVGO');
      act(() => { result.current.setMessages([Q1, pending('Second')]); });
      f.begin('AVGO');
      f.buffer(' buffered');
      setChatHistory('AVGO', [{ role: 'user', content: 'imported' }]);
      const writes = recordChatWrites();

      act(() => { emitStoreChanged(); });
      expect(f.calls).toEqual(['reset']);
      expect(f.handle.live()).toBeNull();
      expect(result.current.messages).toEqual([{ role: 'user', content: 'imported' }]);
      expect(writes()).toEqual([]);

      // Detached, the reply is saved by nothing after it, the unmount included.
      pagehide();
      unmount();
      expect(writes()).toEqual([]);
      expect(stored()).toEqual([{ role: 'user', content: 'imported' }]);
    });

    it("this chat's own change (kind chat, this ticker) reloads it while no reply is live", () => {
      setChatHistory('AVGO', [{ role: 'user', content: 'one' }]);
      const f = fakeStream();
      const { result } = mountOn(f, 'AVGO');
      setChatHistory('AVGO', [{ role: 'user', content: 'two' }]);
      const writes = recordChatWrites();
      act(() => { emitStoreChanged({ kind: 'chat', id: 'AVGO' }); });
      expect(result.current.messages).toEqual([{ role: 'user', content: 'two' }]);
      expect(writes()).toEqual([]);
      expect(f.calls).toEqual([]);
    });

    it("this chat's own change mid-reply is ignored: the reply on screen wins, its settle stored over it", () => {
      const f = fakeStream();
      const { result } = mountOn(f, 'AVGO');
      act(() => { result.current.setMessages([Q1, pending('Hello')]); });
      f.begin('AVGO');
      setChatHistory('AVGO', [{ role: 'user', content: 'elsewhere' }]);

      act(() => { emitStoreChanged({ kind: 'chat', id: 'AVGO' }); });
      expect(result.current.messages).toEqual([Q1, pending('Hello')]);
      expect(f.calls).toEqual([]);
      expect(f.handle.live()).toEqual({ ticker: 'AVGO' });

      f.end();
      act(() => { result.current.setMessagesAndPersist((prev) => settleReply(prev, '')); });
      expect(stored()).toEqual([Q1, reply('Hello')]);
    });

    it.each([
      ["another ticker's chat", { kind: 'chat', id: 'NVDA' }],
      ['a preference', { kind: 'pref', id: 'ai_model' }],
      ['a position', { kind: 'position', id: 'AVGO' }],
    ])('%s changing leaves the chat as it is shown, with or without a reply live', (_label, detail) => {
      setChatHistory('AVGO', [{ role: 'user', content: 'shown' }]);
      const f = fakeStream();
      const { result } = mountOn(f, 'AVGO');
      setChatHistory('AVGO', [{ role: 'user', content: 'written without an event' }]);
      act(() => { emitStoreChanged(detail); });
      expect(result.current.messages).toEqual([{ role: 'user', content: 'shown' }]);

      act(() => { result.current.setMessages((prev) => [...prev, Q2, pending('x')]); });
      f.begin('AVGO');
      act(() => { emitStoreChanged(detail); });
      expect(result.current.messages).toEqual([{ role: 'user', content: 'shown' }, Q2, pending('x')]);
      expect(f.calls).toEqual([]);
    });

    // A reload only reads the store. Here a delete's persist is still pending in the same batch, as a reply's settle
    // can be when an import lands: the store's history wins, and the pending persist must not write it back.
    it('a reload from the store writes nothing, even over a persist still pending in its batch', () => {
      const m0 = { role: 'user', content: 'm0' };
      setChatHistory('AVGO', [m0, reply('m1')]);
      const f = fakeStream();
      const { result } = mountOn(f, 'AVGO');
      const writes = recordChatWrites();
      act(() => {
        result.current.deleteMessage(1);
        emitStoreChanged();
      });
      expect(result.current.messages).toEqual([m0, reply('m1')]);
      expect(writes()).toEqual([]);
      expect(stored()).toEqual([m0, reply('m1')]);
    });

    it("after a ticker change the events follow the new ticker's chat, not the old one's", () => {
      setChatHistory('NVDA', [{ role: 'user', content: 'n1' }]);
      const f = fakeStream();
      const { result, rerender } = mountOn(f, 'AVGO');
      rerender({ t: 'NVDA' });
      expect(result.current.messages).toEqual([{ role: 'user', content: 'n1' }]);

      setChatHistory('AVGO', [{ role: 'user', content: 'avgo elsewhere' }]);
      act(() => { emitStoreChanged({ kind: 'chat', id: 'AVGO' }); });
      expect(result.current.messages).toEqual([{ role: 'user', content: 'n1' }]);

      setChatHistory('NVDA', [{ role: 'user', content: 'n2' }]);
      act(() => { emitStoreChanged({ kind: 'chat', id: 'NVDA' }); });
      expect(result.current.messages).toEqual([{ role: 'user', content: 'n2' }]);
    });
  });

  it('a pagehide mid-reply saves it as far as it got, buffered text included, and leaves the reply running', () => {
    const f = fakeStream();
    const { result } = mountOn(f, 'AVGO');
    act(() => { result.current.setMessages([Q1, pending('Hel')]); });
    f.begin('AVGO');
    f.buffer('lo');
    pagehide();
    expect(stored()).toEqual([Q1, reply('Hello')]);
    expect(f.calls).toEqual([]);
    expect(f.handle.live()).toEqual({ ticker: 'AVGO' });
    expect(f.handle.bufferedText()).toBe('lo');

    // No reply live, no write: the store already holds the last settle, or what a sign-out has just cleared.
    f.end();
    localStorage.clear();
    pagehide();
    expect(chatKeys()).toEqual([]);
  });

  it('an unmount mid-reply saves it as far as it got, buffered text included, and then detaches it', () => {
    const f = fakeStream();
    const { result, unmount } = mountOn(f, 'AVGO');
    act(() => { result.current.setMessages([Q1, pending('Hel')]); });
    f.begin('AVGO');
    f.buffer('lo');
    unmount();
    expect(stored()).toEqual([Q1, reply('Hello')]);
    expect(f.calls).toEqual(['unmount']);
    expect(f.handle.live()).toBeNull();
  });

  it('an unmount with no reply live writes nothing, so a store emptied just before stays empty', () => {
    setChatHistory('AVGO', [Q1, reply('A1')]);
    const f = fakeStream();
    const { unmount } = mountOn(f, 'AVGO');
    localStorage.clear();
    const writes = recordChatWrites();
    unmount();
    expect(writes()).toEqual([]);
    expect(chatKeys()).toEqual([]);
    expect(f.calls).toEqual(['unmount']);
  });

  // Sign-out clears the store and emits a no-detail change, and the chat then unmounts: in one batch, the unmount runs
  // while the dropped reply is still the committed state, and only its detach keeps the unmount from saving it.
  it('a whole-store reset and the unmount in one batch, as at sign-out, write nothing', () => {
    const f = fakeStream();
    const { result, unmount } = mountOn(f, 'AVGO');
    act(() => { result.current.setMessages([Q1, pending('Part')]); });
    f.begin('AVGO');
    f.buffer(' more');
    act(() => {
      localStorage.clear();
      emitStoreChanged();
      unmount();
    });
    expect(chatKeys()).toEqual([]);
    expect(f.calls).toEqual(['reset', 'unmount']);
  });

  it("under StrictMode the mount's extra cleanup writes and detaches nothing; a settle is written once", () => {
    setChatHistory('AVGO', [Q1, reply('A1')]);
    const writes = recordChatWrites();
    const f = fakeStream();
    const { result } = mountOn(f, 'AVGO', { wrapper: StrictMode });
    expect(f.calls).toContain('unmount');
    expect(writes()).toEqual([]);
    expect(result.current.messages).toEqual([Q1, reply('A1')]);

    act(() => { result.current.setMessages((prev) => [...prev, Q2, pending('Hel')]); });
    f.begin('AVGO');
    act(() => { result.current.setMessages((prev) => appendReplyText(prev, 'lo')); });
    f.end();
    act(() => { result.current.setMessagesAndPersist((prev) => settleReply(prev, '')); });
    expect(stored()).toEqual([Q1, reply('A1'), Q2, reply('Hello')]);
    expect(writes()).toEqual([['set', 'chat_history_AVGO']]);
  });

  // useChatStream returns a new object on every render, its functions the same and `sending` flipping: effects that
  // followed the object would run the unmount cleanup at the reply's first render, saving it and cutting it off.
  it('a new handle object carrying the same three functions runs no cleanup: nothing detached, nothing written', () => {
    const f = fakeStream();
    const handle = (sending) => ({ ...f.handle, sending });
    const { result, rerender } = renderHook(({ t, stream }) => useChatHistory(t, stream), {
      initialProps: { t: 'AVGO', stream: handle(false) },
    });
    const writes = recordChatWrites();
    act(() => { result.current.setMessages([Q1, pending('')]); });
    f.begin('AVGO');
    rerender({ t: 'AVGO', stream: handle(true) });
    act(() => { result.current.setMessages((prev) => appendReplyText(prev, 'Hel')); });
    f.buffer('lo');
    rerender({ t: 'AVGO', stream: handle(true) });
    expect(f.calls).toEqual([]);
    expect(writes()).toEqual([]);
    expect(f.handle.live()).toEqual({ ticker: 'AVGO' });
    expect(result.current.messages).toEqual([Q1, pending('Hel')]);
  });

  it('setMessages, setMessagesAndPersist and deleteMessage keep their identity across renders and tickers', () => {
    const f = fakeStream();
    const { result, rerender } = mountOn(f, 'AVGO');
    const { setMessages, setMessagesAndPersist, deleteMessage } = result.current;
    act(() => { result.current.setMessages([Q1]); });
    rerender({ t: 'NVDA' });
    expect(result.current.setMessages).toBe(setMessages);
    expect(result.current.setMessagesAndPersist).toBe(setMessagesAndPersist);
    expect(result.current.deleteMessage).toBe(deleteMessage);
  });

  it('Clear asks first; a yes empties the chat and removes its stored history, and a reply in flight runs on', () => {
    setChatHistory('AVGO', [Q1, reply('A1')]);
    const f = fakeStream();
    const { result } = mountOn(f, 'AVGO');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => { result.current.clearHistory(); });
    expect(confirm).toHaveBeenCalledWith('Clear all chat history for AVGO? This cannot be undone.');
    expect(result.current.messages).toEqual([Q1, reply('A1')]);
    expect(stored()).toEqual([Q1, reply('A1')]);

    act(() => { result.current.setMessages((prev) => [...prev, Q2, pending('Hel')]); });
    f.begin('AVGO');
    confirm.mockReturnValue(true);
    act(() => { result.current.clearHistory(); });
    expect(result.current.messages).toEqual([]);
    expect(localStorage.getItem('chat_history_AVGO')).toBeNull();
    // Today's behaviour, kept: Clear leaves the reply streaming, and its settle stores what came after the Clear.
    expect(f.calls).toEqual([]);
    expect(f.handle.live()).toEqual({ ticker: 'AVGO' });
  });

  it("Clear before the first market data asks about 'this ticker' and writes nothing", () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const f = fakeStream();
    const { result } = mountOn(f, undefined);
    act(() => { result.current.setMessages([Q1]); });
    act(() => { result.current.clearHistory(); });
    expect(confirm).toHaveBeenCalledWith('Clear all chat history for this ticker? This cannot be undone.');
    expect(result.current.messages).toEqual([]);
    expect(chatKeys()).toEqual([]);
  });

  // Clear writes the empty history itself, once: a persist still pending in its batch is superseded, so text that
  // reaches the chat after the Clear in that batch waits for a later persist point.
  it('Clear supersedes a persist still pending in its batch', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const f = fakeStream();
    const { result } = mountOn(f, 'AVGO');
    act(() => { result.current.setMessages([Q1, pending('Hello')]); });
    f.begin('AVGO');
    act(() => {
      result.current.deleteMessage(0);
      result.current.clearHistory();
      result.current.setMessages((prev) => appendReplyText(prev, ' world')); // a frame's text
    });
    expect(result.current.messages).toEqual([reply(' world')]);
    expect(localStorage.getItem('chat_history_AVGO')).toBeNull();

    f.end();
    act(() => { result.current.setMessagesAndPersist((prev) => settleReply(prev, '')); });
    expect(stored()).toEqual([reply(' world')]);
  });

  it('Delete message removes that message and stores the rest', () => {
    const m0 = { role: 'user', content: 'm0' };
    const m2 = { role: 'user', content: 'm2' };
    setChatHistory('AVGO', [m0, reply('m1'), m2]);
    const f = fakeStream();
    const { result } = mountOn(f, 'AVGO');
    act(() => { result.current.deleteMessage(1); });
    expect(result.current.messages).toEqual([m0, m2]);
    expect(stored()).toEqual([m0, m2]);

    act(() => { result.current.deleteMessage(0); });
    expect(result.current.messages).toEqual([m2]);
    expect(stored()).toEqual([m2]);
  });

  it('stores no pending flag, no empty placeholder and no error bubble, whichever path writes', () => {
    const unstorable = () => chatKeys()
      .flatMap((key) => JSON.parse(localStorage.getItem(key)))
      .filter((m) => 'pending' in m || m.role === 'error' || !m.content);
    const f = fakeStream();
    const { result, rerender } = mountOn(f, 'AVGO');
    act(() => { result.current.setMessages([Q1, pending('')]); });
    f.begin('AVGO');
    pagehide(); // the reply's bubble is still the empty placeholder
    expect(stored()).toEqual([Q1]);

    act(() => { result.current.setMessages((prev) => appendReplyText(prev, 'Pa')); });
    f.buffer('rt');
    pagehide();
    expect(stored()).toEqual([Q1, reply('Part')]);

    // The reply fails: its buffered text handed on, then the settle with the error bubble after it.
    act(() => { result.current.setMessages((prev) => appendReplyText(prev, 'rt')); });
    f.end();
    const error = { role: 'error', content: 'Failed to get analysis: Overloaded (ref req-1)' };
    act(() => { result.current.setMessagesAndPersist((prev) => [...settleReply(prev, ''), error]); });
    expect(result.current.messages).toEqual([Q1, reply('Part'), error]);
    expect(stored()).toEqual([Q1, reply('Part')]);

    act(() => { result.current.deleteMessage(0); }); // a persist point with the error bubble shown
    expect(result.current.messages).toEqual([reply('Part'), error]);
    expect(stored()).toEqual([reply('Part')]);

    // A ticker change with the error bubble still shown and the next reply's placeholder still empty.
    act(() => { result.current.setMessages((prev) => [...prev, Q2, pending('')]); });
    f.begin('AVGO');
    rerender({ t: 'NVDA' });
    expect(stored('AVGO')).toEqual([reply('Part'), Q2]);
    expect(unstorable()).toEqual([]);
  });

  // Nothing tells the chat about its own writes: a reload after each would wipe an error bubble, which is shown and
  // never stored.
  it('its own writes emit no store-changed: pagehide, settle, delete, clear, ticker change, unmount', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const heard = vi.fn();
    onTestFinished(subscribeStore(heard));
    const f = fakeStream();
    const { result, rerender, unmount } = mountOn(f, 'AVGO');
    act(() => { result.current.setMessages([Q1, pending('Hel')]); });
    f.begin('AVGO');
    f.buffer('lo');
    pagehide();
    expect(stored()).toEqual([Q1, reply('Hello')]);

    act(() => { result.current.setMessages((prev) => appendReplyText(prev, 'lo')); });
    f.end();
    act(() => { result.current.setMessagesAndPersist((prev) => settleReply(prev, '')); });
    act(() => { result.current.deleteMessage(0); });
    expect(stored()).toEqual([reply('Hello')]);
    act(() => { result.current.clearHistory(); });
    expect(stored()).toBeNull();

    act(() => { result.current.setMessages([Q2, pending('Pa')]); });
    f.begin('AVGO');
    f.buffer('rt');
    rerender({ t: 'NVDA' });
    expect(stored('AVGO')).toEqual([Q2, reply('Part')]);

    act(() => { result.current.setMessages((prev) => [...prev, Q1, pending('x')]); });
    f.begin('NVDA');
    unmount();
    expect(stored('NVDA')).toEqual([Q1, reply('x')]);
    expect(heard).not.toHaveBeenCalled();
  });
});
