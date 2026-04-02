// ============================================================
// TRIPLE BARRIER TRADE SIMULATOR
// Implements Martin Prado's Triple Barrier Method:
// (a) Stop loss — caps downside
// (b) Take profit — secures gains
// (c) Time limit — prevents indefinite exposure
// Whichever triggers first determines the trade outcome.
// ============================================================

/**
 * Default parameters per signal type.
 */
export const DEFAULT_PARAMS = {
  arb: {
    stopLossPct: 2.0,     // 2% stop loss
    takeProfitPct: 1.0,   // 1% take profit (net of fees)
    timeLimitMs: 30 * 60 * 1000, // 30 minutes
  },
  directional: {
    stopLossPct: 5.0,     // 5% stop loss
    takeProfitPct: 3.0,   // 3% take profit
    timeLimitMs: 48 * 60 * 60 * 1000, // 48 hours
  },
};

/**
 * Fee model — realistic costs per the brief.
 */
export const FEES = {
  aerodrome_cl: 0.05,         // 0.05% for cbBTC/USDC and ETH/USDC CL pools (feeTier=500)
  aerodrome_volatile: 0.30,  // 0.30% for volatile legacy pools
  aerodrome_stable: 0.01,    // 0.01% for stable pairs
  base_gas_usd: 0.03,        // ~$0.03 per swap on Base
  coinbase_maker: 0.40,      // 0.40% maker fee
  coinbase_taker: 0.60,      // 0.60% taker fee
};

/**
 * Compute total round-trip fee in basis points for an arb trade.
 * Buy on DEX (Aerodrome) + Sell on CEX (Coinbase) or vice versa.
 */
export function arbFeeBps(positionSizeUsd = 1000) {
  const dexFeeBps = FEES.aerodrome_cl * 100; // 5 bps (corrected from 30 bps — actual pool feeTier=500)
  const cexFeeBps = FEES.coinbase_taker * 100;     // 60 bps
  const gasFeeBps = (FEES.base_gas_usd / positionSizeUsd) * 10000; // Gas as bps
  return dexFeeBps + cexFeeBps + gasFeeBps; // ~90+ bps total
}

/**
 * Simulate a single trade using the Triple Barrier method.
 *
 * @param {Object} entry - { timestamp, price, direction, signalType }
 * @param {Object[]} futurePrices - Time-sorted prices after entry: [{ timestamp, price, high?, low? }]
 * @param {Object} params - { stopLossPct, takeProfitPct, timeLimitMs }
 * @param {number} feeBps - Round-trip fee in basis points
 * @returns {Object} Trade result
 */
export function simulateTrade(entry, futurePrices, params, feeBps) {
  const { stopLossPct, takeProfitPct, timeLimitMs } = params;
  const direction = entry.direction; // "long" or "short"
  const entryPrice = entry.price;
  const deadline = entry.timestamp.getTime() + timeLimitMs;

  // Barrier prices
  const stopPrice = direction === "long"
    ? entryPrice * (1 - stopLossPct / 100)
    : entryPrice * (1 + stopLossPct / 100);

  const tpPrice = direction === "long"
    ? entryPrice * (1 + takeProfitPct / 100)
    : entryPrice * (1 - takeProfitPct / 100);

  let exitPrice = null;
  let exitTimestamp = null;
  let exitReason = null;

  for (const candle of futurePrices) {
    const candleTime = candle.timestamp.getTime();

    // Check time barrier first
    if (candleTime >= deadline) {
      exitPrice = candle.price;
      exitTimestamp = candle.timestamp;
      exitReason = "time_limit";
      break;
    }

    // Use high/low for intra-candle barrier checks if available
    const checkHigh = candle.high || candle.price;
    const checkLow = candle.low || candle.price;

    if (direction === "long") {
      // Stop loss: did price drop below stop?
      if (checkLow <= stopPrice) {
        exitPrice = stopPrice;
        exitTimestamp = candle.timestamp;
        exitReason = "stop_loss";
        break;
      }
      // Take profit: did price reach target?
      if (checkHigh >= tpPrice) {
        exitPrice = tpPrice;
        exitTimestamp = candle.timestamp;
        exitReason = "take_profit";
        break;
      }
    } else {
      // Short: stop loss is price going UP
      if (checkHigh >= stopPrice) {
        exitPrice = stopPrice;
        exitTimestamp = candle.timestamp;
        exitReason = "stop_loss";
        break;
      }
      if (checkLow <= tpPrice) {
        exitPrice = tpPrice;
        exitTimestamp = candle.timestamp;
        exitReason = "take_profit";
        break;
      }
    }
  }

  // If no barrier hit, use last available price
  if (!exitPrice && futurePrices.length > 0) {
    const last = futurePrices[futurePrices.length - 1];
    exitPrice = last.price;
    exitTimestamp = last.timestamp;
    exitReason = "end_of_data";
  }

  if (!exitPrice) {
    return null; // No future data to simulate against
  }

  // Compute P&L
  const rawPnlPct = direction === "long"
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;

  const rawPnlBps = rawPnlPct * 100;
  const netPnlBps = rawPnlBps - feeBps;
  const holdTimeMs = exitTimestamp.getTime() - entry.timestamp.getTime();

  return {
    pair: entry.pair,
    signalType: entry.signalType,
    direction,
    confidence: entry.confidence,
    entryPrice,
    entryTimestamp: entry.timestamp,
    exitPrice,
    exitTimestamp,
    exitReason,
    rawPnlBps,
    feeBps,
    netPnlBps,
    holdTimeMs,
    holdTimeMin: Math.round(holdTimeMs / 60000),
    isWin: netPnlBps > 0,
  };
}
