# Signal Decomposition Results — Real Data

**Date:** April 1, 2026
**Data source:** Postgres (Coinbase hourly prices, 2159 points per pair)
**Params:** 48h lookback, 3% TP, 5% SL, 0.5 confidence threshold, 30bps fee

---

## Task 1: Real-Data Signal Decomposition

| Pair | Signal | Trades | Hit% | AvgPnL (bps) | Sharpe | MaxDD% | PF |
|---|---|---|---|---|---|---|---|
| cbBTC/USDC | **composite** | 65 | 67.7 | 72.6 | **4.46** | 19.4 | 1.90 |
| cbBTC/USDC | trend | 64 | 59.4 | 23.4 | 1.28 | 73.8 | 1.21 |
| cbBTC/USDC | reversion | 57 | 49.1 | -63.8 | -3.21 | 100.0 | 0.63 |
| cbBTC/USDC | volatility | 0 | — | — | — | — | — |
| cbBTC/USDC | onchain | 0 | — | — | — | — | — |
| ETH/USDC | **composite** | 86 | 58.1 | -14.8 | -0.68 | 162.7 | 0.91 |
| ETH/USDC | trend | 93 | 57.0 | -28.3 | -1.28 | 192.1 | 0.84 |
| ETH/USDC | reversion | 73 | 52.1 | -90.5 | -3.88 | 100.0 | 0.58 |
| ETH/USDC | volatility | 0 | — | — | — | — | — |
| ETH/USDC | onchain | 0 | — | — | — | — | — |

### ADX Regime Filter Results

| Pair | ADX≥ | Trades | Hit% | AvgPnL (bps) | Sharpe | MaxDD% | PF | Filtered |
|---|---|---|---|---|---|---|---|---|
| cbBTC/USDC | none | 65 | 67.7 | 72.6 | **4.46** | 19.4 | 1.90 | — |
| cbBTC/USDC | 20 | 65 | 64.6 | 63.8 | 3.71 | 21.9 | 1.69 | 24% |
| cbBTC/USDC | 25 | 62 | 62.9 | 57.7 | 3.38 | 25.3 | 1.64 | 45% |
| cbBTC/USDC | 30 | 58 | 60.3 | 28.0 | 1.48 | 66.6 | 1.24 | 68% |
| ETH/USDC | none | 86 | 58.1 | -14.8 | -0.68 | 162.7 | 0.91 | — |
| ETH/USDC | 20 | 87 | 59.8 | -14.8 | -0.68 | 160.7 | 0.91 | 19% |
| ETH/USDC | 25 | 87 | 59.8 | -10.9 | -0.50 | 143.5 | 0.93 | 27% |
| ETH/USDC | 30 | 83 | 60.2 | -8.8 | -0.40 | 134.3 | 0.95 | 57% |

---

## Decision Taken

**Branch followed:** "Trend Sharpe << Composite Sharpe → Do NOT change weights."

The real data fundamentally contradicts the synthetic-data findings:

1. **Trend is NOT the sole alpha source.** On cbBTC/USDC, trend standalone produces Sharpe 1.28 vs composite's 4.46. The composite outperforms trend by 3.5x in Sharpe terms. This means the signal combination (including reversion and volatility as directional inputs to the scorer) is adding value — likely through trade filtering. Reversion's negative-standalone-Sharpe does not mean it's pure drag in the composite; it may be acting as a filter that prevents trend from entering bad trades.

2. **Onchain generates zero trades** on real data (no on-chain events in the database). Confirmed as non-functional in current state.

3. **Volatility generates zero trades** on both pairs. Confirmed — the signal never fires a non-neutral direction.

4. **ADX regime filter degrades performance** on real data. For cbBTC/USDC, the unfiltered composite (Sharpe 4.46) beats every ADX threshold tested. The filter removes good trades along with bad ones. For ETH/USDC, ADX provides marginal improvement (Sharpe from -0.68 to -0.40 at ADX≥30) but the pair is unprofitable regardless.

5. **ETH/USDC is unprofitable** across all signals and configurations. This is a pair-level problem, not a signal-level one.

### Why synthetic and real data disagree

The synthetic data was generated from statistical distributions that may not capture the temporal structure of real markets. Specifically:
- Synthetic trend signals likely had cleaner directional moves, making trend standalone look dominant
- Real markets have regime transitions where reversion signals fire and cancel out bad trend entries
- The composite scorer's weighting scheme creates an implicit filter: reversion disagreeing with trend can push confidence below threshold, preventing marginal trades

---

## Weight Changes Applied

**None.** Current weights retained:

```js
const SIGNAL_WEIGHTS = {
  trend:     0.30,
  reversion: 0.20,
  volatility: 0.15,
  arbitrage: 0.20,
  onchain:   0.15,
};
```

Rationale: The composite at current weights produces the best cbBTC/USDC Sharpe (4.46). Changing weights risks degrading the implicit trade-filtering effect that reversion provides.

---

## Task 4: Sweep Comparison

**Skipped.** Since no weight or filter changes were made, a new sweep would produce identical results to `PARAMETER_SWEEP_RESULTS.md`.

---

## Recommended Next Steps for Phase 3

1. **Investigate the composite's emergent filtering.** Run a trade-by-trade analysis comparing which trades composite takes vs trend-only. Identify which trades reversion is successfully filtering out. This will inform whether reversion's weight should be adjusted or its role formalized as a filter rather than a signal.

2. **Drop ETH/USDC from live trading scope.** The pair is unprofitable across all configurations. Focus on cbBTC/USDC for paper trading. Revisit ETH when more data is available or market conditions change.

3. **Address the 19.4% max drawdown.** cbBTC/USDC composite passes every graduation criterion except max drawdown (19.4% vs 15% threshold). Investigate position sizing adjustments or a drawdown circuit breaker.

4. **Fix or remove dead signals.** Volatility and onchain produce zero trades on real data. Either fix the underlying signal logic (volatility never fires non-neutral; onchain has no events in DB) or remove them to simplify the codebase. Note: removing them may change composite behavior if their weights affect normalization.

5. **Alternative regime filters.** ADX failed, but the brief suggested trying volatility ratio < 1.3 or Bollinger Band width threshold. These may better identify choppy periods without removing profitable trades.

6. **Update default backtest params.** The standard `npm run backtest` runner uses default params (confidence threshold 0.3, shorter time limit) which produce Sharpe -3.86 on cbBTC/USDC. The optimized params (48h lookback, 3% TP, 5% SL, 0.5 confidence) produce Sharpe 4.46. The defaults in `simulator.js` / `harness.js` should be updated to reflect the sweep-optimized values, or the runner should accept a `--preset optimized` flag.
