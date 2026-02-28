# Institutional Order Flow Dashboard

Real-time options flow analytics with GEX, Max Pain, Net Premium, and AI Co-Pilot — built for Netlify deployment.

## Tech Stack

- **React** (Vite) + **Tailwind CSS** — dark fintech theme
- **Recharts** — GEX bar chart, flow area chart
- **Lucide-React** — icons
- **Netlify Functions** (Node.js) — API proxying to keep keys server-side

## Data Provider Tiers

The dashboard auto-selects the best available data source:

| Tier | Provider | Cost | Latency | Setup |
|------|----------|------|---------|-------|
| 1 | **Tradier** (production) | $10/mo brokerage | Real-time | Set `TRADIER_API_KEY` env var |
| 1b | **Tradier** (sandbox) | Free | Delayed | Sign up at sandbox.tradier.com |
| 2 | **CBOE** | Free | 15-min delayed | No key needed — always works |
| 3 | **Demo** | Free | Static mock | Fallback when no API reachable |

The frontend shows a status badge: **LIVE** (Tradier prod), **SANDBOX** (Tradier sandbox), **CBOE** (free delayed), or **DEMO** (mock data).

## KPI Metrics

- **Net Premium** — Call premium minus put premium (bullish/bearish flow signal)
- **Dark Pool %** — Statistical estimate of off-exchange volume
- **Max Pain** — Strike where ITM option value is minimized for nearest expiration
- **Put/Call Ratio** — Volume-weighted put-to-call ratio

## GEX (Gamma Exposure)

Computed per-strike as: `spot × gamma × OI × 100 × spot × 0.01`
- Calls: positive (dealer long gamma)
- Puts: negative (dealer short gamma)

Filtered to strikes within ±20% of spot price.

## AI Co-Pilot

The sidebar chat uses Anthropic Claude. Every user message is invisibly appended with the current raw JSON data from KPI cards and charts, so the LLM can answer contextually about Net Premium, Max Pain, GEX levels, and flow data.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and add your keys
cp .env.example .env
# Edit .env — add TRADIER_API_KEY and/or ANTHROPIC_API_KEY

# 3. Run locally (with Netlify CLI for functions)
npx netlify dev

# Or without functions (uses mock data):
npm run dev
```

## Deploy to Netlify

1. Push this repo to GitHub/GitLab
2. Connect to Netlify → auto-detects `netlify.toml`
3. Set environment variables in Netlify dashboard:
   - `TRADIER_API_KEY` (optional — CBOE works without it)
   - `ANTHROPIC_API_KEY` (optional — enables AI chat)
4. Deploy

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRADIER_API_KEY` | No | Tradier API token (sandbox or production) |
| `ANTHROPIC_API_KEY` | No | Anthropic Claude API key for AI Co-Pilot |

## Project Structure

```
├── netlify.toml                  # Build config + /api/* redirect
├── .env.example                  # Template for environment variables
├── netlify/functions/
│   ├── getMarketData.js          # Tiered provider: Tradier → CBOE → fallback
│   └── askLLM.js                 # Anthropic Claude proxy with financial context
├── src/
│   ├── App.jsx                   # Layout: header + main + collapsible chat
│   ├── index.css                 # Tailwind + dark theme tokens + animations
│   ├── lib/
│   │   ├── api.js                # fetchMarketData(), askLLM()
│   │   ├── format.js             # Dollar, percent, ratio formatters
│   │   └── mockData.js           # Realistic demo data generator
│   ├── hooks/
│   │   └── useMarketData.js      # Data fetching with mock fallback
│   └── components/
│       ├── Header.jsx            # Search, refresh, spot price, provider badge
│       ├── KPICards.jsx           # Net Premium, Dark Pool %, Max Pain, P/C Ratio
│       ├── GexChart.jsx          # GEX bar chart with spot price reference
│       ├── FlowChart.jsx         # 30-day flow area chart
│       └── ChatBot.jsx           # AI sidebar injecting live data into context
```
