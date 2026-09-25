// shared/thresholds.js
//
// Interpretation thresholds shared by the dashboard (src/) and the Netlify
// Functions (netlify/): the recommendation engine, the KPI cards, the chat
// context builder and the LLM system prompt must all draw the same lines.
//
// Pure constants only: no imports, no host globals. netlify/ must never import
// src/, so anything both sides need lives here.

/** Put/call ratio: below `bullishBelow` reads bullish, above `bearishAbove` bearish, between is neutral. */
export const PUT_CALL = Object.freeze({ bullishBelow: 0.7, bearishAbove: 1.0 });

/** Dark-pool share of volume (a statistical estimate): below `lowBelow` is low, above `elevatedAbove` elevated. */
export const DARK_POOL_PCT = Object.freeze({ lowBelow: 30, elevatedAbove: 40 });

/** Unrealised P&L bands (percent) used by the recommendation engine's position factor. */
export const PNL_PCT = Object.freeze({
  takeProfitAbove: 15,   // up more than this: consider taking profits
  moderateGainAbove: 5,  // up more than this: moderate gain
  breakevenBand: 5,      // within ± this: near breakeven
  recoveryZoneAbove: -15, // down less than this: potential recovery zone; beyond it: reassess
});

/** Spot more than this far (percent) from max pain counts as a likely pull toward it. */
export const MAX_PAIN_PULL_PCT = 3;

/** A negative-GEX strike within this distance (percent of spot) counts as "near spot" for the engine. */
export const GEX_NEAR_SPOT_PCT = 3;

/** Same idea for the chat context's strike commentary, which uses a tighter band. */
export const GEX_NEAR_SPOT_CHAT_PCT = 2;

/** Options data older than this (minutes) is stale: a tighter bar while the session is open. */
export const STALE_AFTER_MIN = Object.freeze({ sessionOpen: 60, sessionClosed: 240 });

/**
 * Recommendation aggregation: a directional call needs at least `minFactors` scored
 * factors and a net score of at least max(minDirectionalScore, ceil(directionalFraction × factors)).
 */
export const RECOMMENDATION = Object.freeze({ minFactors: 3, directionalFraction: 0.4, minDirectionalScore: 2 });

/** Live price must diverge from the options snapshot by at least this (percent) to show dual recommendations. */
export const GAP_DUAL_REC_THRESHOLD_PCT = 0.5;
