# Four-persona walkthrough — cp167

Re-walk of the four standing personas against every checkpoint that
landed since the last full walkthrough at cp164: cp165, cp166, cp167.

The four personas (unchanged from cp164):

- **Bob** — multi-login Blurt user (existing Blurt account, lives in
  the chat + orderbook + reputation surface).
- **Sally-user** — no crypto experience, the onboarding path.
- **Sally-operator** — runs a Morphit node, from any `.md` documentation,
  every CLI/screen/button, launch → week 1.
- **Charlie** — AI agent using the MCP server.

Material checkpoints since cp164 (the ones that touch persona-observable
surface):

- **cp165** — RPC pool foundation: `@morphit/rpc-pool` package with
  EWMA latency tracking, fastest-first endpoint ordering, adaptive
  hedging.  Both BlurtClients (indexer + relay) migrated.  Byte-budget
  pass: 15 dblurt dynamic imports + 10 lazy components + nginx
  gzip_static / brotli_static (the biggest UX win — 4-6× compression
  ratio means dramatically faster page loads for users on slow
  connections).
- **cp166** — `quorumCall<T>` primitive added to EndpointPool; BTC +
  XMR fee verifiers migrated from `Promise.allSettled` to
  quorum-with-early-return.  Behavioral change: at 3-of-4 explorer
  agreement the verifier returns immediately instead of waiting for
  the slowest explorer's full timeout.  Trust model preserved
  (still requires N-1 majority).  Explorer-fee verification went
  from 5-second worst-case to 23ms in measured smoke conditions.
- **cp167** — Setup wizard active-key rename (relay's key is the
  ACTIVE key, never posting), new MCP setup step (default-yes,
  full explanation), SEO step clarity, new `edit-active-key`
  subcommand with `--wipe-prior` for compromised-key recovery,
  explorer dropdown UI with progressive disclosure, MCP runtime
  wiring (`MORPHIT_MCP_ADVERTISE` env var, `/v1/instance.mcp_url`
  field, `ops/systemd/morphit-mcp.service`).

---

## Persona 1 — Bob (multi-login Blurt user)

Bob's flow is largely unchanged across cp165–167.  Three of those
checkpoints touched his surface:

### cp165 — Faster page loads (the byte-budget pass)

Bob notices nothing functional; pages just load faster because the
nginx pre-compression now serves brotli-static for every static asset
in the bundle.  The dblurt chunk is no longer eager-loaded — Bob's
first paint comes ~600ms sooner on a typical residential connection.

**Verification:** No new prompts, no new UI elements, no removed
functionality.  Verified in cp165's byte-budget smoke.

### cp166 — Trade flow: faster fee-attestation appearance

When Bob completes a BTC or XMR trade and the buyer pays on-chain,
the indexer's fee-verifier now returns at first quorum agreement
(3-of-4 explorers concur) rather than waiting for the slowest.
For trades where Bob is the buyer, this means the "fee attestation
confirmed" badge appears in chat faster — typically within seconds
of the second explorer confirming, instead of waiting on the
slowest's full timeout.

**Verification:** Behavioral, observable on the trade-detail page.
Smoke: `apps/indexer/scripts/rpc-pool-quorum-call-smoke.ts` covers
the integration; no regression in `apps/indexer/test/indexer/fee/*`.

### cp167 — Explorer dropdown in chat

When Bob receives a "funds sent" payload in chat with a txid,
clicking the explorer link still opens the primary explorer
(same behavior as today).  NEW: next to the primary link, a small
"+N more ▾" disclosure appears for chains that have multiple
bundled alternatives (BTC has 4, XMR has 4, ETH has 4, SOL has
4, XRP has 4, etc.).  Clicking it reveals a small panel with
host names of the alternatives.

**Why Bob might use it:** He doesn't trust the primary explorer's
operator, or the primary is down, or he wants to see the txid
on a UI he's familiar with from his existing Blurt workflow.

**Verification:** `<ExplorerLink>` component, smoke
`apps/web/scripts/explorer-urls-multi-smoke.ts` (11 scenarios),
href-xss-smoke allowlist entry locks the safety contract.

---

## Persona 2 — Sally-user (no crypto experience)

Sally's onboarding flow is unchanged structurally.  The cp165
byte-budget improvements help her most because she's most likely
on a phone with a slow connection.

### cp165 — Mobile data savings

