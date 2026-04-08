// ============================================================
// SPORTS NEWS INGEST
// Multi-source news aggregation for sports prediction markets.
// Sources: NewsAPI, ESPN headlines, and manual feeds.
// ============================================================

import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";

// ── ESPN API (free, no key required) ──
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

const ESPN_SPORTS = {
  // American leagues
  nba: "basketball/nba",
  nfl: "football/nfl",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
  ncaab: "basketball/mens-college-basketball",
  ncaaf: "football/college-football",
  ufc: "mma/ufc",
  mls: "soccer/usa.1",

  // International soccer (huge Polymarket volume)
  soccer: "soccer/eng.1",      // Premier League
  epl: "soccer/eng.1",         // EPL alias
  laliga: "soccer/esp.1",      // La Liga
  bundesliga: "soccer/ger.1",  // Bundesliga
  championsleague: "soccer/uefa.champions",
  worldcup: "soccer/fifa.world",

  // Golf
  golf: "golf/pga",

  // F1 (ESPN covers via their F1 deal)
  f1: "racing/f1",

  // Tennis
  tennis: "tennis/atp",

  // Cricket
  cricket: "cricket/icc",
};

/**
 * Fetch latest ESPN headlines for a sport.
 * @param {string} sport - Key from ESPN_SPORTS
 * @returns {Object[]} Normalized news items
 */
export async function getESPNHeadlines(sport = "nba") {
  const path = ESPN_SPORTS[sport];
  if (!path) {
    logger.warn({ module: "news", sport }, "Unknown ESPN sport");
    return [];
  }

  try {
    const resp = await axios.get(`${ESPN_BASE}/${path}/news`, {
      timeout: 8_000,
      params: { limit: 25 },
    });

    const articles = resp.data?.articles || [];
    return articles.map((a) => ({
      source: "espn",
      sport,
      title: a.headline || a.title || "",
      description: a.description || "",
      url: a.links?.web?.href || "",
      publishedAt: a.published || new Date().toISOString(),
      categories: (a.categories || []).map((c) => c.description).filter(Boolean),
      // ESPN sometimes includes team/player references
      athletes: (a.athletes || []).map((ath) => ({
        name: ath.displayName,
        team: ath.team?.displayName,
      })),
    }));
  } catch (err) {
    logger.error({ module: "news", sport, err: err.message }, "ESPN fetch failed");
    return [];
  }
}

/**
 * Fetch ESPN injury report for a sport.
 * This is GOLD for prediction markets — injuries move lines instantly.
 */
export async function getESPNInjuries(sport = "nba") {
  const path = ESPN_SPORTS[sport];
  if (!path) return [];

  try {
    // ESPN's scoreboard endpoint includes team injury data
    const resp = await axios.get(`${ESPN_BASE}/${path}/scoreboard`, {
      timeout: 8_000,
    });

    const events = resp.data?.events || [];
    const injuries = [];

    for (const event of events) {
      for (const competition of event.competitions || []) {
        for (const competitor of competition.competitors || []) {
          const team = competitor.team?.displayName || "Unknown";
          // Injury data may be in the odds or status
          if (competitor.injuries?.length > 0) {
            for (const injury of competitor.injuries) {
              injuries.push({
                source: "espn_injury",
                sport,
                team,
                player: injury.athlete?.displayName || "Unknown",
                status: injury.status || "Unknown", // Out, Doubtful, Questionable, Probable
                type: injury.type || "",
                detail: injury.detail?.detail || "",
                event: event.name,
                gameDate: event.date,
              });
            }
          }
        }
      }
    }

    logger.debug({ module: "news", sport, count: injuries.length }, "Fetched injuries");
    return injuries;
  } catch (err) {
    logger.error({ module: "news", sport, err: err.message }, "ESPN injuries fetch failed");
    return [];
  }
}

/**
 * Fetch today's ESPN scoreboard (live scores + upcoming games).
 * Critical for knowing which markets are about to resolve.
 */
