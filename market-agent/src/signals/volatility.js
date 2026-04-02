// ============================================================
// VOLATILITY MODEL
// Realized vol, regime classification, ATR for position sizing.
// Pure function: deterministic given same price history.
// ============================================================

import { createSignal, clampConfidence } from "./schema.js";
import * as history from "./history.js";
import logger from "../logger.js";

/**
 * Compute realized volatility (annualized standard deviation of returns).
 */
function realizedVol(prices, period) {
  if (prices.length < period + 1) return null;
  const window = prices.slice(-(period + 1));
  const returns = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1] !== 0) {
      returns.push(Math.log(window[i] / window[i - 1]));
    }
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  // Annualize: assume ~1440 samples/day (minute data), 365 days
  return Math.sqrt(variance) * Math.sqrt(1440 * 365);
}

/**
 * Compute Average True Range (uses high = max, low = min over rolling windows).
 * Adapted for single-price feeds by using rolling max/min as proxy.
 */
function atr(prices, period) {
  if (prices.length < period * 2) return null;
  const trueRanges = [];

  for (let i = period; i < prices.length; i += period) {
    const window = prices.slice(Math.max(0, i - period), i);
    const high = Math.max(...window);
    const low = Math.min(...window);
    trueRanges.push(high - low);
  }

  if (trueRanges.length === 0) return null;
  return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
}

/**
 * Classify volatility regime based on realized vol percentile.
 */
function classifyVolRegime(currentVol, historicalVol) {
  if (!currentVol || !historicalVol) return "unknown";
  const ratio = historicalVol !== 0 ? currentVol / historicalVol : 1;

  if (ratio < 0.6) return "low_vol";
  if (ratio < 1.2) return "ranging";    // Normal vol
  if (ratio < 2.0) return "high_vol";
  return "transitioning";               // Extreme vol → regime change likely
}

/**
 * Generate volatility signal for a pair.
 * @param {string} pair - Trading pair identifier
 * @param {number[]} [inputPrices] - Optional price array. If omitted, reads from history buffer.
 *                                    Pass explicitly for backtesting (Phase 2).
 */
export function analyze(pair, inputPrices) {
  const priceData = inputPrices || history.prices(pair);

  if (priceData.length < 30) {
    logger.debug({ module: "volatility", pair, points: priceData.length }, "Insufficient data (need 30+)");
    return null;
  }

  const price = priceData[priceData.length - 1];

  // Realized vol at different windows
  const vol10 = realizedVol(priceData, 10);
  const vol30 = realizedVol(priceData, Math.min(30, priceData.length - 1));
  const volFull = realizedVol(priceData, priceData.length - 1);

  // ATR for position sizing reference
  const atr14 = atr(priceData, 14);
  const atrPct = atr14 && price ? (atr14 / price) * 100 : null;

  // Vol regime
  const regime = classifyVolRegime(vol10, vol30);

  // Vol expansion/compression
  const volRatio = vol30 && vol30 > 0 ? vol10 / vol30 : 1;
  const expanding = volRatio > 1.3;
  const compressing = volRatio < 0.7;

  // Signal: high vol expansion = increased risk, suggests caution
  // Low vol compression often precedes breakout
  let direction = "neutral";
  let confidence = 0;

  if (compressing) {
    // Vol squeeze — breakout expected but direction unknown
    direction = "neutral";
    confidence = clampConfidence(0.3 + (1 - volRatio) * 0.5);
  } else if (expanding && vol10 > 1.0) {
    // Vol spike — risk-off signal
    direction = "short";
    confidence = clampConfidence((volRatio - 1) * 0.4);
  }

  const thesis = compressing
    ? `${pair}: Volatility squeeze detected. Vol ratio ${volRatio.toFixed(2)}x. Breakout likely — direction TBD.`
    : expanding
    ? `${pair}: Vol expanding ${volRatio.toFixed(2)}x normal. RV(10)=${(vol10 * 100).toFixed(1)}%. Elevated risk.`
    : `${pair}: Normal vol regime. RV(10)=${vol10 ? (vol10 * 100).toFixed(1) : "N/A"}%, ATR ${atrPct ? atrPct.toFixed(2) : "N/A"}%.`;

  return createSignal({
    type: "volatility",
    pair,
    direction,
    confidence,
    regime,
    indicators: {
      price,
      realized_vol_10: vol10,
      realized_vol_30: vol30,
      realized_vol_full: volFull,
      vol_ratio: volRatio,
      atr_14: atr14,
      atr_pct: atrPct,
      expanding,
      compressing,
    },
    thesis,
  });
}
