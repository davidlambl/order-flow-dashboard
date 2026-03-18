// src/components/ChatBot.jsx
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Send, Bot, User, AlertCircle, MessageSquare, X, Sparkles, Settings, Loader2, Lock, KeyRound, ShieldCheck, Trash2, Copy, Check, FileText, ListChecks, Pencil } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { askLLMStream } from '../lib/api';
import { formatDollar, formatPct, formatRatio, formatPrice } from '../lib/format';
import { setToken, validateToken as validateTokenApi } from '../lib/auth';
import { getChatHistory, setChatHistory, getPreference } from '../lib/store';
import StrategicContextEditor from './StrategicContextEditor';
import { getAISettings } from './AppSettings';
import { computeRecommendation, computeDualRecommendation, GAP_DUAL_REC_THRESHOLD_PCT } from '../lib/recommend';

/**
 * Serializes the current dashboard state into a plain-text context block
 * that gets injected into the LLM system prompt.
 */
function gexCharacter(gex, strike, spotPrice) {
  const near = spotPrice && Math.abs(strike - spotPrice) / spotPrice < 0.02;
  if (gex > 0) return near ? 'Positive gamma — dealer dampener near spot' : 'Positive gamma — magnet/pin';
  return near ? 'Negative gamma — volatility amplifier near spot' : 'Negative gamma — accelerates moves';
}

function buildFlowTrend(flowHistory) {
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

function buildFinancialContext(data, costBasis, shares, tickerCtx, strategicContext, marketOpen, optionsMarketOpen, liveQuote) {
  if (!data) return 'Dashboard data not yet loaded.';

  const { ticker, kpis, gexByStrike, flowHistory, lastUpdated, spotPrice,
    iv30, totalOptionsCount, priceChange, priceChangePct, provider, delay } = data;
  const k = kpis || {};
  const now = new Date().toISOString();
  
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
    const diffMs = Date.now() - new Date(lastUpdated).getTime();
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
  Unrealized P&L (at Snapshot): ${pnlPct >= 0 ? '+' : ''}${pnlPct}%${pnlDollars != null ? ` (${formatDollar(pnlDollars)})` : ''}
  Unrealized P&L (Live): ${livePnlPct >= 0 ? '+' : ''}${livePnlPct}%${livePnlDollars != null ? ` (${formatDollar(livePnlDollars)})` : ''}${notional != null ? `\n  Notional Exposure (at Snapshot): ~${formatDollar(notional)}` : ''}
`;
    } else {
      positionBlock = `
USER POSITION:
  Cost Basis: ${formatPrice(costBasisNum)}
  Shares: ${shares ? shares.toLocaleString() : 'not specified'}
  Current Spot: ${formatPrice(spotPriceNum)}
  Unrealized P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct}%${pnlDollars != null ? ` (${formatDollar(pnlDollars)})` : ''}${notional != null ? `\n  Notional Exposure: ~${formatDollar(notional)}` : ''}
`;
    }
  }

  const dpLevel = k.darkPoolPct > 40 ? 'Elevated (>40%)' : k.darkPoolPct < 30 ? 'Low (<30%)' : 'Normal range';
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
    const negNear = topGexArr.filter((s) => s.gex < 0 && s.strike <= spotPrice * 1.02);
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
  const flowNote = '\nNote: Cumulative flow and trend depend on lookback window; consider broader session count when interpreting institutional flow.';

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

        // Add staleness caveat
        if (lastUpdated) {
          const diffMs = Date.now() - new Date(lastUpdated).getTime();
          const diffMinutes = diffMs / (1000 * 60);
          // Use optionsMarketOpen since options data updates until 4:15 PM ET
          const isStale = (optionsMarketOpen || marketOpen) ? diffMinutes > 60 : diffMinutes > 240;
          
          if (isStale) {
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
      const daysTo = earnings.date
        ? (() => {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const target = new Date(earnings.date + 'T00:00:00');
            return Math.round((target - today) / 86_400_000);
          })()
        : null;
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
        tLine += `  50-day MA: $${t.sma50.toFixed(2)}${dist50 ? ` (spot ${dist50 > 0 ? '+' : ''}${dist50}% from 50-MA)` : ''}\n`;
      }
      if (t.sma200 != null) {
        const dist200 = spotPrice ? ((spotPrice - t.sma200) / t.sma200 * 100).toFixed(1) : null;
        tLine += `  200-day MA: $${t.sma200.toFixed(2)}${dist200 ? ` (spot ${dist200 > 0 ? '+' : ''}${dist200}% from 200-MA)` : ''}\n`;
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
TIMESTAMP: ${now}
DATA LAST UPDATED: ${lastUpdated}${staleness}${sourceNote ? `\n${sourceNote}` : ''}${totalOptionsCount ? `\nCONTRACTS ANALYZED: ${totalOptionsCount.toLocaleString()}` : ''}${iv30 != null ? `\nIV30: ${iv30.toFixed(1)}%` : ''}
SPOT PRICE: ${formatPrice(spotPrice)}${priceChangeNote}
${positionBlock}
KPI SUMMARY:
  Net Premium: ${formatDollar(k.netPremium)} (${k.netPremium >= 0 ? 'BULLISH' : 'BEARISH'})
    Call Premium: ${formatDollar(k.callPremium)}
    Put Premium: ${formatDollar(k.putPremium)}
  Dark Pool Volume: ${formatPct(k.darkPoolPct)} — ${dpLevel}
  Max Pain (Weekly): ${formatPrice(k.maxPain)}${maxPainDist}
  Put/Call Ratio: ${formatRatio(k.putCallRatio)} (${k.putCallRatio > 1 ? 'Bearish' : k.putCallRatio < 0.7 ? 'Bullish' : 'Neutral'})

TOP 5 GEX STRIKES (by magnitude):
${topGex || '  No GEX data'}${gexStructure}

RECENT NET PREMIUM FLOW (last 5 sessions):
${recentFlow || '  No flow history'}${flowTrend}${flowNote}${signalBlock}${painBlock}${enriched}`;
}

