// ============================================================
// COINBASE PUBLIC CANDLES BACKFILL
// Uses the public Exchange API (no auth) for BTC-USD and ETH-USD.
// Max 300 candles per request. Paginate by sliding time window.
// Rate limit: 10 req/sec.
// ============================================================

import axios from "axios";
import logger from "../logger.js";

const BASE_URL = "https://api.exchange.coinbase.com/products";

// Map our pairs to Coinbase Exchange product IDs
// Note: Coinbase Exchange uses BTC-USD not BTC-USDC for public candles
const PRODUCT_MAP = {
  "cbBTC/USDC": "BTC-USD",
  "ETH/USDC": "ETH-USD",
  // AERO not available on Coinbase Exchange — use CoinGecko
};

/**
 * Fetch candles for a product in a time range.
 * Returns array of { timestamp, open, high, low, close, volume }.
 *
 * @param {string} productId - Coinbase product ID (e.g., "BTC-USD")
 * @param {number} granularity - Candle size in seconds (3600 = 1h)
 * @param {Date} start - Range start
 * @param {Date} end - Range end
 */
async function fetchCandles(productId, granularity, start, end) {
  const { data } = await axios.get(`${BASE_URL}/${productId}/candles`, {
    params: {
      granularity,
      start: start.toISOString(),
      end: end.toISOString(),
    },
    timeout: 10000,
  });

  // Coinbase returns [timestamp, low, high, open, close, volume] in DESC order
  return (data || []).map(([ts, low, high, open, close, volume]) => ({
    timestamp: new Date(ts * 1000),
    open,
    high,
    low,
    close,
    volume,
  }));
}

/**
 * Backfill candles for a pair over a date range.
 * Paginates in chunks of 300 candles.
 *
 * @param {string} pair - Our pair name (e.g., "cbBTC/USDC")
 * @param {number} months - How many months of history
 * @param {number} [granularity=3600] - Candle size in seconds
 * @returns {AsyncGenerator} Yields arrays of candle objects
 */
export async function* backfill(pair, months = 3, granularity = 3600) {
  const productId = PRODUCT_MAP[pair];
  if (!productId) {
    logger.info({ module: "backfill:coinbase", pair }, "No Coinbase product — skipping");
    return;
  }

  const now = new Date();
  const start = new Date(now);
  start.setMonth(start.getMonth() - months);

  // Chunk size: 300 candles * granularity seconds
  const chunkMs = 300 * granularity * 1000;
  let windowStart = start;
  let totalCandles = 0;

  logger.info({
    module: "backfill:coinbase",
    pair,
    product: productId,
    from: start.toISOString(),
    to: now.toISOString(),
    granularity,
  }, "Starting Coinbase backfill");

  while (windowStart < now) {
    const windowEnd = new Date(Math.min(windowStart.getTime() + chunkMs, now.getTime()));

    try {
      const candles = await fetchCandles(productId, granularity, windowStart, windowEnd);

      if (candles.length > 0) {
        totalCandles += candles.length;
        yield candles.map((c) => ({
          source: "coinbase",
          pair,
          timestamp: c.timestamp,
          price: c.close, // Use close price as the reference
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));

        logger.debug({
          module: "backfill:coinbase",
          pair,
          chunk: `${windowStart.toISOString().slice(0, 10)} → ${windowEnd.toISOString().slice(0, 10)}`,
          candles: candles.length,
          total: totalCandles,
        }, "Chunk fetched");
      }
    } catch (e) {
      logger.error({
        module: "backfill:coinbase",
        pair,
        err: e.message,
        window: windowStart.toISOString(),
      }, "Chunk failed — continuing");
    }

    windowStart = windowEnd;

    // Rate limit: ~5 req/sec to stay well under 10/sec limit
    await new Promise((r) => setTimeout(r, 200));
  }

  logger.info({
    module: "backfill:coinbase",
    pair,
    totalCandles,
  }, "Coinbase backfill complete");
}
