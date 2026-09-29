// src/lib/mockData.ts
// Generates realistic mock data for development and demo purposes. The dashboard shows it
// under `npm run dev` (Vite alone, no Netlify Functions) and whenever market data fails
// before anything real has loaded for a ticker, so the UI is always demonstrable.

import type { MarketData, GexRow, FlowHistoryRow } from '../../types/market.js';
import { toLocalISODate } from './format.js';

export function generateMockData(ticker = 'AVGO'): MarketData {
  const basePrice = ticker === 'AVGO' ? 178.50 : 150 + Math.random() * 200;

  // KPI data
  const callPremium = 15_000_000 + Math.random() * 30_000_000;
  const putPremium = 8_000_000 + Math.random() * 20_000_000;
  const netPremium = callPremium - putPremium;
  const darkPoolPct = 32 + Math.random() * 16;
  const maxPain = Math.round(basePrice / 5) * 5;

  // Whole-contract counts first, then both ratios from them as getMarketData computes them (puts ÷
  // calls), so the P/C card's ratio and its volume subtitle agree. A $5.00 mid (×100 shares = $500 a
  // contract, as computeNetPremium prices it) turns call premium into call volume; call OI is 5× call
  // volume, and put OI has its own put/call draw.
  const callVolume = Math.round(callPremium / 500);
  const putVolume = Math.round(callVolume * (0.5 + Math.random() * 0.8));
  const putCallRatio = putVolume / callVolume;
  const callOI = callVolume * 5;
  const putOI = Math.round(callOI * (0.6 + Math.random() * 0.8));
  const putCallOIRatio = putOI / callOI;

  // GEX by strike
  const strikes: GexRow[] = [];
  const center = Math.round(basePrice / 5) * 5;
  for (let s = center - 30; s <= center + 30; s += 5) {
    const dist = Math.abs(s - basePrice);
    const magnitude = Math.max(0, 500_000_000 - dist * 15_000_000) * (0.6 + Math.random() * 0.8);
    strikes.push({
      strike: s,
      gex: s >= center ? magnitude : -magnitude * 0.6,
      callGex: magnitude * 0.7,
      putGex: -magnitude * 0.3,
    });
  }

  // 30-day net premium history, weekdays only. Rows are labelled with the local calendar
  // date, the same day getDay() tested (toISOString() gives the UTC date, a day off near
  // midnight in far time zones).
  const flowHistory: FlowHistoryRow[] = [];
  const date = new Date();
  date.setDate(date.getDate() - 30);
  let runningPrem = 0;
  for (let i = 0; i < 30; i++) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const dailyNet = (Math.random() - 0.45) * 10_000_000;
    runningPrem += dailyNet;
    flowHistory.push({
      date: toLocalISODate(date),
      netPremium: dailyNet,
      cumPremium: runningPrem,
      callVolume: Math.floor(5000 + Math.random() * 15000),
      putVolume: Math.floor(3000 + Math.random() * 12000),
    });
  }

  return {
    ticker,
    spotPrice: basePrice,
    priceChange: 0,
    priceChangePct: 0,
    provider: 'mock',
    delay: 'simulated',
    // Every field getMarketData sends is here too, so demo mode can use this object as it is.
    // The mock has no provider to fall back from, no IV30, no trade time and no expiry dates;
    // it counts a call and a put at each strike it draws.
    fallbackReason: null,
    iv30: null,
    lastTradeTime: null,
    totalOptionsCount: strikes.length * 2,
    expiries: [],
    kpis: {
      netPremium,
      callPremium,
      putPremium,
      darkPoolPct,
      maxPain,
      maxPainExpiry: null,
      putCallRatio,
      putCallOIRatio,
      callVolume,
      putVolume,
      callOI,
      putOI,
    },
    gexByStrike: strikes,
    flowHistory,
    lastUpdated: new Date().toISOString(),
  };
}
