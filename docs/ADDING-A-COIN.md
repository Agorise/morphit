# Adding a coin to Morphit

This is the developer-facing playbook for adding a new
cryptocurrency to Morphit.  It covers two phases:

1. **What we need from the coin's community** before any code
   is written.
2. **The file-by-file checklist** for actually doing the work.

If you maintain or represent a cryptocurrency project and want
yours added: read part 1, send us the requested data, and we
take it from there.  Reach the Agorise team via the contact
URL in your local Morphit instance's footer.

If you're a Morphit developer about to add a coin: skim part 1
to understand what fixed inputs you have, then work through
part 2.

---

## Part 1 — What we need from the coin community

A request to add a coin should arrive with the following
information.  No surprises later, no "let me check on the
icon" mid-implementation.

### Required

1. **Ticker symbol.**  The 3-5 character all-caps form (BTC,
   XMR, BLURT, ARRR).  Must not collide with an already-listed
   coin or with a fiat currency code (we exclude USD, EUR, JPY,
   etc.).

2. **Full name.**  How the coin is known in prose ("Bitcoin",
   "Monero", "Pirate Chain").  Used in pickers, tooltips,
   announcements.

3. **One-line description.**  Maximum 120 characters.  Plain
   prose, no slogans.  This is what users see when picking a
   coin in the trade form.  Examples already in the registry:

   - "Privacy-focused cryptocurrency.  Default and recommended
     on Morphit."
   - "The original cryptocurrency.  Recommend SegWit (bc1...)
     addresses."

4. **Logo SVG.**  Two variants:
   - **Mono** — single-color silhouette.  We re-color this for
     dark-mode and themed rendering.  Should look correct at
     16×16 px.
   - **Color** — full brand-color version.  Used in marketing
     pages and orderbook list items.

   Both must be vector, valid SVG 1.1, and free of embedded
   raster images.  No `<text>` elements (font fallback issues);
   convert text-in-logo to outlined paths.  Square viewBox.
   Origin (0, 0) top-left.

