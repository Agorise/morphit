# ADR-0020: Block explorer, trading-activity stats, APR display, cross-chain links

**Status:** Accepted
**Date:** 2026-04-29
**Deciders:** Agorise team (Claude collaborating)
**Supersedes:** —
**Related:**
- ADR-0008 (Phase 3b indexer architecture) — defines the
  feedback / orders schema this ADR's activity endpoint joins
  against.
- ADR-0011 (dynamic fee model) — touches the order schema's
  `external_tx_id` fields that we link out to mempool.space /
  xmrchain.net for completed BTC/XMR trades.
- ADR-0019 (release-trust-anchor) — same chain-direct,
  no-indexer-trust pattern this ADR's explorer reuses.

## Context

Through Batch J the project had a frontend, an indexer, and a
chat layer — but no surface for a curious passer-by to verify
"what's actually happening on this Morphit instance?" or for a
user to inspect the chain history of an order they were involved
in. The user asked for four related things:

1. A public **block explorer** at `/explorer` — search by
   `@username`, transaction id, or block number; polls real-time;
   lazy-loaded.
2. **Cross-chain links** — completed orders linking to
   appropriate external explorers for BTC/XMR; native Blurt
   linking to our own.
3. **Volume + market depth** — "make Morphit feel like a real
   exchange."
4. **APR display** near the user's BP balance.

The user was clear about polling-vs-websocket ("polling is
fine") and was open to design pushback on the depth-chart
question.

## Decision

### Middle-ground explorer

The explorer renders **Morphit-aware decoration** for the ~16
custom_json op ids Morphit uses (order, order_replace, feedback,
chat, operator_block, etc.) plus the three chain primitives
that show up in normal usage (transfer, comment, vote). Anything
else falls through to:

- Custom_json with unknown id → labeled "Other app" + raw-JSON
  fallback.
- Other native ops (witness votes, escrow, vesting) → labeled
  "Other chain op" + raw-JSON fallback.

This avoids the wide-coverage tail of building a generic Blurt
op renderer (every op type with proper field formatting would
take weeks). Users who hit the long tail get a working
raw-JSON view plus a "view on `blocks.blurtwallet.com`"
fallback link.

Routes:

- `/explorer` — search landing.
- `/explorer/account/[name]` — account view, polling 5s.
- `/explorer/block/[num]` — block detail, immutable so no poll.
- `/explorer/tx/[id]` — tx detail, immutable so no poll.
- `/explorer/activity` — volume + listings histogram, polling 30s.

All routes are **public**, no login required, lazy-loaded
(SvelteKit splits per-route by default; the chunks aren't
downloaded until the user navigates).

### Polling cadence

Per-page, fixed cadences:

| Page | Poll | Why |
|---|---|---|
| account | 5s | Real-time op stream feels live |
| activity | 30s | Coarse stats; faster wastes RPC traffic |
| block | none | Immutable once produced |
| tx | none | Immutable once produced |

All polls are **visibility-aware** (skip when `document.hidden`)
and cleaned up in `onDestroy`.

### Chain-direct fetch (NOT via indexer)

Same posture as ADR-0019: the explorer reads from chain RPC
directly via `BlurtClient`, NOT from the indexer's `/v1/...`
endpoints. The indexer caches Morphit-specific state
(orderbook, feedback) but doesn't index every chain op.
Going chain-direct also means the explorer keeps working when
the indexer is down or experiencing replay lag.

The activity page is the one exception — its volume aggregation
does need a SQL JOIN across feedback + orders (impossible from
a single RPC call). It hits the indexer for that data only.

### Cross-chain external explorer choices

| Asset | URL pattern | Rationale |
|---|---|---|
| BTC | `https://mempool.space/tx/{txid}` | Open-source, no JS tracking, fast. |
| XMR | `https://xmrchain.net/tx/{txid}` | Standard Monero community explorer. |
| BLURT (native) | `/explorer/tx/{trxid}` (own) | Self-hosted; falls back to `blocks.blurtwallet.com` if not found. |

XMR caveat surfaced in UI: Monero transactions are encrypted by
design. The external explorer can confirm a tx exists and was
included in a block, but the inputs/outputs are private. We don't
pretend otherwise in copy.

Per the user's correction: `blockchain.blurt.world` does NOT
exist. `blocks.blurtwallet.com` is the only Blurt fallback link
we surface.

### Real-exchange feel: volume + listings histogram (NOT depth chart)

The user asked "make Morphit feel similar to a real exchange."
The honest pushback is that Morphit isn't a matching engine —
each order has its own payment methods, region, and price model.
A traditional bid/ask depth chart would mislead users into
thinking they could just "hit the offer" when they can't.

What we DO show on `/explorer/activity`:

- **Trade count by asset** over 7d / 30d / 90d windows (exact).
- **Estimated volume** per asset, computed as the midpoint of
  each completed order's amount range (since the chain doesn't
  carry exact fill amounts on feedback ops). Clearly labeled
  "estimated" in the UI.
