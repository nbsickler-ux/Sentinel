// ============================================================
// BACKFILL ORCHESTRATOR
// Pulls historical data from all sources and writes to Postgres.
// Idempotent: uses ON CONFLICT / timestamp range checks.
// Resumable: tracks last backfilled timestamp per source/pair.
// ============================================================

import { pool } from "../db/schema.js";
import { runMigrations } from "../db/migrate.js";
import logger from "../logger.js";
import config from "../config.js";
import * as coinbaseBf from "./coinbase.js";
import * as coingeckoBf from "./coingecko.js";
import * as fredBf from "./fred.js";
import * as aerodromeBf from "./aerodrome.js";

/**
 * Ensure the historical_prices table exists for backfill data.
 * This is separate from arb_observations — it stores raw price series
 * that get matched into arb observations during the merge step.
 */
async function ensureBackfillTables() {
  if (!pool) throw new Error("DATABASE_URL not set");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS historical_prices (
      id SERIAL PRIMARY KEY,
      source VARCHAR(30) NOT NULL,
      pair VARCHAR(20),
      timestamp TIMESTAMPTZ NOT NULL,
      price NUMERIC NOT NULL,
      open_price NUMERIC,
      high_price NUMERIC,
      low_price NUMERIC,
      close_price NUMERIC,
      volume NUMERIC,
      extra JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source, pair, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_hist_source_pair_ts
      ON historical_prices(source, pair, timestamp);

    CREATE TABLE IF NOT EXISTS historical_macro (
      id SERIAL PRIMARY KEY,
      series_id VARCHAR(20) NOT NULL,
      indicator VARCHAR(100),
      timestamp TIMESTAMPTZ NOT NULL,
      value NUMERIC NOT NULL,
      unit VARCHAR(20),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(series_id, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_hist_macro_ts
      ON historical_macro(series_id, timestamp);
  `);

  logger.info({ module: "backfill" }, "Backfill tables ready");
}

/**
 * Get the last backfilled timestamp for a source/pair.
 */
async function getLastTimestamp(source, pair) {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT MAX(timestamp) as last_ts FROM historical_prices WHERE source = $1 AND pair = $2`,
    [source, pair]
  );
  return result.rows[0]?.last_ts ? new Date(result.rows[0].last_ts) : null;
}

/**
 * Write price points to historical_prices.
 * Uses ON CONFLICT to skip duplicates (idempotent).
 */
async function writePricePoints(points) {
  if (!pool || points.length === 0) return 0;

  let written = 0;
  for (const p of points) {
    try {
      await pool.query(
        `INSERT INTO historical_prices (source, pair, timestamp, price, open_price, high_price, low_price, close_price, volume, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (source, pair, timestamp) DO NOTHING`,
        [
          p.source, p.pair, p.timestamp, p.price,
          p.open || null, p.high || null, p.low || null, p.close || null,
          p.volume || null,
          p.tvl || p.fees ? JSON.stringify({ tvl: p.tvl, fees: p.fees, token0Price: p.token0Price, token1Price: p.token1Price }) : null,
        ]
      );
      written++;
    } catch (e) {
      // Skip individual write errors (constraint violations, etc.)
    }
  }
  return written;
}

/**
 * Write macro data to historical_macro.
 */
async function writeMacroPoints(points) {
  if (!pool || points.length === 0) return 0;

  let written = 0;
  for (const p of points) {
    try {
      await pool.query(
        `INSERT INTO historical_macro (series_id, indicator, timestamp, value, unit)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (series_id, timestamp) DO NOTHING`,
        [p.series_id, p.indicator, p.timestamp, p.value, p.unit]
      );
      written++;
    } catch (e) {
      // Skip duplicates
    }
  }
  return written;
}

/**
 * After prices are loaded, generate arb_observations by matching
 * CEX (Coinbase) and DEX (Aerodrome) prices at the same timestamps.
 */
async function generateArbObservations(pair) {
  if (!pool) return 0;

  // Match CEX and DEX prices within the same day
  // (Aerodrome data is daily, Coinbase is hourly — use daily close-to-close)
  const result = await pool.query(`
    INSERT INTO arb_observations (cycle, timestamp, pair, cex_price, dex_price, spread_bps, signal_fired, signal_strength)
    SELECT
      NULL as cycle,
      cex.timestamp,
      $1 as pair,
      cex.price as cex_price,
      dex.price as dex_price,
      ((cex.price - dex.price) / cex.price * 10000) as spread_bps,
      ABS((cex.price - dex.price) / cex.price * 10000) >= 50 as signal_fired,
      CASE
        WHEN ABS((cex.price - dex.price) / cex.price * 10000) >= 100 THEN 'strong'
        WHEN ABS((cex.price - dex.price) / cex.price * 10000) >= 50 THEN 'alert'
        ELSE NULL
      END as signal_strength
    FROM historical_prices cex
    INNER JOIN historical_prices dex
      ON DATE_TRUNC('day', cex.timestamp) = DATE_TRUNC('day', dex.timestamp)
      AND dex.source = 'aerodrome'
      AND dex.pair = $1
    WHERE cex.source = 'coinbase'
      AND cex.pair = $1
      -- Only use one CEX price per day (noon or closest)
      AND EXTRACT(HOUR FROM cex.timestamp) = 12
    ON CONFLICT DO NOTHING
  `, [pair]);

  return result.rowCount || 0;
}

/**
 * Run the full backfill pipeline.
 *
 * @param {Object} options
 * @param {number} options.months - Months of history (default: 3)
 * @param {string[]} options.sources - Sources to run (default: all)
 * @param {string[]} options.pairs - Pairs to backfill (default: config.pairs)
 */
export async function runBackfill(options = {}) {
  const months = options.months || 3;
  const sources = options.sources || ["coinbase", "coingecko", "fred", "aerodrome"];
  const pairs = options.pairs || config.pairs;

  logger.info({
    module: "backfill",
    months,
    sources,
    pairs,
  }, "Starting backfill");

  // Ensure all migrations are applied (creates arb_observations, etc.)
  await runMigrations();
  await ensureBackfillTables();

  const summary = { sources: {}, totalRows: 0, startedAt: Date.now() };

  // Step 1: Coinbase (CEX prices for BTC and ETH)
  if (sources.includes("coinbase")) {
    for (const pair of pairs) {
      const last = await getLastTimestamp("coinbase", pair);
      if (last) logger.info({ module: "backfill", source: "coinbase", pair, resumeFrom: last }, "Resuming from last timestamp");

      let count = 0;
      for await (const chunk of coinbaseBf.backfill(pair, months)) {
        const filtered = last ? chunk.filter((p) => p.timestamp > last) : chunk;
        count += await writePricePoints(filtered);
      }
      summary.sources[`coinbase:${pair}`] = count;
      summary.totalRows += count;
      logger.info({ module: "backfill", source: "coinbase", pair, rows: count }, "Source complete");
    }
  }

  // Step 2: CoinGecko (all tokens, especially AERO)
  if (sources.includes("coingecko")) {
    for (const pair of pairs) {
      const last = await getLastTimestamp("coingecko", pair);
      let count = 0;
      for await (const chunk of coingeckoBf.backfill(pair, months)) {
        const filtered = last ? chunk.filter((p) => p.timestamp > last) : chunk;
        count += await writePricePoints(filtered);
      }
      summary.sources[`coingecko:${pair}`] = count;
      summary.totalRows += count;
      logger.info({ module: "backfill", source: "coingecko", pair, rows: count }, "Source complete");

      // Rate limit between tokens
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Step 3: FRED (macro indicators)
  if (sources.includes("fred")) {
    let count = 0;
    for await (const chunk of fredBf.backfill(months > 6 ? 12 : months)) {
      count += await writeMacroPoints(chunk);
    }
    summary.sources["fred"] = count;
    summary.totalRows += count;
    logger.info({ module: "backfill", source: "fred", rows: count }, "Source complete");
  }

  // Step 4: Aerodrome (DEX prices)
  if (sources.includes("aerodrome")) {
    for (const pair of pairs) {
      const last = await getLastTimestamp("aerodrome", pair);
      let count = 0;
      for await (const chunk of aerodromeBf.backfill(pair, months)) {
        const filtered = last ? chunk.filter((p) => p.timestamp > last) : chunk;
        count += await writePricePoints(filtered);
      }
      summary.sources[`aerodrome:${pair}`] = count;
      summary.totalRows += count;
      logger.info({ module: "backfill", source: "aerodrome", pair, rows: count }, "Source complete");
    }
  }

  // Step 5: Generate arb observations from matched CEX/DEX prices
  logger.info({ module: "backfill" }, "Generating arb observations from matched prices...");
  let arbTotal = 0;
  for (const pair of pairs) {
    const arbCount = await generateArbObservations(pair);
    arbTotal += arbCount;
    logger.info({ module: "backfill", pair, arbObservations: arbCount }, "Arb observations generated");
  }
  summary.arbObservations = arbTotal;

  summary.duration_ms = Date.now() - summary.startedAt;

  logger.info({
    module: "backfill",
    totalRows: summary.totalRows,
    arbObservations: arbTotal,
    duration_ms: summary.duration_ms,
  }, "Backfill complete");

  return summary;
}
