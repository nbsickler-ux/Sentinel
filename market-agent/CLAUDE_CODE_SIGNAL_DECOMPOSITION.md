# Signal Decomposition & Regime Filter — Engineering Brief

**Date:** April 1, 2026
**Status:** Ready for execution
**Prerequisite:** Must be run from a machine that can reach the Render Postgres (DATABASE_URL in `.env`)
**Hard constraint:** Do not read .env files or touch API keys.

---

## Context

The directional composite signal (trend + reversion + volatility) was backtested and produced a 4.46 Sharpe with parameters: 48h lookback, 3% take profit, 5% stop loss, 0.5 confidence threshold. The arbitrage signal has already been dropped (definitively fails).

A synthetic-data decomposition run revealed:
- **Trend** carries virtually all the alpha (standalone Sharpe nearly identical to composite)
- **Reversion** is pure drag (negative Sharpe, 77–81% stop loss exits)
- **Volatility** generates zero trades (never fires a non-neutral direction)
- **Onchain** produces near-zero trades as a standalone signal
- **ADX regime filter** at threshold 25 modestly improves Sharpe by filtering out choppy-period trades

These findings need to be **validated against the real historical data in Postgres**, then the codebase updated accordingly.

---

## Tasks

### Task 1: Run `npm run decompose` against real Postgres data

The script already exists at `src/backtest/decompose.js` and is wired up in `package.json` as `npm run decompose`.

```bash
cd market-agent
npm run decompose
```

This will:
- Run trend, reversion, and volatility as standalone backtests on cbBTC/USDC and ETH/USDC
- Run onchain signal standalone
- Run directional composite with ADX regime filter at thresholds 20, 25, 30
- Print a comprehensive summary table

**Capture the full output.** The results determine whether to proceed with Tasks 2–4.

### Task 2: Update signal weights in `scorer.js`

**Only do this if Task 1 confirms:** trend standalone Sharpe is close to composite Sharpe, AND reversion standalone Sharpe is negative.

File: `market-agent/src/signals/scorer.js`

Change the `SIGNAL_WEIGHTS` object from:
```js
const SIGNAL_WEIGHTS = {
  trend:     0.30,
  reversion: 0.20,
  volatility: 0.15,
  arbitrage: 0.20,
  onchain:   0.15,
};
```

To:
```js
const SIGNAL_WEIGHTS = {
  trend:     0.85,
  reversion: 0.00,
  volatility: 0.00,
  arbitrage: 0.00,
  onchain:   0.15,
};
```

