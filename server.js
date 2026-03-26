// ============================================================
// SENTINEL — The Trust Layer for Autonomous Agents
// x402-Gated Verification Service
// ============================================================
//
// SETUP:
//   npm install
//   cp .env.example .env  (fill in your keys)
//   npm run dev
//
// Phase 1: /verify/protocol endpoint on Base Sepolia testnet
// Phase 2: /verify/token + /verify/position endpoints
// ============================================================

import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 4021;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const NETWORK = process.env.NETWORK || "base-sepolia";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const GOPLUS_API_KEY = process.env.GOPLUS_API_KEY || "";
const GOPLUS_API_SECRET = process.env.GOPLUS_API_SECRET || "";

// x402 network identifiers (CAIP-2 format)
const NETWORK_ID = {
  "base-sepolia": "eip155:84532",
  "base":         "eip155:8453",
};

// Pricing in USD strings (x402 v2 format)
const PRICE = {
  verifyProtocol:     "$0.008",
  verifyPosition:     "$0.005",
  verifyCounterparty: "$0.01",
  verifyToken:        "$0.005",
  preflight:          "$0.025",
};

// Response detail levels:
//   "full"    — all dimensions, scores, evidence (default for now, useful for debugging)
//   "standard"— verdict, grade, risk flags, evidence (no dimension scores)
//   "minimal" — verdict and grade only (maximum IP protection)
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


// ============================================================
// DATA LAYER
// Live integrations: DeFiLlama, Basescan, GoPlusLabs, Alchemy
// ============================================================

// --- Protocol Registry (loaded from DeFiLlama on startup) ---
// Maps contract addresses to protocol metadata for TVL + hack lookups
let protocolRegistry = {};   // address -> { slug, name, ... }
let registryLoaded = false;

async function loadProtocolRegistry() {
  try {
    console.log("  Loading DeFiLlama protocol registry...");
    const response = await axios.get("https://api.llama.fi/protocols", { timeout: 15000 });
    const protocols = response.data;

    for (const p of protocols) {
      // Index by all known contract addresses across chains
      const addresses = [];
      if (p.address) addresses.push(p.address.toLowerCase());
      // Some protocols list chain-specific addresses
      if (p.chainAddresses) {
        for (const [chain, addr] of Object.entries(p.chainAddresses)) {
          if (typeof addr === "string") addresses.push(addr.toLowerCase());
        }
      }

      for (const addr of addresses) {
        // Strip chain prefix if present (e.g., "base:0x...")
        const cleanAddr = addr.includes(":") ? addr.split(":")[1] : addr;
        if (cleanAddr && cleanAddr.startsWith("0x")) {
          protocolRegistry[cleanAddr] = {
            slug: p.slug,
            name: p.name,
            category: p.category,
            audits: p.audits,       // 0 = no, 1 = yes (limited data)
            audit_links: p.audit_links || [],
            hacked: p.hacked || false,
            hackDate: p.hackDate || null,
            hackAmount: p.hackAmount || null,
          };
        }
      }
    }

    registryLoaded = true;
    console.log(`  Protocol registry loaded: ${Object.keys(protocolRegistry).length} addresses indexed from ${protocols.length} protocols`);
  } catch (e) {
    console.error("  Failed to load protocol registry:", e.message);
  }
}

// Load registry on startup (non-blocking)
loadProtocolRegistry();

// --- GoPlus API Authentication ---
// GoPlus now requires an API key. We get a short-lived access token.
let goplusAccessToken = null;
let goplusTokenExpiry = 0;

async function getGoPlusToken() {
  // Return cached token if still valid (with 60s buffer)
  if (goplusAccessToken && Date.now() < goplusTokenExpiry - 60000) {
    return goplusAccessToken;
  }

  if (!GOPLUS_API_KEY || !GOPLUS_API_SECRET) {
    return null;  // No credentials - GoPlus calls will be skipped
  }

  try {
    const response = await axios.post("https://api.gopluslabs.io/api/v1/token", {
      app_key: GOPLUS_API_KEY,
      app_secret: GOPLUS_API_SECRET,
    }, { timeout: 5000 });

    if (response.data?.result?.access_token) {
      goplusAccessToken = response.data.result.access_token;
      // Default to 30 min expiry if not specified
      const expiresIn = response.data.result.expires_in || 1800;
      goplusTokenExpiry = Date.now() + (expiresIn * 1000);
      return goplusAccessToken;
    }
  } catch (e) {
    console.error("  GoPlus auth failed:", e.message);
  }
  return null;
}

/**
 * Helper to make authenticated GoPlus API calls
 */
async function goplusGet(url) {
  const token = await getGoPlusToken();
  const headers = token ? { Authorization: token } : {};
  return axios.get(url, { timeout: 8000, headers });
}

