// ============================================================
// KALSHI CLIENT WRAPPER
// REST API client for Kalshi prediction markets.
//
// Key differences from Polymarket:
//   - REST API with RSA-PSS signed requests (not wallet-based)
//   - Contracts priced 1-99¢, resolve to $1 or $0
//   - 85,000+ markets across ALL categories (not just sports)
//   - Taker fee: ~1.75¢/contract max at 50¢. Maker: 0% on most markets.
//   - No blockchain — traditional exchange infrastructure
// ============================================================

import crypto from "crypto";
import axios from "axios";
import fs from "fs";
import config from "../config.js";
import logger from "../logger.js";

const kalshiConfig = config.platforms?.kalshi || {};
const { baseUrl, apiKeyId } = kalshiConfig;

let privateKey = null;

/**
 * Initialize the RSA private key for request signing.
 */
function loadPrivateKey() {
  if (privateKey) return privateKey;

  if (kalshiConfig.privateKeyPem) {
    privateKey = kalshiConfig.privateKeyPem;
  } else if (kalshiConfig.privateKeyPath) {
    try {
      privateKey = fs.readFileSync(kalshiConfig.privateKeyPath, "utf-8");
    } catch (err) {
      logger.error({ module: "kalshi", err: err.message }, "Failed to load private key file");
    }
  }

  if (privateKey) {
    logger.info({ module: "kalshi" }, "RSA private key loaded — trading enabled");
  } else {
    logger.warn({ module: "kalshi" }, "No private key — running in read-only mode");
  }

  return privateKey;
}

/**
 * Sign a request using RSA-PSS (Kalshi's auth method).
 * Headers: KALSHI-ACCESS-KEY, KALSHI-ACCESS-TIMESTAMP, KALSHI-ACCESS-SIGNATURE
 */
function signRequest(method, path, body = "") {
  const key = loadPrivateKey();
  if (!key || !apiKeyId) return {};

  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path + (body || "");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(message);
  sign.end();

  const signature = sign.sign(
    { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
    "base64"
  );

  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type": "application/json",
  };
}

/**
 * Make an authenticated request to Kalshi API.
 */
async function kalshiRequest(method, path, data = null) {
  const url = `${baseUrl}${path}`;
  const body = data ? JSON.stringify(data) : "";
  const headers = signRequest(method, path, body);

  try {
    const resp = await axios({
      method,
      url,
      headers,
      data: data || undefined,
      timeout: 10_000,
    });
    return resp.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    logger.error({ module: "kalshi", method, path, status, err: detail }, "Kalshi API request failed");
    return null;
  }
}

/**
 * Make an unauthenticated request (market data is public).
 */
async function kalshiPublicRequest(path, params = {}) {
  try {
    const resp = await axios.get(`${baseUrl}${path}`, {
      params,
      timeout: 10_000,
    });
    return resp.data;
  } catch (err) {
    logger.error({ module: "kalshi", path, err: err.message }, "Kalshi public request failed");
    return null;
  }
}

// ── MARKET DISCOVERY ──

/**
 * Fetch active markets from Kalshi.
 * @param {Object} opts
 * @param {string} [opts.category] - Filter by category (sports, politics, crypto, etc.)
 * @param {string} [opts.seriesTicker] - Filter by series (e.g., "NBA" for all NBA markets)
 * @param {string} [opts.status] - Market status (open, closed, settled)
 * @param {number} [opts.limit] - Max results (default: 100)
 * @param {string} [opts.cursor] - Pagination cursor
 */
export async function getMarkets(opts = {}) {
  const params = {};
  if (opts.category) params.category = opts.category;
  if (opts.seriesTicker) params.series_ticker = opts.seriesTicker;
  if (opts.status) params.status = opts.status;
  params.limit = opts.limit || 100;
  if (opts.cursor) params.cursor = opts.cursor;

  const resp = await kalshiPublicRequest("/markets", params);
  const markets = resp?.markets || [];

  logger.debug({ module: "kalshi", count: markets.length, category: opts.category }, "Fetched markets");
  return markets;
}

/**
 * Fetch a single market by ticker.
 */
export async function getMarket(ticker) {
  const resp = await kalshiPublicRequest(`/markets/${ticker}`);
  return resp?.market || null;
}