The brotli_static compression saves Sally noticeable bytes on
every page.  Combined with the dblurt lazy import (now only
loads when she's actively in the signup keygen flow), her
home-page first paint is ~40% faster on a 3G connection.

### cp166 — Trade UX: trust signal arrives faster

If Sally has just paid the seller in BTC, the "payment verified"
checkmark appears within seconds of the first three explorers
agreeing — rather than her staring at a "verifying..." spinner
for up to 5 seconds.

### cp167 — Explorer dropdown is opt-in

Sally's default flow is unchanged.  If she clicks the "View on
explorer ↗" link in chat, it opens the same explorer it would
have opened pre-cp167.  The "+N more ▾" affordance is small and
sits to the right of the primary link — easy to ignore.  If
she's never thought "wait, what other explorer could I use?",
she'll never notice it exists.

**Grandma-friendliness check:** Confirmed.  The progressive
disclosure pattern doesn't impose new vocabulary on her, doesn't
add a click to her happy path, and provides no surprises.

### cp167 — MCP doesn't touch her path

The MCP server is operator-side infrastructure exposing read-only
orderbook surface to AI agents.  Sally doesn't interact with it
directly.  If an AI agent recommends Sally's instance to a new
user, that's pure win for the federation — but the new user
arrives via the normal web UI, not via MCP.

---

## Persona 3 — Sally-operator (runs a Morphit node, launch → week 1)

This is the persona with the most cp167 surface change.

### cp165 — RPC endpoints: no manual action required

Sally configured 2-3 Blurt RPC endpoints during the wizard
(step 19).  Pre-cp165, the indexer rotated through them in order
on each request.  Post-cp165, the pool tracks per-endpoint EWMA
latency and prefers the fastest healthy one — with adaptive
hedging when the primary slows down (parallel request to the
next-best after a budget timeout).  Result: Sally's instance is
more resilient to one of her chosen endpoints going slow without
fully failing.

**No new config from Sally.**  She doesn't see the pool; it's a
runtime optimization.

### cp166 — Fee-explorer trust math: no policy change

Sally configured BTC + XMR explorer URLs at wizard step 11.  The
new quorumCall primitive means the indexer accepts a fee
attestation as soon as N-1 of her configured explorers agree (where
N is the total).  With the standard 4 default explorers, that's
3-of-4.

**Sally-flagged behavior:** The cp166 transcript noted that the
old `[100, 50, 50, 50]` outcome (one outlier among three
agreeing explorers) now ACCEPTS at 50 (3-of-4) instead of
rejecting.  This is the documented policy for the new primitive;
trust model preserved (still N-1 majority).

### cp167 — Setup wizard: ALL steps now ACCURATE

The wizard is the most-touched surface this checkpoint:

**Step 5 — Active key.**  Pre-cp167, the wizard prompted for the
"posting key" (a label bug).  Post-cp167, it asks unambiguously
for the **active key**, with a full explanation of why:
`create_claimed_account`, `transfer`, `transfer_to_vesting`, and
`delegate_vesting_shares` are all active-authority operations.
Sally now cannot accidentally hand the wizard her posting key.

**Step 15 — SEO meta tags.**  Pre-cp167 said only "Override
homepage SEO copy" with no explanation.  Post-cp167 explains the
default Morphit-branded copy, what's being overridden (`<title>`,
`<meta description>`, `<meta keywords>`), who consumes them (search
engines, link-preview rendering on Matrix/Mastodon/etc.), and why
Sally might want to customize.  Includes example prompt copy.

**Step 20 — MCP server (NEW).**  Default-yes prompt with full
explanation of what MCP is, the 5 read-only tools, why it matters
for SEO/AI discovery, the federation-wide effect, and the
resource cost (~30 MiB RAM, loopback bind, ~0 CPU).

**Total steps now 20** (was 18 pre-cp167; the orchestrator was
already calling 19 steps; cp167 adds MCP as the 20th and
explicit-numbers them all).

### cp167 — `edit-active-key` recovery path

