// ============================================================
// SENTINEL VERIFICATION CLIENT
// Calls Sentinel's verify endpoints before executing trades.
// Fails safe (blocks trade) if Sentinel is unreachable.
// ============================================================

import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const AERODROME_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (config.sentinel.bypassSecret) {
    headers["x-bypass-secret"] = config.sentinel.bypassSecret;
  }
  return headers;
}

async function callEndpoint(path, body) {
  const url = `${config.sentinel.url}${path}`;
  const res = await axios.post(url, body, {
    headers: buildHeaders(),
    timeout: config.sentinel.timeoutMs,
  });
  return res.data;
}

/**
 * Verify a trade decision through Sentinel's risk endpoints.
 *
 * @param {Object} decision - Decision object from decision.js
 * @returns {Object} { approved, verdict, reason?, details }
 */
export async function verifyTrade(decision) {
  // Mock mode for testing without Sentinel running
  if (process.env.SENTINEL_MOCK === "true") {
    logger.warn({ module: "sentinel" }, "SENTINEL_MOCK=true — returning mock SAFE verdict");
    return { approved: true, verdict: "SAFE", reason: "MOCK", details: { mock: true } };
  }

  const results = {};

  try {
    // 1. Verify token_in
    results.token_in = await callEndpoint("/verify/token", {
      address: decision.token_in,
      chain: decision.chain,
    });

    // 2. Verify token_out
    results.token_out = await callEndpoint("/verify/token", {
      address: decision.token_out,
      chain: decision.chain,
    });

    // 3. Verify protocol (Aerodrome router)
    results.protocol = await callEndpoint("/verify/protocol", {
      address: decision.target_contract,
      chain: decision.chain,
    });

    // 4. Preflight check (Sentinel expects: target, token, counterparty, chain)
    results.preflight = await callEndpoint("/preflight", {
      target: decision.target_contract,
      token: decision.token_in,
      chain: decision.chain,
    });
  } catch (e) {
    logger.warn({ module: "sentinel", err: e.message }, "Sentinel unreachable — blocking trade (fail-safe)");
    return {
      approved: false,
      reason: "SENTINEL_UNREACHABLE",
      verdict: null,
      details: { error: e.message },
    };
  }

  // Evaluate verdicts
  const allVerdicts = Object.entries(results).map(([key, res]) => ({
    endpoint: key,
    verdict: res.verdict,
    trust_score: res.trust_score,
    risk_flags: res.risk_flags || [],
  }));

  const hasDanger = allVerdicts.some((v) => v.verdict === "DANGER");
  const hasHighRisk = allVerdicts.some((v) => v.verdict === "HIGH_RISK");
  const hasCaution = allVerdicts.some((v) => v.verdict === "CAUTION");

  if (hasDanger) {
    return { approved: false, reason: "DANGER_BLOCK", verdict: "DANGER", details: { checks: allVerdicts } };
  }
  if (hasHighRisk) {
    return { approved: false, reason: "HIGH_RISK_FLAG", verdict: "HIGH_RISK", details: { checks: allVerdicts } };
  }
  if (hasCaution) {
    return { approved: true, verdict: "CAUTION", details: { checks: allVerdicts } };
  }

  return { approved: true, verdict: "SAFE", details: { checks: allVerdicts } };
}
