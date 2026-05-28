# Morphit pre-launch revisit list

**Last touched:** Part 122 cp161 (CLOSED) — 2026-05-27 (operator-reported `morphit-ops command not found` after git pull: root-caused to workspace-bin fragility + tsx-as-devDependency; promoted tsx to production dep, hardened Ansible build/verify, documented the git-pull→npm-install requirement across OPERATIONS.md + RUN-A-MORPHIT-NODE.md + Ansible sysadmin-handoff).  Sentinel battery 6245/0 triple-pulse stable.

## cp162 — ops-cli proper build artifact (SCOPED, NOT DONE)

**The real fix** for the operator's `morphit-ops command not found` class of problem: give apps/ops-cli a compiled `dist/` build the way apps/mcp-server has, so `bin` points at `dist/main.js` (with a `#!/usr/bin/env node` shebang) instead of `src/main.ts` (with a `tsx` shebang).  This removes the runtime dependency on tsx entirely and makes ops-cli installable like any normal CLI.

**Why deferred (not done at cp161):** apps/ops-cli is NOT a clean compile target the way mcp-server was.  Two structural blockers, both requiring careful migration:

1. **92 `.ts`-extension import specifiers across 24 files.**  ops-cli's tsconfig has `allowImportingTsExtensions: true` + `noEmit: true` — the imports are written as `from './foo.ts'`.  `tsc` emit rejects `allowImportingTsExtensions` unless paired with rewriting, and even a successful emit would leave `.ts` paths in the output that Node can't resolve at runtime.  All 92 must become extensionless (or `.js`) imports.  mcp-server avoided this entirely — it was written extensionless from the start.

2. **2 cross-workspace reaches outside rootDir:**
   - `from '../../../relay/src/crypto/keyEnvelope.ts'` (encrypt.ts + 2 dynamic imports in paymentMethod.ts, register.ts)
   - `from '../../../indexer/src/lib/feeAmountCalc.ts'`
   These `../../../` paths escape ops-cli's `rootDir: src`, which breaks a clean `tsc -p tsconfig.build.json` emit (files outside rootDir either error or emit to unexpected nested dist paths).  The proper fix is to promote the shared modules (keyEnvelope, feeAmountCalc) into a `@morphit/*` package — same pattern as cp154's `@morphit/net-defense` lift — then import by package name.  That is itself a meaningful refactor with its own deep-verification pass.

**Scope estimate:** rewrite 92 imports + lift 2 shared modules into packages (or relax rootDir + accept nested dist) + add `tsconfig.build.json` + `build` script + `files: ['dist/','src/']` + flip `bin` to `dist/main.js` + add `#!/usr/bin/env node` shebang to a built entry + regenerate lockfile + update the Ansible build comment (ops-cli would then have a real `build` script that `--if-present` picks up) + full triple-pulse + verify the bin runs from dist.  A focused checkpoint of its own.

**Interim mitigation (cp161, DONE):** tsx promoted to production dependency so the existing `src/main.ts` + tsx shebang works reliably under `NODE_ENV=production` and `npm install --omit=dev`; Ansible verifies bin runnability post-install; docs explain the npm-install-after-pull requirement everywhere an operator might enter.  The operator's immediate failure is fully resolved; cp162 is the architectural cleanup that removes the tsx runtime dependency for good.

## cp161 — operator install fix: `morphit-ops command not found` (CLOSED 2026-05-27)

**Operator report:** a sysadmin ran `npx morphit-ops init`, the wizard started; next day after `git pull` + same steps, "command not found."

**Root cause (two layers):**

1. **Workspace-bin fragility.**  `morphit-ops` is `"private": true` — not published to the npm registry.  `npx morphit-ops` resolves only via the `node_modules/.bin/morphit-ops` symlink that `npm install` creates at the repo root.  `git pull` never creates/refreshes that symlink; if the pull touched package.json / package-lock.json / workspace layout (this repo regenerates the lockfile at milestones — cp144, cp154), the symlink goes stale.  npx then finds no local bin, looks for a published `morphit-ops` (none — private), and reports command not found.

2. **tsx was a devDependency.**  The bin shebang is `#!/usr/bin/env -S npx tsx` — the CLI runs from TypeScript source via tsx.  tsx was in ops-cli's `devDependencies`.  A plain `npm install` includes dev deps, so it worked in the common case, BUT under `NODE_ENV=production` or `npm install --omit=dev` (standard on servers) tsx would be absent and the shebang would either fail or attempt a network fetch of tsx (fails on hardened/offline boxes).  Latent second failure mode beyond the symlink issue.

**Ansible angle:** the operator was likely deploying via `ops/ansible/`.  `roles/morphit/tasks/clone_and_build.yml` runs `npm run build --workspaces --if-present` — and because ops-cli had NO `build` script, `--if-present` silently skipped it.  The task comment falsely claimed it built ops-cli ("relay + indexer + **ops-cli** + ...").  So the playbook never produced a runnable ops-cli artifact; it relied entirely on the install symlink + tsx.

**Fixes shipped (cp161):**

1. **tsx → production dependency** in `apps/ops-cli/package.json` (moved from devDependencies to dependencies).  The shebang now resolves under production installs.  Lockfile regenerated.

2. **Ansible hardening** (`clone_and_build.yml`):
   - Corrected the misleading build-task comment (ops-cli is NOT built; it runs from source via tsx).
   - NEW post-install verification task: `npx --no-install morphit-ops --help` run as the service user.  `--no-install` forces local-bin resolution + refuses network fetch.  A broken install (missing symlink, absent tsx) now fails the play with a clear error instead of surfacing weeks later at the operator's first `morphit-ops init`.

3. **Docs — the git-pull→npm-install requirement documented at all three operator entry points:**
   - `OPERATIONS.md §33` — NEW "Troubleshooting: morphit-ops says command not found" block (full explanation: workspace bins, tsx runtime dep, NODE_ENV edge case, the `npm exec --workspace` and `cd apps/ops-cli && npm start` bypasses).
   - `RUN-A-MORPHIT-NODE.md §12` — NEW "morphit-ops says command not found" subsection (operator-friendly version, cross-linked to OPERATIONS.md §33) + inline warning at the first `npx morphit-ops register` invocation (§9.1).
   - `ops/ansible/morphit-sysadmin-handoff.txt` — NEW troubleshooting entry at top (Ansible-specific: re-run the playbook, don't manual-pull; the in-place fix command; cross-link to OPERATIONS.md §33).

**Verified:**
- `node_modules/.bin/morphit-ops --help` runs correctly via the symlink (the operator's exact path) after lockfile regen.
- ansible-structural-smoke: 69/69 checks hold (playbook edit valid).
- Triple-pulse 6245/6245/6245, TypeScript 0×12 (no code logic changed; package.json dep move + docs + ansible only).

**Lesson — "works on my machine" install paths hide a setup dependency.**  The CLI worked in dev because the dev always runs `npm install` and never sets `NODE_ENV=production`.  The operator hit two latent failures (stale symlink + missing-tsx-under-prod) that the dev environment masks.  When a tool's `bin` points at source-run-via-tsx, tsx MUST be a production dependency, and the npm-install-after-pull requirement MUST be documented wherever the tool is first invoked — including paths the dev doesn't personally use (Ansible, OPERATIONS.md).  The proper fix (compiled dist, no tsx runtime) is cp162.

---

## cp160 — Remaining-workspace audit sweep + doc cleanups (CLOSED 2026-05-27)

Fifth and final workspace audit pass under the cp146 finding lens.  After mcp-server (cp146-cp156), relay (cp157), indexer (cp159), cp160 covers everything left: apps/web, the 4 packages, ops-cli, matrix-bot.  Plus a stale-doc correction and a permanent decision record.

### apps/web @html walk — 8 sinks, all safe, ZERO findings

The cp146 lens for a frontend is XSS via `{@html}` (Svelte auto-escaping bypass).  cp158 flagged @html growing 16→23 since cp138 but only verified the delta safe; cp160 does full per-sink provenance + defense analysis.

| # | Site | Provenance | Defense | Verdict |
|---|---|---|---|---|
| 1-3 | LoginQrInitiator, QrPanel, 2fa-page | qrcode lib `toString(text,{type:'svg'})` | fixed-structure SVG; text → QR path-geometry, never markup | ✅ safe-by-construction |
| 4-5 | IdentityLabel + profile-hero avatar | user upload → indexer → `deriveProfileProps()` | `safeSanitizeFromIndexer()` re-sanitize at render (defense-in-depth over indexer ingest sanitization); single producer feeds all 6 consumers | ✅ |
| 6 | Head onion-location | computeOnionLocation URL-validated | `.replace(/"/g,'&quot;')` | ✅ |
| 7 | Head JSON-LD | structured node | `.replace(/</g,'\\u003c')` neutralizes `</script>` breakout | ✅ |
| 8 | ProtectedTextarea overlay | user value + closed-enum kind | `escapeHtml()` all user slices; `data-kind` from closed union `'wif'\|'hex_64'\|'mnemonic'` | ✅ |
| i18n | WelcomeFirstBuyHero ×4 bullets | locale files | `i18n-html-injection-smoke` mechanism-discovers all `{@html $_(...)}` keys + validates ×10 locales vs safe-tag allowlist | ✅ |

The i18n smoke is mechanism-based (regex-extracts every callsite, not a hardcoded key list), so it auto-covers the 4 welcome bullets — verified they're the only `{@html $_(...)}` callsites repo-wide.  No unsafe @html anywhere.

### packages/* (×4) + matrix-bot — clean cp146-lens scan

Zero fetch(), zero @html, zero Dockerfile across indexer-client, relay-client, operator-config, asset-registry.  matrix-bot has zero raw fetch (matrix-bot-sdk owns transport); cp138-D-3 known-issue + opt-in semantics already documented.

### apps/ops-cli — F-opscli-1 (LOW) closed

ops-cli is an operator-run local CLI, not a network service.  5 fetch() sites: 2 HEAD connectivity checks (hardcoded URLs), 1 chain RPC POST (operator's own endpoint), 1 release-metadata JSON, 1 archive download.  Threat model: runs on operator's machine, operator-controlled or hardcoded URLs — SSRF not meaningfully applicable.

**F-opscli-1 (LOW):** `fetchLatestRelease()` in `commands/upgrade.ts` did bare `await res.json()` with no body cap + no `redirect: 'manual'`.  Host is operator-config (git.agorise.net default), so not SSRF, but a MITM'd/compromised release API returning multi-GB JSON would OOM the upgrade run.

**Fix:** 1 MiB body cap (Content-Length pre-check + post-text length check) + `redirect: 'manual'`.  Archive download already SHA-256-verified downstream, so only the metadata fetch needed the guard.

**NEW smoke** `apps/ops-cli/scripts/upgrade-fetch-hardening-smoke.ts` (6 source-sentinel scenarios — fetchLatestRelease is private).  Tamper-tested.

### verbatimModuleSyntax — now consistent across ALL 12 projects

cp160 flipped the final 6 (ops-cli, matrix-bot, + 4 packages which previously didn't set the flag).  Zero source changes, zero typecheck errors.  With cp155 (mcp-server) + cp157 (relay) + cp159 (indexer) + web baseline, every workspace now has it.  Future code review catches `import { type Foo }` shape mistakes uniformly.

### Doc cleanups

1. **Stale F-mcp-7 line:** the cp155-era "deferred until pre-launch polish phase" prose was never updated after cp156 shipped the `?then=` fix the very next checkpoint.  Corrected to point at the cp156 implementation.
2. **SVG sprite-sheet RULED OUT:** Ken permanently rejected the idea (2026-05-27).  Removed from cp116/cp117 pending lists in REVISIT-LIST + TARBALL; rationale preserved as record, decision marked final.  Do not resurface.

### Lessons

#### Lesson #1 — "Safe-by-construction" deserves the same verification rigor as "safe-by-sanitization"

Three of the 8 @html sinks (the QR codes) are safe because the qrcode library emits fixed-structure SVG from encoded text — the text becomes path geometry, not markup.  It's tempting to wave these through as "obviously fine."  But the verification still matters: I confirmed all three pass `type: 'svg'` (not some passthrough mode), because a fetcher that passed `type: 'utf8'` or omitted the type would emit something else entirely.  The safety rests on a specific option value, and that value is the thing to pin.

Pattern: "safe by construction" is a claim about a specific mechanism producing safe output.  Verify the mechanism is actually engaged (the right option, the right library call), not just that the library is "the QR library."

#### Lesson #2 — Mechanism-based smokes scale better than enumeration-based ones

The i18n-html-injection-smoke doesn't hardcode which keys are @html-rendered — it regex-extracts every `{@html $_(...)}` callsite at runtime and validates whatever it finds.  When WelcomeFirstBuyHero added 4 new @html bullets between cp138 and cp160, the smoke covered them automatically with zero smoke changes.

Contrast with a hypothetical enumeration smoke listing "these 12 keys are @html" — that would have silently under-covered the 4 new bullets until someone remembered to update the list.

Pattern: when a smoke guards a category of callsite (all @html, all fetch, all signing-primitive imports), prefer discovering the callsites mechanically over enumerating them.  The mechanism-based smoke can't drift out of sync with the code it guards.

#### Lesson #3 — Audit threat-model interpretation must adjust per workspace, but the lens is constant

ops-cli's fetch() sites would be findings in a network service (unbounded body, redirect-follow).  But ops-cli runs on the operator's own machine hitting operator-controlled URLs — SSRF is moot, and most of the cp146 HTTP findings don't apply.  Yet F-opscli-1 (the release-JSON body cap) IS real because upstream-misbehavior (MITM, compromise) is a separate threat from URL-trust, exactly as it was for the indexer's price feeds (cp159 F-indexer-1).

The lens is constant (defense-in-depth for outbound HTTP: SSRF, body cap, redirect, UA, credential-in-URL).  The interpretation adjusts: which findings apply depends on who controls the URL and who runs the process.  Body caps apply almost universally because upstream misbehavior is always possible regardless of URL trust.

### Verified clean

- Triple-pulse: 6245/6245/6245, 0 runners failed
- TypeScript: 0 errors × 12 projects (verbatimModuleSyntax true everywhere)
- svelte-check: 0/0
- i18n-html-injection-smoke: 1/1

Smoke battery growth cp159 6239 → cp160 6245 (+6).  Breakdown: +6 new upgrade-fetch-hardening smoke.

### Smoke runner script count

248 (was 247 at cp159).

### cp146 lens audit campaign — COMPLETE

| Workspace | Audit cp(s) | Result |
|---|---|---|
| mcp-server | cp146, cp151, cp154-cp156 | 13 findings closed + 4 sentinel smokes |
| relay | cp157 | 0 HIGH/CRITICAL + 3 INFO + tsconfig flip |
| indexer | cp159 | 5 findings + 1 sentinel smoke |
| web | cp160 | 0 findings (8 @html sinks all safe) |
| ops-cli | cp160 | 1 LOW finding + 1 sentinel smoke |
| matrix-bot + 4 packages | cp160 | 0 findings + verbatimModuleSyntax flips |

Every outbound-HTTP surface hardened, every @html sink verified, verbatimModuleSyntax consistent across all 12 projects.

### Pending — cp161+

The cp146 lens audit is complete across the monorepo.  Remaining pre-launch work:

- **Deployment-gated (cp138 items #95-104):** load testing, real Tor circuit behavior, multi-instance federation under network partition.  Require a staging deployment; can't be done in the static sandbox.
- **A1/A14 cp113 audit findings:** context not recoverable from prior transcripts; need Ken to clarify whether hardening is still wanted and what the items were.
- **No urgent code work remains.**  The codebase is in strong pre-launch shape: all audit campaigns closed, CI green, triple-pulse stable, zero open HIGH/CRITICAL.

---

## cp159 — apps/indexer focused audit (CLOSED 2026-05-27)

Fourth workspace audit applying the cp146-style finding lens.  After cp146-cp156 (mcp-server, 13 findings closed) and cp157 (relay, 0 HIGH/CRITICAL + 3 INFO), cp159 walks apps/indexer.

The indexer's threat-surface differs from both prior audits.  Unlike mcp-server (which calls operator-config federation peers and is the classic SSRF case) and unlike relay (which has only inbound HTTP), the indexer:
- Has the cp154-hardened federationProbe outbound surface (already covered)
- Has price-feed outbound calls to operator-trusted upstream APIs (Coingecko, Klingex) — **trusted URL, but not bounded body**
- Has signupAnomalyProbe outbound to operator-config sibling relay URL — **operator-trusted but lacks UA/redirect-manual hygiene**
- Has 2 POST endpoints — one ignores body (orderViews), one has its own cap (loginPairing)

### Scan-pattern results

| cp146 finding | Indexer status |
|---|---|
| F-mcp-1 — SSRF | ✅ federationProbe cp154-hardened.  peerPriceMonitor cp139-F-2 hardened.  Price fetchers use operator-trusted URLs (no SSRF), but body-bomb-able (see F-indexer-1). |
| F-mcp-2 — URL credential leak | ✅ Coingecko uses header `x-cg-pro-api-key`, not URL embedding |
| F-mcp-3 — redirect-follow | ⚙️ FIXED via cp159 F-indexer-2 |
| F-mcp-4 — User-Agent | ⚙️ FIXED via cp159 F-indexer-3 + F-indexer-4 |
| F-mcp-5 — response body cap | ⚙️ FIXED via cp159 F-indexer-1 + F-indexer-4 |
| F-mcp-7 — locale prefix | N/A (indexer is JSON API; no UI deeplinks) |
| F-mcp-16 — marketing-prose drift | ✅ No user-facing marketing strings in indexer (JSON error codes only) |
| F-mcp-22 — Docker `:latest` | ✅ No Dockerfile in apps/indexer |
| F-mcp-27 — verbatimModuleSyntax | ⚙️ FIXED via cp159 F-indexer-5 (zero source changes) |
| F-mcp-30 — LICENSE / packaging | N/A (indexer is internal, AGPL covered at monorepo root) |

### F-indexer-1 (MED) — Price-fetcher missing body cap

**Where:**
- `apps/indexer/src/indexer/price/coingeckoFetcher.ts:90` (pre-fix)
- `apps/indexer/src/indexer/price/klingexFetcher.ts:85` (pre-fix)

**Pattern (pre-fix):**

```typescript
const res = await fetchImpl(url, { method: 'GET', headers, signal: ac.signal });
// ...
const body = (await res.json()) as unknown;  // ← no body bound
```

**Threat model:**

The URL is operator-trusted (operator picks Coingecko URL via env; Klingex URL via env), so SSRF isn't the canonical attack.  The exposure is upstream misbehavior:

| Failure mode | Result |
|---|---|
| Compromised upstream returns multi-GB JSON | Indexer OOM kill |
| Buggy upstream returns truncated JSON in infinite stream | Indexer CPU peg on parse loop |
| Upstream incident returns multi-MB HTML error page | Indexer chokes on parse, refresh cycle stalls |

These aren't hypothetical.  Coingecko's free tier has historically returned multi-MB HTML during status-page incidents.  Klingex has returned full orderbook dumps when the ticker endpoint misbehaves.  Pre-cp159 the indexer had no defense.

**Fix:**

NEW `apps/indexer/src/indexer/price/priceFetchUtil.ts` exports:
- `PRICE_FETCH_MAX_BODY_BYTES` (64 KiB default; env-overridable; 16 MiB hard ceiling)
- `PRICE_FETCH_USER_AGENT` (`'morphit-indexer/price-fetch'`)
- `readPriceBodyCapped(res, ac, url): Promise<string>` — two-layer body cap
- `priceUpstreamHeaders()` — accept + User-Agent
- `priceUpstreamFetchInit(signal)` — method=GET, redirect=manual, signal

`readPriceBodyCapped()` shape mirrors cp151 F-mcp-5 (`readBodyCapped` in mcp-server) and cp154 net-defense `fetchJson`:
1. **Content-Length pre-check** — rejects oversize before any body read
2. **Streaming reader with abort** — catches headers that lie about or omit Content-Length

**Cap sizing:** 64 KiB default.  Coingecko payload is 28 bytes (`{"blurt":{"usd":0.00237}}`); Klingex ticker ~250 bytes.  64 KiB is 250x normal for the larger of the two.

Both fetchers refactored to use the shared helper.

### F-indexer-2 (LOW) — Price-fetcher redirect-follow default

Both fetchers' `fetch()` calls had no `redirect` field, defaulting to `'follow'`.  **Fix:** `priceUpstreamFetchInit()` returns `redirect: 'manual'`.  A 30x to an unexpected host becomes operator-visible (returns non-2xx → `!res.ok` log + null return).

### F-indexer-3 (LOW) — Price-fetcher no User-Agent

Default Node UA leaks Node version.  **Fix:** `priceUpstreamHeaders()` includes named UA.  Friendlier for Coingecko's rate-limiter.

### F-indexer-4 (LOW) — signupAnomalyProbe bare fetch

`apps/indexer/src/indexer/signupAnomalyProbe.ts` fetches `relay-health-url?verbose=1` for the signup-anomaly judgment.  Pre-cp159: bare `fetch()`, no UA, no `redirect: 'manual'`, no body bound on `res.json()`, `JSON.parse` not wrapped in try/catch.

The relay URL is operator-config sibling-process URL (typically `http://127.0.0.1:8080/v1/health?verbose=1`).  Lower SSRF surface than price fetchers but defense-in-depth still warranted.

**Fix:** added named UA `'morphit-indexer/signup-anomaly-probe'`, `redirect: 'manual'`, 16 KiB post-read body cap with non-JSON fallback ("anomaly check skipped" rather than thrown error).

### F-indexer-5 (LOW) — verbatimModuleSyntax flip

`apps/indexer/tsconfig.json` `verbatimModuleSyntax: false → true`.  Zero typecheck errors; zero source changes required.  Third workspace where earlier discipline kept `import type` consistent.

Workspaces with `verbatimModuleSyntax: true` now: web (baseline), indexer (cp159 this), relay (cp157), mcp-server (cp155).

### NEW sentinel smoke

`apps/indexer/scripts/price-fetch-util-smoke.ts` (11 scenarios):

1. priceUpstreamHeaders returns accept + named User-Agent
2. priceUpstreamFetchInit returns method=GET, redirect=manual, threaded signal
3. PRICE_FETCH_MAX_BODY_BYTES default 64 KiB
4. Content-Length pre-check rejects oversized body before stream-read
5. Content-Length pre-check fires abort signal
6. Streaming reader rejects body that exceeds cap when Content-Length absent or lies
7. Streaming-overflow path fires abort signal
8. Well-formed small body reads cleanly (round-trips intact)
9. Source-sentinel: 6 required safety markers in priceFetchUtil.ts
10. Callsite-sentinel: both fetchers actually use the hardened helper
11. Regression guard: no bare `await res.json()` in fetchers (uses strip-comments)

**Tamper-tested:** reverting coingeckoFetcher to bare `res.json()` correctly fires scenarios 10 + 11.

### Lessons

#### Lesson #1 — Cross-tree TS imports from per-workspace smokes resolve awkwardly under tsx --tsconfig

First attempt to use cp153's shared `scripts/lib/strip-comments.ts` from `apps/indexer/scripts/price-fetch-util-smoke.ts` (via 3-level relative path) failed with a misleading `SyntaxError: does not provide an export named 'stripComments'` despite the export being correct.

Root cause: under `tsx --tsconfig=tsconfig.smoke.json` invocation from `apps/indexer/`, the 3-level-up relative path traverses out of the workspace into the repo root.  Module resolution depends on tsconfig's `baseUrl: "."` interpretation, which is per-invocation-cwd.

**Workaround:** per-workspace smoke gets a 3-line local copy of `stripComments`.  Acceptable code duplication for a 3-line helper.  cp153's helper remains canonical for repo-root scripts/ smokes.

**Pattern:** when a smoke at `apps/*/scripts/*.ts` needs a tiny helper from `scripts/lib/`, prefer inlining over fighting the cross-tree import.  When the helper is >50 lines or shared by multiple per-workspace smokes, consider promoting it to a `@morphit/audit-helpers` package the way cp154 promoted `@morphit/net-defense`.

#### Lesson #2 — A regression sentinel can mis-fire on its own explanatory comments

cp159's scenario 11 initially failed because the cp159 inline comment IN coingeckoFetcher.ts said `// Replaces `await res.json()` which had no size bound.`  The regex matched the comment, not code.  Fix: strip comments before pattern-match.

**Pattern:** any regex-based source sentinel that pattern-matches on what code SHOULDN'T contain needs comment-stripping.  The cp159 explanatory comments are MORE likely to mention the old anti-pattern than the new code is to contain it — sentinel must distinguish documentation from regression.

#### Lesson #3 — The cp146 finding lens keeps producing wins

Three workspaces audited under the same lens, each producing a different exposure profile:

| Workspace | Primary exposure | Defenses added |
|---|---|---|
| mcp-server | Outbound HTTP to operator-untrusted federation peers | net-defense package (SSRF) + body cap + redirect-manual + UA |
| relay | Inbound HTTP, X-Forwarded-For trust | (no new — cp31-47 already covered) |
| indexer | Outbound HTTP to operator-trusted but unbounded upstream APIs | price-fetch helper (body cap) + redirect-manual + UA |

The exposure shapes are categorically different.  The same finding lens maps cleanly onto each.  This is the value of pattern audits — pattern recognition transfers across workspaces with different threat models.

**Pattern for future workspace audits:** apply the cp146 lens, but adjust the threat model interpretation per workspace.  Operator-trusted URLs still need body caps (upstream misbehavior is a separate threat from URL trust).  Inbound-only services still benefit from `verbatimModuleSyntax` flips because the cost is zero when source discipline already held.

### Verified clean

- Triple-pulse: 6239/6239/6239, 0 runners failed
- TypeScript: 0 errors × 12 projects (verbatimModuleSyntax true in web + indexer + relay + mcp-server)
- svelte-check: 0/0
- compositeSource vitest: 19/19 (refactored fetchers don't break test mocks)
- All price smokes pass: price-source-hardening 14/14, peer-price-monitor 37/37, morphit-native-fetcher, multi-asset-factory

Smoke battery growth cp158 6226 → cp159 6239 (+13).  Breakdown: +11 new smoke + 2 derived growth.

### Smoke runner script count

247 (was 246 at cp158).

### Pending — cp160+

Three workspaces deeply audited under the cp146 lens.  Remaining workspace targets ranked by likely value:

- **apps/web (frontend) per-component sanitization re-walk:** cp158 noted @html count grew 16 → 23 since cp138; all verified safe but the cp146 lens hasn't been applied to the per-component sanitization shape (avatar SVG sanitizer, IdentityLabel, profile-page avatar inline).
- **packages/* small surfaces:** asset-registry was cp65 era; indexer-client / relay-client are mostly type definitions.  Quick clean walks.
- **apps/ops-cli + apps/matrix-bot:** small workspaces; matrix-bot has cp138-D-3 known-issue documented.

If Ken wants another deep walk, apps/web @html per-component sanitization is the highest-value next target.

---

## cp158 — cp138 110-task audit plan walk (CLOSED 2026-05-27)

Per Ken's session direction #3.  Walked `docs/AUDIT-cp138-PLAN.md` + `docs/AUDIT-cp138-FINDINGS.md` to verify status of all 94 static tasks and the 3 standing follow-ups.

**Plan status:** CLOSED 2026-05-25 with 11 findings shipped + 3 standing follow-ups + 0 outstanding HIGH/CRITICAL.

**Three standing follow-ups re-verified at cp158:**

| Follow-up | Status at cp158 |
|---|---|
| cp138-R-1 — bigint id propagation (parseInt(row.id) → 11 sites at cp138) | ✅ Reduced from 11 sites to 2.  Remaining sites in `apps/indexer/src/api/chatStream.ts:116, 151` both wrapped in explicit `cp138 R-1` reference comments documenting safe-at-Morphit-scale.  Standing-correct deferral. |
| cp138-R-2 — matrix-bot-sdk transitive deps | ✅ Opt-in semantics confirmed in `apps/matrix-bot/src/main.ts:35-44`.  No code change needed pre-launch. |
| R-3 — Postgres statement_timeout operator guidance | ✅ SHIPPED post-cp138.  `OPERATIONS.md §37.8 e.` documents the recommendation; `RUN-A-MORPHIT-NODE.md §11` cross-references it; `scripts/operations-hardening-smoke.ts:142` sentinel-locks the OPERATIONS.md content. |

**Regression check across cp138 phase patterns** — applied to current codebase 19 checkpoints later:

| cp138 phase | Pattern | Status |
|---|---|---|
| D | ILIKE without escapeLike | ✅ 0 violations |
| C | Math.random in security paths | ✅ 2 production uses (modal-id, Fisher-Yates) — both non-security; same count as cp138 baseline |
| F | TODO/FIXME/XXX/HACK | ✅ 0 real instances; 4 hits all docblock prose |
| G | (X+)* ReDoS candidates | ✅ 0 hits |
| E | @html sites | ⚙️ Grew from 16 to 23; **verified safe** (delta is i18n bullets + test files + docblock prose — no new unsafe code) |

**Outcome:** zero new findings, zero regressions, all standing follow-ups on track.  cp158 was a walk-only checkpoint (no code changes); the cp138 invariants survived 19 checkpoints of subsequent work intact.

### Lesson — walking a completed audit's standing follow-ups is the right way to verify health

cp138's standing follow-ups document what we'd intentionally deferred; cp158 re-walks them to verify they're still in their deferred-correct state.  R-1 going from 11 sites to 2 (net better than baseline) is a healthy signal: the deferred work didn't grow, it shrank as adjacent refactors absorbed the cleanup organically.  R-2 (matrix-bot) and R-3 (statement_timeout) confirm the post-cp138 commitments held.  Regression-pattern sampling across the cp138 phases turned up zero issues — the cp138 invariants survived 19 checkpoints of subsequent work intact.

This is what "the audit campaign worked" looks like.

---

## cp157 — apps/relay focused audit (CLOSED 2026-05-27)

Per Ken's session direction (#2: fresh audit on a workspace that hadn't had recent deep-deep attention).  Picked apps/relay over apps/web because apps/web had the exhaustive cp139 deep-deep (every route + every lib walked, ~165 files) while apps/relay's last comprehensive audit was the cp31-47 era (months ago, predates the cp138+ audit discipline).

### Scan-pattern results applying the cp146 finding lens

Every cp146 finding has a direct or analogous applicability check against the relay surface.  The relay's narrower attack surface (backend service, no UI) means many findings just don't apply, but each was verified explicitly.

| cp146 finding | Relay status |
|---|---|
| F-mcp-1 — SSRF | ✅ No `fetch()` in relay.  All outbound traffic is to Blurt nodes (via `@beblurt/dblurt`) and PostgreSQL (via `pg` pool).  Both internal-contract dependencies; no operator-input URLs reach a fetcher. |
| F-mcp-2/3/4 — URL credentials / redirect / User-Agent | N/A (no fetch) |
| F-mcp-5 — body cap | INBOUND covered: `middleware/security.ts maxBodyBytes` does Content-Length pre-check + chunked-Transfer-Encoding rejection (411).  Mirrors cp151 F-mcp-5 defense shape. |
| F-mcp-7 — locale prefix | N/A (relay returns JSON only) |
| F-mcp-16 — marketing-prose drift | ✅ Walked every user-facing error message; all factual ("Daily signup limit reached", "Account signup is currently unavailable on this relay", "Try again in an hour"). No marketing overreach. |
| F-mcp-22 — Docker `:latest` | ✅ No Dockerfile in apps/relay (same status as mcp-server pre-cp140 — npm-only for now) |
| F-mcp-27 — `verbatimModuleSyntax` | ⚙️ FIXED — flipped `false → true` in `apps/relay/tsconfig.json`.  Zero typecheck errors after the flip; zero source changes required (same pattern as cp155 F-mcp-27 mcp-server flip). |
| F-mcp-30 — LICENSE / packaging | N/A (relay isn't published as npm package; AGPL-3.0 covered at monorepo root) |

### `api/create.ts` 9-layer defense walk

`apps/relay/src/api/create.ts` is 864 lines, the user-facing fund-spending signup endpoint.  Defense layers in order:

1. **Kill-switch (env + file)** — operator pause via `MORPHIT_RELAY_SIGNUP_ENABLED=0` or `touch <data-dir>/SIGNUPS_DISABLED` at runtime
2. **Global daily ceiling `tryReserve()` atomic** — explicit audit-fix annotation calls out the prior bug shape (canAccept-then-increment N-1 overshoot) and the fix (atomic-canAccept-then-increment in one synchronous step)
3. **Per-IP burst limiter `allow()`** — consume-on-attempt, not consume-on-success.  Source comment explicitly flags: "Consuming on every request (not only successful broadcasts) is what makes this an actual rate limiter against attackers."
4. **Per-IP daily limiter `peekWithSpacing()`** — peek-vs-commit pattern.  Source comment: "TOCTOU already_registered and pre-broadcast rejections do NOT commit, so a user finding their preferred username can keep trying until they hit one that's free."
5. **Health pre-check** — `health.canAcceptCreation()` checks relay's BLURT balance is above threshold before doing more work
6. **Zod schema parse with `.strict()`** on every object — extra fields rejected at parse time; depth-3 strict shape lock
7. **Invite-token HMAC verify** — bound to IP `/24`-or-`/64` bucket via `bucketKey`; expiry-checked; consumed only AFTER chain broadcast succeeds (failed broadcasts don't burn the invite)
8. **Name validation chain** — `validateBlurtName` → high-value-name policy → sequential-pattern detector.  All operator-tunable; all logged with bucketKey + classification for operator review
9. **Pubkey validation per role** — owner/active/posting/memo each `isValidPublicKey()`, weight-1 verification, set-cardinality-4 distinct-keys check
10. **Composite-fingerprint dedupe** — 60s window, key on `sha256(name + owner + active + posting + memo)` not key-fingerprint alone.  Audit-note in source explains: "Pre-fix this was keyed on key-fingerprint alone, which would lock a user out of retrying with a different name for 60 seconds after any error."
11. **Final chain availability** — `blurt.getAccount(name)`
12. **Broadcast with try/finally** — `handleWithReservation()` pattern: `reservationFinalized` flag flipped only on success path; finally auto-releases otherwise.  Source comment explicitly notes: "Keeping this as a let-flag rather than adding releaseReservation() before every `return c.json()` is less error-prone for future edits."
13. **Post-success bookkeeping** — invite consume → daily limiter commit → ceiling record + finalize → 1-BLURT signup dust transfer → sequential-detector record.  Each wrapped in its own try/catch with error logged but not returned to caller (failures here can't undo the chain record).
14. **Error-path handling** — duplicate-transaction recovery (chain accepted earlier retry → look up account → return success-shape with `note: 'duplicate_after_retry'`); TOCTOU `already_registered` from chain mapped back to the same code as the pre-check path; `pending_claimed_accounts` → `relay_out_of_funds`; `invalid_public_key` from chain → 400; everything else → 502 with stable code + redacted message

The error-message redaction is explicit and documented:

```js
// Never echo the full error to the caller — it may contain
// hex-encoded transaction bytes or other noise.
return c.json(
  {
    status: 'rejected',
    code: 'broadcast_failed',
    message: 'The chain rejected the transaction.'
  },
  502
);
```

**No new HIGH/CRITICAL findings** in this walk.  Code clearly benefited from the cp31-47 audit campaign.

### `middleware/ip.ts` trust-boundary review

`apps/relay/src/middleware/ip.ts` (382 lines) — sole authority for client IP derivation in the relay.  Walked end-to-end.

**Default-secure posture:**
- Trusts ONLY loopback by default: `['127.0.0.1', '::1', '::ffff:127.0.0.1']`
- `MORPHIT_RELAY_TRUSTED_PROXY_IPS` env-var override, documented in source as "the most dangerous knob in the relay's config"
- Both misconfig directions called out in source comment:
  - Too narrow → BunkerWeb / multi-host nginx not trusted → shared rate-limit bucket → one abuser exhausts limit for everyone
  - Too broad (e.g., `0.0.0.0/0`) → ANY remote attacker can forge XFF to bypass per-IP rate limits

**Defense-in-depth elements:**

| Element | Where | What |
|---|---|---|
| 64-char XFF cap | `parseXff()` | Prevents bucket-map bloat from absurdly-long forged headers |
| Length-cap X-Real-IP at 64 | `clientIp()` | Same defense as XFF |
| Trusted-peer gate | `clientIp()` | Headers only honored when socket peer is a trusted proxy |
| IPv4-mapped IPv6 unwrap | `canonicalBucketKey()` | `::ffff:1.2.3.4` → bucketed as IPv4 `/24` |
| `/24` IPv4 bucket | `canonicalBucketKey()` | Catches single-AS botnets |
| `/64` IPv6 bucket | `canonicalBucketKey()` | Defeats `/64`-prefix attacker source-addr budget (2^64 source addrs) |
| Loopback preservation | `canonicalBucketKey()` | Trusted-peer detection (`isTrustedPeer`) keeps working downstream |
| CIDR bitwise mask | `parseV4Cidr()` | Correct `(~0 << (32 - bits)) >>> 0` arithmetic |

**Wiring verified:**

`apps/relay/src/main.ts:32+106-122` actually calls `configureTrustedProxies()` at boot from `cfg.trustedProxyIps` env value.  If the env var is empty, the call is skipped and the trusted set stays at the loopback-only default (correct default-secure behavior).  If the env var has content, the call reconfigures the trusted set.  Per the docblock contract: "the relay's main.ts calls configureTrustedProxies() exactly once at boot before any request handler runs."

**`clientIp()` is the SOLE forwarded-header reader** in the relay:

```
$ grep -rn "x-forwarded-for\|x-real-ip\|remoteAddress" apps/relay/src/ --include="*.ts"
apps/relay/src/middleware/ip.ts:185:  const info = (c.env as ...).?incoming?.socket?.remoteAddress;
apps/relay/src/middleware/ip.ts:221:  const xff = c.req.header('x-forwarded-for');
apps/relay/src/middleware/ip.ts:226:  const xri = c.req.header('x-real-ip');
```

All four lines are inside `middleware/ip.ts`.  Three call sites (`api/create.ts`, `api/push.ts`, `api/availability.ts`) all route through `clientIp()`/`canonicalBucketKey()`.  No bypass paths.

### Other middleware spot-checks

**`middleware/security.ts`:**
- `maxBodyBytes(limit)` — Content-Length pre-check + chunked-Transfer-Encoding 411 rejection.  Closes the unbounded-body bypass through `transfer-encoding: chunked`.
- `securityHeaders()` — standard set: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy: interest-cohort=()`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`.  Defense-in-depth with nginx setting similar headers.

**`middleware/origin_enforcement.ts`:**
- Acknowledges CORS is browser-only; server-side allowlist with 403 catches curl/Postman/bot bypass attempts
- Missing-Origin → 403 (fails closed for fund-spending endpoints)
- Scoped to /v1/account/create only; read-only routes stay permissive
- Triple defense: CORS (browser) + origin_enforcement (server) + per-IP rate limits

**`middleware/ratelimit.ts`:**
- Sliding-window with `allow()` / `peekWithSpacing()` / `commit()` primitives — exactly the shape api/create.ts uses for the peek-then-commit-after-chain-confirms flow

### LOW/INFO findings (documented, not blocking)

**F-relay-N1 (INFO) — X-Forwarded-For leftmost-split assumes single-hop trust**

`parseXff()` takes the leftmost entry of XFF.  This is correct for single-trusted-proxy hops (the common case: client → nginx → relay).

For multi-hop chains (e.g., CDN → BunkerWeb → nginx → relay), the leftmost is the original client IP ONLY if every intermediate proxy strips client-provided XFF before adding its own.  If any link in the chain doesn't, an attacker can spoof the leftmost via `X-Forwarded-For: 1.2.3.4` in their initial request.

**Status:** operator config, not a code bug.  The relay's contract is "trust the immediate peer's XFF if it's a trusted proxy"; multi-hop trust is the operator's responsibility to configure correctly in their proxy chain.  `OPERATIONS.md §32` (BunkerWeb deployment) documents this.

**Action:** none required for code.  Verify `OPERATIONS.md §32` calls out the multi-hop XFF discipline.  (Spot-check: it does — see the BunkerWeb section's nginx config snippets.)

**F-relay-N2 (INFO) — IPv6 CIDR ranges not supported**

`configureTrustedProxies()` accepts IPv4 CIDR (`172.18.0.0/16`) but not IPv6 CIDR.  Operators with IPv6 reverse proxies must whitelist each IPv6 address individually.

**Status:** documented limitation.  Source comment: "IPv6 CIDR ranges are NOT yet supported; pass each address individually if you need to whitelist multiple v6 hops."

**Action:** none required.  IPv6 reverse-proxy deployments are rare today; the workaround (exact-match list) works.  If/when an operator surfaces this as a real pain point, a small extension to `parseCidr()` for IPv6 prefixes would close it.

**F-relay-N3 (INFO) — Module-level mutable state for trusted-peer set**

`trustedExactPeers` and `trustedV4Cidrs` are module-level.  `configureTrustedProxies()` mutates them.  Per docblock: "the relay's main.ts calls configureTrustedProxies() exactly once at boot before any request handler runs."

**Status:** correct per the boot-once contract.  Verified `main.ts` actually calls before handler registration.  Module-level rather than per-call avoids refactoring every middleware call site for config injection.

**Action:** none required.  If the relay ever adds runtime reconfiguration support (e.g. SIGHUP to reload env), this state shape would need synchronization, but that's a future-tense concern.

### Code change shipped

`apps/relay/tsconfig.json`:

```diff
   "isolatedModules": true,
+  "verbatimModuleSyntax": true,
   "allowImportingTsExtensions": true,
```

**Outcome:** zero typecheck errors after the flip, zero source changes required.  Same pattern as cp155 F-mcp-27 (mcp-server) — source already used `import type` consistently from earlier discipline.  Now consistent with the rest of the monorepo's workspaces.

### Verified clean

- Triple-pulse: 6226/6226/6226, 0 runners failed
- TypeScript: 0 errors × 12 projects (with `verbatimModuleSyntax: true` now in relay + mcp-server)
- svelte-check: 0/0
- Smoke battery unchanged from cp156 baseline (audit only, no new smokes shipped)

### Smoke runner script count

246 (unchanged from cp156).

### Lessons

#### Lesson #1 — A focused audit doesn't need to produce findings to be worthwhile

cp157 walked 8800 lines and shipped one tsconfig flip + three INFO documentation items.  Zero new HIGH/CRITICAL findings.

This isn't a failure of audit rigor.  The relay had its deep-deep in cp31-47; subsequent discipline kept it clean.  The cp157 walk confirmed that the prior audit work held up under the cp146-style finding lens.  Confidence is the deliverable; "nothing significant changed" is a useful audit outcome.

Pattern: when planning an audit, set a clear scope and apply a known finding-pattern lens.  If the lens returns "no new findings," that's evidence the prior work held — not evidence the audit was unnecessary.  Both outcomes are valuable.

#### Lesson #2 — `clientIp()` as sole-source for IP derivation is a load-bearing invariant

The relay's security model rests on `clientIp()` being the ONLY route through which client IPs flow into rate-limiters and invite-token bindings.  If a future feature reaches for `c.req.header('x-forwarded-for')` directly without routing through `clientIp()`, the entire trusted-peer gate is bypassed for that caller.

**Considered adding a sentinel smoke** for this invariant.  Decided not to (yet) because:
- The current grep returns exactly 4 lines (inside `middleware/ip.ts`); a sentinel today would just pin those 4
- A sentinel pinning "no x-forwarded-for outside `middleware/ip.ts`" is straightforward (~30 lines, similar to cp149's read-only-invariant pattern) but adds maintenance overhead
- Real-world risk of a future contributor reaching for the header directly is low — the code-review discipline + middleware/ip.ts docblock + this REVISIT entry are sufficient

**If this changes** (someone bypasses `clientIp()` in a future PR), the cp157 doc here becomes the prior-art reference to point at during review.

Pattern: not every load-bearing invariant warrants a smoke.  When the invariant is naturally enforced by file-organization discipline and the violation surface is small, prose documentation can be sufficient.  Smokes are best for invariants where the violation surface is broad OR where the cost of regression is unbounded.

#### Lesson #3 — `verbatimModuleSyntax: true` flip is a clean-cost check

Three workspaces have flipped this in the last three checkpoints: cp155 (mcp-server), cp157 (relay).  In both cases: zero source changes needed.  The source had been written against the wider repo convention even when the per-workspace tsconfig wasn't enforcing it.

This is a good audit-style check to run repo-wide.  For each workspace with `verbatimModuleSyntax: false`: flip to true, run typecheck, see what breaks.  If nothing does, ship the flip.  If something does, the break is informative (real type-only imports were missing the `type` keyword).

Pattern: tsconfig-consistency audits are cheap.  When the flip is clean (zero break), the only cost is the line change; the benefit is consistency + future code-review catching `import { type Foo }` vs `import type { Foo }` shape mistakes.

### Pending — cp158+

cp157 closes audit work for this session.

**Next per Ken's session direction (#3): cp138 110-task audit plan** — walk unresolved items in the 94-task static-audit plan from cp138.  Items #95-104 require sandbox/deployment (out of static-audit scope); items #105-110 are epistemic limits (also out of scope).

---

## cp156 — F-mcp-7 closure via root-shell `?then=` support (CLOSED 2026-05-27)

The last cp146 finding, the one cp155 reclassified as "needs web-app change," shipped.  cp155 recommended Option A (root-shell `?then=` query parameter support, preserves Morphit's static-site deployment posture); cp156 implements Option A.

### What shipped

**Web-app change** (`apps/web/src/routes/+page.svelte`):

Extended the existing root locale-detection shell.  Before cp156: client-side `navigator.languages` detection → redirect to `/{detected-lang}/` with outer query and hash passed through.  After cp156: same flow, plus extraction and validation of `?then=/path` query parameter that becomes the redirect target.

**Safety constraints** on `then` value (defense against deeplink-based redirect attacks):

| Rule | Blocks |
|---|---|
| `then.startsWith('/')` | Relative URLs, full URLs (`http://evil.com/`) |
| `!then.startsWith('//')` | Protocol-relative URLs (`//evil.com/`) — a browser-quirk escape |
| `!then.includes('\\')` | Windows-path-like values some browsers fold `\` → `/` |
| `then.length > 0` | Empty string (would yield `/{lang}` anyway but be explicit) |

Malformed values silently fall back to the bare-root redirect (`/{lang}` with passthrough).  Rationale: a typoed/malicious deeplink yielding "you landed on Morphit's homepage" is friendlier than a stuck loading spinner.  The deeplink-receiver can't meaningfully recover from "this URL is bad"; pushing them to root is the most useful fallback.

**MCP-server change** (three deeplink sites):

- `apps/mcp-server/src/tools/describeMorphit.ts:96` — FAQ deeplink
- `apps/mcp-server/src/tools/searchOrders.ts:148` — orderbook deeplink with filter query
- `apps/mcp-server/src/tools/getListing.ts:72` — listing deeplink

All three now build the deeplink via `URL` constructor + `searchParams.set('then', ...)`.  The inner path-with-query is URI-encoded inside the `then` value.  Example output:

```
${base}/?then=%2Forderbook%3Fasset%3DBTC%26side%3Dsell
```

When the user clicks this, the root shell:
1. Loads (prerendered, ~50ms)
2. Reads `URLSearchParams(window.location.search).get('then')` → `/orderbook?asset=BTC&side=sell`
3. Picks locale via `navigator.languages` (e.g. `es`)
4. `window.location.replace('/es/orderbook?asset=BTC&side=sell')`

User lands on the Spanish-locale orderbook page with filters applied.

**Existing mcp-server-smoke scenario 8 updated** to match the new deeplink shape.  Previously expected `/en/orderbook?asset=XMR`; now expects `/?then=%2Forderbook%3Fasset%3DXMR`.

### New smoke

`scripts/root-shell-then-redirect-smoke.ts` (4 scenarios):

1. **Safety predicate** (15 cases) — pin the `isSafeThen` decision-table across SAFE inputs (`/orderbook`, `/faq`, `/@alice/permlink`, bare `/`, paths with query) and UNSAFE inputs (`//evil.com`, `http://full-url`, missing-leading-slash, contains-backslash, empty, null).
2. **Well-formed-then target construction** (10 cases × all 10 supported locales) — verify `/{lang}{then}` builds correctly for each locale (en, es, fr, de, it, pl, ru, fa, zh-CN, zh-HK).
3. **Malformed-then fallback** (6 cases) — verify malformed values fall back to `/{lang}` rather than producing broken URLs.
4. **Source-sentinel** (8 markers) — pin the load-bearing source text in `apps/web/src/routes/+page.svelte`: URLSearchParams extraction, length>0 check, leading-slash check, protocol-relative check, backslash check, target template, fallback-to-localePath path, cp156 docblock attribution.

Tamper-tested by removing the protocol-relative `!thenRaw.startsWith('//')` check — the source-sentinel fires correctly with the missing marker named in the diagnostic.  Restored, 4/4 pass.

### Why client-side redirect, not server-side Accept-Language

cp155 documented two implementation options:
- **A:** root-shell `?then=` query-param support (this cp156)
- **B:** server-side Accept-Language detection via SvelteKit hooks.server.ts or nginx/Caddy rewrite

Option A chosen because it preserves Morphit's static-site deployment posture.  The web app is currently fully prerendered + deployable to any static host (nginx, Caddy, S3-hosted, CDN).  Option B would require every operator's deployment to run SvelteKit's adapter-node (or equivalent runtime) which would shrink the deployment surface and create a per-operator-instance variance Morphit's federation discipline tries to minimize.

The Option A trade-off — a redirect hop adds ~50ms latency on AI-deeplink handoffs — is acceptable because the user is already in a multi-step flow at that point.  Once the user clicks an AI deeplink they're about to: load Morphit, unlock identity, navigate listing, click Reply.  One invisible 50ms redirect hop is not the bottleneck.

### Other design notes

**Outer query and hash are DROPPED when `then` is present.**  The `then` value carries the full path-with-query the caller wanted; any additional outer query params from the deeplink URL get discarded.  Callers that want to preserve UTM tags or similar should encode them inside the `then` value: `?then=%2Forderbook%3Fasset%3DBTC%26utm%3Dclaude`.

**No content-type negotiation.**  The shell is pure SPA — JS-disabled clients still get the `<noscript>` meta-refresh fallback to `/en` (the pre-cp156 behavior, unchanged).  AI deeplinks landing on JS-disabled clients get English-locale fallback; that's fine because (a) AI agents serving JS-disabled users are vanishingly rare, and (b) English fallback is no worse than the pre-cp156 hardcoded `/en/`.

**Hash fragments in `then`.**  If a caller wants `/orderbook#section`, they must URI-encode the `#` as `%23` inside the `then` value.  An unencoded `#` would be parsed as the outer URL's hash, not part of the `then` query value.  Mentioned in inline source comments for future MCP-tool implementers.

### Verified clean

- Triple-pulse: 6226/6226/6226, 0 runners failed
- TypeScript: 0 errors × 12 projects
- svelte-check: 0/0
- All three mcp-server smokes pass with new deeplink shape
- mcp-server build: clean, `dist/main.js` with shebang preserved

Smoke battery growth cp155 6221 → cp156 6226 (+5).  Breakdown: +4 new root-shell smoke + 1 derived growth.

### Smoke runner script count

246 (was 245 at cp155).

### Lessons

#### Lesson #1 — Static-site deployment posture is a constraint, not a feature

Option B (server-side Accept-Language) would have been cleaner UX.  But "Morphit web is fully prerendered + deployable to any static host" is one of the things Morphit's federation discipline rests on — every operator can stand up an instance with nginx + a static export, no runtime.  Adding a server-side dependency would shrink the deployment surface.

cp156's Option A is the "respect the constraint" choice.  The 50ms redirect-hop is the cost; the constraint is preserved.

Pattern: when a fix has options that differ in deployment-surface impact, default to preserving the existing surface.  Performance/UX wins can be reconsidered if/when the deployment surface itself changes.

#### Lesson #2 — Three safety guards is a stable shape for URL-redirect inputs

`thenRaw.startsWith('/') && !thenRaw.startsWith('//') && !thenRaw.includes('\\')` is the minimum coverage for "absolute path on same origin, no escape."  Tested combinations:

| Attack | Guard that blocks |
|---|---|
| `/orderbook` | (allowed — safe) |
| `http://evil.com/` | startsWith('/') |
| `//evil.com/` | !startsWith('//') |
| `\evil` | startsWith('/') |
| `/path\\with\\backslash` | !includes('\\') |
| `\\\\evil` (UNC-path-like) | startsWith('/') AND !includes('\\') |

The three guards are independent (no overlap removal possible).  Removing any one of them opens an attack surface; the source-sentinel pins all three.

Pattern: for any user-controllable path-redirect input, the start-pattern check and the embedded-backslash check are both required.  They cover different attack classes; same-origin-only enforcement needs both.

#### Lesson #3 — `?then=` is the standard shape for client-side deeplink handoff with detection

The pattern of "land on a detection shell that redirects to a parameterized destination" is used elsewhere (OAuth `redirect_uri` flow, Twitter intent URLs, etc.).  cp156's implementation follows the well-known shape:
- Param name `then` (also seen as `redirect`, `next`, `continue`)
- Same-origin enforcement via path-prefix check
- Detection-then-redirect via JS-side `window.location.replace`

Future AI-agent deeplink work (e.g. Charlie persona's expanded flows) should reuse this mechanism rather than invent new path shapes.

### Pending — cp157+

cp146 audit cluster fully complete.  All actionable findings closed.

Next meaningful work options per Ken's session-level direction:
- **(2) Fresh audit** on a workspace that hasn't had recent deep-deep attention (`apps/relay` or `apps/web` frontend).  Both candidates are sizable; pick based on which gives the bigger pre-launch risk reduction.
- **(3) cp138 110-task audit plan** — check unresolved items in the 94-task static-audit plan from cp138 (items #1–94).

Ken indicated the order: cp156 (this) → (2) audit → (3) cp138 plan.

---

## cp155 — Tier-C cleanup batch (CLOSED 2026-05-27)

Three cp146 Tier-C deferred items addressed in one batch.  Two closed clean, one reclassified with corrected scope.

### F-mcp-22 — no-`:latest`-Docker-tag sentinel (CLOSED)

**Goal:** make the cp146 README guidance "Pin to a specific tag like `:1.0.0`; never `:latest` for reproducibility" enforceable across the whole repo, not just inside the README's prose.

**Shipped:** `scripts/no-docker-latest-tag-smoke.ts` (3 scenarios).  Walks:
- Container configs: `Dockerfile*`, `*.containerfile`, `docker-compose*.{yml,yaml}`, `compose.{yml,yaml}` under `apps/`, `packages/`, `ops/`, `docs/`
- Operator-facing markdown: `*.md` under same dirs

Three invariants:
1. **No `:latest` in container configs** — registry pulls and locally-built image tags both pinned.
2. **No `:latest` in operator-facing markdown** (outside the allowlisted guidance prose).
3. **PROSE_GUIDANCE_PATHS pinned and non-empty** — sanity guard ensuring the allowlist isn't accidentally truncated.

**Backtick-stripping refinement:** The smoke strips backtick-quoted spans before matching `:latest`.  Markdown prose like "never `:latest`" or "should not use `:latest`" appears in many places legitimately; stripping backticks lets those pass without needing every doc on the allowlist.  Real violations like `image: foo:latest` (in fenced code blocks where backticks delimit the FENCE, not the inline content) still trip.

**PROSE_GUIDANCE_PATHS** (six entries, each with inline rationale comment):
- `apps/mcp-server/README.md` — the cp146 canonical guidance line
- `docs/INTEGRATION-TEST-HARNESS-DESIGN.md` — same guidance shape ("should be pinned by digest, not `:latest`")
- `docs/REVISIT-LIST.md` + `docs/REVISIT-LIST-ARCHIVE.md` — project journal discussing the rule
- `TARBALL.md` — same
- `scripts/no-docker-latest-tag-smoke.ts` — the smoke itself, which has to mention `:latest` to explain what it enforces

**Fixed two real pre-existing violations** in `docs/OPERATIONS.md`:

| Before | After |
|---|---|
| `image: sethforprivacy/simple-monerod:latest` | `image: ghcr.io/sethforprivacy/simple-monerod:v0.18.4.1` |
| `image: xmrblocks:latest` (local build name) | `image: morphit-xmrblocks:v1` (namespaced + pinned) |

Also corrected the registry path: `sethforprivacy/simple-monerod` (Docker Hub, less-maintained) → `ghcr.io/sethforprivacy/simple-monerod` (GitHub Container Registry, the actively-maintained one per upstream README).

Added inline operator-facing comment explaining the pinning discipline: "(Pin both images to specific tags — never `:latest` — for reproducibility.  Update by checking the upstream pages for current stable releases before each deploy.)"

**Tamper-tested:** reintroducing an `image: foo:latest` directive correctly fires the smoke with the line number + remediation pointer.  Restored, smoke passes 3/3.

### F-mcp-27 — verbatimModuleSyntax tsconfig flip (CLOSED)

Flipped `apps/mcp-server/tsconfig.json` `verbatimModuleSyntax: false` → `true`.

**Outcome:** zero typecheck errors, zero source changes required.  All `import type` declarations were already in place from earlier discipline.  The cp146 finding was about the FLAG-VALUE inconsistency with other workspaces (which all use `verbatimModuleSyntax: true`), not actual import-syntax violations.

All downstream verifications clean:
- Typecheck: 0 errors
- Build: clean, dist/main.js with shebang preserved
- mcp-server-smoke: 8/8
- fetchjson-body-cap-smoke: 3/3
- private-instance-policy-smoke: 22/22

**No follow-up needed.**  This is a "the fix was trivially clean because earlier discipline kept the source aligned even when the flag wasn't enforcing it" outcome.

### F-mcp-7 — RECLASSIFIED with corrected scope

The cp146 finding (LOW UX) said: "all deeplinks hardcode `/en/` locale prefix.  Web UI's Accept-Language detection would do the right thing without a prefix.  Cleanup, not a bug."

**Verification this session showed the assertion is incorrect.**

**The web app's locale routing structure:** all content lives under `apps/web/src/routes/[lang]/...` (e.g. `[lang]/orderbook/+page.svelte`).  The root `apps/web/src/routes/+page.svelte` is a redirect shell that does client-side `navigator.languages` detection and uses `window.location.replace('/{detected-lang}/')`.  This redirect ONLY fires at the root `/` path.

**A URL like `${base}/orderbook` (locale-less subpath) doesn't match any route — it would 404.**

So stripping `/en/` from the three mcp-server call sites would break the deeplinks:
- `apps/mcp-server/src/tools/describeMorphit.ts:96` — FAQ URL
- `apps/mcp-server/src/tools/searchOrders.ts:148` — orderbook deeplink
- `apps/mcp-server/src/tools/getListing.ts:72` — listing deeplink

**The right fix requires a web-app change** in one of two shapes:

**Option A — `?then=` query-parameter support in root shell.**

Extend `apps/web/src/routes/+page.svelte` to honor a `?then=/path` query param: `${base}/?then=/orderbook?asset=BTC` → root shell detects locale → redirects to `/{detected}/orderbook?asset=BTC`.

- Pros: clean shape, small change to one file, no server-side dependency.
- Cons: introduces a redirect hop on every AI deeplink handoff (root shell loads → JS detects → location.replace).  Slight UX latency.

**Option B — server-side Accept-Language detection.**

SvelteKit `hooks.server.ts` or nginx/Caddy rewrite rule that reads the request's `Accept-Language` header and serves the localized route directly, no redirect hop.

- Pros: cleaner UX, no redirect.
- Cons: introduces a server-side dependency where there isn't one today (Morphit web is currently fully prerendered + statically deployable).  Each operator's deployment shape would need to support this.

**Recommendation:** Option A.  It's smaller, doesn't change Morphit's static-site deployment posture, and the redirect-hop cost is acceptable for AI deeplink handoffs (the user is already in a multi-step flow at that point; one extra hop is invisible).

**Status:** CLOSED at cp156 (this analysis was written at cp155 when the fix was still deferred; cp156 shipped Option A — root-shell `?then=` support — the very next checkpoint).  All three deeplink call sites now route through `${base}/?then=/path`, so non-English-locale users get their detected locale rather than a hardcoded `/en/` page.  See the cp156 entry above for the implementation.

### Verified clean

- Triple-pulse: 6221/6221/6221, 0 runners failed.
- TypeScript: 0 errors × 12 projects.
- svelte-check: 0/0.
- All three mcp-server smokes still pass.

Smoke battery growth cp154 6217 → cp155 6221 (+4).  Breakdown: +3 no-docker-latest-tag-smoke + 1 derived.

### Smoke runner script count

245 (was 244 at cp154).

### Lessons

#### Lesson #1 — Smarter pattern matching beats allowlist sprawl

Initial cp155 smoke used a naive `:latest` regex that tripped on prose like "never `:latest`" in operator docs (OPERATIONS.md, INTEGRATION-TEST-HARNESS-DESIGN.md).  First instinct: add both files to PROSE_GUIDANCE_PATHS.

Better solution: strip backtick-quoted spans before matching.  Markdown prose using backticks to mark inline code is universal; recognizing that pattern at the regex layer means fewer false positives without growing the allowlist.  The allowlist now only contains files where `:latest` appears OUTSIDE backticks (the project's own meta-discussion in REVISIT/TARBALL/the smoke itself).

Pattern: when a sentinel smoke needs an allowlist, first see if a smarter match rules out the common-case false positives.  The regex update is usually smaller than the allowlist it would replace.

#### Lesson #2 — Some "deferred fixes" are trivially clean because discipline already aligned the source

F-mcp-27 (verbatimModuleSyntax flip) was expected to require import-keyword updates throughout the mcp-server source.  Reality: zero changes needed.  Earlier discipline (probably from the original cp140 ship written against the wider repo's convention) had every `import type` correctly marked even though the flag wasn't forcing it.

This means the cp146 finding was about the FLAG VALUE inconsistency, not actual import-syntax debt.  The flag flip cost was: one character in tsconfig.json.

Pattern: when a deferred "configuration polish" finding lands, first try the change and see what breaks.  If nothing does, the source was already aligned and the polish closes cleanly.  Don't pre-assume the source needs refactoring.

#### Lesson #3 — Audit findings carry assertions that need verifying, not just acting on

The cp146 F-mcp-7 finding asserted "Web UI's Accept-Language detection would do the right thing without a prefix."  Reading that, the obvious fix is "strip `/en/`."  Implementing that fix would have broken every AI deeplink.

Verifying the assertion took ~10 minutes (grep route structure, read root +page.svelte, check for server hooks/proxy config) and showed it was wrong.  cp155 reclassified the finding with the corrected scope and a documented path forward.

Pattern: when a deferred finding includes a load-bearing assertion about behavior elsewhere in the system, verify the assertion before implementing the fix.  Assertions in audit notes get stale or were never quite right to begin with; the implementation will hit reality, not the assertion.  A 10-minute verification can save a redo or worse.

### Pending — cp156+

The cp140→cp146 finding cluster is **fully addressed**.  All 12 actionable F-mcp-* findings closed; F-mcp-7 reclassified with documented path forward.

Next meaningful work options:
- Pre-launch polish phase (when scheduled): close F-mcp-7 via web-app `?then=` support
- Audit refresh on a different workspace (apps/relay, apps/web frontend hadn't had recent deep-deep attention)
- The 110-task audit plan from cp138 — check unresolved items
- New work as Ken directs

No urgent items remain in the cp146 audit cluster.

---

## cp154 — F-mcp-1 SSRF defense via lifted federationProbe (CLOSED 2026-05-27)

The cp146 deferred Tier-B finding, the last meaningful F-mcp-* item, shipped.  Followed cp147's `docs/ADDING-A-WORKSPACE.md` playbook end-to-end on a real workspace addition.

### What shipped

**New shared workspace `packages/net-defense/`** (`@morphit/net-defense`, `"private": true`):
- `src/index.ts` — `isPrivateHostname` + `isPrivateIp` byte-for-byte lifted from `apps/indexer/src/indexer/federationProbe.ts`.  Pure functions, zero runtime deps.
- `scripts/net-defense-smoke.ts` — 51 self-test scenarios covering every branch of both functions.
- `package.json` (modeled on asset-registry), `tsconfig.json`.

**Indexer refactor** (`apps/indexer/src/indexer/federationProbe.ts`):
- Inline `export function isPrivateHostname` and `export function isPrivateIp` definitions removed.
- Replaced with `import { isPrivateHostname, isPrivateIp } from '@morphit/net-defense'` + named re-export (so existing call sites and smokes still work).
- The six-layer SSRF defense (HTTPS-only, denylist, DNS+every-record-public, IP-pin, redirect:manual, body cap) unchanged — same shape, primitives now sourced from shared package.

**MCP-server refactor** (`apps/mcp-server/src/indexerClient.ts`):
- `getInstanceUrl()` now calls `isPrivateHostname(parsed.hostname)` after scheme validation.
- Rejects private hostnames by default with diagnostic referencing the env-var escape hatch.
- Allows when `MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE === '1'` (strict equality — not loose-truthy).

**Monorepo wiring** (ADDING-A-WORKSPACE.md Phase 3):
- Root `package.json:workspaces` adds 11th entry.
- `apps/indexer/package.json` + `apps/mcp-server/package.json` add `"@morphit/net-defense": "*"` deps.
- `package-lock.json` regenerated via `npm install` (the cp144 step — playbook explicitly calls this out as the failure mode that caused cp140→cp144 CI-red).
- `scripts/typecheck-sweep.sh` adds the `net-defense` project (12 projects all 0 errors).

**New smokes** (registered in `scripts/run-smokes.sh`):
- `packages/net-defense:net-defense-smoke` — 51 scenarios.
- `apps/mcp-server:private-instance-policy-smoke` — 22 scenarios.

**Existing mcp-server smokes patched** (both bind 127.0.0.1 for local stubs, need opt-in):
- `apps/mcp-server/scripts/mcp-server-smoke.ts` — env block in child spawn.
- `apps/mcp-server/scripts/fetchjson-body-cap-smoke.ts` — env set/restore around test body.

**Documentation same-turn:**
- `docs/adr/0045-net-defense-shared-package.md` — full ADR documenting lift, per-consumer threat-model differences, why two functions (URL-form vs DNS-form), why "private" (workspace-internal, not published).
- `MORPHIT-BRAG-LIST.md` — entry 154 updated 43 ADRs → 44 ADRs, range 0001 through 0045; verification trailer also updated.
- `README.md` — packages list adds net-defense; ADR range references updated (lines 34, 53).
- `apps/web/static/morphit-mediakit.zip` — regenerated via `scripts/build-mediakit.sh` (cp14's mediakit-freshness smoke caught the staleness).
- `apps/web/scripts/persona-walkthrough-smoke.ts` — P122-CP3 sentinel updated for cp154 lifted form (matches `import { isPrivateHostname, isPrivateIp } from '@morphit/net-defense'` and the new re-export shape), NEW P122-CP3-cp154 sentinel pins net-defense package contents (subtle `::ffff:` unwrap + `100\.(6[4-9]` CGNAT regex).

### Why a shared package, not duplicate-and-pin

Three reasons:

1. **Single source of truth.** The function bodies are identical between indexer and mcp-server's threat models.  Duplicating would let drift recreate exactly the F-mcp-1 finding cp154 is closing.

2. **Pure-function surface.** Both functions are stateless and have zero runtime dependencies (no DB, no logger, no env).  A shared package is the natural shape for that.

3. **Test coverage focused.** 51 scenarios in `net-defense-smoke.ts` covering every branch.  Without the package, equivalent coverage would need duplication in both consumer test surfaces — and the cp146 audit literally found that the mcp-server's coverage of the address-range denylist was zero because the helpers were inline in a file the mcp-server didn't even import from.

### Why two functions, not one

`isPrivateHostname` operates on URL-side form (case-insensitive, possibly bracketed `[::1]`, possibly with TLD suffixes like `.local`).  `isPrivateIp` operates on DNS-resolved canonical form (no brackets, lowercase hex, IPv4-mapped IPv6 needs unwrap).

Merging would force callers to know which form they have and which checks to skip.  Keeping them separate matches actual usage:
- Pre-DNS: `isPrivateHostname(parsed.hostname)` — catches literal-form attacks
- Post-DNS: `for (record of dns.lookup(host)) if (isPrivateIp(record.address)) reject;` — catches rebinding-class attacks

### Why "private" (workspace-internal)

`"private": true` in package.json — workspace consumers reach it via npm symlinks, no npm publishing.  Reasoning:

- Function bodies encode Morphit's specific threat-model choices (CGNAT inclusion, cloud-metadata IPs by name).  Project-internal decisions.
- External consumers wanting SSRF defense should use established libraries (`ssrf-req-filter`, `private-ip`).
- Releasing externally would obligate semver discipline on what is internally a freely-evolving surface.

If a future need arises to publish, the lift is small: drop `"private": true`, write a README, accept semver discipline.

### Per-consumer policy composition

The package gives BUILDING BLOCKS.  Consumers compose policy:

| Layer | indexer | mcp-server |
|---|---|---|
| HTTPS-only | Required | Not enforced (Tor/dev) |
| Literal denylist | Hard reject | **Reject default, env opt-in** ← cp154 closure |
| DNS rebinding | Required | Out of scope |
| IP-pin dispatcher | Required (TOCTOU) | Out of scope |
| redirect:manual | Required | cp146 |
| Body cap | 256 KB | 4 MiB (cp151) |

Same primitives, different policies.  The package does NOT compose either policy.

### Catch list from pulse 1

Four smokes fired correctly when the structural lift landed.  All four were patched same-turn:

1. `brag-list-trailer-invariants-smoke` — flagged the brag-list trailer's "0001 through ADR-0044" claim now drifted.  Patched MORPHIT-BRAG-LIST.md entry 154 + verification trailer.
2. `brag-list-claim-parity-smoke` — flagged two README ADR-range claims.  Patched README.md lines 34 + 53.
3. `mediakit-freshness-smoke` — flagged morphit-mediakit.zip older than its MORPHIT-BRAG-LIST.md source.  Ran `scripts/build-mediakit.sh`.
4. `persona-walkthrough-smoke` — P122-CP3 sentinel pinned `export function isPrivateHostname` and `::ffff:` etc. in federationProbe.ts; cp154 lift moved these to net-defense.  Updated sentinel to match the new shape + added a complementary sentinel pinning the lifted package contents.

This catch pattern (write the structural change → pulse fires → patch same-turn) is exactly what the smokes were designed to enforce.  Discipline working as intended.

### Verified clean

- Triple-pulse: 6217/6217/6217, 0 runners failed.
- TypeScript: 0 errors × 12 projects.
- svelte-check: 0/0.
- mcp-server-smoke: 8/8 still passing (loopback opt-in correctly wired).
- fetchjson-body-cap-smoke: 3/3 still passing.
- mcp-server build: clean.

Smoke battery growth cp153 6136 → cp154 6217 (+81).  Breakdown: +51 net-defense + 22 policy + 1 persona-walkthrough new sentinel + 7 derived growth (other source-walking smokes pick up the new files).

### Smoke runner script count

244 (was 242 at cp153).

### Lessons

#### Lesson #1 — Pure re-exports don't create local bindings

Initial attempt was `export { isPrivateHostname } from '@morphit/net-defense';` — concise but wrong.  Pure re-exports don't make the name usable inside the module.  Internal callers like `resolveAndValidatePublicIp(r.address)` calling `isPrivateIp(r.address)` couldn't resolve.

Fix: `import { isPrivateHostname, isPrivateIp } from '@morphit/net-defense'; export { isPrivateHostname }; export { isPrivateIp };` — import (creates local binding) + re-export (preserves public surface).

Pattern: when lifting helpers out of a module that internally calls them, use import+re-export rather than pure re-export.

#### Lesson #2 — ADDING-A-WORKSPACE.md (cp147) playbook is battle-tested

This was the first end-to-end workspace addition since cp147's playbook landed.  The playbook covered every step encountered:
- Phase 2 skeleton: created package.json + tsconfig.json from the asset-registry template
- Phase 3 monorepo wiring: workspaces array → deps in consumers → `npm install` → typecheck-sweep
- Phase 4 smokes: dedicated self-test smoke + policy smoke
- Phase 5 pre-PR: triple-pulse caught four downstream housekeeping issues
- Phase 6 docs: ADR + brag list + README same-turn

The Phase 3 step "regenerate package-lock.json via npm install" was the most load-bearing — it's the cp144-CI-red prevention step.  Playbook is now validated against a real lift, not just the conceptual case it was written for.

#### Lesson #3 — Sentinel smokes need updating when their target's shape changes

`persona-walkthrough-smoke.ts` P122-CP3 sentinel was pinning `export function isPrivateHostname` etc. as `mustHave` strings in `federationProbe.ts`.  After cp154 lifted those bodies out, the file has `export { isPrivateHostname }` (different shape) and the function bodies live in `@morphit/net-defense`.

Two options:
- A: Update sentinel to look at the new file location (split between two files).
- B: Update sentinel to verify the wiring shape (re-export + import from package) and ADD a new sentinel for the package contents.

Went with B — captures both invariants: (1) federationProbe.ts still routes through the shared package, (2) the shared package still has the load-bearing branches.  Net result: stronger coverage than before, two scenarios instead of one.

Pattern: when a structural refactor moves pinned content between files, prefer adding a complementary sentinel over rewriting the existing one.  Both invariants matter.

### Pending — cp155+ candidates (low priority)

The cp146 Tier-C deferred items remain (all LOW severity):
- **F-mcp-7** — hardcoded `/en/` in deeplinks (should respect user locale)
- **F-mcp-22** — Docker image uses `:latest` tag (should pin to version)
- **F-mcp-27** — `verbatimModuleSyntax` enforcement in tsconfig

These are polish, not security or correctness.  Defer until pre-launch polish phase or as ad-hoc cleanup.

The session has shipped 13 checkpoints; cp154 closes the cp140→cp146 finding cluster.  Next meaningful work is either the Tier-C polish above or a fresh audit phase.

---

## cp153 — Shared comment-stripping helper (CLOSED 2026-05-27)

The cp149 + cp151 Lesson cross-reference candidate, shipped.

### What shipped

**`scripts/lib/strip-comments.ts`** — single-function module exporting `stripComments(source: string): string`.  Two-pass regex strip: block comments first (lazy match), then line comments.  Documented limitations: string literals containing comment markers get content eaten (acceptable for the smoke use case because the limitation can only cause false NEGATIVES, never false POSITIVES — a pattern accidentally hidden inside a string, not a pattern accidentally flagged).

**`scripts/strip-comments-smoke.ts`** — self-test smoke with 15 scenarios:
- 6 core behaviors (line strip, block strip, multi-line block, multiple line comments, multiple block comments, code passthrough)
- 3 subtler cases (block containing line markers, line containing block markers, consecutive comments)
- 2 documented-limitation pins (string-literal markers get stripped — current behavior pinned so future changes surface deliberately)
- 4 empty/pathological inputs (empty, whitespace-only, all-comment, all-block-comment)

**Refactor scope:**
- ✅ `scripts/spawn-dist-prebuild-coverage-smoke.ts` (cp142): inline `stripComments` removed, imports from `./lib/strip-comments.js`
- 🔒 `scripts/mcp-server-read-only-invariant-smoke.ts` (cp149): inline state machine retained with cp153 annotation explaining why — its per-line state machine preserves line numbers for diagnostic file:line output.  The whole-text regex helper would collapse multi-line block comments and shift subsequent line numbers, making the smoke's "raw fetch() at apps/mcp-server/src/X.ts:42" reports incorrect.

**Three other smokes with comment-stripping logic were inventoried but NOT consolidated** (different shapes):
- `scripts/now-in-handler-sql-smoke.ts`: only strips `//`, also tracks template-literal state
- `apps/indexer/scripts/ansible-env-template-required-vars-smoke.ts`: character-by-character state machine with string-literal awareness
- `apps/web/scripts/no-real-time-settimeout-in-tests-smoke.ts`: doesn't strip — uses positional comparison of `//` and `setTimeout` indexes

Consolidating these would require either generalizing the shared helper (more complexity than worth) or refactoring callers to a different shape (out of scope).  Pragmatic call: leave them alone.

### The meta-bug caught during development

Both the helper file and the self-test smoke initially had docblocks describing block-comment syntax inline:

```
 *   - String literals containing `//` or `/*` get their content
 *     stripped.  e.g. `const url = 'https://x.com';` becomes
```

The literal `*/` sequence inside the backticks prematurely closes the outer docblock.  esbuild then sees what should be docblock prose as code, hits a syntax error at the FIRST line that doesn't parse as code, and reports column positions that don't match the visible source.

Fix: paraphrase the docblock to avoid the literal close-marker.  Use "OPEN" / "CLOSE" or "slash-star" / "slash-slash" prose references instead.  The irony — comment-stripping logic broken by its own comment markers — is documented inline so future maintainers don't fall into the same trap.

### Verified clean

- Self-test smoke: 15/15 passing
- cp142 spawn-dist smoke (now consumer): 3/3 still passing
- cp149 mcp-server-read-only smoke: 3/3 still passing (unchanged execution path)
- Triple-pulse: 6136/6136/6136, 0 runners failed
- TypeScript: 0 errors × 11 projects

Smoke battery growth from cp153 alone: +15 scenarios (from the self-test) + 1 derived (smoke walker picks up the new file in `scripts/lib/`).

### Lessons

#### Lesson #1 — Block-comment markers inside docblocks need escaping or paraphrasing

When a docblock prose mentions `*/` or `/*` literally — even inside backticks or string examples — the parser sees the literal marker, not the prose.  Backticks don't escape anything in block comments.

Fixes:
- Best: paraphrase prose to avoid literal markers ("OPEN" / "CLOSE" / "slash-star")
- Acceptable: use backslash-escaped form `*\/`  (works in some toolchains)
- Don't: rely on backticks to "quote" the marker — they don't

This is a general pattern, not specific to TypeScript: same issue in JSDoc, Java/C/C++ docblocks, anywhere block comments meet documentation.

#### Lesson #2 — Helper consolidation isn't always wins-all-around

Three of five comment-stripping callers were skipped from consolidation because their shapes genuinely differ:
- Template-literal tracking → can't share with plain comment stripping
- Char-by-char state machine with string-awareness → too specialized
- Position-comparison (not stripping at all) → wrong abstraction

The two we DID consolidate were the same shape (whole-text regex strip).  The two we didn't (state machine for line-number preservation; specialized state machines) are documented as "considered but not consolidated."

For future refactors: if N callers exist with what looks like duplicated logic, inventory ALL of them before extracting.  The right helper might cover 2 out of N; the wrong helper is one that tries to cover all N and pays generality cost on every caller.

#### Lesson #3 — Self-test smokes pin known limitations explicitly

The helper has documented limitations (string-literal markers get stripped).  The self-test smoke includes scenarios that PIN this current behavior:

```
check(
  'string-literal // is stripped (documented limitation)',
  "const url = 'https://example.com';",
  "const url = 'https:"
);
```

If a future refactor "fixes" this (e.g. by adding string-literal awareness), the self-test fails.  This forces the change to be deliberate — the maintainer must update the smoke to match new behavior AND update the docblock's "documented limitations" section.

Pattern: when a helper has known limitations that are acceptable for the current use case, pin them in the self-test smoke.  Limitations become contracts; contract changes become deliberate.

---

## cp152 — Source-marketing-prose smoke (CLOSED 2026-05-27)

The cp146 Lesson #3 candidate, shipped.

### What shipped

**`scripts/source-marketing-prose-smoke.ts`** — pins critical marketing claims and bans known-misleading phrasings in the source-embedded strings AI agents quote verbatim to users.

### Pinned phrases (must be present in their source files)

| File | Phrase | Since | Why pinned |
|---|---|---|---|
| `describeMorphit.ts` | "Instance operators see the connecting IP at the HTTP layer" | cp146 F-mcp-16 | Truthful version of IP-visibility clause |
| `describeMorphit.ts` | "per-user IP log of its own" | cp146 F-mcp-16 | Data-model-side honesty clause |
| `describeMorphit.ts` | "Tor onions" | cp146 F-mcp-16 | User-actionable mitigation |
| `describeMorphit.ts` | "non-custodial" | cp140 | Keys-stay-on-device load-bearing claim |
| `describeMorphit.ts` | "federated" | cp140 | No-single-point-of-failure claim |
| `describeMorphit.ts` | "no email collection" | cp140 | Explicit "we do not collect" attestation |
| `searchOrders.ts` | "non-custodial and KYC-free" | cp140 | Tool description reaffirms trust model |
| `searchOrders.ts` | "the agent never sees keys" | cp140 | Explicit read-only attestation, pairs with cp149 |

### Banned phrasings (must NOT appear in their source files)

| File | Phrase | Banned by | Why banned |
|---|---|---|---|
| `describeMorphit.ts` | "no IP logging by design" | cp146 F-mcp-16 | Pre-cp146 misleading shorthand — reads as "no IP visible" which is false |
| `describeMorphit.ts` | "completely anonymous" | cp146 F-mcp-16 class | Overclaim — Morphit gives non-custody + Tor-onion options, not anonymity by default |
| `describeMorphit.ts` | "we cannot see" | cp146 F-mcp-16 class | Literal claim rarely true at HTTP layer; use "data model retains no per-user log of X" instead |
| `searchOrders.ts` | "anonymous" | cp146 F-mcp-16 class | Tool returns public on-chain data; "anonymous" implies more than trust model delivers |

### Why a separate smoke (not extending brag-list-claim-parity)

`brag-list-claim-parity-smoke.ts` checks NUMERIC claim parity (e.g. "16 tradable assets" matches asset-registry count).  Different shape from PROSE pinning.

Could have extended the existing smoke with a new check kind, but that would mix concerns.  Separate smoke is cleaner: each smoke has one clear purpose, easier to maintain, easier to read when CI fails.

cp146 Lesson #3 originally suggested "extend brag-list-claim-parity" — cp152 implementation is a refinement: a new sibling smoke serving the same goal.

### Verified clean

- 4/4 baseline scenarios passing
- Tamper-tested all 3 directions independently
- Triple-pulse: 6136/6136/6136, 0 runners failed
- TypeScript: 0 errors × 11 projects

### Lessons

#### Lesson #1 — Pin both directions: presence AND absence

A "must contain" pin alone catches removal but not regression-to-misleading.  A "must not contain" ban alone catches reintroduction but not silent removal of the truthful version.

Both directions together create a tight contract: the marketing copy is locked at the cp146 corrected state, no upward freedom for either removing necessary nuance or reintroducing misleading shorthand.

#### Lesson #2 — Rationale strings make failures self-documenting

Each PINNED and BANNED entry has a `rationale` string explaining WHY it's enforced.  When the smoke fails, the rationale appears in the error message:

```
banned phrase "no IP logging by design" (banned by cp146 F-mcp-16).
Rationale: this is the pre-cp146 misleading shorthand.  Reads as "no IP visible"
which is false — instances see connecting IPs at the HTTP layer.  Use the literal
"Instance operators see the connecting IP at the HTTP layer; data model retains
no per-user IP log" pinning instead.
```

Future maintainer hits the failure, reads the rationale, understands the constraint without having to grep history.  Smoke serves as both enforcement AND documentation.

#### Lesson #3 — Pin phrases that are contiguous in source

Initial implementation pinned "retains no per-user IP log" which is split across string-concat lines in the source.  Smoke failed because the substring isn't contiguous in the file.

Fix: pin the source-contiguous form ("per-user IP log of its own") that the actual concat sequence preserves on a single line.

For future marketing-pin work: choose pin phrases that survive the source's line-wrapping conventions.  Either use single-line-contained forms, or normalize the source text (concatenate strings) before checking — but normalization adds complexity for marginal benefit.

### Pending — cp154+ candidates

- **cp154 — F-mcp-1 SSRF defense via lifted federationProbe:** the cp146 Tier-B finding remaining.  Lift `apps/indexer/src/lib/federationProbe.ts` into a shared package, consume from both indexer and mcp-server.  Bigger refactor than this session's other work — deserves its own dedicated session.
- **Memory rule #22 update**: committed this turn via memory_user_edits tool.  Memory now references four personas.

---

## cp151 — F-mcp-5 fetch body cap (CLOSED 2026-05-27)

The cp146 deferred Tier-B finding, shipped.  `fetchJson()` in `apps/mcp-server/src/indexerClient.ts` now enforces a 4 MiB response-body size cap with two-layer defense.

### Threat model

A malicious or compromised Morphit instance can return an arbitrarily large response body:
- Multi-GB JSON via honest Content-Length (8+ GB declared).
- Infinite chunked stream with no Content-Length (`Transfer-Encoding: chunked` + slow drip).
- Dishonest Content-Length (declares 1 KB, sends 1 GB).

Pre-cp151, `await res.json()` accumulated everything into memory before parsing, exhausting Charlie's heap.  The MCP server crashes; the AI agent sees a transient tool failure and retries; the malicious instance can amplify into repeat OOM cycles.

This is the same threat class as cp146 F-mcp-2/3 (credential leak via URL, redirect-follow), but at the byte-volume axis instead of the redirect-target axis.

### Defense

**Layer 1: Content-Length pre-check.**  Read the `Content-Length` header before consuming the body.  If declared > cap, throw immediately:

```typescript
const declared = res.headers.get('content-length');
if (declared !== null) {
  const declaredN = Number.parseInt(declared, 10);
  if (Number.isFinite(declaredN) && declaredN > cap) {
    throw new Error(`response from ${redactUserinfo(url)} declares ${declaredN} bytes (cap is ${cap}); refusing to fetch`);
  }
}
```

Zero bytes of body allocated.  Catches honest oversized responses and honest-Content-Length-based attacks.

**Layer 2: Streaming reader with running-total check.**  Stream chunks via `res.body.getReader()`, count bytes, abort + throw on cap crossing:

```typescript
const reader = res.body.getReader();
let total = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  total += value.byteLength;
  if (total > cap) {
    ac.abort(); // release network resource
    throw new Error(`response from ${redactUserinfo(url)} exceeded body cap (${cap} bytes); refusing to fetch`);
  }
  chunks.push(value);
}
```

Catches dishonest Content-Length, omitted Content-Length, infinite streams.  The `ac.abort()` call releases the network connection so we don't wait for the server to close.

### Cap value

**4 MiB default.**  Calibrated against observed legitimate responses:
- Typical /v1/orders: ~150 KB (a few hundred rows × ~500 bytes)
- Largest observed legitimate: ~500 KB on busy instances
- Cap: 8× headroom above high-water mark

**Override:** `MORPHIT_MCP_MAX_BODY_BYTES` env var.  Use cases for raising: private deployments with extended /v1/ surfaces.  Use case for lowering: hardened deployments on memory-constrained devices.  Values ≤ 0 or non-numeric fall back to default.

### Implementation notes

- Replaced both `await res.text()` (error path) and `await res.json()` (success path) with the cap-aware `readBodyCapped()` helper.
- Helper returns `Uint8Array`; caller decodes via `TextDecoder('utf-8')` + `JSON.parse`.  JSON parse errors get wrapped with "response from {url} is not valid JSON: {msg}" so callers don't see bare SyntaxErrors.
- `reader.releaseLock()` in `finally` cleans up even on abort.  Double-protected with try/catch since some abort paths invalidate the reader before the finally runs.
- The `redactUserinfo()` from cp146 wraps URLs in all three new error messages (Content-Length rejection, streaming overflow, JSON parse failure).

### Tamper-test

Smoke `apps/mcp-server/scripts/fetchjson-body-cap-smoke.ts` has 3 scenarios; I tampered with each check independently:

**Tamper A:** Replace streaming-cap check `total > cap` with `total > Number.MAX_SAFE_INTEGER`.
> Scenario 3 fails: streaming-overflow not rejected; downstream JSON parse fails with "Unexpected end of JSON input" (because the chunked spaces body isn't valid JSON).

**Tamper B:** Replace Content-Length pre-check `declaredN > cap` with `declaredN > Number.MAX_SAFE_INTEGER`.
> Scenario 2 fails: pre-check doesn't fire; fetch proceeds to read the empty body and surfaces Node fetch's "terminated" error (the server closed connection without sending the declared body).

Both restored, smoke goes 3/3 again.

### Why a focused unit-style smoke (not extending mcp-server-smoke)

The existing `mcp-server-smoke.ts` is an end-to-end protocol test — it spawns the MCP server process and speaks JSON-RPC over stdio.  Adding body-cap scenarios there would force the smoke to also stand up a mock instance that the spawned MCP server can hit, which means coordinating two child processes with port discovery.  Complexity not worth it.

Instead, `fetchjson-body-cap-smoke.ts` imports `fetchJson` directly from `src/indexerClient.ts` (not dist), stands up tiny HTTP servers via Node's built-in `createServer`, and exercises the function under controlled conditions.  Faster to run, easier to debug, and the scenarios are localized to the file under test.

This is a textbook unit-style smoke pattern.  Pre-launch hardening benefits from BOTH end-to-end smokes (protocol surface) and unit-style smokes (individual function contracts).  cp151 adds the latter shape to the mcp-server's smoke battery for the first time.

### Verified clean

- Triple-pulse smokes: 6114/6114/6114, 0 runners failed (pulses 65, 66, 67)
- TypeScript: 0 errors × 11 projects
- svelte-check: 0/0
- mcp-server-smoke: 8/8 still passing (no regression from the indexerClient changes)
- mcp-server build: clean, `dist/main.js` produced with shebang preserved

Smoke battery growth cp150 6111 → cp151 6114 (+3).  All three from the new body-cap smoke; no derived growth.

### Smoke runner script count

240 (was 239 at cp150).

### Lessons

#### Lesson #1 — Two-layer defense is necessary for size-based attacks

Pre-check alone (Content-Length) is insufficient because malicious servers can lie or omit the header.  Streaming check alone (running total) is wasteful because honest-but-oversized responses still allocate the first chunk before getting rejected.  Together: catch the easy 99% case at zero cost (pre-check), catch the hard 1% case at minimal cost (one chunk allocated max).

The same shape pattern would apply to other byte-volume defenses: pagination limits, rate limits, upload size limits.  Always pre-check the declared value, always enforce the actual value.

#### Lesson #2 — Tamper-test BOTH layers independently

Initial tamper test (set `DEFAULT_MAX_BODY_BYTES = MAX_SAFE_INTEGER`) FAILED because the env-var override neutralized it.  A real tamper needs to attack the enforcement logic, not just the configuration value.  cp151's tamper test attacks each check's comparison operator separately, which verifies the check itself is doing the work.

For any two-layer defense going forward: write the tamper test to disable each layer in isolation, confirming that scenario coverage is partitioned cleanly between the layers.

#### Lesson #3 — Unit-style smokes complement end-to-end smokes

`mcp-server-smoke.ts` is end-to-end (spawns process, speaks protocol).  `fetchjson-body-cap-smoke.ts` is unit-style (imports function, calls directly).  Both are valuable; neither replaces the other.

End-to-end smokes catch wire-protocol regressions.  Unit-style smokes catch function-contract regressions.  Pre-launch hardening benefits from both shapes in the same battery.

Going forward: when a function has a non-trivial contract (timeout, cap, retry, error mapping), prefer a unit-style smoke that exercises the contract directly.  Don't bundle into the end-to-end smoke just because the function is in the same workspace.

### Pending — cp152+ candidates

- **cp152 — brag-list-claim-parity extension to `.ts` marketing prose:** the cp146 Lesson #3 carryover.  Extend the smoke to walk `apps/mcp-server/src/tools/describeMorphit.ts` (and any other source file with marketing-grade copy) so future copy drift from the #1 Privacy & anonymity priority gets caught at smoke time, not at next walkthrough.
- **cp153 — shared comment-stripping helper for regex smokes:** cp149 Lesson #3 + cp142 self-reference.  Both `mcp-server-read-only-invariant-smoke` and `spawn-dist-prebuild-coverage-smoke` reimplement single-line + block-comment stripping.  Extract to `scripts/lib/strip-comments.ts`.
- **cp154 — F-mcp-1 SSRF defense via lifted federationProbe:** the cp146 Tier-B finding remaining.  Lift `apps/indexer/src/lib/federationProbe.ts` into a shared package, consume from both indexer and mcp-server.  Bigger refactor.
- **Memory rule #22 update** (carry-over from cp148): "three personas" → "four personas (Bob, Sally-user, Sally-operator, Charlie)."

---

## cp150 — REVISIT-LIST archive split (CLOSED 2026-05-27)

The cp148 + cp149 housekeeping candidate, shipped.  `docs/REVISIT-LIST.md` had grown to ~2.1MB (33,373 lines) by cp149.  Most maintainer queries only touch cp100+ entries; pre-cp100 content was load on every read but rarely consulted.

### What shipped

**Archive split at line 3427** (`## CP99 STATE`) — the natural boundary where cp99-and-earlier content begins.  Two files now:

- **`docs/REVISIT-LIST.md`** (live, 3437 lines, ~310KB) — cp100+ history.  cp150 entry sits at top, new entries always land here.
- **`docs/REVISIT-LIST-ARCHIVE.md`** (frozen, 29967 lines, ~1.8MB) — cp99-and-earlier history.  Includes the CP90-cp99 STATE/FIXES + PREDICTED HUNTING GROUND sections + the "Part 100"–"Part 108++" legacy entries at the bottom that predate the modern "cp###" numbering convention.

The split shaved ~86% of the live file's size (2.1MB → 310KB) without losing any content.

### Cross-file plumbing

**Live file footer** points at the archive with an explanation of WHY the split was done and WHEN.

**Archive file header** says:
- The file is FROZEN — new entries land in REVISIT-LIST.md, not here.
- What it covers (cp99-and-earlier) and what it doesn't (cp100+, TARBALL state, ADR decisions).
- Three concrete use cases where someone would actually read it (tracing a bug to pre-cp100 design, checking a lesson reference, understanding audit campaign evolution).

### Verified that no smoke or tool was affected

Two active smokes mention REVISIT-LIST:
- `scripts/operator-doc-fenced-path-existence-smoke.ts` — explicitly EXCLUDES REVISIT-LIST.md from its walk (treats it as historical journal).  Unchanged by split.
- `scripts/brag-list-claim-parity-smoke.ts` — same, excludes REVISIT-LIST + TARBALL + AUDIT-* docs.  Unchanged by split.

The widespread `REVISIT-LIST` mentions across `apps/indexer/src/**/*.ts` are all explanatory comments in source code (e.g. "see REVISIT-LIST for cpNN context").  None are file-path consumers.  Comments survive the split — they referenced cp-entries that are now in either the live file or the archive depending on the cp number.

### Boundary rationale

`## CP99 STATE` at line 3427 is the cleanest break because:
- `CP100 STATE` and `CP100 FIXES` sit just above (lines 3307–3322) and stay in the live file.
- Lessons between CP100 FIXES (line 3322) and CP99 STATE (line 3427) — ~100 lines of "Lesson #N" content — stay in the live file even though some discuss cp99 findings.  Topical, not strictly chronological, but the physical position in the file is what matters for the split.
- Everything from CP99 STATE downward is unambiguously archive-bound: CP99 STATE/FIXES → CP98 → CP97 → … → CP90 STATE/FIXES → PREDICTED HUNTING GROUND sections → Part 100-108++ legacy block.

### Verified clean

- Smoke battery: unchanged (cp149's 6111 carries through — no new scenarios, no removed scenarios; the smokes that walk REVISIT-LIST already excluded it).
- TypeScript: 0 errors × 11 projects (file is markdown, no type impact).
- File integrity: `wc -l` on both files sums to 33404 = 33373 (original) + 31 (new headers/footers).  No content lost.

### Smoke runner script count

239 (unchanged from cp149).

### Lessons

#### Lesson #1 — Splitting historical journals is mechanically simple when smokes already exclude them

The cost of this split was low because the relevant smokes were ALREADY excluding REVISIT-LIST from their walks.  If a smoke had been actively reading REVISIT-LIST to extract structured data (e.g. "find all open REVISIT items"), the split would have required updating that smoke to read BOTH files.

For any future archive split: first check if any tool actually parses the file's content.  If yes, the tool needs an update.  If no (the file is purely human-readable), the split is just a `sed` operation + cross-link.

#### Lesson #2 — File-size-driven housekeeping pays back the moment context windows tighten

A 2.1MB markdown file in context is ~500K tokens of working memory eaten by content that's almost never needed.  Splitting to 310KB live + 1.8MB archive (loaded only on explicit query) frees up the working memory for the cp-work that's actually happening this session.

The pattern is reusable: TARBALL.md is currently ~300KB and growing.  If/when it crosses ~1MB, do the same split.  AUDIT-2026-05.md is ~8,500 lines; the cp138-era audit is the live one but earlier audits could similarly archive.

#### Lesson #3 — Boundary commentary in the archive file is worth writing inline

The archive file's header lists THREE concrete reasons someone might read it.  Without that header, a future maintainer landing in REVISIT-LIST-ARCHIVE.md would have to read backwards to figure out what it contains and why it exists.  The 30-line header costs nothing to write at split time and saves real time later.

### Pending — cp151+ candidates

- **cp151 — F-mcp-5 fetch body cap:** add `Content-Length` / streamed-size enforcement to `fetchJson()`.  Cap at e.g. 4MB.  Currently a malicious instance could return a multi-GB response and exhaust Charlie's memory.  ~40 LOC + tamper test.
- **cp152 — brag-list-claim-parity walks `.ts` marketing prose:** extend the smoke to walk `apps/mcp-server/src/tools/describeMorphit.ts` and any other source file that contains marketing-grade claims.  cp146 Lesson #3.
- **cp153+ candidates:**
  - F-mcp-1 SSRF defense: lift `apps/indexer/src/lib/federationProbe.ts` into shared package (bigger refactor)
  - Shared comment-stripping helper for regex smokes (cp149 Lesson #3)
- **Memory rule #22 update** (carry-over from cp148): "three personas" → "four personas (Bob, Sally-user, Sally-operator, Charlie)."

---

## cp149 — mcp-server read-only invariant smoke (CLOSED 2026-05-27)

The cp148-Lesson-#3 candidate, shipped.  Charlie's read-only architectural property is now code-enforced.

### What shipped

**`scripts/mcp-server-read-only-invariant-smoke.ts`** (~350 lines) — three invariants over every `.ts` file under `apps/mcp-server/src/`:

1. **No signing/mutation primitives imported.**  Pattern list blocks both module specifiers AND symbol names:
   - Module specifiers: `libsodium-wrappers`, `libsodium-wrappers-sumo`, `@noble/curves/*`, `@noble/secp256k1`, `secp256k1`, `tiny-secp256k1`, `@blurtfoundation/*`, `blurt-js`, `dsteem`, `@steempro/*`
   - Symbol names: `signTx`, `signAuthored`, `signPostingKey`, `signActiveKey`, `signMemoKey`, `signMemo`, `broadcastTransaction`, `broadcastAuthored`, `deriveKeyPair`, `derivePostingKey`, `crypto_sign*`, `sodium`

2. **No mutation-API symbols from `@morphit/{indexer,relay}-client`.**  Forward-looking — mcp-server doesn't currently consume these packages, but a future change to import from them would need to skip mutation helpers (postOrder, postFeedback, broadcastEvent, etc.).  Regex: `/^(post|submit|broadcast|cancel|mutate|sign|publish|send)[A-Z]/`.

3. **No raw `fetch(` calls outside `indexerClient.ts`.**  Every network call must inherit the cp146 hardening via `fetchJson()`.  Comment-stripping (single-line `//` and block `/* */`) handles docstrings mentioning fetch without false-positiving.

### Tamper-test results

All three invariants tested independently, each restored before next:

- **Invariant 1:** injected `import { signTx } from '@noble/curves/secp256k1'` into `main.ts`.  Smoke fires both module-match (`@noble/curves`) AND symbol-match (`signTx`) with the message: "SIGNING PRIMITIVE LEAKED INTO READ-ONLY MCP SERVER ... Charlie (the AI-agent persona, cp148 walkthrough) is documented as read-only-by-construction; adding signing primitives to mcp-server invalidates the entire AI-agent trust model. If this is intentional, write an ADR explaining the shift first, then update the cp148 walkthrough, then carve a deliberate exception into this smoke's allowlist."

- **Invariant 2:** injected `import { postOrder } from '@morphit/indexer-client'` into `main.ts`.  Smoke fires invariant 2 with PascalCase regex hit naming the symbol and source.

- **Invariant 3:** appended `const x = await fetch('https://example.com');` to `searchOrders.ts`.  Smoke fires invariant 3 with file:line + remediation pointing at `fetchJson()`.

After restore: 3/3 baseline pass.

### Why this is the cp148 Lesson #3 closure

cp148 walked Charlie's read-only property as a load-bearing trust claim and verified it inline with a single grep.  That verification was correct at the moment of the walkthrough, but couldn't catch future drift.  cp149 closes the window:

- Without cp149: Charlie's read-only property is preserved by reviewer attention.  A PR that imports a signing primitive could land silently; the next walkthrough (weeks later) catches the drift.
- With cp149: any PR that imports a signing primitive into `apps/mcp-server/src/` fails CI immediately.  The trust model is enforced by code.

The pattern matches cp142/144/145/146 meta-smokes: find a real fact, fix the immediate instance, write a smoke to prevent regression of the CLASS.

### Verified clean

- Triple-pulse smokes: 6111/6111/6111, 0 runners failed (pulses 59, 60, 61)
- TypeScript: 0 errors × 11 projects
- svelte-check: 0/0
- All three tamper-tests succeed independently

Smoke battery growth cp148 6107 → cp149 6111 (+4).  Breakdown: +3 from new smoke's 3 scenarios, +1 derived growth in `last-char-tamper-anti-pattern-smoke.ts` from walking the new smoke file.

### Smoke runner script count

239 (was 238 at cp148).

### Lessons

#### Lesson #1 — Walkthrough assertions become smokes

The cp148 walkthrough's "Charlie is read-only by construction" was a verified-once assertion.  Code-enforcing it converts a manual audit step into a permanent guarantee.

Going forward: any walkthrough that asserts an architectural property (no-signing, no-mutation, no-state, federation-aware, locale-parity) should consider whether the assertion can be lifted into a smoke.  Not all can — some are too subjective ("grandma-friendly UX") — but the structural ones (import-based, file-presence-based, count-based) usually can.

This is the inverse of cp146 Lesson #3 ("the brag-list-claim-parity smoke doesn't cover source-code-embedded prose"): there, marketing prose drifted because no smoke watched it; here, architectural posture is now smoke-watched.

#### Lesson #2 — Pattern lists are easier to extend than allowlists are to weaken

cp149's signing-primitive list has 12 entries; adding more is just appending to the array.  If a future signing library not on the list lands, that's a bug — fix by adding to the pattern list, not by carving exceptions.

Compare to the F-mcp-2 SSRF defense: that one uses an allowlist posture (everything denied unless allowed).  Both patterns are valid; the choice depends on whether the failure mode is "imported a thing I shouldn't" (denylist) or "imported a thing that should be specifically validated" (allowlist).

For mcp-server's read-only property, denylist is correct: there's a clearly enumerable set of mutation primitives, and any one of them appearing is a smell.

#### Lesson #3 — Comment-stripping in regex smokes is worth the 30 LOC

cp149's invariant 3 (no raw `fetch(` outside indexerClient.ts) had to handle the case where a docstring describes how `fetchJson()` wraps `fetch()`.  Without comment-stripping, the smoke would false-positive on its own design documentation.

The strip pass is ~30 LOC handling `//` and `/* */` (single-line and multi-line block comments).  Doesn't perfectly handle `/* */` inside strings, which is fine for the use case.  Pattern is reusable for any future regex smoke that walks source files.

cp142's `spawn-dist-prebuild-coverage-smoke` did the same thing.  Worth standardizing into a shared helper at some point (cp150+ candidate).

### Pending — cp150+ candidates

- **cp150 — REVISIT-LIST archive:** `docs/REVISIT-LIST.md` is now ~2.1MB.  Pre-cp100 history is rarely referenced.  Archive cp001–cp099 to `docs/REVISIT-LIST-ARCHIVE.md`; keep cp100+ in the live file.
- **cp150+ housekeeping:**
  - Extend brag-list-claim-parity to walk certain `.ts` files for marketing prose (cp146 Lesson #3)
  - F-mcp-1 SSRF defense: lift `apps/indexer/src/lib/federationProbe.ts` helpers into a shared package
  - F-mcp-5 fetch body cap
  - Shared comment-stripping helper for regex smokes (cp149 Lesson #3)
- **Memory rule #22 update** (carry-over from cp148): "three personas" → "four personas (Bob, Sally-user, Sally-operator, Charlie)."

---

## cp148 — Four-persona walkthrough (CLOSED 2026-05-27)

Standing memory rule #22 walkthrough for this session.  First walkthrough in the project's history to include a fourth persona: Charlie (an AI agent invoking Morphit via the cp140 MCP server).

### What shipped

**`docs/FOUR-PERSONA-WALKTHROUGH-cp148.md`** — 318 lines, delta against cp139:

- **Bob (multi-login Blurt user):** Zero code path changes in cp140–cp147 affect him.  cp140 surfaces new tradable assets in his orderbook filter; cp146 F-mcp-16 affects copy he never sees.  Standing functionality re-verified (multi-login `reset()`, posting-only import, `/post` broadcast with redactPrivateKeys, locale resolution).

- **Sally-user (no crypto):** Same as Bob — sees cp140 new assets, no flow changes.  First-buy waiver (ADR-0011), feedback chain, privacy-positive session-only seed default, push-subscription per-account cap all unchanged.

- **Sally-operator:** cp140 new asset disable mechanism works identically via `MORPHIT_INDEXER_DISABLED_ASSETS` env var.  cp144 lockfile fix is silently correct on next git pull (she'd never have triggered the failure because she installs from tarball, not git).  cp146 mcp-server changes don't touch her deployed instance — the MCP server runs on the END USER's machine, not the operator's instance.

- **Charlie (NEW):** Full flow walked.  Highest-impact change is cp146 F-mcp-16 honest IP-visibility copy in `describeMorphit` — Charlie now quotes the accurate "Instance operators see IP at HTTP layer; data model retains no per-user IP log; Tor onions available" to users instead of the misleading pre-cp146 "no IP logging by design."  Other cp146 fixes (F-mcp-2/3 URL-redaction + redirect:manual, F-mcp-4 User-Agent from package.json, F-mcp-6/13/17 getInstanceUrl consolidation, F-mcp-12 URL builder, F-mcp-23/24 README forthcoming markers, F-mcp-30 LICENSE file) all improve Charlie's reliability or honesty.

### Two factual claims verified inline in the audit

1. **Charlie is read-only by construction.**  `grep -rln "signTx|signAuthored|signPostingKey|signMemo|broadcastTransaction|sodium.crypto_sign|secp256k1" apps/mcp-server/src/` returns zero matches.  The MCP server has no signing primitives imported and cannot mutate user state under any tool invocation.

2. **F-mcp-16 copy matches what the walkthrough quotes.**  The describeMorphit summary string in `apps/mcp-server/src/tools/describeMorphit.ts` reads exactly as the walkthrough quotes: "Instance operators see the connecting IP at the HTTP layer (same as any web service); Morphit's data model retains no per-user IP log of its own, and instances expose Tor onions for users who want IP-level unlinkability."

### Caught one real smoke regression

The cp137 and cp139 walkthroughs were already in `ALLOWED_PATHS` of `apps/indexer/scripts/db-password-placeholder-smoke.ts` because they mention `CHANGE_ME_BEFORE_PRODUCTION` in the Sally-operator section.  The new cp148 walkthrough's standing-memory-items table makes the same reference in the same explanatory posture.

First pulse failed at db-password-placeholder-smoke with:

```
✗ no rogue placeholder strings in tracked source:
  Found 2 unexpected placeholder reference(s):
    docs/FOUR-PERSONA-WALKTHROUGH-cp148.md:290  contains "CHANGE_ME"
    docs/FOUR-PERSONA-WALKTHROUGH-cp148.md:290  contains "CHANGE_ME_BEFORE_PRODUCTION"
```

The smoke is doing the right thing — it's the denylist sentinel and any new file referencing it has to be deliberately allowed.  Added the walkthrough to `ALLOWED_PATHS` with the same rationale comment pattern as the cp137/cp139 entries.  Pulse re-ran cleanly.

This is a positive example of the smoke working as designed: a documentation addition naturally tripped the security sentinel because the doc contains explanatory text about the sentinel itself.  The fix is procedural (add to allowlist with rationale), not architectural.

### Process observation: memory rule #22 should mention four personas

Memory rule #22 reads: "every major session runs 3 personas end-to-end — Bob (Blurt user multi-login), Sally-user (no crypto), Sally-operator (node from any `.md`, every CLI/screen/button, launch→week1)."

cp140's MCP server introduced an audience distinct enough from these three to warrant fourth-persona status.  Bob is a human reading the web UI.  Sally-user is a non-crypto human reading the web UI.  Sally-operator is a sysadmin running the indexer/relay/web stack.  Charlie is an AI agent making MCP tool calls and quoting structured output back to a human user.  The Charlie persona's coverage is different (read-only, deeplink handoff, marketing-copy fidelity, no UI to walk) and deserves its own discipline.

The walkthrough recommends updating memory rule #22 to "four personas (Bob, Sally-user, Sally-operator, Charlie)" going forward.  This is a memory edit recommendation, not a code change.

### Verified clean

- Triple-pulse smokes: 6107/6107/6107, 0 runners failed (pulses 56, 57, 58)
- TypeScript: 0 errors × 11 projects
- svelte-check: 0/0

Smoke battery count unchanged: cp147's 6107 = cp148's 6107.  The new doc would have added +1 to doc-walker counts, offset by the new file being structurally identical to the cp137/cp139 walkthroughs.

### Lessons

#### Lesson #1 — Personas track the AUDIENCES the codebase serves, not just the UI flows

The three-persona convention served fine through cp139 because Morphit had a single user-facing surface: the web UI.  cp140's MCP server introduced a second user-facing surface: the AI-agent tool-call API.  A walkthrough that walks only the web UI misses an entire audience.

Going forward: when a checkpoint introduces a new user-facing surface, the walkthrough discipline grows to cover that surface.  The number of personas isn't an inviolable count; it tracks the number of distinct user-facing surfaces the project has.

#### Lesson #2 — Security sentinel smokes can catch documentation additions; this is correct behavior

The db-password-placeholder smoke is by design intolerant of any new file mentioning `CHANGE_ME` / `CHANGE_ME_BEFORE_PRODUCTION` outside an allowlisted set.  When a new doc legitimately needs to reference the sentinel (as the cp148 walkthrough does), the fix is to add the doc to the allowlist with a rationale comment — NOT to weaken the smoke's pattern.

This pattern is repeatable for any sentinel-style smoke: deliberate allowlists with rationale, never weaken the detector.  Cited as anti-pattern in cp146 Lesson #2 (the `yaml` phantom-dep risk has the same shape — don't reach for the looser solution).

#### Lesson #3 — Read-only architectural properties deserve grep-verifiable assertion in walkthroughs

The walkthrough claims "Charlie is read-only by construction."  Rather than just assert it, the walkthrough authors verified it inline: `grep -rln "signTx|signAuthored|signPostingKey|signMemo|broadcastTransaction|sodium.crypto_sign|secp256k1" apps/mcp-server/src/` returns zero matches.

This is a load-bearing trust claim for the AI-agent audience.  Future audits should preserve this invariant; if any signing primitive is ever imported into `apps/mcp-server/src/`, that's a major architectural shift requiring its own ADR.  Consider extracting this grep into a meta-smoke (cp149+ candidate).

### Pending — cp149+ candidates

- **cp149 — mcp-server read-only invariant smoke:** lock in Charlie's read-only-by-construction property with a grep-based smoke that fails if any signing primitive lands in `apps/mcp-server/src/`.  Cost: ~30 LOC.  Value: prevents a class of future architectural drift.
- **cp149+ housekeeping (unchanged from cp147):**
  - `docs/REVISIT-LIST.md` is now ~2.1MB — consider archiving pre-cp100 history
  - Extend brag-list-claim-parity to walk certain `.ts` files for marketing prose (cp146 Lesson #3)
  - F-mcp-1 SSRF defense: lift `apps/indexer/src/lib/federationProbe.ts` helpers into a shared package
  - F-mcp-5 fetch body cap
- **Memory rule #22 update:** memory rule references "three personas"; recommend updating to "four personas (Bob, Sally-user, Sally-operator, Charlie)" so future sessions don't omit Charlie's walk.

---

## cp147 — `docs/ADDING-A-WORKSPACE.md` (CLOSED 2026-05-27)

The maintainer-side companion to the cp142–cp146 technical defenses.  cp142–cp146 added five different safety nets that would have caught cp140's oversight if they'd been there; cp147 raises the floor by giving future maintainers the checklist that avoids needing the nets at all.

### What shipped

**`docs/ADDING-A-WORKSPACE.md`** — 478 lines, six phases:

1. **Decide the workspace shape** — four questions:
   - apps/ vs packages/? (runnable software vs shared library)
   - publishable to npm? (sets the LICENSE + files-array requirement)
   - ships compiled artifacts? (the cp142 dist/ self-heal class)
   - calls out over the network? (the cp146 F-mcp-2/3 SSRF-flavor class)

2. **Create the workspace** — package.json template (for both publishable-CLI shape and library shape), tsconfig.json template, LICENSE copy rule.

3. **Wire into the monorepo** — five sub-steps:
   - Register in root `package.json:workspaces`
   - **Regenerate `package-lock.json`** with `npm install` then verify `npm ci --dry-run` passes (the cp144 step, called out in bold)
   - Register tsconfig in `scripts/typecheck-sweep.sh`
   - Add LICENSE to `package.json:files` if publishable
   - Add build step to `.forgejo/workflows/ci.yml` if dist-shipping

4. **Build smokes** — minimum content (wire-up sanity / happy path / error path), the cp142 dist-spawn guard pattern with copy-pastable `ensureBuilt()` helper, run-smokes.sh registration line, canonical `✓ all N` emit rule.

5. **Pre-PR verification ladder** — six steps in order:
   - Fresh-checkout clone + `npm ci`
   - Build any compiled workspaces
   - `bash scripts/typecheck-sweep.sh`
   - Triple-pulse smokes
   - svelte-check if web touched
   - Meta-smokes (cp142/144/145/146 enforcement)

6. **Docs** — workspace README (with from-source-first format per cp146 Lesson #4), ADR if architectural, brag-list only if user-facing.

Plus two reference tables at the end:

- **"What gets caught automatically"** — maps each cp142–146 meta-smoke to its class of bug
- **"The cp140 → cp146 sequence"** — six-row table showing the entire failure cascade with what each cp caught and how it was fixed

### Cross-linking

All three maintainer playbooks now reference each other:

- `README.md` For-developers section: added entries for ADDING-A-WORKSPACE, ADDING-A-COIN, LOCALE-GRADUATION (previously only ADDING-A-COIN was findable, and that indirectly through ADR references)
- `LOCALE-GRADUATION.md`: sibling-doc reference paragraph after the opening summary
- `ADDING-A-COIN.md`: sibling-doc reference paragraph after the two-phase intro

A new maintainer landing in any one of them can find the other two.

### Verified clean

- Triple-pulse smokes: 6107/6107/6107, 0 runners failed (pulses 53, 54, 55)
- TypeScript: 0 errors × 11 projects
- svelte-check: 0/0

Smoke battery growth cp146 6101 → cp147 6107 (+6).  All from doc-walker smokes picking up the new 478-line file (brag-list-claim-parity walking maintainer-doc references, locale-doc-coverage smokes, etc.).  No new scenarios authored — cp147 is doc-only.

### Lessons

#### Lesson #1 — Codify procedures the moment they're a recurring failure mode

cp140's oversight wasn't a one-off.  Every previous workspace addition (apps/indexer, apps/relay, apps/web, apps/ops-cli, apps/matrix-bot) silently followed the same checklist informally, and only cp140 happened to skip enough sub-steps to break CI.  The maintainer-side procedure was implicit; cp147 makes it explicit.

The cost of writing a 478-line doc is real but bounded.  The cost of every future workspace add re-running the cp140 failure cascade compounds.  Procedural docs pay back fast.

#### Lesson #2 — Cross-linking matters; isolated docs don't get found

Pre-cp147, `LOCALE-GRADUATION.md` (181 lines, cp141) and `ADDING-A-COIN.md` (636 lines, much older) existed but only referenced each other implicitly.  Neither appeared in `README.md`'s For-developers section.  A new maintainer working on apps/web wouldn't find LOCALE-GRADUATION; one working on a new coin wouldn't find ADDING-A-COIN unless they happened to read ADR-0044's references.

cp147 fixed this for all three docs in one pass: README links to all three, each links to the others.  Future cp14X+ doc additions should follow the same pattern at creation time.

#### Lesson #3 — Reference tables (not prose) close out the doc

The "cp140 → cp146 sequence" table at the end of ADDING-A-WORKSPACE.md is more useful than the surrounding prose because it's scannable.  A maintainer in a hurry can read just the table and get 90% of the value; the prose phases support depth when they need it.

Future procedural docs: lead with a checklist, end with a reference table.  Prose is the connecting tissue, not the deliverable.

### Pending — cp148+ candidates

- **cp148:** Persona walkthrough #4 (Bob multi-login / Sally-user no-crypto / Sally-operator launch→week1) with new "AI agent" persona for MCP server end-to-end (Claude Desktop / Cline / Cursor configs).  Latest is `docs/THREE-PERSONA-WALKTHROUGH-cp139.md`.
- **cp149+ housekeeping:**
  - `docs/REVISIT-LIST.md` is now ~2.1MB — consider archiving pre-cp100 history to `docs/REVISIT-LIST-ARCHIVE.md`
  - Extend brag-list-claim-parity to walk certain `.ts` files for marketing prose (cp146 Lesson #3 — the `describeMorphit` "no IP logging by design" copy drift would have been caught earlier)
  - F-mcp-1 SSRF defense: lift `apps/indexer/src/lib/federationProbe.ts` helpers into a shared package and consume from both indexer and mcp-server
  - F-mcp-5 fetch body cap

---

## cp146 — `apps/mcp-server` pre-launch deep-deep (CLOSED 2026-05-27)

The workspace cp138/cp139 audits never covered, since cp140 introduced it after those passes completed.  cp142–cp145 hardened the SCAFFOLDING around mcp-server (smoke, lockfile, CI surface).  cp146 audits the CODE itself.

### Audit scope

| File | LOC | Audited for |
|---|---|---|
| `src/main.ts` | 219 | MCP protocol wiring, tool registry, zod→JSON-Schema converter, error paths |
| `src/indexerClient.ts` | 125 | HTTP surface, SSRF posture, error-leak surface, timeout, body cap |
| `src/tools/searchOrders.ts` | 164 | Input validation, deeplink construction, response trimming |
| `src/tools/getListing.ts` | 81 | Account/permlink validation, fetch-then-filter pattern, deeplink |
| `src/tools/listInstances.ts` | 79 | Response field whitelisting |
| `src/tools/listPaymentMethods.ts` | 40 | Pass-through fetch |
| `src/tools/describeMorphit.ts` | 98 | Marketing-copy honesty, env-var consumption |
| `scripts/mcp-server-smoke.ts` | 432 | Wire protocol, NDJSON framing, dist self-heal (cp142 carry-over) |
| `README.md` | 176 | Distribution claims, wiring instructions, privacy copy |
| `package.json` | 41 | files array consistency, bin/build coverage, license declaration |
| `tsconfig.json` + `tsconfig.build.json` | 36 | Strictness settings, output shape |
| `docs/adr/0044-mcp-server.md` | 74 | Design rationale, no findings |

Total: ~1565 LOC + docs.  ~35 findings emerged.

### Tier A (8 fixed this turn)

**F-mcp-30 — packaging defect (was about to publish without LICENSE)**
`apps/mcp-server/package.json:files` listed `LICENSE` but `apps/mcp-server/LICENSE` didn't exist.  `npm publish` silently skips missing files in the files array — the tarball would have shipped without a license file, leaving npmjs.com showing "No license" and downstream consumers unable to verify license compliance.

The same smoke (cp146 NEW, see below) caught FOUR additional private workspaces with no LICENSE in their files arrays — but they're `"private": true` so they never publish.  No fix needed for those; the smoke's `isPublishable` heuristic correctly skips them.

**Fix:** `cp LICENSE apps/mcp-server/LICENSE`.

**F-mcp-2 — URL credentials leak into error messages**
`indexerClient.fetchJson` had three error paths that echoed the full URL back to the caller:
- `HTTP ${res.status} ... from ${url}: ...`
- `request to ${url} timed out`
- (new in cp146) `unexpected redirect from ${url}`

If `MORPHIT_MCP_INSTANCE_URL` is set to `https://user:pass@morphit.io/` (a misconfiguration but not implausible), credentials propagate into the MCP tool-call error, which the AI agent renders to the user, which the user pastes into chat support, which lands in someone's transcript.

**Fix:** new `redactUserinfo(url)` helper that clears `.username`/`.password` on a parsed URL before `.toString()`.  Returns the input unchanged if it doesn't parse (callers already validate via `getInstanceUrl()`).  All three error paths wrap the URL via `redactUserinfo()` now.

**F-mcp-3 — fetch follows redirects with no SSRF defense**
`indexerClient.fetchJson` used default `redirect: 'follow'`.  A malicious or misconfigured instance could 302 the MCP client to an internal address (127.0.0.1, 192.168.x, link-local), and the fetch would chase the redirect with the client's process credentials.  cp139-F-2 already added this exact defense to the indexer's `federationProbe`.

**Fix:** `redirect: 'manual'` + branch on `res.type === 'opaqueredirect'` or 300-399 status, emit clean "unexpected redirect from {url}" error.

**F-mcp-4 — User-Agent version hardcoded as string literal**
`'morphit-mcp/1.0.0-beta.1 (+https://morphit.io)'`.  When the package version bumps to 1.0.0-beta.2 or 1.0.0, this string silently drifts.

**Fix:** read version from package.json via `createRequire(import.meta.url)('../package.json').version`.  Build into `USER_AGENT` constant at module load.

**F-mcp-6 / F-mcp-13 / F-mcp-17 — three places read MORPHIT_MCP_INSTANCE_URL directly**
`searchOrders.ts:142`, `getListing.ts:64`, `describeMorphit.ts:54` all had a copy-pasted `(process.env.MORPHIT_MCP_INSTANCE_URL || 'https://morphit.io').replace(/\/+$/, '')` pattern.  `indexerClient.ts` already had a properly-validating `getInstanceUrl()` (scheme check, trailing-slash strip, malformed-URL rejection) but these three tools bypassed it.

**Fix:** exported `getInstanceUrl()` (was already exported), updated all three callers to use it.

**F-mcp-12 — getListing deeplink built via raw string concat**
`\`${base}/en/@${input.account}/${input.permlink}\`` — Zod regexes constrain `account` and `permlink` to safe character sets, but the URL builder is the right structural defense in depth.  If a future change to the validators ever loosens those grammars, the deeplink wouldn't silently sprout an injection point.

**Fix:** `new URL(\`/en/@${input.account}/${input.permlink}\`, getInstanceUrl()).toString()`.

**F-mcp-16 — "no IP logging by design" misleads on instance-level visibility**
The `describeMorphit` summary text said `"... no email collection, no IP logging by design."`  The AI agent quotes this verbatim to users.  But Morphit's actual privacy posture (per METADATA-LEAK-CATALOG.md) is: instance operators DO see connecting IPs at the HTTP layer (same as any web service); Morphit's data model doesn't deliberately retain per-user IP records; Tor onions are available for users who want IP-level unlinkability.

The "no IP logging by design" phrasing reads as "no IP visible" — which is the strong form, and false.

**Fix:** tightened to "Instance operators see the connecting IP at the HTTP layer (same as any web service); Morphit's data model retains no per-user IP log of its own, and instances expose Tor onions for users who want IP-level unlinkability."  Matches the #1 Privacy & anonymity priority more honestly.

**F-mcp-23 + F-mcp-24 — README directs to unpublished pipelines**
README said `npm install -g morphit-mcp` (npm pipeline) and `docker run ghcr.io/agorise/morphit-mcp:latest` (Docker pipeline).  Neither pipeline exists yet — release.yml only builds a tarball, no `npm publish` or `docker push` step.  Users following the README would get "package not found" or "image not found."

**Fix:** added a "Beta status" callout marking npm + Docker as "forthcoming with v1.0.0 stable."  Restructured Installation: from-source instructions first (current beta state), npm + Docker labeled "(forthcoming, v1.0.0 stable)."  Updated Claude Desktop wiring example to show from-source `command: "node"` config alongside the npm `command: "npx"` config.  Honest disclosure beats aspirational drift.

**mcp-server-smoke temporal-const ordering**
Smoke's `ensureBuilt()` referenced `ANSI_RED`/`ANSI_RESET` consts declared below it.  TDZ-safe because called at runtime, but fragile.

**Fix:** hoisted ANSI consts above `ensureBuilt()`.

### NEW class-of-bug meta-smoke

`scripts/package-files-exist-smoke.ts` (~220 lines) — three invariants enforced repo-wide:

  1. **Every non-glob entry in `package.json:files` exists.**  Globs (`dist/`, `src/**/*`) are accepted as npm's responsibility at publish time.  Catches the F-mcp-30 class permanently going forward.
  2. **Every workspace `bin` target either exists OR is in `dist/` with a corresponding `build` script.**  The cp142 self-healing pattern.
  3. **Every publishable workspace (non-`private` with `bin`/`main`/`exports`) declares `LICENSE` in its files array.**

The `isPublishable` heuristic correctly skips `"private": true` workspaces — `packages/asset-registry`, `packages/indexer-client`, `packages/operator-config`, `packages/relay-client` all match this and don't need a LICENSE declaration.

**Tamper-test 1** (delete `apps/mcp-server/LICENSE`):
> ✗ every entry in package.json:files exists — apps/mcp-server missing: LICENSE

**Tamper-test 2** (change bin to `dist/nonexistent.js`, delete dist/):
> ✗ every entry in package.json:files exists — apps/mcp-server missing: dist/
(invariant 1 fires before invariant 2 because the files array entry also breaks)

**Tamper-test 3** (remove LICENSE from files array):
> ✗ every publishable workspace declares LICENSE in package.json:files — apps/mcp-server

All three tamper tests restored cleanly; smoke goes 3/3 again.

### Tier B (5 deferred to REVISIT-LIST as cp147+ candidates)

- **F-mcp-1** (MED security): `fetchJson` has no SSRF defense vs internal addresses (private IPv4 ranges, link-local, ::1).  The right fix is to lift the indexer's `federationProbe` defenses into a shared package and have both indexer and mcp-server import from it.  Trust model argument: MORPHIT_MCP_INSTANCE_URL is user-supplied, so SSRF here means "user attacked themselves via misconfig OR compromised MCP-client config."  The latter is an existing concern (a compromised MCP config can do far worse than SSRF), but defense in depth still wants the addr-range denylist.  Bigger refactor than this audit's scope.

- **F-mcp-5** (LOW): no fetch body cap.  A malicious instance could return a multi-GB JSON response and exhaust memory.  Defense in depth alongside F-mcp-1.

- **F-mcp-7** (LOW UX): all deeplinks hardcode `/en/` locale prefix.  Web UI's Accept-Language detection would do the right thing without a prefix.  Cleanup, not a bug.

- **F-mcp-22** (LOW docs): mention of `:latest` Docker tag now context-fixed by cp146 README updates marking Docker as forthcoming; revisit when the Docker pipeline lands.

- **F-mcp-27** (LOW): `verbatimModuleSyntax: false` inconsistent with other workspaces.  Style cleanup.

### Tier C (22 INFO findings, not bugs)

Documented in audit notes; no action needed.  Includes things like: zod-to-json-schema fallback returns `{}` for unhandled types (fine; Zod validates downstream), order of zod fields doesn't match query string order (cosmetic), "Goose, mcp-agent" third-party tool name dependence in README (low risk), etc.

### Verified clean

- Triple-pulse smokes: **6101/6101/6101**, 0 runners failed (pulses 50, 51, 52)
- TypeScript: 0 errors × 11 projects
- svelte-check: 0/0
- mcp-server-smoke: 8/8 with all the source changes
- mcp-server build (`npm run build -w apps/mcp-server`): clean, produces `dist/main.js` with shebang preserved

### Smoke battery growth

cp145's 6097 → cp146's 6101 (+4).  Breakdown: +3 from new package-files-exist-smoke's 3 scenarios, +1 derived growth in `last-char-tamper-anti-pattern-smoke.ts` from walking the new smoke file.

### Lessons

#### Lesson #1 — npm publish's `files` array silently skips missing entries

`npm publish` does not warn when an entry in `package.json:files` doesn't exist on disk.  It just doesn't include the file in the tarball.  This is the F-mcp-30 root cause: someone added `"LICENSE"` to the files array (correct intent), then never created the LICENSE file (missed step), and there was no signal that the package was about to publish without it.

The cp146 meta-smoke closes this for the whole monorepo.  Even with future workspaces added, the smoke catches the class.

#### Lesson #2 — `dist/`-flavored fragility in package.json:bin needs class-of-bug coverage on three sides

When a workspace declares `bin: dist/something.js`, three things have to be true at every install point:

1. The workspace declares a `build` script (cp142 enforced this).
2. The smoke that exercises the bin either lazy-builds or guards against missing dist/ (cp142 enforced this via `spawn-dist-prebuild-coverage-smoke`).
3. The `files` array includes `dist/` so the published tarball ships the built artifact, and a smoke confirms the directory exists (cp146 enforces this via `package-files-exist-smoke`).

Together: a fresh-checkout + smoke run + npm publish all succeed without silent skip-and-ship failures.

#### Lesson #3 — User-facing marketing copy belongs under claim-parity discipline too

The "no IP logging by design" phrasing in `describeMorphit` was written months ago and survived multiple audits because no smoke checked it.  The cp141 brag-list-claim-parity smoke covers MARKETING_DOCS but doesn't cover source-code-embedded prose.

If similar marketing-grade claims appear in other places (FAQ, ADRs, comment-prose), they could similarly drift from the #1 Privacy & anonymity priority's honesty bar.  Candidate cp147+: extend brag-list-claim-parity to also walk certain `.ts` files for known marketing phrases (or, easier, move all marketing copy out of `.ts` and into a single canonical doc).

#### Lesson #4 — README distribution claims need to track reality, not aspirations

The pre-cp146 README told users `npm install -g morphit-mcp` and `docker run ghcr.io/agorise/morphit-mcp`.  Both commands would fail with "not found" until the corresponding publish pipelines land — which they haven't.  Users following the docs would file confused issues.

For pre-launch: docs should describe the current observable reality, with "forthcoming" markers for planned-but-not-shipped paths.  Easier to migrate "forthcoming" → "live" at release time than to migrate confused users away from broken docs.

---

## cp145 — CI workflow audit (CLOSED 2026-05-27)

The cp142–cp144 trifecta had focused on the smoke-battery side of the pipeline: hangs inside smokes, lockfile drift breaking install.  cp145 audits the OTHER side: the workflow YAML itself.  Both `.forgejo/workflows/*.yml` read end-to-end, 460 lines, 5 jobs.

### Findings table

| # | Severity | Finding | Where | Disposition |
|---|---|---|---|---|
| 1 | MED | No `timeout-minutes` on any of the 5 jobs | both workflows | **Shipped** |
| 2 | LOW | pip ansible install unpinned | ci.yml 116-124, ci.yml 159-164, release.yml 130-135 | Punted with rationale |
| 3 | LOW | Outer `for i in 1 2 3` smoke loop unprotected | ci.yml 183-191, release.yml 144-149 | Subsumed by #1 |
| 4 | INFO | npx in web-check could go network in pathological cases | ci.yml 91-107 | Punted (legibility > DRY) |
| 5 | INFO | release.yml's `npm ci` already enforces cp144 lockfile invariant | release.yml 127-128 | No fix needed |

### Finding #1 (MED) — Shipped

**Class:** the cp143 hang class, but at the JOB level above the smoke-battery level cp143 already covers.

cp143's per-smoke `timeout 240` catches a single smoke hang inside the smoke battery.  But every OTHER CI step has no protection:

- `npm ci` (3 places)
- `bash scripts/typecheck-sweep.sh` (which itself shells `tsc --noEmit` 11 times)
- `npx svelte-kit sync`
- `npx svelte-check`
- `pip3 install --break-system-packages --quiet ansible ansible-lint` (3 places)
- `ansible-galaxy collection install -r ...` (network-dependent)
- `ansible-lint --offline --strict playbook.yml`
- `npm run build -w apps/mcp-server` (cp142 addition)
- `gpg --import` (release only)
- `git fetch ... refs/tags/...` (release only)
- `git verify-tag` (release only)
- `tar --exclude=...` (release only)
- `sha256sum` (release only)
- `actions/upload-artifact@v3` (release only, network-dependent)

Any one of these hanging would burn the runner's default ceiling — unlimited on self-hosted Forgejo, 360 minutes on hosted GitHub Actions.  The `concurrency: cancel-in-progress: true` declared in ci.yml only cancels SUPERSEDED runs, not stuck ones.

**Calibrated timeouts:**

| Job | Observed runtime | Ceiling | Headroom |
|---|---|---|---|
| typecheck | <2 min | 10 min | 5× |
| web-check | ~3 min | 10 min | 3.3× |
| ansible-lint | <1 min | 5 min | 5× |
| smokes | ~18 min (triple-pulse) | 45 min | 2.5× |
| release | ~25 min | 60 min | 2.4× |

**Meta-smoke:** `scripts/ci-workflow-hardening-smoke.ts` (~210 lines) enforces 4 invariants on `.forgejo/workflows/*.yml`:

  1. Every CI job declares `timeout-minutes:`.
  2. Every `timeout-minutes:` is in range 1..90.
  3. Every job pins `runs-on` to a concrete OS (no `-latest` aliases).
  4. Every job has `runs-on` declared.

Parser is regex-based (state machine over the YAML lines).  The project's transitive `yaml` package is a phantom dep (no workspace declares it directly), so importing from a smoke would be fragile.  Workflow YAML uses tight conventions (2-space job indent, 4-space field indent) that make regex parsing sufficient.

**Tamper-test results** (3 independent runs, each restoring before the next):

  - Strip `timeout-minutes: 10` from typecheck + web-check → smoke fires with exact filename + job-name + line-number for both, plus the fix instruction.
  - Set `timeout-minutes: 9999` on smokes → smoke flags as out-of-range with split-job suggestion.
  - Change `ubuntu-24.04` → `ubuntu-latest` everywhere → smoke names all 4 jobs as moving-target with reproducibility warning.

After restore: 4/4 baseline pass.

### Finding #2 (LOW) — Punted with reasoning

Three places in two workflows run `pip3 install --break-system-packages --quiet ansible ansible-lint` with no version constraint.  Pinning would prevent surprise breakage from a major-version-bump introducing new strict checks.

**Trade-off:** pinning has its own ongoing cost.  `pip` doesn't have npm's `~=` semantics readily; pinning to `==X.Y.Z` means you have to actively monitor upstream releases and bump.  In return you get protection against rare major-version-bumps introducing new strict checks (most ansible-lint releases are additive, not breaking).

**Net judgment:** the protection cost outweighs the protection benefit at this scale.  Document and move on.  If a future ansible-lint major release ever breaks our playbook, that's a one-time fix-up — not a recurring drag.

### Finding #3 (LOW) — Subsumed by #1

The triple-pulse outer `for i in 1 2 3; do bash scripts/run-smokes.sh; done` could in principle hang if bash itself wedged (pathological GNU bash bug, extremely unlikely).  cp143's per-smoke timeout protects each iteration; the new job-level `timeout-minutes` protects the whole loop.  No separate action needed.

### Finding #4 (INFO) — Punted (legibility > DRY)

The web-check job runs:

```yaml
- run: npx svelte-kit sync
- run: npx svelte-check --tsconfig ./tsconfig.json --threshold error
```

Both binaries should be in `node_modules/.bin/` after `npm ci`, but `npx` will fetch from registry if they aren't.  Replacing with `npm run check -w apps/web` (which invokes the dev-side `svelte-kit sync && svelte-check --tsconfig ./tsconfig.json` script) would DRY the CI duplication AND avoid the npx-network-fallback risk.

**Trade-off:** the current CI yaml has thoughtful comments explaining exactly what each step does (`--threshold error` flag rationale, why `svelte-kit sync` matters).  Switching to `npm run check` hides those decisions behind a package.json indirection.  Per cp143 Lesson #2 ("any tool whose invocation a CI step uses … should have a corresponding smoke that validates the same invocation locally"), CI legibility wins.

### Finding #5 (INFO) — Already enforced

`release.yml` line 128 runs `npm ci --no-audit --no-fund` which would have surfaced the cp140 lockfile drift via the same EUSAGE error CI hit in cp144.  The cp144 lockfile-sync smoke also catches it pre-release.  Belt and braces.

### Verified clean

- TypeScript: 0 errors × 11 projects
- svelte-check: 0/0
- Triple-pulse smokes: 6097/6097/6097, 0 runners failed (pulses 47, 48, 49)
- ci-workflow-hardening-smoke: 4/4 baseline; 3 invariants tamper-tested independently

### Smoke battery growth

cp144's 6092 → cp145's 6097 (+5).  Breakdown:
- +4 from new ci-workflow-hardening-smoke's 4 scenarios.
- +1 derived growth in `last-char-tamper-anti-pattern-smoke.ts` from walking the new smoke file.

### Lessons

#### Lesson #1 — Two layers of timeout discipline

Morphit now has THREE layers of execution time protection:

1. **Per-smoke wall-clock** (cp143) — `timeout --signal=TERM --kill-after=5 240` inside `scripts/run-smokes.sh`.  Catches a single smoke hang.  240s ceiling.
2. **Per-job wall-clock** (cp145) — `timeout-minutes:` on each CI job.  Catches a hang in any CI step that isn't a smoke (npm ci, tsc, ansible-galaxy, gpg, git fetch, tar, etc.) AND catches a bash-level wedge in the runner-orchestration script.  5-60 minute ceilings.
3. **Concurrency cancellation** (existing) — `concurrency: cancel-in-progress: true` cancels SUPERSEDED runs when a newer commit lands.  Doesn't help with a single stuck run, but prevents wasted CI minutes on amend-and-push cycles.

Layers 1 and 2 are complementary: layer 1 has fine-grained per-smoke control with diagnostic class-of-bug messages; layer 2 has broad-strokes job-level enforcement covering everything layer 1 doesn't.

#### Lesson #2 — Phantom transitive deps are fragile import sources

Workflow YAML is structured enough to parse with regex, but the temptation was strong to use the `yaml` package that's already in `node_modules/` (via a transitive svelte-kit chain).  Importing from a phantom transitive dep would have made the smoke fragile: if the transitive parent ever drops the dep, the smoke breaks for reasons completely unrelated to its purpose.

Going forward: if a smoke needs a parser/library that isn't already declared as a direct dep of some workspace, EITHER add the dep explicitly to a relevant workspace package.json OR write a tight regex parser scoped to the file convention.  No drive-by transitive imports.

#### Lesson #3 — The cp140 oversight pattern is now well-defended

The cp142 + cp143 + cp144 + cp145 sequence covers:

- cp142: smoke spawning a built artifact that doesn't exist → meta-smoke enforces ensureBuilt()/existsSync() guards
- cp143: any smoke hanging → per-smoke timeout converts to legible failure
- cp144: lockfile drift gating install → npm ci dry-run smoke
- cp145: any non-smoke CI step hanging → per-job timeout converts to job-level failure

Together this is a coherent defense surface for the "add a workspace" oversight class.  cp147 candidate: write `docs/ADDING-A-WORKSPACE.md` codifying the maintainer-side procedure (parallels cp141's `docs/LOCALE-GRADUATION.md`).

The remaining work for this session (per Ken's "plow through in order you see fit"): cp146 — pre-launch deep-deep on `apps/mcp-server` source itself (the one workspace cp138/cp139 audits never covered, since cp140 introduced it AFTER those passes).

---

## cp144 — CI-RED-since-cp140 lockfile drift fix + lockfile-sync smoke (CLOSED 2026-05-27)

**Severity: HIGH.**  CI was failing at the install step for ~24 hours.  cp141, cp142, cp143 local triple-pulse verifications all looked green because `npm install` (dev command) silently heals the lockfile, while `npm ci` (CI command) refuses to.  The broken state was invisible to anyone not reading the Forgejo CI logs.

### How it happened

In cp140 the `apps/mcp-server` workspace was added to root `package.json:workspaces`.  Per the standard npm workspace pattern, adding a workspace requires running `npm install` to populate `package-lock.json` with the new workspace's entries and transitive deps.  This was not done before the cp140 commit was pushed.  The committed `package-lock.json` had zero references to `morphit-mcp` or `@modelcontextprotocol/sdk`.

CI's `npm ci` step refused to install:

```
npm error code EUSAGE
npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.
npm error Missing: morphit-mcp@1.0.0-beta.1 from lock file
npm error Missing: @modelcontextprotocol/sdk@1.29.0 from lock file
...
```

### How it was discovered

Ken sent the failing typecheck task #421 Forgejo log directly into the cp144 session.  Until that point, my fresh-session verification of cp141 → cp142 → cp143 had been running `npm install --ignore-scripts` at session start, which silently rewrote the lockfile on disk.  Every subsequent `npm install`, `tsc`, `tsx` invocation, smoke pulse, and typecheck succeeded.  The fact that the lockfile had been mutated was invisible — npm install emits no warning when it heals a lockfile.

### Empirical proof

| File | Bytes | `morphit-mcp` refs | `@modelcontextprotocol` refs |
|---|---|---|---|
| cp141 tarball's package-lock.json (what's in CI) | 308876 | 0 | 0 |
| My session's healed package-lock.json | 327617 | 3 | 24 |

The +19 KB delta is the missing mcp-server workspace entry + the @modelcontextprotocol/sdk subtree + its transitive deps (ajv, cors, express, jose, raw-body, …).

### Fixes shipped

1. **`package-lock.json` regenerated** in the working tree.  Now in sync with the workspaces declared in package.json.

2. **`scripts/lockfile-sync-smoke.ts` (NEW, ~190 lines)** — 3 scenarios:
   - **Scenario 1 (authoritative):** `npm ci --dry-run --no-audit --no-fund --prefer-offline` against the repo, asserts exit-zero.  This IS the exact CI invocation that fails; the smoke speaks the CI's own language.
   - **Scenario 2 (precondition):** `package-lock.json` exists at repo root and parses as valid npm schema with a recognized `lockfileVersion`.
   - **Scenario 3 (fast offline cross-check):** every workspace declared in root `package.json` appears in `package-lock.json`'s `packages` map.  Catches the cp140 class even without network access; names the missing workspace by path.

   On failure, the smoke emits the class-of-bug fix command verbatim: "run `npm install --package-lock-only` from repo root, commit the updated package-lock.json, and push."

3. **`scripts/run-smokes.sh`** — `.:lockfile-sync-smoke` registered as the 236th smoke entry.

### Tamper-tested

Re-staged the cp141 tarball's stale lockfile.  Smoke correctly fired:

- Scenario 1: ✗ — named missing packages: `morphit-mcp@1.0.0-beta.1`, `@modelcontextprotocol/sdk@1.29.0`, `ajv@8.20.0`, `ajv-formats@3.0.1`, `cors@2.8.6`, …
- Scenario 2: ✓ — lockfile JSON itself is valid, just stale.
- Scenario 3: ✗ — named missing workspace: `apps/mcp-server`.

Restored the healed lockfile; smoke goes 3/3 green again.

### Smoke battery growth

cp143's 6088 → cp144's 6092 (+4).  Breakdown:
- +3 from new lockfile-sync-smoke's 3 scenarios.
- +1 derived growth in `last-char-tamper-anti-pattern-smoke.ts` from walking one additional file (the new smoke).

Triple-pulse 6092/6092/6092 stable (pulses 44, 45, 46).

### Verified clean

- TypeScript: 0 errors × 11 projects
- svelte-check: 0/0
- npm ci --dry-run against current package-lock.json: succeeds in ~4s
- lockfile-sync-smoke: 3/3 baseline, 2/3 fail-as-expected after tamper, 3/3 passes again after restore

### Lessons

#### Lesson #1 — `npm install` and `npm ci` have asymmetric healing semantics

`npm install` silently heals a stale lockfile.  No warning.  No diff.  No log line.  The lockfile after `npm install` may differ from the lockfile before, and you'll never know unless you `git diff` it or notice the file's mtime.

`npm ci` refuses to install when the lockfile is stale.  Exits 1 with EUSAGE.

This asymmetry means: a dev workflow that uses `npm install` (the default) will SILENTLY MASK any lockfile drift that a CI workflow using `npm ci` would surface.  If the dev never pushes the healed lockfile (or if the heal happens in a non-committed working state), CI breaks while local works.

**Going forward:** any session that adds or removes a workspace, or changes any dep in any workspace, MUST end with an explicit `git diff package-lock.json` check.  If the lockfile changed, it goes in the same commit as the package.json change.  No exceptions.

Better still: the cp144 lockfile-sync smoke catches this at smoke time.  Run the smoke battery before pushing, and a drift would have been flagged in 4 seconds.

#### Lesson #2 — Local triple-pulse is not a substitute for fresh-checkout CI

cp141, cp142, cp143 ALL reported clean triple-pulse smokes locally.  cp143 even did extensive RSS measurement and runtime hang protection.  None of these caught CI being red, because the smoke battery doesn't include a "would `npm ci` succeed?" check.  The cp144 smoke fills that gap.

**Broader principle:** any tool whose invocation a CI step uses (npm ci, tsc, svelte-check, vitest run, …) should have a corresponding smoke that validates the SAME invocation locally.  cp143 already does this for vitest; cp144 adds it for npm ci.  Future audit candidates: svelte-check (already wrapped by smoke), tsc (covered by typecheck-sweep but not invoked as a smoke), forgejo-runner act-locally (not currently covered).

#### Lesson #3 — Fresh-session verification is necessary but not sufficient

In cp142 I made the case for fresh-session verification: extract a tarball into a clean dir, install, run everything.  That CAUGHT the mcp-server-smoke hang.  But it DID NOT catch the lockfile drift, because `npm install --ignore-scripts` (which I used at session start) silently healed the lockfile before any check ran.

To catch the cp144 class via fresh-session verification, the workflow needs to be: `tar xzf … && npm ci` (not `npm install`).  If `npm ci` fails, that IS the bug.  Then `npm install` to heal, run the rest of the pipeline.

I've added this to my own "fresh-session verification" mental checklist going forward.  Also captured by Scenario 1 of the lockfile-sync-smoke, so future sessions don't need to remember.

#### Lesson #4 — The cp142–cp144 trifecta is the same root cause expressed three ways

All three checkpoints are downstream of one cp140 oversight: adding the mcp-server workspace without exercising the full fresh-checkout install + smoke pipeline.

- cp142: the smoke spawned `node dist/main.js` but dist/ wasn't built. (build-artifact-dependency)
- cp143: any future hang would stall CI without bound. (runtime-defense complement)
- cp144: the lockfile was never regenerated for the new workspace. (lockfile-dependency)

**Pattern:** when adding a workspace, three sub-pipelines need verification:
1. The workspace's source builds (covered by tsc/typecheck — already verified).
2. The workspace's build artifacts (if any) exist before any smoke depends on them (cp142).
3. The workspace's dependencies are in the root lockfile (cp144).
4. Any smoke that exercises the workspace can't hang indefinitely (cp143).

Pre-launch hardening should now include a "new workspace checklist" in `docs/CONTRIBUTING.md` or similar.  Filed as cp145 candidate: write that checklist.

---

## cp143 — Per-smoke runtime timeout (CLOSED 2026-05-27)

cp142 caught the mcp-server-smoke hang class at static-analysis time (the `spawn-dist-prebuild-coverage-smoke` meta-smoke).  cp143 adds the runtime complement: regardless of cause, regardless of class, any smoke that doesn't return in 240 seconds gets SIGTERMed by `timeout`, gets a 5-second grace period, then SIGKILLed, and the runner emits a "HUNG — killed after 240s" message pointing at cp142's meta-smoke as the place to look for static-analysis enforcement of the relevant invariant.

### Falsified prior-turn recommendation

Prior turn's recommendation #3 was "memory-cap hardening on file-walking smokes."  Before shipping a code change on that basis, I measured peak RSS of 18 candidate smokes (the heavy file-walkers from cp141 + the smokes that were `Killed` in the cp141→cp142 chunk run).  Result: every smoke peaks at ~62-65 MB regardless of what it does.  That's just tsx + esbuild + V8 baseline; the actual file-walk data is in the noise.

Examples (peak RSS):
- `.:brag-list-claim-parity-smoke` — 62816 KB (heavy: walks every doc + brag list)
- `.:spawn-dist-prebuild-coverage-smoke` — 62104 KB (walks every workspace + every smoke file)
- `.:last-char-tamper-anti-pattern-smoke` — 63928 KB (walks the entire repo)
- `apps/web:persona-walkthrough-smoke` — 62324 KB (lightweight)
- `apps/web:sally-walkthrough-smoke` — 62060 KB (lightweight)
- `.:operations-hardening-smoke` — 65064 KB (trivial 1-scenario smoke)
- `apps/mcp-server:mcp-server-smoke` — 65220 KB (cp142-fixed; now includes lazy-build pathway)
- `.:sidecar-envelope-error-path-smoke` — 62256 KB (2 scenarios)

The cp141 `Killed` chain was actually mcp-server-smoke hanging and holding wall-clock pressure on adjacent smokes, not memory pressure.  cp142's root-cause fix solves that; cp143's runtime timeout catches any future analog before it can cascade.

Memory rule "NEVER ASSUME, ALWAYS VERIFY" applies: I almost shipped a useless code change ("convert array reads to streaming") based on the wrong root-cause story.  Measurement falsified the hypothesis in 30 seconds.  Should have measured before recommending in the first place.

### Slow-pole derivation

Before setting the timeout ceiling, I ran every candidate smoke individually with `date +%s` bracketing:

- Median smoke: ~1-3 seconds (the smoke-runner's full pulse is ~6 minutes for 235 smokes ≈ 1.5s/smoke avg).
- Slowest fast smoke: ~15 seconds (mcp-server-smoke with cold dist build).
- True slow-pole: `apps/web/scripts/vitest-must-pass-smoke.ts` — runs real `vitest run` × 3 workspaces (apps/indexer = 493 tests, apps/relay = 244, apps/web = 244+) under jsdom.  Total ~150 seconds on this hardware.

First attempt set the ceiling to 90s.  Pulse 1 chunk B caught vitest-must-pass-smoke mid-run.  Bumped to 240s (1.6× headroom over the slow-pole).  Pulse 1 chunk B + C + D ran clean.  Triple-pulse stable.

### Configurable via env var

Slower CI hosts (low-tier ARM runners, shared CI infrastructure) can bump the ceiling without editing the runner script:

```
MORPHIT_SMOKE_TIMEOUT=480 bash scripts/run-smokes.sh
```

The default (240) is calibrated for the published `.forgejo/workflows/ci.yml` runner (ubuntu-24.04 / 2 vCPU / 7 GB).

### Exit code classification

`timeout`'s exit codes are distinguishable from smoke-emitted non-zero:

- 124 — SIGTERM expiry (smoke didn't respond to graceful termination)
- 137 — SIGKILL (smoke held on past the grace period; required `--kill-after`)
- Anything else — smoke's own non-zero exit

The runner branches on these and emits a different error message for each: HUNG-class gets a pointer at cp142's meta-smoke (where the relevant static-analysis enforcement lives); other-class gets the standard "exit N" format.

### Verified clean

- Triple-pulse smokes: **6088/6088/6088**, 0 runners failed (pulses 41, 42, 43 at cp143 baseline)
- TypeScript: 0 errors × 11 projects
- svelte-check: 0/0
- Tamper test: setInterval-based hang script killed at exactly 5s with exit 124 ("HUNG" branch) under MORPHIT_SMOKE_TIMEOUT=5
- vitest-must-pass-smoke clocks 148s (well under 240s ceiling)
- All other smokes clock under 15s

### Files touched

- `scripts/run-smokes.sh` — wrapped per-smoke spawn in `timeout --signal=TERM --kill-after=5 240`, added MORPHIT_SMOKE_TIMEOUT override, branched on 124/137 vs other exits.
- `scripts/run-smokes-chunk.sh` — session-aid chunked runner matched to canonical.

### Lessons

#### Lesson #1 — Measure before optimizing

Prior turn's recommendation #3 ("memory-cap hardening on file-walking smokes") felt obvious — "the smokes that got Killed were the ones walking lots of files; they must be memory-heavy."  But a 5-line bash measurement loop falsified it in 30 seconds.  Every smoke peaks at the same ~62-65 MB regardless of what it does.

Going forward: any recommendation involving "memory" or "performance" gets measured before being recommended.  The cost of measurement is small; the cost of shipping a change based on a wrong root-cause story is huge.

#### Lesson #2 — Static and runtime defense in depth

cp142 catches the dist-spawning-smoke-without-build-guard bug at **static-analysis time** (the meta-smoke walks every smoke file and asserts the guard pattern is present).  cp143 catches **any hang at runtime** (the timeout).  Together they form a layered defense:

- Static layer fires fast (sub-second) and emits a clear "you forgot the guard" message naming the offending file.
- Runtime layer catches things the static layer can't see — for example, a smoke that uses `ensureBuilt()` correctly but hangs for a different reason (deadlock, infinite loop, slow external HTTP call).

A bug in the static layer (false negative) is caught by the runtime layer in 240s.  A bug in the runtime layer (mistaken classification) is caught by the static layer the next time the meta-smoke runs.  Two-layer.

#### Lesson #3 — Slow smokes need explicit ceiling justification

`vitest-must-pass-smoke.ts` legitimately takes ~150s to run.  That's not a bug — it's running 981 real unit tests, which is exactly what a vitest-rot defense is supposed to do.  But the 240s ceiling means any future smoke that creeps past 150s needs to be looked at: is it genuinely a slow real test, or is it accidentally doing too much per file?

If a third such smoke ever lands, consider whether it should be moved to a separate "slow smoke" stage that runs less often (e.g. nightly instead of per-PR), or whether the per-smoke ceiling should be raised.  Today (cp143) only one smoke crosses 60s; the ceiling is calibrated for that reality.

---

## cp142 — mcp-server-smoke CI-bomb fix + class-of-bug meta-smoke (CLOSED 2026-05-27)

A fresh-session smoke-pulse verification of the cp141 tarball surfaced a real, latent bug in cp140's `apps/mcp-server/scripts/mcp-server-smoke.ts`: the smoke spawned `node dist/main.js`, but `dist/` is gitignored.  On any fresh checkout — and on every CI run that does `actions/checkout` → `npm ci` without a prior build — `dist/main.js` doesn't exist.  The smoke hangs forever (or gets OOM-killed in low-memory environments), masking as either a flaky CI run or a multi-hour CI-minutes burn until job timeout.

The bug survived cp140 → cp141 only because Ken's dev machine kept `dist/` on disk between manual `npm run build` runs.  The smoke had never been re-verified from a clean checkout.

### What I found

- One workspace in the entire repo (`apps/mcp-server`) has a `package.json:bin` field pointing into `dist/...`.
- One smoke in the entire repo (`mcp-server-smoke.ts`) spawns a `node dist/...` child.
- Zero of those one smokes had any `existsSync` guard or lazy-build mechanism before the spawn.

### Reproducing

```
cd apps/mcp-server && rm -rf dist
cd .. && timeout 60 node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/mcp-server/scripts/mcp-server-smoke.ts
# Hangs after printing the banner; killed by timeout with exit 124.
```

After fix:

```
cd apps/mcp-server && rm -rf dist
cd .. && timeout 60 node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/mcp-server/scripts/mcp-server-smoke.ts
# Smoke prints "  · dist/main.js missing — running `npm run build` …", builds in ~2s, then runs all 8 scenarios green.
```

### Fixes shipped

1. **`apps/mcp-server/scripts/mcp-server-smoke.ts`** — `ensureBuilt(serverCwd)` helper added.  Called at the top of `main()` before any `runMcpDialog()` spawn.  If `dist/main.js` is missing, spawns `npm run build` synchronously, validates the artifact appeared, and exits 1 with a debug-pointer message if the build fails.  Production-faithful: the smoke still tests the BUILT artifact (which is what ships as the `morphit-mcp` bin), not the source.

2. **`.forgejo/workflows/ci.yml`** — new "Build workspaces that ship compiled artifacts" step runs `npm run build -w apps/mcp-server` after `npm ci` and before the smoke triple-pulse.  Defense in depth: smoke is self-healing, but a build break here surfaces as a named step failure (legible) rather than buried in smoke output.

3. **`scripts/spawn-dist-prebuild-coverage-smoke.ts`** (NEW, ~180 lines) — meta-smoke catching the CLASS of bug.  Three invariants:
   - Every workspace with a `dist/`-pointing `bin` MUST declare `scripts.build`.
   - Every smoke file that contains `spawn('node', ['dist/...'])` MUST also contain `ensureBuilt(` or `existsSync(...dist)` — tested against a **comment-stripped** copy of the source so stale prose can't satisfy the guard.
   - Every dist-bin workspace has at least one dist-spawning smoke.
   Skips itself (its own docblock + regex source contain the patterns).  Tamper-tested: ripping `ensureBuilt()` out of mcp-server-smoke fires the second invariant with the offending filename named.

4. **`scripts/run-smokes.sh`** — `.:spawn-dist-prebuild-coverage-smoke` registered as the last entry.

### Verified clean

- TypeScript: 0 errors × 11 projects
- svelte-check: 0 errors / 0 warnings
- Triple-pulse smokes: 6088/6088/6088, 0 runners failed (pulses 38, 39, 40 at cp142 baseline)
- mcp-server-smoke: clean fresh-checkout repro confirms self-healing
- spawn-dist-prebuild-coverage-smoke: 3/3 baseline, 1/3 fails-as-expected after tamper, 3/3 passes again after restore

### Smoke battery growth

cp141's 6084 → cp142's 6088 (+4).  Breakdown:
- +3 from the new meta-smoke's 3 scenarios.
- +1 derived growth in `scripts/last-char-tamper-anti-pattern-smoke.ts` which walks the file tree and counts one more file (the new meta-smoke gets walked too — passes the tamper-pattern lint because it doesn't use `.slice(0, -1)` anywhere).

### Lessons

#### Lesson #1 — Sentinel-grep smokes need comment-stripping when checking GUARD patterns

First draft of the meta-smoke used a plain regex against the raw file text to assert the GUARD pattern (`ensureBuilt(` OR `existsSync(...dist`).  Tamper test revealed that a stale **comment** referencing `ensureBuilt()` left over from a partial revert satisfied the regex.  Class of bug: "smoke proves text exists, not that code exists."

Fix: strip line- (`// …`) and block- (`/* … */`) comments before the GUARD test.  Deliberately do NOT strip comments before the SPAWN_DIST test — we want to over-flag (a docblock example mentioning `spawn('node', ['dist/'])` should count as a "smoke that spawns from dist/" candidate, so a guard is required even if the spawn is hypothetical).  Asymmetric stripping = fewer false negatives on either side.

Memory rule "Sentinel-grep smokes only prove text exists; structural Svelte/TS requires `svelte-kit sync + tsc --noEmit`" applies here too: text-only smokes have an additional failure mode where the text exists but is in a comment.  When a smoke's pass/fail bit depends on the presence of code (not prose), strip comments first.

#### Lesson #2 — Every dist-bin workspace needs a fresh-checkout sanity check

The `npm run build` step belongs SOMEWHERE in the path from `actions/checkout` to "test runs," and that somewhere needs to be explicit.  Options, in increasing order of legibility:
- (a) Self-healing inside the smoke (fix #1 above).  Robust but the failure mode is buried.
- (b) Explicit CI step (fix #2 above).  Legible failure mode.
- (c) `npm run build --workspaces --if-present` after install.  Most general — would have prevented this bug AND any future analogous one across all workspaces — but adds CI time for workspaces that don't actually need it.

Morphit ships both (a) and (b) at cp142.  (c) is rejected at this time because mcp-server is the only workspace with a dist-bin; if a second one ships, revisit (c).

#### Lesson #3 — "smoke battery N/N triple-pulse stable" doesn't mean the smokes have been re-tested from a clean state

The cp141 close report said "6084/6084 quadruple-pulse stable."  All four of those pulses were against a working tree that had `apps/mcp-server/dist/` lying around from cp140's `npm run build` during MCP development.  A fresh `git clone` followed by `npm ci` and a smoke run would have hung — none of the pulses tested that path.

Standing rule for future deep audits: before every release tag, do at least one smoke pulse in a directory that has just been freshly extracted from a known-clean tarball (no working-tree gunk).  This is exactly the workflow that a CI job runs, so it catches CI-only failure modes that dev machines mask.

The cp142 fix infrastructure (meta-smoke + explicit CI build) is what enforces this going forward.  Pre-cp142, the only enforcement was Ken's eyes on the next CI run.

#### Lesson #4 — OOM-Killed signals are not always genuine OOM

The fresh-pulse run had three smokes report `Killed` in the same 60-smoke chunk: `mcp-server-smoke`, `release-notes-asset-count-parity-smoke`, `npm-audit-gate-smoke`.  First instinct was to blame all three on memory pressure in the sandbox.  The truth was:
- mcp-server-smoke: real bug (hang → wall-clock kill).
- release-notes-asset-count-parity-smoke: ran clean in isolation; was a victim of the wall-clock pressure caused by mcp-server-smoke hanging in the same chunk.
- npm-audit-gate-smoke: ran clean in isolation; same root cause.

Lesson: when multiple smokes fail with `Killed` in the same chunk, verify each individually before concluding "OOM."  One genuinely hanging smoke can drag adjacent ones across the wall-clock cliff.

---

## cp141 — Locale-graduation readiness (CLOSED 2026-05-27)

Pre-cp141 the codebase had 10 SUPPORTED locales (en, es, de, pl, fr, it, ru, fa, zh-CN, zh-HK) and 7 PLANNED locales scaffolded but not shipped (hi, ar, bn, pt, id, ja, vi).  Ken's directive: make sure graduating a PLANNED → SUPPORTED is a one-pass mechanical operation rather than a hunt for stale "10 locales" mentions across the tree.  Also: make sure human translators have a clear workflow for editing the JSON files.

### Audit findings — already-good state

The translator UX was already comprehensive:

- `apps/web/src/lib/i18n/locales.ts` is the SSoT with both `SUPPORTED_LOCALES` and `PLANNED_LOCALES` arrays; graduation is a one-line array-relocation.
- `apps/web/src/routes/[lang]/+layout.ts` + `[lang]/+page.ts` derive prerender entries and lang-validation from `SUPPORTED_LOCALES.map()` — adding a locale auto-prerenders.
- `matchSupported()` in locales.ts handles BCP-47 mapping including the Chinese script-variant disambiguation (Hant → zh-HK, Hans/default → zh-CN).
- `i18n-locale-parity-smoke.ts` enforces JSON key-shape parity via `readdirSync` (auto-adapts to new locales).
- `i18n-locale-registry-smoke.ts` enforces disjointness + 1:1 JSON-to-locale invariants.
- `i18n-translator-diff.ts` produces per-locale missing/fallback/extra reports with English source text inline as `// EN:` comments for context — works for both supported and planned locales.
- `docs/CONTRIBUTING-TRANSLATIONS.md` (239 lines) covers JSON shape, placeholders, ICU plurals, HTML inline tags, RTL, quality bar, submission process.
- Most per-feature locale smokes (mediakit-freshness, web-push-wiring, voucher-locale-parity, payment-method-i18n-parity, privacy-headline-length, etc.) already use `SUPPORTED_LOCALES.map(...)` so are parametric.

### Audit findings — gaps closed

**Five fixes shipped:**

1. **`apps/web/scripts/i18n-translation-completeness-smoke.ts`** — replaced hardcoded `>= 10` literal in the "all N locale files were loaded" check with `=== SUPPORTED_LOCALES.length`.  Scenario name made dynamic.  Imports `SUPPORTED_LOCALES` from `../src/lib/i18n/locales`.

2. **`scripts/brag-list-claim-parity-smoke.ts`** — added `apps/web/static/llms.txt` to `MARKETING_DOCS`.  This means when a PLANNED locale graduates, the smoke flags llms.txt:42's "10 languages" claim alongside the existing brag-list + README scans.  Locale-count claim coverage went 15 → 16; total scenarios 75 → 76.

3. **`apps/web/scripts/web-push-wiring-smoke.ts` + `apps/web/scripts/2fa-locale-parity-smoke.ts`** — replaced "all 10 locales" comment text with generic "every supported locale" wording so the comments don't drift at graduation time.

4. **`docs/LOCALE-GRADUATION.md` (NEW, ~200 lines)** — the maintainer-side procedural checklist for graduating a PLANNED locale.  10-step walkthrough: drop JSON, move registry entry, run smokes (smoke output is the graduation checklist — every flagged file:line is a thing to update), update flagged prose, update untracked comments via a targeted git-grep, rebuild mediakit + comparison image, triple-pulse, persona walkthroughs especially RTL, PR.  Also documents what's NOT part of graduation (no DNS, no CDN, no federation announce, no backend change), and how to revert.

5. **`docs/CONTRIBUTING-TRANSLATIONS.md`** — cross-link to LOCALE-GRADUATION.md added in two places (inline graduation paragraph + bottom reference list).  The translator-side doc and the maintainer-side doc now reference each other explicitly.

### Verified clean

- TypeScript: 0 errors across all 10 projects
- `i18n-translation-completeness-smoke`: 4/4 ✓
- `brag-list-claim-parity-smoke`: 76/76 ✓ (16 locale claims, was 15)
- `web-push-wiring-smoke`: 44/44 ✓
- `2fa-locale-parity-smoke`: 9/9 ✓
- `i18n-locale-registry-smoke`: pass
- `i18n-translator-diff.ts es`: 0 missing, 0 extra (es complete)
- `i18n-translator-diff.ts hi`: 3095 missing (expected — PLANNED locale, no JSON file yet)

### Smoke battery growth

cp140's 6078 → cp141's 6084 (+6).  Breakdown: claim-parity gained 1 scenario (llms.txt locale claim) + a few derived/dependent scenario growths from upstream changes.  Quadruple-pulse stable: pulses 34, 35, 36, 37 all reported 6084/0.

### Lessons

#### Lesson #1 — Most-of-the-work-was-already-done discovery
The cp114-era PLANNED_LOCALES scaffold + the readdirSync-based loaders + the SUPPORTED_LOCALES-driven `entries()` patterns meant the heavy lifting was done.  cp141's job was closing five small gaps that would have created post-graduation toil.  A 30-minute audit beats a 4-hour graduation that misses comments.

#### Lesson #2 — Drift-catching beats drift-avoiding
Trying to make every "10 locales" mention dynamic via string interpolation would have meant editing 30+ files for what's essentially a comment-text concern.  Instead, leaning into `brag-list-claim-parity-smoke` as the drift detector (which already existed for the brag list and README) and just extending it to llms.txt was a 5-line code change that catches more places more reliably.  When the 11th locale lands, the smoke output IS the graduation checklist.

#### Lesson #3 — Translator UX is a doc, not a tool
The pre-cp141 tooling (`i18n-translator-diff.ts` with `// EN:` comments inline) was already excellent.  The missing piece was a single-page "here are the 10 mechanical steps" doc for maintainers.  Tooling doesn't fix workflow gaps — process docs do.

---

## cp140 — `morphit-mcp` Model Context Protocol server (CLOSED 2026-05-26)

New workspace `apps/mcp-server/` shipping `morphit-mcp` — a standalone read-only MCP server (npm + Docker) that exposes Morphit's federated orderbook to any MCP-compatible AI agent (Claude Desktop, Cline, Cursor, Continue, Windsurf, Zed, local-LLM stacks).

**Tools advertised:**
- `morphit_search_orders` — orderbook query mirroring `/v1/orderbook` (asset, side, fiat_currency, location_region, payment_methods, min_trades, sort, limit)
- `morphit_get_listing` — single-listing detail by (account, permlink)
- `morphit_list_instances` — federation directory
- `morphit_list_payment_methods` — per-instance payment-method registry
- `morphit_describe` — structured "what is Morphit" descriptor for AI grounding

**Architecture posture:** read-only by design.  No keys.  No signing.  No mutation.  Every tool result includes a `deeplink` field handing the user off to the Morphit web UI for the actual key-signing step — preserves non-custodial + zero-KYC.

**Single env var:** `MORPHIT_MCP_INSTANCE_URL` (default `https://morphit.io`).

**Smoke coverage:** 8 scenarios in `apps/mcp-server/scripts/mcp-server-smoke.ts` covering wire-protocol NDJSON framing, schema advertisement, bogus-tool error path, unreachable-instance error path, working-stub describe + searchOrders, internal-field trimming, Zod input validation, deeplink shape.

**Docs:** ADR-0044, brag-list #99 (concise; per memory rule #28), `apps/mcp-server/README.md` (Claude Desktop / Cline / Cursor / Continue / Windsurf / Zed integration recipes).

**Smoke battery growth:** cp139's 6079 → cp140's 6078.  +8 from mcp-server-smoke, −16 from removing historical `RELEASE-NOTES-v1.0.0-beta.1.md` from `MARKETING_DOCS` in `brag-list-claim-parity-smoke.ts`, +6 net from brag-list-entry-count + other deltas across the touched smokes.  Double-pulse stable at 6078 across pulses 31+32.

**Lessons:**

### Lesson #1 — Workspace add surfaces multiple registration smokes at once
- `workspace-membership-smoke` flagged tsconfig not in typecheck-sweep.sh
- `brag-list-trailer-invariants-smoke` flagged duplicate entry number (99 collided)
- `brag-list-claim-parity-smoke` flagged stale ADR count claims in 4 places
- `mediakit-freshness-smoke` flagged stale bundled zip

Each smoke caught a real registration step I'd missed.  Pre-launch smoke battery doing exactly what it's designed for.

### Lesson #2 — RELEASE-NOTES-vX.Y.Z.md becomes frozen at publish
Once a release is shipped, the corresponding RELEASE-NOTES file describes that specific artifact and shouldn't be policed against current canonical source (counts evolve; the file doesn't).  Removed `RELEASE-NOTES-v1.0.0-beta.1.md` from `MARKETING_DOCS` in `brag-list-claim-parity-smoke.ts` with a comment explaining the pattern: drop in-progress notes into the list while a release is being prepared, remove again once published.

### Lesson #3 — MCP stdio framing is NDJSON, not Content-Length
First smoke draft assumed Content-Length-framed JSON-RPC (the spec's other transport option).  Real SDK uses newline-delimited JSON.  Always read the actual SDK source for transport invariants instead of guessing from the spec — fixed in `apps/mcp-server/scripts/mcp-server-smoke.ts`.

---



## cp139 — Per-workspace deep-deep with chain-op rigor (CLOSED 2026-05-25)

**Trigger:** Ken's directive after cp138 close: "I want defense-in-depth that matches the chain-op handler rigor, a deep-deep that treats each workspace's source tree the way phase-A treated each handler: file-by-file, with a black-hat hat on, before declaring it green."

**Audit scope:** every source file in apps/{web,indexer,relay,ops-cli,matrix-bot} + packages/{asset-registry,indexer-client,relay-client,operator-config}.  cp138 phase-A walked all 17 chain-op handlers deeply; cp138 phases B/D/F were partial spot-checks.  cp139 walks the rest with the same hostile-eye discipline.

**Findings shipped so far (checkpoints A + B + C — 2026-05-25):**

- **statement_timeout (CLEANUP from cp138 standing follow-up)** — SHIPPED.
- **ME-1 SHIPPED (LOW)** — parseJournalLine RangeError fix. 5 scenarios.
- **ME-2 SHIPPED (MED-on-paper)** — buildDigestBody HTML escape. 5 scenarios.
- **B-1 SHIPPED (LOW)** — drainInfoEvents corrupt-row tolerant. 4 scenarios.
- **B-2 SHIPPED (LOW)** — StructuredAlert envelope length cap. 4 scenarios.
- **B-3 SHIPPED (LOW)** — Matrix-bot digest-time regex tightened. 4 scenarios.
- **B-4 SHIPPED (LOW)** — Matrix-bot homeserver URL https requirement. 6 scenarios.
- **cp139-C-1 SHIPPED (MED, SEC)** — sanitizeForTerm helper + auto-apply at term.ts primitives (info/warn/error/row/section). 24 scenarios in term-sanitize-smoke. Single point of fix covers 80% of ops-cli callers transitively.
- **cp139-C-2 SHIPPED (LOW, ROBUST)** — chainCheck.ts lookupBlurtAccount null-cast hardened with runtime type guard.
- **cp139-C-3 SHIPPED (MED, SEC)** — systemCheck.renderSystemCheck terminal-escape sanitize on c.name/c.actual/c.note (file-content sources).
- **cp139-C-4 SHIPPED (MED, ROBUST)** — paymentMethod list DB-row sanitize at all 5 row.* fields.
- **cp139-C-5 SHIPPED (LOW, SEC)** — commands/init.ts err.message paths sanitize (2 sites).
- **cp139-C-6 SHIPPED (LOW, SEC)** — commands/edit.ts atomicEnvWrite + fsync error sanitize.
- **cp139-C-7 SHIPPED (LOW, SEC)** — importAltnetKey.ts 5 err.message sites sanitize.
- **cp139-C-8 SHIPPED (LOW, SEC)** — register.ts env.error + chain-RPC err.message + field echoes sanitize.
- **cp139-C-9 SHIPPED (LOW, SEC)** — explorerHealth.renderProbeStatus reason sanitize.
- **cp139-C-10 NOTED (LOW, INFO)** — altKeystore.passphrasesEqual early-return length leak in dead code (kept for awareness).
- **cp139-C-11 SHIPPED (MED, SEC + ROBUST)** — quote() switched to single-quote-default in init/render.ts + edit.ts (bash-source-safe; suppresses `$var`/`$(cmd)`/`` ` `` expansion). 4+3 sentinels. **Distinct bug class from sanitize family — operator-self-imposed bash-injection footgun.**
- **cp139-C-12 SHIPPED (LOW, SEC)** — steps.ts chain-RPC err.message sanitize at stepRelayAccount + Coingecko fetcher.
- **cp139-C-13 SHIPPED (LOW, SEC)** — steps.ts operator-typed URL echoes sanitize in renderHealthChecks + editChatLinkUrl.
- **cp139-C-14 SHIPPED (LOW, SEC)** — commands/init.ts path-echo sanitize at 6 sites.
- **cp139-C-15 SHIPPED (LOW, SEC)** — parseExplorerUrlList + parseRpcEndpoints error-message URL sanitize.
- **cp139-C-16 SHIPPED (MED, SEC)** — paymentMethod add+remove 13 flag-echo + result + err.message sites sanitize.
- **cp139-C-17 SHIPPED (LOW, SEC)** — edit.ts printCurrent file-content + applyUpdates review loop sanitize.
- **cp139-C-18 SHIPPED (LOW, SEC)** — main.ts last-resort fatal handler stderr write sanitize.
- **cp139-C-19 SHIPPED (LOW, SEC)** — upgrade.ts release-notes body line-by-line sanitize.
- **cp139-C-20 SHIPPED (LOW, SEC)** — steps.ts chain-RPC balance echo sanitize at stepDailyCeiling.
- **cp139-D-1 SHIPPED (HIGH, SEC)** — `quote()` + `quoteValue()` per-consumer split. cp139-C-11's single-quote-default broke parseEnv reads of morphit.config.env because parseEnv doesn't support POSIX `'\''` close-escape-reopen.  Operator's tagline `"Berlin's first Morphit node."` (wizard's literal example) would silently truncate to `"Berlin"` at indexer boot.  Fix prefers single-quoted; falls back to double-quoted for parseEnv consumer when value has `'`; throws on `'` + `"` combo (unrepresentable).  10 new sentinels including a critical write→parseEnv round-trip invariant that exercises 5 hostile-input fields.  **Bug class: data corruption by design across the wizard→indexer boundary.**
- **cp139-D-2 SHIPPED (LOW, SEC)** — `packages/operator-config/src/index.ts` boot-time `console.log`/`throw` terminal-escape sanitize at all 6 output sites.  Inline `sanitizeForTerm()` mirror of ops-cli's (kept inline since operator-config is leaf code loaded before any other module).
- **cp139-E-1 SHIPPED (LOW, SEC)** — `apps/relay/src/log/index.ts:textSink` + `formatValue()` terminal-escape sanitize.  The bare-string emission path (no-space values) was bypassing `JSON.stringify`-native escape.  Inline `sanitizeForJournal()` helper mirrors ops-cli's `sanitizeForTerm()`.  13-scenario sentinel smoke; tamper-tested (9/13 fire on revert).
- **cp139-F-1 SHIPPED (LOW, SEC)** — same bug class in `apps/indexer/src/log/index.ts`, cross-applied from cp139-E-1 hypothesis.  Identical fix.  Mirror 13-scenario sentinel smoke.
- **cp139-F-2 SHIPPED (MED, SEC)** — `apps/indexer/src/indexer/price/peerPriceMonitor.ts:fetchPeerReceipt()` was calling bare `fetch()` against peer instances loaded from `known_instances.origin`, bypassing **all six** SSRF defense layers that `federationProbe.fetchJson()` applies (HTTPS-only, isPrivateHostname denylist, DNS-rebinding closure with resolveAndValidatePublicIp + IP-pinned undici dispatcher, redirect: manual, 256KB body cap with streaming abort).  Operator-register handler's intake-time literal-hostname denylist catches static forms but is explicitly defense-in-depth; the request-time check was missing.  **Fix:** export `fetchJson<T>` from federationProbe.ts (was private) and route fetchPeerReceipt through it.  8-scenario regression smoke (PPM-7-{1..9}); tamper-tested (3 source-sentinel scenarios fire on revert).  Bug-class sweep catalogued every fetch site in apps/indexer — F-2 was the ONLY attacker-input fetch site missing defense.

**All cp139 findings shipped or noted/deferred.** Packages walk COMPLETE.  Relay walk: 27 files clean + 1 finding (E-1).  Indexer walk **CLOSED**: 2 findings (F-1 LOW SEC, F-2 MED SEC).  Indexer files walked end-to-end: all 17 chain-op handlers (cp138-A) + all 32 API/middleware files + all 27 indexer/* internals + 4 fee/ + 10 price/ + 1 reputation/ + 7 infrastructure (blurt/×3, config/, db/×2, lib/, log/, main.ts) = **~94 files total**.

**Smoke battery: 6076/6076 across NINE confirmed pulses** (14+15+16+17+18+19+20+22+23 — pulse 21 caught a real regression where the new cp139 persona walkthrough doc tripped `db-password-placeholder-smoke` by naming the sentinel strings; fixed same-turn by adding the doc to `ALLOWED_PATHS` in `apps/indexer/scripts/db-password-placeholder-smoke.ts:130`).  cp139-F-2 adds 9 new sentinels to peer-price-monitor-smoke.

**Persona walkthrough:** `docs/THREE-PERSONA-WALKTHROUGH-cp139.md` shipped — delta against cp137's 966-line comprehensive baseline.  Walks Bob/Sally-user/Sally-operator through every cp138 + cp139 audit-closure touchpoint (44 changes total).  Zero regressions found; standing memory items #5/#7/#8/#10/#14/#18/#19/#20/#21/#22/#29 confirmed honored.

**`[lang]/+layout` re-walk:** Final dedicated re-walk before tarball confirmed zero new findings.  Operator-supplied alt_networks fields (tor/lokinet/i2p_b32/i2p_name/nostr) render through hardcoded scheme prefix + Svelte attribute auto-escape; `safeContactUrl()` on contact_url; `encodeURIComponent()` on operator_matrix_room; afterNavigate focus-on-main a11y hook + auto-lock timer + trade-event-listener teardown all verified.

**cp139 walk progress:**

| Workspace | Files walked | Files remaining | Findings |
|---|---|---|---|
| apps/matrix-bot | **ALL 8 files** | — | **6 SHIPPED** (ME-1, ME-2, B-1, B-2, B-3, B-4) |
| apps/ops-cli | **ALL 30 files** (commands/×16, init/×7, lib/×2, render/×2, db.ts, config.ts, main.ts) | — | **19 SHIPPED + 1 noted + 1 deferred** (cp139-C-1 through C-21) |
| packages/* | **ALL 4 packages** (operator-config, asset-registry, indexer-client, relay-client) | — | **2 SHIPPED** (cp139-D-1 HIGH, cp139-D-2 LOW) |
| apps/relay | **ALL 34 files** (log, crypto×2, config×2, middleware×7, api×5, policy×11, blurt×2, queue, clock, db, main) | — | **1 SHIPPED** (cp139-E-1) |
| apps/indexer | **ALL ~94 files** — 17 chain-op handlers (cp138-A walked deeply) + 32 API/middleware + 27 indexer/* internals + 4 fee/ + 10 price/ + 1 reputation/ + 7 infra (blurt/{verify,client,chainProperties}, config/index, db/{migrations,pool}, lib/feeAmountCalc, log/index, main.ts) | — | **2 SHIPPED** (cp139-F-1 LOW + cp139-F-2 MED) |
| apps/web | **lib/crypto** (12 files) + **lib/net** (8) + **lib/auth** (8) + **lib/chat** (23) + **lib/stores** (7) + **lib/blurt** (sign+apr+ops/{chatIdentity,profile}) + **lib/security** (privateKeyDetector) + **lib/notifications** (all 12 files) + **lib/utils** (all 13 files) + **lib/indexer** (3 files: client, profileCache, profileProps with G2.2/O3.2 closures verified) + **lib/components** (71 Svelte files — all 6 `@html` sites verified safe via batch-grep) + **lib/assets/networks** + **lib/avatar/index** (sanitizeSvg with 6-2 closure verified) + **lib/drafts/index** + **lib/explorer/{urls,urlsCore,decorate}** + **lib/trades** (5 files: F-22/F-23/F-26/F-29/F-30/F-31/F-32/F-40/F-44 closures) + **lib/orders** (4 files) + **lib/feedback/pendingReminders** + **lib/plan/phases** + **lib/balance/bus** + **lib/pwa/installPrompt** + **lib/payments** (4 files: registry+match+search+display) + **lib/i18n** (4 files: index+locales+path+formatters — **cp139-G-1 LOW shipped**) + **service-worker.ts** + **hooks.client.ts** + **app.html** + **ALL ROUTES**: root +page/+layout, [lang]/+layout (F-23+F-29 inline), [lang]/+page (operator-SEO defense-in-depth), [lang]/onboarding (**O2.1**), [lang]/onboarding/import (**O2.1 reiteration** + cp137 H-1), [lang]/onboarding/register-name, [lang]/login (**1-10 closure** + TOTP lockout), [lang]/login/qr-pair, [lang]/scan-login, [lang]/backup-keys (Sally H6 inline), [lang]/post (defense-in-depth redaction), [lang]/post/edit/[permlink], [lang]/chat (inbox — G2.2 labelProps), [lang]/chat/[peer] (Part 72 read-ack), [lang]/my/orders (regex-validated URL-hash deep-link), [lang]/settings (3-password-field finally-clear), [lang]/settings/security/2fa (qrcode lib from validated input), [lang]/admin/setup-wizard (POSIX shell-escape), [lang]/run-a-node (validators-before-broadcast), [lang]/operators (**Sally OPS2 inline**: stricter-than-shared validator intentional), [lang]/instances (safeOrigin+safeContactUrl), [lang]/orderbook (chain-fields text-interp), [lang]/[x+40][account=account] (G2.2 inline avatar), [lang]/[x+40][account=account]/[permlink=permlink] (typed-dispatch), [lang]/explorer{+sub-routes×4} (typed labelKey allowlist), [lang]/compare (validateInstanceUrl), [lang]/faq, [lang]/glossary, [lang]/privacy, [lang]/privacy/[asset] (registry-validated), [lang]/privacy-terms, [lang]/security, [lang]/support, [lang]/plan, [lang]/about-this-instance, [lang]/cheat-sheet, [lang]/download, [lang]/dev{+sub-routes×3} = **~165 files walked CLEAN** | — | **1 SHIPPED (cp139-G-1 LOW)** |

---

## cp138 — Pre-launch deep-deep 94-task audit (CLOSED 2026-05-25)

Triggered by Ken's "do a full deep deep on absolutely everything, every file and script, .md/.ts/all svelte-related" + "put on your black hat. FULL security and code audits" directive. **94 tasks across 11 phases A–K reviewed end-to-end. 12 findings shipped (A-1..A-5, C-1, D-1, D-2, D-3, F-1, H-1, I-1, J-1) + 1 stale-brag-claim fix during handoff prep + 2 standing follow-ups.**

**Audit framework files:** `docs/AUDIT-cp138-PLAN.md` (94-task plan), `docs/AUDIT-cp138-FINDINGS.md` (283-line full ledger), `docs/AUDIT-OUTSIDE-SCOPE.md` (answers Ken's "would a pro firm do anything I haven't?" with leverage/urgency table + budget estimates).

**cp138 findings shipped (12 total + 1 follow-up post-handoff prep):**

| # | Severity | What | Where |
|---|---|---|---|
| A-1 | MED | ADR-0004 amendment overstated frontend price-provider wiring | `docs/adr/0004-price-feeds.md` |
| A-2 | MED | parseInt-on-BIGSERIAL feedback id passed to SQL param | `apps/indexer/src/indexer/handlers/feedbackResponse.ts` |
| A-3 | LOW | Stale comment claimed chat_messages.id is SERIAL (it's BIGSERIAL) | `apps/indexer/src/api/chatStream.ts` |
| A-4 | LOW | operatorPaymentMethod forbidden-char + NFC drift vs peer handlers | `apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts` |
| A-5 | LOW | operatorBlock.sanitizeReason lacked NFC normalization | `apps/indexer/src/indexer/handlers/operatorBlock.ts` |
| C-1 | MED | **CRITICAL FIX — was M4 from 2026-04-28 audit, open for a month.** KDF floor was 6000× too generous (ops>=1, mem>=1MB) — latent downgrade-attack surface | `apps/web/src/lib/crypto/keystore.ts` + `apps/web/src/lib/crypto/yubikey/wrap.ts` |
| D-1 | LOW | account_loyalty_milestones.triggered_at non-deterministic across replays | `apps/indexer/src/indexer/loyalty.ts` |
| D-2 | MED | push_subscriptions had no per-account cap → fan-out amplification surface | `apps/relay/src/policy/pushSubscriptions.ts` |
| H-1 | LOW | persona-walkthrough ALERT_COPY sentinel listed 14 of 17 host-resource events | `apps/web/scripts/persona-walkthrough-smoke.ts` |
| I-1 | LOW | No repo-root SECURITY.md (Forgejo auto-discovery friendliness) | new `SECURITY.md` |
| J-1 | LOW | XRP address placeholder unwired in chat-share-modal ternary chain | `apps/web/src/lib/components/AddressShareModal.svelte` |
| D-3 | LOW practical / MED on paper | npm audit: 2 critical + 14 moderate transitive deps via matrix-bot-sdk@0.7.1 (request@2.88.2, form-data@2.3.3) | `package-lock.json` (upstream-constrained) |
| F-1 | LOW | 3 svelte-check warnings on intentional state_referenced_locally pattern in FundsSentModal | `apps/web/src/lib/components/FundsSentModal.svelte` |

**cp138 standing follow-ups (post-launch):**

- **cp138-R-1 (post-launch scaling) — bigint id propagation.** 11 sites in `apps/indexer/src/{api,indexer}/...` use `parseInt(row.id, 10)` on BIGSERIAL. Safe at practical Morphit scale (limit is 2^53 ~ 9 quadrillion rows, vs realistic projected ~1e10) but correct pattern is end-to-end string ids since JSON has no native bigint. Long-horizon scaling item.

- **cp138-R-2 (post-launch dependency hygiene) — matrix-bot-sdk transitive vulnerabilities.** `npm audit` shows 2 critical + several moderate vulnerabilities all traced through `matrix-bot-sdk@0.7.1` to its dependency on deprecated `request@2.88.2` (which pulls vulnerable `form-data@2.3.3`, `qs`, `tough-cookie`, `uuid`). Upgrading to `matrix-bot-sdk@0.8.0` (latest) does NOT fix it — 0.8.0 still depends on `request@^2.88.2`. **Practical exposure on Morphit is near-zero** because matrix-bot is opt-in (only runs if `MORPHIT_MATRIX_BOT_ALERT_MXID` is set), sends outbound only to operator-configured homeserver, doesn't accept user URLs to fetch. Real fix options: (a) swap to `matrix-js-sdk` (official Matrix SDK, bigger surface — needs evaluation), or (b) add `npm overrides` to force-resolve transitives (needs testing that matrix-bot's actual API surface still works with overridden versions). Tracked as a quarterly-review item, not a pre-launch blocker.

- **Ship `ApiRelayProvider` + Settings opt-in for live prices** to deliver the user-facing price-staleness UX that ADR-0004 originally promised. Frontend `$lib/prices/` module exists, indexer `/v1/price/...` endpoint exists; what's missing is the apirelay provider wiring + a Settings toggle.

- **~~Add `statement_timeout` guidance to OPERATIONS.md~~ SHIPPED 2026-05-25 (post-cp138).** Per-database `statement_timeout = '30s'` guidance now lives at OPERATIONS.md §37.8 sub-item `e.` with rationale (defense-in-depth against runaway queries, why pool-level was the wrong place, why per-database is the right place), choice-of-value table, ad-hoc-override snippet for psql sessions, and verification command. Pinned by a new sentinel in `scripts/operations-hardening-smoke.ts` (`'Postgres statement_timeout' → 'statement_timeout'` keyword check). Tamper-tested: stripping the keyword from OPERATIONS.md fires the smoke with "Hardening layer 'Postgres statement_timeout' missing." The §37.8 one-liner in `RUN-A-MORPHIT-NODE.md §11` recommended-hardening summary updated in same turn to read "Postgres SCRAM + pg_hba + per-database `statement_timeout`."

**cp138 sentinel additions (persona-walkthrough 165 → 169):**

- cp138-D-2 push_subscriptions per-account cap with sliding-window eviction
- cp138-C-1 (keystore) KDF floor matches INTERACTIVE — downgrade-attack defense
- cp138-C-1 (yubikey wrap) KDF floor matches INTERACTIVE
- cp138-I-1 repo-root SECURITY.md exists with Matrix DM + Forgejo paths

**cp138 audit completeness across 11 phases:**

- **Phase A** (hostile chain-op review): **all 17 handlers reviewed deeply**. 5 findings, 0 critical.
- **Phase B** (HTTP/API): all clean — locked-down CSP, exact-match CORS, origin-enforcement for fund-spending endpoints, body cap with chunked rejection.
- **Phase C** (crypto): 1 finding (C-1 KDF floor). AEAD nonces, BIP-39 lib, secp256k1 deterministic-k, random-source audit, forward-secrecy posture all clean.
- **Phase D** (DB): 2 findings (D-1, D-2). FK integrity, migration linearization, race conditions, SQL injection, LIKE escapes all clean.
- **Phase E** (frontend XSS): all clean — 16 `@html` sites verified, sanitized SVG + closed-set kinds + escaped JSON-LD + validated onion-location.
- **Phase F** (static quality): all clean — 0 TODO/FIXME/secrets-in-logs, all silent catches legitimate, JSON.parse guards proper.
- **Phase G** (regex): all clean — 0 ReDoS at 10k chars, 22 unanchored .test() all intentional.
- **Phase H** (smokes): 1 finding (H-1). 17 hardcoded counts verified current, skipped tests all gated/documented.
- **Phase I** (docs): 1 finding (I-1). README/OPERATIONS/RUN-A-MORPHIT-NODE/METADATA-LEAK-CATALOG all accurate.
- **Phase J** (wiring): 1 finding (J-1). Locale parity 30,950/30,950 ✓ Every static `$_(...)` reference resolves.
- **Phase K** (failover): all clean — endpoint rotator throws cleanly, errors actionable.

**Pre-launch defenses raised meaningfully by cp138:**

- M4 latent downgrade-attack vector — open for a month — closed
- Push fan-out amplification surface eliminated
- Loyalty milestones now replay-deterministic
- Repo-root SECURITY.md for researcher auto-discovery
- 4 new structural sentinels in persona-walkthrough
- ADR-0004 doc↔code accuracy restored
- Forbidden-char policy aligned across 4 indexer handlers
- XRP placeholder wired (last asset's UI completion)

---
  **58+ STRUCTURAL DEFENSES (cp137 added: comparison-image-freshness now content-fingerprint-based 15 scenarios, asset-select-coverage 3 scenarios, faq-search-grandma-coverage 14 scenarios, import-remember-me 5 scenarios, plus persona-walkthrough expanded from 129 to 165 scenarios with 12 new per-asset structural sentinel families × 3 sentinels each = 36 new sentinels for USDC/BCH/LTC/DAI/DASH/DOGE/ZEC/ARRR/DCR/SOL/ETH/XRP) · BATTERY 5,967/0 TRIPLE-PULSE STABLE (5,931 cp136 baseline + 36 cp137 sentinel additions = 5,967; sandbox wrapper-timeout blocked the monolithic run-smokes.sh but a slice-based helper at `/tmp/run-smokes-slice.sh` runs the suite in 4 batches of ~60 — three full passes of all four slices = 5,967/5,967/5,967, 0 failures) (cp136 5,914 + cp137 net +17 from new smokes + brag-coverage rebalance) · LL #52 41ST HW-VERIFIED (unchanged) · 694 WEB + 493 INDEXER + 244 RELAY VITEST TESTS (1,431 — was 1,381 since cp131; tests added across the deep-audit campaign) · BRAG LIST 326 ENTRIES (cp136 324 + cp137 +2) · LOCALE PARITY 3,095 × 10 = 30,950 · CI GREEN AFTER F-5 FINGERPRINT FIX SHIPS.**

**cp137 — DEEP-DEEP three-persona walkthrough redo with VERIFY-everything rigor, plus CI failure fix:**

After cp136 push hit a CI failure on `comparison-image-freshness-smoke` ("PNG older than build script" — under git checkout's filesystem-walk-order mtime reset), Ken pushed back on the walkthrough rigor: "did sally, bob, etc actually try every feature like i told you? ... VERIFY everything, do not assume." cp137 redid the walkthroughs as a deep-deep of their own, verifying each surface by reading actual code, plus shipped 6 findings end-to-end:

- **cp137-F-5 SHIPPED — CI mtime-based freshness check non-deterministic.** `git checkout` resets every file's mtime to checkout time in filesystem-walk order, so any mtime-based "X newer than Y" check is non-deterministic in CI even when the repo is byte-perfect. Pre-fix smoke compared PNG mtime to script/SVG/brag-list mtimes; failed CI but passed locally because the developer's mtimes reflected actual build order. Replaced with SHA-256 content fingerprint sidecar: `apps/web/static/morphit-comparison.png.fingerprint` written by `build_comparison.py`, validated by `comparison-image-freshness-smoke` which recomputes the live SVG hash and compares. Survives `git checkout` because both inputs are file content. Tamper-tested: editing SVG without rebuilding fires "PNG fingerprint does not match" with both hashes shown. Smoke went 17→15 scenarios (-2 mtime checks, +1 fingerprint check, -1 brittle "footer date older than mtime" check now subsumed by fingerprint).

- **cp137-G-1 SHIPPED — stray trailing "+" in hero copy.** `home.hero_title`, `home.hero_body`, `seo.home.title` each had a literal trailing "+" character that looked like a typo to first-time visitors. Verified by grep: not a CSS pseudo-element, not a brand convention, not used anywhere else in docs except as numerical "or more" (3rd+, 5th+ etc.) — those are different. Stripped trailing "+" across all 10 locales.

- **cp137-G-2 SHIPPED — `login.body` copy misfit.** Said "Enter your Blurt account name and the passphrase that decrypts your posting key" but was rendered ONLY on the `import-needed` branch which has NO input fields — just 3 CTA buttons (Import / Create / QR-pair). Confusing for Grandma. Replaced × 10 locales with "Pick the option that matches how you got here."

- **cp137-G-3 SHIPPED — "first posting" jargon.** `login.no_account_body` said "the first posting is free" — "posting" reads as "blog post" to Grandma. Replaced × 10 locales with "first-time signup is free".

- **cp137-H-1 SHIPPED (Ken picked Option B from the ELI5) — seed-mode session-only persistence UX trap.** Pre-fix: seed-mode encrypted envelope with random ephemeral key, never persisted to localStorage. Sally pastes seed → trades → closes browser → has to paste seed again next visit. Privacy-positive by design but Grandma-hostile. Added new `remember_me_choice` import stage after successful seed import. Single UNCHECKED-BY-DEFAULT checkbox: "Automatically remember me on this device? (assuming nobody else uses it)" (Ken's exact wording). If unchecked → session-only behavior preserved (privacy-positive default). If checked → password + confirm fields appear; envelope re-encrypted with user's password; persisted via `writeEnvelope`; keystore mode set to `'password'`. Keyfile + posting-only modes untouched. New `import-remember-me-smoke` (5 scenarios, tamper-tested — flipping default to `$state(true)` fails with "MUST be unchecked by default"). Locale strings × 10.

- **cp137-H-2 SHIPPED — FAQ search failed Grandma's first-load questions.** Simulated against live `searchEntries`: pre-fix "how do I start" → `order_editing` (1.00), "how do I begin" → 0 hits, "first time user" → `profile_pages`, "getting started" → `how_morphit_protects_me`. Root cause: synonym map had no entries for `start`/`begin`/`first`/`newbie`/`getting`/`tutorial`/`this`/`thing`/`site`. Added two clusters (getting-started + deictic). Post-fix: 14 of 14 grandma queries route correctly. New `faq-search-grandma-coverage-smoke` (14 scenarios, tamper-tested — removing the cluster fails 5 of 14).

- **cp137-F-2 SHIPPED (from cp136 walkthrough, doc completion in cp137).** Updated `docs/OPERATIONS.md §22` to mention the new 19th step in `morphit-ops init` for fresh setups (was edit-only path).

- **cp137-G-5 SHIPPED — stale docstring asset-enumerations.** Four sites had docstrings listing only a subset of the tickers their code actually handles. (1) `apps/web/src/lib/components/ConversationView.svelte` lines 273 + 405 listed 8 and 9 tickers in `markSentArgs`/Mark-as-sent prefill docstrings — actual TypeScript union has 15 single-side methods (BLURT pays via PayBlurtModal separately). Updated to full 15. (2) `apps/web/src/lib/components/AddressShareModal.svelte` header docstring listed 10/16 tradable assets — updated to all 16; threshold-list docstring listed 8/15 single-side methods — updated to all 15; jitter docstring described only BTC/BCH/LTC/DASH UTXO coverage — rewritten to enumerate XMR + 8 UTXO assets + BLURT + SOL/ETH/XRP per-asset + 3 stablecoins. (3) `apps/web/src/lib/chat/payload.ts` line 573 — `jitterUtxoAmount` header "(BTC, BCH, LTC)" updated to all 8 UTXO assets it covers (BTC, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR — note that SOL/ETH/XRP have their own dedicated jitter functions because their unit semantics differ). (4) `apps/ops-cli/src/init/render.ts` — comment block of default explorer URLs listed only 5 single-network defaults (BTC/XMR/BCH/LTC/DASH); extended to all 12 single-network bundled defaults (added DOGE/ZEC/ARRR/DCR/SOL/ETH/XRP) plus added the 4 DAI multi-network defaults (ERC-20/Polygon/Base/Arbitrum) that were missing from the multi-network examples list. Each correction copies the exact URL from the canonical authoritative source (urlsCore.ts for bundled chat-link URLs; networks.ts for multi-network bundledExplorerUrl).

- **cp137-F-6 SHIPPED — BLURT missing from comparison image.** The `morphit-comparison.png` displayed on `morphit.io` (referenced in marketing/blog posts/fediverse threads/brag entry #168) showed only 15 of 16 tradable assets in its "Assets & fiat" section. BLURT — one of the THREE original core trading assets and the chain Morphit federates over — was missing. Added `('Blurt (BLURT) — the chain Morphit federates over', ['Y','-','-','-','-'], None)` between Monero and Ethereum rows in `scripts/comparison-image/build_comparison.py`. Only Morphit gets a Y; competitors don't support BLURT. Feature row count went 128→129. PNG rebuilt (still under 512 KB byte-budget). Brag entry #168 updated "128 verified data points" → "129". Mediakit rebuilt. SHA-256 fingerprint sidecar regenerated. This was a public-facing claim defect — marketing material was missing a CORE asset.


- **cp137-G-6 SHIPPED — comparison-image date non-determinism.** `scripts/comparison-image/build_comparison.py` embedded `date.today().isoformat()` in the SVG footer text. Two rebuilds on different UTC days produced different SVG byte content (and therefore different SHA-256 fingerprints). Harmless for current CI usage (smoke compares committed bytes, doesn't regenerate), but a footgun if anyone ever wires `build_comparison.py` into CI on every push — every UTC midnight would fail the comparison-image-freshness smoke until somebody committed a fresh PNG. Fix: derive the footer date from the brag-list trailer's "Last updated YYYY-MM-DD" via a `_read_brag_trailer_date` helper. Falls back to `date.today()` with a stderr warning if the trailer is missing/malformed. Verified deterministic: two rebuilds 2 seconds apart now produce byte-identical SVG (hash `a091a225...`). Semantically also more correct: the displayed date is "as of when the comparison data was last updated," not "as of when the script happened to run."

- **cp137 persona-walkthrough sentinel-family expansion.** USDT got 5 sentinels at Part 121 cp3 (P121-USDT-1..5) but the 12 subsequent asset additions (USDC cp30, BCH cp23, LTC cp24, DAI cp31, DASH cp27, DOGE cp33, ZEC cp39, ARRR cp41, DCR cp43, SOL cp45, ETH cp47, XRP cp49) had dedicated checkpoint-specific sentinels in other smokes (asset-registry, fee-method-enum-frozen, per-asset-key-family, etc.) but NOT in persona-walkthrough. Added 3-sentinel families for each: (1) canonical asset registry invariants (ticker / canPayListingFee:false / supportedNetworks / defaultNetwork / privacyWarningKey where applicable), (2) frontend asset registry parity (lowercase ticker + displayName + canBeUsedForListingFee:false + defaultNetwork), (3) supporting metadata or bundled chat-link URL constant + TXID regex. Total +36 sentinels: 12 × 3. All 165 walkthrough scenarios pass. Tamper-tested: renaming BCH in canonical registry → cp137-BCH-1 fails with clear "MUST HAVE not found: ticker: 'BCH'" message.


**cp136 — initial three-persona walkthrough (covered in §cp136 below):**

**cp131 — pre-launch deep-deep continuation, fix all findings end-to-end:**

cp131 walked the entire post-cp130 surface fresh: three-persona walkthrough (Bob / Sally-user / Sally-operator), full 94-task hostile-handler sweep across all 17 chain-op handlers, doc-drift scan, FAQ accuracy pass, regex-accuracy audit on a sample of smokes, DB dead-field check, fallback/failover sweep. 11 findings produced (10 from the structural sweep + 1 from FAQ accuracy walk), ALL 11 shipped end-to-end with sentinels pinning each so the drift class can't recur:

- **cp131-HIGH-001 SHIPPED — backup script ignored env vars.** `ops/backup/morphit-backup.sh` ignored `AGE_RECIPIENT`, `REMOTE_DESTINATION`, `SSH_KEY`, `DB_HOST`, `DB_PORT` env vars that the Ansible role wired in. Sally-operator who set up off-site backups got UNENCRYPTED plaintext SQL dumps despite `OPERATIONS.md §37.12` promising encryption that didn't exist. Rewrote backup.sh 111→261 lines (consumes all vars, placeholder-denylist guard for REPLACE/XXXXX/example.com/CHANGE_ME, age encryption, rsync push, pg_dump host/port). Rewrote `ops/backup/backup.env.example` (76 lines, REQUIRED/OPTIONAL split). Rewrote `ops/ansible/group_vars/all.yml` to safe-empty defaults. Rewrote `ops/ansible/roles/morphit/templates/backup.env.j2` to emit optional fields conditionally. Rewrote OPERATIONS.md §37.12 with a verification recipe operators can run to confirm their backups are actually encrypted.

- **cp131-HIGH-002 SHIPPED — env-var-consumer smoke hard-prefix bug.** `apps/ops-cli/scripts/ansible-env-var-consumer-smoke.ts` had a hard `MORPHIT_` prefix gate on both the Ansible-side AND consumer-side scans, so non-prefixed vars (`AGE_RECIPIENT`, `REMOTE_DESTINATION`, etc.) were invisible to both sides — exactly the bug class that masked HIGH-001 for 100+ checkpoints. Dropped the prefix gate from both scans; widened consumer scan to include `ops/backup/*.sh`; added `EXTERNAL_CONSUMER_TEMPLATES` allowlist with `bunkerweb.env.j2` entry (consumed by an upstream container, not by repo code); added scenario 4 verifying every allowlist entry exists on disk. Smoke now 122/122 (was 79); tamper-tested.

- **cp131-MED-003 SHIPPED — init.ts step count drift.** `apps/ops-cli/src/commands/init.ts:6` JSDoc said "~17 ELI5 steps"; wizard actually has 18 (TOTAL_STEPS = 18 in `apps/ops-cli/src/init/steps.ts`). Updated JSDoc + `apps/web/scripts/persona-walkthrough-smoke.ts:456` sentinel. persona-smoke 120/120.

- **cp131-MED-004 SHIPPED — README ADR-range drift.** `README.md` L34 and L53 said "0036-…" but the highest non-template ADR on disk is `0042`. Updated both lines AND extended brag-list-claim-parity-smoke with new claim class H using `ADR_RANGE_RE` regex + `highestAdrNumber()` helper + `CANONICAL_ADR_MAX` constant so any future doc claim of a stale ADR range fails CI. 84/84 passing; tamper-tested.

- **cp131-LOW-005 SHIPPED — duplicate BLURT price-source wiring.** `apps/indexer/src/main.ts` instantiated both a standalone `createPriceSource(config, db)` AND a `createMultiAssetPriceSources` map that ALSO contained a BLURT source — two independent fetchers making duplicate outbound HTTP calls on every refresh interval. cp131 consolidated: `priceSource` is now aliased to `multiAssetSources.get('BLURT') ?? null`. Dropped `createPriceSource` from imports; collapsed redundant `priceSource.stop()` in shutdown (BLURT now stops via the multi-asset loop). 2 new persona-walkthrough sentinels pin the consolidation. multi-asset-factory-smoke 20/20 confirms cp130 backward-compat intact.

- **cp131-HIGH-006 SHIPPED — warrant canary ghost op.** Docs claimed `@morphit` broadcasts a `morphit_warrant_canary_v1` chain op weekly. Reality: PGP-signed static file at `/canary.txt` via `scripts/canary/generate.sh`; the op id was never implemented. Removed all 4 references in `OPERATIONS.md` (lines 386, 396, 425) and `PRE-LAUNCH-CHECKLIST.md` (line 140). Rewrote `@morphit` account-funding rationale (was "needed for weekly canary broadcasts" — now correctly states no chain ops other than founder-tasks). Updated table row. Added 3 new sentinels in persona-walkthrough-smoke that grep for the ghost op id and fail if it reappears anywhere.

- **cp131-LOW-007 SHIPPED — ADR-0037 `_v1` suffix drift.** `docs/adr/0037-physical-shipment-tracking.md` used `morphit_addr_v1` / `morphit_funds_sent_v1` / `morphit_mailing_address_v1` / `morphit_shipment_v1` (with `_v1` suffix). Real code uses bare `kind: 'morphit_addr'` etc. — these are CHAT PAYLOAD kinds nested inside `morphit_chat_v1`, not standalone chain ops. Stripped the `_v1` suffix at 6 sites; added an explanatory note about the versioning convention per ADR-0015.

- **cp131-LOW-008 SHIPPED — PHASE-5 chat-op name drift.** `docs/PHASE-5-PLAN.md:335` and `docs/PHASE-5-BACKLOG.md:589` said `morphit_chat_message_v1`; the real op id is `morphit_chat_v1` (see `apps/indexer/src/indexer/dispatcher.ts:59-87` canonical OP_IDS). Renamed in both files.

- **cp131-MED-009 SHIPPED — push unsubscribe was unauthenticated + unrate-limited.** Pre-cp131 `/v1/push/unsubscribe` accepted `{account, endpoint}` with no signature and no rate limit, on the "users should always be able to unsubscribe" reasoning. Real risk: an attacker with a DB-leaked `(account, endpoint)` list could mass-fire unsubscribes and DoS notifications federation-wide. cp131 MED-009 mirrors the cp14 subscribe-side signature gate onto unsubscribe AND adds a per-IP rate limit (20/hour, same shape as subscribe). The ACTION keyword (`subscribe` vs `unsubscribe`) is folded into the canonical signed message so a captured subscribe-signature CANNOT be replayed as an unsubscribe (or vice-versa). End-to-end:
  - Server: factored `verifyPushActionSignature` parameterized core; added `verifyPushUnsubscribeSignature`; widened `unsubscribeBody` Zod schema with optional `signature` + `timestamp`; added `unsubscribeLimiter` + `requireSignedUnsubscribe` to `PushEndpoints` constructor; rewrote unsubscribe handler with rate-limit gate + optional/required sig verification.
  - Wiring: relay `main.ts` constructs `pushUnsubscribeLimiter` and passes `cfg.pushRequireSigned` for both.
  - Client: factored `signPushAction` parameterized core; kept `signSubscribe` + added `signUnsubscribe`. Unsubscribe call now signs and POSTs `{account, endpoint, signature, timestamp}` (falls back to unsigned when session is locked).
  - Verification: 5 new scenarios in `canonical-message-cross-check-smoke.ts` (16/16 pass; cross-action replay defense mathematically verified by signing a real keypair through both verifiers and asserting each rejects the other's signature). 9 new wiring sentinels in `web-push-wiring-smoke.ts` (44/44 pass; one false-positive in the cp14 sentinel after the refactor was simultaneously fixed).
  - Docs: rewrote OPERATIONS.md §42 unsubscribe rationale (was "intentionally unauthenticated DD-4"; now reflects cp131 MED-009 closure). Updated RELEASE-NOTES Notifications section.

- **cp131-LOW-010 SHIPPED — tar extract safety flags.** `apps/ops-cli/src/commands/upgrade.ts` `tar -xzf` call relied on GNU tar's default behavior, which refuses path traversal + absolute paths BUT honors archived uid/gid, setuid/setgid bits, and same-name dir→file overwrites. A compromised build host (or supply-chain replacement of both tarball and sibling `.sha256`) could exploit any of those. Added `--no-same-owner`, `--no-same-permissions`, `--no-overwrite-dir`. Empirically verified the setuid bit is stripped during extract. 3 new persona-walkthrough sentinels pin each flag.

- **cp131-DEEP-001 SHIPPED — `what_is_morphit` FAQ enumerated only 10 of 16 assets.** The headline FAQ (the FIRST answer a new user reads) was stale through cp124+ asset additions — listed only `Bitcoin, Monero, BLURT, USDT, USD Coin (USDC), Dai, Bitcoin Cash, Litecoin, Dash, and Dogecoin` while the registry has 16. Updated all 10 locales (en, es, fr, de, it, pl, ru, fa, zh-CN, zh-HK) preserving each locale's conjunction style (English Oxford comma, French "et", Persian "و", Chinese "和"/"同"). All 10 still parity-clean at 2,979 leaf strings each. New `what-is-morphit-asset-enum-smoke` (160 scenarios — 16 assets × 10 locales, with native-script aliases for zh-CN/zh-HK) pins the enumeration; tamper-tested by removing "Ethereum," from `en.json` → caught.

**cp131 lessons (carry forward to future audit cycles):**

1. **A "hardened" smoke can hide a real bug class for 100+ checkpoints if its gate excludes part of the surface.** The cp131-HIGH-002 prefix-gate bug in `ansible-env-var-consumer-smoke` is the canonical example. When designing a structural defense smoke, ALWAYS verify it covers the FULL surface — not just the prefixed/branded subset. The widened version now covers 122 scenarios; the original gated version was 79. The 43-scenario delta was exactly the dead-zone where HIGH-001 lived undetected.

2. **Documentation can SOUND right while being structurally wrong.** `OPERATIONS.md §37.12` confidently described backup encryption that the script didn't actually do. The doc-vs-code parity smoke (cp48-cp117 era) catches doc CLAIMS that don't match registry CONSTANTS but does not catch doc CLAIMS that don't match script BEHAVIOR. Open lesson: a smoke that runs `morphit-backup.sh` in a sandbox and verifies the output is age-encrypted would close this class. Filed as backlog.

3. **The "headline FAQ" is its own audit surface.** Asset additions through cp124+ updated the registry, the orderbook, the per-asset privacy pages, the FAQ-per-tradable-asset smoke, the receipt endpoint — but missed the prose enumeration in the most-read FAQ entry. cp131 DEEP-001 closes this with a structural smoke; the lesson is that prose enumerations are a category of drift the registry-coupled smokes don't catch.

4. **Cross-action signature replay needs ACTION-binding in the canonical message.** cp131 MED-009 was the second time a signed-message scheme almost shipped without the ACTION keyword (the first was at cp14 subscribe-side, where it WAS included from the start — credit Ken's spec). The cp14 prose said "subscribe" in the canonical; cp131 ADDED an "unsubscribe" variant with `subscribe`/`unsubscribe` in the canonical message. Generic principle for future signed-action messages: always include the action keyword. A new ACTION = a new ground-truth boundary, not just a code-path branch.

5. **All 17 chain-op handlers deep-read at cp131; none has a real exploit.** This isn't a casual claim — each was walked line-by-line with explicit black-hat reasoning about what a hostile op could do that the handler accepts. The codebase is meticulous. Memory rule "deep-deeps must be comprehensive in one pass — walk every sibling file, route, dispatch site, docblock, narrow union, i18n consumer, doc mention" was fully honored at cp131.

6. **Tarball discipline note:** cp131 work was done over multiple browser-session resumptions thanks to the TARBALL.md handoff protocol. Each turn's TARBALL.md update was the source-of-truth for the next session resumption.

---

**cp119 (Ken queue: fresh re-audit of cp112 SEO surface + fix all findings):**

cp113's A1/A14 findings weren't recoverable from prior transcripts (Ken's option 3: re-audit fresh, label cp119-A1, A2, etc.).  cp119 walks the cp112-touched surface (Head.svelte, urls.ts, jsonld.ts, routes.ts, FaqSearch.svelte, privacy index + per-asset, robots.txt) with a fresh audit eye.  8 findings produced, all 8 shipped same turn:

- **cp119-A1 SHIPPED (HIGH) — FAQ JSON-LD markdown leak.** `faqPageSchema()` was feeding raw FAQ markdown into `acceptedAnswer.text`. 77 of 128 FAQ entries contain `**bold**`, code-backticks, `\n\n`, or bullet markdown.  Google's FAQ rich-snippet would render these as literal asterisks.  Fix: new `stripMarkdown()` utility (`apps/web/src/lib/seo/stripMarkdown.ts`) handles 6 markdown classes (`**bold**`, `__bold__`, `\`code\``, `[link](url)`, `\n\n`, `• bullet`).  Applied in `faqPageSchema()` to both `name` and `acceptedAnswer.text` fields.  New defense `faq-jsonld-no-markdown-smoke` with 7 scenarios checks 2,560 FAQ field outputs (128 entries × 2 fields × 10 locales) for residual markdown across all 6 classes + a self-test that verifies stripMarkdown isn't a no-op.
- **cp119-A2 SHIPPED (HIGH) — Broken sitelinks search.** `websiteSchema()` declared `urlTemplate: ${origin}/faq?q={search_term_string}` to unlock Google's SERP sitelinks search box.  But `FaqSearch.svelte`'s `?q=` handler treated the value as an FAQ entry KEY, not a search query — a user typing "monero privacy" landed on `/faq?q=monero%20privacy` and saw nothing.  Fix: extended the `$effect` deep-link handler with Form 3 logic — when `?q=` doesn't match an FAQ entry key, populate the search input with the query string + focus it.  Now sitelinks-search-from-Google delivers users into a populated search experience that surfaces relevant FAQ entries.
- **cp119-A3 SHIPPED (MEDIUM) — robots.txt locale-prefix gap.** `Disallow: /onboarding/import` and `Disallow: /settings` are prefix-matched, so they covered the bare paths (which 404) but NOT `/en/onboarding/import` or `/es/settings` (the real pages).  Defense-in-depth weakened (pages still emit `<meta robots noindex>` so indexing was blocked at meta level).  Fix: added `Disallow: /*/onboarding/import` and `Disallow: /*/settings` wildcard variants to every user-agent stanza (22 stanzas × 2 paths = 44 new wildcard lines, total 88 disallow lines).  Updated header doc-comment.
- **cp119-A4 SHIPPED (LOW) — Twitter card `twitter:site` plumbing.** Optional `<meta name="twitter:site">` was missing. Extended the existing `MORPHIT_INSTANCE_SEO_*` env-var family with `MORPHIT_INSTANCE_SEO_TWITTER_SITE` (zod validator: `/^@[A-Za-z0-9_]{1,15}$/`).  End-to-end: Config interface + envSchema + map (apps/indexer/src/config/index.ts); InstanceResponse.seo (apps/indexer/src/api/instance.ts); frontend store interface + FALLBACK + API mapping with defensive fallback for older indexers (apps/web/src/lib/stores/instance.ts); indexer-client schema with optional field for back-compat (packages/indexer-client/src/index.ts); Head.svelte emission conditional on presence; canonical example file (ops/env/indexer.env.example); docs/OPERATIONS.md §43 "SEO override env vars" — entirely new section since OPERATIONS.md didn't yet have one (also documents the existing TITLE/DESCRIPTION/KEYWORDS triplet alongside the new TWITTER_SITE).  Ken decides whether/how to populate it for the canonical morphit.io build — Morphit's anti-Twitter stance could justify leaving it unset.
- **cp119-A5 SHIPPED (LOW) — JSON-LD `inLanguage` on home schemas.** `organizationSchema()`, `websiteSchema()`, `softwareApplicationSchema()` all gained an optional `locale` parameter.  When supplied, the schema emits an `inLanguage` field.  Home page (apps/web/src/routes/[lang]/+page.svelte) now passes `currentLang` to all three.  Helps Google disambiguate translated copies of the same `@id` node across hreflang variants.
- **cp119-A6 SHIPPED (LOW) — og:image alt grouping.** Each `<meta property="og:image">` now has its own immediately-following `<meta property="og:image:alt">`.  Previously only the PNG image had alt text; the SVG image was emitted alt-less.  Pleroma / ActivityPub tooling that prefers vector OG images now receives alt text too.
- **cp119-A7 SHIPPED (LOW) — softwareVersion constant.** Was hardcoded `softwareVersion: 'beta'`.  Refactored to named constant `MORPHIT_SOFTWARE_VERSION = 'beta'` at the bottom of `jsonld.ts` with a doc comment explaining: pre-launch is 'beta'; bump to '1.0' at launch; bump on each numbered release.  Single source of truth.  Memory rule "no hardcoded figures that change over time" applies in spirit; a labeled constant is the right granularity for a version string (a build-time package.json read would couple SEO to packaging, which has its own versioning lifecycle).
- **cp119-A8 SHIPPED (INFO) — privacy.guide_heading length smoke.** New defense `privacy-headline-length-smoke` (10 scenarios, 160 ticker × locale combos checked).  Verifies every `privacy.guide_heading` × `tradable_ticker` interpolation renders ≤110 chars (Google's recommended Article `headline` field limit).  Worst current rendering: French at 56 chars on BLURT.  Catches future drift if a translation gets verbose or a new long-name ticker gets added.
- **Audit lesson:** cp112's SEO sweep was thorough at its time but accumulated 8 findings over 7 checkpoints of subsequent work + the deeper-look-with-fresh-eyes pass.  Findings ranged from HIGH (FAQ markdown leak, broken sitelinks search) to INFO (defensive smokes).  All 8 fixable in one checkpoint with appropriate defensive tests.  Fresh-eye re-audits at multi-cp intervals are a real defense mechanism that catches both regressions and original-bug drift that the original-time smokes don't.

**cp118 (Ken queue: A7 flip + setup-wizard V3 #1 + translation re-audit):**

- **A7 SHIPPED — `privacy_asset` flipped to `indexable: true`** — was set to `false` at cp112 to avoid coupling SEO registry to asset registry. Cost: 16 well-written long-form per-asset privacy pages × 10 locales = 160 indexable URLs Google couldn't find. cp118 flip pays the coupling cost: `scripts/build-sitemap.mjs` gained `readAssetTickers()` + `expandRoutes()` that handle the `[asset]` dynamic segment by reading `ASSET_TICKERS` from `packages/asset-registry/src/index.ts` and expanding to one URL per ticker. Sitemap went from 180 URLs to 340 URLs (+160 as predicted). Same expansion mirror added to `scripts/seo-url-consistency-smoke.ts` to keep I-1/I-2 invariants green. The vitest `seo/routes.test.ts` "no dynamic route pattern is marked indexable" test updated to "every indexable dynamic route is expandable by the sitemap builder" with `EXPANDABLE_SEGMENTS = ['[asset]']` allow-list — new contract: if you mark a dynamic route indexable, you MUST add an expansion case to the builder + the smoke + this test allow-list.
- **New defense #47 — `privacy-asset-sitemap-parity-smoke`** — 4 scenarios: P-1 sitemap exists, P-2 every ASSET_TICKER × every locale present, P-3 no `/privacy/<ticker>` for unknown tickers (catches stale-ticker drift in opposite direction), P-4 exact count = `ASSET_TICKERS.length × LOCALES.length`. Self-tested via 1-char sed mutation of a sitemap entry — P-2 + P-3 both fired on the corruption. Registered in `scripts/run-smokes.sh` after svelte-component-import-coverage.
- **Setup-wizard V3 #1 SHIPPED — live config preview** — operators visiting `/admin/setup-wizard` now see their instance's CURRENT state pre-populated. Implementation simpler than feared: the existing `/v1/instance` API already exposes `disabled_assets`, and the existing `getInstancePaymentMethods` endpoint already returns the per-instance payment additions list. No new endpoint needed — just frontend wiring. The setup-wizard `onMount` subscribes to the `instance` Svelte store, hydrates `disabledTickers` from `state.disabled_assets` on first non-default emission, then stops hydrating (so subsequent background refetches don't blow away the operator's in-progress edits). Two new "Currently configured" preview rows: one above the asset checkboxes showing what's disabled NOW, one above the payment-method form showing the current per-instance additions list with key/name/category. Both have `aria-live="polite"` for screen readers. **NOT shipped per Ken explicit veto:** payment-method reordering (#2 cp118 V3 backlog), in-app auth-gating (#3 — defer to reverse-proxy auth which is already documented in OPERATIONS §14).
- **6 new i18n keys × 10 locales = 60 strings** — `admin.setup_wizard.assets.{current_state_label, current_state_loading, current_state_all_enabled, current_state_count}` + `admin.setup_wizard.payment.{current_state_label, current_state_none}`. Auto-translated, flagged in translation-quality block.
- **Translation re-audit of cp108-cp117 strings — PASSED** — mechanical spot-check of 101 auto-translated keys in cp108+ scope across 9 non-EN locales using a script that checks: (a) placeholder mismatches (e.g. `{count}` present in EN but missing in locale), (b) length-ratio outliers ≥3.5× or ≤0.30×, (c) untranslated English red-flag words ("please", "restart", "login", etc.) in non-Latin scripts. Results: **0 HIGH issues** (no placeholder breaks anywhere). 13 MEDIUM length-ratio outliers — all zh-CN/zh-HK translations of English UI labels, all eye-checked and confirmed correctly translated (Chinese is genuinely 3-4× more compact than English for terse UI labels; the heuristic threshold was too generous to Chinese density). 4 LOW English-residue hits — all matched on `docker compose restart indexer` (a literal shell command that correctly stayed in English, not translatable). Conclusion: mechanical audit caught no actual issues. Native-speaker review still recommended pre-launch per standing flag, but no obvious errors caught in the cp108-cp117 ~567 string corpus.

**cp117 (queue continuation — doc audit catch-up + SVGO test + setup-wizard V2):**

- **Operator-doc audit catch-up shipped** — cp116 missed the standing memory rule "Operator/launch doc audit before every tarball" by not mentioning the new `/admin/setup-wizard` route anywhere in operator docs. cp117 fixes it: `docs/RUN-A-MORPHIT-NODE.md` "Decide your operator stance" section rewritten to lead with a 3-path choice (CLI wizard / Browser wizard / Direct env-edit) + new dedicated "Browser setup-wizard" subsection covering UX walkthrough, what-it-does-not-do honest disclosure, and a "when to use" comparison table; `docs/OPERATIONS.md` disabled-assets section gained a browser-wizard mention as the second of three paths + new "Securing operator-only routes" subsection in §14 with copy-paste Nginx http-basic-auth and Caddy basicauth examples (correctly matching `^/[a-z]{2}(?:-[A-Z]{2})?/admin/` to cover all 10 locale prefixes; verified the no-prefix `/admin/setup-wizard` form gets JS-redirected via `apps/web/src/routes/+page.svelte`).
- **SVGO pass tested and rejected** — installed svgo 4.0.1 + wrote conservative config (every lossy/breaking plugin disabled, only metadata-stripping ones enabled), ran on all 22 carousel icons. Aggregate savings: **199 bytes (0.2%)** across 100 KB of icons. Per-file deltas: XMR -45 bytes (4.8%), BCH -28 bytes (3.3%), BTC -39 bytes (2.5%), DOGE -42 bytes (0.1% on 53 KB), several icons exactly 0. Path data SHA-identical verified on doge sample (121 paths preserved byte-for-byte). Conclusion: byte win too small to justify any visual-drift risk under Ken's "don't modify them" rule (cp115-cp4). Cleaned up — devDep uninstalled, config file removed, no working-tree changes from SVGO. **Filed as tested-and-rejected so a future cp doesn't re-try.** Aggressive config (convertPathData + mergePaths + cleanupNumericValues) would save more but risks precision drift; if Ken later wants byte savings on the carousel, the right move is to commission community-blessed simpler artwork rather than algorithmic optimization.
- **Setup-wizard V2 — payment-method REMOVE UI shipped** — third section added to `apps/web/src/routes/[lang]/admin/setup-wizard/+page.svelte`: machine-key input + KEY_PATTERN client-validation matching the indexer + canonical-RESERVED_KEYS warning (with distinct error message — not "reserved" but "canonical methods can't be removed via the per-instance mechanism") + POSIX-safe shell-escaped `morphit-ops payment-method remove <key>` emission + copy-to-clipboard with 2-second feedback + honest "orders safety" aside explaining that on-chain key persists in historical orders after removal. 9 new i18n keys per locale (1 under `payment.remove_key_error_canonical` + 8 under `payment_remove.*` tree): heading / intro / key_label / key_help / output_heading / output_subtitle / output_pending / orders_safety.
- **Brag-list entry shipped at #223** — sequential numbering preserved: 82 entries renumbered 223→304 → 224→305, trailer count 304→305, mediakit rebuilt per memory rule #4. The lettered-sub-entry `222a` from cp117-mid was a precedent break; cleaned up to true sequential. Two cross-references to brag entries existed (`#221`, `#222` in `docs/audit/2026-05-stride-matrix.md`), both below the insertion point — neither affected by the renumber.
- **i18n diff** — 9 new keys per locale × 10 locales = 90 strings (243 in 9 non-EN are auto-translated, flagged in translation-quality block).
- **Battery 4,971/0** local; +2 vs cp116 (one brag-list count scenario, one mediakit scenario count refresh).
- **A1/A14 cp113 audit findings still deferred** — context not recoverable from prior transcripts. Filed for Ken to clarify if hardening is still wanted.
- **SVG sprite-sheet — RULED OUT (2026-05-27, Ken).** Ken has permanently rejected the sprite-sheet idea; do not resurface it. The cp116/cp117 analysis (lazy-loading already negates most wins, regresses cold-visit cost, per-file Vite caching beats monolithic invalidation, ~5-10 KB modest savings not worth the permanent build+consumer-rewrite complexity tax) stands as the rationale, but the decision is now final regardless: no sprite-sheet, ever.

**cp116 (queue execution — A15 + setup-wizard V1):**

- **A15 fix shipped** — og-image-freshness smoke (#40) converted from mtime to content-hash sidecar. Builder (`scripts/build-og-image-png.sh`) now writes `apps/web/static/og-image.png.svg-sha256` containing the SHA-256 of the SVG source at build time. Smoke I-3 rewritten to compare current SVG hash against sidecar contents (robust to git checkout, unlike mtime). New I-7 added: verifies builder source contains both `.svg-sha256` and `sha256sum` patterns to prevent silent regression to mtime-only. Self-tested by corrupting sidecar 1-char with sed — caught. 6→7 smoke scenarios. See CP113 Lesson #3 for rationale.
- **A1/A14 deferred** — source text not recoverable from transcripts (signature-encoded tool payloads). REVISIT-LIST has A15 documented but A1/A14 only listed in cp113 entry without detail. Filed for Ken to provide context if needed.
- **SVG sprite-sheet consolidation deferred** — honest pushback surfaced to Ken: lazy-loading already negates most sprite-sheet wins (IntersectionObserver mount + `loading="lazy"` means first visitor pays zero bytes for unviewed icons); sprite-sheet regresses cold-visit cost; per-file Vite immutable caching is better than monolithic sprite invalidation; build-step + every consumer site rewriting is permanent complexity tax; real savings ~5-10 KB for 16 coin SVGs. RULED OUT by Ken 2026-05-27 — do not resurface.
- **Setup-wizard V1 shipped** — new route `/[lang]/admin/setup-wizard` (registered as non-indexable in ROUTES). Read-only config-generator approach, NOT server-mutation: solves the "manually editing a text file sucks" pain by generating the right env-var lines + CLI commands for operators to paste, without giving the web tier filesystem-write or service-restart privileges (sharp departure from current Docker-compose architecture rejected). **Section 1 — asset enable/disable:** 16 checkboxes (BTC/XMR/BLURT locked enabled per memory-rule core-3); inverted UX ("which coins to list?"); outputs the `MORPHIT_INDEXER_DISABLED_ASSETS=...` line. **Section 2 — payment-method add:** form (key, name, description, category, optional URL) with client-side validation matching `apps/ops-cli/src/commands/paymentMethod.ts` rules (KEY_PATTERN `[a-z0-9_]+`, ≤32 chars, RESERVED_KEYS Set with 41 canonical entries, https-only URL); outputs POSIX-safe shell-escaped `morphit-ops payment-method add ...` command. Copy-to-clipboard with 2-second feedback. **Section 3 — honest disclosure aside:** read_only / no_auth / restart_required limitations stated in plain UI. **Auth-gating:** none in V1 (page never mutates, so no need; operators put behind reverse proxy auth if desired). **i18n diff:** 25 new `admin.setup_wizard.*` keys + 2 new `seo.admin_setup_wizard.*` keys × 10 locales = 27 keys × 10 locales = 270 new strings (243 in non-EN are auto-translated, flagged in translation-quality block below). **Allow-list extensions:** 3 short-word same-spelling cases ("Crypto" fr, "Online" de, "Description" fr) added with documented reasons.
- **V1 NOT IN SCOPE (filed for follow-up):** payment-method remove UI (mirror of add — adds 5-15 strings, same CLI emission shape), live preview of operator's current config (would require new read-only endpoint), auth-gating (V1 is config-generator only), payment-method re-ordering.

**cp115 UX surface upgrade (cp1–cp7 final):**

- **Header bling** — MorphitLogoBling.svelte: 3-body gravitational sparkle behind the wordmark.  RAF loop + canvas + IntersectionObserver pause + prefers-reduced-motion fallback + Vite immutable caching.  3 brand-colored particles, soft mutual attraction + centroid pull + damping + velocity cap.
- **Two-row carousel** — CoinCarousel.svelte: 22 slots (16 coins from registry + 5 networks + Barter) split alternating even/odd into rowA and rowB, scrolling opposite directions (rowA normal, rowB reverse) so all slots become visible faster than a single 60-second loop.  Per-item opacity 0.85 (pinned by smoke I-10).  Icons render at authored full color, no SVG modification.  IntersectionObserver lazy-mount + lazy-loaded `<img>` per asset + duplicated track for seamless loop + prefers-reduced-motion disables animation.  Barter slot uses the Ken-uploaded SVG (10.9 KB, gold-bars-on-black-circle artwork, unmodified per Ken's "do not modify" rule cp115-cp7).
- **Seven-card priorities section** — PrioritiesSection.svelte, ABOVE the carousel.  Replaces the old 4-card `home.points` grid + the 4-card priorities-section from cp115-cp1.  Each card is a real `<a href="/<locale>/faq#<key>">` deep-link to a high-cross-link-density FAQ entry: Privacy first → `privacy_practices` (20 inbound), True P2P → `no_escrow_arbitration`, Unstoppable by design → `help_make_unstoppable`, Discoverability → `what_is_blurt` (12 inbound, 5 outbound), Encrypted Chat → `chat_privacy` (9 inbound), Reputation is everything → `what_is_reputation` (7 inbound, 5 outbound), Trade anything → `trade_goods_services`.  Each FAQ target is also a source in `FAQ_RELATED` so landing visitors see further suggestions and keep browsing.  Hover/click affordances: 2 px lift + intensified border + 3 px arrow nudge + brand-emerald CTA tint, 180 ms ease-out; focus-visible adds 2 px brand-color ring; active drops to baseline at 60 ms for tactile press; prefers-reduced-motion disables transitions.  Card text is Ken-canonical (cp115-cp5) and must not be paraphrased or reordered.  Card #1 (Privacy first) anchored with brand-gradient top border.
- **Asset-registry path consolidation** — 4 stale `/coins/{ticker}.svg` references in the registry (vestigial since cp21) migrated to canonical `/icons/icon-{ticker}.svg`.  CoinCarousel is now the first real consumer of `logoSvgPath` outside the smoke; `asset-registry-smoke` tightened to `existsSync()` every path.
- **Old home.points grid removed** — 4-card "non_custodial / no_kyc / uncensorable / grandma" Tooltip-based grid deleted from `+page.svelte`; locale files pruned of `home.points.*` (4 cards × 2 fields × 10 locales = 80 keys gone); native-translations-snapshot surgically pruned (72 native pairs removed with audit trail).  Heading hierarchy h3→h2 fix in the "Reachable via" panel (was bridged by old grid's h2s; now jumps from h1 to h2 to h2 cleanly).
- **href-xss allowlist** extended for `faqHref(p.faqKey)` in PrioritiesSection (every faqKey from a hardcoded const, no user input — reviewer-confirmed safe).
- **i18n-completeness allow-list** extended with 15 invariant-class entries: 5 network product names (Arbitrum/Base/BEP-20/Polygon/TRC-20) × 3 tested locales (de/es/fr), reason `c` (brand/standard names that don't translate).
- **Six new structural defenses** — #41 logo-bling-invariants (5), #42 coin-carousel-invariants (13 scenarios across cp1→cp2→cp6 expansion: visible-slots / disabled-filter / dedupe / lazy-attrs / IntersectionObserver / reduced-motion / 5-network-on-disk / barter-on-disk / 3-source-dedupe / opacity-0.85-pinned / two-rows-declared / opposite-directions / balanced-alternating-split), #43 svelte-component-import-coverage (57; caught the cp115-cp1 session-compaction "PascalCase tag referenced but import line missing" bug class structurally).
- **svelte-check type-error** fixed in CoinCarousel: `containerEl: HTMLDivElement` → `HTMLElement` since bound to `<section>`.

**cp114 CI failure fixes:** cp112's pushed tarball surfaced 2 CI smoke failures (both legitimate "cleanup needs to update the other side" misses).  **(1) native-translations-floor-smoke** — cp112 deleted 4 orphaned i18n keys but didn't prune them from the native-translations snapshot; surgical removal from es/fr/de native arrays + audit-trail entry in snapshot.  **(2) href-xss-smoke** — cp112's new `feeds` prop emitted `<link href={feed.href}>` which the smoke can't tell is site-controlled; added `'feed.href'` to Head.svelte's allowlist + hardened the prop docblock with a SECURITY CONSTRAINT note pointing future contributors at safeContactUrl() for any non-site-controlled future feed source.

**cp113 cp112-self-audit pass:** Ran an audit-eye pass over cp112's own shipped code and found 4 real bugs.  All 4 fixed same turn.  **A4** — Organization.logo declared 512×512 but pointed at the 41×26 brand mark (Google would reject the logo); repointed at `/app-icon.svg` which IS 512×512.  **A10** — og:locale was emitting bare `en` instead of Facebook-conformant `en_US`; new `ogLocale()` helper with full 10-locale map.  **A11** — missing `og:locale:alternate` entries (OG analog of hreflang); new `ogLocaleAlternates()` helper + loop in Head.svelte.  **A12** — both privacy pages I converted in cp112 used `import { page } from '$app/state'` while every other file in the project uses `$app/stores`; fixed both pages (5 reference sites).  7 other findings filed for follow-up or marked as theoretical (A1, A2, A3, A6, A14, A15) or design-decision-for-Ken (A7: should `privacy_asset` flip to `indexable: true`?).

**cp109+cp110+cp112+cp115+cp116+cp117+cp118 translation-quality flag (PRE-LAUNCH NATIVE REVIEW NEEDED — updated cp118; spot-check passed):** All auto-translated FAQ content + cp112 SEO keys + cp115 carousel/priorities + cp116/cp117 setup-wizard keys (~567 strings) + **cp118 live-preview keys: `admin.setup_wizard.assets.{current_state_label, current_state_loading, current_state_all_enabled, current_state_count}` + `admin.setup_wizard.payment.{current_state_label, current_state_none}` = 6 keys × 9 non-EN = 54 strings**. **Grand total cp108-cp118 auto-translated strings: ~621 strings.** cp118 spot-audit (mechanical script-based check for placeholder mismatches, length-ratio outliers, English-residue in non-Latin locales) found 0 HIGH issues, 13 MEDIUM (all Chinese density false-positives — Chinese is 3-4× more compact than English for terse UI labels; eye-confirmed all correctly translated), 4 LOW (all matched on the literal shell command `docker compose restart indexer` which correctly stayed English). Native-speaker review still recommended pre-launch, but no obvious errors in the corpus.

**Tarball cadence (active since 2026-05-21):** Per Ken's instruction, the .tar.gz binary regenerates only at meaningful milestones (multiple checkpoints of work, end of major audit phase, or when Ken asks). TARBALL.md + REVISIT-LIST + transcripts update every turn. cp130 is a meaningful milestone (item #5 wires multi-asset morphit_native for BTC + XMR alongside BLURT, with generic asset factory + coingecko vsCurrency generalization + per-asset static-floor config + per-asset peer monitoring + ADR-0042 + 20 smoke scenarios + brag entry + 3 docs updates).

## CP130 LESSONS

### Lesson #1 — Generic factories ship "for free" when the design was always generic

cp127 designed `createMorphitNativeFetcher({ asset, denominationFiat, ... })` as fully generic — any (asset, fiat) pair. cp127 only wired BLURT because that was the immediate use case. cp130 unlocked BTC and XMR with essentially the same wiring pattern — the factory was always ready.

The wiring lift in cp130 was ~150 lines of new code (factory.ts rewrite + per-asset config + main.ts boot + coingeckoFetcher vsCurrency generalization). Compare to the cp127 architectural lift of ~3,000 lines for the original morphit_native design. **Ratio: 5%.** Genericity at design time made cp130's additive work nearly trivial.

**Carry-forward:** when designing an asset-aware module, make the asset parameter explicit from day 1 even if only one asset is wired initially. The marginal complexity of `createX(asset, ...)` vs `createBlurtX(...)` is negligible; the future lift is enormous.

### Lesson #2 — `coingeckoFetcher` was 95% generic, 5% USD-hardcoded — find the small bits

The pre-cp130 coingeckoFetcher was already parameterized on `coinId` (so 'bitcoin' / 'monero' worked). What was hardcoded: `vs_currencies=usd` in the URL, `.usd` access in extractPrice. Two small surfaces.

Generalizing took ~10 lines and exposed a `vsCurrency` parameter. The lesson: when a function is "almost generic," the hardcoded bits are often the smallest possible change to make it truly generic. **Don't reflexively rewrite — surgically generalize.**

**Carry-forward:** before rewriting a "BLURT-specific" helper to be generic, grep the helper for the specific asset/fiat hardcoding. The work is usually 2-3 sites, not a full rewrite.

### Lesson #3 — Item collapsing avoids fake choice surface

Ken's six-bullet list included item #3 (per-asset denomination configurability). I had a choice in cp130:

- (a) Wire per-asset denomination via JSON-map env var or 16 separate env vars
- (b) Hardcode all assets to use the global `priceFeedDenominationFiat`

I picked (b) and documented "if a concrete use case appears, revisit." The reasoning: option (a) is preemptive complexity — no operator has asked for it, and the speculative scenario ("BTC in USD but BLURT in EUR") is plausible but speculative. Adding the config surface burdens grandma's grandfather the operator with another knob without solving a concrete problem.

The collapse is honest: item #3 wasn't dropped from REVISIT-LIST without thought. It was decided AGAINST after cp130 made the implications concrete. ADR-0042 documents the decision with reversible language ("if a concrete need appears later, revisit; the factory's `denominationFiat` parameter is per-asset already; only the wiring code hardcodes it").

**Carry-forward:** when faced with a feature request, document the collapse path explicitly. Future maintainers should be able to read "we considered per-asset denomination and chose not to because X" rather than "this surface mysteriously isn't generic."

### Lesson #4 — Backwards-compatibility wrappers cost almost nothing

cp130 kept `createPriceSource(config, db)` as a thin wrapper around the new `createAssetPriceSource(config, BLURT_DEFAULTS, db)`. Old call sites (the listing-fee endpoint, etc.) see no API change. New code uses `createMultiAssetPriceSources` for the map.

This pattern — keep the old function as a wrapper, add a new function for the more general case — is cheap. It avoided needing to refactor ~5 call sites in cp130. The wrapper is ~5 lines.

**Carry-forward:** when generalizing a function, ask "what would it cost to keep the old signature working?" Usually nearly nothing. Do it.

### Lesson #5 — Smoke tests need full fakeConfig defaults

cp130's first smoke run had 8 failures all from `Cannot read properties of undefined (reading 'replace')` — the fakeConfig was missing `klingexBaseUrl`, `coingeckoBaseUrl`, and several cp127 native-fetcher defaults. The fakeConfig in `test/testutils/context.ts` had grown organically as fields were added without test exercise.

Fix: pre-emptively add EVERY field the price-source code reads from Config to fakeConfig, with sane defaults. This bloats fakeConfig but makes the next smoke addition friction-free.

**Carry-forward:** when a smoke imports a feature module, eagerly check that fakeConfig has defaults for everything the module reads from Config. Better to bloat fakeConfig than chase undefined-reads scenario by scenario.

### Lesson #6 — Doc-comment markers as regression sentinels (FW-1 catch)

cp130's factory.ts rewrite accidentally dropped the FW-1 smoke's required documenting comment ("morphit_native between coingecko and the static floor"). The rewrite was structurally correct, but the regression sentinel is a TEXT match on the source file.

This caught a real risk: if a future maintainer rewrites factory.ts and reorders the upstream chain, the comment alone tells them the ordering is structural, not incidental. The smoke is a tripwire.

**Carry-forward:** when shipping a structural defense, include a doc-comment marker AND a smoke that greps for it. Code reviews catch most regressions; the smoke catches the rest.

## CP129 LESSONS

### Lesson #1 — Closing deferred items prevents technical debt accumulation

cp129 picked up where cp127 left off: Defense F was deferred in cp127's ADR-0039 as "future work" and parked in REVISIT-LIST. Two checkpoints later, with a clear head and no other in-flight work, it shipped in one session — ADR-0041 + module + smokes + docs + operator runbook in ~3 hours of focused work.

**The carry-forward:** deferred items in REVISIT-LIST aren't free. They accumulate context-load. If Ken hadn't pushed back ("can we do those 6 bullet points now? i hate walking away from stuff undone"), Defense F might have sat for several more cps. The earlier you ship a deferred item, the closer the design context is to memory and the less re-discovery cost is incurred.

**Carry-forward:** treat REVISIT-LIST items as "scheduled work, not eternal backlog." Pick a target cp for each entry the moment it's added. Items without a target cp turn into orphans.

### Lesson #2 — Logger signature varies by codebase; check before structuring messages

cp129's first typecheck pass had 5 errors, all from assuming a Pino-style structured-object-first logger signature (`log.warn({ ctx }, 'message')`). Morphit's logger uses `(eventName, contextObject)` — the inverse.

The 5-minute fix was sed-driven once I read `log/index.ts:296`. The lesson is structural: **don't assume logger ergonomics from training data; grep the codebase first.** Even a tiny pattern check (`grep "log\.warn(" $(some_existing_file)`) saves debugging.

**Carry-forward:** when introducing logger calls in a new module, copy the call signature from the closest existing module that already uses the logger correctly. Don't paraphrase from memory.

### Lesson #3 — Median-of-N is a Sybil-resistance primitive, not a fairness primitive

cp129's `median()` choice for peer-disagreement is sometimes mis-framed as "the fair way to combine peer prices." It's not about fairness. It's about Sybil resistance: a single malicious peer can shift the MEAN arbitrarily; a single malicious peer cannot shift the MEDIAN at all (the middle value still wins).

Combined with the ≥3 peers minimum requirement, the Sybil-resistance floor becomes "attacker must compromise majority+1 to manipulate the result." That's a meaningfully harder attack than "compromise one peer."

The doc-comment explicitly calls this out, and the structural smoke includes a "median resists single outlier" scenario that codifies the property. **Why this matters:** future maintainers tempted to switch median→mean for performance reasons (median requires sort; mean is O(n)) would break Sybil resistance. The smoke catches that regression.

**Carry-forward:** when a defense relies on a specific mathematical primitive (median vs. mean, hash vs. equality, modular arithmetic vs. integer), write a smoke that verifies the primitive's defining property — not just its correctness on happy-path inputs. Make the smoke fail under accidental substitution.

### Lesson #4 — Same-denomination filter is honest about a fundamental limit

The cp129 peer-price monitor can ONLY compare peers with the same `denomination_fiat`. A USD-denominated indexer can't compare its BLURT/USD price to a EUR-denominated peer's BLURT/EUR price without converting EUR-to-USD, which would require... an external oracle.

The honest answer is: the monitor degrades. In a mostly-EUR federation, a USD-denominated indexer has few comparable peers and skips comparison entirely. **No signal is better than a misleading signal.**

The lesson generalizes: when introducing per-instance configurability (like cp128's denomination_fiat), audit every downstream feature for "does this still work cross-instance?" If not, document the degradation honestly and ship the degradation rather than pretending otherwise.

**Carry-forward:** per-instance configuration creates federation-fragmentation risk. Each new config knob should ship with a "how does this affect cross-instance features?" audit and a documented degradation behavior.

### Lesson #5 — Pure-function decomposition makes time-dependent logic testable

cp129's `shouldFireAlert(aboveSince, now, lastAlertAt, sustainedHours, cooldownHours)` is a pure function — all inputs explicit, no implicit wall-clock dependency. This let the structural smoke verify edge cases (cooldown-elapsed-but-just-barely, exactly-at-sustained-threshold) with constructed `Date` values rather than `await new Promise(resolve => setTimeout(resolve, ...))`.

The runPeerPriceSampleCycle function also takes `now` as an optional param defaulting to `new Date()`. Production callers don't pass it; tests do.

This pattern — explicit time parameter with default to wall-clock — is borrowed from cp127's driftMonitor. It's worth codifying as a project convention. Anything with timing-driven behavior takes `now: Date = new Date()` as a parameter.

**Carry-forward:** all time-dependent logic accepts `now` as an explicit parameter. Don't lock `new Date()` calls into pure functions — they become untestable.

### Lesson #6 — Item #3 push-back was honest but maybe wrong

In planning cp129, I pushed back on item #3 (per-asset denomination configurability) as "preemptive complexity until #5 lands." The push-back was honest at the time. But thinking about it more:

If cp130 wires BTC/USD and XMR/USD via the generic factory, EACH of those will have a `denominationFiat` parameter that today reads from the single global `priceFeedDenominationFiat`. An operator who wants BTC priced in USD but BLURT in EUR will discover the limitation the moment they try.

So item #3 has a use case that's WAITING for item #5 to materialize. Bundling them in cp130 makes sense — design item #3's solution at the same time as item #5's wiring, rather than as a follow-up.

**Carry-forward to cp130:** revisit item #3 alongside item #5. The decision might be: keep one global (simpler), one global PLUS per-asset override map (flexible), or per-asset map mandatory (most expressive but operator-burden). Discuss with Ken before coding.

## CP128 LESSONS

### Lesson #1 — Pre-launch field renames cost less than you think when scoped honestly

cp128 renamed the listing-fee API fields `base_fee_usd` → `base_fee_fiat`, `blurt_price_usd` → `blurt_price_fiat`, and added a companion `denomination_fiat` field. Before starting, the cost estimate was "scope check needed first." After actually grepping the repo, the consumer count was:

- 4 site references (`StrangerFeeModal.svelte`, `post/+page.svelte` × 2, `api-response-shape-smoke.ts`)
- 1 producer (`listingFeeBody.ts`)
- 1 public TypeScript interface (`packages/indexer-client/src/index.ts`)
- 1 downstream Zod schema (`matrix-bot/scripts/api-response-shape-smoke.ts`)
- 2 documentation references (`docs/API.md`, `docs/SECURITY.md`)

Total: 9 sites for a rename that *sounded* expensive ("the listing-fee API field names"). Pre-launch, with no external API consumers, the actual work is bounded by the repo's own surface area. The lesson: **scope-check by grepping, not by intuition**. The intuition said "API rename = expensive"; the grep said "9 sites, all in-repo."

**Carry-forward:** before deciding a pre-launch rename is too risky, grep for the symbol. If it's all in-repo, the rename is just routine refactoring.

### Lesson #2 — Generic factories pay off again, again

cp127's `createMorphitNativeFetcher({ asset, denominationFiat, db, ... })` was already parameterized on `(asset, denominationFiat)` even though the cp127 wiring hardcoded `'USD'` at the call site. cp128 just exposed the parameter as operator config — zero refactor needed in the factory itself.

Similarly, the cp128 `formatFiat(amount, ticker)` helper centralizes per-ticker decimal precision and ISO-4217-vs-fallback handling in one place. The 2 frontend consumer sites went from "needs a custom format function inline" to "calls `formatFiat(amount, denominationFiat)`" with the ticker provided by the indexer response.

The pattern: **wherever you have to write "USD" or "BLURT" or any specific identifier, ask whether the call site should provide it instead**. The marginal cost of making something generic is small at design time; the marginal cost of un-generic-ing it later (when you discover the second use case) is high.

**Carry-forward:** when a module is going to be reused (or might be), invest the small cost of making it generic up front — even if you only have one caller today.

### Lesson #3 — Denomination is operator sovereignty, not USD-collapse-only

Ken's framing was forward-looking: "when and if USD goes away." But the actual immediate beneficiaries of cp128's denomination configurability are operators serving non-USD-native markets *today*. A Brazilian operator who wants the listing-fee echo in BRL doesn't have to wait for any geopolitical scenario — they flip an env var, restart the indexer, done.

This reframes the feature: not "USD-collapse hedge" but "per-operator display sovereignty, with USD-collapse hedge as a downstream benefit."

The two framings have different ADR narratives, different brag-entry pitches, different FAQ explanations. The "operator sovereignty" framing is more honest (immediate value) and the "USD-collapse hedge" framing is more compelling (future-proofing). Cp128's docs use both: lead with sovereignty, mention the hedge.

**Carry-forward:** when a feature has both an immediate and a hypothetical use case, document both. Don't oversell the hypothetical; don't bury the immediate.

### Lesson #4 — BRICS Pay framing nuance: rail vs currency

Ken's original question conflated two things: "won't I need an easy way to set the new base currency (such as a BRICS 'Unit', XDR/SDR, Amero, etc.)" AND "BRICS Pay as another payment method." The first is denomination; the second is payment rail. These are different architectural concerns.

Verified via web search: BRICS Pay is a *payment rail* connecting national payment systems (Pix, UPI, UnionPay, PayShap, SPFS, CIPS) — explicitly not a currency. The BRICS bloc has not announced any common currency as of mid-2026. The actual candidates for "denomination replacement" are XDR (IMF basket), XAU (gold ounces), regional fiats, and hypothetically-future ones.

Pushed back gently on the framing in the response, then shipped both features distinctly: denomination configurability (Part 1) + BRICS Pay registry entry (Part 2). Both are legitimate; both are now in cp128. The framing distinction matters because conflating them would have produced a worse design — e.g., "BRICS_UNIT" as a denomination ticker that doesn't exist.

**Carry-forward:** when a user's request mixes architectural categories, untangle before designing. Disagreeing politely with a framing while affirming the underlying ask is better than building the wrong thing.

### Lesson #5 — Field renames need a repo-wide grep, not a consumer-list grep

The cp128 rename caught the obvious consumers (`StrangerFeeModal`, `post/+page.svelte`) immediately. But the *deep-deep audit* found 4 additional drift sites that would have shipped stale:

1. `packages/indexer-client/src/index.ts` — public TypeScript interface (caught by `svelte-check` failure in the typecheck smoke)
2. `apps/matrix-bot/scripts/api-response-shape-smoke.ts` — downstream Zod schema (caught by repo-wide grep)
3. `docs/API.md` — public API reference doc
4. `docs/SECURITY.md` — operator-trust documentation referring to the old frontend variable name

Without the comprehensive `grep -rEn '<old-symbol>' apps/ packages/ docs/ scripts/ ops/`, all 4 would have shipped stale. The svelte-check smoke caught #1 mechanically; the deep-deep audit caught #2/#3/#4.

The carry-forward isn't "grep harder" — it's a **structural reflex**: every field/symbol rename runs the grep across ALL of (apps, packages, docs, scripts, ops). Not "the consumers I can think of"; literally `grep -rEn <symbol> .` minus `node_modules`.

**Carry-forward:** add to the rename-checklist: after the obvious consumer fixes, run `grep -rEn '<old-symbol>' . --include=...` across the entire repo before claiming done. If grep returns hits beyond the explanatory rename-history comments, those are bugs.

### Lesson #6 — The WAIVER_MIN_BLURT i18n string is denomination-stale (carry-forward to cp129+)

cp128 caught but didn't fix: the `WAIVER_MIN_BLURT` constant + its i18n key `post_order.errors.waiver_min_usd_required` + the user-facing hint "Minimum for the waiver: {N} BLURT (~$1 USD at current price)" hardcode USD as the reference unit even though the rest of the system now supports per-operator denomination.

Not a security bug — the BLURT constant is denomination-independent and works correctly. Just a UX polish item: a user on an EUR-denominated instance reading "~$1 USD" mixes units in their head.

The fix would be a small i18n string change (interpolate the operator's `denomination_fiat` into the hint) + maybe rename the i18n key to drop the `_usd_` segment. Deferred from cp128 because the surface area touches multiple form-validation paths and risks scope creep.

**Carry-forward:** add to cp129+ backlog. Estimated effort: ~30 min — 10 locale strings + one form-validation message + one i18n-key rename. Low priority (cosmetic only); ship when convenient.

## CP127 LESSONS

### Lesson #1 — A discussion phase before coding produces materially better designs

cp127 went through FOUR design discussion turns before any code shipped:

1. Ken's initial proposal (3 traders, 8 hours, 2 stablecoins → average) — sound but underspecified
2. My response surfaced data-model insights (USDT/USDC/DAI sit as BOTH assets AND payment methods; orders are `asset` × `fiat_currency` × `payment_methods[]`)
3. Ken's "what about all coins / what about stablecoin pricing" pushed toward broader architecture
4. Ken's "what if 2-3 stablecoins shut down / USD gets replaced" pushed toward tiered anchors + `denominationFiat` parameterization
5. Ken's "think like a conspiracy theorist" pushed toward 8 specific defenses with code-level commitments

The cp127 code that landed is qualitatively different from what would have shipped after turn 1. Specifically: the tiered anchor architecture (Tier 1 USD-direct primary, Tier 2 stablecoin supplement) only emerged after turn 4. The black-hat defense table (A-H with specific implementations) only emerged after turn 5. Both are now load-bearing parts of the design.

**Carry-forward:** for architecturally significant features, deliberately spend turns on discussion before coding. The "let me check the codebase, surface what I found, propose tradeoffs, ask decision questions, integrate Ken's pushback" pattern produces designs that wouldn't have emerged from straight-to-code execution. The discussion itself IS deliverable work.

### Lesson #2 — Documenting black-hat defenses inline in the code prevents silent regression

cp127's `morphitNativeFetcher.ts` has an explicit defense-by-defense doc comment (A. sock-puppet whale, B. slow-drift, C. external-source compromise, D. post-and-cancel race, etc.) AND the structural smoke MN-9 specifically checks that all 8 defense markers (A-H) appear in the file's source.

This is anti-regression in a way that prose docs alone aren't: a future maintainer who removes the post-and-cancel grace period code without also removing the "D." marker breaks the smoke. They have to consciously remove BOTH the defense AND its documentation marker. That's the friction we want — accidental defense removal becomes impossible.

The reputation-receipt smoke from cp124 did something similar (R-5 checks the formula docstring lists all 4 signal-table exclusions). Applying the pattern more broadly: any time we add a defense that's load-bearing, also add a smoke that fails when the defense's documentation disappears.

**Carry-forward:** for any defense whose removal would be a security regression, encode the defense's DOCUMENTATION in a smoke. Code without docs is hard to audit; smokes that check docs make documentation maintenance non-optional.

### Lesson #3 — Self-anchored systems beat externally-anchored where possible

The cross-stablecoin depeg detector is self-anchored: it uses cross-ratios between stablecoins to identify which one is the outlier, without needing to know "what USD is worth." The standard approach (assume USDT = $1, alert if it deviates) requires trusting an external fixed point. Self-anchoring removes that dependency.

The same pattern applies to morphit_native generally: deriving BLURT/USD from on-platform orders removes dependency on Klingex/Coingecko, but only AS FAR as on-platform trade volume can support. The trader population becomes the new anchor — which is consistent with Morphit's decentralization priority.

There's a limit: USD itself can't be self-anchored within Morphit's data model because USD IS the unit of account. We accept that limit honestly (the `denominationFiat` parameterization lets us swap to a different unit later if needed, but at any given moment SOME external unit has to be the reference).

**Carry-forward:** when designing systems that need to determine "what is X worth," ask first: can we determine it from internal data + internal consensus, OR do we genuinely need external trust? Self-anchored is preferred when feasible; honest acknowledgment is required when not.

### Lesson #4 — The pre-launch window is precious; don't waste it on backwards-compat we don't owe

Ken's reminder mid-cp127 — "noone on earth has installed morphit yet, not even our sysadmin" — was the critical context that let me skip several layers of compat scaffolding. Specifically:

- No migration tooling for the new `price_drift_baseline` table; `CREATE TABLE IF NOT EXISTS` is fine because every operator starts from this schema
- No deprecation path for the old static-floor-only behavior; the new env var defaults to false, existing behavior unchanged
- No "v1 then v2" of the price source interface; ship the tiered architecture from day one
- No legacy-format support in the receipt endpoint; one canonical shape

Each of these saved real complexity. The pre-launch freedom enabled by zero-installs-yet is finite — once the first instance goes live, we owe backwards-compat. **Use the window aggressively while we still have it.**

**Carry-forward:** for any pre-launch architectural change, confirm with Ken that no instance is live, then design for the ideal endpoint rather than for migration paths.

### Lesson #5 — Generic factory > per-asset implementation

cp127's `createMorphitNativeFetcher({ asset, denominationFiat, db, ... })` is generic across (asset, fiat) pairs even though the cp127 deployment only wires it for BLURT/USD. The marginal cost of making it generic was ~10 lines (parameter plumbing); the marginal benefit is that cp128 BTC/USD + XMR/USD instances are config changes, not refactors.

Same pattern applied to the cross-stablecoin depeg detector: accepts any `stablecoinKeys: ReadonlyArray<string>`, degrades gracefully with <2 keys. When USDF or PYUSD eventually need to be added to Morphit's payment methods, the detector picks them up by config change, not code change.

**Carry-forward:** when a module is going to be reused (or might be), invest the small cost of making it generic up front. Lock in the iteration cost of per-asset wiring as "config change" not "code change."

## CP126 LESSON

### Lesson — Verify the user's claim before agreeing, even when they're directionally right

Ken's cp126 note: "OM is mentioned in the brag list haveno section but you did not include the OpenMonero facts. i think the faq covered it, but it's not in the brag list too."

The brag list omission was real — section 13 header lists "OM" but no entry covered OpenMonero.  But Ken's parenthetical claim that "the faq covered it" turned out to be wrong: a thorough search showed the `vs_others` FAQ entry covered LocalBitcoins, LocalMonero, Haveno, Bisq, and BasicSwap — but not OpenMonero specifically.

Two ways this could have gone:

1. **Silently agree** with Ken's framing and just add the brag entry.  Misses the FAQ gap; leaves the brag-vs-FAQ parity Ken implied as broken.
2. **Verify, then push back honestly**: search the FAQ → find no OpenMonero coverage → tell Ken the FAQ is also missing it → propose adding to both surfaces with verified facts (June 6 2025 ~77.85 XMR hack + May 21 2026 second exploit alert).

Picked #2.  Ken's standing rule "honest pushback when claims are wrong" applies even when the wrong claim is a minor parenthetical; the larger ask is still good and the deliverable is better when both surfaces get fixed in one turn.

**Carry-forward:** when a user's note assumes some other surface is already correct, verify that surface before scoping the work.  The note's main point (brag list missing entry) was right; the implied parity baseline (FAQ has it) was wrong.  Both findings need to land in the same turn or the parity assumption stays broken for the next session.

Also: when adding factual claims about other projects (especially hack/exploit details), web-search to verify dates, amounts, and specifics from multiple sources before writing.  Don't invent figures from memory — got the OpenMonero numbers (~77.85 XMR / $25,225 / June 6 2025 / May 21 2026) from Monero Observer + KYCnot.me + OpenMonero's own statement + CryptoAdventure, all of which agreed.

## CP123-CP125 LESSONS

### Lesson #1 — Always inventory existing defenses before proposing new ones

Ken's cp123 ask ("make sure reputation cannot be spoofed, faked, artificially pumped") could have triggered immediate code-writing.  Instead the right first move was a full inventory: read the feedback handler, the signals module, the API aggregation, the schema, and Part 113's prior 15-vector enumeration.

Result: 11 of the 15 vectors were already DEFENDED.  Of the remaining 4: A6 is structurally undecidable, A10 is out of scope, D1 is a design choice, D3 was deferred.  Only D3 + the residual A4 actually warranted new work.  Without the inventory pass, I'd have proposed redundant defenses or worse — replaced existing ones that were already working.

**Carry-forward:** before adding new defenses to an existing system, exhaustively enumerate what's already there.  Credit the prior work honestly; the inventory itself is part of the deliverable.  "Already in place" is a valid and important finding.

### Lesson #2 — Proposing 8 options + having Ken pick 5 is better than proposing 5

Initial instinct was to propose ~5 hardenings.  Final list was 8 (H1-H8) with explicit pros/cons + my recommended subset.  Ken picked H1+H2+H4+H5+H6, skipping H3 (with explicit reason: too punitive for newcomers) and H7+H8.

The 3 rejected options were valuable EVEN THOUGH rejected: they surfaced tradeoffs Ken would otherwise have wondered about ("why not weight by reviewer credibility?" — answered preemptively in H3's analysis).  Forcing my recommendation to be a SUBSET of a larger menu forces the analysis to be honest about why some defenses aren't worth it.

**Carry-forward:** for design-decision asks, present a broader menu than your recommendation.  Each option carries its own analysis; the rejected ones are still load-bearing context.

### Lesson #3 — A shared JS+SQL formula module pays for itself the first time you need to verify

The cp123 time-decay formula lives in 4 places: 3 SQL aggregation sites (feedback.ts summary, orderbook.ts, orderbookStream.ts) AND the JS implementation in `reputation/decay.ts`.  Having a single module that exports BOTH `reputationDecayWeightSql(col)` (returns the SQL fragment) AND `reputationDecayWeight(ageMs)` (the JS function) made cp124 H4 (verifiable receipt) trivially correct — the JS receipt computation is provably the same formula as the SQL aggregate because they're both derived from the same source-of-truth doc comment.

**Carry-forward:** if a formula needs to run in both SQL and JS contexts, put both implementations in one module with cross-references and a smoke that verifies equivalence (cp123 reputation-decay-smoke has 13 such scenarios).  The cost of having two implementations diverge silently is much higher than the cost of co-locating them.

### Lesson #4 — Provability matters more than perfection

H4 (verifiable receipt) is a deliberate trade: the indexer's score becomes auditable by ANYONE with chain access.  This means a misbehaving operator can't quietly inflate their friends' scores — readers can prove it.  But it also means receipts from two different indexers might disagree (different signal-table state).

The right framing is NOT "the score is perfect" — it's "the score is verifiable AGAINST the chain."  Disagreement between two indexers' receipts surfaces the disagreement explicitly; the chain is the tiebreaker.  Provability is more valuable than asymptotic agreement because it gives readers a clear path to evidence rather than a single number to trust.

**Carry-forward:** when designing for trust, provability beats perfection.  Make the inputs auditable; make the algorithm documented; let the reader verify if they care.

### Lesson #5 — Subtle distinctions can be visible without being noisy (H5+H6)

H5 (buy/sell side breakdown) and H6 (dormancy signal) both add information to the profile page without changing the headline number.  Each surfaces as a small chip hidden when not populated.  Grandma still sees "4.74 ⭐ (23)" as the answer to "is this person reliable" — the new chips are inquiry-time additions for readers who want more depth.

Restraint matters: if every signal got the same visual weight as the headline, the profile becomes overwhelming and grandma can't read it.  Tiered visibility ("headline = simple; chips = depth-on-demand") preserves both audiences.

**Carry-forward:** when adding signals to an existing surface, default them to hidden/small/secondary unless they're truly headline-class.  Information density has a cost; not every signal needs to be loud.

### Lesson #6 — Brag-list discipline pays off when there are 311 entries

Ken's cp125 reminder ("make sure when u do the braglist that the numbering, proper categorization and spacing is done perfectly, all items are actually brag worthy and are not too long winded") forced a more careful insertion than the cp122 batch.

Three new entries went in section 8 (reputation) at precise positions: H1 between #116 and #117, H4 right after H1, H2 right after the existing sock-puppet entry, H5+H6 right after the verified-chat entry.  Each placement was chosen so the section reads as a coherent narrative (anchor → faking-defense → recency → verifiability → motivation → A/B/D signals → real-conversation signal → side+dormancy → responses).  Each entry stays at 2-4 sentences (KISS budget); no jargon walls; concrete enough to verify.

The sequential renumber script (originally from cp122) handled the shift from 307 → 311 entries cleanly, including the STACCATO_ALLOWLIST update to follow the now-shifted #195 → #199 and #186 → #190.

**Carry-forward:** the brag-list discipline rules are load-bearing — section placement, sentence budget, jargon avoidance, and the renumbering pipeline.  Disrespect any of them and the deliverable falls below "brag worthy."

## CP120-CP122 LESSONS

### Lesson #1 — When a user's request brushes against priority #1 (privacy), surface concerns AND propose mitigations in the same turn — never just refuse and never just build silently

Ken's cp120 ask ("provide a mail tracking field as basic proof of cash payment") had real privacy implications: tracking numbers can be looked up to reveal origin postmark to anyone with the number, exposing the buyer's general location to the seller.  Two failure modes were available:

1. **Build silently** — ship the feature as requested, no analysis surfaced.  User gets what they asked for but doesn't know the privacy implications.
2. **Refuse / stall** — overstate the risk, push back hard, lose the feature.

Right answer: lay out the privacy considerations in one paragraph + propose a privacy-preserving design + ask 3 specific go/no-go questions on the design choices.  Ken answered all 3 in his next turn; cp120 plowed through end-to-end.

The pattern: **honest pushback + proposed mitigations + crisp decision questions** is faster than either alternative.  It treats the human as an informed adult who can weigh tradeoffs once they have the information.  It avoids both the "blind agreement" and "paternalistic refusal" failure modes.

**Carry-forward:** when a request touches a Morphit priority (privacy especially), the first response should be (a) what's at stake, (b) what I'd build by default, (c) explicit decisions for the user to make.  Not 8 questions; not 0 questions; the minimum set that captures the real ambiguity.

### Lesson #2 — The right time to generalize is BEFORE the second use case ships, not after

Ken's cp120 request started narrow ("tracking for cash by mail").  In his cp120 reply, the related-thought generalization landed naturally: "what if someone wants to buy a barbie doll with monero?"

If I'd built cp120 as "cash-by-mail tracking" specifically (e.g. a `morphit_cash_mailed_v1` payload tied to the cash_by_mail payment method), the Barbie case would have required a cp124-or-later refactor: rename the payload, rebuild the modals, re-translate.

Instead, the payload is `morphit_shipment_v1` and the carrier registry is `apps/web/src/lib/shipping/carriers.ts` (note: `shipping`, not `cash`).  Both the cash-by-mail and goods-by-mail flows already use the same modal + payload.  The Barbie-for-Monero case works today with zero additional code, because barter_goods orders unlock the same in-chat "Record shipment" affordance.

**Carry-forward:** if a user's narrow ask becomes broader within the same conversation, that's the signal to widen the design BEFORE shipping cp.  The cost of refactoring "specific to general" after shipping is much higher than the cost of designing "general from the start" once you know two use cases.  Two use cases is also the right number — designing for hypothetical future use cases ("what about a haircut by remote?") gets speculative.

### Lesson #3 — Bundled-data invariants are cheap defenses; an alphabetized 20-item list with structural smokes caught a typo before any user saw it

cp120's carrier registry has 13 structural-invariant scenarios.  The first battery run after I wrote it caught a real bug: `pochta_rossii` came after `poczta_polska` in my list, violating alphabetical order.  Pre-bundled-invariants, that bug ships and no one notices for months (it's UX-cosmetic — the picker just shows in a slightly-wrong order).

Total cost of the smoke: ~150 lines of code that runs in 100ms.  Total benefit: caught a bug instantly + every future carrier addition gets the same check automatically.

The same pattern caught the second self-introduced bug: my str_replace ate the `function decodePayload(...)` declaration line by accident.  The payload-roundtrip smoke surfaced this immediately with a parse error pointing to the right line.

**Carry-forward:** any new bundled dataset (>10 items) should ship with an invariants smoke.  Cheap (~minutes to write).  Catches mid-stream self-inflicted errors as well as future-additions errors.  The pattern is well-established (carrier-registry-invariants-smoke is the 4th of its kind in Morphit) — copy from a sibling and adapt.

### Lesson #4 — `cash` → `cash_in_person` + `cash_by_mail` rename was clean BECAUSE it happened pre-launch

Pre-launch posture (memory rule: "Zero instances live anywhere.  No prior shipments.") let cp120 do a clean rename across the registry + indexer + 10 locale JSONs + 4 smokes.  No migration path needed.  No deprecated-alias compatibility layer.  No "old `cash` key resolves to `cash_in_person`" complexity.

If this same rename happened post-launch:
- Existing orders with payment_method `cash` would need either chain-side migration (impossible — Blurt ops are immutable) or a resolver shim that maps the legacy key.
- Locale snapshots would need version-stamped entries to support both pre- and post-rename clients.
- The cleanup cp would take 5x as long.

**Carry-forward:** pre-launch is the time to make all the registry/payload schema changes you'd ever want to make.  Resist the post-launch reflex to "preserve compatibility" before there's anything live to preserve compatibility WITH.  Memory rule: "Bugs found pre-launch are bugs prevented, not bugs that hurt anyone."

### Lesson #5 — A 20-carrier list with tracking URL templates is best-effort, not source-of-truth — and the doc comment should say so loudly

Carrier tracking URLs occasionally change (carriers restructure their URL parameter schemes for SEO reasons every few years).  Today's URL works; in 18 months, USPS might change `qtc_tLabels1=` to `qtc_tLabels=` and break our links.

Two design alternatives considered:
- **Strict source-of-truth posture**: smoke-test that every tracking URL actually resolves at battery time.  Network-dependent, fragile, exposes Morphit to rate limits.  Rejected.
- **Best-effort + escape hatch**: the registry has its 20 canonical templates, AND every shipment payload's recipient sees a `📋 Copy tracking` button so they can fall back to manual lookup if the bundled URL is stale.

Picked the second.  The doc comment at the top of `carriers.ts` names this loudly ("Best-effort URL templates.") so future maintainers understand the maintenance cadence (refresh when broken, not preemptively).

**Carry-forward:** for data we ship as "convenience pointers to third-party services," explicit best-effort labeling beats both pretending to be authoritative and refusing to bundle the data at all.  The `📋 Copy` escape hatch is the safety net.

### Lesson #6 — Privacy aside content should match user mental load: 4 bullets for non-cash, 3 collapsible bullets for cash

Initial design draft had ALL safety tips visible in the ShipmentModal (insurance, plain envelope, return address, tracking optional, tinfoil-wrap, UPS/FedEx prohibition, customs warning).  That's 7 bullets — too much for grandma.

Right answer: the always-shown set (4 bullets) covers any physical shipment; the cash-specific set (3 bullets) lives in a collapsible "If you're mailing CASH" expander.  The user opens the expander only when they're shipping cash, and gets the relevant info exactly when they need it.

The cost of the expander: ~10 lines of state + UI.  The benefit: grandma shipping a Barbie doll doesn't get cash-specific advice that doesn't apply to her trade.

**Carry-forward:** privacy/safety aside content can be tiered by context.  Show universal advice; collapse case-specific advice behind a labeled disclosure.  Don't dump everything on the user unconditionally — that's a "responsibility tax" that makes the safer choice harder to find.

## CP119 LESSONS

### Lesson #1 — Fresh-eye re-audits catch original-bug drift the original-time smokes don't

cp112 shipped a comprehensive SEO sweep with three new defenses: brag-list-claim-parity, seo-url-consistency, og-image-freshness.  All three were rigorously tested at cp112 and have stayed green since.  None of them caught any of the 8 findings cp119 surfaced.

Why?  Because each cp112 smoke was scoped to the gap it was created to close.  brag-list-claim-parity checks the brag list, seo-url-consistency checks URL parity, og-image-freshness checks file freshness.  None of them ask "does our JSON-LD render clean text" (cp119-A1), "does our sitelinks search actually work" (cp119-A2), or "are our robots.txt patterns locale-aware" (cp119-A3).

Fresh-eye re-audits are a defense mechanism PER SE.  They re-walk the same surface with no "this was already audited" prior.  Multi-cp intervals are appropriate — the first audit catches most bugs; the second audit catches the bugs the first audit's design didn't think to test for.

**Carry-forward:** schedule a fresh-eye re-audit pass on any "comprehensive sweep" cp ~5-10 cps later.  Label findings with the new cp number to preserve traceability.  If 0 findings, the original sweep was thorough; if N findings, those N are still bugs.  This pattern just shipped 8 real bugs.

### Lesson #2 — A planned-light fix can land in 5-6 files when the plumbing precedent already exists

cp119-A4 (twitter:site) felt heavy.  I initially expected to need a new endpoint, a new schema, a new wizard step, and so on.

Then I noticed the existing `MORPHIT_INSTANCE_SEO_*` family already plumbed an indexer-config → InstanceResponse → frontend-store → Head.svelte path for 3 SEO override fields (title, description, keywords).  Adding a 4th field (twitter_site) to that same path was a 5-file change: extend the Config interface + zod schema + map; extend InstanceResponse.seo; extend the frontend store interface + FALLBACK + API mapping; extend the indexer-client schema (optional for back-compat); emit the meta tag conditionally in Head.svelte.

Plus 2 doc changes: canonical env example + new OPERATIONS.md §43.

7 total files; mechanically straightforward because every file already had the exact pattern I needed to extend.

**Carry-forward:** before designing new plumbing for an optional config knob, check if a sibling family already exists.  Extending a family with one more field is dramatically cheaper than designing new plumbing — and the type checker enforces shape consistency automatically.

### Lesson #3 — The right granularity for a version string is "labeled constant," not "dynamic lookup"

cp119-A7 found `softwareVersion: 'beta'` hardcoded in jsonld.ts.  My first instinct: read from package.json at build time, so the SEO surface stays in sync with packaging.

But that couples two things with different lifecycles.  Package.json version bumps on releases; SEO `softwareVersion` is a human-facing label that may want to lag behind a release ("beta" through 1.x, "stable" at 2.0, etc.).  Coupling them removes the ability to express that intent.

Right answer: a named constant `MORPHIT_SOFTWARE_VERSION` with a doc comment explaining when to bump it.  Ken bumps it manually at meaningful release events.  Single source of truth; intentional state.

**Carry-forward:** the right granularity for a slowly-changing string is "labeled constant + doc comment about when to update it."  Not "hardcoded inline at 5 call sites" (rot risk) and not "dynamic computation" (over-engineering).  Memory rule "no hardcoded figures that change over time" doesn't say "no constants"; it says "no SCATTERED hardcoded figures."  One constant in one place is fine.

## CP118 LESSONS

### Lesson #1 — Check existing API surface before designing new endpoints

cp118 needed live config preview for the setup-wizard.  My first instinct was "this requires a new read-only `/v1/instance/admin-state` endpoint."  Then I went to look at what `/v1/instance` already exposed, and **it already had `disabled_assets: readonly string[]`** as a public field (used today by `apps/web/src/lib/components/PrivacyWarningChip.svelte` to surface "this instance has disabled X").  Similarly the existing `getInstancePaymentMethods` already returned the per-instance additions list (used today by the `instanceAdditions` store consumed by the order-posting picker).

So Item 2's "live config preview" became a pure frontend wiring task: subscribe to two existing stores in `onMount`, hydrate state, render preview.  Zero new API endpoints, zero new indexer routes, zero new server work.  Probably saved 200 LOC and one ADR.

**Carry-forward:** when designing a new feature, run `grep -r '<field>' apps/indexer/src/api/` BEFORE assuming you need a new endpoint.  Older code already exposed half the surface you're about to duplicate.  This pattern repeats in mature codebases — by the time you reach cp118, most of what you need to read is already exposed somewhere.

### Lesson #2 — Invariants written into tests have surprising reach

cp118 flipped `privacy_asset` from `indexable: false` to `true`.  Two distant places broke because they encoded a stronger invariant than the code actually required:

  - `apps/web/src/lib/seo/routes.test.ts` had `"no dynamic route pattern is marked indexable"` — coded for cp112's design.  The right invariant for cp118+ is "no UNEXPANDABLE dynamic route is marked indexable."
  - `scripts/seo-url-consistency-smoke.ts` literally compared the raw `/privacy/[asset]` pattern against sitemap entries — it never expected a dynamic route to BE in the sitemap.

Both were defensible at cp112 (when no dynamic route was indexable) and both became wrong at cp118.  The fix was to update the invariant to match the new design, not to dial back the architectural decision.  But each broke far from the cp118 work — easy to miss without a full battery.

**Carry-forward:** when changing a long-standing architectural invariant (like "dynamic routes never go in the sitemap"), search the codebase for every test/smoke that ENCODES the invariant, not just consumers of the data.  Grep for the invariant phrase or its negation.  The full smoke battery is the catch-net for distant-coupling violations like this; never trust "I only touched one file."

### Lesson #3 — Mechanical translation audits are useful EXACTLY because they're shallow

cp118 ran a script-based spot-audit on the cp108-cp117 auto-translated string corpus.  It flagged 17 findings: 0 HIGH, 13 MEDIUM, 4 LOW.  **Every flagged finding was a false positive.**  But the audit was still worth running because:

  1. Confirmed the cp108-cp117 auto-translations have NO placeholder-mismatch issues (the HIGH-severity class, which would cause runtime bugs like `Hello {name}` rendering as `Hello {name}` in some locale).  0 HIGH is a real datum, not the absence of one.
  2. Surfaced that the heuristic thresholds need refinement for Chinese (which legitimately compresses 3-4×).  Future audits should bypass length-ratio checks for zh-CN/zh-HK, or use a different threshold.  This is now a known limitation, not a recurring source of noise.
  3. Caught the literal `docker compose restart indexer` pattern — useful to confirm that code-fenced commands stay in English (a deliberate choice, but worth verifying).

Mechanical audits don't replace native review.  But they DO catch the class of error that humans miss easily (placeholder breaks, truncation, encoding issues) and rule them out comprehensively.

**Carry-forward:** when shipping batches of auto-translated content (≥50 strings), include a mechanical-audit pass as standard practice.  The script is small and reusable; the confidence it provides is non-trivial.  Add it to PRE-LAUNCH-CHECKLIST.md alongside the existing native-review item.

## CP117 LESSONS

### Lesson #1 — Operator-doc audit catch-up is a real-cost slip when missed

cp116 shipped the `/admin/setup-wizard` route without updating any operator docs.  Memory rule "Operator/launch doc audit before every tarball" should have caught this same-turn.  It didn't, because I read the rule as "audit for *implications* of the turn's work" and not as "audit for *direct mentions* of new operator surfaces."  Both interpretations are valid; the second is what the rule actually means.

cp117's first move was a catch-up: 3 new doc sections (RUN-A-NODE 3-path-stance rewrite, RUN-A-NODE "Browser setup-wizard" subsection, OPERATIONS "Securing operator-only routes" with Nginx + Caddy snippets).  Caught my own claim-error while writing the OPERATIONS section: I'd written "the bare `/admin/setup-wizard` form is accessible too" — false; the bare path JS-redirects to a locale-prefixed form.  Verifying claims before they land in docs is the actual discipline.

**Carry-forward:** when shipping a new operator-facing route, EVERY operator doc that mentions adjacent flows (env vars, CLI commands, services) must get a paragraph referencing the new route.  Same-turn.  Don't take "catch up next cp" — that's how flag-debt accumulates.

### Lesson #2 — Sometimes the right answer is "tested and rejected"

cp117 ran SVGO on all 22 carousel icons with a conservative config (every lossy plugin off).  Aggregate savings: 199 bytes (0.2%).  The honest move was to not ship.

This is worth filing because the alternative — shipping the 0.2% win because it was already done — would have:
(a) added a build-time dependency (svgo 4.0.1) that almost nobody would benefit from
(b) added a permanent code path (`svgo.config.mjs`) that has to be maintained
(c) created a tempting precedent for "well, let's just enable convertPathData too" in a future cp that doesn't read the visual-drift risk carefully

**Carry-forward:** sunk-cost fallacy is a real risk in checkpoint-driven work.  If exploration shows the win is marginal AND the cost is permanent complexity, the courageous move is to revert and document the tested-and-rejected state so future cps know not to retry.  The REVISIT-LIST entry is the safety net — "we tested this, it didn't pay; here's the data" — that lets a future contributor make the same call faster.

### Lesson #3 — Sequential numbering > convenience-numbering for cross-referenceable lists

cp117 first added the new brag-list entry as `222a` to avoid renumbering 82 downstream entries.  It worked structurally (sentence-budget smoke passed) but broke the convention: brag-list numbering is strictly sequential throughout the entire 304-entry file with zero precedent for lettered sub-entries.  An audit document (`docs/audit/2026-05-stride-matrix.md`) already references brag entries by number — and while neither reference happened to fall above my insertion point, the principle stands: numbers in a sequential list have semantic weight.

Renumbered correctly to `223` (with 82 downstream entries shifted to 224-305).  Trailer updated to "305 specific selling points," mediakit rebuilt per memory rule #4.  Total churn: 82 line edits + 1 trailer edit + mediakit zip refresh.

**Carry-forward:** when inserting into a sequentially-numbered reference list, do the renumber.  The convenience of a sub-letter is local; the cost — broken precedent that a future contributor will follow, growing fractal-style — is permanent.  The renumber cost is bounded (and a regex one-liner away).

## CP116 LESSONS

### Lesson #1 — When source text isn't recoverable, file it openly and move on

cp113 had filed audit findings A1, A2, A3, A6, A14, A15 for follow-up.  cp116's queue called for "A1/A14/A15 smoke hardening."  A15 had been documented well in REVISIT-LIST (mtime → content-hash sidecar — actionable).  A1 and A14 had only the bare designation, no detail; the cp113 transcript's tool-use payloads are encoded as opaque signatures, so the original audit text wasn't recoverable.

**The wrong call** would have been to invent hardening work for A1/A14 that *sounded plausible* based on cp113's general SEO theme — risking shipping smokes that defend against things that weren't real findings.  **The right call** was to ship A15 properly, document that A1/A14 source isn't recoverable, and ask Ken for context if those findings still matter.  This is the "NEVER ASSUME, ALWAYS VERIFY" rule applied to your own past work, not just external code.

**Carry-forward:** when a queued item references prior-cp work whose detail can't be confirmed in current context, surface the gap to Ken rather than inferring.  Cheaper than shipping wrong-defense smokes.

### Lesson #2 — Architectural fit matters more than feature completeness

The cp116 queue item "setup-wizard asset-disable + payment-method CRUD" had two design paths:
  - **Path A**: server-mutation UI — the wizard saves the operator's choices back to disk, signals service restart, etc.
  - **Path B**: read-only config-generator — the wizard renders the operator's intended state as text the operator pastes into their morphit.env / runs in their terminal.

Path A is the obvious "complete feature."  But the existing operator architecture is env-file-configured + Docker-compose-managed + ops-cli-broadcast — Path A would require: filesystem-write permissions in the web tier, a new mutation endpoint, service-restart trigger, auth-gating to prevent any visitor from disabling assets / broadcasting fake payment methods.  All four would be sharp departures from the existing architecture, each with its own attack-surface implications.

Path B preserves the architecture and removes the worst pain (typo-prone manual editing).  It surfaces its own limitations honestly via a disclosure aside.  Operators who want full auth-gated mutation can put it behind their reverse proxy, but the page itself never needs to be auth-gated because it never mutates.

**Carry-forward:** when extending a system, the question "what would be the most useful feature?" must be tempered with "how does it fit the existing architecture?"  A V1 that respects the architecture and ships fast beats a V1 that fights the architecture and ships slow.  Tag the V1's limitations openly so a future V2 can add the missing pieces deliberately.

### Lesson #3 — Pushback on a poorly-fitting feature is part of execution, not a stall

The cp116 queue included "SVG sprite-sheet consolidation."  Easy to do mechanically.  But: the carousel already uses `IntersectionObserver` + `loading="lazy"` so first visitors who don't scroll past the hero pay zero bytes for the icons.  A sprite-sheet REGRESSES that — every visitor pays the sprite cost upfront whether they scroll or not.  Plus: per-file Vite immutable caching breaks for monolithic sprites (any icon change invalidates all 22), the source-of-truth complexity grows (build step + every consumer site rewritten to `<use href>`), and the real byte savings are modest (5-10 KB for 16 coins).

Just doing it would have been faster than the pushback was.  But the pushback is the value — Ken gets a real trade-off analysis instead of a 200-line PR that's net-negative for first-visit performance.

**Carry-forward:** when a queue item is dubious on its merits, surface the trade-offs to Ken before doing the work.  The cost of one round-trip is far smaller than the cost of shipping a change that ages badly.

## CP115 LESSONS

### Lesson #4 (cp115-cp7) — Don't quietly delete other people's surfaces

Ken's cp115-cp4 instruction was "use the 7 cards I sent you. that's all of them, just the 7. word for word, just as you displayed them above."  Reading 1: only the priorities-section cards (the 4-card version from cp115-cp1 → 7-card version per Ken's text).  Reading 2: home page only has those 7 cards total, delete the existing `home.points` grid too.  I went with Reading 1 (the safer interpretation) and surfaced the ambiguity instead of guessing.  Ken then confirmed Reading 2 in cp7.

**Carry-forward:** when an instruction could plausibly mean "modify X" OR "modify X and delete Y," ship the smaller change and flag the larger possibility rather than infer Y silently.  The cost of an extra round-trip is much lower than the cost of having silently deleted a surface the user wanted kept.  Especially true when Y has its own integrations (the `home.points` grid had a Tooltip + FAQ link plumbing that wasn't obvious from a casual read).

### Lesson #3 (cp115-cp6) — Structural removals cascade into smoke maintenance

Removing the `home.points` grid wasn't 1 surgical edit; it was 5:
  1. `+page.svelte` markup + `points` array + `Tooltip` import deletion
  2. `home.points.*` removal from all 10 locale JSON files (80 keys)
  3. `native-translations-snapshot.json` surgical-prune of 72 native pairs across 9 non-EN locales
  4. Heading-hierarchy fix: networks-panel `<h3>` → `<h2>` (the points grid's `<h2>`s had been bridging the h1→h3 gap; once removed, hierarchy jumped)
  5. href-xss allowlist extension for the NEW PrioritiesSection's `faqHref(p.faqKey)` binding

Edits 4 and 5 were caught by the full smoke battery only AFTER I'd already considered the change "shipped."  The cp114 lesson #1 was "snapshot files + allowlists are part of 'wire everything'" — cp6 confirms the rule generalizes: ANY structural removal needs full-battery before tarball, not just smokes the cp explicitly touched.

**Carry-forward:** when deleting a UI surface, mentally walk a checklist of (a) markup, (b) all locale strings, (c) native-translations snapshot, (d) heading-hierarchy (did the deletion remove a hierarchy-bridging heading?), (e) smoke allowlists referencing the now-deleted file, (f) any tests asserting the surface's presence.  And then run the full battery.

### Lesson #2 (cp115-cp2) — "Stale fields with no consumers" hide path-correctness bugs

`logoSvgPath` had been declared as a registry field since cp3 and ostensibly the single-source-of-truth for "where does this asset's icon live."  But no UI component ever consumed it — every consumer (home page 3-asset block, orderbook coin pills, FAQ asset references, etc.) hardcoded its own path template (`/icons/icon-{ticker}.svg`).  This meant the 4 stale `/coins/{ticker}.svg` values in the registry were invisible to runtime — they pointed at non-existent files but nothing ever requested them.  When cp115's CoinCarousel became the first real consumer, those 4 entries would have rendered broken images.

**Carry-forward:** when introducing the FIRST consumer of a previously-vestigial field, audit the field's values for soundness before consumption.  Also: the deeper smell is "if a field has no consumer, why does it exist?" — consider deleting unconsumed fields, or wiring the SSoT pattern they were designed for.  cp115 went the second route (made CoinCarousel a real consumer).  Future cps that find similar fields should make the same call deliberately.

### Lesson #1 (cp115-cp2) — Structural defenses that catch session-compaction class bugs are worth their setup cost

The cp114-to-cp115 session compaction left MorphitLogoBling REFERENCED in `+layout.svelte` but its IMPORT line absent.  Svelte didn't error — it treated `<MorphitLogoBling>` as an unknown HTML element and emitted it literally.  The page would have rendered without the bling at runtime.  No SSR error.  No console warning until you opened the actual page.

This is a session-compaction class: any cp that adds a new component reference plus its import in the same edit, but where compaction summarized "import added" without preserving the actual import line, is at risk.

**Carry-forward:** `svelte-component-import-coverage-smoke` (cp115's #43) catches this structurally for the entire `apps/web/src/` tree.  Self-tested by temporarily removing + restoring the MorphitLogoBling import line — caught the regression.  Future cps that ship new Svelte components should run this smoke locally before tarball as part of the standard pre-tarball check (it's in `run-smokes.sh` so the full battery covers it).

### Lesson #1b (cp115-cp2) — Type the bound element to match the HTML element it's bound to, not the closest-looking primitive

`CoinCarousel.svelte` had `let containerEl: HTMLDivElement | null = $state(null)` but `bind:this={containerEl}` was on a `<section>`, which is `HTMLElement` not `HTMLDivElement`.  svelte-check caught it (`Property 'align' is missing in type 'HTMLElement' but required in type 'HTMLDivElement'`).  An honest mistake — I'd been working on MorphitLogoBling earlier where containerEl IS bound to a `<div>` and reused the type pattern thoughtlessly.

**Carry-forward:** when reusing a code pattern across components, verify the bound element type before copy-pasting the declaration.  `HTMLElement` is the safe parent type when you don't need element-specific properties; only narrow to `HTMLDivElement` / `HTMLImageElement` / etc. when you actually call element-specific methods or read element-specific properties.

## CP114 LESSONS

### Lesson #1 — Snapshot files + allowlists are part of "wire everything"

cp112's verification matrix ran the SEO-class smokes I'd touched but NOT the workspace-wide battery.  The snapshot file is owned by `native-translations-floor-smoke` which I didn't think of, and the allowlist is owned by `href-xss-smoke` which I also didn't think of.  Both should have been in cp112's "wire everything" checklist.

**Carry-forward:** every cp that changes i18n keys (add OR delete) is on the hook for `apps/web/scripts/native-translations-snapshot.json`.  Every cp that introduces a new href binding in a `+page.svelte` or `lib/components/*.svelte` file is on the hook for `apps/web/scripts/href-xss-smoke.ts`'s `ALLOWLIST_HREF_EXPR`.  Add both to the standard pre-tarball checklist.

### Lesson #2 — Run the full local smoke battery before tarball

cp112 ran the cp112-touched smokes locally and they all passed; CI caught the two I hadn't thought to run.  The CI catch is fine (that's what CI is for), but the round-trip cost (cp114 fix + fresh tarball) was avoidable.  The full local battery takes ~3-4 minutes; small cost for the certainty.

**Carry-forward:** before tarball — especially comprehensive sweep cps that touch many surfaces — run the full local smoke battery, not just the smokes the cp explicitly touched.

### Lesson #3 — Prefer surgical edits over full regenerates when the regenerate has side effects

The `native-translations-snapshot-rebuild.ts` script would have fixed the failure by regenerating the whole baseline from current state.  But that would have baseline-locked all the cp108–cp112 auto-translated strings as "must stay native" — conflicting with the pre-launch translation-quality flag which says those strings still need native-speaker polish.  Going with surgical removal of just the 4 deleted keys preserved the existing flag's correctness.

**Carry-forward:** when a smoke offers "just regenerate," check whether the regenerate has side effects beyond the immediate fix.  If yes, surgical is better.

## CP113 LESSONS

### Lesson #1 — Audit your own turn before declaring done

The 4 cp113 fixes were bugs **I shipped in cp112** less than an hour earlier.  cp112 felt thorough (mutation tests, comprehensive verification matrix, all smokes green) but the audit-eye pass turned up real issues across 3 of the files I touched most.  Pattern: I trusted my just-written code more than I should have, while distrusting decade-old code (urls.ts as it stood pre-cp112) appropriately.

**Carry-forward:** for any non-trivial cp that touches new design surface, run a self-audit-eye pass at +1 turn before declaring the cp closed.  Memory rule "NEVER ASSUME, ALWAYS VERIFY" extends to verifying my own just-shipped code, not just code from other contributors.

### Lesson #2 — Grep before you import

A12 was the most embarrassing: I wrote `import { page } from '$app/state'` because Svelte 5 docs mention that import path, without checking what **the rest of the project uses**.  The rest of the project uses `$app/stores` consistently across 100+ files.  A single `grep` would have surfaced the convention.

**Carry-forward:** before introducing a new import or pattern, grep the codebase for how similar files do it.  The project has converged on conventions for good reasons (sometimes archaeological, sometimes deliberate); diverging without cause is just creating future cleanup work.

### Lesson #3 — mtime is the wrong tool for git-versioned artifact freshness

A15 surfaced that the og-image-freshness smoke uses mtime, which is reset on git checkout.  The robust check is content-hash + sidecar.  Filed for a future cp; the practical bite-risk is low (smoke runs in CI on every push where mtimes are approximately simultaneous), but the principle generalizes — any "is artifact X derived from source Y" check should hash the source, not check mtimes.

### Lesson #4 — Self-handicaps in SEO registry are still self-handicaps

A7 surfaced that `privacy_asset` was set `indexable: false` to avoid coupling the SEO registry to the asset registry.  That's a valid engineering reason for decoupling, but the SEO cost (160 long-form pages NOT in sitemap) is real.  The coupling cost (1 smoke that enumerates ASSETS → privacy/{ticker} URLs and verifies sitemap presence) is small.  Flipping to `indexable: true` is probably the right call once we decide.  Ken's decision queued.

## CP112 LESSONS

### Lesson #1 — `?lang=` query-string hreflang was a stale design no smoke caught

The cp112 SEO bug had been shipped for many checkpoints.  Path-based prerendering shipped earlier in the project history and was the correct design; the `urls.ts` `hreflangAlternates()` function was a holdover from before that pivot, still emitting `?lang=es` form URLs.  The comment in the file even said "Morphit uses query-string-based locale switching" — false since the prerender refactor.

No existing smoke caught this because:
- `routes.test.ts` covers i18n coverage (every route has seo.*.title) and indexability rules, but not URL-shape parity
- `mediakit-freshness-smoke` covers static asset freshness, not URL emission
- The sitemap builder has its own `assertRoutesInSync()` but only checks against the routes ARRAY, not the urls.ts HELPERS

cp112's new `seo-url-consistency-smoke` (defense #39) closes this gap permanently by comparing the helper's URL output to the sitemap-builder's URL output byte-for-byte.  366 scenarios; mutation-tested across all 3 invariants.

**Lesson:** any place a derived URL form is computed in two places (helper + builder + page), a parity smoke must exist.  Otherwise the two will drift silently and SEO will pay the price.

### Lesson #2 — Stale module-level doc comments are real liability

The bug in Lesson #1 had been hiding in plain sight: the docblock said "uses query-string-based locale switching" but the code DID emit query-string URLs while the rest of the app used path-based URLs.  A reader of the docblock would conclude "this is correct."  Only an exhaustive end-to-end check (cp112's seo-url-consistency smoke) catches the mismatch.

**Lesson:** when refactoring a module's behavior (e.g. switching from query-string to path-based locales), the docblock MUST be updated in the same commit.  Stale docblocks don't just lie — they actively defend the bug against discovery.

### Lesson #3 — Routes that bypass the central Head component are a structural SEO leak

cp112 found that `/[lang]/privacy/+page.svelte` and `/[lang]/privacy/[asset]/+page.svelte` were emitting only bare `<svelte:head>` with title+description, NOT the full `<Head>` component.  Result: those 17 pages (1 index + 16 per-asset × 10 locales = 170 URLs) shipped without canonical URL, hreflang alternates, OG / Twitter cards, robots meta, onion-location, JSON-LD — missing every SEO signal except the absolute minimum.

The gap was structural: `<Head />` is the canonical way, but the SvelteKit template + Svelte 5 conventions don't enforce it.  Nothing prevents a future contributor from writing `<svelte:head><title>...</title></svelte:head>` and bypassing it again.

Considered options:
- (a) Lint rule: forbid `<svelte:head>` in routes.  Too brittle; some legitimate uses exist (the dev/yubikey-probe route).
- (b) Routes-test addition: scan all `+page.svelte` files for `<svelte:head>` without a matching `<Head` import.  Possible but lower-value than (c).
- (c) Just convert the offenders and document the pattern.

cp112 took (c) — converted the two privacy page surfaces; left the dev/yubikey-probe route alone (dev-only, never indexed).  A future cp could add (b) as a smoke if more drift surfaces.

### Lesson #4 — Twitter Card spec is loud about NOT supporting SVG OG images

The Head.svelte comment had already said "Phase 5 adds a PNG fallback for aggregators that don't support SVG OG images (X / Twitter included)" — Phase 5 came and went without shipping the PNG.  cp112 found the same gap by inspection.

Twitter Card spec explicitly rejects SVG.  LinkedIn rejects it inconsistently (sometimes silent failure, sometimes blank preview).  Slack/Discord/Mastodon are mixed.  PNG is the universal format.  **Lesson:** for any image asset where SVG is the source-of-truth but downstream consumers need PNG, ship the PNG alongside and add a freshness smoke (cp112's defense #40) to keep them in sync.

### Lesson #5 — Orphaned i18n keys accumulate when bare `<svelte:head>` is replaced

cp112's conversion of /privacy and /privacy/[asset] from bare svelte:head to the full Head component meant the old `privacy.index_title`, `privacy.index_meta_description`, `privacy.page_title`, `privacy.unknown_asset_title` keys went orphaned (no consumer left).  All four were removed across all 10 locales in the same checkpoint to keep the i18n tree clean.

**Lesson:** Conversion from inline `<title>` / `<meta>` to the Head component should ALWAYS include a sweep for orphaned i18n keys in the same checkpoint.  Otherwise the locale files accumulate dead weight that confuses future contributors ("which key do I use?").

### Lesson #6 — SEO sweep depth: 4 priorities in tension, but mostly aligned

Ken's design priorities (memory) are: privacy > decentralization > grandma-friendliness > tiny footprint.  How did cp112's SEO sweep navigate them?

- **Privacy**: SEO changes ship no third-party trackers, no fingerprinting, no JS-on-load analytics.  All metadata is static + prerendered.  ✓ untouched.
- **Decentralization**: SEO doesn't depend on central services.  hreflang / canonical / sitemap are self-contained.  JSON-LD is plain JSON-in-script.  ✓ untouched.
- **Grandma-friendliness**: SEO is invisible to grandma.  No UX change.  ✓ untouched.
- **Tiny footprint**: +61 KB PNG OG image is the cost.  Lazy-loaded by crawlers / share-preview-fetchers only; never loaded in normal browsing flow.  Net cost to end-users: 0 bytes for normal usage; +61 KB for share-preview crawlers (cheap relative to the share-preview value).  ✓ acceptable.

All 4 priorities preserved; SEO sweep is a net positive across the board.



## CP139 LESSONS

### Lesson #1 — Memory drift can survive even an explicit cp111 lesson about memory drift

cp139 caught the SAME class of bug cp111 Lesson #1 documented: a "standing pre-launch operator action" tracked in memory (rotate `CHANGE_ME_BEFORE_PRODUCTION` in `ops/postgres/init.sql`) was actually already closed.  That string is a DENYLIST entry at lines 58-65 that REJECTS operator deployment when the password is one of the known placeholders — it IS the safety feature, not a placeholder needing rotation.

cp111 Lesson #1 said exactly this for the other two items (package-lock.json + svelte-check in CI).  cp138's handoff explicitly listed `CHANGE_ME_BEFORE_PRODUCTION` as "still remaining" — itself an instance of the same drift class cp111 had documented one checkpoint earlier.  Memory entry #29 now updated to "ALL 3 standing pre-launch operator items are SHIPPED. No standing pre-launch items remain."

**Discipline:** the cp24 reconfirm-memory pattern must include re-reading the linked file every checkpoint, not just the memory string.  A standing fact about file X is not a standing fact — it's a hypothesis to verify against file X, every checkpoint, with `grep` or `view`.

### Lesson #2 — Workspace-by-workspace deep-deep is a viable alternative to phase-by-phase

cp138 walked 11 audit phases (A–K).  cp139 walked 5 workspaces (apps/{matrix-bot,ops-cli,relay,indexer,web}) + 4 packages.  Phase walks naturally bias toward generic-pattern hunting (XSS, SSRF, terminal-escape).  Workspace walks naturally bias toward call-graph completeness (every dispatch site, every wrapper, every consumer).

cp139 found 32 findings (vs cp138's 12).  Six were terminal-escape-class (cp139-C-3/C-4/C-5/C-6/C-7/C-8/etc) that phase walks already covered for the web tier but missed for ops-cli.  Five were related-class bugs cross-applied (cp139-F-1 from cp139-E-1's hypothesis).  This validates the chain-op-handler approach — once you find a bug class, the same class exists in every workspace's parallel implementation.

**Discipline:** future audit campaigns should run BOTH passes: phase walks find the generic bug, workspace walks find every place the generic bug exists.

### Lesson #3 — Pre-launch sentinel battery as multi-pulse stability invariant

cp139 ran 23 pulses across the campaign.  Pulses 14–20 + 22–23 all returned 6076/6076 (pulse 21 caught a real regression — see Lesson #4).  This is the strongest stability signal yet — nine confirmed identical runs across a churning code base (32 findings shipped, ~625 files walked).  No flake, no order-dependence, no warm-up race.

**Discipline:** post-cp139 the stability bar is quintuple-pulse minimum, not triple.  If a campaign can't sustain 5 identical pulses, something is wrong (real flake, or real bug, or new race condition).

### Lesson #4 — Persona walkthrough docs that name sentinels need ALLOWED_PATHS entries

cp139's persona walkthrough doc (`docs/THREE-PERSONA-WALKTHROUGH-cp139.md`) named the placeholder password sentinels in its Sally-operator section explaining the 3-tier denylist defense.  `db-password-placeholder-smoke` correctly tripped on the new doc — it's specifically designed to catch stray placeholder mentions sneaking into the repo.  The smoke worked exactly as intended; the doc author (Claude) failed to anticipate the smoke's reach.

**Discipline:** any new file that legitimately names a sentinel string for closure-narrative purposes must be added to `ALLOWED_PATHS` in `apps/indexer/scripts/db-password-placeholder-smoke.ts` in the same turn.  This is the same class of pattern as cp89's "every new asset registry needs its smoke entry."  The smoke fires correctly; the documentation must adapt to the smoke, not vice versa.

**Meta-lesson:** when Ken pushed back ("you did these tasks too?"), the act of actually doing them surfaced the regression.  This validates Ken's standing rule that claimed-done work must be re-walked against actual artifacts — and proves that the smoke battery itself is the safety net catching documentation discipline failures.

---

## CP111 LESSONS

### Lesson #1 — TARBALL.md handoff section drift is its own real risk

cp110's handoff section listed 5 "still open" pre-launch operator-actions. Three had been closed for many checkpoints (`CHANGE_ME_BEFORE_PRODUCTION` denylisted, `package-lock.json` committed, svelte-kit-sync wired). A fresh chat starting from that tarball would burn an unknown number of turns "fixing" already-fixed items before noticing.

**Discipline going forward:** every checkpoint's TARBALL.md handoff section must be re-verified against actual code/config, not copy-pasted forward. Memory #5 ("docs always in sync") applies to TARBALL.md too — handoff is a doc.

### Lesson #2 — Indirection-through-smoke is real protection but illegible protection

`workspace-typecheck-smoke` has been running `svelte-kit sync && svelte-check` against apps/web in CI since Part 70. Real protection. But the `.forgejo/workflows/ci.yml` surface reads as "three jobs: typecheck / ansible-lint / smokes" with no mention of svelte. An auditor (or me, in this turn) had to dig two levels deep — open `scripts/run-smokes.sh`, find the workspace-typecheck-smoke entry, open `scripts/workspace-typecheck-smoke.ts`, find the `npx svelte-kit sync` line — to confirm the protection existed.

cp111 added an explicit `web-check` job to the CI workflow. The smoke is retained as defense-in-depth (still useful locally + when ci.yml's web-check is misconfigured), but the CI surface itself is now self-documenting.

**Lesson:** when CI does work the audit log claims it does, the WORKFLOW FILE should say so directly. Smoke indirection is correct protection but misses the "legible from outside" property.

### Lesson #3 — Marketing-class docs need parity smokes just like operator-class docs do

The codebase has had `operator-doc-fenced-path-existence-smoke` since cp84 (catches drift in OPERATIONS.md / RUN-A-MORPHIT-NODE.md / PRE-LAUNCH-CHECKLIST.md / etc). Operators following docs hit file-not-found if a path renames silently.

Marketing-class docs (MORPHIT-BRAG-LIST.md, README.md, RELEASE-NOTES) are arguably MORE drift-sensitive: stale claims here directly damage the trust signal a reader uses to decide whether to engage with the project. Counts that go stale ("3,924 scenarios" → 4,432; "10 tradable" → 16; "Seven languages" → 10) are the exact class of false claim Memory #15 forbids — and yet the existing smoke battery didn't cover them.

cp111's `brag-list-claim-parity-smoke` closes that gap. 7 claim classes (file paths / op IDs / env-vars / 4 numeric anchors), each mutation-tested. Floor of 50 scenarios guards against silent regex-broke-and-passes-zero failures. Subset-marker suppression for locale claims (`backlog`, `non-EN`, `native`, etc.) prevents legitimate subset references from false-positive.

### Lesson #4 — Anchor numeric claims by computing canonical, not by hard-coded constant

The natural way to write the brag-list smoke would be: "assert brag list claims 16 assets, 10 locales, 35 ADRs." But that puts THREE places where the asset/locale/ADR count is hard-coded — the canonical source, the brag list claim, AND the smoke. Add an asset and TWO docs go stale; the smoke goes stale silently.

cp111 smoke computes canonical at run-time:
- `countAssetTickers()` parses `packages/asset-registry/src/index.ts`
- `countLocales()` lists `apps/web/src/lib/i18n/locales/*.json`
- `countAdrs()` lists `docs/adr/00*.md` minus the template
- `countBragEntries()` regex-counts numbered entries in the brag list

So the smoke can NEVER go stale relative to code state. Only the brag list / README / release notes go stale; the smoke catches that drift before they ship.

**Lesson:** parity smokes should compute their reference value live from canonical, not from a constant in the smoke. Otherwise the smoke itself becomes a drift surface.

### Lesson #5 — Mutation-test EVERY claim class before declaring a smoke ready

I almost shipped cp111's smoke with the env-var check broken: the original regex was `` /`(MORPHIT_[A-Z][A-Z0-9_]*)`/g `` (backticks both sides, only letters between). The brag list actually quotes env vars as `` `MORPHIT_INDEXER_DISABLED_ASSETS=` `` with a trailing `=`, which the regex didn't match. The smoke passed with 80 scenarios, looked clean — but a deliberate-drift mutation (replacing the env-var name) didn't trip it.

Only the mutation test caught this. Broadened regex to allow optional `=value` shell-assignment suffix; smoke went from 80 to 81 scenarios; all 7 mutation classes now fire as expected.

**Lesson:** "regex matches the right thing" and "regex passes when target is intact" are NOT the same check. Mutation testing (deliberately break each claim type and verify smoke fails with a clean message) is the only way to prove the smoke catches what it claims to catch. Run mutation tests for every NEW claim class before declaring done.

### Lesson #6 — Subset markers in prose are real false-positive risk

Naive locale-count check fired on "across all 6 locales" in brag entry 161 because the regex `(\d+)\s+locales?\b` doesn't know "6" referred to the 6-locale translation-backlog subset mentioned earlier in the same sentence.

Three options considered:
- (a) Hand-allowlist the line — fragile, Memory disagrees with allowlists
- (b) Reduce smoke strictness ("only count claims that match canonical") — admits drift through the gate
- (c) Suppress non-canonical claims when the line contains a subset marker (`backlog`, `non-EN`, `native`, `core`, `community-translation`, etc.)

Picked (c). Same N == CANONICAL claim never gets suppressed (an accurate claim is always treated as canonical). Only fires when N != CANONICAL AND the surrounding line has no subset marker. Real-world: catches "We support 10 locales" when actual count is 11; ignores "across all 6 backlog locales" as a subset reference.



## CP106 LESSONS

### Lesson #1 — paymentMethod.ts Unicode codepoint sanitization mirrors indexer + frontend

`commands/paymentMethod.ts` (492) sanitizes operator-supplied `name` and `description` before broadcasting an `morphit_payment_method_addition_v1` op. The sanitization mirrors the indexer-side handler + frontend registry (parity smoke catches drift):

```typescript
const FORBIDDEN_CODEPOINTS = new Set<number>([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,  // RTL/LTR override + BiDi formatting
  0x2066, 0x2067, 0x2068, 0x2069,          // BiDi isolates
  0x200b, 0x200c, 0x200d,                  // ZWSP, ZWNJ, ZWJ
  0xfeff,                                  // BOM
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064   // word joiner + invisible separators
]);
```

Plus C0/C1 control filter:
```typescript
if (cp >= 0x00 && cp <= 0x1f && cp !== 0x0a && cp !== 0x09) continue;  // C0 except \t/\n
if (cp >= 0x7f && cp <= 0x9f) continue;                                 // C1
```

Same threat as cp103 classifier.ts (Matrix-pill defang + ANSI ESC strip) and cp82 indexer handlers — RTL/BiDi codepoints in display strings can spoof origin, ZWJ-style chars in identifiers can defeat exact-match search, and C0 control chars can clear screen / set window title when displayed via terminal.

Operator gets warned when codepoints are stripped: `⚠ Stripped 3 dangerous codepoint(s) from name.`

### Lesson #2 — paymentMethod.ts reserved-key check is client-side defense-in-depth

```typescript
const RESERVED_CANONICAL_KEYS: ReadonlySet<string> = new Set([
  'pay_btc', 'pay_blurt', 'pay_xmr', 'barter_goods', 'cash', 'precious_metals',
  'airwallex', 'alipay', 'amazon_pay', 'apple_pay', 'bancontact', 'bitso',
  'bizum', 'blik', 'cash_app', 'gcash', 'google_pay', 'ideal', 'interac_etransfer',
  'klarna', 'mpesa', 'mercado_pago', 'mir', 'mtn_momo', 'oxxo_pay', 'payoneer',
  'paypal', 'paytm', 'payu', 'pix', 'przelewy24', 'revolut', 'shebapay',
  'sofort', 'spei', 'square_cash', 'unionpay', 'venmo', 'wechat_pay', 'wise', 'zelle'
]);
```

40 canonical keys. Comment: "Mirrors apps/indexer/src/indexer/handlers/operatorPaymentMethod.ts and apps/web/src/lib/payments/registry.ts. Drift is caught by reserved-keys-parity-smoke."

If the operator tries to add a reserved key, the CLI rejects locally with a helpful error pointing them to the canonical registry. The indexer would also reject (it's the authoritative gate), but client-side rejection saves the chain op + RC and gives a clearer error message.

### Lesson #3 — paymentMethod.ts Audit NEW-9-13 wif='' in finally on BOTH add() AND remove()

Same pattern as cp104 register.ts. Both broadcast paths wrap the broadcast call in try/finally with `wif = ''` in finally. The hardening is consistent across every on-chain broadcaster in the codebase:

- cp104 `commands/register.ts` — operator registration broadcast
- cp106 `commands/paymentMethod.ts` add() — payment-method addition broadcast
- cp106 `commands/paymentMethod.ts` remove() — payment-method removal broadcast

Honest documentation in each: "JS strings are immutable so the original byte sequence may persist in heap memory until GC, but we minimize the variable's lifetime and avoid keeping a live reference past the single use."

### Lesson #4 — edit.ts atomic write via backup → tmp → fsync → rename

`commands/edit.ts` (713) implements robust atomic write:

```typescript
function atomicEnvWrite(path, originalText, updates): AtomicWriteResult {
  // 1. Timestamped backup
  copyFileSync(path, backupPath);
  chmodSync(backupPath, 0o600);

  // 2. Write to tmp + fsync (Audit NEW-9-12)
  writeFileSync(tmpPath, newText, { mode: 0o600, flag: 'w' });
  chmodSync(tmpPath, 0o600);
  const fd = openSync(tmpPath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }

  // 3. Atomic rename
  renameSync(tmpPath, path);
}
```

**Audit NEW-9-12 fsync hardening rationale**:
> "fsync the tmp file before rename so contents are durable on disk. Without this, a power loss between write and rename can leave the renamed file with stale or zero-length contents after reboot. Best-effort — not all filesystems honor fsync semantics (notably some FUSE mounts). Failure here is logged but not fatal: we still rename and let the filesystem do its best."

Honest documentation of fsync's filesystem-dependent behavior. The defense covers POSIX-compliant filesystems and degrades gracefully on FUSE.

If the write fails AFTER the backup is taken, the error message includes "Backup at ${backupPath} is intact." — operator knows recovery is one rename away.

### Lesson #5 — edit.ts tightly-scoped editable keys list enforces allowlist policy

```typescript
const EDITABLE_KEYS = [
  'MORPHIT_INSTANCE_ORIGIN',
  'MORPHIT_INSTANCE_TOR_ADDRESS',
  'MORPHIT_INSTANCE_LOKINET_ADDRESS',
  'MORPHIT_INSTANCE_I2P_ADDRESS',
  'MORPHIT_INSTANCE_NOSTR_PUBKEY',
  'MORPHIT_INSTANCE_SEO_TITLE',
  'MORPHIT_INSTANCE_SEO_DESCRIPTION',
  'MORPHIT_INSTANCE_SEO_KEYWORDS',
  'MORPHIT_INDEXER_RPC_ENDPOINTS'  // morphit.env, tightly-scoped second pass
] as const;
```

The edit command refuses to touch DB URL / account names / posting-key path / fees account — those critical-infra keys are excluded from the operator-config allowlist by design (cp105 lesson #6). The edit command surfaces only the keys it's safe to re-prompt without breaking the chain-binding invariants.

Operators who need to change critical-infra MUST re-run `init` (much heavier ceremony with full system check). This is correct — typoing a fees account name should require maximum-friction recovery, not casual edit.

### Lesson #6 — edit.ts re-uses init/steps.ts validators (single source of truth)

```typescript
import {
  stepAltNetworks,
  stepOrigin,
  stepSeo,
  stepListingFee,
  stepOperatorTag,
  stepRpcEndpoints,
  parseRpcEndpoints,
  DEFAULT_BLURT_RPC_ENDPOINTS,
  ...
} from '../init/steps.ts';
```

The edit command re-uses the same `stepOrigin`/`stepAltNetworks`/`stepSeo`/`stepListingFee`/`stepOperatorTag`/`stepRpcEndpoints` validators that the init wizard uses. A future change to URL validation in `stepOrigin` (e.g., stricter checks) automatically applies to both init AND edit — no parallel paths to keep in sync.

Same pattern as cp104 `init/encrypt.ts` re-exporting from relay's keyEnvelope — single source of truth via re-use, not duplication.

### Lesson #7 — status.ts SQL fully parameterized + parallel dispatch

```typescript
const [indexer, drain, signups, bonuses, loyalty, attestations, recip, related, failed] = await Promise.all([
  ctx.db.query<IndexerStateRow>(`SELECT ... FROM indexer_state WHERE id = 1`),
  ctx.db.query<DrainQueueRow>(`SELECT ... FROM relay_pending_transfers WHERE broadcast_at IS NULL`),
  ctx.db.query<SignupsTodayRow>(`SELECT ... WHERE creator = $1 AND created_block_time >= $2`,
    [ctx.config.relayAccount, midnight]),
  // ... 6 more queries
]);
```

Every parameterized SQL uses `$1`/`$2` placeholders via `pg.Pool.query(text, params)`. No string interpolation into SQL text anywhere across status.ts + the 7 read-only-view commands. Template literals (`${...}`) only used in display strings (human-readable output), never in SQL.

**Promise.all parallel dispatch**: 9 queries fire in parallel. Each is a tiny indexed lookup; serializing would just add latency without saving DB load.

### Lesson #8 — All read-only views follow the same pattern

`abuse.ts` / `flags.ts` / `signups.ts` / `attestations.ts` / `loyalty.ts` / `drainQueue.ts` / `failedBroadcasts.ts` all share the same architecture:

```typescript
1. parseDurationSpec(ctx.flags.since ?? '24h')  // --since=DUR via parseDurationSpec
2. ctx.db.query<RowType>(`SELECT ... WHERE ... >= $1 LIMIT $2`, [cutoffDate, HUMAN_LIMIT])
3. if (ctx.flags.json === 'true') emitJson(rows) else renderHumanTable(rows)
```

**`HUMAN_LIMIT = 50` (or 100 for signups)** on every view bounds memory + readability; --json mode generally also caps. Prevents pulling 100k rows by accident when the operator runs the command on a long-running instance.

### Lesson #9 — db.ts: lazy-import pg + tiny pool + non-crashing error handler

```typescript
// Lazy import so the CLI's `init` subcommand (which doesn't
// touch the DB) works on a fresh checkout where pg hasn't
// been installed yet.
const pgModule = (await import('pg')) as { default: typeof pgType } | typeof pgType;
const pg: typeof pgType = 'default' in pgModule ? pgModule.default : pgModule;

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 2,                          // CLI does handful of queries and exits
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 5_000
});

pool.on('error', (err) => {
  // Surface dropped-connection errors but don't exit — the
  // CLI's main loop catches the eventual query failure and
  // prints a clean error.  Crashing here would skip the
  // per-command error formatting.
  process.stderr.write(`pg pool error: ${err.message}\n`);
});
```

Three design choices:
1. **Lazy import** so init subcommand works on fresh checkout without npm install
2. **max=2 pool** — CLI is short-lived, no reason to hold more connections
3. **Non-crashing error handler** — let main loop's try/catch produce clean per-command error messages instead of bare stack traces

### Lesson #10 — render/term.ts conservative ASCII tags when color off

```typescript
export function glyph(status: Status): string {
  if (!colorEnabled) {
    switch (status) {
      case 'ok': return '[OK]';
      case 'warn': return '[WARN]';
      case 'error': return '[ERR]';
      case 'info': return '[i]';
    }
  }
  switch (status) {
    case 'ok': return fmt.green('✓');
    case 'warn': return fmt.yellow('⚠');
    case 'error': return fmt.red('✗');
    case 'info': return fmt.blue('ℹ');
  }
}
```

Comment: "Uses Unicode when color is on (modern terminal almost-certainly supports UTF-8), ASCII tags when color is off (more conservative — minimal terminals get a more readable plain-ASCII alternative)."

`initColor` honors three signals:
- `Config.color === 'never'` (env or wizard config) → disabled
- `Config.color === 'always'` → enabled
- `Config.color === 'auto'` → `process.stdout.isTTY === true`

Plus the dispatcher (main.ts) reads `--no-color` flag for per-invocation override.

### Lesson #11 — Codebase deep-audit campaign COMPLETE

cp82 opened the deep-deep audit campaign on indexer handlers. cp106 closes it on ops-cli supporting infra. **Every application module in the `apps/*` tree has been deep-audited end-to-end.**

| Phase | Lines | Modules | Findings |
|---|---:|---:|---:|
| Indexer + relay (cp82-cp95) | 25,552 | 99 | 1 |
| Web frontend (cp96-cp102) | 15,579 | 26 | 0 |
| Matrix-bot (cp103) | 2,021 | 8 | 0 |
| Ops-CLI entry + crypto (cp104) | 2,460 | 9 | 0 |
| Ops-CLI init wizard (cp105) | 4,038 | 6 | 0 |
| Ops-CLI commands + infra (cp106) | 2,953 | 15 | 0 |
| **TOTAL** | **52,603** | **163** | **1** |

1 finding (cp93 release.ts JSDoc shape claim) caught + fixed across 163 modules / ~52,603 lines / 25 checkpoints. The deep-deep is signal that the audit is THOROUGH, not that the codebase is buggy — most findings were pre-empted by the audit posture and discipline accumulated over Parts 1-119.

### Lesson #12 — Coverage table for cp106

| Module | Lines | Status | Notes |
|---|---:|---|---|
| `commands/paymentMethod.ts` | 492 | DEEP-AUDITED CLEAN | **Unicode codepoint sanitization** (RTL/BiDi/ZW/BOM/control chars stripped with warn); **reserved canonical key list mirrors indexer + frontend** (40 entries); KEY_RE + length 3-24; VALID_CATEGORIES whitelist; HTTPS URL max 200 chars; **Audit NEW-9-13 `wif=''` in finally on BOTH add() AND remove()**; endpoint rotation; confirm-Y/N before broadcast; lazy DB load for list subcommand |
| `commands/edit.ts` | 713 | DEEP-AUDITED CLEAN | **Atomic write: backup → tmp → fsync → rename**; Audit NEW-9-12 fsync hardening with honest FUSE-degrades-gracefully documentation; tightly-scoped EDITABLE_KEYS enforces allowlist policy; applyUpdates preserves comments/blanks verbatim; re-uses init/steps.ts validators (single source of truth) |
| `commands/status.ts` | 385 | DEEP-AUDITED CLEAN | All SQL parameterized via `$1`/`$2`; Promise.all 9-query parallel dispatch; threshold application via applyThreshold → ok/warn/error glyphs; --json structured-snapshot mode |
| `commands/abuse.ts` | 232 | DEEP-AUDITED CLEAN | Parameterized SQL; HUMAN_LIMIT cap; parseDurationSpec for --since |
| `commands/flags.ts` | 166 | DEEP-AUDITED CLEAN | Parameterized SQL; --type filter (reciprocity\|related); 7d default window |
| `commands/drainQueue.ts` | 163 | DEEP-AUDITED CLEAN | Parameterized SQL; --age filter for "what's stuck"; HUMAN_LIMIT 50 |
| `commands/failedBroadcasts.ts` | 124 | DEEP-AUDITED CLEAN | Parameterized SQL; HUMAN_LIMIT 50; --since 24h default |
| `commands/signups.ts` | 120 | DEEP-AUDITED CLEAN | Parameterized SQL filtered by ctx.config.relayAccount; HUMAN_LIMIT 100; --since 24h default |
| `commands/loyalty.ts` | 120 | DEEP-AUDITED CLEAN | Parameterized SQL; loyalty milestone view |
| `commands/attestations.ts` | 109 | DEEP-AUDITED CLEAN | Parameterized SQL; pending fee-attestation queue view |
| `render/term.ts` | 148 | DEEP-AUDITED CLEAN | ANSI codes hardcoded (no chalk); initColor 3-way (always/never/auto + TTY); **conservative ASCII tags when color off** for minimal terminals; all output via process.stdout/stderr.write |
| `lib/time.ts` | 81 | DEEP-AUDITED CLEAN | Pure functions; UTC-anchored; parseDurationSpec regex `/^(\d+)\s*(s\|m\|h\|d)$/i` |
| `db.ts` | 64 | DEEP-AUDITED CLEAN | **Lazy-import pg** for fresh-checkout init; pool max=2; non-crashing error handler logs to stderr |
| `lib/ctx.ts` | 23 | DEEP-AUDITED CLEAN | CommandCtx interface centralizes shape every subcommand takes |
| `render/json.ts` | 13 | DEEP-AUDITED CLEAN | Single `emitJson` function — `JSON.stringify(value) + '\n'` |

Total cp106: ~2,953 lines walked across 15 modules, 0 findings.

## CP106 STATE

| Metric | Value | Note |
|---|---|---|
| Scenarios PASS | 4432 | unchanged (audit-only) |
| Runners FAILED | 0 | unchanged |
| Workspaces TS-clean (LL #52) | 7/7 | **41st consecutive HW-verified** unchanged |
| Vitest tests passing | 1,381 | unchanged |
| Structural defenses | 37 | unchanged |
| Locale parity | 2,827 × 10 = 28,270 | unchanged |
| Brag entries | 304 | unchanged |
| Lines of code deep-audited cumulative | **~52,603** (163 modules / 1 finding / 25 checkpoints) | **CODEBASE END-TO-END DEEP-AUDIT COMPLETE** |

## CP106 FIXES

None — cp106 was an ops-cli commands + supporting infra audit.  0 findings across 15 modules / 2,953 lines.



### Lesson #1 — prompt.ts askPassword raw-mode TTY handling

`askPassword` implements masked password input via raw-mode + character-by-character read (node:readline doesn't natively mask). Three control-char defenses:

- **0x03 (Ctrl+C)** → write newline + cleanup + `process.exit(130)` (SIGINT convention; operator can bail without confusing stack trace)
- **0x04 (Ctrl+D / EOT)** → newline + cleanup + resolve('') (treat as cancel; caller decides what empty means)
- **0x7f / 0x08 (backspace)** → slice off last char + `\b \b` echo (move-back, overwrite-with-space, move-back)
- **<0x20** (other control chars) → silently ignore (don't add to buffer)
- **printable** → buffer += ch, echo `*`

Cleanup function restores raw-mode AND paused state on exit/cancel. Idempotent guard `stdin.setRawMode?.(...)` — works in non-TTY environments where setRawMode is undefined.

### Lesson #2 — chainCheck.ts validateBlurtAccountName matches chain validator exactly

```typescript
if (name.length < 3) return { ok: false, message: '...' };
if (name.length > 16) ...
if (!/^[a-z]/.test(name)) ...           // must start with letter
if (!/^[a-z0-9-]+$/.test(name)) ...     // alphanumeric + dashes only
if (name.includes('--')) ...            // no consecutive dashes
if (name.endsWith('-')) ...             // no trailing dash
```

Matches the on-chain account-name regex exactly. Catches typos client-side before they cause confusing "account doesn't exist" errors at relay startup. Comment: "Same rules as the chain."

### Lesson #3 — explorerHealth.ts never sends user data through probes

Critical posture documented at top of file:

> "The probes do NOT send any real txids, addresses, proofs, or other user data. They send well-formed harmless requests using deliberately-incorrect test inputs and accept any structured response (even an 'error') as 'API-shape ok.' This is intentional: we want to know 'does this URL speak the expected API surface' not 'is any specific transaction valid.'"

Concrete:
- BTC probe: GET `/blocks/tip/height` (public network height, not a tx detail)
- XMR probe: GET `/api/networkinfo` (public network info, not a tx)
- Chat-link probe: HEAD root (no txid passed; the template's `{txid}` placeholder is replaced with `000...` zeros if we did construct a full URL, but we only probe the root)

Shape validators:
- BTC: response text must match `/^\d{1,12}$/` (Esplora's plain-integer block height)
- XMR: response JSON must have `status` + `data.height` keys (onion-monero-blockchain-explorer surface)
- chat-link: HEAD status must be `<500` (many explorers respond 405 to HEAD; can't distinguish "broken" from "deliberate-no-HEAD" without GET)

Best-effort: probe failures don't block wizard. Comment: "the operator might be configuring an explorer that's not online yet, or running the wizard offline."

### Lesson #4 — systemCheck.ts cp70-D1 strict numeric port parse

```typescript
const portRaw = process.env.MORPHIT_OPS_PG_PORT ?? '5432';
// Strict numeric parse — parseInt() accepts trailing garbage like
// "5432abc"; better to fail-fast with a clear message than connect
// to whatever the partial parse landed on.  cp70-D1 lesson.
const port = /^\d+$/.test(portRaw) ? Number(portRaw) : NaN;
if (!Number.isFinite(port) || port < 1 || port > 65535) {
  return { /* error */ };
}
```

Critical lesson from cp70: `parseInt("5432abc", 10) === 5432` — accepts trailing garbage. If operator pastes a partial copy-paste like `5432abc`, parseInt would succeed and the system would try to connect to port 5432 (which might be the wrong port, or a different service). Better: strict regex check then `Number()` conversion, fail-fast with clear error.

### Lesson #5 — systemCheck.ts SSH check parses sshd_config.d correctly

`/etc/ssh/sshd_config.d/*.conf` entries override `/etc/ssh/sshd_config`; sshd reads them in alphabetical order. The check mirrors that exactly:

```typescript
checkFile(main);
// sshd_config.d entries override main; sshd reads them in alphabetical order.
const entries = execSync(`ls -1 ${dir}/*.conf 2>/dev/null`, ...)
  .split('\n').filter(s => s.length > 0).sort();
for (const e of entries) checkFile(e);
```

Last-matching `PasswordAuthentication` directive wins (matches real sshd behavior). Default is `yes` (insecure) if unspecified — same as actual sshd default. **Critical**: an operator-only-modified file in `sshd_config.d/` would override the main file's setting, and the check must respect that.

Uses wrapper object `{ lastValue: string | null }` instead of bare `let lastValue` because TS can't track closure mutations through the `checkFile` callback.

### Lesson #6 — render.ts three-file split with allowlist policy enforcement

```
1. morphit.config.env  →  operator-tunable (allowlisted by @morphit/operator-config)
2. morphit.env         →  critical infrastructure (DB URL, relay account, posting-key path)
3. apps/relay/keystore.{wif,json}  →  posting key itself
```

**Allowlist policy split is intentional**, documented in render.ts header:

> "Critical-infra values are deliberately excluded from the allowlist because typo'ing them causes data corruption (e.g., wrong fees account = fees flow to nowhere). The operator's deployment automation should set those via OS env, where typos are caught by integration tests rather than discovered when fees go missing."

The wizard generates a separate `morphit.env` file for first-time convenience, but the policy boundary is preserved: critical-infra values come from OS env (set by deployment automation), not from the allowlisted config file. Defense against operator typos turning into data corruption.

All three files written with mode 0o600 + chmodSync 0o600 **belt-and-braces**.

### Lesson #7 — render.ts quote() helper safe-char shortcut

```typescript
function quote(value: string): string {
  if (value === '') return '""';
  if (/^[A-Za-z0-9._\/:@-]+$/.test(value)) {
    // Safe characters — no quoting needed.
    return value;
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}
```

Safe-char regex is conservative: only ASCII alphanumeric + a handful of punctuation that's safe in env-file syntax. Anything else gets quoted and escaped (`\` → `\\`, `"` → `\"`). Pattern is robust against ANY value the wizard might collect, including user-supplied free-form text (instance tagline, SEO override, etc.).

### Lesson #8 — steps.ts WIF regex matches Blurt's WIF format

```typescript
if (!/^5[1-9A-HJ-NP-Za-km-z]{50}$/.test(wif)) {
  console.log("✗ Doesn't look like a valid WIF...");
}
```

Format breakdown:
- Starts with `5` (Blurt WIF version byte's Base58 encoding)
- Followed by 50 chars in Base58 alphabet
- Base58 excludes `0`, `O`, `I`, `l` to avoid visual confusion → `[1-9A-HJ-NP-Za-km-z]`
- Total length exactly 51 chars

**Pubkey-vs-chain match check NOT done here**: comment explicit "we don't verify against @relayAccount's posting pubkey here — that requires deriving the pubkey from the WIF, which would couple ops-cli to dblurt. The relay's startup unlock performs the pubkey-on-chain match check instead." Right tradeoff — wizard does shape check; relay does authoritative check at first start.

### Lesson #9 — steps.ts stepMatrixSurfaces TWO layers of @ vs # defense

The matrix-bot subsystem (cp103) had multi-layer @ vs # enforcement at config.ts; the wizard input layer adds another:

```typescript
// Layer 1: parseMxid / parseRoomAlias (regex + shape validation)
const parsed = parseMxid(v);
if (parsed === null) {
  console.log('✗ Not a valid MXID. Must start with @ ...');
  continue;
}
// Layer 2: explicit prefix check with helpful "what you probably meant" message
if (v.startsWith('#')) {  // for MXID prompt
  console.log('✗ That looks like a room alias (#room:server), not an MXID. ...');
  continue;
}
// And vice versa for the room-alias prompt:
if (v.startsWith('@')) {  // for room alias prompt
  console.log('✗ That looks like an MXID (@user:server), not a room alias. ...');
  continue;
}
```

Comment: "Defense in depth — if a copy-paste accidentally produced a room alias starting with #, reject explicitly. The regex above already excludes this but a clearer error helps the operator notice the mistake."

The wizard step also prints an importance reminder before either prompt:

> "IMPORTANT: keep these two SEPARATE. The MXID is private, the room alias is public. Routing a security alert to a public room would be a privacy violation, which is why the bot validates the @ vs # prefix at startup and the frontend only exposes the room (never the MXID) via the public /v1/instance API."

End-to-end the @ vs # distinction is enforced:
1. Wizard input (cp105) — TWO layers: parseMxid + explicit prefix check
2. Wizard input (cp105) — TWO layers: parseRoomAlias + explicit prefix check
3. matrix-bot config.ts (cp103) — rejects #-prefix BEFORE parseMxid
4. matrix-bot matrix.ts (cp103) — sendDm signature accepts only MatrixMxid (branded type)
5. matrix-bot dispatcher (cp103) — DM room cache keyed on MatrixMxid

5 layers. The footgun is non-trivial to trigger.

### Lesson #10 — steps.ts stepOrigin URL strict validation

```typescript
let parsed = new URL(v);
if (parsed.protocol !== 'https:') ...
if (parsed.username !== '' || parsed.password !== '') ...
if (parsed.pathname !== '/' && parsed.pathname !== '') ...
if (parsed.search !== '') ...
if (parsed.hash !== '') ...
return `${parsed.protocol}//${parsed.host}`;  // normalize: drop trailing /
```

Strict origin shape: HTTPS only, no `user:pass@`, no path beyond `/`, no query string, no fragment. Normalized output drops the trailing slash that URL parser appends. Output goes on-chain in operator-register op AND is published in /v1/instance — strict validation prevents weird origins from being federated.

### Lesson #11 — steps.ts parseChatLinkTemplate two-step URL validation

```typescript
if (!trimmed.startsWith('https://')) return 'Template must start with https://';
if (!trimmed.includes('{txid}')) return "Template must contain the placeholder '{txid}'";
const filled = trimmed.replace(/\{txid\}/g, '0000...0000');  // 64-zero sample
try {
  const parsed = new URL(filled);
  if (parsed.protocol !== 'https:') return '...';
  if (parsed.username !== '' || parsed.password !== '') return '...';
} catch {
  return 'Template does not parse as a URL after {txid} substitution';
}
```

Two-step: first check the literal template starts `https://` and contains `{txid}`; then substitute zeros for txid and check the result parses as a URL. The zero-substitution is a smoke test to catch templates where `{txid}` is in a position that would break URL parsing (e.g., template authors might accidentally put `{txid}` in the scheme or host).

Same posture as cp101 explorerHealth.ts chat-link probe (which uses the same zero-substitution).

### Lesson #12 — Coverage table for cp105

| Module | Lines | Status | Notes |
|---|---:|---|---|
| `init/prompt.ts` | 227 | DEEP-AUDITED CLEAN | askPassword raw-mode handles Ctrl+C(0x03)→exit 130, Ctrl+D(0x04)→cancel, backspace(0x7f/0x08), `<0x20` filter; cleanup restores raw-mode + paused state; ask/askInt/askFloat with NaN+Number.isFinite guards |
| `init/chainCheck.ts` | 130 | DEEP-AUDITED CLEAN | 4-endpoint rotation with 5s AbortController; null on empty array (no-such-account); validateBlurtAccountName matches chain validator exactly (3-16 chars, starts-with-letter, no `--`, no trailing `-`) |
| `init/explorerHealth.ts` | 227 | DEEP-AUDITED CLEAN | **Never sends user data**: harmless test inputs only; BTC `/blocks/tip/height` numeric check; XMR `/api/networkinfo` shape check; chat-link HEAD root accepts <500; 5s timeout per probe; best-effort fail-soft |
| `init/systemCheck.ts` | 768 | DEEP-AUDITED CLEAN | 17 checks (CPU/RAM/disk/Node/OS/systemd/postgres/HTTPS/time/unattended-upgrades/ufw/SSH/fail2ban/journald); **cp70-D1 strict port parse** (no parseInt trailing garbage); **system time check** HEAD google.com Date header + round-trip half-time; **SSH check parses sshd_config.d/*.conf in alphabetical order** (matches real sshd); Postgres socket cleanup with removeAllListeners; all checks fail-soft |
| `init/render.ts` | 724 | DEEP-AUDITED CLEAN | **Three-file split**: morphit.config.env (allowlisted) + morphit.env (critical infra) + keystore (posting key); **allowlist policy split prevents typo→corruption**; all three mode 0o600 + chmodSync belt-and-braces; quote() safe-char shortcut for env-file values; chain ID hardcoded as Blurt mainnet with testnet operator instructions |
| `init/steps.ts` | 1,964 | DEEP-AUDITED CLEAN | 18 wizard steps + Coingecko price fetch + URL validators; **WIF regex `/^5[1-9A-HJ-NP-Za-km-z]{50}$/` matches Blurt's Base58 format**; passphrase prompted twice with mismatch rejection; **stepMatrixSurfaces TWO layers @ vs # defense** (parseMxid + explicit prefix check with helpful message); stepOrigin strict URL validation (https, no user:pass@, no path/query/fragment); parseChatLinkTemplate two-step (literal check + URL-parse after zero substitution); Coingecko fetch with graceful fallback |

Total cp105: ~4,038 lines walked across 6 modules, 0 findings.

### Lesson #13 — Whole-codebase audit progress

After cp105, only ~1,000 lines of ops-cli remain (commands/{edit,paymentMethod,status,abuse,flags,signups,attestations,drainQueue,failedBroadcasts,loyalty}.ts + db.ts + render/* + lib/{time,ctx}.ts).

| Phase | Lines | Modules | Findings |
|---|---:|---:|---:|
| Indexer + relay (cp82-cp95) | 25,552 | 99 | 1 |
| Web frontend (cp96-cp102) | 15,579 | 26 | 0 |
| Matrix-bot (cp103) | 2,021 | 8 | 0 |
| Ops-CLI entry + crypto (cp104) | 2,460 | 9 | 0 |
| Ops-CLI init wizard (cp105) | 4,038 | 6 | 0 |
| **Total walked so far** | **49,650** | **148** | **1** |

## CP105 STATE

| Metric | Value | Note |
|---|---|---|
| Scenarios PASS | 4432 | unchanged (audit-only) |
| Runners FAILED | 0 | unchanged |
| Workspaces TS-clean (LL #52) | 7/7 | **41st consecutive HW-verified** unchanged |
| Vitest tests passing | 1,381 | unchanged |
| Structural defenses | 37 | unchanged |
| Locale parity | 2,827 × 10 = 28,270 | unchanged |
| Brag entries | 304 | unchanged |
| Lines of code deep-audited cumulative | ~49,650 | (full breakdown in coverage table above) |

## CP105 FIXES

None — cp105 was an ops-cli init wizard audit.  0 findings across 6 modules / 4,038 lines.



### Lesson #1 — ops-cli is huge (9,449 lines / 30 modules); split across multiple cp

cp104 walks the highest-security surfaces:
- `main.ts` (389) — entry point + command dispatch
- `config.ts` (161) — config loading
- `init/encrypt.ts` (41) — passphrase wrap delegated to relay's keyEnvelope
- `init/altKeystore.ts` (207) — alt-network key envelope
- `commands/importAltnetKey.ts` (191) — encrypt + store altnet key
- `commands/exportAltnetKey.ts` (141) — decrypt + emit altnet key
- `commands/register.ts` (332) — operator registration on-chain
- `commands/upgrade.ts` (481) — release upgrade with SHA-256 verify
- `commands/init.ts` (517) — first-time setup wizard (partial — init/steps.ts deferred)

Remaining for cp105+:
- `init/steps.ts` (1,963) — the 18-step wizard logic
- `init/systemCheck.ts` (768) — CPU/RAM/disk/OS preflight
- `init/render.ts` (723) — config file rendering
- `init/prompt.ts` (227) — readline wrapper
- `init/explorerHealth.ts` (227)
- `init/chainCheck.ts`
- `commands/edit.ts` (713) — config editor
- `commands/paymentMethod.ts` (492) — ADR-0021 payment-method additions
- `commands/status.ts` (385) — operator dashboard
- `commands/{abuse,flags,signups,attestations,drainQueue,failedBroadcasts,loyalty}.ts` — read-only views
- `db.ts`, `render/*`, `lib/{time,ctx}.ts` — supporting infra

### Lesson #2 — main.ts dispatch order isolates first-time-setup from DB

`main.ts` runs init/register/payment-method/edit/import-altnet-key/export-altnet-key/upgrade BEFORE `loadConfig`. Comment is explicit: "`init` runs BEFORE loadConfig — it's the wizard that produces the config file in the first place, so requiring MORPHIT_OPS_DATABASE_URL etc. would be a chicken-and-egg problem."

Exit codes:
- 0 = ok / up-to-date
- 1 = usage error / newer release available in --check-only / declined to overwrite
- 2 = config load error (DATABASE_URL missing)
- 3 = runtime error during command execution
- 4 = upgrade rollback failed too (operator intervention needed)
- 5 = upgrade preflight failed (network, permissions, missing assets)
- 127 = last-resort fatal at boot

Last-resort handler at boot for escaped promise rejections — `main().catch((err) => process.exit(127))`.

### Lesson #3 — init/encrypt.ts uses single source of truth via re-export

```typescript
export {
  encryptEnvelope,
  KEY_ENVELOPE_VERSION,
  type KeyEnvelope
} from '../../../relay/src/crypto/keyEnvelope.ts';
```

The CLI **delegates** to the relay's existing keyEnvelope module. Quote: "Whatever this produces, the relay's `unlockActiveKey()` at startup will be able to decrypt with the same passphrase." Avoids dual-implementation drift — a change to the envelope format in either place affects both because there's only one place to change.

`checkPassphraseStrength` enforces 8-char minimum (matches envelope's internal enforcement) and recommends 12+ chars or multi-word passphrase. Friendly UX layered on top of the cryptographic floor.

### Lesson #4 — init/altKeystore.ts per-network AAD binding is the cross-network swap defense

The single most important defense in altKeystore.ts:

```typescript
function buildAad(version: number, purpose: string, network: AltNetwork): Buffer {
  return Buffer.from(`v${version}/${purpose}/${network}`);
}
```

AES-GCM Additional Authenticated Data includes the network. Comment: "An attacker who obtains all three keystores cannot swap their contents — GCM auth-fail rejects a ciphertext decrypted under the wrong network's AAD."

Concrete attack the defense blocks: attacker exfiltrates `tor-key.json`, `lokinet-key.json`, `i2p-key.json`. Without AAD binding, they could rename `tor-key.json` → `i2p-key.json` and trick the operator into decrypting it as their I2P key. With AAD binding, the decrypt step requires the AAD to match — renaming the file doesn't change the JSON's `network` field, and using a different AAD in decrypt causes auth-tag verification to fail.

`exportAltnetKey.ts` adds belt-and-braces: refuses to decrypt if `envelope.network !== requested` BEFORE calling decryptAltKey. "Refusing to decrypt — likely a misnamed file" — friendly UX for the same defense.

### Lesson #5 — altKeystore.ts envelope namespace prevents cross-decrypt

```typescript
purpose: 'morphit-altnet-key'  // distinct from posting-key envelope's purpose
```

The altKeystore uses a different `purpose` field from the posting-key envelope. Comment: "Distinct version namespace from the posting-key envelope (`v: 1`) so a future change to either doesn't accidentally cross-decrypt. We start at 1; if we ever bump, both must stay distinguishable."

Same envelope version number space but different purpose strings means:
- Wrong-envelope-type detection happens at the validation layer (envelope.purpose !== 'morphit-altnet-key' → throw)
- Wrong-network detection happens at the AES-GCM AAD layer (auth-fail)

Two-layer defense.

### Lesson #6 — altKeystore.ts wipe-on-error in decryptAltKey

```typescript
let plaintext: Buffer;
try {
  plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
} catch {
  key.fill(0);
  throw new AltKeyEnvelopeError(...);
}

key.fill(0);
return plaintext;
```

Key buffer wiped on BOTH happy path AND error path. Same posture as cp96 keystore.ts and cp101 wrap.ts. Hygiene, not correctness (JS doesn't guarantee zeros survive to OS page), but minimizes lifetime of the derived key buffer.

The generic decryption-failed error message ("wrong passphrase, corrupted file, or wrong network binding") is deliberate — doesn't tell attacker which gate failed. Same posture as PubPin generic-rejection-to-user / detailed-to-console split.

### Lesson #7 — importAltnetKey.ts file mode + backup + plaintext wipe

Three defenses on the write path:

```typescript
mkdirSync(altDir, { recursive: true });
chmodSync(altDir, 0o700);  // directory: only operator can list
```

```typescript
writeFileSync(outPath, JSON.stringify(envelope, null, 2), {
  mode: 0o600  // file: only operator can read
});
chmodSync(outPath, 0o600);  // belt-and-braces in case of umask weirdness
```

**Belt-and-braces**: `writeFileSync` with `mode` option sets at create; `chmodSync` ensures the mode even if umask differs or the file pre-existed. The redundant chmod is intentional defensive coding.

**Backup before overwrite**: timestamp-suffixed `bak-${Date.now()}` with mode 0o600 as well. Operator who imports a wrong key can still recover the previous keystore.

**`plaintext.fill(0)` after encryption**: best-effort wipe of the plaintext Buffer (Node Buffer is a Uint8Array view; `.fill(0)` zeros the underlying bytes). JS doesn't have secure-erase guarantees but minimizes the window.

**Passphrase confirmation prompt** with mismatch rejection — prevents typo-locking the keystore.

**Empty plaintext rejected** with friendly error.

### Lesson #8 — exportAltnetKey.ts separates STDOUT (binary) from STDERR (prompts)

```typescript
writeStderr(`Enter relay passphrase to decrypt ${net} key:\n`);
const passphrase = await askPassword('Passphrase');
// ...
if (outPath) {
  writeFileSync(outAbs, plaintext, { mode: 0o600 });
  // ...
} else {
  // Stdout — binary-safe.  Use process.stdout.write rather than console.log
  // (the latter would utf-8-encode and mutilate binary data).
  process.stdout.write(plaintext);
}
```

Critical separation:
- **Prompts + status → STDERR**: keep STDOUT clean for piping
- **Binary plaintext → STDOUT via `process.stdout.write`**: NOT `console.log` (which would `utf-8-encode and mutilate binary data`)
- **Plaintext wiped after write** via `plaintext.fill(0)` on both success AND error paths

This enables shell composition: `morphit-ops export-altnet-key --network=tor | tor-daemon --key-from-stdin` works correctly because STDOUT is pure binary.

Documented use-case: write to `/dev/shm/morphit-tor-key`, start daemon, delete the tmpfs file. "Operators on a privacy-conscious system should prefer tmpfs (`/dev/shm`, `/run/user/<uid>`) so the plaintext never touches persistent disk."

### Lesson #9 — register.ts Audit NEW-9-13 wif clears even on error

```typescript
let result: { block_num: number; trx_id: string };
try {
  result = await broadcastRegister({ account, wif, ... });
} catch (err) {
  // ... error handling
  return 1;
} finally {
  wif = '';
}
```

**Audit NEW-9-13 hardening** ensures `wif` (plaintext WIF posting key string) clears even on error path. Documentation is honest: "JS strings are immutable; reassignment minimizes lifetime of the reference even if the underlying memory persists until GC."

This is the right kind of defensive coding: not pretending to have secure-erase (impossible in JS), but reducing the window during which the GC could see the WIF as live. After `wif = ''`, the only reference to the original WIF string is whatever the broadcastRegister code held internally during the broadcast, which has now returned.

Same posture as cp96 chat/crypto's ephPriv wipe (Audit 2-12 try/finally) and cp101 wrap.ts HMAC + wrapKey wipe.

### Lesson #10 — upgrade.ts SHA-256 verify chain is documented openly

`commands/upgrade.ts` documents what it does AND does NOT do:

**Does NOT**:
- GPG tag-signature verify — relies on CI's tag-signature verification before tarball build. Operators who want belt-and-braces can `git clone && git tag -v vX.Y.Z` themselves.
- Schema migrations — runMigrations[] is the indexer's responsibility at start.
- Cross-major upgrades — assumes same major (v1.x → v1.y); major-version upgrades may have manual steps.

**Does**:
- 30s fetch timeout for Forgejo (`UPGRADE_FETCH_TIMEOUT_MS`)
- Download tarball + sha256 file separately
- Parse `<hex>  <filename>` sha256sum format with strict regex
- Compute sha256 of downloaded tarball; refuse on mismatch ("tampered with in transit, or the SHA file is stale")
- Atomic rename for backup: `renameSync(installDir → ${installDir}.bak-${Date.now()})`
- Rollback on ANY failure (extract / npm ci / service restart) via two-step (rm partial extract, rename backup back, restart services)
- Exit code 4 for "rollback failed too" with manual-intervention instructions
- Service skip if not active (`systemctl is-active --quiet`)
- Prune old backups (keep MORPHIT_BACKUP_KEEP=3 by default)
- Asset filter: `name.endsWith('.tar.gz') && !name.endsWith('.sha256.tar.gz')` — defends against filename-collision attacks where an attacker might publish a `something.sha256.tar.gz` to confuse the picker

Honest documentation of tradeoffs is the right posture for security-critical tooling. The "what we don't do AND why" section is sometimes more important than the "what we do" section.

### Lesson #11 — Coverage table for cp104

| Module | Lines | Status | Notes |
|---|---:|---|---|
| `main.ts` | 389 | DEEP-AUDITED CLEAN | Tiny arg parser with VALUE_FLAGS whitelist; dispatch order isolates init/register/upgrade from DB; exit codes 0/1/2/3/4/5/127; last-resort fatal handler at boot |
| `config.ts` | 161 | DEEP-AUDITED CLEAN | 3-candidate env var lookup for DATABASE_URL; envInt with explicit NaN check; direction-of-goodness type for thresholds; color mode auto/always/never with NO_COLOR respect |
| `init/encrypt.ts` | 41 | DEEP-AUDITED CLEAN | **Single source of truth via re-export** from relay's keyEnvelope; v1 = scrypt N=2^17 + AES-256-GCM; checkPassphraseStrength 8-char floor + 12+ char recommendation |
| `init/altKeystore.ts` | 207 | DEEP-AUDITED CLEAN | **Per-network AAD binding** is cross-network swap defense (`v${v}/${purpose}/${network}`); **distinct envelope namespace** prevents cross-decrypt with posting-key envelope; **key wipe on BOTH happy path AND error path**; scrypt N=2^17 r=8 p=1; ciphertext length sanity check; generic decryption-failed error message |
| `commands/importAltnetKey.ts` | 191 | DEEP-AUDITED CLEAN | Tor v3 size hint (96 bytes); backup before overwrite (`bak-${Date.now()}`); **mkdir 0o700 + writeFileSync mode 0o600 + chmodSync 0o600 belt-and-braces**; `plaintext.fill(0)` after encryption; passphrase confirmation prompt twice; empty plaintext rejection |
| `commands/exportAltnetKey.ts` | 141 | DEEP-AUDITED CLEAN | **Prompts → STDERR, binary plaintext → STDOUT via process.stdout.write (not console.log)**; network mismatch refusal (friendly UX counterpart to AAD defense); `plaintext.fill(0)` on both success and error paths; documents tmpfs paths (/dev/shm, /run/user/<uid>) |
| `commands/register.ts` | 332 | DEEP-AUDITED CLEAN | **Audit NEW-9-13**: try/finally so wif='' even on error; idempotent at chain level (handler rejects account_already_registered); lazy-import dblurt; endpoint rotation over 4 Blurt RPC; sluggifyTag with [a-z0-9._-] + dedupe + 64-char cap; plaintext-vs-encrypted heuristic via raw.startsWith('{') |
| `commands/upgrade.ts` | 481 | DEEP-AUDITED CLEAN | **SHA-256 verify before extract** (refuse on mismatch with "tampered with in transit" message); 30s AbortController timeout; atomic rename for backup; rollback on ANY failure (extract / npm ci / service restart) with exit code 4 for rollback-failed-too; pruneOldBackups keeps 3; asset filter defends against `*.sha256.tar.gz` filename-collision; **honest documentation of what it does NOT do** (GPG tag-sig verify deferred to CI chain) |
| `commands/init.ts` | 517 (partial walk — init/steps.ts deferred) | DEEP-AUDITED CLEAN at command-orchestrator level | System check → 18 prompts → review → write config + env + keystore; **maskDatabasePassword(url)** before review printing; existing-config detection with timestamped backup; check-only mode for preflight |

Total cp104: ~2,460 lines walked across 9 modules, 0 findings.

### Lesson #12 — Whole-codebase audit is now ~98% complete

ops-cli is the LAST application surface in the Morphit codebase. After cp105+ closes it, every line of every app/* will have been walked end-to-end. Current state:

| Phase | Lines | Modules | Findings |
|---|---:|---:|---:|
| Indexer + relay (cp82-cp95) | 25,552 | 99 | 1 |
| Web frontend (cp96-cp102) | 15,579 | 26 | 0 |
| Matrix-bot (cp103) | 2,021 | 8 | 0 |
| Ops-CLI partial (cp104) | 2,460 | 9 | 0 |
| **Total walked so far** | **45,612** | **142** | **1** |

Remaining ops-cli (~5,000 lines / 18 modules) at cp105+.

## CP104 STATE

| Metric | Value | Note |
|---|---|---|
| Scenarios PASS | 4432 | unchanged (audit-only) |
| Runners FAILED | 0 | unchanged |
| Workspaces TS-clean (LL #52) | 7/7 | **41st consecutive HW-verified** unchanged |
| Vitest tests passing | 1,381 | unchanged |
| Structural defenses | 37 | unchanged |
| Locale parity | 2,827 × 10 = 28,270 | unchanged |
| Brag entries | 304 | unchanged |
| Lines of code deep-audited cumulative | ~45,612 | cp82+cp85 handlers (5,266) + cp86 supporting (3,056) + cp87 indexer API (3,173) + cp88 relay (3,048) + cp89 relay client+config+drainer (1,914) + cp90 poller+federationProbe+signals (1,830) + cp91 web push (1,064) + cp92 indexer auxiliary scanners (1,645) + cp93 remaining indexer API (3,668) + cp94 fee verifiers+breaker (1,275) + cp95 streaming+auth endpoints (1,613) + cp96 web frontend crypto+auth (3,503) + cp97 web frontend pairing+identity+release-validate (2,061) + cp98 web frontend chat MITM-defense (1,787) + cp99 web frontend chat payload core (2,310) + cp100 web frontend chat orchestrator (1,201) + cp101 yubikey transport + identicon (1,429) + cp102 HTTP clients + endpoint rotator (1,288) + cp103 matrix-bot subsystem (2,021) + cp104 ops-cli entry + crypto-touching commands (2,460) |

## CP104 FIXES

None — cp104 was an ops-cli entry + crypto-touching commands audit.  0 findings across 9 modules / 2,460 lines.



### Lesson #1 — config.ts enforces @user:server vs #room:server at multiple layers

The matrix-bot is the single most-sensitive surface for the `@user:server` (DM, private, used for security disclosure) vs `#room:server` (room alias, public chat) distinction. Routing a security alert intended for an operator's private DM into a public room would be a serious privacy regression.

`config.ts` (144) enforces the distinction in three layers:

1. **Explicit pre-check**: `if (raw.startsWith('#'))` BEFORE calling `parseMxid`, with an actionable error message that explains the footgun AND points the operator to `MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM` (the indexer's public-contact-room env var) if they confused the two.
2. **Branded `MatrixMxid` type** from `@morphit/operator-config` — once parsed, the value carries a brand that the type system uses to prevent it from being passed anywhere expecting a `MatrixRoomAlias` or vice versa.
3. **`parseMxid` itself** would also reject `#`-prefixed input. The explicit pre-check is defense-in-depth + helpful error UX.

Quote from the error message: "Routing alerts to a public room would be a privacy violation." This is the kind of in-code documentation that survives even if memory rules drift.

### Lesson #2 — Type-level enforcement extends through matrix.ts

`matrix.ts` (100) consumes `MatrixMxid` (branded) only:

```typescript
sendDm(to: MatrixMxid, body: { plain: string; html: string }): Promise<void>;
```

A code path holding a `MatrixRoomAlias` cannot accidentally pass it through type system. The DM-room cache (`Map<MatrixMxid, string>`) is also keyed on the branded type. `dms.getOrCreateDm` from matrix-bot-sdk handles E2E crypto setup for the private 2-person room.

`createDryRunSender` provides a drop-in replacement for staging mode + tests — logs what would have been sent instead of actually delivering.

### Lesson #3 — Opt-in gate in main.ts prevents unexpected operator activity

`main.ts` (158) opens with an opt-in gate:

```typescript
const rawMxid = (process.env.MORPHIT_MATRIX_BOT_ALERT_MXID ?? '').trim();
if (rawMxid === '') {
  console.log('... exits cleanly because no Matrix surfaces are configured ...');
  process.exit(0);
}
```

This runs BEFORE `parseConfig()`, so:
- Operators who enable the systemd unit but don't use Matrix get a clean exit (not a crash)
- The error log gives clear pointer to MORPHIT_MATRIX_BOT_ALERT_MXID + MORPHIT_MATRIX_BOT_ACCESS_TOKEN + the OPERATIONS.md §16 documentation

The default systemd unit can therefore be safely enabled without forcing Matrix configuration. The bot does nothing until the operator opts in explicitly.

### Lesson #4 — Three-tier policy is the source-of-truth for what wakes operator at 3 AM

`classifier.ts` (1,136) implements the policy:

- **CRITICAL**: deliver immediately, NO rate limit, NO aggregation. Bypasses rate limiter entirely. Every recipient gets it.
- **WARN**: rate-limited (1/hour per category). Suppression counted for daily digest.
- **INFO**: aggregated into daily digest at configured UTC time.

CRITICAL examples: kill-switch activated, balance ≤ 0, signup ceiling reached, RAID array failed, kernel panic, OOM kill, hardware error, segfault in morphit, AIDE integrity violation, fee-verifier invariant violation, cert expiry critical, RPC sustained failure (alerting is BLIND), disk/mem/swap critical thresholds, smartctl SMART failed, etc.

The classifier is the policy doc; changing it requires updating classifier-smoke in the same commit. Tier matchers are stored as arrays of predicates that map (module, event, payload) → boolean for tier membership.

### Lesson #5 — Three layered defenses on payload rendering

`classifier.ts` applies three audit-driven defenses to payload values before rendering:

**AUDIT-2 (cp18) C0 control char strip**:
```typescript
out = out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
```
Drops C0 controls except `\t` (0x09) and `\n` (0x0a). The cp17 `json_str()` fix encodes them as `\uXXXX` in the JSON wire format, but `JSON.parse` decodes them back to raw bytes here. In Matrix-client plain-text bodies the chars render literally (mostly invisible), but operators viewing journalctl directly via terminal would see them — ANSI ESC sequences could clear screen, set window title, or worse.

**AUDIT-3 (cp18) Matrix-pill defanging**:
```typescript
out = out.replace(/([@#])([a-z0-9._=/+-]+):([a-z0-9.-]+)/gi, '$1\u200d$2:$3');
```
Inserts a zero-width joiner (U+200D) after the sigil. Visually near-identical (ZWJ is invisible in most fonts), but Matrix mention/room-pill regex doesn't match — so a raw kernel string containing `@victim:matrix.org` doesn't render as a mention pill pinging random Matrix users.

**AUDIT-4 (cp18) size caps**:
- MAX_FIELD_BYTES = 1024 (per payload field)
- MAX_PAYLOAD_BYTES = 8192 (total payload-line section)

Defends against a compromised sidecar emitting a mega-payload that could DoS the bot's Matrix client (Matrix plain-text body limit is ~65KB; we cap aggressively well below to leave room for title/advice/metadata).

`escapeHtml` standard 5-char escape (`& < > " '`).

### Lesson #6 — journalctl.ts double-nested JSON parse with defensive checks

`journalctl.ts` (145) tails `journalctl -u <units> -o json --follow`. journald wraps the original log line in a JSON envelope with a `MESSAGE` field; Morphit's structured logger emits JSON itself; so the bot has to do a **double-nested parse**:

```typescript
let obj = JSON.parse(line);              // journald envelope
let inner = JSON.parse(obj.MESSAGE);     // Morphit structured log
```

Each parse wrapped in try/catch returning null. Returns null on:
- Outer JSON parse failure (line isn't JSON)
- `obj` isn't an object
- No `MESSAGE` field
- Inner JSON parse failure
- `inner` isn't an object
- Missing `module` or `event` strings

Most journald lines aren't Morphit alerts; they're skipped silently. The bot is best-effort robust against journald format drift, kernel messages, third-party services emitting non-JSON, etc.

`ts` preference: inner JSON's ts first (most accurate — set by the emitter), fall back to journald's `__REALTIME_TIMESTAMP` (microseconds since epoch). Both produce ISO 8601 strings for downstream rendering.

### Lesson #7 — rate-limiter is persisted, sliding-window, per-category

`rateLimit.ts` (69) + `state.ts` (137) implement:

- **1-hour sliding window** (`WARN_WINDOW_MS = 60 * 60 * 1000`)
- **Per-category** (`<module>:<kind>`) not global — distinct problems each surface
- **Persisted in SQLite** so an operator restart doesn't reset all rate-limit windows (would let recently-suppressed events flood through immediately after restart)
- **CRITICAL bypasses entirely** — straight to Matrix sender
- **WARN comes through here** — `isLimited` check + `recordDelivery` or `recordSuppression`
- **INFO goes to digest accumulator** — `state.pushInfoEvent`

`getSuppressedCount` surfaces the count in the daily digest: "you got 47 LOW_BALANCE alerts in the past 24h but we only DM'd you once."

### Lesson #8 — digest scheduler fixed UTC time touches at least one waking timezone

`digest.ts` (132) fires once per UTC day at the configured time (default 09:00). The choice is documented: "operators have varying timezones, but UTC 09:00 is Asia evening / Europe morning / America night — touches at least one waking timezone for most ops teams. Operator can tune via MORPHIT_MATRIX_BOT_DIGEST_SEND_TIME_UTC."

Drains the INFO accumulator + suppression counts; formats them as a single rendered body; calls `onDigest` with the body for distribution. The "drain" is atomic from state's perspective (SQLite transaction).

### Lesson #9 — Coverage table for cp103

| Module | Lines | Status | Notes |
|---|---:|---|---|
| `main.ts` | 158 | DEEP-AUDITED CLEAN | Opt-in gate via process.exit(0); tier routing (CRITICAL bypass rate limit / WARN check rateLimiter / INFO accumulate); loopback 127.0.0.1 healthcheck; graceful SIGTERM/SIGINT shutdown |
| `config.ts` | 144 | DEEP-AUDITED CLEAN | **Rejects `#`-prefix BEFORE parseMxid** with explicit error message pointing to MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM for public-room intent; branded MatrixMxid type from @morphit/operator-config prevents room aliases through type system; zod all-violations-at-once UX |
| `matrix.ts` | 100 | DEEP-AUDITED CLEAN | sendDm signature accepts only `MatrixMxid` (branded); DM room cache; matrix-bot-sdk dms.getOrCreateDm handles E2E crypto for private 2-person room; createDryRunSender for staging/tests |
| `classifier.ts` | 1,136 | DEEP-AUDITED CLEAN | 3-tier policy (CRITICAL/WARN/INFO) is source-of-truth for what wakes operator at 3 AM; **AUDIT-2 strip C0 controls except \t/\n**; **AUDIT-3 ZWJ defang @user/#room patterns**; **AUDIT-4 size caps MAX_FIELD_BYTES=1024 MAX_PAYLOAD_BYTES=8192**; escapeHtml 5-char |
| `journalctl.ts` | 145 | DEEP-AUDITED CLEAN | Tails journalctl -u <units> -o json --follow; double-nested JSON parse (journald envelope + Morphit inner); defensive type-check on every field; ts preference inner first, journald __REALTIME_TIMESTAMP fallback |
| `state.ts` | 137 | DEEP-AUDITED CLEAN | SQLite via better-sqlite3; three concerns (rate-limit windows, suppression counts, INFO accumulator); mkdirSync recursive for state DB path |
| `digest.ts` | 132 | DEEP-AUDITED CLEAN | Fires once per UTC day default 09:00; touches at least one waking timezone for most ops teams; atomic drain of INFO accumulator + suppression counts |
| `rateLimit.ts` | 69 | DEEP-AUDITED CLEAN | Sliding-window 1-hour per category (not global); persisted via state DB so restart doesn't reset windows; CRITICAL bypass; getSuppressedCount surfaces in digest |

Total cp103: 2,021 lines walked, 0 findings.

### Lesson #10 — matrix-bot is exemplary defense-in-depth for the routing-footgun threat

The single most important rule across the entire matrix-bot subsystem is "@user:server (private DM) ≠ #room:server (public room alias)." Mixing them up = security disclosure leaks into public.

The defense is layered:
1. **`config.ts` rejects `#`-prefix with helpful error message before `parseMxid` runs**
2. **Branded `MatrixMxid` type from `@morphit/operator-config`** propagates through every code path that could touch destination addresses
3. **`matrix.ts.sendDm` signature accepts ONLY `MatrixMxid`** — no implicit conversion possible
4. **DM-room cache keyed on `MatrixMxid`** prevents accidental cache-key collision
5. **Documentation at every layer** (file comments + memory rule + the error message itself) explains WHY the distinction matters
6. **Memory rule pinned in REVISIT-LIST header** so future sessions don't undo the defense

This is the gold standard for codifying a non-negotiable security rule in a way that survives code drift, memory loss across sessions, and well-intentioned refactors.

## CP103 STATE

| Metric | Value | Note |
|---|---|---|
| Scenarios PASS | 4432 | unchanged from cp102 (no code changes; audit-only) |
| Runners FAILED | 0 | unchanged |
| Workspaces TS-clean (LL #52) | 7/7 | **41st consecutive HW-verified** unchanged |
| Vitest tests passing | 1,381 | unchanged |
| Structural defenses | 37 | unchanged |
| Locale parity | 2,827 × 10 = 28,270 | unchanged |
| Brag entries | 304 | unchanged |
| Lines of code deep-audited cumulative | ~43,152 | cp82+cp85 handlers (5,266) + cp86 supporting (3,056) + cp87 indexer API (3,173) + cp88 relay (3,048) + cp89 relay client+config+drainer (1,914) + cp90 poller+federationProbe+signals (1,830) + cp91 web push (1,064) + cp92 indexer auxiliary scanners (1,645) + cp93 remaining indexer API (3,668) + cp94 fee verifiers+breaker (1,275) + cp95 streaming+auth endpoints (1,613) + cp96 web frontend crypto+auth (3,503) + cp97 web frontend pairing+identity+release-validate (2,061) + cp98 web frontend chat MITM-defense (1,787) + cp99 web frontend chat payload core (2,310) + cp100 web frontend chat orchestrator (1,201) + cp101 yubikey transport + identicon (1,429) + cp102 HTTP clients + endpoint rotator (1,288) + cp103 matrix-bot subsystem (2,021) |

## CP103 FIXES

None — cp103 was a matrix-bot subsystem audit.  0 findings across 8 modules / 2,021 lines.



### Lesson #1 — net/endpoints.ts is the resilience backbone the entire frontend rides on

`net/endpoints.ts` (470) is the chain RPC pinning + quorum dispatch layer. Every Blurt RPC call in the frontend goes through `EndpointRotator.call` or `callMany`:

- cp89's `apps/relay/src/blurt/client.ts` (server-side rotator)
- cp102's `apps/web/src/lib/blurt/client.ts` (this rotator)
- cp98's `chainVerify.ts` + `blurtVerify.ts` (both use `callMany` for Audit 2-7 + 2-8 quorum)
- cp97's `pairingClient.ts` defaultVerifier (signature recovery via rotator)
- cp97's `pairingPhoneSigner.ts` multisig pre-check

The rotator is one of the most-consumed modules in the codebase. cp102 verifies it's correctly engineered for its load-bearing role:

- Health-aware round-robin: sort eligible by fewer-failures-first, then by lower latency
- Exponential cooldown capped at 5 minutes: `1500ms * 2^(consecutiveFailures - threshold)`, max 5min
- JSON-RPC errors don't demote endpoint (server answered, just said no — caller's problem)
- `callMany` returns per-endpoint outcomes (does NOT fail on individual errors); caller decides quorum agreement
- `maxN` clamping: at least 1, at most available
- Initial endpoint shuffle prevents centralized load on first-listed URL
- `setEndpoints` preserves stats for surviving endpoints; new URLs start clean

### Lesson #2 — Three privacy defenses in fetchWithTimeout

The internal `fetchWithTimeout` helper applies three privacy posture choices:

- `credentials: 'omit'` — never send credentials to third-party RPC endpoints
- `referrerPolicy: 'no-referrer'` — no referer leakage to RPC nodes
- `cache: 'no-store'` — moderate cache hint (rotator itself handles retries)

These are not optional flags — they're hardcoded into every RPC call the rotator makes. RPC endpoints are third-party infrastructure from Morphit's perspective; leaking Referer or session cookies to them is a privacy regression. cp102 confirms the rotator gets this right.

### Lesson #3 — RpcError vs transport-error distinction is structural

The rotator distinguishes RpcError (JSON-RPC-level: server answered, just said no — method not supported, bad params) from transport errors (timeout, network failure, non-200 HTTP). Critical posture:

- RpcError: re-raise immediately; don't demote endpoint; this is the caller's problem
- Transport error: increment `consecutiveFailures`; demote endpoint if over threshold; fall through to next eligible

Pre-this-design, a buggy chain RPC method (or a deliberate test for "what happens if I pass bad params") would have demoted otherwise-healthy endpoints. Correct distinction means the rotator's health stats reflect actual reachability, not API-level disagreements.

`RpcError` carries `(message, code, endpoint)`; `EndpointRotationError` carries `(message, tried[], lastError)` for the "all endpoints failed" case. Both are structured for caller diagnostics.

### Lesson #4 — indexer/client.ts Result<T> eliminates try/catch ceremony

`indexer/client.ts` (551) is the typed HTTP client for the indexer's read-only API. Every function returns `Result<T>`:

```typescript
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCode | 'network_error' | 'timeout'; message: string };
```

Call sites destructure on `.ok`:
```typescript
const r = await indexer.getProfile('alice');
if (r.ok) { use(r.data); }
else if (r.code === 'not_found') { showEmptyState(); }
else { showError(r.message); }
```

No try/catch needed. No exception-flow confusion between "the network call failed" and "the API said no." Same Go-style error-as-value pattern as the rest of the typed-error surfaces (KeystoreError, PubPinError, YubikeyKeystoreError, PairingSignerError).

### Lesson #5 — Schema-drift catches at type-check via @morphit/indexer-client

`indexer/client.ts` imports all its response types from `@morphit/indexer-client`, a shared workspace package:

```typescript
import type {
  AccountFeedbackResponse,
  ChatHistoryResponse,
  ChatIdentityResponse,
  ...
} from '@morphit/indexer-client';
```

The indexer publishes those types from the same package. **A schema drift between indexer and frontend fails type-check at build time, not at runtime in a user's browser.** This is the right architecture for a federated codebase where the indexer and frontend ship together but can drift if not pinned.

### Lesson #6 — anySignal polyfill for AbortSignal.any composition

`indexer/client.ts` composes a caller-supplied AbortSignal with the internal 8s timeout signal via a hand-rolled `anySignal` polyfill — the browser native `AbortSignal.any` is still not in all target browsers as of writing.

```typescript
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
```

The `{ once: true }` listener option prevents listener-leak across long-lived signals. The internal timeout signal aborts on timeout; the caller's signal aborts on user cancellation (component unmount, etc.). Either triggers the composed abort, which propagates to `fetch`.

### Lesson #7 — encodeURIComponent on every account-name path param

`indexer/client.ts` uses `encodeURIComponent` on every account-name path parameter:

```typescript
`/v1/profiles/${encodeURIComponent(account)}`
`/v1/accounts/${encodeURIComponent(account)}/feedback`
`/v1/chat/${encodeURIComponent(a)}/${encodeURIComponent(b)}`
```

This defends against URL-injection in user-controllable paths. Account names should be `[a-z0-9.-]{3,16}` (validated upstream by chat/payload.ts and other validators), but defense-in-depth means encoding regardless. If a malicious account name with `/` or `?` characters slipped past upstream validation, encodeURIComponent prevents path-traversal or query-injection.

### Lesson #8 — blurt/client.ts getLatestCustomJson is the chain-verification primitive

`getLatestCustomJson` is the underlying chain-RPC helper that cp98's `chainVerify.ts` builds on. It walks `condenser_api.get_account_history` backwards from the most-recent entry, filtering for:

- `opName === 'custom_json'`
- `cj.id === opId` (e.g., `morphit_chat_identity_v1`)
- `[...required_auths, ...required_posting_auths].includes(account)`

The third filter is the critical defense: it ensures the op was signed by the named account's posting/active authority. Without this, an impersonated op authored by someone else (in a custom_json with `id=morphit_chat_identity_v1` but `required_posting_auths=['someoneelse']`) could match the first two filters and feed a false pub to chainVerify.

The chain-acceptance invariant guarantees that the op was signed by SOMEONE on `required_posting_auths`; including the account check verifies that someone is the right account.

`JSON.parse` wrapped in try/catch so a single malformed entry doesn't break the walk; continue to the next.

### Lesson #9 — Coverage table for cp102

| Module | Lines | Status | Notes |
|---|---:|---|---|
| `net/endpoints.ts` | 470 | DEEP-AUDITED CLEAN | EndpointRotator health-aware round-robin; per-endpoint stats (consecutiveFailures, lastLatencyMs, cooldownUntil); exponential cooldown capped 5min; RpcError vs transport-error distinction; `callMany` parallel quorum dispatch (powers Audit 2-7/2-8); `credentials: 'omit'` + `referrerPolicy: 'no-referrer'` + `cache: 'no-store'`; initial shuffle; setEndpoints preserves stats |
| `blurt/client.ts` | 267 | DEEP-AUDITED CLEAN | Routes dblurt JSON-RPC through rotator (rotator resolved fresh per-call so settings-edit takes effect immediately); `getLatestCustomJson` filters opName + opId + authedBy.includes (defense against impersonated ops); `getTransaction` graceful fallback for nodes without tx-index plugin; history limit default 500 with Blurt's 10K cap available |
| `indexer/client.ts` | 551 | DEEP-AUDITED CLEAN | Typed `Result<T>` discriminated union eliminates try/catch ceremony; 8s timeout via AbortController + anySignal polyfill (browser native AbortSignal.any not yet in all targets); types imported from `@morphit/indexer-client` workspace package (schema drift fails at type-check); encodeURIComponent on every account-name path param; getOperatorBlockStatus documents "show no banner on transient hiccup" posture |

Total cp102: 1,288 lines walked, 0 findings.

### Lesson #10 — Web frontend deep-audit phase summary (cp96-cp102)

cp96 opened the web frontend audit; cp102 closes it. Seven checkpoints over 16,150 lines of frontend code:

| CP | Lines | Modules | Focus | Findings |
|---|---:|---:|---|---:|
| cp96 | 3,503 | 7 | crypto core (keystore, keygen, confusables, chat/crypto, blurt/sign, service-worker, push) | 0 |
| cp97 | 2,061 | 5 | pairing + identity + releaseValidate | 0 |
| cp98 | 1,787 | 4 | chat MITM-defense (fingerprint, chainVerify, pubPin, blurtVerify) | 0 |
| cp99 | 2,310 | 1 | payload core (16-asset wire format) | 0 |
| cp100 | 1,201 | 1 | chatService orchestrator | 0 |
| cp101 | 1,429 | 5 | yubikey transport (protocol/wrap/transport/keystoreYubikey) + identicon | 0 |
| cp102 | 1,288 | 3 | HTTP clients + endpoint rotator | 0 |
| **Phase total** | **15,579** | **26** | **Web frontend** | **0** |

(Numbers slightly differ from the earlier cp100 phase summary because cp101+cp102 are post-cp100 additions.)

The web frontend was walked end-to-end from primitive to orchestrator with zero findings emerging. The cp93 release.ts JSDoc fix (the only code change in the entire frontend phase) was on the indexer side.

Remaining post-cp102 targets:
- matrix-bot subsystem (apps/matrix-bot/)
- ops-cli (apps/ops-cli/)
- 30-test CI delta hunt (sandbox-blocked)

## CP102 STATE

| Metric | Value | Note |
|---|---|---|
| Scenarios PASS | 4432 | unchanged from cp101 (no code changes; audit-only) |
| Runners FAILED | 0 | unchanged |
| Workspaces TS-clean (LL #52) | 7/7 | **41st consecutive HW-verified** unchanged |
| Vitest tests passing | 1,381 | unchanged |
| Structural defenses | 37 | unchanged |
| Locale parity | 2,827 × 10 = 28,270 | unchanged |
| Brag entries | 304 | unchanged |
| Lines of code deep-audited cumulative | ~41,131 | cp82+cp85 handlers (5,266) + cp86 supporting (3,056) + cp87 indexer API (3,173) + cp88 relay (3,048) + cp89 relay client+config+drainer (1,914) + cp90 poller+federationProbe+signals (1,830) + cp91 web push (1,064) + cp92 indexer auxiliary scanners (1,645) + cp93 remaining indexer API (3,668) + cp94 fee verifiers+breaker (1,275) + cp95 streaming+auth endpoints (1,613) + cp96 web frontend crypto+auth (3,503) + cp97 web frontend pairing+identity+release-validate (2,061) + cp98 web frontend chat MITM-defense (1,787) + cp99 web frontend chat payload core (2,310) + cp100 web frontend chat orchestrator (1,201) + cp101 yubikey transport + identicon (1,429) + cp102 HTTP clients + endpoint rotator (1,288) |

## CP102 FIXES

None — cp102 was an HTTP clients + endpoint rotator audit.  0 findings across 3 modules / 1,288 lines.



### Lesson #1 — YubiKey unlock is layered into 5 modules with intentional separation of concerns

The YubiKey-unlock subsystem (ADR-0017, Batch I) is implemented as a layered set of modules with crisp boundaries:

- **`yubikey/protocol.ts`** (202) — pure types + constants. No libsodium, no @noble, no WebHID. Smoke-importable. Includes the comprehensive T1-T6 threat model.
- **`yubikey/wrap.ts`** (231) — pure wrap/unwrap helpers with the `YubikeyHmacFn` callback contract. Smoke-testable with a deterministic stub HMAC; the actual crypto math is exercised here.
- **`yubikey/transport.ts`** (323) — WebHID transport for the YubiKey OTP applet's HMAC-SHA1 challenge-response protocol. Browser-only (Chromium-only in practice).
- **`keystoreYubikey.ts`** (419) — high-level orchestration. enroll/unenroll/harden/soften/unlock operations the UI calls. Composes wrap.ts with the keystore.ts envelope.
- **`yubikeyErrors.ts`** — typed error class + classifier + i18n key mapping.

The smoke-testable / browser-only split is the right architectural call: `wrap.ts` math can be live-fired in tsx without a physical YubiKey, and the transport-layer protocol (WebHID frame layout) is narrow enough that the integration test must happen at unlock time in a browser. This is documented honestly: "I have NOT been able to live-fire this against a physical YubiKey from this sandbox; the protocol fidelity is best-effort and the integration test must happen in the browser at unlock time."

### Lesson #2 — T1-T6 threat model is comprehensive and documented at the protocol layer

`yubikey/protocol.ts` enumerates six threats with mitigation rationale for each:

- **T1 Stolen device**: passphrase wrap defends in state A; state B is opaque bytes
- **T2 Phished/keylogged passphrase**: YubiKey doesn't help in state A (same posture as pre-Batch-I); state B blocks attack entirely
- **T3 Stolen YubiKey alone**: insufficient — attacker also needs keystore blob
- **T4 Stolen YubiKey + keystore**: known cost of (A) — "YubiKey gives you a SECOND unlock path, not a STRONGER one"; in state B same posture as stolen passphrase in (A)
- **T5 Browser exploit during HMAC**: Argon2id-stretch HMAC before use so brief raw HMAC read still requires GPU time to brute-force wrap key
- **T6 WebHID transport interception**: same-origin policy + USB-permission UX; no mitigation against malicious WebHID polyfill (users with that level of compromise have bigger problems)

The T5 defense is the most important and is implemented in `wrap.ts` — Argon2id over HMAC output is the only friction against an attacker who reads HMAC raw bytes during unwrap. Mirrored Argon2id params with passphrase wrap means a stolen-keystore attacker has no cheaper path through the YubiKey wrap.

### Lesson #3 — transport.ts Audit 6-7 hardening + L3 defensive runtime check

**Audit 6-7 fix (short feature report)**: A malformed device — or a hostile USB device with Yubico vendor ID, which is the threat class here — could deliver a feature report shorter than 8 bytes. Pre-fix, `view[FEATURE_PAYLOAD_SIZE]` reads `undefined`, the `?? 0` fallback interprets as "response ready, all zeros," yielding a partial-zero HMAC output that silently fails closed but confuses the caller. Post-fix: explicit length check + throw on short report.

**L3 fix (defensive slot runtime check)**: `makeHmacFn` checks `slot === 1 || slot === 2`. TypeScript prevents arbitrary slot values at the type level, but values reaching here from JSON-parsed envelopes aren't type-checked. Without this, a tampered envelope with `slot=99` would silently fall through to slot 2 (the default branch).

Both are defense-in-depth at trust boundaries — the WebHID device and the deserialized envelope are both untrusted-input sources where types don't apply.

### Lesson #4 — wrap.ts Argon2id-over-HMAC closes the T5 brief-read window

Documented rationale: "even though the HMAC output is already high-entropy (~160 bits assuming the slot secret is full entropy), running it through Argon2id costs an attacker GPU time to brute-force IF they ever obtain a brief read of the HMAC output during unwrap (T5). Floors a worst-case exposure window."

The KeePassXC / age-yubikey pattern is the same: HMAC output → Argon2id → wrap key. We adopt the convention because the cost-of-attack on the brief-read window matters more than the small CPU cost of an extra Argon2id derivation. Defensive-stretch over high-entropy input is cheap insurance.

Both `buildYubikeyWrap` and `recoverCekFromYubikey` wrap their crypto operations in try/finally so HMAC output and wrap key are zeroed unconditionally — `sodium.memzero` immediately after each is consumed. The pattern mirrors `chat/crypto.ts`'s ephPriv wipe (Audit 2-12) and `keystore.ts`'s JIT-key wipe (M6).

### Lesson #5 — keystoreYubikey.ts Audit 1-5 prevents silent loss of enrolled YubiKeys

Pre-fix, `enrollYubikey` on an already-layered envelope replaced the wraps array with `[passphrase, new-yubikey]`, silently dropping every previously enrolled YubiKey. A user with two physical YubiKeys enrolling a third would lose access to the first two.

Post-fix: ENFORCES the simpler invariant that only ONE YubiKey wrap may exist at enrollment time, throwing `duplicate_yubikey_label` if the user tries to add a second without going through `unenrollYubikey` first. Multi-YubiKey enrollment via a separate API (`enrollAdditionalYubikey` taking one hmacFn per existing wrap) is tracked but not implemented.

This is a graceful degradation: the rare multi-YubiKey case isn't supported yet, but the failure mode is "error message asking user to unenroll first" rather than "silently lose access." The right tradeoff.

### Lesson #6 — keystoreYubikey.ts Audit 7-1 stable error class

Pre-fix: every throw site used `new Error(...)` with a free-form English string. The `HardwareKeyCard` UI surfaced those raw strings via `showToast`, losing localization AND risking implementation-detail leak in future changes.

Post-fix: throw `YubikeyKeystoreError` with a stable `kind` discriminator. UI maps `kind` → i18n key. Free-form `message` kept for log/devtools but never user-facing. The kind taxonomy was extended to cover non-keystoreYubikey throw sites (transport.ts WebHID errors, wrap.ts cryptographic errors) via `classifyYubikeyError`.

This is the same pattern as `PubPinError.code` → `chat.security.*` i18n keys (cp98) and `KeystoreError.kind` → discriminated error UX (cp96). Consistent across the codebase.

### Lesson #7 — keystoreYubikey.ts Audit 1-6 unlock error obfuscation

`unlockWithYubikey` surfaces a generic message ("YubiKey did not unlock this keystore (wrong slot, wrong key, or HMAC mismatch)") rather than the underlying cryptographic-detail error from inner helpers. The internal context lives in `cause` for devtools but won't reach an i18n layer that might log it to a remote logging endpoint.

This is the same posture as `pubPin`'s generic-rejection-to-user / detailed-to-console split (cp98) — never leak the specific gate that failed because that's just a hint for the attacker to try harder.

### Lesson #8 — identicon.ts uses raw bytes not a string hash

Morphit generates identicons from high-entropy cryptographic material: 33-byte secp256k1 pubkeys, 32-byte signatures. Comment explicit: "Running that through a string hash like FNV-1a would destroy entropy for no benefit. We index into the input bytes directly."

180M distinct identicons (7 color slots × 12-color palette × 5 accessory shapes) — far beyond birthday-collision threshold for any user's lifetime of Morphit contacts. The clipId-nonce (`((h * 31) ^ byte) | 0`) is for DOM id uniqueness only; NO cryptographic security properties needed there.

`identiconDataUriFromString` (for paired-readonly sessions) deliberately produces a DIFFERENT identicon than the fully-unlocked identicon for the same account (different seed bytes — posting pubkey vs UTF-8 account name). Comment: "the visual mismatch IS a useful signal that the session shape changed."

This is intentional design, not a bug. The user looking at the avatar and noticing it changed is the visual cue that they're in a different session shape.

### Lesson #9 — Coverage table for cp101

| Module | Lines | Status | Notes |
|---|---:|---|---|
| `yubikey/protocol.ts` | 202 | DEEP-AUDITED CLEAN | Pure types + constants; T1-T6 threat model comprehensively documented; WrappedCek discriminated union; MAX_YUBIKEY_WRAPS=4; MAX_YUBIKEY_LABEL_LEN=64; DEFAULT_YUBIKEY_SLOT=2; ADR-0017 architecture |
| `yubikey/transport.ts` | 323 | DEEP-AUDITED CLEAN | WebHID transport for OTP applet HMAC-SHA1; **WebAuthn rejected** (ECDSA P-256 ≠ secp256k1); Audit 6-7 short-feature-report defense; L3 defensive slot runtime check (defends against tampered envelopes); 30s touch UX timeout; manual WebHID typing surface |
| `yubikey/wrap.ts` | 231 | DEEP-AUDITED CLEAN | Pure helpers smoke-testable with stub HMAC; **Argon2id over HMAC output closes T5 brief-read window**; mirrored Argon2id params with passphrase wrap (no cheaper attacker path); HMAC + wrapKey zeroed unconditionally in try/finally on both happy + error paths; assertSafeKdfParams floor 1MB memlimit |
| `keystoreYubikey.ts` | 419 | DEEP-AUDITED CLEAN | High-level enroll/unenroll/harden/soften/unlock; Audit 7-1 YubikeyKeystoreError typed class with i18n key mapping; Audit 1-5 prevents silent loss of enrolled YubiKeys (enforces single-wrap-at-enroll invariant); Audit 1-6 unlock error obfuscation (generic msg to user, cause to devtools); cannot_unenroll_last_wrap defense; classifyYubikeyError extends taxonomy across transport+wrap |
| `identicon.ts` | 254 | DEEP-AUDITED CLEAN | Heart-style identicon pure SVG no canvas no deps; deterministic from raw bytes (NOT string-hashed — high-entropy crypto material would be destroyed by FNV-1a); 180M distinct shapes; identiconDataUriFromString for paired-readonly deliberately differs from unlocked identicon ("visual mismatch IS a useful signal"); clipId nonce no crypto security needed |

Total cp101: 1,429 lines walked, 0 findings.

## CP101 STATE

| Metric | Value | Note |
|---|---|---|
| Scenarios PASS | 4432 | unchanged from cp100 (no code changes; audit-only) |
| Runners FAILED | 0 | unchanged |
| Workspaces TS-clean (LL #52) | 7/7 | **41st consecutive HW-verified** unchanged |
| Vitest tests passing | 1,381 | unchanged |
| Structural defenses | 37 | unchanged |
| Locale parity | 2,827 × 10 = 28,270 | unchanged |
| Brag entries | 304 | unchanged |
| Lines of code deep-audited cumulative | ~39,843 | cp82+cp85 handlers (5,266) + cp86 supporting (3,056) + cp87 indexer API (3,173) + cp88 relay (3,048) + cp89 relay client+config+drainer (1,914) + cp90 poller+federationProbe+signals (1,830) + cp91 web push (1,064) + cp92 indexer auxiliary scanners (1,645) + cp93 remaining indexer API (3,668) + cp94 fee verifiers+breaker (1,275) + cp95 streaming+auth endpoints (1,613) + cp96 web frontend crypto+auth (3,503) + cp97 web frontend pairing+identity+release-validate (2,061) + cp98 web frontend chat MITM-defense (1,787) + cp99 web frontend chat payload core (2,310) + cp100 web frontend chat orchestrator (1,201) + cp101 yubikey transport + identicon (1,429) |

## CP101 FIXES

None — cp101 was a YubiKey transport + identicon audit.  0 findings across 5 modules / 1,429 lines.



### Lesson #1 — chatService.ts is where the cp96-99 stack comes together

`chat/chatService.ts` (1,201) is the conversation orchestrator. Every module audited cp96-99 plugs into it:

- **`getLiveIdentity` from $crypto/keygen** — the live session's posting key (cp96 keystore.ts owns the just-in-time unlock pattern; cp97 stores/identity.ts owns the LiveIdentity store)
- **`deriveChatIdentity` from $crypto/keygen → $lib/chat/crypto** — X25519 chat keypair derived from posting priv via BLAKE2b
- **`encryptToRecipient` / `decryptFromSender` from cp96's chat/crypto.ts** — ECIES envelope per ADR-0015 (Audit 2-12 try/finally wipes)
- **`decodePayload` from cp99's chat/payload.ts** — structured-wire-format decode for trade-status side-effects
- **`resolveChatPubFromIndexer` from cp98's pubPin.ts** — chain-anchored TOFU state machine
- **`fetchLatestChatIdentityFromChainQuorum` from cp98's chainVerify.ts** — Audit 2-7 quorum + S14 secp256k1
- **`broadcastCustomJson` from cp96's blurt/sign.ts** — F-18 split prepare/sign/broadcast

This module is the demonstration that the entire trust boundary holds together as designed. No new findings — all defenses already in their respective layers compose correctly.

### Lesson #2 — S14 secp256k1 verification IS opted in for the pin-mismatch hot path

cp98's chainVerify.ts documented `verifySignature=true` as opt-in for callers on the pin-mismatch hot path. cp100 walks the actual call site:

```typescript
const trustedPubB64 = await resolveChatPubFromIndexer(
  peerAccount,
  indexerPin,
  (peer) => fetchLatestChatIdentityFromChainQuorum(peer, 3, 2, true) // ← S14 ENABLED
);
```

The third argument `(peer) => fetchLatestChatIdentityFromChainQuorum(peer, 3, 2, true)` is the verifyOnChain callback. The trailing `true` is `verifySignature`. This means **the local secp256k1 verification IS turned on for the production chat-pubkey resolution path** — the bar to a successful indexer-MITM is raised from "lie about a JSON field" to "produce a valid secp256k1 signature against a key we don't possess."

Default off was the right design for chainVerify (extra RPC roundtrips); but cp100 confirms the production opt-in actually happens.

### Lesson #3 — errorToSentinel + chat.security.* i18n keys preserve stable error UX

PubPinError carries a stable code (`pub_pin_tampered_same_ref`, `pub_pin_older_indexer_ref`, `pub_pin_chain_reports_none`, `pub_pin_chain_older_than_pin`, `pub_pin_malformed_indexer_response`). `errorToSentinel(err)` maps the error to a stable identifier:

- `err instanceof PubPinError` → `err.code` (stable, localized via `chat.security.*` i18n keys)
- `err instanceof Error` → `err.message` (technical fallback)
- anything else → `String(err)` (defensive)

The UI surface treats the LocalMessage.error string as either a known sentinel (looked up in i18n) or free-form English (technical fallback). Stable sentinels avoid English leaking into other locales for the security-critical tamper-detection paths.

### Lesson #4 — Trade-status side-effect BEFORE broadcast attempt is by design

When the user sends a structured payload (`morphit_addr` / `morphit_funds_sent`), the trade-status store is updated BEFORE the broadcast attempt:

```typescript
try {
  const decoded = decodePayload(trimmed);
  if (decoded.kind === 'address' && decoded.payload.orderPermlink) {
    recordAddressShared({ ... direction: 'outgoing' });
  } else if (decoded.kind === 'funds_sent' && decoded.payload.orderPermlink) {
    recordFundsSent({ ... direction: 'outgoing' });
  }
} catch { /* swallow */ }
```

Rationale: `/my/orders` badge updates immediately even if network is slow. If broadcast eventually fails, the trade entry still reflects user intent — they'll see the failed message in chat and can retry. Errors swallowed because broadcast is more important than store update.

This is the right ordering. The chat broadcast is the authoritative source-of-truth; the local trade-status store is a derived view for UI snappiness.

### Lesson #5 — retryMessage generates a NEW client_tag

Comment is explicit: "the previous tag's broadcast may have actually landed on-chain (we just never saw the confirmation). A new tag means the retry is a distinct op."

If we reused the old client_tag, two cases:
- Old broadcast actually landed → indexer confirms, reconciles to local pending → both messages show as confirmed (correct behavior, but the new one is now associated with the original's tag)
- Old broadcast actually didn't land → new broadcast uses the same tag → confirms cleanly

By generating a new tag for retry, the retry is an independent op. The original (if it landed) gets confirmed separately. The user might see two confirmed messages (one duplicate), but the accounting is consistent — no double-confirm-on-same-tag confusion.

### Lesson #6 — destroy() comprehensive cleanup hygiene

```typescript
destroy() {
  if (destroyed) return;
  destroyed = true;
  if (streamUnsubscribe) streamUnsubscribe();
  if (pollHandle) clearTimeout(pollHandle);
  if (currentAbort) currentAbort.abort();
  if (visibilityCleanup) visibilityCleanup();
  // Wipe sensitive state...
  if (myChatIdentity) {
    void import('libsodium-wrappers-sumo').then((mod) => {
      if (myChatIdentity) {
        mod.default.memzero(myChatIdentity.priv);
        myChatIdentity = null;
      }
    });
  }
  peerChatPub = null;
  messages = []; // free decrypted plaintext for GC immediately
}
```

Six cleanup steps:
1. SSE unsubscribe
2. Cancel pending poll timer
3. Abort in-flight requests
4. Remove visibility listener
5. **`sodium.memzero(myChatIdentity.priv)` via dynamic-import** (libsodium is already loaded at destroy time since conversation is open; the dynamic-import is essentially free lookup + code-splitting hygiene)
6. **`messages = []` frees decrypted plaintext for GC immediately** without waiting for the controller's closure to vanish

Comment is honest: "This is best-effort (JS's memory model doesn't guarantee zeros survive to the OS page); it's the same posture $crypto/keygen.ts's wipeLiveIdentity uses."

### Lesson #7 — Visibility-change listener only registered when SSE is absent

```typescript
if (!deps.subscribeStream) {
  visibilityCleanup = deps.onVisibilityChange(() => {
    if (deps.visibilityState() === 'visible') {
      // re-poll
    }
  });
}
```

SSE keeps the connection open across hidden/visible flips; no need to re-poll on becoming visible. The no-SSE path uses the visibility listener to catch up on becoming visible. Avoids redundant polling work when SSE is the primary delivery.

### Lesson #8 — Coverage table for cp100

| Module | Lines | Status | Notes |
|---|---:|---|---|
| `chat/chatService.ts` | 1,201 | DEEP-AUDITED CLEAN | State machine (pending→broadcast→confirmed/failed); ChatControllerDeps DI for testability; SSE-primary + 60s fallback poll defense-in-depth; client_tag reconciliation (16 random bytes via crypto.getRandomValues → 32 hex); **S14 secp256k1 verify=true wired at fetchPeerChatPub runtime**; PubPinError→errorToSentinel→chat.security.* i18n; trade-status side-effect before broadcast (UI snappiness); locked-session defense-in-depth; peerPubUnknown cache prevents spam-poll; decryptOrPlaceholder keeps conversation rendering on any failure; retryMessage generates new client_tag (defense against double-confirm); destroy memzero+messages=[] free plaintext for GC immediately; visibility listener only when SSE absent; defensive fetcher guard against misbehaving mock; Q11 order_permlink threading for stranger-fee bypass |

Total cp100: 1,201 lines walked, 0 findings.

### Lesson #9 — Chat client surface NOW FULLY DEEP-AUDITED

cp96 opened the web frontend audit; cp96-cp100 walked the chat client surface end-to-end:

- **cp96** (3,503 lines): crypto core — keystore, keygen, confusables, chat/crypto, blurt/sign, service-worker, push
- **cp97** (2,061 lines): pairing + identity + releaseValidate
- **cp98** (1,787 lines): chat MITM-defense — fingerprint, chainVerify, pubPin, blurtVerify
- **cp99** (2,310 lines): payload core (16-asset structured wire format)
- **cp100** (1,201 lines): chatService orchestrator

Total chat-client phase: **10,862 lines / 28 modules / 0 findings**. The trust boundary holds together as designed; no new findings emerged from the integration audit.

## CP100 STATE

| Metric | Value | Note |
|---|---|---|
| Scenarios PASS | 4432 | unchanged from cp99 (no code changes; audit-only) |
| Runners FAILED | 0 | unchanged |
| Workspaces TS-clean (LL #52) | 7/7 | **41st consecutive HW-verified** unchanged |
| Vitest tests passing | 1,381 | unchanged |
| Structural defenses | 37 | unchanged |
| Locale parity | 2,827 × 10 = 28,270 | unchanged |
| Brag entries | 304 | unchanged |
| Lines of code deep-audited cumulative | ~38,414 | cp82+cp85 handlers (5,266) + cp86 supporting (3,056) + cp87 indexer API (3,173) + cp88 relay (3,048) + cp89 relay client+config+drainer (1,914) + cp90 poller+federationProbe+signals (1,830) + cp91 web push (1,064) + cp92 indexer auxiliary scanners (1,645) + cp93 remaining indexer API (3,668) + cp94 fee verifiers+breaker (1,275) + cp95 streaming+auth endpoints (1,613) + cp96 web frontend crypto+auth (3,503) + cp97 web frontend pairing+identity+release-validate (2,061) + cp98 web frontend chat MITM-defense (1,787) + cp99 web frontend chat payload core (2,310) + cp100 web frontend chat orchestrator (1,201) |

## CP100 FIXES

None — cp100 was an integration audit of the chat orchestrator that consumes cp96-99's primitives.  0 findings across 1 module / 1,201 lines.



### Lesson #1 — payload.ts is the structured-wire-format core for chat

`chat/payload.ts` (2,310) is the largest single TS module in the frontend and the structured-message-shape protocol for chat. The chat layer below (chat/crypto.ts ECIES envelope) treats the plaintext as an opaque string; payload.ts is the JSON shape that rides inside the plaintext. Two top-level message kinds:

- `morphit_addr`: address handoff `{v, kind, method, address, amount?, order_permlink?, note?, memo?, network?, payjoin_endpoint?}`
- `morphit_funds_sent`: payment ack `{v, kind, method, txid, amount?, order_permlink?, note?, memo?, network?}`

Supports 16 tradable assets (btc/xmr/blurt/usdt/usdc/dai/bch/ltc/dash/doge/zec/arrr/dcr/sol/eth/xrp) across single-network and multi-network (USDT/USDC/DAI) families.

### Lesson #2 — Validation philosophy: CHEAP SHAPE not checksums

Documented tradeoff at top of module: regex against known address formats, length bounds, charset — NOT checksums (Base58Check for BTC, bech32 SegWit, Monero crypto-checksum). Reasons:

1. **Bundle size**: bitcoinjs-lib + monero-js would add ~300kB to the chat chunk on top of libsodium's ~250kB. Chat is already lazy-loaded to keep the inbox tiny; doubling its chunk would walk back the Phase E.5 wins.
2. **Defense in depth elsewhere**: when the recipient eventually sends funds to the address, their wallet does the checksum verify. A typo'd address there is a wallet rejection, not a lost transaction.
3. **Cheap shape catches the most likely class of error**: paste-went-wrong, truncated address, mistyped prefix. Catastrophic typos that pass the regex would also pass any human's eyeball check.

This is the right tradeoff to document. Future contributors may be tempted to "harden" payload.ts with full checksums; the module header is explicit about why that would walk back UX wins.

### Lesson #3 — cp30-DD-DD CODE-1 closes the missing-network-field hole

Pre-fix, multi-network methods (USDT/USDC/DAI per ADR-0023 + ADR-0028) didn't require the `network` field on the wire. A message `{method:'usdc', address:'0xabc'}` without network was accepted; downstream UI rendered the address pill without the network chip, leaving the buyer uncertain which chain (Ethereum/Solana/Base/Polygon) to send on.

The CODE-1 fix is symmetric at encode AND decode:
- Decoder rejects multi-network message without network field
- Encoder refuses to emit multi-network message without network field
- Both throw or return null with a specific error message

Closing both sides means a buggy caller using `as`-cast escape hatches to bypass TS types is caught at the encoder rather than letting them ship a wire message the receiver rejects later. Encoder is the runtime gate.

### Lesson #4 — cp30-DD-DD SEC-3/SEC-6 per-network cross-validation closes the address-shape-confusion hole

The asset-wide isValid functions (isValidUsdcAddress, isValidUsdtAddress, isValidDaiAddress) are the UNION of per-network shapes. A hostile peer could send `{method:'usdt', network:'spl', address:'<EVM-format-string>'}` and the asset-wide check would accept it (since EVM-format is a valid USDT shape on ERC-20/BEP-20). The downstream UI would display the address under the SPL network label, potentially confusing the buyer into routing funds to the wrong chain.

SEC-3 fix at decoder + SEC-6 fix at encoder: imports per-network validators from `networks.ts` and cross-checks `address` shape against the decoded `network` value. **CRITICAL for DAI** where ALL FOUR networks share EVM 0x[40 hex] format — only the network field disambiguates which chain.

The validators in `networks.ts` use per-network pinned regexes even though many networks share the EVM shape — this is the cross-network-mis-send hardening. Same trust-gate posture as the cp30-DD-11 latent-since-cp3 lesson.

### Lesson #5 — Amount-jitter privacy defense is universal across asset classes

Every asset type ships a jitter function calibrated to its precision:

- **XMR**: 12-decimal precision, jitter 0..999,999 piconero ≈ 1 microXMR max
- **Stablecoin (USDT/USDC/DAI)** cp30 fix: 6-decimal precision, jitter 0..999 micro-units ≈ $0.001 max. Pre-cp30 was pass-through; the original rationale ("USDT's privacy issue is centralization not amount-correlation; jitter doesn't address Tether freezes") was an INCOMPLETE argument — the absence of jitter benefit on the freeze threat doesn't refute the jitter benefit on the correlation threat. cp30 closed the gap.
- **UTXO (BTC/BCH/LTC) cp26**: 8-decimal precision, jitter 0..999 satoshis ≈ $0.50 BTC, $0.005 BCH, $0.001 LTC
- **BLURT, SOL, ETH, XRP**: per-asset calibration

Universal rules:
- **Round UP only** — never underpay seller; verifier treats underpayment as fail
- **CSPRNG via `crypto.getRandomValues`** — explicitly rejects Math.random because "predictable PRNG state could let an observer correlate jitters across a single user's transactions"
- **Caller-side memoization** per-trade — seller-share, buyer-echo, seller-verify all see same value. The function is NOT internally memoized because the caller's Svelte component lifetime is the right place.
- **Domain dispatch** via `jitterAmountForAsset(method, base)` so callers don't have to know per-asset precision

The defense breaks the trivial "$5,000 of DAI for $5,000 cash" exact-match correlation an observer with off-platform knowledge could otherwise execute. Small implicit-tip cost ≤ gas fee on any supported chain.

### Lesson #6 — generateBlurtMemo CSPRNG closes the pre-image-front-run attack

`generateBlurtMemo` produces 8 chars from a 32-char alphabet (lowercase letters minus l/o + digits 2-9 minus 0/1) = ~40 bits entropy. The l/o/0/1 drop is for read-aloud safety over phone — "el"/"oh"/"zero"/"one" are commonly misheard.

Comment explicit on CSPRNG choice: "to defeat a pre-image attacker who could otherwise pre-compute a memo and front-run a trade — they'd send the seller a small payment with the predicted memo, corrupting the seller's accounting (legitimate buyer's later transfer with the same memo arrives at an account that already has a 'matched' entry). CSPRNG output is unguessable; the attack collapses."

`bytes[i] & 0x1f` with a 32-char alphabet — power-of-two means no modulo bias.

### Lesson #7 — F-1/F-2/F-3/F-5/F-6/F-8 Phase F.5 audit fixes

Six Phase F.5 audit fixes embedded throughout payload.ts:

- **F-1 noteHasForbiddenChars**: rejects control characters and bidi-override characters in user-controlled `note` field — prevents UI confusion attacks where a note containing RTL/LRO could distort displayed pill rendering
- **F-2 unknown_kind surface**: known v:1 but unknown kind (e.g. future `morphit_dispute`) returns `{kind:'unknown_kind', name}` so UI shows "old client, please update" rather than rendering raw JSON
- **F-3 memo BLURT-only**: other methods carrying memo → reject decode AND throw on encode. Memo is a BLURT-chain concept; XMR/UTXO chains don't have it. Cross-method memo would confuse routing.
- **F-5 Object.hasOwn**: `Object.hasOwn(o, k)` instead of `k in o` — defends against prototype-chain phantom fields from untrusted data
- **F-6 empty-string optionals omitted from wire**: saves ~11 chars per omitted field in encrypted payload size. Matters because chat plaintexts get encrypted under ChaCha20-Poly1305 IETF, and every wire byte adds to bandwidth + indexer storage.
- **F-8 BLURT amount 3-decimal normalize via Math.ceil**: chain storage precision is 3 decimals; without normalize the verifier compares high-precision seller expectation against chain's 3-decimal reality → false mismatch on 4th decimal. Math.ceil for symmetry with formatBlurtAmount (sellers slightly overpaid rather than underpaid).

### Lesson #8 — Per-asset URI builders follow each chain's canonical convention

`buildPaymentUri` emits the right URI scheme per asset:
- `bitcoin:` (BIP-21, with optional `pj=` for BIP-78 PayJoin)
- `monero:` with `tx_amount` (not `amount` — Monero historical naming)
- `bitcoincash:` (CashAddr BIP-21 derivative, auto-prefix bare/legacy)
- `litecoin:`, `dash:`, `dogecoin:` (BIP-21 conformant from fork lineage)
- `zcash:` (ZIP-321)
- `arrr:` (Pirate Chain, ZIP-321-style from Zcash fork)
- `decred:` (BIP-21-style)
- `solana:` (Solana Pay spec)
- `ethereum:` (simplified BIP-21-compatible — not full EIP-681 with @chainId/wei because every major wallet parses the simplified shape correctly for native ETH)
- `ripple:` (with optional `dt=` destination tag — privacy guide warns × 10 locales because exchange-hosted addresses without the tag practically lose funds)
- BLURT: bare account name (no URI scheme)

**Memo deliberately NOT included in QR**: "the chain transfer's memo is a separate concern (privacy-affecting; we don't want to auto-pre-fill something sensitive)."

`order_permlink`, `note`, and Morphit-specific metadata also NOT in QR — the QR's only job is to get the recipient's wallet to the "send to address" screen with the right amount. Everything else stays in the chat.

### Lesson #9 — Coverage table for cp99

| Module | Lines | Status | Notes |
|---|---:|---|---|
| `chat/payload.ts` | 2,310 | DEEP-AUDITED CLEAN | 16-asset support (btc/xmr/blurt/usdt/usdc/dai/bch/ltc/dash/doge/zec/arrr/dcr/sol/eth/xrp); cheap shape NOT checksums (bundle size tradeoff documented); amount-jitter privacy defense per-asset (XMR 999K piconero, stablecoins 999 microunits, UTXO 999 sats, all CSPRNG round-UP); F-1 control+bidi defense; F-2 unknown_kind; F-3 memo BLURT-only; F-5 Object.hasOwn; F-6 empty-string omitted; F-8 BLURT 3-decimal Math.ceil; cp30-DD-DD CODE-1 multi-network requires network; cp30-DD-DD SEC-3/SEC-6 per-network cross-validate (CRITICAL for DAI 4-EVM-network sharing); generateBlurtMemo CSPRNG defeats pre-image front-run; per-asset URI builders per canonical chain convention; memo NOT in QR |

Total cp99: 2,310 lines walked, 0 findings.


---

## Archive: CP99 and earlier

Pre-cp100 history (cp99 STATE/FIXES, CP99+ predicted hunting ground, CP90-cp99 history, Part 100–Part 108++ legacy entries) was moved to [`REVISIT-LIST-ARCHIVE.md`](./REVISIT-LIST-ARCHIVE.md) at cp150 (2026-05-27).

The split was done because REVISIT-LIST.md had grown to ~2.1MB and most maintainer queries only touch cp100+ entries.  The archive file is frozen — any new entries land in this live file, not the archive.

See cp150 entry above for the archival rationale.

