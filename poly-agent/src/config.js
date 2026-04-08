import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load shared .env from Sentinel root
dotenv.config({ path: resolve(__dirname, "../../.env") });

export default {
  // ── Claude API ──
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    maxTokens: 1500,
  },

  // ── Model routing: Haiku for volume, Sonnet for reasoning ──
  models: {
    fairValue:     process.env.POLY_FAIR_VALUE_MODEL     || "claude-haiku-4-5-20251001",
    overreaction:  process.env.POLY_OVERREACTION_MODEL    || "claude-sonnet-4-20250514",
    correlation:   process.env.POLY_CORRELATION_MODEL     || "claude-sonnet-4-20250514",
    newsRelevance: process.env.POLY_NEWS_RELEVANCE_MODEL  || "claude-haiku-4-5-20251001",
  },

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
      baseUrl: process.env.KALSHI_BASE_URL || "https://api.kalshi.com/trade-api/v2",
      wsUrl: process.env.KALSHI_WS_URL || "wss://api.kalshi.com/trade-api/ws/v2",
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
  // ═══════════════════════════════════════════════
  exits: {
    // ── Profit-taking ──
    // Take profit when edge compresses (market caught up to our estimate)
    edgeCompressedCents: parseFloat(process.env.POLY_EXIT_EDGE_COMPRESS || "2"),
    // Take profit on absolute price move in our favor
    profitTargetCents: parseFloat(process.env.POLY_EXIT_PROFIT_TARGET || "8"),

    // ── Stop loss ──
    // Exit if price moves against us by this much
    stopLossCents: parseFloat(process.env.POLY_EXIT_STOP_LOSS || "12"),

    // ── Time-based ──
    // If we're still holding and game is about to start, re-evaluate
    // Hold through resolution only if remaining edge > this threshold
    holdThroughMinEdgeCents: parseFloat(process.env.POLY_HOLD_THROUGH_EDGE || "5"),

    // ── Position check frequency ──
    // How often to evaluate exit conditions on open positions
    checkIntervalMs: parseInt(process.env.POLY_EXIT_CHECK || "30000", 10), // 30s
  },

  // ── Risk parameters ──
  risk: {
    maxConcurrentPositions: 10,
    maxSinglePositionPct: 0.05,     // 5% of bankroll
    maxDailyLossPct: 0.03,          // 3% daily stop
    maxDrawdownPct: 0.10,           // 10% from peak
    maxConsecutiveLosses: 5,
    minEdgeCents: 5,                // Minimum 5¢ (5pp) edge to trade
    minConfidence: 0.6,             // Minimum Claude confidence
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
  port: parseInt(process.env.POLY_AGENT_PORT || "4040", 10),
  env: process.env.NODE_ENV || "development",
  logLevel: process.env.LOG_LEVEL || "info",
};
