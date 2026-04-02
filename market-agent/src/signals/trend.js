// ============================================================
// TREND DETECTION
// Multi-timeframe momentum, EMA crossovers, regime ID.
// Pure function: deterministic given same price history.
// ============================================================

import { createSignal, clampConfidence } from "./schema.js";
import * as history from "./history.js";
import logger from "../logger.js";

/**
 * Compute Exponential Moving Average.
 */
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

/**
 * Compute Simple Moving Average.
 */
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Rate of change over N periods (momentum).
 */
function roc(values, period) {
  if (values.length < period + 1) return null;
  const current = values[values.length - 1];
  const past = values[values.length - 1 - period];
  return past !== 0 ? (current - past) / past : 0;
}

/**
 * Generate trend signal for a pair.
 * @param {string} pair - Trading pair identifier
 * @param {number[]} [inputPrices] - Optional price array. If omitted, reads from history buffer.
 *                                    Pass explicitly for backtesting (Phase 2).
 */
export function analyze(pair, inputPrices) {
  const priceData = inputPrices || history.prices(pair);

  if (priceData.length < 26) {
    logger.debug({ module: "trend", pair, points: priceData.length }, "Insufficient data (need 26+)");
    return null;
  }

  const price = priceData[priceData.length - 1];

  // EMA crossovers
  const ema9 = ema(priceData, 9);
  const ema21 = ema(priceData, 21);
  const sma50 = sma(priceData, Math.min(50, priceData.length));

  // Momentum at multiple timeframes
  const roc5 = roc(priceData, 5);
  const roc10 = roc(priceData, 10);
  const roc20 = roc(priceData, Math.min(20, priceData.length - 1));

  // EMA crossover signal: fast above slow = bullish
  const emaCrossover = ema9 && ema21 ? (ema9 - ema21) / ema21 : 0;

  // Price vs SMA50: above = bullish trend
  const priceVsSma = sma50 ? (price - sma50) / sma50 : 0;

  // Regime identification
  let regime = "ranging";
  const absEmaCross = Math.abs(emaCrossover);
  if (absEmaCross > 0.01 && roc10 > 0.02) regime = "trending_up";
  else if (absEmaCross > 0.01 && roc10 < -0.02) regime = "trending_down";
  else if (absEmaCross > 0.005) regime = "transitioning";

  // Direction from combined signals
  let bullishScore = 0;
  let bearishScore = 0;

  if (emaCrossover > 0) bullishScore += 0.3; else bearishScore += 0.3;
  if (priceVsSma > 0) bullishScore += 0.2; else bearishScore += 0.2;
  if (roc5 > 0) bullishScore += 0.2; else bearishScore += 0.2;
  if (roc10 > 0) bullishScore += 0.15; else bearishScore += 0.15;
  if (roc20 > 0) bullishScore += 0.15; else bearishScore += 0.15;

  const netScore = bullishScore - bearishScore;
  let direction = "neutral";
  if (netScore > 0.1) direction = "long";
  if (netScore < -0.1) direction = "short";

  // Confidence based on signal alignment strength
  const confidence = clampConfidence(Math.abs(netScore) * 1.5);

  const thesis = direction === "neutral"
    ? `${pair}: No clear trend. EMA9/21 spread ${(emaCrossover * 100).toFixed(2)}%, regime: ${regime}.`
    : `${pair}: ${direction.toUpperCase()} trend. EMA crossover ${(emaCrossover * 100).toFixed(2)}%, ROC(10) ${(roc10 * 100).toFixed(2)}%, price ${priceVsSma > 0 ? "above" : "below"} SMA50.`;

  return createSignal({
    type: "trend",
    pair,
    direction,
    confidence,
    regime,
    indicators: {
      price,
      ema9,
      ema21,
      sma50,
      ema_crossover_pct: emaCrossover * 100,
      roc5: roc5 * 100,
      roc10: roc10 * 100,
      roc20: roc20 * 100,
      price_vs_sma50_pct: priceVsSma * 100,
    },
    thesis,
  });
}
