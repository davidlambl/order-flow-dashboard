// netlify/functions/collectFlowHistory.js
//
// Scheduled function: runs Mon-Fri at 9:30 PM UTC (~4:30-5:30 PM ET depending on DST).
// Fetches options flow data for tracked tickers and stores daily snapshots
// in the Supabase flow_history table.

import { schedule } from '@netlify/functions';
import { getSupabaseAdmin } from './lib/supabaseAdmin.js';
import { fetchCBOE, computeNetPremium, computePutCallRatio } from './lib/marketDataHelpers.js';

// Tickers to track — user positions + major indices/ETFs.
// TODO: drive this from the positions table once user data syncs to Supabase.
const TRACKED_TICKERS = [
  'AVGO', 'NVDA', 'AAPL', 'TSLA', 'MSFT',
  'META', 'AMZN', 'GOOGL', 'AMD',
  'SPY', 'QQQ',
];

const collectFlow = async () => {
  // Skip weekends
  const dow = new Date().getDay();
  if (dow === 0 || dow === 6) {
    console.log('Weekend — skipping flow collection.');
    return { statusCode: 200 };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase env vars not set — skipping flow collection.');
    return { statusCode: 200 };
  }

  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const ticker of TRACKED_TICKERS) {
    try {
      const rawData = await fetchCBOE(ticker);
      if (!rawData.options || rawData.options.length === 0) {
        console.warn(`No options data for ${ticker}, skipping`);
        continue;
      }
      const premium = computeNetPremium(rawData.options);
      const pcRatio = computePutCallRatio(rawData.options);

      // Fetch previous cumulative total
      const { data: prevRows } = await supabase
        .from('flow_history')
        .select('cum_premium')
        .eq('ticker', ticker)
        .lt('date', today)
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

  return { statusCode: 200 };
};

// Mon-Fri at 21:30 UTC — covers both EST (4:30 PM) and EDT (5:30 PM), always after market close.
export const handler = schedule('30 21 * * 1-5', collectFlow);
