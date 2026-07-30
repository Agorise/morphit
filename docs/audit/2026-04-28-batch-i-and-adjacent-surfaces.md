# Morphit security & code audit — login, keys, pairing, YubiKey

**Date**: 2026-04-28
**Scope**: Batch I (YubiKey unlock) + login page, signup, mobile login, QR-pair flow, WIF import, key handling, chain interaction surfaces.
**Approach**: STRIDE matrix → attack-tree → per-handler hostile-input sweep → chain-direct re-pass.
**Auditor**: Claude (collaborative, with the maintainer driving threat-priority).

This report flags every issue I found, regardless of severity. The maintainer should triage which to fix before launch and which to file as backlog. I've graded each finding from CRITICAL down to NIT.

Severity scale used:

- **CRITICAL** — would let an attacker steal funds from a typical user with realistic effort.
- **HIGH** — meaningfully weakens a security claim (degrades to "lucky timing required" or "specific user behavior required") OR breaks a stated security property.
- **MEDIUM** — exploitable in specific scenarios, but the attacker either needs significant pre-conditions or only achieves DoS / confusion.
- **LOW** — defense-in-depth gap, minor UX/safety issue, or theoretical concern with no known practical attack.
- **NIT** — code-quality / non-security observation.

---

## Critical findings

**None.** I did not find a path that lets a typical attacker steal funds from a typical user with realistic effort. The architectural choices (live-key tier, JIT unlock for active/owner, Argon2id KDF, AEAD with poly1305 tag, cross-tab storage event handling) are sound. The attack surfaces below are real but each has guardrails that prevent the worst outcomes.

---

## High findings

### H1. QR-pair: phone-side fingerprint never compared before keystore upload

**Location**: `apps/web/src/routes/pair/+page.svelte` — `confirmPairing` and `performPairing`.

**Vulnerability**: When a user scans a QR (or follows a deep-link), the mobile flow currently goes:

1. Parse n + k from URL/QR.
2. Show "Pair this device with desktop?" confirmation.
3. User clicks confirm → enters passphrase → keystore is encrypted to `desktopEpkPub` (which came from the QR) → uploaded to indexer.
4. Fingerprint shown on phone AFTER upload.
5. User compares phone fingerprint to desktop fingerprint.

**Step 4 is too late.** If an attacker substituted the QR (browser-extension DOM injection on desktop, shoulder-surfer holding up their own phone, screen-recording malware, etc.), the user's phone has uploaded the keystore encrypted to the attacker's `epkPub` BEFORE the fingerprint check. The attacker's separate desktop polls the indexer and gets the package; the user's real desktop never receives anything and shows "expired."

**Crucially, the user has no real-desktop fingerprint to compare to** — the real desktop didn't receive a package, so it didn't display a fingerprint. The phone's fingerprint comparison is moot when there's nothing to compare against.

The 8-digit fingerprint length (~26.6 bits) was the wrong bandaid for this gap. Length doesn't matter when only one side has a fingerprint to display.

**Severity**: HIGH. Realistic attack: malicious browser extension injects an alternate QR over the desktop QR. User scans, exposes keystore.

**Recommended fix**: Show the fingerprint on the phone IMMEDIATELY after parsing n + k, BEFORE any keystore decryption or upload. Wording: "On your desktop, you should see this same code: XX-XX-XXXX. If it doesn't match, cancel now." This requires the desktop to display its OWN computed fingerprint of (pairingNonce, desktopEpkPub, _) before the phone uploads — but the desktop doesn't know phoneEpkPub yet. So compute the desktop-side fingerprint as `H(pairingNonce || desktopEpkPub)` (without phoneEpkPub) and have the phone display the same `H(pairingNonce || desktopEpkPub)` after parsing the QR. Match → proceed. Mismatch → abandon.

This is a wire-format change: bump `PAIR_PROTOCOL_VERSION` to 2, document the new fingerprint computation in ADR-0016. Backward compatibility: v=1 phones will refuse to pair with v=2 desktops and vice versa; that's the right behavior because the security property changed.

---

### H2. WebHID YubiKey transport unverified against real hardware

**Location**: `apps/web/src/lib/crypto/yubikey/transport.ts`.

**Vulnerability**: The HID feature-report frame layout was written from public Yubico documentation but has not been live-fired against a physical YubiKey. Specific concerns:

1. The per-frame "sequence/flag byte" (last byte of each 8-byte report) is encoded as `cmd | 0x80` on the final frame and bare `frame_index` on intermediate frames. Yubico's `yubikey-personalization` C library uses a different encoding (`SLOT_WRITE_FLAG | seq` for ALL frames, with the slot command communicated via a separate mechanism).
2. The response-poll loop reads feature reports and treats bytes 0-6 as response data, byte 7 as status. In Yubico's protocol, response delivery may require an explicit "read response" command first, not just polling.
3. Edge cases (the YubiKey returning a CRC failure, the slot being mis-configured, the device being a YubiKey 5 NFC vs a YubiKey Bio with different applet behavior) are not exercised.

**Implication**: If the framing is wrong, the YubiKey will produce HMAC-SHA1 outputs of garbage challenges. The cryptographic strength is intact (HMAC-SHA1 of a deterministic-by-frame-corruption challenge is still HMAC-SHA1 of SOMETHING), but the security claim "the YubiKey computes HMAC of the user-chosen 64-byte challenge" is technically wrong — the YubiKey computes HMAC of the bytes it actually received, which may be partial garbage.

This produces wraps that decrypt successfully on subsequent unlocks (because the same garbage-prompted output is reproducible), so the system APPEARS to work in a single-device test. The failure mode isn't "doesn't work"; it's "works wrongly, with weakened assurance."

**Severity**: HIGH. The probe page (Part A) makes this verifiable. Until the probe shows MATCH against a real YubiKey + the user's known slot secret, this batch should not ship.

**Recommended fix**: Run the probe against a real YubiKey. If MISMATCH, rewrite transport.ts following `yubikey-personalization/ykcore/ykcore.c` line-by-line. If MATCH, add a smoke test that captures the byte log from the probe and asserts it matches a recorded golden trace.

---

### H3. Layered keystore: passphrase-path skips structural validation, enabling DoS

**Location**: `apps/web/src/lib/crypto/keystore.ts` — `decryptIdentity` → `decryptLayeredWithPassphrase` → `recoverCekViaPassphrase`.

**Vulnerability**: `recoverCekViaPassphrase` filters wraps to `'passphrase'` kind and iterates each, running Argon2id per wrap. **It does not call `validateLayeredEnvelope` before iterating.** A hostile envelope (planted in localStorage by a malicious extension or cross-origin XSS that lands in another tab) with 1000 passphrase wraps causes 1000 × ~0.5s Argon2id derivations on each unlock attempt = 500-second hang.

The layered envelope's `wraps` array has no upper bound enforced in this path. (The `enrollYubikey` path enforces `MAX_YUBIKEY_WRAPS` but that's a different path.)

**Severity**: HIGH (DoS vector that requires only adversarial localStorage write).

**Recommended fix**: Call `validateLayeredEnvelope(env)` at the very top of `decryptIdentity` for layered envelopes, before any wrap iteration. The function already enforces `wraps.length > MAX_YUBIKEY_WRAPS + 1` rejection. Add similar checks to all entry points that consume a layered envelope structurally.

---

## Medium findings

### M1. unlockWithYubikey: multi-yubikey envelopes prompt N taps

**Location**: `apps/web/src/lib/crypto/keystoreYubikey.ts` — `unlockWithYubikey`.

**Vulnerability**: With N enrolled YubiKeys on one keystore (max 4), the function loops through each yubikey wrap, calling `hmacFn` on each. The user is prompted to tap their YubiKey for EACH wrap until one decrypts successfully. If the user has key #4 plugged in and the loop tries wraps 1, 2, 3 first, the user taps four times and waits 30 seconds × 3 timeout for the failed ones.

**Severity**: MEDIUM (UX), with a side-channel concern: the order of taps reveals which key was used.

**Recommended fix**: Two options:
- **Simpler**: prompt the user to pick which enrolled YubiKey they're presenting (display labels). Try only that wrap.
- **Cleaner**: bind the YubiKey's HID descriptor (productName + serial) to each wrap at enrollment time, then at unlock time match the connected YubiKey to the right wrap before calling hmacFn. Only one tap.

Both require UI changes. The simpler fix is roughly a 1-day item.

---

### M2. WebHID HMAC has no domain binding (intrinsic to YubiKey HMAC slots)

**Location**: WebHID YubiKey HMAC challenge-response is a property of the YubiKey itself, not Morphit code.

