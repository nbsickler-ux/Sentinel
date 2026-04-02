import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";
import { createDataPoint } from "../schema.js";
import { cacheKey, cacheSet, CACHE_TTL } from "../cache/redis.js";

// CoinGecko API — demo keys (CG-*) use demo endpoint, pro keys use pro endpoint
const BASE_URL = !config.coingecko.apiKey
  ? "https://api.coingecko.com/api/v3"
  : config.coingecko.apiKey.startsWith("CG-")
  ? "https://api.coingecko.com/api/v3"
  : "https://pro-api.coingecko.com/api/v3";

// Map our pair base tokens to CoinGecko IDs
const COINGECKO_IDS = {
  cbBTC: "coinbase-wrapped-btc",
  ETH:   "ethereum",
  AERO:  "aerodrome-finance",
};

function getHeaders() {
  if (!config.coingecko.apiKey) return {};
  // Demo keys use x-cg-demo-api-key, pro keys use x-cg-pro-api-key
  const headerName = config.coingecko.apiKey.startsWith("CG-")
    ? "x-cg-demo-api-key"
    : "x-cg-pro-api-key";
  return { [headerName]: config.coingecko.apiKey };
}

/**
 * Fetch price, volume, market cap, and change data for a token.
 */
async function fetchTokenData(tokenSymbol) {
  const cgId = COINGECKO_IDS[tokenSymbol];
  if (!cgId) return null;

  const start = Date.now();
  const { data } = await axios.get(`${BASE_URL}/coins/${cgId}`, {
    params: {
      localization: false,
      tickers: false,
      community_data: false,
      developer_data: false,
      sparkline: false,
    },
    headers: getHeaders(),
    timeout: 10000,
  });

  const market = data.market_data || {};

  return createDataPoint({
    source: "coingecko",
    pair: `${tokenSymbol}/USDC`,
    type: "price",
    timestamp: Date.now(),
    data: {
      price: market.current_price?.usd || 0,
      market_cap: market.market_cap?.usd || 0,
      volume_24h: market.total_volume?.usd || 0,
      change_24h_pct: market.price_change_percentage_24h || 0,
      change_7d_pct: market.price_change_percentage_7d || 0,
      change_30d_pct: market.price_change_percentage_30d || 0,
      ath: market.ath?.usd || 0,
      ath_change_pct: market.ath_change_percentage?.usd || 0,
      circulating_supply: market.circulating_supply || 0,
      total_supply: market.total_supply || 0,
      fdv: market.fully_diluted_valuation?.usd || 0,
    },
    meta: { api_latency_ms: Date.now() - start },
  });
}

/**
 * Ingest CoinGecko data for all base tokens in our pairs.
 */
export async function ingest() {
  // CoinGecko works without API key (rate limited), so we always attempt
  const results = [];
  const seenTokens = new Set();

  for (const pair of config.pairs) {
    const baseToken = pair.split("/")[0];
    if (seenTokens.has(baseToken)) continue;
    seenTokens.add(baseToken);

    try {
      const point = await fetchTokenData(baseToken);
      if (point) {
        await cacheSet(cacheKey("price", "coingecko", pair), point, CACHE_TTL["price:coingecko"]);
        results.push(point);
        logger.info({
          module: "coingecko",
          token: baseToken,
          price: point.data.price,
        }, "Ingested market data");
      }
    } catch (e) {
      logger.error({ module: "coingecko", token: baseToken, err: e.message }, "Ingestion failed");
    }

    // Respect rate limits — 500ms between calls for free tier
    if (!config.coingecko.apiKey) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}
