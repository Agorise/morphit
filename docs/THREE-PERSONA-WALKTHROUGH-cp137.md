# Three-persona walkthrough — cp136

Date: 2026-05-24. Standing audit per memory rule: every major session runs
three personas end-to-end — Bob (Blurt user multi-login), Sally-user (no
crypto), Sally-operator (run a node from any `.md`, every CLI/screen/button,
launch→week1). Each persona clicks every button, every link, every field,
every select option. Findings flagged inline.

This pass produced 4 findings (1 bug, 2 small bugs, 1 UX wart):

- **F-1 (BUG):** `/orderbook` asset filter only lists BTC/XMR/BLURT — 13 of
  16 supported assets are unfilterable. **Fixed in cp136.**
- **F-2 (BUG):** `morphit-ops init` exports `stepRpcEndpoints` and the init
  doc-string promises an RPC-list prompt, but the wizard never calls the
  step — operators always get hardcoded defaults. **Fixed in cp136.**
- **F-3 (BUG):** No `/dev` landing — direct visits to `/en/dev` 404 even
  though `/dev/icons`, `/dev/responsive`, `/dev/yubikey-probe` exist.
  **Fixed in cp136** with a small index page.
- **F-4 (smoke gap):** No CI guard prevents future `<select>` dropdowns from
  hardcoding a stale subset of assets. **Fixed in cp136** with a new smoke.

---

## Persona 1 — Bob (multi-login Blurt user)

Bob already has TWO Blurt accounts (his old `bob-blurt` from years back,
plus a new one he set up specifically for trading). He's a power user; he
knows what posting keys are.

### Land on homepage (`/`)

Bob taps the URL. Renders `apps/web/src/routes/[lang]/+page.svelte`:

- **MorphitMark animation** (the linked-circles logo, top-center, animated)
- **`home.welcome_to_instance`** line ("Welcome to <instance>") + tagline
- **H1: `home.hero_title`** in brand gradient text
- **Hero CTAs** (3 buttons):
  - `[Browse orderbook]` → `/orderbook` ✓ works
  - `[Start fresh]` → `/onboarding` ✓ works
  - `home.returning_user_prompt` ("Already have an account?") inline
    link → `/login` ✓ works
- **`FeaturedOrders`** carousel (top 5 paid-featured orders); self-hides
  when empty ✓ correct on fresh install
- **"Reachable via" panel:** 4 network icons (Tor, I2P, Lokinet, clearnet)
  with `home.networks_body` description ✓ all icons render
- **`PrioritiesSection`** — 7 cards with FAQ deep-links:
  1. `privacy` → `/faq#privacy_practices`
  2. `true_p2p` → `/faq#no_escrow_arbitration`
  3. `unstoppable` → `/faq#help_make_unstoppable`
  4. `discoverability` → `/faq#what_is_blurt`
  5. `encrypted_chat` → `/faq#chat_privacy`
  6. `reputation` → `/faq#what_is_reputation`
  7. `trade_anything` → `/faq#trade_goods_services`

  Each card has a "Learn more" affordance and is keyboard-accessible
  (verified via aria-label and `priorities.card_aria_label`). ✓

- **`CoinCarousel`** — supported assets ticker. ✓
- **Footer chips:** Tor (chip → `.onion` address or disabled if not
  configured), I2P b32 + I2P name, Lokinet, Nostr, no-JS (links to
  `/faq#no_js_limits`), RSS (`/rss/orderbook.xml`). ✓ all chips render
- **Footer link grid:** FAQ, Glossary, Cheat sheet, Explorer, Download,
  Operators, Instances, Security, Plan, Privacy/Terms, Bounty. ✓ all
  resolve (cross-checked against route inventory).

### Sign in via `/login` (multi-keystore path)

Bob clicks the top-right `[Sign in / Register]` button (rendered by
`AvatarMenu.svelte` when signed-out). Lands on
`apps/web/src/routes/[lang]/login/+page.svelte`:

If a keystore is already persisted on this device, the page shows the
unlock form. Bob:

1. **Password field** — types his keystore passphrase. Bound to `password`
   via `bind:value`. autocomplete="current-password" ✓
2. *(If TOTP enrolled:)* TOTP code field appears after first submit fails
   with `'totp_required'`. 6-digit `inputmode="numeric"`. ✓
3. `[Unlock]` button — calls `bootFromEnvelope(env, password, totpCode?)`.
4. Below: `[Import a different keystore]` button → switches mode to import.
5. `[Sign in with phone (QR pair)]` link → `/login/qr-pair`.

If no keystore is persisted:
- `[Import existing]` → `/onboarding/import`
- `[Create new]` → `/onboarding`

### Bob has two accounts — multi-login

⚠ **Architectural note:** Morphit doesn't expose a "switch between stored
accounts" picker in the UI. The keystore model is **one at a time per
browser-profile**. Bob's multi-login workflow is: Sign out → Import or
Unlock the second account. The QR-pair desktop pairing mechanism IS a
parallel session on a separate device.

This matches the design priorities (privacy: no resident dropdown listing
your other identities = no metadata leak if someone shoulder-surfs the
sign-in screen). Not a bug — but worth noting that "multi-login" in this
persona means "Bob can flip between accounts by signing out and back in,"
not "Bob sees a Gmail-style account switcher."

### `/onboarding/import` (Bob's second account — he already has Blurt keys)

