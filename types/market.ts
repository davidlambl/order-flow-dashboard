// types/market.ts — JSON contracts shared by src/ (browser) and netlify/ (functions).
// Type declarations only: no runtime code, no enums. netlify/ must never import src/; both import this file.

// ─── getMarketData ───────────────────────────────────────────────────────────

/** `provider` of getMarketData (marketDataHelpers.ts:153, :274) plus generateMockData's 'mock' (mockData.ts:70). */
export type MarketProvider = 'cboe' | 'tradier' | 'tradier-sandbox' | 'mock';

/** `delay` label paired with each provider (marketDataHelpers.ts:154, :275; mockData.ts:71). */
export type MarketDelay = '15-min delayed' | 'real-time' | 'sandbox (delayed)' | 'simulated';

/**
 * Why getMarketData served CBOE although Tradier was tried (getMarketData.ts:129, :139); null when it was not tried or
 * succeeded, and always in the demo payload (mockData.ts:75).
 */
export type FallbackReason = 'tradier-timeout' | 'tradier-error' | 'tradier-no-spot' | 'tradier-no-options';

/** One strike of `gexByStrike`: computeGEX (marketDataHelpers.ts:356, :367) or generateMockData (mockData.ts:36-41). */
export interface GexRow {
  strike: number;
  callGex: number;
  /** ≤ 0: put gamma is subtracted (marketDataHelpers.ts:362). */
  putGex: number;
  /** Server-side: callGex + putGex (marketDataHelpers.ts:367), and rows with |gex| = 0 are dropped (:368). */
  gex: number;
}

/** One session of `flowHistory`: a flow_history row (getMarketData.ts:71-77; migration 001) or a mock weekday (mockData.ts:56-62). */
export interface FlowHistoryRow {
  /** 'YYYY-MM-DD'. */
  date: string;
  netPremium: number;
  cumPremium: number;
  callVolume: number;
  putVolume: number;
}

/**
 * `kpis` of getMarketData (getMarketData.ts:178-191) and of generateMockData (mockData.ts:80-93), which sets whole
 * volumes and open interest and derives both ratios from them (mockData.ts:23-28), as the function does.
 */
export interface MarketKpis {
  netPremium: number;
  callPremium: number;
  putPremium: number;
  /** 25–55, or null without a stock volume and IV30 (marketDataHelpers.ts:498): always null on Tradier. */
  darkPoolPct: number | null;
  /** null when no open expiry has open interest (marketDataHelpers.ts:432). */
  maxPain: number | null;
  /** Puts ÷ calls by volume; null without call volume (marketDataHelpers.ts:459). */
  putCallRatio: number | null;
  /**
   * Expiry max pain was measured on ('YYYY-MM-DD'); from the function, null together with maxPain. Always null in the
   * demo payload, whose maxPain (the strike nearest spot) belongs to no expiry.
   */
  maxPainExpiry: string | null;
  /** Puts ÷ calls by open interest; null without call OI (marketDataHelpers.ts:460). */
  putCallOIRatio: number | null;
  /** Call volume in whole contracts over the expiry window (computePutCallRatio, marketDataHelpers.ts:441-466); 0 if none. */
  callVolume: number;
  /** Put volume, summed the same way; 0 if none. */
  putVolume: number;
  /** Call open interest over the expiry window; 0 if none. */
  callOI: number;
  /** Put open interest over the expiry window; 0 if none. */
  putOI: number;
}

/**
 * The getMarketData 200 body (getMarketData.ts:166-202) and the generateMockData value (mockData.ts:65-97): both carry
 * every field, so demo mode uses the mock as it is. flowHistory alone is optional: the mock always has it, and the
 * function omits it when Supabase is unconfigured, has no recent rows for the ticker or the read fails
 * (getMarketData.ts:58, :68-69, :199-202).
 */
