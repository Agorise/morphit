# Phase 5 backlog

Items deferred during Phase 4 closeout, organized into the raw
working list for Phase 5 design discussion. This is NOT a plan
— it's the input to planning. Each item includes rough scope,
open questions, and dependencies so we can sub-phase cleanly.

> **2026-05-11 forward note (Part 120 audit):** This backlog
> dates from Phase 4 closeout.  Six of the eight items have
> since shipped:
>
> - **Item 1 (post-first-trade cross-post)** → ✅ shipped under
>   `SYNDICATION-CHECKPOINT.md` (Post A "I joined Morphit" +
>   Post B "I gave feedback" + ADR-0017 pre-broadcast preview).
> - **Item 2 (Morphit Blurt community)** → ✅ shipped; the
>   `@morphit` community lives at the Blurt account
>   `blurt-176570` and is the `parent_permlink` for cross-post
>   Post A.
> - **Item 3 (operator incentives)** → ✅ shipped as **ADR-0013**
>   (accepted + implemented 2026-05-02).  Registration, tag
>   claim, payout pipeline all in place.
> - **Item 4 (price feed)** → ✅ shipped.  Composite source
>   `Klingex → Coingecko → static_floor` at
>   `apps/indexer/src/indexer/priceSource.ts` (live APR
>   computed from chain DGP at `apps/web/src/lib/blurt/apr.ts`).
> - **Item 5 (featured-slot auction)** → ✅ shipped.  Indexer
>   handler at `apps/indexer/src/indexer/handlers/featureBid.ts`,
>   default 50 BLURT/hour with `MIN_HOURS = 6`.
> - **Item 6 (encrypted chat + reputation)** → ✅ shipped under
>   ADR-0015 + Phase 5d.  See CHAT-CRYPTO.md (X25519 +
>   ChaCha20-Poly1305 ECIES) + CHAT-UI-DESIGN.md.  Reputation
>   on profile pages + feedback flows.
>
> Items still open:
>
> - **Item 7 (full indexer → relay integration test harness)**
>   — design at INTEGRATION-TEST-HARNESS-DESIGN.md (Option C
>   ratified 2026-04-23); implementation pending a dev with a
>   local toolchain.
> - **Item 8 (Phase 4 loose ends)** — varies item-by-item; most
>   absorbed into the ongoing audit work (REVISIT-LIST.md).
>
> This file is preserved as a historical backlog snapshot;
> current open work is in REVISIT-LIST.md and PHASE-5-PLAN.md.

The high-level themes of Phase 5, based on what's on this list:
**ecosystem reach** (crossposting, community, operator incentives),
**production robustness** (price feeds, integration test
infrastructure), and **growth features** (featured-slot auction,
encrypted chat). Each theme is large enough to be its own
sub-phase if it lands first; whichever we pick first sets the
character of the phase.

---

## 1. Post-first-trade cross-post flow

**Idea:** When a user completes their first trade successfully,
offer to cross-post a short "trade completed on Morphit"
announcement to Blurt via their own posting key. This turns
the welcome-bonus event into a social signal, drives Blurt
discoverability, and gives the Morphit community a feed of
real activity.

The cross-post content is not a transaction record (that would
leak counterparty info) — it's a high-level "I just used
Morphit for the first time!" post template with optional
customization. The user opts in explicitly; default is off,
with the post scheduled to land about a minute after the
welcome bonus arrives so the feedback loop feels rewarding.

**Open design questions:**

- What's the post template? Copy it 10 times across locales.
  Suggestion: a title like "Traded on Morphit" plus a short
  body mentioning the trade went well, plus tags `#morphit
  #p2p #privacy`. No amounts, no counterparty names, no
  asset specificity unless the user toggles it on.
- Where's the UI? The natural place is on the feedback-submit
  confirmation screen — "Great, feedback submitted. Share
  your first trade on Blurt?" with preview + edit + post
  buttons. This requires a feedback-submit UI which DOES NOT
  YET EXIST as of Phase 4 close. Prerequisite work.
- Which posting-key flow? The user's Morphit session already
  has the posting key JIT-decrypted when they're active. A
  custom_json would need a fresh JIT-unlock unless we extend
  the LiveIdentity lifetime for "signed content you just
  authored." Leaning toward: require explicit password re-entry
  for the cross-post, since it's creating permanent public
  content under their name.
