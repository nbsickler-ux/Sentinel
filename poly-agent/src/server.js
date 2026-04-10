// ============================================================
// WEATHER BOT SERVER
// Express API + Dashboard for the Kalshi weather trading bot.
// ============================================================

import express from "express";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import config from "./config.js";
import logger from "./logger.js";
import { initializeDatabase } from "./db/schema.js";
import { init as initKalshi, isEnabled as kalshiEnabled, getBalance as kalshiBalance } from "./execution/kalshi.js";
import { startAgent, stopAgent, getState } from "./agent.js";
import {
  getPendingProposals,
  approveProposal,
  rejectProposal,
  getOpenPositions,
} from "./execution/manager.js";
import { getPerformanceSummary } from "./execution/positions.js";
import { getCalibrationReport, recordSettlement, initCalibrationTable } from "./analysis/calibration.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(resolve(__dirname, "../dashboard")));

// ── HEALTH ──

app.get("/health", (_req, res) => {
  const state = getState();
  res.json({
    status: "ok",
    agent: state.running ? "running" : "stopped",
    mode: state.mode,
    strategy: "weather-ensemble",
    markets: state.weatherMarkets,
    cycles: state.cycleCount,
    kalshi: kalshiEnabled(),
    uptime: process.uptime(),
  });
});

// ── AGENT STATE ──

app.get("/api/state", (_req, res) => {
  res.json(getState());
});

// ── PROPOSALS (Human approval gate) ──

app.get("/api/proposals", async (_req, res) => {
  const proposals = await getPendingProposals();
  res.json(proposals);
});

app.post("/api/proposals/:id/approve", async (req, res) => {
  const result = await approveProposal(parseInt(req.params.id, 10));
  res.json(result);
});

