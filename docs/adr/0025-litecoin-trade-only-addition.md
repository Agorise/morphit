# ADR-0025 — Litecoin (LTC) trade-only addition

**Status:** Accepted (Part 122 cp24)
**Date:** 2026-05-17
**Deciders:** project maintainer
**Supersedes:** none
**Superseded by:** none
**Related:** ADR-0023 (USDT multi-network — established the
Category A/B trade-only pattern), ADR-0024 (Bitcoin Cash — first
single-network Category-B addition), ADR-0011 (fee model +
fee_method enum-freeze), Part 122 cp22 (interactive
disable-trade-only-asset wizard step).

## Context

Following BCH's successful single-network Category-B integration
in Part 122 cp21 (ADR-0024), the project maintainer requested
Litecoin (LTC) as the third Category-B trade-only asset.  LTC
shares BCH's architectural shape — single-network transparent
chain, no central issuer, BTC-fork heritage — making the cp21
template directly applicable.

The cp21 BCH addition surfaced a CLASS of bugs cp23's fresh
deep-deep found: canonical-source extensions (asset registry,
chat payload, primary UI dispatches) but missed downstream
typed-consumer maps (price store, Coingecko ID map, fallback
prices, payment-method registry, cheat-sheet, crawler-facing
static files).  Cp24 closes those proactively for LTC rather
than waiting for a post-addition DD to surface them.

## Decision

LTC ships as the third Category-B trade-only single-network asset
following ADR-0024's template, with eight design choices:

### 1. Trade-only (Category B), `canPayListingFee: false`

Listing-fee payment methods remain frozen at `{blurt, btc, xmr,
waived_first_buy}` per Memory #23 / ADR-0011.  Adding LTC as a
new fee_method enum value would break the wire-format invariant
that smokes (`fee-method-enum-frozen-smoke`) explicitly pin.

LTC users trade LTC; they pay listing fees in BLURT/BTC/XMR
like every other Category-B asset.

### 2. Single-network mainnet

LTC has no production sidechains, L2s, or wrapped-asset variants
on Morphit's radar.  No per-network picker; defaults to mainnet
and stays there.  This is the BCH posture, NOT the USDT posture.

### 3. No privacy-warning chip (`privacyWarningKey: null`)

LTC is transparent (like BTC and BCH) but the chain is fully
decentralized and LTC addresses cannot be frozen by an issuer.
Same posture as BTC/BCH: no warning chip needed.

Note: LTC has opt-in privacy via MWEB (MimbleWimble Extension
Blocks).  MWEB is wallet-side and per-transaction, NOT a chain
property.  Users seeking Morphit's strongest privacy posture
should use XMR.  MWEB-enabled trades are not specially flagged
in Morphit's UI; the operator-counterparty knows the privacy
posture of the addresses they share.

### 4. Address validator accepts ALL four LTC formats

LTC has three address-shape eras:

1. **Legacy P2PKH** starting with `L` — base58, 26-35 chars.
   Unambiguous with BTC since BTC P2PKH starts with `1`.
2. **Modern P2SH** starting with `M` — base58, 26-35 chars.
   Introduced 2017 to disambiguate from BTC P2SH.
3. **Deprecated P2SH** starting with `3` — base58, 26-35 chars.
   **BTC-shape ambiguous.**  Still valid on the LTC chain.
4. **Bech32 / Bech32m** with `ltc1` prefix — 6-87 char body.
   Covers both segwit-v0 (`ltc1q...`) and taproot (`ltc1p...`).

Decision: accept all four including the deprecated `3`-prefix
P2SH form.  Recipient wallet does chain-binding on receive —
this matches ADR-0024 §4's stance for BCH legacy addresses.

Refusing the `3`-prefix form would be paternalistic toward LTC
users whose wallets still emit it.  The cost is the same as
BCH: a user pasting an LTC `3`-address while having selected BTC
as the asset wouldn't trigger a shape-level rejection.  Same
mitigation: clear UI labels at the picker stage.