- Blurt community to post into? See item 2 below — we'd want
  to post into a dedicated community so it's not spam on
  users' main feeds. So this item depends on item 2.

**Dependencies:** item 2 (community), and new Phase 4c+ frontend
work for feedback-submit UI.

**Rough scope:** medium. Feedback UI + cross-post template UI
+ custom_json signing + 10-locale copy + analytics toggle. Maybe
2-3 weeks.

**Priority:** HIGH — this is the content marketing engine. Every
completed trade becomes a Morphit mention on Blurt. Without it,
Morphit's visibility on Blurt is a function of what its operators
post, not its users.

---

## 2. Morphit Blurt community creation

**Idea:** Create a Morphit-branded community on Blurt (via the
`create_community` or equivalent op). The cross-post flow (item
1) posts into it. Users browsing blurt.blog discover Morphit
through real trader posts there. Moderators of the community
can feature exceptionally well-written trade stories.

**Open design questions:**

- Community name? Suggestions: `morphit`, `morphit-p2p`,
  `morphit-community`. Blurt community names are URL slugs,
  so short and memorable matters.
- Moderator roster? At minimum one Agorise-controlled account.
  Plus 1-2 community-elected mods once there's activity to
  moderate.
- Community rules? Baseline: no counterparty shaming, no
  concrete dollar amounts, no scam accusations without
  evidence. Tone should be "share your experience" not
  "market report."
- How does Morphit the platform interact with it? The
  frontend could embed recent community posts on the
  homepage, or link prominently from the "completed trade"
  UI. Or stay hands-off and just let it exist.

**Dependencies:** none — can be created any time. But there's
no value in creating it before item 1 is ready.

**Rough scope:** small. One Blurt-side manual action (create
community, set rules, designate mods) + maybe a homepage tile
linking to it. 1-2 days of work.

**Priority:** MEDIUM — trivially small but blocks item 1.

---

## 3. Third-party node operator incentives

**Idea (carried from Phase 4 backlog item 1):** Financially
incentivize people to run their own Morphit VPS + indexer +
relay by giving them a fee-split on transactions that happen
through their frontend. One-time upfront fee to prevent throwaway
operators, then a recurring BLURT-denominated cut of fees from
orders posted via their instance.

**Open design questions:**

- How does an indexer identify which frontend a user came from?
  The fee transfer memo is `morphit-fee:<permlink>` — there's no
  operator tag. Options:
  (a) Add a `referrer` field in the `morphit_order_v1` payload.
      Indexer sums referred-volume per operator. Cleanest, but
      a new op version.
  (b) Use the memo: `morphit-fee:<permlink>:<op-tag>`. Cheaper
      to implement (no op version bump). But memos are in-
      the-clear, so a malicious operator could rewrite memos
      on user machines — not a real defense, but muddies
      accounting.
- Fee split mechanics — who pays out?
  (a) Automated: indexer runs a periodic "payout" pass that
      queues BLURT transfers to registered operators based on
      observed referral volume. Uses the existing relay queue.
      Cleanest; operator doesn't have to trust Morphit manually.
  (b) Manual monthly: spreadsheet + manual transfer. Worse
      optics, but avoids automation bugs with real money.
- How does an operator register? An `operator_register` op
  with their $50 fee transfer as a sibling? The fee goes to
  @morphit — we already have a handler pattern for that.
  The operator's account then shows up in a public registry
  (a new table) and their `op-tag` becomes live.
- What prevents tag squatting? First-come-first-served with
  moderator veto? Applications list visible so Agorise can
  revoke bad actors?
- What's the split percentage? 30%? 50%? Depends on how
  expensive running a node is.

**Dependencies:** affects ADR-0011 (fee routing) and requires
a new indexer handler + registry table. No dependencies on
other Phase 5 items.

**Rough scope:** large. New op + handler + registry + referral
counting + payout automation + operator registration UI + FAQ
entry + deploy docs. 4-6 weeks.

**Priority:** HIGH — this is the decentralization mechanism. If
we don't build it, Morphit stays a single-operator project.

---

## 4. Klingex / real price feed integration

**Status: scaffolding shipped, consumer wiring partial.**

Originally: replace the $0.002 BLURT-per-USD static fallback with
a real price feed.

**Shipped this sub-phase:**