5. **Address format specification.**  Enough detail to
   construct a regex-based shape check:
   - First-character constraint (e.g., starts with "1", "3",
     or "bc1" for BTC; "4" or "8" for XMR; "zc" for ZEC
     shielded; etc.).
   - Length range (BTC: 26–62 chars; XMR: 95 or 106).
   - Allowed character set (Base58, Base32-bech, hex, etc.).

   We do not perform checksum verification at the address-
   shape layer (that would require bundling per-coin libraries
   and is the recipient wallet's job).  Cheap shape check only.

6. **TxID format.**  How the coin's confirmed-transaction
   identifier looks.
   - Length (BTC: 64 hex; XMR: 64 hex; etc.).
   - Character set.
   - Whether confirmations are needed before display (and how
     many is "safe enough" for our verifier).

7. **Smallest-unit decimals.**  How many decimal places a
   transfer amount carries on chain.  BTC: 8 (satoshi).  XMR:
   12 (piconero).  BLURT: 3.  Used for amount-display rounding
   and form input precision.

### Conditional

8. **Memo / payment-id support.**  Whether the coin's base
   transaction can carry an arbitrary memo or payment-id field
   that's visible to both sender and recipient.
   - Yes (BLURT, XLM): we expose a memo input in the address-
     share modal.
   - No (BTC, modern XMR): we omit it.
   - "Yes but discouraged" (legacy XMR payment-IDs): we omit
     it; subaddresses are the path forward.

9. **Public block-explorer JSON API endpoint.**  If the coin
   has a public, maintained, no-API-key explorer that returns
   transaction details (sender, recipient, amount, txid,
   confirmations) as JSON, we can wire automatic verification
   for fee-payments in this asset.  Without this, fee-payments
   in this coin require manual operator confirmation.

   What we need:
   - URL template: `https://explorer.example/api/tx/{TXID}`
   - Documented response schema (what field carries the
     amount, recipient address, etc.).
   - Rate limits.
   - Funding model — is the explorer maintained by the coin's
     foundation or by a third party?  Affects how comfortable
     we are depending on it.

10. **Color theme accent.**  Hex code or Tailwind palette name
    matching the coin's brand identity.  We use this for
    border accents, dot indicators, and the chip background.
    Example values: BTC `text-amber-500`, XMR `text-orange-500`,
    BLURT `text-morphit-emerald`.

### Out of scope (don't send these)

- Marketing copy.  We write our own.
- Banner ads or sponsorship offers.  Not what we do.
- Fiat conversion rates.  We don't handle those; users
  agree on prices peer-to-peer.
- Wallet recommendations.  We may suggest wallets in support
  docs, but that's case-by-case.

---

## Part 2 — File-by-file checklist

This section assumes you have all the data above on hand.
Time estimate for an experienced Morphit developer: half a day
of code, plus a translation pass for the user-facing strings
(another day if any new strings need translation across all 10
locales).

### Step 1 — Bundle the logo

```
apps/web/static/coins/<lower-ticker>.svg
```

Mono variant.  Viewbox 0 0 24 24 or similar square.

Test: open the SVG in a browser at multiple sizes (16, 24, 48,
96 px) and confirm it stays crisp and recognizable.

### Step 2 — Extend the chain-payload schema

If the new coin will be used as a payment method in chat
(address-share, funds-sent) or as a listing-fee currency,
extend the on-chain payload schema:

**File:** `apps/web/src/lib/chat/payload.ts`

Add to the `PaymentMethod` type union:

```ts
export type PaymentMethod = 'btc' | 'xmr' | 'blurt' | '<new>';
```

**IMPORTANT — PROTOCOL VERSION:**

Existing indexers will REJECT any chain op carrying an unknown
`method` field as "schema violation".  This means adding a new
method requires either:

- (a) Bumping the op version (currently `v: 1` for chat
  payloads, `v: 1` for orders) so old indexers see it as a
  newer-version op they ignore (forward-compat fallthrough);
  OR
- (b) Coordinating a federation-wide indexer rollout before
  any frontend can broadcast the new method.

Option (a) is preferred when possible — it preserves backward
compatibility.  Option (b) is acceptable for tightly-
coordinated rollouts.

**File:** `apps/web/src/lib/orders/payload.ts`

Add to the `fee_method` union:

```ts
readonly fee_method?: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr' | '<new>';
```

Same protocol-version considerations apply.

### Step 3 — Frontend asset registry

**File:** `apps/web/src/lib/assets/registry.ts`

Add a new entry to `ASSETS`:

```ts
{
    ticker: '<new>',
    displayTicker: '<NEW>',
    displayName: '<Full Name>',
    oneLineDescription: '...',
    logoSvgPath: '/coins/<new>.svg',
    accentClass: 'text-<color>-<shade>',
    decimals: <integer>,
    supportsMemo: <bool>,
    addressValidator: validators.<new>,
    canBeUsedForListingFee: <bool>,
    canBeTraded: <bool>
}
```

Add the validator regex above the `validators` object.  Keep
it permissive (cheap shape check); see existing entries for
style.

Run the smoke:

```
tsx apps/indexer/scripts/asset-registry-smoke.ts
```

Then add new scenario(s) for the new coin's address validator
(positive and negative cases).

### Step 4 — Indexer chain-payload validation

**File:** `apps/indexer/src/indexer/handlers/order.ts`

Find the `asset:` and `fee_method:` zod schemas.  Add the new
ticker.  Same for any per-method conditional checks (e.g.
"externalTxId is required when method is btc/xmr/<new>").

**File:** `apps/indexer/src/indexer/handlers/chatMessage.ts` (if
chat-payload methods extended)

Same — add the new method to validation.

### Step 5 — Database schema (if explorer-verifier wired)

If the new coin gets explorer verification (per Part 1, item 9):

**File:** `apps/indexer/src/db/schema.sql`

Append a new migration section at the bottom of the file in
the same style as the existing v29/v30/v31 blocks:

```sql
-- ─── Migration vN — <new coin> explorer-verified payments ───────
```

Pre-Phase-3 the convention was a separate `schema-v<N>.sql`
file in `apps/indexer/src/db/`; that approach was collapsed
in May 2026 (see `MIGRATIONS` in
`apps/indexer/src/db/migrations.ts` — historical per-version
files are now archived under
`apps/indexer/src/db/historical/`).  All new schema changes
go inline in `schema.sql` and register as additive migration
entries in `MIGRATIONS`.  See `docs/adr/0001-...` for the
migration contract.

Pattern for the verifier code: see how
`bitcoinExplorerVerifier.ts` and `moneroProofVerifier.ts`
write their state.  (Monero uses per-payment tx_proof
verification rather than view-key-based explorer scraping
since Part 108++; the BTC verifier remains the canonical
explorer-style template.)

**File:** `apps/indexer/src/indexer/fee/<new>ExplorerVerifier.ts`

New verifier module.  Use the existing BTC and XMR verifiers as
templates.  Implements the `Verifier` interface defined in
`fee/verifier.ts`.

### Step 6 — Order form + chat modals

**File:** `apps/web/src/lib/components/AddressShareModal.svelte`

Find the per-method branches (current code switches on
`method === 'btc'` / `'xmr'` / `'blurt'`).  Replace with calls
through `getAsset(method)` from the registry — picks up the
new entry automatically once the registry is updated.

**File:** `apps/web/src/lib/components/FundsSentModal.svelte`

Same pattern — switch hard-coded branches to registry lookups
where reasonable.

**File:** `apps/web/src/routes/[lang]/post/+page.svelte`

The order-creation form.  Find the asset-picker UI.  Replace
hardcoded `<button>BTC</button> <button>XMR</button>` triples
with `{#each tradeableAssets() as a}` loops over the registry.

### Step 7 — i18n (NEW STRINGS)

If any new user-visible strings are needed (e.g., a coin-
specific hint or warning), add them across all 10 locales:

```
apps/web/src/lib/i18n/locales/{en,es,fr,de,it,pl,ru,fa,zh-CN,zh-HK}.json
```

Run the parity check:

```python
python3 -c "
import json, glob
def flat(d, p=''): yield from (yield_recurse(d, p))
# (see existing locale-parity check in scripts/run-smokes.sh)
"
```

Make sure no locale lags behind English.

### Step 8 — Tests

For every change above, add or update smoke scenarios:

- `apps/indexer/scripts/asset-registry-smoke.ts` — registry
  shape and validators.
- `apps/indexer/scripts/order-handler-smoke.ts` (if exists) —
  the new asset accepted by the indexer.
- `apps/indexer/scripts/listener-dispatch-smoke.ts` — if the
  new coin has chat-payload paths.
- Visual: open the `/post` form, the orderbook, and the chat
  address-share modal in dev and confirm the new coin appears
  in pickers and renders its accent color correctly.

### Step 9 — Documentation update

- Add a brief mention of the new coin in `docs/ARCHITECTURE.md`
  (the "What runs where" section).
- Update `docs/OPERATIONS.md` if operators need to do anything
  per-coin (e.g., set up an explorer API key).
- Bump the changelog entry.

### Step 10 — Coordination

- Open a PR with all of the above.
- Ping the requesting coin's contact for review of the
  description, logo rendering, and address-validation behavior.
- Get review from at least one other Morphit core developer.
- Stage on a non-canonical instance for at least 72h before
  enabling on the canonical morphit.io.

---

## What we will NOT do

- Add a coin without all the Part 1 inputs.
- Add a coin whose address format is unstable or under active
  consensus debate (we'd have to keep updating the validator).
- Add a coin that requires us to bundle and ship a per-coin
  library larger than 50 KB (we keep the bundle small).
- Add a coin whose primary use is a centralized exchange's
  internal token.

## Future infrastructure: Matrix bridge bot

Coin communities reach us via Matrix today.  We're planning a
Matrix↔Morphit-chat bridge bot so coin-community discussions
about Morphit features can flow naturally between protocols.
Out of scope for the current iteration; tracked separately.

---

## 2026-05-13 architectural update (Part 121) — trade-only assets + multi-network coins

Memory #23 established a hard architectural invariant that
clarifies what kinds of assets can be added in each role:

**Listing fees can ONLY be paid in BLURT, XMR, or BTC.**  This is
not a configuration knob; it's a wire-format-frozen decision.
The indexer's `fee_method` enum at
`apps/indexer/src/indexer/handlers/order.ts` is exactly the
4-member set `'blurt' | 'waived_first_buy' | 'btc' | 'xmr'`.  Two
sentinel-grep smokes enforce this (see "Smoke coverage" below).

This split breaks coin additions into two categories:

### Category A — full-citizen coin (rare, requires deep operator
trust)

Used **both** as a tradable asset AND as a fee-payment method.
Adding one is a HARD breaking change because the wire-format
fee_method enum expands.  Every operator must agree to verify
this coin's payments before federation can continue without
divergence.  In practice we expect this category to be closed
at BLURT/XMR/BTC and not reopen.  If a future case arises,
treat it as a charter-level decision, not a routine PR.

### Category B — trade-only coin (the common case for new
additions)

