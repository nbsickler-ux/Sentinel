import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import config from "./config.js";
import logger from "./logger.js";
import { runCycle } from "./agent.js";
import { formatBriefingJSON } from "./synthesis/formatter.js";
import { initSchema } from "./db/schema.js";
import { getRecentBriefings } from "./db/queries.js";
import { redis } from "./cache/redis.js";
import { getPendingProposals, approveProposal, rejectProposal } from "./paper/approval.js";
import { getOpenPositions, getTradeHistory, getPaperMetrics } from "./paper/tracker.js";
import { paymentMiddleware, PAID_PATHS } from "./payment.js";
import { getUnchangedCycles } from "./cache/staleness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ============================================================
// BASIC API AUTH (M5)
// Set MARKET_AGENT_API_KEY to require Bearer token on all
// non-health, non-dashboard endpoints. Unset = no auth.
// ============================================================

const API_KEY = process.env.MARKET_AGENT_API_KEY || "";

function authMiddleware(req, res, next) {
  if (!API_KEY) return next(); // No key configured — open access
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${API_KEY}`) return next();
  return res.status(401).json({ error: "Unauthorized — provide Authorization: Bearer <key>" });
}

// Public routes: health check + dashboard static files
app.use("/dashboard", express.static(join(__dirname, "../dashboard")));

// Apply auth to API routes (everything except /health, /dashboard, and /dashboard-data)
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/" || req.path.startsWith("/dashboard")) return next();
  return authMiddleware(req, res, next);
});

// x402 payment middleware with local bypass support
const LOCAL_BYPASS_SECRET = process.env.LOCAL_BYPASS_SECRET || "";
const x402Mw = paymentMiddleware;
app.use((req, res, next) => {
  if (LOCAL_BYPASS_SECRET && req.headers["x-bypass-secret"] === LOCAL_BYPASS_SECRET
      && PAID_PATHS.some(p => req.path === p)) {
    return next();
  }
  x402Mw(req, res, next);
});

// ============================================================
// SCHEDULER
// ============================================================

const CYCLE_ACTIVE = config.cycle.intervalActiveMs;
const CYCLE_IDLE = config.cycle.intervalIdleMs;
const IDLE_THRESHOLD = config.cycle.idleThresholdCycles;

let lastCycleResult = null;
let lastSignalResult = null;
let lastBriefing = null;
let cycleCount = 0;
let intervalIds = [];
let cycleRunning = false;
let shuttingDown = false;
let currentInterval = CYCLE_ACTIVE;

async function scheduledCycle() {
  if (cycleRunning || shuttingDown) return;
  cycleRunning = true;

  try {
    cycleCount++;
    const result = await runCycle(cycleCount);

    lastCycleResult = {
      cycle: result.cycle,
      timestamp: result.timestamp,
      ...result.ingestSummary,
      error: result.error || undefined,
    };

    if (result.signalSummary) {
      lastSignalResult = {
        cycle: result.cycle,
        timestamp: result.timestamp,
        ...result.signalSummary,
      };
    }

    if (result.briefing) {
      lastBriefing = result.briefing;
    }

    // Adaptive cycle timing: slow down when data is stale
    const unchanged = getUnchangedCycles();
    const targetInterval = unchanged >= IDLE_THRESHOLD ? CYCLE_IDLE : CYCLE_ACTIVE;
    if (targetInterval !== currentInterval) {
      currentInterval = targetInterval;
      intervalIds.forEach(clearInterval);
      intervalIds = [];
      const id = setInterval(scheduledCycle, currentInterval);
      intervalIds.push(id);
      logger.info({ interval_ms: currentInterval, unchangedCycles: unchanged }, "Cycle interval adjusted");
    }
  } catch (e) {
    logger.error({ cycle: cycleCount, err: e.message }, "Scheduled cycle failed");
    lastCycleResult = {
      cycle: cycleCount,
      timestamp: new Date().toISOString(),
      total: 0,
      error: e.message,
    };
  } finally {
    cycleRunning = false;
  }
}

function startScheduler() {
  scheduledCycle();
  const id = setInterval(scheduledCycle, CYCLE_ACTIVE);
  intervalIds.push(id);
  logger.info({ interval_ms: CYCLE_ACTIVE, idle_ms: CYCLE_IDLE, idle_threshold: IDLE_THRESHOLD }, "Scheduler started (adaptive)");
}

// ============================================================
// API ENDPOINTS
// ============================================================

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "sentinel-market-agent",
    version: "1.0.0",
    uptime: process.uptime(),
    cache: redis ? "connected" : "disabled",
    cycle: cycleCount,
    endpoints: {
      "GET /briefing": { price: "$0.01", description: "Latest market intelligence briefing" },
      "GET /briefings": { price: "$0.03", description: "Historical briefings" },
      "GET /signals": { price: "$0.02", description: "Raw signal data" },
    },
  });
});

// ============================================================
// DASHBOARD DATA ROUTES (free, no x402 payment)
// Mirror the paid endpoints for internal dashboard use.
// ============================================================

app.get("/dashboard/data/briefing", (_req, res) => {
  if (!lastBriefing) return res.json({ message: "No briefing generated yet" });
  res.json(lastBriefing);
});

app.get("/dashboard/data/briefings", async (_req, res) => {
  const limit = parseInt(_req.query.limit || "10", 10);
  const briefings = await getRecentBriefings(limit);
  res.json(briefings);
});

app.get("/dashboard/data/signals", (_req, res) => {
  res.json(lastSignalResult || { message: "No signal cycle completed yet" });
});

// Phase 3 diagnostic endpoint
app.get("/dashboard/data/debug", async (_req, res) => {
  try {
    const { pool } = await import("./db/schema.js");
    const proposals = await pool.query("SELECT count(*) as total, status FROM trade_proposals GROUP BY status");
    const trades = await pool.query("SELECT count(*) as total, status FROM paper_trades GROUP BY status");
    const tableCheck = await pool.query("SELECT tablename FROM pg_tables WHERE tablename IN ('paper_trades', 'trade_proposals')");

    // Test Sentinel call directly
    let sentinelTest = null;
    try {
      const axios = (await import("axios")).default;
      const headers = { "Content-Type": "application/json" };
      if (process.env.LOCAL_BYPASS_SECRET) {
        headers["x-bypass-secret"] = process.env.LOCAL_BYPASS_SECRET;
      }
      const sentinelRes = await axios.post(
        `${process.env.SENTINEL_URL || "http://localhost:4021"}/verify/token`,
        { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" },
        { headers, timeout: 10000 }
      );
      sentinelTest = { status: sentinelRes.status, verdict: sentinelRes.data?.verdict, score: sentinelRes.data?.trust_score };
    } catch (sentErr) {
      sentinelTest = { error: sentErr.message, status: sentErr.response?.status, data: sentErr.response?.data?.toString()?.substring(0, 200) };
    }

    res.json({
      tables: tableCheck.rows.map(r => r.tablename),
      proposals: proposals.rows,
      trades: trades.rows,
      lastSignalConfidence: lastSignalResult?.composites?.[0]?.confidence,
      sentinelUrl: process.env.SENTINEL_URL || "http://localhost:4021",
      bypassSecretSet: !!process.env.LOCAL_BYPASS_SECRET,
      bypassSecretValue: process.env.LOCAL_BYPASS_SECRET ? process.env.LOCAL_BYPASS_SECRET.substring(0, 8) + "..." : "not set",
      configBypassSecret: config.sentinel?.bypassSecret ? config.sentinel.bypassSecret.substring(0, 8) + "..." : "not set",
      sentinelTest,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/dashboard/data/status", (_req, res) => {
  res.json({
    lastCycle: lastCycleResult,
    lastSignals: lastSignalResult,
    cycleCount,
    uptime: process.uptime(),
    config: {
      pairs: config.pairs,
      sources: {
        coinbase: !!config.coinbase.apiKey,
        aerodrome: true,
        alchemy: !!config.alchemy.apiKey,
        coingecko: true,
        fred: !!config.fred.apiKey,
        news: !!config.news.apiKey,
        anthropic: !!config.anthropic.apiKey,
        postgres: !!config.database.url,
      },
    },
  });
});

app.get("/status", (_req, res) => {
  res.json({
    lastCycle: lastCycleResult,
    lastSignals: lastSignalResult,
    cycleCount,
    uptime: process.uptime(),
    config: {
      pairs: config.pairs,
      sources: {
        coinbase: !!config.coinbase.apiKey,
        aerodrome: true,
        alchemy: !!config.alchemy.apiKey,
        coingecko: true,
        fred: !!config.fred.apiKey,
        news: !!config.news.apiKey,
        anthropic: !!config.anthropic.apiKey,
        postgres: !!config.database.url,
      },
    },
  });
});

app.get("/signals", (_req, res) => {
  res.json(lastSignalResult || { message: "No signal cycle completed yet" });
});

app.get("/briefing", (_req, res) => {
  if (!lastBriefing) return res.json({ message: "No briefing generated yet" });
  res.json(lastBriefing);
});

app.get("/briefings", async (_req, res) => {
  const limit = parseInt(_req.query.limit || "10", 10);
  const briefings = await getRecentBriefings(limit);
  res.json(briefings);
});

// Manual trigger — uses the same agent.runCycle() as the scheduler
app.post("/ingest", async (_req, res) => {
  try {
    cycleCount++;
    const result = await runCycle(cycleCount);

    lastCycleResult = {
      cycle: result.cycle,
      timestamp: result.timestamp,
      triggered: "manual",
      ...result.ingestSummary,
    };

    if (result.signalSummary) {
      lastSignalResult = {
        cycle: result.cycle,
        timestamp: result.timestamp,
        triggered: "manual",
        ...result.signalSummary,
      };
    }

    if (result.briefing) {
      lastBriefing = result.briefing;
    }

    res.json({
      ingestion: lastCycleResult,
      signals: lastSignalResult,
      briefing: result.briefing ? formatBriefingJSON(result.briefing) : null,
      sentinel: result.sentinelResults,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// PAPER TRADING API
// ============================================================

app.get("/api/paper/proposals", async (_req, res) => {
  try {
    const proposals = await getPendingProposals();
    res.json(proposals);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/paper/proposals/:id/approve", async (req, res) => {
  try {
    const result = await approveProposal(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/paper/proposals/:id/reject", async (req, res) => {
  try {
    const result = await rejectProposal(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/paper/positions", async (_req, res) => {
  try {
    const positions = await getOpenPositions();
    res.json(positions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/paper/history", async (_req, res) => {
  try {
    const limit = parseInt(_req.query.limit || "50", 10);
    const trades = await getTradeHistory(limit);
    res.json(trades);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/paper/metrics", async (_req, res) => {
  try {
    const metrics = await getPaperMetrics();
    res.json(metrics);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Redirect root to dashboard
app.get("/", (_req, res) => {
  res.redirect("/dashboard/index.html");
});

// ============================================================
// START
// ============================================================

app.listen(config.port, async () => {
  logger.info({
    service: "sentinel-market-agent",
    port: config.port,
    pairs: config.pairs,
  }, `Market agent listening on :${config.port}`);

  // Initialize Postgres schema (runs migrations)
  await initSchema();

  startScheduler();
});

// ============================================================
// GRACEFUL SHUTDOWN (M4)
// ============================================================

async function shutdown(signal) {
  logger.info({ signal }, "Shutdown signal received");
  shuttingDown = true;

  // Stop scheduling new cycles
  intervalIds.forEach(clearInterval);

  // Wait for in-flight cycle to finish (max 30s)
  if (cycleRunning) {
    logger.info("Waiting for in-flight cycle to complete...");
    const deadline = Date.now() + 30_000;
    while (cycleRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (cycleRunning) {
      logger.warn("In-flight cycle did not complete within 30s — exiting anyway");
    }
  }

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
