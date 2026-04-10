import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env — check Render secret file first, then local Sentinel root
dotenv.config({ path: "/etc/secrets/.env" });
dotenv.config({ path: resolve(__dirname, "../../.env") });

export default {
  // ── Kalshi (only platform we need) ──
  platforms: {
    kalshi: {
      enabled: !!process.env.KALSHI_API_KEY_ID,
      baseUrl: process.env.KALSHI_BASE_URL || "https://api.elections.kalshi.com/trade-api/v2",
      wsUrl: process.env.KALSHI_WS_URL || "wss://api.elections.kalshi.com/trade-api/ws/v2",
      apiKeyId: process.env.KALSHI_API_KEY_ID || "",
      privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || "",
      privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM || "",
      fees: { takerMax: 0.0175, maker: 0.0 },
    },
  },

  // ── Postgres ──
  database: {
    url: process.env.DATABASE_URL || "",
  },

  // ── Redis ──
  upstash: {
    url: process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
  },

  // ═══════════════════════════════════════════════
  // WEATHER BOT CONFIGURATION
  // ═══════════════════════════════════════════════
  weather: {
    // Polling intervals
    marketScanMs: parseInt(process.env.WEATHER_MARKET_SCAN_MS || "300000", 10),    // 5 min
    forecastPollMs: parseInt(process.env.WEATHER_FORECAST_POLL_MS || "300000", 10), // 5 min
    edgeScanMs: parseInt(process.env.WEATHER_EDGE_SCAN_MS || "60000", 10),         // 60s

    // Edge thresholds (in cents)
    minEdgeCents: parseFloat(process.env.WEATHER_MIN_EDGE || "5"),     // Log at 5¢+
    tradeEdgeCents: parseFloat(process.env.WEATHER_TRADE_EDGE || "7"), // Trade at 7¢+

    // Minimum filters
    minVolume: parseInt(process.env.WEATHER_MIN_VOLUME || "0", 10),
    minMembers: parseInt(process.env.WEATHER_MIN_MEMBERS || "10", 10), // Need 10+ ensemble members
  },

  // ═══════════════════════════════════════════════
  // OPERATING MODE
  // ═══════════════════════════════════════════════
  //   "analysis"   — Log predictions, place zero orders
  //   "guarded"    — Auto-execute within guardrails
  //   "autonomous" — Full auto, circuit breaker only gate
  mode: process.env.POLY_MODE || "analysis",

  // ── Auto-execution guardrails (mode = "guarded") ──
  autoExec: {
    maxSizeUsd:    parseFloat(process.env.POLY_AUTO_MAX_SIZE || "10"),    // Max $10 per trade (conservative for $500 capital)
    minEdgeCents:  parseFloat(process.env.POLY_AUTO_MIN_EDGE || "8"),     // Need 8¢+ edge
    minConfidence: parseFloat(process.env.POLY_AUTO_MIN_CONF || "0.70"),  // Need 70%+ confidence
  },

  // ═══════════════════════════════════════════════
  // POSITION MANAGEMENT & EXIT RULES
  // ═══════════════════════════════════════════════
  exits: {
    // Hold to settlement by default for weather markets
    // Only exit early if forecast materially contradicts position
    forecastFlipThreshold: parseFloat(process.env.WEATHER_EXIT_FLIP || "0.15"), // 15% prob swing

    // Hard stop: if position is down this many cents, exit regardless
    hardStopCents: parseFloat(process.env.POLY_EXIT_HARD_STOP || "15"),

    // Check frequency
    checkIntervalMs: parseInt(process.env.POLY_EXIT_CHECK || "60000", 10), // 60s
  },

  // ── Risk parameters ──
  risk: {
    maxConcurrentPositions: 8,          // Max 8 open positions
    maxSinglePositionUsd: 10,           // Max $10 per trade
    maxCapitalDeployedPct: 0.30,        // Max 30% of capital deployed
    maxDailyLossUsd: 25,                // $25 daily stop (5% of $500)
    maxPerCity: 3,                      // No more than 3 positions in same city
    kellyFraction: 0.25,                // Quarter-Kelly
  },

  // ── Backward compat: triggers used by some modules ──
  triggers: {
    oddsPollMs: parseInt(process.env.POLY_ODDS_POLL || "60000", 10),
  },

  // ── Server ──
  port: parseInt(process.env.PORT || process.env.POLY_AGENT_PORT || "4040", 10),
  env: process.env.NODE_ENV || "development",
  logLevel: process.env.LOG_LEVEL || "info",
};
