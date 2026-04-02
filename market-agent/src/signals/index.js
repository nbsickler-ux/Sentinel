// ============================================================
// SIGNAL ENGINE ORCHESTRATOR
// Runs all signal modules per pair, produces composites.
// ============================================================

import config from "../config.js";
import logger from "../logger.js";
import * as trend from "./trend.js";
import * as reversion from "./reversion.js";
import { computeComposite } from "./scorer.js";
import { ingestDataPoints } from "./history.js";

// Sync signal modules (pure functions over price history)
// REMOVED (2026-04-02): volatility, arbitrage, onchain modules
// These signals are disconnected from the pipeline but retained for independent testing.
const syncModules = [
  { name: "trend", module: trend },
  { name: "reversion", module: reversion },
];

// Async signal modules (read from Redis cache)
// REMOVED (2026-04-02): arbitrage, onchain modules
// These signals are disconnected from the pipeline but retained for independent testing.
const asyncModules = [];

/**
 * Run all signal engines for all pairs.
 * Call this after each ingestion cycle.
 *
 * @param {Object[]} dataPoints - DataPoints from latest ingestion
 * @param {Object} [options] - Optional config: { cycle }
 * @returns {Object} { composites: [...], signals: [...], summary }
 */
export async function runAll(dataPoints = [], options = {}) {
  const start = Date.now();

  // Feed new data into price history
  ingestDataPoints(dataPoints);

  const allSignals = [];
  const composites = [];

  for (const pair of config.pairs) {
    const pairSignals = [];

    // Run sync modules
    for (const { name, module } of syncModules) {
      try {
        const signal = module.analyze(pair);
        if (signal) {
          pairSignals.push(signal);
          allSignals.push(signal);
        }
      } catch (e) {
        logger.error({ module: name, pair, err: e.message }, "Signal generation failed");
      }
    }

    // Run async modules
    for (const { name, module } of asyncModules) {
      try {
        const signal = await module.analyze(pair, undefined, undefined, options.cycle);
        if (signal) {
          pairSignals.push(signal);
          allSignals.push(signal);
        }
      } catch (e) {
        logger.error({ module: name, pair, err: e.message }, "Signal generation failed");
      }
    }

    // Composite score
    const composite = computeComposite(pair, pairSignals);
    composites.push(composite);
  }

  const summary = {
    pairs: composites.length,
    total_signals: allSignals.length,
    duration_ms: Date.now() - start,
    composites: composites.map((c) => ({
      pair: c.pair,
      direction: c.direction,
      confidence: c.composite_confidence,
      agreement: c.agreement_ratio,
      regime: c.regime,
      signal_count: c.signal_count,
    })),
  };

  logger.info({ module: "signals", ...summary }, "Signal cycle complete");
  return { composites, signals: allSignals, summary };
}
