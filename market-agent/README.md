# Market Intelligence Agent — Phase 1

Quantitative + qualitative market intelligence pipeline for Base L2 DeFi trading pairs. Runs as a standalone service alongside Sentinel, sharing Redis and Alchemy infrastructure.

## Architecture

Four-layer pipeline executing on a 60-second cycle:

1. **Ingest** — Pulls data from Coinbase, CoinGecko, Aerodrome (The Graph), Alchemy (on-chain), FRED (macro), NewsAPI/Benzinga (news). Cached in Upstash Redis with TTL-based velocity tuning.
2. **Signals** — Deterministic quant signals: trend-following, mean-reversion, volatility, CEX/DEX arbitrage, on-chain behavioral (including veAERO lock/unlock events).
3. **Qualitative** — Claude API (claude-sonnet-4-20250514) synthesizes news, classifies macro regime, detects quant/qual contradictions, produces conviction adjustments.
4. **Synthesis** — Composite scoring, entry zone computation, regime delta tracking. Persists briefings to Postgres. Serves formatted output via dashboard.

## Pairs

| Pair | Edge |
|------|------|
| cbBTC/USDC | CEX/DEX arbitrage + momentum |
| ETH/USDC | Macro regime sensitivity |
| AERO/USDC | Protocol-native behavioral (veAERO governance) |

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template and fill in keys
cp .env.example ../.env

# Run (reads .env from parent directory)
node src/server.js
```

Dashboard available at `http://localhost:4030/dashboard/index.html`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + cache/cycle status |
| GET | `/status` | Full status: last cycle, signals, config |
| GET | `/signals` | Latest signal results |
| GET | `/briefing` | Latest briefing (current cycle) |
| GET | `/briefings?limit=10` | Historical briefings from Postgres |
| POST | `/ingest` | Manually trigger a full cycle |
| GET | `/dashboard/index.html` | Browser dashboard SPA |

## Environment Variables

See `.env.example` for the full list. At minimum you need `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `ALCHEMY_API_KEY`. Data source keys are optional — the pipeline degrades gracefully when sources are unavailable.

## Database

Postgres schema is managed via versioned migrations (see `src/db/migrate.js`). Migrations run automatically on server start. Tables: `briefings`, `signals`, `composites`, `onchain_events`, `schema_migrations`.

## Sentinel Compatibility

The market agent shares infrastructure with Sentinel but uses a separate Redis namespace (`ma:` prefix vs Sentinel's `sentinel:` prefix) and separate Postgres tables. Both services can run concurrently on the same Render instance or separately.

## Phase 2 Readiness

All signal functions accept optional input parameters for deterministic backtesting. Timestamps are injectable. Prompt versions are tracked for A/B testing. The `agent.js` orchestrator includes a marked hook point between composite scoring and briefing for Phase 3 execution integration.
