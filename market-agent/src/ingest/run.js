/**
 * Standalone ingestion runner.
 * Usage: node src/ingest/run.js
 *
 * Runs one full ingestion cycle and prints summary.
 * Useful for testing / cron jobs.
 */
import { runAll } from "./index.js";
import logger from "../logger.js";

async function main() {
  logger.info("Starting manual ingestion cycle...");
  const { summary } = await runAll();

  console.log("\n--- Ingestion Summary ---");
  console.log(`Total data points: ${summary.total}`);
  console.log(`Duration: ${summary.duration_ms}ms`);
  console.log("\nBy source:");
  for (const [source, info] of Object.entries(summary.bySource)) {
    const status = info.status === "ok" ? `${info.count} points` : `ERROR: ${info.error}`;
    console.log(`  ${source.padEnd(12)} ${status} (${info.latency_ms}ms)`);
  }

  if (summary.errors.length > 0) {
    console.log(`\n${summary.errors.length} source(s) had errors.`);
  }

  process.exit(summary.errors.length > 0 ? 1 : 0);
}

main().catch((e) => {
  logger.fatal({ err: e.message }, "Ingestion runner crashed");
  process.exit(1);
});
