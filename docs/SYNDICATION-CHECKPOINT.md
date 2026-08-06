# Syndication (ADR Q3) — POST-PIVOT CHECKPOINT

**Status:** Phase 1 + Phase 3 complete as of 2026-04-22 resume session.
Phase 2 pending the feedback-broadcast UI.

## The model (authoritative, implemented)

### Post A — "I joined Morphit" (automatic, once per account, community)

- **When**: client-side, after the user broadcasts feedback on their
  first trade (which is the forced BLURT BUY per Phase 3).
- **Where**: @morphit community (account: `blurt-176570`). Op's
  `parent_permlink` = `"blurt-176570"`.
- **No opt-in.** Automatic onboarding step.
- **Signed by**: user's own posting key.
- **Permlink**: `morphit-first-trade-<feedback-trx-id-truncated>`,
  deterministic so retries are idempotent.
- **Title**: `I just completed my first trade with @{seller} on Morphit!`
- **Body**: includes `IMAGE_FIRST_TRADE` markdown image at top,
  Morphit tagline, link to user's profile at `https://morphit.io/@{username}`.
- **json_metadata**: `app: "morphit/0.1.0"`, `format: "markdown"`,
  `tags: ["morphit", "first-trade", "p2p-trading"]`,
  `image: ["<IMAGE_FIRST_TRADE>"]`.
- **Helper**: `publishFirstTradePost(live, {seller, feedbackTrxId})`
  in `apps/web/src/lib/syndication/publish.ts`. Returns
  `PublishResult` (ok/error). Typically fire-and-forget.

### Post B — per-order announcement (opt-in, personal blog)

- **When**: IMMEDIATELY on order submit, iff the user ticked the
  checkbox on /post. Fires in the same client turn as the order
  broadcast, not on fill.
- **Where**: user's own blog. Op's `parent_permlink` = `"morphit"`
  (Blurt convention: first tag = category). Shows under the
  `#morphit` discovery feed AND on the user's own profile.
- **Opt-in**: checkbox on /post labeled "Syndicate this order to my
  Blog too (Free)".
- **Signed by**: user's own posting key.
- **Permlink**: `morphit-announce-<order_permlink>`, retry-safe.
- **Title**: `I'm {buying|selling} {ASSET1} with {ASSET2}. Want to trade?`
- **Body**: includes `IMAGE_ORDER_POST` markdown image at top,
  repeat of title as opening line, Morphit tagline, link to
  `https://morphit.io/@{username}/{permlink}`.
- **json_metadata**: `app: "morphit/0.1.0"`, `format: "markdown"`,
  `tags: ["morphit", "p2p-trading", "<asset_lowercase>"]`,
  `image: ["<IMAGE_ORDER_POST>"]`.
- **Helper**: `publishOrderPost(live, {orderPermlink, side, asset, counterAsset})`
  in `apps/web/src/lib/syndication/publish.ts`. Returns explicit
  `PublishResult` so the /post success card can show status.

## Completed in Phase 1

- ✅ Old deferred-syndication machinery deleted:
  - `apps/web/src/lib/syndication/queue.ts`
  - `apps/web/src/lib/syndication/scanner.ts`
  - `apps/web/src/lib/components/PendingSyndicationBanner.svelte`
  - `apps/web/src/lib/blurt/ops/syndicateAck.ts`
  - `apps/indexer/src/indexer/handlers/syndicateAck.ts`
  - `apps/indexer/src/api/pendingSyndication.ts`
- ✅ Dispatcher entry for `morphit_syndicate_ack_v1` removed from OP_IDS
  + HANDLERS map
- ✅ Frontend `OP_IDS.syndicateAck` mirror removed from `$net/config`
- ✅ Frontend `getPendingSyndication` removed from indexer client;
  `PendingSyndicationResponse` import dropped
- ✅ Indexer main.ts: pendingSyndication import + route mount removed
- ✅ Indexer orders API: `syndicate_opt_in` + `syndicated_trx_id`
  dropped from `OrderRow`, `rowToWire`, and SELECT SQL