// --- Known Audit Data (curated, supplements DeFiLlama) ---
const KNOWN_AUDITED = {
  "0xa238dd80c259a72e81d7e4664a9801593f98d1c5": {
    audited: true,
    auditors: ["OpenZeppelin", "Trail of Bits", "SigmaPrime"],
    lastAudit: "2025-08-15",
  },
  "0x46e6b214b524310239732d51387075e0e70970bf": {
    audited: true,
    auditors: ["OpenZeppelin", "ChainSecurity"],
    lastAudit: "2025-06-01",
  },
  "0x2626664c2603336e57b271c5c0b26f421741e481": {
    audited: true,
    auditors: ["Trail of Bits"],
    lastAudit: "2024-12-01",
  },
};

/**
 * Check if a contract has been audited
 * Sources: curated list + DeFiLlama protocol metadata
 */
async function getAuditData(contractAddress, chain) {
  const normalized = contractAddress.toLowerCase();

  // Check curated audit data first
  if (KNOWN_AUDITED[normalized]) {
    const data = KNOWN_AUDITED[normalized];
    const monthsSince = Math.round(
      (Date.now() - new Date(data.lastAudit).getTime()) / (30 * 24 * 60 * 60 * 1000)
    );
    return { ...data, monthsSinceAudit: monthsSince, source: "curated" };
  }

  // Check DeFiLlama registry for audit info
  const protocol = protocolRegistry[normalized];
  if (protocol && (protocol.audits > 0 || protocol.audit_links.length > 0)) {
    return {
      audited: true,
      auditors: protocol.audit_links.length > 0
        ? [`See ${protocol.audit_links.length} audit report(s)`]
        : ["Audit confirmed by DeFiLlama"],
      lastAudit: null,
      monthsSinceAudit: null,
      audit_links: protocol.audit_links,
      source: "defillama",
    };
  }

  return { audited: false, auditors: [], lastAudit: null, monthsSinceAudit: null, source: "none" };
}

/**
 * Check exploit history
 * Sources: DeFiLlama protocol metadata (hacked flag) + GoPlusLabs security API
 */
async function getExploitHistory(contractAddress, chain) {
  const normalized = contractAddress.toLowerCase();
  const incidents = [];

  // Check DeFiLlama registry for hack history
  const protocol = protocolRegistry[normalized];
  if (protocol && protocol.hacked) {
    incidents.push({
      date: protocol.hackDate || "unknown",
      type: "exploit",
      lossUsd: protocol.hackAmount || null,
      resolved: true,
      source: "defillama",
    });
  }

  // Check GoPlus for contract security flags (requires API key)
  try {
    const chainId = chain === "base" ? "8453" : "84532";
    const response = await goplusGet(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${contractAddress}`
    );
    const tokenData = response.data?.result?.[normalized];
    if (tokenData) {
      if (tokenData.is_honeypot === "1") {
        incidents.push({ type: "honeypot", detail: "Honeypot detected by GoPlusLabs", source: "goplus" });
      }
      if (tokenData.is_blacklisted === "1") {
        incidents.push({ type: "blacklisted", detail: "Contract is blacklisted", source: "goplus" });
      }
    }
  } catch (e) {
    // GoPlusLabs unavailable - continue without it
  }

  return {
    exploited: incidents.length > 0,
    incidents,
  };
}

/**
 * Get contract metadata from Etherscan V2 + Alchemy
 * Sources: Etherscan V2 API (verification, proxy, creation date), Alchemy (bytecode check)
 * Note: Etherscan V2 uses a single endpoint with chainid param for all supported chains
 */
async function getContractMetadata(contractAddress, chain) {
  const result = {
    isContract: null,
    verifiedSource: null,
    proxyPattern: null,
    ownerIsMultisig: null,
    ageDays: null,
    mock: false,
  };

  // Alchemy: check if address has bytecode (is a contract)
  if (ALCHEMY_API_KEY) {
    try {
      const rpcUrl = `https://${chain === "base" ? "base-mainnet" : "base-sepolia"}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
      const codeResponse = await axios.post(rpcUrl, {
        jsonrpc: "2.0", method: "eth_getCode", params: [contractAddress, "latest"], id: 1,
      }, { timeout: 5000 });
      result.isContract = codeResponse.data.result && codeResponse.data.result !== "0x";
    } catch (e) {
      // Continue without bytecode check
    }
  }

  // Etherscan V2: get contract source verification + creation info
  // Single API endpoint with chainid parameter for all chains
  const ETHERSCAN_API_KEY = process.env.BASESCAN_API_KEY || "";
  const chainId = chain === "base" ? "8453" : "84532";
  const etherscanV2 = `https://api.etherscan.io/v2/api?chainid=${chainId}`;

  if (ETHERSCAN_API_KEY) {
    try {
      // Get source code verification status
      const sourceResponse = await axios.get(
        `${etherscanV2}&module=contract&action=getsourcecode&address=${contractAddress}&apikey=${ETHERSCAN_API_KEY}`,
        { timeout: 5000 }
      );
      const sourceData = sourceResponse.data?.result?.[0];
      if (sourceData) {
        result.verifiedSource = sourceData.SourceCode && sourceData.SourceCode !== "";
        if (sourceData.Proxy === "1" || sourceData.Implementation) {
          result.proxyPattern = sourceData.Implementation ? "Proxy" : null;
        }
      }

      // Get contract creation date
      const txResponse = await axios.get(
        `${etherscanV2}&module=contract&action=getcontractcreation&contractaddresses=${contractAddress}&apikey=${ETHERSCAN_API_KEY}`,
        { timeout: 5000 }
      );
      const txData = txResponse.data?.result?.[0];
      if (txData && txData.txHash) {
        // Get the transaction to find the block timestamp
        const blockResponse = await axios.get(
          `${etherscanV2}&module=proxy&action=eth_getTransactionByHash&txhash=${txData.txHash}&apikey=${ETHERSCAN_API_KEY}`,
          { timeout: 5000 }
        );
        const blockNum = blockResponse.data?.result?.blockNumber;
        if (blockNum) {
          const blockDetailResponse = await axios.get(
            `${etherscanV2}&module=proxy&action=eth_getBlockByNumber&tag=${blockNum}&boolean=false&apikey=${ETHERSCAN_API_KEY}`,
            { timeout: 5000 }
          );
          const timestamp = blockDetailResponse.data?.result?.timestamp;
          if (timestamp) {
            const deployDate = new Date(parseInt(timestamp, 16) * 1000);
            result.ageDays = Math.round((Date.now() - deployDate.getTime()) / (24 * 60 * 60 * 1000));
          }
        }
      }
    } catch (e) {
      // Etherscan V2 unavailable - continue without it
    }
  }

  // If we got no real data, fall back to mock
  if (result.isContract === null && result.verifiedSource === null && result.ageDays === null) {
    return {
      isContract: true,
      verifiedSource: true,
      proxyPattern: "UUPS",
      ownerIsMultisig: true,
      ageDays: 412,
      mock: true,
    };
  }

  return result;
}

