// src/hooks/usePositionSignals.ts
// The position panel's signals (src/lib/positionSignals.ts) over its props and App's market context, with the market
// fields its leaves render as they are. PositionAnalysis derived them in five memos; here the derivation is one memo
// over everything it reads, so a render that changes none of it (another context field, a parent render) keeps the
// same signals without running the engine. The minute tick is one of those inputs: once a minute the signals are new
// objects, the recommendations included, where of the five memos only the staleness one re-ran. The clock is useNow's,
// never a read in render.

import { useMemo } from 'react';
import { useMarket } from '../contexts/MarketContext.js';
import { derivePositionSignals } from '../lib/positionSignals.js';
import type { PositionSignals, PositionSignalsInput } from '../lib/positionSignals.js';
import type { LiveQuote, MarketData } from '../../types/market.js';
import { useNow } from './useNow.js';

/** What usePositionSignals returns. */
export interface PositionSignalsState {
  /** derivePositionSignals over the position and the market context: the same object until one of its inputs moves. */
  signals: PositionSignals;
  /**
   * A foreground load is under way (the panel keeps its inputs and shows skeleton blocks for the rest); the signals
   * are still derived meanwhile.
   */
  loading: boolean;
  /** data?.spotPrice, as the price display reads it. */
  spotPrice: MarketData['spotPrice'] | undefined;
  /** The live quote, null until one lands. */
  liveQuote: LiveQuote | null;
  /** The options session is open: the price display keeps to its regular-hours line. */
  optionsMarketOpen: boolean;
  /** data?.provider: the price display's feed name, and whether its spot is delayed. */
  dataProvider: MarketData['provider'] | undefined;
  /** data?.lastUpdated: the recommendation badge's "Based on … data" time. */
  lastUpdated: MarketData['lastUpdated'] | undefined;
  /** useNow(60_000) in epoch ms: what the signals' staleness and the leaves' relative times read. */
  now: number;
}

/**
 * The position draft comes in as props, since App's usePositionDraft holds the edit and its debounced save; the market
 * data comes from the context.
 */
export function usePositionSignals(
  { costBasis, shares }: Pick<PositionSignalsInput, 'costBasis' | 'shares'>,
): PositionSignalsState {
  const { data, loading, marketOpen, optionsMarketOpen, liveQuote } = useMarket();
  const spotPrice = data?.spotPrice;
  const kpis = data?.kpis;
  const gexByStrike = data?.gexByStrike;
  const lastUpdated = data?.lastUpdated;
  const dataProvider = data?.provider;

  // Ticks once a minute, so staleness and relative times re-evaluate while idle without reading the clock in render
  const now = useNow(60_000);

  const signals = useMemo(
    () => derivePositionSignals({
      costBasis, shares, spotPrice, kpis, gexByStrike, liveQuote, optionsMarketOpen, marketOpen, lastUpdated, now,
    }),
    [costBasis, shares, spotPrice, kpis, gexByStrike, liveQuote, optionsMarketOpen, marketOpen, lastUpdated, now],
  );

  return { signals, loading, spotPrice, liveQuote, optionsMarketOpen, dataProvider, lastUpdated, now };
}
