// src/App.jsx
import { useState, useCallback } from 'react';
import { Sparkles } from 'lucide-react';
import Header from './components/Header';
import KPICards from './components/KPICards';
import GexChart from './components/GexChart';
import FlowChart from './components/FlowChart';
import ChatBot from './components/ChatBot';
import { useMarketData } from './hooks/useMarketData';

export default function App() {
  const [ticker, setTicker] = useState('AVGO');
  const [chatOpen, setChatOpen] = useState(false);
  const { data, loading, error, usingMock, refresh } = useMarketData(ticker);

  const handleTickerChange = useCallback((newTicker) => {
    setTicker(newTicker);
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <Header
        ticker={ticker}
        onTickerChange={handleTickerChange}
        onRefresh={refresh}
        loading={loading}
        usingMock={usingMock}
        data={data}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content */}
        <main
          className="flex-1 overflow-y-auto p-4 md:p-5 space-y-4"
          style={{ overscrollBehavior: 'contain' }}
        >
          {/* Ticker badge */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-lg font-bold font-mono tracking-tight text-[var(--color-text-primary)]">
                {ticker}
              </span>
              {data?.iv30 != null && !loading && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-purple-bg)] text-[var(--color-purple)] border border-[var(--color-purple)]/20 tabular-nums">
                  IV30: {data.iv30.toFixed(1)}%
                </span>
              )}
              {usingMock && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-warn-bg)] text-[var(--color-warn)] border border-[var(--color-warn)]/20">
                  DEMO DATA
                </span>
              )}
              {error && !usingMock && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-bear-bg)] text-[var(--color-bear)] border border-[var(--color-bear)]/20">
                  ERROR
                </span>
              )}
            </div>
            {data?.totalOptionsCount && !loading && (
              <span className="text-xs text-[var(--color-text-muted)] tabular-nums hidden sm:inline">
                {data.totalOptionsCount.toLocaleString()} contracts analyzed
              </span>
            )}
          </div>

          {/* KPI Cards */}
          <KPICards kpis={data?.kpis} loading={loading} />

          {/* Charts */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <GexChart data={data?.gexByStrike} loading={loading} spotPrice={data?.spotPrice} />
            <FlowChart data={data?.flowHistory} loading={loading} />
          </div>

          {/* Info footer */}
          <div className="text-xs text-[var(--color-text-muted)] pt-2 pb-4">
            {usingMock ? (
              <span>
                Currently showing simulated demo data. Deploy to Netlify and the CBOE data feed activates automatically — no API key needed.
              </span>
            ) : data?.provider === 'tradier' ? (
              <span>
                Real-time data via Tradier brokerage API. GEX, Max Pain, and P/C Ratio computed from live options chain.
                Net Premium estimated from daily volume × mid price.
              </span>
            ) : data?.provider === 'tradier-sandbox' ? (
              <span>
                Data from Tradier sandbox (delayed). Upgrade to a Tradier brokerage account ($10/mo) for real-time feeds.
                GEX, Max Pain, P/C Ratio, and Net Premium computed from options chain.
              </span>
            ) : (
              <span>
                Data from CBOE delayed quotes (free, 15-min delay). Add a TRADIER_API_KEY for real-time data ($10/mo).
                GEX, Max Pain, and P/C Ratio computed from live options chain. Dark Pool % is a statistical estimate.
              </span>
            )}
          </div>
        </main>

        {/* Chat Sidebar */}
        <aside
          className={`transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
            chatOpen ? 'w-80 md:w-96' : 'w-0'
          } overflow-hidden shrink-0`}
        >
          <ChatBot data={data} isOpen={chatOpen} onClose={() => setChatOpen(false)} />
        </aside>
      </div>

      {/* Chat Toggle FAB */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fixed bottom-5 right-5 flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-accent)] text-white text-sm font-medium shadow-lg hover:bg-[var(--color-accent-hover)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] z-50"
          aria-label="Open AI Co-Pilot"
        >
          <Sparkles size={16} />
          <span className="hidden sm:inline">AI Co-Pilot</span>
        </button>
      )}
    </div>
  );
}
