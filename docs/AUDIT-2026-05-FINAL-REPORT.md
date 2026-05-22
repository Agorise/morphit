# Morphit pre-launch audit — Final report

**Audit window:** May 2026
**Scope:** Comprehensive 110-item static/security audit covering static
code, deps/supply-chain, SQL/DB, HTTP/API, crypto, privacy, operator-trust,
frontend, contracts, build/CI, threat modeling, and per-subsystem deep dives.

**Outcome:** ~57 findings; all but 1 pre-existing backlog item shipped or
deferred to REVISIT-LIST.  Smoke baseline maintained at 1989 scenarios
across triple-pulse stability checks throughout the campaign.

## Findings by severity

| Severity | Count | Status |
|---|---|---|
| CRITICAL | 4 | All shipped |
| HIGH | 7 | All shipped (1 deferred backlog) |
| MEDIUM | 7 | All shipped |
| LOW | ~37 | All shipped |
| NIT | 2 | Both shipped |

### CRITICAL findings

- **A5** — covered in Phase A (deps/supply-chain) — **shipped**
- **A9** — covered in Phase A — **shipped**
- **G1** — missing v24 schema migration — **shipped**
- **H8** — ACT model drift: relay's `create.ts` used inline-pay
  `account_create` op while ADR-0010 §4 + scripts + operator docs
  specified `create_claimed_account` consuming pre-minted ACTs —
  **shipped**, full vertical fix across `client.ts`, `health.ts`,
  `create.ts`, fixtures, brag list, FAQ entries, and 9-locale
  retranslation backlog logged

### HIGH findings

A4, A6, A7, B1 (waiver-floor bypass), B3 (operatorAccountName split),
G2 (broken schema-v8 errored on every fresh deploy), G6 (loyalty
SAVEPOINT poisoning — silent order loss).  All shipped with smoke
regression coverage.  Pre-existing relay tsc lint backlog (B4)
deferred — non-blocking for launch.

### MEDIUM findings

A8, A10, C1+C2 (relay endpoint repass), J5 (`order_timeouts` FAQ
referenced unimplemented 5-day pay window + business-hours toggle),
J8 (`operator_payouts_timing` FAQ referenced non-existent "Smart
Contract" + claimed BTC/XMR earnings flow to operators), K2 (§28
fail2ban-for-relay subsection described non-existent middleware
+ wrong log shape + IP-privacy violation), **O1** (duplicate-tx
after retry not handled — silent successful broadcast misreported
as failure, causing user to retry with different name while
original account quietly existed on-chain).

## Phase-by-phase summary

### Phase A — doc accuracy
10 doc-accuracy fixes shipped.

### Phase B — hostile-operator sweep
B1 HIGH waiver-floor bypass, B3 HIGH operatorAccountName split.
B4 (pre-existing relay tsc lint backlog) deferred.

### Phase C — relay endpoint repass
C1 + C2 MEDIUM with 13-test regression at
`apps/relay/test/middleware/ip.test.ts`.

### Phase D-F — threat modeling
- STRIDE matrix at `docs/audit/2026-05-stride-matrix.md`
- Attack tree at `docs/audit/2026-05-attack-tree.md`
- Red-team narrative at `docs/audit/2026-05-red-team-narrative.md`

### Phase G — DB schema audit
8 findings (G1 CRITICAL, G2 + G6 HIGH, others LOW).  G6 fix wraps
welcome and milestone INSERTs in nested SAVEPOINTs to prevent
transaction-abort cascades.  4-test regression at
`apps/indexer/test/integration/loyalty-g6-regression.test.ts`.

### Phase H — ADR-vs-code drift
22 ADRs walked.  H8 CRITICAL ACT-model fix is the headline item;
H1-H7 LOW status updates and ref renumbering.

### Phase I — i18n parity
Structurally clean (2161 keys × 10 locales).  48 strings
byte-identical to English captured in
`docs/i18n-untranslated-2026-05.txt` for retranslation backlog;
**all 48 translated 2026-05-08 (Part 89, brag list entry #237)** —
file retained as a tombstone for historical traceability.

### Phase J — FAQ accuracy
All 103 entries walked.  9 fixes (J1-J9): 1 MEDIUM, 7 LOW,
1 dead-code REVISIT for unused `feeStatusLabel` UI branches.

### Phase K — OPERATIONS.md walk
4137 lines / 28 sections.  K1a + K1b LOW (env-var name drift),
K2 MEDIUM (§28 fail2ban subsection rewrite).  RUN-A-MORPHIT-NODE.md
(1110 lines) walked clean.

### Phase L — frontend dead-code
90 .svelte files (53 components + 37 routes) walked.  12 unused
imports / dead-code fixes shipped.  Now zero unused locals
under `tsc --noUnusedLocals --noUnusedParameters` across the
entire frontend.  Zero Svelte 4 legacy syntax remaining
(fully Svelte 5).

### Phase M — memory leaks
Zero unbounded Map/Set growth, zero unbounded array.push without
eviction across indexer + relay.  Zero EventSource leaks, zero
listener leaks in components.

### Phase N — unused files
292 .ts source files walked.  Zero unused (5 flagged were SvelteKit
framework conventions, smoke runners, component imports).
1 unused image (`morphit-fee-flow.svg`) logged as
"decide source-of-truth" REVISIT item — **CLOSED 2026-05-06: SVG
chosen as source-of-truth, the orphaned PNG was deleted, and
FEES-AND-REWARDS.md now references the SVG directly.**

### Phase O — fallback / failover audit
All major failure surfaces walked; **O1 fix shipped** for the
real gap.  Battle-tested rotation patterns in BLURT RPC, XMR
explorer, price-feed composite, frontend endpoint rotation,
EventSource auto-reconnect, drainer exponential backoff.

## Standing pre-launch action items (not audit findings, just
campaign-relevant tracking)

