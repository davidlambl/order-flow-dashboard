// src/lib/financialContext.ts
// The chat's model context: the dashboard state serialized into the plain-text block that askLLM puts in the system
// prompt, which the chat's context inspector also shows. Out of ChatBot so it is tested without React (golden
// snapshots in src/lib/financialContext.node.test.js). Pure and Node-loadable: the clock is the caller's `now`, and
// relative imports carry their extension.

import { formatDollar, formatPct, formatRatio, formatPrice, daysUntil } from './format.js';
import { isStaleData } from './staleness.js';
import { computeRecommendation, computeDualRecommendation, GAP_DUAL_REC_THRESHOLD_PCT } from './recommend.js';
import { GEX_NEAR_SPOT_CHAT_PCT, DARK_POOL_PCT, PUT_CALL } from '../../shared/thresholds.js';
import type { FlowHistoryRow, LiveQuote, MarketData, TickerContext } from '../../types/market.js';

/** buildFinancialContext's input: the chat's market context, the position, the strategic context and the clock. */
export interface FinancialContextInput {
  /** The market payload; null before the first one lands. */
  data: MarketData | null;
  /** The position's cost basis, coerced: the position, signal and pain-tolerance blocks need it finite and > 0. */
  costBasis: number | string | null | undefined;
  /** The position's share count; without it the P&L dollars, notional, pain levels and dividend income are left out. */
  shares: number | null | undefined;
  /** The ticker's research; null until it lands and while research is off. */
  tickerContext: TickerContext | null;
  /** The stored strategic context: only a non-blank string is included. */
  strategicContext: unknown;
  /** The equity session is open. */
  marketOpen: boolean;
  /** The options session is open: no dual recommendation then, and the stale bar is the open session's. */
  optionsMarketOpen: boolean;
  /** The live quote, for the dual recommendation: a position, options closed, a gap ≥ GAP_DUAL_REC_THRESHOLD_PCT. */
  liveQuote: LiveQuote | null;
  /** The clock in epoch ms: the TIMESTAMP line, the data's age, the stale note and the days to earnings. */
  now: number;
}

/** One strike's GEX in words: its sign, and whether the strike sits within GEX_NEAR_SPOT_CHAT_PCT of spot. */
export function gexCharacter(gex: number, strike: number, spotPrice: number): string {
  const near = spotPrice && Math.abs(strike - spotPrice) / spotPrice < GEX_NEAR_SPOT_CHAT_PCT / 100;
  if (gex > 0) return near ? 'Positive gamma — dealer dampener near spot' : 'Positive gamma — magnet/pin';
  return near ? 'Negative gamma — volatility amplifier near spot' : 'Negative gamma — accelerates moves';
}

/**
 * The 5-SESSION TREND line over the last five sessions: the run of same-signed sessions the window ends on, and the
 * window's net premium; '' without a flow history.
 */
export function buildFlowTrend(flowHistory: FlowHistoryRow[] | undefined): string {
  const recent = (flowHistory || []).slice(-5);
  if (recent.length === 0) return '';
  let consec = 0;
  let dir = null;
  for (const f of recent) {
    const d = f.netPremium >= 0 ? 'positive' : 'negative';
    if (d === dir) { consec++; } else { dir = d; consec = 1; }
  }
  const first = recent[0];
  const last = recent[recent.length - 1];
  const delta = last.cumPremium - first.cumPremium + first.netPremium;
  return `\n5-SESSION TREND: ${consec} consecutive ${dir} session${consec > 1 ? 's' : ''}. Cumulative delta over window: ${formatDollar(delta)}.`;
}

/**
 * Serializes the current dashboard state into the plain-text context block that gets injected into the LLM system
 * prompt. It never reads the clock: the caller's `now` stamps the block, ages the data and counts the days to
 * earnings, so a test fixes the time by passing it.
 *
 * @returns the block, which starts with 'TICKER: '; 'Dashboard data not yet loaded.' while `data` is null
 */
