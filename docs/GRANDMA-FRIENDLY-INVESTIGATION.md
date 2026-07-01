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

**Status:** ✅ SHIPPED (Item 16 phase 2 / Part 90 verified; USDT tooltip added Part 121 cp3; BCH tooltip added Part 122 cp21; LTC tooltip added Part 122 cp24; DASH tooltip added Part 122 cp27; USDC tooltip added Part 122 cp30; DAI tooltip added Part 122 cp31; DOGE tooltip added Part 122 cp33; ZEC tooltip added Part 122 cp39; ARRR tooltip added Part 122 cp41; DCR tooltip added Part 122 cp43; SOL tooltip added Part 122 cp45; ETH tooltip added Part 122 cp47; XRP tooltip added Part 122 cp49). Each asset chip on `/post` carries a `<Tooltip>` next to the BTC / XMR / BLURT / USDT / USDC / DAI / BCH / LTC / DASH / DOGE / ZEC / ARRR / DCR / SOL / ETH / XRP button — explainer copy under `post_order.form.asset_explainer.{btc,xmr,blurt,usdt,usdc,dai,bch,ltc,dash,doge,zec,arrr,dcr,sol,eth,xrp}` translated across 10 locales. The BLURT, USDT, USDC, DAI, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP, BCH, LTC, and DASH tooltips have `faqKey="what_is_<asset>"` deep-links so a curious user lands on the longer FAQ entry (BCH/LTC/DASH FAQs backfilled at cp51 to close pre-pattern drift; the cp51-O5 structural defense pins per-asset FAQ existence forever). BTC and XMR chips are tooltip-only since the FAQ doesn't have dedicated entries for those — their explanations live in `what_is_morphit` + the privacy framework FAQs.

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

**Status:** ✅ SHIPPED (Part 89). `/glossary` route at `apps/web/src/routes/[lang]/glossary/+page.svelte` defines 22 terms (active key, blurt, blurt power, broadcast, counterparty, custom_json, delegation, federation, feedback, fiat, indexer, instance, listing fee, network fee, operator, password, permlink, posting key, relay, release op, seed phrase, sign), each with a one-paragraph plain-language definition translated into all 10 locales under `glossary.<term>.{title,body}`. Linked from the footer as `nav.glossary`. The hover-tooltip `<term>` component idea from the original sketch was deferred — pure-page glossary first, in-context tooltips can be a follow-up.

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

### 1.6 — Seed-phrase sign-in had no "remember me on this device" choice

**Status:** ✅ SHIPPED (cp137 H-1).

**Where it bit.**  Sally pastes her 12 words on a new device, logs in, trades, closes the tab.  Tomorrow she comes back to Morphit and is presented with the sign-in screen again — same 12 words required.  The session-only behavior was privacy-positive (great for shared computers) but the user had no way to opt OUT of it without finding the Backup-keys card buried under Settings.

**Fix.**  After a successful seed import, Morphit transitions to a new "remember me on this device?" step with a single checkbox UNCHECKED BY DEFAULT.  Wording: "Automatically remember me on this device? (assuming nobody else uses it)" — the qualifier makes the privacy implication visible at the point of decision.  If unchecked: session-only behavior preserved (privacy-positive default).  If checked: she picks a password, the envelope is re-encrypted with it and persisted to localStorage; future visits prompt for password only.

**Why this matters more than it sounds.**  The previous trap was the kind of UX defect that gets silently misdiagnosed as "the app forgot me" or "I must have done something wrong."  Grandma assumes she did the thing wrong; Sally re-pastes her seed every visit; both end up with worse-than-necessary friction.  Lock-in via `import-remember-me-smoke` (5 scenarios, tamper-tested — flipping the default to `$state(true)` fails with "MUST be unchecked by default") prevents the privacy-positive posture from drifting in a future edit.

### 1.7 — FAQ search failed Grandma's first-load questions