- ✅ Order handler: `syndicate_opt_in` dropped from ValidatedOrder
  type, validate() parse, and all 3 INSERT paths (waived / BTC-XMR / BLURT)
- ✅ Shared types (`packages/indexer-client/src/index.ts`):
  `OrderRecord.syndicate_opt_in`, `OrderRecord.syndicated_trx_id`,
  and the entire `PendingSyndication*` section removed
- ✅ Order payload: `syndicate` field removed from `OrderPayload`,
  `OrderFormInput`, and `buildOrderPayload`
- ✅ Layout: `PendingSyndicationBanner` mount + scanner onMount removed
- ✅ `/post` form:
  - New `publish.ts` module with `publishFirstTradePost` and
    `publishOrderPost` functions
  - State variable renamed: `syndicate` → `syndicateToBlog`
  - New checkbox copy: `syndicate.opt_in_label` / `opt_in_help`
  - Review-step reminder block uses `syndicate.review_on_title/body`
  - Post B wired at both success sites (waived/btc/xmr AND BLURT paths):
    fire-and-forget `fireSyndicationPost(permlink)` when opted in
  - Success card shows 3-state block for syndication:
    pending / ok / failed
- ✅ i18n: 11 new `syndicate.*` keys localized across all 10 locales.
  Parity clean at 1078 leaves.
- ✅ Common verbs added: `common.buying` / `common.selling` across
  10 locales (used in Post B title and body).

## Post A wiring — **SHIPPED**

Previously blocked on the feedback-broadcast UI not existing. That UI
now exists; Post A is wired.

**New frontend pieces:**
- `apps/web/src/lib/blurt/ops/feedback.ts` — `broadcastFeedback` op
  builder signed with posting key, parallel to profile.ts pattern.
  Client-side validation mirrors the indexer handler's rules (subject
  regex, self-review check, rating range, comment length + forbidden
  chars, permlink format). Throws `FeedbackValidationError` with
  indexer-aligned reason codes.
- `apps/web/src/lib/components/LeaveFeedbackForm.svelte` — inline
  disclosure form. Fields: counterparty account (text), rating (1-5
  star buttons), comment (optional textarea with live codepoint
  counter). Broadcasts feedback via posting key (no password
  prompt, no active key). On success, fires `publishFirstTradePost`
  iff the `morphit.syndication.firstTradeFired.<account>`
  localStorage flag is unset; sets the flag to avoid redundant
  retries.
- `apps/web/src/routes/my/orders/+page.svelte` — new disclosure
  slot in the live-order action column, between feature-bid and
  cancel. Button "Mark complete / review" opens the inline form.
  On submit-success the row shows "Feedback submitted. Thanks!"

**Permlink change**: `firstTradePermlink()` in publish.ts is now
account-keyed (`morphit-first-trade-<account>`) rather than
trx-keyed. This makes "once per account" a structural property
— duplicate broadcasts become chain-side edits rather than new
posts. Idempotent even without the localStorage flag; the flag
just avoids the redundant broadcast.

**i18n**: 16 new keys (feedback.form.*, feedback.error.*,
feedback.success_line, my_orders.order.action_feedback) localized
across all 10 locales. Parity clean at **1102 leaves**.

**Not covered yet** (future work, not blocking):
- Profile pages rendering received feedback
- Feedback-response op-builder + UI (subject replies to a review)
- Feedback-given list for viewing a user's own history
- "Is this your first feedback?" indexer endpoint (for multi-device
  correctness; currently we rely on the account-keyed permlink and
  a per-device localStorage flag)

## Dead schema columns (v11)

The v11 columns `orders.syndicate_opt_in` (BOOLEAN NOT NULL DEFAULT FALSE)
and `orders.syndicated_trx_id` (VARCHAR(64)) remain in the schema but
are no longer read or written by any code path. Existing rows keep
whatever values they had; new rows get the DEFAULT FALSE for opt-in
and NULL for trx_id.

**Action**: optional v12 migration to drop the columns. Low priority;
dead columns cost nothing in Postgres. Leave as-is until a general
schema cleanup turn.