### 5. Decimals = 8 (satoshi-denominated)

LTC inherited BTC's 8-decimal smallest-unit semantics; the
LTC ecosystem calls it "litoshi" but the encoding is identical.

### 6. Bundled explorer default: litecoinspace.org

From Ken's seven-explorer candidate list:
- `blockchair.com/litecoin` — multi-chain (same vendor as BCH default)
- `oklink.com/litecoin` — OKX exchange-affiliated (centralization concern)
- `bitinfocharts.com/litecoin/explorer/` — analytics + tracking
- `chain.so/LTC` — older infrastructure, less actively maintained
- `litecoinspace.org` — community-led, mempool.space-style, no JS tracking, open-source
- `blockexplorer.one/litecoin/mainnet` — generic multi-coin
- `ltc.tokenview.io` — Chinese-operated multi-chain

Chosen: **`litecoinspace.org/tx/{txid}`**.  Rationale: it's the
LTC-equivalent of mempool.space (which we already use for BTC).
Privacy-aligned with Morphit's priority #1 (no JS tracking,
open-source).  Operators wanting a different default override
via `MORPHIT_FRONTEND_LTC_CHAT_LINK_URL`; all seven candidates
are enumerated in `docs/OPERATIONS.md` for operator reference.

### 7. Default-ON instance-wide; operator opt-out via env var

Per Memory #25: every new asset ships ENABLED by default on a
fresh instance.  Operators wishing to refuse LTC set
`MORPHIT_INDEXER_DISABLED_ASSETS="LTC"` (or include LTC in a
comma-separated list).

The `morphit-ops init` wizard step 13 "Trade-only asset policy"
(Part 122 cp22) walks new operators through this decision at
install time; LTC surfaces in the wizard automatically because
the wizard iterates `ASSETS.filter(a => a.canBeTraded &&
!a.canPayListingFee)` from the canonical registry.

### 8. Operator-approved logo at `apps/web/static/icons/icon-ltc.svg` (updated Part 122 cp27-DD2)

