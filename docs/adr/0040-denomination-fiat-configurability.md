# ADR-0040 — Operator-configurable price denomination fiat + denomination-agnostic API field rename (cp128)

**Status:** Accepted (shipped 2026-05; pre-launch hardening campaign)

**Date:** 2026-05-23
**Deciders:** project maintainer (Ken)
**Related:** ADR-0039 (self-sovereign pricing — established the `denominationFiat` parameter at the factory level; this ADR exposes it as operator config).

## Context

ADR-0039 designed the `morphit_native` price fetcher as a generic
factory parameterized on `(asset, denominationFiat, ...)`.  The
factory call site in `apps/indexer/src/indexer/price/factory.ts`
hardcoded `denominationFiat: 'USD'` and the listing-fee API
returned field names `base_fee_usd` and `blurt_price_usd` — names
that locked in USD as the indexer's display unit.

Two related limitations:

1. **Operators serving non-USD markets today.**  A Brazilian
   operator wants the listing-fee echo in BRL; a Eurozone operator
   wants EUR; an Iranian operator may want IRR or XAU.  All of
   these are realistic, immediate use cases — not hypothetical
   future scenarios.

2. **USD-collapse / petrodollar-erosion hedge.**  Ken's framing
   was forward-looking: if USD eventually loses its role as the
   global unit of account (replaced by a BRICS arrangement, an
   XDR-like basket, gold-anchored pricing, or any other emerging
   unit), the indexer should be able to switch denomination
   without a code change.

Both concerns map to the same fix: expose `denominationFiat` as
operator config and rename the API fields to be denomination-
agnostic.

Pre-launch leverage (no instances live anywhere) means the API
field rename costs nothing — there are no consumers to migrate
beyond the in-repo frontend and tests.

## Decision

### Backend

- **New env var** `MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT`.
  Default `'USD'` (preserves cp127 behavior).  Validated against
  `/^[A-Z]{3,8}$/` — 3-8 uppercase letters, broad enough to
  accommodate ISO 4217 codes (USD, EUR, JPY, ...), IMF
  Special Drawing Rights (XDR), precious metals (XAU, XAG), and
  any future ticker.

- **Config wiring:** new field `priceFeedDenominationFiat: string`
  on the `Config` interface.  Passed to the morphit_native
  fetcher's factory in `factory.ts` (replacing the hardcoded
  `'USD'`), and read by the receipt endpoint as its
  default-when-query-param-omitted denomination.

- **Listing-fee API field rename:**

  | Pre-cp128 | Post-cp128 |
  |---|---|
  | `base_fee_usd` | `base_fee_fiat` |
  | `blurt_price_usd` | `blurt_price_fiat` |
  | (n/a) | `denomination_fiat: 'USD' \| 'EUR' \| ...` |

  The `denomination_fiat` companion field tells the consumer
  which fiat the numeric values are in.  Frontends read this
  to render with the appropriate symbol / locale rules.

### Frontend