## Phase 3 — force first-trade = BLURT BUY ($1 min) — **COMPLETE**

Shipped in the same resume session as Phase 1:

**Indexer** (`apps/indexer/src/indexer/handlers/order.ts`, waiver branch):
- ✅ Reject with `waiver_requires_blurt` when `asset !== 'BLURT'`
- ✅ Reject with `waiver_requires_min_usd` when `amount_min === null`
- ✅ Reject with `waiver_requires_min_usd` when
  `amount_min < 1 / priceSource.current()` (i.e. less than $1 USD
  worth of BLURT)
- Checks run fail-fast before the expensive prior-order lookup
- Price source is the same one the BLURT fee-verification path uses,
  so there's no divergence between waiver gate and fee sizing

**Frontend** (`/post` page):
- ✅ Asset selector: BTC and XMR buttons are disabled (greyed,
  `pointer-events-none` title hint) when `feeMethodChoice ==
  'waived_first_buy'`
- ✅ Two-way sync in the waiver `$effect`:
  - On waiver choice, auto-set asset to BLURT
  - On user switching to non-BLURT, drop waiver back to paid BLURT
- ✅ `waiverMinBlurtForOneUsd` derived from `feeQuote.usdPerBlurt`
  (the price fetch the fee-quote path already does)
- ✅ `amountError` extended: waiver path requires `amountMin !=
  null` AND `amountMin >= floor`, error key
  `post_order.errors.waiver_min_usd_required`
- ✅ Floor hint shown below amount inputs in waiver mode:
  "Minimum for the waiver: {N} BLURT (~$1 USD at current price)."

**i18n**: 4 new keys added across all 10 locales
(`post_order.form.waiver_asset_locked_title`, `waiver_asset_hint`,
`waiver_min_hint`, `post_order.errors.waiver_min_usd_required`).
Parity clean at 1082 leaves.

## Locked constants

- @morphit community account: `blurt-176570`
- Community browse URL: `https://blurt.blog/created/blurt-176570`
- Morphit project account: `morphit`
- Relay account: `morphit-relay`
- Fees account: `morphit-fees`
- Image A (first-trade):
  `https://img.blurt.blog/blurtimage/morphit/e3d56ddc849685c391dcdb03526463b8264f3e09.png`
  - Local repo copy: `apps/web/static/brand/thumbnails/morphit-first-trade.png`
- Image B (order-post):
  `https://img.blurt.blog/blurtimage/morphit/ed05997f374e75ed59746588f09c0771f136df26.png`
  - Local repo copy: `apps/web/static/brand/thumbnails/morphit-trade.png`
- Morphit web: `https://morphit.io/`
- Blurt image host (not used for syndication but noted): `https://images.blurt.blog`

**Note on image references.** The syndicated posts embed the
on-chain `img.blurt.blog/blurtimage/morphit/...` URLs — those are
the canonical source for anything the chain sees. The local repo
copies in `apps/web/static/brand/thumbnails/` are operator backup
only, so the thumbnails survive if the Blurt image CDN URLs ever
change or go offline. They are not served from the app at
production traffic.

## Blurt specifics (unchanged from research)

- Community posts: `parent_permlink = <community-account-name>`.
  Morphit community is `blurt-176570`.
- Personal blog posts: `parent_permlink = <primary-tag>`. We use
  `"morphit"` so posts are discoverable under #morphit.
- Native `comment` op signed with the posting key. Both posts use
  the existing `broadcastComment` helper in `$blurt/ops/comment`.
- Duplicate permlinks per author are treated as edits by the
  chain, not as new posts — gives us free retry safety.

## Scope recap (unchanged)

Morphit supports trading any of **{BTC, XMR, BLURT}** with **any fiat**
(USD, EUR, GBP, MXN, JPY, etc.) via any agreed-upon payment method
(cash in person, PayPal, Western Union, bank transfer, etc.). Also
direct crypto-for-crypto pairs among {BTC, XMR, BLURT}.

No stablecoin pairs (no USDT, no USDC).
