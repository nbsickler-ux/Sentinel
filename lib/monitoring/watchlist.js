// ============================================================
// MONITORING WATCHLIST
// Redis-backed subscription management for risk change alerts.
// Entries auto-expire after 30 days to prevent unbounded growth.
// ============================================================

const WATCH_PREFIX = "sentinel:watch:";
const WATCH_INDEX = "sentinel:watch:index"; // Set of all active watch keys
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_TOTAL_WATCHES = 100;
const MAX_PER_AGENT = 10;

let redis = null;
let logger = null;

export function initWatchlist(redisClient, log) {
  redis = redisClient;
  logger = log;
}

function watchKey(target, chain) {
  return `${WATCH_PREFIX}${target.toLowerCase()}:${chain}`;
}

/**
 * Add a monitoring subscription.
 * @returns {Object} { success, error?, expires_at? }
 */
export async function addWatch(target, chain, subscriberWallet, webhookUrl, endpointType) {
  if (!redis) return { success: false, error: "Redis unavailable" };

  // Check total watch count
  const totalKeys = await redis.scard(WATCH_INDEX);
  if (totalKeys >= MAX_TOTAL_WATCHES) {
    return { success: false, error: `Maximum watched addresses reached (${MAX_TOTAL_WATCHES}). Try again when a watch expires.` };
  }

  const key = watchKey(target, chain);
  const existing = await redis.get(key);
  const entry = existing ? (typeof existing === "string" ? JSON.parse(existing) : existing) : {
    target: target.toLowerCase(),
    chain,
    subscribers: [],
    baseline: null,
    last_checked: null,
    check_interval_hours: 6,
  };

  // Check per-agent limit
  const agentWatchCount = entry.subscribers.filter(s => s.wallet.toLowerCase() === subscriberWallet.toLowerCase()).length;
  if (agentWatchCount > 0) {
    // Already subscribed — renew TTL
    await redis.expire(key, TTL_SECONDS);
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
    return { success: true, renewed: true, expires_at: expiresAt };
  }

  // Check total watches for this agent across all targets
  const allKeys = await redis.smembers(WATCH_INDEX);
  let agentTotal = 0;
  for (const k of allKeys) {
    const data = await redis.get(k);
    if (data) {
      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      agentTotal += (parsed.subscribers || []).filter(s => s.wallet.toLowerCase() === subscriberWallet.toLowerCase()).length;
    }
  }
  if (agentTotal >= MAX_PER_AGENT) {
    return { success: false, error: `Maximum watches per agent reached (${MAX_PER_AGENT}).` };
  }

  // Add subscriber
  entry.subscribers.push({
    wallet: subscriberWallet.toLowerCase(),
    webhook_url: webhookUrl,
    subscribed_at: new Date().toISOString(),
    endpoint_type: endpointType,
  });

  await redis.set(key, JSON.stringify(entry), { ex: TTL_SECONDS });
  await redis.sadd(WATCH_INDEX, key);

  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
  if (logger) logger.info({ module: "watchlist", target, chain, subscriber: subscriberWallet }, "Watch subscription added");
  return { success: true, expires_at: expiresAt };
}

/**
 * Remove a subscriber from a watch.
 */
export async function removeWatch(target, chain, subscriberWallet) {
  if (!redis) return { success: false };

  const key = watchKey(target, chain);
  const data = await redis.get(key);
  if (!data) return { success: true }; // Already gone

  const entry = typeof data === "string" ? JSON.parse(data) : data;
  entry.subscribers = entry.subscribers.filter(s => s.wallet.toLowerCase() !== subscriberWallet.toLowerCase());

  if (entry.subscribers.length === 0) {
    await redis.del(key);
    await redis.srem(WATCH_INDEX, key);
  } else {
    await redis.set(key, JSON.stringify(entry), { ex: TTL_SECONDS });
  }

  if (logger) logger.info({ module: "watchlist", target, chain, subscriber: subscriberWallet }, "Watch subscription removed");
  return { success: true };
}

/**
 * Get all active watched entries (for scanner).
 */
export async function getWatchlist() {
  if (!redis) return [];

  const keys = await redis.smembers(WATCH_INDEX);
  const entries = [];

  for (const key of keys) {
    const data = await redis.get(key);
    if (data) {
      entries.push(typeof data === "string" ? JSON.parse(data) : data);
    } else {
      // Key expired — clean up index
      await redis.srem(WATCH_INDEX, key);
    }
  }

  return entries;
}

/**
 * Get watches for a specific target.
 */
export async function getWatchesForTarget(target, chain) {
  if (!redis) return null;

  const key = watchKey(target, chain);
  const data = await redis.get(key);
  return data ? (typeof data === "string" ? JSON.parse(data) : data) : null;
}

/**
 * Update baseline after a re-check.
 */
export async function updateBaseline(target, chain, newBaseline) {
  if (!redis) return;

  const key = watchKey(target, chain);
  const data = await redis.get(key);
  if (!data) return;

  const entry = typeof data === "string" ? JSON.parse(data) : data;
  entry.baseline = newBaseline;
  entry.last_checked = new Date().toISOString();

  // Preserve existing TTL
  const ttl = await redis.ttl(key);
  await redis.set(key, JSON.stringify(entry), { ex: ttl > 0 ? ttl : TTL_SECONDS });
}

/**
 * Renew a watch's 30-day TTL.
 */
export async function renewWatch(target, chain, subscriberWallet) {
  if (!redis) return { success: false };

  const key = watchKey(target, chain);
  await redis.expire(key, TTL_SECONDS);
  return { success: true, expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString() };
}

/**
 * Get all watches for a specific agent wallet.
 */
export async function getWatchesForAgent(walletAddress) {
  if (!redis) return [];

  const allEntries = await getWatchlist();
  const wallet = walletAddress.toLowerCase();

  return allEntries
    .filter(entry => entry.subscribers.some(s => s.wallet.toLowerCase() === wallet))
    .map(entry => {
      const sub = entry.subscribers.find(s => s.wallet.toLowerCase() === wallet);
      return {
        target: entry.target,
        chain: entry.chain,
        endpoint_type: sub.endpoint_type,
        subscribed_at: sub.subscribed_at,
        last_checked: entry.last_checked,
        baseline: entry.baseline,
      };
    });
}
