// ============================================================
// SCHEMA MIGRATION RUNNER
// Versioned migrations for safe schema evolution.
// Tracks applied migrations in a dedicated table.
// ============================================================

import { pool } from "./schema.js";
import logger from "../logger.js";

/**
 * Migration definitions — append-only, never edit existing entries.
 * Each migration runs exactly once. Order matters.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: "initial_schema",
    description: "Create base tables: briefings, signals, composites, onchain_events",
    up: `
      CREATE TABLE IF NOT EXISTS briefings (
        id SERIAL PRIMARY KEY,
        cycle INTEGER NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        regime VARCHAR(50),
        regime_confidence REAL,
        overall_sentiment REAL,
        overall_assessment TEXT,
        briefing_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        cycle INTEGER NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pair VARCHAR(20) NOT NULL,
        signal_type VARCHAR(30) NOT NULL,
        direction VARCHAR(10) NOT NULL,
        confidence REAL NOT NULL,
        regime VARCHAR(50),
        thesis TEXT,
        indicators JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS composites (
        id SERIAL PRIMARY KEY,
        cycle INTEGER NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pair VARCHAR(20) NOT NULL,
        direction VARCHAR(10) NOT NULL,
        raw_confidence REAL NOT NULL,
        qualitative_adjustment REAL DEFAULT 0,
        final_confidence REAL NOT NULL,
        regime VARCHAR(50),
        signal_count INTEGER,
        attribution JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS onchain_events (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        token VARCHAR(20),
        event_type VARCHAR(50),
        from_address VARCHAR(42),
        to_address VARCHAR(42),
        value NUMERIC,
        tx_hash VARCHAR(66),
        block_number BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_briefings_cycle ON briefings(cycle);
      CREATE INDEX IF NOT EXISTS idx_briefings_timestamp ON briefings(timestamp);
      CREATE INDEX IF NOT EXISTS idx_signals_pair_cycle ON signals(pair, cycle);
      CREATE INDEX IF NOT EXISTS idx_composites_pair_cycle ON composites(pair, cycle);
      CREATE INDEX IF NOT EXISTS idx_onchain_token ON onchain_events(token, timestamp);
    `,
  },
  {
    version: 2,
    name: "add_regime_delta",
    description: "Add previous_regime column to briefings for regime change tracking",
    up: `
      ALTER TABLE briefings ADD COLUMN IF NOT EXISTS previous_regime VARCHAR(50);
      ALTER TABLE briefings ADD COLUMN IF NOT EXISTS regime_delta VARCHAR(100);
    `,
  },
  {
    version: 3,
    name: "add_entry_zones",
    description: "Add entry_zone column to composites for price-level targets",
    up: `
      ALTER TABLE composites ADD COLUMN IF NOT EXISTS entry_zone JSONB;
    `,
  },
  {
    version: 4,
    name: "raw_data_persistence",
    description: "Add ingestion_snapshots, arb_observations, api_costs tables for Phase 2 backtesting",
    up: `
      -- Raw ingestion data: replay dataset for Phase 2 backtesting
      CREATE TABLE IF NOT EXISTS ingestion_snapshots (
        id SERIAL PRIMARY KEY,
        cycle INTEGER NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        points_json JSONB NOT NULL,
        summary_json JSONB NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0,
        point_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- CEX/DEX spread observations: replaces in-memory spreadHistory
      CREATE TABLE IF NOT EXISTS arb_observations (
        id SERIAL PRIMARY KEY,
        cycle INTEGER,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pair VARCHAR(20) NOT NULL,
        cex_price NUMERIC NOT NULL,
        dex_price NUMERIC NOT NULL,
        spread_bps NUMERIC NOT NULL,
        signal_fired BOOLEAN NOT NULL DEFAULT FALSE,
        signal_strength VARCHAR(10),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Claude API cost tracking per call
      CREATE TABLE IF NOT EXISTS api_costs (
        id SERIAL PRIMARY KEY,
        cycle INTEGER,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        prompt_type VARCHAR(30) NOT NULL,
        model VARCHAR(100) NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        prompt_version VARCHAR(20),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ingestion_cycle ON ingestion_snapshots(cycle);
      CREATE INDEX IF NOT EXISTS idx_ingestion_timestamp ON ingestion_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_arb_pair_timestamp ON arb_observations(pair, timestamp);
      CREATE INDEX IF NOT EXISTS idx_arb_signal_fired ON arb_observations(signal_fired) WHERE signal_fired = TRUE;
      CREATE INDEX IF NOT EXISTS idx_api_costs_cycle ON api_costs(cycle);
      CREATE INDEX IF NOT EXISTS idx_api_costs_model ON api_costs(model, timestamp);
    `,
  },
  {
    version: 5,
    name: "backtest_results",
    description: "Add backtest_results table for persisting backtest runs and performance metrics",
    up: `
      CREATE TABLE IF NOT EXISTS backtest_results (
        id SERIAL PRIMARY KEY,
        run_id VARCHAR(50) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pair VARCHAR(20) NOT NULL,
        signal_type VARCHAR(30) NOT NULL,
        date_range_start TIMESTAMPTZ NOT NULL,
        date_range_end TIMESTAMPTZ NOT NULL,
        total_trades INTEGER NOT NULL DEFAULT 0,
        winning_trades INTEGER NOT NULL DEFAULT 0,
        losing_trades INTEGER NOT NULL DEFAULT 0,
        hit_rate REAL,
        avg_pnl_bps REAL,
        total_pnl_bps REAL,
        sharpe_ratio REAL,
        max_drawdown_pct REAL,
        profit_factor REAL,
        params JSONB,
        trades JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_backtest_run ON backtest_results(run_id);
      CREATE INDEX IF NOT EXISTS idx_backtest_pair_signal ON backtest_results(pair, signal_type);
    `,
  },
  {
    version: 6,
    name: "paper_trading",
    description: "Add paper_trades and trade_proposals tables for Phase 3 paper trading",
    up: `
      CREATE TABLE IF NOT EXISTS paper_trades (
        id SERIAL PRIMARY KEY,
        trade_id TEXT UNIQUE NOT NULL,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price NUMERIC NOT NULL,
        entry_time TIMESTAMPTZ NOT NULL,
        exit_price NUMERIC,
        exit_time TIMESTAMPTZ,
        status TEXT DEFAULT 'open',
        pnl_bps NUMERIC,
        position_size_pct NUMERIC DEFAULT 0.5,
        confidence NUMERIC,
        sentinel_verdict TEXT,
        sentinel_details JSONB,
        signal_attribution JSONB,
        decision_object JSONB,
        human_approved BOOLEAN DEFAULT false,
        human_approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
      CREATE INDEX IF NOT EXISTS idx_paper_trades_pair ON paper_trades(pair);

      CREATE TABLE IF NOT EXISTS trade_proposals (
        id SERIAL PRIMARY KEY,
        proposal_id TEXT UNIQUE NOT NULL,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        confidence NUMERIC,
        sentinel_verdict TEXT,
        sentinel_details JSONB,
        signal_attribution JSONB,
        decision_object JSONB,
        current_price NUMERIC,
        status TEXT DEFAULT 'pending',
        decided_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_trade_proposals_status ON trade_proposals(status);
    `,
  },
];

/**
 * Ensure the migrations tracking table exists.
 */
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/**
 * Get the latest applied migration version.
 */
