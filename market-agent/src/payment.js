// ============================================================
// x402 PAYMENT MIDDLEWARE
// Wraps Market Agent's paid endpoints with micropayments.
// Same pattern as Sentinel's payment setup.
// ============================================================

import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import logger from "./logger.js";

const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "";
const NETWORK = process.env.NETWORK || "base-sepolia";
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID || "";
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET || "";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";

const NETWORK_ID = {
  "base-sepolia": "eip155:84532",
  "base": "eip155:8453",
};

// Paths that require payment
export const PAID_PATHS = ["/briefing", "/briefings", "/signals"];

// Payment routes configuration
const paymentRoutes = {
  "GET /briefing": {
    accepts: {
      scheme: "exact",
      price: "$0.01",
      network: NETWORK_ID[NETWORK] || "eip155:84532",
      payTo: WALLET_ADDRESS,
    },
    description: "Latest market intelligence briefing with trade ideas, regime analysis, and signal conflicts.",
  },
  "GET /briefings": {
    accepts: {
      scheme: "exact",
      price: "$0.03",
      network: NETWORK_ID[NETWORK] || "eip155:84532",
      payTo: WALLET_ADDRESS,
    },
    description: "Historical market briefings with trend analysis over time.",
  },
  "GET /signals": {
    accepts: {
      scheme: "exact",
      price: "$0.02",
      network: NETWORK_ID[NETWORK] || "eip155:84532",
      payTo: WALLET_ADDRESS,
    },
    description: "Raw signal data: trend, reversion, volatility, and composite scores.",
  },
};

// Set up facilitator
const facilitator = (CDP_API_KEY_ID && CDP_API_KEY_SECRET)
  ? new HTTPFacilitatorClient(createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET))
  : new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// EVM schemes for Base Sepolia and Mainnet
const schemes = [
  { network: "eip155:84532", server: new ExactEvmScheme() },
  { network: "eip155:8453", server: new ExactEvmScheme() },
];

/**
 * x402 payment middleware — only active if WALLET_ADDRESS is configured.
 */
export let paymentMiddleware;

if (WALLET_ADDRESS) {
  paymentMiddleware = paymentMiddlewareFromConfig(paymentRoutes, facilitator, schemes);
  logger.info({ module: "payment", network: NETWORK, wallet: WALLET_ADDRESS.slice(0, 10) + "..." }, "x402 payment middleware enabled");
} else {
  // No wallet configured — pass through without payment
  paymentMiddleware = (_req, _res, next) => next();
  logger.warn({ module: "payment" }, "WALLET_ADDRESS not set — payment middleware disabled (all endpoints free)");
}
