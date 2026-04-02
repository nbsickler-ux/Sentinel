// ============================================================
// COMPLIANCE AUDIT LOG
// Structured verification records in Postgres.
// All writes are fire-and-forget — never block API responses.
// ============================================================

let pool = null;
let logger = null;
let ready = false;

/**
 * Initialize audit log with a Postgres pool and logger.
 */
export function initAuditLog(dbPool, log) {
  pool = dbPool;
  logger = log;
  ready = !!pool;
}

// Keys to strip from request params before writing to audit log
const SENSITIVE_KEYS = new Set([
  "apikey", "api_key", "secret", "password", "token", "privatekey",
  "private_key", "authorization", "x-bypass-secret", "credential",
]);

/**
 * Strip sensitive fields from request params before audit logging.
 */
function sanitizeParams(params) {
  if (!params || typeof params !== "object") return {};
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    if (!SENSITIVE_KEYS.has(key.toLowerCase())) {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Write a single audit record. Fire-and-forget.
 * @param {Object} entry - Audit record fields
 */
export function writeAuditLog(entry) {
  if (!pool || !ready) return;

  pool.query(
    `INSERT INTO audit_log
      (agent_wallet, agent_tier, ip_address, endpoint, target_address, chain,
       request_params, verdict, trust_score, trust_grade, risk_flags, proceed,
       response_time_ms, cache_hit, attestation_uid,
       x402_payment_amount, x402_payment_verified,
       data_sources_used, degraded_sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      entry.agent_wallet || null,
      entry.agent_tier || "unknown",
      entry.ip_address || null,
      entry.endpoint,
      entry.target_address,
      entry.chain || "base",
      JSON.stringify(sanitizeParams(entry.request_params)),
      entry.verdict,
      entry.trust_score || null,
      entry.trust_grade || null,
      entry.risk_flags || [],
      entry.proceed ?? null,
      entry.response_time_ms || null,
      entry.cache_hit || false,
      entry.attestation_uid || null,
      entry.x402_payment_amount || null,
      entry.x402_payment_verified ?? true,
      entry.data_sources_used || [],
      entry.degraded_sources || [],
    ]
  ).catch((err) => {
    if (logger) logger.error({ module: "audit", err: err.message }, "Audit log write failed");
  });
}

/**
 * Query audit records with filters. For admin/compliance use.
 * @param {Object} filters - { agent_wallet, target_address, verdict, from, to, limit, offset }
 * @returns {Object} { records, total }
 */
export async function getAuditHistory(filters = {}) {
  if (!pool || !ready) return { records: [], total: 0 };

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (filters.agent_wallet) {
    conditions.push(`agent_wallet = $${paramIdx++}`);
    params.push(filters.agent_wallet.toLowerCase());
  }
  if (filters.target_address) {
    conditions.push(`target_address = $${paramIdx++}`);
    params.push(filters.target_address.toLowerCase());
  }
  if (filters.verdict) {
    conditions.push(`verdict = $${paramIdx++}`);
    params.push(filters.verdict);
  }
  if (filters.endpoint) {
    conditions.push(`endpoint = $${paramIdx++}`);
    params.push(filters.endpoint);
  }
  if (filters.from) {
    conditions.push(`timestamp >= $${paramIdx++}`);
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`timestamp <= $${paramIdx++}`);
    params.push(filters.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters.limit || 50, 200);
  const offset = filters.offset || 0;

  const [records, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM audit_log ${where}`,
      params
    ),
  ]);

  return {
    records: records.rows,
    total: countResult.rows[0]?.total || 0,
  };
}

/**
 * Get audit summary stats for a time period.
 * @param {string} period - "24h", "7d", or "30d"
 */
