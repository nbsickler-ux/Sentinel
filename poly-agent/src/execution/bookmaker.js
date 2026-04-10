// bookmaker.js — Fetches bookmaker odds for cross-platform comparison
// Uses Odds-API.io v3 (free tier: 5,000 requests/hour)
// Docs: https://docs.odds-api.io
//
// Flow: 1. GET /events?sport=X → event IDs
//       2. GET /odds/multi?eventIds=a,b,c&bookmakers=X,Y → odds per event
//       3. Normalize into { homeTeam, awayTeam, consensusProbs, sharpProbs }

import axios from "axios";
import logger from "../logger.js";
import config from "../config.js";

const ODDS_API_BASE = "https://api.odds-api.io/v3";
const apiKey = process.env.ODDS_API_KEY || "";

// Map Kalshi sport categories to Odds-API.io sport slugs
const SPORT_MAP = {
  nba: "basketball",
  nfl: "american-football",
  mlb: "baseball",
  nhl: "ice-hockey",
  ncaab: "basketball",
  mls: "football",
  ufc: "mixed-martial-arts",
};

// Preferred bookmakers in order of "sharpness" (Pinnacle most sharp)
// Names must match Odds-API.io bookmaker names exactly
const SHARP_BOOKS = ["Pinnacle", "BetOnline", "Bovada", "FanDuel", "DraftKings", "BetMGM"];

// Bookmakers to request odds from (comma-separated for API)
const BOOKMAKER_LIST = "Pinnacle,BetOnline,Bovada,FanDuel,DraftKings,BetMGM,Bet365";

/**
 * Fetch events for a sport from Odds-API.io, then fetch odds for each.
 * Returns normalized array of events with implied probabilities.
 */
export async function fetchOdds(sportSlug) {
  if (!apiKey) {
    logger.warn({ module: "bookmaker" }, "No ODDS_API_KEY configured — bookmaker comparison disabled");
    return [];
  }

  try {
    // Step 1: Get upcoming events for this sport
    const eventsResp = await axios.get(`${ODDS_API_BASE}/events`, {
      params: {
        apiKey,
        sport: sportSlug,
        status: "pending",
      },
      timeout: 10_000,
    });

    const events = eventsResp.data || [];
    if (events.length === 0) {
      logger.info({ module: "bookmaker", sport: sportSlug, events: 0 }, "No upcoming events");
      return [];
    }

    // Step 2: Fetch odds in batches of 10 (multi endpoint)
    const allNormalized = [];
    const batches = chunkArray(events, 10);

    for (const batch of batches) {
      const eventIds = batch.map(e => e.id).join(",");
      try {
        const oddsResp = await axios.get(`${ODDS_API_BASE}/odds/multi`, {
          params: {
            apiKey,
            eventIds,
            bookmakers: BOOKMAKER_LIST,
          },
          timeout: 15_000,
        });

        const oddsData = oddsResp.data || [];
        for (const eventOdds of oddsData) {
          const normalized = normalizeEvent(eventOdds);
          if (normalized) allNormalized.push(normalized);
        }
      } catch (err) {
        logger.error({ module: "bookmaker", sport: sportSlug, err: err.message }, "Failed to fetch odds batch");
      }
    }

    const remaining = "check headers";
    logger.info({
      module: "bookmaker",
      sport: sportSlug,
      eventsFound: events.length,
      oddsNormalized: allNormalized.length,
    }, "Bookmaker odds fetched");

    return allNormalized;
  } catch (err) {
    const status = err.response?.status;
    logger.error({ module: "bookmaker", sport: sportSlug, status, err: err.message }, "Failed to fetch bookmaker events");
    return [];
  }
}

/**
 * Fetch odds for ALL configured sports.
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
 * Normalize an Odds-API.io event+odds response into our comparison format.
 *
 * Odds-API.io response structure:
 * {
 *   id, home, away, date, status, sport, league,
 *   bookmakers: {
 *     "Pinnacle": [{ name: "ML", odds: [{ home: "2.10", away: "1.85" }] }],
 *     "Bet365":   [{ name: "ML", odds: [{ home: "2.05", away: "1.90" }] }],
 *   }
 * }
 */
function normalizeEvent(eventOdds) {
  const bookmakers = eventOdds.bookmakers || {};
  const bookmakerNames = Object.keys(bookmakers);
  if (bookmakerNames.length === 0) return null;

  // Find the sharpest available bookmaker
  let sharpBookName = null;
  for (const preferred of SHARP_BOOKS) {
    if (bookmakers[preferred]) {
      sharpBookName = preferred;
      break;
    }
  }
  if (!sharpBookName) sharpBookName = bookmakerNames[0];

  // Extract ML (moneyline) odds from sharp book
  const sharpMarkets = bookmakers[sharpBookName] || [];
  const sharpML = sharpMarkets.find(m => m.name === "ML");
  const sharpOdds = sharpML?.odds?.[0] || {};

  // Calculate sharp book implied probs (remove vig)
  const sharpProbs = calcImpliedProbsFromML(sharpOdds, eventOdds.home, eventOdds.away);

  // Calculate consensus implied probability across all bookmakers
  const consensusProbs = calcConsensusProbs(bookmakers, eventOdds.home, eventOdds.away);

  return {
    eventId: eventOdds.id,
    sport: eventOdds.sport?.slug || "",
    homeTeam: eventOdds.home,
    awayTeam: eventOdds.away,
    commenceTime: eventOdds.date,
    sharpBook: sharpBookName,
    sharpProbs,       // { "Team A": 0.55, "Team B": 0.45 }
    consensusProbs,   // averaged across all bookmakers
    rawOutcomes: sharpOdds,
    bookmakerCount: bookmakerNames.length,
  };
}

/**
 * Convert ML decimal odds to implied probabilities, removing vig.
 * Odds-API.io returns odds as strings: { home: "2.10", draw: "3.40", away: "1.85" }
 */
function calcImpliedProbsFromML(mlOdds, homeTeam, awayTeam) {
  const homeOdds = parseFloat(mlOdds.home);
  const awayOdds = parseFloat(mlOdds.away);
  const drawOdds = mlOdds.draw ? parseFloat(mlOdds.draw) : null;

  if (!homeOdds || !awayOdds) return {};

  // Raw implied probs (sum > 1 due to vig)
  const rawHome = 1 / homeOdds;
  const rawAway = 1 / awayOdds;
  const rawDraw = drawOdds ? 1 / drawOdds : 0;
  const total = rawHome + rawAway + rawDraw;

  // Remove vig by dividing by total
  const result = {};
  result[homeTeam] = rawHome / total;
  result[awayTeam] = rawAway / total;
  if (drawOdds) result["draw"] = rawDraw / total;

  return result;
}

/**
 * Calculate consensus implied probability across all bookmakers.
 */
function calcConsensusProbs(bookmakers, homeTeam, awayTeam) {
  const probSums = {};
  let count = 0;

  for (const [bookName, markets] of Object.entries(bookmakers)) {
    const ml = markets.find(m => m.name === "ML");
    if (!ml?.odds?.[0]) continue;

    const probs = calcImpliedProbsFromML(ml.odds[0], homeTeam, awayTeam);
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

/**
 * Split array into chunks of given size.
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
