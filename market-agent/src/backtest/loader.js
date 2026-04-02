// ============================================================
// HISTORICAL DATA LOADER
// Reads from historical_prices and arb_observations tables.
// Returns time-sorted arrays for the backtesting harness.
// ============================================================

import { pool } from "../db/schema.js";
import logger from "../logger.js";

/**
 * Load historical prices for a pair from a source.
 *
 * @param {string} pair
 * @param {string} source - "coinbase", "coingecko", "aerodrome"
 * @param {Date} [startDate]
 * @param {Date} [endDate]
 * @returns {Object[]} Time-sorted price array
 */
export async function loadPrices(pair, source, startDate, endDate) {
  if (!pool) throw new Error("DATABASE_URL not set");

  let query = `SELECT * FROM historical_prices WHERE pair = $1 AND source = $2`;
  const params = [pair, source];

  if (startDate) {
    params.push(startDate);
    query += ` AND timestamp >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    query += ` AND timestamp <= $${params.length}`;
  }

  query += ` ORDER BY timestamp ASC`;

  const result = await pool.query(query, params);
  logger.info({
    module: "backtest:loader",
    pair,
    source,
    rows: result.rows.length,
  }, "Prices loaded");

  return result.rows.map((r) => ({
    timestamp: new Date(r.timestamp),
    price: parseFloat(r.price),
    open: r.open_price ? parseFloat(r.open_price) : null,
    high: r.high_price ? parseFloat(r.high_price) : null,
    low: r.low_price ? parseFloat(r.low_price) : null,
    close: r.close_price ? parseFloat(r.close_price) : null,
    volume: r.volume ? parseFloat(r.volume) : null,
    extra: r.extra,
  }));
}

/**
 * Load arb observations for a pair.
 */
export async function loadArbObservations(pair, startDate, endDate) {
  if (!pool) throw new Error("DATABASE_URL not set");

  let query = `SELECT * FROM arb_observations WHERE pair = $1`;
  const params = [pair];

  if (startDate) {
    params.push(startDate);
    query += ` AND timestamp >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    query += ` AND timestamp <= $${params.length}`;
  }

  query += ` ORDER BY timestamp ASC`;

  const result = await pool.query(query, params);
  logger.info({
    module: "backtest:loader",
    pair,
    rows: result.rows.length,
  }, "Arb observations loaded");

  return result.rows.map((r) => ({
    timestamp: new Date(r.timestamp),
    cexPrice: parseFloat(r.cex_price),
    dexPrice: parseFloat(r.dex_price),
    spreadBps: parseFloat(r.spread_bps),
    signalFired: r.signal_fired,
    signalStrength: r.signal_strength,
  }));
}

/**
 * Load macro data from FRED historical.
 */
export async function loadMacro(seriesId, startDate, endDate) {
  if (!pool) throw new Error("DATABASE_URL not set");

  let query = `SELECT * FROM historical_macro WHERE series_id = $1`;
  const params = [seriesId];

  if (startDate) {
    params.push(startDate);
    query += ` AND timestamp >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    query += ` AND timestamp <= $${params.length}`;
  }

  query += ` ORDER BY timestamp ASC`;

  const result = await pool.query(query, params);
  return result.rows.map((r) => ({
    timestamp: new Date(r.timestamp),
    value: parseFloat(r.value),
    seriesId: r.series_id,
    indicator: r.indicator,
  }));
}

/**
 * Get the available date range for a pair across sources.
 */
export async function getDateRange(pair) {
  if (!pool) throw new Error("DATABASE_URL not set");

  const result = await pool.query(`
    SELECT
      source,
      MIN(timestamp) as earliest,
      MAX(timestamp) as latest,
      COUNT(*) as count
    FROM historical_prices
    WHERE pair = $1
    GROUP BY source
    ORDER BY source
  `, [pair]);

  return result.rows.map((r) => ({
    source: r.source,
    earliest: new Date(r.earliest),
    latest: new Date(r.latest),
    count: parseInt(r.count),
  }));
}
