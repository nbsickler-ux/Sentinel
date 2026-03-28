#!/usr/bin/env node
// ============================================================
// x402 Payment Client — Trigger a real paid request to Sentinel
// ============================================================
// Usage:
//   PRIVATE_KEY=0x... node scripts/pay-test.js
//
// Requirements:
//   - A wallet with USDC on Base mainnet (even $0.01 is enough)
//   - The wallet must have approved Permit2 for USDC spending
//     (the script will tell you if this is needed)
// ============================================================

import { createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient, decodePaymentRequiredHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

// ---- Configuration ----
const SENTINEL_URL = "https://sentinel-awms.onrender.com";
const ENDPOINT = "/verify/token";
const BODY = JSON.stringify({
  address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
  chain: "base",
  detail: "minimal",
});

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("❌ Set PRIVATE_KEY env var (with 0x prefix)");
  process.exit(1);
}

// ---- Wallet Setup ----
const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(),
});

console.log(`🔑 Wallet: ${account.address}`);
console.log(`🎯 Target: ${SENTINEL_URL}${ENDPOINT}`);
console.log(`💰 Price:  $0.005 USDC (token verification)\n`);

// ---- x402 Client Setup ----
// The EVM scheme expects signer.address at the top level,
// but viem's walletClient stores it at walletClient.account.address.
walletClient.address = account.address;

const client = new x402Client();
registerExactEvmScheme(client, {
  signer: walletClient,
});

const httpClient = new x402HTTPClient(client);

// ---- Make the paid request ----
async function main() {
  try {
    // Step 1: Initial request — expect 402
    console.log("📡 Sending initial request...");
    const initialResponse = await fetch(`${SENTINEL_URL}${ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: BODY,
    });

    if (initialResponse.status !== 402) {
      console.log(`⚠️  Got status ${initialResponse.status} (expected 402)`);
      const text = await initialResponse.text();
      console.log(text);
      return;
    }

    console.log("✅ Got 402 Payment Required — signing payment...\n");

    // Step 2: Extract payment requirements from 402 response
    const paymentRequiredHeader =
      initialResponse.headers.get("PAYMENT-REQUIRED") ||
      initialResponse.headers.get("payment-required");

    if (!paymentRequiredHeader) {
      // Try v1 format — body-based
      const body = await initialResponse.json();
      console.log("Payment requirements (body):", JSON.stringify(body, null, 2));
      return;
    }

    // Decode the payment requirements
    const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);

    console.log("📋 Payment details (raw):");
    console.log(JSON.stringify(paymentRequired, null, 2).slice(0, 2000));
    console.log();

    // Fix any non-checksummed addresses in the payment requirements
    // viem is strict about EIP-55 checksums
    if (paymentRequired.accepts) {
      for (const req of paymentRequired.accepts) {
        if (req.payTo) {
          try { req.payTo = getAddress(req.payTo); } catch {}
        }
        if (req.asset) {
          try { req.asset = getAddress(req.asset); } catch {}
        }
        // Also check nested fields
        if (req.extra) {
          for (const [k, v] of Object.entries(req.extra)) {
            if (typeof v === "string" && v.startsWith("0x") && v.length === 42) {
              try { req.extra[k] = getAddress(v); } catch {}
            }
          }
        }
      }
    }

    // Step 3: Create signed payment payload
    console.log("✍️  Creating payment payload...");
    const paymentPayload = await httpClient.client.createPaymentPayload(paymentRequired);

    // Step 4: Encode payment into headers
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    // Step 5: Retry with payment
    console.log("💸 Sending paid request...\n");
    const paidResponse = await fetch(`${SENTINEL_URL}${ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...paymentHeaders,
      },
      body: BODY,
    });

    console.log(`📬 Response: ${paidResponse.status}`);

    if (paidResponse.ok) {
      const result = await paidResponse.json();
      console.log("\n🎉 SUCCESS — First paid x402 transaction complete!\n");
      console.log(JSON.stringify(result, null, 2));

      // Check for settlement header
      const settlementHeader =
        paidResponse.headers.get("PAYMENT-RESPONSE") ||
        paidResponse.headers.get("payment-response");
      if (settlementHeader) {
        console.log("\n📜 Settlement:", settlementHeader);
      }
    } else {
      const errorText = await paidResponse.text();
      console.log("❌ Payment failed:", errorText);
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
    if (err.message.includes("allowance") || err.message.includes("permit") || err.message.includes("Permit2")) {
      console.log("\n💡 You may need to approve USDC for Permit2 first.");
      console.log("   Visit https://app.uniswap.org and do any small swap to trigger the Permit2 approval,");
      console.log("   or manually approve the Permit2 contract (0x000000000022D473030F116dDEE9F6B43aC78BA3)");
      console.log("   for USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) on Base.");
    }
  }
}

main();