Used **only** for peer-to-peer trading between users.  Cannot
be used for listing fees, cold-message fees, or featured-slot
bids.  Adding one is a much smaller change:

1. Single entry in `packages/asset-registry/src/index.ts` with
   `canPayListingFee: false` AND `canBeTraded: true`.  The
   asset-registry-smoke validates the invariant that
   `canPayListingFee: true → ticker ∈ {BLURT, BTC, XMR}`, so a
   miswired entry fails CI loudly.
2. Mirror in `apps/web/src/lib/assets/registry.ts` with
   `canBeUsedForListingFee: false`.
3. No fee-verifier needed (the asset can't pay fees).
4. Standard logo + i18n + address validator + ADDING-A-COIN
   Part 1 inputs.

The two new sentinel-grep smokes guarantee a Category B coin
cannot accidentally leak into the fee path:

- `packages/asset-registry/scripts/fee-method-enum-frozen-smoke.ts`
  — asserts the indexer's `fee_method` field type union stays
  exactly the 4-member frozen set.  Belt + suspenders against
  someone adding `'usdt'` to the enum out of habit.
- `packages/asset-registry/scripts/first-buy-waiver-payment-agnostic-smoke.ts`
  — asserts the first-buy waiver gate fires on (side=buy,
  asset=BLURT) regardless of `payment_methods`, so a new
  user's first BLURT buy still gets the waiver even if they
  pay their counterparty in USDT.

### Multi-network coins (USDT on ERC-20 / TRC-20 / SPL / etc.)

A new asset-registry field `supportedNetworks: readonly string[]`
declares which networks an asset exists on.  Single-network
coins (BTC, XMR, BLURT) declare `['mainnet']`.  Multi-network
coins (USDT — shipped in Part 121 cp3) list each network
explicitly.  The **canonical reference** is the actual USDT
entry at `packages/asset-registry/src/index.ts`:

```ts
{
  ticker: 'USDT',
  decimals: 6,
  isCoordinationChain: false,
  canBeTraded: true,
  canPayListingFee: false,                  // Category B
  supportedNetworks: ['erc20', 'trc20', 'spl', 'bep20'],
  defaultNetwork: null,                     // force explicit user choice
  privacyWarningKey: 'usdt_centralized',
  addressShape:
    /^(0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33}|[1-9A-HJ-NP-Za-km-z]{32,44})$/,
  privacyFeatures: {                         // Part 122 cp26 — required
    freshAddressAdvice: 'hd-derived',
    optInPrivacyTech: null,                  // USDT has no chain-level opt-in
    privacyGuideKey: 'usdt'
  }
}
```

Setting `defaultNetwork: null` forces the post-order form to
require an explicit network pick on every trade — the safest
stance for cross-chain-mis-send-prone assets.  Per-network
metadata (regexes, fee hints, bundled explorer URLs) lives
separately in `apps/web/src/lib/assets/networks.ts`; adding a
new USDT network is a single entry there.

The frontend address-share modal validates the address against
the chosen network's regex (not just the registry's combined
regex), and the `<ChatMessage>` component renders a bold-network
prefix + amber-warning aside above the address: "Tron (TRC-20)
USDT address — send USDT on Tron only.  Sending USDT on any
other network to this address loses your funds permanently."

