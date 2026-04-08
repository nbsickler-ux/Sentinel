// ============================================================
// DATABASE SCHEMA & POOL
// Postgres tables for predictions, positions, calibration, and P&L.
// ============================================================

import pg from "pg";
import config from "../config.js";
import logger from "../logger.js";

const { Pool } = pg;

export const pool = config.database.url
  ? new Pool({ connectionString: config.database.url, max: 5 })
  : null;

/**
 * Create all required tables if they don't exist.
 */
export async function initializeDatabase() {
  if (!pool) {
    logger.warn({ module: "db" }, "No DATABASE_URL — running without persistence");
    return;
  }

  try {
    await pool.query(`
      -- Predictions for calibration tracking
      CREATE TABLE IF NOT EXISTS poly_predictions (
        id SERIAL PRIMARY KEY,
        condition_id TEXT NOT NULL,
        market_question TEXT NOT NULL,
        fair_probability REAL NOT NULL,
        confidence REAL NOT NULL,
        edge_vs_market REAL,
        direction TEXT,
        market_yes_price REAL,
        market_no_price REAL,
        actual_outcome REAL,  -- 1.0 for YES, 0.0 for NO, NULL if unresolved
        model TEXT,
        prompt_version TEXT,
        cost_usd REAL,
        key_factors JSONB,
        rationale TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );

      -- Active and closed positions
      CREATE TABLE IF NOT EXISTS poly_positions (
        id SERIAL PRIMARY KEY,
        condition_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        market_question TEXT NOT NULL,
        direction TEXT NOT NULL,  -- buy_yes, buy_no, maker_bid, maker_ask
        entry_price REAL NOT NULL,
        size_usd REAL NOT NULL,
        shares REAL,
        exit_price REAL,
        pnl_usd REAL,
        pnl_pct REAL,
        status TEXT NOT NULL DEFAULT 'open',  -- open, won, lost, sold, cancelled
        edge_at_entry REAL,
        confidence_at_entry REAL,
        kelly_fraction REAL,
        order_id TEXT,
        opened_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        resolution TEXT  -- market resolution value
      );

      -- Bankroll tracking (for drawdown calculation)
      CREATE TABLE IF NOT EXISTS poly_bankroll (
        id SERIAL PRIMARY KEY,
        balance REAL NOT NULL,
        change_usd REAL,
        change_reason TEXT,  -- deposit, withdrawal, trade_pnl, rebate
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Trade proposals (human approval gate)
      CREATE TABLE IF NOT EXISTS poly_proposals (
        id SERIAL PRIMARY KEY,
        condition_id TEXT NOT NULL,
        market_question TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price REAL NOT NULL,
        size_usd REAL NOT NULL,
        edge_cents REAL,
        confidence REAL,
        kelly_fraction REAL,
        analysis_summary TEXT,
        status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, rejected, expired
        created_at TIMESTAMPTZ DEFAULT NOW(),
        decided_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '15 minutes'
      );

      -- API cost tracking
      CREATE TABLE IF NOT EXISTS poly_api_costs (
        id SERIAL PRIMARY KEY,
        prompt_type TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER,
        tokens_out INTEGER,
        cost_usd REAL,
        latency_ms INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Odds snapshots (for detecting moves / overreactions)
      CREATE TABLE IF NOT EXISTS poly_odds_history (
        id SERIAL PRIMARY KEY,
        condition_id TEXT NOT NULL,
        yes_price REAL NOT NULL,
        no_price REAL NOT NULL,
        yes_bid_depth REAL,
        yes_ask_depth REAL,
        spread REAL,
        captured_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Indexes for fast queries
      CREATE INDEX IF NOT EXISTS idx_predictions_condition ON poly_predictions(condition_id);
      CREATE INDEX IF NOT EXISTS idx_predictions_resolved ON poly_predictions(actual_outcome) WHERE actual_outcome IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_positions_status ON poly_positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_closed ON poly_positions(closed_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON poly_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_odds_condition ON poly_odds_history(condition_id, captured_at);
    `);

    logger.info({ module: "db" }, "Database schema initialized");
  } catch (err) {
    logger.error({ module: "db", err: err.message }, "Schema initialization failed");
  }
}
