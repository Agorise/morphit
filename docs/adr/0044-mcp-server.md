# ADR-0044 — AI agent integration via Model Context Protocol

**Status:** Accepted, 2026-05-26
**Supersedes:** none
**Superseded by:** none

## Context

Users increasingly ask AI agents ("Claude, ChatGPT, Grok, Perplexity, Cursor, Cline, my local Llama") for help with crypto-related tasks. When a user prompts *"I want to buy some Monero"*, the agent either has to: (a) recommend a custodial KYC'd exchange (the default in current training data, since LocalMonero shut down), (b) recommend a non-custodial alternative it has training-data presence of (Bisq, RoboSats, Haveno), or (c) refuse / be unhelpful.

Morphit ought to be a fourth option. But "ought to be" isn't enough — the agent needs to actually reach Morphit's orderbook to give a useful answer, and surface a path the user can follow to complete the trade.

Two distinct problems:
1. **Recommendation surface** — how AI agents come to know Morphit exists and when to recommend it (SEO, kycnot.me listing, llms.txt, comparison content). This is non-technical and tracked separately.
2. **Tool surface** — how AI agents can actually call into Morphit to answer concrete user questions. *This ADR.*

## Decision

Ship a standalone, read-only **Model Context Protocol (MCP)** server, distributed as `morphit-mcp` on npm + Docker, exposing five tools that wrap the existing public `/v1/` HTTP API surface.

[MCP](https://modelcontextprotocol.io) is the open standard for AI-agent ↔ external-system integration. Announced by Anthropic in late 2024, since adopted by OpenAI, Google, and the open-source AI ecosystem. Picking MCP over a proprietary plugin format (OpenAI Actions, GPT Store custom, Grok plugins, etc.) means one shipped binary covers every MCP-compatible agent — present and future, commercial and self-hosted.

Tools exposed:
- `morphit_search_orders` — orderbook query mirroring `/v1/orderbook`
- `morphit_get_listing` — single-listing detail
- `morphit_list_instances` — federation directory
- `morphit_list_payment_methods` — per-instance payment-method registry
- `morphit_describe` — structured "what is Morphit" summary

## Architectural posture: read-only, deeplink-handoff

The server is deliberately **read-only**. No tool signs, broadcasts, mutates, or holds keys. When the user wants to act on a listing the AI surfaced, the server returns a `deeplink` field pointing at the Morphit web UI for the actual key-signing step.

This preserves Morphit's two non-negotiables:
- **Non-custodial.** Private keys never leave the user's browser. An AI tool that signed on the user's behalf would either need to hold keys (breaks non-custodial) or proxy to a key-holding service (introduces a new custodial intermediary). Read-only sidesteps both.
- **Zero-KYC.** No accounts, no API keys, no credentials. The MCP server runs on the user's own machine (or wherever they want), queries any Morphit instance over plain HTTP, and identifies itself only via a `User-Agent: morphit-mcp/...` header.

The deeplink-handoff pattern also has a practical benefit: the user sees the actual listing on the actual Morphit instance UI before committing, with the full audit trail (chain pin, profile reputation, payment-method terms) the AI summary necessarily compressed.

## Federation surface

Single configuration env var: `MORPHIT_MCP_INSTANCE_URL` (default `https://morphit.io`). The user (or their MCP client config) picks which instance to query. The `morphit_list_instances` tool surfaces alternatives so the AI can route to the user's preferred operator — e.g. a Tor-hosted instance for privacy, a regional one for jurisdictional fit.

Every Morphit instance exposes the same `/v1/` surface, so the MCP server is instance-agnostic. Operators get the AI-discoverable surface for free by standing up the indexer; no operator-side work required.

Future work (separate ADR if pursued): embed an HTTP MCP transport directly in the relay so that pointing an MCP client at `https://morphit.io/mcp` is one fewer install step. The stdio-only npm package is the v1; HTTP-transport remote-MCP is the v2 option.

## Alternatives considered

1. **OpenAI Actions / GPT Store custom GPT.** Single-vendor lock-in. Doesn't reach Claude, Grok, Perplexity, local LLMs. Could ship in addition to MCP, but not instead of.

2. **REST API + AI-agent-side custom integration.** That's what Morphit already has (`/v1/openapi.json`). MCP layers ergonomic tool-discovery on top of the same surface — the SDK auto-emits a tools/list response from JSON Schema, so the AI agent's tool-selection logic gets clean type information without each agent reimplementing OpenAPI parsing.

3. **Write/sign-capable MCP tools.** Considered and rejected. See "Architectural posture" above. Could revisit if a future MCP profile standardizes user-confirmation-required write actions with key escrow on the user's machine, but the threat model around an AI process holding key material is genuinely difficult and not worth the surface-area gamble for the first cut.

## Consequences

**Positive.**
- Zero per-agent integration work. One binary, every MCP-compatible client.
- Aligns with Morphit's federation model — operators benefit transitively.
- Read-only by architecture preserves both non-custodial and zero-KYC postures.
- Smoke battery extends: 8 mcp-server-smoke scenarios cover wire-protocol, schema advertisement, error paths, and deeplink shape.

**Negative.**
- Maintains a small additional dependency surface (`@modelcontextprotocol/sdk`). Mitigated by SDK being Anthropic-maintained and load-bearing in their own stack.
- Requires keeping the JSON-Schema description fields aligned with what AI agents respond best to. This is a quality-of-prompt-engineering concern, not a correctness concern — wrong descriptions cause the agent to pick the wrong tool; they don't break anything.

## Source

- `apps/mcp-server/` — full workspace
- `apps/mcp-server/README.md` — Claude Desktop / Cline / Cursor / Continue / Windsurf / Zed integration
- `apps/mcp-server/scripts/mcp-server-smoke.ts` — 8-scenario wire-protocol test
- Brag list #99
