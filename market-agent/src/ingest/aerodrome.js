import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";
import { createDataPoint } from "../schema.js";
import { cacheKey, cacheSet, CACHE_TTL } from "../cache/redis.js";

// Aerodrome subgraph on The Graph (Base mainnet)
const SUBGRAPH_URL = config.theGraph.apiKey
  ? `https://gateway.thegraph.com/api/${config.theGraph.apiKey}/subgraphs/id/GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM`
  : "https://api.thegraph.com/subgraphs/name/aerodrome-finance/aerodrome-base";

// Aerodrome pool addresses on Base (from subgraph query)
const POOL_MAP = {
  "cbBTC/USDC": "0x4e962bb3889bf030368f56810a9c96b83cb3e778",  // USDC/cbBTC $25M TVL
  "ETH/USDC":   "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59",  // WETH/USDC $73M TVL
  "AERO/USDC":  "0xbe00ff35af70e8415d0eb605a286d8a45466a4c1",  // USDC/AERO $3.2M TVL
};

/**
 * Query pool data from Aerodrome subgraph.
 */
async function fetchPool(pair) {
  const poolAddress = POOL_MAP[pair];
  if (!poolAddress) {
    logger.debug({ module: "aerodrome", pair }, "No known pool address — skipping");
    return null;
  }

  const query = `{
    pool(id: "${poolAddress.toLowerCase()}") {
      id
      totalValueLockedUSD
      volumeUSD
      feesUSD
      token0 { symbol decimals }
      token1 { symbol decimals }
      totalValueLockedToken0
      totalValueLockedToken1
      token0Price
      token1Price
      feeTier
      liquidity
      txCount
    }
  }`;

  const start = Date.now();
  const { data } = await axios.post(
    SUBGRAPH_URL,
    { query },
    { timeout: 10000, headers: { "Content-Type": "application/json" } }
  );

  const pool = data?.data?.pool;
  if (!pool) {
    throw new Error(`Pool not found for ${pair} (${poolAddress})`);
  }

  return createDataPoint({
    source: "aerodrome",
    pair,
    type: "pool",
    timestamp: Date.now(),
    data: {
      pool_address: poolAddress,
      tvl: parseFloat(pool.totalValueLockedUSD || 0),
      volume_24h: parseFloat(pool.volumeUSD || 0),
      fees_24h: parseFloat(pool.feesUSD || 0),
      token0_reserve: parseFloat(pool.totalValueLockedToken0 || 0),
      token1_reserve: parseFloat(pool.totalValueLockedToken1 || 0),
      token0_price: parseFloat(pool.token0Price || 0),
      token1_price: parseFloat(pool.token1Price || 0),
      fee_tier: pool.feeTier || null,
      token0_symbol: pool.token0?.symbol,
      token1_symbol: pool.token1?.symbol,
    },
    meta: { api_latency_ms: Date.now() - start },
  });
}

/**
 * Ingest all Aerodrome pool data for configured pairs.
 */
export async function ingest() {
  if (!config.theGraph.apiKey) {
    logger.warn({ module: "aerodrome" }, "THE_GRAPH_API_KEY not set — using public endpoint (rate limited)");
  }

  const results = [];
  for (const pair of config.pairs) {
    try {
      const point = await fetchPool(pair);
      if (point) {
        await cacheSet(cacheKey("pool", "aerodrome", pair), point, CACHE_TTL["pool:aerodrome"]);
        results.push(point);
        logger.info({ module: "aerodrome", pair, tvl: point.data.tvl }, "Ingested pool data");
      }
    } catch (e) {
      logger.error({ module: "aerodrome", pair, err: e.message }, "Ingestion failed");
    }
  }
  return results;
}