Full architectural rationale: `docs/adr/0023-usdt-multi-network.md`.

### Privacy warning chip

A new field `privacyWarningKey: string | null` opts an asset
into rendering a localized privacy/decentralization warning in
the post-order form and address-share modal.  `null` means no
warning (BTC, XMR, BLURT all have null — they're either
private or decentralized enough that no warning is needed).
Non-null is an i18n key looked up under
`assets.privacy_warnings.<key>` in the locale JSON.

USDT's warning (shipped in Part 121 cp3,
`assets.privacy_warnings.usdt_centralized`) explains:
- Tether can freeze any USDT address (centralization risk).
- USDT transactions are public on the network the user chose
  (no on-chain privacy).
- Morphit can't make USDT private — only XMR has meaningful
  on-chain privacy.

This warning is required by Memory #19 (privacy is priority
#1): users must be told when an asset they're considering
fails the privacy bar.

### Privacy framework (`privacyFeatures` struct)

Every `AssetEntry` carries a `privacyFeatures` struct (shipped in
Part 122 cp26 — see `docs/adr/0026-transparent-chain-privacy-framework.md`).
The struct drives four user-facing surfaces simultaneously:
amount-jitter, address-reuse warnings, opt-in privacy-tech
listings, and the per-asset privacy guide page at
`/[lang]/privacy/{key}`.

