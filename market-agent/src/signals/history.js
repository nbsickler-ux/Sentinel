// ============================================================
// PRICE HISTORY BUFFER
// In-memory rolling window of price data per pair.
// Signal engines read from this to compute indicators.
// Phase 2 replaces this with Postgres historical data.
// ============================================================

const MAX_POINTS = 500; // ~8 hours at 1min intervals

// { "cbBTC/USDC": [{ price, volume, timestamp }, ...] }
const history = {};

/**
 * Record a price observation.
 */
export function record(pair, { price, volume = 0, timestamp = Date.now() }) {
  if (!history[pair]) history[pair] = [];
  history[pair].push({ price, volume, timestamp });

  // Trim to max window
  if (history[pair].length > MAX_POINTS) {
    history[pair] = history[pair].slice(-MAX_POINTS);
  }
}

/**
 * Get price history for a pair.
 * @param {string} pair
 * @param {number} [count] - Number of recent points (default: all)
 * @returns {Array} Price observations, oldest first
 */
export function get(pair, count) {
  const data = history[pair] || [];
  if (count && count < data.length) {
    return data.slice(-count);
  }
  return [...data];
}

/**
 * Get just the price values as an array.
 */
export function prices(pair, count) {
  return get(pair, count).map((p) => p.price);
}

/**
 * Get the latest price for a pair.
 */
export function latest(pair) {
  const data = history[pair];
  return data && data.length > 0 ? data[data.length - 1] : null;
}

/**
 * How many data points we have for a pair.
 */
export function count(pair) {
  return (history[pair] || []).length;
}

/**
 * Seed history from ingestion DataPoints.
 * Call this after each ingestion cycle.
 */
export function ingestDataPoints(dataPoints) {
  for (const dp of dataPoints) {
    if (dp.type === "price" && dp.pair && dp.data.price) {
      record(dp.pair, {
        price: dp.data.price,
        volume: dp.data.volume_24h || 0,
        timestamp: dp.timestamp,
      });
    }
    // Pool data also carries implied prices
    if (dp.type === "pool" && dp.pair && dp.data.token1_price) {
      record(dp.pair, {
        price: dp.data.token1_price,
        volume: dp.data.volume_24h || 0,
        timestamp: dp.timestamp,
      });
    }
  }
}

export { history };