- **New formatter** `formatFiat(amount, ticker)` in
  `apps/web/src/lib/i18n/formatters.ts`.  Knows about ISO 4217
  codes (uses `Intl.NumberFormat`'s currency style for those) and
  has a fallback `"{number} {TICKER}"` format for non-ISO
  tickers.  Picks per-ticker decimal precision (JPY → 0 digits,
  XAU/XAG → 8 digits, XDR → 4 digits, default → 2 digits).

- **`formatUsd` removed** — pre-launch leverage; all call sites
  migrated to `formatFiat(amount, ticker)` with ticker coming
  from the listing-fee response's `denomination_fiat` field.

- **Two consumer call sites updated:**
  - `apps/web/src/lib/components/StrangerFeeModal.svelte`
  - `apps/web/src/routes/[lang]/post/+page.svelte`

  Both renamed local `usdPerBlurt` → `fiatPerBlurt`, added
  `denominationFiat` state, switched to `formatFiat`.

### Setup wizard

- **New picker step** at the end of the listing-fee wizard
  (`apps/ops-cli/src/init/steps.ts:stepListingFee`).  Curated
  list of common fiats (USD/EUR/GBP/JPY/BRL/CNY/INR/RUB/AED/XDR/XAU)
  plus an "Other (enter ticker)" free-text option validated
  against `/^[A-Z]{3,8}$/`.  Default USD.

- **Generated env file** (`render.ts`) includes the new
  `MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT=...` line with
  an explanatory comment block.

### Documentation

- This ADR.
- `OPERATIONS.md` + `RUN-A-MORPHIT-NODE.md` updates.
- Canonical env example file (`ops/env/indexer.env.example`)
  documents the new env var with operator-facing notes about
  realistic use cases.
- FAQ entry `where_does_blurt_price_come_from` gains one
  paragraph mentioning denomination configurability × 10 locales.

## Resilience scenarios — what changes, what doesn't

**Operator in Brazil sets denomination=BRL.**  Listing-fee
response shows `denomination_fiat: "BRL"`, `blurt_price_fiat:
0.012` (or whatever the BRL value is).  Frontend renders
"60 BLURT (~R$0.72)" — the Real symbol and Brazilian formatting.

**Operator in Iran sets denomination=XAU.**  Listing-fee response
shows `denomination_fiat: "XAU"`, `blurt_price_fiat: 0.0000023`
(BLURT/oz).  Frontend renders "60 BLURT (~XAU 0.00013800)" — hard-
currency hedge against fiat instability.

**Soft USD-erosion scenario.**  USD still dominant but operators
in jurisdictions with regulatory pressure on USD pricing switch
to local fiat or XDR.  No code change required; flip the env var,
restart the indexer.

**Hard USD-collapse scenario.**  All operators globally agree to
move to a new common unit.  Federation-wide coordination via
operator messaging (not in Morphit's scope); each operator flips
their env var to the new ticker.  Architecturally Morphit
survives without modification.

### Tier 2 (stablecoin) caveat under non-USD denomination

The morphit_native fetcher's Tier 2 (stablecoin-anchored) anchor
assumes the configured stablecoins are pegged to the **denomination
fiat**, not to USD.  Today the registry only has USD-pegged
stablecoins (USDT, USDC, DAI), which means:

- Operators with denomination=USD: Tier 2 works as designed.
- Operators with denomination=EUR: Tier 2 with USD-pegged
  stablecoins would give a price ~0% off from the EUR
  equivalent at current USD/EUR rates — operator should either
  set `MORPHIT_INDEXER_PRICE_FEED_STABLECOIN_KEYS=''` (disable
  Tier 2 stablecoin anchoring, fall back to Tier 1 USD-direct
  orders priced in EUR) or wait for EUR-pegged stablecoins to be
  added to the asset registry (EURT, EURC, EURS — none currently
  wired).

This is documented honestly in the env example and ADR.  Future
work (cp129+) can add EUR-pegged stablecoins to the registry.

### What this design DOESN'T solve (honest limitations)

- **Cross-instance denomination coordination.**  Different
  operators can pick different denominations.  A user on a
  EUR-denominated instance sees EUR prices; the same orderbook
  viewed via a USD-denominated instance shows USD prices.  This
  is by design (federation = per-operator sovereignty) but means
  there's no single "the BLURT price" displayed everywhere.  Users
  should treat the displayed price as a courtesy, not a
  cross-instance authoritative quote.

- **Fiat-to-fiat conversion.**  Morphit doesn't convert between
  fiats.  An order posted with `fiat_currency='USD'` shown on a
  EUR-denominated instance still displays the USD price stated
  by the trader.  Only the listing-fee echo and morphit_native-
  derived price use the denomination_fiat config.

- **Operator picks the "wrong" denomination.**  If an operator
  in the US sets `denomination_fiat='XAU'`, their users see
  gold-priced fees.  That's the operator's choice; users who
  disagree can switch to a different instance.

## Operator action required

- **None mandatory.**  Default remains `USD`; pre-launch instances
  inherit this automatically.

- **Optional for non-USD operators:** set the env var or use the
  wizard.

## Privacy + decentralization posture

Per priorities #1 and #2:

- **No new on-chain data.**  Denomination is a per-instance
  display preference; nothing crosses the federation.
- **No new federation-wide constants.**  Each operator decides
  their own.
- **No new operator-mandatory config.**  Default works.

## Future work

- **EUR-pegged / non-USD-pegged stablecoins in the asset
  registry** (cp129+).  Enables Tier 2 anchoring for non-USD
  denominations.

- **Per-asset denomination configurability** (cp130+).  Today
  the env var applies to BLURT pricing only.  When morphit_native
  gets wired for BTC/USD, XMR/USD, etc. (future ADR), each
  asset's denomination might want independent config — e.g. an
  operator could denominate BLURT pricing in EUR but BTC pricing
  in USD if that makes sense for their market.  Cp128 doesn't
  block this; the factory already accepts per-instance
  denominationFiat.

- **Symbol-table extension** in `formatFiat` for region-specific
  formatting niceties (e.g. Indian numbering system for INR uses
  lakhs/crores instead of millions/billions).  Today
  `Intl.NumberFormat` handles the basics correctly; locale-
  specific polish can come later.

## Related

- `apps/indexer/src/config/index.ts` — env var + Config field
- `apps/indexer/src/indexer/price/factory.ts` — reads config
- `apps/indexer/src/indexer/price/morphitNativeFetcher.ts` —
  generic factory was already parameterized (cp127)
- `apps/indexer/src/api/priceReceipt.ts` — reads config
- `apps/indexer/src/api/listingFeeBody.ts` — field rename
- `apps/indexer/src/api/listingFee.ts` — doc-comment update
- `apps/indexer/scripts/api-response-shape-smoke.ts` — rename +
  new EUR + XAU scenarios
- `apps/indexer/test/testutils/context.ts` — fakeConfig default
- `apps/web/src/lib/i18n/formatters.ts` — `formatFiat` added,
  `formatUsd` removed
- `apps/web/src/lib/components/StrangerFeeModal.svelte` — consumer
- `apps/web/src/routes/[lang]/post/+page.svelte` — consumer
- `apps/web/scripts/i18n-formatters-smoke.ts` — updated for
  `formatFiat`
- `apps/ops-cli/src/init/render.ts` — ListingFeeResult interface
  extended; env file generator emits new line
- `apps/ops-cli/src/init/steps.ts` — wizard step picker
- `ops/env/indexer.env.example` — documents the new env var
- FAQ entry `where_does_blurt_price_come_from` × 10 locales — new
  paragraph about configurability
