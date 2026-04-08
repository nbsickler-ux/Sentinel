import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env — check Render secret file first, then local Sentinel root
dotenv.config({ path: "/etc/secrets/.env" });
dotenv.config({ path: resolve(__dirname, "../../.env") });

export default {
  // ── Platforms ──
  // Both platforms run in parallel. Agent finds best price across both.
  platforms: {
    polymarket: {
      enabled: !!process.env.POLYGON_WALLET_PRIVATE_KEY,
      clobUrl: process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com",
      gammaUrl: process.env.POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com",
      chainId: 137,
      privateKey: process.env.POLYGON_WALLET_PRIVATE_KEY || "",
      apiKey: process.env.POLYMARKET_API_KEY || "",
      apiSecret: process.env.POLYMARKET_API_SECRET || "",
      apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE || "",
      // Sports only for US users (April 2026)
      categories: ["sports"],
      fees: { taker: 0.0075, makerRebate: 0.002 }, // 0.75% taker, 0.20% rebate
    },
    kalshi: {
      enabled: !!process.env.KALSHI_API_KEY_ID,
      baseUrl: process.env.KALSHI_BASE_URL || "https://api.elections.kalshi.com/trade-api/v2",
      wsUrl: process.env.KALSHI_WS_URL || "wss://api.elections.kalshi.com/trade-api/ws/v2",
      apiKeyId: process.env.KALSHI_API_KEY_ID || "",
      privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || "",
      privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM || "",
      // Full access for US users — sports, politics, crypto, finance, climate, culture
      categories: ["sports", "politics", "crypto", "economics", "climate", "culture"],
      fees: { takerMax: 0.0175, maker: 0.0 }, // ~1.75¢/contract max, 0% maker
    },
  },

  // Legacy alias (some modules still reference this directly)
  polymarket: {
    clobUrl: process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com",
    gammaUrl: process.env.POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com",
    chainId: 137,
    privateKey: process.env.POLYGON_WALLET_PRIVATE_KEY || "",
    apiKey: process.env.POLYMARKET_API_KEY || "",
    apiSecret: process.env.POLYMARKET_API_SECRET || "",
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE || "",
  },

  // ── News sources ──
  news: {
    apiKey: process.env.NEWS_API_KEY || "",
  },

  // ── Postgres (shared with Market Agent) ──
  database: {
    url: process.env.DATABASE_URL || "",
  },

  // ── Redis (shared with Market Agent) ──
  upstash: {
    url: process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
  },

  // ── Bookmaker Odds (cross-platform comparison) ──
  bookmaker: {
    // The Odds API (primary)
    oddsApiKey: process.env.ODDS_API_KEY || "",
    // Poll frequency — match Kalshi scan rate for real-time comparison
    pollMs: parseInt(process.env.BOOKMAKER_POLL_MS || "60000", 10),  // 60s default
    // Minimum number of bookmakers required for consensus
    minBookmakers: parseInt(process.env.BOOKMAKER_MIN_BOOKS || "3", 10),
  },

  // ═══════════════════════════════════════════════
  // OPERATING MODE
  // ═══════════════════════════════════════════════
  //
  //   "analysis"  — Log predictions, place zero orders (calibration phase)
  //   "guarded"   — Auto-execute within tight guardrails (see autoExec)
  //   "autonomous" — Full auto, circuit breaker is the only gate
  //
  mode: process.env.POLY_MODE || "analysis",

  // ── Auto-execution guardrails (mode = "guarded") ──
  autoExec: {
    maxSizeUsd:    parseFloat(process.env.POLY_AUTO_MAX_SIZE || "25"),   // Max $25 per trade
    minEdgeCents:  parseFloat(process.env.POLY_AUTO_MIN_EDGE || "8"),    // Need 8¢+ edge
    minConfidence: parseFloat(process.env.POLY_AUTO_MIN_CONF || "0.75"), // Need 75%+ confidence
  },

  // ═══════════════════════════════════════════════
  // EVENT-DRIVEN ANALYSIS (replaces fixed intervals)
  // ═══════════════════════════════════════════════
  triggers: {
    // News scan: how often to poll ESPN/news sources
    newsPollMs: parseInt(process.env.POLY_NEWS_POLL || "60000", 10),  // 60s

    // Odds scan: how often to check prices on watched markets
    oddsPollMs: parseInt(process.env.POLY_ODDS_POLL || "30000", 10),  // 30s

    // Price move threshold (cents) to trigger re-analysis
    // Only re-analyze a market if its price moved by this much since last analysis
    priceMoveTriggerCents: parseFloat(process.env.POLY_PRICE_TRIGGER || "3"), // 3¢

    // Stale analysis threshold: re-analyze even without trigger after this long
    staleAnalysisMs: parseInt(process.env.POLY_STALE_ANALYSIS || "1800000", 10), // 30 min

    // Approaching resolution: analyze more aggressively when game is within N hours
    preGameWindowHours: parseFloat(process.env.POLY_PREGAME_WINDOW || "3"), // 3h before game

    // During pre-game window, re-analyze on any move > this many cents
    preGameTriggerCents: parseFloat(process.env.POLY_PREGAME_TRIGGER || "1"), // 1¢ (more sensitive)
  },

  // ═══════════════════════════════════════════════
  // POSITION MANAGEMENT & EXIT RULES
  // All numbers derived from Kalshi fee structure
  // (0.07 × P × (1-P) per contract, ~1.75¢ max at 50¢,
  //  round-trip ~3.5¢ at midpoint) and observed
  // cross-platform gap behavior (2-8¢ persist for hours).
  // ═══════════════════════════════════════════════
  exits: {
    // ── Edge compression (primary exit) ──
    // Exit when bookmaker-derived edge compresses below exit fee.
    // Single-side exit fee ≈ 1.75¢ at midpoint, so exiting at <2¢
    // remaining edge means we'd lose money paying to get out.
    edgeCompressedCents: parseFloat(process.env.POLY_EXIT_EDGE_COMPRESS || "2"),

    // ── Stop loss (bookmaker-referenced) ──
    // If bookmaker edge flips negative or drops below 2¢, the thesis
    // is dead — the market corrected or we were wrong.
    // This replaces a fixed price-based stop with a thesis-based one.
    bookmakerStopEdgeCents: parseFloat(process.env.POLY_EXIT_BM_STOP || "2"),

    // ── Hard stop (catastrophic fallback) ──
    // Fixed price-based stop at -15¢ in case bookmaker data stales out.
    // Set at ~2× max expected edge (8¢) so it only fires in true blowups.
    hardStopCents: parseFloat(process.env.POLY_EXIT_HARD_STOP || "15"),

    // ── Time-based exit ──
    // If < 30 min to event start AND remaining edge < 4¢, exit.
    // Rationale: spreads widen as liquidity thins pre-event,
    // and 4¢ edge won't survive the wider exit spread.
    timeExitMinutes: parseFloat(process.env.POLY_EXIT_TIME_MINUTES || "30"),
    timeExitMinEdgeCents: parseFloat(process.env.POLY_EXIT_TIME_MIN_EDGE || "4"),

    // ── Hold-through-resolution ──
    // If edge is still strong (>5¢) at event start, hold to resolution
    // to avoid paying exit fees. Binary resolution = $1 or $0.
    holdThroughMinEdgeCents: parseFloat(process.env.POLY_HOLD_THROUGH_EDGE || "5"),

    // ── Position check frequency ──
    checkIntervalMs: parseInt(process.env.POLY_EXIT_CHECK || "30000", 10), // 30s
  },

  // ── Risk parameters ──
  risk: {
    maxConcurrentPositions: 10,
    maxSinglePositionPct: 0.05,     // 5% of bankroll
    maxDailyLossPct: 0.03,          // 3% daily stop
    maxDrawdownPct: 0.10,           // 10% from peak
    maxConsecutiveLosses: 5,
    // Entry thresholds (derived from round-trip cost ~5¢):
    //   6¢ = log-only threshold (barely clears fees, worth tracking)
    //   7¢ = trade threshold (2¢ buffer over round-trip cost)
    minEdgeCentsLog: 6,             // Log edges at 6¢+ for calibration
    minEdgeCents: 7,                // Execute trades at 7¢+ only
    minConfidence: 0.6,             // Minimum bookmaker consensus confidence
    kellyFraction: 0.25,            // Quarter-Kelly
    positionReductionOnStreak: 0.5, // 50% size reduction after loss streak
  },

  // ── Market categories (US-permitted as of April 2026) ──
  // US exchange: sports only (politics, crypto, finance coming later)
  // But "sports" covers a MASSIVE range: 4,000+ active markets
  categories: ["sports"],

  // Sports we actively monitor — each has different news sources and cycles
  sports: {
    // American leagues (ESPN covers these well)
    nba:     { enabled: true, tag: "nba",     newsSource: "espn", cycle: "daily" },
    mlb:     { enabled: true, tag: "mlb",     newsSource: "espn", cycle: "daily" },
    nhl:     { enabled: true, tag: "nhl",     newsSource: "espn", cycle: "daily" },
    nfl:     { enabled: true, tag: "nfl",     newsSource: "espn", cycle: "weekly" },
    ncaab:   { enabled: true, tag: "ncaab",   newsSource: "espn", cycle: "daily" },
    mls:     { enabled: true, tag: "mls",     newsSource: "espn", cycle: "weekly" },
    ufc:     { enabled: true, tag: "ufc",     newsSource: "espn", cycle: "weekly" },

    // International soccer (huge volume — World Cup alone is $535M)
    soccer:  { enabled: true, tag: "soccer",  newsSource: "espn", cycle: "daily" },
    epl:     { enabled: true, tag: "epl",     newsSource: "espn", cycle: "weekly" },
    laliga:  { enabled: true, tag: "laliga",  newsSource: "espn", cycle: "weekly" },
    bundesliga: { enabled: true, tag: "bundesliga", newsSource: "espn", cycle: "weekly" },

    // Golf (Masters alone is $78M volume — event-driven, not daily)
    golf:    { enabled: true, tag: "golf",    newsSource: "espn", cycle: "event" },

    // F1 ($89M volume — race weekends)
    f1:      { enabled: true, tag: "f1",      newsSource: "espn", cycle: "event" },

    // Tennis (Grand Slams are high-volume)
    tennis:  { enabled: true, tag: "tennis",  newsSource: "espn", cycle: "event" },

    // Cricket (huge international audience)
    cricket: { enabled: true, tag: "cricket", newsSource: "espn", cycle: "event" },

    // Esports (LoL, Rainbow Six, Dota 2, Overwatch — different news ecosystem)
    esports: { enabled: true, tag: "esports", newsSource: "news", cycle: "daily" },
  },

  // ── Server ──
  port: parseInt(process.env.PORT || process.env.POLY_AGENT_PORT || "4040", 10),
  env: process.env.NODE_ENV || "development",
  logLevel: process.env.LOG_LEVEL || "info",
};