**Status:** ✅ SHIPPED (cp137 H-2).

**Where it bit.**  Simulated against the live `searchEntries` function, Grandma's first three FAQ queries all routed to wrong top hits before cp137:

| Grandma's query | Pre-cp137 top hit | Should be |
|---|---|---|
| "how do I start" | `order_editing` (1.00) | `how_to_trade_walkthrough` |
| "how do I begin" | (zero hits) | `how_to_trade_walkthrough` |
| "first time user" | `profile_pages` (1.00) | `how_to_trade_walkthrough` |
| "getting started" | `how_morphit_protects_me` (1.00) | `how_to_trade_walkthrough` |

**Fix.**  Added two synonym clusters to `SYNONYMS_EN` in `apps/web/src/lib/utils/faqIndex.ts`: a getting-started cluster (`start`, `starting`, `started`, `getting`, `begin`, `beginning`, `beginner`, `newbie`, `newcomer`, `first`, `howto`, `tutorial`, `guide`, `step`) and a deictic cluster (`this`, `thing`, `site`, `app`, `platform`, `service`, `product`, `website`) — all mapped to canonical tokens that appear in the walkthrough/signup/morphit entries.  Post-fix: 14 of 14 grandma-shaped queries route correctly.  Lock-in via `faq-search-grandma-coverage-smoke` (14 scenarios, tamper-tested — removing the cluster fails 5 of 14).

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

---

## Update — cp120–cp122 (cash-by-mail & physical-shipment tracking)

A new class of grandma-friction surfaced with the cash-by-mail feature.
Audit notes below.

### Grandma's mental model

"I want to buy some Monero with cash, but I don't live near anyone who
sells it in person. So I mail the cash. How do I prove I sent it?"

Morphit's answer needs to be **two clicks**, not a manual.

### What was shipped (cp121)

In the chat composer, two new buttons next to the existing
"Share address" / "I sent it" buttons:

- **Share mailing address** — opens a form. Country picker has the 15
  most-common countries in a dropdown (US, UK, DE, CN, JP, etc.); a 16th
  "Other" option reveals a 2-char ISO code input for everyone else.
  Street, city, postal-code required; state, recipient name, apt-line,
  note all optional. **Privacy aside at the top** with 4 plain-language
  warnings (E2EE-only / irreversible / P.O.-box tip / clear-chat-after).

- **Record shipment** — opens a form. Carrier dropdown of 20 worldwide
  services + "Other (specify carrier)" with free-text name + URL.
  Tracking number required (5–50 chars), optional note. **Safety aside
  at the top** with 4 always-shown tips; a collapsible "If you're
  mailing CASH" expander reveals 3 cash-specific tips (tinfoil-wrap,
  UPS/FedEx prohibit cash, customs warning).

The recipient sees two new pill types in chat:

- 📬 **Mailing address shared** — formatted address with 📋 Copy button.
- 📦 **Shipped via X** — carrier name + monospace tracking + 📋 Copy
  button + 🔗 "Track package" link (opens carrier site in new tab).

### Where this still has grandma friction (T2/T3 backlog)

