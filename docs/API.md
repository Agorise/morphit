# Morphit public HTTP API

A documented, stable contract over the indexer's `/v1/*` endpoints.
Any Morphit instance you can reach exposes these endpoints — the
hostname changes, the contract doesn't.

This is what powers block explorers, federation aggregators, third-
party clients (CLI tools, mobile apps), and anyone who wants to
read Morphit data without going through the web frontend.

## What we promise

**Stable shape.** Once an endpoint is documented here, response
shapes don't break.  Fields can be ADDED (back-compatible) but not
RENAMED or REMOVED without a version bump (`/v2/...`).

**Stable URL.** Documented endpoints stay at the documented path.
We won't move `/v1/orderbook` to `/v1/orders/list` without leaving
a redirect or deprecation notice in place for 90 days.

**Public + free.** No API key, no signup, no rate-limit-by-account,
no payment.  Just hit the URL.

**Operator-tunable rate limits** (see "Rate limits" below).  Every
operator runs their own instance and sets their own caps; the
defaults below are what you'll find on most instances.

**Read-only.**  Every documented endpoint is `GET`.  Writes happen
on the Blurt chain via `custom_json` ops, not via this API.  If
your tool needs to write data, it broadcasts directly to a Blurt
RPC node — see `apps/web/src/lib/blurt/sign.ts` for the pattern.

## What we DON'T promise

**Specific instance availability.** Any individual Morphit instance
can go down, get blocked in a region, run an old version, or
intentionally rate-limit a noisy client.  Don't pin to one
hostname; instead, query `/v1/instances` to discover the federation
and round-robin against multiple operators.

**Real-time freshness.** The indexer polls Blurt with ~3s block
time but applies blocks in batches.  Your data is at most a few
seconds behind chain head, sometimes more under load.  Endpoints
that need real-time deliver via SSE — see "Streaming endpoints"
below.

**Backwards-compatible operator overrides.** Operators can disable
endpoints (e.g. RSS feeds, SSE streams) per their threat model.
A 404 from one instance might mean "deliberately disabled"; try
another.

---

## Quick start

Pick a Morphit instance.  You can find a directory at any
instance's `/instances` page; for this example we'll use
`https://morphit.example.com` as the base URL.

```bash
# Live orderbook — most popular endpoint
curl 'https://morphit.example.com/v1/orderbook?asset=XMR&side=sell&limit=20'

# Health check
curl 'https://morphit.example.com/v1/health'

# Federation directory — find more instances
curl 'https://morphit.example.com/v1/instances'

# An account's reputation
curl 'https://morphit.example.com/v1/accounts/alice/feedback'
```

All responses are JSON unless explicitly noted (RSS endpoints
return `application/rss+xml`).

## Authentication

None.  Every documented endpoint is open to the public internet.

If you need higher rate limits than the operator's default, the
intended path is **run your own indexer**.  The cost (~$5/month
VPS, see `RUN-A-MORPHIT-NODE.md`) is much lower than negotiating
allowlists with a federation of independent operators, and you
get the data closer to source with no rate limits at all.

## Rate limits

Per-IP, per-minute, enforced by the indexer's middleware:

| Tier        | Default      | Endpoints                                         |
|---|---|---|
| `resource`  | 600 req/min  | Single-record lookups, fee quotes, health         |
| `list`      | 120 req/min  | Listings, search, history pagination, RSS         |

Defaults are operator-tunable via `MORPHIT_INDEXER_LIST_RATE_PER_MIN`
and `MORPHIT_INDEXER_RESOURCE_RATE_PER_MIN`.  An instance running
behind a CDN or reverse proxy may also enforce upstream rate limits
that are stricter.

When you hit the limit, the response is `HTTP 429 Too Many Requests`
with a `Retry-After` header (seconds).  Back off.

For aggregator/explorer use cases that do polling, **respect the
list tier of 120/min by polling no more often than every ~500ms
average per endpoint per instance**.  Spread load across multiple
instances if you want higher aggregate throughput.

## Versioning

The path `/v1/...` is the stable contract.  Breaking changes will
introduce `/v2/...` with `/v1/...` remaining available for at
least 12 months after `/v2/...` ships.

