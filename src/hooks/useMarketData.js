// src/hooks/useMarketData.js
// Fetches market data with optional auto-polling during US market hours.
// A failed fetch keeps the last good data for the same ticker and sets `error`;
// demo data appears only when nothing real has loaded for the ticker. Background
// refreshes back off exponentially after consecutive failures (lib/retry.js).

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchMarketData } from '../lib/api';
import { generateMockData } from '../lib/mockData';
import { backoffSeconds } from '../lib/retry.js';
import { isMarketOpen, isOptionsMarketOpen } from '../../shared/marketCalendar.js';

function getRefreshSecs(provider) {
  return provider === 'tradier' ? 30 : 60;
}

export function useMarketData(ticker) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [failures, setFailures] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [marketOpen, setMarketOpen] = useState(isMarketOpen);
  const [optionsMarketOpen, setOptionsMarketOpen] = useState(isOptionsMarketOpen);
  const [timerEpoch, setTimerEpoch] = useState(0);
  const abortRef = useRef(null);
  const timerRef = useRef(null);
  // Mirror of `data` so fetchAll can see what is on screen while keeping an empty deps array.
  const dataRef = useRef(null);
  const usingMock = data?.provider === 'mock';

  const fetchAll = useCallback(async (symbol, silent = false) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    try {
      const result = await fetchMarketData(symbol, controller.signal);
      if (controller.signal.aborted) return;

      const next = {
        ticker: result.ticker,
        provider: result.provider,
        delay: result.delay,
        spotPrice: result.spotPrice,
        priceChange: result.priceChange,
        priceChangePct: result.priceChangePct,
        iv30: result.iv30,
        kpis: result.kpis,
        gexByStrike: result.gexByStrike || [],
        flowHistory: result.flowHistory || [],
        lastUpdated: result.lastUpdated,
        totalOptionsCount: result.totalOptionsCount,
        fallbackReason: result.fallbackReason ?? null,
        expiries: result.expiries || [],
      };
      dataRef.current = next;
      setData(next);
      setFailures(0);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (controller.signal.aborted) return;
      // Real data for this ticker survives any failure (manual or background); demo data
      // stands in only when nothing real has loaded for it yet.
      const keep = dataRef.current?.ticker === symbol && dataRef.current.provider !== 'mock';
      setFailures((n) => n + 1);
      setError(err.message);
      if (!keep) {
        console.warn('No data loaded for', symbol, '— showing demo data:', err.message);
        const mock = generateMockData(symbol);
        dataRef.current = mock;
        setData(mock);
      } else {
        console.warn('Market data refresh failed; keeping last good data:', err.message);
      }
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ticker) fetchAll(ticker);
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [ticker, fetchAll]);

  useEffect(() => {
    const handler = () => { if (ticker) fetchAll(ticker); };
    window.addEventListener('data-source-changed', handler);
    return () => window.removeEventListener('data-source-changed', handler);
  }, [ticker, fetchAll]);

  // Re-evaluate market hours every 30s
  useEffect(() => {
    const check = () => {
      setMarketOpen(isMarketOpen());
      setOptionsMarketOpen(isOptionsMarketOpen());
    };
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  // Auto-refresh countdown + silent fetch. Demo data never auto-refreshes; after
  // consecutive failures the interval backs off (base × 2^failures, capped).
  const hasData = data != null;
  const provider = data?.provider;
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;

    const active = autoRefresh && optionsMarketOpen && !usingMock && !!ticker && hasData;
    if (!active) {
      setSecondsLeft(0);
      return;
    }

    const secs = backoffSeconds(getRefreshSecs(provider), failures);
    let target = Date.now() + secs * 1000;
    setSecondsLeft(secs);

    timerRef.current = setInterval(() => {
      const rem = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setSecondsLeft(rem);
      if (rem <= 0) {
        target = Date.now() + secs * 1000;
        setSecondsLeft(secs);
        fetchAll(ticker, true);
      }
    }, 1000);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, optionsMarketOpen, usingMock, ticker, provider, hasData, failures, fetchAll, timerEpoch]);

  const refresh = useCallback(() => {
    if (ticker) {
      fetchAll(ticker);
      setTimerEpoch((e) => e + 1);
    }
  }, [ticker, fetchAll]);

  const toggleAutoRefresh = useCallback(() => {
    setAutoRefresh((v) => !v);
  }, []);

  return {
    data, loading, error, usingMock, failures, refresh,
    autoRefresh, secondsLeft, marketOpen, optionsMarketOpen, toggleAutoRefresh,
  };
}
