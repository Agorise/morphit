# ADR-0030 — Dogecoin (DOGE) as a 10th tradable asset (trade-only, single-network mainnet)

**Status:** Accepted (2026-05-19, Part 122 cp33)
**Context window:** Part 122 cp33 — DOGE addition, following the
matured Category-B template from cp27 (DASH), cp24 (LTC), cp21
(BCH), and Part 121 cp3 (USDT).

## Context

Ken's prompt 2026-05-19:

> add Dogecoin (DOGE). wire it up as well, COMPLETELY, and THEN
> do a deep deep on our latest work.  remember, any place where
> dash or ltc are mentioned, is probably also a good place to
> mention these new coins like doge, etc.  implement as many of
> our privacy things with this as we have done with the others
> so far.

DOGE is the 10th tradable asset on Morphit, joining the existing
9 (BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH).  It is the
7th Category-B trade-only asset (joining USDT, USDC, DAI, BCH,
LTC, DASH).

## Design decisions

### 1. Trade-only (Category B)

`canPayListingFee: false`, `canBeTraded: true`.  Per Memory #23,
listing fees stay frozen at BLURT / BTC / XMR.  DOGE is a P2P
trading asset only.

### 2. Single-network mainnet

`supportedNetworks: ['mainnet']`, `defaultNetwork: 'mainnet'`.
Dogecoin has no L2 with formal community endorsement.  Same
posture as BTC/BCH/LTC/DASH.

### 3. Privacy posture — null warning chip

`privacyWarningKey: null`.  Same posture as BTC/BCH/LTC/DASH.
DOGE is transparent at the base layer (every transaction
publicly visible) but fully decentralized — no issuer can freeze
addresses, no foundation controls supply since the fair-launch
emission completed in 2014.  Merge-mined with Litecoin (auxiliary
proof-of-work) gives DOGE inherited hashrate security without
competing for it.

`privacyFeatures.optInPrivacyTech: []` — DOGE has NO native
privacy upgrade.  Unlike DASH (which has PrivateSend masternode-
coordinated CoinJoin) or XMR (chain-level privacy), DOGE has no
PrivateSend equivalent, no confidential transactions, no segwit-
enabled mixing.  Users seeking strongest Morphit privacy should
use XMR.  This is HONESTLY framed in the privacy guide and FAQ
per Memory #29 — DOGE's posture is what it is; no spin.

### 4. Address shape regex

DOGE addresses use 3 prefixes:
- `D...` (P2PKH, version byte 0x1E) — overwhelmingly the most
  common form
- `9...` or `A...` (P2SH, version byte 0x16) — multi-sig, rare
  on DOGE

All are 34 chars total (33 after the version-byte prefix).  No
bech32 / segwit — Dogecoin Core has not activated segwit as of
2026-05.

Canonical regex: `/^[D9A][1-9A-HJ-NP-Za-km-z]{33}$/`

Permissive shape check at Morphit's boundary; the receiving
wallet does checksum + chain-binding validation.

### 5. Decimals: 8 (satoshi-scale)

`decimals: 8`.  Confirmed via Dogecoin Core protocol docs — 1
DOGE = 100,000,000 shibatoshi.  Same scale as BTC/BCH/LTC/DASH.

### 6. Explorer choice — blockchair.com/dogecoin

Ken-supplied 9-candidate survey (2026-05-19):

| Candidate | Status |
|-----------|--------|
| dogechain.info | Community-favored historical default; uptime + ad-inventory issues |
| **blockchair.com/dogecoin** | **CHOSEN** — clean URL, multi-chain, no JS tracking by default |
| bitinfocharts.com/dogecoin/explorer | Aggregator, ad-heavy |
| live.blockcypher.com/doge | BlockCypher infra, free-tier rate-limited |
| blockexplorer.one/dogecoin/mainnet | Multi-chain aggregator |
| blockchain.com/explorer/assets/doge | Exchange-affiliated (Blockchain.com); declined per Priority #2 |
| sochain.com/DOGE | Older SoChain service; uptime variable |
| chain.so/DOGE | Same vendor as SoChain |
| oklink.com | OKLink (OKX-affiliated); exchange-adjacent |

**Rationale**: blockchair.com is already Morphit's BCH default,
giving operators one origin in their CSP allowlist serving two
chains.  Predictable URL pattern, no aggressive fingerprinting,
HTTPS-only.

URL template: `https://blockchair.com/dogecoin/transaction/{txid}`

Operators wanting a different default override via
`MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL`.

### 7. Default-ON instance-wide

Per Memory #25.  Operators disable via
`MORPHIT_INDEXER_DISABLED_ASSETS="DOGE"`.

### 8. Icon — Ken-supplied official Shiba Inu artwork

