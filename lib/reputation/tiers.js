// ============================================================
// REPUTATION TIER DEFINITIONS
// Pure functions for tier calculation, TTL overrides, and
// OFAC skip logic. No side effects, no I/O.
// ============================================================

/**
 * Calculate the correct tier for an agent profile.
 * Pure function — given a profile, returns the tier string.
 *
 * @param {Object} profile - Agent profile from store
 * @returns {string} "unknown" | "recognized" | "trusted"
 */
export function recalculateTier(profile) {
  if (
    profile.total_verifications >= 20 &&
    profile.flagged_transactions === 0 &&
    profile.verifications_30d >= 5
  ) {
    return "trusted";
  }

  if (
    profile.total_verifications >= 5 &&
    profile.flagged_transactions === 0
  ) {
    return "recognized";
  }

  return "unknown";
}

/**
 * Get cache TTLs adjusted for agent tier.
 * Returns a copy of the base TTLs with tier-specific overrides.
 *
 * @param {string} tier - Agent tier
 * @param {Object} baseTTLs - Base CACHE_TTL object from server.js
 * @returns {Object} Adjusted TTLs
 */
export function getTierCacheTTLs(tier, baseTTLs) {
  const base = { ...baseTTLs };

  if (tier === "recognized") {
    return {
      ...base,
      preflight: 600,       // 10 min (from 5 min)
      counterparty: 1800,   // 30 min (from 15 min)
    };
  }

  if (tier === "trusted") {
    return {
      ...base,
      preflight: 900,            // 15 min (from 5 min)
      counterparty: 3600,        // 1 hour (from 15 min)
      contractMetadata: 172800,  // 48 hours (from 24 hours)
    };
  }

  return base; // unknown — standard TTLs
}

/**
 * Determine if OFAC re-check can be skipped for this agent.
 * Based on tier and recency of last clean OFAC screen.
 *
 * @param {Object} profile - Agent profile
 * @returns {boolean} Whether to skip OFAC re-check
 */
export function shouldSkipOfacRecheck(profile) {
  if (!profile || !profile.last_ofac_check) return false;

  const hoursSinceCheck = (Date.now() - new Date(profile.last_ofac_check).getTime()) / (1000 * 60 * 60);

  if (profile.tier === "recognized" && hoursSinceCheck < 24) return true;
  if (profile.tier === "trusted" && hoursSinceCheck < 48) return true;

  return false;
}
