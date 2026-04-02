# Parallel Build Track: Three Tasks During Paper Trading

## Context

Market Agent is running in paper trading mode (Phase 3). While we accumulate market exposure data, there are three independent optimization tasks to complete. These do NOT affect the paper trading logic — they improve cost efficiency and add a revenue stream.

**Priority order:** Task 1 (revenue) → Task 2 (cost savings) → Task 3 (efficiency + reliability)

---

## Task 1: Briefing-as-a-Service (x402 Revenue Stream)

### What exists today

Market Agent already has two public-facing briefing endpoints in `src/server.js`:

- `GET /briefing` (line 142) — returns the latest in-memory briefing
- `GET /briefings?limit=N` (line 147) — returns N recent briefings from Postgres

These return rich JSON: trade ideas with confidence scores, regime analysis, signal conflicts, on-chain highlights, key themes, and data source summaries. This is valuable market intelligence that other agents or users would pay for.

### What to build

Wrap these endpoints with x402 micropayment, following the same pattern Sentinel uses. Market Agent already shares the `.env` with Sentinel and has access to all the same payment infrastructure credentials.

**Create `src/payment.js`:**
```javascript
// Set up x402 payment middleware for Market Agent's paid endpoints
//
// Dependencies to install: @x402/express @x402/core @x402/evm @coinbase/x402
// (Same packages Sentinel uses — check Sentinel's package.json for exact versions)
//
// Configuration:
// - WALLET_ADDRESS from .env (same wallet as Sentinel)
// - NETWORK from .env (base-sepolia for testing, base for production)
// - Facilitator: CDP if keys available, else x402.org fallback
//
// Payment routes:
//   GET /briefing     → $0.01 (latest briefing only)
//   GET /briefings    → $0.03 (historical briefings, more data)
//   GET /api/signals  → $0.02 (raw signal data, if this endpoint exists)
//
// Export: { paymentMiddleware, PAID_PATHS }
```

**Wire into `src/server.js`:**
```javascript
// Import payment middleware
import { paymentMiddleware, PAID_PATHS } from "./payment.js";

// Add LOCAL_BYPASS_SECRET support (same pattern as Sentinel)
// so the dashboard and internal calls skip payment:
const LOCAL_BYPASS_SECRET = process.env.LOCAL_BYPASS_SECRET || "";
if (LOCAL_BYPASS_SECRET) {
  app.use(PAID_PATHS, (req, res, next) => {
    if (req.headers["x-bypass-secret"] === LOCAL_BYPASS_SECRET) {
      return next("route");
    }
    next();
  });
}
app.use(paymentMiddleware);
```

**IMPORTANT:** The bypass middleware pattern here should match what we already added to Sentinel's server.js. Use the same wrapped-middleware approach:

```javascript
// Correct pattern (wraps the payment middleware):
const x402Mw = paymentMiddleware; // from payment.js
app.use((req, res, next) => {
  if (LOCAL_BYPASS_SECRET && req.headers["x-bypass-secret"] === LOCAL_BYPASS_SECRET
      && PAID_PATHS.some(p => req.path === p)) {
    return next(); // Skip payment
  }
  x402Mw(req, res, next);
});
```

**Add a health/discovery endpoint:**
```javascript
// GET /health — free, no payment required
// Return: { service: "market-agent", version: "1.0.0", endpoints: {...pricing...} }
// This lets x402scan and other agents discover the paid endpoints
```

**Add to package.json scripts:**
```json
"register": "node -e \"console.log('Register at x402scan.com with endpoint URL')\""
```

### Testing

