# Grandma-Friendly Features — Investigation

**Status:** Investigation, not yet a roadmap. Item 13 of Batch M.
**Author:** Agorise
**Last updated:** 2026-05-19 (Part 122 cp49 — Ripple (XRP) addition as 16th tradable asset / 13th Category-B with Federated Byzantine Agreement consensus + 6-decimal drops jitter + destination-tag + reserve-requirement UX guards; universal no-favoritism principle from cp39 reapplied 6th consecutive checkpoint; cp47 — Ethereum (ETH) addition as 15th tradable asset / 12th Category-B with post-Merge Proof-of-Stake + 6-decimal display-clamp jitter (matching DAI cp31 design); universal no-favoritism principle from cp39 reapplied 5th consecutive checkpoint; cp45 — Solana (SOL) addition as 14th tradable asset / 11th Category-B with delegated Proof-of-Stake + Proof-of-History sequencing + 9-decimal lamport jitter; universal no-favoritism principle from cp39 reapplied; cp43 — Decred (DCR) addition as 13th tradable asset / 10th Category-B with hybrid PoW/PoS consensus + Politeia on-chain governance + opt-in CoinShuffle++ wallet-side mixing; universal no-favoritism principle from cp39 reapplied; cp41 — Pirate Chain (ARRR) addition as 12th tradable asset / 9th Category-B with chain-level shielded transactions via the Sapling zk-SNARK pool; universal no-favoritism principle from cp39 reapplied; cp39 Zcash (ZEC) addition as 11th tradable asset / 8th Category-B with per-address privacy choice (transparent t1/t3 or shielded zs1/u1 via zk-SNARKs); cp33 Dogecoin (DOGE) addition as 10th tradable asset / 7th Category-B; BEP-20 network icon swap (Ken-supplied improved version); cp32 — 7 network icons swapped (Ken-supplied: ERC-20, SPL, TRC-20, Polygon, BEP-20, Base, Arbitrum), Priority #4 "TINY FOOTPRINT" introduced, lazy-loading retrofit applied across 41 below-the-fold image sites; prior cp31 — DAI tooltip + cheat-sheet row added; asset enumerations through this doc extended to all 16 tradable assets; preceding cp28 route-path drift fixes and cp27-DD2 status updates remain).

This document is a survey of friction points a complete crypto-naive user (the canonical "grandma") would hit on Morphit today, organized into severity tiers. Each gap names the specific friction, where it surfaces, and a sketch of what a fix could look like. Nothing here is committed work — it's a triage list to reference when planning Batch N.

The goal is to identify what's missing for someone who:
- Has never bought crypto before.
- Doesn't know what a private key, seed phrase, blockchain, or wallet is.
- Doesn't know what BTC, XMR, BLURT, or "Mana" mean.
- Came to Morphit because a friend or news article said it's a way to buy Bitcoin without giving up their identity.
- Wants to make one trade, not become a power user.
- Will probably never read the FAQ unless directly pointed at it.

---

## Tier 1 — Show-stoppers for first-time users

### 1.1 — No "what is BTC vs XMR vs BLURT" explainer at decision time

**Status:** ✅ SHIPPED (Item 16 phase 2 / Part 90 verified; USDT tooltip added Part 121 cp3; BCH tooltip added Part 122 cp21; LTC tooltip added Part 122 cp24; USDC tooltip added Part 122 cp30; DAI tooltip added Part 122 cp31; DASH tooltip added Part 122 cp27; DOGE tooltip added Part 122 cp33). Each asset chip on `/post` carries a `<Tooltip>` next to the BTC / XMR / BLURT / USDT / USDC / DAI / BCH / LTC / DASH / DOGE button — explainer copy under `post_order.form.asset_explainer.{btc,xmr,blurt,usdt,usdc,dai,bch,ltc,dash,doge}` translated across 10 locales. The BLURT, USDT, USDC, DAI, and DOGE tooltips have `faqKey="what_is_<asset>"` deep-links so a curious user lands on the longer FAQ entry; BTC, XMR, BCH, LTC, and DASH chips are tooltip-only since the FAQ doesn't have dedicated entries for those.

**Where it bites.** The home page, the orderbook, and the post-an-order page all assume the user knows what BTC, XMR, and BLURT are and which one they want. The FAQ has a lengthy "Why did Morphit choose the BLURT blockchain?" entry, but a grandma at the post-order page doesn't know to look there.

**Why it matters.** A grandma seeing "BTC / XMR / BLURT" radio buttons has to make a choice before continuing. With no inline guidance, she'll either guess (often wrongly — picking BLURT because she paid the listing fee in BLURT once) or back out.

**Fix sketch.** Add a small `<Tooltip>` next to each asset label on the post-order form that explains the asset in one sentence ("Bitcoin — original cryptocurrency, used worldwide", "Monero — privacy-first cryptocurrency, hides amounts and addresses", "Blurt — the social blockchain Morphit runs on, useful for fast small payments"). The tooltip already exists in the codebase (`Tooltip.svelte`, used elsewhere), so this is a copy + wiring change, not a new component.

### 1.2 — Onboarding doesn't say "what comes after"

**Status:** ✅ SHIPPED (Item 16 phase 3 / Part 89 verified). Next-steps panel at `apps/web/src/routes/[lang]/my/orders/+page.svelte:485-532` shows three CTAs (browse orderbook, post first order, walkthrough FAQ) when the user has zero orders. All copy translated across 10 locales under `my_orders.next_steps.*`.

**Where it bites.** `/onboarding` walks the user through generating an identity and writing down 12 words. But after the seed quiz, the user lands at `/onboarding/register-name` and from there at `/my/orders`, which is empty. There's no "you're done — here's what to do next" beat.

**Why it matters.** A grandma who just spent 5 minutes carefully writing down 12 words on paper expects a "you're ready" celebration and direction. Instead she gets an empty orders page with no orders to display.

**Fix sketch.** Add a brief "what's next" panel on `/my/orders` that only shows when the user has zero orders and zero feedback yet. Three CTAs: (a) "Browse the orderbook to find something to buy", (b) "Post your first order — it's free", (c) "Read the 5-minute walkthrough" (link to the existing `how_to_trade_walkthrough` FAQ). The PendingFeedbackReminderBanner already establishes the pattern of "panel that only shows when there's something to show" for /my/orders.

### 1.3 — The seed-phrase backup step is hostile to grandmas

**Status:** ✅ SHIPPED across Parts 90 + 92.
- **Copy softening (Part 90)** — `onboarding.backup.confirm_understand` rewritten across 10 locales: "I understand Morphit cannot recover my account if I lose these keys" → "I'll keep these 12 words safe — I know they're the only way back into my account." Same custody truth, less doom-laden framing.
- **Printable backup card (Part 92)** — new `apps/web/src/lib/components/SeedBackupPrint.svelte` renders a paper-friendly 12-word card with the user's account name + generation date + storage warning. Pure local rendering — no client-side PDF library, no network round trip, the seed phrase never leaves the device. Uses the browser's built-in print dialog (paper or save-to-PDF). Visibility-based CSS isolation hides the rest of the page during print so the printout is just the backup card. Accessible from the seed-display block when the seed is visible. 11 i18n keys × 10 locales = 110 strings (`onboarding.backup.print_card.*`).
- **Show-the-seed-again mid-quiz (already shipped)** — the quiz stage at `apps/web/src/routes/[lang]/onboarding/+page.svelte:669-679` has a `← Show the seed again` button that returns to the review stage with `showSeed = true`. Translated across 10 locales as `onboarding.confirm.show_again`. A flustered user can revisit the seed without restarting onboarding.

**Where it bites.** `/onboarding` shows 12 words and asks the user to write them down on paper. Two checkboxes confirm they did and that they understand losing the seed is permanent. Then a quiz: "What was word #3? Word #7? Word #11?" — three random positions to type back.

**Why it matters.** Three problems:
- **The quiz is hard.** A grandma who wrote down 12 words 30 seconds ago can be flustered by "type word #11" because she's nervous about getting it wrong. There's no "show me the seed again" path mid-quiz; she has to leave the page and start over.
- **Writing on paper is the right answer but the UI doesn't help.** No printable PDF template, no "send to my printer" button, no QR code that links to a printable backup card. The user is on her own to find a pen and figure out how to write 12 words legibly.
- **The "I understand losing this is permanent" checkbox is scary.** Grandmas read those words literally and back out. The framing should be "your seed = your account, like a debit card PIN — write it down and keep it like cash" rather than the current "if you lose this you lose everything forever."

**Fix sketch.**
- **Add a "show me the seed again" button on the quiz step.** It re-displays the words above the quiz inputs. The session is over the moment they refresh anyway, so the secrecy benefit of hiding it is small.
- **Add a "Print a backup card" button on the review step.** A small printable PDF with the 12 words in a grid, the user's account name, the date, and a "keep this somewhere safe" footer. Generated client-side so the seed never leaves the device. Uses the existing PDF skill or could be built fresh.
- **Soften the checkbox copy.** Replace "I understand that if I lose these 12 words my account is permanently gone" with "I've written down my 12 words on paper and I'll keep the paper safe" plus a Tooltip pointing to the `lost_keys` FAQ for the full context.

### 1.4 — No "what is fiat?" / "what is a network fee?" / "what is a counterparty?" glossary

**Status:** ✅ SHIPPED (Part 89). `/glossary` route at `apps/web/src/routes/[lang]/glossary/+page.svelte` defines 21 terms (active key, blurt, blurt power, broadcast, counterparty, custom_json, delegation, federation, feedback, fiat, indexer, listing fee, network fee, operator, password, permlink, posting key, relay, release op, seed phrase, sign), each with a one-paragraph plain-language definition translated into all 10 locales under `glossary.<term>.{title,body}`. Linked from the footer as `nav.glossary`. The hover-tooltip `<term>` component idea from the original sketch was deferred — pure-page glossary first, in-context tooltips can be a follow-up.

**Where it bites.** Words like "fiat," "counterparty," "BLURT Power," "delegation," "permlink," "feedback," "network fee," "listing fee," "operator," "indexer," "relay," "release op," "broadcast," and "sign" are scattered across the UI. Each has an FAQ entry somewhere but the surfacing is uneven.

**Why it matters.** A grandma reading "post your order, pay the small network fee in BLURT" doesn't know what any of those words mean. She has to figure out (a) that "network fee" is the same as "listing fee" (often), (b) that "BLURT" is both an asset and a chain, (c) that "post" doesn't mean Facebook posting.

**Fix sketch.** Build a single `/glossary` page with one paragraph per term, alphabetized. Wire a small `<term>` component that renders the word with a dotted underline and on hover/tap shows the glossary entry inline. Use it sparingly — only on first appearance per page, only for the most jargony terms. Existing `<Tooltip>` component is the natural foundation.

### 1.5 — "Off-platform" trade settlement is unexplained at the moment of the trade

**Status:** ✅ SHIPPED (Item 16 phase 4 / Part 91 verified). `apps/web/src/lib/components/FirstTradeHelper.svelte` renders a 3-step "what to do" panel inside `ConversationView` when the user is in a chat for one of their own orders AND has zero outgoing feedback. Privacy posture preserved (client-side only, queries indexer for `/feedback/given/<user>` once per mount, hides if any feedback exists). Per-session dismissal via sessionStorage — dismissing for one order doesn't dismiss for others, and the next session re-evaluates. All 8 strings (`first_trade_helper.heading`, `step_1`, `step_2_warn`, `step_2`, `step_3`, `faq_link`, `aria_label`, `dismiss_aria`) translated across 10 locales. Step 2 is bold-prefixed with "Wait!" warning about sending crypto before fiat clears — directly addressing the highest-stakes loss vector.

**Where it bites.** The first time a grandma's order matches and someone opens chat with her, she sees a chat window and... nothing else. There's no "here's what happens next" flow. She has to figure out from chat alone that:
- They're going to agree on payment details.
- One of them sends fiat first.
- The other sends crypto.
- Both leave feedback.

**Why it matters.** This is the highest-stakes moment in the whole product — the first trade. Getting it wrong loses money. The only available guidance is the `how_to_trade_walkthrough` FAQ entry, which the user would have to know to look up.

**Fix sketch.** Add a "first-time trade helper" panel that appears in the chat window the FIRST time a user is in a chat for one of their own orders. Three steps with checkboxes:
1. ☐ "Agree on the price and payment method with the other person."
2. ☐ "One of you sends payment first. **Important:** if you're sending crypto, wait until you've actually received the fiat (not just 'pending') before you send crypto."
3. ☐ "After the trade is done, leave a review on `/my/orders` so future traders trust you both."

This panel disappears once the user has completed any trade (i.e., has any outgoing feedback). Privacy posture preserved — the helper is purely client-side.

---

## Tier 2 — Friction that experienced users tolerate but grandmas don't

### 2.1 — No "I made a mistake, undo!" path on chat messages

**Status:** ✅ SHIPPED (Part 91). New module `apps/web/src/lib/security/accountNumberDetector.ts` mirrors the private-key detector pattern with a different regex set (IBANs, 9+-digit runs with space/hyphen separators, SWIFT/BIC codes). Wired into `ChatComposer.svelte` as a SOFT, one-time-per-session inline reminder ("Permanent. Account numbers in chat go on the Blurt chain forever. Proofread carefully before sending.") above the textarea — never blocks send, never redacts (account numbers are LEGITIMATE in chat; that's how trade partners share where to send fiat). Dismissable per session via sessionStorage; once dismissed, won't reappear until a new tab. Translated across all 10 locales under `chat.composer.acct_reminder.{heading,body,dismiss_aria}`. Regression smoke at `apps/web/scripts/account-number-detector-smoke.ts` covers 21 scenarios — IBAN forms (German, French, lowercase), card-shaped digit runs (with spaces, with hyphens), SWIFT 8/11-char codes, routing+account combos, AND negative cases (greetings, prices, dates, short order IDs, mnemonic-shaped words, lowercase 8-char alphanumeric not matching SWIFT, crypto addresses out of scope here). Phone numbers DO trigger (10 digits hyphenated reads as digit run) — intentional per the doc comment: false positives just trigger a once-per-session dismissable reminder; false negatives let an account-number typo through.

A grandma typos her bank account number into chat. The message is on chain — immutable. She can send a correction message but the wrong one is already there forever. The chat UI should at least surface a clear "this is permanent — proofread before sending" warning the first time she's about to send a chat message that contains digits or hyphens that look like account numbers.

This complements the existing private-key detector. Same scanner pattern, different regex set.

### 2.2 — `pendingFeedbackPermlink` URL hash is not human-friendly

**Status:** Deferred — low priority + back-compat concern (Part 90 review). Permlinks are human-readable enough in practice (`morphit-o-2k4f9` is short and recognizably a Morphit-prefixed slug), and any in-flight OS notification already issued with the old `#feedback=<permlink>` shape would break if the URL parser switched to `#review-<account>`. A future change could accept both formats indefinitely, but the user-visible benefit is small and the cost (parser dual-mode, test coverage for both, OS notification re-issue when format changes) is non-trivial. Reviewed and intentionally left as is.

When the OS notification fires for the new feedback reminder (Item 3), it deep-links to `/my/orders#feedback=<long-permlink-hash>`. A grandma seeing that URL in her notification preview doesn't recognize it. The deep link works fine; the URL preview reads as gibberish.

Could be improved by changing the hash format to `#review-<counterparty-name>` (lookup by name → permlink on mount). Lower priority.

### 2.3 — No "back" button on multi-step flows

**Status:** ✅ SHIPPED (Part 98). The original gap analysis identified `/onboarding`'s missing "go back to previous step" affordance. After auditing the stage state machine: `confirm → review` was already shipped (Part 92's "Show again" button); `generating → choose` is sub-second so a back button isn't needed; `done → anywhere` is forbidden (chain state already written). The single meaningful gap was `review → choose` — the user has just seen their seed phrase and might want to switch path or restart. Going back from this stage MUST wipe the in-memory `FullIdentity` (seed bytes + 4 keypair private keys) and `LiveIdentity` (posting + memo private keys) per the project's key-handling contract — same K1.2 / O2.1 pattern as the existing `onConfirmLeave` cleanup. New `requestRestartFromReview()` opens a `ConfirmModal` (the user just generated 12 words they were asked to write down — a misclick that silently discards them would feel like data loss). On confirm, `confirmRestartFromReview()` calls `wipeFullIdentity(full)` + `wipeLiveIdentity(live)`, nulls both refs, clears the password from component state, resets the auxiliary review-stage checkboxes (`wroteDown`, `understand`, `showSeed`, `keystoreMode`) and the (unused-yet-here) quiz state, then sets `stage = 'choose'`. New back button rendered as a ghost-variant `BusyButton` in the review-stage actions row. 5 i18n keys × 10 locales (`onboarding.review.back_button`, `onboarding.review.back_confirm.{title,body,confirm,cancel}`). New permanent regression smoke at `apps/web/scripts/onboarding-back-button-smoke.ts` (15 scenarios) parses the onboarding source and asserts the structural invariants: both wipe helpers are called, both refs are nulled, password is cleared, stage transitions correctly, and the imports survive any future refactor.

`/onboarding` has stages (`choose` → `generating` → `review` → `confirm` → `done`) but no visible "go back to previous step" button. A grandma who wants to switch from "reputation" path to "anonymous" path mid-flow has to know to use the browser back button. Some browsers won't restore state correctly on back-navigation if the page used `goto()` with `replaceState`.

Adding a visible "← Back" button inside each non-terminal stage would help.

### 2.4 — Time displays are absolute, not relative

**Status:** ✅ SHIPPED (Parts 89 + 90). The `<RelativeTime>` component at `apps/web/src/lib/components/RelativeTime.svelte` was built in Part 89 with terse + descriptive formats, 60s auto-tick, NaN-safe, native `<time>` element with `title=` showing the absolute time on hover. Part 89 migrated four call sites: `/my/orders`, `/orderbook`, `/@account` profile (4 instances), `/chat` inbox. Part 90 added `/instances` last-probed-at to the migration. Order-detail "Posted on" / "Expires on" intentionally retain absolute dates because they're the canonical record (a relative "3 days ago" doesn't tell you the trade timestamp).

