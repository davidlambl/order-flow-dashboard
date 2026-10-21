// src/lib/chatMessages.ts
// The chat's messages as pure functions: a reply's stop marker and its settle, the reducer a streamed chunk goes
// through and the buffered text a save mid-reply adds, what a history stores, and the turns a request sends. A module
// of its own so the chat's stream and history hooks share one definition of each rule, tested once without React or
// a stream (src/lib/chatMessages.node.test.js). Pure and Node-loadable: no window, no storage, no React; the store's
// and the API's types come in as types only.

import { STOP_REASON } from './sse.js';
import type { StopReason } from './sse.js';
import type { LLMMessage } from './api.js';
import type { ChatMessage } from './store.js';

/** Italic note appended to a reply that did not end normally; '' when it did. */
export function stopMarker(stopReason: StopReason | null): string {
  if (stopReason === STOP_REASON.END) return '';
  if (stopReason === STOP_REASON.MAX_TOKENS) return '*(cut off at the token limit)*';
  if (stopReason == null) return '*(response ended early)*'; // the stream closed without a stop reason
  return `*(the model stopped here: ${stopReason})*`;
}

/**
 * Settle the streamed reply (the last message, when it is the assistant's): drop its
 * `pending` flag and append `marker`. A reply with neither text nor marker is removed.
 */
export function settleReply(msgs: ChatMessage[], marker: string): ChatMessage[] {
  const last = msgs[msgs.length - 1];
  if (last?.role !== 'assistant' || (!last.pending && !marker)) return msgs;
  const { pending: _pending, ...reply } = last;
  if (!reply.content && !marker) return msgs.slice(0, -1);
  const content = reply.content && marker ? `${reply.content}\n\n${marker}` : reply.content || marker;
  return [...msgs.slice(0, -1), { ...reply, content }];
}

/**
 * Streamed text added to the reply: appended to the last message when it is the assistant's, pending or not, else a
 * new assistant message. Pending or not because the user can delete the streaming bubble: the next chunk then
 * re-creates the reply without the flag, and the rest of the reply must join it rather than open a second turn.
 */
export function appendReplyText(msgs: ChatMessage[], text: string): ChatMessage[] {
  const last = msgs[msgs.length - 1];
  if (last?.role === 'assistant') {
    const updated = [...msgs];
    updated[updated.length - 1] = { ...last, content: last.content + text };
    return updated;
  }
  return [...msgs, { role: 'assistant', content: text }];
}

/**
 * The messages with the text still in the chunk buffer (`buf`: streamed, not yet flushed by a frame) added as a
 * flush adds it, minus a reply placeholder that is still empty: the chat as far as the reply has got, for a save
 * mid-reply and for the next request's turns. The reply keeps its `pending` flag; storableMessages drops it.
 */
export function withBufferedText(msgs: ChatMessage[], buf: string): ChatMessage[] {
  const all = buf ? appendReplyText(msgs, buf) : msgs;
  const tail = all[all.length - 1];
  return tail?.pending && !tail.content ? all.slice(0, -1) : all;
}

/**
 * Chat history as persisted: no empty placeholder and no `pending` flag, even mid-stream, and no error
 * bubbles (D10: a failed request is shown, not stored or synced; it is not part of the conversation).
 */
export function storableMessages(msgs: ChatMessage[]): ChatMessage[] {
  if (!msgs.some((m) => m.pending || m.role === 'error')) return msgs;
  return msgs.flatMap((m) => {
    if (m.role === 'error') return [];
    if (!m.pending) return [m];
    const { pending: _pending, ...rest } = m;
    return rest.content ? [rest] : [];
  });
}

/** How many recent user/assistant turns go upstream with each request. */
export const CONVERSATION_WINDOW = 10;

/**
 * A conversation turn: a user or assistant message, never an error bubble. A type guard, so a filter keeps the same
 * objects (a request carries the messages as they are) and types them as askLLM's turns.
 */
export const isTurn = (m: ChatMessage): m is ChatMessage & LLMMessage => m.role === 'user' || m.role === 'assistant';

/**
 * The last CONVERSATION_WINDOW turns, trimmed so the window opens on a user turn: the
 * providers require the first message to be the user's, and a history that alternates
 * starts a fixed-size tail on the assistant every other exchange.
 */
export function conversationWindow<T extends LLMMessage>(turns: T[]): T[] {
  const window = turns.slice(-CONVERSATION_WINDOW);
  const firstUser = window.findIndex((m) => m.role === 'user');
  return firstUser > 0 ? window.slice(firstUser) : window;
}

/** What 'Suggest updates to Strategic Context' asks: the request's last turn, never shown or stored (its reply is). */
export const CONTEXT_UPDATE_PROMPT = `Review our conversation and suggest specific updates to my Strategic Context document (included in your data under "STRATEGIC CONTEXT"). For each suggestion:
1. Specify the action: **ADD**, **UPDATE**, or **REMOVE**
2. Reference the relevant section or heading in the current document (if updating/removing)
3. Provide the exact text to add or the revised wording for updates

Keep suggestions focused and actionable. Only suggest changes that are supported by our conversation. Do not rewrite the entire document.`;
