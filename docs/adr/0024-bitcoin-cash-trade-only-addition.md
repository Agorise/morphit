# ADR-0024 — Bitcoin Cash (BCH) trade-only addition

**Status:** Accepted (Part 122 cp21)
**Date:** 2026-05-17
**Deciders:** project maintainer
**Supersedes:** none
**Superseded by:** none
**Related:** ADR-0023 (USDT multi-network — established the
Category A/B trade-only pattern that BCH follows), ADR-0011
(fee model + fee_method enum-freeze).

---

**2026-05-17 (Part 122 cp22) forward-note — operator-stance UX
closure.**  Same closure as ADR-0023's cp22 forward-note: the
`MORPHIT_INDEXER_DISABLED_ASSETS` env var path established here
remains the canonical contract; cp22 adds an interactive wizard
step that walks operators through enabling/disabling each
trade-only asset (USDT and BCH today, plus any future
Category-B addition) and emits the right env-file line without
manual editing.  The wizard iterates the canonical registry
filtered to `canBeTraded && !canPayListingFee`, so future
trade-only assets surface in the wizard automatically without
per-asset wizard code changes.  Discoverability win for
operators; design contract from this ADR unchanged.

---

## Context

After USDT shipped as Morphit's first Category-B trade-only
asset (ADR-0023, Part 121), Ken asked whether adding a few more
trade-only coins — Bitcoin Cash, Dash, and similar — would be
similarly contained, and committed to add BCH as the fifth
tradable asset.

