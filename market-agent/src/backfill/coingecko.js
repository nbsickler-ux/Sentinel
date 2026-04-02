// ============================================================
// COINGECKO HISTORICAL BACKFILL
// Uses /coins/{id}/market_chart/range for 90-day hourly data.
// Free/demo tier: 30 calls/min, 500ms between calls.
// ============================================================

import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";

const BASE_URL = !config.coingecko.apiKey
  ? "https://api.coingecko.com/api/v3"
  : config.coingecko.apiKey.startsWith("CG-")
  ? "https://api.coingecko.com/api/v3"
  : "https://pro-api.coingecko.com/api/v3";

function getHeaders() {
  if (!config.coingecko.apiKey) return {};
  const headerName = config.coingecko.apiKey.startsWith("CG-")
    ? "x-cg-demo-api-key"
    : "x-cg-pro-api-key";
  return { [headerName]: config.coingecko.apiKey };
}

// Reuse IDs from ingest/coingecko.js
const COINGECKO_IDS = {
  cbBTC: "coinbase-wrapped-btc",
  ETH: "ethereum",
  AERO: "aerodrome-finance",
};

/**
 * Backfill price history for a pair.
 * CoinGecko auto-selects granularity: hourly for 1-90 days, daily beyond.
 *
 * @param {string} pair - Our pair name
 * @param {number} months - How many months of history
 * @returns {AsyncGenerator} Yields arrays of price points
 */
export async function* backfill(pair, months = 3) {
  const baseToken = pair.split("/")[0];
  const cgId = COINGECKO_IDS[baseToken];
  if (!cgId) {
    logger.info({ module: "backfill:coingecko", pair }, "No CoinGecko ID — skipping");
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const from = now - months * 30 * 24 * 3600;

  logger.info({
    module: "backfill:coingecko",
    pair,
    token: baseToken,
    cgId,
    from: new Date(from * 1000).toISOString(),
  }, "Starting CoinGecko backfill");

  try {
    const { data } = await axios.get(`${BASE_URL}/coins/${cgId}/market_chart/range`, {
      params: {
        vs_currency: "usd",
        from,
        to: now,
      },
      headers: getHeaders(),
      timeout: 30000,
    });

    const prices = data?.prices || [];
    const volumes = data?.total_volumes || [];

    // Build volume lookup (timestamp → volume)
    const volumeMap = new Map();
    for (const [ts, vol] of volumes) {
      volumeMap.set(ts, vol);
    }

    const points = prices.map(([ts, price]) => ({
      source: "coingecko",
      pair,
      timestamp: new Date(ts),
      price,
      volume: volumeMap.get(ts) || 0,
    }));

    logger.info({
      module: "backfill:coingecko",
      pair,
      points: points.length,
      granularity: points.length > 2000 ? "~5min" : points.length > 200 ? "hourly" : "daily",
    }, "CoinGecko backfill complete");

    // Yield in chunks of 500 for manageable DB batches
    for (let i = 0; i < points.length; i += 500) {
      yield points.slice(i, i + 500);
    }
  } catch (e) {
    logger.error({
      module: "backfill:coingecko",
      pair,
      err: e.message,
    }, "CoinGecko backfill failed");
  }
}