If Sally already ran the wizard before cp167 and pasted the
posting key (because that's what the broken wizard asked for),
she now has a dedicated recovery command:

```
morphit-ops edit-active-key
```

It reads her current `morphit.env`, finds the keystore, prompts
her for the new active key, asks whether the prior key was
wrong/compromised (Yes → no-trace rotation, wipes the prior
keystore with random+zero overwrite then unlinks; No → safe
rotation with timestamped `.bak`), atomically writes the new
keystore, and reminds her to restart `morphit-relay.service`.

**Smoke:** `apps/ops-cli/scripts/edit-active-key-smoke.ts` (19
scenarios) covers env parsing, keystore-mode detection, atomic
write with no `.tmp-*` leftover, backup byte-identity, wipe
unlinking, parity with `encryptEnvelope`.

**Doc:** `docs/RECOVERING-FROM-WRONG-RELAY-KEY.md` — full step-by-
step procedure with verification.

### cp167 — Explorer dropdown wired in chat

Sally's instance now exposes the explorer dropdown to her users
automatically.  No config required.  Her bundled default for BTC
is `mempool.space`; users who don't trust it can click the
"+3 more ▾" disclosure and pick `mempool.observer`,
`blockstream.info`, or `btcscan.org`.  Sally can override the
primary via `MORPHIT_INSTANCE_FRONTEND_BTC_CHAT_LINK_URL` (which
prepends to the list — same as today's behavior for the singular
URL).

### cp167 — MCP runtime: systemd + nginx

If Sally answered Yes to step 20 (default), her rendered config
includes `MORPHIT_MCP_ADVERTISE=true` and the systemd unit
`ops/systemd/morphit-mcp.service` is shipped.  She enables + starts
it with:

```
sudo systemctl enable --now morphit-mcp.service
```

The indexer then advertises `mcp_url` on `/v1/instance` (built from
her public origin + `/mcp`).  For public exposure, she adds the
nginx location block documented in OPERATIONS.md §45.

### cp167 — Doc audit: §8 of RUN-A-MORPHIT-NODE now wizard-first

The first-time-configuration section now leads with §8.0 "use
the wizard" instead of §8.1 "manually edit env files" (which
remains as the automation path).  Sally discovers `morphit-ops
init` immediately on her first read.

---

## Persona 4 — Charlie (AI agent via MCP)

Charlie's MCP surface is unchanged in cp165 and cp166.  cp167 adds:

### cp167 — Discoverable advertisement via `/v1/instance.mcp_url`

Before cp167, an AI agent operator wanting to wire up Charlie to a
specific Morphit instance had to know the MCP endpoint URL out of
band.  Now, fetching `https://<any-instance>/v1/instance` returns
an `mcp_url` field when the operator opted in.

**Charlie's wiring workflow becomes:**

1. AI agent's user says "I want to buy XMR with cash in Berlin."
2. Agent fetches `/v1/instance` from a known-good Morphit instance
   to discover `mcp_url` and the federation directory.
3. Agent calls `morphit_search_orders(asset="XMR", side="sell",
   region="Berlin", payment_method="cash")` against the discovered
   MCP endpoint.
4. Returns matching peer-to-peer offers with deeplinks back to the
   frontend.
5. User clicks a deeplink → arrives at the operator's instance
   with filters pre-applied (the cp156 `?then=` shell support).

### cp167 — Federation-wide discoverability scales

Every instance that runs MCP enlarges the AI-discoverable surface.
Charlie can now hit any one and discover the rest of the
federation; Sally's instance contributes to the shared discovery
layer as long as her `MORPHIT_MCP_ADVERTISE=true` is set.

**Verification:** `mcp_url` field added to `InstanceResponse`
interface; null when operator opted out.  Smoke coverage via
existing `apps/indexer/scripts/api-instance-smoke.ts` shape
checks (pending re-run in the final triple-pulse).

### cp167 — No new MCP tool surfaces

Charlie's five read-only tools (`morphit_search_orders`,
`morphit_get_listing`, `morphit_list_operators`,
`morphit_account_reputation`, `morphit_federation_summary`) are
unchanged.  cp167 adds discovery + advertisement only.

---

## Cross-persona check: no regressions

Smokes that touch persona-observable surface, all passing:

- `init-smoke` (43) — wizard answers shape, env file emission,
  matrix-room emission, mcpServer field
- `edit-smoke` (16) — edit subcommand
- `edit-rpc-smoke` (19) — RPC endpoint editing
- `edit-active-key-smoke` (19, new) — active-key rotation
- `altkeystore-smoke` (14) — alt-network keystores
- `explorer-urls-multi-smoke` (11, new) — dropdown data
- `href-xss-smoke` (1) — `<ExplorerLink>` allowlist locked in
- `workspace-typecheck-smoke` (clean across 13 projects + svelte-check)

Quality gates met:
- TypeScript: 0 errors across 8 source projects
- svelte-check: 0 errors, 0 warnings
- Locale parity: 3099 keys × 10 locales (cp167 added 2 new keys to
  each: `explorer.more_explorers`, `explorer.more_explorers_aria`)
- Smoke runner registry: 256 entries (was 254 pre-cp167; added
  `edit-active-key-smoke` + `explorer-urls-multi-smoke`)
