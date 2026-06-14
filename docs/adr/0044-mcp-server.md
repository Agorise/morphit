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

Future work — **now shipped (beta16); see the addendum below.** The stdio-only npm package was the v1; a hardened HTTP transport in the MCP server itself (not the relay — keeping it isolated and key-free) is the v2, making `https://morphit.io/mcp` a real, reachable endpoint.

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

## Addendum (beta16) — HTTP transport shipped

The "future work" HTTP transport is now implemented in the MCP server
itself (not the relay — keeping the MCP isolated and key-free). A single
env var, `MORPHIT_MCP_TRANSPORT`, selects it: `stdio` (default) for local
agents that spawn the server as a subprocess; `http` (the mode
`morphit-mcp.service` runs) for a hardened, network-reachable endpoint a
reverse proxy can expose for federation-wide remote-agent discovery.

**Why it was needed.** cp251 shipped a persistent `morphit-mcp.service`
whose unit, docs, and brag claim all assumed a network HTTP MCP on
`127.0.0.1:8124` — but the server was stdio-only. Run as a daemon it read
EOF on its empty stdin and exited 0 in under a second, so nothing ever
listened on 8124 and the advertised `/v1/instance.mcp_url` (`<origin>/mcp`)
pointed at a dead upstream.

**Transport choice: stateless, JSON-response.** `sessionIdGenerator` is
left `undefined` with `enableJsonResponse: true`, so each POST is an
independent request/response — no session table to exhaust, no long-lived
SSE. `initialize`, `tools/list`, and `tools/call` all work per request
(verified end-to-end). The read-only tool set emits no server-initiated
messages, so nothing is lost by dropping the SSE channel. A hand-rolled
JSON-RPC endpoint was rejected (not MCP-spec compliant — standard clients
couldn't connect); stateful `Mcp-Session-Id` sessions were rejected for
the first cut (a bounded-but-real exhaustion surface for zero benefit
here).

**Security posture (the MCP is the most exposed surface).** Defense in
depth, all on by default, tunable via `MORPHIT_MCP_*` in
`/etc/morphit/mcp.env`: a fail-closed bind that accepts loopback or any
private/bridge address (e.g. `172.18.0.1` for a dockerized reverse proxy,
the same way the indexer/relay are reached) but refuses `0.0.0.0`/`::` or
a public address unless `MORPHIT_MCP_ALLOW_PUBLIC_BIND=1`; DNS-rebinding
Host/Origin allowlists enforced by both our middleware and the SDK
transport (browser `Origin`s rejected by default; the default Host
allowlist auto-includes the bound address); a per-client token-bucket
rate limit; a hard request-body cap; a connection ceiling; slowloris
timeouts; and SSRF-guarded outbound fetches. The systemd unit adds a
`@system-service` seccomp allowlist, `ProtectSystem=strict`,
`ReadOnlyPaths`, an empty capability set, `UMask=0077`, and `MemoryMax=256M`,
and restarts forever with a start-limit circuit breaker.

**Lifecycle.** Fresh nodes: the Ansible role installs the (HTTP-mode) unit
and enables+starts it. Existing nodes: `morphit-ops upgrade` re-deploys the
MCP's isolated vendored tree and restarts it (gated on the unit being
installed), so the endpoint rolls forward automatically.

Source: `apps/mcp-server/src/main.ts` (transport selection +
`startHttpTransport` + in-file rate-limiter / Host-Origin / body-cap
middleware + `bindAllowedByDefault`), `ops/systemd/morphit-mcp.service`,
`apps/ops-cli/src/commands/upgrade.ts` (step 10b),
`apps/mcp-server/scripts/mcp-http-transport-smoke.ts` (12-scenario
behavioral test).
