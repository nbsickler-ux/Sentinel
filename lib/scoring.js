// ============================================================
// SENTINEL — Pure Scoring & Utility Functions
// Extracted for testability (no side effects on import)
// ============================================================

const VERSION = "0.4.0";

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

// Trust grade thresholds
function gradeFromScore(score) {
  if (score >= 85) return { grade: "A", verdict: "SAFE" };
  if (score >= 70) return { grade: "B", verdict: "LOW_RISK" };
  if (score >= 55) return { grade: "C", verdict: "CAUTION" };
  if (score >= 40) return { grade: "D", verdict: "HIGH_RISK" };
  return { grade: "F", verdict: "DANGER" };
}

function scoreToken(security, market) {
  const startTime = Date.now();
  const dimensions = {};
  const riskFlags = [];

  // Determine confidence based on data availability
  const confidence = security.available ? 0.90 : 0.50;

  if (!security.available) {
    return {
      verdict: "UNKNOWN",
      trust_grade: "N/A",
      trust_score: null,
      confidence,
      dimensions: {},
      risk_flags: ["No security data available for this token"],
      meta: { response_time_ms: Date.now() - startTime, data_freshness: new Date().toISOString(), sentinel_version: VERSION },
    };
  }

  // 1. Honeypot & Scam Detection (30%)
  let honeypotScore = 95;
  if (security.is_honeypot) { honeypotScore = 0; riskFlags.push("HONEYPOT DETECTED - do not interact"); }
  if (security.honeypot_with_same_creator) { honeypotScore = Math.min(honeypotScore, 10); riskFlags.push("Creator has deployed honeypots before"); }
  if (security.is_airdrop_scam) { honeypotScore = Math.min(honeypotScore, 5); riskFlags.push("Identified as airdrop scam"); }
  if (security.cannot_sell_all) { honeypotScore = Math.min(honeypotScore, 15); riskFlags.push("Cannot sell all tokens - partial honeypot"); }
  if (security.cannot_buy) { honeypotScore = Math.min(honeypotScore, 20); riskFlags.push("Buying is restricted"); }
  dimensions.honeypot_safety = { score: honeypotScore, detail: security.is_honeypot ? "Honeypot detected" : "No honeypot indicators" };

  // 2. Tax Analysis (20%)
  let taxScore = 90;
  const buyTax = security.buy_tax || 0;
  const sellTax = security.sell_tax || 0;
  if (buyTax > 0.10 || sellTax > 0.10) { taxScore -= 30; riskFlags.push(`High tax: buy ${(buyTax * 100).toFixed(1)}% / sell ${(sellTax * 100).toFixed(1)}%`); }
  else if (buyTax > 0.05 || sellTax > 0.05) { taxScore -= 15; }
  if (security.slippage_modifiable) { taxScore -= 20; riskFlags.push("Slippage is modifiable by owner"); }
  if (security.personal_slippage_modifiable) { taxScore -= 15; riskFlags.push("Personal slippage can be modified per-address"); }
  dimensions.tax_fairness = { score: Math.max(0, taxScore), detail: `Buy tax: ${(buyTax * 100).toFixed(1)}%, Sell tax: ${(sellTax * 100).toFixed(1)}%` };

  // 3. Ownership & Control (25%)
  let ownerScore = 75;
  if (security.hidden_owner) { ownerScore -= 30; riskFlags.push("Hidden owner detected"); }
  if (security.can_take_back_ownership) { ownerScore -= 20; riskFlags.push("Ownership can be reclaimed"); }
  if (security.owner_change_balance) { ownerScore -= 25; riskFlags.push("Owner can modify balances"); }
  if (security.is_mintable) { ownerScore -= 10; riskFlags.push("Token is mintable - supply can increase"); }
  if (security.transfer_pausable) { ownerScore -= 10; riskFlags.push("Transfers can be paused"); }
  if (!security.is_open_source) { ownerScore -= 15; riskFlags.push("Contract source is not verified"); }
  if (security.is_proxy) { ownerScore -= 5; riskFlags.push("Proxy contract - logic can be upgraded"); }
  if (security.owner_percent && security.owner_percent > 10) { ownerScore -= 15; riskFlags.push(`Owner holds ${security.owner_percent.toFixed(1)}% of supply`); }
  dimensions.ownership_risk = { score: Math.max(0, ownerScore), detail: `Open source: ${security.is_open_source}. Mintable: ${security.is_mintable}. Owner balance: ${security.owner_percent ? security.owner_percent.toFixed(1) + "%" : "unknown"}` };

  // 4. Liquidity & Holder Distribution (15%)
  let liquidityScore = 60;
  if (security.holder_count && security.holder_count > 10000) liquidityScore += 25;
  else if (security.holder_count && security.holder_count > 1000) liquidityScore += 15;
  else if (security.holder_count && security.holder_count > 100) liquidityScore += 5;
  else if (security.holder_count && security.holder_count < 50) { liquidityScore -= 20; riskFlags.push(`Only ${security.holder_count} holders`); }
  if (security.creator_percent && security.creator_percent > 20) { liquidityScore -= 15; riskFlags.push(`Creator holds ${security.creator_percent.toFixed(1)}% of supply`); }
  if (security.is_anti_whale) liquidityScore += 5;
  if (market.available && market.tvl && market.tvl > 10_000_000) liquidityScore += 10;
  dimensions.liquidity_distribution = { score: Math.min(100, Math.max(0, liquidityScore)), detail: `Holders: ${security.holder_count || "unknown"}. LP holders: ${security.lp_holder_count || "unknown"}` };

  // 5. Trading Restrictions (10%)
  let tradingScore = 85;
  if (security.trading_cooldown) { tradingScore -= 15; riskFlags.push("Trading cooldown enforced"); }
  if (security.is_blacklisted) { tradingScore -= 20; riskFlags.push("Blacklist function exists"); }
  if (security.is_whitelisted) { tradingScore -= 10; riskFlags.push("Whitelist function exists - restricted trading"); }
  dimensions.trading_freedom = { score: Math.max(0, tradingScore), detail: `Cooldown: ${security.trading_cooldown}. Blacklist: ${security.is_blacklisted}. Whitelist: ${security.is_whitelisted}` };

  // Weighted composite
  const weights = { honeypot_safety: 0.30, tax_fairness: 0.20, ownership_risk: 0.25, liquidity_distribution: 0.15, trading_freedom: 0.10 };
  const compositeScore = Math.round(
    Object.entries(weights).reduce((sum, [key, weight]) => sum + (dimensions[key]?.score || 0) * weight, 0)
  );
  const { grade, verdict } = gradeFromScore(compositeScore);

  return { verdict, trust_grade: grade, trust_score: compositeScore, confidence, dimensions, risk_flags: riskFlags, meta: { response_time_ms: Date.now() - startTime, data_freshness: new Date().toISOString(), sentinel_version: VERSION } };
}

function generatePositionRecommendations(riskFlags, score) {
  const recs = [];
  if (score < 40) recs.push("Consider exiting this position - risk level is elevated");
  if (score < 55) recs.push("Set stop-loss or exit triggers if the protocol supports it");
  if (riskFlags.some(f => f.includes("Bridge"))) recs.push("Minimize time assets spend in bridge contracts");
  if (riskFlags.some(f => f.includes("TVL volatility"))) recs.push("Monitor TVL trends - rapid outflows may signal issues");
  if (riskFlags.some(f => f.includes("Algo-Stables"))) recs.push("Limit exposure to algorithmic stablecoin positions");
  if (riskFlags.some(f => f.includes("Low-TVL"))) recs.push("Consider splitting across multiple protocols to reduce concentration");
  if (score >= 70) recs.push("Position is in a well-established protocol - standard monitoring recommended");
  return recs;
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
