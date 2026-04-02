// ============================================================
// EAS CLIENT MODULE
// Handles reading and writing Sentinel verification attestations.
//
// Architecture:
//   - Writes: POST-RESPONSE path (fire-and-forget, never blocks response)
//   - Reads: GraphQL queries with 2s timeout (fast lookup for existing attestations)
//   - Graceful degradation: if EAS is unavailable, verifications proceed normally
// ============================================================

import { ethers } from "ethers";
import { createRequire } from "module";
import axios from "axios";
import { EAS_CONTRACT, SCHEMA_UID, SCHEMA_STRING, EAS_GRAPHQL, FRESHNESS } from "./config.js";

// EAS SDK uses extensionless ESM imports which fail under Node's strict resolver.
// Use createRequire to load it via CommonJS path.
const require = createRequire(import.meta.url);
const { EAS, SchemaEncoder } = require("@ethereum-attestation-service/eas-sdk");

let eas = null;
let signer = null;
let signerAddress = null;
let easEnabled = false;
let provider = null;

/**
 * Initialize the EAS SDK with provider and signer.
 * Fails gracefully — attestation writes are disabled if no key is available.
 * GraphQL reads still work without a signer.
 *
 * @param {Object} logger - Pino logger instance
 * @returns {boolean} Whether write capability is enabled
 */