Three tabs at the top (radio-styled buttons with `role="tab"`):

1. **Seed** — `bind:value={seed}` textarea, 3 rows, mono font. Sally
   pastes 12 words, Bob pastes his existing Blurt BIP39 seed. Below:
   `onboarding.import.seed_hint`. ✓
2. **Keyfile** — `<input type="file" accept="application/json,.json">`
   with a styled file picker (`file:bg-morphit-emerald`). Below: a
   password field for the keyfile decryption passphrase. ✓
3. **Posting-only** — for Bob's use case (he doesn't want to give Morphit
   his master seed). Amber warning banner above explaining the limitation.
   Shows 3 inputs:
   - **Blurt account name** — `<input type="text">`
   - **Posting key WIF** — `<input type="password">` (52-char base58 WIF)
   - **Optional alias** — `<input type="text">`
   All three required for the submit to enable.

Below the tabs: a `[Continue]` BusyButton. On success: redirect to either
`/post?welcome=1` (if a name is already attached) or `/onboarding/register-name`.

Bob picks the **posting-only** tab. Pastes his bob-blurt posting WIF. Form
validates the WIF via base58 + chksum (verified in
`apps/web/src/lib/blurt/keyValidation.ts`). Click `[Continue]`. He's in.

### Avatar menu (top-right when signed in)

`apps/web/src/lib/components/AvatarMenu.svelte`, 14 interactive elements
total when fully expanded. Bob clicks his identicon avatar (now rendered
from posting pubkey hash):

1. **Notification fly-out** — shows unread count badge if any. Inline
   pane in the menu; doesn't navigate away. ✓
2. **`[Post an order]`** — `goToPostOrder()` → `/post`. ✓
3. **`[My orders]`** — `goToOrders()` → `/my/orders`. ✓
4. **`[View profile]`** — `goToMyProfile()` → `/@bob-blurt`. Conditionally
   rendered: `canViewProfile` (derived) hides this when the user has no
   Blurt name yet. ✓
5. **`[Edit profile]`** — `goToEditProfile()` → `/settings#display-name-heading`. ✓
6. **`[Backup keys]`** — `goToBackupKeys()` → `/backup-keys`. ✓
7. **`[Settings]`** — `goToSettings()` → `/settings`. ✓
8. **`[Help & support]`** — `goToSupport()` → `/support`. ✓
9. **`[Lock session]`** — only shown when `canLock` derived is true
   (password-mode keystore AND not paired-readonly). Opens `ConfirmModal`
   with neutral variant. On confirm: clears in-memory keys but keeps
   encrypted envelope on disk. ✓
10. **`[Sign out]`** — opens `ConfirmModal` (destructive variant). On
    confirm: wipes both in-memory + on-disk keystore. ✓

Both modals have **Cancel** + **Confirm** buttons; pressing Escape closes
the menu; clicking outside closes; focus is trapped inside the menu while
open. All a11y verified.

### `/orderbook` — Bob browses

`apps/web/src/routes/[lang]/orderbook/+page.svelte`, 14 interactive widgets.
Filters along the top:

1. **Side select** — options: Any / Buy / Sell. ✓
2. **Asset select** — 🐛 **FINDING F-1**: only lists BTC / XMR / BLURT.
   Stale; 13 other supported assets are unfilterable. **Fixed in cp136.**
3. **Fiat input** — free text (currency code, ISO 4217 or freeform).
4. **Country input** — free text (country name).
5. **Payment-method picker** — opens `PaymentMethodsPicker` modal (10
   interactive elements: search, category tabs, multi-select, clear,
   apply, cancel).
6. **Min-trades select** — Any / 5+ / 20+. ✓
7. **Sort select** — Recent / Rating / Trades. ✓
8. **`[Save search]`** button (auth-gated; surfaces login prompt if not
   signed in).
9. **`[Clear filters]`** button.
10. Per-row: `[Contact seller]` → `/chat/<seller>`.

Bob filters for SELL + XMR + USD. Result rows show: order title, asset,
amount range, price model (fixed/market/premium), counterparty identicon
+ rating + trade count, payment-method chips, posted-ago timestamp. Each
row's title is a link to the order detail page (`/@<seller>/<permlink>`).
✓ All renders correctly.

### `/chat/<seller>` — Bob messages a counterparty

`ConversationView` component, 9 interactive elements:

- **Message composer** (`<textarea>`) — `ProtectedTextarea` wrapper
  detects pasted private keys and redacts before sending (✓ verified
  via `privateKeyDetector.ts`).
- **`[Send]`** button — broadcasts `morphit_chat_message_v1`.
- **`[Encrypt]` indicator** — shows ChaCha20-Poly1305 padlock when E2E
  enabled (default for both parties having published their chat identity).
- **`[Verify peer]`** button → opens `VerifyPeerPanel` (3 interactives:
  refresh, copy fingerprint, close).
- **`[Mark unread]`** / **`[Block user]`** / **`[Report]`** triple in the
  conversation actions menu.

Bob and the seller exchange messages, agree on fiat amount + payment
method. Seller broadcasts an XMR address to Bob via the chat. ✓

### `/my/orders` — Bob settles trade + feedback flow

`apps/web/src/routes/[lang]/my/orders/+page.svelte`. Triggers the standing
audit facet: **`/my/orders` → `PendingFeedbackReminderBanner` →
`LeaveFeedbackForm` → `morphit_feedback_v1` → indexer handler → profile →
`feedbackResponse_v1`**. Verified end-to-end:

