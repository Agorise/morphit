# Morphit cp308+ repo-wide deep-deep + five-persona walkthrough campaign

**Mandate (Ken, cp308):** exhaustive five-persona walkthroughs (every button,
link, field, select option — soup to nuts), then a 94+-task deep-deep across
EVERY file/script (.md/.ts/.svelte/ops): drift, regex accuracy, type errors,
test-coverage gaps, stale/outdated smokes + gates + parities, bad keys/vals,
unwired code, non-functioning paths, staleness/orphans, hostile-op sweep across
all handlers, chain-direct attack patterns, DB dead fields, unfinished drafts,
FAQ accuracy, mobile-responsiveness, UX papercuts, README + OPERATIONS +
RUN-A-MORPHIT-NODE + all docs/*.md accuracy, broken refs, efficiency / slow
page loads, memory leaks, fallbacks/failovers, "never leave a user hanging,"
and "is it grandma-friendly?". Fix as we go. NO tarball until Ken says so.
Tree stays v1.0.0-beta.23, Forgejo only.

This file is the campaign spine — updated every turn so the effort survives
across sessions. Status legend: ☐ not started · ◐ in progress · ☑ done.

---

## Persona walkthroughs (trace every interactive element through real code)

- ☑ **Bob** — Blurt multi-login. COMPLETE. Login unlock (full error matrix incl. yubikey/TOTP/paired, busy guards); sign-in cards (cp305) + import (cp306); account-switch via guardSwitch sign-out modal (cp305); QR-pair BOTH sides clean (ScanLoginQr phase machine handles camera-denied/no-camera/invalid-QR/not-unlocked terminal states; LoginQrInitiator one-tap regenerate on expiry, "no scary error", paired-readonly boot; /pair protocol handler falls back to home on malformed payload); post/create (6-phase, frozen fee enum, proof validation, never-hang — F-005 fixed); post/edit (separate impl, not_found/not_yours/not_live/window_expired/save_error states, idempotent same-permlink so no F-005 risk); my/orders (loading/ready/error, two-step cancel confirm, per-order error + finally un-stick, idempotent cancel). One finding (F-005) fixed; rest clean.
- ☑ **Sally-user** — no crypto. COMPLETE. Onboarding (generate path) CLEAN; register-name CLEAN (F-004 fixed). backup-keys CLEAN (locked/posting-only/paired each handled, seed-decrypt wipes the copy, download try/catch/finally). orderbook browse CLEAN (phase loading/ready/error with retry; side/min_trades/sort selects all wired + correctly mapped to the indexer enum incl. the goods/barter variants; moderation transparency line; read-only register banner grandma-friendly). Feedback path WIRED end-to-end (banner→LeaveFeedbackForm→`morphit_feedback_v1`→dispatcher→feedbackHandler / feedbackResponseHandler→RespondToFeedbackForm + explorer decoration). The post/create-order placement flow is the same impl Bob traced (6-phase, never-hang, F-005 fixed); feedback round-trip reads through the wired handler chain above.
- ☑ **Sally-operator** — node setup purely from the .md docs. COMPLETE. Doc-accuracy audit of RUN-A-MORPHIT-NODE.md: all referenced `MORPHIT_*` env vars are real (now gated by F-006); referenced files exist; `npm run migrate` exists; "23 steps" == `TOTAL_STEPS=23`; every `morphit-ops <cmd>` reference is a real subcommand. Install-sequence ordering traced + sound: nginx+certbot installed but cert deferred until DNS + nginx config exist (the doc explicitly states the prerequisite); `npm run build --workspaces` before deploy; DB setup before `npm run migrate`; SSL via `morphit-ops ssl setup` after the domain resolves. BunkerWeb path coherent (frontend container serves whole site, SvelteKit build mounted read-only not copied, relay/indexer bind for the 172.20.0.0/16 Docker bridge with matching UFW rules). Home-hosting/CGNAT path documented via Dynu DDNS + VPS→Pi migration note. Found + fixed F-007 (compose relay-key var names) + built F-006 gate. Host-gated remainder: the live on-host install itself.
- ☑ **Josie** — sysadmin, morphit-ops daily usage (every menu item). COMPLETE. Smoke battery green; color + #16 fixed; graceful-degradation traced: status.ts wraps each probe (DB / relay / indexer / systemd) in try/catch (lines 292/305/314/329) so a down service or unreachable DB degrades to a reported-unavailable line, never a crash; #16 DB-URL fallback removes the prior "No database URL" dead-end; health-view + status-backups smokes gate it. Host-gated remainder: #15 (Matrix-alerts editing) needs Ken's host.
- ☑ **Charlie** — MCP agent, read-only (every tool + every parameter). Complete: 5 tools bounded + SSRF-guarded, 53 smoke scenarios, version drift fixed.

Feedback path to verify in each: /my/orders → banner → form → morphit_feedback_v1
→ indexer → profile → feedbackResponse_v1.

## Deep-deep task categories (A–L, ≥94 tasks)

- ☑ A. Static code (dead code, unwired, orphans, TODO/FIXME/draft markers) — no markers; smoke-registration clean
- ☑ B. Deps / supply-chain (pins, no audit-fix, lockfile integrity) — ranges+lock+sync/satisfaction/audit gates
- ☑ C. SQL / DB (dead fields, migrations, injection, indexes) — both-direction drift clean; injection clean
- ☑ D. HTTP / API (handler hostile-op sweep, error shapes, never-hang) — 17 handlers + relay HTTP + MCP
- ☑ E. Crypto / keys (zeroing, KDF floors, WIF/base58, no key leak) — argon2id + memzero; no leak
- ☑ F. Privacy (no IP leak, no external fetch, CSP, view-key env-only) — IP/CSP/TX-proof-not-viewkey
- ☑ G. Operator-trust (fee math, treasury, block enforcement) — 90/10 exact, 100/0 BTC/XMR, frozen enum
- ☑ H. Frontend (a11y, mobile-responsive, UX, never-hang, grandma-friendly) — viewport/responsive/a11y-gated
- ☑ I. Contracts / parities (smoke ↔ code, env ↔ schema, locale parity) — smoke-reg + FAQ-locale + env clean; F-006 gate BUILT + registered (battery 358)
- ☑ J. Build / CI (tsc clean, smokes wired, gates current) — FULL pre-tarball battery GREEN: tsc 11/11 workspaces, svelte-check 0/0, vitest (web 730 / ops-cli 24 / indexer 486 / relay 268), full 358 smoke battery all pass (chunked + 2 meta-runners covered directly); version held at beta.23 (consistency 19/19); F-010 (stale llms-full.txt) found + fixed.
- ☑ K. Threat modeling (chain-direct attack patterns across handlers) — covered by D hostile-op sweep
- ☑ L. Per-subsystem deep reads (relay, indexer, web, ops-cli, mcp, matrix-bot, packages) — all swept
- ☑ M. Docs accuracy (README, OPERATIONS, RUN-A-MORPHIT-NODE, FAQ, all docs/*.md, broken refs) — F-007/F-009 fixed, gates present

---

## Findings log

### F-004 — register-name "register from Settings" is a broken promise · UX/COPY · FIXED (cp308)
The `relay_out_of_funds` registration error (all 10 locales) told a generate-and-
skip Sally to "skip for now and register from Settings." But Settings has NO
account-CREATION path — only an on-chain name VERIFICATION section
(`needsAccountNameBanner`, for seed/keyfile imports whose keys are already on
chain). A Sally who generated keys and skipped has no on-chain account, so
Settings is a dead end → exactly the "left wondering wtf" failure. The real
re-registration path is the orderbook (and post / my-orders) banner — `skipForNow`
even navigates to `/orderbook`, whose `$isUnlocked && viewerAccount === null`
banner shows a clear 👋 register CTA. Fix: corrected the copy in all 10 locales
to "…register when you're ready to trade" (parity 10/10, completeness 4/4), and
fixed the inaccurate `skipForNow` comment that claimed "Settings will nudge them."
RECOMMENDATION — DECLINED by Ken (cp308). Do NOT add a Settings register
affordance. The corrected copy + the orderbook register banner are the path;
leave Settings as verification-only. (Keeping this noted so no future session
re-proposes or builds it.)

### F-001 — mcp-server version string not drift-gated · DRIFT · FIXED (cp308)
`apps/mcp-server/src/main.ts` advertised `version: '1.0.0-beta.23'` as an inline
literal in the SDK server-info handshake. The version-consistency smoke gated the
relay/indexer health.ts constants and every package.json, but NOT this string —
so a release bump could silently leave the MCP server reporting a stale version.
Fix: hoisted to `const MCP_VERSION` and added it as a Category-B touchpoint in
`apps/web/scripts/version-consistency-smoke.ts`. Smoke 18→19, mcp-server tsc 0.

### F-005 — post/create-order had no mid-broadcast navigation guard · UX/SAFETY · FIXED (cp308)
register-name cancels navigation while its account-creation op is broadcasting,
but the post (create-order) flow did not — its `broadcasting` phase was just a
spinner with the global nav still live. Order permlinks are RANDOM per attempt
(`makeOrderPermlink`), so a user who navigates away mid-broadcast (unsure whether
it landed) and re-posts creates a DUPLICATE on-chain order. Fix: added a
`beforeNavigate` guard that cancels navigation while `phase === 'broadcasting'`,
mirroring register-name. svelte-check 0/0. (Pre-broadcast `awaiting_password` is
intentionally NOT guarded — nothing has hit the chain yet, and the draft system
preserves the in-progress order.)

### F-006 — no doc↔code parity gate for env vars · GATE GAP · FIXED/BUILT (cp308)
The operator docs (RUN-A-MORPHIT-NODE.md, OPERATIONS.md) prescribe ~118 `MORPHIT_*`
env vars in fenced examples. `operator-doc-fenced-path-existence-smoke` gates fenced
PATHS, but NOTHING gated doc-referenced env-var NAMES — so the F-007 drift class
(doc prescribes a var the code never reads → relay won't boot) had no gate. Manual
cross-check was CLEAN; BUILT the gate this turn.

BUILT: `scripts/operator-doc-env-var-parity-smoke.ts` (registered `.:operator-doc-env-var-parity-smoke`,
battery 357→358). Design — every false-positive class mapped before writing:
- Extracts `MORPHIT_*` only from FENCED code blocks (```…```), not prose. This is
  what makes it robust: the F-007 caveat NAMES the wrong vars in prose precisely to
  warn against them, and `MORPHIT_RELAY_KEYSTORE_PATH` survives only there now —
  fenced-only extraction correctly ignores it. Prose design/roadmap vars
  (DAILY_RECIPIENT_CAP_USD, GLOBAL_TPM_CEILING) are likewise ignored.
- Known universe = `MORPHIT_*` across apps/ packages/ ops/ scripts/ (305 vars).
- DYNAMIC_PATTERNS = `^MORPHIT_FAIL2BAN_[A-Z0-9]+_(CRITICAL|WARN)$` — the fail2ban
  monitor builds per-jail names at runtime (`MORPHIT_FAIL2BAN_<JAIL>_CRITICAL`), so
  e.g. `…_SSHD_CRITICAL` is a valid prescribed override a static grep can't see.
- DOCUMENTED_BUT_UNIMPLEMENTED allowlist (2, each with rationale): the compose
  `*_FILE` DB-secret pattern (INDEXER/RELAY_DB_PASSWORD_FILE), documented with an
  explicit not-yet-implemented caveat.
TESTED: passes (✓ all 118); tamper-test (inject fake var into a fenced block →
✗ 1/119; revert → ✓ 118, no residual diff); registration-integrity green (358/358,
351 smoke files all registered). The command-name half was intentionally NOT built
— `morphit-ops` subcommand drift is already covered by the ops-cli dispatcher tests,
and a doc-command extractor risks prose false-positives for little marginal gain.

### F-007 — docker-compose example named relay key vars the relay never reads · DOC/OPS · FIXED (cp308)
OPERATIONS.md "Compose example" (relay service env block, ~line 6031) set
`MORPHIT_RELAY_KEYSTORE_PATH: /run/secrets/relay_keystore` and
`MORPHIT_RELAY_PASSPHRASE_FILE: /run/secrets/relay_passphrase` — NEITHER name is
read anywhere in the relay. The relay reads its key from `MORPHIT_RELAY_ACTIVE_KEY_FILE`
(REQUIRED, `z.string().min(1)`, apps/relay/src/config/index.ts:65) and the unlock
passphrase from `MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE` (apps/relay/src/config/unlock.ts:77).
An operator copying the compose verbatim would set two ignored vars, omit the REQUIRED
`…ACTIVE_KEY_FILE`, and the relay would FAIL TO BOOT (config validation). Worse, the
pre-existing caveat block wrongly lumped both into the "not yet implemented `*_FILE`
secret pattern" — but the relay key+passphrase-from-file ARE implemented; only the
DB-password `*_FILE` vars (`MORPHIT_INDEXER_DB_PASSWORD_FILE`, `MORPHIT_RELAY_DB_PASSWORD_FILE`)
are unimplemented (confirmed: no consumer anywhere). **FIX:** renamed the two compose
vars to the real implemented names (`…ACTIVE_KEY_FILE` / `…ACTIVE_KEY_PASSPHRASE_FILE`,
pointing at the same mounted secret paths; docker `secrets:` labels unchanged) and
rewrote the caveat to split the two classes — DB-password `*_FILE` NOT implemented
(inline creds in DATABASE_URL meanwhile) vs. relay key+passphrase-from-file IS
implemented and works as shown — plus a parenthetical recording the old wrong names
and that copying them bricks the relay. Verified post-fix: wrong names survive only in
the explanatory parenthetical; compose block uses the real required names.

### F-008 — loyalty.ts comment calls the first-trade bonus a "10 BP delegation" · DRIFT (comment) · FIXED (cp308)
`apps/indexer/src/indexer/loyalty.ts` docstring (above the first-fee welcome)
described the first-COMPLETED-trade reward as "the existing 10 BP delegation that
fires on first COMPLETED trade … both add to the cumulative delegation target."
But feedback.ts:435-436 enqueues that reward as `liquid` 10 + `vesting` 10 — a
10 BLURT liquid transfer + 10 BLURT Power (vesting) the user OWNS, NOT a delegation
and NOT "10 BP", and it does NOT feed the cumulative DELEGATION target (only the
first-fee 1 BP welcome + the loyalty milestones are delegations, which replace-not-add
per client.ts:595 and so accumulate via the queue). Same delegation/vesting
confusion the prior campaign (beta.19) fixed in the user-facing FAQ but missed in
this internal comment. Comment-only (no behavior change, no smoke needed). The FAQ
itself is verified ACCURATE. FIX: rewrote the comment to describe the first-trade
reward as owned liquid+vesting and clarify only the delegations accumulate.

### F-009 — README "~320 runners" self-check count stale · DRIFT (doc) · FIXED (cp308)
README.md quick-start step 6 cited "~320 runners" but `run-smokes.sh` registers
357 entries (the documented battery). The count is an approximation ("~") and
NOT gated by any smoke (cross-document-value-invariants doesn't cover it), so it
drifted as the battery grew (cp183 had corrected it to ~266). FIX: updated to
"~357 runners". Doc-only, no behavior change.

### F-010 — committed llms-full.txt stale vs current FAQ · DRIFT (generated artifact) · FIXED (cp308)
The pre-tarball full-battery run surfaced `llms-full-freshness-smoke` failing: the
committed `apps/web/static/llms-full.txt` (the AI-readable whole-site FAQ dump) had
drifted from `en.json` — ~137 sections changed + footer "136 entries" vs en.json's
138 (the cp303 FAQ work added/edited entries; the committed dump was never rebuilt).
Production is unaffected (the web prebuild regenerates it via `build:llms-full`), but
the committed copy was stale. FIX: ran `node scripts/build-llms-full.mjs` → 138
entries / 225583 chars; freshness smoke now ✓ all 6. Generated artifact, no hand-edit.

### Verified CLEAN this chunk (cp308) — no findings
- **G operator-trust (fee math/treasury/enum) — CLEAN.** `OPERATOR_BLURT_SPLIT_PERCENT=90`,
  treasury = exact remainder via integer milliBLURT math (always sums to 100%, no
  float drift), `computeOperatorShareBlurt` validates finite-and-positive, per-event
  `split_percent_at_event` preserves history; BTC/XMR → 100% treasury; treasury =
  `morphit-fees`; fee_method enum frozen (asset-registry comments + the frozen-enum smoke).
- **A static code — CLEAN.** No TODO/FIXME/HACK/XXX/unimplemented/stub markers in
  shipping src across all workspaces (all "placeholder" hits are legitimate txid
  templates / password sentinels / default placeholders).
- **B deps/supply-chain — CLEAN.** Standard posture: `^`/`~` ranges in manifests +
  exact pins in `package-lock.json`; `deps-pin-check` verifies installed satisfies
  declared; `lockfile-sync-smoke` enforces `npm ci` sync; `npm-audit-gate-smoke`;
  standing `audit fix --force` ban.
- **E crypto — CLEAN.** KDF = argon2id (modern; INTERACTIVE tier is the right
  client/mobile choice — SENSITIVE's ~1GB is infeasible on phones); comprehensive
  `sodium.memzero()` of keys/plaintext/CEK/wrapKey after use; WIF/base58 verified
  earlier (Bob/Charlie); no key leak in logs.
- **F privacy — CLEAN.** IP never logged/persisted (ip.ts, brag #14 verified);
  Monero verification uses per-payment TX-PROOFS not a wallet view key (no persistent
  view-key config anywhere; code notes proofs "strictly less leaky"; not logged);
  CSP gated (`csp-header-consistency-smoke`).
- **H frontend a11y/mobile/grandma — CLEAN.** Correct mobile viewport
  (`width=device-width…viewport-fit=cover`); responsive breakpoints, no fixed-width
  layout traps; touch-sized padding across ~44 components; a11y gated by
  a11y-patterns + color-contrast + heading-hierarchy smokes; persona-verified
  never-hang + grandma copy.
- **L matrix-bot + packages — CLEAN.** matrix-bot is send-only (no inbound Matrix
  command handler; tails journalctl + pushes alerts over a loopback sidecar with
  dedicated input-hardening/json-str-injection/sidecar-envelope smokes); packages
  carry no unfinished markers.
- **M docs broken-ref gates — present + README spot-check.** fenced-path-existence
  + section-ref + external-link-hygiene gates cover doc refs; README falsifiable
  claims accurate post-F-009 (version series, apps/locale descriptions); OPERATIONS
  (F-007) + RUN-A + FAQ + brag-list verified earlier.
- **Stale/orphaned-gates check (smoke registration integrity) — CLEAN.** All 350
  smoke files (324 in scripts/apps + 26 in packages/*/scripts) are registered in
  `run-smokes.sh`'s SMOKES array; all 357 registered entries (350 smoke + 7
  meta-runners: 2 lints, xml-validate, live-fire, 2 deps-pin, 2 noble-signer proofs)
  resolve to existing files; 0 orphans, 0 dangling, 0 duplicates; count (357)
  matches the documented battery; a dedicated `smoke-registration-integrity-smoke`
  gates this with an explicit deliberate-exclusions allowlist. (Two false leads from
  my own tooling were caught + reconciled before recording — a grep that kept `.ts`
  vs the runner's extensionless names, and a `find` that skipped `packages/` — not
  code defects.)
