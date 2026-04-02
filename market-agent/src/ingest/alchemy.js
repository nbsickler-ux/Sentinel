import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";
import { createDataPoint } from "../schema.js";
import { cacheKey, cacheSet, CACHE_TTL } from "../cache/redis.js";

const BASE_URL = `https://base-mainnet.g.alchemy.com/v2/${config.alchemy.apiKey}`;

// Token addresses on Base mainnet
const TOKEN_ADDRESSES = {
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  USDC:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ETH:   "0x4200000000000000000000000000000000000006", // WETH
  AERO:  "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
};

// veAERO voting escrow contract on Base mainnet
const VEAERO_ADDRESS = "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4";

// veAERO event signatures (keccak256 of event signature)
const VEAERO_EVENTS = {
  Deposit: "0x4566dfc29f6f11d13a418c26a02bef7c28bae749d4de47e4e6a7cddea6730571",  // Deposit(address,uint256,uint256,int128,uint256)
  Withdraw: "0xf279e6a1f5e320cca91135676d9cb6e44ca8a08c0b88342bcdb1144f6511b568", // Withdraw(address,uint256,uint256,int128,uint256)
};

// Map pair to tokens for transfer monitoring
const PAIR_TOKENS = {
  "cbBTC/USDC": ["cbBTC", "USDC"],
  "ETH/USDC":   ["ETH", "USDC"],
  "AERO/USDC":  ["AERO", "USDC"],
};

/**
 * Fetch recent ERC-20 transfers for a token via Alchemy Transfers API.
 */
async function fetchTransfers(tokenSymbol) {
  const address = TOKEN_ADDRESSES[tokenSymbol];
  if (!address) return [];

  const start = Date.now();
  const { data } = await axios.post(
    BASE_URL,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{
        fromBlock: "latest",
        toBlock: "latest",
        contractAddresses: [address],
        category: ["erc20"],
        maxCount: "0x14", // 20 transfers
        order: "desc",
        withMetadata: true,
      }],
    },
    { timeout: 10000 }
  );

  const transfers = data?.result?.transfers || [];
  return transfers.map((tx) =>
    createDataPoint({
      source: "alchemy",
      pair: null,
      type: "onchain",
      timestamp: tx.metadata?.blockTimestamp
        ? new Date(tx.metadata.blockTimestamp).getTime()
        : Date.now(),
      data: {
        event_type: "transfer",
        token: tokenSymbol,
        token_address: address,
        from: tx.from,
        to: tx.to,
        value: parseFloat(tx.value || 0),
        tx_hash: tx.hash,
        block_number: parseInt(tx.blockNum, 16),
      },
      meta: { api_latency_ms: Date.now() - start },
    })
  );
}

/**
 * Fetch current block number and gas price for Base network health.
 */
async function fetchNetworkStats() {
  const start = Date.now();

  const [blockRes, gasRes] = await Promise.all([
    axios.post(BASE_URL, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { timeout: 5000 }),
    axios.post(BASE_URL, { jsonrpc: "2.0", id: 2, method: "eth_gasPrice", params: [] }, { timeout: 5000 }),
  ]);

  return createDataPoint({
    source: "alchemy",
    pair: null,
    type: "onchain",
    timestamp: Date.now(),
    data: {
      event_type: "network_stats",
      block_number: parseInt(blockRes.data?.result || "0x0", 16),
      gas_price_gwei: parseInt(gasRes.data?.result || "0x0", 16) / 1e9,
      network: "base",
    },
    meta: { api_latency_ms: Date.now() - start },
  });
}

/**
 * Fetch recent veAERO lock/unlock events via eth_getLogs.
 * Monitors the voting escrow contract for Deposit (lock) and Withdraw (unlock) events.
 */
async function fetchVeAeroEvents() {
  const start = Date.now();

  const { data } = await axios.post(
    BASE_URL,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [{
        fromBlock: "latest",
        toBlock: "latest",
        address: VEAERO_ADDRESS,
        topics: [[VEAERO_EVENTS.Deposit, VEAERO_EVENTS.Withdraw]],
      }],
    },
    { timeout: 10000 }
  );

  const logs = data?.result || [];
  return logs.map((log) => {
    const isDeposit = log.topics[0] === VEAERO_EVENTS.Deposit;
    const eventType = isDeposit ? "veaero_lock" : "veaero_unlock";

    // Decode basic fields from log topics and data
    const provider = log.topics[1] ? `0x${log.topics[1].slice(26)}` : null;
    const value = log.data ? parseInt(log.data.slice(0, 66), 16) / 1e18 : 0;

    return createDataPoint({
      source: "alchemy",
      pair: "AERO/USDC",
      type: "onchain",
      timestamp: log.blockNumber ? Date.now() : Date.now(),
      data: {
        event_type: eventType,
        token: "veAERO",
        token_address: VEAERO_ADDRESS,
        from: provider,
        to: VEAERO_ADDRESS,
        value,
        tx_hash: log.transactionHash,
        block_number: parseInt(log.blockNumber, 16),
        is_lock: isDeposit,
      },
      meta: { api_latency_ms: Date.now() - start },
    });
  });
}

/**
 * Ingest all on-chain data.
 */
export async function ingest() {
  if (!config.alchemy.apiKey) {
    logger.warn({ module: "alchemy" }, "ALCHEMY_API_KEY not set — skipping");
    return [];
  }

  const results = [];

  // Network stats
  try {
    const stats = await fetchNetworkStats();
    await cacheSet(cacheKey("onchain", "alchemy", "network_stats"), stats, CACHE_TTL["onchain:alchemy"]);
    results.push(stats);
    logger.info({ module: "alchemy", block: stats.data.block_number }, "Ingested network stats");
  } catch (e) {
    logger.error({ module: "alchemy", err: e.message }, "Network stats failed");
  }

  // Token transfers for each unique token in our pairs
  const seenTokens = new Set();
  for (const pair of config.pairs) {
    const tokens = PAIR_TOKENS[pair] || [];
    for (const token of tokens) {
      if (seenTokens.has(token)) continue;
      seenTokens.add(token);

      try {
        const transfers = await fetchTransfers(token);
        if (transfers.length > 0) {
          await cacheSet(
            cacheKey("onchain", "alchemy", `transfers:${token}`),
            transfers,
            CACHE_TTL["onchain:alchemy"]
          );
          results.push(...transfers);
          logger.info({ module: "alchemy", token, count: transfers.length }, "Ingested transfers");
        }
      } catch (e) {
        logger.error({ module: "alchemy", token, err: e.message }, "Transfer fetch failed");
      }
    }
  }

  // veAERO lock/unlock events (AERO/USDC protocol-native behavioral edge)
  try {
    const veAeroEvents = await fetchVeAeroEvents();
    if (veAeroEvents.length > 0) {
      await cacheSet(
        cacheKey("onchain", "alchemy", "veaero_events"),
        veAeroEvents,
        CACHE_TTL["onchain:alchemy"]
      );
      results.push(...veAeroEvents);
      logger.info({ module: "alchemy", count: veAeroEvents.length }, "Ingested veAERO events");
    }
  } catch (e) {
    logger.error({ module: "alchemy", err: e.message }, "veAERO event fetch failed");
  }

  return results;
}
