// src/components/TickerResearch.test.jsx — the research panel: the header that collapses it and the choice it stores
// (section_research), the Loading... badge and a refetch's skeleton rows, the Finnhub-key empty state, the news links
// and their ages, the earnings countdown and figures, the analyst ratings bar and price-target range, the market
// overview's index strip and headlines, and which of the two halves show. Written against the one-file panel before
// its decomposition into a shell over components/research/*.tsx, as the contract both must keep, so every test is a
// pin: it asserts what the user sees and the storage keeps (text, links and their attributes, counts, the stored
// preference) and deliberately not the header's markup, which the decomposition moves onto CollapsibleSection (the
// title in a span, aria-expanded, the hover transitions); the header is only ever the button named Research.
// No fake timers: every datetime and earnings date is taken from the real clock before the panel mounts, so a label
// reads the same whether the panel reads the clock on each render or once when it mounts.
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TickerResearch from './TickerResearch.jsx';
import { toLocalISODate } from '../lib/format.js';
import { withContexts } from '../test/contexts.jsx';

/** A complete getTickerContext body: every TickerContext field (types/market.ts), empty unless overridden. */
const context = (overrides = {}) => ({
  ticker: 'AVGO', news: [], earnings: null, analysts: null, technicals: null, fundamentals: null, marketNews: [],
  marketQuotes: null, errors: {}, ...overrides,
});

/** A complete NewsItem; Finnhub's company news carries no sentiment. */
const newsItem = (headline, source, url, datetime) => ({
  headline, summary: '', source, url, datetime, sentiment: null,
});

/** A complete MarketHeadline. */
const marketHeadline = (headline, url, datetime) => ({ headline, source: 'Reuters', url, datetime });

/** A complete EarningsInfo with nothing known yet, overridden field by field. */
const earnings = (overrides = {}) => ({
  date: null, epsEstimate: null, epsActual: null, revenueEstimate: null, revenueActual: null, quarter: null,
  year: null, surprise: null, ...overrides,
});

/** A complete AnalystInfo: counts default to 0 and targets to null, as the function sends them. */
const analysts = (counts = {}, targets = {}) => ({
  consensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, period: '2026-10-01', ...counts },
  priceTarget: { mean: null, median: null, high: null, low: null, ...targets },
});

/** A complete MarketIndex. */
const quote = (label, price, change, changePct) => ({
  label, price, change, changePct, previousClose: change == null ? null : price - change,
});

/** An ISO datetime `minutes` before now on the real clock; call it before the render that shows it. */
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

/** The local calendar date `days` from today, 'YYYY-MM-DD' as the earnings feed writes it. */
function localDate(days) {
  const today = new Date();
  return toLocalISODate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
}

/** One company-news item, half an hour old: ticker data for a test about something else. */
const someNews = () => [newsItem('Broadcom extends its AI deal', 'Reuters', 'https://example.com/n1', minutesAgo(30))];

/** One market headline, an hour old: market data for a test about something else. */
const someHeadlines = () => [marketHeadline('Stocks rally into the close', 'https://example.com/m1', minutesAgo(60))];

/** The panel under both providers, as App provides it: the research value, its loading flag and the spot price. */
const panel = ({ tickerContext = null, contextLoading = false, spotPrice = 200 } = {}) => withContexts(
  <TickerResearch />,
  { market: { tickerContext, contextLoading, data: spotPrice == null ? null : { spotPrice } } },
);

const renderPanel = (options) => render(panel(options));

const header = () => screen.getByRole('button', { name: /Research/ });

const EMPTY = 'Add a Finnhub API key in Settings to see news, earnings, and analyst data.';
const CAPTIONS = ['News', 'Earnings', 'Analyst Consensus', 'Market Overview', 'Market Headlines'];

/** The panel captions on screen, in document order. */
const captions = () => screen.queryAllByText(/^(News|Earnings|Analyst Consensus|Market Overview|Market Headlines)$/)
  .map((el) => el.textContent);

/** A caption's column: the caption and the panel under it. */
const column = (caption) => screen.getByText(caption).parentElement;