/**
 * Get TVL data from DeFiLlama
 * Uses protocol registry to resolve contract address -> slug
 */
async function getTvlData(contractAddress) {
  // Look up the protocol slug from our registry
  const normalized = contractAddress ? contractAddress.toLowerCase() : null;
  const protocol = normalized ? protocolRegistry[normalized] : null;
  const slug = protocol?.slug;

  if (!slug) {
    return {
      currentUsd: null,
      trend30d: null,
      stable: null,
      source: "no_slug_mapping",
      protocolName: protocol?.name || null,
    };
  }

  try {
    const response = await axios.get(
      `https://api.llama.fi/protocol/${slug}`,
      { timeout: 5000 }
    );
    const data = response.data;
    const currentTvl = data.currentChainTvls?.Base || data.tvl?.[data.tvl.length - 1]?.totalLiquidityUSD || 0;

    // Calculate 30-day trend
    const tvlHistory = data.tvl || [];
    const now = tvlHistory[tvlHistory.length - 1]?.totalLiquidityUSD || 0;
    const thirtyDaysAgo = tvlHistory[Math.max(0, tvlHistory.length - 30)]?.totalLiquidityUSD || now;
    const trend = thirtyDaysAgo > 0 ? ((now - thirtyDaysAgo) / thirtyDaysAgo * 100).toFixed(1) : 0;

    return {
      currentUsd: Math.round(currentTvl),
      trend30d: `${trend > 0 ? "+" : ""}${trend}%`,
      stable: Math.abs(parseFloat(trend)) < 15,
      source: "defillama",
      protocolName: data.name || protocol.name,
    };
  } catch (e) {
    return {
      currentUsd: null,
      trend30d: null,
      stable: null,
      source: "unavailable",
    };
  }
}


// ============================================================
// TOKEN DATA LAYER
// Live integrations: GoPlusLabs token security, DeFiLlama
// ============================================================

/**
 * Get comprehensive token security data from GoPlusLabs
 * Covers: honeypot, buy/sell tax, ownership, mintability, proxy, holder info
 */
