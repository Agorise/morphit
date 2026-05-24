# CP131 Deep-Deep Audit — Findings Log

**Started:** 2026-05-23
**Scope:** Three-persona walkthrough + 94-task deep-deep + hostile-handler sweep + ABSOLUTELY EVERYTHING
**Baseline:** cp130 (5,470 smoke battery / 41 ADRs / 318 brag entries / 16 assets / 29,790 locale strings)

## Categories

- WALK — found during persona walkthrough (Bob/Sally-user/Sally-operator)
- HOST — found during hostile-handler sweep
- DOC — documentation accuracy
- DRIFT — stale numbers / claims / references
- TYPE — type errors / narrow union issues
- TEST — smoke/test coverage gap
- SMOKE — outdated smoke / wrong regex / gate
- WIRING — built-but-not-wired / dead key / orphan
- MEM — memory leak / unbounded growth
- SEC — security vulnerability
- FALLBACK — missing fallback/failover or "user hanging" UX
- REGEX — regex accuracy in smokes/validators
- LOCALE — i18n drift
- DB — dead field / orphaned migration

## Severity

- CRIT — must fix before any further work
- HIGH — must fix this checkpoint
- MED — fix this checkpoint
- LOW — fix this checkpoint
- INFO — note + maybe defensive smoke

## Findings


### HIGH-001 [HOST/DOC/WIRING] — backup script ignores AGE_RECIPIENT + REMOTE_DESTINATION + SSH_KEY env vars

**Surface:** `ops/backup/morphit-backup.sh` (the canonical backup script promoted from doc copy-paste at Part 32) + `ops/ansible/roles/morphit/templates/backup.env.j2` (Ansible generates this with placeholder values).

**Symptom:**
1. Ansible deploy creates `/etc/morphit/backup.env` with `AGE_RECIPIENT=age1XXXXX-replace-with-real-age-public-key-XXXXX` (placeholder).
2. The placeholder value is NOT validated anywhere — Ansible doesn't assert, the script doesn't read it.
3. `morphit-backup.sh` writes plain `pg_dump | gzip > foo.sql.gz` — no encryption, no remote push.
4. `REMOTE_DESTINATION` and `SSH_KEY` are also wired by Ansible and ignored by script.
5. OPERATIONS.md §37.12 shows the operator a snippet they must hand-edit into the script to actually get age encryption — directly contradicting the brag list claim that backups are encrypted (§37 hardening map: "Backup theft → offline crack | age-encrypted backups | 37.12").

**Threat:** Sally-operator's daily backups are plaintext SQL of the entire indexer DB (orderbook history, chat ciphertexts, account metadata, payment-method registrations). If she also wires `REMOTE_DESTINATION` thinking the script handles off-host transfer (the Ansible template *implies* it does), she'd be confused why no remote copies appear. Worst case: she trusts the brag-list claim and doesn't audit; reads `/etc/morphit/backup.env` and sees AGE_RECIPIENT=age1XXXXX, assumes it works, ships unencrypted backups.

**Severity:** HIGH — privacy violation in operator's first 24h.

**Fix:** Rewrite `morphit-backup.sh` to actually use `AGE_RECIPIENT` (if set) and `REMOTE_DESTINATION` (if set), with clear "operator must replace placeholder" guardrails. Add Ansible asserts that placeholder values aren't shipped to production. Update OPERATIONS.md §37.12 to point at the script as-now-functional rather than recommending a hand-edit.


### HIGH-002 [SMOKE/REGEX] — ansible-env-var-consumer-smoke only checks MORPHIT_* prefix; misses non-prefixed dead vars

**Surface:** `apps/ops-cli/scripts/ansible-env-var-consumer-smoke.ts` lines ~91 and ~118.

**Bug:** Both regexes hard-prefix on `MORPHIT_`:
- Line 91: `if (!varName.startsWith('MORPHIT_')) continue;`
- Line 118: `const re = /MORPHIT_[A-Z][A-Z0-9_]*/g;`

