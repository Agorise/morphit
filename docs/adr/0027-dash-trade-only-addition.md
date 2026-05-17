# ADR-0027 — DASH trade-only addition

**Status:** Accepted (Part 122 cp27, 2026-05-17)

**Supersedes:** None.  Extends the trade-only Category-B template
established by ADR-0023 (USDT), ADR-0024 (BCH), and ADR-0025 (LTC).

**Memory invariants involved:** #23 (fee_method enum frozen at
`{blurt, btc, xmr, waived_first_buy}`), #25 (every new trade-only
asset ships default-ON instance-wide, operator override via
`MORPHIT_INDEXER_DISABLED_ASSETS`).

---

## Context

After cp24 added LTC, Ken proposed Dash (DASH) as the next
trade-only asset.  Dash brings a notable shape to the Morphit
roster: it's the first transparent Bitcoin-family chain on
Morphit with a **chain-level opt-in privacy upgrade**
(PrivateSend), placing it between BTC/BCH/LTC (transparent only)
and XMR (mandatory chain-level privacy) on the privacy spectrum.

The asset-registry pattern matured through cp21/cp24 means
adding DASH is a content task across known seams.  cp27 ships
the addition with proactive cp23-DD-class closure (every
downstream typed-consumer site touched in the same checkpoint,
not deferred to a follow-up DD).

## Decision

**Decision 1 — Trade-only Category B.**  DASH is added with
`canBeTraded: true, canPayListingFee: false`.  Listing fees
stay BLURT/BTC/XMR; the fee_method enum stays frozen per
Memory #23.  Same posture as USDT/BCH/LTC.

**Decision 2 — Single-network mainnet.**  Dash has no per-network
sub-chains (no testnet split, no L2).  `supportedNetworks:
['mainnet']`, `defaultNetwork: 'mainnet'`.  No network picker
shown in the address-share modal or post-order form.

**Decision 3 — No privacy warning chip.**  `privacyWarningKey:
null`.  Dash is transparent at the base layer (like BTC/BCH/LTC)
and fully decentralized — no central issuer can freeze
addresses.  PrivateSend is wallet-side and per-transaction
opt-in, not a chain-level property worth warning about; if
anything, surfacing PrivateSend on the address-share modal would
mislead users into thinking Morphit performs the mixing.  The
per-asset privacy guide at `/[lang]/privacy/dash` explains
PrivateSend's actual mechanics and trade-offs.

**Decision 4 — Address validator accepts X-prefix P2PKH and
7-prefix P2SH.**  Dash addresses are 34 chars total, base58, with
the version byte distinguishing P2PKH (`X`) from P2SH (`7`).  Both
forms exist in the wild; receiving wallets do chain-binding +
checksum validation, so the registry validator is shape-only.
Permissive — same posture as the BCH and LTC validators.  No
bech32-equivalent native to Dash (the chain stayed on base58
throughout its evolution).

**Decision 5 — decimals: 8 (duff == satoshi).**  Dash forked from
Litecoin which forked from Bitcoin; the 8-decimal smallest-unit
semantics were preserved across both forks.

