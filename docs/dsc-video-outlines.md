# DSC YouTube Series — Sentinel Build Documentation

*Three-video arc documenting the Sentinel build for purposeful entrepreneurs.*
*Target audience: people who think in frameworks, not crypto natives or pure developers.*

---

## Video 1: "I Found a Gap Nobody's Building For"

**Core thesis:** How to identify a genuine opportunity at the intersection of emerging technology and real market need — using the trust gap in the agentic economy as a case study.

**Runtime target:** 12–18 minutes

### Opening Hook (2 min)

- Cold open: "AI agents are about to start spending real money on the internet. Autonomously. Without asking permission. And right now, there is no way for them to know if what they're about to do is safe."
- Frame the stakes: This isn't theoretical. Coinbase, Cloudflare, and Amazon are building the payment infrastructure right now. The agents are coming. The trust layer doesn't exist.
- Personal context: "I'm not a developer by trade. I'm an operator who saw a gap and decided to build into it."

### The Opportunity Framework (5 min)

- Walk through how you evaluate emerging markets: What's being built? What's assumed? What's missing?
- The agentic economy stack: payments (x402), wallets (Coinbase Agentic Wallets), identity (World AgentKit, ERC-8004). Map it visually.
- The missing layer: Every piece of the stack assumes agents will know what's safe. None of them verify it.
- The key insight: Identity tells you *who* an agent is. Nothing tells you whether *what it's about to do* is safe. That's a different problem entirely.

### Why This Gap Is Real (4 min)

- ERC-8004 explicitly defines Reputation and Validation registries and leaves them open for the ecosystem. This isn't speculation — the standard's authors acknowledge the gap.
- World AgentKit proves a human is behind an agent. It doesn't prove the agent is making good decisions.
- Parallel from traditional finance: KYC tells you who someone is. Risk management tells you if the trade is sound. Both exist. In the agent economy, only the first one is being built.

### The Decision to Build (3 min)

- Why I chose to build the product myself rather than wait for someone else
- The x402 protocol as the right foundation — HTTP-native, pay-per-use, no accounts. Perfect for autonomous agents.
- "The best time to build infrastructure is before the demand curve hits. The second best time doesn't exist — someone else built it."

### Close and Tease (2 min)

- "In the next video, I'll show you exactly what I built, how the x402 protocol works, and what it looks like when an autonomous agent verifies trust before executing a transaction on-chain."
- CTA: Subscribe, share with someone who's looking for real opportunities in emerging tech.

---

## Video 2: "What I Built and How It Works"

**Core thesis:** A builder's walkthrough of Sentinel — what it does, how the x402 payment protocol works, and why the architecture decisions matter. Accessible enough for non-developers, specific enough for builders.

**Runtime target:** 15–20 minutes

### Opening (2 min)

