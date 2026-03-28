# Sentinel MCP Server — Technical Specification

*Build brief for publishing Sentinel as an MCP server for Claude Desktop, Cursor, and other MCP-compatible AI assistants.*

---

## Overview

The Sentinel MCP server wraps Sentinel's verification endpoints as MCP tools that AI assistants can invoke directly during conversations. This is a fundamentally different integration surface than the raw API: instead of autonomous agents paying USDC per call, a human-in-the-loop AI assistant performs trust lookups on behalf of the user during interactive sessions.

### Key Difference: API vs. MCP

| Dimension | Raw API (x402) | MCP Server |
|-----------|---------------|------------|
| **Consumer** | Autonomous agent | AI assistant (Claude, Cursor, etc.) |
| **Payment** | x402 USDC micropayment per call | Free tier or API key auth (user's Sentinel account) |
| **Invocation** | Programmatic HTTP request | Natural language → tool call |
| **Context** | Agent's decision loop | Human conversation about on-chain activity |
| **Latency tolerance** | Sub-second preferred | 2–5 seconds acceptable (conversational) |
| **Response format** | Raw JSON | Structured for LLM interpretation and summarization |

The MCP server does not replace the x402 API. It's a second integration surface targeting a different user: developers, researchers, and DeFi participants who want to ask their AI assistant "is this contract safe?" during a conversation.

---

## Tools Exposed

### 1. `sentinel_verify_protocol`

**Description:** Check whether a smart contract or protocol on Base is trustworthy. Evaluates audit status, exploit history, TVL health, contract maturity, and governance.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "address": {
      "type": "string",
      "description": "The contract address to verify (0x + 40 hex characters)",
      "pattern": "^0x[a-fA-F0-9]{40}$"
    },
    "chain": {
      "type": "string",
      "enum": ["base", "base-sepolia"],
      "default": "base",
      "description": "Which chain to verify on"
    },
    "detail": {
      "type": "string",
      "enum": ["full", "standard", "minimal"],
      "default": "full",
      "description": "Response detail level"
    }
  },
  "required": ["address"]
}
```

**Output:** Trust verdict, grade, score, confidence, risk flags, and dimensional breakdown. The LLM should summarize the verdict and highlight any risk flags in natural language.

**Example invocation (natural language):**
- "Is this contract safe? 0x2626664c2603336e57b271c5c0b26f421741e481"
- "Check the trust score for Uniswap on Base"
- "Should I interact with this protocol?"

---

### 2. `sentinel_verify_token`

**Description:** Check whether a token on Base is legitimate. Detects honeypots, tax manipulation, ownership concentration, and rugpull patterns.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "address": {
      "type": "string",
      "description": "The token contract address (0x + 40 hex characters)",
      "pattern": "^0x[a-fA-F0-9]{40}$"
    },
    "chain": {
      "type": "string",
      "enum": ["base", "base-sepolia"],
      "default": "base"
    },
    "detail": {
      "type": "string",
      "enum": ["full", "standard", "minimal"],
      "default": "full"
    }
  },
  "required": ["address"]
}
```

**Example invocations:**
- "Is BRETT a safe token?"
- "Check this token for rugpull risk: 0x532f..."
- "Can I trust this token before swapping?"

---

### 3. `sentinel_verify_position`

**Description:** Analyze the safety of a DeFi position. Evaluates protocol trust, category risk, TVL health, and concentration risk.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "protocol": {
      "type": "string",
      "description": "The protocol contract address",
      "pattern": "^0x[a-fA-F0-9]{40}$"
    },
    "user": {
      "type": "string",
      "description": "Optional user wallet address for position-specific analysis",
      "pattern": "^0x[a-fA-F0-9]{40}$"
    },
    "chain": {
      "type": "string",
      "enum": ["base", "base-sepolia"],
      "default": "base"
    },
    "detail": {
      "type": "string",
      "enum": ["full", "standard", "minimal"],
      "default": "full"
    }
  },
  "required": ["protocol"]
}
```

**Example invocations:**
- "Is my position in this lending protocol safe?"
- "Analyze the risk of this DeFi position"

---

### 4. `sentinel_verify_counterparty`

**Description:** Check whether a wallet address is safe to interact with. Screens against OFAC sanctions, checks contract verification status, exploit association, wallet age, and activity patterns.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "address": {
      "type": "string",
      "description": "The wallet or contract address to screen",
      "pattern": "^0x[a-fA-F0-9]{40}$"
    },
    "chain": {
      "type": "string",
      "enum": ["base", "base-sepolia"],
      "default": "base"
    },
    "detail": {
      "type": "string",
      "enum": ["full", "standard", "minimal"],
      "default": "full"
    }
  },
  "required": ["address"]
}
```

**Example invocations:**
- "Is this wallet sanctioned? 0x..."
- "Check if this address is safe to send tokens to"
- "Screen this counterparty before I trade with them"

---

### 5. `sentinel_preflight`

