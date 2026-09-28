// types/market.ts — JSON contracts shared by src/ (browser) and netlify/ (functions).
// Type declarations only: no runtime code, no enums. netlify/ must never import src/; both import this file.

// ─── getMarketData ───────────────────────────────────────────────────────────

/** `provider` of getMarketData (marketDataHelpers.js:42, :159) plus generateMockData's 'mock' (mockData.js:59). */
export type MarketProvider = 'cboe' | 'tradier' | 'tradier-sandbox' | 'mock';

/** `delay` label paired with each provider (marketDataHelpers.js:43, :160; mockData.js:60). */
export type MarketDelay = '15-min delayed' | 'real-time' | 'sandbox (delayed)' | 'simulated';

/** Why getMarketData served CBOE although Tradier was tried (getMarketData.js:125, :135); null when it was not tried or succeeded. */
export type FallbackReason = 'tradier-timeout' | 'tradier-error' | 'tradier-no-spot' | 'tradier-no-options';

/** One strike of `gexByStrike`: computeGEX (marketDataHelpers.js:224, :235) or generateMockData (mockData.js:25-30). */
export interface GexRow {
  strike: number;
  callGex: number;
  /** ≤ 0: put gamma is subtracted (marketDataHelpers.js:230). */
  putGex: number;
  /** Server-side: callGex + putGex (marketDataHelpers.js:235), and rows with |gex| = 0 are dropped (:236). */
  gex: number;
}

/** One session of `flowHistory`: a flow_history row (getMarketData.js:67-73; migration 001) or a mock weekday (mockData.js:45-51). */
export interface FlowHistoryRow {
  /** 'YYYY-MM-DD'. */
  date: string;
  netPremium: number;
  cumPremium: number;
  callVolume: number;
  putVolume: number;
}

/**
 * `kpis` of getMarketData (getMarketData.js:168-181). The six required fields are also produced by generateMockData
 * (mockData.js:61-68); the optional ones are always sent by the function and only omitted by the mock.
 */
export interface MarketKpis {
  netPremium: number;
  callPremium: number;
  putPremium: number;
  /** 25–55, or null without a stock volume and IV30 (marketDataHelpers.js:353): always null on Tradier. */
  darkPoolPct: number | null;
  /** null when no open expiry has open interest (marketDataHelpers.js:296). */
  maxPain: number | null;
  /** Puts ÷ calls by volume; null without call volume (marketDataHelpers.js:317). */
  putCallRatio: number | null;
  /** Expiry max pain was measured on ('YYYY-MM-DD'); null together with maxPain. */
  maxPainExpiry?: string | null;
  /** Puts ÷ calls by open interest; null without call OI (marketDataHelpers.js:318). */
  putCallOIRatio?: number | null;
  callVolume?: number;
  putVolume?: number;
  callOI?: number;
  putOI?: number;
}

/**
 * The getMarketData 200 body (getMarketData.js:156-191) and the generateMockData value (mockData.js:54-72).
 * The optional fields are always present in the function's body (see MarketDataResponse) and absent from the mock,
 * except flowHistory, which the function omits when Supabase is unconfigured, has no recent rows for the ticker or
 * the read fails (getMarketData.js:54, :64-65, :189-191).
 */
export interface MarketData {
  ticker: string;
  provider: MarketProvider;
  delay: MarketDelay;
  /** Validated finite and > 0 before a provider's answer is accepted (getMarketData.js:116-118). */
  spotPrice: number;
  priceChange: number;
  priceChangePct: number;
  kpis: MarketKpis;
  /** Strikes within ±20 % of spot, ascending (getMarketData.js:152-154). */
  gexByStrike: GexRow[];
  /** ISO 8601, stamped when the body is built. */
  lastUpdated: string;
  /** Chronological, at most 30 rows from the last 45 days (getMarketData.js:40-41, :66-67). */
  flowHistory?: FlowHistoryRow[];
  fallbackReason?: FallbackReason | null;
  /** Percent (e.g. 31.4); null on Tradier (marketDataHelpers.js:164) and when CBOE omits it. */
  iv30?: number | null;
  /** CBOE: a date-time string; Tradier: epoch milliseconds (marketDataHelpers.js:49, :166). Read by nothing in src/. */
  lastTradeTime?: string | number | null;
  /** Contracts left after normalizeChain (the expiry window). */
  totalOptionsCount?: number;
  /** The expiry window: 'YYYY-MM-DD', ascending, at most EXPIRY_WINDOW = 6 (marketDataHelpers.js:9, :194). */
  expiries?: string[];
}