The indexer reports its version in `GET /v1/health` (`version`
field) so clients can warn users on stale instances.

---

## Endpoints

### Health & metadata

#### `GET /v1/health`

Tier: `resource`

Liveness check — also exposes block lag and indexer version.

```json
{
  "status": "ok",
  "version": "1.5.5",
  "uptime_sec": 3742,
  "chain_head_block": 17234569,
  "indexed_block": 17234567,
  "lag_blocks": 2,
  "lag_blocks_note": "0–30 is normal (~90s behind; Blurt makes a block every 3s)",
  "stale": false,
  "rpc_endpoints_healthy": 4,
  "rpc_endpoints_total": 4,
  "price_feed": {
    "enabled": true,
    "blurt_fiat": 0.00130526,
    "denomination_fiat": "USD",
    "source": "coingecko",
    "stale": false
  }
}
```

`status` is `"ok"` (lag below configured threshold) or
`"degraded"` (lag exceeds threshold but indexer is still
responsive).  If the indexer's database is unreachable, the
endpoint itself returns 503 instead of a body.

`stale` is a boolean mirror of the same threshold check, exposed
as a separate field for clients that just want a yes/no without
parsing the status enum.

`uptime_sec` is seconds since the indexer process started.
`chain_head_block` is the most recent block the indexer has seen
on the Blurt RPC pool; `indexed_block` is the most recent block
the indexer has fully written to its database.  `lag_blocks` is
the difference.  `lag_blocks_note` is a human-readable hint for
operators eyeballing the endpoint: a healthy indexer trails chain
head by only a handful of blocks, so "normal" is reported as up to
the same threshold the `stale` flag uses (default 30 blocks ≈ 90s
at Blurt's 3-second block time).

`rpc_endpoints_healthy` and `rpc_endpoints_total` report how many
of the operator's configured Blurt RPC endpoints are currently
reachable (out of cooldown) versus configured in total.  If
`rpc_endpoints_healthy` reads `0` while the node is behind, the
RPC endpoints — not the indexer — are the problem.  Per-endpoint
URLs and detail stay in the operator-opt-in verbose block below.

`price_feed` summarises the BLURT/USD price feed that powers the
UI's fiat echoes (the same number served as `blurt_price_fiat` on
`/v1/listing-fee`, so nothing here is more sensitive than that).
`enabled` is `false` when the operator has
`MORPHIT_INDEXER_PRICE_FEED_ENABLED=false` (the UI then shows
BLURT only).  When enabled, `blurt_fiat` is the current 1-BLURT
price, `denomination_fiat` is the fiat ticker it's quoted in
(`MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT`, default `USD`),
`source` is the upstream currently serving
(`coingecko` or `static_floor`), and `stale` is `true` when no
live upstream has succeeded and the indexer is falling back to the
static floor.  The per-upstream forensic detail (drift,
disagreement, peer comparison) stays in the verbose block.

Operators who set `MORPHIT_INDEXER_VERBOSE_HEALTH=1` may also see
a `diagnostics` block in the response with breaker snapshots,
queue depths, etc.  This is operator-opt-in because the verbose
data leaks below-threshold signal that a public attacker could
use to time a drain.

The `diagnostics.price` object (present only when the optional price
feed is enabled) reports the live BLURT/USD value, the serving
upstream, and the three price-manipulation defenses (ADR-0039 /
ADR-0041), all surfaced as of cp233: `drift` (defense B — deviation
from a time-decayed moving baseline), `disagreement` (defense C —
`morphit_native` vs the external market price), and `peer` (defense F
— own price vs federation peer median).  Each carries an `alert`
boolean that goes true on a sustained breach and is `null` until it
has data.  See `docs/OPERATIONS.md` → "Monitoring the
price-manipulation defenses".

Use this endpoint for federation health monitors and uptime
probes.

#### `GET /v1/instance`

Tier: (no rate limit; very small static response)

Per-instance branding and metadata as configured by the operator.

