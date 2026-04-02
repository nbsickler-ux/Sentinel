// ============================================================
// ARBITRAGE MONITOR
// CEX/DEX price spread for cbBTC/USDC.
// Tracks spread history and threshold alerts.
// ============================================================

import { createSignal, clampConfidence } from "./schema.js";
import { cacheGet } from "../cache/redis.js";
import { saveArbObservation } from "../db/queries.js";
import logger from "../logger.js";

// Spread history (in-memory, rolling)
const spreadHistory = [];
const MAX_SPREAD_POINTS = 200;

// Threshold for actionable spread (in basis points)
const ALERT_THRESHOLD_BPS = 50;   // 0.5%
const STRONG_THRESHOLD_BPS = 100; // 1.0%

/**
 * Get CEX price from Coinbase cache.
 */
async function getCexPrice(pair) {
  const data = await cacheGet(`ma:price:coinbase:${pair}`);
  return data?.data?.price || null;
}

/**
 * Get DEX price from Aerodrome cache.
 */
async function getDexPrice(pair) {
  const data = await cacheGet(`ma:pool:aerodrome:${pair}`);
  // token1_price gives the price of token0 in terms of token1
  return data?.data?.token1_price || null;
}

/**
 * Fallback: get CoinGecko price as CEX proxy when Coinbase unavailable.
 */
async function getFallbackPrice(pair) {
  const data = await cacheGet(`ma:price:coingecko:${pair}`);
  return data?.data?.price || null;
}

/**
 * Generate arbitrage signal for a pair.
 * Primary use case: cbBTC/USDC CEX vs DEX spread.
 *
 * @param {string} pair - Trading pair identifier
 * @param {Object} [inputPrices] - Optional { cexPrice, dexPrice } for backtesting (Phase 2).
 *                                  If omitted, reads from Redis cache.
 * @param {Object[]} [inputHistory] - Optional spread history array for backtesting.
 *                                     If omitted, uses module-level spreadHistory.
 * @param {number} [cycle] - Current cycle number for persistence.
 */
export async function analyze(pair, inputPrices, inputHistory, cycle) {
  const history = inputHistory || spreadHistory;

  // Get both price sources
  let cexPrice = inputPrices?.cexPrice ?? await getCexPrice(pair);
  let dexPrice = inputPrices?.dexPrice ?? await getDexPrice(pair);

  // Fallback to CoinGecko if Coinbase not available
  if (!cexPrice) {
    cexPrice = await getFallbackPrice(pair);
  }

  if (!cexPrice || !dexPrice) {
    logger.debug({
      module: "arbitrage",
      pair,
      cex: cexPrice ? "ok" : "missing",
      dex: dexPrice ? "ok" : "missing",
    }, "Insufficient price data for arb analysis");
    return null;
  }

  // Compute spread
  const spread = cexPrice - dexPrice;
  const spreadBps = (spread / cexPrice) * 10000;
  const absSpreadBps = Math.abs(spreadBps);

  // Record history (in-memory rolling window)
  history.push({
    pair,
    cexPrice,
    dexPrice,
    spreadBps,
    timestamp: Date.now(),
  });
  if (history.length > MAX_SPREAD_POINTS) {
    history.splice(0, history.length - MAX_SPREAD_POINTS);
  }

  // Persist to Postgres for Phase 2 backtesting (non-blocking)
  saveArbObservation(cycle, { pair, cexPrice, dexPrice, spreadBps }).catch((e) => {
    logger.debug({ module: "arbitrage", pair, err: e.message }, "Arb observation persistence failed");
  });

  // Historical spread stats
  const recentSpreads = history.slice(-50).map((s) => s.spreadBps);
  const avgSpread = recentSpreads.reduce((a, b) => a + b, 0) / recentSpreads.length;
  const maxSpread = Math.max(...recentSpreads.map(Math.abs));

  // Direction: positive spread = CEX > DEX (buy DEX, sell CEX)
  //            negative spread = DEX > CEX (buy CEX, sell DEX)
  let direction = "neutral";
  let confidence = 0;

  if (absSpreadBps >= STRONG_THRESHOLD_BPS) {
    direction = spreadBps > 0 ? "long" : "short"; // Long DEX (buy cheap side)
    confidence = clampConfidence(absSpreadBps / 200);
  } else if (absSpreadBps >= ALERT_THRESHOLD_BPS) {
    direction = spreadBps > 0 ? "long" : "short";
    confidence = clampConfidence(absSpreadBps / 300);
  }

  const regime = absSpreadBps > STRONG_THRESHOLD_BPS ? "trending_up" : "ranging";

  const thesis = absSpreadBps < ALERT_THRESHOLD_BPS
    ? `${pair}: CEX/DEX spread tight at ${spreadBps.toFixed(1)}bps. No arb opportunity.`
    : `${pair}: ${absSpreadBps >= STRONG_THRESHOLD_BPS ? "STRONG" : ""} arb signal. Spread ${spreadBps.toFixed(1)}bps (CEX $${cexPrice.toFixed(2)} vs DEX $${dexPrice.toFixed(2)}). ${spreadBps > 0 ? "Buy DEX" : "Buy CEX"}.`;

  return createSignal({
    type: "arbitrage",
    pair,
    direction,
    confidence,
    regime,
    indicators: {
      cex_price: cexPrice,
      dex_price: dexPrice,
      spread_usd: spread,
      spread_bps: spreadBps,
      avg_spread_bps: avgSpread,
      max_spread_bps: maxSpread,
      spread_history_count: history.length,
    },
    thesis,
  });
}

export { spreadHistory };
