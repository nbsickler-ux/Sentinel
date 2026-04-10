// bookmaker.js — Kalshi-first bookmaker odds fetching
// Uses Odds-API.io v3 (free tier: 5,000 requests/hour)
// Docs: https://docs.odds-api.io
//
// Flow: Kalshi markets drive everything.
//   1. Kalshi market discovered → extract team names from question
//   2. Search odds-api.io for matching event → cache the event ID
//   3. Every cycle → fetch odds only for cached/matched event IDs
//   4. Normalize into { homeTeam, awayTeam, consensusProbs, sharpProbs }
//
// This means we ONLY fetch odds for events Kalshi actually lists.
// Zero wasted API calls on irrelevant leagues or distant events.

import axios from "axios";
import logger from "../logger.js";

const ODDS_API_BASE = "https://api.odds-api.io/v3";
const apiKey = process.env.ODDS_API_KEY || "";

// Persistent cache: Kalshi market ID → odds-api.io event ID
// Only cleared on restart. Event IDs are stable for the life of an event.
const marketToEventCache = new Map();

// Reverse cache: odds-api.io event ID → full event metadata
const eventMetaCache = new Map();

// Markets that failed to match — don't re-search every cycle
const unmatchable = new Set();

// Preferred bookmakers in order of "sharpness" (Pinnacle most sharp)
const SHARP_BOOKS = ["Pinnacle", "BetOnline", "Bovada", "FanDuel", "DraftKings", "BetMGM"];

// Bookmakers to request odds from
const BOOKMAKER_LIST = "Pinnacle,BetOnline,Bovada,FanDuel,DraftKings,BetMGM,Bet365";

/**
 * Main entry point. Takes Kalshi markets, returns bookmaker odds
 * for only the markets that have a matching bookmaker event.
 *
 * @param {Array} kalshiMarkets - Watched Kalshi markets from agent state
 * @returns {Array} Normalized bookmaker events with implied probabilities
 */
export async function fetchOddsForKalshiMarkets(kalshiMarkets) {
  if (!apiKey) {
    logger.warn({ module: "bookmaker" }, "No ODDS_API_KEY configured — bookmaker comparison disabled");
    return [];
  }

  if (!kalshiMarkets || kalshiMarkets.length === 0) return [];

  // Step 1: Find matching odds-api.io event IDs for any new Kalshi markets
  const newMarkets = kalshiMarkets.filter(
    m => !marketToEventCache.has(m.id) && !unmatchable.has(m.id)
  );

  if (newMarkets.length > 0) {
    await matchNewMarkets(newMarkets);
  }

  // Step 2: Collect all matched event IDs
  const eventIds = [];
  for (const km of kalshiMarkets) {
    const eventId = marketToEventCache.get(km.id);
    if (eventId && !eventIds.includes(eventId)) {
      eventIds.push(eventId);
    }
  }

  if (eventIds.length === 0) {
    logger.info({
      module: "bookmaker",
      kalshiMarkets: kalshiMarkets.length,
      matched: 0,
      unmatchable: unmatchable.size,
    }, "No Kalshi markets matched to bookmaker events");
    return [];
  }

  // Step 3: Fetch odds for matched events only
  const results = await fetchOddsForEventIds(eventIds);

  logger.info({
    module: "bookmaker",
    kalshiMarkets: kalshiMarkets.length,
    matched: eventIds.length,
    oddsReturned: results.length,
    cached: marketToEventCache.size,
    unmatchable: unmatchable.size,
  }, "Bookmaker odds fetched (Kalshi-first)");

  return results;
}

// How many new markets to search per cycle (avoids 429 on first cycle)
const SEARCH_BATCH_SIZE = 15;

/**
 * For new Kalshi markets, extract team names and search odds-api.io
 * to find the matching event. Cache the mapping.
 * Processes at most SEARCH_BATCH_SIZE per call to avoid rate limits.
 */
