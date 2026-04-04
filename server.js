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
import pino from "pino";
import pinoHttp from "pino-http";
import {
  filterResponse,
  gradeFromScore,
  scoreToken,
  generatePositionRecommendations,
  checkSanctionsWithSet,
  checkExploitAssociationWithRegistry,
  DETAIL_LEVELS,
  VERSION,
} from "./lib/scoring.js";
import {
  scoreProtocolDimensions,
  scoreCounterpartyDimensions,
  scorePositionDimensions,
  computePreflightComposite,
  CATEGORY_RISK_MAP,
} from "./lib/scoring-engine/index.js";
import { initPool, runMigrations } from "./lib/db.js";
import { createRequestLogger } from "./lib/request-logger.js";
import { createAdminRouter } from "./lib/admin-stats.js";
import { initEAS, isEASEnabled, createVerificationAttestation, getAttestationsByTarget } from "./lib/eas/client.js";
import { initReputationStore, getAgentProfile, updateAgentProfile } from "./lib/reputation/store.js";
import { getTierCacheTTLs, shouldSkipOfacRecheck } from "./lib/reputation/tiers.js";
import { initWatchlist, addWatch, removeWatch, getWatchesForAgent } from "./lib/monitoring/watchlist.js";
import { initScanner, startScanner, stopScanner } from "./lib/monitoring/scanner.js";
import { initAuditLog, writeAuditLog } from "./lib/compliance/audit-log.js";
import { getAuditHistory, getAuditSummary, generateDailyReport } from "./lib/compliance/audit-log.js";

dotenv.config();

// ============================================================
// STRUCTURED LOGGING WITH PINO
// ============================================================
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const NODE_ENV = process.env.NODE_ENV || "development";

// Configure pino with optional pretty-printing in development
const pinoConfig = {
  level: LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Create logger with optional pretty-printing in development
let logger;
try {
  if (NODE_ENV !== "production") {
    // Development: use pino-pretty for human-readable logs
    logger = pino(
      pinoConfig,
      pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      })
    );
  } else {
    // Production: use standard JSON format
    logger = pino(pinoConfig);
  }
} catch (e) {
  // Fallback logger for testing environment
  logger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
}

const app = express();
app.set("trust proxy", true);   // Render (and most PaaS) sit behind a reverse proxy — trust X-Forwarded-Proto so req.protocol is "https"
app.use(express.json());

// Add pino-http middleware for automatic request logging (only if logger has request method)
if (typeof logger.request === 'function') {
  try {
    app.use(pinoHttp({ logger }));
  } catch (e) {
    // Skip middleware if it fails
  }
}

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
// VERSION imported from lib/scoring.js
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

// filterResponse, gradeFromScore, DETAIL_LEVELS imported from lib/scoring.js

// Well-known Base addresses for examples and error messages
const EXAMPLES = {
  token:        "0x532f27101965dd16442E59d40670FaF5eBB142E4",  // Aerodrome (AERO) on Base
  protocol:     "0x940181a94A35A4569E4529A3CDfB74e38FD98631",  // Aerodrome AMM Router on Base
  counterparty: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",  // vitalik.eth
  position:     "0x940181a94A35A4569E4529A3CDfB74e38FD98631",  // Aerodrome AMM Router
};

const BASE_URL = "https://sentinel-awms.onrender.com";

// ============================================================
// CACHING LAYER (Upstash Redis)
// Caches verification results to achieve <200ms responses
// Falls back gracefully if Redis is not configured
// ============================================================

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

let redis = null;
let ratelimit = null;
let freetierLimit = null;

if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });

  // Rate limiter: 25 calls per wallet per day (sliding window) — safety cap for paid calls
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(25, "1 d"),
    prefix: "sentinel:ratelimit",
  });

  // Free tier limiter: 25 calls per IP per day — no payment required
  // Checked BEFORE x402 middleware. Once exhausted, x402 payment kicks in.
  freetierLimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(25, "1 d"),
    prefix: "sentinel:freetier",
  });

  logger.info({ service: "sentinel", feature: "redis" }, "Redis caching enabled (Upstash)");
  logger.info({ service: "sentinel", feature: "ratelimit" }, "Rate limiting enabled: 25 calls/wallet/day");
  logger.info({ service: "sentinel", feature: "freetier" }, "Free tier enabled: 25 calls/IP/day without payment");
} else {
  logger.info({ service: "sentinel", feature: "redis" }, "Redis caching disabled (no UPSTASH_REDIS_REST_URL configured)");
}

