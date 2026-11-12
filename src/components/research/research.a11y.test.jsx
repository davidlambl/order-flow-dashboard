// src/components/research/research.a11y.test.jsx — the research leaves for a screen reader and for a pointer that
// cannot hover: what a coloured dot, a bar, a marker or a hover alone used to say is there as text, a link out shows
// its icon at rest and says it opens a new tab, a skeleton says it is loading, and axe finds nothing in each leaf's
// loading, empty and filled states. The leaves render bare (they read no context). Tailwind's sr-only does nothing
// under jsdom, so visually hidden text counts in textContent and in an accessible name as a screen reader hears it.
// TickerResearch.test.jsx holds what a sighted user sees of the same leaves, through their shell.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import NewsPanel from './NewsPanel.js';
import MarketHeadlines from './MarketHeadlines.js';
import AnalystPanel from './AnalystPanel.js';
import RatingBar from './RatingBar.js';
import EarningsCard from './EarningsCard.js';
import LoadingSkeleton from './LoadingSkeleton.js';
import MarketIndicesStrip from './MarketIndicesStrip.js';
import { expectNoAxeViolations } from '../../test/a11y.js';

/** The research shell's clock, fixed: Friday 2026-09-25, 11:00 ET. */
const NOW = Date.parse('2026-09-25T15:00:00Z');
const minutesBefore = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

/** A complete NewsItem, half an hour old, from Reuters. */
const newsItem = (headline, sentiment) => ({
  headline, summary: '', source: 'Reuters', url: `https://example.com/${headline.replaceAll(' ', '-')}`,
  datetime: minutesBefore(30), sentiment,
});

/** A complete MarketHeadline, an hour old. */
const headline = (text) => ({ headline: text, source: 'Reuters', url: 'https://example.com/m1', datetime: minutesBefore(60) });

/** A complete AnalystInfo: the counts default to 0 and the targets to null, as the function sends them. */
const analysts = (counts = {}, targets = {}) => ({
  consensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, period: '2026-10-01', ...counts },
  priceTarget: { mean: null, median: null, high: null, low: null, ...targets },
});

/** A complete EarningsInfo, reported the day before NOW, a beat on EPS and a miss on revenue. */
const REPORTED = {
  date: '2026-09-24', epsEstimate: 2.5, epsActual: 2.6, revenueEstimate: 12.3e9, revenueActual: 12.1e9,
  quarter: null, year: null, surprise: 0.1,
};

const TARGETS = { mean: 245, median: 250, high: 300, low: 100 };

/** `link` shows its arrow-out icon at rest: nothing in it waits for a hover (which a phone has not) to be seen. */
function expectNothingHiddenUntilHover(link) {
  expect(link.querySelector('svg.lucide-external-link')).not.toBeNull();
  expect(link.querySelector('.opacity-0')).toBeNull();
}