- **Listings histogram** — current buy vs sell count per asset,
  rendered as horizontal split bars. Honest representation of
  "how many active offers" without faking exchange semantics.

UI copy explicitly explains that Morphit is P2P with negotiated
terms and that each listing has its own constraints — so users
understand what they're looking at.

### APR computation

`computeBlurtVestingApr(dgp)` is a pure helper that takes the
chain's `DynamicGlobalProperties` and returns the current
APR for staked BLURT (Blurt Power) as a percentage.

Constants baked in from Blurt chain config:

- Inflation start: 9.5% annual.
- Decay: 1 basis point per ~250,000 blocks (4 micro-bps/block).
- Floor: 0.95%.
- Vesting share of inflation: 75%.

Computed once per `MyBalanceCard.refresh()` cycle (60s) using
the DGP that was already fetched for BP/MANA — no extra RPC
call. Display: "Currently earning N.NN% APR" sub-line under BP.

Per the user's note "ask the chain every day" — the inflation
rate drifts by sub-basis-points per day, so a 24h cache would
work, but the computation is so cheap (a few floating-point
ops) that we just recompute every refresh. Same end-user
experience.

### Search-input parser

Pure helper `parseSearchInput(raw)` returns one of:
`{kind: 'account', account}`, `{kind: 'txid', txid}`,
`{kind: 'block', blockNumber}`, or `{kind: 'unknown', raw}`.

Strict classification:

- Strips leading `@` (so `@alice` and `alice` are equivalent).
- Account name: lowercase, starts with letter, length 3–16.
- Block number: pure digits, positive, less than
  `Number.MAX_SAFE_INTEGER`.
- Txid: 40 hex chars (the Blurt format; not 64 BTC/XMR).
- Anything else → `unknown`. Better to fail explicitly than
  guess wrong.

The submit handler dispatches to the right route based on the
discriminated kind.

### Param matchers

SvelteKit param matchers reject malformed URLs at routing time:

- `account` (existing): the standard Blurt account regex.
- `blocknum` (new): `/^[1-9][0-9]{0,18}$/`.
- `trxid` (new): `/^[0-9a-f]{40}$/` lowercase only.

A garbage URL like `/explorer/block/abc` 404s before any RPC
call.

### Op-decoration helper

Pure helper `decorateOp(opName, opBody)` returns
`{kind, labelKey, isMorphitOp}`. Uses `OP_IDS` from the existing
config. Smoke covers all 21 decoration kinds plus the
fallthrough cases.

`isMorphitOp` drives a tinted background on Morphit-specific op
labels — visual signal that this op is part of Morphit's
protocol rather than generic Blurt activity.

## Consequences

### Positive

- Closed the "where's the explorer" gap. The project now has a
  user-facing surface that demonstrates "everything is on chain"
  rather than just claiming it.
- Cross-chain links reduce friction in completed-trade UX. A
  buyer who paid via BTC sees a one-click "View on explorer"
  link to mempool.space.
- APR display gives stake-holders concrete feedback on what
  their BP earns — was previously invisible.
- Activity stats give an honest "how active is this instance"
  signal without faking exchange semantics.
- Reuses the chain-direct-not-indexer posture from ADR-0019,
  consistent with the project's trust model.

### Negative

- The middle-ground explorer can't render the long tail of
  Blurt op types beautifully. Users who hit, say, an
  `escrow_transfer` op see raw JSON. The fallback link to
  `blocks.blurtwallet.com` mitigates but doesn't eliminate the
  rough edge.
- The activity page caps orderbook fetch at limit:100. If the
  ecosystem grows past that for one (asset, side), the
  histogram undercounts. Acceptable for early launch;
  documented in the component for future expansion.
- Volume is an ESTIMATE — the chain doesn't carry exact fill
  amounts on feedback ops. We label this clearly in the UI but
  it's still an asterisk on what looks like a precise number.
- The trust posture for explorer reads is "trust the RPC node"
  same as the rest of the app. A malicious RPC could lie about
  account balances, op history, etc. Detection is best-effort
  (the account-name guard catches one class). Same posture as
  pre-Batch-K and not regressed.