Order rows show "Created: 2026-04-15 14:32 UTC" instead of "3 days ago". Feedback rows show "2026-04-20" instead of "yesterday". The codebase has the data and could use `Intl.RelativeTimeFormat` directly. A grandma scanning her orders thinks "2026-04-15 14:32 UTC" is gobbledygook.

A quick `<RelativeTime>` component that takes an ISO timestamp and renders "3 days ago" with the absolute time as a `<Tooltip>` would be a meaningful upgrade. Already done in some pages but not consistently.

### 2.5 — No "starter pack" of safe practices on first-trade post

**Status:** ✅ SHIPPED (Part 93). New `apps/web/src/lib/components/FirstPostStarterPack.svelte` detects first-time posters via `getOrdersByAccount` (zero orders on record → plausibly first post) and surfaces a green-tinted starter-pack card at the top of `/post` with three safe-default tips: (1) start small (under $50), (2) 7-day expiry instead of 90, (3) pick payment methods you actually accept. The card auto-pre-fills the form's `expiresDays` from 90 → 7 via the `onFirstTimeStatus` callback (only when still at the form's default — won't override a user's saved draft). Per-session sessionStorage dismissal. Self-hides for experienced posters (any historical orders disqualify, including cancelled and expired). 11 i18n keys × 10 locales translated.

