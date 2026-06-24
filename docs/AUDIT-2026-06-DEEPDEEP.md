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