- `apps/indexer/src/indexer/price/source.ts` — `BlurtPriceSource`
  interface with `current()` (synchronous, never-throws, always
  positive) + `currentDetailed()` (for observability via
  `/v1/health?verbose=1`).
- `apps/indexer/src/indexer/price/compositeSource.ts` — the
  `CompositeCachedPriceSource` with fallback chain, background
  refresh loop, clock + setInterval injection for tests, cache
  preservation across upstream failures, and a static-floor
  fallback for the no-upstream-ever-succeeded case.
- `apps/indexer/src/indexer/price/klingexFetcher.ts` — Klingex
  ticker fetcher. **⚠ API-shape caveat:** written against the
  inferred `/ticker/BLURT_USD` endpoint with defensive field
  detection. Operators on a fresh deploy must verify the URL +
  response shape against the current klingex.io docs before
  relying on it. A wrong endpoint causes silent fallback to
  Coingecko, not a crash.
- `apps/indexer/src/indexer/price/coingeckoFetcher.ts` — against
  the documented `/simple/price?ids=blurt&vs_currencies=usd`
  endpoint. Free-tier-compatible; paid-tier API key supported
  via `x-cg-pro-api-key` header.
- `apps/indexer/src/indexer/price/factory.ts` — three operator
  modes: `composite` (Klingex → Coingecko → floor), `klingex`
  (Klingex → floor, no Coingecko traffic), `static` (floor only;
  preserves Phase 3–4 behavior). Default is `static` so
  operators who haven't opted in keep the old behavior
  exactly.
- `apps/indexer/test/indexer/price/compositeSource.test.ts` —
  tests cover all baseline contracts, fallback chain, cache
  preservation, staleness, and lifecycle idempotency.
- Config additions: `MORPHIT_INDEXER_PRICE_MODE`,
  `MORPHIT_INDEXER_PRICE_REFRESH_INTERVAL_MS`,
  `MORPHIT_INDEXER_KLINGEX_BASE_URL`,
  `MORPHIT_INDEXER_COINGECKO_BASE_URL`,
  `MORPHIT_INDEXER_COINGECKO_API_KEY`.
- `main.ts` wires `createPriceSource()` before the Poller;
  `priceSource.start()` before HTTP; `priceSource.stop()` during
  shutdown.
- `/v1/listing-fee` endpoint now reads `priceSource.current()`
  instead of `config.blurtPriceUsd`.

**Pending (minor — no consumer-visible consistency gaps
remain):**

- Verify the Klingex endpoint URL against real klingex.io
  docs. Our fetcher uses a defensive field parser so a wrong
  URL just causes silent fallback to Coingecko — not a
  crash — but the ideal-path behavior depends on verifying
  the URL matches what Klingex actually serves.

**Shipped this sub-phase:**

- `OpContext.priceSource` plumbing through handler-contract,
  dispatcher, and Poller — the order handler now reads live
  price for fee verification so quote-time and verify-time
  both use the same `priceSource.current()` call. The
  `config.blurtPriceUsd` static floor is now only consulted
  when no upstream has ever served (absolute fallback).
  Single test helper (`test/testutils/context.ts`) updated;
  all existing handler tests pass unchanged.
- `/v1/health?verbose=1` now surfaces `diagnostics.price`
  with `blurt_usd`, `source` (klingex / coingecko /
  static_floor), `updated_at`, and `stale`. Test coverage
  added in `apps/indexer/test/api/health.test.ts`.
- OPERATIONS.md §13 "Responding to a stale BLURT/USD price
  feed" — diagnosis steps, curl commands for manual
  probing, immediate-mitigation procedure, and a list of
  don't-do-this anti-patterns.

---

## 5. Featured-slot auction

**Idea:** A way for active traders to pay (in BLURT) to have
their order surface at the top of the orderbook for a limited
time. This both generates revenue for the protocol and signals
trust (slots only go to accounts with strong feedback).

**Open design questions:**

- Auction mechanics: first-price sealed bid per time window,
  or Dutch auction with falling price over time, or just
  "pay N BLURT per hour to be featured"? Complexity vs fairness
  tradeoff.
- How many featured slots? Probably 1-3, visually distinct.
- Who can bid? Accounts with N positive feedback over Y days?
  Any account that's ever traded? Only accounts at a certain
  loyalty milestone? Restrictions prevent "rent-a-slot"
  manipulation.