describe('NewsPanel', () => {
  it("says each item's sentiment in words, for a screen reader and as the dot's title", () => {
    render(
      <NewsPanel
        news={[newsItem('Chips rally', 0.4), newsItem('Chips slide', -0.2), newsItem('Chips flat', 0), newsItem('Chips unscored', null)]}
        loading={false}
        now={NOW}
      />,
    );
    const [up, down, flat, unscored] = screen.getAllByRole('link');
    expect(up).toHaveAccessibleName(/^Positive sentiment Chips rally /);
    expect(down).toHaveAccessibleName(/^Negative sentiment Chips slide /);
    expect(flat).toHaveAccessibleName(/^Neutral sentiment Chips flat /);
    expect(unscored).toHaveAccessibleName(/^Chips unscored /); // no score, no dot, nothing said
    expect(screen.getAllByTitle(/ sentiment$/).map((dot) => dot.title))
      .toEqual(['Positive sentiment', 'Negative sentiment', 'Neutral sentiment']);
  });

  it('shows each link\'s icon at rest and says the link opens a new tab', () => {
    render(<NewsPanel news={[newsItem('Chips rally', null)]} loading={false} now={NOW} />);
    const link = screen.getByRole('link');
    expectNothingHiddenUntilHover(link);
    // jsdom joins inline spans without a space ("Reuters30m ago"); a browser separates flex items.
    expect(link).toHaveAccessibleName(/^Chips rally Reuters\s?30m ago \(opens in a new tab\)$/);
  });

  it('Pin: the icons are decorative: hidden from the accessibility tree', () => {
    render(<NewsPanel news={[newsItem('Chips rally', null)]} loading={false} now={NOW} />);
    const icons = screen.getByRole('link').querySelectorAll('svg');
    expect(icons).toHaveLength(2); // the clock before the age, the arrow out
    for (const icon of icons) expect(icon).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('MarketHeadlines', () => {
  it('shows each link\'s icon at rest and says the link opens a new tab', () => {
    render(<MarketHeadlines news={[headline('Stocks rally into the close')]} now={NOW} />);
    const link = screen.getByRole('link');
    expectNothingHiddenUntilHover(link);
    expect(link).toHaveAccessibleName(/^Stocks rally into the close\s?1h ago \(opens in a new tab\)$/);
  });
});

describe('LoadingSkeleton', () => {
  it('is a status that says it is loading, over its placeholder rows', () => {
    const { container } = render(<LoadingSkeleton rows={4} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Loading…$/);
    expect(container.querySelectorAll('.skeleton')).toHaveLength(4);
  });
});

describe('RatingBar', () => {
  it('names each count beneath the bar, which said the rating by its colour alone', () => {
    const { container } = render(
      <RatingBar consensus={analysts({ strongBuy: 5, buy: 10, hold: 4, sell: 0, strongSell: 1 }).consensus} />,
    );
    expect(container.textContent).toBe('Strong Buy: 5Buy: 10Hold: 4Strong Sell: 1');
    // The bar draws the same counts as segments, titled for a pointer: a screen reader reads the counts instead.
    const bar = container.firstChild.firstChild;
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect([...bar.children].map((segment) => segment.title)).toEqual(['Strong Buy: 5', 'Buy: 10', 'Hold: 4', 'Strong Sell: 1']);
  });

  it('Pin: each count is still the text of an element of its own, as the research panel reads it', () => {
    const { container } = render(<RatingBar consensus={analysts({ hold: 1, sell: 3 }).consensus} />);
    const counts = [...container.querySelectorAll('span')].filter((el) => /^\d+$/.test(el.textContent));
    expect(counts.map((el) => el.textContent)).toEqual(['1', '3']);
  });
});

describe('AnalystPanel', () => {
  it("says where spot is on the targets' range in words, not only by its marker", () => {
    render(<AnalystPanel analysts={analysts({ buy: 3 }, TARGETS)} spotPrice={200} loading={false} />);
    expect(screen.getByText('Spot: $200.00')).toBeInTheDocument();
    // The two markers are drawings, titled for a pointer; the target's prices are in the text above them.
    const markers = [screen.getByTitle('Spot: $200.00'), screen.getByTitle('Mean: $245.00 Median: $250.00')];
    for (const marker of markers) expect(marker).toHaveAttribute('aria-hidden', 'true');
  });

  it('Pin: with no spot price there is no spot marker, and no spot in words either', () => {
    render(<AnalystPanel analysts={analysts({ buy: 3 }, TARGETS)} spotPrice={undefined} loading={false} />);
    expect(screen.queryByText(/^Spot: /)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^Spot: /)).not.toBeInTheDocument();
  });
});

describe('the research leaves under axe', () => {
  it('loading: the news, earnings and analyst skeletons each say so', async () => {
    const { container } = render(
      <div>
        <NewsPanel news={[]} loading now={NOW} />
        <EarningsCard earnings={null} loading now={NOW} />
        <AnalystPanel analysts={null} spotPrice={200} loading />
      </div>,
    );
    expect(screen.getAllByRole('status').map((status) => status.textContent)).toEqual(['Loading…', 'Loading…', 'Loading…']);
    await expectNoAxeViolations(container);
  });

  it('Pin: empty, every leaf says it has nothing', async () => {
    const { container } = render(
      <div>
        <NewsPanel news={[]} loading={false} now={NOW} />
        <EarningsCard earnings={null} loading={false} now={NOW} />
        <AnalystPanel analysts={null} spotPrice={200} loading={false} />
        <AnalystPanel analysts={analysts()} spotPrice={200} loading={false} />
        <MarketHeadlines news={[]} now={NOW} />
        <MarketIndicesStrip quotes={{}} />
      </div>,
    );
    expect(container.firstChild.textContent).toBe(
      'No recent news available. Add a Finnhub API key in Settings.No earnings data available.No analyst data available.'
      + 'RatingsPrice targetsNo price target data for this symbol.No market news available',
    );
    await expectNoAxeViolations(container);
  });

  it('Pin: filled: news, earnings, ratings and targets, the index strip and the headlines', async () => {
    const { container } = render(
      <div>
        <NewsPanel news={[newsItem('Chips rally', 0.4), newsItem('Chips slide', null)]} loading={false} now={NOW} />
        <EarningsCard earnings={REPORTED} loading={false} now={NOW} />
        <AnalystPanel analysts={analysts({ strongBuy: 5, buy: 10, hold: 4, strongSell: 1 }, TARGETS)} spotPrice={200} loading={false} />
        <MarketIndicesStrip
          quotes={{
            SPY: { label: 'S&P 500', price: 520.1, change: 2.33, changePct: 0.45, previousClose: 517.77 },
            QQQ: { label: 'Nasdaq 100', price: 440, change: -5.35, changePct: -1.2, previousClose: 445.35 },
          }}
        />
        <MarketHeadlines news={[headline('Stocks rally into the close')]} now={NOW} />
      </div>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(3);
    await expectNoAxeViolations(container);
  });
});