export interface MarketData {
  ticker: string;
  provider: MarketProvider;
  delay: MarketDelay;
  /** Validated finite and > 0 before a provider's answer is accepted (getMarketData.ts:120-122). */
  spotPrice: number;
  priceChange: number;
  priceChangePct: number;
  kpis: MarketKpis;
  /** Strikes within ±20 % of spot, ascending (getMarketData.ts:162-164). */
  gexByStrike: GexRow[];
  /** ISO 8601, stamped when the body is built. */
  lastUpdated: string;
  /** Chronological, at most 30 rows from the last 45 days (getMarketData.ts:44-45, :70-71). */
  flowHistory?: FlowHistoryRow[];
  fallbackReason: FallbackReason | null;
  /** Percent (e.g. 31.4); null on Tradier (marketDataHelpers.ts:279), when CBOE omits it, and in the demo payload. */
  iv30: number | null;
  /**
   * CBOE: a date-time string; Tradier: epoch milliseconds (marketDataHelpers.ts:160, :281); null in the demo payload.
   * Read by nothing in src/.
   */
  lastTradeTime: string | number | null;
  /** Contracts left after normalizeChain (the expiry window); the demo payload counts a call and a put per strike. */
  totalOptionsCount: number;
  /**
   * The expiry window: 'YYYY-MM-DD', ascending, at most EXPIRY_WINDOW = 6 (marketDataHelpers.ts:10, :317); [] in the
   * demo payload.
   */
  expiries: string[];
}

/** Exactly what getMarketData sends on 200: MarketData without the mock's provider and delay (flowHistory still optional). */
export interface MarketDataResponse extends Omit<MarketData, 'provider' | 'delay'> {
  provider: Exclude<MarketProvider, 'mock'>;
  delay: Exclude<MarketDelay, 'simulated'>;
}

// ─── getLiveQuote ────────────────────────────────────────────────────────────

/** Where `current` came from (getLiveQuote.ts:276-278, :415). 'futures-implied' is never emitted. */
export type LiveQuoteSource = 'yahoo-regular' | 'yahoo-post' | 'yahoo-pre' | 'finnhub';

/** NQ futures move attached for context only (getLiveQuote.ts:365-370); never changes `current`. */
export interface FuturesContext {
  nqChangePercent: number;
  /** previousClose × (1 + nqChangePercent / 100): an estimate anchored on the stock's prior close. */
  impliedPrice: number;
  nqCurrent: number;
  nqPreviousClose: number;
}

/** The getLiveQuote 200 body (getLiveQuote.ts:342-351 Yahoo, :406-416 Finnhub). */
export interface LiveQuote {
  ticker: string;
  /** Always a real traded price > 0. */
  current: number;
  previousClose: number | null;
  /** null when previousClose is missing or 0. */
  changePercent: number | null;
  /** Epoch milliseconds of the price itself; null only on the Finnhub path when it sends no time (getLiveQuote.ts:414). */
  timestamp: number | null;
  source: LiveQuoteSource;
  /**
   * Only for a Nasdaq-100 member whose newest price is a regular-session print, with a non-zero previousClose, while
   * the equity session is closed and NQ moved > 0.1 % (getLiveQuote.ts:356-362).
   */
  futuresContext?: FuturesContext;
}

// ─── getTickerContext ────────────────────────────────────────────────────────

/** A company-news item (getTickerContext.ts:532-539), at most 7. */
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

/** A general market headline (getTickerContext.ts:627-632), at most 5. */
export interface MarketHeadline {
  headline: string;
  source: string;
  url: string;
  datetime: string | null;
}

/**
 * Latest reported quarter (getTickerContext.ts:399-408; revenue :549-551); served from the earnings_cache row's `data`
 * JSON when fresh, and from a stale row when Alpha Vantage cannot refresh it (:360-368).
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

/** Latest Finnhub recommendation trend (getTickerContext.ts:560-567, :578-585). Counts default to 0. */
export interface AnalystConsensus {
  buy: number;
  hold: number;
  sell: number;
  strongBuy: number;
  strongSell: number;
  /** 'YYYY-MM-DD' of the trend row. */
  period: string | null;
}

/** Price-target consensus (getTickerContext.ts:568-573); all null when /stock/price-target failed (:586). */
export interface PriceTarget {
  mean: number | null;
  median: number | null;
  high: number | null;
  low: number | null;
}

/** `analysts` (getTickerContext.ts:554-588); null when /stock/recommendation failed. */
export interface AnalystInfo {
  consensus: AnalystConsensus;
  priceTarget: PriceTarget;
}