/** Exactly what getMarketData sends on 200: the server-only fields required, no mock values, flowHistory still optional. */
export interface MarketDataResponse extends Required<Omit<MarketData, 'flowHistory'>> {
  provider: Exclude<MarketProvider, 'mock'>;
  delay: Exclude<MarketDelay, 'simulated'>;
  kpis: Required<MarketKpis>;
  flowHistory?: FlowHistoryRow[];
}

// ─── getLiveQuote ────────────────────────────────────────────────────────────

/** Where `current` came from (getLiveQuote.js:200-202, :335). 'futures-implied' is never emitted. */
export type LiveQuoteSource = 'yahoo-regular' | 'yahoo-post' | 'yahoo-pre' | 'finnhub';

/** NQ futures move attached for context only (getLiveQuote.js:288-293); never changes `current`. */
export interface FuturesContext {
  nqChangePercent: number;
  /** previousClose × (1 + nqChangePercent / 100): an estimate anchored on the stock's prior close. */
  impliedPrice: number;
  nqCurrent: number;
  nqPreviousClose: number;
}

/** The getLiveQuote 200 body (getLiveQuote.js:265-274 Yahoo, :326-336 Finnhub). */
export interface LiveQuote {
  ticker: string;
  /** Always a real traded price > 0. */
  current: number;
  previousClose: number | null;
  /** null when previousClose is missing or 0. */
  changePercent: number | null;
  /** Epoch milliseconds of the price itself; null only on the Finnhub path when it sends no time (getLiveQuote.js:334). */
  timestamp: number | null;
  source: LiveQuoteSource;
  /**
   * Only for a Nasdaq-100 member whose newest price is a regular-session print, with a non-zero previousClose, while
   * the equity session is closed and NQ moved > 0.1 % (getLiveQuote.js:279-285).
   */
  futuresContext?: FuturesContext;
}

// ─── getTickerContext ────────────────────────────────────────────────────────

/** A company-news item (getTickerContext.js:380-387), at most 7. */
export interface NewsItem {
  headline: string;
  summary: string;
  source: string;
  url: string;
  /** ISO 8601 from Finnhub's Unix seconds; null when absent. */
  datetime: string | null;
  /** Finnhub company-news carries no sentiment: null in practice. */
  sentiment: number | null;
}

/** A general market headline (getTickerContext.js:471-476), at most 5. */
export interface MarketHeadline {
  headline: string;
  source: string;
  url: string;
  datetime: string | null;
}

/**
 * Latest reported quarter (getTickerContext.js:250-259; revenue :393-395); served from the earnings_cache row's `data`
 * JSON when fresh, and from a stale row when Alpha Vantage cannot refresh it (:213-220).
 */
export interface EarningsInfo {
  /** Reported date 'YYYY-MM-DD'. */
  date: string | null;
  epsEstimate: number | null;
  epsActual: number | null;
  /** Finnhub calendar entry for the same quarter (±3 days), else null. */
  revenueEstimate: number | null;
  revenueActual: number | null;
  /** Never populated. */
  quarter: null;
  /** Never populated. */
  year: null;
  surprise: number | null;
}

/** Latest Finnhub recommendation trend (getTickerContext.js:404-411, :422-429). Counts default to 0. */
export interface AnalystConsensus {
  buy: number;
  hold: number;
  sell: number;
  strongBuy: number;
  strongSell: number;
  /** 'YYYY-MM-DD' of the trend row. */
  period: string | null;
}

/** Price-target consensus (getTickerContext.js:412-417); all null when /stock/price-target failed (:430). */
export interface PriceTarget {
  mean: number | null;
  median: number | null;
  high: number | null;
  low: number | null;
}

/** `analysts` (getTickerContext.js:398-432); null when /stock/recommendation failed. */
export interface AnalystInfo {
  consensus: AnalystConsensus;
  priceTarget: PriceTarget;
}