The post-order form doesn't ask "is this your first time?" If yes, it could surface a different flow:
- Strongly recommend a small first trade ("less than $50") for safety.
- Pre-fill a 7-day expiry instead of 90.
- Explain what each form field means (price, payment method, region, terms) inline rather than the user having to figure out which fields are required.

### 2.6 — The avatar identicon is intimidating

**Status:** ✅ SHIPPED (Part 97). The investigation re-framed: identicons themselves are non-negotiable (privacy + uniformity policy per `IdentityLabel.svelte` docstring), and the actionable Tier 2.6 fix is two-fold: (1) audit that the project's "no raw `@{account}` without an identicon" policy is consistently applied across the codebase, and (2) make the user's own identicon prominently visible to the user themselves so grandma associates "the abstract pattern" with "me." Part 96's Memory #11 Category M audit established the policy authoritatively (M-8 fix). Part 97 audits compliance: of the 5 raw `@{account}` render sites found, 2 are acceptable exceptions (the print-only seed-backup card and the explorer profile page hero, which already renders a 64px identicon adjacent), and 3 needed fixes — `apps/web/src/routes/[lang]/settings/+page.svelte` lines 886, 1581, 1669 — all replaced with `<IdentityLabel>`. The own-account fix at line 886 directly addresses the Tier 2.6 grandma concern: when she opens settings and sees her own account name, the identicon next to it lets her associate the visual identity with herself. The hidden-accounts and blocked-accounts fixes (1581, 1669) close real spoofing-protection gaps — without identicons, "I blocked `@morphit` but the spoof `@morph1t` is still unblocked" was textually indistinguishable. Permanent regression smoke at `apps/web/scripts/identity-label-policy-smoke.ts` runs a regex sweep over `apps/web/src/routes` and `apps/web/src/lib/components` for raw `@{...}` patterns, with an explicit allow-list (3 files) and 6 scenarios checking call-site presence. Future raw-render drift will be caught at smoke time.

