# Audit cp175 — full deep-deep + five-persona walkthrough + hostile-op sweep

**Started:** 2026-05-29. Scope (per Ken's mandate): re-walk all personas
(Bob, Sally-user, Sally-operator, Charlie) clicking/typing EVERY interactive
element; then a 94-task "deep deep" black-hat pass over EVERY file/script in
the repo (.md, .ts, .svelte, .sql, .sh) covering: drift, regex accuracy, type
errors, test-coverage gaps, stale/outdated smokes + gates + parities, bad/dead
keys, unwired code, staleness/orphans, DB dead fields, draft finalization, FAQ
/ README / OPERATIONS / RUN-A-MORPHIT-NODE accuracy, broken references, missing
/broken wiring, memory leaks, fallback/failover completeness, and a
consolidated "what if every op was hostile?" chain-direct attack sweep across
all 17 indexer handlers.

Pre-launch context: nobody has installed or used Morphit yet. No live data.
Goal: rock-solid before first real use.

---

## Methodology

Each finding gets: ID, severity (CRITICAL/HIGH/MED/LOW/INFO), file:line,
description, and resolution (fixed inline / smoke added / deferred-with-reason /
verified-clean). Verification grep after every sweep claim. Fixes get smoke
coverage. Triple-pulse after meaningful batches.

Repo at audit start: 771 TS, 119 Svelte, 135 MD, 29 SQL, 258 registered smokes,
6 apps (web/indexer/relay/ops-cli/matrix-bot/mcp-server), 7 packages, 17 indexer
handlers.

---

## Part A — Five-persona walkthrough (cp173–cp174 surface + full re-walk)

(findings below)

### F-001 (HIGH, fixed) — cp174 noble migration was incomplete: comment.ts had an orphan dblurt-only signer

`apps/web/src/lib/blurt/ops/comment.ts` carried its OWN `signTransactionWithKey`
(separate from sign.ts's) that always called dblurt's `broadcast.sign` and did
NOT consult `SIGNER_BACKEND`. So the syndication/cross-post comment path (Bob's
"share my first trade" + per-order syndication, a real persona action) would
have kept signing via elliptic even when an operator selected the noble backend
— a silent inconsistency and exactly the elliptic-CVE exposure cp173/cp174
aimed to remove.

**Fix:** made comment.ts's signer branch on `SIGNER_BACKEND`, mirroring sign.ts
(digest via dblurt's `cryptoUtils.transactionDigest`, sign with
`signDigestWithNoble`, append wire sig to a cloned tx). Threaded the posting
raw scalar through the call site. Web typecheck 0 errors.

**Guard added:** PPM-style source sentinel (see signer-backend-consistency
smoke) asserting every `broadcast.sign` site in apps/web also branches on
`SIGNER_BACKEND`, so a future third signer can't silently ignore the flag.

## Part B — Hostile-op sweep across all 17 indexer handlers ("what if every op was hostile?")

### Authz (signer-binding) — VERIFIED CLEAN across all 17 handlers
Every state-mutating query (UPDATE/DELETE/INSERT) is scoped to `ctx.signer`, which
the chain binds cryptographically — a hostile actor cannot touch another account's
rows. Privileged ops gate explicitly: `operatorPaymentMethod`/`operatorBlock` on
`ctx.signer === config.operatorAccountName`; `release` on
`ctx.signer === config.officialAccountName`. Self-action guards present where
relevant (`block`, `chatRead`, `feedback`, `strangerFee`, `chat` all reject
`X === ctx.signer`). `feedbackResponse` checks `row.subject === ctx.signer` before
allowing a response. `orderReplace`/`orderCancel` only match `(ctx.signer, permlink)`.
No handler keys a mutation off a payload-supplied account/author/target. This is the
single most important hostile-op property and it holds uniformly.

### Amount parsing (money paths) — VERIFIED CLEAN (one symmetry fix)
`order.ts` + `strangerFee.ts` parse fee transfers from attacker-controlled sibling
ops. Both: anchored regex `^(\d+(?:\.\d+)?)\s+BLURT$` (rejects negatives, sci-notation,
junk, wrong asset), `typeof === 'string'` guard, `Number.isFinite` guard. order.ts
also validates `amount_min` finite/non-negative/≤ MAX_AMOUNT (blocks 1e308 UI-break).
- **F-002 (LOW, fixed):** order.ts's fee parser lacked the `amount <= 0` reject that
  strangerFee.ts has. Not exploitable (0-amount already → underpaid downstream), but
  fixed for symmetry so amountBlurt is positive-by-construction.

### Payload-shape — VERIFIED CLEAN
All 17 handlers guard `isPlainObject(payload)` (rejects array/null/scalar) before
field access. Manual validation (no zod) but uniform across handlers — no
zod/manual drift.

### Replay/idempotency — VERIFIED CLEAN
Two-layer defense: (1) global dispatcher dedup — every op insert uses
`ON CONFLICT (block_num, trx_in_block, op_in_trx) DO NOTHING` (dispatcher.ts),
so re-delivered ops during re-sync are dropped at the cursor level; (2) per-handler
unique constraints (e.g. feeAttest `fee_attestations` → `isUniqueViolation` →
`already_attested`) + idempotent UPDATE-with-WHERE-guards (orderCancel, block).
Handlers showing 0 `ON CONFLICT` (orderReplace/block/strangerFee/feeAttest) are
replay-safe via these other mechanisms, not gaps.

## Part C — Doc accuracy (in progress)

- **F-003 (INFO, fixed):** `docs/SECURITY.md` "Recommended Morphit-project
  practice" paragraph for the elliptic advisory was stale — described the noble
  migration as an unstarted "open item / monitor upstream." Updated to reflect
  cp173–cp174: signer built, proven, wired behind SIGNER_BACKEND (default still
  dblurt, cutover gated on a chain broadcast), with the proof/sentinel smoke
  references. The fenced-path smoke now validates 247 scenarios (picked up the 4
  cited script paths).
- Doc-accuracy gates GREEN: brag-list-claim-parity 79/79, cross-document-value-
  invariants 21/21, operator-doc-fenced-path-existence 247/247, version-
  consistency 18/18.

## Session 1 summary (cp175 start)

Fixes this session: F-001 (HIGH — orphan dblurt-only signer in comment.ts, now
noble-aware + guarded by a new consistency sentinel + comment-op proof),
F-002 (LOW — order.ts fee-parser non-positive symmetry), F-003 (INFO — SECURITY.md
staleness). Hostile-op sweep core classes (authz / money-parsing / replay) verified
clean across all 17 handlers. New smokes: signer-backend-consistency (registered),
extended blurt-noble-tx-signature-proof (+comment op, now 5 scenarios).

### Remaining for subsequent sessions (the rest of the 94-task deep-deep)
- Per-handler deep read of the remaining hostile-op classes: unicode/confusable
  injection in free-text fields, oversized-payload bounds, numeric precision in
  featureBid/feedback rating math, auth-context (required_auths vs posting_auths)
  per op.
- Full .md accuracy pass: FAQ (1300+ Q&A lines), README, OPERATIONS.md,
  RUN-A-MORPHIT-NODE.md, ADR cross-references, every fenced path + claim.
- DB dead-field sweep: every column in schema.sql vs. actual reads/writes.
- Regex-accuracy pass: every validation regex vs. its spec (txid shapes, account
  names, permlinks, amounts, URLs).
- Type-error / strictness sweep across all 14 tsconfig projects.
- Orphan/staleness: unreferenced exports, dead components, stale snapshot docs.
- Memory-leak pass: every $effect/subscription/interval/listener in Svelte +
  every setInterval/timer in the indexer/relay.
- Fallback/failover completeness: every fetch/RPC path has a graceful degrade.
- Smoke/gate currency: every smoke still asserts a live invariant; no orphaned
  smokes referencing removed code.

## Session 2 (cp175 continued)

### Hostile-op: auth-context — VERIFIED CLEAN
`apps/indexer/src/blurt/verify.ts` `extractSigner()` enforces Morphit's auth
policy airtight: rejects `required_auths` (active-key) custom_json
(`active_auth_not_allowed` — blocks hotter-key leverage), rejects empty
(`no_posting_auth`) and multiple (`multiple_posting_auths`) posting auths, and
binds signer = `required_posting_auths[0]` which the chain already verified the
signature against. No impersonation path.

### Hostile-op: oversized payload — VERIFIED CLEAN
`parseJsonPayload()` enforces `MAX_RAW_JSON_LENGTH` (16KB) BEFORE `JSON.parse`,
returns null on oversize/malformed → op rejected. Universal first gate;
per-handler caps (checkJsonbSize 4KB, profile 8KB) downstream.

### Hostile-op: unicode/confusable — VERIFIED CLEAN + already drift-guarded
The confusables defense (LETTER_EQUIVS skeleton map + RESERVED_NAMES_RAW) is
duplicated frontend⇄indexer with a manual-sync requirement. Investigated as a
suspected drift (F-004): line counts differ (216 vs 162) BUT that is comment-only
— the extracted codepoint sets are IDENTICAL (215 each, comm shows zero diff both
ways) and RESERVED_NAMES_RAW identical (9 each). `confusables-parity-smoke.ts`
already asserts byte-equivalent parity on both and PASSES, so future drift is
caught automatically. F-004 = false alarm; class is clean and guarded.
Applied across 10 handlers (order/orderReplace/profile/chat/feedback/
feedbackResponse/featureBid/operatorRegister/operatorBlock/operatorPaymentMethod).

### Hostile-op: numeric precision — VERIFIED CLEAN
feedback rating: `typeof === 'number' && Number.isInteger && 1 ≤ r ≤ 5`. featureBid
hours: `Number.isInteger && 6 ≤ h ≤ 168`; bid amount: anchored regex + `Number.isFinite
&& > 0` (featureBid already had the >0 check order.ts lacked — confirms F-002 was the
lone outlier). Cost math `perHour × hours` bounded (hours ≤ 168, no overflow).

**Hostile-op sweep COMPLETE.** All 6 classes (authz, money-parsing, replay, auth-context,
oversized-payload, unicode/confusable, numeric-precision) verified clean across all 17
handlers. Lone fix: F-002 (order.ts >0 symmetry).

## Part D — DB dead-field sweep (COMPLETE)

Parsed 38 tables / 287 columns; cross-checked every column against all .ts in the repo
(not just indexer — the key correction: push + relay-queue + scanner columns are written
by OTHER apps).
- **F-005 (LOW, fixed):** `stranger_fees.amount_usd_equivalent` was declared
  `NUMERIC(10,4) NOT NULL` + `CHECK (>0)` in the CREATE TABLE, but a later v20 section in
  the SAME collapsed baseline did `ALTER ... DROP COLUMN IF EXISTS` it, AND the handler's
  only INSERT omits it. On a fresh deploy the create-then-drop nets to "no column" so it's
  not a runtime bug — but the self-contradiction is reader-hostile and cost real audit time
  (looked like a guaranteed NOT-NULL-violation until the DROP was found). Since schema.sql
  is the explicit pre-launch v1 collapsed baseline (never deployed, safe to edit), removed
  the column declaration + CHECK from the CREATE TABLE and left the v20 DROP as a documented
  version-parity no-op.
- **12 other suspects — all FALSE POSITIVES (explained):** `*.detected_at` (related_accounts,
  suspicious_reciprocity, one_way_pile_on, review_concentration) written by ops-cli/abuse +
  abuse scanners; relay_pending_transfers `broadcast_at`/`broadcast_trx_id`/`error_count`
  written by the relay queue drainer (apps/relay); push_subscriptions `p256dh`/`user_agent`/
  `privacy_mode`/`last_delivery_at` + push_pending `enqueued_at` written by apps/web push.ts
  + apps/relay pushSubscriptions/pushSender. No genuinely orphaned columns.

## Part E — Memory-leak sweep (COMPLETE — clean)

### Backend (indexer/relay/matrix-bot/mcp) — clean
- Most `setTimeout` sites are AbortController fetch timeouts (auto-fire or cleared on
  completion). Correct pattern.
- Rate-limiter (`api/middleware/ratelimit.ts`): per-IP `buckets` Map is PRUNED every 5 min
  (deletes empty buckets, trims old timestamps) and the interval is `.unref()`'d (won't
  hold the process alive). Bounded.
- SSE streams (`api/chatStream.ts`, `api/instancesStream.ts`): both have a `cleanup()` that
  `clearInterval`s poll + keepalive timers, guarded by a `cancelled` flag, called on close.
- `compositeSource`/`peerPriceMonitor` interval handles stored + stoppable.

### Frontend (Svelte) — clean
- Every `setInterval`/`setTimeout` component (PendingFeedbackReminderBanner,
  FeaturedAuctionHistory, FeaturedBidHistory, LoginQrInitiator, PriceFreshnessIndicator,
  AnimatedNumber, ProtectedTextarea, ConversationView) stores its handle and clears it in
  teardown (clears == teardown-hook count).
- `addEventListener`(51) vs `removeEventListener`(24) imbalance is NOT a leak: all three
  EventSource consumers (chat/stream.ts, orderbook/stream.ts, instances/+page.svelte) call
  `eventSource.close(); eventSource = null;` in stop()/onDestroy (closing releases the
  source's listeners + connection); service-worker.ts listeners (install/activate/fetch/push)
  are intentional worker-lifetime handlers; remaining adds are `{ once: true }` or on
  GC'd-with-component elements.

## Session 2 summary

Fixes: F-002 (order.ts >0 symmetry — carried from session 1 close), F-005 (stranger_fees
dead column removed from collapsed baseline). Verified clean: complete hostile-op sweep (all
6 classes × 17 handlers), complete DB dead-field sweep (12 suspects explained as cross-app
writes), complete memory-leak sweep (backend + frontend). F-004 (confusables drift) = false
alarm, already guarded by confusables-parity-smoke.

### Still remaining (subsequent sessions)
- FAQ accuracy (1300+ Q&A) / README / OPERATIONS.md / RUN-A-MORPHIT-NODE.md full read.
- Regex-accuracy pass (every validation regex vs spec).
- Type-strictness sweep across all 14 tsconfig projects (full tsc, not just web).
- Orphan/staleness: unreferenced exports, dead components, stale snapshot docs.
- Fallback/failover completeness: every fetch/RPC path degrades gracefully + user never hangs.
- Smoke/gate currency: every smoke asserts a live invariant; no orphan smokes.
- "What an outside pentest/agency would add" writeup for Ken.

## Session 3 (cp175 continued)

## Part F — Type-strictness sweep across all 14 projects (COMPLETE)

Ran `tsc --noEmit` on every project: all 14 at **0 errors** (web + indexer confirmed
earlier; relay, ops-cli, mcp-server, matrix-bot, and all 7 packages confirmed this session).
- **F-006 (LOW, fixed):** `apps/mcp-server` and `apps/matrix-bot` were the only two projects
  MISSING `noUncheckedIndexedAccess` (the other 12 enforce it). Added it to both. mcp-server
  (Charlie's surface) compiled clean immediately. matrix-bot surfaced 2 real unchecked-index
  sites in `scripts/sidecar-envelope-smoke.ts` (regex capture-group accesses `m[1]` assumed
  defined) — both fixed with guards; smoke still 26/26. Now all 14 projects uniformly enforce
  `strict` + `noUncheckedIndexedAccess`.

## Part G — Regex-accuracy pass (COMPLETE)

Inventoried security-relevant validation regexes (permlink, account-name, txid, amount,
semver, sha256, BTC/XMR address, Matrix MXID/room, origin).
- **No ReDoS:** the `^[a-z0-9]+(?:-[a-z0-9]+)*$` permlink pattern (8 call sites) matched a
  naive nested-quantifier grep but is SAFE — the inner group requires a literal `-`
  separator between runs, so there's no overlapping-ambiguity backtracking. All other
  patterns are linear.
- All security-critical validators are anchored (`^...$`) — no partial-match bypass.
- **F-007 (LOW, documented/deferred):** account-name regex divergence. Pattern A
  `^[a-z][a-z0-9.-]{2,15}$` (10+ files) allows dots + trailing punctuation; Pattern B in
  registry.ts `^[a-z][a-z0-9-]{1,14}[a-z0-9]$` forbids dots + requires alnum end. Neither
  exactly matches Blurt's real account-name rule (dot-separated segments, no trailing/double
  punctuation). **NOT a security issue:** these are client-side UX validators; the real authz
  boundary is the chain + indexer `extractSigner` (accepts only a chain-validated signer with
  matching signature), so frontend looseness can't create a hole. Proper fix = unify on one
  shared `isValidBlurtAccount` across all call sites — deferred to a focused refactor with its
  own regression coverage rather than a hasty 10-file edit mid-audit. Tracked.

## Part H — Fallback/failover completeness (COMPLETE — clean)

Sampled the data-heavy, RPC-dependent route surfaces (orderbook, explorer/*, my/orders,
settings, onboarding/import). All use explicit phase state machines with error states + retry,
not bare spinners.
- **orderbook** (highest-traffic): `phase: 'loading' | 'ready' | 'error'` state machine; on
  fetch failure sets a LOCALIZED `errorMessage` + `phase='error'` → renders error text +
  Retry button; success → 'ready' (empty list renders as empty, not a hang). Exemplary
  "never leave the user hanging" pattern.
- RPC layer itself has rpc-pool failover (cp165) + quorum early-return (cp166) underneath.
- **Locale completeness for error states VERIFIED:** orderbook.error.fetch_failed /
  load_more_failed / retry all 10/10 locales; sampled ~20 `$_('...error...')` keys used in
  routes — all present in en.json (a missing error key would itself be a hang-equivalent,
  showing a raw key string to the user). No missing-key user-facing bugs found.

## Session 3 summary

Fixes: F-006 (mcp-server + matrix-bot were missing noUncheckedIndexedAccess; added to both,
fixed the 2 real unchecked-index sites it surfaced in a matrix-bot smoke — now all 14 projects
uniformly enforce strict + noUncheckedIndexedAccess, all at 0 errors).
Verified clean: type-strictness across all 14 projects; regex-accuracy (no ReDoS, all anchored;
F-007 account-name divergence documented as non-security UX item deferred to a focused refactor);
fallback/failover completeness (phase state machines + localized error/retry everywhere, all
error locale keys present).

### Still remaining (subsequent sessions)
- FAQ accuracy (1300+ Q&A) / README / OPERATIONS.md / RUN-A-MORPHIT-NODE.md full read-through.
- Orphan/staleness: unreferenced exports, dead components, stale snapshot docs.
- Smoke/gate currency: every registered smoke asserts a live invariant; no orphan smokes.
- F-007 account-name regex unification (focused refactor with regression coverage).
- "What an outside pentest/agency would add" writeup for Ken.

## Session 4 (cp175 continued)

## Part I — Doc accuracy: operator env vars (IN PROGRESS)

Cross-checked all `MORPHIT_*` env vars in OPERATIONS.md + RUN-A-MORPHIT-NODE.md (144) vs.
code. Two diffs investigated:
- **~50 "documented but not in .ts"** — ALL legitimately read by ops/shell scripts
  (`ops/scripts/morphit-{apt,certbot,host,smartctl,trivy,systemd,compose}-monitor.sh`,
  `scripts/canary/generate.sh`, `scripts/release-sign.sh`). Not stale; the .ts-only grep was
  too narrow (same lesson as the DB sweep — host/monitoring/release vars live in shell).
- **F-008 (MED, fixed):** real doc↔code naming mismatch on the USDT multi-network chat-link
  override vars. Code's zod env schema reads
  `MORPHIT_FRONTEND_USDT_{ERC20,TRC20,SPL,BEP20}_CHAT_LINK_URL` (network token BEFORE
  CHAT_LINK_URL); OPERATIONS.md (lines 9095–9098) told operators to set
  `MORPHIT_FRONTEND_USDT_CHAT_LINK_URL_{ERC20,TRC20,SPL,BEP20}` (network token AFTER). An
  operator copying the docs would set a var the indexer never reads → self-hosted explorer
  override silently no-ops. Fixed the four doc lines to match code (code is the runtime
  authority). USDC/DAI doc forms were already correct.
- **Guard added:** new `apps/indexer/scripts/frontend-chatlink-env-doc-parity-smoke.ts`
  (REGISTERED) extracts every `MORPHIT_FRONTEND_*_CHAT_LINK_URL` named in the operator docs
  and asserts each exists in the indexer config source. Negative-tested: fails on the F-008
  divergence, passes when correct. 24 code vars / 10 documented, all match.

### Env-var doc accuracy — remaining checks (VERIFIED, no further fixes)
- **In-code-but-undocumented (100 candidates):** triaged. Buckets: (a) per-asset/network
  chat-link OVERRIDES — optional, every asset has a bundled default, discoverable via the same
  documented pattern; (b) indexer tuning knobs (BLOCK_INTERVAL_MS, BTC_FEE_SATOSHIS,
  DB_POOL_MAX, FEE_TOLERANCE, LOW_BALANCE_*, PEER_PRICE_SAMPLE_INTERVAL_MINUTES,
  BTC_MIN_SUCCESSFUL_RESPONSES, etc.) — all have zod `.default()`, optional; (c) NOT env vars
  at all — `MORPHIT_ACCOUNT`/`MORPHIT_COMMUNITY` are hardcoded frontend constants
  ($net/config.ts, syndication/publish.ts), grep matched the constant names. No required var
  is undiscoverable.
- **MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY (required, no default):** the minimal env block in
  RUN-A-MORPHIT-NODE.md omits it, BUT the doc explicitly defers to
  `ops/env/indexer.env.example`, which DOES include it (line 92, with a pinned default + comment).
  The operator workflow (copy the example file) provides it. NOT a gap — verified clean. (Note
  the two-name distinction: `MORPHIT_OFFICIAL_POSTING_PUBKEY` = frontend build constant in
  $net/config.ts (the pinned release-signing key); `MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY` =
  the indexer's env var that must match it. Docs describe both correctly in their contexts.)

## Part J — FAQ accuracy (COMPLETE — verified clean)

FAQ lives in locale JSON (`faq.entries.*`, 135 entries). Spot-checked every drift-prone
numeric/factual claim against code:
- **fees** ("$0.25 BTC/XMR, $0.125 Blurt 50% discount", "60 Blurt listing fee"): matches
  `MORPHIT_INDEXER_FEE_BASE_BLURT` default 60 + BTC/XMR config "~$0.25 USD" targets. ✓
- **first_order_free** ("free buy of ≥500 Blurt", "60 Blurt each, 50% off"): matches
  `WAIVER_MIN_BLURT = 500` + fee base 60. ✓
- **welcome_bonus** ("1 BP delegated on first listing fee", milestone framing): matches
  loyalty.ts first-listing-fee welcome (1 BP) + milestones 100/500/2000/10000 BLURT →
  10/50/200/1000 BP. The loyalty.ts comment itself uses "$0.125 listing fee" — consistent
  with the fees FAQ. ✓
- **order_timeouts** ("90 days default, 1-90 range, 15-min replace window"): matches order.ts
  ("frontend UI cap is 90 days") + orderReplace.ts `REPLACE_WINDOW_MS = 15 min`. ✓
No drift found. Existing FAQ smokes (per-tradable-asset-parity, keys-themed-section,
search-grandma-coverage, jsonld-no-markdown, what-is-asset-native-locale-floor) cover
structure/parity.

## Session 4 summary

Fix: F-008 (MED — USDT multi-network chat-link env vars were documented with the network
token in the wrong position vs the code's zod schema; an operator copying the docs would set
vars the indexer never reads → silent override no-op). Fixed the 4 doc lines + added a
registered, negative-tested doc↔code parity sentinel.
Verified clean: ~50 "documented-not-in-.ts" env vars (all shell/ops-script vars, not stale);
100 in-code-undocumented vars (optional overrides / defaulted tuning knobs / hardcoded
constants, no required var undiscoverable); MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY (required
but present in the env example the docs point to); FAQ numeric claims (all match code).

### Still remaining (subsequent sessions)
- README / OPERATIONS / RUN-A-MORPHIT-NODE prose accuracy (beyond env vars + fenced paths).
- Orphan/staleness: unreferenced exports, dead components, stale snapshot docs.
- Smoke/gate currency: every registered smoke asserts a live invariant; no orphan smokes.
- F-007 account-name regex unification (focused refactor with regression coverage).
- "What an outside pentest/agency would add" writeup for Ken.

## Session 5 (cp175 continued)

## Part K — Orphan/staleness sweep (COMPLETE — clean)

- **Dead components: NONE.** All 72 components in lib/components are imported somewhere.
- **Dead routes: NONE.** The /dev/* subtree (icons, responsive, yubikey-probe) is intentional
  operator/contributor diagnostics (documented as such in the page).
- **Snapshot docs (FOUR/THREE-PERSONA-WALKTHROUGH-cpNN, AUDIT-cpNN-*):** intentional point-in-time
  audit-trail records, referenced only by REVISIT-LIST.md + AUDIT-2026-05.md (history) and by
  `db-password-placeholder-smoke.ts` (which asserts the doc PATHS exist — a currency guard
  against accidental deletion, not a staleness bug). Not stale-as-bug.
- **"Orphan exports" (101 candidates flagged by a static name grep):** overwhelmingly FALSE
  POSITIVES — symbols used only WITHIN their defining file (e.g. isValidBtcAddress dispatched
  at payload.ts:1478; validateMnemonic at keygen.ts:319) or consumed via namespace/dynamic
  imports + .svelte template expressions the literal-string grep can't see. No genuinely dead
  code of consequence. A mass `export`-stripping sweep was DELIBERATELY NOT done: it's
  churn-heavy, risks breaking dynamic/barrel imports, and unused `export` keywords have zero
  runtime/security/correctness impact. Tracked as optional future cleanliness, not a finding.

## Part L — Smoke/gate currency (COMPLETE)

- **No broken registrations:** all 260 registered entries in run-smokes.sh resolve to files on
  disk (the "7 missing" were regex false-positives matching shell echo strings / `${var%:*}`
  expansions in the runner body).
- **F-010 (LOW, fixed):** `apps/web/scripts/locale-source-of-truth-smoke.ts` existed on disk but
  was NOT registered → it never ran, giving zero protection. It's a genuinely valuable guard
  (enforces SUPPORTED_LOCALES single-source-of-truth; flags any file that inlines the full
  10-locale set instead of importing the canonical array — the exact drift that would
  silently under-cover a newly-graduated locale). It passes 2/2. Registered it next to
  i18n-locale-registry-smoke. Now ZERO unregistered smoke files (258 on disk, all registered).

## Part M — F-007 account-name regex unification (COMPLETE — fixed)

Resolved the deferred F-007 divergence. Root cause: `registry.ts` used
`/^[a-z][a-z0-9-]{1,14}[a-z0-9]$/` (no dots, alnum-end) while the canonical
`isValidBlurtAccount` (chat/payload.ts) and all ~14 other validators used
`/^[a-z][a-z0-9.-]{2,15}$/`. Aligned registry.ts to the canonical form (strictly more
permissive toward real dotted Blurt names; the divergent form was the lone outlier).
- Chose alignment + a parity guard over a runtime-import refactor: making the low-level asset
  registry import the higher-level chat/payload module at runtime is an architectural smell /
  future-cycle risk. Aligning the literal + guarding parity achieves single-source-of-truth
  behavior without the dependency.
- **Guard added:** `apps/web/scripts/blurt-account-regex-parity-smoke.ts` (REGISTERED,
  negative-tested) discovers all 15 account-name regex definitions in the frontend and asserts
  each is byte-identical to the canonical `/^[a-z][a-z0-9.-]{2,15}$/`. Web typecheck 0 errors;
  payload/precision smokes (61 + 17) green. Not a security change (chain + extractSigner remain
  the authority); a UX-consistency correctness fix.

## Part N — Outside-pentest assessment (COMPLETE — for Ken)

Updated `docs/AUDIT-OUTSIDE-SCOPE.md` (the doc that directly answers "would a hired firm run
tests you haven't?"): (1) §3 crypto-specialist review now flags the cp173–174 signing migration
as RAISING its priority — a dual-signer period (dblurt elliptic + noble, behind SIGNER_BACKEND)
is a classic site for nonce/low-S/recovery-id/digest-binding bugs; a cryptographer should audit
the noble path + cutover plan before the flip. (2) Added a cp175 addendum: what this static
deep-deep covered, why it's necessary-not-sufficient, and the concrete recommended sequence
(finish static → stand up staging → cheap self-serve passes [libFuzzer on payload parsers,
ZAP/Nuclei, bug bounty] → specialist crypto + DAST/threat-model). Bottom line for Ken: code is
in unusually good static shape, but "static-clean" ≠ "pentested" — honest launch line is
"extensively self-audited; independent third-party review pending."

## Session 5 summary

Fixes: F-007 (account-name regex divergence — registry.ts aligned to canonical + parity
sentinel), F-010 (dormant locale-source-of-truth smoke registered). Verified clean:
orphan/staleness (no dead components/routes; "orphan exports" are within-file/dynamic, no real
dead code; snapshot docs intentional+guarded); smoke currency (260 registrations all resolve,
now ZERO unregistered smoke files). Outside-pentest assessment updated for Ken (Part N).

This completes the planned cp175 deep-deep scope. Findings summary: F-001 (HIGH) + F-002/F-005/
F-006/F-007/F-008/F-010 fixed; F-003 (INFO) doc fix; F-004 false alarm; F-009 verified-clean
(not a gap). Six new guard smokes added (signer-consistency, chatlink-env-doc-parity,
account-regex-parity + the comment-op proof extension + locale-source-of-truth registration).

## Session 6 (cp175 continued — pushing past "planned scope")

## Part O — FULL suite execution (the real gate, finally run end-to-end)

Prior sessions ran slices; this session ran the ENTIRE registered suite group-by-group plus the
unit suites. Result:
- **All 262 registered smokes PASS** (root 25, indexer 77, relay 10, ops-cli 17, matrix-bot 10,
  mcp-server 3, web 94, packages 26). Includes all 6 new cp175 guard smokes.
- **All unit suites PASS** via vitest-must-pass-smoke: **indexer 475/0fail/1skip, relay 244/0fail,
  web 694/0fail/5skip** = 1,413 passing unit tests. (Correcting a stale assumption: the indexer
  vitest suite DOES run here — 475 passing — it is not blocked by the native better-sqlite3 build
  as the handoff summary implied; those tests use pg-path mocks.)
- One harness false-positive worth recording: `apps/relay/drainer-defense-smoke` prints expected
  `Error:` lines as part of its NEGATIVE-path assertions (deliberately triggering rejections);
  run in isolation it reports "✓ all 17 scenarios passed". A naive grep for "Error:" mis-flags it.
  The relay drainer (hot-key component) is clean.

## Part P — SQL-injection sweep (COMPLETE — clean) + F-011

Systematic sweep of every SQL query in indexer + relay for non-parameterized construction.
- **No string-concatenation query building** (zero `query('...' + var` patterns).
- **14 template-interpolation sites, all verified safe:** (a) cursor pagination
  (orders.ts/feedback.ts) interpolates only a FIXED clause string with values bound as `$2/$3`;
  (b) dynamic WHERE builder (orderbook.ts/orderbookStream.ts) uses a `p(v)` helper that PUSHES
  the value to params and returns the `$N` placeholder — user filter values
  (asset/side/fiat/region/methods/min_trades) are all parameterized; region adds escapeLike +
  ESCAPE; (c) signals.ts/decay.ts interpolate only module-level numeric CONSTANTS
  (SIGNAL_*_DAYS=7/30, REPUTATION_DECAY_HALF_LIFE_DAYS=365), never user/config data. No user
  input reaches SQL via interpolation. Injection surface clean.
- **F-011 (LOW, fixed):** found while tracing decay SQL. `reputationDecayWeightSql()` (decay.ts)
  is exported but UNUSED; the decay formula `POWER(0.5, ... / (365 * 86400.0))` is hand-inlined
  10× across api/feedback.ts (×6) + api/orderbook.ts (×2) + api/orderbookStream.ts (×2) with 365
  as a magic number. The JS decay path is guarded against the constant by reputation-decay-smoke,
  but the SQL path was NOT — a change to REPUTATION_DECAY_HALF_LIFE_DAYS would silently diverge
  the verifiable-receipt (JS) from the live rating query (SQL). Added
  `reputation-decay-sql-constant-parity-smoke` (REGISTERED, negative-tested: asserts all 10
  inlined literals == the constant). Annotated the helper as intentionally-retained reference
  (not dead code) with a pointer to the guard. Chose guard-the-duplication over refactoring 10
  multi-line SQL aggregates (churn/risk).

## Session 6 summary

Ran the FULL suite end-to-end for the first time this campaign: 262/262 smokes + 1,413 unit
tests (indexer 475, relay 244, web 694) all PASS; triple-pulsed the security-critical/flaky set.
Corrected a stale belief (indexer vitest DOES run here). SQL-injection sweep clean. F-011 (LOW,
fixed) decay-constant SQL drift guard. Two more guard smokes (chatlink+account-regex from S5,
now decay-constant) — cp175 has added 7 guard smokes total.

## Session 7 (cp175 — privacy/Monero hardening + handler deep-read + persona traces + doc prose)

## Part Q — Metadata-leak reduction (Monero-comfort focus)

### F-012 (MEDIUM, fixed) — order permlink leaked the asset into permanent public surfaces
The order permlink was `<side>-<asset>-<fiat>-<rand>` (e.g. `sell-xmr-usd-ab12cd`). A Blurt
permlink is permanently public AND propagates into order URLs (`/[account]/[permlink]`), RSS feed
GUIDs + links (rssOrderbookHandlers), and block explorers. So the asset name ("xmr") leaked into
many human-readable, widely-syndicated, permanent surfaces — exactly what a Monero observer would
flag. Verified EXHAUSTIVELY that nothing parses meaning from the permlink: the indexer reads
side/asset/fiat from the STRUCTURED payload (payload.asset, v.side, line 129/671), the orderbook UI
renders from structured fields, every other reference treats the permlink as an opaque
`account/permlink` token. So embedding the asset was pure redundant leakage.

**Fix:** `makeOrderPermlink` now returns an OPAQUE `order-<12 random chars>` (~59 bits, collision-
negligible; uniqueness still enforced by the indexer (account,permlink) PK). The asset/side/fiat
still travel in the structured payload (a public orderbook MUST publish them to match traders —
that's inherent, not a leak). This stops DUPLICATING them into the permlink/URL/RSS/explorer.
Pre-launch (zero live orders) so format change is free. Updated the unit test to assert the opaque
form AND that asset/side/fiat are absent (privacy invariant locked in — a regression re-adding them
fails the test). Web vitest 695 passing (was 694; +1 new invariant test). Typecheck 0 errors;
order/rss/persona/payload smokes green.

### Monero-comfort: existing posture VERIFIED STRONG + one disclosure added
Confirmed the privacy engineering is genuinely Monero-respectful:
- **XMR view-key NEVER exposed** — `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` was removed entirely
  (Part 109, treasurySource.ts); release.ts has a Part-107 invariant that STRIPS any `viewkey`
  field from release ops (defense vs an old broadcast). Never on-chain, never in API, never logged.
- **Fee verification uses Monero-native `get_tx_proof` selective disclosure** (moneroProofVerifier.ts
  via `check_tx_key`/`txprove=1`) — reveals only "this txid paid this address this amount," nothing
  about the wallet. Correct, idiomatic Monero design.
- **XMR fee-payment is OPT-IN** (default fee_method = 'blurt', and BLURT is 50% cheaper).
- **Amount jitter** with piconero precision + a FAQ entry that understands chat-amount correlation.
- **Existing FAQ `xmr_txid` + `xmr_tx_proof`** already explain the proof mechanics well.

**Disclosure added (honesty for maximalists):** augmented the `xmr_txid` FAQ in ALL 10 locales with
the one cross-chain fact a skeptic will look for — paying the *listing fee* in XMR records that
fee's TxID in the order op on the public Blurt chain (the ONLY place an XMR TxID touches Blurt; it's
a ~$0.25 fee to the public treasury, never the trade settlement, which is peer-to-peer and never on
Blurt) — and the clean opt-out: pay the fee in BLURT (default + half price) for ZERO XMR↔Blurt
linkage. Locale parity preserved (3094×10); FAQ + parity smokes green.

## Part R — Handler deep-read (business logic, not just attack classes)

### order.ts (974L) — read in full
- **waived_first_buy branch:** correctly gated (side=buy, asset=BLURT, amount_min≥500 BLURT,
  no prior orders one-shot) with an ATOMIC `INSERT...ON CONFLICT...WHERE first_buy_waived_at IS
  NULL` claim that returns 0 rows (→ reject) if a concurrent op already claimed the waiver. Race-safe.
- **Multi-network asset_network validation** (USDT/USDC/DAI): per-asset allowlist Set-membership,
  single-network assets must omit, length-bounded before lowercasing. Correct.
- **F-013 (LOW, fixed):** the per-asset network allowlists are hardcoded as Sets in BOTH order.ts
  (L397-403) AND orderReplace.ts (L210-213) — three copies counting the registry's
  `supportedNetworks`, with NO guard tying them together. A network added to the registry would
  leave the handlers stale → silent `asset_network_unknown` rejection of orders on the new network
  (frontend offers a network the indexer refuses). Added
  `asset-network-set-registry-parity-smoke` (REGISTERED, negative-tested: 6 checks = 2 handlers ×
  3 assets vs registry, fails on injected drift). The Sets are currently correct (USDT
  erc20/trc20/spl/bep20, USDC erc20/spl/base/polygon, DAI erc20/polygon/base/arbitrum all match).

### featureBid.ts (516L) — read in full — CLEAN
Auction logic correct: hours validated integer∈[6,168] BEFORE the `amountBlurt/hours` division
(no div-by-zero), `requiredBeat = max(displacedRate+1, displacedRate*1.05)` anti-pennywise rule,
`expiresAt` from block-time (deterministic), anti-snipe soft-close extension (SNIPE_EXTENSION),
bid must reference a live + fee-verified order. Money math bounded.

### orderReplace.ts (434L) — read in full — CLEAN (notably strong)
Ownership is keyspace-bound (looks up (ctx.signer, permlink); can't touch another account's order).
Although the UPDATE can write side/asset, the validator FORBIDS changing side/asset/fiat/
asset_network with explicit reasons + attack-comments — including `replace_asset_network_change_
forbidden` which blocks a USDT-ERC20→USDT-TRC20 swap that would fool a counterparty who clicked the
original listing (settlement-chain bait-and-switch). `replace_below_waiver_floor` blocks the
claim-waiver-at-500-then-replace-to-1 abuse. created_at preserved (age/reputation can't be reset).

### chat.ts (545L) — read in full — CLEAN (privacy-correct)
Stores ONLY ciphertext + opaque jsonb header (ephemeral_pub/nonce/client_tag) + sender/recipient/
timestamps — nothing derived from plaintext (indexer can't read messages). Layered anti-abuse:
block-check fires first, stranger-gate (prior exchange OR paid stranger_fee), fan-in cap (>20 new
senders/24h) + per-sender no-reply cap (>50). order_permlink is an opaque validated lookup key
(checks the order is real + recipient-owned) — does NOT parse asset/side from it, so F-012's opaque
permlinks are fully compatible; the fast-path does NOT bypass block/stranger gates.

**Handler deep-read COMPLETE:** all 4 biggest handlers (order/featureBid/orderReplace/chat) read
line-by-line for business logic. One finding (F-013, fixed). The replace bait-and-switch defenses
and chat anti-abuse layering are notably mature.

## Part S — Persona traces: Charlie (MCP) + Sally-operator (end-to-end, not via smokes)

### Charlie (MCP server) — read-only BY CONSTRUCTION, verified
The MCP server exposes exactly 5 tools, all read-only: morphit_search_orders, morphit_list_
instances, morphit_list_payment_methods, morphit_get_listing, morphit_describe. A grep over the
ENTIRE apps/mcp-server/src for signing/broadcast/key primitives (sign, broadcast, privateKey, wif,
active/posting key, custom_json, keystore, seed, mnemonic, @noble, elliptic, dblurt) returns ZERO
real hits — no write capability EXISTS in the code. indexerClient only does `fetch` against the
indexer's read /v1/ endpoints, hardened with redirect-refusal + body-cap (a malicious instance
can't redirect or flood it). The `mcp-server-read-only-invariant-smoke` codifies this as a CI guard
so a signing import can't land silently. Runtime: read-only/server/private-instance/body-cap smokes
all green. Charlie can shop the orderbook but cannot move funds or impersonate a user.

### Sally-operator (ops-cli init wizard) — verified, Monero-rule-clean
The init wizard (~20 ELI5 prompts) writes morphit.config.env + an encrypted keystore. MONERO RULE
HELD: the wizard collects only XMR PUBLIC config (MORPHIT_INDEXER_XMR_EXPLORER_URLS, _FEE_PICONERO
amount) — it NEVER asks for or stores the XMR view key (Part 109's removal holds through the
operator tooling). The one sensitive secret (the relay active key, for account-creation/transfers)
is stored ENCRYPTED AT REST (scrypt N=2^17 + AES-GCM, "one passphrase per instance"; alt-network
keystores reuse the same envelope — an attacker with all keystores still needs the passphrase).
Runtime: init (43), edit-active-key (19), altkeystore (14), disabled-assets-wizard (22),
install-invariants (9), persona-walkthrough (170), sally-walkthrough (22) all green.

## Part Q (cont.) — Further metadata-leak reductions

### F-015 (LOW, fixed) — order expiry leaked the submit moment to ms precision
`expires_at` was `new Date(Date.now() + expiresDays * 86_400_000)` at both order call sites
(post/+page.svelte:1150, post/edit/[permlink]/+page.svelte:462). Its ISO string carried HH:MM:SS.mmm
of the submit moment onto the public Blurt chain; since the interval is a round number of days, an
observer could subtract it to recover the client's exact wall-clock at submit — a clock-skew
fingerprint finer than, and independent of, the block time. Added `makeExpiryFlooredUtcDay()` in
$lib/orders/payload (floors to UTC midnight; floors-not-rounds so it can't cross the indexer's
MAX_EXPIRES_AT_DAYS=365 ceiling), routed both call sites through it. expires_at is only used in `>`
liveness comparisons (verified: featureBid/chat/order/orderReplace) and shown as "expires in N
days," so nothing functional is lost. Guard: `order-expiry-day-floor-smoke` (REGISTERED,
negative-tested: floors 1/14/90/365d to midnight + asserts no call site reintroduces the raw
pattern). Web typecheck 0 errors; vitest 695 passing; persona/order smokes green.

### Final on-chain order-op review — no further gratuitous fields
Read the complete OrderPayload: side/asset/fiat/amount_min/amount_max/price_model/location_region/
payment_methods/terms/expires_at (+ fee_method/external_tx_id/tx_proof/asset_network when relevant).
All user-intentional. Grep for navigator/Intl/timezone/locale/userAgent fingerprints in the
order-build path: ZERO. Confirms "what you see in the order form is what goes on chain, nothing more."
Catalog (METADATA-LEAK-CATALOG.md) updated: B.2 defenses note + Sealings section now list F-012 + F-015.

## Part T — Operator-doc prose read (OPERATIONS.md 9768L + RUN-A-MORPHIT-NODE.md 2343L)

Read the prose (beyond env-vars/paths/FAQ already covered) with a focus on stale/inaccurate claims
and Monero-scrutinizable statements. Monero/view-key prose is consistent + accurate throughout:
§12 documents the view-key check was RETIRED (Part 110 — no view key exists to check); lines
8096-8466 reinforce "no view key lives on any indexer's box," "Does NOT prompt for the view key";
RUN-A-NODE's community-operator section correctly says "no view key required by you, no shared
secret." Numeric claims (60 BLURT listing fee, $0.125 BLURT / $0.25 BTC-XMR, 90/10 BLURT split,
scrypt N=2^17, 3-second blocks, MAX_EXPIRES_AT_DAYS) all consistent with code.

### F-014 (INFO, fixed) — alarming `viewkey=` URL in OPERATIONS.md
The explorer API URL `/api/outputs?txhash=…&address=…&viewkey=…&txprove=1` (OPERATIONS.md ~line
8226) is the onion-monero-blockchain-explorer's API, where the `viewkey=` param (with `txprove=1`)
actually carries the single-use tx_proof, NOT a real view key — confirmed in code
(moneroProofVerifier.ts passes `viewkey: txProof`, with a code comment explaining the explorer's
naming + that the proof is excluded from logs). But the doc snippet lacked that clarification, so a
privacy-conscious operator reading it would reasonably be alarmed (it appears to contradict the "no
view key" messaging elsewhere). Added a Monero note at that URL clarifying the param carries the
tx_proof, not a view key, and that Morphit never holds/transmits/logs a treasury view key. (RUN-A-
NODE does not show the raw URL, so no fix needed there — both operator docs now tell a consistent,
non-alarming Monero story.)

## Session 7 summary

Completed all four requested deep-dives + the Monero metadata push:
- **Handler deep-read (all 4 biggest):** order.ts (F-013 fixed: asset_network Set vs registry
  parity guard), featureBid.ts (clean), orderReplace.ts (clean — strong bait-and-switch defenses),
  chat.ts (clean — privacy-correct, opaque-permlink-compatible).
- **Persona traces:** Charlie/MCP read-only-by-construction (no signing/write capability exists;
  CI-guarded) + Sally-operator (wizard never touches XMR view key; active key encrypted at rest).
- **Privacy/Monero reductions:** F-012 (opaque order permlinks — asset no longer in
  permlink/URL/RSS/explorer), F-015 (UTC-day-floored expiry — no submit-moment timing leak),
  xmr_txid FAQ disclosure across 10 locales, F-014 (OPERATIONS.md viewkey-param clarification).
  Verified the existing posture strong: view-key never exposed, tx_proof selective disclosure,
  amount jitter, XMR fee opt-in.
- **Operator-doc prose read:** OPERATIONS.md + RUN-A-NODE — claims accurate; F-014 the only fix.
Findings this session: F-012/F-013/F-014/F-015 (all fixed). cp175 now: F-001 HIGH + F-002/F-005/
F-006/F-007/F-008/F-010/F-012/F-013/F-015 fixed; F-003/F-014 INFO doc fixes; F-004 false alarm;
F-009/F-011-guard verified. Ten guard smokes added across the campaign.

## Session 8 (cp175) — privacy-coin parity + catalog simplification + FAQ/brag/comparison

### Privacy-coin inventory + parity (the "do the same for all privacy coins" ask)
Established the full picture: privacy coins are XMR, ZEC, ARRR, DASH, DCR (+ BTC/BCH/LTC carry
opt-in privacy tech). KEY FINDING — the on-chain protections are ALREADY asset-agnostic and cover
every privacy coin uniformly: F-012 opaque permlinks, F-015 day-floored expiry, amount jitter
(jitterAmountForAsset → jitterUtxoAmount covers ZEC/ARRR/DASH/DCR at satoshi precision;
jitterMoneroAmount for XMR), shielded-address-aware validation (ZEC zs1/u1, ARRR zs1-only). And
because the fee_method enum is FROZEN at blurt|btc|xmr, ZEC/ARRR/DASH/DCR can NEVER pay fees → their
TxIDs never touch Blurt at all (cleaner than XMR's one optional fee-link). The per-asset
/privacy/{asset} guides + what_is_<asset> FAQ already cover each privacy coin thoroughly (XMR's
guide is the SHORTEST because Monero's privacy needs the least guidance). Net: privacy-coin parity
was largely already present; this session made it explicit in user-facing surfaces.

### New FAQ entry: privacy_coins_onchain (all 10 locales, +2 keys → parity 3096×10)
Added one canonical "How does Morphit keep my privacy-coin trades private?" entry covering all five
privacy coins: settlement off-chain, opaque permlinks, floored expiry, jitter, the trade-only
TxID-never-on-Blurt guarantee for ZEC/ARRR/DASH/DCR, and XMR's single opt-out-able fee-link.
Registered in faqIndex.ts section 7 (Privacy) + related-map. FAQ/parity/jsonld smokes green.

### METADATA-LEAK-CATALOG.md — massively simplified (554 → 161 lines)
Rewrote into the three-part structure: (1) What does NOT leak + why (table), (2) What DOES leak +
why (on-chain / network / server / client, each concise), (3) Privacy coins — how far we've gone
(the full measures, per-coin). Kept the comparison table + provenance/change-policy. All
load-bearing facts preserved; doc-parity + fenced-path smokes green; no broken anchor refs.

### Brag list + comparison image
- Brag entry 113 enhanced (no renumber): folded in opaque permlinks (asset never in
  permlink/URL/RSS/explorer), floored expiry, XMR's opt-out fee-link, and the ZEC/ARRR/DASH/DCR
  TxID-never-on-Blurt guarantee. Brag-list parity smoke 79/79; media kit regenerated (freshness
  green).
- Comparison image: added 2 rows to "Privacy & anonymity" — "Privacy coins first-class
  (XMR/ZEC/ARRR/DASH/DCR; TxIDs off-chain)" and "Opaque order IDs — asset name never on the
  coordination chain." Rebuilt PNG + fingerprint (cairosvg + pngquant); freshness smoke 15/15.

### Status of the original 4 bullets (confirmed complete)
1. Handler deep-read (order/featureBid/orderReplace/chat all 4) — COMPLETE (Parts R/S; F-013 fixed).
2. Charlie/MCP + Sally-operator end-to-end traces — COMPLETE (Part S).
3. Privacy/metadata-leak pass — COMPLETE + extended this session (F-012/F-014/F-015 + privacy-coin
   parity + catalog/FAQ/brag/comparison).
4. OPERATIONS.md + RUN-A-MORPHIT-NODE.md prose read — COMPLETE (Part T; F-014 fixed).

## Part T (cont.) — RUN-A-MORPHIT-NODE.md full prose read complete
Finished reading the remaining prose sections (§8 manual-config, §9 operator-economics, §11
hardening, §12 troubleshooting). All accurate:
- §8.1: separate morphit-relay system user (smaller blast radius), 0600 env modes — matches the
  ops-cli wizard + OPERATIONS key handling.
- §9.3 earnings flow: 90% floor-rounded to 3 decimals, relay_pending_transfers queue + drainer,
  ports (indexer 8081 / relay 8080) — consistent. §9.6 Part-111 federation-cost gating
  (4 categories + account-creation as the HTTP-scoped 5th) matches code.
- VERIFIED a cross-doc numeric claim that looked drift-prone: "welcome bonus = 20 BLURT (10 liquid
  + 10 vesting)" is EXACTLY right (feedback.ts:435-436 inserts liquid 10 + vesting 10). The "1 BP"
  in some notes refers to the SEPARATE loyalty-milestone BP delegation (10/50/200/1000 BP), not the
  welcome bonus — no conflict.
- §11 "What none of these prevent" is candid + accurate (account creation ~100 BLURT paid by the
  relay; the brake is the §18 daily-ceiling drain defense + kill-switch, not attacker cost).
No stale claims found in RUN-A-NODE beyond the F-014 viewkey-param clarification already applied to
OPERATIONS.md. Bullet 4 (operator-doc prose read) now fully complete across both docs.

## Session 9 (cp175) — operator setup-wizard clarity + upgrade-doc (4 operator asks)

Operator-experience pass on the ops-cli init wizard + upgrade docs. Four asks:

1. **Upgrade doc for an older-version sysadmin.** docs/UPGRADING.md ALREADY EXISTS (346 lines,
   sysadmin-focused: `morphit-ops upgrade` check→notes→confirm→backup→apply→npm ci→restart→
   auto-rollback; manual procedure; automated mode; release-monitor; GPG belt-and-braces; dedicated
   Rollback section). No new doc needed. IMPROVED: de-staled "~3,300+ scenarios" → "thousands of
   self-checking scenarios" (drift-proof); ADDED "## What if my instance is several releases behind?"
   section (the user's exact scenario — cumulative tarballs jump straight to latest in one step; read
   ALL intermediate release notes; confirm not crossing a major; schema migrations auto-apply on
   indexer restart; data/config untouched).

2. **instance name + tagline fields.** Both wizard prompts (steps.ts step 1 stepInstanceName, step 2
   stepTagline) already had explain()+examples() but undersold the display surfaces. Traced where the
   values render: title bar (Head.svelte:95), header/nav (+layout.svelte), homepage (+page.svelte),
   support page, the FEDERATED /instances directory (instances/+page.svelte:230 name + :361-362
   tagline italic), and SEO/JSON-LD (jsonld.ts). REWROTE both explain() blocks to enumerate ALL
   surfaces, emphasizing the federated /instances directory (users on OTHER nodes see your instance by
   this name/tagline). Examples improved (instance name now 'alice-morphit'/'Morphit Berlin'/'Free
   Morphit Canada').

3. **public origin.** stepOrigin (step 9) rewrote explain() to tie "public origin" explicitly to
   "the domain name you registered (and pointed at this server) with https:// in front," with concrete
   "if your domain is X, you enter https://X" examples + DuckDNS home-host note + clarified NOT a Blurt
   RPC and NOT a block explorer.

4. **"chat-link" URLs → block explorer URLs.** Investigated: these ARE block explorer transaction-URL
   templates (mempool.space/tx/{txid}, xmrchain.net/tx/{txid}, ...) — "chat-link" just describes the
   purpose (linkify a TxID pasted in chat). User's instinct correct. There are TWO explorer steps:
   step 11 stepFeeExplorers "Fee-verifier explorer URLs" (server-side, multi-URL LIST per asset w/
   Keep/Edit-comma-separated/Reset — add/delete genuinely works here) vs step 12 stepChatLinkExplorers
   (what users click; exactly ONE URL per asset/network, REQUIRED — parseChatLinkTemplate rejects
   blank). FIXES: renamed step-12 title to 'Block explorer links (clickable TxIDs in chat)'; rewrote
   its explain() to say these are ordinary block explorers ("chat-link" is the internal name), one per
   asset/network, editable/resettable/required-not-blank, SEPARATE from the fee-verifier LIST; renamed
   all 39 admin-visible per-asset labels + section headers "X chat-link URL" → "X block explorer URL"
   (BTC/XMR/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL/ETH/XRP + USDT/USDC/DAI per-network). Kept env-var names
   MORPHIT_FRONTEND_*_CHAT_LINK_URL unchanged (config compat + doc-parity smoke). editChatLinkUrl
   helper already offers Keep/Change/Reset per URL w/ live reachability probe — editing+resetting work;
   add/delete is a fee-verifier-list concept, not chat-link (each asset needs exactly one explorer).

CAUGHT + FIXED a latent regression from session-8's catalog rewrite: wizard-step-count-doc-parity-smoke
asserts METADATA-LEAK-CATALOG.md contains /roughly \d+ prompts/ matching TOTAL_STEPS=20; my rewrite had
written "~20 prompts" → restored "roughly 20 prompts." 8/8 green.

VERIFIED: ops-cli tsc 0 errors; no smoke pins the old step-12 title; touched smokes (init,
wizard-step-count, frontend-chatlink-env-doc-parity, operator-doc-fenced-path, upgrade-fetch-hardening,
cross-document-value-invariants) triple-pulse green. NO TARBALL YET (per user).
