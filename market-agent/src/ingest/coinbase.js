import axios from "axios";
import crypto from "crypto";
import config from "../config.js";
import logger from "../logger.js";
import { createDataPoint } from "../schema.js";
import { cacheKey, cacheSet, CACHE_TTL } from "../cache/redis.js";

const BASE_URL = "https://api.coinbase.com/api/v3/brokerage";

/**
 * Generate JWT for Coinbase CDP (Cloud Developer Platform) auth.
 * Uses ES256 signing with the EC private key.
 */
function generateJWT(method, path) {
  const keyName = config.coinbase.apiKey;
  const privateKeyPem = config.coinbase.apiSecret.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const uri = `${method.toUpperCase()} api.coinbase.com${path}`;

  // Build JWT header and payload
  const header = { alg: "ES256", kid: keyName, nonce: crypto.randomBytes(16).toString("hex"), typ: "JWT" };
  const payload = { sub: keyName, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uri };

  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;

  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  const derSig = sign.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  const signature = derSig.toString("base64url");

  return `${signingInput}.${signature}`;
}

function authHeaders(method, path) {
  const jwt = generateJWT(method, path);
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
}

// Map our pair names to Coinbase Advanced Trade product IDs
const PRODUCT_MAP = {
  "cbBTC/USDC": "BTC-USDC",   // Coinbase BTC spot — used for CEX/DEX arb vs on-chain cbBTC
  "ETH/USDC":   "ETH-USDC",
  "AERO/USDC":  "AERO-USDC",
};

function toProductId(pair) {
  return PRODUCT_MAP[pair] || pair.replace("/", "-").toUpperCase();
}

/**
 * Fetch current ticker price for a pair.
 */
async function fetchPrice(pair) {
  const productId = toProductId(pair);
  const path = `/api/v3/brokerage/market/products/${productId}/ticker`;
  const start = Date.now();

  const { data } = await axios.get(`${BASE_URL}/market/products/${productId}/ticker`, {
    headers: authHeaders("GET", path),
    timeout: 5000,
  });

  const trades = data.trades || [];
  const bestBid = parseFloat(data.best_bid || 0);
  const bestAsk = parseFloat(data.best_ask || 0);
  const price = trades.length > 0 ? parseFloat(trades[0].price) : (bestBid + bestAsk) / 2;

  return createDataPoint({
    source: "coinbase",
    pair,
    type: "price",
    timestamp: Date.now(),
    data: {
      price,
      bid: bestBid,
      ask: bestAsk,
      spread: bestAsk - bestBid,
      spread_bps: bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 10000 : 0,
      volume_24h: parseFloat(data.volume || 0),
    },
    meta: { api_latency_ms: Date.now() - start },
  });
}

/**
 * Fetch order book depth for a pair.
 */
async function fetchOrderBook(pair) {
  const productId = toProductId(pair);
  const authPath = `/api/v3/brokerage/product_book`;
  const start = Date.now();

  const { data } = await axios.get(`https://api.coinbase.com${authPath}`, {
    params: { product_id: productId, limit: 50 },
    headers: authHeaders("GET", authPath),
    timeout: 5000,
  });

  const book = data.pricebook || {};
  const bids = (book.bids || []).map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
  const asks = (book.asks || []).map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));

  const bidDepth = bids.reduce((sum, b) => sum + b.price * b.size, 0);
  const askDepth = asks.reduce((sum, a) => sum + a.price * a.size, 0);
  const midPrice = bids.length && asks.length ? (bids[0].price + asks[0].price) / 2 : 0;
  const spreadBps = midPrice > 0 && asks.length && bids.length
    ? ((asks[0].price - bids[0].price) / midPrice) * 10000
    : 0;

  return createDataPoint({
    source: "coinbase",
    pair,
    type: "orderbook",
    timestamp: Date.now(),
    data: {
      bids_depth: bidDepth,
      asks_depth: askDepth,
      mid_price: midPrice,
      spread_bps: spreadBps,
      imbalance_ratio: bidDepth + askDepth > 0 ? bidDepth / (bidDepth + askDepth) : 0.5,
      levels: { bids: bids.slice(0, 10), asks: asks.slice(0, 10) },
    },
    meta: { api_latency_ms: Date.now() - start },
  });
}

/**
 * Ingest all Coinbase data for configured pairs.
 */
export async function ingest() {
  if (!config.coinbase.apiKey) {
    logger.warn({ module: "coinbase" }, "COINBASE_ADV_API_KEY not set — skipping");
    return [];
  }

  const results = [];
  for (const pair of config.pairs) {
    try {
      const price = await fetchPrice(pair);
      await cacheSet(cacheKey("price", "coinbase", pair), price, CACHE_TTL["price:coinbase"]);
      results.push(price);

      const book = await fetchOrderBook(pair);
      await cacheSet(cacheKey("orderbook", "coinbase", pair), book, CACHE_TTL["orderbook"]);
      results.push(book);

      logger.info({ module: "coinbase", pair, price: price.data.price }, "Ingested price + orderbook");
    } catch (e) {
      logger.error({ module: "coinbase", pair, err: e.message }, "Ingestion failed");
    }
  }
  return results;
}