The avatar shown in the IdentityLabel component is a deterministic identicon — a procedural pattern derived from the user's account name. To a grandma it looks like "weird abstract art". She'd expect a photo or initials. Without an option to upload a photo (which would cost privacy), the next-best is to add an "edit display name" affordance more prominently so users can at least make their identity recognizable to themselves.

### 2.7 — No "I don't see my order, where did it go?" recovery panel

**Status:** ✅ SHIPPED (Part 91). `/my/orders` already shows fee-rejected chips on individual order rows (lines 589-607: amber chip with `feeStatusLabel` text + a "learn more" link to `/faq#order_fee_rejected`). The missing piece was a forward link FROM `/orderbook` so a grandma who paid a fee and doesn't see her listing has a recovery path. Part 91 added: `apps/web/src/routes/[lang]/orderbook/+page.svelte` lines 502-516 render an inline secondary link below the "Post an order" CTA — "Posted an order but don't see it? Check fee status →" — pointing to `/my/orders#fee-status`. Visible only when `$isUnlocked && viewerAccount !== null` (anonymous browsers have no orders to recover). The `/my/orders` orders list `<ul>` got `id="fee-status"` so the deep link lands at the orders section. New i18n key `orderbook.fee_rejected_check` translated across 10 locales (es: "¿Publicaste una orden pero no la ves? Revisa el estado de la tarifa →", de: "Order veröffentlicht, aber nicht sichtbar? Gebührenstatus prüfen →", fa uses LRM-flipped arrow, etc.).

