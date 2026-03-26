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
// Phase 3: /verify/counterparty + /preflight unified check
// ============================================================

import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.set("trust proxy", true);   // Render (and most PaaS) sit behind a reverse proxy — trust X-Forwarded-Proto so req.protocol is "https"
app.use(express.json());

// Favicon — x402scan requires one to avoid OG-image constraint issues during registration
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="20" fill="#1a1a2e"/>
  <text x="50" y="68" font-size="60" text-anchor="middle" fill="#00d4ff" font-family="Arial,sans-serif" font-weight="bold">S</text>
</svg>`;
app.get("/favicon.ico", (_req, res) => {
  res.type("image/svg+xml").send(FAVICON_SVG);
});
app.get("/favicon.svg", (_req, res) => {
  res.type("image/svg+xml").send(FAVICON_SVG);
});

// ============================================================
// CONFIGURATION
// ============================================================
const VERSION = "0.4.0";
const PORT = process.env.PORT || 4021;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const NETWORK = process.env.NETWORK || "base-sepolia";
// CDP facilitator for production (Base mainnet); falls back to x402.org for testnet
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID || "";
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET || "";
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
// CACHING LAYER (Upstash Redis)
// Caches verification results to achieve <200ms responses
// Falls back gracefully if Redis is not configured
// ============================================================

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

let redis = null;
let ratelimit = null;

if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });

  // Rate limiter: 25 free calls per wallet per day (sliding window)
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(25, "1 d"),
    prefix: "sentinel:ratelimit",
  });

  console.log("  Redis caching enabled (Upstash)");
  console.log("  Rate limiting enabled: 25 calls/wallet/day");
} else {
  console.log("  Redis caching disabled (no UPSTASH_REDIS_REST_URL configured)");
}

// Cache TTLs in seconds
const CACHE_TTL = {
  protocol:     600,   // 10 min — contract metadata changes slowly
  token:        300,   // 5 min — token security can shift faster
  position:     300,   // 5 min
  counterparty: 900,   // 15 min — sanctions lists update daily
};

/**
 * Get a cached result, or compute and cache it
 * Falls back to direct computation if Redis is unavailable
 */
async function cachedCall(cacheKey, ttlSeconds, computeFn) {
  if (!redis) return computeFn();

  try {
    // Check cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      const result = typeof cached === "string" ? JSON.parse(cached) : cached;
      result.meta = { ...result.meta, cache_hit: true };
      return result;
    }
  } catch (e) {
    // Redis read failed — continue to compute
  }

  // Cache miss — compute fresh result
  const result = await computeFn();

  // Store in cache (non-blocking, don't await)
  if (redis) {
    redis.set(cacheKey, JSON.stringify(result), { ex: ttlSeconds }).catch(() => {});
  }

  if (result.meta) result.meta.cache_hit = false;
  return result;
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
            // Governance & community signals
            governanceID: p.governanceID || null,  // e.g. "snapshot:uniswap"
            treasury: p.treasury || null,
            openSource: p.openSource !== false,     // Most are open source
            forkedFrom: p.forkedFrom || [],
            twitter: p.twitter || null,
            url: p.url || null,
            listedAt: p.listedAt || null,           // Unix timestamp when listed on DeFiLlama
            mcap: p.mcap || null,
            chainTvls: p.chainTvls || {},
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
        `${etherscanV2}&module=contract&action=getsourcecode&address=${contractAddress}`,
        {
          timeout: 5000,
          headers: { 'X-API-Key': ETHERSCAN_API_KEY }
        }
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
        `${etherscanV2}&module=contract&action=getcontractcreation&contractaddresses=${contractAddress}`,
        {
          timeout: 5000,
          headers: { 'X-API-Key': ETHERSCAN_API_KEY }
        }
      );
      const txData = txResponse.data?.result?.[0];
      if (txData && txData.txHash) {
        // Get the transaction to find the block timestamp
        const blockResponse = await axios.get(
          `${etherscanV2}&module=proxy&action=eth_getTransactionByHash&txhash=${txData.txHash}`,
          {
            timeout: 5000,
            headers: { 'X-API-Key': ETHERSCAN_API_KEY }
          }
        );
        const blockNum = blockResponse.data?.result?.blockNumber;
        if (blockNum) {
          const blockDetailResponse = await axios.get(
            `${etherscanV2}&module=proxy&action=eth_getBlockByNumber&tag=${blockNum}&boolean=false`,
            {
              timeout: 5000,
              headers: { 'X-API-Key': ETHERSCAN_API_KEY }
            }
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
      sentinel_version: VERSION,
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
// COUNTERPARTY DATA LAYER
// OFAC sanctions screening + address reputation
// ============================================================

// --- OFAC SDN Sanctioned Addresses (loaded on startup) ---
let sanctionedAddresses = new Set();
let sanctionsLoaded = false;

async function loadSanctionedAddresses() {
  try {
    console.log("  Loading OFAC sanctioned addresses...");
    // Primary: 0xB10C's daily-updated list from OFAC SDN
    const response = await axios.get(
      "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt",
      { timeout: 10000 }
    );
    const addresses = response.data
      .split("\n")
      .map(line => line.trim().toLowerCase())
      .filter(line => line.startsWith("0x") && line.length === 42);

    for (const addr of addresses) {
      sanctionedAddresses.add(addr);
    }
    sanctionsLoaded = true;
    console.log(`  OFAC sanctions list loaded: ${sanctionedAddresses.size} ETH addresses indexed`);
  } catch (e) {
    console.error("  Failed to load OFAC sanctions list:", e.message);
    // Try fallback source
    try {
      const fallback = await axios.get(
        "https://raw.githubusercontent.com/ultrasoundmoney/ofac-ethereum-addresses/main/data.csv",
        { timeout: 10000 }
      );
      const lines = fallback.data.split("\n").slice(1); // Skip CSV header
      for (const line of lines) {
        const addr = line.split(",")[0]?.trim().toLowerCase();
        if (addr && addr.startsWith("0x") && addr.length === 42) {
          sanctionedAddresses.add(addr);
        }
      }
      sanctionsLoaded = true;
      console.log(`  OFAC sanctions list loaded (fallback): ${sanctionedAddresses.size} ETH addresses`);
    } catch (e2) {
      console.error("  Fallback sanctions list also failed:", e2.message);
    }
  }
}

// Load sanctions list on startup (non-blocking)
loadSanctionedAddresses();

/**
 * Check if an address is on the OFAC sanctions list
 */
function checkSanctions(address) {
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
 * Get address security data from GoPlus
 * Checks: malicious address, phishing, contract risk
 */
async function getAddressSecurity(address, chain) {
  const normalized = address.toLowerCase();
  const chainId = chain === "base" ? "8453" : "84532";

  try {
    const response = await goplusGet(
      `https://api.gopluslabs.io/api/v1/address_security/${normalized}?chain_id=${chainId}`
    );
    const data = response.data?.result;
    if (!data) {
      return { available: false, source: "goplus_no_data" };
    }

    return {
      available: true,
      source: "goplus",
      is_malicious_address: data.malicious_address === "1",
      is_phishing: data.phishing_activities === "1",
      is_blacklisted: data.blacklist_doubt === "1",
      is_contract: data.contract_address === "1",
      is_mixer: data.mixer === "1",
      is_cybercrime: data.cybercrime === "1",
      is_money_laundering: data.money_laundering === "1",
      is_financial_crime: data.financial_crime === "1",
      is_darkweb: data.darkweb_transactions === "1",
      is_sanctioned: data.sanctioned === "1",
      data_source: data.data_source || null,
    };
  } catch (e) {
    return { available: false, source: "goplus_error", error: e.message };
  }
}