async function matchNewMarkets(newMarkets) {
  // Only process a batch per cycle — the rest will get picked up next cycle
  const batch = newMarkets.slice(0, SEARCH_BATCH_SIZE);
  if (newMarkets.length > SEARCH_BATCH_SIZE) {
    logger.info({
      module: "bookmaker",
      total: newMarkets.length,
      processing: batch.length,
      deferred: newMarkets.length - batch.length,
    }, "Staggering market search — processing batch, rest deferred to next cycle");
  }

  for (const market of batch) {
    const searchTerms = extractSearchTerms(market);
    if (searchTerms.length === 0) {
      unmatchable.add(market.id);
      logger.debug({
        module: "bookmaker",
        ticker: market.ticker,
        eventTicker: market.eventTicker,
        question: market.question?.slice(0, 80),
        yesSub: market.yesSub?.slice(0, 60),
      }, "No search terms extractable — marking unmatchable");
      continue;
    }

    // Log what we're about to search for (diagnostic)
    logger.info({
      module: "bookmaker",
      ticker: market.ticker,
      eventTicker: market.eventTicker,
      searchTerms,
    }, "Searching bookmaker for Kalshi market");

    // Try each search term until we find a match
    let matched = false;
    for (const term of searchTerms) {
      try {
        const resp = await axios.get(`${ODDS_API_BASE}/events/search`, {
          params: { apiKey, query: term },
          timeout: 10_000,
        });

        const events = resp.data || [];
        if (events.length === 0) continue;

        // Find best match by time proximity to Kalshi close time
        const bestEvent = findBestTimeMatch(events, market);
        if (bestEvent) {
          marketToEventCache.set(market.id, bestEvent.id);
          eventMetaCache.set(bestEvent.id, bestEvent);
          logger.info({
            module: "bookmaker",
            kalshi: market.ticker,
            matched: `${bestEvent.home} vs ${bestEvent.away}`,
            eventId: bestEvent.id,
            searchTerm: term,
          }, "Kalshi market matched to bookmaker event");
          matched = true;
          break;
        }
      } catch (err) {
        logger.error({ module: "bookmaker", term, err: err.message }, "Event search failed");
      }
    }

    if (!matched) {
      unmatchable.add(market.id);
      logger.debug({
        module: "bookmaker",
        kalshi: market.ticker,
        eventTicker: market.eventTicker,
        question: market.question?.slice(0, 60),
        searched: searchTerms,
      }, "No bookmaker match found — skipping");
    }

    // Small delay between search requests to avoid burst rate limits
    await new Promise(r => setTimeout(r, 200));
  }
}

/**
 * Extract search terms from a Kalshi market.
 *
 * Kalshi markets have these useful fields:
 *   - question: yes_sub_title || event_ticker || ticker
 *   - yesSub: "Lakers win", "Over 220.5", "Patrick Mahomes 300+ yards"
 *   - noSub: "Lakers lose", "Under 220.5"
 *   - eventTicker: "KXNBA-LAL-BOS-2026APR09" or similar
 *   - ticker: hex-like market ID (not useful for search)
 *
 * Strategy: try multiple sources in order of quality.
 */