Rationale: Trend is the alpha source. Onchain keeps a small weight as a sentiment modifier (even if it rarely fires, when it does it shouldn't be ignored). Reversion, volatility, and arbitrage are zeroed out.

If Task 1 shows onchain also has zero value, change to `trend: 1.0` and zero everything else.

### Task 3: Add ADX regime gate to `backtestDirectional()` in `harness.js`

File: `market-agent/src/backtest/harness.js`

Add an ADX computation function at the top of the file:

```js
function computeADX(prices, period = 14) {
  if (prices.length < period * 3) return null;

  const trueRanges = [];
  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < prices.length; i++) {
    const windowSize = Math.min(3, i);
    const recentHigh = Math.max(...prices.slice(i - windowSize, i + 1));
    const recentLow = Math.min(...prices.slice(i - windowSize, i + 1));
    const prevHigh = i >= 2 ? Math.max(...prices.slice(Math.max(0, i - windowSize - 1), i)) : prices[i - 1];
    const prevLow = i >= 2 ? Math.min(...prices.slice(Math.max(0, i - windowSize - 1), i)) : prices[i - 1];

    const tr = Math.max(
      recentHigh - recentLow,
      Math.abs(recentHigh - prices[i - 1]),
      Math.abs(recentLow - prices[i - 1])
    );
    trueRanges.push(tr);

    const upMove = recentHigh - prevHigh;
    const downMove = prevLow - recentLow;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  if (trueRanges.length < period) return null;

  function wilderSmooth(values, p) {
    const smoothed = [values.slice(0, p).reduce((a, b) => a + b, 0)];
    for (let i = p; i < values.length; i++) {
      smoothed.push(smoothed[smoothed.length - 1] - smoothed[smoothed.length - 1] / p + values[i]);
    }
    return smoothed;
  }

  const smoothedTR = wilderSmooth(trueRanges, period);
  const smoothedPlusDM = wilderSmooth(plusDMs, period);
  const smoothedMinusDM = wilderSmooth(minusDMs, period);

  const dxValues = [];
  for (let i = 0; i < smoothedTR.length; i++) {
    if (smoothedTR[i] === 0) continue;
    const plusDI = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
    const minusDI = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
    const diSum = plusDI + minusDI;
    if (diSum === 0) continue;
    dxValues.push((Math.abs(plusDI - minusDI) / diSum) * 100);
  }

  if (dxValues.length < period) return null;

  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }
  return adx;
}
```

Then in `backtestDirectional()`, after the composite is computed and before `simulateTrade()` is called, add the ADX filter:

```js
// After: if (composite.direction === "neutral" || composite.composite_confidence < confidenceThreshold) continue;
// Add:
const adxThreshold = options.adxThreshold ?? 25;
const adx = computeADX(priceWindow);
if (adx !== null && adx < adxThreshold) continue;
```

Also add `adxThreshold` to the options/params interface so it can be configured from the sweep runner and CLI.

### Task 4: Re-run parameter sweep with updated weights + regime filter

After Tasks 2–3 are applied:

```bash
cd market-agent
npm run sweep -- --pair=cbBTC/USDC
npm run sweep -- --pair=ETH/USDC
```

Compare results to the previous sweep in `PARAMETER_SWEEP_RESULTS.md`. The expectation is:
- Sharpe should stay the same or improve (removing reversion drag)
- Max drawdown should decrease (ADX filter removes choppy-period losses)
- Hit rate should increase slightly

Write a new `PARAMETER_SWEEP_RESULTS_V2.md` documenting the updated sweep.

### Task 5: Verify no regressions

Run the existing test suite:

```bash
npm test
```

Also run a quick sanity check with the standard backtest runner:

```bash
npm run backtest -- --pair=cbBTC/USDC --signal=directional
```

Confirm the directional backtest still produces positive results with the new weights.

---

## Decision Tree

```
Task 1 output
├── Trend Sharpe ≈ Composite Sharpe AND Reversion Sharpe < 0
│   → Proceed with Tasks 2–5 as written
│
├── Trend Sharpe << Composite Sharpe (reversion/vol contribute)
│   → Do NOT change weights. Instead investigate why synthetic
│     and real data disagree. The composite may depend on
│     reversion in certain regime windows.
│
├── Onchain has meaningful standalone Sharpe (> 1.0)
│   → Keep onchain weight at 0.15 or increase to 0.20
│
└── ADX filter degrades Sharpe on real data
    → Skip Task 3. The regime structure in real data may differ
      from synthetic. Try alternative filters: vol ratio < 1.3,
      or BB width threshold.
```

---

## Files Modified

| File | Change |
|---|---|
| `src/signals/scorer.js` | Update SIGNAL_WEIGHTS |
| `src/backtest/harness.js` | Add computeADX(), add regime gate |
| `src/backtest/decompose.js` | Already exists (new file from this session) |
| `src/backtest/decompose-local.js` | Already exists (new file from this session) |
| `package.json` | Already updated with `decompose` and `decompose-local` scripts |
| `PARAMETER_SWEEP_RESULTS_V2.md` | New — output of post-change sweep |

---

## Output

Write `SIGNAL_DECOMPOSITION_RESULTS.md` in the market-agent root with:

1. **Task 1 real-data results table** — all standalone signal backtests + regime filter results
2. **Decision taken** — which branch of the decision tree was followed and why
3. **Weight changes applied** — before/after SIGNAL_WEIGHTS
4. **Task 4 sweep comparison** — top 10 before vs after, highlighting improvements
5. **Recommended next step** — what to focus on for Phase 3 paper trading
