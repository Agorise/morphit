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

**Read-only.**  Almost every documented endpoint is `GET`.  Writes
happen on the Blurt chain via `custom_json` ops, not via this API.
If your tool needs to write data, it signs a transaction and
broadcasts it to a Blurt RPC node (the web app sends its signed
transactions through its own indexer's `POST /v1/broadcast`; see
`apps/web/src/lib/blurt/sign.ts`). The eight `POST` routes —
`/v1/broadcast`, `/v1/chain/condenser`, `/v1/chain/key-references`,
`/v1/orders/:account/:permlink/view`, `/v1/orders/:account/:permlink/check-fee`,
`/v1/pairing/forward`, `/v1/login-pairing/:pid/deliver` and
`/v1/federation/chat-fast` — accept only `Content-Type: application/json`
(415 otherwise).

**CORS.**  Reads (`GET`/`HEAD`) send `Access-Control-Allow-Origin: *`
and never use credentials, so any web page may read this public data.
Writes carry no `Access-Control-Allow-Origin`, so another website
cannot drive or read them from its visitors' browsers.

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

None.  Every documented endpoint is open to the public internet:
no API key, no login, no JWT, no signature.

If you need higher rate limits than the operator's default, the
intended path is **run your own indexer**.  The cost (~$5/month
VPS, see `RUN-A-MORPHIT-NODE.md`) is much lower than negotiating
allowlists with a federation of independent operators, and you
get the data closer to source with no rate limits at all.

## Rate limits

Per-IP, per-minute, enforced by the indexer's middleware:

| Tier        | Default      | Endpoints                                         |
|---|---|---|
| `resource`  | 600 req/min  | Single-record lookups, fee quotes                 |
| `list`      | 120 req/min  | Listings, search, history pagination, RSS, the federation directory `/v1/instances`, and CONNECTING to any SSE stream (`/v1/orderbook/stream`, `/v1/chat/:a/:b/stream`, `/v1/chat-activity/:account/stream`, `/v1/instances/stream`) |

`/v1/health` and `/v1/instance` are not rate-limited (small
responses, no per-request database scan).

