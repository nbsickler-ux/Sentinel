// ============================================================
// POLYMARKET CLIENT WRAPPER
// Thin layer over @polymarket/clob-client for market discovery,
// odds monitoring, and order placement.
// ============================================================

import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";

const { gammaUrl, clobUrl, chainId } = config.polymarket;

// ── We use the Gamma API (REST) for market discovery since it doesn't
//    require authentication. CLOB client is for authenticated trading. ──

let clobClient = null;

/**
 * Initialize the CLOB client for authenticated operations (order placement).
 * Call this after wallet and API credentials are set up.
 */
export async function initClobClient() {
  if (!config.polymarket.privateKey) {
    logger.warn({ module: "polymarket" }, "No wallet key — running in read-only mode");
    return null;
  }

  try {
    // Dynamic import because @polymarket/clob-client uses ethers v5
    const { ClobClient } = await import("@polymarket/clob-client");
    const { Wallet } = await import("ethers");

    const wallet = new Wallet(config.polymarket.privateKey);

    // If we have API credentials, use them; otherwise we'll need to generate
    const creds = config.polymarket.apiKey
      ? {
          key: config.polymarket.apiKey,
          secret: config.polymarket.apiSecret,
          passphrase: config.polymarket.apiPassphrase,
        }
      : undefined;

    clobClient = new ClobClient(clobUrl, chainId, wallet, creds);

    // If no creds, derive them (first-time setup)
    if (!creds) {
      logger.info({ module: "polymarket" }, "No API credentials found — deriving new ones...");
      const newCreds = await clobClient.createApiKey();
      logger.info({ module: "polymarket" }, "API credentials created. Add these to .env:");
      logger.info({ module: "polymarket" }, `POLYMARKET_API_KEY=${newCreds.key}`);
      logger.info({ module: "polymarket" }, `POLYMARKET_API_SECRET=${newCreds.secret}`);
      logger.info({ module: "polymarket" }, `POLYMARKET_API_PASSPHRASE=${newCreds.passphrase}`);

      // Reinitialize with new creds
      clobClient = new ClobClient(clobUrl, chainId, wallet, newCreds);
    }

    logger.info({ module: "polymarket" }, "CLOB client initialized — trading enabled");
    return clobClient;
  } catch (err) {
    logger.error({ module: "polymarket", err: err.message }, "Failed to initialize CLOB client");
    return null;
  }
}

// ── MARKET DISCOVERY (Gamma API — unauthenticated) ──

/**
 * Fetch active markets from Gamma API.
 * @param {Object} opts
 * @param {string} [opts.tag] - Filter by tag (e.g., "sports", "nba", "mlb")
 * @param {boolean} [opts.active] - Only active markets (default: true)
 * @param {boolean} [opts.closed] - Include closed markets (default: false)
 * @param {number} [opts.limit] - Max results (default: 100)
 * @param {number} [opts.offset] - Pagination offset
 * @returns {Object[]} Array of market objects
 */
export async function getMarkets(opts = {}) {
  const params = new URLSearchParams();
  if (opts.active !== false) params.set("active", "true");
  if (opts.closed) params.set("closed", "true");
  if (opts.tag) params.set("tag", opts.tag);
  params.set("limit", String(opts.limit || 100));
  if (opts.offset) params.set("offset", String(opts.offset));
  // Sort by volume for the most liquid markets
  params.set("order", "volume24hr");
  params.set("ascending", "false");

  try {
    const resp = await axios.get(`${gammaUrl}/markets?${params.toString()}`, {
      timeout: 10_000,
    });
    const markets = resp.data || [];
    logger.debug({ module: "polymarket", count: markets.length, tag: opts.tag }, "Fetched markets");
    return markets;
  } catch (err) {
    logger.error({ module: "polymarket", err: err.message }, "Failed to fetch markets");
    return [];
  }
}

/**
 * Fetch a single market by condition ID.
 */
export async function getMarket(conditionId) {
  try {
    const resp = await axios.get(`${gammaUrl}/markets/${conditionId}`, { timeout: 10_000 });
    return resp.data;
  } catch (err) {
    logger.error({ module: "polymarket", conditionId, err: err.message }, "Failed to fetch market");
    return null;
  }
}

/**
 * Fetch events (grouped markets) from Gamma API.
 * Events contain multiple related markets (e.g., "NBA Finals" contains individual game markets).
 */
export async function getEvents(opts = {}) {
  const params = new URLSearchParams();
  if (opts.tag) params.set("tag", opts.tag);
  if (opts.active !== false) params.set("active", "true");
  params.set("limit", String(opts.limit || 50));
  params.set("order", "volume24hr");
  params.set("ascending", "false");

  try {
    const resp = await axios.get(`${gammaUrl}/events?${params.toString()}`, { timeout: 10_000 });
    return resp.data || [];
  } catch (err) {
    logger.error({ module: "polymarket", err: err.message }, "Failed to fetch events");
    return [];
  }
}

