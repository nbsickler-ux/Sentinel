// edge.js — Pure math edge detection via cross-platform odds comparison
// No LLM calls. The bookmaker implied probability IS the fair value.
// Edge = bookmaker_prob - kalshi_price (adjusted for fees)

import logger from "../logger.js";
import config from "../config.js";

/**
 * Kalshi taker fee: 0.07 × P × (1-P) per contract.
 * Max is 1.75¢ at P=0.50. Falls toward 0 at extremes.
 * Round-trip = entry fee + exit fee (different P at each point).
 */
function kalshiFee(price) {
  return 0.07 * price * (1 - price);
}

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

  // Edge = fair value - market price (positive = underpriced, buy it)
  const rawEdgeYes = fairValueYes - kalshiYesPrice;
  const rawEdgeNo = (1 - fairValueYes) - kalshiNoPrice;

  // Adjust for Kalshi's actual fee formula: 0.07 × P × (1-P)
  // Entry fee is based on entry price; we estimate round-trip by also
  // projecting an exit near fair value (edge compressed → exit near fair)
  const entryFeeYes = kalshiFee(kalshiYesPrice);
  const exitFeeYes = kalshiFee(fairValueYes);   // exit when price converges to fair
  const roundTripYes = entryFeeYes + exitFeeYes;

  const entryFeeNo = kalshiFee(kalshiNoPrice);
  const exitFeeNo = kalshiFee(1 - fairValueYes);
  const roundTripNo = entryFeeNo + exitFeeNo;

  const feeAdjustedEdgeYes = rawEdgeYes - roundTripYes;
  const feeAdjustedEdgeNo = rawEdgeNo - roundTripNo;

  // Pick the better side
  const bestSide = Math.abs(feeAdjustedEdgeYes) >= Math.abs(feeAdjustedEdgeNo) ? "yes" : "no";
  const bestEdge = bestSide === "yes" ? feeAdjustedEdgeYes : feeAdjustedEdgeNo;
  const edgeCents = Math.round(bestEdge * 100);

  // Only trade positive edges (buy the underpriced side)
  if (bestEdge <= 0) return null;

  // Dual-threshold entry:
  //   6¢+ → log for calibration (minEdgeCentsLog)
  //   7¢+ → eligible for execution (minEdgeCents)
  const minEdgeLog = config.risk?.minEdgeCentsLog || 6;
  const minEdgeTrade = config.risk?.minEdgeCents || 7;
  if (edgeCents < minEdgeLog) return null;

  // Flag whether this edge is trade-eligible or log-only
  const tradeEligible = edgeCents >= minEdgeTrade;

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
    edgeCents,  // after round-trip fees
    roundTripFeeCents: Math.round((bestSide === "yes" ? roundTripYes : roundTripNo) * 100),
    tradeEligible,  // true if edge >= minEdgeCents (7¢), false if log-only (6¢)
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
 *
 * Exit priority (first match wins):
 *   1. Hard stop: -15¢ price move — catastrophic fallback if bookmaker data stales
 *   2. Bookmaker stop: bookmaker-derived edge < 2¢ or negative — thesis dead
 *   3. Edge compression: remaining edge < 2¢ — market caught up, take profit
 *   4. Time exit: < 30 min to event AND edge < 4¢ — liquidity thinning
 *   5. Hold through: edge > 5¢ at event time — ride to resolution
 */