- **Efficiency / query sweep + INTERVAL-injection check — CLEAN.** No problematic
  N+1: the per-row `INSERT INTO fee_transfers`/account-create loops in dispatcher.ts
  are bounded by block size (small on Blurt), are writes (prepared-stmt amortized),
  and carry a documented clarity-vs-multirow tradeoff. Signal/anomaly + native-price
  queries are WINDOWED (`WHERE created_at >= NOW() - INTERVAL 'N ...'`), not
  full-table; orderbook hot path uses the `orders_live_idx` partial index; chat/order
  existence checks are `SELECT 1 … WHERE`-indexed. Bonus SQL-injection surface: every
  `INTERVAL '${…}'` interpolation uses a trusted numeric — `SIGNAL_*_WINDOW_DAYS`
  consts (=7 etc.), `Math.floor(...)` integers (federationProbe), and TS-typed
  `number` config defaults (`windowHours`/`graceMinutes`) — so no injection (extends
  the parameterized-query result: the ONLY SQL interpolations anywhere are constant
  savepoint names + numeric intervals).
- **Brag-list claim spot-check (concrete/high-stakes claims) — CLEAN.** Verified
  against code: #14 (IP never logged/persisted/transmitted — ip.ts only transforms
  the IP into a /24 or /64 rate-limit bucket key, no console/fs/db/fetch; bucket
  evicted after the window per the mem-leak sweep) ✓; #32 jitter bounds (≤999
  satoshis UTXO = `jitterUtxoAmount`, ≤99 milliblurt Blurt = `jitterBlurtAmount`,
  plus the XMR/stablecoin/SOL/ETH family) ✓; #33 address-reuse buffer (`MAX_ENTRIES=200`
  rolling, localStorage-only, never transmitted = addressHistory.ts) ✓. Concrete
  numbers match the implementation; the "claims verifiable in code" rule holds for
  the sampled claims.