- What does "featured" look like? A distinct card style, a
  "Featured" badge, a position above the normal orderbook
  sort. Design question.
- Where does the BLURT go? Into @morphit-fees like regular
  listing fees? Or into a burn pool? Or split with operators
  (see item 3)?

**Dependencies:** arguably item 3 (so featured-slot revenue
can be in the fee-split). If items 3 and 5 both ship, they
need to be designed together.

**Rough scope:** medium. New op + handler + bid tracking table
+ orderbook rendering changes + 10-locale copy. 3-4 weeks.

**Priority:** LOW — nice revenue feature, not a structural
requirement. Can wait.

---

## 6. Encrypted chat + reputation

**Idea:** End-to-end encrypted chat between trade counterparties
using per-message ECIES (X25519 ECDH key agreement +
ChaCha20-Poly1305-IETF AEAD), with the trade permlink as
the shared-context identifier.  Replaces the current
in-memory chat (which has no persistence + relies on the
unauthenticated websocket bridge).  Adds on-chain reputation
hooks so repeat counterparty interactions are tied to
cryptographic identity.

**Resolved design (per ADR-0015):**

- Cipher: per-message ECIES.  Each message generates a fresh
  X25519 ephemeral keypair on the sender side; ECDH against
  the recipient's chat pubkey gives a shared secret;
  per-message symmetric key derived via BLAKE2b with domain
  separation; ChaCha20-Poly1305-IETF for the AEAD.
  Implementation in `apps/web/src/lib/chat/crypto.ts`,
  ~200 lines of libsodium calls.
- Key derivation: chat-identity X25519 keypair derived
  deterministically from the Blurt posting private key via
  BLAKE2b-256 with the
  `morphit-chat-v1/identity/<account>` domain-separated
  label.  Public half published in a
  `morphit_chat_identity_v1` op.
- Message transport: `morphit_chat_v1` custom_json op carries
  `{ ciphertext, header: { ephemeralPub, nonce } }` plus
  plaintext metadata (sender, recipient, order_permlink).
  Indexer stores ciphertext only.
- Storage: on-chain only.  Operators only see ciphertext.
- Reputation integration: chain-anchored "verified-chat
  badge" (≥2 messages each side, ≥15min span, no recip
  flag) signaling that a real-looking conversation
  preceded the feedback being shown.

**Dependencies:** none strictly, but benefits from item 3
(operator incentives) being in place because chat message
storage is on-chain and adds load to operator-run nodes.

**Rough scope:** LARGE.  Crypto implementation (~200 lines),
op handlers, indexer endpoints, frontend chat UI, key
discovery, identity-publish flow, verified-chat-badge
indexer pass.  Approximately 3 months of work; landed as
its own sub-phase 5c.

---

## 7. Full indexer → relay integration test harness

**Idea:** Today the integration test harness in
`apps/indexer/test/integration/` only touches Postgres. For
Phase 4c we added a concurrent-write test (`loyalty.test.ts`)
that's the first new integration test since Phase 3. What's
missing is an end-to-end test that goes: mint ACT → create
account → verify signup dust arrives → post first order
(waived) → complete trade → verify welcome bonus arrives. This
would flush out misalignments between indexer, relay, and
actual Blurt chain behavior.

**Open design questions:**

- Blurt testnet or local Blurt instance? Testnet is real but
  might be flaky; local instance is reliable but another
  thing to operate.
- How is the chain seeded? A known-good Blurt block export +
  start from that block?
- Run cadence? CI every PR (expensive) or nightly only (cheap
  but you find breakages late)?
- Secret management? Test runs need a funded testnet account.
  Credentials in CI = security considerations.

**Dependencies:** none but would catch regressions in
everything else.

**Rough scope:** medium. Testnet setup + seed account + relay
bootstrap test + CI integration. 2-3 weeks.

**Priority:** MEDIUM — not user-facing, but prevents a whole
class of "works in dev, breaks in prod" regressions. Worth
shipping early in Phase 5 so all subsequent work benefits.

---

## 8. Phase 4 loose ends (small)

Small items that surfaced during Phase 4 and deserve tidying
up but aren't big enough to be their own phase item. If Phase
5 has any spare capacity, these get pulled in.