function extractSearchTerms(market) {
  const terms = [];

  // ── Source 1: event_ticker (most reliable for sports) ──
  // Format: "KXNBA-LAL-BOS-2026APR09" or "KXMLB-NYY-BOS-2026APR09"
  const eventTicker = market.eventTicker || "";
  if (eventTicker.includes("-")) {
    const parts = eventTicker.split("-");
    // Map common 2-3 letter team abbreviations to full names for search
    const teamAbbrevMap = {
      // NBA
      LAL: "Lakers", BOS: "Celtics", GSW: "Warriors", MIL: "Bucks", PHX: "Suns",
      DEN: "Nuggets", MIA: "Heat", NYK: "Knicks", PHI: "76ers", DAL: "Mavericks",
      LAC: "Clippers", MEM: "Grizzlies", SAC: "Kings", CLE: "Cavaliers", ATL: "Hawks",
      CHI: "Bulls", MIN: "Timberwolves", NOP: "Pelicans", OKC: "Thunder", IND: "Pacers",
      TOR: "Raptors", BKN: "Nets", POR: "Blazers", ORL: "Magic", CHA: "Hornets",
      WAS: "Wizards", SAS: "Spurs", DET: "Pistons", HOU: "Rockets", UTA: "Jazz",
      // MLB
      NYY: "Yankees", NYM: "Mets", BOS: "Red Sox", LAD: "Dodgers", CHC: "Cubs",
      CHW: "White Sox", SF: "Giants", STL: "Cardinals", HOU: "Astros", ATL: "Braves",
      PHI: "Phillies", SD: "Padres", SEA: "Mariners", TB: "Rays", TOR: "Blue Jays",
      MIN: "Twins", CLE: "Guardians", TEX: "Rangers", BAL: "Orioles", KC: "Royals",
      DET: "Tigers", MIL: "Brewers", CIN: "Reds", PIT: "Pirates", ARI: "Diamondbacks",
      COL: "Rockies", MIA: "Marlins", OAK: "Athletics", WAS: "Nationals",
      // NHL
      BOS: "Bruins", NYR: "Rangers", NYI: "Islanders", TOR: "Maple Leafs", MTL: "Canadiens",
      TB: "Lightning", FLA: "Panthers", CAR: "Hurricanes", NJ: "Devils", PIT: "Penguins",
      WSH: "Capitals", PHI: "Flyers", CBJ: "Blue Jackets", DET: "Red Wings", OTT: "Senators",
      BUF: "Sabres", EDM: "Oilers", COL: "Avalanche", DAL: "Stars", WPG: "Jets",
      VGK: "Golden Knights", MIN: "Wild", SEA: "Kraken", LA: "Kings", ANA: "Ducks",
      SJ: "Sharks", CGY: "Flames", VAN: "Canucks", NSH: "Predators", STL: "Blues", CHI: "Blackhawks",
      // NFL
      KC: "Chiefs", SF: "49ers", PHI: "Eagles", DAL: "Cowboys", BUF: "Bills",
      BAL: "Ravens", CIN: "Bengals", MIA: "Dolphins", DET: "Lions", GB: "Packers",
      MIN: "Vikings", LAR: "Rams", LAC: "Chargers", DEN: "Broncos", SEA: "Seahawks",
      ARI: "Cardinals", ATL: "Falcons", TB: "Buccaneers", NO: "Saints", CAR: "Panthers",
      WAS: "Commanders", NYG: "Giants", NYJ: "Jets", NE: "Patriots", PIT: "Steelers",
      CLE: "Browns", HOU: "Texans", IND: "Colts", JAX: "Jaguars", TEN: "Titans", LV: "Raiders",
    };

    // Skip the sport prefix (parts[0] like "KXNBA") and date suffix
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i].toUpperCase();
      // Skip date-like parts (2026APR09, 20260409, etc.)
      if (/^\d{4}/.test(part) || /^2\d{3}/.test(part)) continue;
      // Map abbreviation to team name, or use the abbreviation itself
      const teamName = teamAbbrevMap[part] || (part.length >= 3 ? part : null);
      if (teamName) terms.push(teamName);
    }
    if (terms.length > 0) return terms;
  }

  // ── Source 2: yes_sub_title / question (outcome descriptions) ──
  // Examples: "Lakers win", "Over 220.5", "Celtics +5.5"
  const question = market.question || market.yesSub || "";
  if (question.length < 3) return terms;

  // Skip pure hex/numeric strings (Kalshi ticker IDs)
  if (/^[A-F0-9]+$/i.test(question.replace(/[-_]/g, ""))) return terms;

  // "Team wins" or "Team win"
  const winMatch = question.match(/^(.+?)\s+wins?(?:\s|$)/i);
  if (winMatch) {
    terms.push(extractLastWord(winMatch[1]));
    // Also check noSub for the other team
    if (market.noSub) {
      const noWinMatch = market.noSub.match(/^(.+?)\s+wins?(?:\s|$)/i);
      if (noWinMatch) terms.push(extractLastWord(noWinMatch[1]));
    }
    return terms.filter(t => t.length >= 3);
  }

  // "[Team] vs [Team]" or "[Team] v [Team]"
  const vsMatch = question.match(/(.+?)\s+(?:vs\.?|v\.?)\s+(.+?)(?:\?|$)/i);
  if (vsMatch) {
    terms.push(extractLastWord(vsMatch[1]));
    terms.push(extractLastWord(vsMatch[2]));
    return terms.filter(t => t.length >= 3);
  }

  // "Will the [Team] beat/win against [Team]"
  const beatMatch = question.match(/(?:will\s+(?:the\s+)?)?(.+?)\s+(?:beat|defeat|win\s+against|over)\s+(?:the\s+)?(.+?)(?:\?|$)/i);
  if (beatMatch) {
    terms.push(extractLastWord(beatMatch[1]));
    terms.push(extractLastWord(beatMatch[2]));
    return terms.filter(t => t.length >= 3);
  }

  // "[Team] to win"
  const toWinMatch = question.match(/(.+?)\s+to\s+win/i);
  if (toWinMatch) {
    terms.push(extractLastWord(toWinMatch[1]));
    return terms.filter(t => t.length >= 3);
  }

  // "Over/Under X.X" — skip these, they're prop bets not team matchups
  if (/^(?:over|under)\s+\d/i.test(question)) return terms;

  // Last resort: try to extract any capitalized words that look like names
  const words = question.split(/\s+/).filter(w => w.length >= 3 && /^[A-Z]/.test(w));
  if (words.length > 0 && words.length <= 3) {
    return words.slice(0, 2);
  }

  return terms.filter(t => t.length >= 3);
}