Three fields, all required:

- **`freshAddressAdvice`** — one of `'subaddress'` (XMR-style),
  `'hd-derived'` (BTC and forks, transparent UTXO chains), or
  `'account-reuse'` (account-model chains like BLURT where the
  address IS the account name).
- **`optInPrivacyTech`** — `null` if the chain has no in-protocol
  opt-in privacy tech, OR an array of protocol-standard
  identifiers from the fixed enum:
  `'mweb' | 'cashfusion' | 'coinjoin' | 'payjoin' | 'privatesend'`.
  These are PROTOCOL NAMES not wallet names — Morphit never
  endorses specific wallets.
- **`privacyGuideKey`** — lowercase i18n key prefix.  Pages live
  at `/[lang]/privacy/{key}` and pull from `privacy.guides.{key}.*`
  i18n strings.

If a new coin has a privacy tech not in the enum, **extend the
enum** in `packages/asset-registry/src/index.ts` AND in
`docs/adr/0026-transparent-chain-privacy-framework.md`'s table.
Then add localized copy under `privacy.opt_in_tech.{tech}.{name,explain}`
× 10 locales.  Same path DASH took to add `'privatesend'` (cp27,
ADR-0027 §7).

Required i18n keys per new asset (× 10 locales):

- `privacy.guides.{key}.one_line` — under-80-char summary shown
  on the `/privacy` index page next to the asset icon.
- `privacy.guides.{key}.intro` — 2-3 sentence intro paragraph
  shown on the per-asset guide page.
- `privacy.guides.{key}.meta_description` — `<meta name=description>`
  for SEO + social cards.
- `privacy.guides.{key}.caveats` — honest disclosure of where
  the asset's privacy story falls short and what stronger
  alternatives exist on Morphit (typically XMR).

Skip the caveats key if the asset has no caveats worth flagging
(rare — every asset has some compromise).