- **Structured logging.** Handlers currently do
  `console.log('[handler-name] ...')` with ad-hoc prefixes.
  A thin `logger.info({handler, signer, reason}, msg)` wrapper
  would make log search + metric extraction much easier.
- **Health endpoint verbose tests.** Shipped in
  `apps/indexer/test/api/health.test.ts`. Covers: baseline
  response shape, ok/degraded status boundary, lag clamping
  when indexed is ahead of head, cache-control header,
  diagnostics inclusion by config flag AND by `?verbose=1`
  query param, diagnostics omission by default, rejection of
  `?verbose` values other than "1", the full diagnostics
  object shape (last_error, last_error_at, started_at,
  explorers), null last_error_at when no error has occurred,
  and explorer diagnostics reflecting real CircuitBreaker
  state transitions (closed → open → tracking per-key
  independently). Uses fake Config + fake Poller with a real
  CircuitBreaker to exercise state transitions authentically
  without DB or chain dependencies.
- **XMR viewkey verification CLI.** Shipped at
  `apps/indexer/scripts/verify-xmr-viewkey.ts`. Three modes:
  `reachable` (explorer root URL returns 2xx), `tx <txid>`
  (fetch /api/outputs with operator's address+viewkey and
  check status=success — surfaces wrong-viewkey misconfig at
  deploy time instead of at first user fee verification),
  `health` (probes all configured explorers). Exit codes
  signal pass/fail/usage-error distinctly so systemd timers
  and CI can gate on the result. No DB or chain RPC required
  — pure HTTP check against public explorers.
- **Translation quality audit for Persian + Chinese.** Phase 4
  added 100+ strings across 10 locales. Auto-assistance was
  used; a native speaker pass over the Persian (`fa`) and
  Chinese (`zh-CN`, `zh-HK`) strings is worth its cost.
- **FAQ search scoring tweaks.** Shipped. The scorer in
  `apps/web/src/lib/utils/faqIndex.ts` now combines: (1)
  original full-phrase + prefix bonuses, (2) English-side
  synonym expansion (e.g. "safety" → security/safe/attack;
  "price" → fee/fees/cost; "KYC" → identity/verification),
  (3) stopword filtering for English queries so "how", "do",
  "a" don't dominate token scoring, (4) IDF-style rare-token
  weighting so specific terms beat generic ones, (5) length
  normalization to prevent long catch-all entries (like
  `vs_others` at 3.8k chars vs the ~900-char median) from
  firing on almost every query. Empirical smoke test against
  all 40 English entries: queries like "free", "safety",
  "price", "run a node", "lost my key", "bitcoin" now
  consistently surface the on-topic entry first. Test suite
  lives at `apps/web/src/lib/utils/faqIndex.test.ts`.
  Phase 5 content-side follow-up: add dedicated FAQ entries
  for high-frequency user terms that currently don't map
  to a single canonical entry (e.g. a standalone "Does
  Morphit require KYC?" entry rather than burying that
  answer inside `signup_requirements` + `what_is_morphit`).
- **`/rss/orderbook.xml` indexer endpoint.** Shipped in
  Phase 4+prep. `apps/indexer/src/api/rssOrderbook.ts` serves
  an RSS 2.0 feed of the 50 most recent live + fee-verified
  orders, 60s Cache-Control, rate-limited at the `list` tier.
  Phase 5 items: add per-asset feeds (`/rss/orderbook-btc.xml`,
  etc.) if subscriber demand materializes, move the
  frontendOrigin config out of `publicOrigin.replace()` into
  its own env var (`PUBLIC_MORPHIT_FRONTEND_ORIGIN`) when the
  first operator runs indexer + frontend on distinct origins.
- **`?nojs=1` server-side switch.** Deferred from Phase 4+prep
  to Phase 5. The existing architecture is prerender + hydrate
  globally, so disabling JS in the browser's own settings
  already yields the static HTML. A per-request switch that
  suppresses hydration requires moving from `export const
  prerender = true` (in `+layout.ts`) to per-request SSR, which
  is a larger architectural change than a Phase 4 wrap-up
  should carry. The footer pill now links to the FAQ entry
  `no_js_limits` that explains the current state honestly.
  Phase 5 task: implement the switch properly, either via an
  SSR-per-request flip or a separate `/nojs` path that serves
  a hydration-script-stripped variant of each page.