export function evaluateExits(openPositions, kalshiPrices, bookmakerEvents) {
  const actions = [];
  const exitConfig = config.exits || {};

  for (const pos of openPositions) {
    const currentPrice = kalshiPrices.get(pos.marketId);
    if (!currentPrice) continue;

    const currentSidePrice = pos.side === "yes" ? currentPrice.yes : currentPrice.no;
    const entryPrice = pos.entryPrice;
    const pnlCents = Math.round((currentSidePrice - entryPrice) * 100);

    // ── 1. HARD STOP: -15¢ catastrophic fallback ──
    // Fires regardless of bookmaker data. Safety net.
    const hardStop = exitConfig.hardStopCents || 15;
    if (pnlCents <= -hardStop) {
      actions.push({
        marketId: pos.marketId,
        action: "exit",
        reason: "hard_stop",
        pnlCents,
        detail: `Price moved ${Math.abs(pnlCents)}¢ against — hard stop at ${hardStop}¢`,
      });
      continue;
    }

    // ── Re-compare to bookmaker for thesis-based exits ──
    const match = matchMarketToEvent(pos, bookmakerEvents || []);
    let currentEdgeCents = null;
    let fairValue = null;

    if (match) {
      fairValue = match.consensusProbs?.[match.side === "home" ? match.homeTeam : match.awayTeam] || 0;
      if (pos.side === "no") fairValue = 1 - fairValue;
      // Current edge = bookmaker fair value - current Kalshi price (minus single exit fee)
      const exitFee = kalshiFee(currentSidePrice);
      currentEdgeCents = Math.round((fairValue - currentSidePrice - exitFee) * 100);
    }

    // ── 2. BOOKMAKER STOP: edge flipped or < 2¢ ──
    // The trade thesis was "bookmakers say X, Kalshi says Y, gap = edge."
    // If that gap is gone, the reason for the trade is gone.
    const bmStopEdge = exitConfig.bookmakerStopEdgeCents || 2;
    if (currentEdgeCents !== null && currentEdgeCents < bmStopEdge) {
      actions.push({
        marketId: pos.marketId,
        action: "exit",
        reason: currentEdgeCents <= 0 ? "bookmaker_stop_negative" : "bookmaker_stop_compressed",
        pnlCents,
        currentEdgeCents,
        detail: currentEdgeCents <= 0
          ? `Bookmaker edge flipped negative (${currentEdgeCents}¢) — thesis invalidated`
          : `Bookmaker edge compressed to ${currentEdgeCents}¢ (< ${bmStopEdge}¢ threshold)`,
      });
      continue;
    }

    // ── 3. EDGE COMPRESSION PROFIT-TAKE ──
    // If edge started at 8¢+ and is now < 2¢, the market caught up.
    // Taking profit avoids paying exit fees on a disappearing edge.
    const edgeCompress = exitConfig.edgeCompressedCents || 2;
    if (currentEdgeCents !== null && currentEdgeCents < edgeCompress && pnlCents > 0) {
      actions.push({
        marketId: pos.marketId,
        action: "exit",
        reason: "edge_compressed_profit",
        pnlCents,
        currentEdgeCents,
        detail: `Edge compressed to ${currentEdgeCents}¢ with ${pnlCents}¢ profit — taking profit`,
      });
      continue;
    }

    // ── 4. TIME EXIT: < 30 min to event AND edge < 4¢ ──
    // Spreads widen as liquidity thins pre-event. Small edges
    // won't survive the wider exit spread, so get out.
    const timeExitMin = exitConfig.timeExitMinutes || 30;
    const timeExitMinEdge = exitConfig.timeExitMinEdgeCents || 4;
    const commenceTime = pos.commenceTime || match?.commenceTime;
    if (commenceTime) {
      const minutesToEvent = (new Date(commenceTime).getTime() - Date.now()) / 60_000;
      if (minutesToEvent > 0 && minutesToEvent < timeExitMin) {
        if (currentEdgeCents !== null && currentEdgeCents < timeExitMinEdge) {
          actions.push({
            marketId: pos.marketId,
            action: "exit",
            reason: "time_exit",
            pnlCents,
            currentEdgeCents,
            minutesToEvent: Math.round(minutesToEvent),
            detail: `${Math.round(minutesToEvent)} min to event, edge only ${currentEdgeCents}¢ (< ${timeExitMinEdge}¢) — exiting before liquidity thins`,
          });
          continue;
        }

        // ── 5. HOLD THROUGH: edge > 5¢ at event time ──
        // Strong edge near event = hold to binary resolution ($1 or $0).
        // Avoids paying exit fee, lets the position resolve naturally.
        const holdEdge = exitConfig.holdThroughMinEdgeCents || 5;
        if (currentEdgeCents !== null && currentEdgeCents >= holdEdge) {
          actions.push({
            marketId: pos.marketId,
            action: "hold",
            reason: "hold_through_resolution",
            pnlCents,
            currentEdgeCents,
            minutesToEvent: Math.round(minutesToEvent),
            detail: `${Math.round(minutesToEvent)} min to event, edge ${currentEdgeCents}¢ (>= ${holdEdge}¢) — holding to resolution`,
          });
        }
      }
    }
  }

  return actions;
}
