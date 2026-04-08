// edge.js — Pure math edge detection via cross-platform odds comparison
// No LLM calls. The bookmaker implied probability IS the fair value.
// Edge = bookmaker_prob - kalshi_price (adjusted for fees)

import logger from "../logger.js";
import config from "../config.js";

const KALSHI_TAKER_FEE = 0.0175; // 1.75¢ max per contract at 50¢

/**
 * Compare Kalshi market prices against bookmaker odds to find edges.
 *
 * @param {Array} kalshiMarkets - Watched Kalshi markets with current prices
 * @param {Array} bookmakerEvents - Normalized bookmaker events from bookmaker.js
 * @returns {Array} edges - Markets with detected edges, sorted by edge size
 */
export function findEdges(kalshiMarkets, bookmakerEvents) {
  const edges = [];

  for (const km of kalshiMarkets) {
    // Try to match this Kalshi market to a bookmaker event
    const match = matchMarketToEvent(km, bookmakerEvents);
    if (!match) continue;

    const edge = calculateEdge(km, match);
    if (edge) {
      edges.push(edge);
    }
  }

  // Sort by absolute edge descending (biggest opportunities first)
  edges.sort((a, b) => Math.abs(b.edgeCents) - Math.abs(a.edgeCents));

  logger.info({ module: "edge", marketsCompared: kalshiMarkets.length, edgesFound: edges.length }, "Edge scan complete");
  return edges;
}

/**
 * Match a Kalshi market to a bookmaker event.
 * Uses team names and commence time for matching.
 */
function matchMarketToEvent(kalshiMarket, bookmakerEvents) {
  const question = (kalshiMarket.question || kalshiMarket.ticker || "").toLowerCase();
  const closeTime = kalshiMarket.closeTime ? new Date(kalshiMarket.closeTime).getTime() : null;

  for (const event of bookmakerEvents) {
    const home = (event.homeTeam || "").toLowerCase();
    const away = (event.awayTeam || "").toLowerCase();
    const commence = new Date(event.commenceTime).getTime();

    // Check if the Kalshi market question mentions both teams
    const homeMatch = home && question.includes(home);
    const awayMatch = away && question.includes(away);

    // Also try partial team name matching (e.g., "Lakers" from "Los Angeles Lakers")
    const homeShort = home.split(" ").pop();
    const awayShort = away.split(" ").pop();
    const homePartial = homeShort && homeShort.length > 3 && question.includes(homeShort);
    const awayPartial = awayShort && awayShort.length > 3 && question.includes(awayShort);

    const teamsMatch = (homeMatch || homePartial) && (awayMatch || awayPartial);

    // Time proximity check — events should be within 24 hours of each other
    const timeClose = closeTime && commence && Math.abs(closeTime - commence) < 24 * 60 * 60 * 1000;

    if (teamsMatch || (timeClose && (homeMatch || homePartial || awayMatch || awayPartial))) {
      // Determine which side of the Kalshi market maps to which team
      const side = determineSide(kalshiMarket, event);
      return { ...event, side };
    }
  }

  return null;
}

/**
 * Determine which team the Kalshi "YES" outcome corresponds to.
 */
function determineSide(kalshiMarket, event) {
  const question = (kalshiMarket.question || "").toLowerCase();
  const home = (event.homeTeam || "").toLowerCase();
  const homeShort = home.split(" ").pop();

  // If the question is "Will [Team X] win?", YES = Team X
  // Most Kalshi markets are structured: "Will [home team] beat [away team]?"
  // Default: YES = home team (first team mentioned in most question formats)
  if (question.includes(home) || question.includes(homeShort)) {
    // Check if home team appears before away team in the question
    const homeIdx = question.indexOf(homeShort);
    const awayShort = (event.awayTeam || "").toLowerCase().split(" ").pop();
    const awayIdx = awayShort ? question.indexOf(awayShort) : 999;

    if (homeIdx <= awayIdx) {
      return "home"; // YES on Kalshi = home team wins
    }
  }
  return "home"; // Default assumption
}

/**
 * Calculate edge between Kalshi price and bookmaker implied probability.
 */
