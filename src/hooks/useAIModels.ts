// src/hooks/useAIModels.ts
// The models the AI tab offers for a provider and the user's saved key for it, from the getModels function. Each
// (provider, key) is one query in the shared TanStack Query client (src/lib/queryClient.ts), fresh for 5 min, so the
// tab opened again within that window shows its list without a request, and a key is fetched once it is saved, not
// on every keystroke (the dialog sent two requests per open and one per keystroke). A provider that needs the user's
// own key fetches nothing until one is saved, and says so.
//
// The query key's last element is the user's API key. Lists fetched with keys since replaced or cleared stay in memory
// with theirs until gcTime (15 min unobserved), or until a token change drops them. Nothing serialises or logs query
// keys (no persister, no devtools, no cache subscriber), so they never leave the page; that has to stay true.

import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { QueryFunctionContext } from '@tanstack/react-query';
import { fetchModels } from '../lib/api.js';
import { subscribeAuth } from '../lib/auth.js';
import { providerMeta } from '../lib/aiSettings.js';
import { keys, queryClient } from '../lib/queryClient.js';
import type { ModelInfo, ModelList } from '../../types/market.js';

/** How long a list is served from the cache: getModels' own `Cache-Control: private, max-age=300`. */
const FRESH_MS = 5 * 60_000;

/** One empty list for every render without models, so a consumer's effect keyed on the list does not re-run. */
const NO_MODELS: readonly ModelInfo[] = [];

type ModelsKey = ReturnType<typeof keys.models>;

// Module level: the provider and the key come from the query key, not from a render's closure. fetchModels takes no
// abort signal, so a request superseded by a provider or key change runs on and lands in its own entry, unshown.
function loadModels({ queryKey }: QueryFunctionContext<ModelsKey>): Promise<ModelList> {
  return fetchModels(queryKey[2] || null, queryKey[1]);
}

// The reply depends on the access token as well as the key: with no key of the user's own, getModels answers with the
// server's Anthropic list for a token holder only (KEY_REQUIRED or a 401 otherwise). So a token set or cleared drops
// the whole family. The lists no hook shows are removed (a reset would clear their GC timer for good: data-hooks.md),
// and a shown one is reset, which fetches it again with the new token. One listener for the page's life, attached by
// the first mount and never detached, as storeEvents.ts's is: the token changes on the Account tab, at the premium
// gate, on the chat's lock screen or with a dead-token reply, nearly always while the AI tab (and this hook with it)
// is unmounted, which a listener of the hook's own effect would miss.
let followingAuth = false;

function followAuth(): void {
  if (followingAuth) return;
  followingAuth = true;
  subscribeAuth(() => {
    queryClient.removeQueries({ queryKey: ['models'], predicate: (query) => query.getObserversCount() === 0 });
    queryClient.resetQueries({ queryKey: ['models'] });
  });
}

/** What useAIModels returns. */
export interface AIModelsState {
  /**
   * The provider's models for the key, the cache's own array (do not mutate it). Empty until the first list lands,
   * after a failed request (a refresh's included: the dialog's catch blanked the list) and without a needed key.
   */
  models: readonly ModelInfo[];
  /** A request for this (provider, key) is in flight: the first load, or a refresh while the list stays shown. */
  loading: boolean;
  /**
   * Why there are no models, or null: the missing key's sentence, the failed request's message, or the reply's own
   * sentence (KEY_REQUIRED's) when it listed none.
   */
  error: string | null;
  /**
   * Fetches the provider's list again: for `nextKey`, the key the tab has just saved (it calls this in the handler that
   * saved it, before it re-renders onto it), or for this hook's own key when omitted.
   */
  refresh: (nextKey?: string) => void;
}

/**
 * @param provider - an AI provider's id (AI_PROVIDERS in lib/aiSettings.ts); another id is requested as given
 * @param key - the user's saved key for it; null or '' for none (the server's key, for an access-token holder)
 */
export function useAIModels(provider: string, key: string | null): AIModelsState {
  const meta = providerMeta(provider);
  // A provider without a server key lists models only with the user's own key.
  const missingKeyFor = meta?.needsKey && !key ? meta.label : null;
  // Every field derived from is read on every render: the result is a tracked proxy, and React re-renders only when a
  // field read during a render changes (a cached KEY_REQUIRED body would otherwise leave `error` unread).
  const { data, error, isFetching, isError } = useQuery({
    queryKey: keys.models(provider, key ?? ''),
    queryFn: loadModels,
    enabled: missingKeyFor === null,
    staleTime: FRESH_MS,
  }, queryClient);

  useEffect(() => {
    followAuth();
  }, []);

  // Marks the provider's family stale without refetching it, then refetches one entry: the key the tab has just saved
  // (it saves the draft with flush() and calls this in the same handler, before it re-renders onto that key), or this
  // hook's own. A cached entry for that key, the Test's seed included, is fetched again; one that does not exist yet is
  // fetched when the re-render observes it (new, so unconditionally); the replaced key's entry, still the one observed
  // until that re-render, is only marked stale, so no request goes out for a key the user has just replaced. A
  // disabled query (a provider waiting for its key) is skipped by refetchQueries.
  const refresh = useCallback((nextKey?: string) => {
    queryClient.invalidateQueries({ queryKey: ['models', provider], refetchType: 'none' });
    void queryClient.refetchQueries({ queryKey: keys.models(provider, nextKey ?? key ?? ''), exact: true });
  }, [provider, key]);

  // The dialog's catch: a failure blanks the list (TanStack keeps the last list through a failed refetch) and shows
  // its message. Its fallbacks are kept too, for a failure without a message and a reply that lists nothing.
  const models = isError ? NO_MODELS : (data?.models ?? NO_MODELS);
  let message: string | null = null;
  if (missingKeyFor !== null) message = `Enter your ${missingKeyFor} API key to load models.`;
  else if (error) message = error.message || 'Failed to fetch models.';
  else if (data && models.length === 0) message = data.error || 'No models returned.';

  return { models, loading: isFetching, error: message, refresh };
}
