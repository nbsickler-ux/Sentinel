# Phase 3 Build Sprint: Sentinel Integration + Paper Trading Engine

## Context

You are working on the Market Agent, a crypto trading system in `/market-agent/`.
Market Agent generates trade signals for cbBTC/USDC on Aerodrome (Base L2).
Sentinel is the parent project (one directory up) — a risk verification API.

**Phase 2 is complete.** cbBTC/USDC passes all 6 graduation criteria:
- Composite directional signal: Sharpe 4.46, hit rate 53.3%, profit factor 3.96, max DD 0.05%
- Winning params: 48h time limit, 3% TP, 5% SL, 0.5 confidence threshold, 0.5% position size
- Signal: weighted composite of trend (0.30) + reversion-as-filter (0.20) + others

**Your job:** Build the Phase 3 infrastructure so paper trading can begin.

---

## Task 1: Sentinel Integration Module

**Create `src/sentinel/client.js`**

Build a client module that calls Sentinel's verify endpoints. Sentinel runs at `http://localhost:4021` (configurable via `SENTINEL_URL` env var).

### Sentinel API Details

Sentinel has these verify endpoints (all POST):
- `/verify/token` — Token safety & honeypot detection. Price: $0.005
- `/verify/protocol` — Contract trust assessment. Price: $0.008
- `/verify/counterparty` — OFAC sanctions & address reputation. Price: $0.01
- `/preflight` — Unified pre-transaction check. Price: $0.025

**Response format (all endpoints):**
```json
{
  "verdict": "SAFE" | "LOW_RISK" | "CAUTION" | "HIGH_RISK" | "DANGER",
  "trust_grade": "A" | "B" | "C" | "D" | "F",
  "trust_score": 0-100,
  "confidence": 0-1,
  "risk_flags": ["flag1", "flag2"],
  "evidence": { ... },
  "meta": {
    "response_time_ms": number,
    "sentinel_version": "0.4.0"
  }
}
```

**Verdict-to-score mapping:**
- Score >= 85 → SAFE (Grade A)
- Score 70-84 → LOW_RISK (Grade B)
- Score 55-69 → CAUTION (Grade C)
- Score 40-54 → HIGH_RISK (Grade D)
- Score < 40 → DANGER (Grade F)

### What the client should do:

```javascript
// src/sentinel/client.js
// Export: verifyTrade(decisionObject) → { approved, verdict, details }

// 1. Call /verify/token for token_in (USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
// 2. Call /verify/token for token_out (cbBTC on Base: 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf)
// 3. Call /verify/protocol for Aerodrome router (0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43)
// 4. Call /preflight with the full transaction details

// Decision logic:
// - If ANY endpoint returns DANGER → { approved: false, reason: "DANGER_BLOCK", details }
// - If ANY endpoint returns HIGH_RISK → { approved: false, reason: "HIGH_RISK_FLAG", details }
// - If ALL endpoints return SAFE or LOW_RISK → { approved: true, verdict: "SAFE", details }
// - If any endpoint returns CAUTION but none DANGER/HIGH_RISK → { approved: true, verdict: "CAUTION", details }
// - On network error: { approved: false, reason: "SENTINEL_UNREACHABLE", details }

// IMPORTANT: Sentinel uses x402 payment. For paper trading on localhost,
// set SENTINEL_SKIP_PAYMENT=true in .env to bypass payment middleware.
// The client should include header: x-skip-payment: true when this env var is set.
// If Sentinel is not running, the client should fail SAFE (block the trade, log warning).
```

### Build the decision object from composite signal:

```javascript
// src/sentinel/decision.js
// Export: buildDecisionObject(composite, cycleId) → decision object

// Map from the composite signal output to Sentinel's expected format:
// {
//   agent_id: "market-agent-v1",
//   action: "swap",
//   target_contract: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", // Aerodrome router
//   chain: "base",
//   token_in: composite.direction === "long" ? USDC_ADDRESS : CBBTC_ADDRESS,
//   token_out: composite.direction === "long" ? CBBTC_ADDRESS : USDC_ADDRESS,
//   amount_usd: positionSizeUsd,
//   direction: composite.direction,
//   confidence: composite.composite_confidence,
//   regime: composite.regime,
//   signal_agreement: composite.agreement_ratio,
//   thesis: `Composite signal: ${composite.direction} with ${composite.composite_confidence} confidence. ` +
//           `Attribution: ${JSON.stringify(composite.attribution)}`,
//   cycle: cycleId,
// }
```

### Wire into agent.js:

The hook point is at line 90 of `src/agent.js`. Uncomment and implement:

```javascript
// Replace the commented-out hook at line 90-93 with:
import { verifyTrade } from "./sentinel/client.js";
import { buildDecisionObject } from "./sentinel/decision.js";

// After adjustedComposites is computed:
let sentinelResults = {};
for (const composite of adjustedComposites) {
  if (composite.direction !== "neutral" && composite.composite_confidence >= 0.5) {
    const decision = buildDecisionObject(composite, cycleId);
    const verification = await verifyTrade(decision);
    sentinelResults[composite.pair] = verification;

    if (!verification.approved) {
      logger.warn({
        cycle: cycleId,
        pair: composite.pair,
        reason: verification.reason,
        verdict: verification.verdict,
      }, "Sentinel BLOCKED trade");
    }
  }
}
// Pass sentinelResults to the briefing generator
```

**Add config values to `src/config.js`:**
```javascript
sentinel: {
  url: process.env.SENTINEL_URL || "http://localhost:4021",
  skipPayment: process.env.SENTINEL_SKIP_PAYMENT === "true",
  timeoutMs: 10000,
},
```

---

## Task 2: Paper Trading Engine

**Create `src/paper/tracker.js`**

A virtual position tracker that simulates trades without real execution.

### Requirements:

```javascript
// src/paper/tracker.js

// State: stored in Postgres table `paper_trades`
// CREATE TABLE IF NOT EXISTS paper_trades (
//   id SERIAL PRIMARY KEY,
//   trade_id TEXT UNIQUE NOT NULL,
//   pair TEXT NOT NULL,
//   direction TEXT NOT NULL,        -- "long" or "short"
//   entry_price NUMERIC NOT NULL,
//   entry_time TIMESTAMPTZ NOT NULL,
//   exit_price NUMERIC,
//   exit_time TIMESTAMPTZ,
//   status TEXT DEFAULT 'open',     -- "open", "closed_tp", "closed_sl", "closed_tl", "closed_manual"
//   pnl_bps NUMERIC,
//   position_size_pct NUMERIC DEFAULT 0.5,
//   confidence NUMERIC,
//   sentinel_verdict TEXT,
//   sentinel_details JSONB,
//   signal_attribution JSONB,
//   human_approved BOOLEAN DEFAULT false,
//   human_approved_at TIMESTAMPTZ,
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );

// Export functions:
// - openPosition(params) → trade_id
//   params: { pair, direction, entryPrice, confidence, sentinelVerdict, sentinelDetails, signalAttribution }
//   Generates trade_id, inserts into paper_trades with status='open'
//
// - checkExits(currentPrice) → closedTrades[]
//   For each open position, check triple barrier:
//   - Take profit: 3% gain → close with status 'closed_tp'
//   - Stop loss: 5% loss → close with status 'closed_sl'
//   - Time limit: 48h elapsed → close with status 'closed_tl'
//   Returns array of trades that were just closed
//
// - getOpenPositions() → positions[]
// - getTradeHistory(limit) → trades[]
// - getPaperMetrics() → { totalTrades, winRate, avgPnlBps, totalPnlBps, sharpeRatio }
//   Compute metrics from closed paper trades (same formulas as backtest metrics.js)
```

### Add migration for paper_trades table:

**Create `src/db/migrations/006_paper_trades.sql`** (check current migration numbering — use the next available number):

```sql
CREATE TABLE IF NOT EXISTS paper_trades (
  id SERIAL PRIMARY KEY,
  trade_id TEXT UNIQUE NOT NULL,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price NUMERIC NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL,
  exit_price NUMERIC,
  exit_time TIMESTAMPTZ,
  status TEXT DEFAULT 'open',
  pnl_bps NUMERIC,
  position_size_pct NUMERIC DEFAULT 0.5,
  confidence NUMERIC,
  sentinel_verdict TEXT,
  sentinel_details JSONB,
  signal_attribution JSONB,
  decision_object JSONB,
  human_approved BOOLEAN DEFAULT false,
  human_approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_paper_trades_status ON paper_trades(status);
CREATE INDEX idx_paper_trades_pair ON paper_trades(pair);
```

---

## Task 3: Human Approval Gate

**Create `src/paper/approval.js`**

All paper trades require human approval before they execute.

### Approval flow:

```javascript
// src/paper/approval.js

// When a composite signal fires above threshold AND Sentinel approves:
// 1. Create a "pending" trade proposal in a new table `trade_proposals`
// 2. The dashboard displays the proposal with approve/reject buttons
// 3. If approved within 15 minutes, open the paper position
// 4. If rejected or expired, log and skip

// CREATE TABLE IF NOT EXISTS trade_proposals (
//   id SERIAL PRIMARY KEY,
//   proposal_id TEXT UNIQUE NOT NULL,
//   pair TEXT NOT NULL,
//   direction TEXT NOT NULL,
//   confidence NUMERIC,
//   sentinel_verdict TEXT,
//   sentinel_details JSONB,
//   signal_attribution JSONB,
//   decision_object JSONB,
//   current_price NUMERIC,
//   status TEXT DEFAULT 'pending',  -- "pending", "approved", "rejected", "expired"
//   decided_at TIMESTAMPTZ,
//   expires_at TIMESTAMPTZ,
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );

// Export functions:
// - createProposal(params) → proposal_id
// - approveProposal(proposalId) → { success, tradeId }
// - rejectProposal(proposalId) → { success }
// - expireStaleProposals() → count  (called on each cycle)
// - getPendingProposals() → proposals[]
```