const remarkPlugins = [remarkGfm];

const markdownComponents = {
  strong: ({ children }) => (
    <strong className="text-[var(--color-accent)] font-semibold">{children}</strong>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  code: ({ children }) => (
    <code className="bg-[var(--color-surface-2)] px-1 py-0.5 rounded text-[12px] font-mono">{children}</code>
  ),
  h3: ({ children }) => (
    <h3 className="text-xs font-semibold text-[var(--color-text-primary)] mt-3 mb-1">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-xs font-medium text-[var(--color-text-secondary)] mt-2 mb-1">{children}</h4>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2 -mx-1">
      <table className="min-w-full text-[11px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-[var(--color-border-subtle)]">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold text-[var(--color-text-secondary)] whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1 text-[var(--color-text-primary)] whitespace-nowrap">{children}</td>
  ),
  tr: ({ children }) => (
    <tr className="border-b border-[var(--color-border-subtle)]/50 last:border-0">{children}</tr>
  ),
};

function MessageBubble({ msg, onDelete }) {
  const [copied, setCopied] = useState(false);
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`group/msg flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''} fade-in`}>
      <div
        className={`flex items-center justify-center w-6 h-6 rounded-lg shrink-0 mt-0.5 ${
          isUser
            ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
            : isError
            ? 'bg-[var(--color-bear-bg)] text-[var(--color-bear)]'
            : 'bg-[var(--color-purple-bg)] text-[var(--color-purple)]'
        }`}
      >
        {isUser ? <User size={12} /> : isError ? <AlertCircle size={12} /> : <Bot size={12} />}
      </div>
      <div className="flex flex-col max-w-[85%]">
        <div
          className={`text-[13px] leading-relaxed rounded-xl px-3 py-2 ${
            isUser
              ? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)] border border-[var(--color-accent)]/20'
              : isError
              ? 'bg-[var(--color-bear-bg)] text-[var(--color-bear)] border border-[var(--color-bear)]/20'
              : 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)]'
          }`}
        >
          {isUser || isError ? (
            <div className="whitespace-pre-wrap">{msg.content}</div>
          ) : (
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>{msg.content}</ReactMarkdown>
          )}
        </div>
        <div className={`flex gap-0.5 mt-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity ${isUser ? 'justify-end' : ''}`}>
          <button
            onClick={handleCopy}
            className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
            aria-label="Copy message"
            title={copied ? 'Copied!' : 'Copy markdown'}
          >
            {copied ? <Check size={11} className="text-[var(--color-bull)]" /> : <Copy size={11} />}
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-bear)] transition-colors"
            aria-label="Delete message"
            title="Delete message"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-2.5 fade-in">
      <div className="flex items-center justify-center w-6 h-6 rounded-lg shrink-0 bg-[var(--color-purple-bg)] text-[var(--color-purple)]">
        <Bot size={12} />
      </div>
      <div className="bg-[var(--color-surface-3)] border border-[var(--color-border-subtle)] rounded-xl px-3 py-2">
        <div className="flex gap-1 items-center h-5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '200ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] pulse-glow" style={{ animationDelay: '400ms' }} />
        </div>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  'What does the GEX profile suggest?',
  'Is the flow bullish or bearish?',
  'Where are key support/resistance levels?',
  'Summarize the dark pool activity.',
];