/**
 * Extract the last word of a team name (most distinctive).
 * "Los Angeles Lakers" → "Lakers"
 * "Boston Celtics" → "Celtics"
 */
function extractLastWord(str) {
  const cleaned = str.trim().replace(/[?.!,]/g, "");
  const words = cleaned.split(/\s+/);
  return words[words.length - 1] || cleaned;
}

/**
 * Find the odds-api.io event that best matches a Kalshi market by time.
 * Returns null if no event is within 48 hours of the Kalshi close time.
 */
function findBestTimeMatch(events, kalshiMarket) {
  const kalshiClose = kalshiMarket.closeTime ? new Date(kalshiMarket.closeTime).getTime() : null;

  if (!kalshiClose) {
    // No close time — just return the first upcoming event
    return events.find(e => e.status === "pending") || events[0] || null;
  }

  let best = null;
  let bestDelta = Infinity;

  for (const event of events) {
    const eventTime = new Date(event.date).getTime();
    const delta = Math.abs(eventTime - kalshiClose);

    // Must be within 48 hours
    if (delta > 48 * 60 * 60 * 1000) continue;

    if (delta < bestDelta) {
      bestDelta = delta;
      best = event;
    }
  }

  return best;
}

/**
 * Fetch odds for a set of event IDs.
 * Uses /odds/multi to batch up to 10 at a time (counts as 1 API call).
 */
async function fetchOddsForEventIds(eventIds) {
  const results = [];
  const batches = chunkArray(eventIds, 10);

  for (const batch of batches) {
    try {
      const resp = await axios.get(`${ODDS_API_BASE}/odds/multi`, {
        params: {
          apiKey,
          eventIds: batch.join(","),
          bookmakers: BOOKMAKER_LIST,
        },
        timeout: 15_000,
      });

      const oddsData = resp.data || [];
      for (const eventOdds of oddsData) {
        const normalized = normalizeEvent(eventOdds);
        if (normalized) results.push(normalized);
      }
    } catch (err) {
      const status = err.response?.status;
      logger.error({ module: "bookmaker", status, err: err.message }, "Failed to fetch odds batch");
    }
  }

  return results;
}

// ── LEGACY EXPORTS (backward compat with agent.js) ──

/**
 * @deprecated Use fetchOddsForKalshiMarkets instead.
 * Kept for backward compat — agent.js calls fetchAllOdds().
 */
export async function fetchAllOdds() {
  logger.warn({ module: "bookmaker" }, "fetchAllOdds called — use fetchOddsForKalshiMarkets for Kalshi-first flow");
  return [];
}

// ── NORMALIZATION ──

/**
 * Normalize an Odds-API.io event+odds response into our comparison format.
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
    sharpProbs,
    consensusProbs,
    rawOutcomes: sharpOdds,
    bookmakerCount: bookmakerNames.length,
  };
}

/**
 * Convert ML decimal odds to implied probabilities, removing vig.
 */
function calcImpliedProbsFromML(mlOdds, homeTeam, awayTeam) {
  const homeOdds = parseFloat(mlOdds.home);
  const awayOdds = parseFloat(mlOdds.away);
  const drawOdds = mlOdds.draw ? parseFloat(mlOdds.draw) : null;

  if (!homeOdds || !awayOdds) return {};

  const rawHome = 1 / homeOdds;
  const rawAway = 1 / awayOdds;
  const rawDraw = drawOdds ? 1 / drawOdds : 0;
  const total = rawHome + rawAway + rawDraw;

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

/**
 * Get cache stats for monitoring.
 */
export function getCacheStats() {
  return {
    matched: marketToEventCache.size,
    unmatchable: unmatchable.size,
    eventsMeta: eventMetaCache.size,
  };
}
