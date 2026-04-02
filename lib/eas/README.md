# EAS Attestation Layer

Sentinel records every verification result as an on-chain attestation on Base via [Ethereum Attestation Service (EAS)](https://attest.org).

## Architecture

- **Writes** are post-response (fire-and-forget) — never block the API response
- **Reads** use EAS GraphQL with a 2-second timeout — fast lookup for existing attestations
- **Degradation** is graceful — if EAS is unavailable, verifications proceed normally

## Setup

### 1. Deploy the schema (one-time)

```bash
# Testnet first
SENTINEL_DEPLOYER_KEY=0x... ALCHEMY_API_KEY=... node lib/eas/deploy-schema.js --testnet

# Then mainnet
SENTINEL_DEPLOYER_KEY=0x... ALCHEMY_API_KEY=... node lib/eas/deploy-schema.js
```

Update `SCHEMA_UID` in `lib/eas/config.js` with the returned UID.

### 2. Configure environment

```
SENTINEL_ATTESTATION_KEY=0x...   # Private key for signing attestations
ALCHEMY_API_KEY=...              # Already configured for Sentinel
```

The attestation wallet needs a small ETH balance on Base for gas (~$0.001-$0.01 per attestation).

### 3. Verify

- Check `/health` — `attestation_enabled` should be `true`
- Hit any `/verify/*` endpoint — attestation is written post-response
- Query `GET /attestation/0x...` to see recorded attestations

## Contracts

| Contract | Base Mainnet Address |
|----------|---------------------|
| EAS | `0x4200000000000000000000000000000000000021` |
| SchemaRegistry | `0xA7b39296258348C78294F95B872b282326A97BDF` |

## Gas Budget

~$0.001-$0.01 per attestation. At 100 verifications/day = ~$0.10-$1.00/day.
