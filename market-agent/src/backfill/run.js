#!/usr/bin/env node
// ============================================================
// BACKFILL CLI
// Usage: node src/backfill/run.js [--months=3] [--sources=coinbase,coingecko]
// ============================================================

import { runBackfill } from "./index.js";
import logger from "../logger.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (const arg of args) {
    if (arg.startsWith("--months=")) {
      options.months = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--sources=")) {
      options.sources = arg.split("=")[1].split(",");
    } else if (arg.startsWith("--pairs=")) {
      options.pairs = arg.split("=")[1].split(",");
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  MARKET AGENT — Historical Data Backfill    ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();
  console.log(`  Months:  ${options.months || 3}`);
  console.log(`  Sources: ${(options.sources || ["coinbase", "coingecko", "fred", "aerodrome"]).join(", ")}`);
  console.log(`  Pairs:   ${(options.pairs || ["cbBTC/USDC", "ETH/USDC", "AERO/USDC"]).join(", ")}`);
  console.log();

  const summary = await runBackfill(options);

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  BACKFILL SUMMARY                           ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();
  console.log(`  Total rows written:    ${summary.totalRows}`);
  console.log(`  Arb observations:      ${summary.arbObservations}`);
  console.log(`  Duration:              ${(summary.duration_ms / 1000).toFixed(1)}s`);
  console.log();
  console.log("  By source:");
  for (const [source, count] of Object.entries(summary.sources)) {
    console.log(`    ${source.padEnd(25)} ${count} rows`);
  }
  console.log();

  process.exit(0);
}

main().catch((e) => {
  logger.fatal({ err: e.message }, "Backfill runner crashed");
  console.error(e);
  process.exit(1);
});
