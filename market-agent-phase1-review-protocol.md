# Market Intelligence Agent — Opus Review Protocol
## Phase 1 Code & Architecture Verification
**Reviewer: Claude Opus · Review Version: 1.0 · March 2026**

---

## How to Use This Document

This is a structured verification protocol for the Market Intelligence Agent Phase 1 codebase. Work through each section methodically. For every item:

- Mark **PASS**, **FAIL**, or **PARTIAL**
- Add a brief note on any FAIL or PARTIAL
- Flag any item that would create a **Phase 2 blocker** — issues that, if left unresolved, will require a rebuild rather than a patch when backtesting is introduced

At the end of each section, assign a **Section Verdict**: PASS / NEEDS WORK / BLOCKING

At the end of the full review, produce a **Priority Fix List** — ordered by severity, with a concrete recommendation for each item.

---

## Reviewer Kickoff Prompt

> You are conducting a formal architecture and code review of the Market Intelligence Agent Phase 1 codebase. A project brief defines the intended architecture — I will provide it as context. Your job is to work through the review protocol methodically, checking what was built against what was specified, and flagging any deviations, shortcuts, quality issues, or Phase 2 compatibility risks. Be direct and specific. Do not summarize what the code does — evaluate whether it does it correctly and completely. For each item, return PASS, FAIL, or PARTIAL with a one-to-two sentence explanation. At the end, produce a prioritized fix list ordered by severity.

Attach both this review protocol and the Phase 1 project brief (`market-agent-phase1-brief.md`) before beginning.

---

## Section 1 — Project Structure & Organization

Verify the codebase is organized coherently and matches the specified directory structure.

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 1.1 | `/src/ingest/` directory exists with all six modules | `aerodrome.js`, `alchemy.js`, `coinbase.js`, `coingecko.js`, `fred.js`, `news.js` | | |
| 1.2 | `/src/signals/` directory exists with all six modules | `trend.js`, `reversion.js`, `volatility.js`, `arbitrage.js`, `onchain.js`, `scorer.js` | | |
| 1.3 | `/src/qualitative/` directory exists with all three modules | `context.js`, `prompts.js`, `modifier.js` | | |
| 1.4 | `/src/synthesis/` directory exists with both modules | `briefing.js`, `formatter.js` | | |
| 1.5 | `/src/db/` directory exists with schema and queries | `schema.js`, `queries.js` | | |
| 1.6 | `/src/cache/` directory exists | `redis.js` | | |
| 1.7 | Root orchestrator and server files exist | `agent.js`, `server.js` | | |
| 1.8 | `.env` is present and not committed to git | `.gitignore` includes `.env` | | |
| 1.9 | `package.json` is present with all dependencies declared | No undeclared `require()` calls | | |
| 1.10 | No logic lives in root files that belongs in modules | `agent.js` orchestrates, does not implement | | |

**Section 1 Verdict:** ☐ PASS ☐ NEEDS WORK ☐ BLOCKING

---

## Section 2 — Data Ingestion Layer (Layer 1)

Verify all six data sources are ingesting correctly and normalizing to a unified schema.

### 2A — Source Coverage

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 2.1 | Aerodrome subgraph client is operational | GraphQL queries returning pool data for all three pairs | | |
| 2.2 | Alchemy RPC client is operational | On-chain data flowing for Base mainnet | | |
| 2.3 | Coinbase Advanced Trade API is operational | cbBTC spot price feed live | | |
| 2.4 | CoinGecko client is operational | Supplementary price/volume data flowing | | |
| 2.5 | FRED API client is operational | Macro indicators ingesting | | |
| 2.6 | News ingestion is operational | Articles flowing from at least one news source | | |

