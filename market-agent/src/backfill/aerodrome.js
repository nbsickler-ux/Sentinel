// ============================================================
// AERODROME HISTORICAL BACKFILL
// Strategy: Use The Graph subgraph for poolDayData (daily OHLCV).
// This is simpler and more reliable than decoding raw swap events.
// Falls back to Alchemy eth_getLogs if needed for higher resolution.
// ============================================================

import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";

const SUBGRAPH_ID = "GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM";

function getSubgraphUrl() {
  if (!config.theGraph.apiKey) return null;
  return `https://gateway.thegraph.com/api/${config.theGraph.apiKey}/subgraphs/id/${SUBGRAPH_ID}`;
}

// Pool addresses from ingest/aerodrome.js
const POOL_MAP = {
  "cbBTC/USDC": "0x4e962bb3889bf030368f56810a9c96b83cb3e778",
  "ETH/USDC": "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59",
  "AERO/USDC": "0xbe00ff35af70e8415d0eb605a286d8a45466a4c1",
};

/**
 * Fetch poolDayData for a pool from the Aerodrome subgraph.
 * Returns daily price/volume/TVL data.
 */
async function fetchPoolDayData(poolAddress, startTimestamp, skip = 0) {
  const url = getSubgraphUrl();
  if (!url) throw new Error("THE_GRAPH_API_KEY not set");

  const query = `{
    poolDayDatas(
      first: 1000,
      skip: ${skip},
      where: { pool: "${poolAddress}", date_gte: ${startTimestamp} },
      orderBy: date,
      orderDirection: asc
    ) {
      date
      pool { id token0 { symbol } token1 { symbol } }
      volumeUSD
      tvlUSD
      feesUSD
      token0Price
      token1Price
      open
      high
      low
      close
    }
  }`;

  const { data } = await axios.post(url, { query }, { timeout: 15000 });

  if (data.errors) {
    throw new Error(data.errors[0]?.message || "Subgraph query failed");
  }

  return data.data?.poolDayDatas || [];
}

/**
 * Backfill Aerodrome DEX price history for a pair.
 * Uses poolDayData for daily granularity (sufficient for initial backtesting).
 *
 * @param {string} pair - Our pair name
 * @param {number} months - How many months of history
 * @returns {AsyncGenerator} Yields arrays of DEX price points
 */
export async function* backfill(pair, months = 3) {
  const poolAddress = POOL_MAP[pair];
  if (!poolAddress) {
    logger.info({ module: "backfill:aerodrome", pair }, "No pool address — skipping");
    return;
  }

  if (!config.theGraph.apiKey) {
    logger.warn({ module: "backfill:aerodrome" }, "THE_GRAPH_API_KEY not set — skipping");
    return;
  }

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const startTimestamp = Math.floor(startDate.getTime() / 1000);

  logger.info({
    module: "backfill:aerodrome",
    pair,
    pool: poolAddress.slice(0, 10) + "...",
    from: startDate.toISOString(),
  }, "Starting Aerodrome backfill");

  let skip = 0;
  let totalDays = 0;

  while (true) {
    try {
      const dayDatas = await fetchPoolDayData(poolAddress, startTimestamp, skip);

      if (dayDatas.length === 0) break;

      const points = dayDatas.map((d) => {
        // token1Price gives price of token0 in terms of token1
        // For USDC/cbBTC pool, token1Price = cbBTC price in USDC
        const price = parseFloat(d.close || d.token1Price || 0);

        return {
          source: "aerodrome",
          pair,
          timestamp: new Date(d.date * 1000),
          price,
          open: parseFloat(d.open || 0),
          high: parseFloat(d.high || 0),
          low: parseFloat(d.low || 0),
          close: parseFloat(d.close || 0),
          volume: parseFloat(d.volumeUSD || 0),
          tvl: parseFloat(d.tvlUSD || 0),
          fees: parseFloat(d.feesUSD || 0),
          token0Price: parseFloat(d.token0Price || 0),
          token1Price: parseFloat(d.token1Price || 0),
        };
      });

      totalDays += points.length;
      yield points;

      logger.debug({
        module: "backfill:aerodrome",
        pair,
        days: points.length,
        total: totalDays,
        from: dayDatas[0]?.date ? new Date(dayDatas[0].date * 1000).toISOString().slice(0, 10) : "?",
        to: dayDatas[dayDatas.length - 1]?.date ? new Date(dayDatas[dayDatas.length - 1].date * 1000).toISOString().slice(0, 10) : "?",
      }, "Chunk fetched");

      if (dayDatas.length < 1000) break; // No more pages
      skip += dayDatas.length;

      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      logger.error({
        module: "backfill:aerodrome",
        pair,
        skip,
        err: e.message,
      }, "Chunk failed — stopping pagination");
      break;
    }
  }

  logger.info({
    module: "backfill:aerodrome",
    pair,
    totalDays,
  }, "Aerodrome backfill complete");
}