When a fee is rejected (`order_fee_rejected`), the order shows a fee-status chip in `/my/orders`. But on the orderbook itself, the order just doesn't appear — no breadcrumb back to the user explaining "your order isn't showing because the fee didn't verify, here's how to fix it."

A grandma who paid the fee and then doesn't see her order on the orderbook will assume Morphit is broken and leave. Adding a "your fee-rejected orders" subsection on `/my/orders` (already partially there) plus a forward link from the orderbook ("Posted but don't see it? Check fee status →") would close that loop.

---

## Tier 3 — Polish, not blockers

### 3.1 — No light mode

**Status:** ✅ REVIEWED, intentionally deferred (Part 90). Project standing direction is "dark-mode-only" per `apps/web/src/app.html` and `docs/UX-STANDARD.md`. The dual-class Tailwind CSS (Tier 4.2) preserves the optionality if direction shifts, but no toggle is on the roadmap. Closed as not-a-bug for the grandma campaign; remains a real future option if user research demands it.

The site is hard-locked to dark mode (`<html class="dark">`). Some grandmas have astigmatism that makes light text on dark backgrounds harder to read; the user-research literature is roughly split. Adding a light-mode toggle is a Tier-3 nice-to-have. Note: project standing direction is "dark-mode only" so this is flagged but not actually a recommendation — just an observation that some users would prefer light mode.