function ChatLockScreen({ onClose, onUnlock }) {
  const [tokenInput, setTokenInput] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  const handleActivate = async (e) => {
    e.preventDefault();
    const raw = tokenInput.trim();
    if (!raw) return;
    setStatus('validating');
    setError('');
    try {
      const result = await validateTokenApi(raw);
      if (result.valid) {
        setToken(raw);
        setStatus('success');
        setTimeout(() => onUnlock?.(), 400);
      } else {
        setStatus('error');
        setError(result.error || 'Invalid token');
      }
    } catch {
      setStatus('error');
      setError('Could not validate token.');
    }
  };

  return (
    <div className="flex flex-col h-full border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] w-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--color-purple-bg)]">
            <Sparkles size={12} className="text-[var(--color-purple)]" />
          </div>
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">AI Co-Pilot</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
          aria-label="Close chat"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5">
        <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/20">
          <Lock size={24} className="text-[var(--color-accent)]" />
        </div>

        <div className="text-center">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Premium Feature
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-1.5 leading-relaxed max-w-[220px]">
            The AI Co-Pilot provides institutional-grade analysis of options flow and gamma exposure.
          </p>
        </div>

        <form onSubmit={handleActivate} className="w-full max-w-xs space-y-2">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] focus-within:border-[var(--color-accent)] transition-colors">
              <KeyRound size={12} className="text-[var(--color-text-muted)] shrink-0" />
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => { setTokenInput(e.target.value); setStatus(null); setError(''); }}
                placeholder="Paste access token..."
                spellCheck={false}
                className="flex-1 bg-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={!tokenInput.trim() || status === 'validating'}
              className="px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {status === 'validating' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : status === 'success' ? (
                <ShieldCheck size={14} />
              ) : (
                'Activate'
              )}
            </button>
          </div>
          {error && (
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-bear)]">
              <AlertCircle size={10} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

const CONTEXT_UPDATE_PROMPT = `Review our conversation and suggest specific updates to my Strategic Context document (included in your data under "STRATEGIC CONTEXT"). For each suggestion:
1. Specify the action: **ADD**, **UPDATE**, or **REMOVE**
2. Reference the relevant section or heading in the current document (if updating/removing)
3. Provide the exact text to add or the revised wording for updates

Keep suggestions focused and actionable. Only suggest changes that are supported by our conversation. Do not rewrite the entire document.`;