- **Delegation/vesting/transfer drift class — fully swept (docs + code comments).**
  Repo-wide grep of `delegat*` / welcome-bonus / "10 BP" against the ground-truth
  enqueue kinds (feedback.ts first-trade = liquid+vesting; loyalty.ts first-fee +
  milestones = delegation): the user-facing FAQ + operator docs are accurate (the
  AUDIT-2026-05.md hits are the prior fix's audit log, not live drift); F-008 (the
  loyalty.ts comment) was the only live instance, now fixed.
- **FAQ accuracy spot-check (welcome_bonus deep, kyc/safety) — CLEAN; one code-comment drift fixed (F-008).**
  Reconciled the `welcome_bonus` FAQ (the highest-factual-risk entry, and the one
  a prior campaign fixed for delegation/vesting confusion) against the code: all
  three rewards are accurately characterized — reward #1 (first-fee 1 BP) IS a
  `delegation` (loyalty.ts:206), reward #2 (first trade) is `liquid` 10 + `vesting`
  10 = "10 Blurt liquid + 10 Blurt Power" (vesting = owned, correctly NOT called a
  delegation; feedback.ts:435-436), reward #3 (loyalty milestones) is `delegation`.
  10-locale parity holds (entry present + non-empty in all; zh shorter is normal
  density). `kyc_requirement` + `is_it_safe` accurate. The FAQ is correct — the
  only drift was a code comment (F-008, fixed).