- Recap the gap from Video 1 (30 seconds — don't repeat, just anchor)
- "This is what I built to fill it. It's called Sentinel. It's live. It's already processed its first real payment on-chain. Let me show you how it works."

### The Product — What Sentinel Does (5 min)

- Walk through the five endpoints conceptually. Don't show code — show what an agent *experiences*.
- The preflight pattern: "Before your agent does anything on-chain, it asks Sentinel one question: should I do this?"
- Show a real response (sanitized). Walk through the verdict, trust grade, confidence score, risk flags.
- The key design principle: Sentinel is opinionated. It gives a yes/no, not a data dump. Agents need decisions, not dashboards.

### How x402 Works — Demystified (5 min)

- This section is for the audience that isn't in crypto. Explain x402 like you'd explain credit card processing to someone who's never seen a POS terminal.
- The flow: request → 402 → sign payment → get result. Four steps. Pure HTTP.
- Why this matters: No accounts. No API keys. No subscriptions. An agent with a wallet can use Sentinel the same way a person with a credit card uses a vending machine.
- The Coinbase connection: CDP facilitator, Bazaar discovery. Position this as built on Coinbase infrastructure, not a side project running on duct tape.

### Architecture Decisions That Matter (4 min)

- Multi-source verification: Why Sentinel doesn't trust any single data source. GoPlus, DeFiLlama, Etherscan, Alchemy, OFAC — explain what each contributes and why redundancy matters.
- Confidence scoring: "Sentinel tells you how confident it is in its own answer. If only two of five data sources returned data, the confidence score reflects that. An agent can decide whether a low-confidence answer is good enough."
- Caching and rate limiting: Design for the economics of agents. 25 free calls per wallet per day. Redis caching so repeated queries don't cost the agent or hit rate limits unnecessarily.
- Why x402 over API keys: Agents don't have email addresses. They don't fill out signup forms. The payment *is* the authentication. This is a fundamental design insight for agent-native services.

### The First Transaction (2 min)

- Show (screen recording) the actual first paid transaction. The terminal output. The settlement hash.
- "Half a cent. That's what it cost to verify that a token called Brett on Base is a B-grade, low-risk asset. The agent now knows. It took less than two seconds."
- Connect this back to the opportunity: This is what agent commerce looks like. Micro-payments for micro-decisions. Thousands of times a day. Across millions of agents.

### Close and Tease (2 min)

- "The product is built. It's live. It's discoverable. But what happened next is what turned this from a side project into something much bigger."
- Tease the Erik Reppel conversation without revealing details.
- CTA: Subscribe. "If you want to see what happens when you build the right thing at the right time, the next video is the one."

---

## Video 3: "What Happens When You Build at the Right Moment"

**Core thesis:** The Reppel conversation and what it means — both for Sentinel specifically and for the broader lesson about timing, positioning, and building in emerging ecosystems.

**Runtime target:** 12–15 minutes

*Note: This is an outline only. Do not script until after the Monday conversation. The structure below is designed to flex based on how the conversation goes.*

### Opening (2 min)

- Recap arc: "In Video 1, I showed you the gap. In Video 2, I showed you the product. This video is about what happens when the person who designed the architecture you're building on top of sees your work."
- Frame: This is not a pitch story. This is a timing story.

### Context: Who Erik Reppel Is (3 min)

- Head of engineering at Coinbase Developer Platform
- Created x402 — the payment protocol Sentinel is built on
- Co-author of ERC-8004 — the Ethereum standard that defines the agent trust registries Sentinel implements
- "When I say Sentinel fills the gap in the architecture, this is the person who designed the architecture."

### The Conversation — What Happened (5 min)

*Adapt based on actual conversation. Possible structures:*

**If strong alignment:**
- What he said about the verification gap
- Where he sees Sentinel fitting in the roadmap
- Any specific next steps, introductions, or integration opportunities
- What this means for Sentinel's trajectory

**If exploratory/neutral:**
- What he's thinking about for the reputation and validation layers
- Where his perspective differs from our assumptions (this is valuable — lean into it)
- What we learned about timing and positioning
- Adjustments to Sentinel's strategy based on the conversation

**If he's already building something similar:**
- What that tells us about the opportunity validation
- How Sentinel differentiates or complements
- The lesson: being early and visible matters, even when larger players enter

### The Broader Lesson (3 min)

- Timing in emerging ecosystems: The infrastructure gets built in a specific order. Payments → wallets → identity → trust. If you can identify where the sequence is and build the next layer before demand arrives, you have a window.
- The "build something real" principle: We didn't pitch an idea. We built a live product, processed a real transaction, submitted to the ecosystem registry, and then reached out. That sequence matters. Builders get conversations that pitch decks don't.
- For the DSC audience: This is what it looks like to do something instead of talking about doing something. The whole point of Do Something Collective.

### What's Next for Sentinel (2 min)

- Without revealing confidential strategy: MCP server integration (Claude Desktop, Cursor), expanded protocol coverage, community adoption targets
- The protocol question: "There's a version of this that's bigger than a product. I'll share more as it develops."
- Honest about what's unknown: "This is still early. The agent economy is still mostly builders building for other builders. The demand curve hasn't hit yet. But the infrastructure is in place, and Sentinel is live and ready when it does."

### Close (1 min)

- CTA: "If you're building something at the edge of what's possible and you want to document the process, that's what DSC is for. Subscribe. Build something. Do something."
- End card with links: Sentinel GitHub, DSC socials, x402 ecosystem resources.
