// ============================================================
// POSTGRES SCHEMA
// Tables for briefings, signals, and on-chain events.
// Essential for Phase 2 backtesting validation.
// ============================================================

import pg from "pg";
import config from "../config.js";
import logger from "../logger.js";

const { Pool } = pg;

let pool = null;

if (config.database.url) {
  pool = new Pool({
    connectionString: config.database.url,
    ssl: { rejectUnauthorized: false }, // Render managed Postgres requires SSL
    max: 5,
    idleTimeoutMillis: 30000,
  });
  logger.info({ module: "db" }, "Postgres pool created");
} else {
  logger.warn({ module: "db" }, "DATABASE_URL not set — Postgres disabled");
}

/**
 * Initialize database schema via migration runner.
 * Safe to call on every startup — only applies pending migrations.
 */
export async function initSchema() {
  if (!pool) return;

  try {
    const { runMigrations } = await import("./migrate.js");
    await runMigrations();
    logger.info({ module: "db" }, "Schema initialized via migrations");
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Schema initialization failed");
  }
}

export { pool };
