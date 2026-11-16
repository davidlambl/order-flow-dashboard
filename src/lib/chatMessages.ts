// src/lib/chatMessages.ts
// The chat's messages as pure functions: a reply's stop marker and its settle, the reducer a streamed chunk goes
// through and the buffered text a save mid-reply adds, what a history stores, the turns a request sends, and what a
// failed request leaves for its Retry. A module of its own so the chat's stream and history hooks share one definition
// of each rule, tested once without React or a stream (src/lib/chatMessages.node.test.js, and
// chatMessages.retry.node.test.js for the Retry). Two rules hold the stored history safe from the user's deletes and
// Clear while a reply streams: a request's stream writes only into its own reply, the last message while that is a
// pending assistant message (appendReplyText, settleReply), never into a message a delete left last; and an error
// bubble can be retried only while the message its request was asked after is still in the chat with replies alone
// after it (failReply), so a Retry never asks a different request. Pure and Node-loadable: no window, no storage, no
// React; the store's and the API's types come in as types only.

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
 * Settle the streamed reply, the last message while it is a pending assistant message: drop its `pending` flag and
 * append `marker`. A reply with neither text nor marker is removed. Anything else last (a settled reply, a question,
 * nothing) is not this request's reply, since the user deleted it: the same array, whatever the marker, so a stop or
 * a cut never marks a message the request did not write.
 */
export function settleReply(msgs: ChatMessage[], marker: string): ChatMessage[] {
  const last = msgs[msgs.length - 1];
  if (last?.role !== 'assistant' || !last.pending) return msgs;
  const { pending: _pending, ...reply } = last;
  if (!reply.content && !marker) return msgs.slice(0, -1);
  const content = reply.content && marker ? `${reply.content}\n\n${marker}` : reply.content || marker;
  return [...msgs.slice(0, -1), { ...reply, content }];
}

/**
 * Streamed text added to the reply: appended to the last message while it is a pending assistant message, the reply
 * in flight; otherwise a new pending assistant message. Otherwise because the user can delete the streaming bubble:
 * the next chunk then re-creates the reply, pending, the rest of the reply joins it rather than opening a third turn,
 * and it never joins the message the delete left last (a stored partial, an earlier reply), which is not this
 * request's to extend.
 */
export function appendReplyText(msgs: ChatMessage[], text: string): ChatMessage[] {
  const last = msgs[msgs.length - 1];
  if (last?.role === 'assistant' && last.pending) {
    const updated = [...msgs];
    updated[updated.length - 1] = { ...last, content: last.content + text };
    return updated;
  }
  return [...msgs, { role: 'assistant', content: text, pending: true }];
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
 * an empty placeholder goes), then the error bubble. `after` is the request's anchor, the message it was asked after:
 * a send's question, the suggestions' last message at the click (undefined in an empty chat), a retry's the last
 * message of the chat its first attempt was asked on. While that same object is in the settled chat with only
 * assistant messages after it, those are the request's partial replies, its earlier attempts' included, since nothing
 * else can join the chat while a reply streams: the bubble carries the record its Retry reads, `partials` their
 * number. Otherwise (no anchor, the anchor deleted, the chat cleared or reloaded from the store, a question after it)
 * the bubble carries no record: it is shown and announced, and never retryable, since the request it would ask again
 * can no longer be rebuilt from the chat.
 */
export function failReply(
  msgs: ChatMessage[],
  content: string,
  kind: RetryKind,
  after: ChatMessage | undefined,
): ChatMessage[] {
  const settled = settleReply(msgs, '');
  const i = after ? settled.lastIndexOf(after) : -1;
  if (i < 0 || !settled.slice(i + 1).every((m) => m.role === 'assistant')) {
    return [...settled, { role: 'error', content }];
  }
  const partials = settled.length - i - 1;
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
