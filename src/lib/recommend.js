// src/lib/recommend.js
// Algorithmic position recommendation engine.
// Scores 5 market factors and aggregates into a BUY / HOLD / SELL signal.

// Minimum gap percentage to trigger dual recommendation mode
export const GAP_DUAL_REC_THRESHOLD_PCT = 0.5;

/**
 * @param {{ costBasis: number, shares: number, spotPrice: number, kpis: object, gexByStrike: Array }} params
 * @returns {{ signal: 'BUY'|'HOLD'|'SELL', confidence: 'HIGH'|'MEDIUM'|'LOW', reasons: string[], pnl: { dollars: number, percent: number } }}
 */
export function computeRecommendation({ costBasis, shares, spotPrice, kpis, gexByStrike }) {
  if (!costBasis || !spotPrice || !kpis) return null;

  const k = kpis;
  const pnlDollars = (spotPrice - costBasis) * (shares || 0);
  const pnlPercent = ((spotPrice - costBasis) / costBasis) * 100;
  const pnl = { dollars: pnlDollars, percent: pnlPercent };

  const scores = [];
  const reasons = [];

  // Factor 1: P&L position
  if (pnlPercent > 15) {
    scores.push(-1);
    reasons.push(`Up ${pnlPercent.toFixed(1)}% — consider taking profits`);
  } else if (pnlPercent > 5) {
    scores.push(0);
    reasons.push(`Up ${pnlPercent.toFixed(1)}% — moderate gain`);
  } else if (pnlPercent > -5) {
    scores.push(0);
    reasons.push(`Near breakeven (${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
  } else if (pnlPercent > -15) {
    scores.push(1);
    reasons.push(`Down ${pnlPercent.toFixed(1)}% — potential recovery zone`);
  } else {
    scores.push(-1);
    reasons.push(`Down ${pnlPercent.toFixed(1)}% — significant loss, reassess thesis`);
  }

  // Factor 2: Max pain magnet
  if (k.maxPain) {
    const distToMaxPain = ((spotPrice - k.maxPain) / k.maxPain) * 100;
    if (distToMaxPain > 3) {
      scores.push(-1);
      reasons.push(`Spot is ${distToMaxPain.toFixed(1)}% above max pain ($${k.maxPain}) — likely pull toward it`);
    } else if (distToMaxPain < -3) {
      scores.push(1);
      reasons.push(`Spot is ${Math.abs(distToMaxPain).toFixed(1)}% below max pain ($${k.maxPain}) — likely push toward it`);
    } else {
      scores.push(0);
      reasons.push(`Spot near max pain ($${k.maxPain}) — pinning expected`);
    }
  }

  // Factor 3: GEX positioning
  if (gexByStrike && gexByStrike.length > 0) {
    const sorted = [...gexByStrike].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex));
    const biggestStrikes = sorted.slice(0, 5);
    const positiveGexAbove = biggestStrikes.some((s) => s.gex > 0 && s.strike > spotPrice);
    const positiveGexBelow = biggestStrikes.some((s) => s.gex > 0 && s.strike < spotPrice);
    const negativeGexNearby = biggestStrikes.some(
      (s) => s.gex < 0 && Math.abs(s.strike - spotPrice) / spotPrice < 0.03
    );

    if (positiveGexBelow && !negativeGexNearby) {
      scores.push(1);
      reasons.push('Positive GEX below spot — dealer hedging provides support');
    } else if (negativeGexNearby) {
      scores.push(-1);
      reasons.push('Negative GEX near spot — volatile, dealers amplify moves');
    } else if (positiveGexAbove) {
      scores.push(0);
      reasons.push('Positive GEX above spot — resistance zone overhead');
    } else {
      scores.push(0);
      reasons.push('GEX positioning neutral');
    }
  }

  // Factor 4: Net premium flow
  if (k.netPremium != null) {
    if (k.netPremium > 0) {
      scores.push(1);
      reasons.push('Net premium is bullish — institutional call buying');
    } else {
      scores.push(-1);
      reasons.push('Net premium is bearish — institutional put buying');
    }
  }

  // Factor 5: Put/Call ratio
  if (k.putCallRatio != null) {
    if (k.putCallRatio < 0.7) {
      scores.push(1);
      reasons.push(`P/C ratio ${k.putCallRatio.toFixed(2)} — bullish sentiment`);
    } else if (k.putCallRatio > 1.0) {
      scores.push(-1);
      reasons.push(`P/C ratio ${k.putCallRatio.toFixed(2)} — bearish sentiment`);
    } else {
      scores.push(0);
      reasons.push(`P/C ratio ${k.putCallRatio.toFixed(2)} — neutral`);
    }
  }

  const sum = scores.reduce((a, b) => a + b, 0);
  const signal = sum >= 2 ? 'BUY' : sum <= -2 ? 'SELL' : 'HOLD';

  const absScores = scores.map(Math.abs);
  const dissents = scores.filter((s) => (sum >= 0 && s < 0) || (sum < 0 && s > 0)).length;
  const confidence = dissents === 0 ? 'HIGH' : dissents <= 1 ? 'MEDIUM' : 'LOW';

  return { signal, confidence, reasons, pnl };
}

/**
 * Extract key price levels from market data for the position chart.
 */
export function extractPriceLevels({ costBasis, spotPrice, kpis, gexByStrike }) {
  const levels = [];

  if (costBasis) levels.push({ price: costBasis, label: 'Basis', color: 'var(--color-cyan)' });
  if (spotPrice) levels.push({ price: spotPrice, label: 'Spot', color: 'var(--color-warn)' });
  if (kpis?.maxPain) levels.push({ price: kpis.maxPain, label: 'Max Pain', color: 'var(--color-purple)' });

  if (gexByStrike && gexByStrike.length > 0) {
    const sorted = [...gexByStrike].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex));
    const topStrikes = sorted.slice(0, 4);
    const support = topStrikes.filter((s) => s.gex > 0 && s.strike <= (spotPrice || Infinity));
    const resistance = topStrikes.filter((s) => s.gex > 0 && s.strike > (spotPrice || 0));

    if (support.length > 0) {
      levels.push({ price: support[0].strike, label: 'GEX Support', color: 'var(--color-bull)' });
    }
    if (resistance.length > 0) {
      levels.push({ price: resistance[0].strike, label: 'GEX Resist.', color: 'var(--color-bear)' });
    }
  }

  return levels.sort((a, b) => a.price - b.price);
}

/**
 * Compute dual recommendations for when options market is closed and spot price has diverged.
 * @param {{ costBasis: number, shares: number, optionsSnapshotPrice: number, livePrice: number, kpis: object, gexByStrike: Array, optionsMarketOpen: boolean }} params
 *   - optionsSnapshotPrice: Delayed CBOE quote (15-min delayed current_price from options data feed)
 *   - livePrice: Real-time price from Yahoo/Finnhub (extended hours or futures-implied)
 * @returns {{ primary: object, secondary: object|null, optionsSnapshotPrice: number, livePrice: number, gapPercent: number, optionsMarketOpen: boolean } | null}
 */
export function computeDualRecommendation({
  costBasis, shares,
  optionsSnapshotPrice, livePrice,
  kpis, gexByStrike,
  optionsMarketOpen
}) {
  if (
    costBasis == null || !Number.isFinite(costBasis) ||
    optionsSnapshotPrice == null || !Number.isFinite(optionsSnapshotPrice) ||
    livePrice == null || !Number.isFinite(livePrice) ||
    !kpis
  ) {
    return null;
  }

  const gapPercent = ((livePrice - optionsSnapshotPrice) / optionsSnapshotPrice) * 100;

  // If options market is open, only compute live recommendation (no dual mode needed)
  if (optionsMarketOpen) {
    const liveRec = computeRecommendation({
      costBasis,
      shares,
      spotPrice: livePrice,
      kpis,
      gexByStrike,
    });

    if (!liveRec) {
      return null;
    }

    return {
      primary: liveRec,
      secondary: null,
      optionsSnapshotPrice,
      livePrice,
      gapPercent,
      optionsMarketOpen,
    };
  }

  // Options market closed - compute both recommendations for dual mode
  const optionsCloseRec = computeRecommendation({
    costBasis,
    shares,
    spotPrice: optionsSnapshotPrice,
    kpis,
    gexByStrike,
  });

  const liveRec = computeRecommendation({
    costBasis,
    shares,
    spotPrice: livePrice,
    kpis,
    gexByStrike,
  });

  if (!optionsCloseRec || !liveRec) {
    return null;
  }

  return {
    primary: optionsCloseRec,
    secondary: liveRec,
    optionsSnapshotPrice,
    livePrice,
    gapPercent,
    optionsMarketOpen,
  };
}
