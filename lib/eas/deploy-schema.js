#!/usr/bin/env node
// ============================================================
// EAS SCHEMA DEPLOYMENT SCRIPT
// One-time script to register the Sentinel verification schema
// on EAS (Base mainnet or Sepolia testnet).
//
// Usage:
//   SENTINEL_DEPLOYER_KEY=0x... ALCHEMY_API_KEY=... node lib/eas/deploy-schema.js
//   Add --testnet flag for Base Sepolia deployment.
//
// After running, update SCHEMA_UID in lib/eas/config.js with the output UID.
// ============================================================

import { ethers } from "ethers";
import { createRequire } from "module";
import { SCHEMA_REGISTRY, SCHEMA_STRING } from "./config.js";

const require = createRequire(import.meta.url);
const { SchemaRegistry } = require("@ethereum-attestation-service/eas-sdk");

const TESTNET_REGISTRY = "0x4200000000000000000000000000000000000020"; // Base Sepolia
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function main() {
  const isTestnet = process.argv.includes("--testnet");
  const network = isTestnet ? "base-sepolia" : "base-mainnet";
  const registryAddress = isTestnet ? TESTNET_REGISTRY : SCHEMA_REGISTRY;

  const deployerKey = process.env.SENTINEL_DEPLOYER_KEY;
  const alchemyKey = process.env.ALCHEMY_API_KEY;

  if (!deployerKey) {
    console.error("ERROR: SENTINEL_DEPLOYER_KEY environment variable required.");
    console.error("Usage: SENTINEL_DEPLOYER_KEY=0x... ALCHEMY_API_KEY=... node lib/eas/deploy-schema.js [--testnet]");
    process.exit(1);
  }

  if (!alchemyKey) {
    console.error("ERROR: ALCHEMY_API_KEY environment variable required.");
    process.exit(1);
  }

  const rpcUrl = isTestnet
    ? `https://base-sepolia.g.alchemy.com/v2/${alchemyKey}`
    : `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`;

  console.log(`\nEAS Schema Deployment`);
  console.log(`=====================`);
  console.log(`Network:  ${network}`);
  console.log(`Registry: ${registryAddress}`);
  console.log(`Schema:   ${SCHEMA_STRING}`);
  console.log();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(deployerKey, provider);

  console.log(`Deployer: ${signer.address}`);
  const balance = await provider.getBalance(signer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error("ERROR: Deployer wallet has zero ETH balance. Fund it first.");
    process.exit(1);
  }

  const schemaRegistry = new SchemaRegistry(registryAddress);
  schemaRegistry.connect(signer);

  console.log(`\nRegistering schema...`);
  const tx = await schemaRegistry.register({
    schema: SCHEMA_STRING,
    resolverAddress: ZERO_ADDRESS,
    revocable: true,
  });

  console.log(`Transaction submitted. Waiting for confirmation...`);
  const schemaUID = await tx.wait();

  console.log(`\n=== SCHEMA REGISTERED ===`);
  console.log(`Schema UID: ${schemaUID}`);
  console.log(`\nUpdate lib/eas/config.js with this UID:`);
  console.log(`  export const SCHEMA_UID = "${schemaUID}";`);

  if (isTestnet) {
    console.log(`\nVerify on Sepolia: https://base-sepolia.easscan.org/schema/view/${schemaUID}`);
  } else {
    console.log(`\nVerify on Base: https://base.easscan.org/schema/view/${schemaUID}`);
  }
}

main().catch((e) => {
  console.error("Schema deployment failed:", e.message);
  process.exit(1);
});