/**
 * Fetch events (grouped markets).
 */
export async function getEvents(opts = {}) {
  const params = {};
  if (opts.category) params.category = opts.category;
  if (opts.status) params.status = opts.status;
  params.limit = opts.limit || 50;

  const resp = await kalshiPublicRequest("/events", params);
  return resp?.events || [];
}

// ── ORDERBOOK & PRICING ──

/**
 * Get the orderbook for a market.
 * Returns bids, asks, spread, and depth.
 */
export async function getOrderbook(ticker) {
  const resp = await kalshiPublicRequest(`/markets/${ticker}/orderbook`);
  if (!resp?.orderbook) return null;

  const book = resp.orderbook;
  const bestBid = book.yes?.[0] ? book.yes[0][0] / 100 : null; // Kalshi prices in cents
  const bestAsk = book.no?.[0] ? 1 - book.no[0][0] / 100 : null;

  return {
    ticker,
    bestBid,
    bestAsk,
    spread: bestBid && bestAsk ? bestAsk - bestBid : null,
    midpoint: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null,
    rawYes: book.yes || [],
    rawNo: book.no || [],
    timestamp: Date.now(),
  };
}

/**
 * Get current price snapshot for a market.
 */
export async function getPrice(ticker) {
  const market = await getMarket(ticker);
  if (!market) return null;

  const yesPrice = market.last_price ? market.last_price / 100 : null;
  const noPrice = yesPrice != null ? 1 - yesPrice : null;

  return {
    ticker,
    question: market.title || market.subtitle,
    yes: yesPrice,
    no: noPrice,
    volume: market.volume,
    openInterest: market.open_interest,
    closeTime: market.close_time,
    timestamp: Date.now(),
  };
}

// ── ORDER PLACEMENT ──

/**
 * Place a limit order on Kalshi.
 *
 * @param {Object} params
 * @param {string} params.ticker - Market ticker
 * @param {string} params.side - "yes" or "no"
 * @param {number} params.price - Price in cents (1-99)
 * @param {number} params.count - Number of contracts
 * @param {string} [params.type] - "limit" (default) or "market"
 */
export async function placeOrder({ ticker, side, price, count, type = "limit" }) {
  if (!apiKeyId || !loadPrivateKey()) {
    logger.error({ module: "kalshi" }, "Cannot place order — not authenticated");
    return null;
  }

  const orderData = {
    ticker,
    action: "buy",
    side,
    type,
    count,
    ...(type === "limit" ? { yes_price: side === "yes" ? price : undefined, no_price: side === "no" ? price : undefined } : {}),
  };

  const result = await kalshiRequest("POST", "/portfolio/orders", orderData);

  if (result?.order) {
    logger.info({
      module: "kalshi",
      ticker,
      side,
      price,
      count,
      orderId: result.order.order_id,
    }, "Kalshi order placed");
    return result.order;
  }

  return null;
}

/**
 * Cancel an order.
 */
export async function cancelOrder(orderId) {
  const result = await kalshiRequest("DELETE", `/portfolio/orders/${orderId}`);
  if (result) {
    logger.info({ module: "kalshi", orderId }, "Kalshi order cancelled");
  }
  return result;
}

/**
 * Get open orders.
 */
export async function getOpenOrders() {
  const result = await kalshiRequest("GET", "/portfolio/orders?status=resting");
  return result?.orders || [];
}

// ── PORTFOLIO ──

/**
 * Get current portfolio balance.
 */
export async function getBalance() {
  const result = await kalshiRequest("GET", "/portfolio/balance");
  return result ? { balance: result.balance / 100, portfolioValue: result.payout / 100 } : null;
}

/**
 * Get current positions.
 */
export async function getPositions() {
  const result = await kalshiRequest("GET", "/portfolio/positions");
  return result?.market_positions || [];
}

// ── INITIALIZATION ──

export function isEnabled() {
  return kalshiConfig.enabled && !!apiKeyId;
}

export function init() {
  if (!kalshiConfig.enabled) {
    logger.info({ module: "kalshi" }, "Kalshi disabled — no API key configured");
    return false;
  }
  loadPrivateKey();
  return !!privateKey;
}
