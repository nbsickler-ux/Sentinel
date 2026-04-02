import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, Header, Footer,
        AlignmentType, WidthType, ShadingType, BorderStyle, HeadingLevel, LevelFormat,
        PageBreak, PageNumber, TableOfContents } from 'docx';
import fs from 'fs';

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

const darkBlue = "1F3864";
const contentWidth = 9360; // US Letter (12240) - 2x1440 margins

function createTableCell(text, isBold = false, isHeader = false) {
  return new TableCell({
    borders,
    width: { size: contentWidth / 2, type: WidthType.DXA },
    shading: { fill: isHeader ? "D5E8F0" : "FFFFFF", type: ShadingType.CLEAR },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({
      children: [new TextRun({
        text: text,
        bold: isBold || isHeader,
        font: "Arial",
        size: 22
      })]
    })]
  });
}

function createTableCellWide(text, isBold = false, isHeader = false) {
  return new TableCell({
    borders,
    width: { size: contentWidth, type: WidthType.DXA },
    shading: { fill: isHeader ? "D5E8F0" : "FFFFFF", type: ShadingType.CLEAR },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({
      children: [new TextRun({
        text: text,
        bold: isBold || isHeader,
        font: "Arial",
        size: 22
      })]
    })]
  });
}

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: "Arial", size: 24 }
      }
    },
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 32, bold: true, font: "Arial", color: darkBlue },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 }
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: darkBlue },
        paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 1 }
      },
      {
        id: "Heading3",
        name: "Heading 3",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: darkBlue },
        paragraph: { spacing: { before: 120, after: 80 }, outlineLevel: 2 }
      }
    ]
  },
  numbering: {
    config: [
      {
        reference: "numbered",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } }
          }
        ]
      }
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          children: [new TextRun({
            text: "SENTINEL — Lean Architecture for Layer Expansion",
            font: "Arial",
            size: 22,
            color: darkBlue,
            bold: true
          })]
        })]
      })
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: "Page ",
              font: "Arial",
              size: 22
            }),
            new TextRun({
              children: [PageNumber.CURRENT],
              font: "Arial",
              size: 22
            })
          ]
        })]
      })
    },
    children: [
      // Title
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({
          text: "SENTINEL",
          bold: true,
          size: 36,
          font: "Arial",
          color: darkBlue
        })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({
          text: "Lean Architecture for Layer Expansion",
          size: 28,
          font: "Arial",
          color: darkBlue
        })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [new TextRun({
          text: "Design Principles, Request Flow, and Implementation Specification",
          size: 24,
          font: "Arial",
          italic: true
        })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [new TextRun({
          text: "April 2, 2026",
          size: 22,
          font: "Arial"
        })]
      }),

      // Table of Contents
      new Paragraph({ children: [new PageBreak()] }),
      new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
      new Paragraph({ children: [new PageBreak()] }),

      // SECTION 1: Design Philosophy
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun("Design Philosophy")]
      }),
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun("Every new layer must pass the \"net load\" test before it is approved for implementation. This document formalizes Sentinel\'s architectural principles to prevent overfit as the system expands from five verification endpoints to a comprehensive trust infrastructure.")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("The Net Load Test")]
      }),
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun("Every proposed addition must answer four questions:")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Does it reduce total external API calls for repeat queries? (Approve)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Does it replace an existing data source with a better one? (Approve)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Does it add to the hot path between request and response? (Reject — move to async post-response)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("Does it create a new single point of failure? (Reject — must have fallback or graceful degradation)")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Core Metrics")]
      }),
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun("Three metrics govern all architecture decisions, in priority order:")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Speed: ",
          bold: true
        }), new TextRun("Sub-500ms target for cache/attestation hits. Sub-5s for full verifications. The current worst case (preflight with all params) is approximately 15 seconds on cache miss after the April 2 deduplication fix; it was approximately 25 seconds before.")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Security: ",
          bold: true
        }), new TextRun("Zero false positives on sanctions screening. Graceful degradation with confidence penalties when data sources fail. Never return fake data.")]
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun({
          text: "Accuracy: ",
          bold: true
        }), new TextRun("Multi-source verification with independent signals. Redundancy where sources provide genuinely different data (e.g., DeFiLlama exploit history plus GoPlus honeypot detection). No redundancy where sources overlap (e.g., the removed mock data fallback).")]
      }),

      // SECTION 2: Current Architecture
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun("Current Architecture (Post-April 2 Fixes)")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("External Dependencies")]
      }),
      new Table({
        width: { size: contentWidth, type: WidthType.DXA },
        columnWidths: [1872, 1872, 1872, 1872],
        rows: [
          new TableRow({
            children: [
              createTableCell("Source", true, true),
              createTableCell("Endpoints Used", true, true),
              createTableCell("Calls Per Request", true, true),
              createTableCell("Timeout", true, true)
            ]
          }),
          new TableRow({
            children: [
              createTableCell("DeFiLlama"),
              createTableCell("/protocols (startup), /protocol/slug (per-request)"),
              createTableCell("1-2"),
              createTableCell("5-15s")
            ]
          }),
          new TableRow({
            children: [
              createTableCell("GoPlus Security"),
              createTableCell("/token_security, /address_security"),
              createTableCell("1-2"),
              createTableCell("8s")
            ]
          }),
          new TableRow({
            children: [
              createTableCell("Etherscan V2"),
              createTableCell("getsourcecode, getcontractcreation, getTxByHash, getBlockByNumber"),
              createTableCell("4 chained"),
              createTableCell("5s each")
            ]
          }),
          new TableRow({
            children: [
              createTableCell("Alchemy"),
              createTableCell("eth_getCode"),
              createTableCell("1"),
              createTableCell("5s")
            ]
          }),
          new TableRow({
            children: [
              createTableCell("OFAC (GitHub)"),
              createTableCell("sanctioned_addresses_ETH.txt"),
              createTableCell("1 + fallback"),
              createTableCell("10s")
            ]
          })
        ]
      }),
      new Paragraph({ spacing: { after: 240 }, children: [new TextRun("")] }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Request Flow (Current)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("/verify/protocol: 4-5 parallel calls (audit, exploit, contract metadata, TVL). Cached 10 min.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("/verify/token: 2 parallel calls (GoPlus security, DeFiLlama market). Cached 5 min.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("/verify/position: Delegates to scoreProtocol internally + TVL. Cached 5 min.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("/verify/counterparty: 3 parallel calls (OFAC in-memory, GoPlus address, exploit registry). Cached 15 min.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("/preflight: Calls scoreProtocol ONCE (fixed April 2), then runs token + counterparty + position in parallel. Position receives pre-computed protocol score. NOT cached (should be).")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Identified Inefficiencies (Remaining)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Etherscan V2 makes 4 sequential calls to determine contract age. No caching. Should be cached 24h minimum.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Preflight results not cached at all. Should cache composite for 5 min.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("GoPlus has no fallback for token security or address reputation. Single point of failure.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("Protocol registry loaded at startup, never refreshed. New protocols not recognized until restart.")]
      }),

      // SECTION 3: Three-Path Architecture
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun("Three-Path Architecture")]
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun("All operations in the expanded Sentinel system must be classified into exactly one of three paths. No operation may span multiple paths.")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Hot Path (Request to Response)")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Definition: ",
          bold: true
        }), new TextRun("Everything between receiving an HTTP request and sending the HTTP response. This is the latency-critical path. Target: sub-500ms for attestation/cache hits, sub-5s for full verifications.")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "What belongs here:",
          bold: true
        })]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Redis cache lookup")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("EAS attestation read (new: if a valid recent attestation exists for this address+chain, return cached verdict immediately)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Scoring engine computation")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 80 },
        children: [new TextRun("Response formatting and filtering")]
      }),
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({
          text: "What NEVER belongs here:",
          bold: true
        })]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Writing attestations to chain")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Updating reputation scores")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Logging to audit trail")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Firing monitoring webhooks")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("Any write operation")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Post-Response Path (Async, Fire-and-Forget)")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Definition: ",
          bold: true
        }), new TextRun("Operations triggered after the response has been sent to the client. These are non-blocking and do not affect response latency. They execute via setImmediate or process.nextTick after res.json().")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "What belongs here:",
          bold: true
        })]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Write EAS attestation to chain (if verification produced a new result)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Update agent reputation score based on this verification")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Append to compliance audit trail (Postgres)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Evaluate monitoring subscriptions and fire webhooks if risk state changed")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 80 },
        children: [new TextRun("Log request to analytics")]
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun({
          text: "Failure handling: ",
          bold: true
        }), new TextRun("Post-response operations fail silently with logging. They NEVER affect the hot path. If an attestation write fails, the verification result was still delivered. Retry via background job.")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Background Path (Periodic, Not Per-Request)")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Definition: ",
          bold: true
        }), new TextRun("Operations that run on a schedule, not triggered by individual requests.")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "What belongs here:",
          bold: true
        })]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Protocol registry refresh (every 24 hours)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("OFAC sanctions list refresh (every 24 hours)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Reputation score batch computation (aggregate across all verified transactions)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Monitoring subscription evaluation (periodic health checks on subscribed positions)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Attestation garbage collection (mark expired attestations)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("Cache warming (pre-compute verifications for frequently queried addresses)")]
      }),

      // SECTION 4: Layer Expansion Map
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun("Layer Expansion Map")]
      }),
      new Table({
        width: { size: contentWidth, type: WidthType.DXA },
        columnWidths: [1872, 1872, 1872, 1872],
        rows: [
          new TableRow({
            children: [
              createTableCell("Proposed Layer", true, true),
              createTableCell("What It Replaces", true, true),
              createTableCell("Path Classification", true, true),
              createTableCell("Priority", true, true)
            ]
          }),
          new TableRow({
            children: [
              createTableCell("EAS Attestations"),
              createTableCell("Redis cache for cross-agent queries. Agents reading a recent attestation skip full re-verification."),
              createTableCell("Hot path: read attestation. Post-response: write attestation."),
              createTableCell("Tier 1")
            ]
          }),
          new TableRow({
            children: [
              createTableCell("Reputation Registry"),
              createTableCell("Full verification depth for trusted agents. High-reputation agents get tiered verification."),
              createTableCell("Hot path: read tier. Post-response: update. Background: compute."),
              createTableCell("Tier 1")
            ]
          }),
          new TableRow({
            children: [
              createTableCell("Monitoring Webhooks"),
              createTableCell("Polling pattern. Push alerts only when risk state changes."),
              createTableCell("Post-response: evaluate. Background: health checks."),
              createTableCell("Tier 1")
            ]
          }),
          new TableRow({
            children: [
              createTableCell("Compliance Audit Trail"),
              createTableCell("Pure addition. Write-only append to DB/chain."),
              createTableCell("Post-response: append. Background: generate reports."),
              createTableCell("Tier 2")
            ]
          }),
          new TableRow({
            children: [
              createTableCell("Insurance Integration"),
              createTableCell("Reads existing reputation + attestation data."),
              createTableCell("Background: compute premium tiers."),
              createTableCell("Tier 2")
            ]
          }),
          new TableRow({
            children: [
              createTableCell("Multi-Chain Expansion"),
              createTableCell("Shares cross-chain data (OFAC list, reputation)."),
              createTableCell("All three paths, per chain."),
              createTableCell("Tier 3")
            ]
          })
        ]
      }),
      new Paragraph({ spacing: { after: 240 }, children: [new TextRun("")] }),

      // SECTION 5: EAS Attestation
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun("EAS Attestation as Smart Cache")]
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun("The key architectural insight: EAS attestations are not just receipts — they are the caching and fast-path layer for the entire system. They replace Redis for high-value, cross-agent queries.")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Why Attestations Beat Redis Cache")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Redis cache: ",
          bold: true
        }), new TextRun("Per-Sentinel-instance, ephemeral, lost on restart, not verifiable by third parties, TTL-based expiry.")]
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun({
          text: "EAS attestation: ",
          bold: true
        }), new TextRun("On-chain on Base, permanent, verifiable by any party, cryptographically signed by Sentinel, queryable by any agent. An attestation saying \"Aerodrome Router scored A/SAFE on April 2, 2026 with confidence 0.85\" is verifiable proof — not just a cached value.")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Attestation-First Request Flow")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun("When a request arrives at any verification endpoint:")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Check: Does a valid, non-expired EAS attestation exist for this address+chain?")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("If YES: Return attestation data immediately (sub-100ms). No external API calls.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 120 },
        children: [new TextRun("If NO: Run full verification pipeline (current flow). After response sent, write new attestation (post-response path).")]
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun({
          text: "Attestation validity window: ",
          bold: true
        }), new TextRun("configurable per endpoint. Protocol attestations valid 24h. Token attestations valid 1h. Counterparty attestations valid 4h.")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Schema Design")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "EAS Schema (on Base):",
          bold: true
        })]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("issuer: Sentinel\'s address")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("agent: address (the agent that requested verification)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("target: address (the contract/token/counterparty verified)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("endpoint: string (protocol, token, position, counterparty, preflight)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("verdict: string (SAFE, LOW_RISK, CAUTION, HIGH_RISK, DANGER)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("riskScore: uint8 (0-100)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("confidence: uint8 (0-100, stored as integer for gas efficiency)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("verificationTimestamp: uint64")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("expiresAt: uint64")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("x402 Receipt Binding")]
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun("Leverages the Signed Receipt extension (PR #935 on coinbase/x402). Each x402 payment receipt is cryptographically bound to the Sentinel attestation UID. This proves: (a) payment was made, (b) verification was performed, (c) the specific verdict was issued. All three facts are independently verifiable on-chain.")]
      }),

      // SECTION 6: Reputation-Gated Verification
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun("Reputation-Gated Verification Tiers")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Tier Definitions")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Tier 1 — Unknown Agent: ",
          bold: true
        }), new TextRun("Full verification. All external API calls. Highest latency, highest cost.")]
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Tier 2 — Recognized Agent: ",
          bold: true
        }), new TextRun("10+ successful verifications. Skip redundant data sources. Use attestation cache aggressively. Moderate latency.")]
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun({
          text: "Tier 3 — Trusted Agent: ",
          bold: true
        }), new TextRun("100+ verifications, 95%+ success rate. Attestation-only fast path. Minimal external calls. Lowest latency. May qualify for reduced x402 pricing.")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("How Reputation Reduces Load")]
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun("A Tier 3 agent verifying Aerodrome Router (with a 24h-valid attestation) gets: 1 attestation read, 0 external API calls, sub-100ms response. Compare to a Tier 1 agent checking an unknown contract: 8-10 external API calls, 5-15s response. Same endpoint, same price, vastly different resource consumption. This creates a natural incentive: agents that use Sentinel more get faster responses. Network effect — more agents means more attestations means faster lookups for everyone.")]
      }),

      // SECTION 7: Implementation Sequence
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun("Implementation Sequence")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Phase 0 — Finish Current Fixes (This Week)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Add 24h Redis cache for Etherscan contract metadata")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Add 5-min cache for /preflight composite results")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Add daily refresh for protocol registry")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("Let paper trading accumulate 20-30 closed trades for validation")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Phase 1 — Attestation Layer (Weeks 1-4)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Week 1: Deploy EAS schema on Base. Implement attestation read on hot path.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Week 2: Implement attestation write on post-response path. Bind to x402 receipt.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Week 3: Add attestation validity windows per endpoint. Add cache-hit metrics.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("Week 4: Performance benchmarking. Measure attestation read latency vs Redis cache latency.")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Phase 2 — Reputation Registry (Weeks 5-8)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Week 5: Define ERC-8004 compliant schema. Deploy reputation contract on Base.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Week 6: Implement reputation read on hot path (determine agent tier).")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Week 7: Implement reputation update on post-response path.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("Week 8: Implement tiered verification logic. Benchmark per-tier latency.")]
      }),

      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun("Phase 3 — Monitoring and Compliance (Weeks 9-12)")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Week 9: Monitoring webhook subscription model. POST /subscribe endpoint.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Week 10: Background path — periodic position health evaluation.")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        children: [new TextRun("Week 11: Compliance audit trail (Postgres append-only log).")]
      }),
      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun("Week 12: Compliance report generation (background path).")]
      }),

      // SECTION 8: Anti-Overfit Guardrails
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun("Anti-Overfit Guardrails")]
      }),
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun("These rules prevent architectural bloat as Sentinel scales:")]
      }),

      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Maximum External Dependencies: ",
          bold: true
        }), new TextRun("No more than 7 external APIs in the hot path for any single endpoint. Currently at 5. Each new dependency must replace or reduce an existing one.")]
      }),

      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Maximum Hot Path Latency: ",
          bold: true
        }), new TextRun("No endpoint may exceed 5 seconds on cache miss (P95). If a new feature would push latency above this, it must be moved to post-response or background path.")]
      }),

      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Single Responsibility per Path: ",
          bold: true
        }), new TextRun("Hot path handles reads only. Post-response handles writes only. Background handles batch operations only. No exceptions.")]
      }),

      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Graceful Degradation Required: ",
          bold: true
        }), new TextRun("Every new dependency must define its failure mode before implementation. \"What happens when this is down?\" must have an answer that does not block the hot path.")]
      }),

      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 80 },
        children: [new TextRun({
          text: "Net Load Audit: ",
          bold: true
        }), new TextRun("Before each phase deployment, run a full API call audit. Total external calls per /preflight request must not increase.")]
      }),

      new Paragraph({
        numbering: { reference: "numbered", level: 0 },
        spacing: { after: 240 },
        children: [new TextRun({
          text: "Attestation Cannibalization Target: ",
          bold: true
        }), new TextRun("By end of Phase 1, 30% of requests should hit attestation cache. By end of Phase 2, 50% of requests from returning agents should skip full verification.")]
      })
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("/sessions/compassionate-dreamy-turing/mnt/Sentinel/Sentinel_Lean_Architecture_v1.docx", buffer);
  console.log("Document created successfully!");
});
