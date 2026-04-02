// ============================================================
// EAS CONFIGURATION
// Contract addresses and schema UID for Base mainnet.
// Schema UID is set after running deploy-schema.js.
// ============================================================

// Base mainnet EAS contract addresses (official)
// Ref: https://docs.attest.org/docs/quick--start/contracts
export const EAS_CONTRACT = "0x4200000000000000000000000000000000000021";
export const SCHEMA_REGISTRY = "0xA7b39296258348C78294F95B872b282326A97BDF";

// GraphQL endpoint for reading attestations (faster than on-chain calls)
export const EAS_GRAPHQL = "https://base.easscan.org/graphql";

// Schema UID — set after running: node lib/eas/deploy-schema.js
// Update this value with the UID returned by the deployment script.
export const SCHEMA_UID = "0x0000000000000000000000000000000000000000000000000000000000000000";

// Schema string registered on EAS
export const SCHEMA_STRING = "address target, string chain, string endpointType, uint8 trustScore, string verdict, string trustGrade, bool proceed, string riskFlags, uint64 timestamp, uint256 x402PaymentId";

// ERC-8004 COMPATIBILITY NOTES
// When ERC-8004 finalizes, Sentinel will:
// 1. Check the Agent Registry contract to verify agent identity
// 2. Issue on-chain trust scores via the Trust Score interface
// 3. Accept delegated trust checks from registered agents
// 4. Map our tier system to ERC-8004 trust levels
// Tracking: https://eips.ethereum.org/EIPS/eip-8004

// Attestation freshness windows (seconds)
export const FRESHNESS = {
  protocol: 24 * 60 * 60,     // 24 hours
  counterparty: 24 * 60 * 60, // 24 hours
  token: 60 * 60,             // 1 hour
  position: 60 * 60,          // 1 hour
  preflight: 5 * 60,          // 5 minutes
};