async function getTokenSecurity(tokenAddress, chain) {
  const normalized = tokenAddress.toLowerCase();
  const chainId = chain === "base" ? "8453" : "84532";

  try {
    const response = await goplusGet(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress}`
    );
    const data = response.data?.result?.[normalized];
    if (!data) {
      return { available: false, source: "goplus_no_data" };
    }

    return {
      available: true,
      source: "goplus",
      // Core safety flags
      is_honeypot: data.is_honeypot === "1",
      honeypot_with_same_creator: data.honeypot_with_same_creator === "1",
      // Tax analysis
      buy_tax: data.buy_tax ? parseFloat(data.buy_tax) : null,
      sell_tax: data.sell_tax ? parseFloat(data.sell_tax) : null,
      // Ownership and control
      is_open_source: data.is_open_source === "1",
      is_proxy: data.is_proxy === "1",
      is_mintable: data.is_mintable === "1",
      can_take_back_ownership: data.can_take_back_ownership === "1",
      owner_change_balance: data.owner_change_balance === "1",
      hidden_owner: data.hidden_owner === "1",
      // Trading restrictions
      cannot_buy: data.cannot_buy === "1",
      cannot_sell_all: data.cannot_sell_all === "1",
      slippage_modifiable: data.slippage_modifiable === "1",
      personal_slippage_modifiable: data.personal_slippage_modifiable === "1",
      trading_cooldown: data.trading_cooldown === "1",
      transfer_pausable: data.transfer_pausable === "1",
      is_blacklisted: data.is_blacklisted === "1",
      is_whitelisted: data.is_whitelisted === "1",
      is_anti_whale: data.is_anti_whale === "1",
      // Holder data
      holder_count: data.holder_count ? parseInt(data.holder_count) : null,
      total_supply: data.total_supply || null,
      owner_address: data.owner_address || null,
      owner_balance: data.owner_balance ? parseFloat(data.owner_balance) : null,
      owner_percent: data.owner_percent ? parseFloat(data.owner_percent) * 100 : null,
      creator_address: data.creator_address || null,
      creator_balance: data.creator_balance ? parseFloat(data.creator_balance) : null,
      creator_percent: data.creator_percent ? parseFloat(data.creator_percent) * 100 : null,
      // LP info
      lp_holder_count: data.lp_holder_count ? parseInt(data.lp_holder_count) : null,
      lp_total_supply: data.lp_total_supply || null,
      is_true_token: data.is_true_token === "1",
      is_airdrop_scam: data.is_airdrop_scam === "1",
      // Token info
      token_name: data.token_name || null,
      token_symbol: data.token_symbol || null,
    };
  } catch (e) {
    return { available: false, source: "goplus_error", error: e.message };
  }
}

/**
 * Get token market data from DeFiLlama (if it's a known protocol token)
 */
async function getTokenMarketData(tokenAddress) {
  const normalized = tokenAddress.toLowerCase();
  const protocol = protocolRegistry[normalized];

  if (!protocol) {
    return { available: false, source: "no_protocol_match" };
  }

  try {
    const response = await axios.get(
      `https://api.llama.fi/protocol/${protocol.slug}`,
      { timeout: 5000 }
    );
    const data = response.data;
    return {
      available: true,
      source: "defillama",
      protocol_name: data.name,
      category: data.category,
      tvl: data.currentChainTvls?.Base || data.tvl?.[data.tvl?.length - 1]?.totalLiquidityUSD || null,
      mcap: data.mcap || null,
    };
  } catch (e) {
    return { available: false, source: "defillama_error" };
  }
}

/**
 * Score a token across safety dimensions
 */
