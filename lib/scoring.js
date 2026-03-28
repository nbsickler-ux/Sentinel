// ============================================================
// SENTINEL — Public Scoring Interface
// Delegates to private scoring engine (lib/scoring-engine/)
// ============================================================

// Re-export scoring functions from the private engine
import {
  gradeFromScore,
  scoreToken,
  generatePositionRecommendations,
  VERSION,
} from "./scoring-engine/index.js";

// Response detail levels
const DETAIL_LEVELS = ["full", "standard", "minimal"];

function filterResponse(result, detailLevel) {
  if (detailLevel === "full") return result;

  if (detailLevel === "minimal") {
    return {
      address: result.address || result.protocol_address,
      chain: result.chain,
      verdict: result.verdict,
      trust_grade: result.trust_grade,
      confidence: result.confidence,
      token_name: result.token_name || undefined,
      token_symbol: result.token_symbol || undefined,
      meta: result.meta,
    };
  }

  // "standard" — remove dimension scores but keep evidence and flags
  const filtered = { ...result };
  delete filtered.dimensions;
  delete filtered.trust_score;
  return filtered;
}

/**
 * Check sanctions against a provided set (dependency-injected for testability)
 */
function checkSanctionsWithSet(address, sanctionedAddresses, sanctionsLoaded) {
  const normalized = address.toLowerCase();
  const isSanctioned = sanctionedAddresses.has(normalized);
  return {
    sanctioned: isSanctioned,
    list: isSanctioned ? "OFAC SDN" : null,
    list_loaded: sanctionsLoaded,
    addresses_indexed: sanctionedAddresses.size,
  };
}

/**
 * Check exploit association against a provided registry (dependency-injected)
 */
function checkExploitAssociationWithRegistry(address, protocolRegistry) {
  const normalized = address.toLowerCase();
  const protocol = protocolRegistry[normalized];
  if (protocol && protocol.hacked) {
    return {
      associated: true,
      protocol_name: protocol.name,
      hack_date: protocol.hackDate,
      hack_amount: protocol.hackAmount,
    };
  }
  return { associated: false };
}

export {
  VERSION,
  DETAIL_LEVELS,
  filterResponse,
  gradeFromScore,
  scoreToken,
  generatePositionRecommendations,
  checkSanctionsWithSet,
  checkExploitAssociationWithRegistry,
};
