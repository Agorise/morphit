# ADR-0023 — USDT (Tether) multi-network support

**Status:** Accepted (Part 121)
**Date:** 2026-05-13
**Deciders:** project maintainer
**Supersedes:** none
**Superseded by:** none
**Related:** ADR-0011 (fee model, including the Part 121
fee_method enum-freeze forward-note), ADR-0021 (payment-method
registry — fiat rails, intentionally separate from
trade-asset registry).

## Context

Morphit's pre-launch asset registry shipped with three trade-asset
tickers: BTC, XMR, and BLURT.  Each is a single-network asset.  In
the post-cp2 audit Ken asked whether adding new coins, specifically
USDT (Tether), would be easy — and committed to add USDT as the
fourth tradable asset.

The investigation findings (Part 121 AUDIT entry) confirmed the
asset registry already carried the right discriminator flags
(`canBeTraded` and `canPayListingFee` with a literal "reserved
for future fee-only/stable-only tickers" comment), but three
real gaps existed:

1. `apps/web/src/lib/explorer/urls.ts` hardcoded `if (asset ===
   'BTC')` / `if (asset === 'XMR')` branches — adding a
   trade-only asset's explorer link would require new hardcoded
   branches.
2. No sub-network field for multi-network coins.  USDT exists on
   Ethereum (ERC-20), Tron (TRC-20), Solana (SPL), BNB Smart
   Chain (BEP-20), Bitcoin Omni Layer (deprecated), and several
   L2s.  The order-row had no way to express "USDT on Tron."
3. No privacy-warning surface.  USDT is centrally controlled
   (Tether Inc. can freeze any address) and has no on-chain
   privacy.  Per Memory #19 (privacy is priority #1), users
   considering USDT must be told this clearly — not buried in
   docs.

This ADR documents the design decisions that closed those gaps
and shipped USDT as Morphit's first multi-network and first
trade-only asset.

## Decision

### 1. USDT is **trade-only** (cannot pay listing fees)

Memory #23 invariant: listing fees can ONLY be paid in BLURT,
XMR, or BTC.  USDT (and any future trade-only asset) is
peer-to-peer trading only.  Users can buy/sell USDT, the
listing fee for those orders is paid in BLURT/BTC/XMR.

Enforced by two wire-format-frozen sentinel smokes
(`fee-method-enum-frozen-smoke`,
`first-buy-waiver-payment-agnostic-smoke`) and the asset
registry's hard invariant
(`canPayListingFee: true → ticker ∈ {BLURT, BTC, XMR}`).

The first-buy waiver still applies regardless: a new user
buying their first BLURT and paying their counterparty in USDT
still gets the waiver, because the waiver covers the LISTING
FEE (which is paid in BLURT or waived entirely), not the trade
settlement currency.

### 2. **Single registry entry**, network picked at trade time

We considered three options:

- **Option A** — separate entries per network: `USDT-ERC20`,
  `USDT-TRC20`, etc., as distinct tickers in the registry.
  Rejected: would explode the orderbook into N variants per
  asset, fragment liquidity, confuse users (which is the
  "real" USDT?), and produce ugly UI ("buy USDT-ERC20 with
  USD via Wise").
- **Option B** (chosen) — single `USDT` entry, network picked
  at trade time via a required `assetNetwork` field on the
  order payload.  The asset registry declares
  `supportedNetworks: ['erc20', 'trc20', 'spl', 'bep20']`
  and `defaultNetwork: null`.  The /post form requires
  explicit user choice every trade; no remembered default.
  The orderbook row renders the network as a chip
  ("Tron (TRC-20)") next to the asset.
- **Option C** — auto-detect network from address shape.
  Rejected: ERC-20 and BEP-20 share the same address format
  (both EVM-compatible), so shape isn't sufficient to
  disambiguate.  Would also defeat the deliberate friction we
  want users to feel ("I am committing to USDT on Tron").

### 3. **`defaultNetwork: null`** — force explicit choice every trade

Cross-network sends lose funds permanently.  USDT-ERC20 sent
to a TRC-20 address is unrecoverable.  We refuse to default
the user into any of those losses; every USDT trade requires
a deliberate network commit.

The form-level smoke (`usdt-network-picker-required-smoke`)
sentinel-greps `/post +page.svelte`, `AddressShareModal`, and
`FundsSentModal` for the `usdtNetwork !== null` gate in
their respective `canSubmit` derivations.  If any future
refactor drops the gate, the smoke fails loudly in CI.

### 4. **Native USDT only** — no bridged versions

USDT exists in native form on each supported chain (the
canonical Tether-issued contract).  It also exists in bridged
forms (`USDT.e` on Avalanche-L2, etc.).  We support **native
only**: fewer footguns, cleaner mental model, simpler audit
surface for operators.

If a future bridged variant gains material P2P-trading
adoption, that's a new ADR — not a registry edit.

### 5. **Omni Layer USDT is excluded**

Tether themselves deprecated Omni-Layer USDT.  Adding it to
our supported networks list would endorse a path Tether is
actively winding down.  Omitted at launch.

### 6. **Information chip** on every USDT surface

Per Memory #19 (privacy is priority #1) and Memory #27 (respectful
copy about every listed asset), users considering an asset whose
technical properties differ from Morphit's defaults should be told
about those properties so they can make an informed choice.  For
USDT, two facts are worth surfacing:

- **Issuance and administration**: USDT is issued and administered
  by Tether Inc., who have the technical ability to freeze addresses
  on the host chain and have used that ability in the past (mostly
  in response to law-enforcement requests).
- **On-chain visibility**: USDT transactions on each supported host
  chain (Ethereum, Tron, Solana, BNB Smart Chain) are publicly
  visible on those chains.  This is a property of the chain, not
  unique to USDT.

The information chip (`<PrivacyWarningChip
privacyWarningKey="usdt_centralized" />`) renders in the
`/post` form, in `AddressShareModal` (when sharing a USDT
address), and as a permanent per-message banner in
`ChatMessage` (so a buyer re-checking an old chat message
still sees the context before sending).  The copy is
factual, not judgmental — millions of traders use USDT
every day for its stability and liquidity, and the chip is
information for an informed choice, not a warning to avoid
the asset.

The component is named `PrivacyWarningChip` for historical
reasons (the first asset to use it was USDT and the
shorthand stuck); the i18n key is the source of truth and
the body copy is neutral.

### 7. **Operator opt-out** — default-ON with `MORPHIT_INDEXER_DISABLED_ASSETS`

Memory #25: every new tradable asset ships **default=ON
instance-wide**, with an operator-config override to disable.
Pattern: `MORPHIT_INDEXER_DISABLED_ASSETS` env var
(comma-separated tickers).  Operators with philosophical or
regulatory objections to a specific asset flip the switch;
canonical morphit.io ships everything on.

Per-asset opt-out is OPERATOR-level, not user-level.
Individual users who object to a particular asset pick a
different Morphit instance.  Federation rules: orders for an
asset disabled on instance A but enabled on instance B still
appear in B's orderbook (cross-instance read-only visibility
preserved); A simply refuses to ACCEPT new orders for that
asset from its own users.