// ── ODDS MONITORING ──

/**
 * Get current orderbook for a token (YES or NO outcome).
 * Returns best bid/ask and depth.
 */
export async function getOrderbook(tokenId) {
  try {
    const resp = await axios.get(`${clobUrl}/book`, {
      params: { token_id: tokenId },
      timeout: 5_000,
    });
    const book = resp.data;

    const bestBid = book.bids?.[0] ? parseFloat(book.bids[0].price) : null;
    const bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].price) : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    const bidDepth = (book.bids || []).reduce((sum, o) => sum + parseFloat(o.size), 0);
    const askDepth = (book.asks || []).reduce((sum, o) => sum + parseFloat(o.size), 0);

    return {
      tokenId,
      bestBid,
      bestAsk,
      spread,
      midpoint: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null,
      bidDepth,
      askDepth,
      rawBids: book.bids || [],
      rawAsks: book.asks || [],
      timestamp: Date.now(),
    };
  } catch (err) {
    logger.error({ module: "polymarket", tokenId, err: err.message }, "Failed to fetch orderbook");
    return null;
  }
}

/**
 * Get orderbooks for all outcomes in a market.
 * Markets have YES/NO tokens; we fetch both.
 */
export async function getMarketBooks(market) {
  const tokens = market.tokens || [];
  const books = {};

  for (const token of tokens) {
    const book = await getOrderbook(token.token_id);
    if (book) {
      books[token.outcome] = {
        ...book,
        outcome: token.outcome,
        tokenId: token.token_id,
      };
    }
  }

  return books;
}

// ── PRICE SNAPSHOT ──

/**
 * Get a quick price snapshot for a market.
 * Returns YES/NO midpoints without full orderbook depth.
 */
export async function getPrice(market) {
  const tokens = market.tokens || [];
  const prices = {};

  for (const token of tokens) {
    try {
      const resp = await axios.get(`${clobUrl}/price`, {
        params: { token_id: token.token_id, side: "buy" },
        timeout: 5_000,
      });
      prices[token.outcome] = parseFloat(resp.data?.price || 0);
    } catch {
      prices[token.outcome] = null;
    }
  }

  return {
    question: market.question,
    conditionId: market.condition_id,
    yes: prices["Yes"] || null,
    no: prices["No"] || null,
    timestamp: Date.now(),
  };
}

// ── ORDER PLACEMENT ──

/**
 * Place a limit order (maker — 0% fee + 0.20% rebate).
 * This is the primary order type for our market-making strategy.
 *
 * @param {Object} params
 * @param {string} params.tokenId - Token to buy/sell
 * @param {string} params.side - "BUY" or "SELL"
 * @param {number} params.price - Limit price (0-1, e.g., 0.65 = 65¢)
 * @param {number} params.size - Amount in USDC
 * @returns {Object} Order result
 */
export async function placeLimitOrder({ tokenId, side, price, size }) {
  if (!clobClient) {
    logger.error({ module: "polymarket" }, "Cannot place order — CLOB client not initialized");
    return null;
  }

  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price,
      side,
      size,
    });

    const result = await clobClient.postOrder(order);

    logger.info({
      module: "polymarket",
      side,
      price,
      size,
      tokenId: tokenId.slice(0, 12) + "...",
      orderId: result?.orderID,
    }, "Limit order placed");

    return result;
  } catch (err) {
    logger.error({ module: "polymarket", err: err.message, side, price, size }, "Order placement failed");
    return null;
  }
}

/**
 * Cancel an open order.
 */
export async function cancelOrder(orderId) {
  if (!clobClient) return null;
  try {
    const result = await clobClient.cancelOrder({ orderID: orderId });
    logger.info({ module: "polymarket", orderId }, "Order cancelled");
    return result;
  } catch (err) {
    logger.error({ module: "polymarket", orderId, err: err.message }, "Order cancellation failed");
    return null;
  }
}

/**
 * Cancel all open orders.
 */
export async function cancelAllOrders() {
  if (!clobClient) return null;
  try {
    const result = await clobClient.cancelAll();
    logger.info({ module: "polymarket" }, "All orders cancelled");
    return result;
  } catch (err) {
    logger.error({ module: "polymarket", err: err.message }, "Cancel all failed");
    return null;
  }
}

/**
 * Get open orders.
 */
export async function getOpenOrders() {
  if (!clobClient) return [];
  try {
    const orders = await clobClient.getOpenOrders();
    return orders || [];
  } catch (err) {
    logger.error({ module: "polymarket", err: err.message }, "Failed to fetch open orders");
    return [];
  }
}

export { clobClient };
