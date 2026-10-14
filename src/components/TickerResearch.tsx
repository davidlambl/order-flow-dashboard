// src/components/TickerResearch.tsx
// The research panel: the ticker's news, earnings and analyst consensus, then the market overview, in the collapsible
// section whose open state is the section_research preference. A shell over the pure leaves in components/research/:
// it reads the market context, decides which halves show, and owns the one clock.

import { Calendar, Globe, Newspaper, TrendingUp } from 'lucide-react';
import CollapsibleSection from './CollapsibleSection.jsx';
import { useMarket } from '../contexts/MarketContext.js';
import { useNow } from '../hooks/useNow.js';
import NewsPanel from './research/NewsPanel.js';
import EarningsCard from './research/EarningsCard.js';
import AnalystPanel from './research/AnalystPanel.js';
import MarketIndicesStrip from './research/MarketIndicesStrip.js';
import MarketHeadlines from './research/MarketHeadlines.js';

export default function TickerResearch() {
  const { tickerContext: context, contextLoading: loading, data } = useMarket();
  const spotPrice = data?.spotPrice;
  // One clock for the "Nm ago" labels and the earnings countdown, passed down so the leaves stay pure: render never
  // reads the clock (react-hooks/purity), and the labels move while the page sits idle.
  const now = useNow(60_000);

  const hasTickerData = context !== null && (
    context.news.length > 0 || context.earnings !== null || context.analysts !== null
  );
  const hasMarketData = context !== null && (
    context.marketQuotes !== null || context.marketNews.length > 0
  );
  const showEmpty = !loading && !hasTickerData && !hasMarketData;

  return (
    <CollapsibleSection
      id="research"
      title="Research"
      icon={TrendingUp}
      badge={loading ? (
        <span className="text-[10px] text-[var(--color-text-muted)] animate-pulse">
          Loading...
        </span>
      ) : null}
    >
      {showEmpty ? (
        <p className="text-xs text-[var(--color-text-muted)] text-center py-4">
          Add a Finnhub API key in Settings to see news, earnings, and analyst data.
        </p>
      ) : (<>
        {hasTickerData && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                <Newspaper size={10} />
                News
              </div>
              <NewsPanel news={context.news} loading={loading} now={now} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                <Calendar size={10} />
                Earnings
              </div>
              <EarningsCard earnings={context.earnings} loading={loading} now={now} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                <TrendingUp size={10} />
                Analyst Consensus
              </div>
              <AnalystPanel analysts={context.analysts} spotPrice={spotPrice} loading={loading} />
            </div>
          </div>
        )}

        {hasMarketData && (
          <>
            {hasTickerData && (
              <div className="border-t border-[var(--color-border-subtle)] my-3" />
            )}
            <div className="space-y-3">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                <Globe size={10} />
                Market Overview
              </div>
              <MarketIndicesStrip quotes={context.marketQuotes} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    Market Headlines
                  </div>
                  <MarketHeadlines news={context.marketNews} now={now} />
                </div>
              </div>
            </div>
          </>
        )}
      </>)}
    </CollapsibleSection>
  );
}
