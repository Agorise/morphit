# Morphit — June 2026 DEEP-DEEP audit campaign

Status legend: ⬜ not started · 🔄 in progress · ✅ done · ⚠️ finding open · 🟢 finding fixed

Scope (Ken's directive): all five persona walkthroughs touching every interactive
surface; a 94+ task full security + code audit of EVERY file/script in the repo;
a "what if every op was hostile?" sweep per handler + a consolidated chain-direct
attack re-pass; DB dead fields, draft finalization, FAQ accuracy, mobile-responsiveness,
UI/UX, README + OPERATIONS + RUN-A-NODE + every docs/*.md accuracy, broken references,
efficiency / page-load, wiring, keys, drift, memory leaks, fallbacks/failovers,
"never leave a user hanging"; any audit type not yet performed; recommendations;
grandma-friendliness. Fix as we go. No tarball until Ken says go.

Repo size at campaign start: 6 apps + 7 packages; 45 routes, 77 components, 197 web
lib .ts, 190 smoke scripts, 70 docs/*.md.

---

## PHASE 1 — Persona walkthroughs (every button / link / field / select)
- ⬜ **Bob** — Blurt multi-login (login, onboarding/import posting-key + keyfile + master-password, account switching, authenticated surfaces)
- ⬜ **Sally-user** — no crypto (new-account onboarding, orderbook browse, order detail, chat, feedback)
- ⬜ **Sally-operator** — stands up a node from the .md (RUN-A-NODE + OPERATIONS walked as written)
- ⬜ **Josie** — sysadmin, daily `morphit-ops` usage (every command + menu + prompt + select)
- ⬜ **Charlie** — MCP agent, read-only (every MCP tool, deeplink-handoff posture)

Surface checklist per persona: every `<button>`, `<a>`, `on:click`/`onclick`,
`<input>`/`<textarea>`, every `<select>`/option, every form submit, every error/empty/
loading state ("never leave a user hanging"), keyboard + RTL + dark-mode, mobile width.

## PHASE 2 — 94+ task deep-deep (categories A–M, black-hat)
- ⬜ A static code (dead code, unreachable, TODO/FIXME, console.* leaks)
- ⬜ B deps / supply-chain (lockfile integrity, advisory check w/o `audit fix`, license parity)
- ⬜ C SQL / DB (injection, dead fields, migrations, indexes, schema drift)
- ⬜ D HTTP / API (validation, authz, rate-limit, error leakage, CORS, headers)
- ⬜ E crypto (key handling, signature paths, RNG, envelope/2FA, byte-identity proofs)
- ⬜ F privacy (no-IP, no-telemetry, no-CDN, fresh-address, jitter, ciphertext-only)
- ⬜ G operator-trust (untrusted-by-default, federation, rogue-operator containment)
- ⬜ H frontend (XSS, injection, @html, unsafe href, state leaks)
- ⬜ I contracts / op schemas (narrow unions, validation, version frozen enums)
- ⬜ J build / CI (gates green, version-consistency, smoke registration, reproducibility)
- ⬜ K threat modeling (STRIDE per changed subsystem, attack trees)
- ⬜ L per-subsystem walk (every sibling file/route/dispatch/docblock/i18n consumer)
- ⬜ M i18n integrity (parity, coverage, completeness, native-floor, hardcoded-english, drift)

## PHASE 3 — Hostile-op sweep (every handler) + chain-direct attack re-pass
Handlers (17): ⬜ block ⬜ chat ⬜ chatIdentity ⬜ chatRead ⬜ featureBid ⬜ feeAttest
⬜ feedback ⬜ feedbackResponse ⬜ operatorBlock ⬜ operatorPaymentMethod ⬜ operatorRegister
⬜ order ⬜ orderCancel ⬜ orderReplace ⬜ profile ⬜ release ⬜ strangerFee
Op types (18): block, chat_identity, chat_read, chat, feature_bid, fee_attest,
feedback_response, feedback, operator_block, operator_register, operator_update,
order_cancel, order_replace, order, payment_method_addition, profile, release, stranger_fee.
- ⬜ Per-handler: "what if this op was hostile?" (malformed/oversized/spoofed/replayed/out-of-order/unicode/injection)
- ⬜ Consolidated chain-direct attack pass (bypass the frontend, post raw ops)

## PHASE 4 — Cross-cutting
- ⬜ DB dead fields (the known `voting_manabar`/`received_vesting_shares`/`delegated_vesting_shares` prune candidate + any others)
- ⬜ Draft finalization (any half-built features / TODO drafts)
- ⬜ FAQ accuracy (138 entries × facts vs code/economics; new `why_agpl` consistency)
- ⬜ Mobile responsiveness (every route at narrow width; the `dev/responsive` harness)
- ⬜ UI/UX oddities; grandma-friendliness
- ⬜ README accuracy
- ⬜ OPERATIONS.md + RUN-A-MORPHIT-NODE.md accuracy (walked as written)
- ⬜ Every other docs/*.md accuracy (70 files)
- ⬜ Broken references (links, paths, anchors, cross-doc)
- ⬜ Efficiency / slow page loads (bundle, lazy-load, N+1, waterfalls)
- ⬜ Wiring (call-site + registered + tested for every feature)
- ⬜ Keys / vals (missing, dead, drifted, bad)
- ⬜ Memory leaks (timers, listeners, subscriptions, SW caches)
- ⬜ Fallbacks / failovers everywhere they should be

## PHASE 5 — Audit types not yet performed (identify + run)
- ⬜ Enumerate prior audit types (from docs/AUDIT-*.md) → find the gaps → run them

## PHASE 6 — Recommendations
- ⬜ Change / remove / simplify list; grandma-friendliness verdict

---

## PROGRESS LOG
(newest first)

### Session (cp337, 2026-06-24) — beta.30 RELEASE CUT (beta.29 → beta.30; Ken said go)
Cut the **v1.0.0-beta.30** release, bundling the entire post-beta.29 working tree (cp333 settings/Short-Bio + cp334 login-race-fix/2FA-polish/SignupProgress/ENS + cp335 arrows/RTL/breadcrumbs/`uv_cwd`-fix + cp336 the fresh-review + 3 stale-comment fixes). **Bumped all 19 version touchpoints beta.29 → beta.30** via surgical per-line edits (each file verified to hold exactly ONE `1.0.0-beta.29` string first, so a per-file `sed` of the version literal is surgical, no reformat): 14 `package.json` (root + the 13 workspaces, discovered dynamically by version-consistency from the root `workspaces` array), `apps/relay/src/api/health.ts` `VERSION`, `apps/indexer/src/api/health.ts` `INDEXER_VERSION`, `apps/mcp-server/src/main.ts` `MCP_VERSION`, `docs/API.md` (health example), `apps/indexer/README.md` (health example). Synced `package-lock.json` (`npm install --package-lock-only --ignore-scripts`; 15 beta.29 → 15 beta.30 entries; **`npm audit fix`/`--force` NOT run — permanently banned**; the 23 advisories are the documented dev-only vitest-UI + matrix-bot-sdk transitives with no prod exposure). Wrote `RELEASE-NOTES-v1.0.0-beta.30.md` — user-facing plain-language prose matching the beta.29 format, organized by Staying-signed-in / Profile-and-settings / Signing-up / Getting-around / Two-factor / For-operators / Under-the-hood; deliberately NO asset-count claims so `release-notes-asset-count-parity` stays 3/3; headline item is the cp334 sign-in reliability fix (a normal refresh no longer drops a "Remember Me" user to the import screen), confirmed in-tree before writing. Verified no test pins the literal version string (so vitest is unaffected by the bump) + no generated asset (llms-full.txt, llms.txt, mediakit) embeds the version. **No code change beyond the 3 version-constant strings + the new RELEASE-NOTES** — every functional change was already in the tree at cp336. **FULL VERIFICATION @ beta.30 (all GREEN):** version-consistency **19/19 @ beta.30** + RELEASE-NOTES present; release-notes-asset-count-parity **3/3**; mediakit-freshness **7/7**; llms-full-freshness **6/6**; `svelte-check` **0 errors / 0 warnings / 698 files**; typecheck-sweep **14/14 (0 errors)** (indexer src+test, relay src+test, ops-cli, matrix-bot, mcp-server + the 7 packages); i18n-locale-parity **10/10**, translation-completeness **4/4**, key-coverage **2/2**, html-injection **1/1**; smoke-registration-integrity **4/4** (371 entries / 364 files); the FULL smoke battery via the smoke-tsconfig chunk runner = **8417 scenarios across ALL 371 registered smokes, 0 runners failed** (chunks 2436 + 1667 + 2334 + 1980); vitest **1480 passing / 0 failing** (web 741/5-skip, indexer 489/1-skip, relay 250/0). **NOT run in-sandbox (explicit, standing limits):** indexer `better-sqlite3` native build (needed only by matrix-bot, which has 0 tests) + web `vite build` → Forgejo CI on push. **FULL tarball** `morphit-cp337-beta30-FULL-STATE.tar.gz` cut (a doc FILE — the release notes — was added, so FULL not delta). **This is a BETA → Forgejo only:** the beta Basic-Auth gate STAYS up, nothing is mirrored to Codeberg/IPFS, no `morphit_release_v1` is broadcast — those are the separate stable-public-release ceremony. Handed Ken the single-paste git block (add / commit / signed tag `v1.0.0-beta.30` / push main + tag) plus the verified VPS `sudo morphit-ops upgrade` flow for the live deployment.

### Session (cp336, 2026-06-24) — fresh-session deep re-verification of the cp335 tarball + 3 stale-comment fixes (post-beta.29, no bump; WORKING TREE ONLY → folded into the beta.30 release, cp337 below)
Ken's standard "deeply review the tarball, recommend where to go, fix what should be fixed" ask, from a CLEAN session (no trust in the inbound handoff numbers). **(A) Independent full-gate re-verification — ALL GREEN, and STRONGER than the cp335 handoff claimed.** `npm install --ignore-scripts` → 684 pkgs (23 advisories = the documented dev-only vitest-UI + matrix-bot-sdk transitives, NO prod exposure; `audit fix` BANNED). `svelte-check` (apps/web) **0 errors / 0 warnings / 698 files**; `typecheck-sweep` **all 14 targets 0 errors**; vitest **1480 passing / 0 failing** (indexer 489 / relay 250 / web 741 — better-sqlite3 not built but only matrix-bot needs it and it has 0 tests; indexer/relay run on pg + fakes); the FULL smoke battery via the smoke-tsconfig runner (`tsconfig.smoke.json`, which resolves the `$lib`/`$config` path aliases the bare runner cannot) = **8417 scenarios across ALL 371 registered smokes, 0 runners failed** — strictly better than the cp335 handoff's "≈327 pass / 3 env-only", because those 3 indexer non-passes were only the bare-runner alias gap, not real defects. Gates: version-consistency **19/19 @ beta.29**; i18n-locale-parity 10/10; translation-completeness 4/4; key-coverage 2/2; html-injection 1/1; mediakit-freshness 7/7; llms-full-freshness 6/6; smoke-registration-integrity 4/4 (364 files). **(B) Black-hat audit of the freshest cp333/334/335 code — all substantive work SOUND.** ENS `.eth`: validator `ENS_RE` = safe strict-lowercase-ASCII `label(.label)*\.eth`; indexer zod `MORPHIT_INSTANCE_ENS_NAME` mirrors the TOR/LOKINET/I2P siblings; footer + /instances pills build `https://{ens}.eth.limo` via a Svelte-escaped attribute + `rel="noopener noreferrer"` (no new vector beyond the existing operator-self-declared alt-net pills); the `MORPHIT_INSTANCE_ENS_NAME` allowlist entry is genuinely present at `packages/operator-config/src/index.ts:325` → the claimed boot-error launch-blocker IS fixed. cp334 CRITICAL login-race fix (`identity.ts reset(opts?)`): in-memory wipe always, disk-clear ONLY on explicit `{clearDisk:true}`; all callers verified (pagehide→bare; cross-tab storage-mirror→bare; broadcastSignOut + cross-tab 'signout'→clearDisk:true); regression test pins both contracts incl. the refresh-race — sound. cp335 `uv_cwd` fix (`repoRoot.ts safeCwd()`): all 6 sites route through `safeCwd() ?? defaultRepoRoot()`, render.ts passes an explicit base — comprehensive. cp335 RTL arrows: all 18 markup `⇦`/`⇨` carry `rtl:inline-block rtl:-scale-x-100`; no `←` residue outside ToastRegion. cp333 Short Bio: rendered via escaped `{shortBio}` (NOT @html) → XSS-safe even with hostile chain content. HMAC-secrets schema secure-by-default. **No functional bug found.** **(C) The one finding — 3 stale comments from the cp334 reset()-contract change (LOW, comment-only → no smoke).** cp334 made disk-clear opt-in but left 3 cross-reference comments describing the OLD unconditional-disk-clear behaviour, which contradicted the new contract and obscured the exact refresh-logout bug cp334 fixed. Verified in code (NEVER ASSUME): the idle auto-lock calls `lockSession()` (NOT bare reset()), and `lockSession()` on a paired-readonly session DELIBERATELY calls `clearPairedSession()` (correct — a QR-pair carries no password, so a meaningful lock must drop the marker rather than silently auto-restore it). Behaviour is correct; only docs drifted. 🟢 Fixed: (1a/1b) `identity.ts` reset() doc paragraph + body bullet — removed the false "idle auto-lock" attribution, clarified idle-lock is a separate `lockSession()` path; (2) `identity.ts` storage-event mirror comment (~line 550) — "tries to clear the persisted envelope (already gone — clearKeystore is idempotent)" → a bare reset() never touches disk, which is exactly right here since the other tab already removed the envelope; (3) `apps/web/src/lib/crypto/pairedSession.ts` lifecycle header (~line 28) — "cleared … by any reset() call" → cleared by signOut-from-paired / keystore-unlock-switch / `lockSession()` on a paired session / explicit `reset({clearDisk:true})`; a BARE reset() (pagehide / cross-tab mirror) PRESERVES the marker for auto-restore. `profile.ts:111`'s reset() comment is about the account-name cache → accurate, left alone. **5 personas traced** (Bob / Sally-user / Sally-operator / Josie / Charlie) → all reach the feedback path (`/my/orders → PendingFeedbackReminderBanner → LeaveFeedbackForm → morphit_feedback_v1 → indexer → profile → feedbackResponse_v1`); no recursive bug-finding. **Post-edit re-verify:** `svelte-check` 0/0; targeted vitest on the three identity/paired suites (`identityPaired.test.ts` + `identity.test.ts` + `pairedSession.test.ts`) = **46 passed / 5 skipped** (the contract the edited comments describe is pinned green); comment block-delimiters balanced (identity.ts 22/22, pairedSession.ts 9/9). **Recommendation to Ken — the real deliverable:** the tree is in excellent release-ready-for-beta.30 shape; every substantive next step is HARDWARE or CEREMONY, not code — (1) a YubiKey bench session to fix the 5 `transport.ts` WebHID framing defects with a physical device (the single remaining pre-stable human gate); (2) the stable-public-release ceremony (build → SRI manifest → `morphit_release_v1` on-chain broadcast → remove the beta Basic-Auth gate → mirror Codeberg + IPFS); (3) set the two launch-blocking relay HMAC secrets; (4) a locale-QA eyeball of the 9 non-English `why_agpl` translations + the ENS FAQ bullet. The cp336 comment-only fixes were folded directly into the beta.30 release cut (cp337) — no separate cp336 tarball was cut.

### Session (cp335, 2026-06-24) — UI arrows + breadcrumb/back-link standardization + morphit-ops `uv_cwd` crash fix (post-beta.29, no bump; WORKING TREE ONLY)
Ken's 4-item batch, no version bump; captured in the `morphit-cp335-beta29-FULL-STATE.tar.gz` handoff tarball (not released). **(1) Bigger arrows site-wide:** swapped thin `→`/`←` for the larger `⇦`/`⇨` (U+21E6/U+21E8) — text glyphs, so they inherit the adjacent text's colour + size with zero extra CSS (satisfies "same colour/height"). All back-nav `←`→`⇦` in 9 route files (13 sites; `ToastRegion` swipe `←` left), trailing link-label `→`→`⇨` across all 10 locales (value-based — only strings ending in `→`), and forward-nav `→`→`⇨` in 4 components (settings TOTP CTA, chat row affordance, onboarding path CTA hints ×2, privacy asset-link). Prose-internal flow arrows ("Settings → Session", "first trade → 10 Blurt") deliberately left as-is (mid-sentence ⇨ hurts readability) — flagged to Ken. **(3) Breadcrumb / back-link standardization:** top-of-page breadcrumb back-links were in inconsistent "weird colours" (explorer grey `text-ink-500`, privacy always-green, 2FA blue `var(--accent,#4a9eff)`) → all `text-white hover:text-morphit-emerald`; 2FA scoped `.back` → `color:#fff` + `:hover{color:var(--morphit-emerald)}`. App is dark-only (`<html class="dark">`, `bg-ink-950 text-ink-100`) so plain white is correct/visible. Bottom de-emphasized cancel/back: new `BusyButton` `link` variant (grey `text-ink-300` + emerald-text hover, no button chrome); the 5 ghost back/cancel controls converted to it + larger `⇦`; the 2 prominent `secondary` recovery buttons (post/edit `back_to_orderbook`) left as outlined buttons. **(2) "Sign in with YubiKey" — FINDING, no code change (honest pushback):** YubiKey login is ALREADY built/wired on the login `welcome-back` (unlock) state (`handleUnlockYubikey()`→`requestYubikey(slot)`→`bootFromEnvelopeWithYubikey`, both as the sole path for a YubiKey-only keystore and as a secondary option beside the password form, already using `/icons/icon-yubikey.svg`). It is an UNLOCK factor for the *local* encrypted keystore (YubiKey HMAC-SHA1 challenge-response + the enroll-time passphrase), NOT a portable/fresh-device credential — so it cannot sit next to the QR "use my phone" button, which lives on the *separate* `import-needed` (fresh-device) state with no local keystore to unwrap. NO button added next to QR; QR label NOT shortened (that shortening was explicitly conditional on adding the button). Caveat unchanged: the 5 WebHID `transport.ts` framing defects (the remaining pre-stable hardware-gate) mean it won't function against real hardware until fixed with a device; the enroll-verify gate currently blocks enrolling one. **(4) 🔴 morphit-ops `✗ ENOENT … uv_cwd` on menu choices 3/4/etc — FIXED + proven:** `process.cwd()` throws `uv_cwd ENOENT` when the shell's cwd was removed out from under the process (classic post-`upgrade` install-dir rename). The interactive menu RENDERS without cwd, but dispatching `edit`(3)/`alt-address`(4)/`status`/etc → `defaultRepoRoot()` → `process.cwd()` → crash. Fix (`apps/ops-cli/src/lib/repoRoot.ts`): new exported `safeCwd()` (try/catch→`null`); `defaultRepoRoot()` skips the cwd-walk on null cwd and falls through to module-relative resolution (`fileURLToPath(import.meta.url)`, always inside the install tree); `cwdStrandedInUpgradeBackup()` returns false on null cwd. The 5 other direct `process.cwd()` sites (`doctor`/`ssl`/`install`/`editActiveKey`/init `render` resolveOutputPath) hardened to `safeCwd() ?? defaultRepoRoot()` (identical when cwd valid). PROVEN via a deleted-cwd runtime repro: `safeCwd()=null`, `defaultRepoRoot()=<repo root>` (no throw), `cwdStranded()=false`. NOT introduced by the ENS work — root cause is the operator's shell sitting in a removed dir. **Gates (green @ beta.29):** ops-cli `tsc` clean; deleted-cwd repro passes; `svelte-check` 0/0; `i18n-locale-parity` 10/10, `i18n-translation-completeness` 4/4, `i18n-key-coverage` 2/2, `i18n-html-injection` 1/1; all 10 locale JSONs valid; `←` now only in `ToastRegion` swipe CSS. Not in-sandbox: indexer vitest + web `vite build` → CI.

**cp335 DEEP-DEEP (full smoke battery + targeted audit + 5 personas).** Ran the ENTIRE smoke battery (all 330 scripts) in-sandbox: **ops-cli 46/46** (incl. `repo-root-bak-recovery`, `doctor`, `ssl`, `install-invariants`, `edit-active-key` — the cwd-hardened files), **web 144/144**, **packages 26/26** (asset-registry 22, operator-config 1 incl. ENS allowlist, net-defense 1, relay-client 1, rpc-pool 1), **relay 11/11**, **matrix-bot 11/11** (incl. cp334 ENS API-shape fixture), **mcp-server 5/5**, **indexer 84/87** (the 3 are `$lib`-alias resolution under bare tsx — CI-only, not regressions). Total ≈327 pass / 3 env-only. **The deep-deep CAUGHT + FIXED 3 real regressions left by the prior (cp334) session, each traced to legitimate cp334 code that the last session didn't re-verify:** (i) `llms-full-freshness` — en.json changed (ENS FAQ bullet + trailing arrows) so the generated `apps/web/static/llms-full.txt` was stale → regenerated via `node scripts/build-llms-full.mjs` (139 entries, now 6/6); (ii) `2fa-no-google-recommendation` — cp334's non-mutating alphabetical sort made the `#each` iterate `recommendedAppsSorted`/`notRecommendedAppsSorted` (sorted copies) so the smoke's literal `each RECOMMENDED_AUTHENTICATOR_APPS` regex missed; the code is correct (all apps still rendered, source arrays untouched) → relaxed both assertions to also accept the `[...RECOMMENDED_AUTHENTICATOR_APPS].sort(…)` full-spread-copy pattern (completeness preserved); (iii) `cross-tab-signout-propagation` — cp334's critical `reset()` signature change to `reset(opts?: { clearDisk?: boolean })` broke the smoke's empty-parens locator `/export\s+function\s+reset\s*\(\s*\)\s*:/`; the code is correct → made the locator param-tolerant `/…reset\s*\([^)]*\)\s*:/` (the actual safety assertion — no signout broadcast inside `reset()` — is preserved and passes). **Targeted audit:** ops-cli has NO bare-relative `readFileSync`/`existsSync` that could still throw on a dead cwd (all paths absolute/resolved via `defaultRepoRoot()`) → the cwd fix is complete. **RTL ARROW DIRECTION — FIXED (follow-up to the initial flag):** the app activates `dir="rtl"` for Farsi (app.html + hooks.client.ts, `fa` = `rtl:true`). All 18 markup nav arrows (13 back + 5 forward) now carry Tailwind `rtl:inline-block rtl:-scale-x-100`, which flips the glyph horizontally ONLY under `[dir="rtl"]` and composes with existing hover-transforms (verified via a standalone `tailwindcss` compile — generates `.rtl\:-scale-x-100:where([dir="rtl"], [dir="rtl"] *)` with `scaleX(var(--tw-scale-x))`, `--tw-scale-x:-1`; LTR unaffected). The 4 fa-embedded i18n trailing forward arrows were flipped `⇨`→`⇦` directly (CSS cannot target text inside a translated string; in RTL the trailing `⇦` resolves to the visual-left pointing left = correct forward affordance). Back arrows also gained `aria-hidden="true"` (decorative — improves the link's accessible name; matches the forward arrows). Re-verified: svelte-check 0/0, web battery 144/144, i18n parity 10/10 + completeness 4/4, a11y 36/36, fa now 4 `⇦`/0 `⇨`, en still `⇨`. The `ToastRegion` swipe-to-dismiss arrow was also verified and is ALREADY RTL-aware (`.toast-arrow:dir(rtl)::after` swaps `→`→`←`), so it needs no change. **5 PERSONA WALKTHROUGHS traced** (Bob multi-login unlock incl. YubiKey factor; Sally-user fresh onboarding incl. signup progress + the `link`-variant back buttons; Sally-operator first node setup incl. the now-FIXED morphit-ops cwd crash; Josie ongoing morphit-ops incl. edit/alt-address/status/ENS no longer crashing on stale cwd; Charlie MCP — 5 read-only-by-construction tools) — all reach the feedback path `/my/orders → PendingFeedbackReminderBanner → LeaveFeedbackForm → lib/blurt/ops/feedback.ts (morphit_feedback_v1) → indexer handlers/feedback.ts → profile → feedbackResponse_v1`. No new defects surfaced beyond the 3 fixed above; no recursive bug-finding. Still working-tree only; NO tarball.

### Session (cp334, 2026-06-24) — UI/feature batch + ENS `.eth` alt-DNS (post-beta.29, no bump; WORKING TREE ONLY)
Four items, no version bump, no tarball cut (awaiting Ken's go). **(F) 🔴 CRITICAL login/lock-session race** in
`apps/web/src/lib/stores/identity.ts`: `reset()` did an UNCONDITIONAL fire-and-forget disk-clear
(`clearKeystore()`+`clearPairedSession()`) that — because `$crypto/persistentKeystore` is loaded on every page —
actually ran on a normal REFRESH, wiping a "Remember Me" user to the import screen. Fixed with
`reset(opts?: { clearDisk?: boolean })` defaulting to in-memory-only; pagehide + idle-lock + the cross-tab
`storage`-event mirror call bare `reset()` (disk survives), only genuine sign-out paths pass `{ clearDisk: true }`.
Regression test added (identity 23 passed / 5 skipped). **(E)** 2FA settings page polish (discoverable `<details>`
summaries w/ hover+pointer, gradient h1, alphabetized recommended/not-recommended authenticator lists, link hover)
+ " (2FA)" on `settings.totp.heading` ×10 (WebAuthn copy untouched per Ken). **(C)** NEW `SignupProgress.svelte`
("Step X of Y", `role=progressbar`) wired through onboarding steps 1–3 + register-name 4/4 (importers excluded);
`onboarding.progress.step_label` ×10. **(D) ENS `.eth` feature wired end-to-end** — a registered, display-only
decentralized NAME (modeled on the I2P vanity name, NOT a hidden-service transport; footer/instances pills link to
`https://{name}.eth.limo`, no in-app resolution, pragmatic ASCII `.eth` regex). Touch-points: ops-cli
`altAddressValidate.ts` (`ENS_RE`/`isValidEnsName`/`validateEnsName`/`ENS_ENV_KEY`) + `altAddress.ts` managed slot
(`collectEns`, menu, dispatch) + init Step-10 `wantsEns` prompt + `render.ts` + `edit.ts` keep-current field;
indexer config zod (`MORPHIT_INSTANCE_ENS_NAME`→`instanceEnsName`) + `/v1/instance` + poller + federationProbe +
instancesStreamHelpers; `@morphit/indexer-client` (both alt_networks blocks); web instance store + `AltNetworkIcon`
(`+'ens'`→`/icons/icon-ens.svg`) + footer/instances ENS pills (`{#if ens}`-gated); `footer.ens` ×10 (dropped the
unused `footer.eth`); a per-locale ENS bullet in the `help_make_unstoppable` FAQ ×10. **Launch-blocker caught +
fixed:** `MORPHIT_INSTANCE_ENS_NAME` was MISSING from the `@morphit/operator-config` ALLOWLIST — a
`morphit.config.env` with it would HARD-ERROR at boot; now allowlisted. Smokes: alt-address-wizard +ENS cases
(57/57), api-response-shape `ens` (76), completeness allowlists `footer.ens` ×9, indexer
`federationProbeSelfBranding.test` mock+assertion `ens:null`. Env/docs: indexer.env.example, API.md, OPERATIONS.md
+ RUN-A-MORPHIT-NODE.md (alt-address ENS row/bullet, headers, init step-10). **ENS icon RESOLVED:** supplied
`icon-ens.svg` is all-white-fill, rendered via `<img>` like every alt-network icon; the app is dark-only (footer
`bg-ink-950`) so the white icon is visible, and it matches sibling `icon-i2p.svg` (also pure `#fff`) — optional aesthetic only. Gates: svelte-check 0/0; `tsc` clean for ops-cli/indexer/indexer-client/matrix-bot; alt-address-wizard
57/57; i18n parity 10/10 @ 3203 + completeness 4/4 + key-coverage 2/2 + hardcoded-english 1/1; api-response-shape
76; edit-smoke 18/18. NOT in-sandbox: indexer vitest + web vite build → CI; `indexer-config-boot-smoke` can't run
under bare tsx (`$config` path-alias unresolved — pre-existing, unrelated; indexer tsc covers the new zod field).
No release; working tree only.

### Session (cp333, 2026-06-24) — settings-screen UI + profile batch (post-beta.29, no bump)
Seven items against the settings screen plus one new profile field. (1) Avatar card moved up to sit directly
under the Blurt-account-name card (above Display name) — splice on the section comment markers. (2) Avatar
explainer trimmed (dropped the on-chain-storage sentence). (3) Display-name explainer trimmed (dropped
"You can change this at any time"). (4) Display-name "not unique" reminder: 💡 prefix on the title, removed the
`(BLT7gHu8mn…A9bb)` example from the body. (5) New two-line button legend above that reminder, and the two
buttons renamed to "Save locally only" / "Save & broadcast" (legend reuses the button-label keys so they can't
drift). (6) Auto-lock select already applied on change (no submit); added a transient green-check
"Changed to {label}" confirmation that clears on page unmount. (7) NEW optional Short Bio field (≤128 codepoints):
`validateShortBio` + `SHORT_BIO_MAX_LENGTH` in `$crypto/profile`; `short_bio` on `ProfilePayload` + `buildProfileBody`
(json_metadata, WIF-redacted); a Short Bio settings card on the local-save/broadcast model; threaded into all 5
`broadcastProfile` call sites; rendered on the account profile page under the hero. All copy in 10 locales
(+11 keys each, 6 edits each). Tests: +7 `validateShortBio` cases (crypto.test), +3 `short_bio` redaction cases
(ops.redaction.test). Gates: svelte-check 0/0; apps/web vitest 740/5-skip; full non-indexer battery ~6118
scenarios / 0 genuine failures (workspace-typecheck 13/13 + relay vitest 250/0 standalone; the two battery
timeouts are the aggregate meta-smokes at the 70s cap); i18n locale-parity 10/10 + completeness 4/4 + 2fa 9/9;
version-consistency 19/19 @ beta.29; registration-integrity 4/4. NOT in-sandbox: indexer vitest + web vite build
→ CI. No release; beta.30 candidate. FULL tarball `morphit-cp333-beta29-FULL-STATE.tar.gz`.

### Session (cp332, 2026-06-24) — beta.29 RELEASE CUT
Ken said go. Bumped all 19 version touchpoints beta.28→beta.29 (14 package.json + relay/indexer/mcp runtime
constants + docs/API.md + apps/indexer/README.md) via surgical per-line edits; synced package-lock.json
(`npm install --package-lock-only --ignore-scripts`; 15→beta.29; no audit). Wrote
`RELEASE-NOTES-v1.0.0-beta.29.md` (user-facing; no asset-count claims). The release bundles cp330 (keystore
hardening + CEK nonce fix + first 2FA round-trip coverage), cp331 (YubiKey transport 5-defect diagnosis +
fail-closed enroll-verify gate), and the post-beta.28 working-tree batch (14-task UI, AGPL FAQ, two-slot i2p,
voting power, RPC list UX, SW cache + snackbar fixes, ops-cli Tor-wipe fix). No code change beyond the bump +
notes. Gates green: version-consistency 19/19 @ beta.29 + RELEASE-NOTES present; release-notes-asset-count-parity
3/3; mediakit-freshness 7/7; llms-full-freshness 6/6; svelte-check 0/0; full non-indexer battery 6118 scenarios /
0 genuine failures (the two timeouts are workspace-typecheck + vitest-must-pass at the 70s runner cap, both green
standalone: workspace-typecheck 13/13, web vitest 730/5-skip, relay vitest 250/0); registration-integrity 4/4
(371/364). Still a BETA → Forgejo only; Basic-Auth gate stays up; nothing mirrored to Codeberg/IPFS; no
`morphit_release_v1` broadcast (the stable-public ceremony is separate and still pending). FULL tarball cut
(`morphit-cp332-beta29-FULL-STATE.tar.gz`).

### Session (cp331, 2026-06-24) — YubiKey transport re-diagnosis (FIVE defects, corrects cp330) + fail-closed enroll-verify gate
A fresh DEEP review of the cp330 handoff re-read `yubikey/transport.ts` against Yubico's `yubikey-personalization`
C source (`ykcore.c` `yk_write_to_key` / `yk_read_response_from_key` / `yk_wait_for_key_status`, `ykdef.h`).
cp330's "two framing bugs" count was **incomplete — there are FIVE defects, and cp330 missed the most
dangerous one.** SEND: (1) no 70-byte `YK_FRAME` (challenge `[0..63]`, slot cmd `[64]`, CRC16 of `[0..63]`
`[65..66]` LE, filler `[67..69]`) — raw chunks with a misplaced command byte and NO CRC16 → frame-CRC reject;
(2) wrong per-report seq/flag byte (must be `SLOT_WRITE_FLAG 0x80 | seq`). READ: **(3) `RESP_PENDING_FLAG (0x40)`
polarity INVERTED** — the key SETS 0x40 when data is READY and the host CLEARS it while draining; this code
waits-while-set / reads-when-clear (backwards) → reads status, not the HMAC. **This is the one cp330 missed,
and the one most likely to yield challenge-INDEPENDENT output.** (4) no response-sequence de-dup; (5) no device
reset (`0x8f`) after read. The transport is browser-only WebHID — cannot be run or safely rewritten in-sandbox,
so the full five-defect diagnosis + interim-gate rationale is now written into `transport.ts` (replacing the
misleading "narrow surface" comment) to set up the bench session.

**FIX — fail-closed enrollment-verification gate (all in `apps/web`, ZERO transport code changed).** Because
defect (3) most likely produces challenge-INDEPENDENT output, a naive single-tap enroll could silently commit a
wrap around a CONSTANT / zero-entropy response — a "2FA factor" unlockable by a known constant (security
theatre). `wrap.ts`: extracted a private `wrapCekWithResponse` build-core; `buildYubikeyWrap` delegates to it
(unchanged, 1 tap); ADDED `verifyYubikeyChallengeResponse(hmacFn)` (two DISTINCT challenges must yield DISTINCT
20-byte responses via constant-time `sodium.memcmp`; equal → throws `'YubiKey verification failed:
challenge-independent response'`) and `buildVerifiedYubikeyWrap` (verify → build-from-verified, 2 taps).
`keystoreYubikey.ts`: `enrollYubikey` calls the verified builder at BOTH enroll sites. `yubikeyErrors.ts`: new
`enroll_verify_failed` kind + classifier rule, routed to localized copy (10 locales × both error blocks). A
transport that can't prove real challenge-response simply can't enroll; the passphrase wrap is the escape hatch
so a user can never be locked out. **Design:** the 2-tap independence check catches the *dangerous*
constant/zero-entropy case; the residual (inconsistent-but-varying garbage → dead-but-not-hollow factor) is
bounded by the passphrase fallback and deferred to the hardware session.

**Verification.** NEW `yubikey-enroll-verify-smoke` 15/15 (correct stub passes + exactly 2 taps + round-trips;
constant / zero / dead / wrong-length all rejected with the right kinds; legacy single-tap `buildYubikeyWrap`
WOULD have accepted the constant — proving the closed gap; `enrollYubikey` end-to-end rejects a constant device).
`yubikey-error-classifier-smoke` 17 → 19. 10 locale files gained `enroll_verify_failed` in both
`settings.hardware_key.error` and `login.unlock.yubikey.error` (genuine translations; locale-parity 10/10,
translation-completeness 4/4). Battery 370 → 371. Gates: full non-indexer battery 4-chunk = 6118 scenarios /
0 genuine failures (only `workspace-typecheck` + `vitest-must-pass` timed out at the 70s runner cap — both
confirmed green standalone: workspace-typecheck 13/13, apps/web vitest 730/5-skip, relay vitest 250/0);
svelte-check 0/0; version-consistency 19/19 @ beta.28 (NO bump); registration-integrity 4/4 (371/364).
**NOT runnable in-sandbox:** indexer vitest + web `vite build` + `vitest-must-pass` (runs indexer vitest) —
Forgejo CI on push. **Remaining human gate (better set up now):** real-hardware enroll → reload → unlock +
fixing the five transport defects with the device in hand.

### Session 1 (cont., 2026-06-23) — #11a fixed + a CRITICAL latent keystore bug found & fixed
**Phase 1 (continued) — Bob's authenticated trading surfaces + chat/settings: all CLEAN.**
`orderbook` (1436): clean 3-phase machine (loading/ready/error) + retry + handled empty; filters
(side/asset/fiat/region/payment/minTrades/sort) all wired. `post` (2751): mature 6-phase machine
(editing→reviewing→awaiting_password→broadcasting→success/error) + draft persistence + per-field fee
validation + degraded-broadcast handling; `feeMethodChoice` matches the frozen enum. `my/orders` (896):
loading/ready/error + retry + empty/no-account CTAs. `chat` (529): corrupt-localStorage try/catch,
profile-fetch fallbacks, empty/error/load-error states. `settings` (2083): every handler has a catch.
**Drift check:** the `fee_method` enum shows ONLY the 4 frozen values (`blurt/waived_first_buy/btc/xmr`)
across the entire stack — no drift, no typos.

**#11a (/settings change-password) — FIXED; the prior diagnosis was partly wrong.**
The earlier REVISIT note claimed `decryptIdentity` throws `totp_required` for a 2FA envelope and that the
re-encrypt "drops 2FA". Reading the code: the TOTP gate is in `bootFromEnvelope` (unlock), NOT
`decryptIdentity`; and `totpSecret`/backup codes ride INSIDE the encrypted identity blob, so re-encrypting
preserves TOTP on either scheme — **TOTP-only 2FA survived a password change all along** (Ken's planned 2FA
test would have shown "works", masking the real bug). The real bug: a **`layered-cek`** envelope (YubiKey
enrolled + passphrase wrap) got re-encrypted via `encryptIdentity()` → `simple-passphrase` (no `wraps[]`),
**silently dropping the YubiKey unlock path.** FIX: new `rewrapLayeredPassphrase(env, oldPw, newPw)` in
`keystore.ts` rotates ONLY the passphrase wrap — recovers the CEK via the old passphrase, rebuilds the
passphrase wrap from the new one, carries the CEK + ciphertext + every yubikey wrap over byte-for-byte;
`changePassword` branches on `scheme === 'layered-cek'` to use it. Also bumped `MIN_NEW_PASSWORD_LENGTH`
8 → 10 to match the keystore floor (`encryptIdentity`/`buildPassphraseWrap` throw under 10; an 8–9 char pw
previously surfaced as a confusing generic `'internal'`). New regression smoke
`change-password-layered-rewrap-smoke` (8/8), registered in `run-smokes.sh`. svelte-check 0/0.

**🔴 CRITICAL — entire YubiKey / layered-cek keystore WRITE path was broken (`CEK_NONCE_BYTES = 12`). FIXED.**
Found while building the #11a smoke — the first code in the repo to exercise `encryptIdentityToCek` /
`buildPassphraseWrap` at runtime. They call libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305, **24-byte**
nonce) but generated a **12-byte** nonce from `CEK_NONCE_BYTES` (mislabeled in `yubikey/protocol.ts` as a
ChaCha20-Poly1305-IETF size). libsodium throws **"invalid nonce length"** → every YubiKey enrollment / layered
write threw at runtime. Unnoticed because that path needs a physical YubiKey and had ZERO automated coverage.
FIX: `CEK_NONCE_BYTES` 12 → **24** + corrected the comment. No migration concern (the write path always threw,
so no 12-byte envelope exists; readers use the stored nonce length). Verified by the #11a smoke's full
encrypt→decrypt round-trip and the whole crypto/keystore smoke cluster (all green). **Follow-up (same
session): added two smokes exercising the full crypto round-trips these 2FA mechanisms previously had ZERO
coverage for** — `yubikey-enroll-unlock-smoke` (7/7: real `enrollYubikey`→`unlockWithYubikey` with a
deterministic simulated HMAC-SHA1 device; identity recovered & matched across all four key roles, wrong key
rejected, passphrase still works) and `totp-2fa-enroll-verify-smoke` (7/7: real
`enrollTotp`→`verifyTotpOrBackup`, RFC-6238 codegen, backup-code redemption, and proves **TOTP survives a
password change**). Both registered. The only leg now untested in-sandbox is the literal physical HID
transport + touch (`yubikey/transport.ts`); the cryptographic core of both 2FA mechanisms is verified
end-to-end.


### Session 1 (2026-06-23) — battery baseline + 3 stale-smoke fixes + smoke type-health survey
**Phase 1 (personas) — started.** Bob (Blurt multi-login): `/login` (651 lines) read in full — CLEAN
(4 form modes, every button/field/state wired; typed KeystoreError dispatch, password cleared on every
branch, TOTP session-local rate-limit, YubiKey phase indicators, sign-out-before-switch ConfirmModal,
RTL/dark-safe). `/onboarding/import` (1205 lines): interactive elements + error surfacing scanned —
CLEAN (3 mode tabs seed/keyfile/posting-only, every error path maps to an i18n key — no user left
hanging; line 392 raw-err is an explicit `smoke-ok-raw-local` for regex-classification + console.warn,
NOT echoed to UI). Remaining Bob surfaces (authenticated: orderbook/post/my-orders/chat/settings) + the
other 4 personas: TODO.

**Cross-cutting anti-pattern sweep (whole tree).** Zero real TODO/FIXME (the 4 hits are `XXXX-XXXX`/
`\uXXXX` format-string comments). Zero raw `err.message`/`String(err)` echoed to UI state in web. The
1366 `console.*` hits are CLI tools (ops-cli/matrix-bot/indexer terminal output = their UI) + comments;
the 73 web-frontend `console.warn/error` are bracketed dev diagnostics (not telemetry, not user-data) —
acceptable.

**Full smoke battery (367 runners / ~8,364 scenarios) — run in 3 chunks; found + FIXED 3 stale smokes,
all from THIS session's earlier work not propagating:**
1. 🟢 `href-xss-smoke` — the explorer-link lang-prefix fix added 3 `href={url ? lp(url) : '#'}` bindings
   the XSS smoke didn't allowlist (block page prevUrl+txUrl, tx page blockUrl). VERIFIED safe (all
   `{@const}` from validated `morphitExplorer{Block,Tx}Url()` — block validates finite positive int, tx
   validates BLURT_TRXID_RE — wrapped in `lp()` SAFE_BUILDER, '#' fallback; identical profile to the
   existing allowlisted account-page entry). Added 2 new `ALLOWLIST_HREF_EXPR` entries with full safety
   rationale. 1/1.
2. 🟢 `init-smoke` — the i2p two-slot refactor (`AltNetworkResult.i2p` → `i2pB32`+`i2pName`) updated the
   WIZARD smoke but left init-smoke on the old `i2p` shape (runtime assertion failed: expected legacy
   `MORPHIT_INSTANCE_I2P_ADDRESS`). Fixed the fixture + strengthened the scenario to exercise BOTH slots
   (asserts `_I2P_B32_ADDRESS` + `_I2P_NAME_ADDRESS`, and NO legacy `_I2P_ADDRESS`). Drift-swept ops-cli
   for other stale `.i2p` — remaining hits are intentional network-name keys in the `alt-address`
   command's lookup maps (with documented legacy `_I2P_ADDRESS` read-fallback), NOT the dropped field.
   PLUS fixed 2 more latent stale fields in the same fixture (caught via the typecheck survey below):
   `chatLinkExplorers` was missing `dcr/sol/eth/xrp` (vs `ChatLinkExplorersResult`); `listingFee` was
   missing `denominationFiat` (vs `ListingFeeResult`). 51/51.
3. 🟢 `cross-tab-signout-propagation-smoke` — scenario #8 enforced the explicit Sign Out button calls
   `broadcastSignOut()` (not bare reset, for cross-tab propagation) but inspected the SETTINGS page whose
   button #11b removed. VERIFIED not a real bug: `AvatarMenu.confirmSignOut` (line 191) correctly calls
   `broadcastSignOut()`, and login's confirmSwitch too — propagation intact, only the site moved
   settings→avatar. Repointed the smoke (constant/read/scenario #8/header doc) to `AvatarMenu.svelte`.
   8/8.
Post-fix chunk results: [1-130] 3270 scenarios / 0 fail; [131-260] 2673 / 0; [261-367] 2421 / 0.
**Full battery GREEN.** All 3 were exactly the "updated/outdated smokes + drift" class.

**Phase 2/J — GATE GAP found + analyzed (recommendation, NOT fixed): smokes are never typechecked.**
ops-cli `tsconfig.json` `include` is `["src/**/*.ts","test/**/*.ts"]` (excludes `scripts/`); web
`tsconfig.json` include is `src/**`+`tests/**` (excludes `scripts/`); `tsconfig.smoke.json` is a RUN-only
config for `tsx` (esbuild, no typecheck — no `include`/`allowImportingTsExtensions`/`noEmit`). So NO gate
typechecks any smoke — which is how init-smoke's 3 stale fields all slipped. Built a temp
`tsconfig.smoke-check.json` (extends smoke + allowImportingTsExtensions + noEmit + all `*/scripts/**`)
and ran `tsc`: 253 errors across ~30 smokes — BUT after isolating them, the overwhelming majority are
(a) harness-batch artifacts (cross-file `scenarios`/`failed` "cannot redeclare" + `.push`/`.ok`/`.detail`
on `Scenario` — each smoke runs in ISOLATION under tsx, so invalid when batched into one tsc program),
and (b) discriminated-union access without narrowing (e.g. `r.reason` on `ReleaseValidateResult` /
`HandlerResult` / `WifDecodeVerdict` / rate-limit unions before checking `!r.ok`/`!r.allowed`) — the
property exists on the right branch, so every one of these smokes PASSES at runtime. Spot-confirmed
`EligibilityResult`'s `missingLoyaltyBlurt`/`daysUntilEligible` live on the Fail branch (real, not
stale). VERDICT: a smoke-typecheck gate would mean ~253 low-value narrowing edits to passing smokes; not
worth the churn. The runtime battery is the real gate and it catches the drift that matters (init-smoke
went red because its drift caused a runtime failure; these don't). Temp config deleted; tree clean. If
ever desired, the cheap version is per-file `tsc` (matches tsx isolation, kills the harness-batch false
positives) — logged for a future J pass.

### Campaign setup
Created this tracker. Surveyed scope (6 apps + 7 packages; 45 routes, 77 components, 197 web lib .ts, 367
smoke runners, 70 docs). Inventoried 17 indexer handlers + 18 on-chain op types for the Phase-3 hostile-op
sweep.