**T2.1 — Modal trigger discovery.** Buttons are surfaced next to existing
ones; chat-flow users will find them. New users posting their first
cash-by-mail order may not realize the in-chat buttons exist. Future
work: surface a hint in the order-detail page ("Your trade uses Cash by
mail — when you're ready, share your mailing address from chat") when
the order's payment_method matches by_mail. **Estimate:** small —
one-line conditional banner. **Priority:** T2.

**T2.2 — Tracking spoofing detection.** Sellers must manually verify the
destination ZIP matches their actual ZIP. Documented in FAQ
(`cash_by_mail_walkthrough`) but a built-in nudge in the shipment-pill
UI could help. Future: when a seller's mailing-address-share carries a
ZIP, and a subsequent shipment pill arrives in the same conversation,
auto-show a "Verify on carrier site that destination ZIP matches the
ZIP you shared" reminder. **Estimate:** medium — needs pill-pair
detection logic. **Priority:** T2.

**T3.1 — Carrier tracking URL freshness.** Carriers occasionally
restructure their tracking-page URL structure. When that happens, the
"Track package" link 404s. Today: user falls back to copy-and-paste.
Future: periodic carrier-URL probe (out-of-band, not at runtime;
maintainer task). **Estimate:** low ongoing maintenance. **Priority:**
T3.

**T3.2 — International shipment cost estimation.** Grandma doesn't know
that a USPS envelope to Russia costs differently than to Mexico.
Future: surface a brief "estimate shipping cost at your post office
before agreeing to a trade" tip on the order-detail page for
international counterparties. **Estimate:** small (text-only).
**Priority:** T3.

### What's NOT being added (deliberate)

- **"Verify the address is real" check.** No third-party postal-API
  integration. We don't ping commercial address-verification APIs —
  that's a privacy leak (the verifier learns the recipient's address)
  and a chokepoint.
- **"Hold the crypto until package arrives" escrow.** No. Morphit is
  non-custodial; we never hold either side's value. The seller waits
  for the cash, then releases crypto via the existing flow. Adding
  escrow would require trusting Morphit (or some operator) with funds.

---

## Update — cp123-cp125 (reputation hardening: time decay + concentration detector + verifiable receipt + side distinction + dormancy)

The reputation surface gained four new signals across cp123-cp125. Each
was reviewed against the grandma-friendliness lens before shipping.

### What grandma actually sees on the profile

**Before cp123:** "4.7 ⭐ (23)" + histogram + raw feedback list.

**After cp125:** "4.74 ⭐ (23)" + histogram + (when populated) two side
chips "as buyer: 4.92 (15)" and "as seller: 3.21 (8)" + "Last traded:
3 days ago" + raw feedback list.

Net visual additions: 2-3 small chips + 1 one-line dormancy text.
Hidden gracefully when the data isn't there (brand-new account, etc.).

### Grandma's mental model — what we want her to learn

When grandma sees a profile, she should be able to answer in 3 seconds:
- "Is this person reliable?" → headline 4.74 with count
- "Do they have a track record with someone like me?" → buy vs sell
  chips show if their seller-side rep is the relevant one
- "Are they active or have they vanished?" → "Last traded N ago" chip

She should NOT need to know:
- That there's an exponential decay formula
- That there are signals A/B/C/D filtering some reviews
- That she can fetch a JSON receipt to verify the score

That's all visible behind a FAQ link, not on the page. The page stays
calm.

### T2/T3 backlog from cp123-cp125

**T2.1 — Surface excluded count.** Today the headline shows the
INCLUDED count (post-filter). Could show "(23 included; 2 excluded
by Sybil filter)" as a small ink-500 line. **Risk:** grandma asks
"why 2 excluded? did this person do something bad?" — answering this
in-UI requires careful copy. **Estimate:** medium (needs both data
flow + careful UX copy). **Priority:** T2.

**T2.2 — Verifiable-receipt button.** Today the receipt is API-only.
Could add a small "[verify this score]" link near the rating, opening
a modal showing the receipt rows + decay weights in a table form.
**Risk:** grandma sees a big table of cryptic data she doesn't
understand. **Estimate:** medium-high (good UX is hard). **Priority:**
T3.

**T2.3 — Recency explainer.** Today the headline number reflects
365-day decay silently. A long-time trader whose score dropped after
cp123 might wonder why. Could add a hover-tooltip "weighted by
recency: 365-day half-life — newer reviews count more." **Estimate:**
low. **Priority:** T2.

**T2.4 — Last-traded chip styling.** Currently displays as plain
text. Could surface as a colored chip (green if <30 days, yellow
30-180 days, red >180 days). **Risk:** color signals can mislead
("red = bad"); dormancy isn't necessarily bad. **Estimate:** low.
**Priority:** T3 (good idea pending more user feedback).

