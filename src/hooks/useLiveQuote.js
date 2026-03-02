// src/hooks/useLiveQuote.js
// Fetches real-time stock quotes via fetchLiveQuote (Yahoo Finance primary, Finnhub fallback).
// Caches results client-side for 1 minute per ticker for freshness.
// Extended-hours support and source fields (yahoo-extended, futures-implied, finnhub) depend on
// the underlying data provider and ticker eligibility (e.g., Nasdaq-100 constituents).

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
  const activeTickerRef = useRef(ticker);
  const loadingRef = useRef(false);

  // background=true: silent periodic refresh — keeps existing quote visible,
  // no loading spinner, and skips if a foreground fetch is already in flight.
  const load = useCallback(async (symbol, force = false, background = false) => {
    if (!symbol) return;

    // Track ticker change to detect stale state
    const isTickerChange = activeTickerRef.current !== symbol;
    activeTickerRef.current = symbol;

    if (!force) {
      const hit = getCached(symbol);
      if (hit) {
        setQuote(hit);
        setError(null);
        return;
      }
    }

    // Background refreshes keep the existing quote visible; only clear on
    // explicit ticker changes or foreground force-refreshes.
    if (isTickerChange || (force && !background)) {
      setQuote(null);
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!background) setLoading(true);
    loadingRef.current = true;
    setError(null);

    try {
      const data = await fetchLiveQuote(symbol, controller.signal);
      if (controller.signal.aborted) return;
      setCache(symbol, data);
      setQuote(data);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.warn('Live quote fetch failed:', err.message);
      setError(err.message);
    } finally {
      loadingRef.current = false;
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(ticker);
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [ticker, load]);

  // Periodic refresh: re-fetch every CACHE_TTL ms so the quote never goes stale
  // while the app is open (e.g. left running overnight). Skip if a fetch is
  // already in flight to avoid an abort/retry loop on slow networks.
  useEffect(() => {
    if (!ticker) return;
    const id = setInterval(() => {
      if (!loadingRef.current) load(ticker, true, true);
    }, CACHE_TTL);
    return () => clearInterval(id);
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