// Cache TTLs in seconds
const CACHE_TTL = {
  protocol:         600,   // 10 min — contract metadata changes slowly
  token:            300,   // 5 min — token security can shift faster
  position:         300,   // 5 min
  counterparty:     900,   // 15 min — sanctions lists update daily
  contractMetadata: 86400, // 24 hours — deployment data never changes
  preflight:        300,   // 5 min — composite results for identical inputs
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
let registryLastRefreshed = null;

async function loadProtocolRegistry() {
  try {
    logger.info({ source: "defilama" }, "Loading DeFiLlama protocol registry...");
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
    registryLastRefreshed = new Date().toISOString();
    logger.info({ addressCount: Object.keys(protocolRegistry).length, protocolCount: protocols.length }, "Protocol registry loaded");
  } catch (e) {
    logger.error({ err: e, source: "defilama" }, "Failed to load protocol registry");
  }
}

/**
 * Refresh protocol registry in the background (24h schedule).
 * Mirrors loadProtocolRegistry logic exactly. Swaps atomically.
 */
async function refreshProtocolRegistry() {
  try {
    logger.info({ source: "defilama" }, "Refreshing protocol registry (scheduled)...");
    const response = await axios.get("https://api.llama.fi/protocols", { timeout: 15000 });
    const protocols = response.data;
    const newRegistry = {};

    for (const p of protocols) {
      const addresses = [];
      if (p.address) addresses.push(p.address.toLowerCase());
      if (p.chainAddresses) {
        for (const [chain, addr] of Object.entries(p.chainAddresses)) {
          if (typeof addr === "string") addresses.push(addr.toLowerCase());
        }
      }

      for (const addr of addresses) {
        const cleanAddr = addr.includes(":") ? addr.split(":")[1] : addr;
        if (cleanAddr && cleanAddr.startsWith("0x")) {
          newRegistry[cleanAddr] = {
            slug: p.slug,
            name: p.name,
            category: p.category,
            audits: p.audits,
            audit_links: p.audit_links || [],
            hacked: p.hacked || false,
            hackDate: p.hackDate || null,
            hackAmount: p.hackAmount || null,
            governanceID: p.governanceID || null,
            treasury: p.treasury || null,
            openSource: p.openSource !== false,
            forkedFrom: p.forkedFrom || [],
            twitter: p.twitter || null,
            url: p.url || null,
            listedAt: p.listedAt || null,
            mcap: p.mcap || null,
            chainTvls: p.chainTvls || {},
          };
        }
      }
    }

    // Atomic swap — no request sees a half-built registry
    const oldSize = Object.keys(protocolRegistry).length;
    protocolRegistry = newRegistry;
    registryLoaded = true;
    registryLastRefreshed = new Date().toISOString();
    const newSize = Object.keys(protocolRegistry).length;
    logger.info({ oldSize, newSize, delta: newSize - oldSize }, "Protocol registry refreshed successfully");
  } catch (error) {
    logger.error({ err: error }, "Protocol registry refresh failed — keeping existing data");
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
    logger.error({ err: e, service: "goplus" }, "GoPlus auth failed");
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
  // Aerodrome Finance — largest DEX on Base ($1.5B+ TVL)
  // Velodrome fork; audited by Ether Authority (June 2024)
  // Smart contracts never exploited (DNS/frontend incident Nov 2023 did not affect contracts)
  "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43": {  // Router
    audited: true,
    auditors: ["Ether Authority"],
    lastAudit: "2024-06-05",
  },
  "0x420dd381b31aef6683db6b902084cb0ffece40da": {  // Pool Factory
    audited: true,
    auditors: ["Ether Authority"],
    lastAudit: "2024-06-05",
  },
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": {  // AERO Token
    audited: true,
    auditors: ["Ether Authority"],
    lastAudit: "2024-06-05",
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

  // If we got no real data, return nulls with degraded flag
  // SECURITY: Never return fake positive data — callers must handle nulls
  // and scoring engine should apply confidence penalty for missing metadata
  // NOTE: `mock` field retained for backward compatibility with scoring-engine/index.js
  // which checks contract.mock for confidence penalties (lines 143, 217)
  if (result.isContract === null && result.verifiedSource === null && result.ageDays === null) {
    logger.warn({ contractAddress, chain }, "Contract metadata unavailable — all data sources failed. Returning degraded result.");
    return {
      isContract: null,
      verifiedSource: null,
      proxyPattern: null,
      ownerIsMultisig: null,
      ageDays: null,
      mock: true,
      degraded: true,
      meta: {},
    };
  }

  return { ...result, meta: {} };
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

// scoreToken imported from lib/scoring.js


// ============================================================
// POSITION DATA LAYER
// Combines protocol trust with position-specific risk factors
// ============================================================

/**
 * Analyze a DeFi position for risk factors
 * Uses protocol trust score + position-specific heuristics
 */
/**
 * Analyze a DeFi position's risk profile.
 * @param {string} protocolAddress - Contract address of the protocol
 * @param {string|null} userAddress - Optional user wallet address
 * @param {string} chain - Chain identifier (default: "base")
 * @param {object|null} precomputedProtocolScore - Optional pre-computed scoreProtocol() result.
 *   Pass this when calling from /preflight to avoid duplicate API calls.
 *   If null, scoreProtocol() is called internally (standalone /verify/position usage).
 */
async function analyzePosition(protocolAddress, userAddress, chain, precomputedProtocolScore = null) {
  const startTime = Date.now();

  // Reuse pre-computed protocol score if available, otherwise fetch fresh
  const protocolScore = precomputedProtocolScore || await scoreProtocol(protocolAddress, chain);

  // Get protocol info from registry
  const normalized = protocolAddress.toLowerCase();
  const protocol = protocolRegistry[normalized];
  const category = protocol?.category || "Unknown";

  // Reuse TVL data from protocol score evidence if available, otherwise fetch fresh
  // This avoids a duplicate DeFiLlama API call when protocol score already has TVL data
  const tvl = protocolScore.evidence?.tvl?.current_usd !== undefined
    ? { currentUsd: protocolScore.evidence.tvl.current_usd, trend30d: protocolScore.evidence.tvl.trend_30d, stable: protocolScore.evidence.tvl.stable }
    : await getTvlData(protocolAddress);

  // Delegate scoring to private engine
  const scored = scorePositionDimensions(protocolScore, category, tvl);

  return {
    protocol_address: protocolAddress,
    user_address: userAddress,
    chain,
    verdict: scored.verdict,
    trust_grade: scored.grade,
    trust_score: scored.compositeScore,
    confidence: protocol ? 0.80 : 0.50,
    protocol_info: {
      name: protocol?.name || "Unknown",
      category,
      underlying_protocol_grade: protocolScore.trust_grade,
    },
    dimensions: scored.dimensions,
    risk_flags: scored.riskFlags,
    recommendations: generatePositionRecommendations(scored.riskFlags, scored.compositeScore),
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
// Scoring functions delegated to lib/scoring-engine/ (private module)


// ============================================================
// COUNTERPARTY DATA LAYER
// OFAC sanctions screening + address reputation
// ============================================================

// --- OFAC SDN Sanctioned Addresses (loaded on startup) ---
let sanctionedAddresses = new Set();
let sanctionsLoaded = false;

async function loadSanctionedAddresses() {
  try {
    logger.info({ source: "ofac" }, "Loading OFAC sanctioned addresses...");
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
    logger.info({ addressCount: sanctionedAddresses.size, source: "ofac" }, "OFAC sanctions list loaded");
  } catch (e) {
    logger.error({ err: e, source: "ofac" }, "Failed to load OFAC sanctions list");
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
      logger.info({ addressCount: sanctionedAddresses.size, source: "ofac-fallback" }, "OFAC sanctions list loaded (fallback)");
    } catch (e2) {
      logger.error({ err: e2, source: "ofac-fallback" }, "Fallback sanctions list also failed");
    }
  }
}

// Load sanctions list on startup (non-blocking)
loadSanctionedAddresses();

/**
 * Check if an address is on the OFAC sanctions list
 * SECURITY: If sanctions list failed to load, returns degraded=true
 * so callers can apply appropriate confidence penalties or hard-block.
 */
function checkSanctions(address) {
  const normalized = address.toLowerCase();
  const isSanctioned = sanctionedAddresses.has(normalized);
  return {
    sanctioned: isSanctioned,
    list: isSanctioned ? "OFAC SDN" : null,
    list_loaded: sanctionsLoaded,
    addresses_indexed: sanctionedAddresses.size,
    degraded: !sanctionsLoaded,
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
async function scoreCounterparty(address, chain, skipOfac = false) {
  const startTime = Date.now();

  // If agent reputation allows OFAC skip, use a clean placeholder result
  const sanctionsPromise = skipOfac
    ? Promise.resolve({ sanctioned: false, list: null, list_loaded: true, degraded: false, skipped: true, reason: "agent_reputation" })
    : Promise.resolve(checkSanctions(address));

  // Fetch all data in parallel
  const [sanctions, addressSecurity, exploitAssoc] = await Promise.all([
    sanctionsPromise,
    getAddressSecurity(address, chain),
    Promise.resolve(checkExploitAssociation(address)),
  ]);

  // Delegate scoring to private engine
  const scored = scoreCounterpartyDimensions(sanctions, addressSecurity, exploitAssoc);

  // SECURITY: If OFAC list failed to load, cap confidence and add warning
  let confidence = scored.confidence;
  const riskFlags = [...scored.riskFlags];
  if (sanctions.degraded) {
    confidence = Math.min(confidence, 0.3);
    riskFlags.push("OFAC_SCREENING_UNAVAILABLE");
    logger.warn({ address, source: "counterparty" }, "Counterparty scored without OFAC sanctions data — confidence capped at 0.3");
  }

  return {
    address,
    chain,
    verdict: sanctions.degraded ? "CAUTION" : scored.verdict,
    trust_grade: sanctions.degraded ? "C" : scored.grade,
    trust_score: scored.compositeScore,
    confidence,
    evidence: {
      sanctions: {
        sanctioned: sanctions.sanctioned,
        list: sanctions.list,
        addresses_screened: sanctions.addresses_indexed,
        screening_degraded: sanctions.degraded,
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
    dimensions: scored.dimensions,
    risk_flags: riskFlags,
    meta: {
      response_time_ms: Date.now() - startTime,
      data_freshness: new Date().toISOString(),
      sentinel_version: VERSION,
      warnings: sanctions.degraded ? ["OFAC sanctions screening unavailable — sanctions list failed to load. Confidence has been capped. Counterparty safety cannot be fully verified."] : [],
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

  // Fetch all data in parallel (contract metadata cached 24h — deployment data never changes)
  const [audit, exploits, contract, tvl] = await Promise.all([
    getAuditData(contractAddress, chain),
    getExploitHistory(contractAddress, chain),
    cachedCall(
      `sentinel:contract:${contractAddress.toLowerCase()}:${chain}`,
      CACHE_TTL.contractMetadata,
      () => getContractMetadata(contractAddress, chain)
    ),
    getTvlData(contractAddress),
  ]);

  // Get protocol metadata from registry
  const protocolMeta = protocolRegistry[contractAddress.toLowerCase()] || {};

  // Delegate scoring to private engine
  const scored = scoreProtocolDimensions(audit, exploits, contract, tvl, protocolMeta);

  return {
    address: contractAddress,
    chain,
    verdict: scored.verdict,
    trust_grade: scored.grade,
    trust_score: scored.compositeScore,
    confidence: scored.confidence,
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
    dimensions: scored.dimensions,
    risk_flags: scored.riskFlags,
    meta: {
      response_time_ms: Date.now() - startTime,
      data_freshness: new Date().toISOString(),
      sentinel_version: VERSION,
      contract_metadata_degraded: !!contract.degraded,
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
    description: "Sentinel Protocol Verification - trust assessment for any smart contract. Creates an on-chain EAS attestation.",
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
    description: "Sentinel Token Verification - honeypot detection, tax analysis, ownership risks. Creates an on-chain EAS attestation.",
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
    description: "Sentinel Position Analysis - DeFi position risk assessment with protocol trust scoring. Creates an on-chain EAS attestation.",
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
    description: "Sentinel Counterparty Intelligence - OFAC sanctions screening, address reputation, exploit association. Creates an on-chain EAS attestation.",
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
    description: "Sentinel Preflight Check - unified pre-transaction safety analysis combining protocol trust, token safety, counterparty screening, and position risk in one call. Creates an on-chain EAS attestation.",
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

// ── Local bypass for internal agents (skips x402 payment) ──
// Set LOCAL_BYPASS_SECRET in .env and pass it via x-bypass-secret header.
// Only affects requests that present the correct secret — public users still pay.
const LOCAL_BYPASS_SECRET = process.env.LOCAL_BYPASS_SECRET || "";
const BYPASS_PATHS = ["/verify/protocol", "/verify/token", "/verify/position", "/verify/counterparty", "/preflight"];

// Wrap x402 payment middleware so bypass requests and free-tier requests skip it
const x402Middleware = paymentMiddlewareFromConfig(paymentRoutes, facilitator, schemes);
app.use(async (req, res, next) => {
  // 1. Local bypass for internal agents (market-agent, testing)
  if (LOCAL_BYPASS_SECRET && req.headers["x-bypass-secret"] === LOCAL_BYPASS_SECRET && BYPASS_PATHS.some(p => req.path === p)) {
    return next();  // Skip x402 payment
  }

  // 2. x402 discovery mode: skip free tier so validators (x402scan, etc.)
  //    can see the real 402 payment challenge for registration/indexing.
  //    Usage: POST /verify/token?x402_discover=true
  if (req.query?.x402_discover === "true" && BYPASS_PATHS.some(p => req.path === p)) {
    logger.info({ path: req.path, ip: req.ip }, "x402 discovery mode — skipping free tier for validator");
    return x402Middleware(req, res, next);
  }

  // 3. Empty-body probe bypass: if a POST to a paid endpoint has no JSON body,
  //    it's a validator/crawler probing for the 402 challenge (e.g. x402scan "Add Server").
  //    Skip free tier so the real 402 payment response is returned.
  if (BYPASS_PATHS.some(p => req.path === p) && req.method === "POST") {
    const hasBody = req.body && typeof req.body === "object" && Object.keys(req.body).length > 0;
    if (!hasBody) {
      logger.info({ path: req.path, ip: req.ip }, "Empty-body probe — skipping free tier for 402 challenge");
      return x402Middleware(req, res, next);
    }
  }

  // 4. Free tier: 25 calls/day per IP — no payment required
  //    Check before x402 so agents can try Sentinel with zero friction.
  //    Once free quota is exhausted, fall through to x402 payment flow.
  if (freetierLimit && BYPASS_PATHS.some(p => req.path === p) && req.method === "POST") {
    const identifier = (req.ip || req.headers["x-forwarded-for"] || "anonymous").toLowerCase();
    try {
      const { success, limit, remaining, reset } = await freetierLimit.limit(identifier);

      // Always set free-tier headers so agents know their quota
      res.set("X-FreeTier-Limit", String(limit));
      res.set("X-FreeTier-Remaining", String(remaining));
      res.set("X-FreeTier-Reset", String(reset));

      if (success) {
        // Free call — skip x402 payment, mark request as free-tier
        req.freeTierCall = true;
        logger.info({ ip: identifier, remaining, path: req.path }, "Free tier call (no payment required)");
        return next();
      }
      // Free quota exhausted — fall through to x402 payment
      logger.info({ ip: identifier, path: req.path }, "Free tier exhausted, requiring x402 payment");
    } catch (err) {
      // If free-tier check fails, fall through to x402 (fail-safe, don't give free calls on error)
      logger.error({ err }, "Free tier limiter error (falling through to x402)");
    }
  }

  x402Middleware(req, res, next);  // Normal x402 payment flow
});
if (LOCAL_BYPASS_SECRET) {
  console.log("[sentinel] Local bypass enabled for internal agents");
}
console.log("[sentinel] Free tier enabled: 25 calls/IP/day without x402 payment");


// ============================================================
// RATE LIMITING MIDDLEWARE (applied to all paid endpoints)
// ============================================================

const PAID_PATHS = ["/verify/protocol", "/verify/token", "/verify/position", "/verify/counterparty", "/preflight"];

app.use(PAID_PATHS, async (req, res, next) => {
  if (!ratelimit) return next(); // Skip if Redis not configured

  // Internal agents with bypass secret skip rate limiting
  if (LOCAL_BYPASS_SECRET && req.headers["x-bypass-secret"] === LOCAL_BYPASS_SECRET) {
    return next();
  }

  // Free tier calls already passed the freetierLimit check — skip the paid rate limiter
  if (req.freeTierCall) {
    return next();
  }

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
        message: `Daily rate limit of ${limit} calls per wallet exceeded. Wait until ${new Date(reset).toISOString()}.`,
        limit,
        remaining: 0,
        reset: new Date(reset).toISOString(),
      });
    }
  } catch (err) {
    // If rate limiter fails, let the request through (fail-open)
    logger.error({ err }, "Rate limiter error (failing open)");
  }

  next();
});


// ============================================================
// REQUEST LOGGING MIDDLEWARE (non-blocking, fail-silent)
// Logs every paid + discovery request to Postgres request_log
// ============================================================

app.use(createRequestLogger({
  alchemyApiKey: ALCHEMY_API_KEY,
  network: NETWORK,
}));


// ============================================================
// ADMIN ROUTES (protected by SENTINEL_ADMIN_KEY)
// ============================================================

const SENTINEL_ADMIN_KEY = process.env.SENTINEL_ADMIN_KEY || "";
app.use("/admin", createAdminRouter(SENTINEL_ADMIN_KEY));


// ============================================================
// API ENDPOINTS
// ============================================================

/**
 * Extract payer wallet from x402 payment context.
 * The x402 middleware sets x-payer-address header after payment verification.
 */
function getPayerWallet(req) {
  const addr = req.headers["x-payer-address"];
  return addr && addr.startsWith("0x") ? addr.toLowerCase() : null;
}

/**
 * Load agent reputation context for a request.
 * Returns { payerWallet, agentProfile, tier, tierTTLs, skipOfac }
 */
async function loadAgentContext(req) {
  const payerWallet = getPayerWallet(req);
  if (!payerWallet) {
    return { payerWallet: null, agentProfile: null, tier: "unknown", tierTTLs: CACHE_TTL, skipOfac: false };
  }
  const agentProfile = await getAgentProfile(payerWallet).catch(() => null);
  const tier = agentProfile?.tier || "unknown";
  const tierTTLs = getTierCacheTTLs(tier, CACHE_TTL);
  const skipOfac = agentProfile ? shouldSkipOfacRecheck(agentProfile) : false;
  return { payerWallet, agentProfile, tier, tierTTLs, skipOfac };
}

/**
 * Fire-and-forget post-response agent profile update.
 */
function updateAgentPostResponse(payerWallet, result) {
  if (!payerWallet) return;
  updateAgentProfile(payerWallet, {
    verdict: result.verdict,
    riskFlags: result.risk_flags || [],
    ofacClean: !(result.risk_flags || []).includes("OFAC_SCREENING_UNAVAILABLE") && !(result.risk_flags || []).includes("SANCTIONED"),
  }).catch(() => {});
}

/**
 * Fire-and-forget audit log write.
 */
function writeAuditPostResponse(req, { payerWallet, tier, endpoint, target, chain, result, startTime, dataSources, price }) {
  writeAuditLog({
    agent_wallet: payerWallet,
    agent_tier: tier,
    ip_address: req.ip,
    endpoint,
    target_address: target,
    chain,
    request_params: { chain, detail: req.query?.detail || req.body?.detail },
    verdict: result.verdict,
    trust_score: result.trust_score || result.composite_score,
    trust_grade: result.trust_grade,
    risk_flags: result.risk_flags || [],
    proceed: result.verdict !== "UNSAFE" && result.verdict !== "DANGER",
    response_time_ms: Date.now() - startTime,
    cache_hit: result.meta?.cache_hit || false,
    x402_payment_amount: price,
    x402_payment_verified: true,
    data_sources_used: dataSources,
    degraded_sources: (result.risk_flags || []).includes("OFAC_SCREENING_UNAVAILABLE") ? ["ofac"] : [],
  });
}

// ============================================================
// GET FALLBACK HANDLERS — guide callers who use GET instead of POST
// These catch the most common DX mistake (GET instead of POST)
// and return a helpful response with a working curl example.
// ============================================================
const GET_FALLBACK_MAP = {
  "/verify/protocol": {
    param: "address",
    example: EXAMPLES.protocol,
    desc: "contract address to verify",
  },
  "/verify/token": {
    param: "address",
    example: EXAMPLES.token,
    desc: "token contract address to check",
  },
  "/verify/position": {
    param: "protocol",
    example: EXAMPLES.position,
    desc: "pool or vault contract address",
  },
  "/verify/counterparty": {
    param: "address",
    example: EXAMPLES.counterparty,
    desc: "wallet or contract address to screen",
  },
  "/preflight": {
    param: "target",
    example: EXAMPLES.protocol,
    desc: "target contract you are about to interact with",
  },
};

for (const [path, info] of Object.entries(GET_FALLBACK_MAP)) {
  app.get(path, (req, res) => {
    res.status(405).json({
      error: "This endpoint requires a POST request with a JSON body.",
      method_received: "GET",
      method_required: "POST",
      hint: `Send a POST request with Content-Type: application/json and a JSON body containing '${info.param}' (${info.desc}).`,
      free_tier: "First 25 calls/day are free — no wallet, no payment, no signup.",
      example: {
        curl: `curl -X POST ${BASE_URL}${path} -H "Content-Type: application/json" -d '{"${info.param}": "${info.example}"}'`,
        body: { [info.param]: info.example, chain: "base" },
      },
    });
  });
}

/**
 * /verify/protocol - $0.008 per call
 * The highest-value endpoint: answers "is this contract safe to interact with?"
 */
app.post("/verify/protocol", async (req, res) => {
  const params = { ...req.query, ...req.body };
  const { address, chain = "base", detail = "full" } = params;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({
      error: "Valid contract address required (0x + 40 hex characters)",
      hint: "Send a POST request with a JSON body containing an 'address' field.",
      example: {
        curl: `curl -X POST ${BASE_URL}/verify/protocol -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.protocol}"}'`,
        body: { address: EXAMPLES.protocol, chain: "base" },
      },
    });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";
  const startTime = Date.now();
  const { payerWallet, tier, tierTTLs } = await loadAgentContext(req);

  try {
    const cacheKey = `sentinel:protocol:${address.toLowerCase()}:${chain}`;
    const result = await cachedCall(cacheKey, tierTTLs.protocol, () => scoreProtocol(address, chain));

    if (result.meta) { result.meta.agent_tier = tier; result.meta.cache_ttl_applied = tierTTLs.protocol; }
    res.json(filterResponse(result, detailLevel));

    if (isEASEnabled() && result.trust_score !== undefined) {
      createVerificationAttestation({ target: address, chain, endpointType: "protocol", trustScore: Math.min(255, Math.max(0, Math.round(result.trust_score))), verdict: result.verdict || "UNKNOWN", trustGrade: result.trust_grade || "N/A", proceed: result.verdict !== "UNSAFE" && result.verdict !== "DANGER", riskFlags: (result.risk_flags || []).join(","), timestamp: Math.floor(Date.now() / 1000), x402PaymentId: 0 }, logger).catch(err => logger.error({ err: err.message, target: address }, "Attestation write failed"));
    }
    updateAgentPostResponse(payerWallet, result);
    writeAuditPostResponse(req, { payerWallet, tier, endpoint: "protocol", target: address, chain, result, startTime, dataSources: ["etherscan", "defilama", "alchemy"], price: "$0.008" });
  } catch (error) {
    logger.error({ err: error, endpoint: "/verify/protocol", address, chain }, "Protocol verification failed");
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
    return res.status(400).json({
      error: "Valid protocol contract address required",
      hint: "Send a POST with JSON body containing a 'protocol' field (the pool/vault contract address).",
      example: {
        curl: `curl -X POST ${BASE_URL}/verify/position -H "Content-Type: application/json" -d '{"protocol": "${EXAMPLES.position}"}'`,
        body: { protocol: EXAMPLES.position, chain: "base" },
      },
    });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";
  const { payerWallet, tier, tierTTLs } = await loadAgentContext(req);

  try {
    const cacheKey = `sentinel:position:${protocolAddress.toLowerCase()}:${chain}`;
    const result = await cachedCall(cacheKey, tierTTLs.position, () => analyzePosition(protocolAddress, user || null, chain));

    if (result.meta) { result.meta.agent_tier = tier; result.meta.cache_ttl_applied = tierTTLs.position; }
    res.json(filterResponse(result, detailLevel));

    if (isEASEnabled() && result.trust_score !== undefined) {
      createVerificationAttestation({
        target: protocolAddress, chain, endpointType: "position",
        trustScore: Math.min(255, Math.max(0, Math.round(result.trust_score))),
        verdict: result.verdict || "UNKNOWN", trustGrade: result.trust_grade || "N/A",
        proceed: result.verdict !== "UNSAFE" && result.verdict !== "DANGER",
        riskFlags: (result.risk_flags || []).join(","),
        timestamp: Math.floor(Date.now() / 1000), x402PaymentId: 0,
      }, logger).catch(err => logger.error({ err: err.message, target: protocolAddress }, "Attestation write failed"));
    }
    updateAgentPostResponse(payerWallet, result);
    writeAuditPostResponse(req, { payerWallet, tier, endpoint: "position", target: protocolAddress, chain, result, startTime: Date.now(), dataSources: ["etherscan", "defilama"], price: "$0.005" });
  } catch (error) {
    logger.error({ err: error, endpoint: "/verify/position", protocol: protocolAddress, chain }, "Position analysis failed");
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
    return res.status(400).json({
      error: "Valid address required (0x + 40 hex characters)",
      hint: "Send a POST with JSON body containing an 'address' field (the wallet or contract to check).",
      example: {
        curl: `curl -X POST ${BASE_URL}/verify/counterparty -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.counterparty}"}'`,
        body: { address: EXAMPLES.counterparty, chain: "base" },
      },
    });
  }

  const { payerWallet, tier, tierTTLs, skipOfac } = await loadAgentContext(req);

  try {
    const cacheKey = `sentinel:counterparty:${address.toLowerCase()}:${chain}`;
    const result = await cachedCall(cacheKey, tierTTLs.counterparty, () => scoreCounterparty(address, chain, skipOfac));

    if (result.meta) { result.meta.agent_tier = tier; result.meta.cache_ttl_applied = tierTTLs.counterparty; result.meta.ofac_skipped = skipOfac; }
    res.json(filterResponse(result, DETAIL_LEVELS.includes(detail) ? detail : "full"));

    if (isEASEnabled() && result.trust_score !== undefined) {
      createVerificationAttestation({
        target: address, chain, endpointType: "counterparty",
        trustScore: Math.min(255, Math.max(0, Math.round(result.trust_score))),
        verdict: result.verdict || "UNKNOWN", trustGrade: result.trust_grade || "N/A",
        proceed: result.verdict !== "UNSAFE" && result.verdict !== "DANGER",
        riskFlags: (result.risk_flags || []).join(","),
        timestamp: Math.floor(Date.now() / 1000), x402PaymentId: 0,
      }, logger).catch(err => logger.error({ err: err.message, target: address }, "Attestation write failed"));
    }
    updateAgentPostResponse(payerWallet, result);
    writeAuditPostResponse(req, { payerWallet, tier, endpoint: "counterparty", target: address, chain, result, startTime: Date.now(), dataSources: ["ofac", "goplus", "exploits"], price: "$0.010" });
  } catch (error) {
    logger.error({ err: error, endpoint: "/verify/counterparty", address, chain }, "Counterparty verification failed");
    res.status(500).json({ error: "Counterparty verification failed. Please try again later." });
  }
});

/**
 * /verify/token - $0.005 per call
 * Token safety assessment: honeypot, tax, ownership, holder distribution
 */
app.post("/verify/token", async (req, res) => {
  const startTime = Date.now();
  const params = { ...req.query, ...req.body };
  const { address, chain = "base", detail = "full" } = params;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({
      error: "Valid token address required (0x + 40 hex characters)",
      hint: "Send a POST with JSON body containing an 'address' field (the token contract to check).",
      example: {
        curl: `curl -X POST ${BASE_URL}/verify/token -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.token}"}'`,
        body: { address: EXAMPLES.token, chain: "base" },
      },
    });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";
  const { payerWallet, tier, tierTTLs } = await loadAgentContext(req);

  try {
    const cacheKey = `sentinel:token:${address.toLowerCase()}:${chain}`;
    const fullResult = await cachedCall(cacheKey, tierTTLs.token, async () => {
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
          response_time_ms: Date.now() - startTime,
          data_freshness: new Date().toISOString(),
          sentinel_version: VERSION,
        },
      };
    });

    if (fullResult.meta) { fullResult.meta.agent_tier = tier; fullResult.meta.cache_ttl_applied = tierTTLs.token; }
    res.json(filterResponse(fullResult, detailLevel));

    if (isEASEnabled() && fullResult.trust_score !== undefined) {
      createVerificationAttestation({
        target: address, chain, endpointType: "token",
        trustScore: Math.min(255, Math.max(0, Math.round(fullResult.trust_score))),
        verdict: fullResult.verdict || "UNKNOWN", trustGrade: fullResult.trust_grade || "N/A",
        proceed: fullResult.verdict !== "UNSAFE" && fullResult.verdict !== "DANGER",
        riskFlags: (fullResult.risk_flags || []).join(","),
        timestamp: Math.floor(Date.now() / 1000), x402PaymentId: 0,
      }, logger).catch(err => logger.error({ err: err.message, target: address }, "Attestation write failed"));
    }
    updateAgentPostResponse(payerWallet, fullResult);
    writeAuditPostResponse(req, { payerWallet, tier, endpoint: "token", target: address, chain, result: fullResult, startTime, dataSources: ["goplus", "defilama"], price: "$0.005" });
  } catch (error) {
    logger.error({ err: error, endpoint: "/verify/token", token: params.token, chain: params.chain }, "Token verification failed");
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
    return res.status(400).json({
      error: "Valid target address required (0x + 40 hex characters)",
      hint: "Send a POST with JSON body containing a 'target' field (the contract you're about to interact with). Optionally include 'token' and 'counterparty' for a more complete check.",
      example: {
        curl: `curl -X POST ${BASE_URL}/preflight -H "Content-Type: application/json" -d '{"target": "${EXAMPLES.protocol}", "token": "${EXAMPLES.token}"}'`,
        body: { target: EXAMPLES.protocol, token: EXAMPLES.token, counterparty: EXAMPLES.counterparty, chain: "base" },
      },
    });
  }
  if (token && !/^0x[a-fA-F0-9]{40}$/.test(token)) {
    return res.status(400).json({ error: "Invalid token address format (must be 0x + 40 hex chars)" });
  }
  if (counterparty && !/^0x[a-fA-F0-9]{40}$/.test(counterparty)) {
    return res.status(400).json({ error: "Invalid counterparty address format (must be 0x + 40 hex chars)" });
  }

  const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";
  const startTime = Date.now();
  const { payerWallet, tier, tierTTLs, skipOfac } = await loadAgentContext(req);

  try {
    // Cache key includes all inputs that affect the result (NOT detail level — that's display only)
    const cacheKey = `sentinel:preflight:${target.toLowerCase()}:${(token || "none").toLowerCase()}:${(counterparty || "none").toLowerCase()}:${chain}`;

    const result = await cachedCall(cacheKey, tierTTLs.preflight, async () => {
      // OPTIMIZATION: Score protocol ONCE, then reuse for position analysis.
      // Previously, scoreProtocol was called twice (directly + inside analyzePosition),
      // duplicating all Etherscan, Alchemy, and DeFiLlama calls. This fix reduces
      // /preflight latency by ~50% on cache misses. — 2026-04-02
      const protocolResult = await scoreProtocol(target, chain).catch(() => null);

      // Run remaining checks in parallel — protocol result is reused by analyzePosition
      const checks = await Promise.allSettled([
        token ? (async () => {
          const [security, market] = await Promise.all([
            getTokenSecurity(token, chain),
            getTokenMarketData(token),
          ]);
          const scored = scoreToken(security, market);
          return { address: token, token_name: security.token_name, token_symbol: security.token_symbol, ...scored };
        })() : Promise.resolve(null),
        counterparty ? scoreCounterparty(counterparty, chain, skipOfac) : Promise.resolve(null),
        analyzePosition(target, counterparty || null, chain, protocolResult),
      ]);

      const [tokenResult, counterpartyResult, positionResult] = checks.map(
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

      // Delegate composite scoring to private engine
      const preflight = computePreflightComposite(components);

      return {
        target,
        token: token || null,
        counterparty: counterparty || null,
        chain,
        verdict: preflight.verdict,
        trust_grade: preflight.grade,
        composite_score: preflight.compositeScore,
        proceed: preflight.proceed,
        proceed_recommendation: preflight.proceedRecommendation,
        checks_summary: {
          protocol: components.protocol.grade,
          token: components.token?.grade || "not_checked",
          counterparty: components.counterparty?.grade || "not_checked",
          position: components.position?.grade || "not_checked",
        },
        risk_flags: preflight.allRiskFlags,
        components,
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
          attestation_enabled: isEASEnabled(),
          agent_tier: tier,
          cache_ttl_applied: tierTTLs.preflight,
          ofac_skipped: skipOfac,
        },
      };
    });

    // Override response_time_ms to reflect actual time (including cache lookup)
    result.meta.response_time_ms = Date.now() - startTime;

    // Apply detail filtering (outside cache — detail is a display preference)
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

    // Post-response attestation write (fire-and-forget)
    if (isEASEnabled() && result.composite_score !== undefined) {
      createVerificationAttestation({
        target,
        chain,
        endpointType: "preflight",
        trustScore: Math.min(255, Math.max(0, Math.round(result.composite_score))),
        verdict: result.verdict || "UNKNOWN",
        trustGrade: result.trust_grade || "N/A",
        proceed: result.proceed !== false,
        riskFlags: (result.risk_flags || []).join(","),
        timestamp: Math.floor(Date.now() / 1000),
        x402PaymentId: 0, // TODO: When x402 Signed Receipts ship (PR #935), extract receipt ID from payment middleware and bind here
      }, logger).catch(err => logger.error({ err: err.message, target }, "Attestation write failed"));
    }
    updateAgentPostResponse(payerWallet, result);
    writeAuditPostResponse(req, { payerWallet, tier, endpoint: "preflight", target, chain, result, startTime, dataSources: ["etherscan", "defilama", "alchemy", "goplus", "ofac"], price: "$0.025" });
  } catch (error) {
    logger.error({ err: error, endpoint: "/preflight", target: params.target, chain: params.chain }, "Preflight check failed");
    res.status(500).json({ error: "Preflight check failed. Please try again later." });
  }
});


// ============================================================
// ATTESTATION LOOKUP (free — encourages agents to check before paying)
// ============================================================

const attestationRateLimit = new Map(); // IP -> { count, resetAt }

app.get("/attestation/:address", async (req, res) => {
  const { address } = req.params;
  const { chain = "base", type } = req.query;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Valid address required (0x + 40 hex characters)" });
  }

  // Simple rate limit: 50 calls per IP per hour
  const ip = req.ip || "unknown";
  const now = Date.now();
  const limit = attestationRateLimit.get(ip);
  if (limit && limit.resetAt > now) {
    if (limit.count >= 50) {
      return res.status(429).json({ error: "Rate limit exceeded (50 calls/hour). Try again later." });
    }
    limit.count++;
  } else {
    attestationRateLimit.set(ip, { count: 1, resetAt: now + 3600000 });
  }

  try {
    const attestations = await getAttestationsByTarget(address);
    const filtered = type
      ? attestations.filter(a => a.endpointType === type)
      : attestations;

    res.json({
      address,
      chain,
      attestations: filtered,
      count: filtered.length,
      meta: { sentinel_version: VERSION },
    });
  } catch (error) {
    logger.error({ err: error, endpoint: "/attestation", address }, "Attestation lookup failed");
    res.status(500).json({ error: "Attestation lookup failed." });
  }
});


// ============================================================
// AGENT REPUTATION (free)
// ============================================================

const agentRateLimit = new Map();

app.get("/agent/:walletAddress", async (req, res) => {
  const { walletAddress } = req.params;

  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: "Valid wallet address required (0x + 40 hex characters)" });
  }

  // Rate limit: 50 calls per IP per hour
  const ip = req.ip || "unknown";
  const now = Date.now();
  const limit = agentRateLimit.get(ip);
  if (limit && limit.resetAt > now) {
    if (limit.count >= 50) {
      return res.status(429).json({ error: "Rate limit exceeded (50 calls/hour)." });
    }
    limit.count++;
  } else {
    agentRateLimit.set(ip, { count: 1, resetAt: now + 3600000 });
  }

  try {
    const profile = await getAgentProfile(walletAddress);
    res.json({
      wallet: profile.wallet,
      tier: profile.tier,
      total_verifications: profile.total_verifications,
      first_seen: profile.first_seen,
      last_verification: profile.last_verification,
      meta: {
        sentinel_version: VERSION,
        erc8004_compatible: false,
      },
    });
  } catch (error) {
    logger.error({ err: error, endpoint: "/agent", wallet: walletAddress }, "Agent profile lookup failed");
    res.status(500).json({ error: "Agent profile lookup failed." });
  }
});


// ============================================================
// MONITORING WATCH MANAGEMENT
// ============================================================

app.post("/watch", async (req, res) => {
  const { target, chain = "base", webhook_url, endpoint_type = "protocol" } = req.body || {};

  if (!target || !/^0x[a-fA-F0-9]{40}$/.test(target)) {
    return res.status(400).json({ error: "Valid target address required" });
  }
  if (!webhook_url || !webhook_url.startsWith("https://")) {
    return res.status(400).json({ error: "Valid HTTPS webhook URL required" });
  }
  if (!["protocol", "token", "counterparty"].includes(endpoint_type)) {
    return res.status(400).json({ error: "endpoint_type must be one of: protocol, token, counterparty" });
  }

  const payerWallet = getPayerWallet(req);
  if (!payerWallet) {
    return res.status(401).json({ error: "Payment required to create a watch subscription" });
  }

  const profile = await getAgentProfile(payerWallet).catch(() => null);
  const tier = profile?.tier || "unknown";
  if (tier === "unknown") {
    return res.status(403).json({
      error: "Watch subscriptions require RECOGNIZED or TRUSTED agent tier. Complete 5+ paid verifications to qualify.",
      current_tier: tier,
      total_verifications: profile?.total_verifications || 0,
      verifications_needed: Math.max(0, 5 - (profile?.total_verifications || 0)),
    });
  }

  const result = await addWatch(target, chain, payerWallet, webhook_url, endpoint_type);
  if (!result.success) {
    return res.status(409).json({ error: result.error });
  }

  res.json({
    watch_id: `${target.toLowerCase()}:${chain}`,
    subscribed: true,
    expires_at: result.expires_at,
    check_interval_hours: 6,
  });
});

app.delete("/watch", async (req, res) => {
  const { target, chain = "base" } = req.body || {};

  if (!target || !/^0x[a-fA-F0-9]{40}$/.test(target)) {
    return res.status(400).json({ error: "Valid target address required" });
  }

  const payerWallet = getPayerWallet(req);
  if (!payerWallet) {
    return res.status(401).json({ error: "Wallet address required" });
  }

  await removeWatch(target, chain, payerWallet);
  res.json({ success: true, unsubscribed: true });
});

app.get("/watch", async (req, res) => {
  const payerWallet = getPayerWallet(req);
  if (!payerWallet) {
    return res.status(401).json({ error: "Wallet address required" });
  }

  const watches = await getWatchesForAgent(payerWallet);
  res.json({ watches, count: watches.length });
});


// ============================================================
// ADMIN COMPLIANCE ENDPOINTS
// ============================================================

app.get("/admin/audit", async (req, res) => {
  if (!SENTINEL_ADMIN_KEY || req.headers.authorization !== `Bearer ${SENTINEL_ADMIN_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await getAuditHistory({
      agent_wallet: req.query.agent,
      target_address: req.query.target,
      verdict: req.query.verdict,
      endpoint: req.query.endpoint,
      from: req.query.from,
      to: req.query.to,
      limit: parseInt(req.query.limit || "50", 10),
      offset: parseInt(req.query.offset || "0", 10),
    });

    res.json({
      records: result.records,
      total: result.total,
      filters_applied: { agent: req.query.agent, target: req.query.target, verdict: req.query.verdict, endpoint: req.query.endpoint, from: req.query.from, to: req.query.to },
      meta: { sentinel_version: VERSION },
    });
  } catch (error) {
    logger.error({ err: error, endpoint: "/admin/audit" }, "Audit query failed");
    res.status(500).json({ error: "Audit query failed" });
  }
});

app.get("/admin/audit/summary", async (req, res) => {
  if (!SENTINEL_ADMIN_KEY || req.headers.authorization !== `Bearer ${SENTINEL_ADMIN_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const period = req.query.period || "30d";
    const summary = await getAuditSummary(period);
    res.json({ ...summary, meta: { sentinel_version: VERSION } });
  } catch (error) {
    logger.error({ err: error, endpoint: "/admin/audit/summary" }, "Audit summary failed");
    res.status(500).json({ error: "Audit summary failed" });
  }
});


// ============================================================
// HEALTH & DISCOVERY (free)
// ============================================================

// Root — human & agent-friendly service overview
app.get("/", (req, res) => {
  // Return JSON only when explicitly requested (e.g. curl with Accept: application/json)
  // Default to HTML so scrapers/crawlers (x402scan) see <title> and <meta> tags
  const accepts = req.headers.accept || "";
  if (accepts.includes("application/json") && !accepts.includes("text/html")) {
    // Skip to JSON response below
  } else {
    return res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sentinel — The Trust Layer for Autonomous Agents</title>
  <meta name="title" content="Sentinel — The Trust Layer for Autonomous Agents">
  <meta name="description" content="Trust infrastructure for autonomous AI agents on Base. Verify protocols, tokens, positions, and counterparties with on-chain EAS attestations. 25 free calls/day, then pay per query in USDC via x402.">
  <meta property="og:title" content="Sentinel — The Trust Layer for Autonomous Agents">
  <meta property="og:description" content="Trust infrastructure for autonomous AI agents on Base. Verify protocols, tokens, positions, and counterparties with on-chain EAS attestations. 25 free calls/day, then pay per query in USDC via x402.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${BASE_URL}">
</head>
<body>
  <h1>Sentinel</h1>
  <p>The Trust Layer for Autonomous Agents</p>
  <p>Trust infrastructure for autonomous AI agents on Base. Every verification creates an on-chain EAS attestation.</p>
  <p>API Docs: <a href="/openapi.json">/openapi.json</a> | Health: <a href="/health">/health</a></p>
</body>
</html>`);
  }

  // Return JSON for API clients / agents
  res.json({
    service: "Sentinel",
    tagline: "The Trust Layer for Autonomous Agents",
    description: "Sentinel is the trust infrastructure for autonomous AI agents on Base. Every verification is recorded as an on-chain EAS attestation, building a permanent trust record. Returning agents earn reputation tiers for faster, cheaper service. Subscribe to monitoring webhooks for proactive risk alerts.",
    version: VERSION,
    network: NETWORK,
    base_url: `https://sentinel-awms.onrender.com`,
    free_tier: {
      calls_per_day: 25,
      description: "25 free verification calls per day — no wallet, no payment, no signup. Just POST JSON to any /verify/* endpoint. Free tier resets daily. After 25 calls, x402 USDC payment kicks in.",
      how_to_use: "Send a POST request with a JSON body to any verification endpoint. The first 25 calls per day are free — no x402 payment required. Check X-FreeTier-Remaining response header for your remaining quota.",
    },
    payment_protocol: "x402 (HTTP 402 Payment Required) — only after free tier exhausted",
    payment_token: "USDC on Base",
    features: {
      free_tier: "25 free calls/day per IP — try every endpoint with zero friction, no wallet needed",
      verification: "5 endpoints covering protocol trust, token safety, counterparty screening, position risk, and unified preflight checks",
      attestations: "Every verification produces a permanent EAS attestation on Base — queryable by any agent",
      reputation: "Agent reputation tiers (Unknown → Recognized → Trusted) with progressive speed and cost benefits",
      monitoring: "Subscribe to webhook alerts when a verified target's risk profile changes",
      compliance: "Full audit trail of every verification for regulatory and analytics purposes",
    },
    documentation: {
      openapi: "/openapi.json",
      health: "/health",
      integration_guide: "https://github.com/nbsickler-ux/Sentinel/blob/main/INTEGRATION.md",
    },
    endpoints: {
      verification: [
        { path: "POST /verify/protocol",     price: "$0.008 USDC (free tier: 25/day)", description: "Is this smart contract trustworthy? Checks audit status, TVL, age, and open-source verification.", try_it: `curl -X POST ${BASE_URL}/verify/protocol -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.protocol}"}'` },
        { path: "POST /verify/token",         price: "$0.005 USDC (free tier: 25/day)", description: "Is this token legitimate? Detects honeypots, fake tokens, tax manipulation, and rugpull patterns.", try_it: `curl -X POST ${BASE_URL}/verify/token -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.token}"}'` },
        { path: "POST /verify/position",      price: "$0.005 USDC (free tier: 25/day)", description: "Is this DeFi position safe? Analyzes liquidity depth, IL risk, concentration, and utilization.", try_it: `curl -X POST ${BASE_URL}/verify/position -H "Content-Type: application/json" -d '{"protocol": "${EXAMPLES.position}"}'` },
        { path: "POST /verify/counterparty",  price: "$0.010 USDC (free tier: 25/day)", description: "Is this wallet safe to interact with? Checks OFAC sanctions, contract verification, and activity patterns.", try_it: `curl -X POST ${BASE_URL}/verify/counterparty -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.counterparty}"}'` },
        { path: "POST /preflight",            price: "$0.025 USDC (free tier: 25/day)", description: "Should I execute this transaction? Runs all checks in parallel, returns a single go/no-go recommendation.", try_it: `curl -X POST ${BASE_URL}/preflight -H "Content-Type: application/json" -d '{"target": "${EXAMPLES.protocol}", "token": "${EXAMPLES.token}"}'` },
      ],
      free_always: [
        { path: "GET /attestation/:address",  description: "Look up existing Sentinel attestations for any address — see if it's been verified before paying." },
        { path: "GET /agent/:wallet",          description: "Check an agent's reputation tier, verification history, and trust standing." },
        { path: "POST /watch",                price: "$0.05 USDC", description: "Subscribe to monitoring — get webhook alerts when a target's risk changes." },
      ],
    },
    trust_verdicts: ["SAFE", "MODERATE", "CAUTION", "DANGER"],
    grades: ["A+", "A", "B+", "B", "C+", "C", "D", "F"],
    quick_start: {
      step_1: "Send a POST request with JSON body to any /verify/* endpoint — first 25 calls/day are FREE",
      step_2: "Receive trust verification result immediately (no payment needed for free tier)",
      step_3: "Check X-FreeTier-Remaining header to see how many free calls you have left",
      step_4: "After 25 calls, you'll receive HTTP 402 — sign a USDC payment on Base via x402 to continue",
      step_5: "Every verification creates a permanent on-chain EAS attestation automatically",
      example: 'curl -X POST https://sentinel-awms.onrender.com/verify/token -H "Content-Type: application/json" -d \'{"address": "0x532f27101965dd16442E59d40670FaF5eBB142E4", "chain": "base"}\'',
    },
  });
});

// /.well-known/x402 — discovery document for x402scan and agent frameworks
app.get("/.well-known/x402", (req, res) => {
  res.json({
    version: 1,
    name: "Sentinel — The Trust Layer for Autonomous Agents",
    title: "Sentinel — The Trust Layer for Autonomous Agents",
    description: "Trust infrastructure for autonomous AI agents on Base. Verify protocols, tokens, positions, and counterparties with on-chain EAS attestations. 25 free calls/day, then pay per query in USDC via x402.",
    tags: ["Crypto", "Security", "DeFi", "AI Agents", "Verification"],
    openapi: `${BASE_URL}/openapi.json`,
    resources: [
      `${BASE_URL}/verify/protocol`,
      `${BASE_URL}/verify/token`,
      `${BASE_URL}/verify/position`,
      `${BASE_URL}/verify/counterparty`,
      `${BASE_URL}/preflight`,
      `${BASE_URL}/attestation`,
      `${BASE_URL}/agent`,
      `${BASE_URL}/watch`,
    ],
    instructions: [
      "# Sentinel API",
      "Trust infrastructure for AI agents on Base. Every verification creates an on-chain EAS attestation. Returning agents earn reputation tiers for faster service.",
      "",
      "## FREE TIER — Try Sentinel with zero friction",
      "Every verification endpoint includes 25 free calls per day. No wallet, no payment, no signup required.",
      "Just send a POST request with a JSON body — the first 25 calls per day are completely free.",
      "Check the X-FreeTier-Remaining response header for your remaining daily quota.",
      "After 25 calls, x402 USDC payment kicks in automatically.",
      "",
      "## Verification Endpoints",
      "All accept POST with JSON body. First 25 calls/day are free, then x402 payment on Base (eip155:8453) in USDC.",
      "",
      "## POST /verify/protocol",
      `Assess smart contract trustworthiness. Input: { "address": "0x..." (required), "chain": "base", "detail": "full" }. Price: free (25/day) then $0.008 USDC.`,
      `Example: curl -X POST ${BASE_URL}/verify/protocol -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.protocol}"}'`,
      "",
      "## POST /verify/token",
      `Check token legitimacy and safety. Input: { "address": "0x..." (required), "chain": "base", "detail": "full" }. Price: free (25/day) then $0.005 USDC.`,
      `Example: curl -X POST ${BASE_URL}/verify/token -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.token}"}'`,
      "",
      "## POST /verify/position",
      `Analyze DeFi position risk. Input: { "protocol": "0x..." (required), "chain": "base", "detail": "full" }. Price: free (25/day) then $0.005 USDC.`,
      `Example: curl -X POST ${BASE_URL}/verify/position -H "Content-Type: application/json" -d '{"protocol": "${EXAMPLES.position}"}'`,
      "",
      "## POST /verify/counterparty",
      `Assess counterparty wallet safety. Input: { "address": "0x..." (required), "chain": "base", "detail": "full" }. Price: free (25/day) then $0.010 USDC.`,
      `Example: curl -X POST ${BASE_URL}/verify/counterparty -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.counterparty}"}'`,
      "",
      "## POST /preflight",
      `Unified pre-transaction safety check. Input: { "target": "0x..." (required), "token": "0x..." (optional), "counterparty": "0x..." (optional), "chain": "base", "detail": "full" }. Price: free (25/day) then $0.025 USDC.`,
      `Example: curl -X POST ${BASE_URL}/preflight -H "Content-Type: application/json" -d '{"target": "${EXAMPLES.protocol}", "token": "${EXAMPLES.token}"}'`,
      "",
      "## Always-Free Endpoints",
      "",
      "## GET /attestation/:address",
      "Look up existing Sentinel attestations for an address. Check before paying for a fresh verification.",
      "",
      "## GET /agent/:wallet",
      "Check an agent's reputation tier and verification history.",
      "",
      "## POST /watch",
      "Subscribe to monitoring webhooks for risk change alerts. Price: $0.05 USDC. Requires Recognized+ reputation tier.",
    ].join("\n"),
  });
});

// OpenAPI 3.1 spec — machine-readable API contract for agent frameworks
app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: "Sentinel — The Trust Layer for Autonomous Agents",
      description: "Trust infrastructure for autonomous AI agents on Base. FREE TIER: 25 verification calls per day — no payment, no wallet, no signup. Just POST JSON to any /verify/* endpoint. After 25 calls/day, pay per query in USDC via x402. Every verification creates a permanent on-chain EAS attestation. Returning agents earn reputation tiers for faster service.",
      version: VERSION,
      contact: { name: "Sentinel", url: "https://github.com/nbsickler-ux/Sentinel" },
      "x-payment-protocol": "x402",
      "x-payment-token": "USDC",
      "x-payment-network": "Base (eip155:8453)",
      "x-free-tier": "25 calls/day per IP — no payment required. Check X-FreeTier-Remaining response header.",
      "x-guidance": "Sentinel is trust infrastructure for autonomous AI agents on Base. FREE TIER: All /verify/* and /preflight endpoints allow 25 free calls per day with no payment required — just send a POST with a JSON body. After the free quota, x402 USDC payment is required. Always-free endpoints: GET /attestation/:address (check existing trust records), GET /agent/:wallet (reputation lookup), GET /, GET /health, GET /openapi.json. Every verification creates an on-chain EAS attestation. Returning agents earn reputation tiers for faster service.",
    },
    servers: [{ url: "https://sentinel-awms.onrender.com", description: "Production (Base mainnet)" }],
    paths: {
      "/verify/protocol": {
        post: {
          operationId: "verifyProtocol",
          summary: "Assess smart contract trustworthiness",
          description: "Evaluates a smart contract's audit status, TVL, on-chain age, open-source verification, and protocol registry presence. Returns a composite trust score with verdict and grade.",
          tags: ["Verification"],
          "x-payment-info": { price: { mode: "fixed", currency: "USDC", amount: "0.008" }, protocols: [{ "x402": {} }] },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["address"],
                  properties: {
                    address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Contract address to verify", example: EXAMPLES.protocol },
                    chain: { type: "string", default: "base", description: "Chain identifier", example: "base" },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
                example: { address: EXAMPLES.protocol, chain: "base" },
              },
            },
          },
          responses: {
            "200": { description: "Trust verification result with score, verdict, grade, and evidence" },
            "402": { description: "Payment required — x402 payment details in response headers" },
            "400": { description: "Invalid address format — response includes a working example" },
            "405": { description: "Wrong HTTP method — use POST, not GET" },
          },
          "x-curl-example": `curl -X POST ${BASE_URL}/verify/protocol -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.protocol}"}'`,
        },
      },
      "/verify/token": {
        post: {
          operationId: "verifyToken",
          summary: "Check token legitimacy and safety",
          description: "Detects honeypots, fake tokens, tax manipulation, rugpull patterns, and ownership risks. Uses GoPlus Security API for comprehensive token analysis.",
          tags: ["Verification"],
          "x-payment-info": { price: { mode: "fixed", currency: "USDC", amount: "0.005" }, protocols: [{ "x402": {} }] },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["address"],
                  properties: {
                    address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Token contract address", example: EXAMPLES.token },
                    chain: { type: "string", default: "base", description: "Chain identifier", example: "base" },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
                example: { address: EXAMPLES.token, chain: "base" },
              },
            },
          },
          responses: {
            "200": { description: "Token safety result with honeypot detection, tax analysis, and risk flags" },
            "402": { description: "Payment required" },
            "400": { description: "Invalid address format — response includes a working example" },
            "405": { description: "Wrong HTTP method — use POST, not GET" },
          },
          "x-curl-example": `curl -X POST ${BASE_URL}/verify/token -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.token}"}'`,
        },
      },
      "/verify/position": {
        post: {
          operationId: "verifyPosition",
          summary: "Analyze DeFi position risk",
          description: "Evaluates liquidity depth, impermanent loss risk, pool concentration, and utilization rate for DeFi positions.",
          tags: ["Verification"],
          "x-payment-info": { price: { mode: "fixed", currency: "USDC", amount: "0.005" }, protocols: [{ "x402": {} }] },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["protocol"],
                  properties: {
                    protocol: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Pool or vault contract address", example: EXAMPLES.position },
                    user: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "User wallet address (optional, for user-specific position analysis)" },
                    chain: { type: "string", default: "base", description: "Chain identifier", example: "base" },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
                example: { protocol: EXAMPLES.position, chain: "base" },
              },
            },
          },
          responses: {
            "200": { description: "Position risk analysis with liquidity and concentration metrics" },
            "402": { description: "Payment required" },
            "400": { description: "Invalid address format — response includes a working example" },
            "405": { description: "Wrong HTTP method — use POST, not GET" },
          },
          "x-curl-example": `curl -X POST ${BASE_URL}/verify/position -H "Content-Type: application/json" -d '{"protocol": "${EXAMPLES.position}"}'`,
        },
      },
      "/verify/counterparty": {
        post: {
          operationId: "verifyCounterparty",
          summary: "Assess counterparty wallet safety",
          description: "Checks OFAC sanctions list, contract verification status, wallet age, transaction patterns, and activity signals. OFAC hits are hard blockers that override all other scores.",
          tags: ["Verification"],
          "x-payment-info": { price: { mode: "fixed", currency: "USDC", amount: "0.010" }, protocols: [{ "x402": {} }] },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["address"],
                  properties: {
                    address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Wallet or contract address", example: EXAMPLES.counterparty },
                    chain: { type: "string", default: "base", description: "Chain identifier", example: "base" },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
                example: { address: EXAMPLES.counterparty, chain: "base" },
              },
            },
          },
          responses: {
            "200": { description: "Counterparty intelligence with sanctions check and activity analysis" },
            "402": { description: "Payment required" },
            "400": { description: "Invalid address format — response includes a working example" },
            "405": { description: "Wrong HTTP method — use POST, not GET" },
          },
          "x-curl-example": `curl -X POST ${BASE_URL}/verify/counterparty -H "Content-Type: application/json" -d '{"address": "${EXAMPLES.counterparty}"}'`,
        },
      },
      "/preflight": {
        post: {
          operationId: "preflight",
          summary: "Unified pre-transaction safety check",
          description: "Runs protocol, token, position, and counterparty checks in parallel. Computes a weighted composite score (protocol 35%, position 25%, token 20%, counterparty 20%) with dynamic normalization for missing checks. OFAC sanctions and honeypot detections are hard blockers. Returns a single proceed/do-not-proceed recommendation.",
          tags: ["Verification"],
          "x-payment-info": { price: { mode: "fixed", currency: "USDC", amount: "0.025" }, protocols: [{ "x402": {} }] },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["target"],
                  properties: {
                    target: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Target contract address for the transaction", example: EXAMPLES.protocol },
                    chain: { type: "string", default: "base", description: "Chain identifier", example: "base" },
                    token: { type: "string", description: "Token address involved (optional)", example: EXAMPLES.token },
                    counterparty: { type: "string", description: "Counterparty wallet address (optional)", example: EXAMPLES.counterparty },
                    detail: { type: "string", enum: ["full", "standard", "minimal"], default: "full", description: "Response detail level" },
                  },
                },
                example: { target: EXAMPLES.protocol, token: EXAMPLES.token, counterparty: EXAMPLES.counterparty, chain: "base" },
              },
            },
          },
          responses: {
            "200": { description: "Composite safety analysis with proceed recommendation, individual component scores, and hard-blocker flags" },
            "402": { description: "Payment required" },
            "400": { description: "Invalid target address — response includes a working example" },
            "405": { description: "Wrong HTTP method — use POST, not GET" },
          },
          "x-curl-example": `curl -X POST ${BASE_URL}/preflight -H "Content-Type: application/json" -d '{"target": "${EXAMPLES.protocol}", "token": "${EXAMPLES.token}"}'`,
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
    attestation_enabled: isEASEnabled(),
    registry_loaded: registryLoaded,
    registry_size: Object.keys(protocolRegistry).length,
    registry_last_refreshed: registryLastRefreshed,
    capabilities: {
      attestations: isEASEnabled() ? "enabled" : "disabled (awaiting schema deployment)",
      reputation_tiers: redis ? "enabled" : "disabled",
      monitoring: "enabled",
      compliance_audit: "enabled",
    },
    endpoints: {
      "/verify/protocol":     { price: "$0.008 USDC", status: "live", cache_ttl: "10 min (tier-adjusted)", description: "Protocol trust verification" },
      "/verify/position":     { price: "$0.005 USDC", status: "live", cache_ttl: "5 min (tier-adjusted)",  description: "Position risk analysis" },
      "/verify/counterparty": { price: "$0.010 USDC", status: "live", cache_ttl: "15 min (tier-adjusted)", description: "Counterparty intelligence" },
      "/verify/token":        { price: "$0.005 USDC", status: "live", cache_ttl: "5 min (tier-adjusted)",  description: "Token legitimacy check" },
      "/preflight":           { price: "$0.025 USDC", status: "live", cache_ttl: "5-15 min (tier-adjusted)", description: "Unified pre-transaction safety" },
      "/attestation/:address": { price: "free", status: "live", description: "Look up existing trust attestations" },
      "/agent/:wallet":        { price: "free", status: "live", description: "Check agent reputation tier" },
      "/watch":                { price: "$0.05 USDC", status: "live", description: "Subscribe to monitoring webhooks" },
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
      logger.error({ err: error, endpoint: "/test/protocol", address, chain }, "Test protocol verification failed");
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
      logger.error({ err: error, endpoint: "/test/token", token: address, chain }, "Test token verification failed");
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
      logger.error({ err: error, endpoint: "/test/position", protocol: protocolAddress, chain }, "Test position analysis failed");
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
      logger.error({ err: error, endpoint: "/test/counterparty", address, chain }, "Test counterparty verification failed");
      res.status(500).json({ error: "Counterparty verification failed. Please try again later." });
    }
  });

  app.get("/test/preflight", async (req, res) => {
    const { target, token, counterparty, chain = "base", detail = "full" } = req.query;
    if (!target || !/^0x[a-fA-F0-9]{40}$/.test(target)) {
      return res.status(400).json({ error: "Valid target address required (?target=0x...)" });
    }
    try {
      // Score protocol once, reuse for position analysis (same optimization as production /preflight)
      const protocolResult = await scoreProtocol(target, chain).catch(() => null);
      const checks = await Promise.allSettled([
        token ? (async () => {
          const [security, market] = await Promise.all([getTokenSecurity(token, chain), getTokenMarketData(token)]);
          const scored = scoreToken(security, market);
          return { address: token, token_name: security.token_name, token_symbol: security.token_symbol, ...scored };
        })() : Promise.resolve(null),
        counterparty ? scoreCounterparty(counterparty, chain) : Promise.resolve(null),
        analyzePosition(target, counterparty || null, chain, protocolResult),
      ]);
      const [tokenResult, counterpartyResult, positionResult] = checks.map(r => r.status === "fulfilled" ? r.value : null);

      const components = {
        protocol: protocolResult ? { verdict: protocolResult.verdict, grade: protocolResult.trust_grade, score: protocolResult.trust_score, risk_flags: protocolResult.risk_flags } : { verdict: "ERROR", grade: "N/A", score: null, risk_flags: ["Protocol check failed"] },
        token: tokenResult ? { verdict: tokenResult.verdict, grade: tokenResult.trust_grade, score: tokenResult.trust_score, name: tokenResult.token_name, symbol: tokenResult.token_symbol, risk_flags: tokenResult.risk_flags } : null,
        counterparty: counterpartyResult ? { verdict: counterpartyResult.verdict, grade: counterpartyResult.trust_grade, score: counterpartyResult.trust_score, risk_flags: counterpartyResult.risk_flags } : null,
        position: positionResult ? { verdict: positionResult.verdict, grade: positionResult.trust_grade, score: positionResult.trust_score, risk_flags: positionResult.risk_flags, recommendations: positionResult.recommendations } : null,
      };

      // Delegate composite scoring to private engine
      const preflight = computePreflightComposite(components);

      const result = {
        target, token: token || null, counterparty: counterparty || null, chain,
        verdict: preflight.verdict, trust_grade: preflight.grade, composite_score: preflight.compositeScore, proceed: preflight.proceed,
        proceed_recommendation: preflight.proceedRecommendation,
        checks_summary: { protocol: components.protocol.grade, token: components.token?.grade || "not_checked", counterparty: components.counterparty?.grade || "not_checked", position: components.position?.grade || "not_checked" },
        risk_flags: preflight.allRiskFlags, components, recommendations: positionResult?.recommendations || [],
        meta: { response_time_ms: Date.now() - startTime, data_freshness: new Date().toISOString(), sentinel_version: VERSION, checks_run: ["protocol", token ? "token" : null, counterparty ? "counterparty" : null, "position"].filter(Boolean) },
      };
      const detailLevel = DETAIL_LEVELS.includes(detail) ? detail : "full";
      if (detailLevel === "minimal") { res.json({ target: result.target, chain: result.chain, verdict: result.verdict, trust_grade: result.trust_grade, composite_score: result.composite_score, proceed: result.proceed, proceed_recommendation: result.proceed_recommendation, checks_summary: result.checks_summary, meta: result.meta }); }
      else if (detailLevel === "standard") { const { components: _c, ...rest } = result; res.json(rest); }
      else { res.json(result); }
    } catch (error) {
      logger.error({ err: error, endpoint: "/test/preflight", target, chain }, "Test preflight check failed");
      res.status(500).json({ error: "Preflight check failed. Please try again later." });
    }
  });

  logger.info({ testRoutes: ["/test/protocol", "/test/token", "/test/position", "/test/counterparty", "/test/preflight"] }, "DEV Test routes enabled");
}