### 8. **Bundled explorer defaults** per network

Operators can override per-network explorer templates via the
instance config (`chat_link_urls.usdt.{erc20,trc20,spl,bep20}`),
but Morphit ships bundled defaults so a fresh install renders
working tx-links out of the box:

- ERC-20 → `https://etherscan.io/tx/{txid}`
- TRC-20 → `https://tronscan.org/#/transaction/{txid}`
- SPL → `https://solscan.io/tx/{txid}`
- BEP-20 → `https://bscscan.com/tx/{txid}`

These were drawn from the canonical block-explorer list for
each chain.  Operators running self-hosted instances of the
same chains (privacy-conscious) override via the per-network
env vars (`MORPHIT_FRONTEND_USDT_CHAT_LINK_URL_TRC20`, etc.).

### 9. **Live USDT/USD price subline** on every USDT order row

USDT pegs 1:1 to USD by design, but pegs break.  2018 saw
USDT trade at $0.91; 2022 saw it at $0.95.  When the peg
breaks, a "1000 USDT" order's displayed USD-value becomes
a lie unless we surface the actual peg state.

The orderbook row carries a small `<UsdtPriceSubline />`
component that reads from the existing `$lib/prices` store
(Coingecko provider on the live path, fallback static-1.00
when the feed is unreachable).  Renders as `1 USDT = $1.00
live` when fresh; falls back to `USDT/USD price feed
unavailable — last seen 12m ago.` when stale (5+ minutes old).

## Consequences

### Positive

- USDT trades work end-to-end: post, orderbook, address-share,
  funds-sent, chat-message rendering, per-network explorer
  links — all driven by single registry entries with no
  hardcoded branches per network.
