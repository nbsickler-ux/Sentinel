// ============================================================
// DATA STALENESS TRACKER
// Tracks when each data source last changed to skip redundant
// Claude API calls when inputs haven't changed.
// ============================================================

import crypto from "crypto";
import logger from "../logger.js";

// In-memory cache: sourceName → { hash, timestamp, cycle }
const sourceCache = new Map();
let lastQualCycle = null;
let unchangedCycles = 0;

/**
 * Hash a data payload for change detection.
 */
function hashData(data) {
  return crypto.createHash("md5").update(JSON.stringify(data)).digest("hex");
}

/**
 * Check if a specific source's data has changed since last cycle.
 *
 * @param {string} sourceName
 * @param {*} newData
 * @returns {boolean}
 */
export function hasSourceChanged(sourceName, newData) {
  const newHash = hashData(newData);
  const cached = sourceCache.get(sourceName);

  if (!cached || cached.hash !== newHash) {
    return true;
  }
  return false;
}

/**
 * Determine if the qualitative layer should run this cycle.
 * Only runs if news, fred, or coinbase data has changed.
 *
 * @param {Object} ingestResult - Result from ingestAll()
 * @returns {boolean}
 */
export function shouldRunQualitative(ingestResult) {
  const points = ingestResult.points || [];
  const bySource = ingestResult.summary?.bySource || {};

  // Check if qualitative-relevant sources have changed
  const qualSources = ["newsapi", "benzinga", "fred", "coinbase"];
  let anyChanged = false;

  for (const source of qualSources) {
    const sourcePoints = points.filter((p) => p.source === source);
    if (sourcePoints.length > 0) {
      const newHash = hashData(sourcePoints);
      const cached = sourceCache.get(source);
      if (!cached || cached.hash !== newHash) {
        anyChanged = true;
        break;
      }
    }
  }

  if (anyChanged) {
    unchangedCycles = 0;
    return true;
  }

  unchangedCycles++;

  // Force refresh every 10 cycles (10 minutes at 60s intervals) regardless
  if (unchangedCycles >= 10) {
    logger.info({ module: "staleness", unchangedCycles }, "Force-refreshing qualitative after 10 unchanged cycles");
    unchangedCycles = 0;
    return true;
  }

  return false;
}

/**
 * Update the staleness cache with current cycle's data.
 *
 * @param {Object} ingestResult
 */
export function updateCache(ingestResult) {
  const points = ingestResult.points || [];

  // Group points by source and hash each
  const bySource = {};
  for (const point of points) {
    if (!bySource[point.source]) bySource[point.source] = [];
    bySource[point.source].push(point);
  }

  for (const [source, sourcePoints] of Object.entries(bySource)) {
    sourceCache.set(source, {
      hash: hashData(sourcePoints),
      timestamp: Date.now(),
      count: sourcePoints.length,
    });
  }
}

/**
 * Get the number of consecutive unchanged cycles.
 */
export function getUnchangedCycles() {
  return unchangedCycles;
}