/**
 * From a year of daily candles (getTickerContext.js:440-447); null as a whole when /stock/candle failed (403 on free
 * keys) or answered without s: 'ok' (:435).
 */
export interface Technicals {
  sma50: number | null;
  sma200: number | null;
  /** Wilder RSI-14; null with fewer than 15 closes or a flat series. */
  rsi14: number | null;
  currentPrice: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
}

/** Finnhub /stock/metric subset (getTickerContext.js:453-467); null as a whole when that call failed. */
export interface Fundamentals {
  /** Finnhub reports it in millions (ChatBot divides by 1e3 for billions). */
  marketCap: number | null;
  peRatio: number | null;
  forwardPE: number | null;
  dividendYield: number | null;
  beta: number | null;
  revenueGrowthQuarterly: number | null;
  epsGrowthQuarterly: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  roeTTM: number | null;
  debtToEquity: number | null;
  freeCashFlowTTM: number | null;
  revenuePerShareTTM: number | null;
}

/** Index proxies quoted by getTickerContext (getTickerContext.js:334). */
export type MarketSymbol = 'SPY' | 'QQQ' | 'VIX' | 'USO' | 'GLD';

/** One entry of `marketQuotes` (getTickerContext.js:483-489); present only when Finnhub returned a non-zero price. */
export interface MarketIndex {
  /** 'S&P 500' | 'Nasdaq 100' | 'VIX' | 'Oil (USO)' | 'Gold (GLD)' (getTickerContext.js:335). */
  label: string;
  price: number;
  change: number | null;
  changePct: number | null;
  previousClose: number | null;
}

/** Keys of the `errors` map (getTickerContext.js:48, :361-362). */
export type ContextSection =
  | 'news' | 'earningsCalendar' | 'recommendation' | 'priceTarget' | 'metrics' | 'candles' | 'marketNews'
  | 'marketQuotes' | 'earnings';

/** Client-safe failure reason (getTickerContext.js:97-99); 'rate-limited' only for `earnings` (:45). */
export type ContextErrorReason = 'timeout' | 'error' | 'rate-limited' | `HTTP ${number}`;

/** Per-section failures; {} when every section answered. Also carried by the 401/502 error bodies. */
export type ContextErrors = Partial<Record<ContextSection, ContextErrorReason>>;

/** The getTickerContext 200 body (getTickerContext.js:493-498). Sections fail independently. */
export interface TickerContext {
  ticker: string;
  /** [] when the news call failed. */
  news: NewsItem[];
  /**
   * null without a valid access token, BYOK key or not (Alpha Vantage is token-holder only: getTickerContext.js:303-305,
   * :339-341), without ALPHA_VANTAGE_KEY, or when AV had nothing usable and no row was cached.
   */
  earnings: EarningsInfo | null;
  analysts: AnalystInfo | null;
  technicals: Technicals | null;
  fundamentals: Fundamentals | null;
  /** [] when the general-news call failed. */
  marketNews: MarketHeadline[];
  /** Only the symbols that answered; null when none did. */
  marketQuotes: Partial<Record<MarketSymbol, MarketIndex>> | null;
  errors: ContextErrors;
}

// ─── getModels ───────────────────────────────────────────────────────────────

/** LLM providers getModels and askLLM accept (getModels.js:12). */
export type LlmProvider = 'anthropic' | 'openai' | 'gemini';

/** One listed model (getModels.js:25, :49, :61). */
export interface ModelInfo {
  /** Provider model id (Gemini's 'models/' prefix stripped). */
  id: string;
  /** Display name, falling back to the id (Gemini: to its full 'models/…' name, getModels.js:61). */
  name: string;
  provider: LlmProvider;
}

/**
 * The getModels 200 body (getModels.js:104). With no key and no server key the function still answers 200 with
 * `models: []` plus `error`/`code: 'KEY_REQUIRED'` (getModels.js:90-93), which AppSettings shows as `result.error`.
 */
export interface ModelList {
  models: ModelInfo[];
  provider: LlmProvider;
  requestId: string;
  error?: string;
  code?: 'KEY_REQUIRED';
}

