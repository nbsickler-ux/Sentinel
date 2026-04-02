# Claude Code: Two Follow-Up Tasks

**Date:** April 1, 2026
**From:** Opus strategy session
**Hard constraint:** Do not read .env files or touch API keys.

---

## Task 1: Take Profit Micro-Sweep

The best cbBTC/USDC config (48h/3%/5%/0.5) has TP < SL which is counterintuitive. The 67.7% hit rate makes it work mathematically, but we want to see if a wider TP maintains performance.

**Run a focused sweep with these parameters held constant:**
- Time limit: 48h
- Stop loss: 5%
- Confidence threshold: 0.5
- Pair: cbBTC/USDC

**Sweep take profit through:** 2%, 2.5%, 3%, 3.5%, 4%, 4.5%, 5%, 6%

That's 8 runs. Save all to backtest_results. Report:
- Full metrics for each (trades, hit rate, avg P&L, Sharpe, max drawdown, profit factor)
- Exit type breakdown (% take profit / % stop loss / % time limit) for each
- Whether each passes graduation criteria (including the 15% max drawdown threshold)
- Identify the sweet spot where TP/SL ratio improves without killing the Sharpe

We're looking for: can we get TP ≥ SL while staying near that 4.46 Sharpe? Or is the 3% TP genuinely optimal?

---

## Task 2: Arb Re-Run with Corrected Fees

The cbBTC/USDC Aerodrome pool is 0.05% (5 bps), not the 0.30% (30 bps) assumed in the original arb backtest.

**Update the fee model in the arb backtest path** (simulator.js or wherever the Aerodrome fee is configured) to use 5 bps for cbBTC/USDC. Keep Coinbase taker at 60 bps and gas at ~3 bps. New round-trip: ~68 bps.

**Re-run the arb backtest for cbBTC/USDC** with the corrected fee. Use the same default Triple Barrier parameters from the original run.

**Also check:** what is the ETH/USDC Aerodrome pool fee tier? If it's also lower than 30 bps, re-run that too.

Report:
- Updated arb metrics (trades, hit rate, avg P&L, Sharpe, profit factor)
- Compare side-by-side with original 93 bps results
- Does anything change meaningfully? Does arb get closer to graduation?
- Exit type breakdown — are spreads persisting long enough to hit take profit now?

---

## Output

Add results to the bottom of PARAMETER_SWEEP_RESULTS.md under new sections:
- "Take Profit Micro-Sweep Results"
- "Arb Re-Run with Corrected Fees"

Keep it in the same format as the existing report.