### What's deliberately NOT being added (per Ken's priorities)

- **EigenTrust-style transitive reputation weighting.** Considered as
  H3 in the analysis phase; explicitly skipped because newcomer
  ramp-up costs were judged too high. Brand-new reviewers carry full
  weight on their reviews; the alternative was an unfair penalty on
  legitimate new traders.
- **Reviewer-comment-quality scoring.** No attempt to grade comments
  for "specificity" or "detail." Subjective, gameable, and incompatible
  with privacy (would require operator content reading).
- **Operator-side reputation override.** Operators cannot bump or
  demote any account's score. Reputation is on-chain; operators choose
  to display it or not, but cannot change what it says.

---

## Update — cp127 (self-sovereign BLURT pricing: morphit_native)

cp127 added a new price source (`morphit_native`) that derives BLURT/USD
from on-platform trade data instead of asking Klingex/Coingecko. From
grandma's perspective, this is **entirely invisible** — and that's the
right outcome.

### What grandma sees today, after cp127

The exact same thing she saw before: "60 BLURT (~$0.12)" next to listing
fees, an order saying "sell 0.05 BTC for $5,000 USD via bank transfer,"
etc. Nothing changed in the UI. The price source's job is to make the
USD echo informative; whether it came from Klingex, Coingecko, or
on-platform trades is plumbing.

If the operator flips on `MORPHIT_INDEXER_PRICE_FEED_NATIVE_ENABLED`,
grandma still sees the same USD figure — possibly slightly more
accurate because it's anchored in real on-platform trade activity, but
not visibly different.

### T2/T3 backlog from cp127

**T2.1 — Price-source-name surface.** Today the price's PROVENANCE
(Klingex vs Coingecko vs morphit_native vs static) is in
`/v1/listing-fee.diagnostics` but not displayed to users. Curious
power-users might want a small "via Klingex" / "via morphit_native"
chip near the USD echo. Risk: grandma asks "what's morphit_native?
should I worry?" — answering this in-UI requires careful copy. **Estimate**:
low for the technical work, medium for the UX copy. **Priority**: T3.

**T2.2 — Receipt UI button.** Today `/v1/price/morphit-native/receipt`
is API-only. Could add a "[verify the price]" link near the USD echo,
opening a modal showing the contributing traders and tier breakdown.
Same risk as the H4 reputation-receipt UI button: cryptic data
overwhelming for casual users. **Estimate**: medium-high. **Priority**:
T3.

