// src/hooks/useChatStream.ts
// The chat's reply stream: one askLLM request at a time, its text handed on once per animation frame, and its end
// reported to the sinks the request brings. ChatBot's runStream with its refs (the guard, the chunk buffer and its
// frame, the reply in flight) as a hook that holds no messages: the caller's setters arrive as sinks with every
// start(), so the hook takes nothing, useChatHistory takes its controls without a cycle, and a reply always reaches
// the sinks it started with. Besides the Stop button, three things cut a reply off, each through detach(), which
// useChatHistory calls: a ticker change, a whole-store reset and an unmount. The messages on screen are not that
// reply's any more, so it neither settles nor fails, and detach() hands back the text still waiting for its frame,
// for the save that keeps the reply as far as it got.

import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { askLLMStream } from '../lib/api.js';
import type { AskLLMParams } from '../lib/api.js';
import { stopMarker } from '../lib/chatMessages.js';
import type { ChatMessage } from '../lib/store.js';

/** Why a reply was cut off for a chat it no longer belongs to: a ticker change, a whole-store reset, an unmount. */
export type DetachReason = 'ticker' | 'reset' | 'unmount';

/**
 * Where one reply goes: the caller's message setters, brought by its start(). Called from start(), a frame or the
 * request's end, never during render.
 */
export interface StreamSinks {
  /** At the start, in one update: `lead`, then the empty pending reply (the typing indicator's bubble). */
  placeholder(lead: ChatMessage[]): void;
  /** Streamed text, appended to the reply: a frame's worth, or what is left before a settle or a fail. */
  append(text: string): void;
  /** The reply ended or was stopped: `marker` is its stop marker, '' when it ended normally. */
  settle(marker: string): void;
  /** The request failed: `content` is the error line; the reply keeps the text that had arrived. */
  fail(content: string): void;
}

/** One start(): the chat the reply belongs to, how to build its request, and where it goes. */
export interface StartRequest {
  /**
   * The chat's ticker at the send (data?.ticker; undefined before the first market data): what live() reports and a
   * save mid-reply writes under. Never the request's own ticker, which reads 'UNKNOWN' then.
   */
  ticker: string | undefined;
  /** Builds the request inside the run, after the placeholder: a throw fails the reply and nothing is sent. */
  buildParams: () => AskLLMParams;
  /** The error line's opening: 'Failed to get analysis' or 'Failed to get suggestions'. */
  failPrefix: string;
  /** What goes up with the placeholder: the question for a send, nothing for the suggestions. */
  lead: ChatMessage[];
  sinks: StreamSinks;
}

/** What useChatHistory takes from the stream: these three functions, never the object that carries `sending`. */
export interface StreamControls {
  /**
   * Cuts the live reply off for `reason`: its request is aborted and its frame cancelled, it neither settles nor
   * fails, and the text still waiting for a frame is returned and cleared, for the save that follows. '' and nothing
   * else when no reply is live: StrictMode runs the history's unmount cleanup once at mount, so the reason belongs to
   * the reply, never to the hook.
   */
  detach: (reason: DetachReason) => string;
  /**
   * The reply in flight while it still belongs to its chat: `{ ticker }`, StartRequest's ticker; null when idle or
   * once detached; for handlers and effects only, never render (reads refs; the lint cannot see it).
   */
  live: () => { ticker: string | undefined } | null;
  /**
   * The streamed text no frame has handed on yet, left in place (detach() is what takes it);
   * for handlers and effects only, never render (reads refs; the lint cannot see it).
   */
  bufferedText: () => string;
}

/** What useChatStream returns. */
export interface ChatStream extends StreamControls {
  /** A reply is in flight, a detached one included until its request has ended: for the UI. */
  sending: boolean;
  /**
   * Starts a reply. Returns false, with nothing appended or sent, while a reply is in flight, a detached one included
   * (the guard is synchronous: `sending` is a render behind). Otherwise the placeholder goes up, the request runs (not
   * awaited; nothing rejects out of it) and the result is true.
   */
  start: (req: StartRequest) => boolean;
  /** The Stop button: the reply in flight is aborted and settles as '*(stopped)*'. A no-op when idle or stopped. */
  stop: () => void;
}