```json
{
  "name": "Acme Morphit",
  "tagline": "Trade in Acme's community",
  "contact_url": "https://acme.example.com/contact",
  "alt_networks": {
    "tor":      "abc123...onion",
    "lokinet":  "abc123.loki",
    "i2p_b32":  "abc123.b32.i2p",
    "i2p_name": "acme.i2p",
    "i2p":      null,
    "ens":      "acme.eth",
    "nostr":    "npub1..."
  },
  "fee_recipient":   "morphit-fees-acme",
  "relay_account":   "morphit-relay-acme",
  "operator_tag":    "acme",
  "seo": {
    "title":       null,
    "description": null,
    "keywords":    null
  }
}
```

Fields are nullable when unset.  Use this to render an instance's
identity in directories and aggregators.

`alt_networks.i2p_b32` and `alt_networks.i2p_name` are the
preferred fields for I2P addresses (b32 hash and human-readable
name respectively).  `alt_networks.i2p` is a deprecated legacy
field kept for one release cycle; it's `null` when either of the
new fields is set.

`alt_networks.ens` is an optional registered ENS `.eth` name
(e.g. `acme.eth`) pointing at the instance, typically via an ENS
contenthash to an IPFS copy of the site.  Display-only — the
indexer does not resolve it; frontends render it as a footer pill
linking to an ENS gateway.

`operator_tag` is the operator-attribution tag used for
operator-earnings split.  Null on unbranded instances.

`seo.{title,description,keywords}` are optional per-instance SEO
overrides; null means the frontend uses its bundled localized
defaults.  Operators only set these if they want to override the
default page metadata for their instance.

---

### Orderbook

#### `GET /v1/orderbook`

Tier: `list`

The live orderbook — every verified, non-expired order across the
federation.  This is the most-hit endpoint in the API.

Query parameters (all optional):

| Param            | Type    | Description |
|---|---|---|
| `asset`          | string  | Filter to `BTC`, `XMR`, `BLURT`, `USDT`, `USDC`, `DAI`, `BCH`, `LTC`, `DASH`, `DOGE`, `ZEC`, `ARRR`, `DCR`, `SOL`, `ETH`, or `XRP` |
| `asset_network`  | string  | For multi-network assets: USDT → `erc20`/`trc20`/`spl`/`bep20`; USDC → `erc20`/`spl`/`base`/`polygon` |
| `side`           | string  | `buy` or `sell` |
| `fiat_currency`  | string  | ISO-4217 e.g. `USD`, `EUR` |
| `payment_method` | string  | e.g. `bank_transfer`, `paypal`; case-insensitive |
| `location_region`| string  | e.g. `US`, `EU` |
| `sort`           | string  | `recent` (default), `rating`, `trades` |
| `limit`          | integer | 1–100, default 25 |
| `cursor`         | string  | opaque cursor from previous response's `next_cursor` |

Response:

```json
{
  "items": [
    {
      "account":          "alice",
      "permlink":         "order-2026-04-25-aaa",
      "side":             "sell",
      "asset":            "XMR",
      "fiat_currency":    "USD",
      "amount_min":       100,
      "amount_max":       1000,
      "price_model":      { "kind": "spread", "percent": 5 },
      "location_region":  "US",
      "payment_methods":  ["cash_in_person", "zelle"],
      "terms":            "...",
      "fee_method":       "blurt",
      "feedback_count":   42,
      "weighted_rating":  4.7,
      "is_new_trader":    false,
      "engagement_24h":   3,
      "created_at":       "2026-04-25T14:23:00Z",
      "updated_at":       "2026-04-25T14:23:00Z",
      "expires_at":       "2026-05-09T14:23:00Z"
    }
  ],
  "next_cursor": "..."
}
```

Notable fields:

- `weighted_rating` excludes feedback flagged by the suspicious-
  reciprocity detector — it's the **trustworthy** rating, not raw
  average.  See `FEES-AND-REWARDS.md` if you need the breakdown.
- `engagement_24h` is the count of distinct accounts who messaged
  the order owner about THIS order in the last 24 hours.  Useful
  for "is this order actually being looked at" signals.
- `is_new_trader` is `feedback_count < 4` — flag for the UI to
  badge inexperienced counterparties.