**Add the trade_proposals table to the same migration file (006).**

### Add API endpoints to server.js:

```javascript
// GET /api/paper/proposals — list pending proposals
// POST /api/paper/proposals/:id/approve — approve a proposal (opens paper position)
// POST /api/paper/proposals/:id/reject — reject a proposal
// GET /api/paper/positions — list open paper positions
// GET /api/paper/history — list closed paper trades
// GET /api/paper/metrics — get paper trading performance metrics
```

---

## Task 4: Dashboard Updates

**Update `src/dashboard/index.html`** to add a paper trading section.

### Add these UI elements:

1. **Trade Proposals Panel:** Shows pending proposals with:
   - Pair, direction, confidence score
   - Sentinel verdict (color-coded: green=SAFE, yellow=CAUTION, red=DANGER)
   - Signal attribution breakdown (which signals contributed)
   - Current price
   - Approve / Reject buttons
   - Countdown timer showing time until expiry

2. **Open Positions Panel:** Shows current paper positions with:
   - Entry price, current price, unrealized P&L
   - Time remaining until time limit
   - Distance to take profit and stop loss levels

3. **Paper Trading Metrics Panel:** Shows running performance:
   - Total trades, win rate, avg P&L, total P&L
   - Comparison to backtest expectation (58.1 bps/trade target)
   - A simple line chart of cumulative P&L over time

4. **Sentinel Log Panel:** Shows recent Sentinel verification calls:
   - Verdict, response time, risk flags
   - Any DANGER blocks highlighted

Keep the existing dashboard panels (arb spread, cycle health, etc.) — add the paper trading panels below them.

Use the existing dashboard styling conventions. No new CSS frameworks — vanilla HTML/CSS/JS matching what's already there.

---

## Task 5: Integration Test

After building all of the above, verify the integration works end-to-end:

1. Run `npm run migrate` to create the new tables
2. Start Sentinel: `node server.js` (from the Sentinel root)
3. Start Market Agent: `npm start` (from market-agent/)
4. Verify the cycle runs, composite signal fires, Sentinel is called, and a trade proposal appears in the dashboard
5. If Sentinel is not running, verify the system fails safe (blocks trade, logs warning)

### Quick smoke test you can run:

```bash
# From market-agent/
node -e "
import('./src/sentinel/client.js').then(async (m) => {
  const result = await m.verifyTrade({
    agent_id: 'test',
    action: 'swap',
    target_contract: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    chain: 'base',
    token_in: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    token_out: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    amount_usd: 50,
    direction: 'long',
    confidence: 0.65,
  });
  console.log('Sentinel result:', JSON.stringify(result, null, 2));
}).catch(e => console.error('Test failed:', e.message));
"
```

If Sentinel is running, you should get back a verdict. If not, you should get `{ approved: false, reason: "SENTINEL_UNREACHABLE" }`.

---

## File Summary

### New files to create:
- `src/sentinel/client.js` — Sentinel API client
- `src/sentinel/decision.js` — Decision object builder
- `src/paper/tracker.js` — Paper position tracker
- `src/paper/approval.js` — Human approval gate
- `src/db/migrations/006_paper_trades.sql` — DB migration (check numbering)

### Files to modify:
- `src/agent.js` — Wire Sentinel hook at line 90
- `src/config.js` — Add sentinel config block
- `src/dashboard/index.html` — Add paper trading panels
- `server.js` (market-agent's) — Add paper trading API endpoints

### Do NOT modify:
- `src/signals/scorer.js` — Signal weights are validated; don't touch
- `src/backtest/` — Backtest infrastructure is complete
- `../server.js` (Sentinel's) — Don't modify Sentinel itself
- `src/signals/trend.js`, `reversion.js`, `volatility.js` — Signal modules are frozen

---

## Decision Tree

**If Sentinel is unreachable from localhost:**
→ Build the client with graceful fallback (fail-safe = block trade)
→ Add a `SENTINEL_MOCK=true` env var that returns `{ approved: true, verdict: "SAFE" }` for all calls
→ This lets paper trading run without Sentinel for initial testing
→ Log a warning on every mock call so we don't forget to wire up real Sentinel

**If the migration numbering is wrong:**
→ Check `src/db/migrations/` for the highest-numbered file
→ Use the next number (might be 005, 006, 007, etc.)

**If the dashboard uses a framework you don't recognize:**
→ Read the existing `index.html` first to understand the pattern
→ Match existing conventions exactly
→ No new dependencies
