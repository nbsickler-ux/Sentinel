# Market Intelligence Agent
## Phase 1: Data Pipeline & Intelligence Layer
**Claude Code Build Specification · v1.0 · March 2026**

---

## 1. Mission & Scope

Build a market intelligence agent that monitors, analyzes, and synthesizes quantitative and qualitative signals across three Base-native token pairs. Phase 1 produces no trade execution — the sole output is a structured daily briefing for human review and calibration.

The agent is the first component of a multi-phase autonomous trading system. Every architectural decision in Phase 1 must support backward compatibility with Phase 2 (backtesting) and Phase 3 (paper trading) without requiring a full rebuild.

| Field | Value |
|---|---|
| Phase | Phase 1 — Intelligence Layer |
| Execution authority | None. Briefing output only. |
| Target timeline | 2–4 weeks from kickoff |
| Primary output | Daily structured briefing (dashboard + log) |
| Human role | Review briefings, log agreement/disagreement with agent reasoning |

---

## 2. Instrument Universe

Tier 1 assets on Base only. All pairs trade on Aerodrome Finance — Base's primary DEX and liquidity hub. No long-tail tokens, no assets below $50M market cap, no Tier 2 assets in Phase 1.

| Pair | Edge Type | Primary Signal Source |
|---|---|---|
| cbBTC / USDC | CEX/DEX Arbitrage + Momentum | Coinbase spot price vs Aerodrome pool price divergence |
| ETH / USDC | Macro & Regime Signals | News flow, Fed language, risk-on/off classification |
| AERO / ETH | Protocol-Native Behavioral | veAERO lock/unlock events, governance cycles, emission schedules |

**Rationale:** Three pairs, three distinct edge types. The agent learns a different lesson from each pair, making combined intelligence significantly stronger than any single-pair architecture.

---

## 3. System Architecture

Four layers in sequence. Each layer is independently testable. No layer has execution authority in Phase 1.

---

### Layer 1 — Data Ingestion

**Responsibility:** Pull raw data from all sources, normalize into a unified schema, cache in Redis.

- **Aerodrome subgraph via The Graph** — real-time pool data, liquidity depth, swap volume, fee revenue
- **Alchemy RPC (Base mainnet)** — on-chain wallet flows, transaction monitoring, contract events, token transfers
- **Coinbase Advanced Trade API** — cbBTC spot price feed for arbitrage layer, real-time order book
- **CoinGecko / CryptoCompare** — supplementary price/volume, market cap, circulating supply
- **FRED API** — macro indicators: Fed funds rate, CPI, employment data, yield curve
- **NewsAPI + Benzinga** — crypto and macro news ingestion for qualitative layer

All raw data normalized into a unified schema before reaching signal engines. Redis (Upstash) used for caching with TTLs appropriate to data velocity.

---

### Layer 2 — Quantitative Signal Engine

**Responsibility:** Generate scored signals from structured price/volume/on-chain data. Output is a confidence-scored signal object per pair per cycle.

- **Trend Detection** — Multi-timeframe momentum, EMA crossovers, regime identification (trending/ranging/transitioning)
- **Mean Reversion** — Statistical deviation signals, z-score based, Bollinger Band variants
- **Volatility Model** — Realized vs implied vol, regime classification, ATR-based position sizing prep
- **Arbitrage Monitor** — cbBTC CEX/DEX price spread, threshold alerts, spread history tracking
- **On-Chain Behavioral** — Wallet accumulation/distribution, large transfer detection, DEX liquidity depth changes, veAERO lock events
- **Feature Engineering** — Derived indicators normalized for ML layer compatibility in Phase 2
- **Signal Confidence Scoring** — Per-signal strength score, 0.0–1.0 normalized, with source attribution

---

### Layer 3 — Qualitative Context Module

**Responsibility:** Process unstructured data through the Claude API. Output is structured context JSON that adjusts quantitative signal conviction by up to ±30%.

- **News Synthesis** — Real-time article ingestion, entity extraction, relevance scoring per instrument
- **Macro Language Parsing** — FOMC minutes, CPI releases, Fed speaker transcripts — tone and policy signal extraction
- **Regime Classification** — Risk-on / risk-off / transition — updated with each news cycle
- **Contradiction Detection** — Flags when quant signal direction conflicts with qualitative context
- **Conviction Modifier** — Structured JSON output adjusting quant signal weights based on context strength