1. Start Market Agent with the x402 packages installed
2. `curl http://localhost:4030/briefing` without payment → should get 402 Payment Required
3. `curl -H 'x-bypass-secret: <secret>' http://localhost:4030/briefing` → should get briefing JSON
4. Dashboard should still work (it fetches via the bypass or doesn't hit paid paths)

### Dashboard compatibility

The dashboard fetches `/briefing` and other data via the browser. Two options:
- **Option A (recommended):** Dashboard endpoints use different paths (`/dashboard/data`, `/dashboard/briefing`) that are NOT in PAID_PATHS. Move the dashboard-specific data fetching to dashboard-prefixed routes.
- **Option B:** Dashboard JS includes the bypass secret in fetch headers. Less clean but simpler.

Choose Option A — create dashboard-specific data routes that mirror the public endpoints but are free.

---

## Task 2: Haiku/Sonnet Hybrid Routing (55-70% Cost Reduction)

### What exists today

All three Claude API calls in `src/qualitative/context.js` use Sonnet (`claude-sonnet-4-20250514`):
1. **News synthesis** — summarize articles into sentiment/regime signals
2. **Macro analysis** — interpret FRED indicators
3. **Contradiction detection** — find conflicts between quant signals and qualitative context

Model pricing (already tracked in `context.js` lines 16-27):
- Sonnet: $3.00/M input, $15.00/M output
- Haiku: $0.80/M input, $4.00/M output

### What to build

**Modify `src/qualitative/context.js`:**

Route each prompt to the cheapest model that can handle it well:

| Prompt | Current | Target | Rationale |
|--------|---------|--------|-----------|
| News synthesis | Sonnet | **Haiku** | Structured extraction from articles. Haiku handles this well — it's pattern matching, not reasoning. |
| Macro analysis | Sonnet | **Haiku** | FRED indicators → regime classification. Rule-based enough for Haiku. |
| Contradiction detection | Sonnet | **Sonnet** | Keep on Sonnet. This requires reasoning about conflicting signals and making judgment calls. |

**Implementation:**

```javascript
// In context.js, add a model selector:
const PROMPT_MODELS = {
  news_synthesis:         "claude-haiku-4-5-20251001",
  macro_analysis:         "claude-haiku-4-5-20251001",
  contradiction_detection: "claude-sonnet-4-20250514",
};

// Modify the callClaude() function to accept a promptType parameter
// and use PROMPT_MODELS[promptType] instead of the hardcoded model
```

**Add config override in `src/config.js`:**
```javascript
qualitative: {
  models: {
    news_synthesis: process.env.QUAL_NEWS_MODEL || "claude-haiku-4-5-20251001",
    macro_analysis: process.env.QUAL_MACRO_MODEL || "claude-haiku-4-5-20251001",
    contradiction: process.env.QUAL_CONTRADICTION_MODEL || "claude-sonnet-4-20250514",
  },
},
```

This lets us override per-prompt models via env vars for A/B testing without code changes.

**Cost tracking already works** — the `saveApiCost` call in context.js already logs the model used. After this change, you'll see mixed Haiku/Sonnet entries in the api_costs table, and the cost summary will show the savings.

### Expected savings

Current: ~3 Sonnet calls/cycle × $0.01-0.03/call ≈ $0.03-0.09/cycle
After: 2 Haiku + 1 Sonnet ≈ $0.01-0.04/cycle
Savings: **55-70%** on Claude API costs

### Validation

After implementing, run 5-10 cycles and compare:
1. Haiku news synthesis quality vs Sonnet (spot check a few)
2. Haiku macro analysis quality vs Sonnet
3. Cost per cycle in api_costs table (should drop ~60%)
4. Contradiction detection quality should be unchanged (still Sonnet)

If Haiku quality is noticeably worse on either prompt, switch that one back to Sonnet via the env var override.

---

## Task 3: Cycle Frequency Optimization + Render Keepalive

### What exists today

`src/server.js` line 46: `const CYCLE_INTERVAL = 60_000` — runs a full cycle every 60 seconds.

Each cycle runs ALL four layers regardless of whether inputs have changed:
1. **Ingest** — fetches from 7 data sources (Coinbase, CoinGecko, Aerodrome, Alchemy, FRED, news, Benzinga)
2. **Signals** — recomputes all signal detectors
3. **Qualitative** — 3 Claude API calls ($$$)
4. **Synthesis** — generates briefing

Problem: Most of these inputs don't change every 60 seconds. FRED updates daily. News updates every few hours. Aerodrome pool data updates daily. Running Claude analysis on identical inputs wastes money.

### What to build

**Create `src/cache/staleness.js`:**

A module that tracks when each data source last changed and whether a new Claude call is needed.

```javascript
// src/cache/staleness.js
//
// Track data freshness per source. On each cycle, compare current
// ingestion results against the cache to determine what changed.
//
// Export:
//   hasSourceChanged(sourceName, newDataHash) → boolean
//   shouldRunQualitative(ingestResult) → boolean
//   updateCache(ingestResult) → void
//
// Strategy:
// - Hash each source's data points (simple JSON hash)
// - If hash matches previous cycle, source hasn't changed
// - Qualitative layer only runs if ANY of: news, fred, or coinbase changed
// - Signals layer always runs (prices change every cycle)
// - Ingest layer always runs (need fresh prices for signal computation)
//
// Implementation:
// - In-memory cache (Map of sourceName → { hash, timestamp })
// - Use crypto.createHash('md5') for fast hashing
// - Log skipped layers: "Skipping qualitative: no input changes since cycle N"
```

**Modify `src/agent.js`:**

```javascript
import { shouldRunQualitative, updateCache } from "./cache/staleness.js";

// After Layer 1 (Ingest):
updateCache(ingestResult);

// Before Layer 3 (Qualitative):
if (!shouldRunQualitative(ingestResult)) {
  logger.info({ cycle: cycleId }, "Skipping qualitative — inputs unchanged");
  // Reuse previous cycle's qualContext and qualSummary
  qualContext = previousQualContext; // need to cache this
  qualSummary = previousQualSummary;
} else {
  // Run qualitative as normal
  qualContext = await qualAnalyze(newsPoints, signalResult.signals, cycleId);
  qualSummary = buildQualSummary(qualContext);
  // Cache for reuse
  previousQualContext = qualContext;
  previousQualSummary = qualSummary;
}
```

**Add Sentinel health ping for Render keepalive:**

```javascript
// In agent.js, after the Phase 3 block (regardless of signal confidence):
// This keeps Render's Postgres and Sentinel warm even on quiet cycles.
try {
  const sentinelHealth = await fetch(`${config.sentinel.url}/health`, {
    timeout: 5000,
  }).then(r => r.json());
  logger.debug({ cycle: cycleId, sentinel: sentinelHealth.status }, "Sentinel health ping");
} catch (e) {
  logger.warn({ cycle: cycleId }, "Sentinel health ping failed — Render may be spinning down");
}
```

This is a lightweight GET to `/health` (free, no payment) on every cycle. At 60-second intervals, Render will never spin down.

**Add adaptive cycle timing (optional enhancement):**

```javascript
// In server.js, make the cycle interval adaptive:
// - During market hours with changing data: 60s (current)
// - When no data has changed for 5+ cycles: extend to 300s (5 min)
// - When a signal is close to threshold (confidence > 0.4): stay at 60s
// This further reduces unnecessary API calls during quiet periods.
//
// Config:
// CYCLE_INTERVAL_ACTIVE=60000
// CYCLE_INTERVAL_IDLE=300000
// IDLE_THRESHOLD_CYCLES=5
```

### Expected savings

- Qualitative skip rate: ~50-70% of cycles (news/macro don't change every minute)
- Claude API calls saved: ~1.5-2 calls/cycle on skipped cycles
- Combined with Task 2 (Haiku routing): total cost reduction from ~$0.09/cycle to ~$0.01-0.02/cycle
- Render keepalive: guaranteed uptime, no more cold starts

### Validation

1. Run 20+ cycles and check logs for "Skipping qualitative" messages
2. Verify signal quality is unchanged on cycles that DO run qualitative
3. Check api_costs table: cost per cycle should drop on skipped cycles
4. Verify Sentinel health pings appear in Sentinel's request log
5. Leave system running overnight — Render should not spin down

---

## File Summary

### Task 1 (Briefing-as-a-Service):
- **New:** `src/payment.js` — x402 payment middleware setup
- **Modify:** `src/server.js` — wire payment middleware, add dashboard-specific routes
- **Modify:** `package.json` — add x402 dependencies
- **Install:** `@x402/express`, `@x402/core`, `@x402/evm`, `@coinbase/x402`

### Task 2 (Haiku/Sonnet Hybrid):
- **Modify:** `src/qualitative/context.js` — per-prompt model routing
- **Modify:** `src/config.js` — add qualitative.models config block

### Task 3 (Cycle Optimization):
- **New:** `src/cache/staleness.js` — data freshness tracking
- **Modify:** `src/agent.js` — conditional qualitative execution + Sentinel health ping
- **Modify:** `src/server.js` — adaptive cycle timing (optional)
- **Modify:** `src/config.js` — add cycle timing config

### Do NOT modify:
- `src/signals/` — Signal computation modules are frozen
- `src/backtest/` — Backtest infrastructure is complete
- `src/paper/` — Paper trading engine is in use
- `src/sentinel/` — Sentinel client is working correctly
- `../server.js` (Sentinel) — Don't touch Sentinel

---

## Execution Order

These three tasks are independent and can be built in any order. Recommended:
1. **Task 2 first** (Haiku/Sonnet) — smallest change, immediate cost savings, easy to validate
2. **Task 3 second** (cycle optimization) — medium complexity, compounds with Task 2 savings
3. **Task 1 last** (Briefing-as-a-Service) — most complex (new dependencies), but highest upside (revenue)

## Decision Tree

**If x402 packages fail to install (Task 1):**
→ Check Sentinel's `package.json` for exact versions and copy them
→ The packages may need Node 18+ — verify with `node --version`

**If Haiku quality is bad on news synthesis (Task 2):**
→ Switch news back to Sonnet: `QUAL_NEWS_MODEL=claude-sonnet-4-20250514` in .env
→ Keep macro on Haiku (it's more structured/deterministic)

**If staleness cache causes stale signals (Task 3):**
→ The signals layer always runs fresh (only qualitative is cached)
→ If regime changes are missed, reduce the skip threshold or add a time-based force-refresh (e.g., always run qualitative every 10 minutes regardless)

**If dashboard breaks after adding payment middleware (Task 1):**
→ Ensure dashboard fetch calls go to `/dashboard/*` routes, not `/briefing`
→ Or add the bypass secret to dashboard fetch headers as a quick fix
