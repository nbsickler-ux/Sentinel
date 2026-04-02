// ============================================================
// BACKGROUND RISK SCANNER
// Periodically re-scores watched addresses and fires webhooks
// when significant risk changes are detected.
// ============================================================

import axios from "axios";
import { getWatchlist, updateBaseline } from "./watchlist.js";

let logger = null;
let scoringFunctions = {}; // { protocol: fn, token: fn, counterparty: fn }
let intervalId = null;
let version = "0.4.0";

const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const CRITICAL_FLAGS = ["SANCTIONED", "EXPLOIT_VICTIM", "HONEYPOT", "RUG_PULL"];

/**
 * Initialize scanner with dependencies.
 * @param {Object} deps - { logger, scoreProtocol, scoreCounterparty, scoreToken, VERSION }
 */
export function initScanner(deps) {
  logger = deps.logger;
  version = deps.VERSION || version;
  scoringFunctions = {
    protocol: deps.scoreProtocol,
    token: deps.scoreToken,
    counterparty: deps.scoreCounterparty,
  };
}

/**
 * Detect significant changes between baseline and current result.
 * @returns {Object[]|null} Array of changes, or null if no significant change
 */
export function detectChange(baseline, current) {
  if (!baseline || !current) return null;

  const changes = [];

  if (baseline.verdict !== current.verdict) {
    changes.push({ type: "verdict_change", from: baseline.verdict, to: current.verdict });
  }

  if (Math.abs((baseline.trust_score || 0) - (current.trust_score || 0)) > 15) {
    changes.push({
      type: "score_shift",
      from: baseline.trust_score,
      to: current.trust_score,
      delta: (current.trust_score || 0) - (baseline.trust_score || 0),
    });
  }

  const newCritical = (current.risk_flags || []).filter(
    f => CRITICAL_FLAGS.includes(f) && !(baseline.risk_flags || []).includes(f)
  );
  if (newCritical.length > 0) {
    changes.push({ type: "critical_flag", flags: newCritical });
  }

  return changes.length > 0 ? changes : null;
}

/**
 * Send a webhook notification to a subscriber.
 * Retries once after 30 seconds on failure.
 */
async function fireWebhook(webhookUrl, payload) {
  try {
    await axios.post(webhookUrl, payload, { timeout: 5000 });
    if (logger) logger.info({ module: "scanner", url: webhookUrl, target: payload.target }, "Webhook delivered");
    return true;
  } catch (err) {
    if (logger) logger.warn({ module: "scanner", url: webhookUrl, err: err.message }, "Webhook delivery failed — retrying in 30s");

    // Retry once after 30 seconds
    setTimeout(async () => {
      try {
        await axios.post(webhookUrl, payload, { timeout: 5000 });
        if (logger) logger.info({ module: "scanner", url: webhookUrl }, "Webhook retry succeeded");
      } catch (retryErr) {
        if (logger) logger.error({ module: "scanner", url: webhookUrl, err: retryErr.message }, "Webhook retry failed — giving up");
      }
    }, 30000);

    return false;
  }
}

/**
 * Run a single scan cycle.
 * @returns {Object} { scanned, changes, webhooks }
 */
export async function scanOnce() {
  const entries = await getWatchlist();
  const now = Date.now();

  let scanned = 0;
  let changesDetected = 0;
  let webhooksFired = 0;

  for (const entry of entries) {
    // Check if this entry is due for a scan
    const lastChecked = entry.last_checked ? new Date(entry.last_checked).getTime() : 0;
    const intervalMs = (entry.check_interval_hours || 6) * 60 * 60 * 1000;

    if (now - lastChecked < intervalMs) continue; // Not due yet

    // Determine which scoring function to use
    const endpointTypes = [...new Set(entry.subscribers.map(s => s.endpoint_type))];
    const scoreFn = scoringFunctions[endpointTypes[0] || "protocol"];
    if (!scoreFn) continue;

    try {
      const result = await scoreFn(entry.target, entry.chain);
      scanned++;

      const current = {
        trust_score: result.trust_score || result.composite_score,
        verdict: result.verdict,
        trust_grade: result.trust_grade,
        risk_flags: result.risk_flags || [],
        checked_at: new Date().toISOString(),
      };

      // Detect changes
      const changes = detectChange(entry.baseline, current);

      if (changes) {
        changesDetected++;

        const payload = {
          event: "risk_change",
          target: entry.target,
          chain: entry.chain,
          changes,
          current,
          previous: entry.baseline,
          checked_at: current.checked_at,
          sentinel_version: version,
        };

        // Fire webhooks to all subscribers
        for (const sub of entry.subscribers) {
          await fireWebhook(sub.webhook_url, payload);
          webhooksFired++;
        }
      }

      // Update baseline
      await updateBaseline(entry.target, entry.chain, current);
    } catch (err) {
      if (logger) logger.error({ module: "scanner", target: entry.target, err: err.message }, "Scan failed for target");
    }
  }

  if (logger) {
    logger.info({ module: "scanner", scanned, changesDetected, webhooksFired, totalWatched: entries.length }, "Scan cycle complete");
  }

  return { scanned, changes: changesDetected, webhooks: webhooksFired };
}

/**
 * Start the periodic scan loop.
 */
export function startScanner() {
  if (intervalId) return; // Already running
  scanOnce(); // Run immediately
  intervalId = setInterval(scanOnce, SCAN_INTERVAL_MS);
  if (logger) logger.info({ module: "scanner", intervalMinutes: SCAN_INTERVAL_MS / 60000 }, "Background scanner started");
}

/**
 * Stop the scan loop (for graceful shutdown).
 */
export function stopScanner() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    if (logger) logger.info({ module: "scanner" }, "Background scanner stopped");
  }
}