/**
 * From a year of daily candles (getTickerContext.ts:596-603); null as a whole when /stock/candle failed (403 on free
 * keys) or answered without s: 'ok' (:591).
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

/** Finnhub /stock/metric subset (getTickerContext.ts:609-623); null as a whole when that call failed. */
export interface Fundamentals {
  /** Finnhub reports it in millions (the chat's context builder divides by 1e3 for billions). */
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

/** Index proxies quoted by getTickerContext (getTickerContext.ts:483). */
export type MarketSymbol = 'SPY' | 'QQQ' | 'VIX' | 'USO' | 'GLD';

/** One entry of `marketQuotes` (getTickerContext.ts:639-645); present only when Finnhub returned a non-zero price. */
export interface MarketIndex {
  /** 'S&P 500' | 'Nasdaq 100' | 'VIX' | 'Oil (USO)' | 'Gold (GLD)' (getTickerContext.ts:484). */
  label: string;
  price: number;
  change: number | null;
  changePct: number | null;
  previousClose: number | null;
}

/** Keys of the `errors` map (getTickerContext.ts:54, :511-513). */
export type ContextSection =
  | 'news' | 'earningsCalendar' | 'recommendation' | 'priceTarget' | 'metrics' | 'candles' | 'marketNews'
  | 'marketQuotes' | 'earnings';

/** Client-safe failure reason (getTickerContext.ts:236-238); 'rate-limited' only for `earnings` (:51). */
export type ContextErrorReason = 'timeout' | 'error' | 'rate-limited' | `HTTP ${number}`;

/** Per-section failures; {} when every section answered. Also carried by the 401/502 error bodies. */
export type ContextErrors = Partial<Record<ContextSection, ContextErrorReason>>;

/** The getTickerContext 200 body (getTickerContext.ts:649-654). Sections fail independently. */
export interface TickerContext {
  ticker: string;
  /** [] when the news call failed. */
  news: NewsItem[];
  /**
   * null without a valid access token, BYOK key or not (Alpha Vantage is token-holder only: getTickerContext.ts:452-454,
   * :488-490), without ALPHA_VANTAGE_KEY, or when AV had nothing usable and no row was cached.
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

/** LLM providers getModels and askLLM accept (getModels.ts:13). */
export type LlmProvider = 'anthropic' | 'openai' | 'gemini';

/** One listed model (getModels.ts:46, :70, :82). */
export interface ModelInfo {
  /** Provider model id (Gemini's 'models/' prefix stripped). */
  id: string;
  /** Display name, falling back to the id (Gemini: to its full 'models/…' name, getModels.ts:82). */
  name: string;
  provider: LlmProvider;
}

/**
 * The getModels 200 body (getModels.ts:127). With no key and no server key the function still answers 200 with
 * `models: []` plus `error`/`code: 'KEY_REQUIRED'` (getModels.ts:113-116), which AppSettings shows as `result.error`.
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
 * Access-token verdicts (netlify/functions/lib/auth.ts:96-131), relayed as `code` by askLLM.ts:401, getModels.ts:120,
 * validateToken.ts:45 and getTickerContext.ts:456-458 (only without a BYOK key, and never TOKEN_REQUIRED or
 * AUTH_NOT_CONFIGURED); getMarketData and getLiveQuote never relay them (getMarketData.ts:99-103, getLiveQuote.ts:450-453).
 */
export type AuthErrorCode = 'AUTH_NOT_CONFIGURED' | 'TOKEN_REQUIRED' | 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'TOKEN_REVOKED';

/**
 * Codes only askLLM sends (askLLM.ts:314-347 validation, :379-474), except INVALID_JSON, which validateToken sends too
 * (validateToken.ts:32); listed because src/lib/api.ts's apiError is shared.
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
 * A non-2xx JSON body from any function (lib/http.ts:81 errorResponse, :180 rateLimitResponse, and the inline
 * jsonResponse bodies). src/lib/api.ts:30-38 reads `error`, `code` and `requestId`; the rest are per-endpoint extras.
 * RATE_LIMITED carries its retry delay in the `Retry-After` header, not in the body (http.ts:179-183).
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
  /** getModels INVALID_PROVIDER, KEY_PROVIDER_MISMATCH and token-failure bodies (getModels.ts:99, :107, :120); not its UPSTREAM_* bodies. */
  models?: [];
  /** askLLM UPSTREAM_ERROR: the provider's HTTP status (askLLM.ts:456). */
  upstreamStatus?: number;
  /** askLLM 400 validation bodies duplicate `error` here (askLLM.ts:384). */
  message?: string;
  /** validateToken failure bodies (validateToken.ts:32-45). */
  valid?: false;
}

/**
 * The validateToken 200 body (validateToken.ts): what the verified token says. Its other JSON answers are
 * ApiErrorBody, with `valid: false` except on the 405 and the 429.
 */
export interface TokenValidation {
  valid: true;
  /** Normalised: a missing or unknown tier claim reads as 'trial'. */
  tier: 'trial' | 'pro';
  /**
   * The token's subject: a string in every token the token script mints. Verification only requires it present, and
   * this body relays it as it is.
   */
  sub: string;
  /** ISO 8601, from the token's `exp`. */
  expiresAt: string;
  requestId: string;
}