**Vulnerability**: Unlike WebAuthn, YubiKey's HMAC-SHA1 slot does not bind responses to the requesting site's origin. If a user visits `evil-morphit.com` and grants WebHID permission to their YubiKey, the malicious site can request `HMAC-SHA1(slot_secret, X)` for any challenge X. The YubiKey computes and returns it, with or without touch (depending on slot configuration).

This means: if an attacker has the user's encrypted keystore (e.g., leaked localStorage backup), AND the user can be tricked into visiting a malicious site that requests their YubiKey's HMAC for the challenge embedded in the keystore wrap, the attacker recovers the wrap key.

This is the same property KeePassXC and age-yubikey have. It's intrinsic to using HMAC slots; the alternative (WebAuthn) doesn't fit the secp256k1 constraint.

**Severity**: MEDIUM. Exploitable but requires specific user behavior (visiting a malicious site, granting WebHID permission, tapping the YubiKey on the malicious site's prompt).

**Recommended fix**: User education in the Settings → Hardware key card. Add a warning panel: "Only tap your YubiKey when you're certain you're on the real Morphit. A malicious site that gets you to tap can compute responses against your slot — if they also have your encrypted keystore, that lets them unlock it. This is how all HMAC-based hardware keys work, including KeePassXC and age-yubikey."

Optionally: configure the slot with "require touch" by default in setup instructions. The touch isn't a security boundary against a determined phisher but it's a friction-of-mistake mitigation.

---

### M3. Indexer pair-package signature doesn't cover `account` field

**Location**: `apps/web/src/lib/pair/crypto.ts` — `pairSignatureDigest`.

**Vulnerability**: The signature digest is computed over `pairingNonce || desktopEpkPub || phoneEpkPub || symmetricNonce || ciphertext`. The `account` field is NOT included. A hostile indexer (or a network attacker controlling the relay) could substitute a different account name in the response.

The desktop's verification flow:
1. Receive `pkg = { v, ephemeral_pub, nonce, ciphertext, account, signature }`.
2. Fetch `account.posting.key_auths[0]` from chain RPC.
3. Verify signature against that pub.

If indexer swaps `account` from "alice" to "bob", the desktop fetches bob's posting key. Signature verification uses bob's pubkey. The signature was created by alice, so verification FAILS. **Defended by chain.** ✓ in the practical sense.

But: the failure-mode is wrong. The user typed nothing; the phone signed; the desktop displays an error. A more meaningful failure would be "account name mismatch" not "invalid signature."

There's also a theoretical concern: if alice and bob shared posting keys (impossible by chain consensus, but if a chain RPC LIES about bob's posting key matching alice's, the signature might verify on the lie). Then the desktop displays "Paired as: bob" but the keystore is actually alice's. Confusion attack at best, but the keystore is the user's correctly.

**Severity**: MEDIUM (confusion only; no key compromise).

**Recommended fix**: Include `account` in `pairSignatureDigest`. Bump `PAIR_PROTOCOL_VERSION` to 2. Backward incompatibility: v=1 desktops can't verify v=2 packages and vice versa.

---

### M4. KDF parameter floor is too generous

**Location**: `apps/web/src/lib/crypto/keystore.ts` — `MIN_KDF_OPSLIMIT = 1`, `MIN_KDF_MEMLIMIT = 1 << 20` (1 MB).

**Vulnerability**: The floor accepts envelopes claiming `opslimit=1, memlimit=1MB`. An attacker who can write to localStorage can plant such an envelope. Today the decrypt path uses `argonParams()` (libsodium INTERACTIVE = ~64MB / ops=2), so the stored params are advisory. **But** if a future code change ever honors stored params (e.g., per-envelope KDF strength upgrade), the floor permits an attacker-tampered envelope to be brute-forced ~6000× faster.

The current code comment acknowledges this: "Today the decrypt path uses argonParams() ... so the envelope's stored values are only an audit aid. But a future code change that honored the envelope's params would silently accept an attacker-tampered envelope with ops=1 mem=8K."

**Severity**: MEDIUM (latent — only triggers on a future change).

**Recommended fix**: Tighten the floor to libsodium's INTERACTIVE values (`ops=2, mem=64MB` typical) so the floor and the actual decrypt-time params match. If the floor accepts INTERACTIVE, and decrypt uses INTERACTIVE, no future drift can introduce a downgrade by accident.

---

### M5. Onboarding mnemonic string is in DOM during display

**Location**: `apps/web/src/routes/onboarding/+page.svelte` — `seedWords` derived from `mnemonicForBackup(full)`.

**Vulnerability**: K1.2 acknowledged this as the residual surface. The mnemonic string lives in JS-engine heap from the moment `mnemonicForBackup` is called until the page unmounts. After unmount it's GC-eligible but not guaranteed to be reclaimed promptly.

A browser extension or memory-dumping malware that snapshots the heap during the "review" stage gets the mnemonic in plaintext.

**Severity**: MEDIUM (specific window — during onboarding only — and requires malicious-extension-class capability).

**Recommended fix**: There's no perfect fix because the user has to read the mnemonic. Mitigations:
- Render the mnemonic as individual word elements rather than a single concatenated string. Each word survives independently in heap; recovering the order requires DOM-walking, not just a string-search of the heap. Modest improvement but real.
- Auto-clear the page after a configurable period (e.g., 5 minutes idle).
- Recommend Private/Incognito browsing mode for onboarding.

---

### M6. Storage-event handler trusts cross-tab envelope unconditionally

**Location**: `apps/web/src/lib/stores/identity.ts` — `window.addEventListener('storage', ...)`.

**Vulnerability**: When another tab writes to the keystore localStorage key, our tab parses the new value and calls `updateEnvelope`. The next JIT-unlock (`useActiveKey`) then uses this envelope.

A successful XSS in a different same-origin tab could write a hostile envelope. Our tab swaps to it. **The user's password no longer decrypts (unless attacker happens to know it).** So the next active-key op fails with "wrong password" — confusing but not fund-stealing.

If the attacker DID know the password (game-over scenario), they could plant an envelope decrypting to their own identity. User signs ops with the attacker's keys. Since on-chain signatures don't match the user's account, ops fail. Confusion attack.

**Severity**: MEDIUM (no fund theft, but UX-corrupting in a hostile-tab scenario).

**Recommended fix**: When receiving a storage event, the new envelope should be structurally validated AND its decryption tested (at least the AEAD tag check) before swapping. If the user is currently unlocked, also verify the new envelope decrypts to the SAME public-key set as the live identity. If pubkeys differ, treat as adversarial, ignore the event, surface a UI warning.

---

### M7. Unbounded passphrase wraps in layered envelope

**Location**: `apps/web/src/lib/crypto/keystore.ts` — `validateLayeredEnvelope`.

**Vulnerability**: The cap is `MAX_YUBIKEY_WRAPS + 1` (= 5). This allows 1 passphrase + 4 yubikey, OR 5 passphrase, OR any mix. Multiple passphrase wraps shouldn't legitimately occur (the API only ever creates one passphrase wrap per envelope). An attacker-tampered envelope could use 5 passphrase wraps to slow unlock by 5×.

**Severity**: LOW-MEDIUM (mild DoS; doesn't enable theft).

**Recommended fix**: Tighten the validator to `passphraseWraps.length ≤ 1 && yubikeyWraps.length ≤ MAX_YUBIKEY_WRAPS`. Combined with H3's fix, this caps unlock worst-case at 1 Argon2id derivation.

---

### M8. enrollYubikey: writeEnvelope failure silently ignored

**Location**: `apps/web/src/lib/components/HardwareKeyCard.svelte` — `doEnroll`.

**Vulnerability**: After successful enrollment:
```ts
writeEnvelope(newEnv);    // returns void; safeStorage.set returned bool but ignored
await bootFromEnvelope(newEnv, enrollPassword);
showToast({ kind: 'success', text: ... });
```

If `writeEnvelope` failed (localStorage quota, private mode, disabled), the in-memory `bootFromEnvelope` succeeds, the toast shows "YubiKey enrolled", but on next page reload the envelope is the OLD one without the YubiKey wrap. The user thinks enrollment persisted; it didn't.

**Severity**: MEDIUM (UX bug with security implications: if the user later hardens to YubiKey-only based on a believed enrollment, then reloads to find no enrollment, they might be locked out).

**Recommended fix**: Make `writeEnvelope` return a boolean. Check it. If false, surface "couldn't save enrollment to this device" error instead of success toast. Same fix applies to `doRemoveKey`, `doHarden`, `doSoften`, and the equivalent paths in onboarding.

---

## Low findings

### L1. WIF input field leaves WIF string in DOM/heap

**Location**: `apps/web/src/routes/onboarding/import/+page.svelte` — `postingWif` binding.

The WIF is held as a JS string until form unmount. Same K1.2 class as the mnemonic. Mitigated for the BIP-39 mnemonic (stored as bytes); not mitigated for the WIF.

**Severity**: LOW (the user just typed it; they have it elsewhere).

**Recommended fix**: After successful import, set `postingWif = ''` and trust the GC to eventually reclaim. Already done in the wrong-role / not-found error paths. ✓ — but on the success path, the form unmounts (navigation), so the binding is cleared by Svelte. Actually OK; this isn't a residual.

Actually wait, looking again: the success path navigates to `/orderbook`, the form unmounts, the `postingWif` binding is unrooted. The string is GC-eligible. Standard JS string lifecycle. Same as any password input. Acknowledge as a known JS-engine limitation; not a Morphit-specific issue.

**Resolution**: NOT A BUG. Withdraw.

### L2. WIF decoder doesn't reject scalars ≥ secp256k1 order

**Location**: `apps/web/src/lib/crypto/base58.ts` — `wifDecodePure`.

Validates non-zero scalar but not "scalar < curve order." A maliciously-constructed WIF could decode to a value ≥ N. `secp256k1.getPublicKey(scalar)` would either throw or produce a malformed point. Subsequent on-chain ops would fail.

**Severity**: LOW (chance of legitimate WIF being ≥ N is ~2⁻¹²⁸; intentional construction by attacker = DoS only because chain rejects).

**Recommended fix**: Add `secp256k1.utils.isValidPrivateKey(scalar)` check before returning. The wif-smoke covers most edge cases; add a scenario for this.

### L3. requestYubikey accepts any slot value at runtime

**Location**: `apps/web/src/lib/crypto/yubikey/transport.ts` — `makeHmacFn`.

```ts
const cmd = slot === 1 ? CMD_HMAC_SLOT_1 : CMD_HMAC_SLOT_2;
```

If a hostile caller passes `slot = 99`, falls through to slot 2 silently. TypeScript prevents this at compile-time but runtime values from JSON-parsed envelopes aren't type-checked.

**Severity**: LOW.

**Recommended fix**: `if (slot !== 1 && slot !== 2) throw new Error(...)` at function entry. Same in `validateLayeredEnvelope` for stored wraps.

### L4. Indexer pair relay has no rate-limit

**Location**: `apps/indexer/src/api/pair.ts`.

The 256 in-flight cap protects memory but doesn't rate-limit per-IP. An attacker can rapidly POST and GET to fill the slot, drain it, fill again, eating bandwidth.

**Severity**: LOW (DoS only, easily mitigated at nginx layer).

**Recommended fix**: Document that the relay is supposed to sit behind nginx with rate limits per source-IP. Not a code issue per se.

### L5. Login error messages can fingerprint envelope schema

**Location**: `apps/web/src/routes/login/+page.svelte` — `handleUnlock` catch block.

```ts
if (err instanceof Error && /decrypt|auth|tag|integrity/i.test(err.message)) {
    errorMsg = $_('login.unlock.wrong_password');
} else {
    errorMsg = err instanceof Error ? err.message : String(err);
}
```

The else branch surfaces the underlying error message verbatim. For a hostile envelope, this could leak structural details ("Layered envelope must have at least one wrap", "Unsupported keystore version: 2", etc.).

**Severity**: LOW (signal-leakage to a local attacker who already has localStorage write access; they already know everything).

**Recommended fix**: Whitelist the small set of error categories the login path should surface; for everything else, show a generic "couldn't unlock — keystore may be corrupted." Log the raw error to console.error for debugging but don't expose to UI.

### L6. Pair desktop's `receivedTransitPassword` lingers as string

**Location**: `apps/web/src/routes/pair/desktop/+page.svelte` — `receivedTransitPassword`.

Set during `handleReceivedPackage`, used during `finalize`. Between those two events, the user is choosing a new passphrase. The transit password sits in component state as a JS string. After `finalize` the variable is set to null but the original string is GC-eligible.

K1.2 class. Random hex string but it can be used to decrypt the transit envelope, which is in `receivedEnvelope`.

**Severity**: LOW (window is short, requires concurrent memory access).

**Recommended fix**: Could store as Uint8Array bytes (32 random bytes) and pass through `decryptIdentity`'s handling. But `decryptIdentity` takes a string. Would require an overload. Tracking as a backlog item rather than a fix-now.

### L7. Settings → Remove key has no confirmation

**Location**: `apps/web/src/lib/components/HardwareKeyCard.svelte` — `doRemoveKey`.

Click → immediately writes new envelope. A misclick removes a wrap. Recoverable by re-enrollment (assuming still in state A) but slightly hostile UX.

**Severity**: LOW (UX, not security).

**Recommended fix**: Add a `ConfirmModal` ("Remove `{label}`? You'll need to re-enroll if you want to use it again.").

### L8. Pair phone parses URL but doesn't cap total URL length

**Location**: `apps/web/src/routes/pair/+page.svelte` — `parsePairUrl`.

`new URL(url)` works on arbitrarily long inputs. A 1MB URL would parse, then the n + k decoders run on potentially-large strings (which then fail the length check). Memory burst before rejection.

**Severity**: LOW.

**Recommended fix**: Cap URL length at 4096 bytes before passing to `URL()`.

### L9. Layered envelope: structural validation doesn't check yubikey wrap fields

**Location**: `apps/web/src/lib/crypto/keystore.ts` — `validateLayeredEnvelope`.

Validates `kdfParams` but not `slot`, `challenge` length, `schemaVersion`, etc. on yubikey wraps. `recoverCekFromYubikey` does these checks per-call, but a hostile envelope could mix valid passphrase wraps with garbage yubikey wraps and the validator wouldn't reject.

**Severity**: LOW (downstream consumers eventually error out, no compromise).

**Recommended fix**: Move the per-wrap checks into `validateLayeredEnvelope` so the validator is the canonical structural gate.

### L10. Posting-only verifyPostingKey trusts BlurtAccount shape

**Location**: `apps/web/src/lib/crypto/postingVerify.ts` — `hasKey`.

```ts
function hasKey(auth: { key_auths: Array<[string, number]> }, ...) {
    for (const [k, w] of auth.key_auths) { ... }
}
```

If `auth.key_auths` is not an array (hostile RPC), `for...of` errors. Not a security issue (DoS only) but the type assumption is implicit.

**Severity**: LOW.

**Recommended fix**: `if (!Array.isArray(auth.key_auths)) return false;` at function entry.

### L11. Password unicode normalization not specified

**Location**: `apps/web/src/lib/crypto/keystore.ts` — `deriveKey`.

Argon2id treats the password input as bytes. A user typing the same password on Mac (NFD) vs Windows (NFC) could produce different bytes for accented characters. Decryption fails.

**Severity**: LOW (UX for international users; would surface as "wrong password" mysteriously).

**Recommended fix**: Apply `password.normalize('NFC')` before passing to Argon2id. Document in onboarding ("password is treated as Unicode NFC"). Adds slight friction for users who already chose passwords without normalization, but: any password chosen via the form is NFC-normalized at input time by most browsers, so the practical impact is small.

### L12. Login page `errorMsg` exposes raw transport errors on YubiKey path

**Location**: `apps/web/src/routes/login/+page.svelte` — `handleUnlockYubikey` catch block has whitelist; OK.

Actually this is fine. ✓

### L13. Pair desktop polls `/v1/pair/:nonce` without origin verification

**Location**: `apps/web/src/routes/pair/desktop/+page.svelte` — `startPolling`.

Uses `resolveOrigin(MORPHIT_INDEXER_ORIGIN)` for the indexer URL. If `MORPHIT_INDEXER_ORIGIN` is misconfigured (or attacker-controlled in a self-hosted instance), the desktop polls the attacker's relay. This is the standard "the indexer is trusted" assumption.

**Severity**: LOW (configuration issue, not code).

**Recommended fix**: None — explicit by design.

### L14. recoverCekViaPassphrase's "try each passphrase wrap" may leak timing

**Location**: `apps/web/src/lib/crypto/keystore.ts` — `recoverCekViaPassphrase`.

The loop tries each passphrase wrap, returning the first that decrypts. Argon2id timing per wrap is constant ~0.5s, but the loop length depends on which wrap matches. An attacker who can repeatedly trigger an unlock attempt with their guesses can use response-time to learn how many passphrase wraps are present.

**Severity**: LOW (low-information leak).

**Recommended fix**: With L7's tightening (max 1 passphrase wrap), this is moot.

### L15. localStorage envelope corruption silently wiped on read

**Location**: `apps/web/src/lib/crypto/persistentKeystore.ts` — `readEnvelope`.

If JSON.parse fails, the envelope is REMOVED from localStorage:
```ts
} catch {
    safeLocal.remove(ENVELOPE_KEY);
    return null;
}
```

This means a transient read corruption (storage glitch, encoding hiccup) destroys the user's persisted keystore. If the user only had this device's keystore (no seed-phrase backup), they're locked out.

**Severity**: LOW (rare but catastrophic when it happens).

**Recommended fix**: On parse failure, leave the envelope alone. Surface the error to the login page so the user can investigate. Don't auto-wipe.

### L16. transport.ts lacks USB lock recovery

**Location**: `apps/web/src/lib/crypto/yubikey/transport.ts` — `requestYubikey`.

If a previous `device.close()` failed (Chromium occasionally retains an exclusive lock), the next `device.open()` fails with `open-failed`. Surfaced to user as "couldn't open the YubiKey." The user has no UI hint that they need to refresh / disconnect.

**Severity**: LOW (UX/recovery).

**Recommended fix**: On `open-failed`, hint at "try unplugging and re-plugging your YubiKey." Add to error-message.

---

## Nits / observations

### N1. Comment in identity.ts mentions AES-GCM; we use ChaCha20-Poly1305

`apps/web/src/routes/login/+page.svelte` line 98:
```ts
// decryptIdentity throws on bad password (invalid auth tag
// on the AES-GCM ciphertext).
```

Actually it's XSalsa20-Poly1305 (libsodium `secretbox`). Misleading comment.

### N2. ADR-0017 claims "non-destructive" upgrade; verify

The ADR says pre-Batch-I keystores remain valid. Verify by:
1. Build a simple-passphrase envelope in v=1 with no `scheme` field.
2. Run through Batch I's `decryptIdentity`.
3. Confirm it decrypts and produces the same identity.

Add as a smoke if not already covered.

### N3. The probe page is at /dev/yubikey-probe with `<meta robots noindex>` but is publicly accessible

Anyone who knows the path can hit it. The probe doesn't touch the keystore; the worst impact is exposing a slot's HMAC outputs to a curious user (who'd need to plug their YubiKey in voluntarily). Acceptable.

If you'd prefer to hide it, add a build-time flag that only includes the route in dev builds (`if (!import.meta.env.DEV) return null` at the top of the page). But there's a real argument for keeping it: a user reporting a YubiKey issue can use the probe to provide a byte log to support without exposing keys.

### N4. ADR-0016 "8-digit fingerprint defeats brute force" is a cleaner claim than reality

Per H1, the fingerprint comparison is moot when the attack substitutes the QR entirely (the user has no real-desktop fingerprint to compare). The "defeats brute force" claim is true for the specific scenario of a passive attacker who guesses ephemeral pubs to match a fingerprint, but that's not the primary threat. ADR should be updated.

### N5. Smoke for yubikey-protocol covers structure but not crypto round-trip

The smoke (22 scenarios) covers protocol-level invariants. It does not exercise:
- Actual Argon2id derivation correctness.
- AEAD round-trip (encrypt → decrypt produces same plaintext).
- Reading + writing layered envelopes.

These would need libsodium in the sandbox, which isn't available. Document the coverage gap explicitly.

### N6. Login page imports ordering

The `bootFromEnvelopeWithYubikey` import in the login page pulls in `keystoreYubikey.ts` (and transitively `wrap.ts`, `transport.ts`) on every login. These are ~20 KB minified gzipped. For users who never enroll a YubiKey, this is wasted bytes.

`bootFromEnvelopeWithYubikey` already lazy-imports `keystoreYubikey` internally, so the only static import cost is `bootFromEnvelopeWithYubikey` itself, which is small. ✓ already done.

### N7. The hardening confirm checkbox in HardwareKeyCard is the only check

The user could check the box accidentally (single click), then click the button. Two-click confirmation is better for irrecoverable actions ("Type 'harden' to confirm").

### N8. ADR-0017's threat model T2 claims state B defeats phishing

> State B: attacker has only the passphrase, which doesn't decrypt anything. YubiKey unwrap is the only path. This is the security win of (B).

True in the strict sense, but **if the user is in state B and gets phished onto a malicious site that asks for their YubiKey HMAC against the keystore's challenge** (M2), the attack still works. The wording in ADR-0017 should acknowledge this nuance.

---

## STRIDE matrix summary

(Components: simple-passphrase keystore | layered-cek keystore | yubikey wrap | webhid transport | pair flow | persistent-keystore | identity store)

```
                       │ S │ T │ R │ I │ D │ E │
─────────────────────────┼───┼───┼───┼───┼───┼───┼
simple-passphrase keystore │ ✓ │ ✓ │ - │ ⚠L│ ✓ │ ✓ │
layered-cek keystore       │ ⚠H3│⚠H3│ - │ ⚠ │ ⚠H3│⚠ │
yubikey wrap               │ ⚠M2│ ✓ │ - │ ⚠ │ ⚠ │ ✓ │
webhid transport           │ ⚠ │ ❌H2│ - │ ⚠ │ ⚠ │ ⚠ │
pair flow                  │ ⚠H1│⚠M3│⚠L4│ ⚠ │ ✓ │ ⚠ │
persistent-keystore        │ ⚠M6│⚠M6│ - │ ⚠ │ ✓ │ ⚠ │
identity store             │ ✓ │ ⚠M6│ - │ ⚠ │ ✓ │ ✓ │
```

---

## Prioritized remediation order

For pre-launch:

1. **H1** (pair-fingerprint-before-upload). Real attack vector with realistic effort. **MUST FIX.**
2. **H2** (WebHID transport unverified). Run probe, fix transport if probe fails. **MUST VERIFY.**
3. **H3** (layered keystore validation gap). One-line fix. **MUST FIX.**
4. **M1** (multi-yubikey UX). Fix or postpone with clear single-yubikey constraint.
5. **M3** (sig doesn't cover account). Wire-format change; coordinate with H1's protocol bump.
6. **M4** (KDF floor). One-line fix.
7. **M6** (storage event handler). Add verification step.
8. **M7** (passphrase wrap cap).
9. **M8** (writeEnvelope failure ignored).
10. **L1-L16**: backlog.

For post-launch:

- **M2** (HMAC domain binding). User education in UI; no code fix possible.
- **M5** (mnemonic in DOM). Harden via word-by-word rendering.
- **N1-N8**: schedule cleanup.

---

## What I did NOT find

For completeness, here are things I looked for and did NOT find a problem with:

- **secp256k1 misuse**: signing paths use `signAsync` correctly; no nonce reuse, no scalar reuse across roles.
- **AEAD nonce reuse**: nonces are per-encrypt random via `randombytes_buf`; no fixed nonces.
- **Argon2id parameter manipulation**: encrypt-side uses INTERACTIVE; decrypt-side uses INTERACTIVE; the floor (M4) is the only soft spot.
- **Time-of-check-vs-time-of-use on the envelope**: `readEnvelope` is called at submit time, not at form mount. No race.
- **JSON injection in error messages**: errors are passed to i18n, which doesn't interpret HTML. ✓
- **CSRF on the indexer pair endpoints**: relay is unauthenticated by design (it's just a relay). The cryptographic security comes from signature + AEAD, not from session cookies.
- **Replay attacks on pair**: nonces are single-use (single POST, single GET). 60s TTL.
- **Subnormal floats in fee calculations**: out of scope but didn't see anything alarming in the WIF/keystore math.
- **Open redirects**: pair flow only navigates via SvelteKit's `goto()`; no user-controlled URLs in `window.location.href` without validation.
- **Same-site cookie issues**: Morphit doesn't use cookies for auth (keystore is localStorage).
- **Subresource integrity**: Morphit bundles all crypto (libsodium, secp256k1, dblurt) — no CDN crypto. ✓
- **Path traversal in keyfile import**: `blobToEnvelope` reads `blob.text()`; no path involved.

---

## Methodology disclaimer

I went through the code thoughtfully, multiple passes, with explicit attention to high-risk patterns. I am NOT a substitute for an external audit by a security firm experienced with browser-based crypto (Trail of Bits, NCC Group, Cure53, etc.). Use this report as a developer-level pre-audit pass that catches the clearly-bad-and-fixable issues; commission an external review before launch.

I'm especially thin on:
- Side-channel timing analysis under realistic JS engine conditions.
- WebHID protocol correctness for non-YubiKey devices that might respond to the same vendor-id filter.
- Mobile browser quirks (Safari iOS Web Crypto, Firefox Mobile, in-app webviews).
- Adversarial Service Worker behavior (the sw.js was not in audit scope).

A real external auditor would also do dynamic testing — spinning up the app, instrumenting with a debug-protocol fuzzer, running through every form with random inputs.
