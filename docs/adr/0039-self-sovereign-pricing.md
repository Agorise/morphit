# ADR-0039 — Self-sovereign price derivation (morphit_native): tiered anchor architecture with cross-stablecoin depeg detection (cp127)

**Status:** Accepted (shipped 2026-05; pre-launch hardening campaign)

**Date:** 2026-05-23
**Deciders:** project maintainer (Ken)
**Related:** ADR-0011 (fee-collection design, where BTC/XMR fees came from); §F.11 BLURT-native fee refactor (which removed price-source dependency from fee verification); cp123-cp125 reputation hardening (whose Sybil-signal tables this design reuses).

## Context

Pre-cp127, Morphit's BLURT/USD price feed used a composite source
that tried external upstreams (Klingex → Coingecko) before falling
back to an operator-set static floor (default `$0.002`).  This worked
during phases 3-4 when BLURT price was relatively flat, but had
several structural problems:

1. **External-source dependency**: every instance phoning home to
   Klingex or Coingecko makes Morphit's price visibility a function
   of external services that can be compromised, rate-limit us, or
   shut down entirely.  LocalBitcoins disappeared in 2023; LocalMonero
   in 2024; Klingex is regionally hosted and subject to its own
   regulatory environment.  Depending on external sources for
   anything "important" is the opposite of Morphit's decentralization
   priority (priority #2 per the standing rules).

2. **Static fallback drifts from reality**: the operator-set
   `$0.002` floor was a snapshot of BLURT price at one moment.  Over
   weeks-to-months it drifts from real market price, leaving the
   USD echo (visible to users alongside listing-fee BLURT amounts)
   meaningfully wrong when external sources are unavailable.

3. **No transparency**: users had to take the indexer's word for the
   price.  An operator could manipulate the static floor with no
   external check; a compromised Klingex value would be served as
   truth.

Ken's cp127 request: derive a self-sovereign price from on-platform
trade data, eventually reducing reliance on Klingex/Coingecko as
on-platform volume grows.  Subsequent discussion expanded the scope
to handle scenarios where stablecoins themselves shut down, USD
itself gets replaced, or various adversarial conditions emerge.

## Decision

A new price-source upstream, `morphit_native`, that derives the
displayed asset/fiat rate from on-platform verified-fee orders.
Slotted between Coingecko and the static floor in the composite
chain (Klingex → Coingecko → **morphit_native** → static floor).
Opt-in via `MORPHIT_INDEXER_PRICE_FEED_NATIVE_ENABLED=true`.

### Tiered anchor architecture

`morphit_native` resolves a price through three tiers, in priority
order:

**Tier 1 — USD-fiat-direct anchor (PRIMARY)**.  Orders where the
asset trades directly against the denomination fiat (typically USD)
via any payment method — bank transfer, cash in person, cash by
mail, Venmo, PayPal, etc.  The fiat side is stated explicitly by
the trader.  **Survives**: all stablecoin shutdowns, single-payment-
method failures, brand-new-fiat replacement of USD (via the
`denominationFiat` factory parameter).

**Tier 2 — Stablecoin-anchored supplement**.  Orders where the
asset trades against stablecoins via `payment_methods` keys
(`pay_usdt`/`pay_usdc`/`pay_dai`).  Each stablecoin's contribution
is gated by the cross-stablecoin depeg detector — only "pegged" or
"unknown" stablecoins count.  **Survives**: single-stablecoin
shutdown (tier skipped entirely when <2 stablecoins available;
Tier 1 covers).

**Tier 3 — Hybrid combined pool**.  When Tier 1 and Tier 2 each
independently fail to meet thresholds, combine into one pool.
Useful during bootstrap or post-shutdown degraded operation.

Each tier requires ≥3 distinct verified-fee traders with clean
Sybil-signal records.  Each trader contributes their own median
order price (one vote per trader, regardless of order count).  The
tier's final price is the median across trader medians.

### Cross-stablecoin depeg detection

A companion module (`stablecoinDepegDetector.ts`) computes
cross-stablecoin ratios from on-platform orders where stablecoins
trade against each other (USDT-vs-USDC, USDT-vs-DAI, USDC-vs-DAI,
etc.).  If all ratios are near 1.0, all stablecoins are pegged.
If one stablecoin's ratios consistently diverge from 1.0 by more
than the threshold (default 3%), that stablecoin is "depegged" —
the median deviation across all pairs involving that coin is the
classifier.

The detector is **self-anchored** — it doesn't require external
knowledge of "what USD is worth."  It only requires the assumption
that **the MAJORITY of stablecoins are correctly pegged at any
given moment**.  This is a much weaker and more defensible
assumption than "USDT = $1 always."

When fewer than 2 stablecoins are available (one or zero
stablecoins remain), cross-ratio detection cannot run.  All
stablecoins are reported as "unknown".  Tier 2 is skipped in this
state; Tier 1 USD-direct covers the derivation.

### Hardened against the cp127 black-hat scenarios

The design explicitly defends against the conspiracy-theorist
attack scenarios surfaced in pre-implementation discussion:

| # | Attack | Defense (built into the code) |
|---|---|---|
| A | Sock-puppet whale | Proportional contribution cap via per-trader median (one trader = one vote) |
| B | Slow-drift attack ("frog in boiling water") | Long-term drift monitor with 7-day exponential baseline; alert on 25% sustained divergence |
| C | Klingex compromise undetected | Cross-source disagreement detector; opt-in priority flip env var |
| D | Post-and-cancel race | 10-minute order-age grace period before order qualifies; live status re-checked at query time |
| E | Operator-config envelope widening | Hardcoded outer plausibility bounds (`HARDCODED_OUTER_MIN_USD = 0.00001`, `HARDCODED_OUTER_MAX_USD = 10_000_000`) that operator config can only TIGHTEN, never widen |
| F | Cross-instance federation manipulation | DEFERRED to cp128 — peer disagreement detector |
| G | Patient sock-puppet evading Sybil filters | Price-derivation receipt endpoint `/v1/price/morphit-native/receipt` for after-the-fact forensics |
| H | Downstream oracle abuse | NOT-AN-ORACLE warning in receipt payload + listing-fee payload + ADR + FAQ |

Additional structural defenses:

- **Spread-model echo defense**: only `kind: 'fixed'` orders count.
  `kind: 'spread'` orders price against an external market
  reference; including them would create a circular dependency.
- **Multi-method double-count defense**: each Tier 2 order
  contributes via its FIRST eligible stablecoin only, regardless
  of how many stablecoin payment methods it accepts.
- **Cold-start floor**: each contributing account must have ≥1
  prior verified-fee completed order.  Same protection as the
  `is_new_trader` orderbook badge.
- **Sybil-table filters**: reuses cp123-cp125 reputation tables
  (`suspicious_reciprocity`, `related_accounts`,
  `one_way_pile_on`, `review_concentration`).  Price manipulation
  requires the same level of sophistication as reputation
  manipulation — high bar by design.

### Resilience scenarios

**One stablecoin shuts down** → Tier 2 runs in degraded mode (cross-
ratio detector returns "unknown" for the lone remaining; we treat
"unknown" as eligible; effectively the single remaining stablecoin
is assumed to be $1).  Tier 1 unaffected.

**Two or three stablecoins shut down** → Tier 2 skipped entirely
(`< NATIVE_MIN_STABLECOIN_COUNT_TIER2 = 2` eligible stablecoins).
Tier 1 still works.  Tier 3 falls back to Tier 1 alone.

**Brand new world currency replaces USD** → operator changes the
`denominationFiat` factory parameter (currently hardcoded to 'USD'
in the cp127 factory call site, but the module is parameterized).
Same factory works with new fiat code; no schema change needed
since `orders.fiat_currency` is already a generic TEXT field.

**External sources go completely dark** → composite chain falls
through Klingex → Coingecko → morphit_native → static floor in
order.  morphit_native picks up the slack when traders have generated
enough on-platform data.

### What this design DOESN'T solve (honest limitations)

- **Regulatory capture of all operators in a jurisdiction** —
  federation-level structural limit; users in affected jurisdictions
  use cross-jurisdiction instances via Tor/I2P/Lokinet.
- **State-actor forced account filtering** — operators can locally
  filter accounts; users compare across instances per
  `OPERATOR-TRUST-DESIGN.md`.
- **51%-of-legitimate-trade-volume by a single entity** — if one
  entity legitimately runs >50% of volume, they ARE the market by
  definition.  Not a bug.
- **Patient sock-puppet long-game (months of building reputation
  before activation)** — the cp123-cp125 Sybil filters catch
  concentration patterns at intake, but a patient diversified
  attacker can evade.  Defense G (receipt endpoint) makes
  post-hoc forensics easy; anticipation is the deterrent.
- **Klingex-Coingecko aggregation overlap** — Coingecko aggregates
  many sources including possibly Klingex.  Two-source check might
  effectively be one source displayed twice.  Documented honestly;
  no clean fix.
- **CBDC stealth via "USD" payment methods** — out of scope for
  the price-source design but relevant for broader privacy.

## Operator action required

- **None mandatory.**  Schema migration adds one new table
  (`price_drift_baseline`) idempotently via `CREATE TABLE IF NOT
  EXISTS`.  Existing instances pick this up on next indexer restart.
- **Optional**: operators can enable the native fetcher via
  `MORPHIT_INDEXER_PRICE_FEED_NATIVE_ENABLED=true` when they trust
  their platform's trade volume to support self-sovereign pricing.
- **Optional**: operators with mature data can flip
  `MORPHIT_INDEXER_PRICE_PREFER_NATIVE_WHEN_DISAGREEING=true` to
  prefer the native price over external sources during sustained
  disagreement.

## Performance posture

- **Per-refresh cost**: 3-6 SQL queries (one per tier + depeg
  detector cross-pair queries).  Each query is bounded by the
  8-hour window + Sybil-table filters.  Cheap relative to the
  composite source's 5-min refresh cadence.
- **Drift baseline update**: one INSERT-or-UPDATE per refresh per
  (asset, fiat) pair.  Trivial.
- **Receipt endpoint**: O(N) in qualifying orders + cross-pair
  data.  60s ETag caching mitigates repeat-call cost.

## Privacy posture

Per priority #1:

1. **No new on-chain data.**  All changes operate on already-chain-
   anchored orders + locally-derived signal tables.  No new custom
   JSON op types.
2. **Receipt endpoint reveals which accounts contributed to a price**
   — but this is already publicly inferable from the orderbook.  No
   new privacy leak.
3. **Cross-stablecoin depeg detector reads existing tables only.**
   No new chain-data inputs.

## Decentralization posture

Per priority #2:

- **Per-instance signal-table + baseline state** is the same posture
  as the pre-existing Signals A-D.  Two indexers can show slightly-
  different prices based on their local data.  The disagreement
  monitor + receipt endpoint surface this disagreement explicitly.
- **No new federation-wide constants** beyond the hardcoded outer
  envelope (which is a SAFETY floor, not a coordination point).
- **No new operator-mandatory config**.  Existing operators
  upgrade and the migration applies automatically.

## Future work

Tracked as REVISIT items for cp128+:

- **Defense F (cross-instance peer disagreement detector)**: sample
  prices from peer Morphit instances; alert on sustained
  cross-instance divergence.
- **Per-asset wiring for BTC/USD, XMR/USD**: the factory is generic;
  wire additional asset/fiat instances when needed for the
  listing-fee USD-echo extension to BTC/XMR fees.
- **USD-equivalent display in orderbook**: per-asset native price
  surfaces in the orderbook UI for cross-order comparison.
- **denominationFiat parameterization at the call-site level**:
  today the factory hardcodes `denominationFiat: 'USD'`.  Wire it
  to an operator config field so non-USD operator instances can use
  morphit_native too.

## Related

- `apps/indexer/src/indexer/price/morphitNativeFetcher.ts` — generic
  factory + tiered anchor implementation
- `apps/indexer/src/indexer/price/stablecoinDepegDetector.ts` —
  cross-stablecoin ratio analysis
- `apps/indexer/src/indexer/price/driftMonitor.ts` — long-term drift
  sanity check (defense B)
- `apps/indexer/src/indexer/price/disagreementMonitor.ts` —
  cross-source disagreement detector (defense C)
- `apps/indexer/src/api/priceReceipt.ts` — `/v1/price/morphit-native/receipt`
  endpoint (defense G)
- `apps/indexer/scripts/stablecoin-depeg-detector-smoke.ts` —
  6 structural scenarios
- `apps/indexer/scripts/morphit-native-fetcher-smoke.ts` — 10
  structural scenarios (one per defense + contract checks)
- `apps/indexer/scripts/price-source-hardening-smoke.ts` — 14
  scenarios across receipt + drift + disagreement + factory wiring