- The wire-format-frozen `fee_method` enum invariant
  (memory #23) is preserved.  Three sentinel smokes guard
  against future drift.
- Operators with philosophical objections to USDT can disable
  it instance-wide with one env-var flip.  The canonical
  morphit.io ships USDT on; alternative instances can be
  XMR-pure or BTC+XMR-only.
- The pattern generalizes: adding ARRR (or any future
  trade-only asset) is a single asset-registry entry plus
  optional per-network metadata, no code-level branches.

### Negative / accepted costs

- USDT traders on Morphit see the information chip every
  time they post or share an address.  This is a small
  friction in service of an informed-choice user model —
  Memory #19 keeps the chip in place, Memory #27 keeps
  its tone factual.
- The network picker is required on every USDT trade with no
  default.  Slightly more friction than a default-and-edit
  flow, accepted because cross-network-mis-send is
  unrecoverable.
- We carry per-network metadata (regexes, explorers) for
  four networks.  Adding a fifth is one entry in
  `apps/web/src/lib/assets/networks.ts` plus four i18n
  translations per locale (displayName + feeHint per locale
  × 10 locales = 40 strings).
- Operators with `MORPHIT_INDEXER_DISABLED_ASSETS` listing
  USDT see USDT orders from peer instances in their read-only
  feeds but cannot accept new USDT orders from their own users.
  Cross-instance discoverability is preserved; local
  posting authority is the operator's call.

### Forward-looking

If/when Tether adds support on a new chain that gains
material P2P-trading adoption, the addition is:

1. Add the new network key to `USDT_NETWORKS` in
   `apps/web/src/lib/assets/networks.ts` (regex + bundled
   explorer URL).
2. Add the matching i18n keys: `assets.usdt.network.<key>.{
   displayName, feeHint}` × 10 locales.
3. Add the canonical registry update:
   `supportedNetworks` array grows to N+1.
4. Document in this ADR (a "2026-XX-XX forward note"
   section).

No structural code changes needed.

## Implementation references

Code:
- `packages/asset-registry/src/index.ts` — canonical USDT entry
- `apps/web/src/lib/assets/registry.ts` — frontend mirror
- `apps/web/src/lib/assets/networks.ts` — per-network metadata
- `apps/web/src/lib/components/PrivacyWarningChip.svelte`
- `apps/web/src/lib/components/UsdtNetworkPicker.svelte`
- `apps/web/src/lib/components/UsdtPriceSubline.svelte`
- `apps/web/src/lib/components/AddressShareModal.svelte`
- `apps/web/src/lib/components/FundsSentModal.svelte`
- `apps/web/src/lib/components/ChatMessage.svelte`
- `apps/web/src/lib/explorer/urls.ts` (registry-driven dispatch)
- `apps/web/src/routes/post/+page.svelte`
- `apps/web/src/routes/orderbook/+page.svelte`
- `apps/indexer/src/indexer/handlers/order.ts` (instance-wide
  disable gate + `asset_network_required_for_usdt` validation)
- `apps/indexer/src/config/index.ts`
  (`MORPHIT_INDEXER_DISABLED_ASSETS`)
- `apps/indexer/src/db/schema.sql` (v32 migration:
  `orders.asset_network`)

Smokes:
- `packages/asset-registry/scripts/usdt-trade-only-smoke.ts`
- `packages/asset-registry/scripts/usdt-network-picker-required-smoke.ts`
- `packages/asset-registry/scripts/fee-method-enum-frozen-smoke.ts`
  (Part 121 cp1 — still relevant; pins USDT out of the
  fee-method enum)

i18n: 25+ new keys × 10 locales documenting USDT-specific
copy (privacy warning, network names, fee hints, picker UI,
address-share copy, order-row hints, price subline,
disabled-on-instance message).

Docs:
- `docs/FEES-AND-REWARDS.md` §"What is FROZEN" — USDT named
  in the trade-only row.
- `docs/ADDING-A-COIN.md` — Category B worked example
  references USDT as the canonical reference.
- `docs/OPERATIONS.md` — operator-config for
  `MORPHIT_INDEXER_DISABLED_ASSETS` and per-network explorer
  overrides.
- `docs/RUN-A-MORPHIT-NODE.md` — USDT support setup section.
- `docs/PRE-LAUNCH-CHECKLIST.md` — operator stance on USDT
  checklist item.