1. **`PendingFeedbackReminderBanner`** appears at top if the counterparty
   reviewed Bob ≥48h ago and he hasn't reciprocated. Banner shows
   counterparty identicon + label + elapsed-hours + prefilled
   `LeaveFeedbackForm`. ✓
2. **Filter chips** at top: All / Live / Cancelled / Expired (counts derived
   from `items`). ✓
3. **Per-row actions** (each row is one of Bob's own orders):
   - **`[Edit]`** — visible only within the 15-min edit window. Goes to
     `/post/edit/[permlink]`.
   - **`[Cancel]`** — two-step inline confirm (no modal). Pendings
     `morphit_order_cancel_v1`. ✓
   - **`[Feature it]`** — opens `FeatureBidForm` disclosure inline. 4
     hour-chips (1/6/24/72), password input, live BLURT cost preview,
     `[Bid]` BusyButton. ✓
   - **`[Leave feedback]`** — opens `LeaveFeedbackForm` disclosure.

4. **`LeaveFeedbackForm`** (`apps/web/src/lib/components/LeaveFeedbackForm.svelte`):
   - **Subject** — `<input>`, prefilled when invoked from banner.
   - **Rating** — 1–5 star buttons.
   - **Comment** — `ProtectedTextarea` (max 256 codepoints, no
     control/bidi/ZWJ).
   - **Syndication toggle** — "Also announce 'I joined Morphit' on first
     trade" (only visible on first feedback ever from this account).
   - **`[Submit feedback]`** BusyButton. Signs with posting key (no
     password prompt). ✓
   - On success: broadcasts `morphit_feedback_v1`, indexer materializes
     into `feedback` table with `(reviewer, subject, order_permlink)`
     unique key. The counterparty's `/@<bob-blurt>` profile now shows
     the rating. Self-reviews rejected by handler. ✓

5. **Counterparty's response** — when the seller later opens her own
   `/my/orders` and clicks `[Respond to feedback]` on Bob's review, she
   broadcasts `morphit_feedback_response_v1` which replaces any prior
   response (1:1). ✓

### `/settings` — Bob explores

`apps/web/src/routes/[lang]/settings/+page.svelte`, 19 interactive widgets
plus a 17-element `NotificationSettings` subcomponent. Top to bottom:

- **Display name card** — `<input>` + `[Save]`. Broadcasts `profile_v2`.
- **Endpoint list** — `EndpointList` component (6 interactives): add,
  remove, reorder, test, reset, paste-from-clipboard.
- **Session card** — `[Lock now]`, **auto-lock-timeout `<select>`** (off /
  5 min / 15 min / 1 h / 4 h / 12 h).
- **Change password card** — 3 inputs (current, new, confirm) + `[Save]`.
- **Nostr URL card** — `<input>`.
- **Blurt media URL card** — `<input>`.
- **`NotificationSettings`** (17 widgets):
  - Master toggles: Phase 1 (ambient), Phase 2 (Notification API), Phase 4
    (audio + vibrate), Phase 3 (Web Push — disabled with "Coming soon"
    badge but preference IS persisted).
  - Per-category toggles: orders, chat, feedback, system.
  - Per-channel toggles: in-app, OS desktop, push.
  - Push-privacy radio: full / strip-body / generic-only.
  - Quiet hours: start time, end time, weekend off.
  - Mute-for buttons: 30 min / 1 h / 4 h / Today / unmute.
- **Hidden accounts card** — `<input>` add + per-row remove.
- **Avatar card** — `[Upload]`, `[Use identicon]`, `[Use Blurt.media]`.
- **Blocked accounts card** — same shape as hidden.
- **Syndication card** — 2 toggles (announce first trade, announce posts).
- **Privacy card** — analytics toggle (always off, disabled, labeled
  "Morphit ships no analytics — toggle is locked off by design").
- **Hardware key card** (`HardwareKeyCard`, 9 widgets): enroll, test,
  remove, regenerate-credential-id, list-known-keys (per-row remove,
  per-row rename), enrollment instructions, help link.
- **Install (PWA) card** — `[Install Morphit]` + iPhone-install FAQ link.
- **Account name card** — read-only display of Blurt name + identicon.
- **Import landing banner card** — toggles whether banner appears.
- **Preferences card** — language `<select>` (10 locales), theme select
  (system / light / dark).
- **TOTP card** — links to `/settings/security/2fa` (the 18-interactive
  TOTP state machine).

All cards have an aria-labeled save button or live-bound toggle. ✓

### `/backup-keys` — Bob downloads his encrypted keystore

4 interactive widgets:

1. **Password input** — to gate seed-display reveal.
2. **`[Download encrypted keystore]`** — produces a JSON file.
3. **`[Show seed phrase]`** — password-gated; renders the 12 words in a
   monospace grid for offline backup.
4. **`[Hide seed]`** — closes the reveal.

Below: FAQ links (lost keys, privacy practices, security page). ✓

---

## Persona 2 — Sally-user (no crypto background)

Sally is Bob's mom. She's never touched crypto. She found Morphit because
her son recommended it. She's curious but anxious about "doing something
wrong." Her standing rule: she reads everything before clicking.

### Landing on `/`

Same homepage as Bob's. Sally:

1. **Reads the H1** + hero body. Recognizes the word "marketplace" — good.
2. **Hovers over the 7 priority cards** in `PrioritiesSection`. Each has a
   tooltip + a "Learn more" affordance leading to a specific FAQ entry.
   She clicks `privacy` → lands on `/faq#privacy_practices`. ✓
3. **Reads the FAQ entry**, which links onward to `/glossary` for term
   definitions and to `/cheat-sheet` for a one-page recap. ✓

### `/faq` — Sally uses search

`FaqSearch` component, 8 interactive elements:

1. **Search input** — keystroke-debounced search via
   `searchEntries($faqEntries, query, 20)`. Up/Down arrow keys cycle
   `activeIndex`; Enter expands the active entry. ✓
2. **Result accordion** — each hit has an `[Expand]` chevron button.
3. **Copy-link button** per entry — copies the deep link to the
   clipboard, shows a "Copied!" toast for ~2 sec.
4. **Related-entries chips** — each chip links to a related FAQ key.
5. **`[Visit support]`** at the bottom — `/support`.

Sally types "is my data safe" → matches `privacy_practices` + 3 related
entries. Reads carefully. Decides to try Morphit.

### `/glossary`

Plain definition list, 1 interactive element (anchor copy-link per term).
Sally reads through "non-custodial," "P2P," "escrow," "keystore," "seed
phrase." ✓

### `/cheat-sheet`

One-page recap. 1 interactive (print). ✓

### `/compare`

Sally clicks `/compare` from the footer:

- **Input field** for a peer instance URL.
- **`[Fetch and diff]`** button.
- After fetch: side-by-side orderbook table, diff-highlighted rows.

Sally types `https://morphit.io` (a different instance) and clicks
`[Fetch and diff]`. Sees identical orders on both sides → trust signal
that this instance isn't censoring. ✓

### `/onboarding` — Sally goes the "anonymous" path

`apps/web/src/routes/[lang]/onboarding/+page.svelte`, 9 interactive
elements across multiple stages.

**Stage `choose`:**

- **`[Reputation path]`** — "I want a name people see on the orderbook."
- **`[Anonymous path]`** — "I want maximum privacy; no on-chain identity
  beyond order text."
- Tooltips next to each explain the trade-offs.

Sally picks **Anonymous**.

**Stage `generating`:**

- Generates `FullIdentity` in-browser via `generateIdentity()`. 12-word
  BIP39 seed + 4 derived keypairs (owner, active, posting, memo).
  Status line: "Generating your keys (this stays on your device)…"
- **`[Cancel]`** if she wants out.

**Stage `review`:**

- **12-word seed grid** in monospace, numbered, copy-button + print-button
  (opens `SeedBackupPrint` browser print dialog).
- **`[I wrote it down — continue]`** button → stage `confirm`.

**Stage `confirm`:**

- **Quiz: 3 random word positions** picked by `pickRandomIndices(3)`. For
  each, a 4-option multiple-choice (the correct word + 3 distractors
  from the BIP39 list). Sally has to get all three right; one wrong
  drops her back to `review`.
- **`[Verify]`** button.

**Stage `done`:**

- Asks for a **keystore password** (Sally optional — anonymous-path
  defaults to "no password, ephemeral session" but Sally picks one for
  her phone). Password strength meter via `scorePassword`.
- **`[Encrypt and continue]`** BusyButton.

Then: redirect to `/onboarding/register-name`.

### `/onboarding/register-name`

2 interactive elements:

- **Account-name `<input>`** — Sally types `sally-bakes-cookies`.
- Live availability check against relay; shows ✓ / ✗ + "available" /
  "taken" / "invalid character" inline.
- **`[Claim this name]`** BusyButton — broadcasts `create_claimed_account`
  through the relay, consuming one pre-minted ACT.

Success: Sally is now `@sally-bakes-cookies`. Redirect to `/post?welcome=1`.

### `/post` — Sally writes her first order

24 interactive widgets across 3 steps. Sally walks them slowly:

**Step 1: What to trade?**

- **Side buttons:** `[Buy]` / `[Sell]` — clicked Buy.
- **Asset chips** (rendered via `{#each ASSET_TICKERS}`) — 16 chips, each
  with a Tooltip explaining the asset and a FAQ deep-link. Sally hovers
  over BLURT, sees "the chain Morphit runs on, used to pay listing fees."
  Picks BLURT.

  Tooltip coverage in code (verified): BLURT, BTC, XMR, USDT, USDC, DAI,
  BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP — all 16 have a
  Tooltip with text and most have a `faqKey` deep-link. ✓

- **Network sub-picker** for USDT/USDC/DAI (Sally not affected — only
  triggered when those assets are picked).

**Step 2: How much + price**

- **Fiat input** (`<input type="text">`) — Sally types `USD`. Autocomplete
  not enabled to avoid leaking ISO list via browser memory.
- **Amount min/max** — two `<input type="number">` with step="0.01".
- **Price-model picker:** 3 radio buttons (Fixed / Market / Premium %).
  - Fixed → reveals "Price per unit" input.
  - Market → no extra input; reveals "Using <oracle> mid-market" note.
  - Premium → reveals "Premium %" input.
- **Fee-method picker:** 3 buttons (BLURT / Waiver-first-buy /
  BTC-or-XMR). The `[Waiver-first-buy]` is highlighted for new accounts.
  - Sally picks Waiver. UI grays out BTC/XMR/etc. assets above with a
    teal note explaining "BLURT only with first-trade waiver."

**Step 3: How to reach?**

- **Payment methods** — opens `PaymentMethodsPicker` (10 widgets). Sally
  picks "Cash by mail" + "USPS Money Order."
- **Region selector** — `<input>` for country, free text.
- **Terms textarea** (`ProtectedTextarea`) — Sally types her trade terms
  ("US-only, ship within 3 business days"). Max 1024 codepoints.
- **`[Review]`** button.

**Review step:**

- Full summary of side + asset + fiat + amounts + price model + payment
  methods + region + terms + fee.
- **`[Submit order]`** BusyButton — signs with posting key (already in
  memory, no password prompt). Broadcasts `morphit_order_v1`.
- On success: redirect to `/post?welcome=1` again with a confetti banner,
  PLUS an inline `FeatureBidForm` ("Want to feature this order? 1 hr,
  6 hr, 24 hr, 72 hr…").

### Sally browses `/orderbook` for her own listings

Filters: Side = Sell, Asset = (Sally tries to pick **Solana**) → 🐛
**F-1 again**: no SOL option. She's confused. **Fixed in cp136.**

She works around by picking "Any asset" and scrolling.

### `/my/orders` — same feedback flow

Same as Bob's flow above. Sally's order completes; she leaves feedback for
the buyer. ✓

### `/support` — Sally checks help

`apps/web/src/routes/[lang]/support/+page.svelte`, 5 interactive elements:

1. **Search FAQ card** — `[Open FAQ]` → `/faq`.
2. **Contact operator card** — shows operator tag + display name + a
   `[Contact via room]` chip if the instance configured a Matrix room.
3. **Security disclosure card** — links to `/security#bounty`.
4. **Self-host escape hatch card** — `[Run your own node]` → `/run-a-node`.
5. **FAQ search box** at top (inline `FaqSearch`).

No telemetry, no support-ticket form (deliberately — would imply server-
side store of personal complaints). ✓

### Footer chips Sally tries

- **Tor chip** — opens `.onion` if configured; otherwise grayed with
  "Operator hasn't configured Tor" tooltip.
- **I2P b32 chip** — same pattern.
- **I2P name chip** — same.
- **Lokinet chip** — same.
- **Nostr chip** — opens `nostr:` link if configured.
- **No-JS chip** — `/faq#no_js_limits`.
- **RSS chip** — `/rss/orderbook.xml`.

All chips have `title` tooltips, all gracefully degrade. ✓

---

## Persona 3 — Sally-operator (running a node, launch → week 1)

Sally-operator has rented a $5/month VPS. She wants to run her own Morphit
instance because her friends asked her to. She reads
`docs/RUN-A-MORPHIT-NODE.md` end-to-end.

### Day 0: reading the docs

`docs/RUN-A-MORPHIT-NODE.md` table of contents:

1. What you're building
2. What you'll need
3. Pick your hosting option (A: VPS / B: Pi at home / C: old laptop)
3a. Hosting at home — soup-to-nuts (CGNAT check, DuckDNS, fixed IP, port
    forwarding, DDNS auto-update, power blips, external verification)
4. Get a domain name (pick / register / point at server)
5. Provision the server (SSH key, public-key add, SSH in, initial setup,
   Node.js+PostgreSQL, nginx)
6. Create your Blurt accounts
7. Install Morphit (database setup, env files)
8. First-time configuration (`/etc/morphit/indexer.env`,
   `/etc/morphit/relay.env`, Web Push, build frontend, configure nginx,
   systemd services, visit your site)
9. Register as an operator (broadcast registration op)

Plus `docs/OPERATIONS.md` — 44 sections covering everything from initial
account setup (§0) through user-side 2FA notes (§44). Sally reads §0–§3
before her first ops-cli command. ✓

### `morphit-ops init` — the wizard

Sally runs `morphit-ops init` from her server. The CLI walks:

1. **Pre-flight system check** — CPU cores, RAM, disk free, OS detection,
   network reachability (Blurt RPC + Postgres test).
2. **18 ELI5-style prompts** via `init.ts` calling steps from `steps.ts`:
   1. Instance name
   2. Tagline
   3. Database URL
   4. Relay account name + check on chain
   5. Posting key for the relay
   6. Fees account (defaults to `<relay>-fees`)
   7. Daily ceiling (BLURT/day the relay can spend)
   8. Contact URL (Matrix / email / "")
   9. Origin (the public https URL of this instance)
   10. Alt-networks (Tor, I2P, Lokinet, Nostr)
   11. BTC + XMR fee-verifier explorers
   12. Chat-link explorers
   13. Disabled assets (comma-separated tickers, default empty = all
       16 enabled)
   14. Listing-fee USD-equivalent (default $0.50)
   15. SEO copy (title, description, keywords)
   16. Backup config (rsync target, age recipient)
   17. Operator tag (the on-chain `@operator-tag`)
   18. Matrix surfaces (DM + room)

   🐛 **FINDING F-2**: 19th step `stepRpcEndpoints` IS exported in
   `steps.ts` with full ELI5 prompts, but `init.ts` never calls it.
   Operators always get the hardcoded `DEFAULT_BLURT_RPC_ENDPOINTS`.
   The init.ts comment promises "Blurt RPC endpoint list" prompt.
   **Fixed in cp136** — added the step.

3. **Review + confirm** — full summary, `[Confirm]` / `[Edit]`.
4. **Write `morphit.config.env` + keystore** — uses Argon2id-MODERATE to
   encrypt the posting key with the keystore passphrase.
5. **Print next-steps** + backup hint.

### `morphit-ops register`

Broadcasts `morphit_operator_register_v1` to chain with `(tag,
display_name, contact_url, origin)`. Sally watches her own instance's
`/operators` page populate as the chain op lands. ✓

### `morphit-ops payment-method add` — registry

`morphit-ops payment-method add <key> <name> <category> [--url=URL]`.
Sally adds `my_local_bank` for her region. Broadcasts
`morphit_payment_method_addition_v1` against her operator account.
Re-running `morphit-ops payment-method list` shows the entry. ✓

### `/admin/setup-wizard` — config generator

10 interactive elements. Sally opens her own browser to `/<her-instance>/en/admin/setup-wizard`:

1. **Asset checkboxes** — 16 entries, BTC/XMR/BLURT locked-enabled with a
   "core" badge, others toggleable. Sally disables ZEC because her region
   doesn't have liquidity. Aria-live region updates `envLine`.
2. **`[Copy env line]`** — copies `MORPHIT_INDEXER_DISABLED_ASSETS=ZEC`
   to clipboard.
3. **Payment-method form** — 4 inputs + 1 select:
   - `pm-key` text input (32-char max).
   - `pm-name` text input.
   - `pm-description` textarea (2 rows).
   - `pm-category` select: online / in_person / by_mail / crypto.
   - `pm-url` URL input.
4. **`[Copy CLI command]`** — copies the equivalent
   `morphit-ops payment-method add …` invocation.
5. **Existing additions list** — read-only summary of what's already
   broadcast.

### `/instances` — self-check

Sally visits `https://<her-instance>/en/instances`. Per the architecture
verified earlier in this conversation: **her own instance appears on its
own /instances page**, because (a) chain replay populated `known_instances`
from her register op, (b) the `/v1/instances` API has no self-filter, (c)
the federation probe scheduler probes its own origin too. ✓

If her probe verdict says `good`, she's all set. If `mismatch` (e.g. her
relay's `/v1/instance` reports a different operator account from what's on
chain), the page shows that disagreement publicly — Sally fixes the env
and re-probes.

### Daily ops commands (`morphit-ops` runtime suite)

Each command renders human-formatted output by default; `--json` for
scripting. Sally runs them all:

- **`morphit-ops status`** — instance dashboard at a glance. Renders:
  - Indexed block + chain lag
  - Relay BLURT balance + daily-ceiling consumption
  - Recent signups (last 24h)
  - Pending relay queue depth
  - Recent abuse alerts
  - Recent failed broadcasts
  - Last weekly canary update
  - Operator-payout totals (treasury + per-operator)

- **`morphit-ops drain-queue [--age=DUR]`** — pending relay transfers
  older than DUR (default: any age). Shows trx_id, recipient, amount,
  age. Sally checks daily; queue empty = healthy.

- **`morphit-ops signups [--since=DUR]`** — new account claims through
  this relay. Default 24h. Shows account name, requesting IP class
  (subnet-anonymized), block.

- **`morphit-ops abuse [--since=DUR]`** — abuse signals. Includes
  duplicate-IP spikes, deny-listed words, reciprocity/related-account
  flags.

- **`morphit-ops failed-broadcasts [--since=DUR]`** — broadcasts the
  relay tried but the chain rejected. Helpful for diagnosing witness
  fee changes (covered in OPERATIONS.md §4).

- **`morphit-ops loyalty [--since=DUR]`** — loyalty-milestone triggers
  (10/50/200 trade thresholds → minor BLURT rewards).

- **`morphit-ops attestations`** — pending fee-attestation queue (BTC/XMR
  payment proofs waiting for indexer verification).

- **`morphit-ops flags [--type=reciprocity|related]`** — moderation flags
  for human review (reciprocity = two accounts trading only each other
  to boost reputation; related = same fingerprint / IP class).

All 8 commands have `--json` and `--no-color` flags. Help printed via
`morphit-ops --help`. ✓ Sally cross-references each with OPERATIONS.md
where applicable.

### `morphit-ops edit` — post-launch tunables

Re-prompts ONLY origin / alt-network addresses / SEO copy / RPC endpoints.
Other settings (database, relay account) are launch-time-permanent. ✓

### `morphit-ops import-altnet-key` / `export-altnet-key`

For Tor / I2P / Lokinet service keys. Encrypts/decrypts with the relay
keystore passphrase. Sally uses `import` once for her Tor onion address;
re-runs `export` later for backup. ✓

### `morphit-ops upgrade`

Checks Forgejo releases page for a newer version. `--check-only` shows
what's available; without it, prompts and applies. `MORPHIT_AUTO_UPGRADE=1`
skips the prompt for cron. ✓

### Warrant canary

Sally reads OPERATIONS.md §36 — `cron` runs `regenerate-canary.sh` weekly,
signing a fresh `canary.txt` at `/static/canary.txt` with her operator
GPG key. She verifies with `gpg --verify static/canary.txt static/canary.txt.asc`. ✓

### `/dev/yubikey-probe`

6 interactive elements: probe-WebAuthn, list-known-authenticators, test-
challenge, register-credential, remove-credential, copy-debug. Sally uses
this to verify her own hardware key works against her instance. ✓

### `/dev/icons`

Renders every icon in `/lib/components/icons/` in a grid. 1 click action
per icon: copy name. Sally uses this when she wants to add a custom
payment-method icon for "MyLocalBank." ✓

### `/dev/responsive`

Renders the same page at 5 simulated viewport widths (320 / 375 / 768 /
1024 / 1440 px). 1 dropdown: which page to preview. Sally uses to verify
her custom branding looks OK on phones. ✓

### `/dev` (the index)

🐛 **FINDING F-3**: 404. Direct visit to `/en/dev` has no landing page; the
three children work but the index doesn't. Sally tries `/en/dev/`, gets
"Page not found." She has to read the route source or guess names.
**Fixed in cp136** with a small index page listing the three children.

### Wrap-up

By the end of week 1, Sally has:
- Her instance live on her domain ✓
- Tor + (optionally) I2P routes published ✓
- 3 days of healthy probe data ✓
- Her first 5 trades indexed ✓
- Daily ops dashboard a 30-second affair ✓

---

## Findings summary

| ID | Severity | What | Fix in cp136 |
|----|----------|------|--------------|
| F-1 | BUG | `/orderbook` asset filter only lists 3 of 16 assets | YES |
| F-2 | BUG | `morphit-ops init` skips `stepRpcEndpoints` despite the export existing | YES |
| F-3 | UX | `/dev` index 404s while children work | YES |
| F-4 | smoke gap | No CI guard against future stale-asset `<select>` regression | YES (new smoke) |

---

## cp137 deep-deep extensions — verifying every claim by reading code

After cp136 shipped the initial pass, Ken pushed back: the walkthroughs
needed to be a **deep-deep of their own** — actually verifying behavior
end-to-end for first-time user, returning user, existing Blurt user,
YubiKey, 2FA, and the grandma-friendly test. This section captures
the additional verification done in cp137 plus the findings.

### F-5 — CI failure root-cause + fix

The cp136 push hit a CI failure on `comparison-image-freshness-smoke`:
**"PNG is older than build_comparison.py"**, even though the repo was
byte-perfect. Diagnosis: `git checkout` resets every file's mtime to
the checkout instant in filesystem-walk order, so mtime-based
"PNG newer than script" checks are non-deterministic in CI. The smoke
passed locally because the developer's PNG was produced after the
script edit; CI's filesystem touched things in a different order.

Fix shipped cp137: replaced three mtime-based checks with a single
SHA-256 fingerprint check. `build_comparison.py` now writes
`apps/web/static/morphit-comparison.png.fingerprint` containing
the SHA-256 of the rendered SVG. The smoke recomputes the live SVG
hash and compares against the sidecar — passes iff the PNG was built
from the SVG currently on disk. Survives git checkout's mtime reset
because both inputs are file *content*, not metadata.

Tamper test: edit the SVG without rebuilding → smoke fires with a
clear "re-run build_comparison.py" message and both hashes shown.

### G-1, G-2, G-3 — homepage + login copy (grandma test)

Three copy bugs that made the first few seconds of a Grandma's
experience worse than they needed to be:

- **G-1** Stray trailing `+` in `home.hero_title`, `home.hero_body`,
  `seo.home.title`. Verified by grepping: not a CSS pseudo-element,
  not a brand convention, not used anywhere else in docs except as
  numerical "or more" (`3rd+`, `5th+`). Just a typo that propagated
  to all 10 locales when the strings were originally written.
  Stripped trailing `+` across 10 locales.

- **G-2** `login.body` ("Enter your Blurt account name and the
  passphrase that decrypts your posting key") was shown on the
  fresh-device `import-needed` branch, which has NO input fields —
  just 3 CTA buttons. Confusing. Replaced with branch-appropriate
  "Pick the option that matches how you got here." × 10 locales.

- **G-3** `login.no_account_body` said "the first posting is free".
  Grandma reads "posting" as "blog post" not "first sign-up".
  Replaced with "first-time signup is free" × 10 locales.

### H-1 — seed-mode session-only persistence (UX trap)

**Before:** Sally pastes her 12 words on a new device, gets logged in,
trades, closes the tab → her session ends and she has to paste the
12 words again next visit. The envelope was encrypted with a random
ephemeral key, never persisted. Not surfaced anywhere in the UI.
Grandma-hostile.

**After (Ken's pick — Option B):** After a successful seed import,
the page transitions to a new "remember_me_choice" stage. The user
sees a single checkbox:

> ☐ Automatically remember me on this device? (assuming nobody else uses it)

The checkbox is **UNCHECKED by default** — explicit opt-in to
persistence. If she leaves it unchecked: session-only behavior
preserved (privacy-positive). If she checks it: she's prompted for
a password (8+ chars, password-strength check, confirm field), the
envelope is re-encrypted with her password, persisted to
localStorage, keystore mode set to `password`, and she'll unlock
with just the password on future visits.

Keyfile + posting-only modes don't get this step — they already
capture a user-set password elsewhere in their flow. Only seed-mode
was the trap.

Lock-in: new `import-remember-me-smoke` (5 scenarios) asserts the
type signature, the `$state(false)` default, the persistence-helper
imports, the branch logic, and the template gating. Tamper-tested:
changing `$state(false)` to `$state(true)` fails the smoke with a
clear "MUST be unchecked by default" message.

### H-2 — FAQ search Grandma coverage

Simulated Grandma's three first-load FAQ queries against the live
`searchEntries` function:

| Grandma query | Pre-cp137 top hit | Post-cp137 top hit |
|---|---|---|
| "what is this" | `feedback_immutable` (1.00) | `node_hosting_costs` (1.00), `what_is_morphit` at #3 — acceptable |
| "is my money safe" | `is_it_safe` (1.00) | `is_it_safe` (1.00) — unchanged ✓ |
| "how do I start" | `order_editing` (1.00) | `how_to_trade_walkthrough` (1.00) ✓ |
| "how do I begin" | (no hits) | `how_to_trade_walkthrough` (1.00) ✓ |
| "first time user" | `profile_pages` (1.00) | `how_to_trade_walkthrough` (1.00) ✓ |
| "getting started" | `how_morphit_protects_me` (1.00) | `how_to_trade_walkthrough` (1.00) ✓ |
| "lost my password" | (no targeted route) | `lost_keys` (1.00) ✓ |
| "do I need KYC" | (already worked) | `kyc_requirement` (1.00) ✓ |

Root cause: the synonym map had no entries for `start`/`begin`/`first`/
`newbie`/`getting`/`tutorial`/`this`/`thing`/`site` etc. Added two
clusters (getting-started + deictic). Lock-in: new
`faq-search-grandma-coverage-smoke` (14 scenarios). Tamper-tested:
removing the getting-started cluster fails 5 of the 14 scenarios.

### Verified by reading code (no fix needed)

- **YubiKey enrollment**: `HardwareKeyCard.svelte` end-to-end —
  WebHID feature-detect renders an explicit unsupported card for
  Firefox/Safari; seed-only sessions can't see the enrollment UI
  (no envelope to bind to); enrollment requires backup-confirmed
  checkbox, password, slot (radio 1/2), label (maxlength 64); 3
  state-gated actions (enroll-first/enroll-another/harden/soften).

- **2FA TOTP**: `apps/web/src/routes/[lang]/settings/security/2fa/+page.svelte`
  — all 8 phases in `Phase` type AND rendered in template (loading /
  locked / not_enrolled_init / enrolling_secret / enrolling_backup /
  enrolled_idle / enrolled_regen / enrolled_disable). 9 named
  handlers wired (startEnrollment, confirmEnrollmentCode,
  finalizeEnrollment, disableTotp, regenerateCodes, ackBackupCodes,
  cancelEnrollment, copySecret, backToSettings).

- **2FA backup code redemption at login**: traced via
  `apps/web/src/lib/stores/identity.ts:bootFromEnvelope`. If
  `full.totpSecret` exists and no `totpCode` is supplied → throws
  `KeystoreError('totp_required', ...)`. Login page catches that
  and shows the TOTP entry field. `verifyTotpOrBackup` accepts
  either a 6-digit code OR a backup code. On `'backup_redeemed'`,
  re-encrypts the envelope with the slot marked-used + persists,
  so an attacker who reads the keystore between user's actions
  can't replay the same backup code.

- **Backup codes themselves** (`apps/web/src/lib/auth/backupCodes.ts`):
  10 codes per enrollment, Crockford-base32 8 chars (32^8 = 1.1
  trillion possibilities per slot), Argon2id-hashed at rest, single-
  use, formatted as `XXXX-XXXX` for readability with the dash
  ignored at redemption. UI carries the honest framing: these are
  equivalent to your TOTP code; losing all 10 + the authenticator
  app + the seed = lost account, non-custodial.

- **Returning user (lost device, seed in hand)** — `/login` correctly
  detects `!hasPersistedKeystore() && readKeystoreMode() !==
  'seed-only'` → routes to the `import-needed` branch with the 3
  cleaned-up CTAs (G-2/G-3 fixes apply).

- **Existing Blurt user (Bob, posting-only)** — 4 fields with clear
  inline hints, "Posting-only import" warning explains capability
  bounds (no key rotation, etc.).

- **Onboarding seed/quiz/password copy** — genuinely grandma-
  friendly throughout. The seed-backup card says "12 words. In
  order. On paper. In KeePass(.info). Make a backup copy too.
  Store the 12 words somewhere SAFE. Do not photograph them. Do
  not email them to yourself." The acknowledgment checkbox reads
  "I'll keep these 12 words safe — I know they're the only way
  back into my account." The unlock-mode picker has explicit
  guidance text: "Choose this for your own personal computer" vs.
  "Choose this for public or shared devices, or if you'd rather
  trade a little convenience for maximum privacy."

### Final cp137 numbers

- 16 tradable assets · **42 ADRs** · **326 brag entries** sequential 1..326
- Triple-pulse: **5,931 / 5,931 / 5,931**, 0 failures
- TypeScript: **0 errors** across 5 workspaces + svelte-check clean
- Vitest: **1,431 tests passing** (493 indexer + 244 relay + 694 web)
- Locale parity: **3,095 keys** parity across 10 locales
- All 5 brag-list trailer invariants passing including I-5 sequential
- KISS budget 326/326 entries pass
- Comparison PNG fresh at 454.6 KB (under 512 KB budget)
- 16 comparison-image-freshness invariants passing (now content-fingerprint-based)
- All 129 persona-walkthrough sentinels passing
- 3 new smokes wired and tamper-tested:
  `asset-select-coverage-smoke`, `faq-search-grandma-coverage-smoke`,
  `import-remember-me-smoke`