function scoreToken(security, market) {
  const startTime = Date.now();
  const dimensions = {};
  const riskFlags = [];

  if (!security.available) {
    return {
      verdict: "UNKNOWN",
      trust_grade: "N/A",
      trust_score: null,
      confidence: 0.1,
      dimensions: {},
      risk_flags: ["No security data available for this token"],
      meta: { response_time_ms: Date.now() - startTime, data_freshness: new Date().toISOString(), sentinel_version: "0.1.0" },
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

  return { verdict, trust_grade: grade, trust_score: compositeScore, dimensions, risk_flags: riskFlags };
}


// ============================================================
// POSITION DATA LAYER
// Combines protocol trust with position-specific risk factors
// ============================================================

/**
 * Analyze a DeFi position for risk factors
 * Uses protocol trust score + position-specific heuristics
 */
async function analyzePosition(protocolAddress, userAddress, chain) {
  const startTime = Date.now();

  // Get the underlying protocol trust score
  const protocolScore = await scoreProtocol(protocolAddress, chain);

  // Get protocol info from registry
  const normalized = protocolAddress.toLowerCase();
  const protocol = protocolRegistry[normalized];

  // Position-specific risk dimensions
  const dimensions = {};
  const riskFlags = [];

  // 1. Protocol Foundation (40%) - derived from protocol trust score
  dimensions.protocol_trust = {
    score: protocolScore.trust_score,
    detail: `Underlying protocol rated ${protocolScore.trust_grade} (${protocolScore.trust_score}/100): ${protocolScore.verdict}`,
  };
  if (protocolScore.trust_score < 55) riskFlags.push(`Underlying protocol rated ${protocolScore.trust_grade} - elevated risk`);

  // 2. Protocol Category Risk (20%)
  const categoryRisk = {
    "Dexes": 80,
    "Lending": 75,
    "Bridge": 45,
    "Yield Aggregator": 60,
    "Yield": 55,
    "CDP": 70,
    "Liquid Staking": 75,
    "Derivatives": 55,
    "Options": 50,
    "Algo-Stables": 30,
    "Insurance": 80,
    "Launchpad": 40,
    "Farm": 45,
    "Ponzi": 5,
  };
  const category = protocol?.category || "Unknown";
  const catScore = categoryRisk[category] || 50;
  dimensions.category_risk = {
    score: catScore,
    detail: `Category: ${category}. Inherent risk profile: ${catScore >= 70 ? "lower" : catScore >= 50 ? "moderate" : "higher"}.`,
  };
  if (catScore < 40) riskFlags.push(`High-risk category: ${category}`);
  if (category === "Bridge") riskFlags.push("Bridge protocols carry elevated exploit risk");
  if (category === "Algo-Stables") riskFlags.push("Algorithmic stablecoins have historically high failure rate");

  // 3. TVL Health (20%) - larger TVL = more battle-tested
  const tvl = await getTvlData(protocolAddress);
  let tvlScore = 50;
  if (tvl.currentUsd !== null) {
    if (tvl.currentUsd > 1_000_000_000) tvlScore = 95;
    else if (tvl.currentUsd > 500_000_000) tvlScore = 85;
    else if (tvl.currentUsd > 100_000_000) tvlScore = 75;
    else if (tvl.currentUsd > 10_000_000) tvlScore = 60;
    else if (tvl.currentUsd > 1_000_000) tvlScore = 45;
    else tvlScore = 25;
    if (!tvl.stable) { tvlScore -= 10; riskFlags.push(`TVL volatility: ${tvl.trend30d} in 30 days`); }
  } else {
    tvlScore = 30;
    riskFlags.push("No TVL data available");
  }
  dimensions.tvl_health = {
    score: Math.max(0, tvlScore),
    detail: tvl.currentUsd ? `TVL: $${(tvl.currentUsd / 1_000_000).toFixed(1)}M. 30d trend: ${tvl.trend30d}` : "TVL data unavailable",
  };

  // 4. Concentration Risk (20%) - is this position a large % of protocol TVL?
  // Without on-chain position data we provide a structural assessment
  let concentrationScore = 65;
  if (tvl.currentUsd && tvl.currentUsd < 5_000_000) {
    concentrationScore = 40;
    riskFlags.push("Low-TVL protocol - individual positions may represent significant share");
  } else if (tvl.currentUsd && tvl.currentUsd > 100_000_000) {
    concentrationScore = 85;
  }
  dimensions.concentration_risk = {
    score: concentrationScore,
    detail: "Structural concentration assessment based on protocol TVL depth",
  };

  // Weighted composite
  const weights = { protocol_trust: 0.40, category_risk: 0.20, tvl_health: 0.20, concentration_risk: 0.20 };
  const compositeScore = Math.round(
    Object.entries(weights).reduce((sum, [key, weight]) => sum + (dimensions[key]?.score || 0) * weight, 0)
  );
  const { grade, verdict } = gradeFromScore(compositeScore);

  return {
    protocol_address: protocolAddress,
    user_address: userAddress,
    chain,
    verdict,
    trust_grade: grade,
    trust_score: compositeScore,
    confidence: protocol ? 0.80 : 0.50,
    protocol_info: {
      name: protocol?.name || "Unknown",
      category: protocol?.category || "Unknown",
      underlying_protocol_grade: protocolScore.trust_grade,
    },
    dimensions,
    risk_flags: riskFlags,
    recommendations: generatePositionRecommendations(riskFlags, compositeScore),
    meta: {
      response_time_ms: Date.now() - startTime,
      data_freshness: new Date().toISOString(),
      sentinel_version: "0.1.0",
    },
  };
}

/**
 * Generate actionable recommendations based on risk flags
 */
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


// ============================================================
// SCORING ENGINE
// ============================================================

/**
 * Score a protocol across all trust dimensions
 */
async function scoreProtocol(contractAddress, chain) {
  const startTime = Date.now();

  // Fetch all data in parallel
  const [audit, exploits, contract, tvl] = await Promise.all([
    getAuditData(contractAddress, chain),
    getExploitHistory(contractAddress, chain),
    getContractMetadata(contractAddress, chain),
    getTvlData(contractAddress),
  ]);

  // Score each dimension (0-100)
  const dimensions = {};

  // Audit (25%)
  if (audit.audited) {
    let score = 80;
    if (audit.auditors.length >= 2) score += 10;
    if (audit.monthsSinceAudit && audit.monthsSinceAudit < 6) score += 5;
    if (audit.monthsSinceAudit && audit.monthsSinceAudit > 18) score -= 15;
    dimensions.audit = { score: Math.min(100, Math.max(0, score)), detail: `Audited by ${audit.auditors.join(", ")}. Last audit: ${audit.monthsSinceAudit} months ago.` };
  } else {
    dimensions.audit = { score: 15, detail: "No audit records found." };
  }

  // Exploit history (25%)
  if (exploits.exploited) {
    const resolved = exploits.incidents.every(i => i.resolved);
    dimensions.exploit_history = {
      score: resolved ? 35 : 5,
      detail: `${exploits.incidents.length} exploit(s) on record. ${resolved ? "All resolved." : "Unresolved incidents."}`,
    };
  } else {
    dimensions.exploit_history = { score: 90, detail: "No exploit history found." };
  }

  // Contract maturity (15%)
  let contractScore = 50;
  if (contract.ageDays && contract.ageDays > 365) contractScore += 20;
  if (contract.ageDays && contract.ageDays > 180) contractScore += 10;
  if (contract.verifiedSource) contractScore += 10;
  if (contract.ownerIsMultisig) contractScore += 10;
  dimensions.contract_maturity = {
    score: Math.min(100, contractScore),
    detail: contract.mock
      ? "Using estimated contract data (mock mode)"
      : `Contract age: ${contract.ageDays} days. Source verified: ${contract.verifiedSource}. Multisig: ${contract.ownerIsMultisig}.`,
  };

  // TVL stability (15%)
  if (tvl.currentUsd !== null) {
    let tvlScore = 60;
    if (tvl.currentUsd > 1_000_000_000) tvlScore += 25;
    else if (tvl.currentUsd > 100_000_000) tvlScore += 15;
    else if (tvl.currentUsd > 10_000_000) tvlScore += 5;
    if (tvl.stable) tvlScore += 10;
    dimensions.tvl_stability = { score: Math.min(100, tvlScore), detail: `TVL: $${(tvl.currentUsd / 1_000_000).toFixed(0)}M. 30d trend: ${tvl.trend30d}. ${tvl.stable ? "Stable." : "Volatile."}` };
  } else {
    dimensions.tvl_stability = { score: 40, detail: "TVL data unavailable." };
  }

  // Governance risk (10%) - placeholder for Phase 2
  dimensions.governance = { score: 65, detail: "Governance scoring not yet implemented - default moderate." };

  // Community signal (10%) - placeholder for Phase 2
  dimensions.community = { score: 60, detail: "Community signal scoring not yet implemented - default moderate." };

  // Compute composite
  const weights = { audit: 0.25, exploit_history: 0.25, contract_maturity: 0.15, tvl_stability: 0.15, governance: 0.10, community: 0.10 };
  const compositeScore = Math.round(
    Object.entries(weights).reduce((sum, [key, weight]) => sum + (dimensions[key]?.score || 0) * weight, 0)
  );

  // Identify risk flags
  const riskFlags = [];
  if (!audit.audited) riskFlags.push("No audit records found - high risk");
  if (exploits.exploited) riskFlags.push(`Previous exploit: ${exploits.incidents[0]?.type || "unknown type"}`);
  if (contract.proxyPattern) riskFlags.push(`Proxy contract (${contract.proxyPattern}) - admin upgrade possible`);
  if (audit.monthsSinceAudit && audit.monthsSinceAudit > 12) riskFlags.push(`Audit is ${audit.monthsSinceAudit} months old - may not reflect current code`);
  if (tvl.currentUsd !== null && tvl.currentUsd < 10_000_000) riskFlags.push("TVL below $10M - limited liquidity");

  const { grade, verdict } = gradeFromScore(compositeScore);

  return {
    address: contractAddress,
    chain,
    verdict,
    trust_grade: grade,
    trust_score: compositeScore,
    confidence: contract.mock ? 0.45 : 0.88,
    evidence: {
      audit: {
        audited: audit.audited,
        auditors: audit.auditors,
        last_audit: audit.lastAudit,
        months_since_audit: audit.monthsSinceAudit,
      },
      exploit_history: {
        exploited: exploits.exploited,
        incidents: exploits.incidents,
      },
      contract: {
        age_days: contract.ageDays,
        verified_source: contract.verifiedSource,
        proxy_pattern: contract.proxyPattern,
        owner_is_multisig: contract.ownerIsMultisig,
      },
      tvl: {
        current_usd: tvl.currentUsd,
        trend_30d: tvl.trend30d,
        stable: tvl.stable,
      },
    },
    dimensions,
    risk_flags: riskFlags,
    meta: {
      response_time_ms: Date.now() - startTime,
      data_freshness: new Date().toISOString(),
      sentinel_version: "0.1.0",
      mock_data: !!contract.mock,
    },
  };
}


// ============================================================
// x402 PAYMENT MIDDLEWARE (global)
// ============================================================

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const paymentRoutes = {
  "GET /verify/protocol": {
    accepts: {
      scheme: "exact",
      price: PRICE.verifyProtocol,
      network: NETWORK_ID[NETWORK],
      payTo: WALLET_ADDRESS,
    },
    description: "Sentinel Protocol Verification - trust assessment for any smart contract",
    ...declareDiscoveryExtension({
      input: { address: "0x2626664c2603336e57b271c5c0b26f421741e481", chain: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "Contract address to verify (0x + 40 hex chars)" },
          chain: { type: "string", description: "Chain name: 'base' or 'base-sepolia'", enum: ["base", "base-sepolia"] },
          detail: { type: "string", description: "Response detail level", enum: ["full", "standard", "minimal"] },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0x2626664c2603336e57b271c5c0b26f421741e481",
          chain: "base",
          verdict: "LOW_RISK",
          trust_grade: "B",
          trust_score: 70,
          confidence: 0.88,
          risk_flags: ["Proxy contract (Proxy) - admin upgrade possible"],
        },
        schema: {
          properties: {
            verdict: { type: "string", enum: ["SAFE", "LOW_RISK", "CAUTION", "HIGH_RISK", "DANGER"] },
            trust_grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
            trust_score: { type: "number" },
            confidence: { type: "number" },
          },
        },
      },
    }),
  },
  "GET /verify/token": {
    accepts: {
      scheme: "exact",
      price: PRICE.verifyToken,
      network: NETWORK_ID[NETWORK],
      payTo: WALLET_ADDRESS,
    },
    description: "Sentinel Token Verification - honeypot detection, tax analysis, ownership risks",
    ...declareDiscoveryExtension({
      input: { address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", chain: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "Token contract address (0x + 40 hex chars)" },
          chain: { type: "string", description: "Chain name: 'base' or 'base-sepolia'", enum: ["base", "base-sepolia"] },
          detail: { type: "string", description: "Response detail level", enum: ["full", "standard", "minimal"] },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
          chain: "base",
          token_name: "Brett",
          token_symbol: "BRETT",
          verdict: "LOW_RISK",
          trust_grade: "B",
          trust_score: 82,
          risk_flags: ["Slippage is modifiable by owner"],
        },
        schema: {
          properties: {
            verdict: { type: "string", enum: ["SAFE", "LOW_RISK", "CAUTION", "HIGH_RISK", "DANGER"] },
            trust_grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
            trust_score: { type: "number" },
            token_name: { type: "string" },
            token_symbol: { type: "string" },
          },
        },
      },
    }),
  },
  "GET /verify/position": {
    accepts: {
      scheme: "exact",
      price: PRICE.verifyPosition,
      network: NETWORK_ID[NETWORK],
      payTo: WALLET_ADDRESS,
    },
    description: "Sentinel Position Analysis - DeFi position risk assessment with protocol trust scoring",
    ...declareDiscoveryExtension({
      input: { protocol: "0x2626664c2603336e57b271c5c0b26f421741e481", chain: "base" },
      inputSchema: {
        properties: {
          protocol: { type: "string", description: "Protocol contract address (0x + 40 hex chars)" },
          user: { type: "string", description: "User wallet address (optional)" },
          chain: { type: "string", description: "Chain name: 'base' or 'base-sepolia'", enum: ["base", "base-sepolia"] },
          detail: { type: "string", description: "Response detail level", enum: ["full", "standard", "minimal"] },
        },
        required: ["protocol"],
      },
      output: {
        example: {
          protocol_address: "0x2626664c2603336e57b271c5c0b26f421741e481",
          chain: "base",
          verdict: "CAUTION",
          trust_grade: "C",
          trust_score: 57,
          recommendations: ["Monitor TVL trends - rapid outflows may signal issues"],
        },
        schema: {
          properties: {
            verdict: { type: "string", enum: ["SAFE", "LOW_RISK", "CAUTION", "HIGH_RISK", "DANGER"] },
            trust_grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
            trust_score: { type: "number" },
          },
        },
      },
    }),
  },
};