**T2.3 — Disagreement banner.** When the disagreement monitor fires
an alert (morphit_native vs Klingex/Coingecko sustained 25% off),
operators see it in logs and `/v1/health`. Grandma sees nothing. A
small ambient warning ("Price uncertainty: indexer sources disagree;
verify before large trades") could help — but it's also alarming and
might cause more confusion than benefit on small-discrepancy days.
**Estimate**: low for the technical work, high for getting the UX
right. **Priority**: T3 pending user feedback.

**T2.4 — Stablecoin-depeg banner.** When the cross-stablecoin depeg
detector flags a stablecoin as off-peg, currently only operators see
it. A small "USDC currently trading 5% off peg on Morphit" banner on
stablecoin order pages could be useful — but rare-event UX is hard
to get right and "depegged" might be alarming to non-crypto-native
readers. **Estimate**: low-medium. **Priority**: T3.

### What's deliberately NOT being added (per Ken's priorities)

- **No oracle-style API export of morphit_native.** The NOT-AN-ORACLE
  warning is loud everywhere because Morphit's native price is for
  display only — making it usable as an oracle would create
  manipulation incentives we don't want. Other systems wanting a BLURT
  price oracle should source from elsewhere or build their own
  derivation with their own threat model.
- **No "what price should I set?" suggestion in the order form.**
  Suggesting prices would create herd behavior that drifts away from
  market reality. Traders set their own prices based on whatever
  reference they want; Morphit displays what they posted.
- **No auto-correction when sources disagree.** Auto-correction
  introduces a separate attack vector (manipulate the input that gets
  promoted). Disagreement is surfaced; operators decide what to do.

### Why this is good for grandma even though she'll never see it

Self-sovereign pricing means: when Klingex eventually shuts down (or
gets regulator-frozen, or rate-limits us), the USD echo on grandma's
screen doesn't suddenly drift to $0.002 (the static fallback). It
keeps tracking reality based on what's actually traded. Grandma
won't notice the day Klingex disappears — and that's exactly the
point.

---

## Update — cp128 (operator-configurable denomination fiat + BRICS Pay payment method)

cp128 added two changes that affect grandma in different ways: a
backend rename + denomination-configurable display unit (largely
invisible to her), and a new payment method she might see in
pickers (BRICS Pay).

### Part 1 — Denomination fiat configurability: invisible if operator keeps USD; minor visible change if not

The listing-fee API rename (`base_fee_usd` → `base_fee_fiat`,
`blurt_price_usd` → `blurt_price_fiat`, new `denomination_fiat`
companion field) is purely a backend cleanup. From grandma's
perspective on a default-USD instance, the UI still shows
"60 BLURT (~$0.12)" exactly as before.

On a non-USD instance (operator set `MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT=EUR`,
for instance), grandma sees "60 BLURT (~€0.11)" instead. The
symbol changes, the locale-appropriate decimal separator applies,
the amount is in the configured unit. This is what we want — she
sees pricing in her market's currency without thinking about it.

### Part 2 — BRICS Pay shows up in payment-method pickers

cp128 added BRICS Pay to the curated payment-method registry. On
instances serving BRICS+ markets (Brazil, Russia, India, China,
South Africa, Indonesia, Saudi Arabia, etc.), users will see
"BRICS Pay" as an option in the same dropdown as PayPal, Alipay,
Cash App, GCash, etc. The description in their locale explains
what it is briefly (cross-border payment rail connecting national
systems like Pix, UPI, UnionPay, PayShap, SPFS, CIPS).

Risk for grandma: she might pick BRICS Pay without knowing what
it is. Mitigation: the description in the locale string explains
it in one sentence. Same risk applies to any payment method
she's unfamiliar with — the mitigation is consistent across the
registry.

### T2/T3 backlog from cp128

**T2.1 — Per-instance denomination disclosure.** A user on an
EUR-denominated instance might want to know "wait, why are prices
in EUR here instead of USD?" Could add a small chip near the
listing-fee echo: "Pricing displayed in {denomination_fiat}.
Operator-configured." Risk: extra UI noise for grandma. **Estimate**:
low. **Priority**: T3 pending user feedback.

**T2.2 — Denomination-aware WAIVER_MIN_BLURT hint.** Today the
hint says "Minimum for the waiver: 500 BLURT (~$1 USD at current
price)." On a non-USD instance this mixes units in the user's
head. Fix: interpolate the operator's `denomination_fiat` into
the hint. **Estimate**: 30 min — 10 locale strings + one form-
validation message. **Priority**: T2 (low impact, easy fix, polish
item — bundle with cp129).

**T2.3 — BRICS Pay onboarding tooltip.** When a user picks BRICS
Pay for the first time, could show a one-time info modal
explaining what it is and which BRICS+ countries it works in.
Risk: yet another modal. **Estimate**: medium. **Priority**: T3 if
user feedback indicates confusion.

**T2.4 — Cross-instance denomination disagreement awareness.**
A federation where some instances are USD-denominated and others
are EUR-denominated means the "same" BLURT amount displays
differently across instances. Could add a per-instance footer
showing which denomination this instance uses, helping users
who hop between instances understand why prices look different.
**Estimate**: low. **Priority**: T3.

### What's deliberately NOT being added (per Ken's priorities)

