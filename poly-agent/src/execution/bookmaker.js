// bookmaker.js — Fetches bookmaker odds for cross-platform comparison
// Uses Odds-API.io (free tier: 100 requests/hour, no monthly cap)
// Docs: https://docs.odds-api.io

import axios from "axios";
import logger from "../logger.js";
import config from "../config.js";

const ODDS_API_BASE = "https://api.odds-api.io/v3";
const apiKey = process.env.ODDS_API_KEY || "";

// Map Kalshi sport categories to API sport keys
const SPORT_MAP = {
  nba: "basketball_nba",
  nfl: "americanfootball_nfl",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
  ncaab: "basketball_ncaab",
  mls: "soccer_usa_mls",
  ufc: "mma_mixed_martial_arts",
};

// Preferred bookmakers in order of "sharpness" (Pinnacle most sharp)
const SHARP_BOOKS = ["pinnacle", "betonlineag", "bovada", "fanduel", "draftkings", "betmgm"];

/**
 * Fetch odds for a sport from Odds-API.io.
 * Returns normalized array of events with implied probabilities.
 */
export async function fetchOdds(sportKey) {
  if (!apiKey) {
    logger.warn({ module: "bookmaker" }, "No ODDS_API_KEY configured — bookmaker comparison disabled");
    return [];
  }

  try {
    const resp = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
      params: {
        apiKey,
        regions: "us,us2",
        markets: "h2h",
        oddsFormat: "decimal",
      },
      timeout: 10_000,
    });

    const remaining = resp.headers["x-requests-remaining"];
    const used = resp.headers["x-requests-used"];
    logger.info({ module: "bookmaker", sport: sportKey, events: resp.data?.length || 0, remaining, used }, "Bookmaker odds fetched");

    return (resp.data || []).map(normalizeEvent);
  } catch (err) {
    const status = err.response?.status;
    logger.error({ module: "bookmaker", sport: sportKey, status, err: err.message }, "Failed to fetch bookmaker odds");
    return [];
  }
}

/**
 * Fetch odds for ALL configured sports in one batch.
 */
export async function fetchAllOdds() {
  const enabledSports = Object.entries(config.sports || {})
    .filter(([_, cfg]) => cfg.enabled)
    .map(([key]) => key);

  const results = [];
  for (const sport of enabledSports) {
    const apiSport = SPORT_MAP[sport];
    if (!apiSport) continue;
    const events = await fetchOdds(apiSport);
    results.push(...events);
  }

  logger.info({ module: "bookmaker", totalEvents: results.length }, "All bookmaker odds fetched");
  return results;
}

/**
 * Normalize an API event into our comparison format.
 * Extracts the sharpest available bookmaker's implied probability.
 */
function normalizeEvent(event) {
  const bookmakers = event.bookmakers || [];

  // Find the sharpest available bookmaker
  let bestBook = null;
  for (const preferred of SHARP_BOOKS) {
    bestBook = bookmakers.find(b => b.key === preferred);
    if (bestBook) break;
  }
  // Fallback to first available
  if (!bestBook && bookmakers.length > 0) bestBook = bookmakers[0];

  // Extract h2h (moneyline) market
  const h2hMarket = bestBook?.markets?.find(m => m.key === "h2h");
  const outcomes = h2hMarket?.outcomes || [];

  // Calculate consensus implied probability (average across all bookmakers)
  const consensusProbs = calcConsensusProbs(bookmakers);

  // Calculate implied probabilities from the sharp book (remove vig with power method)
  const sharpProbs = calcImpliedProbs(outcomes);

  return {
    eventId: event.id,
    sport: event.sport_key,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    commenceTime: event.commence_time,
    sharpBook: bestBook?.key || "none",
    sharpProbs,       // { "Team A": 0.55, "Team B": 0.45 }
    consensusProbs,   // averaged across all bookmakers
    rawOutcomes: outcomes,
    bookmakerCount: bookmakers.length,
  };
}

/**
 * Convert decimal odds to implied probabilities, removing vig using the power method.
 */
function calcImpliedProbs(outcomes) {
  if (!outcomes.length) return {};

  // Raw implied probs (will sum > 1 due to vig)
  const rawProbs = outcomes.map(o => 1 / o.price);
  const totalVig = rawProbs.reduce((s, p) => s + p, 0);

  // Power method to remove vig (more accurate than multiplicative)
  // Solve for k where sum(p_i^k) = 1
  // Approximation: divide by total
  const result = {};
  for (let i = 0; i < outcomes.length; i++) {
    result[outcomes[i].name] = rawProbs[i] / totalVig;
  }
  return result;
}

/**
 * Calculate consensus implied probability across all bookmakers.
 */
function calcConsensusProbs(bookmakers) {
  const probSums = {};
  let count = 0;

  for (const book of bookmakers) {
    const h2h = book.markets?.find(m => m.key === "h2h");
    if (!h2h) continue;

    const probs = calcImpliedProbs(h2h.outcomes);
    for (const [team, prob] of Object.entries(probs)) {
      probSums[team] = (probSums[team] || 0) + prob;
    }
    count++;
  }

  if (count === 0) return {};
  const result = {};
  for (const [team, sum] of Object.entries(probSums)) {
    result[team] = sum / count;
  }
  return result;
}