const schemes = [
  { network: "eip155:84532", server: new ExactEvmScheme() },  // Base Sepolia
  { network: "eip155:8453",  server: new ExactEvmScheme() },  // Base Mainnet
];

app.use(paymentMiddlewareFromConfig(paymentRoutes, facilitator, schemes));


// ============================================================
// API ENDPOINTS
// ============================================================

/**
 * /verify/protocol - $0.008 per call
 * The highest-value endpoint: answers "is this contract safe to interact with?"
 */
app.get("/verify/protocol", async (req, res) => {
  const { address, chain = "base", detail = "full" } = req.query;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Valid contract address required (0x + 40 hex characters)" });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";

  try {
    const result = await scoreProtocol(address, chain);
    res.json(filterResponse(result, detailLevel));
  } catch (error) {
    console.error("Protocol verification error:", error);
    res.status(500).json({ error: "Verification failed", detail: error.message });
  }
});

/**
 * /verify/position - $0.005 per call
 * DeFi position risk analysis: protocol trust + category risk + TVL health + concentration
 */
app.get("/verify/position", async (req, res) => {
  const { protocol: protocolAddress, user, chain = "base", detail = "full" } = req.query;

  if (!protocolAddress || !/^0x[a-fA-F0-9]{40}$/.test(protocolAddress)) {
    return res.status(400).json({ error: "Valid protocol contract address required (?protocol=0x...)" });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";

  try {
    const result = await analyzePosition(protocolAddress, user || null, chain);
    res.json(filterResponse(result, detailLevel));
  } catch (error) {
    console.error("Position analysis error:", error);
    res.status(500).json({ error: "Position analysis failed", detail: error.message });
  }
});

/**
 * /verify/counterparty - $0.01 per call
 * Stub for Phase 3
 */
app.get("/verify/counterparty", (req, res) => {
  res.status(501).json({
    error: "Coming in Phase 3",
    description: "Counterparty intelligence - sanctions screening, exploit association, reputation",
    expected: "May 2026",
  });
});

/**
 * /verify/token - $0.005 per call
 * Token safety assessment: honeypot, tax, ownership, holder distribution
 */
app.get("/verify/token", async (req, res) => {
  const { address, chain = "base", detail = "full" } = req.query;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Valid token address required (0x + 40 hex characters)" });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";

  try {
    const [security, market] = await Promise.all([
      getTokenSecurity(address, chain),
      getTokenMarketData(address),
    ]);

    const result = scoreToken(security, market);

    const fullResult = {
      address,
      chain,
      token_name: security.token_name || null,
      token_symbol: security.token_symbol || null,
      ...result,
      evidence: {
        security: security.available ? {
          is_honeypot: security.is_honeypot,
          buy_tax: security.buy_tax,
          sell_tax: security.sell_tax,
          is_open_source: security.is_open_source,
          is_mintable: security.is_mintable,
          is_proxy: security.is_proxy,
          hidden_owner: security.hidden_owner,
          can_take_back_ownership: security.can_take_back_ownership,
          owner_change_balance: security.owner_change_balance,
          holder_count: security.holder_count,
          owner_percent: security.owner_percent,
          creator_percent: security.creator_percent,
        } : { available: false },
        market: market.available ? {
          protocol_name: market.protocol_name,
          category: market.category,
          tvl: market.tvl,
          mcap: market.mcap,
        } : { available: false },
      },
      meta: {
        response_time_ms: Date.now(),
        data_freshness: new Date().toISOString(),
        sentinel_version: "0.1.0",
      },
    };

    res.json(filterResponse(fullResult, detailLevel));
  } catch (error) {
    console.error("Token verification error:", error);
    res.status(500).json({ error: "Token verification failed", detail: error.message });
  }
});

/**
 * /preflight - $0.025 per call
 * Stub for Phase 4
 */
app.get("/preflight", (req, res) => {
  res.status(501).json({
    error: "Coming in Phase 4",
    description: "Unified pre-transaction safety check - protocol + counterparty + position in one call",
    expected: "June 2026",
  });
});


// ============================================================
// HEALTH & DISCOVERY (free)
// ============================================================
app.get("/health", (req, res) => {
  res.json({
    service: "Sentinel",
    tagline: "The Trust Layer for Autonomous Agents",
    version: "0.1.0",
    status: "operational",
    network: NETWORK,
    endpoints: {
      "/verify/protocol":     { price: "$0.008 USDC", status: "live",    description: "Protocol trust verification" },
      "/verify/position":     { price: "$0.005 USDC", status: "live",    description: "Position risk analysis" },
      "/verify/counterparty": { price: "$0.010 USDC", status: "phase3",  description: "Counterparty intelligence" },
      "/verify/token":        { price: "$0.005 USDC", status: "live",    description: "Token legitimacy check" },
      "/preflight":           { price: "$0.025 USDC", status: "phase4",  description: "Unified pre-transaction safety" },
    },
  });
});


// ============================================================
// DEV-ONLY TEST ROUTES (remove before production deployment)
// Bypasses x402 paywall for local testing
// ============================================================
if (NETWORK === "base-sepolia") {
  app.get("/test/protocol", async (req, res) => {
    const { address, chain = "base", detail = "full" } = req.query;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: "Valid contract address required" });
    }
    try {
      const result = await scoreProtocol(address, chain);
      res.json(filterResponse(result, detail));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/test/token", async (req, res) => {
    const { address, chain = "base", detail = "full" } = req.query;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: "Valid token address required" });
    }
    try {
      const [security, market] = await Promise.all([
        getTokenSecurity(address, chain),
        getTokenMarketData(address),
      ]);
      const result = scoreToken(security, market);
      res.json(filterResponse({ address, chain, token_name: security.token_name, token_symbol: security.token_symbol, ...result }, detail));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/test/position", async (req, res) => {
    const { protocol: protocolAddress, user, chain = "base", detail = "full" } = req.query;
    if (!protocolAddress || !/^0x[a-fA-F0-9]{40}$/.test(protocolAddress)) {
      return res.status(400).json({ error: "Valid protocol address required" });
    }
    try {
      const result = await analyzePosition(protocolAddress, user || null, chain);
      res.json(filterResponse(result, detail));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  console.log("  [DEV] Test routes enabled: /test/protocol, /test/token, /test/position");
}


// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`
  ┌────────────────────────────────────────────┐
  │  SENTINEL v0.1.0                            │
  │  The Trust Layer for Autonomous Agents       │
  │  Verify before you execute.                  │
  ├────────────────────────────────────────────┤
  │  Network:  ${NETWORK.padEnd(33)}│
  │  Port:     ${String(PORT).padEnd(33)}│
  ├────────────────────────────────────────────┤
  │  LIVE:                                       │
  │    GET /verify/protocol  ($0.008 USDC)       │
  │    GET /verify/token     ($0.005 USDC)       │
  │    GET /verify/position  ($0.005 USDC)       │
  │  COMING:                                     │
  │    GET /verify/counterparty ($0.01 USDC)     │
  │    GET /preflight        ($0.025 USDC)       │
  │  FREE:                                       │
  │    GET /health                               │
  └────────────────────────────────────────────┘
  `);
});