export async function initEAS(logger) {
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const attestationKey = process.env.SENTINEL_ATTESTATION_KEY;

  if (!alchemyKey) {
    logger.warn({ module: "eas" }, "ALCHEMY_API_KEY not set — EAS provider disabled");
    return false;
  }

  provider = new ethers.JsonRpcProvider(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`);

  if (!attestationKey) {
    logger.warn({ module: "eas" }, "SENTINEL_ATTESTATION_KEY not set — attestation writes disabled (reads via GraphQL still work)");
    return false;
  }

  try {
    signer = new ethers.Wallet(attestationKey, provider);
    signerAddress = signer.address;

    eas = new EAS(EAS_CONTRACT);
    eas.connect(signer);

    // Check gas balance
    const balance = await provider.getBalance(signerAddress);
    const balanceEth = parseFloat(ethers.formatEther(balance));

    if (balanceEth < 0.01) {
      logger.warn({ module: "eas", balance: balanceEth, address: signerAddress }, "Low ETH balance for attestation gas — consider topping up");
    }

    easEnabled = true;
    logger.info({ module: "eas", address: signerAddress, balance: balanceEth.toFixed(4) }, "EAS attestation layer initialized (writes enabled)");
    return true;
  } catch (e) {
    logger.error({ module: "eas", err: e.message }, "EAS initialization failed — attestations disabled");
    return false;
  }
}

/**
 * Check if EAS write capability is enabled.
 */
export function isEASEnabled() {
  return easEnabled;
}

/**
 * Write a verification attestation to EAS (fire-and-forget).
 * MUST be called post-response — never blocks the API response.
 *
 * @param {Object} data - Attestation data fields
 * @param {Object} logger - Pino logger instance
 * @returns {string|null} Attestation UID, or null on failure
 */
export async function createVerificationAttestation(data, logger) {
  if (!eas || !easEnabled) return null;

  if (SCHEMA_UID === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    logger.debug({ module: "eas" }, "Schema UID not set — skipping attestation write");
    return null;
  }

  try {
    const encoder = new SchemaEncoder(SCHEMA_STRING);
    const encodedData = encoder.encodeData([
      { name: "target", value: data.target, type: "address" },
      { name: "chain", value: data.chain, type: "string" },
      { name: "endpointType", value: data.endpointType, type: "string" },
      { name: "trustScore", value: data.trustScore, type: "uint8" },
      { name: "verdict", value: data.verdict, type: "string" },
      { name: "trustGrade", value: data.trustGrade, type: "string" },
      { name: "proceed", value: data.proceed, type: "bool" },
      { name: "riskFlags", value: data.riskFlags || "", type: "string" },
      { name: "timestamp", value: data.timestamp, type: "uint64" },
      { name: "x402PaymentId", value: data.x402PaymentId || 0, type: "uint256" },
    ]);

    const tx = await eas.attest({
      schema: SCHEMA_UID,
      data: {
        recipient: data.target,
        expirationTime: 0n,
        revocable: true,
        data: encodedData,
      },
    });

    const uid = await tx.wait();
    logger.info({ module: "eas", uid, target: data.target, endpointType: data.endpointType }, "Attestation written");
    return uid;
  } catch (e) {
    logger.error({ module: "eas", err: e.message, target: data.target }, "Attestation write failed");
    return null;
  }
}

/**
 * Read the most recent valid attestation for a target from EAS GraphQL.
 * HOT PATH — has a 2-second timeout. Returns null on any failure.
 *
 * @param {string} target - Address to look up
 * @param {string} chain - Chain identifier
 * @param {string} endpointType - Endpoint type filter
 * @returns {Object|null} Decoded attestation data, or null
 */
export async function getExistingAttestation(target, chain, endpointType) {
  if (SCHEMA_UID === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    return null;
  }

  const freshnessSeconds = FRESHNESS[endpointType] || FRESHNESS.protocol;
  const minTimestamp = Math.floor(Date.now() / 1000) - freshnessSeconds;

  try {
    const query = `
      query GetAttestations($where: AttestationWhereInput) {
        attestations(where: $where, orderBy: [{ time: desc }], take: 1) {
          id
          attester
          recipient
          time
          decodedDataJson
        }
      }
    `;

    const variables = {
      where: {
        schemaId: { equals: SCHEMA_UID },
        recipient: { equals: target.toLowerCase() },
        time: { gte: minTimestamp },
        revoked: { equals: false },
        ...(signerAddress ? { attester: { equals: signerAddress } } : {}),
      },
    };

    const response = await axios.post(EAS_GRAPHQL, { query, variables }, { timeout: 2000 });
    const attestations = response.data?.data?.attestations;

    if (!attestations || attestations.length === 0) return null;

    const att = attestations[0];
    const decoded = JSON.parse(att.decodedDataJson);

    // Verify chain and endpointType match from decoded data
    const decodedMap = {};
    for (const field of decoded) {
      decodedMap[field.name] = field.value?.value ?? field.value;
    }

    if (decodedMap.chain !== chain || decodedMap.endpointType !== endpointType) {
      return null;
    }

    return {
      uid: att.id,
      attester: att.attester,
      target: att.recipient,
      chain: decodedMap.chain,
      endpointType: decodedMap.endpointType,
      trustScore: parseInt(decodedMap.trustScore, 10),
      verdict: decodedMap.verdict,
      trustGrade: decodedMap.trustGrade,
      proceed: decodedMap.proceed,
      riskFlags: decodedMap.riskFlags,
      timestamp: parseInt(decodedMap.timestamp, 10),
      time: att.time,
    };
  } catch (e) {
    // Timeout or error — fall through silently
    return null;
  }
}

/**
 * Get all Sentinel attestations for a target address.
 *
 * @param {string} target - Address to look up
 * @returns {Object[]} Array of decoded attestations
 */
export async function getAttestationsByTarget(target) {
  if (SCHEMA_UID === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    return [];
  }

  try {
    const query = `
      query GetAttestations($where: AttestationWhereInput) {
        attestations(where: $where, orderBy: [{ time: desc }], take: 50) {
          id
          attester
          recipient
          time
          decodedDataJson
          revoked
        }
      }
    `;

    const variables = {
      where: {
        schemaId: { equals: SCHEMA_UID },
        recipient: { equals: target.toLowerCase() },
        revoked: { equals: false },
        ...(signerAddress ? { attester: { equals: signerAddress } } : {}),
      },
    };

    const response = await axios.post(EAS_GRAPHQL, { query, variables }, { timeout: 5000 });
    const attestations = response.data?.data?.attestations;

    if (!attestations) return [];

    return attestations.map((att) => {
      const decoded = JSON.parse(att.decodedDataJson);
      const decodedMap = {};
      for (const field of decoded) {
        decodedMap[field.name] = field.value?.value ?? field.value;
      }

      return {
        uid: att.id,
        endpointType: decodedMap.endpointType,
        trustScore: parseInt(decodedMap.trustScore, 10),
        verdict: decodedMap.verdict,
        trustGrade: decodedMap.trustGrade,
        proceed: decodedMap.proceed,
        riskFlags: decodedMap.riskFlags,
        timestamp: parseInt(decodedMap.timestamp, 10),
        age_hours: Math.round((Date.now() / 1000 - parseInt(decodedMap.timestamp, 10)) / 3600 * 10) / 10,
      };
    });
  } catch (e) {
    return [];
  }
}
