// src/lib/chatMessages.ts
// The chat's messages as pure functions: a reply's stop marker and its settle, the reducer a streamed chunk goes
// through and the buffered text a save mid-reply adds, what a history stores, the turns a request sends, and what a
// failed request leaves for its Retry. A module of its own so the chat's stream and history hooks share one definition
// of each rule, tested once without React or a stream (src/lib/chatMessages.node.test.js, and
// chatMessages.retry.node.test.js for the Retry). Pure and Node-loadable: no window, no storage, no React; the store's
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

/** Which request an error bubble's Retry asks again: a send (its question is in the chat) or the suggestions. */
export type RetryKind = NonNullable<ChatMessage['retry']>['kind'];

/**
 * The fail sink's update: the reply settled as far as it got (settleReply with no marker: a partial keeps its text,
 * an empty placeholder goes), then the error bubble with the record its Retry reads. `partials` counts the request's
 * partial replies just before the bubble. The request's own counts only when the last message received is the reply
 * in flight, still pending, with text: neither a reply re-created without the flag after its streaming bubble was
 * deleted, nor an older reply that a delete left last. A retried request also passes `after`, the last message of the
 * chat its first attempt was asked on (the question, for a send): while that same object is in the chat with only
 * assistant messages after it, those are the request's partials, its earlier attempts' included, since nothing else
 * can join the chat while a reply streams. Otherwise (it was deleted, or the chat was reloaded from the store) the
 * request's own partial alone counts, and retryBase's guards decide whether the bubble can be retried.
 */
export function failReply(msgs: ChatMessage[], content: string, kind: RetryKind, after?: ChatMessage): ChatMessage[] {
  const last = msgs[msgs.length - 1];
  const settled = settleReply(msgs, '');
  let partials = last?.role === 'assistant' && last.pending === true && last.content !== '' ? 1 : 0;
  if (after) {
    const i = settled.lastIndexOf(after);
    if (i >= 0 && settled.slice(i + 1).every((m) => m.role === 'assistant')) partials = settled.length - i - 1;
  }
  return [...settled, { role: 'error', content, retry: { kind, partials, at: settled.length } }];
}

/**
 * What a Retry of the last message asks again: `base`, the chat the failed request was asked on (before the bubble
 * and before the request's partial replies, which stay in the chat), and the request's kind. null unless the last
 * message is an error bubble still at its index (a message deleted before it moves it; one sent after it leaves it
 * behind) AND the request can be made: a send's base ends on the user's turn, its question; a suggestions base holds
 * a reply to review (the test the composer makes before it offers the suggestions). So every request a Retry sends
 * ends on a user turn: the question, or the suggestions' prompt after the base.
 */
export function retryBase(msgs: ChatMessage[]): { base: ChatMessage[]; kind: RetryKind } | null {
  const at = msgs.length - 1;
  const last = msgs[at];
  const record = last?.role === 'error' ? last.retry : undefined;
  if (!record || record.at !== at || record.partials > at) return null;
  const base = msgs.slice(0, at - record.partials);
  const askable = record.kind === 'send'
    ? base[base.length - 1]?.role === 'user'
    : base.some((m) => m.role === 'assistant');
  return askable ? { base, kind: record.kind } : null;
}

/**
 * A retry's placeholder, the first update of the reply it starts, on the messages as they stand when it lands: while
 * retryBase still finds the bubble, the bubble gives way to the pending reply, and the partial replies before it stay.
 * Otherwise (the chat was reloaded between the click and this update) a send's placeholder: `lead`, the question as it
 * was clicked (nothing for the suggestions, whose prompt is never shown), then the pending reply, so the reply is never
 * stored without its question. Nothing but the error bubble, which is never stored, is ever removed.
 */
export function retryPlaceholder(msgs: ChatMessage[], lead: ChatMessage[]): ChatMessage[] {
  const pending: ChatMessage = { role: 'assistant', content: '', pending: true };
  return retryBase(msgs) ? [...msgs.slice(0, -1), pending] : [...msgs, ...lead, pending];
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