- Long-running tabs accumulate ops in memory unboundedly.
  Acceptable for practical use; tab close clears it.

### Trade-offs explicitly considered

- **Build a generic Blurt op renderer vs middle-ground.**
  Rejected the generic renderer for scope reasons; the long
  tail of op types doesn't materially help Morphit users. The
  middle-ground covers the 95% case beautifully.
- **WebSocket push vs polling.** Per the user, polling is
  fine. Polling is also simpler, doesn't require a
  streaming-RPC plugin (not all Blurt nodes expose one), and
  visibility-aware polling is gentle on chain RPC bandwidth.
- **Depth chart vs listings histogram.** Pushed back on the
  user's "depth chart" framing because Morphit isn't a
  matching engine. User accepted volume + listings-histogram
  alternative.
- **Indexer endpoint vs chain-direct for explorer reads.**
  Chose chain-direct for everything except the activity-page
  volume aggregation (which needs SQL JOIN). Same posture as
  ADR-0019.
- **APR cache cadence.** Considered 24h cache, decided to
  recompute every refresh (60s) — math is trivial, no extra
  RPC call needed.

## Implementation

- `apps/web/src/lib/blurt/apr.ts` — pure APR computation.
- `apps/web/src/lib/explorer/urls.ts` — external + internal
  explorer URL builders with strict input validation.
- `apps/web/src/lib/explorer/search.ts` — search-input parser.
- `apps/web/src/lib/explorer/decorate.ts` — op-decoration
  helper.
- `apps/web/src/lib/explorer/listingsHistogram.ts` — pure
  aggregator for the listings bar chart.
- `apps/web/src/lib/blurt/client.ts` — added `getBlock` +
  `getTransaction` methods + types.
- `apps/web/src/lib/indexer/client.ts` — added
  `getActivityVolume` wrapper and types.
- `apps/indexer/src/api/activity.ts` — `/v1/activity/volume`
  endpoint with three windowed SQL aggregations.
- `apps/web/src/params/{blocknum,trxid}.ts` — route matchers.
- `apps/web/src/routes/explorer/+page.svelte` — search landing.
- `apps/web/src/routes/explorer/account/[name=account]/+page.svelte`
  — account view with 5s polling.
- `apps/web/src/routes/explorer/block/[num=blocknum]/+page.svelte`
  — block detail.
- `apps/web/src/routes/explorer/tx/[id=trxid]/+page.svelte` —
  tx detail with show/hide raw JSON per op.
- `apps/web/src/routes/explorer/activity/+page.svelte` —
  trading activity page.
- `apps/web/src/lib/components/MyBalanceCard.svelte` — APR
  sub-line under BP.
- `apps/web/src/lib/components/ChatMessage.svelte` — funds_sent
  pill "View on explorer" link routing per asset.
- `apps/web/src/routes/+layout.svelte` — footer link added.
- `apps/web/src/routes/my/orders/+page.svelte` — header link
  to user's account on explorer.
- `apps/web/src/lib/utils/faqIndex.ts` — `block_explorer` FAQ
  key registered.
- Smokes:
  - `apr-smoke.ts` — 13 scenarios (inflation curve, APR
    formula, formatter).
  - `explorer-urls-smoke.ts` — 21 scenarios (URL builders +
    injection rejection).
  - `explorer-search-smoke.ts` — 20 scenarios (parser
    classification + edge cases).
  - `explorer-activity-smoke.ts` — 19 scenarios (histogram
    aggregation + decorateOp).
- i18n: 109 new keys × 10 locales = 1090 strings (88 page
  keys + 21 op labels). Drift = 0.
- Audit doc: `docs/audit/2026-04-29-batch-k-explorer.md`.

## Open questions / future work

- **Generic Blurt op renderer**: every Blurt op type with
  properly formatted fields, replacing raw-JSON fallback.
  Substantial work; deferred until users complain.
- **Real depth/price-vs-market display**: requires a market-
  price feed (currently no canonical source in the Blurt
  ecosystem). Deferred.
- **Tx-by-id without tx-index plugin**: walk blocks ourselves
  to find a tx. Quadratic if naive; needs a sensible search
  bound. Deferred.
- **Activity page cap > 100 listings per side**: if the
  ecosystem grows, expand to paginated fetch + accumulate.
  Deferred.
- **Long-running tab memory cap on /explorer/account**: cap
  the `ops` array at, e.g., 1000 entries with "view earlier
  on fallback" affordance. Deferred until reports.