- `fee_method` is one of: `'blurt'` (paid in BLURT — fee split
  90/10 operator/treasury), `'waived_first_buy'` (the user's
  one-time first-buy waiver per ADR-0011), `'btc'` (paid in
  Bitcoin — 100% to treasury), or `'xmr'` (paid in Monero —
  100% to treasury).
- `price_model` is one of: `{kind:'fixed', price:N}` (a flat
  fiat price per unit), `{kind:'spread', percent:N}` (relative
  to current market rate, where `N` is the +/- percentage; 0
  means "market price"), or any other shape — unknown `kind`
  values pass through as-is for forward compatibility, and
  the frontend's `priceModelDisplay.ts` falls back to a
  "Custom price" rendering for them.  Note: an earlier draft
  of this API named these `market_premium`/`premium_pct` and
  `unspecified`; those names never shipped — the code paths
  use `spread`/`percent` and forward-compat respectively.

#### `GET /v1/orderbook/stream`

Tier: SSE-specific (long-lived; one connection per IP-orderbook-filter)

Server-Sent Events stream of orderbook deltas.  Same query params
as `/v1/orderbook` but instead of a snapshot, you get a live feed
of `add`, `update`, and `remove` events as the chain moves.

Use for explorers that need real-time orderbook display without
polling.

#### `GET /v1/orderbook/featured`

Tier: `list`

