// src/components/dashboard/ChartsPanel.tsx
// The Charts section's content: gamma exposure by strike beside the net premium flow. App loads this module, and
// recharts with it, only while the section is expanded, with ChartsSkeleton in its place until it is in; the charts
// take their slices of the data as props, as they did when App drew them itself.

import GexChart from '../GexChart.jsx';
import FlowChart from '../FlowChart.jsx';
import type { MarketData, Technicals } from '../../../types/market.js';
import type { Position } from '../../lib/store.js';

interface ChartsPanelProps {
  /** data?.gexByStrike: the strikes' gamma exposure; undefined before anything has loaded. */
  gexByStrike: MarketData['gexByStrike'] | undefined;
  /** data?.flowHistory: the daily premium flow, which a payload may leave out. */
  flowHistory: MarketData['flowHistory'];
  /** useMarketData's loading: both charts draw their skeleton card while a foreground load is under way. */
  loading: boolean;
  /** data?.spotPrice: the GEX chart's spot line. */
  spotPrice: number | undefined;
  /** The position's cost basis (the draft, as the inputs show it): the GEX chart's basis line. */
  costBasis: Position['costBasis'];
  /** tickerContext?.technicals: the GEX chart's moving-average lines, when research is on and has them. */
  technicals: Technicals | null | undefined;
}

export default function ChartsPanel({ gexByStrike, flowHistory, loading, spotPrice, costBasis, technicals }: ChartsPanelProps) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <GexChart data={gexByStrike} loading={loading} spotPrice={spotPrice} costBasis={costBasis} technicals={technicals} />
      <FlowChart data={flowHistory} loading={loading} />
    </div>
  );
}
