// ============================================================
// SENTINEL — Request Logger Middleware
// Non-blocking, fail-silent middleware that logs every paid
// and discovery request to Postgres via lib/db.js.
// ============================================================

import { logRequest } from "./db.js";
import axios from "axios";

// Price lookup: endpoint path → USDC amount (matches PRICE map in server.js)
const ENDPOINT_PRICE = {
  "/verify/protocol":     0.008,
  "/verify/position":     0.005,
  "/verify/counterparty": 0.01,
  "/verify/token":        0.005,
  "/preflight":           0.025,
};

// Discovery endpoints — free, logged with verdict "discovery"
const DISCOVERY_PATHS = new Set(["/.well-known/x402", "/openapi.json"]);

// In-memory cache for isContract lookups (wallet → boolean)
// Avoids repeated RPC calls for the same wallet within a session
const contractCache = new Map();

/**
 * Check if an address is a contract using Alchemy eth_getCode.
 * Returns null if Alchemy is not configured or the call fails.
 */
async function checkIsContract(address, alchemyApiKey) {
  if (!alchemyApiKey || !address || address === "anonymous") return null;

  const lower = address.toLowerCase();
  if (contractCache.has(lower)) return contractCache.get(lower);

  try {
    const rpcUrl = `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
    const res = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      method: "eth_getCode",
      params: [lower, "latest"],
      id: 1,
    }, { timeout: 3000 });

    const isContract = res.data.result && res.data.result !== "0x";
    contractCache.set(lower, isContract);
    return isContract;
  } catch {
    return null;
  }
}

/**
 * Creates Express middleware that logs requests to the request_log table.
 * Hooks into res.json() to capture the verdict from the response body,
 * then writes the log entry asynchronously (non-blocking).
 *
 * @param {object} opts
 * @param {string} opts.alchemyApiKey - Alchemy API key for contract detection
 * @param {string} opts.network - Network name (e.g. "base", "base-sepolia")
 */
export function createRequestLogger({ alchemyApiKey, network }) {
  const chainId = network === "base" ? 8453 : 84532;

  return function requestLoggerMiddleware(req, res, next) {
    const startTime = Date.now();
    const endpoint = req.path;

    // Only log paid endpoints and discovery endpoints
    const isPaid = ENDPOINT_PRICE[endpoint] !== undefined;
    const isDiscovery = DISCOVERY_PATHS.has(endpoint);
    if (!isPaid && !isDiscovery) return next();

    // Extract caller wallet from x402 payment header
    const callerWallet = (req.headers["x-payer-address"] || req.ip || "anonymous").toLowerCase();

    // For discovery endpoints, log immediately (no response body to capture)
    if (isDiscovery) {
      const responseTimeMs = Date.now() - startTime;
      // Fire-and-forget: classify wallet in background, then log
      checkIsContract(callerWallet, alchemyApiKey).then((isContract) => {
        logRequest({
          callerWallet,
          endpoint,
          method: req.method,
          chainId,
          isContract,
          paymentAmount: null,
          paymentCurrency: null,
          verdict: "discovery",
          responseTimeMs,
        });
      }).catch(() => {});
      return next();
    }

    // For paid endpoints, intercept res.json() to capture the verdict
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      // Restore original before calling it
      res.json = originalJson;

      const responseTimeMs = Date.now() - startTime;
      const verdict = body?.verdict || body?.error || null;

      // Fire-and-forget: classify wallet in background, then log
      checkIsContract(callerWallet, alchemyApiKey).then((isContract) => {
        logRequest({
          callerWallet,
          endpoint,
          method: req.method,
          chainId,
          isContract,
          paymentAmount: ENDPOINT_PRICE[endpoint] || null,
          paymentCurrency: "USDC",
          verdict: typeof verdict === "string" ? verdict.substring(0, 50) : null,
          responseTimeMs,
        });
      }).catch(() => {});

      return originalJson(body);
    };

    next();
  };
}
