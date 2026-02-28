// src/hooks/useMarketData.js
// Fetches all market data from our single CBOE-backed Netlify Function.
// Falls back to mock data when the function is unavailable (e.g. local dev without Netlify CLI).

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchMarketData } from '../lib/api';
import { generateMockData } from '../lib/mockData';

export function useMarketData(ticker) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [usingMock, setUsingMock] = useState(false);
  const abortRef = useRef(null);

  const fetchAll = useCallback(async (symbol) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchMarketData(symbol);

      if (controller.signal.aborted) return;

      // The serverless function returns pre-computed data in our exact shape
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
        flowHistory: generateMockData(symbol).flowHistory, // Historical flow needs time-series — use simulated
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
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [ticker, fetchAll]);

  useEffect(() => {
    const handler = () => { if (ticker) fetchAll(ticker); };
    window.addEventListener('data-source-changed', handler);
    return () => window.removeEventListener('data-source-changed', handler);
  }, [ticker, fetchAll]);

  const refresh = useCallback(() => {
    if (ticker) fetchAll(ticker);
  }, [ticker, fetchAll]);

  return { data, loading, error, usingMock, refresh };
}
