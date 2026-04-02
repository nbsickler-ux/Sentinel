// ============================================================
// MEAN REVERSION
// Z-score deviation, Bollinger Bands, statistical extremes.
// Pure function: deterministic given same price history.
// ============================================================

import { createSignal, clampConfidence } from "./schema.js";
import * as history from "./history.js";
import logger from "../logger.js";

/**
 * Compute standard deviation.
 */
function stdDev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * Compute z-score of current price relative to rolling window.
 */
function zScore(values, period) {
  if (values.length < period) return null;
  const window = values.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const sd = stdDev(window);
  if (sd === 0) return 0;
  return (values[values.length - 1] - mean) / sd;
}

/**
 * Compute Bollinger Band position (0 = lower band, 0.5 = middle, 1 = upper).
 */
function bollingerPosition(values, period, numStd = 2) {
  if (values.length < period) return null;
  const window = values.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const sd = stdDev(window);
  if (sd === 0) return 0.5;

  const upper = mean + numStd * sd;
  const lower = mean - numStd * sd;
  if (upper === lower) return 0.5; // Degenerate band — price is at mean
  const price = values[values.length - 1];

  return (price - lower) / (upper - lower);
}

/**
 * Generate mean reversion signal for a pair.
 * @param {string} pair - Trading pair identifier
 * @param {number[]} [inputPrices] - Optional price array. If omitted, reads from history buffer.
 *                                    Pass explicitly for backtesting (Phase 2).
 */
export function analyze(pair, inputPrices) {
  const priceData = inputPrices || history.prices(pair);

  if (priceData.length < 20) {
    logger.debug({ module: "reversion", pair, points: priceData.length }, "Insufficient data (need 20+)");
    return null;
  }

  const price = priceData[priceData.length - 1];

  // Z-scores at multiple windows
  const z20 = zScore(priceData, 20);
  const z50 = zScore(priceData, Math.min(50, priceData.length));

  // Bollinger Band position
  const bbPos20 = bollingerPosition(priceData, 20);
  const bbPos50 = bollingerPosition(priceData, Math.min(50, priceData.length));

  // Mean reversion signal: extreme z-scores suggest reversion
  // z > 2 = overbought (short signal), z < -2 = oversold (long signal)
  const avgZ = z50 !== null ? (z20 + z50) / 2 : z20;

  let direction = "neutral";
  let confidence = 0;

  if (avgZ >= 2) {
    direction = "short"; // Overbought — expect reversion down
    confidence = clampConfidence((Math.abs(avgZ) - 1.5) / 2);
  } else if (avgZ <= -2) {
    direction = "long"; // Oversold — expect reversion up
    confidence = clampConfidence((Math.abs(avgZ) - 1.5) / 2);
  } else if (Math.abs(avgZ) > 1) {
    // Mild signal
    direction = avgZ > 0 ? "short" : "long";
    confidence = clampConfidence((Math.abs(avgZ) - 0.5) / 3);
  }

  // Boost confidence when BB position confirms z-score
  if (bbPos20 !== null) {
    if ((direction === "short" && bbPos20 > 0.9) || (direction === "long" && bbPos20 < 0.1)) {
      confidence = clampConfidence(confidence * 1.3);
    }
  }

  const regime = Math.abs(avgZ) > 2 ? "ranging" : "transitioning";

  const thesis = direction === "neutral"
    ? `${pair}: Z-score ${avgZ.toFixed(2)} — within normal range, no reversion signal.`
    : `${pair}: ${direction === "long" ? "OVERSOLD" : "OVERBOUGHT"}. Z(20)=${z20.toFixed(2)}, BB position ${(bbPos20 * 100).toFixed(0)}%. Expect reversion ${direction === "long" ? "up" : "down"}.`;

  return createSignal({
    type: "reversion",
    pair,
    direction,
    confidence,
    regime,
    indicators: {
      price,
      z_score_20: z20,
      z_score_50: z50,
      bollinger_position_20: bbPos20,
      bollinger_position_50: bbPos50,
      avg_z: avgZ,
    },
    thesis,
  });
}