**Decision 6 — Bundled chat-link explorer:
`https://insight.dash.org/insight/tx/{txid}`.**  Operator's
9-candidate survey: blockchair.com/dash, explorer.dash.org/insight/,
chainz.cryptoid.info/dash/, oklink.com/dash,
bitinfocharts.com/dash/explorer/, insight.dash.org/insight/,
blockexplorer.one/dash/mainnet,
blockchain.com/explorer/assets/dash, dash.tokenview.io.
**Chosen:** insight.dash.org — official Dash project, community-led,
open-source backend, no third-party ad/tracking layer.  Same
posture as litecoinspace.org (chosen for LTC in ADR-0025) and
mempool.space (BTC).  Aligns with Morphit priority #1
(privacy/anonymity).  Excluded: blockchair/tokenview (commercial
aggregators), oklink/blockchain.com (exchange-affiliated —
conflicts with priority #2 decentralization), bitinfocharts /
blockexplorer.one / chainz.cryptoid.info (third-party
aggregators with various tracking overhead).  Operators wanting
a different default override via
`MORPHIT_FRONTEND_DASH_CHAT_LINK_URL`.

**Decision 7 — PrivateSend as `'privatesend'` in
`AssetEntry.privacyFeatures.optInPrivacyTech`.**  PrivateSend is a
masternode-coordinated CoinJoin variant using denominated input/
output amounts.  Surfaced in the per-asset privacy guide page
(`/[lang]/privacy/dash`) and in the `privacy.opt_in_tech.privatesend`
i18n keys.  Pre-mixing happens entirely wallet-side BEFORE the
address is shared on Morphit — Morphit does not coordinate the
mix, hold the funds, or expose users to masternode-trust
trade-offs beyond what their wallet already does.

**Decision 8 — Default-ON instance-wide.**  Per Memory #25, new
assets ship enabled.  Operators preferring a narrower asset
policy disable per-asset via `MORPHIT_INDEXER_DISABLED_ASSETS="DASH"`
or via the `morphit-ops init` wizard step 13.  The cp22
wizard auto-picks up DASH via the
`canBeTraded && !canPayListingFee` filter.

**Decision 9 — Placeholder SVG logo at
`apps/web/static/icons/icon-dash.svg`.**  Path-based stylized "D"
in Dash-brand-blue (#008CE7) disc, no `<text>` elements (per
ADDING-A-COIN.md font-fallback rule).  Same placeholder posture
as the BCH/LTC logos shipped in cp21/cp24.  REVISIT §E entry
filed for community-blessed artwork swap-in pre-launch or
post-launch.

## Consequences

**Positive:**

- DASH is the 4th Category-B asset (USDT, BCH, LTC, DASH).  The
  trade-only template has matured to a point where adding the
  next asset is a 1-day content-and-wiring task.
- Privacy-conscious traders gain an additional rail with opt-in
  mixing as a wallet-side option, sitting between transparent
  BTC/BCH/LTC and mandatory-private XMR.
- The `privatesend` enum extension follows the cp26
  privacy-framework pattern — `optInPrivacyTech` is now
  `['mweb','cashfusion','coinjoin','payjoin','privatesend']` and
  every per-asset privacy guide page surfaces the relevant entries
  automatically.

**Negative / trade-offs:**

- DASH SVG logo is a placeholder pending community-blessed
  artwork.  REVISIT §E entry tracks this.
- PrivateSend masternode-coordination is a trust trade-off the
  privacy guide must explain honestly: the protocol is
  non-custodial (masternodes never hold your coins) but the
  coordinator sees the mixing pattern.  Users wanting maximum
  privacy on Morphit should still use XMR.
- 7 tradable assets is a meaningful UI surface — keeping the
  asset-picker, address-share modal, funds-sent modal, and
  cheat-sheet readable matters for the grandma-friendly
  priority.  The horizontal-scrolling tab layout still fits
  comfortably; revisit if/when an 8th asset is added.

## Files changed

Canonical asset registry, chat payload (regex + dispatchers +
URI scheme + jitter dispatcher), frontend asset registry,
explorer plumbing (urlsCore + urls + instance store + indexer
config + matrix-bot schema), ops-cli wizard (step 12 prompt +
step 13 auto-picks up + CATEGORY_B_DESCRIPTIONS), 10 locale
files (14 keys each = 140 strings; native for en/es/fr/de +
EN-fallback for it/pl/ru/fa/zh-CN/zh-HK), 5 UI dispatches
(AddressShareModal/FundsSentModal/ChatMessage/ConversationView/
post-page), prices internalStore + reset + COINGECKO_IDS +
FALLBACK_USD, RESERVED_CANONICAL_KEYS + frontend payments
registry, cheat-sheet route, schema.sql comments, API.md
examples, GRANDMA-FRIENDLY-INVESTIGATION.md, llms.txt +
llms-full.txt asset enumerations, FAQ entries (3 × 10 locales),
brag list (10 enumeration patches + new entry #279), this ADR,
new packages/asset-registry/scripts/dash-trade-only-smoke.ts
(13 scenarios), disabled-assets-wizard-smoke updated to expect
4 Category-B tickers (17 → 18 scenarios).

## Smoke baseline impact

cp26-DD 3,306 → cp27 3,320: +13 dash-trade-only-smoke + 1 new
DASH-in-disabled-assets-wizard scenario.  privacy-features-registry
smoke extended VALID_TECH + per-ticker maps for DASH (36 → 42
scenarios — but already counted in cp26 → cp26-DD baseline math,
so no new scenarios added here).
