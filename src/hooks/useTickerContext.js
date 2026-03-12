// src/hooks/useTickerContext.js
// Fetches enriched ticker context from Finnhub via our Netlify function.
// Caches results client-side for 15 minutes per ticker.

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchTickerContext } from '../lib/api';

const CACHE_TTL = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 50;
const cache = new Map();

function getCached(ticker) {
  const entry = cache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(ticker);
    return null;
  }
  return entry.data;
}

function setCache(ticker, data) {
  cache.set(ticker, { data, ts: Date.now() });
  // Evict oldest entries when cache exceeds size limit to prevent memory leaks
  if (cache.size > MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

export function useTickerContext(ticker) {
  const [context, setContext] = useState(() => getCached(ticker));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async (symbol, force = false) => {
    if (!symbol) return;

    if (!force) {
      const hit = getCached(symbol);
      if (hit) {
        setContext(hit);
        setError(null);
        return;
      }
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const data = await fetchTickerContext(symbol, controller.signal);
      if (controller.signal.aborted) return;
      setCache(symbol, data);
      setContext(data);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.warn('Ticker context fetch failed:', err.message);
      setError(err.message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(ticker);
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [ticker, load]);

  useEffect(() => {
    const handler = () => {
      cache.delete(ticker);
      load(ticker, true);
    };
    window.addEventListener('data-source-changed', handler);
    return () => window.removeEventListener('data-source-changed', handler);
  }, [ticker, load]);

  const refresh = useCallback(() => {
    cache.delete(ticker);
    load(ticker, true);
  }, [ticker, load]);

  return { context, loading, error, refresh };
}
