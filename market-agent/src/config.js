import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load shared .env from project root (parent of market-agent/)
dotenv.config({ path: resolve(__dirname, "../../.env") });

export default {
  // Claude API
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-20250514",
    maxTokens: 1000,
  },

  // Postgres
  database: {
    url: process.env.DATABASE_URL || "",
  },

  // Shared infrastructure (already provisioned)
  upstash: {
    url: process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
  },
  alchemy: {
    apiKey: process.env.ALCHEMY_API_KEY || "",
  },

  // New data pipeline keys (add when provisioned)
  coinbase: {
    apiKey: process.env.COINBASE_ADV_API_KEY || "",
    apiSecret: process.env.COINBASE_ADV_API_SECRET || "",
  },
  coingecko: {
    apiKey: process.env.COINGECKO_API_KEY || "",
  },
  fred: {
    apiKey: process.env.FRED_API_KEY || "",
  },
  news: {
    apiKey: process.env.NEWS_API_KEY || "",
  },
  benzinga: {
    apiKey: process.env.BENZINGA_API_KEY || "",
  },
  theGraph: {
    apiKey: process.env.THE_GRAPH_API_KEY || "",
  },

  // Qualitative model routing (Haiku/Sonnet hybrid for cost optimization)
  qualitative: {
    models: {
      news_synthesis: process.env.QUAL_NEWS_MODEL || "claude-haiku-4-5-20251001",
      macro_analysis: process.env.QUAL_MACRO_MODEL || "claude-haiku-4-5-20251001",
      contradiction: process.env.QUAL_CONTRADICTION_MODEL || "claude-sonnet-4-20250514",
    },
  },

  // Cycle timing
  cycle: {
    intervalActiveMs: parseInt(process.env.CYCLE_INTERVAL_ACTIVE || "60000", 10),
    intervalIdleMs: parseInt(process.env.CYCLE_INTERVAL_IDLE || "300000", 10),
    idleThresholdCycles: parseInt(process.env.IDLE_THRESHOLD_CYCLES || "5", 10),
  },

  // Sentinel risk verification
  sentinel: {
    url: process.env.SENTINEL_URL || "http://localhost:4021",
    bypassSecret: process.env.LOCAL_BYPASS_SECRET || "",
    timeoutMs: 10000,
  },

  // Instrument universe from brief
  // TODO(S9): Brief specifies AERO/ETH but Aerodrome's primary AERO pool is AERO/USDC.
  //           Using AERO/USDC for Phase 1 — confirm with stakeholders whether to add AERO/ETH
  //           or keep AERO/USDC before Phase 2 launch.
  pairs: ["cbBTC/USDC"],
  // ETH/USDC dropped: Sharpe -0.68, unprofitable across all configs (see SIGNAL_DECOMPOSITION_RESULTS.md)
  // AERO/USDC dropped: volatile pool, 100bps fee, not tested

  // Server
  port: parseInt(process.env.MARKET_AGENT_PORT || "4030", 10),
  env: process.env.NODE_ENV || "development",
  logLevel: process.env.LOG_LEVEL || "info",
};