- **`rss_feeds` FAQ privacy nuance.** Shipped in Phase 4+prep.
  The previous "completely private" framing was replaced in
  all 10 locales with the honest version: the feed is trivial
  to aggregate passively, Blurt being public means no new
  information is exposed, mitigations (post via Tor, vary
  timing, rotate usernames) are spelled out. Phase 5 item:
  native-speaker QA of the rewritten FAQ copy in `fa`, `ru`,
  and the two Chinese locales.
- **Dark-mode-only confirmation.** Site now ships dark-only
  (Phase 4+prep). `class="dark"` is hard-set on `<html>` in
  `app.html`, and `color-scheme` is `dark` rather than
  `light dark`. The `dark:*` Tailwind utility classes are
  retained across the codebase as inert fallback — if a
  future phase wants to offer a user-toggleable theme, the
  light styles are already defined. Phase 5 task: decide
  whether to strip the `dark:` prefixes entirely (smaller
  bundle, cleaner markup) or keep them for reversibility.

**Priority:** opportunistic. Pull in as schedule allows.

---

## Phase 5 scaffolding landed (pre-ADR)

A shape-stable subset of Phase 5b and 5c has been landed ahead
of the ADR decisions, so that (a) the pieces that don't depend
on open questions don't wait unnecessarily, and (b) the pieces
that do have somewhere to land when the ADRs resolve.

**5b — operator incentives scaffolding:**
- Migration v7: `operators`, `operator_earnings`,
  `operator_registration_events` tables. Column set is
  policy-independent (who / when / how much); ADR-0013 Q1-Q6
  decisions land in an `extras` JSONB column or additional
  columns as needed, no future migration bump required for
  most answers.
- `/v1/operators` indexer endpoint. Returns active-first,
  most-recent-first. Empty response until registration op
  ships — no error state.
- `OperatorRecord`, `OperatorStats`, `OperatorsResponse`
  types in `@morphit/indexer-client`.
- `/operators` public directory page with loading /
  empty-state / populated renderings.
- `/run-a-node` landing page — motivations, 4-step setup,
  resource requirements, CTA to repo.
- Three new FAQ entries: `how_to_run_node`,
  `how_operators_earn`, `how_to_find_good_operator` — the
  earnings entry explicitly explains how revenue scales with
  BLURT price (earnings denominated in BLURT; BP milestones
  fixed quantity so BP's economic value rises with BLURT
  market cap; delegation earnings also denominated in BLURT).
  All 10 locales now carry native-prose translations with
  quoted-English preservation of "RC" and "Perfect Forward
  Secrecy". `fa`, `ru`, `zh-CN`, and
  `zh-HK` still want a native-speaker QA pass.
- Footer link to `/operators` added across all 10 locales.

**ADR-0013 partial decision locked this scaffolding pass:**
- **Q3 (fee split percentage): 50/50** — half to the
  operator who attracted the order, half to the Morphit
  treasury. Confirmed by Agorise. Cited directly in the
  `how_operators_earn` FAQ and the `run_a_node.why_earn_body`
  copy across all 10 locales. This value is treated as a
  governance parameter Agorise can adjust in later phases
  without requiring a new op version.

**Avatar-with-name rule (executed):**
Project policy locked this pass: every render site that shows
a Blurt account name or display name must also show that
user's identicon avatar. Enforced by centralizing all username
renders through the `IdentityLabel` component, which renders
the identicon unconditionally from the publicKey-if-present
or account-name-as-fallback seed. i18n strings that used to
interpolate `{account}` (e.g. "Trade with {account}") were
refactored to prefix-only form ("Trade with") so the account
slot can only be filled by a component. Rationale recorded at
the top of `IdentityLabel.svelte`.

**Still blocked on ADR-0013:**
- Registration op itself (`morphit_operator_register_v1`) —
  Q1 and Q5.
- Referrer tracking mechanism in `morphit_order_vN` payload
  — Q2.
- Payout automation vs manual — Q4.
- Retroactive credit for existing operators — Q6.

**Resolved Q3 (fee split):** DECIDED 2026-04-20 at 50/50.
Agorise approved; split is reversible via governance vote
in a future phase without requiring a new op version.
ADR-0013 Q3 section has been rewritten to record the
decision and reject the other options. The `how_operators_earn`
FAQ entry reflects 50/50 in all 10 locales; the
`/run-a-node` page's `why_earn_body` string does too.