### 2B — Schema & Normalization

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 2.7 | A unified data schema is defined and documented | Schema definition exists, all sources map to it | | |
| 2.8 | All six sources normalize to the unified schema before caching | No raw API responses passed directly to signal layer | | |
| 2.9 | Timestamps are normalized to a single timezone/format | UTC throughout, no mixed formats | | |
| 2.10 | Numeric fields are consistently typed | No string/number ambiguity in price or volume fields | | |
| 2.11 | Missing or null data is handled gracefully | No crashes on missing fields, fallback values defined | | |
| 2.12 | Schema includes instrument identifier on all records | Every cached record is attributable to a specific pair | | |

### 2C — Redis Caching

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 2.13 | Redis TTL strategy is documented | TTLs defined per data source based on data velocity |  | |
| 2.14 | Price data TTL is appropriate | 30–60 seconds for real-time price feeds | | |
| 2.15 | News data TTL is appropriate | 5–15 minutes for news articles | | |
| 2.16 | Macro data TTL is appropriate | 1–24 hours for FRED indicators | | |
| 2.17 | On-chain data TTL is appropriate | Block-time aligned (~2 seconds on Base) or batched | | |
| 2.18 | Cache key naming is consistent and collision-safe | Namespaced keys, e.g. `price:cbbtc:usdc:latest` | | |
| 2.19 | Cache misses are handled without crashing | Fallback to direct fetch or graceful error | | |

**Section 2 Verdict:** ☐ PASS ☐ NEEDS WORK ☐ BLOCKING

---

## Section 3 — Quantitative Signal Engine (Layer 2)

Verify signal modules are producing correctly scored, serializable output for all three pairs.

### 3A — Signal Module Coverage

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 3.1 | Trend detection module produces output for all three pairs | Direction + strength score per pair | | |
| 3.2 | Mean reversion module produces output for all three pairs | Deviation score + z-score per pair | | |
| 3.3 | Volatility model produces output for all three pairs | Regime classification + ATR per pair | | |
| 3.4 | Arbitrage monitor is operational for cbBTC/USDC | CEX/DEX spread tracked, threshold alerts defined | | |
| 3.5 | On-chain behavioral module is operational | Wallet flow signals, veAERO events tracked | | |
| 3.6 | Signal scorer produces normalized confidence scores | 0.0–1.0 range, source attribution included | | |

### 3B — Signal Quality

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 3.7 | Confidence scores are deterministic | Same inputs always produce same output | | |
| 3.8 | Signal objects are fully serializable | JSON.stringify produces complete, valid output | | |
| 3.9 | Signal objects include source attribution | Every score traceable to its contributing signals | | |
| 3.10 | Data transformations are pure functions | No side effects in signal calculation functions | | |
| 3.11 | Signal modules do not make direct API calls | All data consumed from cache layer only | | |
| 3.12 | Edge cases handled: low liquidity, stale data, zero volume | No NaN, Infinity, or undefined in signal output | | |

### 3C — Phase 2 Compatibility

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 3.13 | Signal logic can run against historical data | No hard dependency on current timestamp | | |
| 3.14 | Signal functions accept data as input parameters | Not pulling from global state or live cache | | |
| 3.15 | Feature engineering output is documented | Derived features named and typed consistently | | |

**Section 3 Verdict:** ☐ PASS ☐ NEEDS WORK ☐ BLOCKING

---

## Section 4 — Qualitative Context Module (Layer 3)

Verify the LLM integration is structured, prompt-driven, and producing actionable context JSON.

### 4A — Claude API Integration

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 4.1 | Claude API calls are isolated in `context.js` | No API calls scattered across other modules | | |
| 4.2 | Correct model is specified | `claude-sonnet-4-20250514` | | |
| 4.3 | Max tokens is set | 1000 per call | | |
| 4.4 | API errors are handled gracefully | No crash on API timeout or rate limit | | |
| 4.5 | API key sourced from environment variable | `process.env.ANTHROPIC_API_KEY`, never hardcoded | | |