/**
 * Check if an address has exploit history in our protocol registry
 */
function checkExploitAssociation(address) {
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

/**
 * Score a counterparty address across risk dimensions
 */
async function scoreCounterparty(address, chain) {
  const startTime = Date.now();
  const dimensions = {};
  const riskFlags = [];

  // Fetch all data in parallel
  const [sanctions, addressSecurity, exploitAssoc] = await Promise.all([
    Promise.resolve(checkSanctions(address)),
    getAddressSecurity(address, chain),
    Promise.resolve(checkExploitAssociation(address)),
  ]);

  // 1. Sanctions Screening (40%)
  let sanctionsScore = 95;
  if (sanctions.sanctioned) {
    sanctionsScore = 0;
    riskFlags.push("ADDRESS IS ON OFAC SDN SANCTIONS LIST - DO NOT INTERACT");
  }
  if (addressSecurity.available && addressSecurity.is_sanctioned) {
    sanctionsScore = 0;
    riskFlags.push("Address flagged as sanctioned by GoPlus");
  }
  if (!sanctions.list_loaded) {
    sanctionsScore = 50;
    riskFlags.push("Sanctions list not loaded - screening incomplete");
  }
  dimensions.sanctions_screening = {
    score: sanctionsScore,
    detail: sanctions.sanctioned
      ? `SANCTIONED on ${sanctions.list}`
      : `Not found on OFAC SDN list (${sanctions.addresses_indexed} addresses screened)`,
  };

  // 2. Address Reputation (30%)
  let reputationScore = 80;
  if (addressSecurity.available) {
    if (addressSecurity.is_malicious_address) { reputationScore = 5; riskFlags.push("Flagged as malicious address"); }
    if (addressSecurity.is_phishing) { reputationScore = Math.min(reputationScore, 10); riskFlags.push("Associated with phishing activities"); }
    if (addressSecurity.is_cybercrime) { reputationScore = Math.min(reputationScore, 10); riskFlags.push("Associated with cybercrime"); }
    if (addressSecurity.is_money_laundering) { reputationScore = Math.min(reputationScore, 15); riskFlags.push("Associated with money laundering"); }
    if (addressSecurity.is_darkweb) { reputationScore = Math.min(reputationScore, 15); riskFlags.push("Associated with darkweb transactions"); }
    if (addressSecurity.is_financial_crime) { reputationScore = Math.min(reputationScore, 20); riskFlags.push("Associated with financial crime"); }
    if (addressSecurity.is_mixer) { reputationScore = Math.min(reputationScore, 30); riskFlags.push("Associated with mixer/tumbler usage"); }
    if (addressSecurity.is_blacklisted) { reputationScore = Math.min(reputationScore, 25); riskFlags.push("Address is on blacklist"); }
  } else {
    reputationScore = 60; // Unknown = moderate risk
  }
  dimensions.address_reputation = {
    score: reputationScore,
    detail: addressSecurity.available
      ? (reputationScore >= 70 ? "No negative reputation signals detected" : "Negative reputation signals detected")
      : "Address reputation data unavailable",
  };

  // 3. Exploit Association (20%)
  let exploitScore = 90;
  if (exploitAssoc.associated) {
    exploitScore = 20;
    riskFlags.push(`Associated with exploited protocol: ${exploitAssoc.protocol_name} (hacked ${exploitAssoc.hack_date || "date unknown"})`);
  }
  dimensions.exploit_association = {
    score: exploitScore,
    detail: exploitAssoc.associated
      ? `Associated with ${exploitAssoc.protocol_name} exploit`
      : "No exploit associations found",
  };

  // 4. Address Type (10%)
  let typeScore = 70;
  if (addressSecurity.available && addressSecurity.is_contract) {
    typeScore = 60; // Contracts are slightly riskier as counterparties
    riskFlags.push("Address is a contract, not an EOA");
  } else if (addressSecurity.available) {
    typeScore = 80; // EOA is typical
  }
  dimensions.address_type = {
    score: typeScore,
    detail: addressSecurity.available
      ? (addressSecurity.is_contract ? "Contract address" : "Externally owned account (EOA)")
      : "Address type unknown",
  };

  // Weighted composite
  const weights = { sanctions_screening: 0.40, address_reputation: 0.30, exploit_association: 0.20, address_type: 0.10 };
  const compositeScore = Math.round(
    Object.entries(weights).reduce((sum, [key, weight]) => sum + (dimensions[key]?.score || 0) * weight, 0)
  );
  const { grade, verdict } = gradeFromScore(compositeScore);

  return {
    address,
    chain,
    verdict,
    trust_grade: grade,
    trust_score: compositeScore,
    confidence: sanctions.list_loaded && addressSecurity.available ? 0.90 : 0.55,
    evidence: {
      sanctions: {
        sanctioned: sanctions.sanctioned,
        list: sanctions.list,
        addresses_screened: sanctions.addresses_indexed,
      },
      reputation: addressSecurity.available ? {
        is_malicious: addressSecurity.is_malicious_address,
        is_phishing: addressSecurity.is_phishing,
        is_mixer: addressSecurity.is_mixer,
        is_cybercrime: addressSecurity.is_cybercrime,
        is_money_laundering: addressSecurity.is_money_laundering,
      } : { available: false },
      exploit_association: exploitAssoc,
    },
    dimensions,
    risk_flags: riskFlags,
    meta: {
      response_time_ms: Date.now() - startTime,
      data_freshness: new Date().toISOString(),
      sentinel_version: VERSION,
    },
  };
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

  // Governance risk (10%) - based on registry metadata
  const protocolMeta = protocolRegistry[contractAddress.toLowerCase()] || {};
  {
    let govScore = 50; // baseline
    const govDetails = [];

    if (protocolMeta.governanceID) {
      govScore += 25; // Has on-chain/snapshot governance
      govDetails.push("Active governance system detected");
    }
    if (protocolMeta.treasury) {
      govScore += 10; // Has a treasury (DAO structure)
      govDetails.push("Protocol treasury exists");
    }
    if (contract.ownerIsMultisig) {
      govScore += 10; // Multisig ownership = decentralized control
      govDetails.push("Multisig ownership");
    }
    if (protocolMeta.openSource) {
      govScore += 5;
      govDetails.push("Open source");
    }

    dimensions.governance = {
      score: Math.min(100, Math.max(0, govScore)),
      detail: govDetails.length > 0 ? govDetails.join(". ") + "." : "No governance signals available.",
    };
  }

  // Community signal (10%) - based on ecosystem presence
  {
    let commScore = 40; // baseline
    const commDetails = [];

    if (protocolMeta.twitter) {
      commScore += 10;
      commDetails.push("Social presence verified");
    }
    if (protocolMeta.url) {
      commScore += 5;
      commDetails.push("Active website");
    }
    if (protocolMeta.listedAt) {
      // Longer listing on DeFiLlama = more established community
      const listedDaysAgo = (Date.now() / 1000 - protocolMeta.listedAt) / 86400;
      if (listedDaysAgo > 730) { commScore += 20; commDetails.push("Established for 2+ years"); }
      else if (listedDaysAgo > 365) { commScore += 15; commDetails.push("Established for 1+ year"); }
      else if (listedDaysAgo > 90) { commScore += 5; commDetails.push("Listed for 3+ months"); }
    }
    if (protocolMeta.mcap && protocolMeta.mcap > 100_000_000) {
      commScore += 15;
      commDetails.push(`Market cap: $${(protocolMeta.mcap / 1_000_000).toFixed(0)}M`);
    } else if (protocolMeta.mcap && protocolMeta.mcap > 10_000_000) {
      commScore += 10;
      commDetails.push(`Market cap: $${(protocolMeta.mcap / 1_000_000).toFixed(0)}M`);
    }
    if (protocolMeta.forkedFrom && protocolMeta.forkedFrom.length > 0) {
      commScore += 5; // Fork of established protocol
      commDetails.push(`Fork of ${protocolMeta.forkedFrom[0]}`);
    }

    dimensions.community = {
      score: Math.min(100, Math.max(0, commScore)),
      detail: commDetails.length > 0 ? commDetails.join(". ") + "." : "No community signals available.",
    };
  }

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
      sentinel_version: VERSION,
      mock_data: !!contract.mock,
    },
  };
}


