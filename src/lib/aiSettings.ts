// src/lib/aiSettings.ts
// The AI providers the Settings dialog offers, and the readers of the AI preferences it writes: the chat reads them for
// every message it sends and shows the model's name in its header. A module of its own because a component file that
// also exports a function loses Fast Refresh (react-refresh/only-export-components). Node-loadable: the store is read
// when a function is called, never at import (src/lib/aiSettings.node.test.js).

import { getPreference } from './store.js';
import type { PrefName } from './store.js';
import type { LlmProvider } from '../../types/market.js';

/** A provider as the Settings picker shows it. */
export interface AIProvider {
  readonly id: LlmProvider;
  readonly label: string;
  /** The key input's placeholder: what the provider's keys look like. */
  readonly hint: string;
  /** No server key for this provider: its models load, and the chat answers, only with the user's own key. */
  readonly needsKey: boolean;
  /** Starred in the picker. */
  readonly recommended?: boolean;
}

/** The picker's providers, in its order. */
export const AI_PROVIDERS: readonly AIProvider[] = [
  { id: 'anthropic', label: 'Anthropic', hint: 'sk-ant-...', needsKey: false, recommended: true },
  { id: 'gemini', label: 'Gemini', hint: 'AIza...', needsKey: true },
  { id: 'openai', label: 'OpenAI', hint: 'sk-...', needsKey: true },
];

/** The picker's entry for an id; undefined for any other id (a stored provider from an import, say). */
export function providerMeta(id: string): AIProvider | undefined {
  return AI_PROVIDERS.find((p) => p.id === id);
}

/** Each provider's key preference: a PrefName, so a read through it is typed (a name built at run time is not). */
export const KEY_PREF = {
  anthropic: 'ai_key_anthropic',
  openai: 'ai_key_openai',
  gemini: 'ai_key_gemini',
} as const satisfies Record<LlmProvider, PrefName>;

/** Whether a value (a stored or picked provider) is a provider's id, so it can index KEY_PREF. */
export function isLlmProvider(id: unknown): id is LlmProvider {
  return typeof id === 'string' && Object.hasOwn(KEY_PREF, id);
}

// getPreference types a name built at run time as unknown: a string is the value, anything else the fallback.
const stringOr = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

/**
 * The model's display name, 'Default' when none is stored: the chat header's label, which ChatBot follows through
 * useStoreValue, so a savePreference, an import or a cloud pull of the name re-renders it. A stored value outside the
 * string contract (importAll writes any JSON under a known name; a cloud row is applied as it is) reads as the
 * default: a fresh object per read would loop useSyncExternalStore, and ChatBot is mounted with the chat closed, so
 * that took the whole dashboard down at load. getAISettings reads the name through it too, so the default is one.
 */
export function readAiModelName(): string {
  const v = getPreference('ai_model_name');
  return typeof v === 'string' && v ? v : 'Default';
}

/** The AI preferences as the chat reads them. */
export interface AISettings {
  /** The stored id, not narrowed to LlmProvider: an import can write any string here. */
  provider: string;
  /** '' for the server's default model. */
  model: string;
  modelName: string;
  /** '' for no key of the user's own. */
  apiKey: string;
}

/**
 * The AI preferences as stored at the call: ChatBot reads them for each message it sends, so a change in Settings
 * applies to the next.
 */
export function getAISettings(): AISettings {
  const provider = getPreference('ai_provider') || 'anthropic';
  return {
    provider,
    model: getPreference('ai_model') || '',
    modelName: readAiModelName(),
    // No writer stores a key that is not a string, and askLLM already treats one as no key.
    apiKey: stringOr(getPreference(`ai_key_${provider}`), ''),
  };
}
