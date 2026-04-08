// ============================================================
// CROSS-PLATFORM PRICE COMPARISON & ARBITRAGE DETECTION
//
// Compares equivalent markets across Polymarket and Kalshi.
// Three use cases:
//   1. Best execution: route orders to the platform with better price
//   2. Arbitrage: buy on one, sell on the other when prices diverge
//   3. Confidence boost: when both platforms agree, higher conviction
// ============================================================

import logger from "../logger.js";
import config from "../config.js";

/**
 * Compare prices for the same event across platforms.
 * Markets are matched by question similarity (fuzzy matching).
 *
 * @param {Object} polyMarket - Polymarket market data { question, yes, no, conditionId }
 * @param {Object} kalshiMarket - Kalshi market data { question, yes, no, ticker }
 * @returns {Object} Comparison result with arb detection
 */
export function comparePrices(polyMarket, kalshiMarket) {
  if (!polyMarket?.yes || !kalshiMarket?.yes) return null;

  const polyYes = polyMarket.yes;
  const kalshiYes = kalshiMarket.yes;
  const divergenceCents = Math.abs(polyYes - kalshiYes) * 100;

  // Check for arbitrage: buy YES on cheaper platform, buy NO on more expensive
  // Arb exists when: cheapest YES + cheapest NO < $1.00 (minus fees)
  const cheapestYes = Math.min(polyYes, kalshiYes);
  const cheapestNo = Math.min(1 - polyYes, 1 - kalshiYes);
  const totalCost = cheapestYes + cheapestNo;

  // Estimate fees for round-trip
  const polyFee = config.platforms?.polymarket?.fees?.taker || 0.0075;
  const kalshiFee = config.platforms?.kalshi?.fees?.takerMax || 0.0175;
  const worstCaseFees = polyFee + kalshiFee; // ~2.5% combined

  const arbProfit = 1.0 - totalCost - worstCaseFees;
  const hasArb = arbProfit > 0;

  // Best execution routing
  const bestYesPlatform = polyYes <= kalshiYes ? "polymarket" : "kalshi";
  const bestNoPlatform = (1 - polyYes) <= (1 - kalshiYes) ? "polymarket" : "kalshi";
  const priceSavingCents = divergenceCents;

  const result = {
    polymarket: {
      yes: polyYes,
      no: 1 - polyYes,
      conditionId: polyMarket.conditionId,
    },
    kalshi: {
      yes: kalshiYes,
      no: 1 - kalshiYes,
      ticker: kalshiMarket.ticker,
    },
    divergenceCents,
    bestYesPlatform,
    bestNoPlatform,
    priceSavingCents,
    arbitrage: {
      exists: hasArb,
      profit: hasArb ? arbProfit : 0,
      profitCents: hasArb ? (arbProfit * 100).toFixed(1) : "0",
      buyYesOn: polyYes < kalshiYes ? "polymarket" : "kalshi",
      buyNoOn: (1 - polyYes) < (1 - kalshiYes) ? "polymarket" : "kalshi",
      totalCost,
      fees: worstCaseFees,
    },
    consensus: {
      // When both platforms agree (within 3¢), higher conviction
      agree: divergenceCents <= 3,
      avgYes: (polyYes + kalshiYes) / 2,
      spread: divergenceCents,
    },
    timestamp: Date.now(),
  };

  if (hasArb) {
    logger.info({
      module: "crossplatform",
      question: polyMarket.question?.slice(0, 60),
      profit: `${result.arbitrage.profitCents}¢`,
      polyYes: `${(polyYes * 100).toFixed(1)}¢`,
      kalshiYes: `${(kalshiYes * 100).toFixed(1)}¢`,
    }, "Arbitrage opportunity detected");
  }

  return result;
}

/**
 * Match markets across platforms by question similarity.
 * Uses simple keyword matching — can be upgraded to embeddings later.
 *
 * @param {Object[]} polyMarkets - Array of Polymarket markets
 * @param {Object[]} kalshiMarkets - Array of Kalshi markets
 * @returns {Object[]} Matched pairs
 */
export function matchMarkets(polyMarkets, kalshiMarkets) {
  const matches = [];

  for (const poly of polyMarkets) {
    const polyQ = normalizeQuestion(poly.question || "");
    if (!polyQ) continue;

    let bestMatch = null;
    let bestScore = 0;

    for (const kalshi of kalshiMarkets) {
      const kalshiQ = normalizeQuestion(kalshi.title || kalshi.subtitle || "");
      if (!kalshiQ) continue;

      const score = similarityScore(polyQ, kalshiQ);
      if (score > bestScore && score > 0.6) { // 60% similarity threshold
        bestScore = score;
        bestMatch = kalshi;
      }
    }

    if (bestMatch) {
      matches.push({
        polymarket: poly,
        kalshi: bestMatch,
        similarity: bestScore,
      });
    }
  }

  logger.info({
    module: "crossplatform",
    polyCount: polyMarkets.length,
    kalshiCount: kalshiMarkets.length,
    matched: matches.length,
  }, "Cross-platform market matching complete");

  return matches;
}

/**
 * Normalize a market question for comparison.
 * Strips common words, lowercases, removes punctuation.
 */
function normalizeQuestion(q) {
  return q
    .toLowerCase()
    .replace(/[?!.,'"]/g, "")
    .replace(/\b(will|the|a|an|in|on|at|to|by|of|for|vs|versus)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Simple Jaccard similarity on word tokens.
 * Returns 0-1 score.
 */
function similarityScore(a, b) {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

/**
 * Run a full cross-platform scan.
 * Fetches markets from both platforms, matches them, compares prices.
 *
 * @param {Object[]} polyMarkets - Polymarket markets with prices
 * @param {Object[]} kalshiMarkets - Kalshi markets with prices
 * @returns {Object} Scan results with arbs, best execution routes, and consensus signals
 */
export function crossPlatformScan(polyMarkets, kalshiMarkets) {
  const matched = matchMarkets(polyMarkets, kalshiMarkets);
  const comparisons = [];
  const arbs = [];
  const bestRoutes = [];

  for (const { polymarket: poly, kalshi, similarity } of matched) {
    const polyPrice = {
      question: poly.question,
      yes: parseFloat(poly.outcomePrices?.[0] || poly.yes || 0),
      no: parseFloat(poly.outcomePrices?.[1] || poly.no || 0),
      conditionId: poly.condition_id,
    };

    const kalshiPrice = {
      question: kalshi.title || kalshi.subtitle,
      yes: kalshi.last_price ? kalshi.last_price / 100 : kalshi.yes || 0,
      no: kalshi.last_price ? 1 - kalshi.last_price / 100 : kalshi.no || 0,
      ticker: kalshi.ticker,
    };

    const comparison = comparePrices(polyPrice, kalshiPrice);
    if (!comparison) continue;

    comparison.similarity = similarity;
    comparisons.push(comparison);

    if (comparison.arbitrage.exists) {
      arbs.push(comparison);
    }

    if (comparison.priceSavingCents >= 2) {
      bestRoutes.push(comparison);
    }
  }

  return {
    totalMatched: matched.length,
    comparisons,
    arbitrageOpportunities: arbs,
    bestExecutionRoutes: bestRoutes,
    timestamp: Date.now(),
  };
}