**5c — encrypted chat scaffolding:**
- Migration v8: `chat_messages` ciphertext transport table
  with dedupe unique index.
- `apps/web/src/lib/chat/crypto.ts` — full per-message ECIES
  implementation per ADR-0015 (X25519 ECDH key agreement +
  ChaCha20-Poly1305-IETF AEAD with BLAKE2b-derived per-message
  keys, ~200 lines libsodium calls).
- Three new FAQ entries: `what_is_morphit_chat`,
  `chat_key_loss`, `why_chat_on_chain` — all 10 locales
  translated in native prose this turn. "RC" and "Perfect
  Forward Secrecy" preserved as quoted English across all
  non-en locales per project style.

**Still blocked on ADR-0014:**
- Sub-ADR on storage model (Q2) — pure on-chain vs hybrid.
  (Q1 — identity-key management — was resolved by ADR-0015:
  X25519 keypair derived deterministically from the Blurt
  posting private key via BLAKE2b-256 with domain separation.)
- `morphit_chat_identity_v1` and `morphit_chat_message_v1`
  ops themselves.
- Chat UI implementation (5c-M4).
- Reputation signals derived from chat data (5c-M5).
- Key-loss backup flow UI (5c-M6) — FAQ entry shipped, UI
  pending.

**Avatar-with-name rule:** `IdentityLabel.svelte` rewritten
to always render the heart-style identicon avatar alongside
any displayed username or display name. Works from either
`publicKey` (preferred, cryptographically-authoritative seed)
or `account` (fallback for pre-pubkey-fetch sites; account
name's UTF-8 bytes become the deterministic identicon seed).
Every existing call site — orderbook, settings, onboarding,
register-name, operators directory — picks up the avatar
automatically. When operator-owned profile avatars ship in
a future phase, this component becomes the single place to
layer them over the identicon fallback.

**Translation backlog from this scaffolding pass:**
Six new FAQ entries + two new page string blocks
(`operators.*`, `run_a_node.*`) were auto-translated into
all 10 locales this turn. Native-speaker QA pass needed
for `de`, `pl`, `fr`, `it`, `ru`, `fa`, `zh-CN`, `zh-HK` —
combine with the existing `fa`/`ru`/`zh-*` QA item rather
than tracking separately. English and Spanish are
maintainer-native.

---

## What Phase 5 is NOT going to include

To keep the scope honest:

- **No blockchain beyond Blurt.** We're not adding Ethereum,
  Solana, or any other chain. Morphit is a Blurt-anchored
  protocol by design.
- **No custody, no escrow.** Moving to a custodial model
  would defeat the architecture. P2P stays P2P.
- **No KYC.** Ever. This is non-negotiable per ADR-0001.
- **No mobile native apps.** The SvelteKit frontend works on
  mobile web; dedicated iOS/Android apps are out of scope
  and would require app-store review which compromises the
  "no takedown surface" property.
- **No in-protocol dispute resolution beyond feedback.** We
  are not building an arbitration layer. Reputation is
  chain-tracked; disputes that can't be resolved via the
  reputation signal are not Morphit's problem.

---

## Sub-phase proposal (rough)

Without committing to dates: three plausible sub-phases, each
ship-able independently.

**Phase 5a — ecosystem reach.** Items 2 (community), 1 (cross-
post), 4 (price feed), 8 (loose ends). Small/medium items
grouped for a quick release. Prerequisite: frontend feedback-
submit UI.

**Phase 5b — operator incentives.** Item 3. One big feature
in isolation — a substantial economic redesign that deserves
its own release.

**Phase 5c — encrypted chat.** Item 6. The biggest rock;
deserves a full sub-phase.

Item 5 (featured-slot auction) and item 7 (e2e test) are
flexible — can be pulled into any sub-phase or deferred
further.

---

## Timeline anchor

None. Phase 4 shipped ~Q2 2026. Phase 5 timing depends on:
- Feedback from Phase 4 deployment (what broke, what needs
  urgent follow-up)
- Team bandwidth
- Whether a specific item becomes urgent due to external
  pressure (e.g. a competitor shipping their own cross-chat
  would make item 6 urgent)

The next concrete action on this document is an ADR stub
pass on items 1, 3, and 6 (ADR-0012, 0013, 0014 respectively).