// ============================================================
// START
// ============================================================
app.listen(PORT, async () => {
  const facType = (CDP_API_KEY_ID && CDP_API_KEY_SECRET) ? "CDP (Coinbase)" : "x402.org";
  logger.info({
    version: VERSION,
    network: NETWORK,
    facilitator: facType,
    port: PORT,
    cache: redis ? "enabled" : "disabled",
    service: "sentinel",
  }, "SENTINEL server started — The Trust Layer for Autonomous Agents");

  // Initialize EAS attestation layer (non-blocking)
  try {
    await initEAS(logger);
  } catch (e) {
    logger.warn({ module: "eas", err: e.message }, "EAS initialization failed — attestations disabled");
  }

  // Initialize agent reputation store
  if (redis) {
    initReputationStore(redis, logger);
    logger.info({ module: "reputation" }, "Agent reputation store initialized");

    initWatchlist(redis, logger);
    logger.info({ module: "monitoring" }, "Watchlist initialized");
  }

  // Initialize Postgres for request logging (non-fatal if unavailable)
  // MUST happen before audit log init which depends on dbPool
  const DATABASE_URL = process.env.DATABASE_URL || "";
  const dbPool = initPool(DATABASE_URL, logger);
  if (dbPool) {
    try {
      await runMigrations(logger);
      logger.info({ module: "db" }, "Request logging enabled (Postgres)");
    } catch (e) {
      logger.warn({ module: "db", err: e.message }, "Postgres migration failed — request logging disabled");
    }
  }

  // Initialize monitoring scanner
  initScanner({ logger, scoreProtocol, scoreCounterparty, VERSION });
  startScanner();

  // Initialize audit log (uses Postgres pool from above)
  if (dbPool) {
    initAuditLog(dbPool, logger);
    logger.info({ module: "compliance" }, "Audit log initialized");

    // Daily report generator (runs once per day)
    setInterval(() => {
      generateDailyReport().then(summary => {
        if (summary) logger.info({ module: "compliance", ...summary }, "Daily report generated");
      }).catch(() => {});
    }, 24 * 60 * 60 * 1000);
  }

  // Refresh protocol registry every 24 hours
  const REGISTRY_REFRESH_MS = 24 * 60 * 60 * 1000;
  setInterval(refreshProtocolRegistry, REGISTRY_REFRESH_MS);
  logger.info({ intervalHours: 24 }, "Protocol registry auto-refresh scheduled");
});

// ============================================================
// EXPORTS FOR TESTING
// ============================================================
// Re-export scoring functions from lib + server-specific functions
export {
  scoreProtocol,
  scoreToken,
  scoreCounterparty,
  gradeFromScore,
  filterResponse,
  checkSanctions,
  checkExploitAssociation,
  app,
};