/** A label's row or box: the label and the figures beside or under it, as one string. */
const rowOf = (label) => screen.getByText(label).parentElement.textContent;

/** The 'Nm ago' / 'Nh ago' / 'Nd ago' label inside a link, or null when it shows none. */
const ageIn = (link) => within(link).queryByText(/ ago$/)?.textContent ?? null;

/** b comes after a in the document. */
const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

const SEGMENT = /^(Strong Buy|Buy|Hold|Sell|Strong Sell): \d+$/;
const MARKER = /^(Spot|Mean|Median): /;
const SYMBOL = /^(SPY|QQQ|VIX|USO|GLD)$/;

describe('TickerResearch', () => {
  it('Pin: the header toggles the body and stores each choice, once per click and never on render', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const tickerContext = context({ news: someNews(), marketNews: someHeadlines() });
    render(<StrictMode>{panel({ tickerContext })}</StrictMode>);
    expect(captions()).toEqual(CAPTIONS);
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(localStorage.getItem('section_research')).toBeNull();
    expect(setItem).not.toHaveBeenCalled(); // rendering (twice, under StrictMode) never writes

    await user.click(header());
    expect(captions()).toEqual([]);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(localStorage.getItem('section_research')).toBe('false');
    expect(setItem).toHaveBeenCalledTimes(1);

    await user.click(header());
    expect(captions()).toEqual(CAPTIONS);
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(localStorage.getItem('section_research')).toBe('true');
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('Pin: a stored false starts it collapsed, with the header there to reopen it', async () => {
    const user = userEvent.setup();
    localStorage.setItem('section_research', 'false');
    renderPanel();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();

    await user.click(header());
    expect(screen.getByText(EMPTY)).toBeInTheDocument();
    expect(localStorage.getItem('section_research')).toBe('true');
  });

  it('Pin: loading shows the badge in the header, an empty body with nothing yet and skeleton rows over data', () => {
    const tickerContext = context({
      news: someNews(), earnings: earnings({ date: localDate(10) }), analysts: analysts({ buy: 3 }),
    });
    const { container, rerender } = renderPanel({ contextLoading: true });
    expect(within(header()).getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
    expect(captions()).toEqual([]);
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);

    // A refetch over a value already shown: the captions stay, each panel's content gives way to its skeleton rows.
    rerender(panel({ tickerContext, contextLoading: true }));
    expect(within(header()).getByText('Loading...')).toBeInTheDocument();
    expect(captions()).toEqual(['News', 'Earnings', 'Analyst Consensus']);
    expect(column('News').querySelectorAll('.skeleton')).toHaveLength(4);
    expect(column('Earnings').querySelectorAll('.skeleton')).toHaveLength(3);
    expect(column('Analyst Consensus').querySelectorAll('.skeleton')).toHaveLength(3);
    expect(container.querySelectorAll('.skeleton')).toHaveLength(10);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    rerender(panel({ tickerContext }));
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('Pin: not loading, with nothing to show, it asks for a Finnhub key', () => {
    const { rerender } = renderPanel();
    expect(screen.getByText(EMPTY)).toBeInTheDocument();
    expect(captions()).toEqual([]);
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();

    // An answer with every section empty reads the same as no answer.
    rerender(panel({ tickerContext: context() }));
    expect(screen.getByText(EMPTY)).toBeInTheDocument();
    expect(captions()).toEqual([]);
  });

  it('Pin: each news item is a link out with its headline, source and age; an empty list says so', () => {
    const news = [
      newsItem('Broadcom extends its AI deal', 'Reuters', 'https://example.com/n1', minutesAgo(30)),
      newsItem('Chip stocks slide', 'Bloomberg', 'https://example.com/n2', minutesAgo(3 * 60)),
      newsItem('Analysts lift their targets', 'MarketWatch', 'https://example.com/n3', minutesAgo(2 * 24 * 60)),
      newsItem('Broadcom files its 10-Q', 'Business Wire', 'https://example.com/n4', null),
    ];
    const upcoming = earnings({ date: localDate(10) });
    const { rerender } = renderPanel({ tickerContext: context({ news }) });
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    links.forEach((link, i) => {
      expect(link).toHaveAttribute('href', news[i].url);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(within(link).getByText(news[i].headline)).toBeInTheDocument();
      expect(within(link).getByText(news[i].source)).toBeInTheDocument();
    });
    expect(links.map(ageIn)).toEqual(['30m ago', '3h ago', '2d ago', null]);

    rerender(panel({ tickerContext: context({ earnings: upcoming }) }));
    expect(screen.getByText('No recent news available. Add a Finnhub API key in Settings.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('Pin: the earnings date counts down in local calendar days; without a date it reads TBD', () => {
    const dates = [
      [localDate(0), 'Reporting TODAY'],
      [localDate(1), 'Reporting TOMORROW'],
      [localDate(2), '2 days away'],
      [localDate(10), '10 days away'],
      [localDate(-1), 'Reported 1 day ago'],
      [localDate(-3), 'Reported 3 days ago'],
    ];
    const { rerender } = renderPanel();
    for (const [date, timing] of dates) {
      rerender(panel({ tickerContext: context({ earnings: earnings({ date }) }) }));
      expect(rowOf(date)).toBe(`${date}${timing}`);
    }

    // No date: TBD with no timing line, and nothing reported shows no figures.
    rerender(panel({ tickerContext: context({ earnings: earnings() }) }));
    expect(rowOf('TBD')).toBe('TBD');
    expect(screen.queryByText('EPS Est.')).not.toBeInTheDocument();
    expect(screen.queryByText('Rev. Est.')).not.toBeInTheDocument();
    expect(screen.queryByText(/ (beat|miss)$/)).not.toBeInTheDocument();
  });

  it('Pin: earnings show the EPS and revenue estimates with their actuals and the surprise; none says so', () => {
    const reported = earnings({
      date: localDate(-1), epsEstimate: 2.5, epsActual: 2.6, revenueEstimate: 12.3e9, revenueActual: 12.1e9,
      surprise: 0.1,
    });
    const upcoming = earnings({ date: localDate(10), epsEstimate: 2.5, revenueEstimate: 12.3e9 });
    const news = someNews();
    const { rerender } = renderPanel({ tickerContext: context({ earnings: reported }) });
    expect(rowOf('EPS Est.')).toBe('EPS Est.$2.50Actual: $2.60');
    expect(rowOf('Rev. Est.')).toBe('Rev. Est.$12.30BActual: $12.10B');
    expect(screen.getByText('+$0.10 beat')).toBeInTheDocument();

    rerender(panel({ tickerContext: context({ earnings: { ...reported, surprise: -0.05 } }) }));
    expect(screen.getByText('-$0.05 miss')).toBeInTheDocument();
    expect(screen.queryByText('+$0.10 beat')).not.toBeInTheDocument();

    // Ahead of the report: the estimates alone, no surprise.
    rerender(panel({ tickerContext: context({ earnings: upcoming }) }));
    expect(rowOf('EPS Est.')).toBe('EPS Est.$2.50');
    expect(rowOf('Rev. Est.')).toBe('Rev. Est.$12.30B');
    expect(screen.queryByText(/ (beat|miss)$/)).not.toBeInTheDocument();

    rerender(panel({ tickerContext: context({ news }) }));
    expect(screen.getByText('No earnings data available.')).toBeInTheDocument();
  });

  it('Pin: the ratings bar has a segment per non-zero rating, sized by its share, with the counts beneath', () => {
    /** The bar as the user reads it: each segment's title and width, and the counts under the bar. */
    const bar = () => {
      const segments = screen.queryAllByTitle(SEGMENT);
      return {
        titles: segments.map((s) => s.title),
        widths: segments.map((s) => s.style.width),
        counts: within(screen.getByText('Ratings').parentElement).queryAllByText(/^\d+$/).map((el) => el.textContent),
      };
    };
    const { rerender } = renderPanel({
      tickerContext: context({ analysts: analysts({ strongBuy: 5, buy: 10, hold: 4, sell: 0, strongSell: 1 }) }),
    });
    expect(bar()).toEqual({
      titles: ['Strong Buy: 5', 'Buy: 10', 'Hold: 4', 'Strong Sell: 1'],
      widths: ['25%', '50%', '20%', '5%'],
      counts: ['5', '10', '4', '1'],
    });

    // A second total, so the widths read as shares of it and not as a fixed scale of the counts.
    rerender(panel({ tickerContext: context({ analysts: analysts({ hold: 1, sell: 3 }) }) }));
    expect(bar()).toEqual({ titles: ['Hold: 1', 'Sell: 3'], widths: ['25%', '75%'], counts: ['1', '3'] });

    // No ratings at all: the caption stays alone, with no bar element and no counts.
    rerender(panel({ tickerContext: context({ analysts: analysts() }) }));
    expect(bar()).toEqual({ titles: [], widths: [], counts: [] });
    expect(screen.getByText('Ratings').parentElement.children).toHaveLength(1);
  });

  it('Pin: the price target shows the median, else the mean, its upside from spot and markers on the range', () => {
    const targets = { mean: 245, median: 250, high: 300, low: 100 };
    const withTargets = (over) => context({ analysts: analysts({}, { ...targets, ...over }) });
    const { rerender } = renderPanel({ tickerContext: withTargets() });
    expect(screen.getByText('Price targets')).toBeInTheDocument();
    expect(rowOf('Median')).toBe('Median$250.00+25.0%');
    expect(screen.getByText('Mean: $245.00')).toBeInTheDocument();
    expect(screen.getByTitle('Spot: $200.00').style.left).toBe('50%');
    expect(screen.getByTitle('Mean: $245.00 Median: $250.00').style.left).toBe('72.5%');
    expect(screen.getByText('Low: $100.00')).toBeInTheDocument();
    expect(screen.getByText('High: $300.00')).toBeInTheDocument();

    // No median: the mean is the headline figure and loses its own line.
    rerender(panel({ tickerContext: withTargets({ median: null }) }));
    expect(rowOf('Mean')).toBe('Mean$245.00+22.5%');
    expect(screen.queryByText('Mean: $245.00')).not.toBeInTheDocument();
    expect(screen.getByTitle('Mean: $245.00').style.left).toBe('72.5%');

    // No mean: the marker sits on the median.
    rerender(panel({ tickerContext: withTargets({ mean: null }) }));
    expect(rowOf('Median')).toBe('Median$250.00+25.0%');
    expect(screen.getByTitle('Median: $250.00').style.left).toBe('75%');

    // A spot outside the range puts its marker at that end; above the target the upside is negative.
    rerender(panel({ tickerContext: withTargets(), spotPrice: 400 }));
    expect(rowOf('Median')).toBe('Median$250.00-37.5%');
    expect(screen.getByTitle('Spot: $400.00').style.left).toBe('100%');
    rerender(panel({ tickerContext: withTargets(), spotPrice: 50 }));
    expect(rowOf('Median')).toBe('Median$250.00+400.0%');
    expect(screen.getByTitle('Spot: $50.00').style.left).toBe('0%');
  });

  it('Pin: price-target edges (no spot price, a zero range, a missing bound, no targets) and no analyst data', () => {
    const targets = { mean: 245, median: 250, high: 300, low: 100 };
    const withTargets = (over) => context({ analysts: analysts({}, { ...targets, ...over }) });
    const news = someNews();
    // No market data yet: no upside and no spot marker; the target's marker stays.
    const { rerender } = renderPanel({ tickerContext: withTargets(), spotPrice: null });
    expect(rowOf('Median')).toBe('Median$250.00');
    expect(screen.queryAllByTitle(MARKER).map((el) => el.title)).toEqual(['Mean: $245.00 Median: $250.00']);

    // high === low: no width to place a marker in.
    rerender(panel({ tickerContext: withTargets({ mean: 250, high: 250, low: 250 }) }));
    expect(screen.queryAllByTitle(MARKER)).toHaveLength(0);
    expect(screen.getByText('Low: $250.00')).toBeInTheDocument();
    expect(screen.getByText('High: $250.00')).toBeInTheDocument();

    // A missing bound: no range, and a dash after its dollar sign.
    rerender(panel({ tickerContext: withTargets({ low: null }) }));
    expect(screen.queryAllByTitle(MARKER)).toHaveLength(0);
    expect(screen.getByText('Low: $—')).toBeInTheDocument();
    expect(screen.getByText('High: $300.00')).toBeInTheDocument();

    // Every target null (the price-target call failed): one line under the caption.
    rerender(panel({ tickerContext: context({ analysts: analysts() }) }));
    expect(screen.getByText('Price targets')).toBeInTheDocument();
    expect(screen.getByText('No price target data for this symbol.')).toBeInTheDocument();
    expect(screen.queryByText(/^(Low|High): /)).not.toBeInTheDocument();

    rerender(panel({ tickerContext: context({ news }) }));
    expect(screen.getByText('No analyst data available.')).toBeInTheDocument();
  });

  it('Pin: the market overview shows each index quote (VIX without a dollar sign) and the headlines as links', () => {
    const marketQuotes = {
      SPY: quote('S&P 500', 520.1, 2.33, 0.45),
      QQQ: quote('Nasdaq 100', 440, -5.35, -1.2),
      VIX: quote('VIX', 18.25, 0.4, 2.24),
      GLD: quote('Gold (GLD)', 230, null, null),
    };
    const marketNews = [
      marketHeadline('Stocks rally into the close', 'https://example.com/m1', minutesAgo(60)),
      marketHeadline('Treasury yields hold steady', 'https://example.com/m2', null),
    ];
    const { rerender } = renderPanel({ tickerContext: context({ marketQuotes, marketNews }) });
    expect(screen.getAllByText(SYMBOL).map((el) => el.parentElement.textContent))
      .toEqual(['SPY$520.10+0.45%', 'QQQ$440.00-1.20%', 'VIX18.25+2.24%', 'GLD$230.00+0.00%']);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    links.forEach((link, i) => {
      expect(link).toHaveAttribute('href', marketNews[i].url);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(within(link).getByText(marketNews[i].headline)).toBeInTheDocument();
    });
    expect(links.map(ageIn)).toEqual(['1h ago', null]);
    expect(links[1].querySelector('span.text-\\[9px\\]')).toBeNull(); // no age element at all, not an empty one

    // An empty quotes map still counts as market data: the overview shows, without a strip element.
    rerender(panel({ tickerContext: context({ marketQuotes: {} }) }));
    expect(captions()).toEqual(['Market Overview', 'Market Headlines']);
    expect(screen.queryAllByText(SYMBOL)).toHaveLength(0);
    expect(screen.getByText('Market Overview').parentElement.querySelector('.flex-wrap')).toBeNull();
    expect(screen.getByText('No market news available')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();

    rerender(panel({ tickerContext: context({ marketQuotes }) }));
    expect(screen.getAllByText(SYMBOL)).toHaveLength(4);
    expect(screen.getByText('No market news available')).toBeInTheDocument();
  });

  it('Pin: ticker data and market data each show their own half, with a divider only between the two', () => {
    const news = someNews();
    const marketNews = someHeadlines();
    const { container, rerender } = renderPanel({ tickerContext: context({ news }) });
    expect(captions()).toEqual(['News', 'Earnings', 'Analyst Consensus']);
    expect(container.querySelectorAll('.border-t')).toHaveLength(0);

    rerender(panel({ tickerContext: context({ marketNews }) }));
    expect(captions()).toEqual(['Market Overview', 'Market Headlines']);
    expect(container.querySelectorAll('.border-t')).toHaveLength(0);

    rerender(panel({ tickerContext: context({ news, marketNews }) }));
    expect(captions()).toEqual(CAPTIONS);
    const dividers = container.querySelectorAll('.border-t');
    expect(dividers).toHaveLength(1);
    expect(follows(screen.getByText('Analyst Consensus'), dividers[0])).toBe(true);
    expect(follows(dividers[0], screen.getByText('Market Overview'))).toBe(true);
  });
});
