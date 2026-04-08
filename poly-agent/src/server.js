// ============================================================
// POLY-AGENT SERVER
// Express API + Dashboard for the Polymarket prediction agent.
// ============================================================

import express from "express";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import config from "./config.js";
import logger from "./logger.js";
import { initializeDatabase } from "./db/schema.js";
import { initClobClient } from "./execution/polymarket.js";
import { init as initKalshi, isEnabled as kalshiEnabled, getBalance as kalshiBalance } from "./execution/kalshi.js";
import { startAgent, stopAgent, getState } from "./agent.js";
import {
  getPendingProposals,
  approveProposal,
  rejectProposal,
  getOpenPositions,
} from "./execution/manager.js";
import { getCalibrationStats } from "./analysis/engine.js";
import { getPerformanceSummary } from "./execution/positions.js";

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
    markets: state.watchedMarkets,
    cycles: state.cycleCount,
    platforms: {
      polymarket: !!config.platforms?.polymarket?.enabled,
      kalshi: kalshiEnabled(),
    },
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

// ── CALIBRATION ──

app.get("/api/calibration", async (_req, res) => {
  const stats = await getCalibrationStats();
  res.json(stats || { message: "No calibration data yet" });
});

// ── PERFORMANCE ──

app.get("/api/performance", async (_req, res) => {
  const summary = await getPerformanceSummary();
  res.json(summary || { message: "No closed positions yet" });
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

  // Initialize platform clients
  await initClobClient();  // Polymarket (read-only if no wallet key)
  initKalshi();            // Kalshi (read-only if no RSA key)

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
}

boot().catch((err) => {
  logger.error({ err: err.message }, "Boot failed");
  process.exit(1);
});