Open SSE streams are capped: at most 24 per client and 2,000 per
instance. Past a cap the connect answers `503 {code: "stream_capacity"}`
with `Retry-After: 30`. Visitors arriving over Tor/I2P share one client
identity (the proxy's), so only the instance-wide cap applies to them. The same holds for an untrusted private
proxy that forwards a client address (a proxy the instance wasn't told
about): its address stands for everyone behind it, so only the
instance-wide cap applies — the per-client cap never becomes a cap on the
whole site. A public peer gains nothing by sending forwarding headers.

"Per-IP": behind a reverse proxy the client is read from
`X-Forwarded-For` (the rightmost address not in the trusted-proxy set) —
trusted by default: loopback and Docker's bridge pool `172.16.0.0/12` —
see `MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS` in `OPERATIONS.md`.

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

The release an instance runs is in `GET /v1/release` and in the
page's own build; `/v1/health` carries `version` only for the
operator's local tools (see below).

---

## Endpoints

### Health & metadata

#### `GET /v1/health`

Tier: none (not rate-limited)

Liveness check — block lag, sync progress and coarse health flags.
The public body:

```json
{
  "status": "ok",
  "chain_head_block": 17234569,
  "indexed_block": 17234567,
  "lag_blocks": 2,
  "lag_blocks_note": "0–30 is normal (~90s behind; Blurt makes a block every 3s)",
  "stale": false,
  "sync": { "behind": false, "pct_complete": 100, "eta_seconds": 0, "eta_utc": null },
  "rpc_ok": true,
  "ipfs_seeding": { "state": "ok" },
  "relay": { "up": true },
  "price_feed": {
    "enabled": true,
    "blurt_fiat": 0.00130526,
    "denomination_fiat": "USD",
    "stale": false
  }
}
```

`status` is `"ok"` (lag below the configured threshold) or
`"degraded"` (lag exceeds it, or the node has no chain head yet).
`stale` is the same check as a boolean. `chain_head_block` is the
most recent block the indexer has seen on its RPC pool;
`indexed_block` the most recent it has fully written; `lag_blocks`
the difference, with `lag_blocks_note` as a human hint. `sync`
reports catch-up progress on a fresh node. `rpc_ok` says whether at
least one configured RPC endpoint is answering. `price_feed`
summarises the display-only fiat price (the same number as
`blurt_price_fiat` on `/v1/listing-fee`); `enabled` is `false` when
the operator turned the feed off.

**Operator-only fields.** When the request carries
`X-Morphit-Local-Health: 1` — which `morphit-ops` sends on the box
itself, and which every public edge strips, so a public caller can
never set it — the body also has `version`, `uptime_sec`,
`rpc_endpoints_healthy` / `rpc_endpoints_total`, `system` (CPU,
memory, disk), `ipfs_seeding.detail`, `price_feed.source`,
`sync.blocks_per_sec`, `price_feeds`, `block_check` and `fastpath`.
Operators who set `MORPHIT_INDEXER_VERBOSE_HEALTH=true` and pass
`?verbose=1` also get a `diagnostics` block (breaker snapshots, queue
depths, the price-manipulation defenses). Both stay off the public
body because they leak below-threshold signal an attacker could use
to time a drain.

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
  "fee_recipient":   "acme-fees",
  "fee_recipient_registered": true,
  "relay_account":   "acme-relay",
  "operator_tag":    "acme",
  "clearnet_eliminated": false,
  "treasury":        { "btc": { "…": "…" }, "xmr": { "…": "…" } },
  "seo": {
    "title":       null,
    "description": null,
    "keywords":    null,
    "twitter_site": null
  },
  "chat_link_urls":  { "btc": null, "…": null },
  "disabled_assets": [],
  "disabled_payment_methods": [],
  "operator_matrix_room": "#acme:matrix.org",
  "mcp_url":         null
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

`operator_tag` is the operator-attribution tag written into orders
posted through this instance.  Null on untagged instances.

`clearnet_eliminated` is the instance's **own claim** that it uses
no clearnet internet (all its private-transport legs pass on its
own checks). Other instances accept it only from an instance
registered at an onion/I2P/Lokinet origin, and nobody verifies it
leg by leg; directories show it with the badge "Zero use of clearnet
internet". The list of failing legs (`clearnet_eliminated_missing`)
is returned only to the operator's local tools.

`treasury.btc` / `treasury.xmr` are the listing-fee addresses this
node uses; `null` means that fee method is not taken here (an
explicitly empty address setting, an empty explorer list, or — on a
zero-clearnet node, which verifies through onion explorers only — no
onion explorer of that method answering right now; OPERATIONS §40.4a).

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
| `asset_network`  | string  | For multi-network assets: USDT → `erc20`/`trc20`/`spl`/`bep20`; USDC → `erc20`/`spl`/`base`/`polygon`; DAI → `erc20`/`polygon`/`base`/`arbitrum`. Only orders on that network; refused for an asset that has one network or not this one |
| `side`           | string  | `buy` or `sell` |
| `fiat_currency`  | string  | ISO-4217, one or more, comma-separated, e.g. `USD` or `USD,EUR` |
| `payment_methods`| string  | comma-separated method keys, e.g. `bank_transfer,paypal` (`payment_method` is accepted as an alias) |
| `location_region`| string  | e.g. `US`, `EU` |
| `langs`          | string  | comma-separated language codes, exactly as written here (case-sensitive): `en`, `es`, `de`, `pl`, `fr`, `it`, `ru`, `fa`, `zh-CN`, `zh-HK`; returns only orders written in one of those languages (orders posted before v1.15.0 carry no language and are left out). Unknown codes in the list are ignored; a list with no known code is a `400`, on this endpoint and on the stream. Given twice, the last one counts |
| `min_trades`     | integer | minimum completed trades of the poster (0–100) |
| `sort`           | string  | `recent` (default), `rating`, `trades` |
| `limit`          | integer | 1–100, default 50 |
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
- `is_new_trader` is "fewer than 4 completed, fee-verified trades"
  (the poster's `trade_count`) — flag for the UI to badge
  inexperienced counterparties.
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

Tier: `list` for the connect (see "Rate limits" for the stream caps)

Server-Sent Events stream of orderbook changes.  Same filter params
as `/v1/orderbook`. On connect you get one `snapshot` event, then
`order_upserted` and `order_removed` events as the chain moves, and a
`:keepalive` comment every 25 s.

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

All orders for a specific account (live + expired + cancelled +
completed), newest first, paged. Useful for "show me alice's
complete order history."

#### `GET /v1/orders/:account/:permlink`

Tier: `list`

One order: `{ "item": { …the /v1/orderbook item shape… } }`, or 404.

#### `GET /v1/orders/:account/sybil_tier`

Tier: `list`

`{ "account", "at", "count" }` — how many orders count toward the
account's listing-fee multiplier now (or `?at=<ISO time>`).

#### `GET /v1/orders/:account/:permlink/views` and `POST …/view`

Tier: `list`

The order view counter. Both are **public and unauthenticated** (no
key, no signature): `POST` adds one view (`application/json`), `GET`
returns `{ "count": <n> }` only. The indexer stores no time and no
viewer for a view. The web app shows the count only to the order's
author; that is a display choice, not access control.

#### `GET /v1/orders/:account/view_counts?permlinks=a,b,…`

Tier: `list`

View counts for up to 100 of the account's orders: `{ "counts": { "<permlink>": <n>, … } }`.

#### `GET /v1/orders/:owner/counterparty_lists?permlinks=a,b,…`

Tier: `list`

For up to 50 of the owner's orders, the accounts that messaged the
owner about each one: `{ "owner", "lists": { "<permlink>": [ { "peer",
"reviewable" } ] } }` (up to 50 per order). `reviewable` is true when
the conversation clears the review bar (2+ messages each way over 15+
minutes, not a flagged pair). This is chat metadata that is public on
chain anyway; note that a `false` on a conversation that otherwise
clears the bar reveals that the pair is flagged.

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

- `suppressed: true` means the row does not count toward the
  headline rating: the (reviewer, subject) pair is flagged by the
  anti-review-ring signals (`suspicious_reciprocity`,
  `related_accounts`), the review cites no order, or **the reviewer
  has a later order-bound review of this subject — only a reviewer's
  latest review of a trader counts** (the reputation receipt marks
  older ones `superseded_by_later_review`). See ADR-0014 / ADR-0038.
- `has_verified_chat: true` means a real two-way conversation
  preceded the review. New reviews without one are rejected
  (`no_verified_counterparty`), so only older rows can show
  `false`.

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

- `last_probe_status` is one of: `good` (all checks pass), `syncing`
  (the peer is still catching up with the chain), `quiet`
  (live but no recent orders), `stale` (lagging chain), `unreachable`
  (probe couldn't connect), `clearnet_blocked` (unreachable over
  clearnet but the operator signed a Morphit op — any kind — in the
  last ~day: "censored but alive"; not counted toward the 7-day
  prune), `mismatch` (relay account doesn't match what's recorded
  on-chain), `never` (not checked yet — also shown for a peer this
  node cannot ask, e.g. its proxy for that network is down, or the
  peer is clearnet-only and this node is hidden-only).
- `?status=` filters by any of these values.
- The name, tagline, contact and alt addresses a peer reports in its
  own `/v1/instance` are validated like the register op (length,
  type, contact scheme, address shape); the on-chain alt addresses
  win over self-reported ones.

#### `GET /v1/instances/stream`

Tier: `list` for the connect

SSE stream of instance-directory changes: one `snapshot` event, then
`instance_added`, `instance_updated` and `instance_removed` events
(items in the `/v1/instances` shape), and a `:keepalive` comment
every 25 s.

#### `GET /v1/operators`

Tier: `list`

All registered operators on the chain: `{ "operators": [ { account,
tag, display_name, contact_url, registered_at, is_active, stats? } ] }`
(`stats` = `{ cumulative_blurt_earned, total_orders_attributed }`
once an order has been attributed). No query parameters and no
per-tag endpoint — filter client-side. Every account that has
broadcast `morphit_operator_register_v1` is listed, active ones first
(`is_active`). Distinct from /instances — operators are the chain
identities, instances are the running servers.

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
(see ADR-0039).  Downstream protocols using the
`_fiat` numbers as oracle input do so against this explicit
recommendation; the price is for Morphit UI display only and is
NOT designed to be cryptoeconomically secure as a price feed for
third-party value-bearing systems.  Use `/v1/price/morphit-native/receipt`
for the full derivation transparency.

> **Renamed fields**: earlier pre-launch builds named the optional fields
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
addresses + amounts and the BLURT fee base under
`treasury.blurt.base`) — all public information.  Any Monero
view key on a legacy row is stripped before the response (it is
never stored or served).

#### `GET /v1/fx`

Tier: `resource`

The indexer's cached USD→fiat rate table, so a client can
compute the "$1 USD-equivalent" first-order minimum and other fiat
echoes in the user's LOCAL currency without itself calling an FX
provider. Response: `{ base: "USD", rates: { EUR: 0.92, … },
source, stale, updated_at, currency_count }`. The WHOLE table is
served and the client picks its own currency locally — there is
deliberately no per-currency lookup, so the indexer never learns
which fiat any individual user chose (the same privacy posture as
the server-side FX fetch). `404` when the FX feed is disabled on
the instance (`MORPHIT_INDEXER_FX_FEED_ENABLED=false`). Clients can
then only check a USD amount against the $1 first-order minimum; the
indexer rejects a free first buy whose currency it cannot convert
(`waiver_fiat_unconvertible`) instead of treating the amount as
already-USD (v1.20.0).

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

Per-account: is this account currently eligible to attest a
BTC/XMR fee? Returns `{ account, phase, eligible, reason,
loyalty_blurt, age_days, missing_loyalty_blurt, days_until_eligible }`,
where `reason` is `loyalty`, `age` or `both` when eligible, and
`insufficient_loyalty_and_young_account`, `insufficient_loyalty`,
`young_account` or `account_not_found` when not. `loyalty_blurt`
counts only BLURT that reached the canonical treasury.

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

The 50 most recent live, fee-verified orders, built with the
orderbook's own filter rules, served as RSS 2.0 (`.xml`), Atom 1.0
(`.atom`) or JSON Feed 1.1 (`.json`):

- `GET /rss/orderbook.{xml,atom,json}` — the global feed
- `GET /rss/orderbook/by-asset/<asset>.{xml,atom,json}` — orders that
  sell, pay in or accept that asset (as the orderbook page shows them)
- `GET /rss/orderbook/by-account/<account>.{xml,atom,json}` — one
  account's listings

The global and by-asset feeds take the optional filters `side`,
`fiat_currency`, `location_region` (matched as a substring),
`payment_methods`, `min_trades` (completed trades) and `langs`;
expired orders are dropped. A filtered feed URL encodes the
subscriber's criteria, so the bare URL is the least revealing.

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

The server does not support `Last-Event-ID` resume: on reconnect a
client gets a fresh `snapshot` (orderbook, directory) and should
re-fetch anything it missed. Keep-alive comments arrive every 25 s.

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
- **`/v1/pairing`** — `GET /v1/pairing/target?origin=` and `POST /v1/pairing/forward`: the phone's
  same-origin half of cross-instance QR sign-in (ADR-0022, v1.20.0 amendment). The forward carries one
  sealed pairing delivery to `/v1/login-pairing/<pid>/deliver` on a registered directory instance and
  nowhere else; it is not a general relay.
- **`/v1/compare`** — `GET /v1/compare/orderbook?origin=` (v1.20.2): the /compare page's
  same-origin way to see another instance's orderbook. This indexer fetches the first page
  (`/v1/orderbook?limit=100`) of a registered directory instance over its registered addresses and
  returns `{status, origin, items, indexed_block, next_cursor}` (the `/v1/orderbook` shape) rebuilt from validated fields; an
  unregistered origin is refused (`unknown_instance`). Cached 30 s per instance; it is not a
  general relay.
- **`/v1/account`** and **`/v1/chain`** — the web app's chain reads, relayed by this
  indexer so the browser never contacts an RPC node for them: an account's balance, keys and
  history (`GET /v1/account/:account/history?from=&limit=`), the block explorer's reads and
  `POST /v1/chain/condenser` / `POST /v1/chain/key-references`. A history page larger than a
  reply of that `limit` may be is refused with 413 `reply_too_large` (ask for fewer entries), and
  a busy indexer answers 503 `history_busy` with `Retry-After` (wait, then ask the same page
  again). Pages over 1,000 entries are not hedged across nodes.

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
- Or ask in the public Matrix room `#agorise:matrix.org`

Security issues affecting the API go ONLY by private Matrix DM to
`@agorise:matrix.org` — see `SECURITY.md`. Never in an issue.