export default function ChatBot({ data, isOpen, onClose, costBasis, shares, isPremium, onUnlock, onOpenSettings, tickerContext, marketOpen, optionsMarketOpen, liveQuote }) {
  const currentTicker = data?.ticker;
  const prevTickerRef = useRef(currentTicker);
  const skipSaveRef = useRef(false);
  const [messages, setMessages] = useState(() => getChatHistory(currentTicker));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [contextCopied, setContextCopied] = useState(false);
  const [contextEditorOpen, setContextEditorOpen] = useState(false);
  const [aiLabel, setAiLabel] = useState(() => {
    const s = getAISettings();
    return { modelName: s.modelName, provider: s.provider };
  });
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const chunkBuf = useRef('');
  const rafId = useRef(null);
  const messagesRef = useRef(messages);
  useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    if (currentTicker && currentTicker !== prevTickerRef.current) {
      setChatHistory(prevTickerRef.current, getCompleteMessages());
      prevTickerRef.current = currentTicker;
      skipSaveRef.current = true;
      setMessages(getChatHistory(currentTicker));
    }
  }, [currentTicker, getCompleteMessages]);

  useEffect(() => {
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    setChatHistory(currentTicker, messages);
  }, [messages, currentTicker]);

  useEffect(() => {
    const handler = () => {
      skipSaveRef.current = true;
      setMessages(getChatHistory(currentTicker));
    };
    window.addEventListener('store-changed', handler);
    return () => window.removeEventListener('store-changed', handler);
  }, [currentTicker]);

  useEffect(() => {
    const handler = () => {
      const s = getAISettings();
      setAiLabel({ modelName: s.modelName, provider: s.provider });
    };
    window.addEventListener('ai-settings-changed', handler);
    return () => window.removeEventListener('ai-settings-changed', handler);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  useEffect(() => () => {
    if (rafId.current) cancelAnimationFrame(rafId.current);
  }, []);

  const getCompleteMessages = useCallback(() => {
    const buf = chunkBuf.current;
    if (!buf) return messagesRef.current;
    const msgs = messagesRef.current;
    const last = msgs[msgs.length - 1];
    if (last?.role === 'assistant') {
      return [...msgs.slice(0, -1), { ...last, content: last.content + buf }];
    }
    return [...msgs, { role: 'assistant', content: buf }];
  }, []);

  const flushChunks = useCallback(() => {
    rafId.current = null;
    const text = chunkBuf.current;
    if (!text) return;
    chunkBuf.current = '';
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, content: last.content + text };
        return updated;
      }
      return [...prev, { role: 'assistant', content: text }];
    });
  }, []);

  const onStreamChunk = useCallback((chunk) => {
    chunkBuf.current += chunk;
    if (!rafId.current) {
      rafId.current = requestAnimationFrame(flushChunks);
    }
  }, [flushChunks]);

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || sending) return;

    const userMsg = { role: 'user', content: text.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setSending(true);

    try {
      const financialContext = buildFinancialContext(data, costBasis, shares, tickerContext, getPreference('strategic_context'), marketOpen, optionsMarketOpen, liveQuote);
      const apiMessages = [...getCompleteMessages().filter((m) => m.role === 'user' || m.role === 'assistant'), userMsg]
        .slice(-10);

      const settings = getAISettings();

      await askLLMStream(
        {
          messages: apiMessages,
          financialContext,
          ticker: data?.ticker || 'UNKNOWN',
          userApiKey: settings.apiKey || null,
          model: settings.model,
          provider: settings.provider,
        },
        onStreamChunk,
      );
      flushChunks();
    } catch (err) {
      flushChunks();
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: `Failed to get analysis: ${err.message}` },
      ]);
    } finally {
      setSending(false);
    }
  }, [sending, data, costBasis, shares, tickerContext, marketOpen, optionsMarketOpen, liveQuote, onStreamChunk, flushChunks, getCompleteMessages]);

  const requestContextSuggestions = useCallback(async () => {
    if (sending) return;
    setSending(true);

    try {
      const financialContext = buildFinancialContext(data, costBasis, shares, tickerContext, getPreference('strategic_context'), marketOpen, optionsMarketOpen, liveQuote);

      // Send the prompt as a transient API message — not persisted in chat history
      const apiMessages = [
        ...getCompleteMessages().filter((m) => m.role === 'user' || m.role === 'assistant').slice(-10),
        { role: 'user', content: CONTEXT_UPDATE_PROMPT },
      ];

      const settings = getAISettings();

      await askLLMStream(
        {
          messages: apiMessages,
          financialContext,
          ticker: data?.ticker || 'UNKNOWN',
          userApiKey: settings.apiKey || null,
          model: settings.model,
          provider: settings.provider,
        },
        onStreamChunk,
      );
      flushChunks();
    } catch (err) {
      flushChunks();
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: `Failed to get suggestions: ${err.message}` },
      ]);
    } finally {
      setSending(false);
    }
  }, [sending, data, costBasis, shares, tickerContext, marketOpen, optionsMarketOpen, liveQuote, onStreamChunk, flushChunks, getCompleteMessages]);

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const autoResize = useCallback((el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const deleteMessage = useCallback((index) => {
    setMessages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearHistory = useCallback(() => {
    const tickerLabel = currentTicker || 'this ticker';
    if (!window.confirm(`Clear all chat history for ${tickerLabel}? This cannot be undone.`)) {
      return;
    }
    setMessages([]);
    setChatHistory(currentTicker, []);
  }, [currentTicker]);

  if (!isOpen) return null;

  if (!isPremium) {
    return <ChatLockScreen onClose={onClose} onUnlock={onUnlock} />;
  }

  return (
    <div className="flex flex-col h-full border-l border-[var(--color-border-subtle)] bg-[var(--color-surface)] w-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--color-purple-bg)]">
            <Sparkles size={12} className="text-[var(--color-purple)]" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)] leading-none">
              AI Co-Pilot
            </h3>
            <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
              {aiLabel.modelName} · {data?.ticker || '—'} context
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setShowContext((v) => !v); setContextCopied(false); }}
            className={`p-1.5 rounded-lg transition-colors ${
              showContext
                ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]'
            }`}
            aria-label="Inspect model context"
            title="View data sent to model"
          >
            <FileText size={14} />
          </button>
          <button
            onClick={() => setContextEditorOpen(true)}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            aria-label="Edit strategic context"
            title="Edit Strategic Context"
          >
            <Pencil size={14} />
          </button>
          {messages.length > 0 && (
            <button
              onClick={clearHistory}
              className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-bear)] hover:bg-[var(--color-bear-bg)] transition-colors"
              aria-label="Clear chat history"
              title="Clear chat history"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={onOpenSettings}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            aria-label="Settings"
          >
            <Settings size={14} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] transition-colors"
            aria-label="Close chat"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Context Inspector */}
      {showContext && (() => {
        const ctx = buildFinancialContext(data, costBasis, shares, tickerContext, getPreference('strategic_context'), marketOpen, optionsMarketOpen, liveQuote);
        return (
          <div className="flex-1 overflow-y-auto border-b border-[var(--color-border-subtle)]">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]">
              <span className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                Model Context ({ctx.length.toLocaleString()} chars)
              </span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(ctx).catch(() => {});
                  setContextCopied(true);
                  setTimeout(() => setContextCopied(false), 1500);
                }}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
              >
                {contextCopied ? <><Check size={10} className="text-[var(--color-bull)]" /> Copied</> : <><Copy size={10} /> Copy</>}
              </button>
            </div>
            <pre className="p-3 text-[11px] leading-relaxed text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap break-words">
              {ctx}
            </pre>
          </div>
        );
      })()}

      {/* Messages */}
      {!showContext && <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 space-y-3"
        style={{ overscrollBehavior: 'contain' }}
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-2">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-purple-bg)]">
              <MessageSquare size={18} className="text-[var(--color-purple)]" />
            </div>
            <p className="text-xs text-[var(--color-text-muted)] max-w-[200px]">
              Ask questions about {data?.ticker || 'the'} order flow, gamma, or positioning.
            </p>
            <div className="flex flex-col gap-1.5 w-full mt-1">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="text-left text-xs text-[var(--color-text-secondary)] px-3 py-2 rounded-lg border border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border)] transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[var(--color-text-muted)]/60 mt-2">
              Chat history is saved locally and persists until cleared.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} onDelete={() => deleteMessage(i)} />
        ))}

        {sending && messages[messages.length - 1]?.role !== 'assistant' && <TypingIndicator />}
      </div>}

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex items-end gap-2 px-3 py-2.5 border-t border-[var(--color-border-subtle)]"
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); autoResize(e.target); }}
          onKeyDown={handleKeyDown}
          placeholder="Ask about the flow..."
          rows={1}
          className="flex-1 bg-[var(--color-surface-2)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors resize-none leading-relaxed"
          disabled={sending}
        />
        {messages.some((m) => m.role === 'assistant') && !sending && (
          <button
            type="button"
            onClick={requestContextSuggestions}
            className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors shrink-0"
            aria-label="Suggest updates to Strategic Context"
            title="Suggest updates to Strategic Context"
          >
            <ListChecks size={16} />
          </button>
        )}
        <button
          type="submit"
          disabled={!input.trim() || sending}
          className="p-2 rounded-lg bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
          aria-label="Send message"
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </form>

      <StrategicContextEditor
        isOpen={contextEditorOpen}
        onClose={() => setContextEditorOpen(false)}
      />
    </div>
  );
}
