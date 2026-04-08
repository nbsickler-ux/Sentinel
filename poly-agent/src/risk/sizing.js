// ============================================================
// POSITION SIZING: FRACTIONAL KELLY CRITERION
// Optimal bet sizing for prediction markets.
// ============================================================

import config from "../config.js";
import logger from "../logger.js";

const { kellyFraction, maxSinglePositionPct, minEdgeCents, minConfidence } = config.risk;

/**
 * Calculate optimal position size using fractional Kelly criterion.
 *
 * In prediction markets:
 *   - You buy a YES token at price p (e.g., 0.60 = 60¢)
 *   - If YES wins, you get $1.00 (profit = 1 - p)
 *   - If YES loses, you lose your stake (loss = p)
 *
 * Kelly formula for binary outcomes:
 *   f* = (bp - q) / b
 *   where b = odds (net payout), p = our probability, q = 1-p
 *
 * For prediction markets buying YES at price P with our probability estimate E:
 *   b = (1 - P) / P  (net profit per dollar risked)
 *   f* = (b * E - (1-E)) / b
 *   Simplified: f* = (E - P) / (1 - P)
 *
 * @param {Object} params
 * @param {number} params.ourProbability - Our fair probability estimate (0-1)
 * @param {number} params.marketPrice - Current market price (0-1)
 * @param {number} params.confidence - Claude's confidence in the estimate (0-1)
 * @param {number} params.bankroll - Current bankroll in USD
 * @param {number} params.sizeMultiplier - From circuit breaker (1.0 or 0.5)
 * @param {string} params.direction - "buy_yes" or "buy_no"
 * @returns {Object} Sizing decision
 */
export function calculatePositionSize({
  ourProbability,
  marketPrice,
  confidence,
  bankroll,
  sizeMultiplier = 1.0,
  direction,
}) {
  // Determine which side we're trading
  let effectiveProb, effectivePrice;
  if (direction === "buy_yes") {
    effectiveProb = ourProbability;
    effectivePrice = marketPrice;
  } else if (direction === "buy_no") {
    effectiveProb = 1 - ourProbability;
    effectivePrice = 1 - marketPrice;
  } else {
    return { trade: false, reason: "No trade direction", size: 0 };
  }

  // ── Gate 1: Minimum edge ──
  const edgeCents = (effectiveProb - effectivePrice) * 100;
  if (edgeCents < minEdgeCents) {
    return {
      trade: false,
      reason: `Edge too small: ${edgeCents.toFixed(1)}¢ (min: ${minEdgeCents}¢)`,
      size: 0,
      edge: edgeCents,
    };
  }

  // ── Gate 2: Minimum confidence ──
  if (confidence < minConfidence) {
    return {
      trade: false,
      reason: `Confidence too low: ${(confidence * 100).toFixed(0)}% (min: ${(minConfidence * 100).toFixed(0)}%)`,
      size: 0,
      edge: edgeCents,
    };
  }

  // ── Kelly calculation ──
  // f* = (E - P) / (1 - P) for YES side
  const fullKelly = (effectiveProb - effectivePrice) / (1 - effectivePrice);

  if (fullKelly <= 0) {
    return {
      trade: false,
      reason: "Negative Kelly — no edge",
      size: 0,
      edge: edgeCents,
      kelly: fullKelly,
    };
  }

  // Apply fractional Kelly (quarter-Kelly default)
  let fractionedKelly = fullKelly * kellyFraction;

  // Scale by Claude's confidence (lower confidence = smaller bet)
  fractionedKelly *= confidence;

  // Apply circuit breaker multiplier (halved during loss streaks)
  fractionedKelly *= sizeMultiplier;

  // Calculate dollar size
  let sizeUsd = fractionedKelly * bankroll;

  // ── Cap: max single position ──
  const maxSize = bankroll * maxSinglePositionPct;
  if (sizeUsd > maxSize) {
    sizeUsd = maxSize;
  }

  // ── Floor: minimum trade size ($1) ──
  if (sizeUsd < 1.0) {
    return {
      trade: false,
      reason: `Position too small: $${sizeUsd.toFixed(2)} (min: $1.00)`,
      size: 0,
      edge: edgeCents,
      kelly: fullKelly,
    };
  }

  // Round to 2 decimal places
  sizeUsd = Math.round(sizeUsd * 100) / 100;

  logger.info({
    module: "sizing",
    direction,
    edge_cents: edgeCents.toFixed(1),
    confidence: (confidence * 100).toFixed(0),
    full_kelly: (fullKelly * 100).toFixed(2),
    fractioned_kelly: (fractionedKelly * 100).toFixed(2),
    size_usd: sizeUsd,
    bankroll,
    size_multiplier: sizeMultiplier,
  }, "Position sized");

  return {
    trade: true,
    size: sizeUsd,
    direction,
    edge: edgeCents,
    confidence,
    kelly: fullKelly,
    fractionedKelly,
    maxSizeApplied: sizeUsd >= maxSize,
    sizeMultiplier,
    expectedValue: sizeUsd * (effectiveProb - effectivePrice),
  };
}

/**
 * Calculate market-making order sizes.
 * Places orders on BOTH sides of our fair value estimate.
 *
 * @param {Object} params
 * @param {number} params.fairValue - Our probability estimate
 * @param {number} params.confidence - How sure we are of the estimate
 * @param {number} params.bankroll - Current bankroll
 * @param {number} params.spreadCents - How wide to quote around fair value (default: 3¢)
 * @returns {Object} Bid and ask orders
 */
export function calculateMarketMakingOrders({
  fairValue,
  confidence,
  bankroll,
  sizeMultiplier = 1.0,
  spreadCents = 3,
}) {
  // Only market-make when we're confident in our fair value
  if (confidence < 0.65) {
    return { make: false, reason: "Confidence too low for market making" };
  }

  const halfSpread = spreadCents / 100 / 2;
  const bidPrice = Math.max(0.01, fairValue - halfSpread);
  const askPrice = Math.min(0.99, fairValue + halfSpread);

  // Size: smaller than directional bets (we're exposed on both sides)
  const maxMakerSize = bankroll * maxSinglePositionPct * 0.5; // Half of directional max
  let sizeUsd = maxMakerSize * confidence * sizeMultiplier;
  sizeUsd = Math.round(Math.min(sizeUsd, maxMakerSize) * 100) / 100;

  if (sizeUsd < 1.0) {
    return { make: false, reason: "Maker size too small" };
  }

  return {
    make: true,
    bid: { price: Math.round(bidPrice * 100) / 100, size: sizeUsd },
    ask: { price: Math.round(askPrice * 100) / 100, size: sizeUsd },
    fairValue,
    spreadCents,
    expectedRebate: sizeUsd * 0.002 * 2, // 0.20% rebate on both sides if filled
  };
}