function calculateEdge(kalshiMarket, matchedEvent) {
  const kalshiYesPrice = kalshiMarket.lastYesPrice || 0;
  const kalshiNoPrice = kalshiMarket.lastNoPrice || (1 - kalshiYesPrice);

  // Get bookmaker's implied probability for the YES side
  const probs = matchedEvent.consensusProbs; // Use consensus across bookmakers
  const sharpProbs = matchedEvent.sharpProbs; // Also track sharp book

  if (!probs || Object.keys(probs).length === 0) return null;

  // Map the YES outcome to a team probability
  let fairValueYes;
  if (matchedEvent.side === "home") {
    fairValueYes = probs[matchedEvent.homeTeam] || 0;
  } else {
    fairValueYes = probs[matchedEvent.awayTeam] || 0;
  }

  if (fairValueYes === 0) return null;

  // Edge = fair value - market price (positive = YES is underpriced, buy YES)
  const rawEdgeYes = fairValueYes - kalshiYesPrice;
  const rawEdgeNo = (1 - fairValueYes) - kalshiNoPrice;

  // Adjust for Kalshi taker fee
  const feeAdjustedEdgeYes = rawEdgeYes - KALSHI_TAKER_FEE;
  const feeAdjustedEdgeNo = rawEdgeNo - KALSHI_TAKER_FEE;

  // Pick the better side
  const bestSide = Math.abs(feeAdjustedEdgeYes) >= Math.abs(feeAdjustedEdgeNo) ? "yes" : "no";
  const bestEdge = bestSide === "yes" ? feeAdjustedEdgeYes : feeAdjustedEdgeNo;
  const edgeCents = Math.round(bestEdge * 100);

  // Only report if edge exceeds minimum threshold
  const minEdge = config.risk?.minEdgeCents || 5;
  if (Math.abs(edgeCents) < minEdge) return null;

  // Only trade positive edges (buy the underpriced side)
  if (bestEdge <= 0) return null;

  // Position sizing: quarter-Kelly
  const kellyFraction = config.risk?.kellyFraction || 0.25;
  const fairValue = bestSide === "yes" ? fairValueYes : (1 - fairValueYes);
  const marketPrice = bestSide === "yes" ? kalshiYesPrice : kalshiNoPrice;
  const kellyPct = ((fairValue - marketPrice) / (1 - marketPrice)) * kellyFraction;
  const suggestedSizePct = Math.max(0, Math.min(kellyPct, config.risk?.maxSinglePositionPct || 0.05));

  return {
    marketId: kalshiMarket.id,
    ticker: kalshiMarket.ticker,
    question: kalshiMarket.question,
    platform: kalshiMarket.platform,
    side: bestSide,
    kalshiPrice: bestSide === "yes" ? kalshiYesPrice : kalshiNoPrice,
    fairValue,
    rawEdgeCents: Math.round((bestSide === "yes" ? rawEdgeYes : rawEdgeNo) * 100),
    edgeCents,  // after fees
    sharpBook: matchedEvent.sharpBook,
    sharpFairValue: matchedEvent.sharpProbs?.[matchedEvent.side === "home" ? matchedEvent.homeTeam : matchedEvent.awayTeam] || null,
    consensusFairValue: fairValue,
    bookmakerCount: matchedEvent.bookmakerCount,
    homeTeam: matchedEvent.homeTeam,
    awayTeam: matchedEvent.awayTeam,
    commenceTime: matchedEvent.commenceTime,
    suggestedSizePct,
    timestamp: Date.now(),
  };
}

/**
 * Evaluate exit conditions for open positions using bookmaker odds as fair value.
 */
export function evaluateExits(openPositions, kalshiPrices, bookmakerEvents) {
  const actions = [];

  for (const pos of openPositions) {
    const currentPrice = kalshiPrices.get(pos.marketId);
    if (!currentPrice) continue;

    const entryPrice = pos.entryPrice;
    const exitConfig = config.exits || {};

    // Profit target
    const pnlCents = Math.round((currentPrice.yes - entryPrice) * 100) * (pos.side === "yes" ? 1 : -1);
    if (pnlCents >= (exitConfig.profitTargetCents || 8)) {
      actions.push({ marketId: pos.marketId, action: "exit", reason: "profit_target", pnlCents });
      continue;
    }

    // Stop loss
    if (pnlCents <= -(exitConfig.stopLossCents || 12)) {
      actions.push({ marketId: pos.marketId, action: "exit", reason: "stop_loss", pnlCents });
      continue;
    }

    // Edge compression — re-compare to bookmaker
    const match = matchMarketToEvent(pos, bookmakerEvents);
    if (match) {
      const fairValue = match.consensusProbs?.[match.side === "home" ? match.homeTeam : match.awayTeam] || 0;
      const currentEdge = Math.abs(fairValue - (pos.side === "yes" ? currentPrice.yes : currentPrice.no));
      if (currentEdge * 100 < (exitConfig.edgeCompressedCents || 2)) {
        actions.push({ marketId: pos.marketId, action: "exit", reason: "edge_compressed", remainingEdgeCents: Math.round(currentEdge * 100), pnlCents });
      }
    }
  }

  return actions;
}