- **No automatic denomination conversion in the UI.**  The
  indexer's `denomination_fiat` is what it is; if you're on an
  EUR instance and want to see USD, switch to a USD instance.
  Adding "convert to my preferred fiat" client-side would
  require a USD/EUR external rate, which defeats the
  self-sovereignty point.
- **No "all denominations shown simultaneously" UI.**  Cluttered;
  defeats the per-operator-sovereignty point.
- **No BRICS Pay-specific UX flow.**  Treated like any other
  online payment method.  Operator-extensibility means we don't
  privilege specific rails.

### Why this is good for grandma even though she barely notices

Operator sovereignty means: when grandma's regional operator decides
to switch their instance from USD to EUR (or BRL, or XAU during a
currency crisis), grandma's UI adapts automatically. She doesn't
have to know what changed; the prices just start showing in the
unit her operator chose. Same orderbook, same trades, same chat —
just a different display unit. The operator absorbed the configuration
work; grandma just sees prices in her market's currency.

For BRICS Pay specifically: grandma in São Paulo or Bangalore or
Cape Town will increasingly encounter sellers who accept BRICS Pay
alongside their national payment systems (Pix, UPI, etc.). Having
it in the registry means picking it is a normal interaction, not
an "Other" free-text field. The discovery happens through the
payment-method picker, naturally, with the locale string explaining
it.

---

## Update — cp129 (item #1: WAIVER_MIN i18n key polish; item #4: Defense F peer-disagreement detector)

### Item #1 — invisible to grandma

