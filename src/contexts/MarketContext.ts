// src/contexts/MarketContext.ts
// The market data of the dashboard's one ticker, for everything below App that used to take it as props: Header
// (20 props), ChatBot and PositionAnalysis (12 each), TickerResearch and AppSettings. App builds the value from its
// state and its hooks (useMarketData, useLiveQuote, useTickerContext) and provides it with React 19's context-as-
// provider element, <MarketContext value={market}>; useMarket() reads it and throws outside the provider, since
// nothing below App renders without one. The leaves that take only their own slice of the data (KPICards, GexChart,
// FlowChart) stay on props: they are pure, and App.test.jsx counts App's renders through KPICards' props.

import { createContext, useContext } from 'react';
import type { LiveQuote, MarketData, TickerContext } from '../../types/market.js';

export interface MarketValue {
  /** The symbol shown everywhere (App's state). */
  ticker: string;
  /** App's handleTickerChange: flushes a position edit still inside its debounce, then switches the ticker. */
  setTicker: (ticker: string) => void;
  /** useMarketData's data: the ticker's last good payload, the previous ticker's while this one loads, or demo data. */
  data: MarketData | null;
  /** useMarketData's loading: a foreground load is under way, never the silent refresh. */
  loading: boolean;
  /** useMarketData's error: the last failure's message, null after a success. */
  error: string | null;
  /** useMarketData's usingMock: `data` is demo data. */
  usingMock: boolean;
  /** App's handleRefresh: reloads the market data AND the live quote in the foreground (Header's button). */
  refresh: () => void;
  /** useMarketData's autoRefresh: the silent refresh is switched on. */
  autoRefresh: boolean;
  /** useMarketData's toggleAutoRefresh. */
  toggleAutoRefresh: () => void;
  /** useMarketData's nextRefreshAt: the next silent refresh's deadline (epoch ms), or null (Header's countdown). */
  nextRefreshAt: number | null;
  /** useMarketData's refreshMs: the refresh interval in ms, after backoff. */
  refreshMs: number;
  /** useMarketData's marketOpen: the equity session is open (useMarketClock, Eastern Time). */
  marketOpen: boolean;
  /** useMarketData's optionsMarketOpen: the options session is open; the silent refresh runs only then. */
  optionsMarketOpen: boolean;
  /** useLiveQuote's quote, or null until one lands. */
  liveQuote: LiveQuote | null;
  /** useTickerContext's context: the ticker's research, null until it lands and while research is off. */
  tickerContext: TickerContext | null;
  /** useTickerContext's loading. */
  contextLoading: boolean;
  /** 'mock' while usingMock, else data's provider, 'cboe' before anything loads (AppSettings' data-source banner). */
  dataSource: string;
}

export const MarketContext = createContext<MarketValue | null>(null);

export function useMarket(): MarketValue {
  const value = useContext(MarketContext);
  if (value === null) throw new Error('useMarket: no MarketContext above this component (App provides it)');
  return value;
}