export function buildFinancialContext({
  data, costBasis, shares, tickerContext: tickerCtx, strategicContext, marketOpen, optionsMarketOpen, liveQuote, now,
}: FinancialContextInput): string {
  if (!data) return 'Dashboard data not yet loaded.';

  const { ticker, kpis, gexByStrike, flowHistory, lastUpdated, spotPrice,
    iv30, totalOptionsCount, expiries, priceChange, priceChangePct, provider, delay } = data;
  const k = kpis || {};
  const timestamp = new Date(now).toISOString();

  const spotPriceNum = Number(spotPrice);
  const livePriceNum = Number(liveQuote?.current);
  const costBasisNum = Number(costBasis);
  const showDual = liveQuote != null &&
    Number.isFinite(spotPriceNum) && spotPriceNum > 0 &&
    Number.isFinite(livePriceNum) && livePriceNum > 0 &&
    Number.isFinite(costBasisNum) && costBasisNum > 0 &&
    !optionsMarketOpen &&
    Math.abs(((livePriceNum - spotPriceNum) / spotPriceNum) * 100) >= GAP_DUAL_REC_THRESHOLD_PCT;

  let staleness = '';
  if (lastUpdated) {
    const diffMs = now - new Date(lastUpdated).getTime();
    const mins = Math.round(diffMs / 60_000);
    staleness = mins > 0 ? ` (data is ~${mins} min old)` : '';
  }

  const sourceNote = provider
    ? `DATA SOURCE: ${provider}${delay ? ` (${delay})` : ''}`
    : '';

  const priceChangeNote = priceChange != null && priceChangePct != null
    ? `\nDAILY CHANGE: ${priceChange >= 0 ? '+' : ''}$${priceChange.toFixed(2)} (${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%)`
    : '';

  let positionBlock = '';
  if (Number.isFinite(costBasisNum) && costBasisNum > 0 && Number.isFinite(spotPriceNum) && spotPriceNum > 0) {
    const pnlPct = ((spotPriceNum - costBasisNum) / costBasisNum * 100).toFixed(2);
    const pnlDollars = shares ? (spotPriceNum - costBasisNum) * shares : null;
    const notional = shares ? spotPriceNum * shares : null;

    if (showDual) {
      const livePnlPct = ((livePriceNum - costBasisNum) / costBasisNum * 100).toFixed(2);
      const livePnlDollars = shares ? (livePriceNum - costBasisNum) * shares : null;
      const gapPctNum = ((livePriceNum - spotPriceNum) / spotPriceNum) * 100;
      const gapPct = Math.abs(gapPctNum).toFixed(1);
      positionBlock = `
USER POSITION:
  Cost Basis: ${formatPrice(costBasisNum)}
  Shares: ${shares ? shares.toLocaleString() : 'not specified'}
  Options Snapshot (delayed): ${formatPrice(spotPriceNum)}
  Live Price (Overnight): ${formatPrice(livePriceNum)} (${gapPctNum >= 0 ? '↑ +' : '↓ '}${gapPct}% gap)
  Unrealized P&L (at Snapshot): ${Number(pnlPct) >= 0 ? '+' : ''}${pnlPct}%${pnlDollars != null ? ` (${formatDollar(pnlDollars)})` : ''}
  Unrealized P&L (Live): ${Number(livePnlPct) >= 0 ? '+' : ''}${livePnlPct}%${livePnlDollars != null ? ` (${formatDollar(livePnlDollars)})` : ''}${notional != null ? `\n  Notional Exposure (at Snapshot): ~${formatDollar(notional)}` : ''}
`;
    } else {
      positionBlock = `
USER POSITION:
  Cost Basis: ${formatPrice(costBasisNum)}
  Shares: ${shares ? shares.toLocaleString() : 'not specified'}
  Current Spot: ${formatPrice(spotPriceNum)}
  Unrealized P&L: ${Number(pnlPct) >= 0 ? '+' : ''}${pnlPct}%${pnlDollars != null ? ` (${formatDollar(pnlDollars)})` : ''}${notional != null ? `\n  Notional Exposure: ~${formatDollar(notional)}` : ''}
`;
    }
  }

  const dpLevel = k.darkPoolPct != null && Number.isFinite(k.darkPoolPct)
    ? (k.darkPoolPct > DARK_POOL_PCT.elevatedAbove ? `Elevated (>${DARK_POOL_PCT.elevatedAbove}%)`
      : k.darkPoolPct < DARK_POOL_PCT.lowBelow ? `Low (<${DARK_POOL_PCT.lowBelow}%)` : 'Normal range')
    : 'No data';
  const maxPainDist = k.maxPain && spotPrice
    ? ` — Spot is $${Math.abs(spotPrice - k.maxPain).toFixed(2)} ${spotPrice < k.maxPain ? 'below' : 'above'}`
    : '';

  const topGexArr = [...(gexByStrike || [])]
    .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
    .slice(0, 5);
  const topGex = topGexArr
    .map((s) => `  Strike $${s.strike}: Net GEX ${s.gex > 0 ? '+' : ''}${(s.gex / 1e6).toFixed(1)}M (Call: ${(s.callGex / 1e6).toFixed(1)}M, Put: ${(s.putGex / 1e6).toFixed(1)}M) — ${gexCharacter(s.gex, s.strike, spotPrice)}`)
    .join('\n');

  let gexStructure = '';
  if (topGexArr.length > 0 && spotPrice) {
    const negNear = topGexArr.filter((s) => s.gex < 0 && s.strike <= spotPrice * (1 + GEX_NEAR_SPOT_CHAT_PCT / 100));
    const posAbove = topGexArr.filter((s) => s.gex > 0 && s.strike > spotPrice);
    if (negNear.length > 0 || posAbove.length > 0) {
      const parts = [];
      if (negNear.length > 0)
        parts.push(`Negative GEX dominates near/below spot (${negNear.map((s) => '$' + s.strike).join(', ')}) — dealers amplify downside moves`);
      if (posAbove.length > 0)
        parts.push(`Positive GEX above spot (${posAbove.map((s) => '$' + s.strike).join(', ')}) — dampens upside, acts as ceiling`);
      gexStructure = `\nGEX STRUCTURE: ${parts.join('. ')}.`;
    }
  }

  const recentFlow = (flowHistory || []).slice(-5)
    .map((f) => `  ${f.date}: Net ${formatDollar(f.netPremium)}, Cum ${formatDollar(f.cumPremium)}, Calls ${f.callVolume.toLocaleString()}, Puts ${f.putVolume.toLocaleString()}`)
    .join('\n');
  const flowTrend = buildFlowTrend(flowHistory);
  const flowNote = '\nNote: Cumulative flow and trend depend on lookback window; consider broader session count when interpreting premium traded (not aggressor-signed).';

  let signalBlock = '';

  if (showDual) {
    const dualRec = computeDualRecommendation({
      costBasis,
      shares,
      optionsSnapshotPrice: spotPrice,
      livePrice: liveQuote.current,
      kpis,
      gexByStrike,
      optionsMarketOpen: optionsMarketOpen || false,
    });

    if (dualRec && dualRec.primary) {
      const timeStr = lastUpdated ? new Date(lastUpdated).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }) : '';

      const timeClause = timeStr ? ` (snapshot as of ${timeStr}, may be delayed)` : '';

      signalBlock = `\n\nDASHBOARD SIGNALS (algorithmic):

  Recommendation #1 (Options Snapshot): ${dualRec.primary.signal} (${dualRec.primary.confidence} confidence)
${dualRec.primary.reasons.map((r) => `    • ${r}`).join('\n')}
    ⚠ Note: This recommendation is based on a delayed options quote snapshot${timeClause}, not the official options close price.
           Options market is currently closed; this signal will refresh after the next options snapshot when trading resumes.`;

      if (dualRec.secondary) {
        signalBlock += `

  Scenario #2 (If Live Price Holds): ${dualRec.secondary.signal} (${dualRec.secondary.confidence} confidence)
${dualRec.secondary.reasons.map((r) => `    • ${r}`).join('\n')}
    ⚠ Note: This is a hypothetical adjustment based on the current live price. The actual recommendation
           will depend on how options traders react when the options market next opens.`;
      }
    } else {
      // Fallback to single recommendation if dual computation fails
      if (Number.isFinite(costBasisNum) && costBasisNum > 0 && Number.isFinite(spotPriceNum) && spotPriceNum > 0) {
        const rec = computeRecommendation({ costBasis: costBasisNum, shares, spotPrice: spotPriceNum, kpis, gexByStrike });
        if (rec) {
          signalBlock = `\n\nDASHBOARD SIGNALS (algorithmic):
  Recommendation: ${rec.signal} (${rec.confidence} confidence)
${rec.reasons.map((r) => `  • ${r}`).join('\n')}`;
        }
      }
    }
  } else {
    if (Number.isFinite(costBasisNum) && costBasisNum > 0 && Number.isFinite(spotPriceNum) && spotPriceNum > 0) {
      const rec = computeRecommendation({ costBasis: costBasisNum, shares, spotPrice: spotPriceNum, kpis, gexByStrike });
      if (rec) {
        signalBlock = `\n\nDASHBOARD SIGNALS (algorithmic):
  Recommendation: ${rec.signal} (${rec.confidence} confidence)
${rec.reasons.map((r) => `  • ${r}`).join('\n')}`;

        // Add staleness caveat (optionsMarketOpen too: options data updates until 4:15 PM ET)
        if (isStaleData(lastUpdated, now, optionsMarketOpen || marketOpen)) {
          const d = new Date(lastUpdated);
          const timeStr = d.toLocaleString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });
          signalBlock += `\n  Note: This recommendation is based on options data from ${timeStr}. It does not reflect overnight/weekend macro developments.`;
        }
      }
    }
  }

  let painBlock = '';
  if (Number.isFinite(costBasisNum) && costBasisNum > 0 && shares != null && Number.isFinite(spotPriceNum) && spotPriceNum > 0 && iv30 != null) {
    const dailyPct = (iv30 / Math.sqrt(252)).toFixed(1);
    const threeDayPct = (iv30 * Math.sqrt(3 / 252)).toFixed(1);
    const expectedMove3d = (spotPriceNum * (iv30 / 100) * Math.sqrt(3 / 252)).toFixed(2);
    const levelUp10 = Math.round(spotPriceNum * 1.10 * 100) / 100;
    const levelUp5  = Math.round(spotPriceNum * 1.05 * 100) / 100;
    const levelDn5  = Math.round(spotPriceNum * 0.95 * 100) / 100;
    const pnlUp10 = (levelUp10 - costBasisNum) * shares;
    const pnlUp5  = (levelUp5  - costBasisNum) * shares;
    const pnlDn5  = (levelDn5  - costBasisNum) * shares;
    painBlock = `\n\nPAIN TOLERANCE (estimated):
  Expected move (1d, IV30): ±${dailyPct}% | Through 3 days: ±${threeDayPct}% (≈ ±$${expectedMove3d}/share)
  Unrealized P&L at key levels: +10% ($${levelUp10}) = ${formatDollar(pnlUp10)}, +5% ($${levelUp5}) = ${formatDollar(pnlUp5)}, -5% ($${levelDn5}) = ${formatDollar(pnlDn5)}`;
  }

  let enriched = '';

  if (!tickerCtx) {
    enriched = '\n\nRESEARCH DATA: Not available — add a Finnhub API key in Settings for news, earnings, analyst ratings, technicals, and fundamentals.';
  } else if (tickerCtx) {
    const { news, earnings, analysts, technicals, fundamentals } = tickerCtx;

    if (news?.length > 0) {
      const lines = news.map((n) => {
        const d = n.datetime ? new Date(n.datetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const sent = n.sentiment != null ? ` [sentiment: ${n.sentiment > 0 ? 'positive' : n.sentiment < 0 ? 'negative' : 'neutral'}]` : '';
        return `  ${d} (${n.source}): ${n.headline}${sent}`;
      }).join('\n');
      enriched += `\n\nRECENT NEWS (last 7 days):\n${lines}`;
    }

    if (earnings) {
      const daysTo = daysUntil(earnings.date, now);
      const timing = daysTo != null
        ? (daysTo > 0 ? `${daysTo} day${daysTo !== 1 ? 's' : ''} away` : daysTo === 0 ? 'TODAY' : `${Math.abs(daysTo)} day${Math.abs(daysTo) !== 1 ? 's' : ''} ago`)
        : '';
      let eLine = `  Date: ${earnings.date || 'unknown'}${timing ? ` (${timing})` : ''}`;
      if (earnings.epsEstimate != null) eLine += `\n  EPS Estimate: $${earnings.epsEstimate}`;
      if (earnings.epsActual != null) eLine += ` | Actual: $${earnings.epsActual}`;
      if (earnings.revenueEstimate != null) eLine += `\n  Revenue Estimate: $${(earnings.revenueEstimate / 1e9).toFixed(2)}B`;
      if (earnings.revenueActual != null) eLine += ` | Actual: $${(earnings.revenueActual / 1e9).toFixed(2)}B`;
      if (earnings.surprise != null) eLine += `\n  Surprise: ${earnings.surprise >= 0 ? '+' : '-'}$${Math.abs(earnings.surprise).toFixed(2)} ${earnings.surprise >= 0 ? 'beat' : 'miss'}`;
      enriched += `\n\nEARNINGS:\n${eLine}`;
    }

    if (analysts) {
      const c = analysts.consensus || {};
      const total = (c.strongBuy || 0) + (c.buy || 0) + (c.hold || 0) + (c.sell || 0) + (c.strongSell || 0);
      let aLine = `  Ratings: ${c.strongBuy || 0} Strong Buy, ${c.buy || 0} Buy, ${c.hold || 0} Hold, ${c.sell || 0} Sell, ${c.strongSell || 0} Strong Sell (${total} total)`;
      const pt = analysts.priceTarget || {};
      if (pt.mean != null || pt.median != null) {
        const price = pt.median ?? pt.mean;
        const upside = spotPrice && price ? ((price - spotPrice) / spotPrice * 100).toFixed(1) : null;
        const parts = [];
        if (pt.median != null) parts.push(`Median $${pt.median.toFixed(2)}`);
        if (pt.mean != null) parts.push(`Mean $${pt.mean.toFixed(2)}`);
        aLine += `\n  Price targets: ${parts.join(', ')}${upside ? ` (${Number(upside) >= 0 ? '+' : ''}${upside}% from spot)` : ''}`;
        if (pt.high != null) aLine += ` | High $${pt.high.toFixed(2)}`;
        if (pt.low != null) aLine += ` | Low $${pt.low.toFixed(2)}`;
      }
      enriched += `\n\nANALYST CONSENSUS:\n${aLine}`;
    }

    if (technicals) {
      const t = technicals;
      let tLine = '';
      if (t.sma50 != null) {
        const dist50 = spotPrice ? ((spotPrice - t.sma50) / t.sma50 * 100).toFixed(1) : null;
        tLine += `  50-day MA: $${t.sma50.toFixed(2)}${dist50 ? ` (spot ${Number(dist50) > 0 ? '+' : ''}${dist50}% from 50-MA)` : ''}\n`;
      }
      if (t.sma200 != null) {
        const dist200 = spotPrice ? ((spotPrice - t.sma200) / t.sma200 * 100).toFixed(1) : null;
        tLine += `  200-day MA: $${t.sma200.toFixed(2)}${dist200 ? ` (spot ${Number(dist200) > 0 ? '+' : ''}${dist200}% from 200-MA)` : ''}\n`;
      }
      if (t.rsi14 != null) {
        const rsiLabel = t.rsi14 > 70 ? 'OVERBOUGHT' : t.rsi14 < 30 ? 'OVERSOLD' : 'neutral';
        tLine += `  RSI-14: ${t.rsi14.toFixed(1)} (${rsiLabel})\n`;
      }
      if (t.fiftyTwoWeekHigh != null && t.fiftyTwoWeekLow != null) {
        tLine += `  52-Week Range: $${t.fiftyTwoWeekLow.toFixed(2)} — $${t.fiftyTwoWeekHigh.toFixed(2)}`;
        if (spotPrice) {
          const range = t.fiftyTwoWeekHigh - t.fiftyTwoWeekLow;
          const pctInRange = range > 0 ? ((spotPrice - t.fiftyTwoWeekLow) / range * 100).toFixed(0) : 0;
          tLine += ` (spot at ${pctInRange}% of range)`;
        }
      }
      if (tLine) enriched += `\n\nTECHNICAL LEVELS:\n${tLine}`;
    }

    if (fundamentals) {
      const f = fundamentals;
      const fLines = [];
      if (f.marketCap != null) fLines.push(`  Market Cap: $${(f.marketCap / 1e3).toFixed(1)}B`);
      if (f.peRatio != null) fLines.push(`  P/E (TTM): ${f.peRatio.toFixed(1)}`);
      if (f.forwardPE != null) fLines.push(`  Forward P/E: ${f.forwardPE.toFixed(1)}`);
      if (f.dividendYield != null) fLines.push(`  Dividend Yield: ${f.dividendYield.toFixed(2)}%`);
      if (f.beta != null) fLines.push(`  Beta: ${f.beta.toFixed(2)}`);
      if (f.revenueGrowthQuarterly != null) fLines.push(`  Revenue Growth (QoQ YoY): ${f.revenueGrowthQuarterly.toFixed(1)}%`);
      if (f.grossMargin != null) fLines.push(`  Gross Margin: ${f.grossMargin.toFixed(1)}%`);
      if (f.operatingMargin != null) fLines.push(`  Operating Margin: ${f.operatingMargin.toFixed(1)}%`);
      if (f.roeTTM != null) fLines.push(`  ROE (TTM): ${f.roeTTM.toFixed(1)}%`);
      if (fLines.length > 0) enriched += `\n\nFUNDAMENTALS:\n${fLines.join('\n')}`;
    }

    if (fundamentals?.dividendYield != null && shares != null && spotPrice != null) {
      const annDiv = shares * spotPrice * (fundamentals.dividendYield / 100);
      enriched += '\n\nPosition annual dividend income (est.): ~' + formatDollar(annDiv);
    }

    if (tickerCtx.marketQuotes) {
      const mq = tickerCtx.marketQuotes;
      const lines = Object.entries(mq).map(([sym, q]) => {
        const sign = (q.change || 0) >= 0 ? '+' : '';
        return `  ${q.label || sym}: $${q.price.toFixed(2)}  ${sign}${(q.change || 0).toFixed(2)} (${sign}${(q.changePct || 0).toFixed(2)}%)`;
      });
      if (lines.length > 0) enriched += `\n\nMARKET INDICES (ETF proxies, last close when market closed):\n${lines.join('\n')}`;
    }

    if (tickerCtx.marketNews?.length > 0) {
      const lines = tickerCtx.marketNews.map((n) => {
        const d = n.datetime ? new Date(n.datetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        return `  ${d} (${n.source}): ${n.headline}`;
      }).join('\n');
      enriched += `\n\nBROAD MARKET NEWS:\n${lines}`;
    }
  }

  if (strategicContext && typeof strategicContext === 'string' && strategicContext.trim()) {
    enriched += '\n\nSTRATEGIC CONTEXT (user-provided):\n' + strategicContext.trim();
  }

  return `TICKER: ${ticker}
TIMESTAMP: ${timestamp}
DATA LAST UPDATED: ${lastUpdated || 'unknown'}${staleness}${sourceNote ? `\n${sourceNote}` : ''}${totalOptionsCount ? `\nCONTRACTS ANALYZED: ${totalOptionsCount.toLocaleString()}` : ''}${Array.isArray(expiries) && expiries.length > 0 ? `\nEXPIRIES ANALYZED: ${expiries.join(', ')}` : ''}${iv30 != null ? `\nIV30: ${iv30.toFixed(1)}%` : ''}
SPOT PRICE: ${formatPrice(spotPrice)}${priceChangeNote}
${positionBlock}
KPI SUMMARY:
  Premium Traded (calls − puts, volume × mid, not aggressor-signed): ${formatDollar(k.netPremium)} (${k.netPremium == null ? 'n/a' : k.netPremium >= 0 ? 'call-heavy' : 'put-heavy'})
    Call Premium: ${formatDollar(k.callPremium)}
    Put Premium: ${formatDollar(k.putPremium)}
  Dark Pool Volume (statistical estimate from IV, not reported data): ${formatPct(k.darkPoolPct)} — ${dpLevel}
  Max Pain (${k.maxPainExpiry || 'nearest open expiry'}): ${formatPrice(k.maxPain)}${maxPainDist}
  Put/Call Ratio: ${formatRatio(k.putCallRatio)} (${k.putCallRatio == null ? 'n/a' : k.putCallRatio > PUT_CALL.bearishAbove ? 'Bearish' : k.putCallRatio < PUT_CALL.bullishBelow ? 'Bullish' : 'Neutral'})

TOP 5 GEX STRIKES (by magnitude):
${topGex || '  No GEX data'}${gexStructure}

RECENT NET PREMIUM FLOW (last 5 sessions):
${recentFlow || '  No flow history'}${flowTrend}${flowNote}${signalBlock}${painBlock}${enriched}`;
}
