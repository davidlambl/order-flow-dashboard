// src/components/research/MarketHeadlines.tsx
// The general market headlines, each a link out with its age when the feed dated it.

import { ExternalLink } from 'lucide-react';
import { timeAgo } from '../../lib/format.js';
import type { MarketHeadline } from '../../../types/market.js';

interface MarketHeadlinesProps {
  news: MarketHeadline[];
  /** Epoch ms from the research shell's clock (useNow): the ages follow it, and render never reads the clock. */
  now: number;
}

export default function MarketHeadlines({ news, now }: MarketHeadlinesProps) {
  if (!news || news.length === 0) return (
    <p className="text-[11px] text-[var(--color-text-muted)] italic">No market news available</p>
  );
  return (
    <div className="space-y-1.5">
      {news.map((n, i) => (
        <a
          key={i}
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-2 group py-1 first:pt-0"
        >
          <span className="flex-1 text-[11px] text-[var(--color-text-secondary)] leading-snug group-hover:text-[var(--color-text-primary)] transition-colors line-clamp-2">
            {n.headline}
          </span>
          <div className="flex items-center gap-1 shrink-0 pt-0.5">
            {n.datetime && (
              <span className="text-[9px] text-[var(--color-text-muted)]">{timeAgo(n.datetime, now)}</span>
            )}
            <ExternalLink size={8} className="text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </a>
      ))}
    </div>
  );
}
