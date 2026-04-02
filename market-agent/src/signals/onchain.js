// ============================================================
// ON-CHAIN BEHAVIORAL SIGNALS
// Wallet accumulation/distribution, large transfers,
// DEX liquidity changes, veAERO lock events.
// ============================================================

import { createSignal, clampConfidence } from "./schema.js";
import { cacheGet } from "../cache/redis.js";
import logger from "../logger.js";

// Thresholds for "large" transfers (in native token units)
const LARGE_TRANSFER_THRESHOLDS = {
  cbBTC: 1,        // 1 BTC (~$67k)
  ETH:   50,       // 50 ETH (~$100k)
  AERO:  500000,   // 500k AERO (~$150k)
  USDC:  100000,   // $100k
};

/**
 * Analyze token transfers for accumulation/distribution patterns.
 */
function analyzeTransfers(transfers, token) {
  if (!transfers || transfers.length === 0) return null;

  const threshold = LARGE_TRANSFER_THRESHOLDS[token] || 0;
  let totalVolume = 0;
  let largeTransferCount = 0;
  let largeTransferVolume = 0;
  const uniqueReceivers = new Set();
  const uniqueSenders = new Set();

  for (const dp of transfers) {
    const t = dp.data || dp;
    const value = t.value || 0;
    totalVolume += value;

    if (value >= threshold) {
      largeTransferCount++;
      largeTransferVolume += value;
    }

    if (t.to) uniqueReceivers.add(t.to);
    if (t.from) uniqueSenders.add(t.from);
  }

  // Accumulation signal: many receivers < senders = distribution
  // Few receivers > senders = accumulation (concentration)
  const concentrationRatio = uniqueReceivers.size > 0
    ? uniqueSenders.size / uniqueReceivers.size
    : 1;

  return {
    total_volume: totalVolume,
    transfer_count: transfers.length,
    large_transfer_count: largeTransferCount,
    large_transfer_volume: largeTransferVolume,
    unique_senders: uniqueSenders.size,
    unique_receivers: uniqueReceivers.size,
    concentration_ratio: concentrationRatio,
    is_accumulating: concentrationRatio > 1.5,
    is_distributing: concentrationRatio < 0.7,
  };
}

/**
 * Analyze pool liquidity changes for a pair.
 */
async function analyzeLiquidity(pair) {
  const poolData = await cacheGet(`ma:pool:aerodrome:${pair}`);
  if (!poolData?.data) return null;

  return {
    tvl: poolData.data.tvl,
    volume_24h: poolData.data.volume_24h,
    fees_24h: poolData.data.fees_24h,
    // Volume/TVL ratio: high = lots of trading relative to liquidity
    utilization: poolData.data.tvl > 0
      ? poolData.data.volume_24h / poolData.data.tvl
      : 0,
  };
}

/**
 * Generate on-chain behavioral signal for a pair.
 *
 * @param {string} pair - Trading pair identifier
 * @param {Object} [inputData] - Optional { transfers, poolData } for backtesting (Phase 2).
 *                                 If omitted, reads from Redis cache.
 */