Featured-slot bidders, top 3 by paid bid amount (`max_slots`, the
indexer's hard cap, is echoed in the response).

Each item is `{ order, bid }`.  The `order` is a COMPLETE
`OrderRecord` — identical in shape to a `/v1/orderbook` item,
including the trust signals (`feedback_count`, `weighted_rating`,
the composite `reputation_score`, `is_new_trader` for the 🌱 chip,
`first_trade_at`, `posting_pubkey`), `engagement_24h`,
`asset_network` (a featured USDT order must name its chain) and
`created_at`.  Reputation and engagement come from the SAME
sock-puppet-filtered, time-decayed aggregates the orderbook uses
(`apps/indexer/src/api/reputationJoin.ts`), so the numbers rendered
on a featured card can never disagree with the ones on the same
trader's orderbook card.  `bid` carries `hours_requested`,
`blurt_paid`, `blurt_per_hour`, `effective_at` and `expires_at`.

#### `GET /v1/orders/:account`

Tier: `list`

All orders for a specific account (live + expired + cancelled).
Useful for "show me alice's complete order history."

#### `GET /v1/orders/:account/:permlink/views`

Tier: `list`

Private viewcount for a specific order — only the order owner can
read this (JWT-gated).  Documented for completeness; aggregators
typically don't have access.

---

### Reputation

#### `GET /v1/accounts/:account/feedback`

Tier: `list`

All feedback received by `:account`.

```json
{
  "items": [
    {
      "id":                  "12345",
      "reviewer":            "bob",
      "subject":             "alice",
      "rating":              5,
      "comment":             "Smooth trade, would do again",
      "order_permlink":      "order-2026-04-20-xyz",
      "created_at":          "2026-04-22T10:00:00Z",
      "source_trx_id":       "abc123...",
      "suppressed":          false,
      "has_verified_chat":   true,
      "responses": [
        {
          "responder":  "alice",
          "comment":    "Thanks!",
          "created_at": "2026-04-22T11:00:00Z"
        }
      ]
    }
  ],
  "next_cursor": null
}
```

- `suppressed: true` means the (reviewer, subject) pair is flagged
  in `suspicious_reciprocity` or `related_accounts` and excluded
  from the headline rating.  See ADR-0014 if you need the full
  detector spec.
- `has_verified_chat: true` means a real-looking conversation
  preceded the review — see `FEES-AND-REWARDS.md` and
  `apps/indexer/src/db/schema.sql` (search for the
  `verified-chat` marker comments) for the conformance criteria.

#### `GET /v1/accounts/:account/feedback-given`

Tier: `list`

Symmetrical: all feedback authored BY `:account`.  Same row shape
as `/feedback` above.

#### `GET /v1/accounts/:account`

Tier: `resource`

Summary of `:account`'s reputation:

```json
{
  "name":              "alice",
  "feedback_count":    42,
  "weighted_rating":   "4.7",
  "by_rating":         { "1": 0, "2": 1, "3": 2, "4": 5, "5": 34 },
  "first_trade_at":    "2025-08-12T...",
  "trades_completed":  47
}
```

---

### Federation

#### `GET /v1/operator-blocks/by-blocked/:account`

Tier: `resource`

Whether `:account` is currently operator-blocked **on this
instance**, and if so by whom and why.  The frontend banner uses
this to tell a signed-in user that their listings are hidden here.

When there is no block:

```json
{ "account": "alice", "blocked": false }
```

When the operator has an active block:

```json
{
  "account": "alice",
  "blocked": true,
  "operator": "acme-operator",
  "reason": "repeated payment-method spam",
  "since_block_num": 17234001,
  "since_trx_id": "a1b2c3...",
  "created_at": "2026-06-01T12:00:00.000Z",
  "updated_at": "2026-06-01T12:00:00.000Z"
}
```

#### `GET /v1/operator-blocks/by-operator/:operator`

Tier: `resource`

Every account `:operator` currently has blocked on this instance
(capped at 10,000 rows).

```json
{
  "operator": "acme-operator",
  "items": [
    {
      "blocked": "alice",
      "reason": "repeated payment-method spam",
      "since_block_num": 17234001,
      "since_trx_id": "a1b2c3...",
      "created_at": "2026-06-01T12:00:00.000Z",
      "updated_at": "2026-06-01T12:00:00.000Z"
    }
  ]
}
```

Both endpoints are **unauthenticated** and the data is
**instance-local**.  Moderation on Morphit is transparent by
design: a blocked user — and anyone else — can see what an
operator has blocked on their instance and the operator's stated
reason, so an operator cannot censor silently.  A block here has
no effect on any other Morphit instance; a user blocked here
remains fully visible everywhere else.

#### `GET /v1/instances`

Tier: `list`

Directory of all known Morphit instances the indexer has probed.

```json
{
  "items": [
    {
      "origin":               "https://acme.example.com",
      "operator_account":     "acmecorp",
      "name":                 "Acme Morphit",
      "tagline":              "Trade in Acme's community",
      "contact_url":          "https://acme.example.com/contact",
      "alt_networks":         { "tor": "...", "lokinet": "...", "i2p": "...", "nostr": "..." },
      "registered_at":        "2025-12-01T00:00:00Z",
      "last_probed_at":       "2026-04-30T14:00:00Z",
      "last_probe_status":    "good",
      "indexed_block":        17234567,
      "chain_lag_sec":        3
    }
  ]
}
```

- `last_probe_status` is one of: `good` (all checks pass), `quiet`
  (live but no recent orders), `stale` (lagging chain), `unreachable`
  (probe couldn't connect), `mismatch` (relay account doesn't match
  what's recorded on-chain), `never` (never probed).

#### `GET /v1/instances/stream`

Tier: SSE-specific

SSE stream of instance-directory changes.  Same shape as
`/v1/instances`, delivered as add/update/remove events.

#### `GET /v1/operators`

Tier: `list`

All registered operators on the chain.  Distinct from /instances —
operators are the chain identities, instances are the running
servers.  An operator can run multiple instances; an instance can
operate without registering (running unregistered = invisible to
the federation directory).

---

### Discovery & metadata

#### `GET /v1/listing-fee`

Tier: `resource`

Current listing-fee schedule for this instance.

```json
{
  "base_fee_blurt":              60,
  "feature_fee_blurt_per_hour":  50,
  "quote_ttl_seconds":           300,
  "base_fee_fiat":               0.12,
  "blurt_price_fiat":            0.002,
  "denomination_fiat":           "USD",
  "price_warning":               "NOT-AN-ORACLE: For Morphit UI display only. Do NOT use as oracle."
}
```

`base_fee_fiat`, `blurt_price_fiat`, `denomination_fiat`, and
`price_warning` are present iff the operator has price-feed
integration enabled AND the price is fresh.  If any are missing,
frontends should display BLURT only.

The `denomination_fiat` field tells you which fiat the `_fiat`
numbers are in.  Default `"USD"`; operators in non-USD-native
markets (or hedging against USD erosion) can configure
`"EUR"`, `"GBP"`, `"JPY"`, `"BRL"`, `"CNY"`, `"INR"`, `"RUB"`,
`"AED"`, `"XDR"` (IMF Special Drawing Rights), `"XAU"` (gold
ounces), or any 3-8 character uppercase ticker.  See ADR-0040
for the design.

The `price_warning` field carries a loud NOT-AN-ORACLE warning
(cp127 defense H from ADR-0039).  Downstream protocols using the
`_fiat` numbers as oracle input do so against this explicit
recommendation; the price is for Morphit UI display only and is
NOT designed to be cryptoeconomically secure as a price feed for
third-party value-bearing systems.  Use `/v1/price/morphit-native/receipt`
for the full derivation transparency.

> **cp128 rename**: pre-cp128 the optional fields were
> `base_fee_usd` and `blurt_price_usd` (USD hardcoded).  No
> external consumers depend on the old names — the rename
> shipped during pre-launch hardening before any instance went
> live.

`quote_ttl_seconds` is how long a frontend should cache its quote
before re-fetching.  The frontend renders fee amounts using this
window; once it elapses, the next page render re-fetches.

The fee-recipient account is NOT on this endpoint; it lives on
`/v1/instance` as the `fee_recipient` field, since it's an
operator-identity property not a fee-schedule property.

#### `GET /v1/chain-fee`

Tier: `resource`

Current Blurt chain `account_creation_fee`.  Read from chain
dynamic global properties, with a configured fallback.

```json
{ "account_creation_fee_blurt": 100, "source": "chain" }
```

`source` is `"chain"` if read from a live RPC, `"fallback"` if all
RPCs are unreachable and we returned the configured default.

#### `GET /v1/release`

Tier: `resource`

Latest `morphit_release_v1` op the indexer has seen.  Use for
detecting stale instance bundles.  When the release carries a
chain-pinned `treasury` block it is surfaced here (BTC/XMR
addresses + amounts and, as of cp372, the BLURT fee base under
`treasury.blurt.base`) — all public information.  Any Monero
view key on a legacy row is stripped before the response (it is
never stored or served).

#### `GET /v1/fx`

Tier: `resource`

The indexer's cached USD→fiat rate table (cp372), so a client can
compute the "$1 USD-equivalent" first-order minimum and other fiat
echoes in the user's LOCAL currency without itself calling an FX
provider. Response: `{ base: "USD", rates: { EUR: 0.92, … },
source, stale, updated_at, currency_count }`. The WHOLE table is
served and the client picks its own currency locally — there is
deliberately no per-currency lookup, so the indexer never learns
which fiat any individual user chose (the same privacy posture as
the server-side FX fetch). `404` when the FX feed is disabled on
the instance (`MORPHIT_INDEXER_FX_FEED_ENABLED=false`); clients
then treat amounts as already-USD and the indexer's own floor
still applies.

#### `GET /v1/profiles/:account`

Tier: `list`

Single account's public profile (display name, avatar, BLURT-media
URL, optional Nostr pubkey).  404 if the account has never broadcast
a `morphit_profile_v1` op.  Reads cleanly even from a Morphit-naive
account (returns 404, not an error — the account just doesn't have
a Morphit profile yet).

#### `GET /v1/profiles?accounts=alice,bob,carol`

Tier: `list`

Batch profile lookup.  Up to 100 accounts per request, comma-
separated.  Accounts without a profile row are silently dropped
from the response (no 404 since some-found-some-not is the common
case).  Use this for orderbook rows and feedback lists — N+1
single-account lookups are how clients used to flood the API.

Caching: a COMPLETE batch (every requested account resolved) is sent
with `Cache-Control: public, max-age=90, stale-while-revalidate=60`.
A PARTIAL batch — one where any requested account is absent — is sent
with `Cache-Control: no-store`, because an absent account is usually
just indexer lag right after that account's profile broadcast, and
caching the negative result would pin it in the client's HTTP cache
across page refreshes.

#### `GET /v1/operators`

Tier: `list`

The federation's operator directory: every account that has
broadcast `morphit_operator_register_v1` and that this instance
considers active.  Useful for federation-health dashboards and
operator-comparison tools.

#### `GET /v1/instance/payment-methods`

Tier: `list`

This instance's payment-method additions (ADR-0021).  Operators
extend the global picker with region-specific methods (PromptPay,
PIX, etc.) by broadcasting `morphit_payment_method_addition_v1`
ops; this endpoint returns the active set for the instance you
queried.  Different instances will return different sets — that's
the federation working.

```json
{
  "additions": [
    {
      "key": "@instance:promptpay",
      "name": "PromptPay",
      "description": "Thai instant retail payments…",
      "category": "online",
      "url": "https://www.bot.or.th/en/our-roles/payment-systems/PromptPay.html"
    }
  ],
  "generated_at": "2026-04-29T00:00:00.000Z"
}
```

#### `GET /v1/activity/volume`

Tier: `list`

Aggregate trading-activity stats for the Morphit instance.

```json
{
  "trade_count_by_asset_7d":  { "BTC": 12, "XMR": 8,  "BLURT": 4,  "USDT": 6, "USDC": 4, "DAI": 3, "BCH": 3, "LTC": 5, "DASH": 2, "DOGE": 4, "ZEC": 2, "ARRR": 1, "DCR": 1, "SOL": 5, "ETH": 11, "XRP": 7 },
  "trade_count_by_asset_30d": { "BTC": 47, "XMR": 31, "BLURT": 19, "USDT": 24, "USDC": 17, "DAI": 13, "BCH": 11, "LTC": 18, "DASH": 9, "DOGE": 15, "ZEC": 8, "ARRR": 4, "DCR": 2, "SOL": 23, "ETH": 42, "XRP": 18 },
  "trade_count_by_asset_90d": { "BTC": 132, "XMR": 91, "BLURT": 53, "USDT": 72, "USDC": 51, "DAI": 38, "BCH": 28, "LTC": 47, "DASH": 22, "DOGE": 41, "ZEC": 24, "ARRR": 11, "DCR": 6, "SOL": 67, "ETH": 121, "XRP": 49 },
  "volume_estimate_by_asset_30d": {
    "BTC": "0.42",
    "XMR": "23.0",
    "BLURT": "12500",
    "USDT": "4200",
    "USDC": "3100",
    "DAI": "2400",
    "BCH": "1.8",
    "LTC": "8.5",
    "DASH": "3.2",
    "DOGE": "1200",
    "ZEC": "85.5",
    "ARRR": "12.4",
    "DCR": "8.7",
    "SOL": "180.5",
    "ETH": "2580.12",
    "XRP": "2.48"
  }
}
```

Notes: the asset list is dynamic — new tradable assets added to the
canonical registry appear here automatically. USDT, USDC, and DAI are
each reported as a single rollup; per-network breakdown is not
exposed in this endpoint (see `/v1/orderbook?asset=USDT&asset_network=trc20`
or `/v1/orderbook?asset=USDC&asset_network=base` or
`/v1/orderbook?asset=DAI&asset_network=polygon` for per-network
filtering on the live orderbook).

**Trade count semantics:** unique completed orders that received
feedback from at least one party. An order with feedback from
BOTH parties counts ONCE.

**Volume caveat:** the feedback row carries the order_permlink but
not the actual filled amount.  Volume is computed as
`(amount_min + amount_max) / 2` per completed order — clearly
labeled "estimate."  Real volume could be anywhere in the
amount-range or even outside it.  Don't quote these numbers as
"the volume Morphit did" — quote them as "a midpoint estimate."

#### `GET /v1/attestor-eligibility/:account`

Tier: `list`

Per-account: is this account currently eligible to act as a
third-party fee attestor for the operator-paid-fee scheme?
Returns `{eligible: bool, reason?: string}` where reason is a
machine-readable code (`account_too_young`, `insufficient_stake`,
`recently_attested_too_often`, etc.) when ineligible.

Public read so operator-monitoring tools can verify their
attestor pool stays healthy.

#### `GET /v1/stranger-fee-quote`

Tier: `list`

Quote the stranger-message fee a sender would owe to message a
specific recipient (Finding H layer-2 admission gate).  Query
params: `?sender=X&recipient=Y`. Returns the BLURT amount and
the fee-recipient account.

Public read so unauthenticated previews work — a sender about to
write their first message to a stranger needs to know the fee
before any signing happens.

---

### RSS feeds (alternative format)

Same data as `/v1/orderbook`, served as RSS for RSS readers and
news aggregators.  Requires an nginx config block to proxy through;
see `OPERATIONS.md §14` and `§24`.

- `GET /rss/orderbook.xml` — full orderbook
- `GET /rss/orderbook/by-asset/:asset.xml` — filtered to one asset
- `GET /rss/orderbook/by-account/:account.xml` — one account's listings

All `application/rss+xml` content type.

### Streaming endpoints

SSE (Server-Sent Events) streams for real-time data:

- `GET /v1/orderbook/stream` — orderbook deltas
- `GET /v1/instances/stream` — federation directory deltas
- `GET /v1/chat/:a/:b/stream` — chat messages between two accounts
  (only the two accounts can usefully consume this; ciphertext
  delivered as-is)
- `GET /v1/chat-activity/:account/stream` — GLOBAL (all-conversations)
  activity pings for one account, so the inbox list + notification
  badges update sub-second without per-conversation streams. Emits
  `chat_activity` with `{"peer":"<account>"}` ONLY — no ciphertext,
  header, or message id (privacy: metadata is on-chain-public; content
  stays end-to-end encrypted and is re-fetched same-origin on the ping).
  A `ready` event on connect signals the stream is live.

SSE clients must respect `Last-Event-ID` for resume-after-
disconnect.  Server emits keep-alive comments every 30s.

---

### Intentionally undocumented endpoints

Several `/v1/*` routes are deliberately omitted from this
document because they require client-side cryptographic context
to be useful:

- **`/v1/chat-identity`**, **`/v1/conversations`**,
  **`/v1/chat-read-state`**, **`/v1/chat-admission`** — chat
  metadata and ciphertext. You can't decrypt without the
  recipient's chat private key, derived from their posting key.
  Documented internally in `apps/web/src/lib/chat/`.
- **`/v1/blocks`** — chat blocklist mutations. Each
  `morphit_block_v1` op is signed by the blocker; reads are
  per-account-self.
- **`/v1/login-pairing`** — the QR-pair handshake endpoint
  used by ADR-0022's desktop-mediated paired-readonly sessions.
  Pairing is intentionally a closed loop between a desktop
  client and its phone; documenting the protocol publicly would
  invite confusion about whether arbitrary third parties can
  initiate it (they shouldn't).

If you have a genuine third-party use case for any of these,
open an issue and we'll consider promoting it to a documented
endpoint.

---

## Self-hosting

If you're building a serious aggregator or block explorer, run your
own indexer.  See `RUN-A-MORPHIT-NODE.md` for the setup walkthrough.

You'll get:
- No rate limits (the public ones are for unknown clients)
- Faster response times (data closer to your application)
- Independence from any single operator's uptime
- Full RSS / SSE access without nginx proxy fiddling

This is genuinely the right answer for high-volume use cases.

## Versioning policy

- **Adding a field** to a response: not breaking.  Aggregators
  should ignore unknown fields.
- **Removing a field**: breaking.  Requires `/v2/...`.
- **Renaming a field**: breaking.
- **Changing a field's type** (string → number, etc.): breaking.
- **Adding a new endpoint**: not breaking.
- **Changing rate-limit defaults**: not breaking, but operators
  may notice.

We'll publish breaking-change notices in `morphit_release_v1` ops
on chain (so any indexer can detect that downstream consumers of
the API need to update).

## Reporting issues

API bugs / inconsistencies / docs errata:
- Open an issue at git.agorise.net/agorise/morphit
- Or DM `@agorise:matrix.org` on Matrix

Security issues affecting the API: see `SECURITY.md` for the
disclosure path.
