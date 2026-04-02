// ============================================================
// SIGNAL SCHEMA
// Every signal module outputs this shape.
// Serializable, deterministic given same inputs (Phase 2 req).
// ============================================================

// ACTIVE SIGNALS (live agent pipeline, as of 2026-04-02)
const ACTIVE_SIGNAL_TYPES = ["trend", "reversion"];
// LEGACY SIGNALS (disconnected from pipeline but retained for independent backtesting)
const LEGACY_SIGNAL_TYPES = ["volatility", "arbitrage", "onchain"];
// All signal types for validation (backtest harness may use legacy signals)
const VALID_SIGNAL_TYPES = [...ACTIVE_SIGNAL_TYPES, ...LEGACY_SIGNAL_TYPES];

const VALID_DIRECTIONS = ["long", "short", "neutral"];
const VALID_REGIMES = ["trending_up", "trending_down", "ranging", "transitioning", "high_vol", "low_vol"];

/**
 * Create a validated Signal object.
 *
 * @param {Object} params
 * @param {string} params.type       - Signal type (trend, reversion, etc.)
 * @param {string} params.pair       - Trading pair
 * @param {string} params.direction  - long / short / neutral
 * @param {number} params.confidence - 0.0 to 1.0
 * @param {string} params.regime     - Current regime classification
 * @param {Object} params.indicators - Supporting indicator values
 * @param {string} params.thesis     - Human-readable signal thesis
 * @param {Object} [params.meta]     - Optional metadata
 * @returns {Object} Validated Signal
 */
export function createSignal({ type, pair, direction, confidence, regime, indicators, thesis, timestamp, meta = {} }) {
  if (!VALID_SIGNAL_TYPES.includes(type)) {
    throw new Error(`Invalid signal type: ${type}`);
  }
  if (!VALID_DIRECTIONS.includes(direction)) {
    throw new Error(`Invalid direction: ${direction}`);
  }
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new Error(`Confidence must be 0.0–1.0, got: ${confidence}`);
  }

  return {
    type,
    pair,
    direction,
    confidence: Math.round(confidence * 1000) / 1000, // 3 decimal places
    regime: regime || "unknown",
    indicators: indicators || {},
    thesis,
    timestamp: timestamp || Date.now(),
    meta: {
      version: "1.0.0",
      ...meta,
    },
  };
}

/**
 * Clamp a value to 0.0–1.0 range for confidence scoring.
 */
export function clampConfidence(value) {
  return Math.max(0, Math.min(1, value));
}

export { VALID_SIGNAL_TYPES, VALID_DIRECTIONS, VALID_REGIMES };