// ============================================================
// x402 PAYMENT MIDDLEWARE (global)
// ============================================================

// Use CDP facilitator on mainnet (authenticated, production-grade),
// fall back to generic URL facilitator on testnet.
const facilitator = (CDP_API_KEY_ID && CDP_API_KEY_SECRET)
  ? new HTTPFacilitatorClient(createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET))
  : new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const paymentRoutes = {
  "POST /verify/protocol": {
    accepts: {
      scheme: "exact",
      price: PRICE.verifyProtocol,
      network: NETWORK_ID[NETWORK],
      payTo: WALLET_ADDRESS,
    },
    description: "Sentinel Protocol Verification - trust assessment for any smart contract",
    extensions: declareDiscoveryExtension({
      input: { address: "0x2626664c2603336e57b271c5c0b26f421741e481", chain: "base" },
      bodyType: "json",
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
  "POST /verify/token": {
    accepts: {
      scheme: "exact",
      price: PRICE.verifyToken,
      network: NETWORK_ID[NETWORK],
      payTo: WALLET_ADDRESS,
    },
    description: "Sentinel Token Verification - honeypot detection, tax analysis, ownership risks",
    extensions: declareDiscoveryExtension({
      input: { address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", chain: "base" },
      bodyType: "json",
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
  "POST /verify/position": {
    accepts: {
      scheme: "exact",
      price: PRICE.verifyPosition,
      network: NETWORK_ID[NETWORK],
      payTo: WALLET_ADDRESS,
    },
    description: "Sentinel Position Analysis - DeFi position risk assessment with protocol trust scoring",
    extensions: declareDiscoveryExtension({
      input: { protocol: "0x2626664c2603336e57b271c5c0b26f421741e481", chain: "base" },
      bodyType: "json",
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
  "POST /verify/counterparty": {
    accepts: {
      scheme: "exact",
      price: PRICE.verifyCounterparty,
      network: NETWORK_ID[NETWORK],
      payTo: WALLET_ADDRESS,
    },
    description: "Sentinel Counterparty Intelligence - OFAC sanctions screening, address reputation, exploit association",
    extensions: declareDiscoveryExtension({
      input: { address: "0x1234567890abcdef1234567890abcdef12345678", chain: "base" },
      bodyType: "json",
      inputSchema: {
        properties: {
          address: { type: "string", description: "Wallet or contract address to screen (0x + 40 hex chars)" },
          chain: { type: "string", description: "Chain name: 'base' or 'base-sepolia'", enum: ["base", "base-sepolia"] },
          detail: { type: "string", description: "Response detail level", enum: ["full", "standard", "minimal"] },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0x1234567890abcdef1234567890abcdef12345678",
          chain: "base",
          verdict: "SAFE",
          trust_grade: "A",
          trust_score: 88,
          risk_flags: [],
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
  "POST /preflight": {
    accepts: {
      scheme: "exact",
      price: PRICE.preflight,
      network: NETWORK_ID[NETWORK],
      payTo: WALLET_ADDRESS,
    },
    description: "Sentinel Preflight Check - unified pre-transaction safety analysis combining protocol trust, token safety, counterparty screening, and position risk in one call",
    extensions: declareDiscoveryExtension({
      input: { target: "0x2626664c2603336e57b271c5c0b26f421741e481", chain: "base" },
      bodyType: "json",
      inputSchema: {
        properties: {
          target: { type: "string", description: "Primary contract/protocol address for the transaction (0x + 40 hex chars)" },
          token: { type: "string", description: "Token address involved in the transaction (optional, 0x + 40 hex chars)" },
          counterparty: { type: "string", description: "Counterparty wallet address (optional, 0x + 40 hex chars)" },
          chain: { type: "string", description: "Chain name: 'base' or 'base-sepolia'", enum: ["base", "base-sepolia"] },
          detail: { type: "string", description: "Response detail level", enum: ["full", "standard", "minimal"] },
        },
        required: ["target"],
      },
      output: {
        example: {
          target: "0x2626664c2603336e57b271c5c0b26f421741e481",
          chain: "base",
          verdict: "LOW_RISK",
          trust_grade: "B",
          composite_score: 74,
          proceed: true,
          checks: { protocol: "B", token: null, counterparty: null, position: "C" },
        },
        schema: {
          properties: {
            verdict: { type: "string", enum: ["SAFE", "LOW_RISK", "CAUTION", "HIGH_RISK", "DANGER"] },
            trust_grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
            composite_score: { type: "number" },
            proceed: { type: "boolean" },
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

// Sync with facilitator on startup so the middleware learns what payment
// schemes / networks are supported (required for 402 responses to work).
app.use(paymentMiddlewareFromConfig(paymentRoutes, facilitator, schemes));


// ============================================================
// RATE LIMITING MIDDLEWARE (applied to all paid endpoints)
// ============================================================

const PAID_PATHS = ["/verify/protocol", "/verify/token", "/verify/position", "/verify/counterparty", "/preflight"];

app.use(PAID_PATHS, async (req, res, next) => {
  if (!ratelimit) return next(); // Skip if Redis not configured

  // Identify caller by x-payer-address header (set by x402 after payment)
  // or fall back to IP address for non-paying requests
  const walletAddress = req.headers["x-payer-address"] || req.ip || "anonymous";
  const identifier = walletAddress.toLowerCase();

  try {
    const { success, limit, remaining, reset } = await ratelimit.limit(identifier);

    // Always set rate limit headers so agents know their quota
    res.set("X-RateLimit-Limit", String(limit));
    res.set("X-RateLimit-Remaining", String(remaining));
    res.set("X-RateLimit-Reset", String(reset));

    if (!success) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        message: `Free tier allows ${limit} calls per day per wallet. Upgrade or wait until ${new Date(reset).toISOString()}.`,
        limit,
        remaining: 0,
        reset: new Date(reset).toISOString(),
      });
    }
  } catch (err) {
    // If rate limiter fails, let the request through (fail-open)
    console.error("Rate limiter error (failing open):", err.message);
  }

  next();
});


// ============================================================
// API ENDPOINTS
// ============================================================

/**
 * /verify/protocol - $0.008 per call
 * The highest-value endpoint: answers "is this contract safe to interact with?"
 */
app.post("/verify/protocol", async (req, res) => {
  const params = { ...req.query, ...req.body };
  const { address, chain = "base", detail = "full" } = params;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Valid contract address required (0x + 40 hex characters)" });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";

  try {
    const cacheKey = `sentinel:protocol:${address.toLowerCase()}:${chain}`;
    const result = await cachedCall(cacheKey, CACHE_TTL.protocol, () => scoreProtocol(address, chain));
    res.json(filterResponse(result, detailLevel));
  } catch (error) {
    console.error("Protocol verification error:", error);
    res.status(500).json({ error: "Protocol verification failed. Please try again later." });
  }
});

/**
 * /verify/position - $0.005 per call
 * DeFi position risk analysis: protocol trust + category risk + TVL health + concentration
 */
app.post("/verify/position", async (req, res) => {
  const params = { ...req.query, ...req.body };
  const { protocol: protocolAddress, user, chain = "base", detail = "full" } = params;

  if (!protocolAddress || !/^0x[a-fA-F0-9]{40}$/.test(protocolAddress)) {
    return res.status(400).json({ error: "Valid protocol contract address required (?protocol=0x...)" });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";

  try {
    const cacheKey = `sentinel:position:${protocolAddress.toLowerCase()}:${chain}`;
    const result = await cachedCall(cacheKey, CACHE_TTL.position, () => analyzePosition(protocolAddress, user || null, chain));
    res.json(filterResponse(result, detailLevel));
  } catch (error) {
    console.error("Position analysis error:", error);
    res.status(500).json({ error: "Position analysis failed. Please try again later." });
  }
});

/**
 * /verify/counterparty - $0.01 per call
 * Counterparty intelligence: OFAC sanctions, address reputation, exploit association
 */
app.post("/verify/counterparty", async (req, res) => {
  const params = { ...req.query, ...req.body };
  const { address, chain = "base", detail = "full" } = params;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Valid address required (0x + 40 hex characters)" });
  }

  try {
    const cacheKey = `sentinel:counterparty:${address.toLowerCase()}:${chain}`;
    const result = await cachedCall(cacheKey, CACHE_TTL.counterparty, () => scoreCounterparty(address, chain));
    res.json(filterResponse(result, DETAIL_LEVELS.includes(detail) ? detail : "full"));
  } catch (error) {
    console.error("Counterparty verification error:", error);
    res.status(500).json({ error: "Counterparty verification failed. Please try again later." });
  }
});

/**
 * /verify/token - $0.005 per call
 * Token safety assessment: honeypot, tax, ownership, holder distribution
 */
app.post("/verify/token", async (req, res) => {
  const params = { ...req.query, ...req.body };
  const { address, chain = "base", detail = "full" } = params;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Valid token address required (0x + 40 hex characters)" });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";

  try {
    const cacheKey = `sentinel:token:${address.toLowerCase()}:${chain}`;
    const fullResult = await cachedCall(cacheKey, CACHE_TTL.token, async () => {
      const [security, market] = await Promise.all([
        getTokenSecurity(address, chain),
        getTokenMarketData(address),
      ]);

      const result = scoreToken(security, market);

      return {
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
          sentinel_version: VERSION,
        },
      };
    });

    res.json(filterResponse(fullResult, detailLevel));
  } catch (error) {
    console.error("Token verification error:", error);
    res.status(500).json({ error: "Token verification failed. Please try again later." });
  }
});

/**
 * /preflight - $0.025 per call
 * Unified pre-transaction safety check
 * Runs protocol trust + token safety + counterparty screening + position risk in parallel
 * Returns a single go/no-go verdict with component grades
 */
app.post("/preflight", async (req, res) => {
  const params = { ...req.query, ...req.body };
  const { target, token, counterparty, chain = "base", detail = "full" } = params;

  if (!target || !/^0x[a-fA-F0-9]{40}$/.test(target)) {
    return res.status(400).json({ error: "Valid target address required (?target=0x... — the contract you're about to interact with)" });
  }
  if (token && !/^0x[a-fA-F0-9]{40}$/.test(token)) {
    return res.status(400).json({ error: "Invalid token address format (must be 0x + 40 hex chars)" });
  }
  if (counterparty && !/^0x[a-fA-F0-9]{40}$/.test(counterparty)) {
    return res.status(400).json({ error: "Invalid counterparty address format (must be 0x + 40 hex chars)" });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";
  const startTime = Date.now();

  try {
    // Run all checks in parallel — only protocol is mandatory
    const checks = await Promise.allSettled([
      scoreProtocol(target, chain),
      token ? (async () => {
        const [security, market] = await Promise.all([
          getTokenSecurity(token, chain),
          getTokenMarketData(token),
        ]);
        const scored = scoreToken(security, market);
        return { address: token, token_name: security.token_name, token_symbol: security.token_symbol, ...scored };
      })() : Promise.resolve(null),
      counterparty ? scoreCounterparty(counterparty, chain) : Promise.resolve(null),
      analyzePosition(target, counterparty || null, chain),
    ]);

    const [protocolResult, tokenResult, counterpartyResult, positionResult] = checks.map(
      (r) => r.status === "fulfilled" ? r.value : null
    );

    // Build component summary
    const components = {
      protocol: protocolResult ? {
        verdict: protocolResult.verdict,
        grade: protocolResult.trust_grade,
        score: protocolResult.trust_score,
        risk_flags: protocolResult.risk_flags,
      } : { verdict: "ERROR", grade: "N/A", score: null, risk_flags: ["Protocol check failed"] },

      token: tokenResult ? {
        verdict: tokenResult.verdict,
        grade: tokenResult.trust_grade,
        score: tokenResult.trust_score,
        name: tokenResult.token_name,
        symbol: tokenResult.token_symbol,
        risk_flags: tokenResult.risk_flags,
      } : null,

      counterparty: counterpartyResult ? {
        verdict: counterpartyResult.verdict,
        grade: counterpartyResult.trust_grade,
        score: counterpartyResult.trust_score,
        risk_flags: counterpartyResult.risk_flags,
      } : null,

      position: positionResult ? {
        verdict: positionResult.verdict,
        grade: positionResult.trust_grade,
        score: positionResult.trust_score,
        risk_flags: positionResult.risk_flags,
        recommendations: positionResult.recommendations,
      } : null,
    };

    // Compute composite score — weighted by what checks were actually run
    // Protocol is always heaviest; others scale if present
    const scores = [];
    const weights = [];

    if (components.protocol.score != null) { scores.push(components.protocol.score); weights.push(0.35); }
    if (components.position?.score != null) { scores.push(components.position.score); weights.push(0.25); }
    if (components.token?.score != null)    { scores.push(components.token.score);    weights.push(0.20); }
    if (components.counterparty?.score != null) { scores.push(components.counterparty.score); weights.push(0.20); }

    // Normalize weights to sum to 1.0
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const compositeScore = Math.round(
      scores.reduce((sum, score, i) => sum + score * (weights[i] / weightSum), 0)
    );
    const { grade, verdict } = gradeFromScore(compositeScore);

    // Aggregate all risk flags
    const allRiskFlags = [
      ...(components.protocol.risk_flags || []),
      ...(components.token?.risk_flags || []),
      ...(components.counterparty?.risk_flags || []),
      ...(components.position?.risk_flags || []),
    ];

    // Hard blockers: sanctions or honeypot override the composite
    const hardBlock = allRiskFlags.some(f =>
      f.includes("OFAC SDN SANCTIONS") || f.includes("HONEYPOT DETECTED")
    );
    const finalVerdict = hardBlock ? "DANGER" : verdict;
    const finalGrade = hardBlock ? "F" : grade;
    const finalScore = hardBlock ? Math.min(compositeScore, 15) : compositeScore;

    // Proceed recommendation
    const proceed = !hardBlock && finalScore >= 40;

    const result = {
      target,
      token: token || null,
      counterparty: counterparty || null,
      chain,
      verdict: finalVerdict,
      trust_grade: finalGrade,
      composite_score: finalScore,
      proceed,
      proceed_recommendation: proceed
        ? (finalScore >= 70 ? "Transaction appears safe to proceed" : "Proceed with caution — review risk flags")
        : "DO NOT PROCEED — elevated risk detected",
      checks_summary: {
        protocol: components.protocol.grade,
        token: components.token?.grade || "not_checked",
        counterparty: components.counterparty?.grade || "not_checked",
        position: components.position?.grade || "not_checked",
      },
      risk_flags: allRiskFlags,
      components: detailLevel === "minimal" ? undefined : components,
      recommendations: positionResult?.recommendations || [],
      meta: {
        response_time_ms: Date.now() - startTime,
        data_freshness: new Date().toISOString(),
        sentinel_version: VERSION,
        checks_run: [
          "protocol",
          token ? "token" : null,
          counterparty ? "counterparty" : null,
          "position",
        ].filter(Boolean),
      },
    };

    // Apply detail filtering
    if (detailLevel === "minimal") {
      res.json({
        target: result.target,
        chain: result.chain,
        verdict: result.verdict,
        trust_grade: result.trust_grade,
        composite_score: result.composite_score,
        proceed: result.proceed,
        proceed_recommendation: result.proceed_recommendation,
        checks_summary: result.checks_summary,
        meta: result.meta,
      });
    } else if (detailLevel === "standard") {
      const { components: _c, ...rest } = result;
      res.json(rest);
    } else {
      res.json(result);
    }
  } catch (error) {
    console.error("Preflight error:", error);
    res.status(500).json({ error: "Preflight check failed. Please try again later." });
  }
});


// ============================================================
// HEALTH & DISCOVERY (free)
// ============================================================

// Root — human & agent-friendly service overview
app.get("/", (req, res) => {
  res.json({
    service: "Sentinel",
    tagline: "The Trust Layer for Autonomous Agents",
    description: "Sentinel is an x402-gated verification service that helps autonomous AI agents assess on-chain risk before executing transactions on Base. Pay per query in USDC — no API keys, no accounts, no subscriptions.",
    version: VERSION,
    network: NETWORK,
    base_url: `https://sentinel-awms.onrender.com`,
    payment_protocol: "x402 (HTTP 402 Payment Required)",
    payment_token: "USDC on Base",
    documentation: {
      openapi: "/openapi.json",
      health: "/health",
      integration_guide: "https://github.com/nbsickler-ux/Sentinel/blob/main/INTEGRATION.md",
    },
    endpoints: [
      { path: "POST /verify/protocol",     price: "$0.008 USDC", description: "Is this smart contract trustworthy? Checks audit status, TVL, age, and open-source verification." },
      { path: "POST /verify/token",         price: "$0.005 USDC", description: "Is this token legitimate? Detects honeypots, fake tokens, tax manipulation, and rugpull patterns." },
      { path: "POST /verify/position",      price: "$0.005 USDC", description: "Is this DeFi position safe? Analyzes liquidity depth, IL risk, concentration, and utilization." },
      { path: "POST /verify/counterparty",  price: "$0.010 USDC", description: "Is this wallet safe to interact with? Checks OFAC sanctions, contract verification, and activity patterns." },
      { path: "POST /preflight",            price: "$0.025 USDC", description: "Should I execute this transaction? Runs all checks in parallel, returns a single go/no-go recommendation." },
    ],
    trust_verdicts: ["SAFE", "MODERATE", "CAUTION", "DANGER"],
    grades: ["A+", "A", "B+", "B", "C+", "C", "D", "F"],
    quick_start: {
      step_1: "Send a POST request with JSON body to any endpoint above",
      step_2: "Receive HTTP 402 with x402 payment details",
      step_3: "Sign a USDC payment on Base and include the x402 header",
      step_4: "Receive the trust verification result",
      example: 'POST /verify/protocol { "address": "0x2626664c2603336e57b271c5c0b26f421741e481", "chain": "base" }',
    },
  });
});

// /.well-known/x402 — discovery document for x402scan and agent frameworks
app.get("/.well-known/x402", (req, res) => {
  const BASE = "https://sentinel-awms.onrender.com";
  res.json({
    version: 1,
    description: "Sentinel — x402-gated on-chain trust verification for autonomous AI agents on Base. Pay per query in USDC, no API keys required.",
    resources: [
      `${BASE}/verify/protocol`,
      `${BASE}/verify/token`,
      `${BASE}/verify/position`,
      `${BASE}/verify/counterparty`,
      `${BASE}/preflight`,
    ],
    instructions: [
      "# Sentinel API",
      "All endpoints accept POST with JSON body. Payment via x402 on Base (eip155:8453) in USDC.",
      "",
      "## POST /verify/protocol",
      "Assess smart contract trustworthiness. Input: { address (required), chain, detail }. Price: $0.008 USDC.",
      "",
      "## POST /verify/token",
      "Check token legitimacy and safety. Input: { address (required), chain, detail }. Price: $0.005 USDC.",
      "",
      "## POST /verify/position",
      "Analyze DeFi position risk. Input: { address (required), chain, detail }. Price: $0.005 USDC.",
      "",
      "## POST /verify/counterparty",
      "Assess counterparty wallet safety. Input: { address (required), chain, detail }. Price: $0.010 USDC.",
      "",
      "## POST /preflight",
      "Unified pre-transaction safety check. Input: { target (required), chain, token, counterparty, detail }. Price: $0.025 USDC.",
    ].join("\n"),
  });
});

// OpenAPI 3.1 spec — machine-readable API contract for agent frameworks
app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: "Sentinel — The Trust Layer for Autonomous Agents",
      description: "x402-gated on-chain risk verification service for AI agents on Base. Pay per query in USDC with no API keys required. Agents send a request, receive HTTP 402, sign a USDC payment, and get trust verification results.",
      version: VERSION,
      contact: { name: "Sentinel", url: "https://github.com/nbsickler-ux/Sentinel" },
      "x-payment-protocol": "x402",
      "x-payment-token": "USDC",
      "x-payment-network": "Base (eip155:8453)",
      "x-guidance": "Sentinel verifies on-chain trust for autonomous AI agents on Base. All /verify/* and /preflight endpoints require x402 USDC payment on Base. Free discovery endpoints: GET /, GET /health, GET /openapi.json.",
    },
    servers: [{ url: "https://sentinel-awms.onrender.com", description: "Production (Base mainnet)" }],
    paths: {
      "/verify/protocol": {
        post: {
          operationId: "verifyProtocol",
          summary: "Assess smart contract trustworthiness",
          description: "Evaluates a smart contract's audit status, TVL, on-chain age, open-source verification, and protocol registry presence. Returns a composite trust score with verdict and grade.",
          tags: ["Verification"],
          "x-payment-info": { protocols: ["x402"], pricingMode: "fixed", price: "0.008", currency: "USDC", network: "eip155:8453" },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["address"],
                  properties: {
                    address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Contract address to verify" },
                    chain: { type: "string", default: "base", description: "Chain identifier" },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Trust verification result with score, verdict, grade, and evidence" },
            "402": { description: "Payment required — x402 payment details in response headers" },
            "400": { description: "Invalid address format" },
          },
        },
      },
      "/verify/token": {
        post: {
          operationId: "verifyToken",
          summary: "Check token legitimacy and safety",
          description: "Detects honeypots, fake tokens, tax manipulation, rugpull patterns, and ownership risks. Uses GoPlus Security API for comprehensive token analysis.",
          tags: ["Verification"],
          "x-payment-info": { protocols: ["x402"], pricingMode: "fixed", price: "0.005", currency: "USDC", network: "eip155:8453" },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["address"],
                  properties: {
                    address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Token contract address" },
                    chain: { type: "string", default: "base", description: "Chain identifier" },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Token safety result with honeypot detection, tax analysis, and risk flags" },
            "402": { description: "Payment required" },
            "400": { description: "Invalid address format" },
          },
        },
      },
      "/verify/position": {
        post: {
          operationId: "verifyPosition",
          summary: "Analyze DeFi position risk",
          description: "Evaluates liquidity depth, impermanent loss risk, pool concentration, and utilization rate for DeFi positions.",
          tags: ["Verification"],
          "x-payment-info": { protocols: ["x402"], pricingMode: "fixed", price: "0.005", currency: "USDC", network: "eip155:8453" },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["address"],
                  properties: {
                    address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Pool or vault contract address" },
                    chain: { type: "string", default: "base", description: "Chain identifier" },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Position risk analysis with liquidity and concentration metrics" },
            "402": { description: "Payment required" },
            "400": { description: "Invalid address format" },
          },
        },
      },
      "/verify/counterparty": {
        post: {
          operationId: "verifyCounterparty",
          summary: "Assess counterparty wallet safety",
          description: "Checks OFAC sanctions list, contract verification status, wallet age, transaction patterns, and activity signals. OFAC hits are hard blockers that override all other scores.",
          tags: ["Verification"],
          "x-payment-info": { protocols: ["x402"], pricingMode: "fixed", price: "0.010", currency: "USDC", network: "eip155:8453" },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["address"],
                  properties: {
                    address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Wallet or contract address" },
                    chain: { type: "string", default: "base", description: "Chain identifier" },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Counterparty intelligence with sanctions check and activity analysis" },
            "402": { description: "Payment required" },
            "400": { description: "Invalid address format" },
          },
        },
      },
      "/preflight": {
        post: {
          operationId: "preflight",
          summary: "Unified pre-transaction safety check",
          description: "Runs protocol, token, position, and counterparty checks in parallel. Computes a weighted composite score (protocol 35%, position 25%, token 20%, counterparty 20%) with dynamic normalization for missing checks. OFAC sanctions and honeypot detections are hard blockers. Returns a single proceed/do-not-proceed recommendation.",
          tags: ["Verification"],
          "x-payment-info": { protocols: ["x402"], pricingMode: "fixed", price: "0.025", currency: "USDC", network: "eip155:8453" },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["target"],
                  properties: {
                    target: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Target contract address for the transaction" },
                    chain: { type: "string", default: "base", description: "Chain identifier" },
                    token: { type: "string", description: "Token address involved (optional)" },
                    counterparty: { type: "string", description: "Counterparty wallet address (optional)" },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Composite safety analysis with proceed recommendation, individual component scores, and hard-blocker flags" },
            "402": { description: "Payment required" },
            "400": { description: "Invalid target address" },
          },
        },
      },
    },
    components: {
      schemas: {
        TrustVerdict: { type: "string", enum: ["SAFE", "MODERATE", "CAUTION", "DANGER"], description: "Overall risk assessment" },
        Grade: { type: "string", enum: ["A+", "A", "B+", "B", "C+", "C", "D", "F"], description: "Letter grade mapped from numeric score" },
      },
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    service: "Sentinel",
    tagline: "The Trust Layer for Autonomous Agents",
    version: VERSION,
    status: "operational",
    network: NETWORK,
    facilitator: (CDP_API_KEY_ID && CDP_API_KEY_SECRET) ? "cdp (coinbase)" : "x402.org",
    cache: redis ? "enabled" : "disabled",
    rate_limit: ratelimit ? "25 calls/wallet/day free tier" : "disabled",
    endpoints: {
      "/verify/protocol":     { price: "$0.008 USDC", status: "live", cache_ttl: "10 min", description: "Protocol trust verification" },
      "/verify/position":     { price: "$0.005 USDC", status: "live", cache_ttl: "5 min",  description: "Position risk analysis" },
      "/verify/counterparty": { price: "$0.010 USDC", status: "live", cache_ttl: "15 min", description: "Counterparty intelligence" },
      "/verify/token":        { price: "$0.005 USDC", status: "live", cache_ttl: "5 min",  description: "Token legitimacy check" },
      "/preflight":           { price: "$0.025 USDC", status: "live", cache_ttl: "varies", description: "Unified pre-transaction safety" },
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
      console.error("Test protocol verification error:", error);
      res.status(500).json({ error: "Protocol verification failed. Please try again later." });
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
      console.error("Test token verification error:", error);
      res.status(500).json({ error: "Token verification failed. Please try again later." });
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
      console.error("Test position analysis error:", error);
      res.status(500).json({ error: "Position analysis failed. Please try again later." });
    }
  });

  app.get("/test/counterparty", async (req, res) => {
    const { address, chain = "base", detail = "full" } = req.query;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: "Valid address required" });
    }
    try {
      const result = await scoreCounterparty(address, chain);
      res.json(filterResponse(result, detail));
    } catch (error) {
      console.error("Test counterparty verification error:", error);
      res.status(500).json({ error: "Counterparty verification failed. Please try again later." });
    }
  });

  app.get("/test/preflight", async (req, res) => {
    const { target, token, counterparty, chain = "base", detail = "full" } = req.query;
    if (!target || !/^0x[a-fA-F0-9]{40}$/.test(target)) {
      return res.status(400).json({ error: "Valid target address required (?target=0x...)" });
    }
    try {
      // Run all checks in parallel
      const checks = await Promise.allSettled([
        scoreProtocol(target, chain),
        token ? (async () => {
          const [security, market] = await Promise.all([getTokenSecurity(token, chain), getTokenMarketData(token)]);
          const scored = scoreToken(security, market);
          return { address: token, token_name: security.token_name, token_symbol: security.token_symbol, ...scored };
        })() : Promise.resolve(null),
        counterparty ? scoreCounterparty(counterparty, chain) : Promise.resolve(null),
        analyzePosition(target, counterparty || null, chain),
      ]);
      const [protocolResult, tokenResult, counterpartyResult, positionResult] = checks.map(r => r.status === "fulfilled" ? r.value : null);

      const components = {
        protocol: protocolResult ? { verdict: protocolResult.verdict, grade: protocolResult.trust_grade, score: protocolResult.trust_score, risk_flags: protocolResult.risk_flags } : { verdict: "ERROR", grade: "N/A", score: null, risk_flags: ["Protocol check failed"] },
        token: tokenResult ? { verdict: tokenResult.verdict, grade: tokenResult.trust_grade, score: tokenResult.trust_score, name: tokenResult.token_name, symbol: tokenResult.token_symbol, risk_flags: tokenResult.risk_flags } : null,
        counterparty: counterpartyResult ? { verdict: counterpartyResult.verdict, grade: counterpartyResult.trust_grade, score: counterpartyResult.trust_score, risk_flags: counterpartyResult.risk_flags } : null,
        position: positionResult ? { verdict: positionResult.verdict, grade: positionResult.trust_grade, score: positionResult.trust_score, risk_flags: positionResult.risk_flags, recommendations: positionResult.recommendations } : null,
      };

      const scores = [], weights = [];
      if (components.protocol.score != null) { scores.push(components.protocol.score); weights.push(0.35); }
      if (components.position?.score != null) { scores.push(components.position.score); weights.push(0.25); }
      if (components.token?.score != null)    { scores.push(components.token.score);    weights.push(0.20); }
      if (components.counterparty?.score != null) { scores.push(components.counterparty.score); weights.push(0.20); }
      const weightSum = weights.reduce((a, b) => a + b, 0);
      const compositeScore = Math.round(scores.reduce((sum, score, i) => sum + score * (weights[i] / weightSum), 0));
      const { grade, verdict } = gradeFromScore(compositeScore);

      const allRiskFlags = [...(components.protocol.risk_flags || []), ...(components.token?.risk_flags || []), ...(components.counterparty?.risk_flags || []), ...(components.position?.risk_flags || [])];
      const hardBlock = allRiskFlags.some(f => f.includes("OFAC SDN SANCTIONS") || f.includes("HONEYPOT DETECTED"));
      const finalVerdict = hardBlock ? "DANGER" : verdict;
      const finalGrade = hardBlock ? "F" : grade;
      const finalScore = hardBlock ? Math.min(compositeScore, 15) : compositeScore;
      const proceed = !hardBlock && finalScore >= 40;

      const result = {
        target, token: token || null, counterparty: counterparty || null, chain, verdict: finalVerdict, trust_grade: finalGrade, composite_score: finalScore, proceed,
        proceed_recommendation: proceed ? (finalScore >= 70 ? "Transaction appears safe to proceed" : "Proceed with caution — review risk flags") : "DO NOT PROCEED — elevated risk detected",
        checks_summary: { protocol: components.protocol.grade, token: components.token?.grade || "not_checked", counterparty: components.counterparty?.grade || "not_checked", position: components.position?.grade || "not_checked" },
        risk_flags: allRiskFlags, components, recommendations: positionResult?.recommendations || [],
        meta: { response_time_ms: Date.now() - startTime, data_freshness: new Date().toISOString(), sentinel_version: VERSION, checks_run: ["protocol", token ? "token" : null, counterparty ? "counterparty" : null, "position"].filter(Boolean) },
      };
      const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";
      if (detailLevel === "minimal") { res.json({ target: result.target, chain: result.chain, verdict: result.verdict, trust_grade: result.trust_grade, composite_score: result.composite_score, proceed: result.proceed, proceed_recommendation: result.proceed_recommendation, checks_summary: result.checks_summary, meta: result.meta }); }
      else if (detailLevel === "standard") { const { components: _c, ...rest } = result; res.json(rest); }
      else { res.json(result); }
    } catch (error) {
      console.error("Test preflight error:", error);
      res.status(500).json({ error: "Preflight check failed. Please try again later." });
    }
  });

  console.log("  [DEV] Test routes enabled: /test/protocol, /test/token, /test/position, /test/counterparty, /test/preflight");
}


// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  const facType = (CDP_API_KEY_ID && CDP_API_KEY_SECRET) ? "CDP (Coinbase)" : "x402.org";
  console.log(`
  ┌────────────────────────────────────────────┐
  │  SENTINEL v0.3.0                            │
  │  The Trust Layer for Autonomous Agents       │
  │  Verify before you execute.                  │
  ├────────────────────────────────────────────┤
  │  Network:     ${NETWORK.padEnd(29)}│
  │  Facilitator: ${facType.padEnd(29)}│
  │  Port:        ${String(PORT).padEnd(29)}│
  │  Cache:       ${(redis ? "enabled" : "disabled").padEnd(29)}│
  ├────────────────────────────────────────────┤
  │  LIVE:                                       │
  │    GET /verify/protocol  ($0.008 USDC)       │
  │    GET /verify/token     ($0.005 USDC)       │
  │    GET /verify/position  ($0.005 USDC)       │
  │    GET /verify/counterparty ($0.01 USDC)     │
  │    GET /preflight        ($0.025 USDC)       │
  │  FREE:                                       │
  │    GET /health                               │
  └────────────────────────────────────────────┘
  `);
});