Ken supplied the canonical Dogecoin Shiba Inu illustration (54 KB
detailed multi-path SVG).  This is 13× the cp32-conservative
per-icon ceiling of 4 KB.

cp33 raises the per-asset-icon ceiling from 4 KB to **64 KB**
and the total asset-icon budget from 32 KB to **128 KB** in
`network-icon-coverage-smoke.ts`.  Justification:

- The HEAVY mitigation for Priority #4 is **lazy-loading**, not
  the absolute byte ceiling.  Lazy-loading ensures the 54 KB
  DOGE icon only transfers when a viewer scrolls to a page that
  actually renders DOGE.
- The ceiling is a defensive guard against accidental bloat
  (developer pastes a base64 PNG renamed `.svg`), not a hard
  policy.
- Network icons keep the tighter 4 KB ceiling — simple chain
  logos don't need detailed illustration.
- Home page (BTC/XMR/BLURT icons combined ~5.6 KB) is
  unaffected.

### 9. Payment-rail axis wired same-turn (cp32 LL #36)

Per the cp32 LL #36 lesson — every tradable asset must also be
wired as a payment rail (you can ACCEPT DOGE for a trade of a
different asset, even though you can't pay Morphit's listing
fees in DOGE).  Cp31 missed this for DAI (closed in cp32
CODE-1); cp33 ships DOGE with BOTH axes same-turn:

- `pay_doge` entry in `apps/web/src/lib/payments/registry.ts`
- `'pay_doge'` in indexer's `RESERVED_CANONICAL_KEYS`
- `payment_method.pay_doge.description` × 10 locales (cp32 LL
  #35 invariant — multi-checkpoint i18n drift compounds; same-
  turn discipline now)

## Files changed

ADR, canonical registry, frontend mirror:
- `docs/adr/0030-dogecoin-trade-only-addition.md` (new)
- `packages/asset-registry/src/index.ts` (ASSET_TICKERS 9 → 10;
  DOGE AssetEntry)
- `apps/web/src/lib/assets/registry.ts` (validateDoge + frontend
  DOGE entry, text-yellow-500)

Chat payload:
- `apps/web/src/lib/chat/payload.ts` (DOGE regex constants,
  isValidDogeAddress/Txid, dispatcher extension, jitter
  dispatcher route, buildPaymentUri `dogecoin:` URI scheme,
  **CRITICAL: all 4 wire-format gates atomically widened with
  DAI cp31 miss + DOGE**)

Explorer URLs:
- `apps/web/src/lib/explorer/urlsCore.ts` (DOGE_TXID_RE +
  BUNDLED_DOGE_CHAT_LINK_URL + 9-explorer survey comment)
- `apps/web/src/lib/explorer/urls.ts` (ExternalAsset extension
  + EXPLORER_REGISTRY.DOGE + re-exports)

4 wire-format surfaces:
- `apps/web/src/lib/stores/instance.ts` (interface + initial
  state + 2 hydration sites)
- `apps/indexer/src/api/instance.ts` (InstanceResponse interface
  + body construction)
- `packages/indexer-client/src/index.ts` (**CRITICAL: closed
  preexisting LTC cp24 miss + DASH cp27 miss + DOGE cp33 in
  same atomic pass — CODE-4**)
- `apps/matrix-bot/scripts/api-response-shape-smoke.ts`

Indexer config + prices:
- `apps/indexer/src/config/index.ts` (frontendDogeChatLinkUrl
  Config field + Zod schema + builder mapping)
- `apps/web/src/lib/prices/providers/coingecko.ts` (DOGE: 'dogecoin')
- `apps/web/src/lib/prices/providers/fallback.ts` (DOGE: 0.10)
- `apps/web/src/lib/prices/index.ts` (initial Record + reset)