The `bg-white` / `dark:bg-ink-900` style in the CSS hints that light mode was contemplated and dropped. Keeping the dual-class CSS but adding a toggle is a small change if direction shifts.

### 3.2 — No "remember my preferences" survey

**Status:** ✅ SHIPPED (Part 99). New `apps/web/src/lib/stores/userPreferences.ts` (~135 lines) — typed `UserPreferences { fiat: string; region: string }` Svelte writable store, persisted to localStorage under `morphit.userPreferences.v1`. Privacy-first: never sent to indexer/relay, never on chain, lives only in browser localStorage. Cleared when the user clears site data or chooses "Clear preferences" in `/settings`. Read at module load, written synchronously on every `setPreference()` call. Empty-state cleanliness: when both keys are empty, the localStorage key is removed entirely rather than persisting `{"fiat":"","region":""}`. Graceful localStorage failures (private browsing, quota exceeded, JSON parse errors): fall back to empty state, never crash the page. Wired into `/post`'s `onMount` as a third-tier pre-fill (after draft restore + session-prefill), only fills empty fields. Wired into both success paths via `persistPreferencesAfterSuccess()` helper that records the fiat and region values used after a successful broadcast. New "Preferences" section in `/settings` shows current saved values with a two-step "Clear preferences" confirm. 9 i18n keys × 10 locales (`settings.preferences.{heading, explain, empty, fiat_label, region_label, clear_button, clear_confirm_body, clear_confirm_yes, clear_confirm_cancel}`). Permanent regression smoke at `apps/web/scripts/user-preferences-smoke.ts` covers 12 scenarios across the localStorage contract: empty state, single-key persist, multi-key persist, clear-as-empty-write, malformed JSON tolerance, wrong-type tolerance, parsed-primitive tolerance, parsed-null tolerance, unknown-extra-fields drop, storage key shape, overwrite persistence.

A grandma who goes through onboarding can fill in some preferences (preferred fiat currency? region? language?) so subsequent flows are pre-filled. Currently every form starts blank.

### 3.3 — Localized number/date formats inconsistent

**Status:** ✅ SHIPPED (Part 94). Centralized `apps/web/src/lib/i18n/formatters.ts` (~210 lines) exports locale-aware helpers: `formatUsd`, `formatPercent`, `formatBlurt`, `formatCount`, `formatDateLong`, `formatDateMedium`, `formatDateTime`. Reads the active locale from svelte-i18n's `locale` store at call time; falls back to `'en'` in SSR/smoke contexts where the store isn't initialized. `Intl.NumberFormat` and `Intl.DateTimeFormat` instances are cached per (locale, options) tuple. Migrated 4 user-facing call sites: 2 USD displays (`StrangerFeeModal.svelte`, `/post` fee preview) now route through `formatUsd`; `apr.ts:formatApr` and `balanceMath.ts:formatPercentage` route through `formatPercent`. `priceModelDisplay.ts`'s local `formatPercent` was deliberately NOT migrated — it has bespoke trailing-zero stripping for orderbook line density that the centralized helper doesn't provide. Rating displays (`weighted_rating.toFixed(1)`) deliberately not migrated either — single-decimal star ratings are conventional cross-locale. `formatPercent` preserves the original 2-decimal padding ("7.50%" not "7.5%") for visual consistency in tables, matched against the existing apr-smoke / balance-math-smoke / pnl-smoke unit tests. Permanent regression smoke at `apps/web/scripts/i18n-formatters-smoke.ts` covers 16 scenarios across all 7 helpers + edge cases (NaN, Infinity, invalid date strings).

