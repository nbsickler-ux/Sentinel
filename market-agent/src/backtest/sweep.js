#!/usr/bin/env node
// ============================================================
// PARAMETER SWEEP RUNNER
// Runs backtestDirectional() across a grid of parameter combos.
// Saves every result to backtest_results table.
// ============================================================

import { runMigrations } from "../db/migrate.js";
import { backtestDirectional, saveResults } from "./harness.js";
import { checkGraduation } from "./metrics.js";
import config from "../config.js";
import logger from "../logger.js";

// ── Parameter Grid ──
const GRID = {
  timeLimitHours: [8, 12, 24, 48],
  takeProfitPct: [1, 2, 3, 5, 8],
  stopLossPct: [1, 2, 3, 5],
  confidenceThreshold: [0.3, 0.4, 0.5, 0.6],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { top: 20 };

  for (const arg of args) {
    if (arg.startsWith("--pair=")) options.pair = arg.split("=")[1];
    else if (arg.startsWith("--top=")) options.top = parseInt(arg.split("=")[1], 10);
  }

  return options;
}

function generateCombinations() {
  const combos = [];
  for (const tl of GRID.timeLimitHours) {
    for (const tp of GRID.takeProfitPct) {
      for (const sl of GRID.stopLossPct) {
        for (const ct of GRID.confidenceThreshold) {
          combos.push({
            timeLimitMs: tl * 3600 * 1000,
            timeLimitHours: tl,
            takeProfitPct: tp,
            stopLossPct: sl,
            confidenceThreshold: ct,
          });
        }
      }
    }
  }
  return combos;
}

