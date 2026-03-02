// src/hooks/useMarketData.js
// Fetches market data with optional auto-polling during US market hours.

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchMarketData } from '../lib/api';
import { generateMockData } from '../lib/mockData';

const MARKET_OPEN_MIN = 570;  // 9:30 ET
const MARKET_CLOSE_MIN = 960; // 16:00 ET
const OPTIONS_CLOSE_MIN = 975; // 16:15 ET

function isMarketOpen() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
    }).formatToParts(new Date()).map(({ type, value }) => [type, value])
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = parseInt(parts.hour) * 60 + parseInt(parts.minute);
  return mins >= MARKET_OPEN_MIN && mins < MARKET_CLOSE_MIN;
}

function isOptionsMarketOpen() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
    }).formatToParts(new Date()).map(({ type, value }) => [type, value])
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = parseInt(parts.hour) * 60 + parseInt(parts.minute);
  return mins >= MARKET_OPEN_MIN && mins < OPTIONS_CLOSE_MIN;
}

function getRefreshSecs(provider) {
  return provider === 'tradier' ? 30 : 60;
}

export function useMarketData(ticker) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [usingMock, setUsingMock] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [marketOpen, setMarketOpen] = useState(isMarketOpen);
  const [optionsMarketOpen, setOptionsMarketOpen] = useState(isOptionsMarketOpen);
  const [timerEpoch, setTimerEpoch] = useState(0);
  const abortRef = useRef(null);
  const timerRef = useRef(null);

  const fetchAll = useCallback(async (symbol, silent = false) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    try {
      const result = await fetchMarketData(symbol);
      if (controller.signal.aborted) return;

      setData({
        ticker: result.ticker,
        provider: result.provider,
        delay: result.delay,
        spotPrice: result.spotPrice,
        priceChange: result.priceChange,
        priceChangePct: result.priceChangePct,
        iv30: result.iv30,
        kpis: result.kpis,
        gexByStrike: result.gexByStrike || [],
        flowHistory: generateMockData(symbol).flowHistory,
        lastUpdated: result.lastUpdated,
        totalOptionsCount: result.totalOptionsCount,
      });
      setUsingMock(false);
      setLoading(false);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.warn('Falling back to mock data:', err.message);
      setData(generateMockData(symbol));
      setUsingMock(true);
      setError(err.message);
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

  // Auto-refresh countdown + silent fetch
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;

    const active = autoRefresh && marketOpen && !usingMock && !!ticker && data != null;
    if (!active) {
      setSecondsLeft(0);
      return;
    }

    const secs = getRefreshSecs(data?.provider);
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
  }, [autoRefresh, marketOpen, usingMock, ticker, data?.provider, fetchAll, timerEpoch]);

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
    data, loading, error, usingMock, refresh,
    autoRefresh, secondsLeft, marketOpen, optionsMarketOpen, toggleAutoRefresh,
  };
}