Claude API model: `claude-sonnet-4-20250514`. System prompt engineering is a first-class concern — the quality of qualitative output depends entirely on prompt quality. Iteration expected.

---

### Layer 4 — Synthesis & Briefing Engine

**Responsibility:** Combine quant signals and qualitative context into a structured daily briefing. Persist to database. Surface via dashboard.

- **Trade Ideas** — Ranked setups per instrument: direction, entry zone, thesis, composite confidence score
- **Regime Status** — Current market classification and what changed since last briefing
- **Signal Conflicts** — Explicit flags where quant and qualitative disagree, with reasoning
- **On-Chain Highlights** — Notable wallet movements, liquidity changes, protocol events
- **Briefing Log** — Full history persisted to Postgres — essential for Phase 2 backtesting validation

---

## 4. Technology Stack

Stack is intentionally aligned with existing Sentinel infrastructure to minimize new surface area and enable shared deployment.

| Component | Technology | Notes |
|---|---|---|
| Runtime | Node.js / Express | Matches Sentinel stack exactly |
| Deployment | Render | Same platform as Sentinel — shared infrastructure |
| Cache / State | Upstash Redis | Already integrated in Sentinel — reuse existing instance |
| Database | Postgres (Render managed) | Signal history, briefing log, on-chain event store |
| LLM Layer | Anthropic Claude API | claude-sonnet-4-20250514, 1000 max_tokens per call |
| Base RPC | Alchemy (Base mainnet) | Existing Sentinel integration — same API key |
| On-chain Data | Etherscan API (Base) | Existing Sentinel integration — reuse |
| DEX Data | Aerodrome subgraph (The Graph) | GraphQL endpoint, real-time pool state |
| Price / Market | Coinbase Advanced Trade API | Requires new API key — cbBTC arbitrage layer |
| Supplementary | CoinGecko API | Free tier sufficient for Phase 1 volume |
| Macro Data | FRED API | Free, no rate limit concerns at Phase 1 volume |
| News | NewsAPI + Benzinga | NewsAPI free tier + Benzinga for crypto-specific coverage |
| Protocol TVL | DeFiLlama API | Existing Sentinel integration — reuse |

---

## 5. API Keys & Environment

Keys marked **EXISTING** are already live in Sentinel. Keys marked **NEW** must be provisioned before build begins.

| Key | Status | Source |
|---|---|---|
| ALCHEMY_API_KEY (Base mainnet) | EXISTING | Reuse from Sentinel .env |
| ETHERSCAN_API_KEY | EXISTING | Reuse from Sentinel .env |
| UPSTASH_REDIS_URL + TOKEN | EXISTING | Reuse from Sentinel .env |
| ANTHROPIC_API_KEY | EXISTING | Reuse from Sentinel .env |
| DEFILLAMA_API_KEY | EXISTING (free) | Reuse from Sentinel .env |
| COINBASE_ADV_API_KEY + SECRET | **NEW — provision first** | Coinbase Advanced Trade dashboard |
| COINGECKO_API_KEY | **NEW — free tier** | CoinGecko developer portal |
| FRED_API_KEY | **NEW — free** | fred.stlouisfed.org/docs/api |
| NEWS_API_KEY | **NEW — free tier** | newsapi.org |
| THE_GRAPH_API_KEY | **NEW — free tier** | thegraph.com/studio |

All keys stored in `.env` file. Never committed to version control. Provision the five NEW keys before starting the build session.

---

## 6. Recommended Project Structure