app.post("/api/proposals/:id/reject", async (req, res) => {
  await rejectProposal(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ── POSITIONS ──

app.get("/api/positions", async (_req, res) => {
  const positions = await getOpenPositions();
  res.json(positions);
});

// ── EDGES (recent detections) ──

app.get("/api/edges", async (_req, res) => {
  try {
    const { pool } = await import("./db/schema.js");
    if (!pool) return res.json({ edges: [] });
    const { rows } = await pool.query(
      `SELECT * FROM poly_edges ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ edges: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MATCH RATE (how often Kalshi markets match to bookmaker events) ──

app.get("/api/match-rate", async (_req, res) => {
  try {
    const state = getState();
    const totalMarkets = state.weatherMarkets || 0;
    const edges = state.detectedEdges || [];
    const matchedMarkets = new Set(edges.map(e => e.ticker));

    // Also pull historical match data from edges table
    const { pool } = await import("./db/schema.js");
    let historical = null;
    if (pool) {
      const { rows } = await pool.query(`
        SELECT
          DATE(created_at) as day,
          COUNT(DISTINCT market_id) as unique_markets_matched,
          COUNT(*) as total_edges_logged,
          COUNT(*) FILTER (WHERE executed) as edges_traded,
          ROUND(AVG(edge_cents)::numeric, 1) as avg_edge_cents,
          MAX(edge_cents) as max_edge_cents
        FROM poly_edges
        GROUP BY DATE(created_at)
        ORDER BY day DESC
        LIMIT 14
      `);
      historical = rows;
    }

    res.json({
      current: {
        weatherMarketsWatched: totalMarkets,
        marketsWithEdge: matchedMarkets.size,
        edgeRate: totalMarkets > 0 ? `${((matchedMarkets.size / totalMarkets) * 100).toFixed(1)}%` : "0%",
      },
      historical,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PERFORMANCE ──

app.get("/api/performance", async (_req, res) => {
  const summary = await getPerformanceSummary();
  res.json(summary || { message: "No closed positions yet" });
});

// ── CALIBRATION ──

app.get("/api/calibration", async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const report = await getCalibrationReport({ days });
  res.json(report || { message: "No calibration data yet" });
});

app.post("/api/calibration/settle", async (req, res) => {
  const { cityCode, targetDate, actualHigh } = req.body;
  if (!cityCode || !targetDate || actualHigh == null) {
    return res.status(400).json({ error: "Missing cityCode, targetDate, or actualHigh" });
  }
  await recordSettlement(cityCode, targetDate, actualHigh);
  res.json({ success: true, cityCode, targetDate, actualHigh });
});

// ── BANKROLL MANAGEMENT ──

app.post("/api/bankroll/deposit", async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  try {
    const { pool } = await import("./db/schema.js");
    if (!pool) return res.status(500).json({ error: "No database" });
    const { rows } = await pool.query(
      `INSERT INTO poly_bankroll (balance, change_usd, change_reason)
       SELECT COALESCE(
         (SELECT balance FROM poly_bankroll ORDER BY updated_at DESC LIMIT 1), 0
       ) + $1, $1, 'deposit'
       RETURNING balance`,
      [amount]
    );
    logger.info({ module: "server", amount, newBalance: rows[0].balance }, "Deposit recorded");
    res.json({ balance: parseFloat(rows[0].balance), deposited: amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bankroll/withdraw", async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  try {
    const { pool } = await import("./db/schema.js");
    if (!pool) return res.status(500).json({ error: "No database" });
    const { rows } = await pool.query(
      `INSERT INTO poly_bankroll (balance, change_usd, change_reason)
       SELECT COALESCE(
         (SELECT balance FROM poly_bankroll ORDER BY updated_at DESC LIMIT 1), 0
       ) - $1, -$1, 'withdrawal'
       RETURNING balance`,
      [amount]
    );
    logger.info({ module: "server", amount, newBalance: rows[0].balance }, "Withdrawal recorded");
    res.json({ balance: parseFloat(rows[0].balance), withdrawn: amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bankroll", async (_req, res) => {
  try {
    const { pool } = await import("./db/schema.js");
    if (!pool) return res.json({ balance: 0, history: [] });
    const { rows: current } = await pool.query(
      `SELECT balance FROM poly_bankroll ORDER BY updated_at DESC LIMIT 1`
    );
    const { rows: history } = await pool.query(
      `SELECT balance, change_usd, change_reason, updated_at
       FROM poly_bankroll ORDER BY updated_at DESC LIMIT 50`
    );
    res.json({
      balance: current[0] ? parseFloat(current[0].balance) : 0,
      history,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AGENT CONTROL ──

app.post("/api/agent/start", async (_req, res) => {
  await startAgent();
  res.json({ status: "started" });
});

app.post("/api/agent/stop", (_req, res) => {
  stopAgent();
  res.json({ status: "stopped" });
});

// ── MODE CHANGE (runtime — doesn't persist across restarts) ──

app.post("/api/agent/mode", (req, res) => {
  const { mode } = req.body;
  if (!["analysis", "guarded", "autonomous"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode. Use: analysis, guarded, autonomous" });
  }
  config.mode = mode;
  logger.info({ module: "server", mode }, "Operating mode changed");
  res.json({ mode, message: `Switched to ${mode} mode` });
});

// ── DASHBOARD ──

app.get("/", (_req, res) => {
  res.sendFile(resolve(__dirname, "../dashboard/index.html"));
});

// ── STARTUP ──

async function boot() {
  logger.info({ module: "server", port: config.port }, "Poly-Agent server starting...");

  // Initialize database
  await initializeDatabase();

  // Initialize weather calibration table (after main schema)
  await initCalibrationTable();

  // Initialize Kalshi client
  initKalshi();

  // Start listening
  app.listen(config.port, () => {
    logger.info({ module: "server", port: config.port }, `Poly-Agent server running on :${config.port}`);
    logger.info({ module: "server" }, `Dashboard: http://localhost:${config.port}`);
  });

  // Auto-start agent if in production
  if (config.env === "production") {
    await startAgent();
  } else {
    logger.info({ module: "server" }, "Dev mode — agent not auto-started. POST /api/agent/start to begin.");
  }

  // ── KEEP-ALIVE SELF-PING ──
  // Render free tier suspends after 15 min of no inbound HTTP.
  // Self-ping goes through the load balancer → counts as inbound.
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL
    || process.env.SERVICE_URL
    || (config.env === "production" ? "https://sentinel-poly-agent.onrender.com" : null);
  if (RENDER_URL) {
    const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    setInterval(async () => {
      try {
        const resp = await fetch(`${RENDER_URL}/health`);
        if (resp.ok) {
          logger.debug({ module: "keepalive" }, "Self-ping OK");
        }
      } catch (err) {
        logger.warn({ module: "keepalive", err: err.message }, "Self-ping failed");
      }
    }, PING_INTERVAL_MS);
    logger.info({ module: "keepalive", url: RENDER_URL, intervalMin: 10 }, "Keep-alive self-ping enabled");
  }
}

boot().catch((err) => {
  logger.error({ err: err.message }, "Boot failed");
  process.exit(1);
});