async function runSweep(pairs, topN) {
  const combos = generateCombinations();
  const totalRuns = combos.length * pairs.length;

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  DIRECTIONAL SIGNAL PARAMETER SWEEP         ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();
  console.log(`  Pairs:         ${pairs.join(", ")}`);
  console.log(`  Combinations:  ${combos.length} per pair`);
  console.log(`  Total runs:    ${totalRuns}`);
  console.log(`  Grid:`);
  console.log(`    time_limit:   ${GRID.timeLimitHours.map((h) => h + "h").join(", ")}`);
  console.log(`    take_profit:  ${GRID.takeProfitPct.map((p) => p + "%").join(", ")}`);
  console.log(`    stop_loss:    ${GRID.stopLossPct.map((p) => p + "%").join(", ")}`);
  console.log(`    confidence:   ${GRID.confidenceThreshold.join(", ")}`);
  console.log();

  const allResults = [];
  let completed = 0;
  const startTime = Date.now();

  for (const pair of pairs) {
    console.log(`  Running ${pair}...`);

    for (const combo of combos) {
      try {
        const result = await backtestDirectional(pair, {
          params: {
            stopLossPct: combo.stopLossPct,
            takeProfitPct: combo.takeProfitPct,
            timeLimitMs: combo.timeLimitMs,
          },
          confidenceThreshold: combo.confidenceThreshold,
        });

        // Enrich result with sweep params
        result.sweepParams = {
          timeLimitHours: combo.timeLimitHours,
          takeProfitPct: combo.takeProfitPct,
          stopLossPct: combo.stopLossPct,
          confidenceThreshold: combo.confidenceThreshold,
        };
        result.params = {
          ...result.params,
          ...result.sweepParams,
        };

        // Save to Postgres
        await saveResults(result);

        allResults.push(result);
      } catch (e) {
        logger.error({
          module: "sweep",
          pair,
          params: combo,
          err: e.message,
        }, "Sweep run failed");
      }

      completed++;
      if (completed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (completed / (Date.now() - startTime) * 1000).toFixed(1);
        console.log(`    ${completed}/${totalRuns} (${elapsed}s, ${rate} runs/sec)`);
      }
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Sweep complete: ${completed} runs in ${totalTime}s\n`);

  return allResults;
}

function printResults(allResults, topN) {
  // Group by pair
  const byPair = {};
  for (const r of allResults) {
    if (!byPair[r.pair]) byPair[r.pair] = [];
    byPair[r.pair].push(r);
  }

  for (const [pair, results] of Object.entries(byPair)) {
    // Sort by Sharpe descending
    results.sort((a, b) => (b.metrics.sharpe_ratio || -999) - (a.metrics.sharpe_ratio || -999));

    const graduating = results.filter((r) => r.graduation?.passes);
    const top = results.slice(0, topN);

    console.log(`╔══════════════════════════════════════════════╗`);
    console.log(`║  ${pair.padEnd(42)} ║`);
    console.log(`╚══════════════════════════════════════════════╝`);
    console.log(`  Total combos: ${results.length} | Graduating: ${graduating.length}`);
    console.log();

    // Header
    console.log("  " + [
      "TL".padStart(4),
      "TP".padStart(4),
      "SL".padStart(4),
      "Conf".padStart(5),
      "Trades".padStart(7),
      "Hit%".padStart(6),
      "AvgPnL".padStart(8),
      "Sharpe".padStart(7),
      "MaxDD%".padStart(7),
      "PF".padStart(6),
      "Pass".padStart(5),
    ].join(" "));

    console.log("  " + "─".repeat(73));

    for (const r of top) {
      const sp = r.sweepParams;
      const m = r.metrics;
      const pass = r.graduation?.passes ? "  ✓" : "  ✗";

      console.log("  " + [
        `${sp.timeLimitHours}h`.padStart(4),
        `${sp.takeProfitPct}%`.padStart(4),
        `${sp.stopLossPct}%`.padStart(4),
        sp.confidenceThreshold.toFixed(1).padStart(5),
        String(m.total_trades).padStart(7),
        `${(m.hit_rate * 100).toFixed(1)}`.padStart(6),
        m.avg_pnl_bps.toFixed(1).padStart(8),
        m.sharpe_ratio.toFixed(2).padStart(7),
        m.max_drawdown_pct.toFixed(1).padStart(7),
        m.profit_factor.toFixed(2).padStart(6),
        pass.padStart(5),
      ].join(" "));
    }

    // Exit analysis for top 5
    console.log(`\n  Exit Analysis (top 5):`);
    for (const r of results.slice(0, 5)) {
      const sp = r.sweepParams;
      const m = r.metrics;
      const exits = m.exit_reasons || {};
      const total = m.total_trades || 1;
      const tp = ((exits.take_profit || 0) / total * 100).toFixed(0);
      const sl = ((exits.stop_loss || 0) / total * 100).toFixed(0);
      const tl = ((exits.time_limit || 0) / total * 100).toFixed(0);
      const eod = ((exits.end_of_data || 0) / total * 100).toFixed(0);

      console.log(`    TL=${sp.timeLimitHours}h TP=${sp.takeProfitPct}% SL=${sp.stopLossPct}% C=${sp.confidenceThreshold}  →  TP:${tp}% SL:${sl}% Time:${tl}% EOD:${eod}%`);
    }

    console.log();
  }

  // Overall summary
  const allGraduating = allResults.filter((r) => r.graduation?.passes);
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  OVERALL SUMMARY                            ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Total combinations tested: ${allResults.length}`);
  console.log(`  Graduating:                ${allGraduating.length}`);

  if (allGraduating.length > 0) {
    console.log(`\n  Graduating combinations:`);
    for (const r of allGraduating.sort((a, b) => b.metrics.sharpe_ratio - a.metrics.sharpe_ratio)) {
      const sp = r.sweepParams;
      const m = r.metrics;
      console.log(`    ✓ ${r.pair} | TL=${sp.timeLimitHours}h TP=${sp.takeProfitPct}% SL=${sp.stopLossPct}% C=${sp.confidenceThreshold} | ${m.total_trades} trades, ${(m.hit_rate*100).toFixed(1)}% hit, ${m.avg_pnl_bps.toFixed(1)}bps avg, Sharpe ${m.sharpe_ratio.toFixed(2)}`);
    }
  } else {
    // Show how close the best ones got
    const best = allResults.sort((a, b) => (b.metrics.sharpe_ratio || -999) - (a.metrics.sharpe_ratio || -999)).slice(0, 5);
    console.log(`\n  Closest to graduation:`);
    for (const r of best) {
      const sp = r.sweepParams;
      const m = r.metrics;
      const g = r.graduation?.criteria || {};
      const passing = Object.values(g).filter((c) => c.actual).length;
      const total = Object.values(g).length;
      console.log(`    ${r.pair} | TL=${sp.timeLimitHours}h TP=${sp.takeProfitPct}% SL=${sp.stopLossPct}% C=${sp.confidenceThreshold} | Sharpe ${m.sharpe_ratio.toFixed(2)}, ${passing}/${total} criteria`);
    }
  }

  console.log();
}

async function main() {
  const options = parseArgs();
  const pairs = options.pair ? [options.pair] : config.pairs.filter((p) => p !== "AERO/USDC"); // Brief focuses on cbBTC and ETH

  // Ensure DB is up to date
  await runMigrations();

  const allResults = await runSweep(pairs, options.top);
  printResults(allResults, options.top);

  process.exit(0);
}

main().catch((e) => {
  logger.fatal({ err: e.message }, "Sweep runner crashed");
  console.error(e);
  process.exit(1);
});