The i18n key rename `waiver_min_usd_required` →
`waiver_min_required` is a backend identifier change. The actual
error message grandma sees is unchanged ("The waiver requires a
minimum order size. Set the amount to at least the floor shown
above."). No visible effect.

### Item #4 — Defense F is operator-side, fully invisible to grandma

The cross-instance peer-disagreement detector is a monitor that
runs in the operator's indexer and writes to operator logs. There
is NO user-facing surface in cp129 itself. Grandma sees nothing
new. If her operator's indexer gets compromised and Defense F
fires an alert, the operator investigates; either it gets fixed
(grandma sees nothing) or the operator pauses pricing (grandma
might see "(~$0.12)" disappear, falling back to BLURT-only
display — degrades gracefully).

### T2/T3 backlog from cp129

**T2.1 — `/v1/health` surface for peer-disagreement state.**
Today the cp129 alert is log-only. Adding a field to
`/v1/health` like `peer_price_disagreement.active: true` (with
timestamp + deviation magnitude) would surface the alert to
users who check the instance's health endpoint — and to power-
users who decide to switch instances based on it. Risk: grandma
hits `/v1/health`, sees a scary field, panics. Mitigation:
keep the field name technical (`peer_price_disagreement_active`
not `your_operator_might_be_lying`). **Estimate**: low-medium.
**Priority**: T2 — closes a UX gap. Likely cp130 or cp131.

**T2.2 — Weighted peer median by federation-prober score.**
Today all peers count equally in the median. A more
sophisticated design would weight peers by their age in the
federation, trade volume, or last-probe-status track record.
Trade-off: complexity for slightly better Sybil resistance. The
cp129 equal-weight design is simpler and already requires
majority compromise to manipulate. **Priority**: T3 unless a
real attack pattern emerges that exploits equal-weighting.

**T2.3 — Tor + I2P + Lokinet peer-query support.** Today the
peer query uses `fetch()`, which goes over clearnet. A peer
that's reachable ONLY via Tor isn't queried — they show up in
the federation directory but Defense F can't sample them. Fix:
plumb the SOCKS proxy used by the federation prober for alt-
network peers into peerPriceMonitor.ts's fetcher. **Estimate**:
medium — touching network code. **Priority**: T2 — actual
operators in privacy-focused jurisdictions need this. Likely
cp131+.

### What's deliberately NOT being added

- **No /v1/health alert field for users in cp129.** The
  operator-side log surface is sufficient for the initial
  defense; adding a public-facing alert risks user confusion
  on a defense that's still being tuned. Surface later (T2.1).
- **No automatic price-source switchover on alert.** If
  Defense F detects my indexer is wrong, the answer is "alert
  the operator" not "auto-switch to peer median." Auto-
  switchover creates a new attack vector (manipulate the
  switchover to feed bad data). Operators investigate and
  decide.
- **No mandatory peer-disagreement check.** Defense F is opt-in
  via env var. Operators with fewer than 3 peers reachable
  shouldn't run it; the monitor degrades silently anyway.

### Why this is good for grandma even though she doesn't see it

Defense F is the last in the cp127 8-defense table. With it
shipped, the morphit_native price-source architecture is
maximally defensive against the realistic attack classes:
trader-level manipulation (Defenses A-E + G + H from cp127),
external-source compromise (Defense C from cp127), and now
operator/indexer-level compromise (Defense F from cp129). All
the manipulation surfaces have a defense. Grandma trades against
a price display backed by 8 specific defenses, none of which
are visible to her — they just work.

---

## Update — cp130 (item #5: wire morphit_native for BTC/USD + XMR/USD)

### Mostly invisible to grandma, but unlocks future UI

cp130 wires the cp127 morphit_native price source for BTC and
XMR (it was BLURT-only before). Grandma sees nothing change in
cp130 itself — there is no UI consumer of BTC/XMR prices yet.

But cp130 makes the receipt endpoint usable for BTC and XMR:
`GET /v1/price/morphit-native/receipt?asset=BTC` now returns a
real BTC/USD derivation that operators can inspect, debug, and
trust. This is foundation work for future grandma-facing
features (orderbook USD echo for non-BLURT assets, wallet
displays, etc.) — deferred indefinitely per Ken's "wrap here"
directive, but the backend is ready when someone picks it back
up.

### What grandma might one day see (if cp131+ ships)

If a future UI consumer of BTC/USD or XMR/USD prices ever ships
(e.g. "show USD-equivalent next to BTC orderbook rows"),
grandma would see something like:

  BTC seller: 0.05 BTC (~$3,250)

— with the "$3,250" coming from cp130's backend derivation. The
USD framing matches the cp128 denomination configurability, so
on a EUR-denominated instance she'd see "≈€3,050" instead.

### What's deliberately NOT being added

- **Per-asset denomination override (item #3)** — collapsed into
  "global denomination applies to all assets." An operator who
  sets `MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT=EUR` gets
  BLURT/EUR, BTC/EUR, XMR/EUR — coherent across the whole
  instance. The speculative use case (operator wants BTC in
  USD but BLURT in EUR) has no concrete request. Revisit only
  if a real operator asks.
- **EUR-pegged stablecoins (item #2)** — explicitly retired by
  Ken ("probably never"). Tier 2 (stablecoin-anchored
  morphit_native) on non-USD denominations effectively stays
  disabled in practice; documented honestly in ADR-0040.
- **USD-equivalent orderbook display (item #6)** — explicitly
  deferred by Ken ("some other day"). The backend is ready;
  the UI work is deferred indefinitely.
- **More external sources for BTC/XMR** — Coingecko + native +
  static is the chain. Kraken, CoinPaprika, Bitstamp are
  candidates if operators report Coingecko being too narrow,
  but each adds a privacy surface; defer until concrete demand.

### Why this is good for grandma even though she doesn't see it

The cp127 self-sovereign pricing architecture was always
designed to support any asset — not just BLURT. cp130 finally
exercises that generality. When some future operator builds a
wallet integration or alternate frontend that needs BTC/USD
prices on Morphit, the backend is already there. Architectural
debt avoided, not accumulated. Same property as cp128's
denomination configurability: shipped with no UI consumer at
the time, used by cp130's per-asset wiring later.
