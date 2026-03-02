// src/hooks/useLiveQuote.js
// Fetches real-time stock quotes from Finnhub.
// Caches results client-side for 1 minute per ticker for freshness.

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchLiveQuote } from '../lib/api';

const CACHE_TTL = 1 * 60 * 1000;
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
}

export function useLiveQuote(ticker) {
  const [quote, setQuote] = useState(() => getCached(ticker));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async (symbol, force = false) => {
    if (!symbol) return;

    if (!force) {
      const hit = getCached(symbol);
      if (hit) {
        setQuote(hit);
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
      const data = await fetchLiveQuote(symbol);
      if (controller.signal.aborted) return;
      setCache(symbol, data);
      setQuote(data);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.warn('Live quote fetch failed:', err.message);
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

  return { quote, loading, error, refresh };
}