// ─── Error bodies ────────────────────────────────────────────────────────────

/**
 * Access-token verdicts (netlify/functions/lib/auth.js:59-92), relayed as `code` by askLLM.js:287, getModels.js:97,
 * validateToken.js:36 and getTickerContext.js:307-309 (only without a BYOK key, and never TOKEN_REQUIRED or
 * AUTH_NOT_CONFIGURED); getMarketData and getLiveQuote never relay them (getMarketData.js:95-99, getLiveQuote.js:369-372).
 */
export type AuthErrorCode = 'AUTH_NOT_CONFIGURED' | 'TOKEN_REQUIRED' | 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'TOKEN_REVOKED';

/**
 * Codes only askLLM sends (askLLM.js:200-233 validation, :265-359), except INVALID_JSON, which validateToken sends too
 * (validateToken.js:23); listed because src/lib/api.js's apiError is shared.
 */
export type AskLlmErrorCode =
  | 'INVALID_JSON' | 'PROVIDER_REQUIRED' | 'MESSAGES_REQUIRED' | 'TOO_MANY_MESSAGES' | 'INVALID_MESSAGE'
  | 'MESSAGE_TOO_LONG' | 'CONTEXT_TOO_LONG' | 'INVALID_MODEL' | 'MODEL_NOT_ALLOWED' | 'QUOTA_UNAVAILABLE'
  | 'QUOTA_EXCEEDED' | 'UPSTREAM_UNREACHABLE' | 'UPSTREAM_INVALID';

/** Every `code` a function can send. */
export type ApiErrorCode =
  | 'METHOD_NOT_ALLOWED' | 'RATE_LIMITED' | 'INVALID_TICKER'
  | 'NO_SPOT_PRICE' | 'NO_OPTIONS' | 'UPSTREAM_ERROR' | 'UPSTREAM_TIMEOUT'   // getMarketData (UPSTREAM_ERROR also askLLM/getModels, UPSTREAM_TIMEOUT also askLLM)
  | 'QUOTE_UNAVAILABLE'                                                       // getLiveQuote
  | 'KEY_REQUIRED' | 'FINNHUB_KEY_REJECTED' | 'CONTEXT_UNAVAILABLE'           // getTickerContext (KEY_REQUIRED also getModels/askLLM)
  | 'INVALID_PROVIDER' | 'KEY_PROVIDER_MISMATCH' | 'UPSTREAM_KEY_REJECTED'    // getModels (KEY_PROVIDER_MISMATCH also askLLM)
  | AuthErrorCode
  | AskLlmErrorCode;

/**
 * A non-2xx JSON body from any function (lib/http.js:70 errorResponse, :152 rateLimitResponse, and the inline
 * jsonResponse bodies). src/lib/api.js:16-27 reads `error`, `code` and `requestId`; the rest are per-endpoint extras.
 * RATE_LIMITED carries its retry delay in the `Retry-After` header, not in the body (http.js:151-155).
 */
export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
  /** 8-char id for the function log; absent only on the 405 METHOD_NOT_ALLOWED bodies. */
  requestId?: string;
  /** getMarketData NO_SPOT_PRICE / NO_OPTIONS: the provider whose answer was unusable ('cboe' in practice: the last attempt). getModels: the requested LLM provider. */
  provider?: Exclude<MarketProvider, 'mock'> | LlmProvider;
  /** getMarketData NO_SPOT_PRICE / NO_OPTIONS: why Tradier was skipped before CBOE also failed. */
  fallbackReason?: FallbackReason | null;
  /** getTickerContext FINNHUB_KEY_REJECTED / CONTEXT_UNAVAILABLE. */
  errors?: ContextErrors;
  /** getModels INVALID_PROVIDER, KEY_PROVIDER_MISMATCH and token-failure bodies (getModels.js:76, :84, :97); not its UPSTREAM_* bodies. */
  models?: [];
  /** askLLM UPSTREAM_ERROR: the provider's HTTP status (askLLM.js:341). */
  upstreamStatus?: number;
  /** askLLM 400 validation bodies duplicate `error` here (askLLM.js:270). */
  message?: string;
  /** validateToken failure bodies (validateToken.js:23-36). */
  valid?: false;
}
