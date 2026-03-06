// netlify/functions/collectFlowHistory.js
//
// Scheduled function: runs Mon-Fri at ~4:30 PM ET (after market close).
// Fetches options flow data for tracked tickers and stores daily snapshots
// in the Supabase flow_history table.

import { getSupabaseAdmin } from './lib/supabaseAdmin.js';
import { fetchCBOE, computeNetPremium, computePutCallRatio } from './lib/marketDataHelpers.js';

// Tickers to track — user positions + major indices/ETFs.
// TODO: drive this from the positions table once user data syncs to Supabase.
const TRACKED_TICKERS = [
  'AVGO', 'NVDA', 'AAPL', 'TSLA', 'MSFT',
  'META', 'AMZN', 'GOOGL', 'AMD',
  'SPY', 'QQQ',
];

export default async () => {
  // Skip weekends
  const dow = new Date().getDay();
  if (dow === 0 || dow === 6) {
    console.log('Weekend — skipping flow collection.');
    return;
  }

  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const ticker of TRACKED_TICKERS) {
    try {
      const rawData = await fetchCBOE(ticker);
      const premium = computeNetPremium(rawData.options);
      const pcRatio = computePutCallRatio(rawData.options);

      // Fetch previous cumulative total
      const { data: prevRows } = await supabase
        .from('flow_history')
        .select('cum_premium')
        .eq('ticker', ticker)
        .order('date', { ascending: false })
        .limit(1);

      const prevCum = prevRows?.[0]?.cum_premium || 0;

      results.push({
        date: today,
        ticker,
        net_premium: premium.netPremium,
        cum_premium: prevCum + premium.netPremium,
        call_volume: pcRatio.callVolume,
        put_volume: pcRatio.putVolume,
        call_premium: premium.callPremium,
        put_premium: premium.putPremium,
        spot_price: rawData.spotPrice,
        provider: rawData.provider,
      });

      console.log(`Collected ${ticker}: net=${premium.netPremium.toFixed(0)}, calls=${pcRatio.callVolume}, puts=${pcRatio.putVolume}`);
    } catch (err) {
      console.error(`Failed to collect ${ticker}:`, err.message);
    }
  }

  if (results.length > 0) {
    const { error } = await supabase
      .from('flow_history')
      .upsert(results, { onConflict: 'date,ticker' });

    if (error) {
      console.error('Supabase upsert error:', error.message);
    } else {
      console.log(`Stored flow history for ${results.length} tickers on ${today}.`);
    }
  }
};

// Netlify Scheduled Function: Mon-Fri at 20:30 UTC (4:30 PM ET / 5:30 PM EDT).
// During EDT the run is 30 min late, which is fine — data is still from the same trading day.
export const config = {
  schedule: '30 20 * * 1-5',
};