export async function getAuditSummary(period = "30d") {
  if (!pool || !ready) return null;

  const intervalMap = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
  const interval = intervalMap[period] || "30 days";

  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_verifications,
      jsonb_object_agg(
        COALESCE(verdict, 'UNKNOWN'),
        cnt
      ) FILTER (WHERE verdict IS NOT NULL) AS by_verdict,
      jsonb_object_agg(
        COALESCE(endpoint, 'unknown'),
        ep_cnt
      ) FILTER (WHERE endpoint IS NOT NULL) AS by_endpoint,
      jsonb_object_agg(
        COALESCE(agent_tier, 'unknown'),
        tier_cnt
      ) FILTER (WHERE agent_tier IS NOT NULL) AS by_tier,
      COALESCE(AVG(response_time_ms), 0)::int AS avg_response_time_ms,
      COALESCE(AVG(CASE WHEN cache_hit THEN 1.0 ELSE 0.0 END), 0)::numeric(4,3) AS cache_hit_rate,
      COUNT(DISTINCT agent_wallet)::int AS unique_agents,
      COUNT(DISTINCT target_address)::int AS unique_targets,
      COALESCE(AVG(CASE WHEN array_length(degraded_sources, 1) > 0 THEN 1.0 ELSE 0.0 END), 0)::numeric(4,3) AS degraded_percentage
    FROM (
      SELECT *,
        COUNT(*) OVER (PARTITION BY verdict) AS cnt,
        COUNT(*) OVER (PARTITION BY endpoint) AS ep_cnt,
        COUNT(*) OVER (PARTITION BY agent_tier) AS tier_cnt
      FROM audit_log
      WHERE timestamp >= NOW() - INTERVAL '${interval}'
    ) sub
  `);

  // The above query is complex — use simpler individual queries instead
  const [total, byVerdict, byEndpoint, byTier, perf] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM audit_log WHERE timestamp >= NOW() - INTERVAL '${interval}'`),
    pool.query(`SELECT verdict, COUNT(*)::int AS count FROM audit_log WHERE timestamp >= NOW() - INTERVAL '${interval}' GROUP BY verdict`),
    pool.query(`SELECT endpoint, COUNT(*)::int AS count FROM audit_log WHERE timestamp >= NOW() - INTERVAL '${interval}' GROUP BY endpoint`),
    pool.query(`SELECT agent_tier, COUNT(*)::int AS count FROM audit_log WHERE timestamp >= NOW() - INTERVAL '${interval}' GROUP BY agent_tier`),
    pool.query(`
      SELECT
        COALESCE(AVG(response_time_ms), 0)::int AS avg_response_time_ms,
        COALESCE(AVG(CASE WHEN cache_hit THEN 1.0 ELSE 0.0 END), 0)::numeric(4,3) AS cache_hit_rate,
        COUNT(DISTINCT agent_wallet)::int AS unique_agents,
        COUNT(DISTINCT target_address)::int AS unique_targets,
        COALESCE(AVG(CASE WHEN array_length(degraded_sources, 1) > 0 THEN 1.0 ELSE 0.0 END), 0)::numeric(4,3) AS degraded_percentage
      FROM audit_log
      WHERE timestamp >= NOW() - INTERVAL '${interval}'
    `),
  ]);

  const toObj = (rows) => rows.reduce((acc, r) => { acc[r.verdict || r.endpoint || r.agent_tier || "unknown"] = r.count; return acc; }, {});

  return {
    total_verifications: total.rows[0]?.total || 0,
    period,
    by_verdict: toObj(byVerdict.rows),
    by_endpoint: toObj(byEndpoint.rows),
    by_tier: toObj(byTier.rows),
    ...perf.rows[0],
  };
}

/**
 * Generate and store a daily report.
 */
export async function generateDailyReport() {
  if (!pool || !ready) return null;

  const summary = await getAuditSummary("24h");
  if (!summary) return null;

  const reportDate = new Date().toISOString().slice(0, 10);

  await pool.query(
    `INSERT INTO daily_reports
      (report_date, total_verifications, verdicts_json, endpoints_json, tiers_json,
       avg_response_ms, cache_hit_rate, unique_agents, unique_targets,
       monitoring_changes, webhooks_fired)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (report_date) DO UPDATE SET
       total_verifications = EXCLUDED.total_verifications,
       verdicts_json = EXCLUDED.verdicts_json,
       endpoints_json = EXCLUDED.endpoints_json,
       tiers_json = EXCLUDED.tiers_json,
       avg_response_ms = EXCLUDED.avg_response_ms,
       cache_hit_rate = EXCLUDED.cache_hit_rate,
       unique_agents = EXCLUDED.unique_agents,
       unique_targets = EXCLUDED.unique_targets`,
    [
      reportDate,
      summary.total_verifications,
      JSON.stringify(summary.by_verdict),
      JSON.stringify(summary.by_endpoint),
      JSON.stringify(summary.by_tier),
      summary.avg_response_time_ms,
      summary.cache_hit_rate,
      summary.unique_agents,
      summary.unique_targets,
      0, // monitoring_changes — updated by scanner
      0, // webhooks_fired — updated by scanner
    ]
  ).catch(() => {});

  return summary;
}