The following were on Ken's radar at the time this final report
was written.  All three have since been closed; the report is
preserved as a historical artifact and the audit-trail below
records what shipped:

- ~~Rotate the `CHANGE_ME_BEFORE_PRODUCTION` placeholder in
  `ops/postgres/init.sql` before any production deploy.~~
  **CLOSED — pattern inverted to denylist.**  Rather than
  removing the placeholder, `ops/postgres/init.sql` now treats
  it (along with `CHANGEME`, `CHANGE_ME`, `__SET_BEFORE_DEPLOY__`,
  `password`, `postgres`) as a denied value: any operator who
  fails to replace it before running init.sql hits a clear
  `RAISE EXCEPTION` with the placeholder name in the message.
  Same denylist enforced at runtime in the indexer's and
  relay's Zod config schemas, so a misconfigured production
  boot refuses to start.  See OPERATIONS.md §30 for the
  full provisioning + runtime guardrail rationale.
- ~~Commit `package-lock.json` for reproducible installs.~~
  **CLOSED by Part 70** — `package-lock.json` is committed at
  the repo root for reproducible `npm ci` installs.
- ~~Wire `svelte-kit sync + tsc --noEmit` into CI.~~
  **CLOSED by Part 70 (initial), made explicit Part 122 cp111.**
  The protection has been in place since Part 70 via the
  `workspace-typecheck-smoke` script (root-level smoke listed
  in `scripts/run-smokes.sh`), which runs `npx svelte-kit sync`
  followed by `npx svelte-check` against apps/web — wired into
  CI through the `smokes` job that invokes `run-smokes.sh`.
  cp111 added a dedicated **`web-check`** job in
  `.forgejo/workflows/ci.yml` that runs the same two binaries
  directly, so the protection is legible in the CI surface
  without indirection through the smoke runner; the smoke
  remains as a defense-in-depth layer that also runs locally
  via `bash scripts/run-smokes.sh`.  See cp111 entry in
  `TARBALL.md` for the wiring rationale.

## REVISIT-LIST highlights (deferred work)

- ~~9-locale retranslation of FAQ entries that were edited in
  English (signup_stuck, why_multi_accounts_fail, order_timeouts,
  operator_payouts_timing, etc.) — non-EN locales currently show
  the pre-edit text.~~ **CLOSED — all retranslated by Part 89.**
- ~~48 i18n untranslated strings in non-EN locales (SEO meta
  + fallback states) — captured in
  `docs/i18n-untranslated-2026-05.txt`.~~ **CLOSED — all
  translated by Part 89; file retained as tombstone.**
- ~~Dead `feeStatusLabel` UI branches in My Orders
  (`missing`, `underpaid`, `unverified`) — indexer never writes
  these states; either delete the dead UI branches or wire the
  indexer to actually emit them.~~ **CLOSED — Part 103 re-audit:
  the original diagnosis was inverted.  `feeStatusLabel` was
  MISSING explicit cases for `missing` and `underpaid` (which
  the indexer DOES write — verified in
  `apps/indexer/src/indexer/handlers/order.ts:649,714` and the
  order-handler smoke), so an order in either state rendered an
  empty amber pill.  Fixed by adding the two cases plus a
  defensive default that returns the raw status string.  Two i18n
  keys added (`my_orders.order.fee_missing`,
  `my_orders.order.fee_underpaid`) translated to all 10 locales.
  `'unverified'` is the DB-level DEFAULT and remains a defensive
  UI branch in order_detail (no handler path lets it land today
  but the column constraint admits it).**
- Optional opt-in IP logging on relay access_log
  (`MORPHIT_RELAY_ACCESS_LOG_INCLUDE_IP`) for operators who
  want fail2ban integration without giving up the privacy
  default.
- ~~Decide source-of-truth for fee-flow brand asset
  (PNG referenced from docs, SVG orphaned).~~ **CLOSED 2026-05-06:
  SVG chosen, PNG deleted, FEES-AND-REWARDS.md now points at SVG.**

## Test coverage at audit close

| Suite | Count | Status |
|---|---|---|
| Indexer default tests | 370 / 370 + 1 skipped | ✅ |
| Indexer integration tests | 67 / 67 across 9 files | ✅ |
| Relay tests | 178 / 178 (incl. 2 new O1 regressions) | ✅ |
| Smokes (triple-pulse) | 1989 / 1989 | ✅ stable |
| Frontend typecheck | 0 errors | ✅ |
| Frontend `noUnusedLocals` | 0 issues | ✅ (was 18) |
| `svelte-check --threshold warning` | 0 / 0 | ✅ |

## Known flake

~~`drain-defense-live-fire` smoke scenario occasionally drops 23
scenarios on one pulse — known timing race, not introduced by
this audit campaign.~~  **Root-caused and fixed post-audit:** the
flake was a tamper-last-char padding collision in the live-fire
scenario.  Fixed by tampering the first char instead — eliminates
the padding ambiguity entirely.  Triple-pulse stable since.

## Audit close statement

The codebase is exceptionally clean for a pre-launch project of
this complexity.  The audit found real gaps (especially H8 ACT
model drift, K2 fail2ban privacy violation, O1 duplicate-tx
silent failure) that pre-launch fixing was the entire point of —
those bugs are now bugs prevented, not bugs that hurt anyone.

The Phases L, M, N sweeps came up nearly empty after fixing the
unused-locals — that's the signature of a well-maintained
codebase, not a sloppy one we polished.  Ship with confidence.
