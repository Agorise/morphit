# ADR-0045 — Shared network-defense primitives package

**Status:** Accepted, 2026-05-27
**Supersedes:** none
**Superseded by:** none

## Context

`apps/indexer/src/indexer/federationProbe.ts` implements a six-layer SSRF defense for the indexer's outbound HTTP fetches against peer Morphit instances:

1. HTTPS protocol enforcement
2. Literal-hostname denylist (`isPrivateHostname`)
3. DNS resolution + every-record-public validation (DNS-rebinding closure)
4. IP-pinned undici dispatcher (TOCTOU defense between pre-validation and connect)
5. `redirect: 'manual'` (block redirect-following to internal URLs)
6. Body cap with streaming abort

At cp146 the audit of `apps/mcp-server/src/indexerClient.ts` surfaced finding **F-mcp-1** (MED): the MCP server's `fetchJson()` had no equivalent private-address defense. Trust model is weaker than the indexer's (MORPHIT_MCP_INSTANCE_URL is user-supplied, not peer-supplied), but defense-in-depth still wants the address-range denylist for:

- Catching misconfigurations (user accidentally pastes a localhost URL).
- Modestly raising the bar against chained exploits where a compromised MCP-client config tries to use the MCP server to probe internal networks from the user's machine.

cp146 deferred F-mcp-1 as Tier-B because "lifting `federationProbe.ts` defenses into a shared package and having both indexer and mcp-server import from it" was bigger than that audit's scope. cp154 ships the lift.

## Decision

Create `packages/net-defense` — a new private workspace at `@morphit/net-defense` — exporting the two **pure** building blocks:

- `isPrivateHostname(hostnameRaw: string): boolean` — literal-form denylist (loopback, RFC1918, link-local, cloud-metadata, `.local`/`.localhost`/`.internal` TLDs, IPv6 unique-local + link-local + loopback).
- `isPrivateIp(ip: string): boolean` — DNS-resolved IP form (same coverage plus CGNAT, IPv4-mapped IPv6 unwrap).

Consumers **compose policy** with the primitives:

- **`apps/indexer`** keeps its full six-layer lockdown. `federationProbe.ts` now imports from `@morphit/net-defense` instead of defining the functions inline. Public API surface unchanged (re-exports preserve `import { isPrivateHostname, isPrivateIp } from '../federationProbe.ts'` for existing callers and smokes).
- **`apps/mcp-server`** adds a private-address check in `getInstanceUrl()`. By default rejects with a clear diagnostic; allows when `MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE=1` is set (legit dev / localhost-self-hosted / Tor-onion cases).

The MCP server does NOT adopt the full six-layer lockdown because its threat model is different:

| Layer | indexer (peer-supplied URL) | mcp-server (user-supplied URL) |
|---|---|---|
| HTTPS-only | Required — federation directory is by definition cross-instance | Not enforced — users may legitimately use `http://onion.tor` or local dev instances |
| `isPrivateHostname` literal denylist | Hard reject | **Reject by default, env opt-in** (cp154 F-mcp-1) |
| DNS rebinding defense | Required — peer can return any IP | Out of scope — user-supplied URL implies user has already evaluated the instance's identity |
| IP-pinned dispatcher | Required (TOCTOU) | Out of scope |
| `redirect: 'manual'` | Required | Already shipped (cp146 F-mcp-3) |
| Body cap | Required (256 KB indexer / 4 MiB mcp-server) | Already shipped (cp151 F-mcp-5) |

## Why a separate package (not inline indexer/mcp-server)

Three reasons:

1. **Single source of truth.** The function bodies are identical at the lift point. Any future change to (e.g.) add a new RFC range goes in one place and propagates to both consumers. Duplication would let drift recreate exactly the F-mcp-1 finding cp154 is closing.

2. **Pure-function surface.** Both functions are stateless and have zero runtime dependencies. They don't need DB, logger, env, or any other contextual state. A shared package is the natural shape for that surface.

3. **Test coverage focused.** `packages/net-defense/scripts/net-defense-smoke.ts` has 51 scenarios covering every branch of both functions. Without a shared package, equivalent coverage would need to be duplicated in both consumer test surfaces.

## Why two functions, not one

`isPrivateHostname` operates on the URL-side form (case-insensitive, possibly with brackets, possibly with TLD suffixes). `isPrivateIp` operates on DNS-resolved canonical form (no brackets, lowercase hex, may be IPv4-mapped IPv6).

Merging them would force the caller to know which form they have and which checks to skip. Keeping them separate matches the actual usage:

- Pre-DNS check: `isPrivateHostname(parsed.hostname)` — catches literal-form attacks.
- Post-DNS check: `for (record of dns.lookup(host)) { if (isPrivateIp(record.address)) reject; }` — catches rebinding-class attacks.

The functions are intentional pair, not redundant variants.

## Why "private" (workspace-internal)

`@morphit/net-defense` is published nowhere (`"private": true`). Consumers reach it via npm workspace symlinks; it doesn't appear on npm.

Reasoning:

- The function bodies encode Morphit's specific threat-model choices (CGNAT inclusion, cloud-metadata IPs by name, etc.). These are project-internal decisions.
- External consumers wanting SSRF defense should use established libraries (`ssrf-req-filter`, `private-ip`, etc.) rather than pinning to Morphit's internal package.
- Releasing externally would also obligate semantic-versioning discipline on what is, internally, a freely-evolving surface.

If a future need arises to publish (e.g. third-party Morphit integrations want the same primitives), the lift is small: drop `"private": true`, write a README, accept the semver discipline.

## Consequences

**Positive:**
- F-mcp-1 closed at the smallest reasonable scope.
- cp154 demonstrates the ADDING-A-WORKSPACE.md (cp147) playbook on a real workspace addition — the playbook is now battle-tested.
- Both consumers gain access to the same primitives if/when their threat models converge further.

**Negative:**
- One more workspace in the monorepo. Modest typecheck-sweep + smoke-runner cost (+1 each).
- New package-lock.json regeneration in cp154 (`npm install`) — same kind of change that caused the cp140→cp144 CI-red incident, but this time the playbook (Phase 3 step 2) explicitly calls it out as a required step.

**Neutral:**
- The indexer's `federationProbe.ts` shrinks by ~80 lines (the two function bodies move out). Existing callers and smokes unaffected via re-export.

## Source

- `packages/net-defense/src/index.ts` — the two pure functions
- `packages/net-defense/scripts/net-defense-smoke.ts` — 51-scenario self-test
- `apps/indexer/src/indexer/federationProbe.ts:414–427` — re-export shim (was the inline definitions)
- `apps/mcp-server/src/indexerClient.ts:getInstanceUrl()` — F-mcp-1 enforcement with env-var opt-in
- `apps/mcp-server/scripts/private-instance-policy-smoke.ts` — 22-scenario policy test
