// src/lib/sse.ts
// Server-sent-event parsing for the AI co-pilot stream: askLLM relays the provider's
// SSE body untouched (Anthropic, OpenAI or Gemini), so the client splits the frames
// and normalises each provider's text, error and stop events. Pure and import-free:
// api.js owns the network side, and src/lib/sse.test.js loads this module directly.

/** Why a reply stopped, normalised across providers. */
export const STOP_REASON = Object.freeze({
  END: 'end',
  MAX_TOKENS: 'max_tokens',
  REFUSAL: 'refusal',
  SAFETY: 'safety',
  PROMPT_BLOCKED: 'prompt_blocked',
  OTHER: 'other',
} as const);

export type StopReason = (typeof STOP_REASON)[keyof typeof STOP_REASON];

export interface SSETextEvent { type: 'text'; text: string }
/** `code` is passed on as the provider sent it: a string, or Gemini's numeric code when it sent no status. */
export interface SSEErrorEvent { type: 'error'; message: string | null; code: string | number | null }
export interface SSEStopEvent { type: 'stop'; reason: StopReason; raw: string }
/** One normalised stream event; switch on `type`. */
export type SSEEvent = SSETextEvent | SSEErrorEvent | SSEStopEvent;

const ANTHROPIC_STOP = new Map<string, StopReason>([
  ['end_turn', STOP_REASON.END],
  ['stop_sequence', STOP_REASON.END],
  ['max_tokens', STOP_REASON.MAX_TOKENS],
  ['refusal', STOP_REASON.REFUSAL],
]);

const OPENAI_STOP = new Map<string, StopReason>([
  ['stop', STOP_REASON.END],
  ['length', STOP_REASON.MAX_TOKENS],
  ['content_filter', STOP_REASON.SAFETY],
]);

const GEMINI_STOP = new Map<string, StopReason>([
  ['STOP', STOP_REASON.END],
  ['MAX_TOKENS', STOP_REASON.MAX_TOKENS],
  ...['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']
    .map((reason): [string, StopReason] => [reason, STOP_REASON.SAFETY]),
]);

/**
 * Split an SSE buffer into complete `data:` payloads.
 * Lines end in `\n` (a trailing `\r` is dropped, so `\r\n` framing works). Unless `final`,
 * the last line may still be incomplete and comes back as `rest`, to be prefixed to the
 * next chunk; with `final` (the body has ended) every line is consumed. `event:`, `id:`,
 * `retry:` and `:` comment lines are ignored, as are empty payloads and `[DONE]`.
 */
export function drainSSEBuffer(buffer: string, { final = false }: { final?: boolean } = {}): { payloads: string[]; rest: string } {
  const lines = buffer.split('\n');
  // split() returns at least one element, so pop() is never undefined here and the `?? ''` never applies.
  const rest = final ? '' : (lines.pop() ?? '');
  const payloads: string[] = [];
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== '[DONE]') payloads.push(payload);
  }
  return { payloads, rest };
}

const textEvent = (text: unknown): SSETextEvent[] => (typeof text === 'string' && text ? [{ type: 'text', text }] : []);

const stopEvent = (map: Map<string, StopReason>, raw: string): SSEStopEvent => ({ type: 'stop', reason: map.get(raw) ?? STOP_REASON.OTHER, raw });

function errorEvent(error: unknown, code: string | number | undefined): SSEErrorEvent {
  // Only an object can carry `message`: any other value reads undefined here, as `error?.message` would.
  const body: { message?: unknown } | null | undefined = typeof error === 'object' ? error : undefined;
  const message = typeof error === 'string' ? error : body?.message;
  return { type: 'error', message: typeof message === 'string' && message ? message : null, code: code ?? null };
}

// What each parser reads: all optional and typed as the provider documents it, except the text, unknown until its
// typeof check. The payload is untrusted JSON; the optional chaining and checks below cope with any other shape.
interface AnthropicPayload {
  type?: string;
  error?: { type?: string };
  delta?: { type?: string; text?: unknown; stop_reason?: string | null };
}

interface OpenAIPayload {
  error?: { code?: string | null; type?: string };
  choices?: { delta?: { content?: unknown }; finish_reason?: string | null }[];
}

interface GeminiPayload {
  error?: { status?: string; code?: number };
  candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

function anthropicEvents(event: AnthropicPayload): SSEEvent[] {
  if (event.type === 'error') return [errorEvent(event.error, event.error?.type)];
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') return textEvent(event.delta.text);
  if (event.type === 'message_delta' && event.delta?.stop_reason) return [stopEvent(ANTHROPIC_STOP, event.delta.stop_reason)];
  return []; // message_start, content_block_start/stop, ping, message_stop, thinking deltas
}

function openAIEvents(event: OpenAIPayload): SSEEvent[] {
  if (event.error) return [errorEvent(event.error, event.error.code || event.error.type)];
  const choice = event.choices?.[0];
  if (!choice) return [];
  // One chunk may carry both the last text and the finish_reason.
  const events: SSEEvent[] = textEvent(choice.delta?.content);
  if (choice.finish_reason) events.push(stopEvent(OPENAI_STOP, choice.finish_reason));
  return events;
}

function geminiEvents(event: GeminiPayload): SSEEvent[] {
  if (event.error) return [errorEvent(event.error, event.error.status || event.error.code)];
  const candidate = event.candidates?.[0];
  const parts = candidate?.content?.parts;
  // The last chunk carries text parts and finishReason together.
  const events: SSEEvent[] = textEvent(Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
  const blockReason = event.promptFeedback?.blockReason;
  if (blockReason) events.push({ type: 'stop', reason: STOP_REASON.PROMPT_BLOCKED, raw: blockReason });
  if (candidate?.finishReason) events.push(stopEvent(GEMINI_STOP, candidate.finishReason));
  return events;
}

/**
 * Normalise one `data:` payload into events, text before stop:
 *   { type: 'text', text } | { type: 'error', message, code } | { type: 'stop', reason, raw }
 * `reason` is a STOP_REASON value and `raw` the provider's own string. Anything that is not
 * JSON, or carries none of these, yields [].
 * @param provider - 'anthropic', 'openai' or 'gemini'; anything else is read as Anthropic
 */
export function parseSSEEvents(jsonStr: string, provider?: string): SSEEvent[] {
  let event: unknown;
  try {
    event = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  if (!event || typeof event !== 'object') return [];
  switch (provider) {
    case 'openai': return openAIEvents(event);
    case 'gemini': return geminiEvents(event);
    default: return anthropicEvents(event);
  }
}