`Intl.NumberFormat` is used in some places but not others. A grandma in Germany sees "$1,234.56" in one place and "1.234,56 €" in another for the same amount. Auditable via grep but tedious.

### 3.4 — "Free" vs "no fee" terminology drift

**Status:** ✅ REVIEWED, not a real bug (Part 90). Fresh sweep of every non-FAQ user-facing string found three patterns in active use: "Your first order is on us! 🌱" (welcome heading), "Your first order is free" (`waiver_asset_hint`, explanatory body copy), and "no listing fee" (`fee_note`, secondary captions). On close reading these are stylistically distinct phrasings appropriate to their context — "on us" is the warm greeting voice, "is free" is the matter-of-fact explanation, "no listing fee" is the clarification when the user might wonder which fee waivers apply. They aren't drift; they're context-specific variants. Translators across all 10 locales mirror the same three-pattern convention. Closed without changes.

The first-buy waiver UI says "First order is free 🌱" in some places, "no listing fee" in others, "fee waived" in others. Pick one term and use it consistently.

### 3.5 — No printable cheat-sheet of "what is what"

**Status:** ✅ SHIPPED (Part 95; USDT row added Part 121 cp4; BCH row added Part 122 cp23 DD; LTC row added Part 122 cp24; USDC row added Part 122 cp30; DAI row added Part 122 cp34 (cp31 i18n strings landed but the cheat-sheet page never rendered them — closed in cp34 H-1); DOGE row added Part 122 cp34 — same H-1 closure). New `apps/web/src/routes/[lang]/cheat-sheet/+page.svelte` renders a one-page printable reference covering the four highest-confusion concept-pairs: account name vs seed phrase vs password, listing fee vs network fee vs trade payment, the supported tradable assets at a glance (BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP — with the USDT row noting the four supported networks and the cross-network-irreversibility warning, and the BCH row noting CashAddr + legacy address-format coexistence, and the LTC row noting L/M/3/ltc1 address-format coexistence, and the DASH row noting X-prefix P2PKH and 7-prefix P2SH coexistence plus the optional PrivateSend mixing posture, and the DOGE row noting D-prefix P2PKH + 9/A-prefix P2SH coexistence and DOGE's lack of native privacy upgrade, and the ZEC row noting per-address privacy choice between t1/t3 transparent and zs1/u1 shielded, and the ARRR row noting chain-level shielded transactions via the Sapling zk-SNARK pool with single zs1 address format, and the DCR row noting hybrid PoW/PoS consensus with on-chain governance via Politeia plus opt-in wallet-side CoinShuffle++ mixing, and the SOL row noting high-throughput delegated PoS + Proof-of-History sequencing with transparent base layer and wallet-side address rotation as the privacy lever, and the ETH row noting post-Merge Proof-of-Stake consensus + EVM-wide address-shape disambiguation via asset/network fields + ENS-out-of-scope for distributed-no-SPOF + contract-destination warnings, and the XRP row noting Federated Byzantine Agreement consensus + destination-tag UX guard for exchange-hosted addresses + 1-XRP reserve requirement for account creation + native XRP cannot be frozen), and "what to do if something goes wrong" (lost seed, forgotten password, lost device, suspected compromise). The route uses the same visibility-isolation print pattern as `SeedBackupPrint.svelte` (Part 92) — html-level class flag `morphit-printing-cheatsheet` activates print-only CSS that hides everything except the cheat-sheet, lifts it to fill the page, and renders at 9pt with section headers. Static content; no user data loaded; can be printed by anyone signed in or not. 36 i18n keys × 10 locales initially + 1 USDT row × 10 locales added Part 121 cp4 + 1 BCH row × 10 locales added Part 122 cp21 (wired into the svelte at cp23 DD) + 1 LTC row × 10 locales added Part 122 cp24 + 1 DASH row × 10 locales added Part 122 cp27 + 1 DOGE row × 10 locales added Part 122 cp33 + 1 ZEC row × 10 locales added Part 122 cp39 (with no-favoritism framing per the universal principle adopted at cp39) + 1 ARRR row × 10 locales added Part 122 cp41 + 1 DCR row × 10 locales added Part 122 cp43 + 1 SOL row × 10 locales added Part 122 cp45 + 1 ETH row × 10 locales added Part 122 cp47 + 1 XRP row × 10 locales added Part 122 cp49 (same no-favoritism framing). Footer link wired in `+layout.svelte` next to the glossary link.

A one-page printable PDF that explains: account name vs seed phrase vs password, network fee vs listing fee vs trade payment, BTC vs XMR vs BLURT, what to do if you lose your seed. Grandmas like paper. A printable cheat-sheet they can keep next to the keyboard would be high-value-low-cost.

---

## Tier 4 — Non-grandma but worth flagging

### 4.1 — `expires_30d` in the post-order form is untranslated

**Status:** ✅ SHIPPED (Part 89). The 88-string × 9-locale translation pass in Part 89 included `post_order.form.expires_{1d,3d,7d,30d}` along with the rest of the systematically-untranslated post-order strings. Verified per locale: `es: "En 30 días"`, `de: "In 30 Tagen"`, `ru: "Через 30 дней"`, `fa: "در ۳۰ روز"`, `zh-CN: "30 天后"` — all correct.

The localized JSON files all carry English "In 30 days" for the `expires_30d` option label, in 9 of 10 locales (`en` is correct, the rest are still in English). Real i18n drift bug; not specifically grandma-facing but visible to non-English-speaking grandmas. Out of scope for this investigation but flagged.

### 4.2 — Light-mode CSS classes are dead code

**Status:** ✅ REVIEWED, intentional (Part 90). The comment block in `apps/web/src/app.html` (lines 6-13) explicitly preserves the light variants as inert fallback so that a future `<html class="dark">` → `<html class="light">` toggle can ship without re-introducing every component's light-mode rules. Tier 3.1 (no light mode) flags the toggle itself as "Tier 3 nice-to-have"; if the toggle ever ships, the dead classes immediately become live. The bundle cost is small (~2-4KB across all pages) and the optionality is non-trivial. Closed without changes.

`bg-white` etc. ship in CSS but never render because `<html class="dark">` overrides them. About 2-4 KB of unused CSS in every page. Not grandma-facing but a small bundle-weight win if cleaned up.

### 4.3 — Spinner on `/onboarding` generation is faster than human comprehension

**Status:** ✅ SHIPPED (Part 89). 600ms minimum visibility on the generating spinner via `Promise.all([generateIdentity(), minDelay])` at `apps/web/src/routes/[lang]/onboarding/+page.svelte`. Slower machines proceed at natural rate; fast machines see the spinner long enough to read as "device is doing something" rather than "did something break?"

`generateIdentity()` resolves in ~50ms on modern hardware. The spinner appears for less than a frame, then jumps to the seed display. It looks broken — a grandma may think nothing happened. Adding a 500-700ms minimum visibility on the spinner would feel more reassuring.

---

## Recommendation for Batch N

If you're doing a grandma-friendliness pass, the highest-impact items are:

1. **Tier 1.3** (seed-phrase quiz + printable backup) — directly removes the most stressful moment in onboarding.
2. **Tier 1.5** (first-time trade helper in chat) — directly de-risks the highest-stakes user moment.
3. **Tier 1.1** (asset tooltips on post-order) — addresses the most-likely point where new users back out.
4. **Tier 1.2** (post-onboarding "what's next" panel) — closes the dead end after signup.
5. **Tier 2.4** (relative time) — passive improvement; touched everywhere but each touch is cheap.

The rest is real but lower-priority — pick from Tier 2 based on how much of the grandma flow you want to cover. Tier 3 / 4 are polish.

---

## Items NOT in this list (deliberate)

A few things grandmas might think they want but Morphit deliberately does not provide:

- **"Customer service" chat with humans.** Morphit has no humans on staff who can intervene in trades. Adding a fake "Help" chat would mislead users.
- **"Reset my password" flow.** No, the seed phrase is the only recovery path. Faking a reset would either give Morphit access to keys (custodial) or pretend to do something it can't.
- **"Verify with email/phone."** No, that's KYC by another name. Even "for security" framing would be a step toward identity-linked trading.
- **"Reverse my trade."** No, trades are between two humans off-platform. Morphit can't reverse what it never touched.

These are honest limitations, not friction to remove. The grandma-friendly answer here is **clear messaging upfront** that those things don't exist, and why — not adding fake versions of them.
