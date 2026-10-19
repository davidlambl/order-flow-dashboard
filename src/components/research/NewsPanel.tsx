// src/components/research/NewsPanel.tsx
// The ticker's company news, each headline a link out with its source and age.

import { Clock, ExternalLink } from 'lucide-react';
import LoadingSkeleton from './LoadingSkeleton.js';
import { timeAgo } from '../../lib/format.js';
import type { NewsItem } from '../../../types/market.js';

interface NewsPanelProps {
  news: NewsItem[];
  loading: boolean;
  /** Epoch ms from the research shell's clock (useNow): the ages follow it, and render never reads the clock. */
  now: number;
}

function SentimentDot({ value }: { value: number | null }) {
  if (value == null) return null;
  const color = value > 0
    ? 'bg-[var(--color-bull)]'
    : value < 0
    ? 'bg-[var(--color-bear)]'
    : 'bg-[var(--color-text-muted)]';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color} shrink-0`} />;
}

export default function NewsPanel({ news, loading, now }: NewsPanelProps) {
  if (loading) return <LoadingSkeleton rows={4} />;

  if (!news || news.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] italic">
        No recent news available. Add a Finnhub API key in Settings.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1">
      {news.map((n, i) => (
        <a
          key={i}
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex gap-2 items-start p-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors"
        >
          <SentimentDot value={n.sentiment} />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-[var(--color-text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--color-accent)] transition-colors">
              {n.headline}
            </p>
            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[var(--color-text-muted)]">
              <span>{n.source}</span>
              <span className="flex items-center gap-0.5">
                <Clock size={8} />
                {timeAgo(n.datetime, now)}
              </span>
            </div>
          </div>
          <ExternalLink size={10} className="text-[var(--color-text-muted)] shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
        </a>
      ))}
    </div>
  );
}