export async function getESPNScoreboard(sport = "nba") {
  const path = ESPN_SPORTS[sport];
  if (!path) return [];

  try {
    const resp = await axios.get(`${ESPN_BASE}/${path}/scoreboard`, {
      timeout: 8_000,
    });

    const events = resp.data?.events || [];
    return events.map((e) => {
      const comp = e.competitions?.[0] || {};
      const teams = (comp.competitors || []).map((c) => ({
        name: c.team?.displayName || "Unknown",
        abbreviation: c.team?.abbreviation || "",
        score: c.score || "0",
        homeAway: c.homeAway,
        winner: c.winner,
        odds: comp.odds?.[0]?.details || null,
        spread: comp.odds?.[0]?.spread || null,
        overUnder: comp.odds?.[0]?.overUnder || null,
      }));

      return {
        id: e.id,
        name: e.name,
        shortName: e.shortName,
        date: e.date,
        status: e.status?.type?.name, // STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_FINAL
        statusDetail: e.status?.type?.detail,
        sport,
        teams,
        venue: comp.venue?.fullName || null,
        broadcasts: (comp.broadcasts || []).flatMap((b) => b.names || []),
      };
    });
  } catch (err) {
    logger.error({ module: "news", sport, err: err.message }, "ESPN scoreboard fetch failed");
    return [];
  }
}

// ── NEWS API (general sports news) ──

/**
 * Fetch sports news from NewsAPI.
 * Useful for broader context that ESPN might miss.
 */
export async function getNewsAPIHeadlines(query = "sports") {
  if (!config.news.apiKey) {
    logger.debug({ module: "news" }, "NewsAPI key not set — skipping");
    return [];
  }

  try {
    const resp = await axios.get("https://newsapi.org/v2/everything", {
      params: {
        q: query,
        sortBy: "publishedAt",
        pageSize: 20,
        language: "en",
        apiKey: config.news.apiKey,
      },
      timeout: 8_000,
    });

    return (resp.data?.articles || []).map((a) => ({
      source: "newsapi",
      sport: null, // General — needs classification
      title: a.title || "",
      description: a.description || "",
      url: a.url || "",
      publishedAt: a.publishedAt || new Date().toISOString(),
      sourceName: a.source?.name || "",
    }));
  } catch (err) {
    logger.error({ module: "news", err: err.message }, "NewsAPI fetch failed");
    return [];
  }
}

// ── AGGREGATOR ──

/**
 * Get the list of enabled sports from config.
 * Returns ESPN-compatible sport keys.
 */
function getEnabledSports() {
  if (!config.sports) return ["nba", "mlb", "nhl"];
  return Object.entries(config.sports)
    .filter(([_, v]) => v.enabled && ESPN_SPORTS[v.tag])
    .map(([_, v]) => v.tag);
}

/**
 * Fetch all news across all monitored sports.
 * Dynamically reads from config.sports — covers everything from
 * NBA to esports to F1 to cricket.
 */
export async function fetchAllNews(sports = null) {
  const activeSports = sports || getEnabledSports();
  const allNews = [];
  const allInjuries = [];
  const allScores = [];

  // Fetch all sports in parallel (ESPN handles most)
  const [newsResults, injuryResults, scoreResults] = await Promise.all([
    Promise.all(activeSports.map((s) => getESPNHeadlines(s))),
    Promise.all(activeSports.map((s) => getESPNInjuries(s))),
    Promise.all(activeSports.map((s) => getESPNScoreboard(s))),
  ]);

  for (const result of newsResults) allNews.push(...result);
  for (const result of injuryResults) allInjuries.push(...result);
  for (const result of scoreResults) allScores.push(...result);

  // General sports news via NewsAPI (broader coverage for esports, F1, etc.)
  const searchTerms = [
    "NBA", "MLB", "NHL", "UFC",
    "Premier League", "Champions League", "La Liga", "World Cup",
    "Formula 1", "F1", "Masters golf",
    "ATP tennis", "esports League of Legends",
  ].join(" OR ");
  const generalNews = await getNewsAPIHeadlines(searchTerms);
  allNews.push(...generalNews);

  // Sort news by publish date (most recent first)
  allNews.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  logger.info({
    module: "news",
    sports: activeSports.length,
    headlines: allNews.length,
    injuries: allInjuries.length,
    games: allScores.length,
  }, "News aggregation complete");

  return {
    headlines: allNews,
    injuries: allInjuries,
    scoreboard: allScores,
    activeSports,
    fetchedAt: Date.now(),
  };
}