- **Fallbacks / graceful-degradation sweep — CLEAN.** Price feed
  (`CompositeCachedPriceSource`): `current()` always returns a positive number
  (validated `staticFloor > 0` floor), upstream chain tried in priority order,
  all-fail → last-good served with `stale=true`, never-succeeded → static_floor
  with `source='static_floor'` + `stale=true` (staleness EXPOSED, not hidden),
  refresh failures logged not propagated, Defense-B drift bound caps a compromised
  oracle. Chain poller: `cooling_down` backoff on transient RPC errors, `last_applied_block`
  advanced in the SAME DB tx as block effects (mid-block failure rolls back both —
  no skipped/partial blocks; resumes from the DB cursor on restart), `tick_failed`
  logged+backed-off not crashed, fatal/transient split (chain_id mismatch → fatal
  throw, won't index the wrong fork), abort signal threaded through every sleep.
  Joins the already-verified relay `chain_unavailable` 503 + timeout-guarded
  monero/bitcoin fee verifiers.
- **DB dead-field + schema-drift sweep (schema.sql ↔ code) — CLEAN both directions.**
  (1) Extracted all 169 distinct column names across ~40 tables and grepped every
  non-test `.ts`/`.svelte` across all 6 workspaces: 0 columns never referenced by
  name — no vestigial/abandoned columns. (2) Parsed every `INSERT INTO <table> (cols)`
  in indexer code and checked each column against the table's schema columns
  (incl. `ALTER TABLE ADD COLUMN`): 0 mismatches — no code writes to a nonexistent
  column (no broken-write drift). (Scope note: finer write-only vs read-only
  sub-classification isn't statically separable here — some reads use `SELECT *`,
  some column lists are built dynamically; the two checks above are the reliable
  ones and both are clean. Schema mixes upper/lower-case type keywords across
  tables — a parser-case footgun, not a defect.)
- **Memory-leak / unbounded-growth sweep (relay + indexer + matrix-bot) — CLEAN.**
  Every PERSISTENT in-memory structure is explicitly bounded: relay rate-limiter
  `buckets` Map (janitor sweep deletes empty keys + per-key in-place eviction +
  `stop()`); create-handler `dedupe[]` (`evictStaleDedupe()` compacting filter, 60s
  window); `sequentialDetector.records[]` (`prune()` by age + `MAX_RECENT_SIGNUPS=5000`
  cap); invite `consumedNonces` Map (janitor-swept); indexer rate-limiter `buckets`
  Map (janitor `delete`); `loginPairing.entries` Map (30s janitor + 5-min `PID_TTL_MAX_MS`
  + delete on expiry/success/sweep, `.unref()` + `stop()`); `operatorAccountBalanceScanner.state`
  + `blurt clientCache` bounded by the finite operator/endpoint sets. Per-request
  `setTimeout` abort timers fire once (not leaks); daemon `setInterval`s (price
  monitors, janitors) are intended loops carrying `.unref()`/stop hooks. Function-scope
  arrays are GC'd on return.
- **Category-B relay HTTP attack surface (anonymous network-direct) — CLEAN.**
  `/v1/account/create` (spends an ACT → the Sybil/drain target) is defended in
  depth: bounded Zod body, per-IP burst limiter + per-IP daily limiter + global
  daily ceiling with ATOMIC `tryReserve()` and `releaseReservation()` in `finally`
  (author reasons explicitly about the count=ceiling-1 race), signed-invite gate,
  and real pubkey validation (`isValidPublicKey` = `BLT` prefix + `PublicKey.fromString`
  base58/checksum, not a stub) — ordered so policy-rejected inputs never reach the
  signing path. `/v1/account/invite` (the Sybil entry point) carries a tighter
  per-IP issuance limiter + an ALTCHA proof-of-work bond triggered past a per-IP
  daily threshold. Invite tokens: HMAC-SHA256 signed, `timingSafeEqual`-compared,
  single-use via a janitor-swept (bounded) nonce map, expiry-checked, verify/consume
  separated so a failed create doesn't burn the invite. ALTCHA: challenge HMAC
  authenticated (timing-safe), PoW recomputed server-side, salt-replay protected.
  All cryptographically real, not theater.
- **Category-A hostile-op handler sweep (all 17 indexer handlers) — CLEAN.**
  Trust boundary `extractSigner` (src/blurt/verify.ts) yields a single
  chain-authenticated signer: rejects non-array auths, active-auth ops
  (`required_auths.length>0` — no leveraging a hotter key), zero posting-auths,
  and >1 posting-auths (no ambiguous attribution). `parseJsonPayload` rejects
  non-string / over-`MAX_RAW_JSON_LENGTH` / unparseable JSON. Dispatcher coerces
  auths→[] and json→'' defensively, skips unknown op-ids, swallows handler
  rejections (only unexpected throws roll back). Cross-handler greps: every query
  parameterized (the only interpolation is the hardcoded `'welcome_bonus_sp'`
  savepoint name — identifiers can't be bound, not attacker-derived); authz is
  always `ctx.signer` (the `b.from !== signer` checks in featureBid/strangerFee/order
  are correct guards skipping transfers/ops not from the authenticated signer);
  chatIdentity regex-validates base64 before the lenient `Buffer.from` decode.
  Deep-read of the highest-risk handler (order.ts, 996L): `MAX_AMOUNT=1e12` +
  `MAX_EXPIRES_AT_DAYS=365` caps, `Number.isFinite` rejects NaN/Infinity,
  negative/min>max/oversize all rejected, `price_model` size-bounded +
  shape-validated against "chain-direct abuse" (author's own term).

- **Bob QR-pair + my/orders + post/edit:** ScanLoginQr + LoginQrInitiator + /pair
  all terminal-state-complete and grandma-friendly (one-tap QR regenerate, no
  scary errors, camera-permission states handled); my/orders cancel has a generic
  fallback + `finally` un-stick and is idempotent; post/edit has a full
  invalid-state phase machine and is idempotent (same permlink).
- **backup-keys route:** locked → clear error (no hang); posting-only and
  paired-readonly each get a handled section + deep-link; seed reveal decrypts a
  fresh FullIdentity and wipes it after use; keyfile download try/catch/finally.
- **orderbook browse + filters:** phase machine (loading/ready/error+retry),
  debounced + cancellable fetches; side/min_trades/sort `<select>` options all
  wired and mapped to the indexer enum (goods/barter variants translate to
  buy/sell before query — no drift); moderation transparency line; read-only
  register banner is grandma-friendly.
- **feedback path:** fully wired — banner + form lazy-loaded in /my/orders →
  `morphit_feedback_v1` (config.ts + feedback.ts, signed) → indexer dispatcher
  → feedbackHandler + feedbackResponseHandler → RespondToFeedbackForm + explorer
  decoration. No unwired links.


Tool-dispatch envelope (`main.ts` CallToolRequestSchema) verified never-hang:
unknown tool → `isError`; Zod parse failure → caught → `isError` with message;
handler throw → caught → `isError: Tool error: <msg>`. Stateless HTTP rebuild
per request (no session leak). Remaining: per-tool input-schema + handler reads
(searchOrders, listInstances, listPaymentMethods, getListing, describeMorphit) —
validation bounds, SSRF guard in indexerClient, output shape stability.

### Charlie (MCP) walkthrough — ☑ COMPLETE (cp308)
All 5 tools have bounded Zod schemas (asset/side/sort enums, min/max strings,
limit 1–100, min_trades ≤100) — every field/option Charlie can try is validated;
invalid input → `isError`, never a hang. `indexerClient.ts` SSRF guard verified:
https/http-only scheme check, private-address denylist (cp154 F-mcp-1, opt-out
via env), credential-stripping in error messages, body-size cap. Stateless HTTP,
loopback bind, rate limit, slowloris timeouts, path allowlist (§45). Coverage: 5
smokes all green — private-instance-policy 22, mcp-server 8, fetchjson-body-cap 3,
mcp-http-transport 12, agent-field-allowlist 8 (= 53 scenarios). tsc 0. One
finding fixed (F-001 version drift). NO issues left on Charlie's surface.

### F-002 — morphit-ops Status dashboard "No database URL configured" (#16) · FIXED (cp308)
Root cause: `defaultRepoRoot()` (apps/ops-cli/src/lib/repoRoot.ts) derived the
install root by walking UP from `process.cwd()` only. Run `morphit-ops` from
anywhere outside the install tree (e.g. operator's home dir) → the walk finds no
`workspaces` package.json, falls back to the cwd → `loadInstanceEnv()` looks for
`morphit.config.env`/`morphit.env` in the wrong place → DB URL (and other infra
env) never loaded → Status dashboard throws. Fix: when the cwd-walk doesn't land
on a workspaces root, fall back to walking up from THIS module's own location
(`import.meta.url`), which is always inside the installed tree (dist or src),
with the same stale-.bak recovery applied. Verified: repo-root-bak-recovery 6/6
(all .bak cases preserved), instance-env-loader 14/14, ops-cli tsc 0.
RESIDUAL (deployment data, not code): `<install>/morphit.env` must contain
`MORPHIT_INDEXER_DATABASE_URL` (or `DATABASE_URL`) for the loader to apply it;
the infra-env path is loaded unfiltered, the allowlist applies only to the
operator-tunable `morphit.config.env`.

### F-003 — morphit-ops color stripped on the interactive menu · FIXED (cp307, re-confirmed cp308)
(See cp307.) The menu rendered before `initColor` ran; fixed with
`initColorMode(readColorMode())` before the menu. The "update available"
bright-yellow marker + relay-balance warnings now colorize. ops-cli vitest 24.

### #15 Matrix alerts editing — DIAGNOSED (cp307/cp308), implementation deferred
`apps/ops-cli/src/commands/matrix.ts` edits ONLY the alert-MXID line in
`/etc/morphit/matrix-bot.env` and requires that file to already exist (else
`no-env-file`). It does NOT edit the public chatroom alias (separate indexer
config / `/v1/instance`). Ken wants: edit + clear MXID AND chatroom, and set the
MXID even before the bot is installed. Needs careful work on host file layout +
live verification (interactive CLI not runnable in-sandbox) — tackle on Ken's box.

### Josie (ops-cli) walkthrough — ◐ in progress (cp308)
Full smoke battery GREEN (~47 smokes: install/upgrade/edit/matrix-lifecycle/
status-backups/health-view/doctor/moderation/ansible/term-sanitize/menu-
annotations/…). Color fix (F-003) verified. #16 (F-002) FIXED. #15 diagnosed,
deferred. Remaining for full completion: per-command graceful-degradation trace
(every menu item when the node is half-installed / DB down / chain unreachable —
confirm none leave Josie hanging), and the #15 implementation.
