// ============================================================
// EDGE DETECTION — Weather Model vs Kalshi Market Price
//
// For each temperature bracket:
//   model_probability = ensemble members in bracket / total members
//   market_price = Kalshi YES price (what market thinks)
//   raw_edge = model_probability - market_price  (for BUY YES)
//            = market_price - model_probability  (for SELL YES / BUY NO)
//   fee = 0.07 × P × (1-P) per contract
//   net_edge = raw_edge - fee
//
// We trade when net_edge exceeds threshold.
// ============================================================

import logger from "../logger.js";

// ── KALSHI FEE FORMULA ──

/**
 * Kalshi taker fee per contract.
 * Formula: 0.07 × P × (1-P)
 * Max fee: 1.75¢ at P=50¢, drops to near zero at extremes.
 *
 * @param {number} price - Contract price as decimal (0-1)
 * @returns {number} Fee in dollars
 */
export function kalshiFee(price) {
  return 0.07 * price * (1 - price);
}

/**
 * Round-trip fee (entry + exit before settlement).
 * Entry fee at entry price + exit fee at exit price.
 */
export function roundTripFee(entryPrice, exitPrice) {
  return kalshiFee(entryPrice) + kalshiFee(exitPrice);
}

// ── EDGE COMPUTATION ──

/**
 * Compute edges for all weather brackets across all cities.
 *
 * @param {Array} kalshiMarkets - Kalshi market objects with parsed brackets and prices
 *   Each: { ticker, cityCode, bracket: { low, high }, yesPrice, noPrice, volume, closeTime }
 * @param {Object} forecasts - cityCode → { members: number[], modelInfo }
 * @param {Object} opts - { minEdgeCents, minVolume, minMembers }
 * @returns {Array} Sorted edges with trade eligibility
 */
export function findWeatherEdges(kalshiMarkets, forecasts, opts = {}) {
  const {
    minEdgeCents = 5,       // Minimum net edge to flag (¢)
    tradeEdgeCents = 7,     // Minimum net edge to auto-trade (¢)
    minVolume = 0,          // Minimum contract volume
    minMembers = 10,        // Minimum ensemble members for confidence
  } = opts;

  const edges = [];

  for (const market of kalshiMarkets) {
    const forecast = forecasts[market.cityCode];
    if (!forecast || forecast.members.length < minMembers) continue;

    const { members } = forecast;
    const total = members.length;

    // Count members that fall in this bracket
    const inBracket = members.filter(temp => {
      if (market.bracket.low != null && temp < market.bracket.low) return false;
      if (market.bracket.high != null && temp >= market.bracket.high) return false;
      return true;
    }).length;

    const modelProb = inBracket / total;
    const marketPrice = market.yesPrice;

    if (marketPrice == null || marketPrice <= 0 || marketPrice >= 1) continue;

    // Fee at current market price
    const fee = kalshiFee(marketPrice);

    // Two possible trades:
    // 1. BUY YES if model says more likely than market (modelProb > marketPrice)
    // 2. SELL YES (BUY NO) if model says less likely than market (modelProb < marketPrice)

    const buyYesEdge = modelProb - marketPrice - fee;
    const sellYesEdge = marketPrice - modelProb - fee;

    // Determine which side has the edge
    let side, rawEdge, netEdge;
    if (buyYesEdge > sellYesEdge && buyYesEdge > 0) {
      side = "buy_yes";
      rawEdge = modelProb - marketPrice;
      netEdge = buyYesEdge;
    } else if (sellYesEdge > 0) {
      side = "sell_yes";
      rawEdge = marketPrice - modelProb;
      netEdge = sellYesEdge;
    } else {
      // No edge on either side — skip
      continue;
    }

    const netEdgeCents = Math.round(netEdge * 100);
    if (netEdgeCents < minEdgeCents) continue;

    // Volume filter
    if (market.volume < minVolume) continue;

    edges.push({
      ticker: market.ticker,
      cityCode: market.cityCode,
      cityName: market.cityName,
      bracket: market.bracket,
      bracketLabel: market.bracketLabel,

      // Model data
      modelProb: Math.round(modelProb * 1000) / 1000,
      ensembleMembers: total,
      membersInBracket: inBracket,

      // Market data
      marketPrice: Math.round(marketPrice * 1000) / 1000,
      volume: market.volume,

      // Edge calculation
      side,
      rawEdgeCents: Math.round(rawEdge * 100),
      feeCents: Math.round(fee * 100 * 10) / 10,  // one decimal for fees
      netEdgeCents,

      // Trade eligibility
      tradeEligible: netEdgeCents >= tradeEdgeCents,

      // Expected value per contract
      // BUY YES: EV = modelProb × (1 - marketPrice) - (1-modelProb) × marketPrice - fee
      // SELL YES: EV = (1-modelProb) × marketPrice - modelProb × (1 - marketPrice) - fee
      evPerContract: side === "buy_yes"
        ? modelProb * (1 - marketPrice) - (1 - modelProb) * marketPrice - fee
        : (1 - modelProb) * marketPrice - modelProb * (1 - marketPrice) - fee,

      // Confidence: higher with more ensemble members and larger edge
      confidence: Math.min(0.95, (total / 80) * 0.5 + (netEdgeCents / 20) * 0.5),

      closeTime: market.closeTime,
      timestamp: Date.now(),
    });
  }

  // Sort by net edge descending
  edges.sort((a, b) => b.netEdgeCents - a.netEdgeCents);

  if (edges.length > 0) {
    logger.info({
      module: "edge",
      total: edges.length,
      tradeEligible: edges.filter(e => e.tradeEligible).length,
      topEdge: `${edges[0].ticker} ${edges[0].side} ${edges[0].netEdgeCents}¢`,
      topModel: `${(edges[0].modelProb * 100).toFixed(1)}%`,
      topMarket: `${(edges[0].marketPrice * 100).toFixed(1)}%`,
    }, "Weather edges computed");
  }

  return edges;
}

/**
 * Summarize edges for logging/dashboard.
 */
export function summarizeEdges(edges) {
  return {
    total: edges.length,
    tradeEligible: edges.filter(e => e.tradeEligible).length,
    bySide: {
      buy_yes: edges.filter(e => e.side === "buy_yes").length,
      sell_yes: edges.filter(e => e.side === "sell_yes").length,
    },
    byCity: Object.fromEntries(
      [...new Set(edges.map(e => e.cityCode))].map(code => [
        code,
        edges.filter(e => e.cityCode === code).length,
      ])
    ),
    avgEdgeCents: edges.length > 0
      ? Math.round(edges.reduce((sum, e) => sum + e.netEdgeCents, 0) / edges.length)
      : 0,
    maxEdgeCents: edges.length > 0 ? Math.max(...edges.map(e => e.netEdgeCents)) : 0,
  };
}
