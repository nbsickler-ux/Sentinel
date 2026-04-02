#!/usr/bin/env node
// ============================================================
// BACKTEST CLI
// Usage: node src/backtest/run.js [--pair=cbBTC/USDC] [--signal=arb]
//        [--months=3] [--position=1000]
// ============================================================

import { initSchema } from "../db/schema.js";
import { runMigrations } from "../db/migrate.js";
import { getDateRange } from "./loader.js";
import { backtestArb, backtestDirectional, saveResults } from "./harness.js";
import { checkGraduation } from "./metrics.js";
import config from "../config.js";
import logger from "../logger.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (const arg of args) {
    if (arg.startsWith("--pair=")) options.pair = arg.split("=")[1];
    else if (arg.startsWith("--signal=")) options.signal = arg.split("=")[1];
    else if (arg.startsWith("--months=")) options.months = parseInt(arg.split("=")[1], 10);
    else if (arg.startsWith("--position=")) options.positionSizeUsd = parseInt(arg.split("=")[1], 10);
  }

  return options;
}

function printMetrics(result) {
  const m = result.metrics;
  const g = result.graduation;

  console.log(`\n  ┌──────────────────────────────────────────────┐`);
  console.log(`  │ ${result.pair} — ${result.signalType.toUpperCase()}`);
  console.log(`  └──────────────────────────────────────────────┘`);
  console.log(`  Trades:        ${m.total_trades} (${m.winning_trades}W / ${m.losing_trades}L)`);
  console.log(`  Hit Rate:      ${(m.hit_rate * 100).toFixed(1)}%`);
  console.log(`  Avg P&L:       ${m.avg_pnl_bps.toFixed(1)} bps`);
  console.log(`  Total P&L:     ${m.total_pnl_bps.toFixed(1)} bps`);
  console.log(`  Sharpe:        ${m.sharpe_ratio.toFixed(2)}`);
  console.log(`  Max Drawdown:  ${m.max_drawdown_pct.toFixed(1)}%`);
  console.log(`  Profit Factor: ${m.profit_factor.toFixed(2)}`);
  console.log(`  Avg Hold:      ${m.avg_hold_time_min} min`);
  console.log(`  Avg Win:       ${m.avg_win_bps.toFixed(1)} bps`);
  console.log(`  Avg Loss:      ${m.avg_loss_bps.toFixed(1)} bps`);

  console.log(`\n  Exit Reasons:`);
  for (const [reason, count] of Object.entries(m.exit_reasons)) {
    console.log(`    ${reason.padEnd(15)} ${count} (${(count / m.total_trades * 100).toFixed(0)}%)`);
  }

  console.log(`\n  Graduation: ${g.passes ? "✓ PASSES" : "✗ FAILS"}`);
  for (const [name, c] of Object.entries(g.criteria)) {
    const icon = c.actual ? "✓" : "✗";
    console.log(`    ${icon} ${name.padEnd(25)} ${typeof c.value === "number" ? c.value.toFixed(2) : c.value}`);
  }
}

async function main() {
  const options = parseArgs();
  const pairs = options.pair ? [options.pair] : config.pairs;
  const signal = options.signal || "all"; // "arb", "directional", or "all"

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  MARKET AGENT — Backtesting Harness         ║");
  console.log("╚══════════════════════════════════════════════╝");

  // Ensure DB is up to date
  await runMigrations();

  // Show available data
  console.log("\n  Available data:");
  for (const pair of pairs) {
    const ranges = await getDateRange(pair);
    for (const r of ranges) {
      console.log(`    ${pair} [${r.source}]: ${r.earliest.toISOString().slice(0, 10)} → ${r.latest.toISOString().slice(0, 10)} (${r.count} points)`);
    }
    if (ranges.length === 0) {
      console.log(`    ${pair}: No historical data. Run backfill first: node src/backfill/run.js`);
    }
  }

  // Run backtests
  const allResults = [];

  for (const pair of pairs) {
    if (signal === "arb" || signal === "all") {
      const arbResult = await backtestArb(pair, {
        positionSizeUsd: options.positionSizeUsd,
      });
      printMetrics(arbResult);
      const runId = await saveResults(arbResult);
      if (runId) console.log(`  Saved: run_id=${runId}`);
      allResults.push(arbResult);
    }

    if (signal === "directional" || signal === "all") {
      const dirResult = await backtestDirectional(pair, { positionSizePct: 0.5 });
      printMetrics(dirResult);
      const runId = await saveResults(dirResult);
      if (runId) console.log(`  Saved: run_id=${runId}`);
      allResults.push(dirResult);
    }
  }

  // Summary
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  SUMMARY                                    ║");
  console.log("╚══════════════════════════════════════════════╝");

  const graduating = allResults.filter((r) => r.graduation?.passes);
  const failing = allResults.filter((r) => !r.graduation?.passes);

  if (graduating.length > 0) {
    console.log(`\n  Graduating signals (${graduating.length}):`);
    for (const r of graduating) {
      console.log(`    ✓ ${r.pair} / ${r.signalType} — ${r.metrics.total_trades} trades, ${(r.metrics.hit_rate * 100).toFixed(0)}% hit rate, Sharpe ${r.metrics.sharpe_ratio.toFixed(2)}`);
    }
  }

  if (failing.length > 0) {
    console.log(`\n  Failing signals (${failing.length}):`);
    for (const r of failing) {
      console.log(`    ✗ ${r.pair} / ${r.signalType} — ${r.metrics.total_trades} trades, ${(r.metrics.hit_rate * 100).toFixed(0)}% hit rate, Sharpe ${r.metrics.sharpe_ratio.toFixed(2)}`);
    }
  }

  console.log();
  process.exit(0);
}

main().catch((e) => {
  logger.fatal({ err: e.message }, "Backtest runner crashed");
  console.error(e);
  process.exit(1);
});