**Description:** Comprehensive pre-transaction safety check. Runs protocol, token, counterparty, and position verification in parallel and returns a unified go/no-go recommendation.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "The primary contract address for the transaction",
      "pattern": "^0x[a-fA-F0-9]{40}$"
    },
    "token": {
      "type": "string",
      "description": "Optional token address involved in the transaction",
      "pattern": "^0x[a-fA-F0-9]{40}$"
    },
    "counterparty": {
      "type": "string",
      "description": "Optional counterparty wallet address",
      "pattern": "^0x[a-fA-F0-9]{40}$"
    },
    "chain": {
      "type": "string",
      "enum": ["base", "base-sepolia"],
      "default": "base"
    },
    "detail": {
      "type": "string",
      "enum": ["full", "standard", "minimal"],
      "default": "full"
    }
  },
  "required": ["target"]
}
```

**Example invocations:**
- "Should I execute this swap? Target contract is 0x..., token is 0x..."
- "Run a full safety check before I enter this position"
- "Preflight check on this transaction"

---

## Authentication Model

The MCP server cannot use x402 (MCP tool calls don't go through an HTTP 402 flow). Two options:

### Option A: API Key Authentication (Recommended)

- User registers on Sentinel and receives an API key
- API key is configured in the MCP server settings (Claude Desktop config, Cursor settings)
- Sentinel validates the key and tracks usage against a quota
- Free tier: 25 calls/day. Paid tiers scale from there.

### Option B: Wallet-Based Authentication

- User configures their wallet address in the MCP server
- MCP server signs a session token on startup
- Sentinel validates the signature and allows calls against the wallet's quota
- More web3-native but higher friction for non-crypto users

**Recommendation:** Start with Option A. API key auth is familiar to the MCP audience (developers using Claude Desktop and Cursor). The wallet-based model can be added later for web3-native users.

---

## Implementation Architecture

```
User (Claude Desktop / Cursor)
  ↓ natural language
AI Assistant
  ↓ MCP tool call
Sentinel MCP Server (local process)
  ↓ HTTP POST with API key header
Sentinel API (sentinel-awms.onrender.com)
  ↓ response
Sentinel MCP Server
  ↓ structured tool result
AI Assistant
  ↓ natural language summary
User
```

The MCP server is a lightweight Node.js process running locally. It:

1. Receives tool calls from the AI assistant via MCP protocol (stdio or SSE transport)
2. Validates input parameters
3. Makes HTTP POST requests to the Sentinel API with the user's API key
4. Returns structured results for the LLM to interpret

### File Structure

```
sentinel-mcp/
├── package.json
├── index.js              # MCP server entry point
├── tools/
│   ├── verify-protocol.js
│   ├── verify-token.js
│   ├── verify-position.js
│   ├── verify-counterparty.js
│   └── preflight.js
├── lib/
│   └── sentinel-client.js  # HTTP client for Sentinel API
└── README.md
```

### MCP Server Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "sentinel": {
      "command": "node",
      "args": ["/path/to/sentinel-mcp/index.js"],
      "env": {
        "SENTINEL_API_KEY": "sk_..."
      }
    }
  }
}
```

---

## Response Formatting for LLMs

The MCP server should return structured content that helps the LLM produce good natural language summaries. Each tool result should include:

1. **Verdict summary** — A one-sentence assessment (e.g., "This protocol is rated SAFE with a trust grade of A and 95% confidence.")
2. **Risk flags** — Bulleted list of specific concerns, if any
3. **Recommendation** — Clear action guidance (proceed, proceed with caution, do not proceed)
4. **Raw data** — The full JSON response for the LLM to reference if the user asks follow-up questions

Example tool result:

```json
{
  "content": [
    {
      "type": "text",
      "text": "## Sentinel Verification: Protocol\n\n**Verdict:** SAFE (Grade A, Score 88/100, Confidence 95%)\n\n**Risk Flags:** None detected\n\n**Recommendation:** This protocol appears safe to interact with. Audited, verified source code, healthy TVL, no exploit history.\n\n**Details:**\n- Audit: Verified (score 90)\n- Exploit History: Clean (score 95)\n- Contract Maturity: 14 months deployed (score 85)\n- TVL Health: $45M (score 88)\n- Governance: On-chain governance active (score 80)"
    }
  ]
}
```

---

## Server-Side Changes Required

To support MCP server authentication, Sentinel's API needs a parallel auth path:

1. **API key middleware** — Accept `Authorization: Bearer sk_...` header as an alternative to x402 payment
2. **Key management** — Simple key issuance and quota tracking (can use Upstash Redis, already in the stack)
3. **Usage metering** — Track calls per key per day, enforce quotas
4. **Bypass x402 for authenticated requests** — If a valid API key is present, skip the 402 payment flow and serve the response directly

This is a net-new auth layer that runs alongside x402, not a replacement.

---

## Build Priorities

1. **Phase 1:** Ship the MCP server with the five core tools, API key auth, and Claude Desktop/Cursor support
2. **Phase 2:** Add caching at the MCP layer (avoid re-querying Sentinel for the same address within a session)
3. **Phase 3:** Add conversational context — let the LLM build up a "trust portfolio" during a conversation (e.g., "check all the contracts I've mentioned so far")
4. **Phase 4:** Wallet-based auth option for web3-native users

---

## Success Metrics

- Number of MCP server installations (via npm downloads or GitHub clones)
- Daily active tool invocations
- Conversion from free tier to paid
- User retention at 7 and 30 days