Templates can declare arbitrary uppercase env vars (`AGE_RECIPIENT`, `REMOTE_DESTINATION`, `SSH_KEY`, `DB_HOST`, `DB_PORT`, `BACKUP_DIR`, etc.). The smoke silently ignores them. This is what let HIGH-001 ship.

**Fix:** Drop the `MORPHIT_` prefix gate; check every `^[A-Z][A-Z0-9_]*=` LHS in templates against the union of token references in apps/ + ops/scripts/. The smoke is small enough that a wider net doesn't slow it down meaningfully.

**Severity:** HIGH — it's a smoke regex that's actively letting the F13 class slip through, exactly the bug class the smoke was created to prevent.


### MED-003 [DRIFT/SMOKE] — init.ts JSDoc says "~17 prompts" but TOTAL_STEPS=18; smoke sentinel enforces wrong number

**Surface:** `apps/ops-cli/src/commands/init.ts:6` ("~17 ELI5-style configuration prompts") and `apps/web/scripts/persona-walkthrough-smoke.ts:456` (`mustHave: ['~17 ELI5', 'check steps.ts']`).

**Bug:** `TOTAL_STEPS = 18` in `apps/ops-cli/src/init/steps.ts`. `apps/ops-cli/README.md:34` already says "18 setup steps". But the JSDoc in `init.ts:6` says "~17", and the smoke's sentinel at line 456 *enforces* the stale value.

The DD-cp27-DD-20 fix already corrected the same drift in OPERATIONS.md / RELEASE-NOTES / PRE-LAUNCH-CHECKLIST / persona-smoke F14 — but missed F14b (the line-456 sentinel still says "~17 ELI5") and the init.ts JSDoc.

**Fix:** Update `init.ts:6` JSDoc → "~18 ELI5-style configuration prompts" + smoke sentinel → `['~18 ELI5', 'check steps.ts']`.

**Severity:** MED — operator-facing JSDoc and a smoke sentinel covering up drift.


### MED-004 [DOC/DRIFT] — README.md ADR range 0036 (actual: 0042)

**Surface:** README.md L34 and L53.

**Bug:** Both lines say `docs/adr/0001-…` through `0036-…` — actual file range is 0001–0042 (0016 retracted). The brag-list-claim-parity-smoke validates `N ADRs` / `N architecture decision records` shape but doesn't match the `NNNN-…` filename-range claim shape.

**Fix:** Update both lines to `0042-…`. Extend brag-list-claim-parity-smoke with a new claim class for `(?:docs/adr/)?\d{4}-(?:…|.+\.md)\s+through\s+(?:docs/adr/)?(\d{4})-` so this drift can't repeat.

**Severity:** MED — public-facing surface.


### LOW-005 [WIRING/MEM] — main.ts runs two independent BLURT price sources when priceFeedEnabled

**Surface:** `apps/indexer/src/main.ts` lines 122–148.

**Bug:** `priceSource` (BLURT-only, from `createPriceSource`) and `multiAssetSources` (which INCLUDES BLURT, from `createMultiAssetPriceSources`) are both created and started when `priceFeedEnabled=true`. They have independent caches, independent refresh ticks, and each makes its own outbound HTTP calls to Klingex/Coingecko/morphit_native. The comment at L138-142 explicitly acknowledges this duplication and labels it as a cp131 consolidation task.

**Cost:** 2x outbound HTTP per refresh interval (default = 5 minutes), 2x cache memory for the BLURT row, 2x failure surface. Honest about the tradeoff but suboptimal for priority #4 (tiny footprint).

**Fix:** Consolidate. Make the listing-fee endpoint and receipt endpoint both read from `multiAssetSources.get('BLURT')`. Delete the standalone `priceSource` path. The listing-fee endpoint's hot-path concern is well-founded — but `multiAssetSources.get('BLURT')` is a single Map.get(), the BLURT source's getCurrentPrice() is the same implementation. Risk = effectively zero with smoke coverage.