### 4B — Prompt Architecture

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 4.6 | System and user prompts are separated from logic | Prompts defined in `prompts.js`, not inline in `context.js` | | |
| 4.7 | Prompts are parameterized, not hardcoded | Instrument, timeframe, and context injected dynamically | | |
| 4.8 | System prompt instructs JSON-only output | No prose responses that require parsing | | |
| 4.9 | Prompts include instrument-specific context | cbBTC prompt differs from ETH prompt differs from AERO prompt | | |
| 4.10 | Prompt versioning or comments indicate iteration intent | Clear to a future reader what each prompt is optimizing for | | |

### 4C — Context Output Quality

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 4.11 | Output is valid, parseable JSON | JSON.parse succeeds on all outputs | | |
| 4.12 | Output includes regime classification | Risk-on / risk-off / transition field present | | |
| 4.13 | Output includes conviction modifier value | Numeric value in defined range | | |
| 4.14 | Output includes contradiction flag | Boolean or enum field when quant/qualitative conflict | | |
| 4.15 | Output includes reasoning summary | Human-readable field explaining the context assessment | | |
| 4.16 | Conviction modifier range is enforced | Modifier stays within ±30% bounds, no unbounded adjustments | | |

**Section 4 Verdict:** ☐ PASS ☐ NEEDS WORK ☐ BLOCKING

---

## Section 5 — Synthesis & Briefing Engine (Layer 4)

Verify the briefing engine correctly combines all layers and produces a complete, logged output.

### 5A — Briefing Completeness

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 5.1 | Briefing includes ranked trade ideas for all three pairs | Direction, entry zone, thesis, confidence score per pair | | |
| 5.2 | Briefing includes regime status | Current classification + delta from last briefing | | |
| 5.3 | Briefing includes signal conflict flags | Explicit surface of quant/qualitative disagreements | | |
| 5.4 | Briefing includes on-chain highlights | Notable wallet movements, liquidity events, protocol activity | | |
| 5.5 | Briefing includes timestamp and version | Auditable, traceable to specific data snapshot | | |

### 5B — Persistence & Logging

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 5.6 | Every briefing is persisted to Postgres | No briefings exist only in memory | | |
| 5.7 | Postgres schema is robust for backtesting | Signal scores, confidence values, and context stored as queryable fields — not blob JSON | | |
| 5.8 | Briefing log includes raw signal values | Not just final scores — intermediate values stored for Phase 2 attribution | | |
| 5.9 | Database writes are non-blocking | Failed DB write does not crash briefing generation | | |
| 5.10 | Schema migrations are versioned | Changes to schema won't silently corrupt historical data | | |

### 5C — Dashboard

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 5.11 | Dashboard route is live and accessible | `/dashboard` or equivalent returns briefing UI | | |
| 5.12 | Dashboard displays most recent briefing | Not a static page — pulls from live data | | |
| 5.13 | Dashboard shows historical briefing log | At minimum a list of past briefings accessible | | |
| 5.14 | Dashboard is readable on a single screen | No critical information buried below the fold | | |

**Section 5 Verdict:** ☐ PASS ☐ NEEDS WORK ☐ BLOCKING

---

## Section 6 — Orchestration & Run Loop

Verify the agent orchestrates all layers correctly and runs reliably over time.

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 6.1 | `agent.js` orchestrates all four layers in sequence | Ingest → Signals → Qualitative → Synthesis | | |
| 6.2 | Run loop timing is defined | Clear schedule for when briefings are generated | | |
| 6.3 | Layer failures are isolated | One layer failing does not crash the entire run | | |
| 6.4 | Errors are logged with context | Errors include layer, instrument, timestamp, and error message | | |
| 6.5 | No memory leaks in run loop | Long-running process does not degrade over time | | |
| 6.6 | Agent restarts cleanly after crash | No corrupt state left from previous run | | |
| 6.7 | Run loop can be paused/stopped cleanly | Graceful shutdown without data loss | | |

**Section 6 Verdict:** ☐ PASS ☐ NEEDS WORK ☐ BLOCKING

---

## Section 7 — Security & Environment

