#!/usr/bin/env node
// ============================================================
// FILTER ANALYSIS: Composite vs Trend-Only Trade Comparison
//
// Identifies which trades reversion is filtering out of the
// composite and whether those filtered trades are losers.
// ============================================================

import { pool } from "../db/schema.js";
import { runMigrations } from "../db/migrate.js";
import { loadPrices } from "./loader.js";
import { simulateTrade } from "./simulator.js";
import { computeMetrics } from "./metrics.js";
import { analyze as trendAnalyze } from "../signals/trend.js";
import { analyze as reversionAnalyze } from "../signals/reversion.js";
import { analyze as volatilityAnalyze } from "../signals/volatility.js";
import { computeComposite } from "../signals/scorer.js";

const PAIR = "cbBTC/USDC";
const WINNING_PARAMS = {
  stopLossPct: 5.0,
  takeProfitPct: 3.0,
  timeLimitMs: 48 * 3600 * 1000,
};
const CONFIDENCE_THRESHOLD = 0.5;
const DEX_FEE_BPS = 30;
const LOOKBACK = 50;

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  FILTER ANALYSIS: Composite vs Trend-Only   ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();

  await runMigrations();

  let prices = await loadPrices(PAIR, "coinbase");
  if (prices.length < LOOKBACK + 1) {
    console.log("  Insufficient data.");
    process.exit(1);
  }

  console.log(`  Analyzing ${PAIR}: ${prices.length} candles`);
  console.log(`  Params: TL=48h, TP=3%, SL=5%, Confidence=${CONFIDENCE_THRESHOLD}`);
  console.log();

  // Buckets
  const bothTrade = [];       // Both trend-only and composite would trade (same direction)
  const onlyTrend = [];       // Trend would trade but composite doesn't (filtered)
  const onlyComposite = [];   // Composite trades but trend-only wouldn't
  let neitherCount = 0;
  let candlesAnalyzed = 0;

  // Track reversion details on filtered trades
  const filteredReversionDetails = [];

  // We need to simulate trades with skip-ahead logic, so track independently
  let bothSkipUntil = 0;
  let trendSkipUntil = 0;
  let compositeSkipUntil = 0;

  for (let i = LOOKBACK; i < prices.length; i++) {
    candlesAnalyzed++;
    const priceWindow = prices.slice(Math.max(0, i - LOOKBACK), i + 1).map((p) => p.price);

    // Run trend signal
    const trendSig = trendAnalyze(PAIR, priceWindow);
    const trendWouldTrade = trendSig && trendSig.direction !== "neutral" && trendSig.confidence >= CONFIDENCE_THRESHOLD;

    // Run full composite (trend + reversion + volatility)
    const signals = [];
    if (trendSig) signals.push(trendSig);
    const revSig = reversionAnalyze(PAIR, priceWindow);
    if (revSig) signals.push(revSig);
    const volSig = volatilityAnalyze(PAIR, priceWindow);
    if (volSig) signals.push(volSig);

    let compositeWouldTrade = false;
    let compositeResult = null;
    if (signals.length > 0) {
      compositeResult = computeComposite(PAIR, signals);
      compositeWouldTrade = compositeResult.direction !== "neutral" && compositeResult.composite_confidence >= CONFIDENCE_THRESHOLD;
    }

    // Classify
    if (trendWouldTrade && compositeWouldTrade) {
      // Both trade — simulate the trade (use composite direction)
      if (i >= bothSkipUntil) {
        const futurePrices = prices.slice(i + 1);
        if (futurePrices.length > 0) {
          const trade = simulateTrade(
            {
              timestamp: prices[i].timestamp,
              price: prices[i].price,
              direction: compositeResult.direction,
              signalType: "both",
              pair: PAIR,
              confidence: compositeResult.composite_confidence,
            },
            futurePrices,
            WINNING_PARAMS,
            DEX_FEE_BPS
          );
          if (trade) {
            bothTrade.push(trade);
            bothSkipUntil = i + Math.max(1, Math.floor(trade.holdTimeMs / (3600 * 1000)));
          }
        }
      }
    } else if (trendWouldTrade && !compositeWouldTrade) {
      // Only trend trades — reversion filtered it out
      if (i >= trendSkipUntil) {
        const futurePrices = prices.slice(i + 1);
        if (futurePrices.length > 0) {
          const trade = simulateTrade(
            {
              timestamp: prices[i].timestamp,
              price: prices[i].price,
              direction: trendSig.direction,
              signalType: "trend-only-filtered",
              pair: PAIR,
              confidence: trendSig.confidence,
            },
            futurePrices,
            WINNING_PARAMS,
            DEX_FEE_BPS
          );
          if (trade) {
            onlyTrend.push(trade);
            trendSkipUntil = i + Math.max(1, Math.floor(trade.holdTimeMs / (3600 * 1000)));

            // Capture reversion details
            filteredReversionDetails.push({
              timestamp: prices[i].timestamp.toISOString().slice(0, 16),
              price: prices[i].price,
              trendDir: trendSig.direction,
              trendConf: trendSig.confidence.toFixed(3),
              revDir: revSig ? revSig.direction : "n/a",
              revConf: revSig ? revSig.confidence.toFixed(3) : "n/a",
              revZScore: revSig?.indicators?.avg_z?.toFixed(2) ?? "n/a",
              revBBPos: revSig?.indicators?.bollinger_position_20 != null
                ? (revSig.indicators.bollinger_position_20 * 100).toFixed(1) + "%"
                : "n/a",
              compositeDir: compositeResult?.direction ?? "neutral",
              compositeConf: compositeResult?.composite_confidence?.toFixed(3) ?? "0",
              tradeResult: trade.netPnlBps.toFixed(1) + " bps",
              exitReason: trade.exitReason,
            });
          }
        }
      }
    } else if (!trendWouldTrade && compositeWouldTrade) {
      // Only composite trades
      if (i >= compositeSkipUntil) {
        const futurePrices = prices.slice(i + 1);
        if (futurePrices.length > 0) {
          const trade = simulateTrade(
            {
              timestamp: prices[i].timestamp,
              price: prices[i].price,
              direction: compositeResult.direction,
              signalType: "composite-only",
              pair: PAIR,
              confidence: compositeResult.composite_confidence,
            },
            futurePrices,
            WINNING_PARAMS,
            DEX_FEE_BPS
          );
          if (trade) {
            onlyComposite.push(trade);
            compositeSkipUntil = i + Math.max(1, Math.floor(trade.holdTimeMs / (3600 * 1000)));
          }
        }
      }
    } else {
      neitherCount++;
    }
  }

  // Compute metrics for each bucket
  const bothMetrics = computeMetrics(bothTrade);
  const trendOnlyMetrics = computeMetrics(onlyTrend);
  const compositeOnlyMetrics = computeMetrics(onlyComposite);

  // Print summary
  console.log(`  Filter Analysis: ${PAIR}`);
  console.log("  " + "═".repeat(50));
  console.log();
  console.log(`  Candles analyzed:       ${candlesAnalyzed}`);
  console.log(`  Both trade:             ${bothTrade.length} (${(bothTrade.length / candlesAnalyzed * 100).toFixed(1)}%)`);
  console.log(`  Only trend trades:      ${onlyTrend.length} (${(onlyTrend.length / candlesAnalyzed * 100).toFixed(1)}%)  ← filtered by reversion`);
  console.log(`  Only composite trades:  ${onlyComposite.length} (${(onlyComposite.length / candlesAnalyzed * 100).toFixed(1)}%)`);
  console.log(`  Neither trades:         ${neitherCount} (${(neitherCount / candlesAnalyzed * 100).toFixed(1)}%)`);

  console.log();
  console.log(`  "Both trade" metrics:`);
  if (bothMetrics.total_trades > 0) {
    console.log(`    Trades: ${bothMetrics.total_trades}, Hit: ${(bothMetrics.hit_rate * 100).toFixed(1)}%, Sharpe: ${bothMetrics.sharpe_ratio.toFixed(2)}, AvgPnL: ${bothMetrics.avg_pnl_bps > 0 ? "+" : ""}${bothMetrics.avg_pnl_bps.toFixed(1)}bps`);
    console.log(`    Max DD: ${bothMetrics.max_drawdown_pct.toFixed(1)}%, PF: ${bothMetrics.profit_factor.toFixed(2)}`);
    console.log(`    Exits: ${Object.entries(bothMetrics.exit_reasons).map(([r, c]) => `${r}=${c}`).join(", ")}`);
  } else {
    console.log(`    No trades.`);
  }

  console.log();
  console.log(`  "Only trend" metrics (the filtered trades):`);
  if (trendOnlyMetrics.total_trades > 0) {
    console.log(`    Trades: ${trendOnlyMetrics.total_trades}, Hit: ${(trendOnlyMetrics.hit_rate * 100).toFixed(1)}%, Sharpe: ${trendOnlyMetrics.sharpe_ratio.toFixed(2)}, AvgPnL: ${trendOnlyMetrics.avg_pnl_bps > 0 ? "+" : ""}${trendOnlyMetrics.avg_pnl_bps.toFixed(1)}bps`);
    console.log(`    Max DD: ${trendOnlyMetrics.max_drawdown_pct.toFixed(1)}%, PF: ${trendOnlyMetrics.profit_factor.toFixed(2)}`);
    console.log(`    Exits: ${Object.entries(trendOnlyMetrics.exit_reasons).map(([r, c]) => `${r}=${c}`).join(", ")}`);
  } else {
    console.log(`    No trades.`);
  }

  console.log();
  console.log(`  "Only composite" metrics:`);
  if (compositeOnlyMetrics.total_trades > 0) {
    console.log(`    Trades: ${compositeOnlyMetrics.total_trades}, Hit: ${(compositeOnlyMetrics.hit_rate * 100).toFixed(1)}%, Sharpe: ${compositeOnlyMetrics.sharpe_ratio.toFixed(2)}, AvgPnL: ${compositeOnlyMetrics.avg_pnl_bps > 0 ? "+" : ""}${compositeOnlyMetrics.avg_pnl_bps.toFixed(1)}bps`);
    console.log(`    Max DD: ${compositeOnlyMetrics.max_drawdown_pct.toFixed(1)}%, PF: ${compositeOnlyMetrics.profit_factor.toFixed(2)}`);
    console.log(`    Exits: ${Object.entries(compositeOnlyMetrics.exit_reasons).map(([r, c]) => `${r}=${c}`).join(", ")}`);
  } else {
    console.log(`    No trades.`);
  }

  // Reversion filter verdict
  console.log();
  console.log("  Reversion filter verdict:");
  if (onlyTrend.length > 0) {
    const filteredAvgPnl = trendOnlyMetrics.avg_pnl_bps;
    console.log(`    Trades prevented: ${onlyTrend.length}`);
    console.log(`    Avg P&L of prevented trades: ${filteredAvgPnl > 0 ? "+" : ""}${filteredAvgPnl.toFixed(1)} bps`);
    if (filteredAvgPnl < 0) {
      console.log(`    → Reversion SAVED the composite ${Math.abs(filteredAvgPnl).toFixed(1)} bps per filtered trade (total: ${Math.abs(trendOnlyMetrics.total_pnl_bps).toFixed(1)} bps)`);
    } else {
      console.log(`    → Reversion COST the composite ${filteredAvgPnl.toFixed(1)} bps per filtered trade (total: ${trendOnlyMetrics.total_pnl_bps.toFixed(1)} bps)`);
    }
  } else {
    console.log("    No trades were filtered — reversion is not acting as a filter.");
  }

  // Reversion detail table for filtered trades
  if (filteredReversionDetails.length > 0) {
    console.log();
    console.log("  ─── Reversion Details on Filtered Trades ───");
    console.log("  " + [
      "Timestamp".padEnd(17),
      "TrDir".padEnd(6),
      "TrConf".padEnd(7),
      "RevDir".padEnd(7),
      "RevConf".padEnd(8),
      "Z-Score".padEnd(8),
      "BB Pos".padEnd(8),
      "CompDir".padEnd(8),
      "CompConf".padEnd(9),
      "Result".padEnd(12),
      "Exit",
    ].join(" "));
    console.log("  " + "─".repeat(110));

    for (const d of filteredReversionDetails) {
      console.log("  " + [
        d.timestamp.padEnd(17),
        d.trendDir.padEnd(6),
        d.trendConf.padEnd(7),
        d.revDir.padEnd(7),
        d.revConf.padEnd(8),
        d.revZScore.padEnd(8),
        d.revBBPos.padEnd(8),
        d.compositeDir.padEnd(8),
        d.compositeConf.padEnd(9),
        d.tradeResult.padEnd(12),
        d.exitReason,
      ].join(" "));
    }
  }

  console.log();
  console.log("═".repeat(60));
  console.log("  Done.");
  console.log("═".repeat(60));

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
