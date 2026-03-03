// src/lib/mockData.js
// Generates realistic mock data for development and demo purposes.
// When the UW API is not configured or returns errors, the dashboard
// falls back to this data so the UI is always demonstrable.

export function generateMockData(ticker = 'AVGO') {
  const basePrice = ticker === 'AVGO' ? 178.50 : 150 + Math.random() * 200;

  // KPI data
  const callPremium = 15_000_000 + Math.random() * 30_000_000;
  const putPremium = 8_000_000 + Math.random() * 20_000_000;
  const netPremium = callPremium - putPremium;
  const darkPoolPct = 32 + Math.random() * 16;
  const maxPain = Math.round(basePrice / 5) * 5;
  const putCallRatio = 0.5 + Math.random() * 0.8;

  // GEX by strike
  const strikes = [];
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

  // 30-day net premium history
  const flowHistory = [];
  let date = new Date();
  date.setDate(date.getDate() - 30);
  let runningPrem = 0;
  for (let i = 0; i < 30; i++) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const dailyNet = (Math.random() - 0.45) * 10_000_000;
    runningPrem += dailyNet;
    flowHistory.push({
      date: date.toISOString().split('T')[0],
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
    kpis: {
      netPremium,
      callPremium,
      putPremium,
      darkPoolPct,
      maxPain,
      putCallRatio,
    },
    gexByStrike: strikes,
    flowHistory,
    lastUpdated: new Date().toISOString(),
  };
}