Payment rail (cp32 LL #36):
- `apps/web/src/lib/payments/registry.ts` (pay_doge entry)
- `apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts`
  ('pay_doge' in RESERVED_CANONICAL_KEYS)

Static assets:
- `apps/web/static/icons/icon-doge.svg` (Ken-supplied Shiba Inu,
  accessibility-hardened: aria-label, title, width/height stripped)
- BEP-20 icon swap (Ken-supplied improved version) at
  `apps/web/static/icons/networks/icon-network-bep20.svg`

i18n (10 locales × 12 leaves = 120 strings + cp32 LL #35
payment_method.pay_doge × 10 = 130 total):
- `apps/web/src/lib/i18n/locales/{10 locales}.json`
- FAQ what_is_doge × 10 locales (native EN/ES/FR/DE +
  EN-fallback × 6)
- 2 stale FAQs cleaned up across all 10 locales:
  trade_goods_services + where_to_buy_blurt (DAI cp31 drift +
  asset count cp30 miss + DOGE cp33)

Components (4 chat surfaces extended with DOGE branches):
- `apps/web/src/lib/components/AddressShareModal.svelte` (DOGE
  tab + invalid-msg + placeholder dispatch; **CODE-5: DAI
  placeholder dispatch added (cp31 miss)**)
- `apps/web/src/lib/components/FundsSentModal.svelte` (DOGE tab)
- `apps/web/src/lib/components/ConversationView.svelte` (2 type
  unions widened with DAI cp31 miss + DOGE)
- `apps/web/src/lib/components/ChatMessage.svelte` (4 sites: DOGE
  explorer dispatch + canMarkSent guard + address-pill branch +
  funds-sent-pill branch; 2 type unions widened with DAI cp31
  miss + DOGE)

Routes:
- `apps/web/src/routes/[lang]/post/+page.svelte` (DOGE Tooltip
  with what_is_doge FAQ link)
- `apps/web/src/routes/[lang]/dev/icons/+page.svelte` (DOGE in
  ASSETS list)

faqIndex:
- `apps/web/src/lib/utils/faqIndex.ts` (FAQ_KEYS + FAQ_RELATED
  for what_is_doge)

ops-cli wizard:
- `apps/ops-cli/src/init/steps.ts` (DEFAULT_DOGE_CHAT_LINK_URL +
  ChatLinkExplorersResult.doge + stepChatLinkExplorers DOGE
  prompt + return statement)
- `apps/ops-cli/src/init/render.ts` (DOGE env-var emission)
- `apps/ops-cli/src/commands/init.ts` (DOGE URL summary line)
- `apps/ops-cli/scripts/init-smoke.ts` (DOGE fixture)
- `ops/env/indexer.env.example` (DOGE env-var commented example
  + disabled-assets variants refresh)

Smokes:
- `packages/asset-registry/scripts/doge-trade-only-smoke.ts`
  (new, 13 scenarios mirroring dash-trade-only-smoke with
  DOGE-specific assertions: empty optInPrivacyTech, D/9/A
  address-prefix validator coverage, BTC/DASH cross-rejection)
- `scripts/run-smokes.sh` (doge-trade-only-smoke registered)
- `apps/indexer/scripts/asset-registry-smoke.ts` (lowercase
  allowlist extended)
- `apps/web/scripts/wiring-completeness-smoke.ts` (3 new CHECK
  rows: cp33-doge-p2p, cp33-doge-payment-rail-wired,
  cp33-doge-explorer-bundled-default)
- `apps/web/scripts/network-icon-coverage-smoke.ts` (per-asset
  ceiling 4 KB → 64 KB + total budget 32 KB → 128 KB; sanity
  9 → 10 assets)

Brag list + mediakit:
- `MORPHIT-BRAG-LIST.md` (NEW entry #282 DOGE; #205, #207, #219
  asset enumerations extended)
- Mediakit rebuilt

## Consequences

**Positive:**
- 7th Category-B asset shipped via fully matured template (zero
  new architectural patterns introduced).
- Cp33 deep-deep surfaced 5 HIGH-severity preexisting bugs
  (CODE-3 through CODE-7) — each of which was silently shipping
  broken behavior in production: DAI wire-format gates broken
  since cp31, indexer-client mirror missing LTC+DASH since
  cp24/cp27, DAI placeholder dispatch broken since cp31, 4 type
  unions narrowed-wrong since cp30/cp31, FAQ asset enumerations
  stale across 10 locales.
- Cp32 LL #36 invariant (tradable axis ≠ payment-rail axis)
  applied SAME-TURN for DOGE — first asset addition where both
  axes ship as one work unit, not as a follow-up.
- Cp32 LL #35 invariant (i18n description for payment-method)
  applied same-turn — `payment_method.pay_doge.description`
  shipped with the rest, not back-filled.

**Trade-offs:**
- DOGE icon at 54 KB raises per-asset budget significantly.
  Mitigated by lazy-loading (the icon only transfers when DOGE
  renders on a page the user actually visits) — Priority #4
  byte-discipline holds via the mechanism, not the absolute
  ceiling.
- DOGE legacy `9...` / `A...` P2SH prefix overlaps slightly with
  DASH (`7...` doesn't, but multi-sig users may accidentally
  send DASH to a DOGE P2SH or vice-versa).  Same chain-binding
  guarantee as the BTC/BCH legacy 1.../3... overlap: the
  receiving wallet rejects wrong-chain sends.  Refusing legacy
  P2SH on DOGE would be paternalistic.

## Future revisits

- DOGE Lightning analogs (mooncake, lit) — not currently
  shipping as supported networks; may revisit if community
  adoption matures.
- DOGE NFT-on-DOGE (Doginals, ordinals-style inscription) — out
  of scope for Morphit's trading model.
- Confidential transactions for DOGE — if a future hard fork
  ships them, revisit `privacyFeatures.optInPrivacyTech`.