export async function analyze(pair, inputData) {
  const baseToken = pair.split("/")[0];

  // Get transfer data — from input (backtesting) or cache (live)
  let transfers = [];
  if (inputData?.transfers) {
    transfers = inputData.transfers;
  } else {
    // Upstash may return arrays as objects with numeric keys
    const rawTransfers = await cacheGet(`ma:onchain:alchemy:transfers:${baseToken}`);
    if (Array.isArray(rawTransfers)) {
      transfers = rawTransfers;
    } else if (rawTransfers && typeof rawTransfers === "object") {
      transfers = Object.values(rawTransfers);
    }
  }
  const transferAnalysis = analyzeTransfers(transfers, baseToken);

  // Get liquidity data — from input (backtesting) or cache (live)
  let liquidity = null;
  if (inputData?.poolData) {
    const pd = inputData.poolData;
    liquidity = {
      tvl: pd.tvl, volume_24h: pd.volume_24h, fees_24h: pd.fees_24h,
      utilization: pd.tvl > 0 ? pd.volume_24h / pd.tvl : 0,
    };
  } else {
    liquidity = await analyzeLiquidity(pair);
  }

  // Get veAERO lock/unlock events (only for AERO pairs)
  let veAeroAnalysis = null;
  if (baseToken === "AERO") {
    let veAeroEvents = [];
    if (inputData?.veAeroEvents) {
      veAeroEvents = inputData.veAeroEvents;
    } else {
      const rawEvents = await cacheGet("ma:onchain:alchemy:veaero_events");
      if (Array.isArray(rawEvents)) {
        veAeroEvents = rawEvents;
      } else if (rawEvents && typeof rawEvents === "object") {
        veAeroEvents = Object.values(rawEvents);
      }
    }

    if (veAeroEvents.length > 0) {
      let locks = 0, unlocks = 0, lockVolume = 0, unlockVolume = 0;
      for (const ev of veAeroEvents) {
        const d = ev.data || ev;
        if (d.event_type === "veaero_lock" || d.is_lock) {
          locks++;
          lockVolume += d.value || 0;
        } else {
          unlocks++;
          unlockVolume += d.value || 0;
        }
      }
      veAeroAnalysis = {
        total_events: veAeroEvents.length,
        locks, unlocks, lockVolume, unlockVolume,
        net_lock_ratio: locks + unlocks > 0 ? locks / (locks + unlocks) : 0.5,
        is_net_locking: lockVolume > unlockVolume,
      };
    }
  }

  if (!transferAnalysis && !liquidity && !veAeroAnalysis) {
    logger.debug({ module: "onchain", pair }, "No on-chain data available");
    return null;
  }

  // Scoring logic
  let bullishScore = 0;
  let bearishScore = 0;

  if (transferAnalysis) {
    // Accumulation = bullish
    if (transferAnalysis.is_accumulating) bullishScore += 0.3;
    if (transferAnalysis.is_distributing) bearishScore += 0.3;

    // Large transfers = whales moving, ambiguous but noteworthy
    if (transferAnalysis.large_transfer_count > 3) {
      // Many large transfers = heightened activity
      bullishScore += 0.1;
      bearishScore += 0.1;
    }
  }

  if (liquidity) {
    // High utilization = active market, generally bullish for the pair
    if (liquidity.utilization > 0.5) bullishScore += 0.2;
    if (liquidity.utilization < 0.05) bearishScore += 0.1;
  }

  if (veAeroAnalysis) {
    // Net locking = bullish (tokens locked in governance, reduced supply)
    if (veAeroAnalysis.is_net_locking) bullishScore += 0.25;
    else bearishScore += 0.2;

    // High lock ratio = strong conviction from veAERO participants
    if (veAeroAnalysis.net_lock_ratio > 0.7) bullishScore += 0.1;
    if (veAeroAnalysis.net_lock_ratio < 0.3) bearishScore += 0.1;
  }

  const netScore = bullishScore - bearishScore;
  let direction = "neutral";
  if (netScore > 0.15) direction = "long";
  if (netScore < -0.15) direction = "short";

  const confidence = clampConfidence(Math.abs(netScore) * 1.5);
  const regime = transferAnalysis?.is_accumulating ? "trending_up"
    : transferAnalysis?.is_distributing ? "trending_down"
    : "ranging";

  const thesis = direction === "neutral"
    ? `${pair}: On-chain activity normal. ${transferAnalysis?.transfer_count || 0} transfers, ${transferAnalysis?.large_transfer_count || 0} large.`
    : `${pair}: ${transferAnalysis?.is_accumulating ? "Accumulation" : "Distribution"} detected. ${transferAnalysis?.large_transfer_count || 0} whale transfers. Liquidity util ${liquidity ? (liquidity.utilization * 100).toFixed(1) : "N/A"}%.`;

  return createSignal({
    type: "onchain",
    pair,
    direction,
    confidence,
    regime,
    indicators: {
      ...transferAnalysis,
      liquidity_tvl: liquidity?.tvl,
      liquidity_volume_24h: liquidity?.volume_24h,
      liquidity_utilization: liquidity?.utilization,
      veaero_locks: veAeroAnalysis?.locks || null,
      veaero_unlocks: veAeroAnalysis?.unlocks || null,
      veaero_lock_volume: veAeroAnalysis?.lockVolume || null,
      veaero_net_lock_ratio: veAeroAnalysis?.net_lock_ratio || null,
      veaero_is_net_locking: veAeroAnalysis?.is_net_locking || null,
    },
    thesis,
  });
}