Silver-gray disc with stylized "Ł" (the Polish-style L with
diagonal slash that distinguishes Litecoin's mark from a
generic L).  No `<text>` elements (font-fallback rules from
ADDING-A-COIN.md).  Originally shipped at cp24 as a placeholder
pending community-blessed artwork from the Litecoin Foundation;
operator-approved as-is at cp27-DD2 (Ken: "the current ltc icon
looks great, i do not think u need to change that").  Minified
via svgo to 0.4 KB while preserving viewBox.  Drop-in SVG swap
remains supported with no other code changes if the Litecoin
Foundation later publishes a different mark.

## Files changed (cp24)

Code:
- `packages/asset-registry/src/index.ts` — `ASSET_TICKERS` extended; LTC `AssetEntry`
- `apps/web/src/lib/chat/payload.ts` — 4 LTC regex constants, `isValidLtcAddress` + `isValidLtcTxid`, `ChatAssetTicker` union widened, dispatcher widening, 4 dispatch gates widened, `buildPaymentUri` LTC branch (litecoin: URI scheme)
- `apps/web/src/lib/assets/registry.ts` — `validateLtc` helper, full LTC entry with `accentClass: 'text-slate-400'`
- `apps/web/src/lib/explorer/urlsCore.ts` — `LTC_TXID_RE`, `BUNDLED_LTC_CHAT_LINK_URL`
- `apps/web/src/lib/explorer/urls.ts` — `LTC` added to `ExternalAsset`, `EXPLORER_REGISTRY.LTC`
- `apps/web/src/lib/stores/instance.ts` — `chat_link_urls.ltc` field
- `apps/indexer/src/config/index.ts` — `frontendLtcChatLinkUrl` Config field + Zod schema + env-var mapping
- `apps/indexer/src/api/instance.ts` — `ltc: string | null` in `InstanceResponse`
- `apps/ops-cli/src/init/steps.ts` — `DEFAULT_LTC_CHAT_LINK_URL`, `ChatLinkExplorersResult.ltc`, LTC prompt block, `CATEGORY_B_DESCRIPTIONS` LTC entry
- `apps/ops-cli/src/init/render.ts` — `MORPHIT_FRONTEND_LTC_CHAT_LINK_URL` emission
- `apps/ops-cli/src/commands/init.ts` — LTC printReview line
- `apps/web/src/lib/components/AddressShareModal.svelte` — LTC tab + dispatches
- `apps/web/src/lib/components/FundsSentModal.svelte` — LTC tab
- `apps/web/src/lib/components/ChatMessage.svelte` — explorer dispatch, type unions widened, pill dispatches
- `apps/web/src/lib/components/ConversationView.svelte` — type unions widened
- `apps/web/src/routes/[lang]/post/+page.svelte` — LTC tooltip block
- `apps/matrix-bot/scripts/api-response-shape-smoke.ts` — `ltc` in `ChatLinkUrlsSchema`

Smokes:
- `packages/asset-registry/scripts/ltc-trade-only-smoke.ts` — NEW (13 scenarios)
- `apps/ops-cli/scripts/disabled-assets-wizard-smoke.ts` — Category-B count 2→3
- `scripts/run-smokes.sh` — `ltc-trade-only-smoke` registered

i18n:
- `apps/web/src/lib/i18n/locales/{en,es,fr,de,it,pl,ru,fa,zh-CN,zh-HK}.json` — 8 LTC keys per locale

Logo:
- `apps/web/static/icons/icon-ltc.svg` — operator-approved
  stylized "Ł" on silver disc, originally shipped cp24 as
  placeholder; operator approval Part 122 cp27-DD2; minified
  via svgo at cp27-DD.

cp23-DD-class downstream consumers (the BCH-class bugs cp23 found, closed proactively for LTC):
- `apps/web/src/lib/prices/index.ts` — `LTC: null` in `internalStore` + `reset()`
- `apps/web/src/lib/prices/providers/coingecko.ts` — `LTC: 'litecoin'`
- `apps/web/src/lib/prices/providers/fallback.ts` — `LTC: 100`
- `apps/web/src/routes/[lang]/cheat-sheet/+page.svelte` — LTC row
- `apps/web/src/lib/payments/registry.ts` — `pay_ltc` entry
- `apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts` — `pay_ltc` in `RESERVED_CANONICAL_KEYS`
- `apps/indexer/src/db/schema.sql` — comments updated
- `docs/API.md` — asset filter + example
- `docs/GRANDMA-FRIENDLY-INVESTIGATION.md` — status notes
- `apps/web/static/llms.txt` + `llms-full.txt` — references updated

## Consequences

### Positive

- **Third Category-B asset shipped** — pattern fully matured.
  Future trade-only additions (Dash, DOGE) will follow the
  same template with even less ceremony.
- **cp23-DD class closed proactively** — for the first time
  in the asset-addition lifecycle, the downstream typed-consumer
  maps are touched in the SAME checkpoint as the canonical
  registry, rather than days later in a follow-up DD.
- **Operator stance UX matures** — `morphit-ops init` step 13
  now walks through 3 Category-B assets (USDT, BCH, LTC) in
  alphabetical order with per-ticker Y/n prompts.

### Trade-offs accepted

- **Legacy `3`-prefix P2SH is BTC-shape ambiguous** (§4 above).
  Wallet does chain-binding on receive.  Same posture as BCH.
- **One more chat-link env var** — `MORPHIT_FRONTEND_LTC_CHAT_LINK_URL`.
  Operators editing the env file have one more line; the wizard
  hides this complexity behind a single prompt.

### Future revisits

- Possible MWEB awareness chip if/when MWEB-only trades become
  a UX concern (not at launch — wallet-side opt-in, no Morphit
  surface area).
- Same pattern extends to Dash, DOGE, etc.  Each new Category-B
  asset surfaces in the wizard automatically without per-asset
  wizard code.