The Category-B pattern from ADR-0023 was designed to make this
exact case routine: single entry in
`packages/asset-registry/src/index.ts` with
`canPayListingFee: false` + `canBeTraded: true`, a mirror in the
frontend registry, no fee-verifier (it can't pay fees), the
ADDING-A-COIN.md inputs (logo, address regex, txid regex,
explorer URL).  This ADR records the BCH-specific choices.

## Decision

### 1. BCH is **trade-only** (Category B)

Same posture as USDT.  The `fee_method` wire-format enum stays
exactly `'blurt' | 'waived_first_buy' | 'btc' | 'xmr'` —
`fee-method-enum-frozen-smoke.ts` continues to pin this.  A
new `bch-trade-only-smoke.ts` mirrors `usdt-trade-only-smoke.ts`
as a BCH-specific sentinel that fails loudly if a future
contributor toggles BCH's `canPayListingFee` to true.

### 2. **Single-network** — mainnet only

BCH is single-network (unlike USDT).  `supportedNetworks:
['mainnet']`, `defaultNetwork: 'mainnet'`.  No network picker
shown in the post-order form or address-share modal.  The
`asset_network` field on order/chat payloads stays undefined for
BCH (it's required only for `asset === 'USDT'`).

### 3. **No privacy warning chip**

`privacyWarningKey: null`.  BCH is transparent (like BTC) but
decentralized — no issuer can freeze addresses, no central
authority can blacklist holders.  Same posture as BTC: users
opting into Bitcoin Cash know its traceability properties; we
don't surface a warning where none is needed.  This is a
deliberate philosophical alignment, not a copy-paste oversight:
the warning chip exists for assets that compromise either of
the top-2 priorities (privacy or decentralization), and BCH
compromises neither.

### 4. Address validator accepts both **CashAddr and legacy**

BCH wallets in the field emit either format.  CashAddr is the
modern BCH standard (post-2018), with or without the
`bitcoincash:` prefix.  Legacy P2PKH (1...) and P2SH (3...)
addresses share their format with pre-fork Bitcoin and are
still accepted by most BCH wallets.  Our shape-check regex
accepts all four cases:

```ts
addressShape:
  /^(bitcoincash:[qp][a-z0-9]{41}|[qp][a-z0-9]{41}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/
```

This is a permissive shape check, not a checksum — the
recipient's wallet does the real verification.  Tradeoff
discussed and accepted: a `1...` or `3...` address typed in
the BCH tab could be a BTC address that the user picked the
wrong tab for.  We can't disambiguate from the shape alone; the
buyer's wallet will refuse if it's wrong-chain.  The friction
is acceptable to avoid rejecting legitimate legacy BCH
addresses.

### 5. Decimals = 8 (same as BTC)

BCH preserved BTC's satoshi-denominated smallest unit across
the 2017 fork.  The amount-formatter and form-input precision
match BTC's behavior exactly.

### 6. Bundled chat-link explorer: `blockchair.com/bitcoin-cash`

Operator surveyed eight BCH explorers at cp21 addition time:

1. https://blockchair.com/bitcoin-cash
2. https://www.blockchain.com/explorer
3. https://bitinfocharts.com/bitcoin%20cash/explorer/
4. https://bchexplorer.info/
5. https://www.oklink.com/bch
6. https://bch.tokenview.io/
7. https://blockexplorer.one/bitcoin-cash/mainnet
8. https://explorer.cloverpool.com/bch

Chose **blockchair.com/bitcoin-cash** as the bundled default
based on:
- Well-established multi-chain explorer (operating since 2017)
- Predictable URL format: `/transaction/{txid}`
- Good uptime track record
- No mandatory JavaScript for the basic tx-view page
- Doesn't aggressively fingerprint visitors

Operators wanting a different default override per-instance via
`MORPHIT_FRONTEND_BCH_CHAT_LINK_URL`; the env var follows the
same shape contract as BTC/XMR (`https://…/{txid}`, must contain
the `{txid}` placeholder, must parse as a valid URL).  The
ops-cli wizard step 12 now asks for the BCH URL after BTC and
XMR with the same probe-reachability check.

### 7. Default-ON instance-wide, operator opt-out via env var

Per Memory #25 (every new asset ships default-ON instance-wide,
operator override).  An operator who wants to refuse BCH orders
on their instance sets `MORPHIT_INDEXER_DISABLED_ASSETS="BCH"`
(or includes BCH in a comma-separated list).  Federation-wise:
disabled-on-A doesn't break visibility of BCH orders posted on
peer instance B — they still appear in A's read-only orderbook
view.  A only refuses to ACCEPT new BCH orders posted FROM its
own users.

### 8. Logo placeholder pending community artwork

`apps/web/static/icons/icon-bch.svg` ships as a path-based
stylized "B" inside a BCH-brand-green disc (#0AC18E).  No
`<text>` elements (font-fallback rules from ADDING-A-COIN.md).
The placeholder is honest art, not a community-blessed
official mark — flagged in REVISIT-LIST as a deferred swap-in
when the BCH community provides their preferred SVG.

## Files changed

Canonical asset registry:
- `packages/asset-registry/src/index.ts` — `ASSET_TICKERS`
  extended `['BTC','XMR','BLURT','USDT']` → `['BTC','XMR','BLURT','USDT','BCH']`;
  full `BCH` `AssetEntry` appended to `ASSETS`.

Frontend asset registry:
- `apps/web/src/lib/assets/registry.ts` — `validateBch`
  function; frontend BCH entry (logoSvgPath, accentClass
  `text-lime-500`, decimals 8, supportsMemo false).

Chat payload:
- `apps/web/src/lib/chat/payload.ts` — 5 BCH regex constants
  (CashAddr prefixed/bare, legacy P2PKH/P2SH, txid),
  `'bch'` added to `ChatAssetTicker` union, `isValidBchAddress`
  + `isValidBchTxid` functions, `isValidAddress` + `isValidTxid`
  dispatchers extended.

Explorer URL plumbing:
- `apps/web/src/lib/explorer/urlsCore.ts` — `BCH_TXID_RE`,
  `BUNDLED_BCH_CHAT_LINK_URL`.
- `apps/web/src/lib/explorer/urls.ts` — `'BCH'` in
  `ExternalAsset` type, `EXPLORER_REGISTRY.BCH` entry,
  re-export.

Indexer + clients:
- `apps/indexer/src/api/instance.ts` — `chat_link_urls.bch`
  field, emitted in body.
- `apps/indexer/src/config/index.ts` — `frontendBchChatLinkUrl`
  field, `MORPHIT_FRONTEND_BCH_CHAT_LINK_URL` Zod schema,
  mapped in Config builder.
- `packages/indexer-client/src/index.ts` — `bch?` in
  `chat_link_urls` schema (optional for back-compat).
- `apps/matrix-bot/scripts/api-response-shape-smoke.ts` — `bch`
  in `ChatLinkUrlsSchema`.

Instance store:
- `apps/web/src/lib/stores/instance.ts` — `bch: string | null`
  in store interface, FALLBACK, fetch handler defensive
  fallback.

ops-cli:
- `apps/ops-cli/src/init/steps.ts` — `DEFAULT_BCH_CHAT_LINK_URL`,
  `ChatLinkExplorersResult.bch`, step 12 explain text +
  BCH prompt + return value.
- `apps/ops-cli/src/init/render.ts` — emits
  `MORPHIT_FRONTEND_BCH_CHAT_LINK_URL` in rendered env file.

UI dispatches:
- `apps/web/src/lib/components/AddressShareModal.svelte` — BCH
  tab, placeholder dispatch, invalid-address message.
- `apps/web/src/lib/components/FundsSentModal.svelte` — BCH tab.
- `apps/web/src/lib/components/ChatMessage.svelte` — BCH
  branches in explorer URL dispatch, address-pill label,
  funds-sent pill title; `canMarkSent` guard extended;
  `onMarkSent` callback type widened.
- `apps/web/src/lib/components/ConversationView.svelte` —
  `markSentArgs` + `handleMarkSentClick` types widened.
- `apps/web/src/routes/[lang]/post/+page.svelte` — BCH tooltip
  block in asset picker.

i18n × 10 locales:
- `apps/web/src/lib/i18n/locales/{en,es,fr,de,it,pl,ru,fa,zh-CN,zh-HK}.json` —
  `assets.bch.{displayName, oneLineDescription, disabled_on_instance}`,
  `chat.address.{method_bch, address_placeholder_bch, address_invalid_bch, pill_method_bch}`,
  `chat.funds_sent.pill_title_bch`, `home.asset_subtitles.bch`,
  `post_order.form.asset_explainer.bch`,
  `payment_method.pay_bch.description`,
  `cheat_sheet.section_assets.bch`.

Logo:
- `apps/web/static/icons/icon-bch.svg` — path-based stylized
  BCH "B" on green disc, placeholder pending community
  artwork.

Smoke:
- `packages/asset-registry/scripts/bch-trade-only-smoke.ts` —
  13 scenarios, mirrors `usdt-trade-only-smoke.ts`.
- `scripts/run-smokes.sh` — registers
  `packages/asset-registry:bch-trade-only-smoke`.

## Consequences

**Positive:**
- Two trade-only assets now shipped (USDT, BCH); the Category-B
  pattern is exercised twice and the indexer/frontend split
  holds.  Future trade-only additions (Dash, Litecoin, etc.)
  follow the same template with even less new code.
- BCH community visibility — a long-running coin with
  established users now has a no-KYC P2P trading rail.
- Asset count: BTC, XMR, BLURT, USDT, BCH = 5.

**Trade-offs accepted:**
- Legacy BCH addresses (1.../3...) are indistinguishable from
  BTC addresses at the shape-check layer.  Mitigation:
  recipient wallet rejects wrong-chain sends.  Friction
  considered acceptable to avoid rejecting legitimate
  legacy-format BCH addresses.
- Logo is a placeholder.  Marketing materials note this
  explicitly; brag-list entry doesn't claim official artwork.
- One more chat-link override env var (`MORPHIT_FRONTEND_BCH_CHAT_LINK_URL`)
  for operators to remember — but the ops-cli wizard step 12
  walks them through it.

**Future revisits:**
- Replace the placeholder SVG with a community-blessed BCH
  artwork (REVISIT-LIST item).
- If the BCH community pushes for CashAddr-only behavior,
  consider tightening the validator to reject legacy P2PKH/P2SH
  (currently accepted).
- If/when Dash, Litecoin, or similar request inclusion, mirror
  the same Category-B template — the pattern is now proven for
  single-network trade-only coins.
