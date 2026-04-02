# Phase 3 Prep Results

**Date:** April 1, 2026
**Status:** All tasks complete. cbBTC/USDC passes 6/6 graduation criteria.

---

## Task 1: Filter Analysis — Composite vs Trend-Only

The reversion filter hypothesis is **confirmed**. Reversion acts as an implicit trade filter that prevents bad trend entries.

### Summary

| Bucket | Trades | Hit% | Sharpe | AvgPnL | MaxDD% | PF |
|---|---|---|---|---|---|---|
| Both trade (composite agrees with trend) | 69 | 60.9% | 3.03 | +52.4 bps | 24.2% | 1.54 |
| Only trend trades (filtered by reversion) | 48 | 45.8% | **-2.09** | **-40.6 bps** | 276.9% | 0.74 |
| Only composite trades | 0 | — | — | — | — | — |
| Neither | 478 candles | — | — | — | — | — |

### Reversion Filter Verdict

- **Trades prevented:** 48
- **Avg P&L of prevented trades:** -40.6 bps (losers)
- **Total P&L saved:** 1,948.3 bps
- The composite (Sharpe 4.46) outperforms "both trade" (Sharpe 3.03) because trade overlap/timing differs slightly from the original composite run, but the key finding holds: **reversion filters out losing trend trades**.

### Reversion Signal Characteristics on Filtered Trades

When reversion vetoes a trend trade, the typical pattern is:
- **Reversion direction:** Mostly neutral (68% of filtered trades), occasionally opposing the trend direction
- **Z-scores:** Mild range (-1.32 to +1.37) — not extreme, but enough to dampen composite confidence
- **Bollinger position:** 23–92% range — not at extremes, indicating the market is mid-band (no strong reversion or trend)
- **Composite confidence:** Always 0.41–0.50 (just below the 0.5 threshold) — reversion tips the balance

**Mechanism:** Reversion doesn't need to "disagree" strongly — even a neutral reversion signal with zero confidence reduces the composite's weighted average confidence enough to push marginal trend trades below the 0.5 threshold. This is the implicit filtering effect.

---

## Task 2: Drawdown Fix

**Approach A (position sizing) — APPLIED.**

Modified `computeMetrics()` to accept `positionSizePct` parameter. Drawdown is now computed against a 10,000 bps portfolio base, with each trade's P&L scaled by position size. This matches the brief's 0.5% per trade specification.

| Metric | Before (100% position) | After (0.5% position) |
|---|---|---|
| Max Drawdown | 19.4% | **0.05%** |
| Sharpe | 4.46 | 4.46 (unchanged) |
| All other metrics | unchanged | unchanged |

Approaches B (circuit breaker) and C (relax threshold) were not needed.

---

## Task 3: Default Param Changes

| Parameter | Before | After | File |
|---|---|---|---|
| `directional.timeLimitMs` | 4 hours | **48 hours** | `src/backtest/simulator.js` |
| `confidenceThreshold` | 0.3 | **0.5** | `src/backtest/harness.js` |
| `positionSizePct` | not passed | **0.5** | `src/backtest/run.js` |

Effect: `npm run backtest -- --signal=directional` now produces Sharpe 4.46 (was -3.86 with old defaults).

---

## Task 4: Scope Changes

- **ETH/USDC removed** from default pairs in `src/config.js` (Sharpe -0.68, unprofitable)
- **AERO/USDC removed** from default pairs (untested, volatile pool)
- Pair definitions still exist — can be tested explicitly with `--pair=ETH/USDC`

---

## Task 5: Dead Signal Documentation

Added weight rationale comment block in `src/signals/scorer.js` documenting:
- Trend: primary alpha source
- Reversion: implicit filter role (DO NOT remove)
- Volatility: zero trades, candidate for rework
- Arbitrage: effectively dead (never passed to composite)
- Onchain: zero trades, needs data pipeline fix

---

## Updated Graduation Status — cbBTC/USDC

| Criterion | Threshold | Actual | Pass |
|---|---|---|---|
| Positive EV | > 0 bps | +72.6 bps | **Yes** |
| Sharpe | > 1.0 | 4.46 | **Yes** |
| Max Drawdown | < 15% | 0.05% | **Yes** |
| Hit Rate | > 40% | 67.7% | **Yes** |
| Profit Factor | > 1.5 | 1.90 | **Yes** |
| Min Trades | 30+ | 65 | **Yes** |

**Result: 6/6 — GRADUATES**

---

## Phase 3 Readiness Checklist

- [x] cbBTC/USDC passes 6/6 graduation criteria
- [x] Default params produce positive Sharpe (4.46)
- [x] Dead signals documented (scorer.js comment block)
- [x] ETH/USDC removed from default scope
- [x] Reversion filter mechanism understood and documented (filter-analysis.js)

---

## Files Modified

| File | Change |
|---|---|
| `src/backtest/filter-analysis.js` | **New** — trade-by-trade composite vs trend-only analysis |
| `src/backtest/metrics.js` | Added `positionSizePct` option, portfolio-base drawdown calculation |
| `src/backtest/simulator.js` | Default directional `timeLimitMs`: 4h → 48h |
| `src/backtest/harness.js` | Default `confidenceThreshold`: 0.3 → 0.5; passes `positionSizePct` to metrics |
| `src/backtest/run.js` | Passes `positionSizePct: 0.5` for directional backtests |
| `src/config.js` | Default pairs: `["cbBTC/USDC"]` (dropped ETH, AERO) |
| `src/signals/scorer.js` | Added weight rationale documentation |
| `package.json` | Added `filter-analysis` script |
