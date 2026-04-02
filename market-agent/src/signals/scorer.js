// ============================================================
// SIGNAL CONFIDENCE SCORER
// Aggregates all signal modules into a composite score per pair.
// Source attribution preserved for Phase 2 performance analysis.
// ============================================================

import logger from "../logger.js";

// WEIGHT RATIONALE (updated April 2026):
// - trend (0.60): Primary alpha source. Sharpe 1.28 standalone, drives composite.
// - reversion (0.40): Negative standalone Sharpe (-3.21) but acts as implicit trade filter.
//   When reversion disagrees with trend, composite confidence drops below threshold,
//   preventing bad entries. DO NOT remove without running filter-analysis.js first.
//
// REMOVED SIGNALS (2026-04-02):
// - volatility: Never fires non-neutral. Produces zero trades. No actionable signal.
// - arbitrage: Definitively fails. Weight was 0.20 but signals never profitable.
// - onchain: No on-chain events in database. Data pipeline incomplete.
// Renormalized weights preserve existing ratio (0.30:0.20 = 3:2 = 0.60:0.40).
const SIGNAL_WEIGHTS = {
  trend:     0.60,
  reversion: 0.40,
};

/**
 * Compute composite signal for a pair from individual signals.
 *
 * @param {string} pair
 * @param {Object[]} signals - Array of Signal objects for this pair
 * @returns {Object} Composite signal with attribution
 */
export function computeComposite(pair, signals) {
  if (!signals || signals.length === 0) {
    return {
      pair,
      direction: "neutral",
      composite_confidence: 0,
      regime: "unknown",
      signals: [],
      attribution: {},
      timestamp: Date.now(),
    };
  }

  // Score direction: long = +1, short = -1, neutral = 0
  const directionScores = { long: 0, short: 0, neutral: 0 };
  let totalWeight = 0;
  let weightedConfidence = 0;
  const attribution = {};

  for (const signal of signals) {
    const weight = SIGNAL_WEIGHTS[signal.type] || 0.1;
    const dirScore = signal.direction === "long" ? 1 : signal.direction === "short" ? -1 : 0;

    directionScores[signal.direction] += weight * signal.confidence;
    weightedConfidence += weight * signal.confidence;
    totalWeight += weight;

    attribution[signal.type] = {
      direction: signal.direction,
      confidence: signal.confidence,
      weight,
      contribution: weight * signal.confidence * dirScore,
      regime: signal.regime,
    };
  }

  // Normalize
  const normalizedConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

  // Net direction from weighted votes
  const longScore = directionScores.long;
  const shortScore = directionScores.short;
  let direction = "neutral";
  if (longScore > shortScore && longScore > 0.1) direction = "long";
  if (shortScore > longScore && shortScore > 0.1) direction = "short";

  // Consensus strength: how much do signals agree?
  const agreementRatio = totalWeight > 0
    ? Math.abs(longScore - shortScore) / (longScore + shortScore + directionScores.neutral || 1)
    : 0;

  // Dominant regime from signals
  const regimeCounts = {};
  for (const s of signals) {
    regimeCounts[s.regime] = (regimeCounts[s.regime] || 0) + 1;
  }
  const regime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  const composite = {
    pair,
    direction,
    composite_confidence: Math.round(normalizedConfidence * 1000) / 1000,
    agreement_ratio: Math.round(agreementRatio * 1000) / 1000,
    regime,
    signal_count: signals.length,
    signals,
    attribution,
    timestamp: Date.now(),
  };

  logger.debug({
    module: "scorer",
    pair,
    direction,
    confidence: composite.composite_confidence,
    agreement: composite.agreement_ratio,
    regime,
  }, "Composite signal scored");

  return composite;
}

export { SIGNAL_WEIGHTS };