Verify no credentials are exposed and environment handling matches Sentinel patterns.

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 7.1 | No API keys hardcoded anywhere in codebase | Full grep for known key patterns returns nothing | | |
| 7.2 | `.env` is in `.gitignore` | Confirmed not tracked by git | | |
| 7.3 | All ten required environment variables are documented | README or `.env.example` lists all keys | | |
| 7.4 | `.env` pattern is consistent with Sentinel | Same variable naming conventions | | |
| 7.5 | No sensitive data appears in logs | API responses, wallet addresses, key fragments not logged | | |
| 7.6 | External API calls use HTTPS only | No HTTP endpoints | | |
| 7.7 | No user-facing endpoints expose raw API data | Dashboard does not leak internal signal data inappropriately | | |

**Section 7 Verdict:** ☐ PASS ☐ NEEDS WORK ☐ BLOCKING

---

## Section 8 — Sentinel Compatibility

Verify the agent is architected to support Sentinel integration in Phase 3 without a rebuild.

| # | Check | Expected | Verdict | Notes |
|---|---|---|---|---|
| 8.1 | Agent decision objects are structured and attributable | Every trade idea has a clear data lineage | | |
| 8.2 | Decision objects are auditable | Reasoning, signal inputs, and confidence scores all present | | |
| 8.3 | No shared state conflicts with Sentinel | Redis key namespacing prevents collisions | | |
| 8.4 | Infrastructure patterns are consistent with Sentinel | Same Render, Alchemy, Redis patterns used | | |
| 8.5 | A clear hook point exists for Sentinel verification | Identifiable location in code where verification call would be inserted in Phase 3 | | |

**Section 8 Verdict:** ☐ PASS ☐ NEEDS WORK ☐ BLOCKING

---

## Section 9 — Phase 2 Readiness Assessment

A dedicated forward-looking check. These items are not failures in Phase 1 but must be confirmed before Phase 2 begins.

| # | Check | Status | Notes |
|---|---|---|---|
| 9.1 | Signal objects are fully serializable to JSON | ☐ Confirmed ☐ At Risk | |
| 9.2 | Confidence scores are deterministic given same inputs | ☐ Confirmed ☐ At Risk | |
| 9.3 | All data transformations are pure functions | ☐ Confirmed ☐ At Risk | |
| 9.4 | Briefing log schema supports backtesting queries | ☐ Confirmed ☐ At Risk | |
| 9.5 | Signal functions accept data as parameters (not from live cache) | ☐ Confirmed ☐ At Risk | |
| 9.6 | Historical data loader insertion point is identified | ☐ Confirmed ☐ At Risk | |
| 9.7 | No hardcoded current-date logic in signal calculations | ☐ Confirmed ☐ At Risk | |

**Phase 2 Readiness:** ☐ READY ☐ CONDITIONALLY READY ☐ NOT READY

---

## Final Output — Priority Fix List

*To be completed by Opus after working through all sections above.*

### 🔴 Blocking Issues
*Must be resolved before Phase 1 is considered complete. Would require a rebuild if carried into Phase 2.*

| # | Issue | Location | Recommended Fix |
|---|---|---|---|
| | | | |

### 🟡 Significant Issues
*Should be resolved before Phase 2 begins. Will create friction or inaccuracy if left.*

| # | Issue | Location | Recommended Fix |
|---|---|---|---|
| | | | |

### 🟢 Minor Issues
*Recommended improvements. Will not block Phase 2 but represent technical debt.*

| # | Issue | Location | Recommended Fix |
|---|---|---|---|
| | | | |

---

## Overall Verdict

| Section | Verdict |
|---|---|
| 1 — Project Structure | |
| 2 — Data Ingestion | |
| 3 — Quant Signal Engine | |
| 4 — Qualitative Module | |
| 5 — Briefing Engine | |
| 6 — Orchestration | |
| 7 — Security | |
| 8 — Sentinel Compatibility | |
| 9 — Phase 2 Readiness | |
| **Overall** | |

---

*Market Intelligence Agent · Phase 1 Review Protocol · Confidential*