/** A reply, from start() to the end of its run. */
interface StreamRecord {
  controller: AbortController;
  ticker: string | undefined;
  /** Set by detach(). Stop leaves it null: a stopped reply is still its chat's, and settles. */
  reason: DetachReason | null;
  sinks: StreamSinks;
}

function cancelFrame(frameRef: RefObject<number | null>): void {
  if (frameRef.current === null) return;
  cancelAnimationFrame(frameRef.current);
  frameRef.current = null;
}

/**
 * The chat's reply stream. The five functions are callbacks over refs with no deps, one identity for the hook's life,
 * and that is an invariant: useChatHistory's effects depend on detach, live and bufferedText, and a new identity
 * would run its unmount cleanup, which saves the reply and then detaches it (a handle carrying `sending` would abort
 * every reply at its first render).
 *
 * The hook registers no effect, and must not: React runs a component's cleanups in the order its hooks were declared,
 * and the shell declares this one first (useChatHistory takes its controls), so a cleanup here would run before the
 * history's, which saves the reply as far as it got and then calls detach('unmount'), the only release of the frame
 * and the controller.
 */
export function useChatStream(): ChatStream {
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false); // synchronous double-submit guard; `sending` state drives the UI
  const streamRef = useRef<StreamRecord | null>(null);
  // Streamed text not yet handed on: chunks come faster than frames, and each frame hands on what has arrived.
  const bufferRef = useRef('');
  const frameRef = useRef<number | null>(null);

  const start = useCallback((req: StartRequest): boolean => {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    req.sinks.placeholder(req.lead);
    const record: StreamRecord = {
      controller: new AbortController(), ticker: req.ticker, reason: null, sinks: req.sinks,
    };
    streamRef.current = record;
    const { signal } = record.controller;

    const flush = () => {
      frameRef.current = null;
      const text = bufferRef.current;
      if (!text) return;
      bufferRef.current = '';
      record.sinks.append(text);
    };
    const onChunk = (text: string) => {
      bufferRef.current += text;
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(flush);
    };
    // Before a settle or a fail: the buffered text first, and its frame cancelled, since it would land after them.
    const flushNow = () => {
      cancelFrame(frameRef);
      flush();
    };

    const run = async () => {
      try {
        const params = req.buildParams();
        const result = await askLLMStream(params, onChunk, signal);
        if (record.reason) return; // it finished just as it was detached
        flushNow();
        record.sinks.settle(stopMarker(result.stopReason));
      } catch (err) {
        if (record.reason) return;
        flushNow();
        // The signal decides, not the error: a Stop while an error reply's body is read rejects with that error, and
        // the user's Stop wins.
        if (signal.aborted) {
          record.sinks.settle('*(stopped)*');
        } else {
          const e = err as Error & { requestId?: string | null };
          record.sinks.fail(`${req.failPrefix}: ${e.message}${e.requestId ? ` (ref ${e.requestId})` : ''}`);
        }
      } finally {
        // The guard drops only here: a detached reply holds it until its request has ended, so no two runs overlap.
        if (streamRef.current === record) streamRef.current = null;
        sendingRef.current = false;
        setSending(false);
      }
    };
    void run();
    return true;
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.controller.abort();
  }, []);

  const detach = useCallback((reason: DetachReason): string => {
    const record = streamRef.current;
    if (!record || record.reason) return '';
    record.reason = reason;
    record.controller.abort();
    cancelFrame(frameRef);
    const text = bufferRef.current;
    bufferRef.current = '';
    return text;
  }, []);

  const live = useCallback(() => {
    const record = streamRef.current;
    return record && !record.reason ? { ticker: record.ticker } : null;
  }, []);

  const bufferedText = useCallback(() => bufferRef.current, []);

  return { sending, start, stop, detach, live, bufferedText };
}
