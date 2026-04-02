// ============================================================
// AGENT REPUTATION STORE
// Redis-backed agent profile storage with rolling history.
// Profiles persist indefinitely; if Redis data is lost, agents
// restart as UNKNOWN — acceptable degradation.
// ============================================================

import { recalculateTier } from "./tiers.js";

const PROFILE_PREFIX = "sentinel:agent:";
const HISTORY_PREFIX = "sentinel:agent:history:";
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

let redis = null;
let logger = null;

/**
 * Initialize the reputation store with a Redis client and logger.
 * @param {Object} redisClient - Upstash Redis client
 * @param {Object} log - Pino logger
 */
export function initReputationStore(redisClient, log) {
  redis = redisClient;
  logger = log;
}

function defaultProfile(walletAddress) {
  return {
    wallet: walletAddress.toLowerCase(),
    tier: "unknown",
    total_verifications: 0,
    verifications_30d: 0,
    flagged_transactions: 0,
    last_verification: null,
    last_ofac_check: null,
    first_seen: new Date().toISOString(),
    tier_updated: null,
    metadata: {
      erc8004_registered: false,
      erc8004_agent_id: null,
      erc8004_trust_score: null,
    },
  };
}

/**
 * Get an agent's reputation profile, creating a default if none exists.
 * @param {string} walletAddress
 * @returns {Object} Agent profile
 */
export async function getAgentProfile(walletAddress) {
  if (!redis) return defaultProfile(walletAddress);

  try {
    const key = PROFILE_PREFIX + walletAddress.toLowerCase();
    const data = await redis.get(key);
    if (data) {
      const profile = typeof data === "string" ? JSON.parse(data) : data;
      // Refresh 30d count from sorted set
      profile.verifications_30d = await get30DayCount(walletAddress);
      return profile;
    }
  } catch (e) {
    // Redis read failed — return default
  }

  return defaultProfile(walletAddress);
}

/**
 * Quick tier lookup for hot path.
 * @param {string} walletAddress
 * @returns {string} "unknown" | "recognized" | "trusted"
 */
export async function getAgentTier(walletAddress) {
  if (!redis) return "unknown";

  try {
    const key = PROFILE_PREFIX + walletAddress.toLowerCase();
    const data = await redis.get(key);
    if (data) {
      const profile = typeof data === "string" ? JSON.parse(data) : data;
      return profile.tier || "unknown";
    }
  } catch (e) {
    // Fall through
  }
  return "unknown";
}

/**
 * Get rolling 30-day verification count from sorted set.
 */
async function get30DayCount(walletAddress) {
  if (!redis) return 0;

  try {
    const key = HISTORY_PREFIX + walletAddress.toLowerCase();
    const thirtyDaysAgo = Date.now() - THIRTY_DAYS_MS;
    const count = await redis.zcount(key, thirtyDaysAgo, "+inf");
    return count || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Update an agent's profile after a verification.
 * @param {string} walletAddress
 * @param {Object} verificationResult - { verdict, riskFlags, ofacClean }
 */
export async function updateAgentProfile(walletAddress, verificationResult) {
  if (!redis) return;

  const wallet = walletAddress.toLowerCase();

  try {
    // Get or create profile
    const profile = await getAgentProfile(wallet);

    // Update counters
    profile.total_verifications += 1;
    profile.last_verification = new Date().toISOString();

    // Check for flagged transactions
    const isUnsafe = verificationResult.verdict === "UNSAFE" || verificationResult.verdict === "DANGER";
    const hasSanctionFlags = (verificationResult.riskFlags || []).some(
      f => f === "SANCTIONED" || f === "EXPLOIT_ASSOCIATED"
    );
    if (isUnsafe || hasSanctionFlags) {
      profile.flagged_transactions += 1;
    }

    // Update OFAC check timestamp
    if (verificationResult.ofacClean) {
      profile.last_ofac_check = new Date().toISOString();
    }

    // Add to rolling history (sorted set with timestamp as score)
    const historyKey = HISTORY_PREFIX + wallet;
    const now = Date.now();
    await redis.zadd(historyKey, { score: now, member: now.toString() });

    // Prune entries older than 90 days
    const ninetyDaysAgo = now - NINETY_DAYS_MS;
    await redis.zremrangebyscore(historyKey, 0, ninetyDaysAgo);

    // Refresh 30d count
    profile.verifications_30d = await get30DayCount(wallet);

    // Recalculate tier
    const oldTier = profile.tier;
    profile.tier = recalculateTier(profile);

    if (profile.tier !== oldTier) {
      profile.tier_updated = new Date().toISOString();
      if (logger) {
        logger.info({
          module: "reputation",
          wallet,
          oldTier,
          newTier: profile.tier,
          totalVerifications: profile.total_verifications,
        }, `Agent tier changed: ${oldTier} → ${profile.tier}`);
      }
    }

    // Write back to Redis (no TTL — persists indefinitely)
    const profileKey = PROFILE_PREFIX + wallet;
    await redis.set(profileKey, JSON.stringify(profile));
  } catch (e) {
    if (logger) {
      logger.error({ module: "reputation", err: e.message, wallet }, "Agent profile update failed");
    }
  }
}
