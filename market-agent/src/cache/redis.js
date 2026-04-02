import { Redis } from "@upstash/redis";
import config from "../config.js";
import logger from "../logger.js";

// ============================================================
// REDIS CACHE LAYER
// Mirrors Sentinel's caching pattern (server.js:144-211)
// Namespace: "ma:" to isolate from Sentinel's "sentinel:" keys
// ============================================================

// TTLs in seconds — tuned to data velocity
export const CACHE_TTL = {
  "price:coinbase": 15,    // Near-real-time for arb detection
  "pool:aerodrome": 30,    // Pool state lags ~15s via subgraph
  "onchain:alchemy": 60,   // Batched per minute
  "price:coingecko": 120,  // Free tier rate limits
  "macro:fred": 21600,     // 6h — releases are daily/monthly
  "news": 900,             // 15m — articles don't change
  "orderbook": 10,         // Very short — order books are volatile
};

let redis = null;

if (config.upstash.url && config.upstash.token) {
  redis = new Redis({
    url: config.upstash.url,
    token: config.upstash.token,
  });
  logger.info({ service: "market-agent", feature: "redis" }, "Redis cache connected (Upstash)");
} else {
  logger.warn({ service: "market-agent", feature: "redis" }, "Redis not configured — running without cache");
}

/**
 * Build a namespaced cache key.
 * Pattern: ma:{type}:{source}:{identifier}
 */
export function cacheKey(type, source, identifier) {
  return `ma:${type}:${source}:${identifier}`;
}

/**
 * Get cached data or fetch fresh.
 * Mirrors Sentinel's cachedCall pattern exactly.
 *
 * Note: @upstash/redis auto-serializes/deserializes JSON,
 * so we pass objects directly — no manual JSON.stringify needed.
 */
export async function cachedFetch(key, ttlSeconds, fetchFn) {
  if (!redis) return fetchFn();

  try {
    const cached = await redis.get(key);
    if (cached) {
      if (cached.meta) cached.meta.cache_hit = true;
      return cached;
    }
  } catch (e) {
    logger.debug({ err: e.message, key }, "Redis read failed, computing fresh");
  }

  const result = await fetchFn();

  if (redis) {
    redis.set(key, result, { ex: ttlSeconds }).catch((e) => {
      logger.debug({ err: e.message, key }, "Redis write failed");
    });
  }

  if (result.meta) result.meta.cache_hit = false;
  return result;
}

/**
 * Direct cache write (for ingestion modules that always write fresh data).
 */
export async function cacheSet(key, data, ttlSeconds) {
  if (!redis) return;
  try {
    await redis.set(key, data, { ex: ttlSeconds });
  } catch (e) {
    logger.debug({ err: e.message, key }, "Redis write failed");
  }
}

/**
 * Direct cache read.
 */
export async function cacheGet(key) {
  if (!redis) return null;
  try {
    const data = await redis.get(key);
    return data || null;
  } catch (e) {
    logger.debug({ err: e.message, key }, "Redis read failed");
    return null;
  }
}

export { redis };