```
/market-agent
  /src
    /ingest          ← Layer 1: data pipeline modules
      aerodrome.js   ← Aerodrome subgraph client
      alchemy.js     ← On-chain data via Alchemy
      coinbase.js    ← cbBTC spot price feed
      coingecko.js   ← Supplementary price data
      fred.js        ← Macro indicators
      news.js        ← News ingestion
    /signals         ← Layer 2: quant signal engines
      trend.js       ← Trend detection
      reversion.js   ← Mean reversion
      volatility.js  ← Volatility model
      arbitrage.js   ← cbBTC CEX/DEX spread monitor
      onchain.js     ← Wallet flows, on-chain behavioral
      scorer.js      ← Signal confidence scoring
    /qualitative     ← Layer 3: LLM reasoning
      context.js     ← Claude API integration
      prompts.js     ← System/user prompt templates
      modifier.js    ← Conviction adjustment logic
    /synthesis       ← Layer 4: briefing engine
      briefing.js    ← Combines all layers into briefing
      formatter.js   ← Structured output formatting
    /db              ← Database layer
      schema.js      ← Postgres schema definitions
      queries.js     ← Reusable query functions
    /cache           ← Redis caching layer
      redis.js       ← Upstash client + TTL helpers
    agent.js         ← Main orchestrator / run loop
    server.js        ← Express server + dashboard route
  /dashboard         ← Briefing UI (HTML/JS)
  .env               ← API keys (never committed)
  package.json
  README.md
```

---

## 7. Phase 1 Build Milestones

| Milestone | Deliverable | Target |
|---|---|---|
| 01 — Data Pipeline Live | All six data sources ingesting, normalized schema, Redis caching operational | Week 1 |
| 02 — Quant Signal Engine | Trend, reversion, volatility, arbitrage, and on-chain modules producing scored signals for all three pairs | Week 1–2 |
| 03 — Qualitative Module | Claude API integrated, news and macro parsed into structured context JSON, conviction modifier operational | Week 2–3 |
| 04 — Briefing Engine | Synthesis layer combining all signals into structured daily briefing. Dashboard live. Postgres logging active. | Week 3–4 |
| 05 — Calibration Review | Manual review of first 7 days of briefings. Agent reasoning quality assessed. Go/no-go for Phase 2. | Week 4 |

---

## 8. Sentinel Integration Path

The trading agent and Sentinel are designed to grow together. Architectural touchpoints to keep in mind during Phase 1 — not to implement now, but to avoid decisions that complicate later integration.

- **Agent behavioral trust verification** — In Phase 3+, every agent decision will be submitted to Sentinel for verification before execution. Build agent decision objects with this in mind — structured, attributable, auditable.
- **Shared infrastructure** — Same Render deployment, same Alchemy key, same Redis instance. Avoid patterns that create resource contention as both services scale.
- **Dogfooding value** — A live autonomous agent verified by Sentinel is the most compelling product demonstration possible. The trading agent is Sentinel's first real customer.
- **Progressive trust model** — Phase 1 (human reviews all) → Phase 3 (Sentinel verifies, human approves) → Phase 5 (Sentinel verifies, agent executes within parameters). Sentinel's trust scoring maps directly onto this graduation framework.

---

## 9. Claude Code Kickoff Prompt

Paste the following verbatim as your opening prompt in the Claude Code session, with this document attached as context:

> I'm building a market intelligence agent. I have a project brief that defines the full architecture, tech stack, instrument universe, and milestone structure. Please read it carefully before writing any code. We're starting with Milestone 01: getting all six data pipeline modules ingesting live data, normalizing to a unified schema, and caching in Redis. My existing Sentinel project is in this directory — please review the existing .env and infrastructure patterns before building so the new agent is architecturally consistent. Start by proposing the unified data schema and the Redis TTL strategy, then we'll proceed to implementation.

After pasting the kickoff prompt, Claude Code will read this brief and your existing Sentinel codebase before proposing anything. Let it lead — the first output should be a schema proposal and Redis TTL strategy, not raw code.

---

## 10. Phase 2 Preview (Backtesting)

*Not in scope for current build session — documented here for architectural awareness only.*

Phase 2 adds a backtesting engine that replays Phase 1 signal logic against historical data. The Phase 1 briefing log (Postgres) becomes the ground truth for validating signal quality. Key additions:

- **Historical data loader** — fetches OHLCV and on-chain data for backtesting periods
- **Signal replay engine** — runs Phase 1 signal logic against historical data deterministically
- **Performance attribution** — measures which signals contributed to profitable vs unprofitable setups
- **Strategy graduation framework** — defines minimum performance thresholds for advancing to Phase 3

Phase 1 architecture decisions that directly affect Phase 2: signal objects must be serializable, confidence scores must be deterministic given the same inputs, and all data transformations must be pure functions without side effects.

---

*Market Intelligence Agent · Phase 1 Build Brief · Confidential*
