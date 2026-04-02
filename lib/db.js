// ============================================================
// SENTINEL — Postgres Integration
// Manages connection pool, schema migrations, and request logging.
// Designed to be non-blocking and fail-silent for all write ops.
// ============================================================

import pg from "pg";
const { Pool } = pg;

let pool = null;
let dbReady = false;

// ============================================================
// CONNECTION
// ============================================================

export function initPool(databaseUrl, logger) {
  if (!databaseUrl) {
    logger.info({ module: "db" }, "DATABASE_URL not set — request logging disabled");
    return null;
  }

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,               // Low pool — logging is secondary workload
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", (err) => {
    logger.error({ module: "db", err: err.message }, "Postgres pool error (non-fatal)");
  });

  return pool;
}

// ============================================================
// MIGRATIONS
// Versioned, transactional. Runs automatically on startup.
// ============================================================

const MIGRATIONS = [
  {
    version: 1,
    name: "create_request_log",
    up: `
      CREATE TABLE IF NOT EXISTS request_log (
        id SERIAL PRIMARY KEY,
        caller_wallet VARCHAR(42) NOT NULL,
        endpoint VARCHAR(255) NOT NULL,
        method VARCHAR(10) NOT NULL,
        chain_id INTEGER,
        is_contract BOOLEAN,
        payment_amount NUMERIC(20, 6),
        payment_currency VARCHAR(10),
        verdict VARCHAR(50),
        response_time_ms INTEGER,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_request_log_caller ON request_log (caller_wallet);
      CREATE INDEX IF NOT EXISTS idx_request_log_endpoint ON request_log (endpoint);
      CREATE INDEX IF NOT EXISTS idx_request_log_timestamp ON request_log (timestamp);
    `,
  },
  {
    version: 2,
    name: "create_audit_and_reports",
    up: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        request_id UUID NOT NULL DEFAULT gen_random_uuid(),
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        agent_wallet TEXT,
        agent_tier TEXT DEFAULT 'unknown',
        ip_address TEXT,
        endpoint TEXT NOT NULL,
        target_address TEXT NOT NULL,
        chain TEXT DEFAULT 'base',
        request_params JSONB,
        verdict TEXT NOT NULL,
        trust_score NUMERIC(5,2),
        trust_grade TEXT,
        risk_flags TEXT[],
        proceed BOOLEAN,
        response_time_ms INTEGER,
        cache_hit BOOLEAN DEFAULT FALSE,
        attestation_uid TEXT,
        x402_payment_amount TEXT,
        x402_payment_verified BOOLEAN,
        data_sources_used TEXT[],
        degraded_sources TEXT[],
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_wallet);
      CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_address);
      CREATE INDEX IF NOT EXISTS idx_audit_log_verdict ON audit_log(verdict);

      CREATE TABLE IF NOT EXISTS daily_reports (
        id SERIAL PRIMARY KEY,
        report_date DATE NOT NULL UNIQUE,
        total_verifications INTEGER,
        verdicts_json JSONB,
        endpoints_json JSONB,
        tiers_json JSONB,
        avg_response_ms INTEGER,
        cache_hit_rate NUMERIC(4,3),
        unique_agents INTEGER,
        unique_targets INTEGER,
        monitoring_changes INTEGER,
        webhooks_fired INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
  },
];

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sentinel_schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getLatestVersion() {
  const res = await pool.query(
    "SELECT COALESCE(MAX(version), 0) AS v FROM sentinel_schema_migrations"
  );
  return res.rows[0].v;
}

export async function runMigrations(logger) {
  if (!pool) return;

  try {
    await ensureMigrationsTable();
    const currentVersion = await getLatestVersion();
    const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

    if (pending.length === 0) {
      logger.info({ module: "db", version: currentVersion }, "Schema up to date");
      dbReady = true;
      return;
    }

    for (const migration of pending) {
      await pool.query("BEGIN");
      try {
        await pool.query(migration.up);
        await pool.query(
          "INSERT INTO sentinel_schema_migrations (version, name) VALUES ($1, $2)",
          [migration.version, migration.name]
        );
        await pool.query("COMMIT");
        logger.info({ module: "db", migration: migration.name, version: migration.version }, "Migration applied");
      } catch (e) {
        await pool.query("ROLLBACK");
        logger.error({ module: "db", migration: migration.name, err: e.message }, "Migration failed");
        throw e;
      }
    }

    dbReady = true;
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Migration runner failed — request logging disabled");
    dbReady = false;
  }
}

// ============================================================
// REQUEST LOGGING (non-blocking, fail-silent)
// ============================================================

export function logRequest({ callerWallet, endpoint, method, chainId, isContract, paymentAmount, paymentCurrency, verdict, responseTimeMs }) {
  if (!pool || !dbReady) return; // Silently skip if no DB

  // Fire-and-forget — never awaited by the caller
  pool.query(
    `INSERT INTO request_log
       (caller_wallet, endpoint, method, chain_id, is_contract, payment_amount, payment_currency, verdict, response_time_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      callerWallet,
      endpoint,
      method,
      chainId || null,
      isContract,
      paymentAmount || null,
      paymentCurrency || null,
      verdict || null,
      responseTimeMs || null,
    ]
  ).catch(() => {}); // Swallow errors — logging must never affect core service
}

// ============================================================
// ADMIN STATS QUERIES
// ============================================================

export async function getStats() {
  if (!pool || !dbReady) return null;

  const [summary, topEndpoints, topCallers, overTime, recent] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS total_requests,
        COUNT(DISTINCT caller_wallet)::int AS unique_callers,
        COUNT(*) FILTER (WHERE is_contract = true)::int AS contract_callers,
        COUNT(*) FILTER (WHERE is_contract = false)::int AS eoa_callers,
        COALESCE(SUM(payment_amount) FILTER (WHERE payment_currency = 'USDC'), 0)::numeric AS total_revenue_usdc
      FROM request_log
    `),
    pool.query(`
      SELECT endpoint, COUNT(*)::int AS count
      FROM request_log
      GROUP BY endpoint
      ORDER BY count DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT
        caller_wallet AS wallet,
        COUNT(*)::int AS requests,
        bool_or(is_contract) AS is_contract,
        MIN(timestamp) AS first_seen,
        MAX(timestamp) AS last_seen
      FROM request_log
      GROUP BY caller_wallet
      ORDER BY requests DESC
      LIMIT 20
    `),
    pool.query(`
      SELECT
        DATE(timestamp) AS date,
        COUNT(*)::int AS count
      FROM request_log
      WHERE timestamp >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(timestamp)
      ORDER BY date DESC
    `),
    pool.query(`
      SELECT caller_wallet, endpoint, timestamp, verdict, response_time_ms
      FROM request_log
      ORDER BY timestamp DESC
      LIMIT 50
    `),
  ]);

  return {
    summary: summary.rows[0],
    top_endpoints: topEndpoints.rows,
    top_callers: topCallers.rows,
    requests_over_time: overTime.rows,
    recent_requests: recent.rows,
  };
}

export function isDbReady() {
  return dbReady;
}