**Severity:** LOW (priority-#4-aligned cleanup; the existing code is correct, just wasteful).


### HIGH-006 [DOC/DRIFT] — Docs claim @morphit broadcasts `morphit_warrant_canary_v1` weekly; the actual canary is a PGP-signed static file

**Surfaces:**
- `docs/OPERATIONS.md:386` "periodic `morphit_warrant_canary_v1` ops (weekly automated; see §36)"
- `docs/OPERATIONS.md:396` "Periodic `morphit_warrant_canary_v1` broadcasts — sub-BLURT each, weekly automated; over a year that's ~52 ops"
- `docs/OPERATIONS.md:425` table: "`@morphit` | Trust anchor (release + warrant canary) | ~10 BLURT"
- `docs/PRE-LAUNCH-CHECKLIST.md:140` "Periodic `morphit_warrant_canary_v1` ops (weekly automated, see OPERATIONS §36)"

**Reality:** §36 of OPERATIONS.md itself describes the canary as a static file at `/canary.txt`, generated by `scripts/canary/generate.sh`, **PGP-signed by the operator's release key** — there is no Blurt op broadcast, no `@morphit` posting-key signature, and no BLURT mana spent. There is no `morphit_warrant_canary_v1` op-id constant anywhere in the indexer dispatcher or relay; the op type doesn't exist.

**Threat:** Operator following PRE-LAUNCH-CHECKLIST funds `@morphit` thinking it'll be spent on weekly canary broadcasts and looks for an on-chain op-id that doesn't exist. The "~10 BLURT" sizing is over-allocated (only `morphit_release_v1` ever broadcasts from this account; canary is off-chain). More importantly, an operator setting up the canary may search the indexer for `morphit_warrant_canary_v1` ops to verify the canary, find none, and incorrectly conclude the canary isn't working.

**Severity:** HIGH — operator-facing doc drift naming a chain op that doesn't exist; misframes a security primitive (canary = file + PGP, not chain op + posting key).

**Fix:**
- Remove the four `morphit_warrant_canary_v1` doc references.
- Rewrite the bullets to accurately describe: PGP-signed static file at `/canary.txt`, regenerated weekly by `scripts/canary/generate.sh`, signed by operator's release PGP key (separate from `@morphit` Blurt posting key).
- Update the "~10 BLURT" sizing rationale: only the `morphit_release_v1` op spends BLURT from `@morphit` — sub-BLURT once, with multi-year headroom. (The 10-BLURT figure remains adequate, the *reason* changes.)
- Update the "Trust anchor" table row to remove "+ warrant canary" — the canary's trust anchor is the operator's PGP key, not the `@morphit` Blurt account.
- Extend the persona-walkthrough-smoke with a sentinel that asserts `morphit_warrant_canary_v1` does NOT appear in operator docs (it's not a real op).


### LOW-007 [DOC/DRIFT] — Chat-payload `_v1` suffix mismatch between docs and code

**Surfaces:**
- `docs/adr/0037-physical-shipment-tracking.md` lines 11-12, 67, 75, 178, 196 — uses `morphit_addr_v1`, `morphit_funds_sent_v1`, `morphit_mailing_address_v1`, `morphit_shipment_v1`.
- `apps/web/src/lib/chat/payload.ts` — code uses bare `kind: 'morphit_addr'`, `kind: 'morphit_funds_sent'`, `kind: 'morphit_mailing_address'`, `kind: 'morphit_shipment'` (no `_v1` suffix on the wire).

**Reality:** The chain-level op carrying these payloads is `morphit_chat_v1` (a single op id with versioned outer envelope). The inner `kind` fields are NOT versioned with `_v1` — that's only the outer chain op. Per ADR-0015, versioning happens at the outer envelope.

**Impact:** Doc reader could try to grep the codebase for `morphit_addr_v1` and find nothing, concluding the feature isn't implemented (when it is, just spelled `morphit_addr`). Low security impact but a future-contributor confusion vector.

**Fix:** Drop the `_v1` suffix in ADR-0037 prose. Either change wire format (HARD breaking change, NO — chain history is forever) or fix the docs.

### LOW-008 [DOC/DRIFT] — `morphit_chat_message_v1` mentioned in PHASE-5 docs; real op is `morphit_chat_v1`

**Surfaces:**
- `docs/PHASE-5-PLAN.md:335`: "5c-M3: `morphit_chat_message_v1` op + indexer handler."
- `docs/PHASE-5-BACKLOG.md:589`: `morphit_chat_identity_v1` and `morphit_chat_message_v1`
- `docs/REVISIT-LIST.md:29650`: ADR-0014 lines 106, 242: `morphit_chat_message_v1`
- `docs/REVISIT-LIST.md:29761`: `morphit_chat_message_v1` in PHASE-5 docs

**Reality:** Dispatcher's OP_IDS uses `morphit_chat_v1`. The `_message` suffix is a historical pre-merge name. ADR-0014 and PHASE-5 docs predate the rename and were never cleaned up.

**Fix:** Update both PHASE-5 docs to say `morphit_chat_v1`. ADR-0014 lines 106 + 242 already noted as drift in REVISIT-LIST §B; fix those too.


### MED-009 [HOST/SEC] — push unsubscribe has no signature check AND no rate limit

**Surface:** `apps/relay/src/api/push.ts` lines ~218-247.

**Issue:** `POST /v1/push/unsubscribe` accepts `(account, endpoint)` and unconditionally deletes the matching subscription row. There is NO signature check (subscribe got cp14's posting-key signature; unsubscribe didn't) and NO rate limit (the source comment explicitly says "users should always be able to remove a subscription").

**Threats:**
1. **DB-leak weaponization**: any party that learns or guesses (account, endpoint) pairs from a DB leak (or a malicious operator publishing them) can unsubscribe every user, breaking all notifications federation-wide. The endpoint URLs are opaque-random from the push service, so brute-force is impractical — but a DB leak gives them up wholesale.
2. **No-rate-limit enumeration**: an attacker who can guess endpoint URLs (or has lookup access) can fire arbitrary unsubscribe attempts at this endpoint without throttling. The fail path returns 200 either way ('unsubscribed' regardless of prior state), so the attacker doesn't even need to know if their guess worked.

**Severity:** MED — not critical (notifications are convenience-tier, the user can re-subscribe), but trivial DoS on the convenience feature and a Memory #19 (privacy first) implication: an operator-side adversary or DB-breach gives the attacker push-management control over every user. Should at least have the signature check + rate limit.

**Fix:**
1. Apply cp14-equivalent signature verification to unsubscribe. Canonical message: `morphit:push:unsubscribe:<account>:<endpoint_sha256_hex>:<timestamp>`.
2. Apply the same `subscribeLimiter` (or a dedicated `unsubscribeLimiter`) as a defense-in-depth bucket. Per-IP rate limit on this endpoint doesn't break legitimate clients (a user unsubscribes from one device at a time, and re-subscribe is a separate API call).
3. Add a smoke that pins both invariants.


### DEEP-001 [DOC/DRIFT] — FAQ `what_is_morphit` enumerates only 10 of 16 supported assets

**Surface:** `apps/web/src/lib/i18n/locales/{en,es,fr,de,it,pl,ru,fa,zh-CN,zh-HK}.json` → `faq.entries.what_is_morphit.a`

**Reality:** The headline FAQ — the FIRST thing a new user reads — enumerates `Bitcoin, Monero, BLURT, USDT, USD Coin (USDC), Dai, Bitcoin Cash, Litecoin, Dash, and Dogecoin` (10 assets). Codebase actually supports 16: also ZEC, ARRR, DCR, SOL, ETH, XRP. Stale since cp124+ asset additions never propagated to this answer.

**Severity:** MED — user-facing copy on the most-read FAQ entry. Underclaims capability.

**Fix:** Update the answer in all 10 locales to enumerate all 16 tradable assets. Also audit the other FAQ entries that enumerate asset lists (11 more flagged: `blurt_benefits`, `where_to_buy_blurt`, `welcome_bonus`, `what_is_usdc`, `why_usdt_warning`, `why_usdc_warning`, `what_is_doge`, `what_is_zec`, `what_is_sol`, `what_is_eth`, `how_to_spread_morphit`) — each might be intentionally narrower (e.g. `what_is_doge` may legitimately mention only DOGE-relevant alternatives) but each needs human-judgment review.


### DEEP-002 [DOC/STRUCTURAL] SHIPPED — Schema versioning framing reconciled with reality

**Surface:** `apps/indexer/src/db/migrations.ts` + `apps/indexer/src/db/schema.sql` + `docs/PRE-LAUNCH-CHECKLIST.md`

**Was:** `migrations.ts` MIGRATIONS array had `subsumesVersions: [2..27]` and a comment promising "future migrations land here at v28, v29..." — but `schema.sql` actually grew in place with section markers for v28, v33.1, v33.2, v34, v35.

**Shipped (Option 1):** Extended `subsumesVersions` to `[2..35]` so the audit trail in `schema_migrations` correctly records all collapsed-historical versions as applied. Updated the migrations.ts comment to reflect actual practice: "v1 collapsed schema is the pre-launch baseline that grows in place until 1.0.0 launch; the first separate additive migration to be assigned an integer version will land at launch." Updated description from "v1-v27 merged, May 2026 audit" to "v1-v35 merged in-place; pre-launch baseline". Updated PRE-LAUNCH-CHECKLIST.md D-section schema framing to match (collapsed 1-35, not 1-27; framing now says "v1 baseline grows in place until 1.0.0 launch"; cited cp123 H2's review_concentration and cp127's price_drift_baseline as examples of v33+ features).

Module load test confirmed: `validateMigrationsContract()` accepts the extended range; declared + subsumed coverage is gap-free starting at 1; no overlap; subsumed versions all > declared (1).

**Severity downgraded post-fix:** functionally no change (no downstream code checks specific high versions), but documentation now matches implementation matches audit trail.


### DEEP-003 [SMOKE/REGEX] SHIPPED — schema-migration-coverage banner regex missed cp123/cp127-era box-decorator format

**Surface:** `apps/indexer/scripts/schema-migration-coverage-smoke.ts`

**Was:** Banner-parser regex `/^--\s+v(\d+)(?:\s*$|\s+\/\s+)/` only recognized the cp82-era format `-- v<N>` or `-- v<N> / Part ...`. Schema v34 (review_concentration, cp123 H2) and v35 (price_drift_baseline, cp127 defense B) were added with the box-decorator format `-- ─── v<N>: <description> ───`. The smoke silently undercounted, reporting `schema head = v33` when the actual head was v35.

**Severity:** MED — a silent-undercount in a coverage smoke is exactly the HIGH-002 class. The smoke would still catch a NEW v36 added in the wrong format (sanity check "no banner above pinned head" would fire) but couldn't have caught v34/v35 themselves before they shipped.

**Shipped:**
1. Banner regex widened to accept both formats:
   - Format A (cp82-era): `^--\s+v(\d+)(?:\s*$|\s+\/\s+)/`
   - Format B (cp123/cp127-era): `^--\s+\W+\s*v(\d+)\s*:` (any non-word decorator between `--` and `v<N>`, colon separator)
2. `SCHEMA_HEAD_VERSION` pin bumped 33 → 35 (reflects actual schema.sql state).
3. `MIGRATIONS_COVERAGE_HIGH` pin bumped 27 → 35 (reflects DEEP-002 `subsumesVersions` extension).

**Verification:** smoke now reports banners `[32, 33, 34, 35]` and coverage `[1..35]`, all 4 scenarios pass. Tamper-tested: bumping SCHEMA_HEAD_VERSION to 36 fails the smoke as expected.

**Co-discovered finding:** the existence of two coexisting banner formats in schema.sql is a stylistic drift. Pre-launch is the right time to normalize but Ken chose not to rewrite v34/v35 headers — the widened regex is the structural fix; the format coexistence is documented in the smoke's docblock.