async function getLatestVersion() {
  const result = await pool.query(
    `SELECT COALESCE(MAX(version), 0) as version FROM schema_migrations`
  );
  return result.rows[0].version;
}

/**
 * Run all pending migrations in order.
 * Safe to call on every startup.
 */
export async function runMigrations() {
  if (!pool) {
    logger.warn({ module: "migrate" }, "DATABASE_URL not set — skipping migrations");
    return;
  }

  try {
    await ensureMigrationsTable();
    const currentVersion = await getLatestVersion();

    const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
    if (pending.length === 0) {
      logger.info({ module: "migrate", version: currentVersion }, "Schema up to date");
      return;
    }

    for (const migration of pending) {
      logger.info(
        { module: "migrate", version: migration.version, name: migration.name },
        `Applying migration: ${migration.name}`
      );

      await pool.query("BEGIN");
      try {
        await pool.query(migration.up);
        await pool.query(
          `INSERT INTO schema_migrations (version, name, description) VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.description]
        );
        await pool.query("COMMIT");

        logger.info(
          { module: "migrate", version: migration.version },
          `Migration ${migration.name} applied`
        );
      } catch (e) {
        await pool.query("ROLLBACK");
        logger.error(
          { module: "migrate", version: migration.version, err: e.message },
          `Migration ${migration.name} FAILED — rolled back`
        );
        throw e; // Stop further migrations on failure
      }
    }

    logger.info(
      { module: "migrate", applied: pending.length, version: pending[pending.length - 1].version },
      "All migrations applied"
    );
  } catch (e) {
    logger.error({ module: "migrate", err: e.message }, "Migration runner failed");
  }
}

export { MIGRATIONS };
