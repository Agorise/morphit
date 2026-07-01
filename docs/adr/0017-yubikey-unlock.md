# ADR-0017: YubiKey unlock via layered-CEK keystore

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** Agorise team (Claude collaborating)
**Supersedes:** —
**Related:**
- ADR-0010 (key custody) — defines the encrypted-keystore model
  this ADR extends.
- ADR-0007 (keygen curve and dblurt package) — explains why
  Blurt's secp256k1 isn't substitutable with WebAuthn's P-256.
- ADR-0022 (cross-device QR pair) — shares the layered-encryption
  pattern thinking; both ADRs are about adding additional
  unwrap paths to a keystore.

## Context

Morphit's keystore today encrypts the user's identity JSON
(seed bytes + per-role keypairs) under a single key derived
from a user-chosen passphrase via Argon2id.  This is a
single-factor lock: anyone who learns the passphrase can
decrypt the keystore.  Phishing, keyloggers, shoulder-
surfing, and password-reuse all attack this surface.

Hardware security keys (YubiKey, NitroKey, etc.) raise the
bar by tying decryption to physical possession of a device
that no remote attacker can reach.  The maintainer asked for
YubiKey support.

The design space narrows quickly:

**Option 1 — WebAuthn / U2F.**  Browser-native, but uses
ECDSA over P-256.  Blurt uses secp256k1.  Signatures from
WebAuthn cannot replace Blurt posting/active signatures, so
the YubiKey would have to wrap a separate keystore-key, not
the chain key directly.  This is doable but adds complexity
and doesn't make the keystore-key any stronger than HMAC-
based options.

**Option 2 — WebHID + YubiKey HMAC-SHA1 challenge-response.**
Same approach as KeePassXC, age-yubikey, pam_yubico.  The
host sends a 64-byte challenge over the OTP-applet HID
protocol; the YubiKey returns HMAC-SHA1(slot_secret,
challenge).  We treat this as a high-entropy "password" and
run it through Argon2id to derive a wrap key.

We chose **Option 2**.  Rationale:

- Same protocol as the existing Linux/Windows/macOS hardware-
  key tooling users already trust.  Cross-tool muscle memory.
- Doesn't require any chain-protocol changes.  Keystore stays
  the only thing the YubiKey wraps; chain keys remain
  unaffected.
- Symmetric primitive (HMAC) sidesteps the curve-mismatch
  issue entirely.
- WebHID is permission-gated by the browser and origin-bound;
  same security model as WebUSB.

The cost: WebHID is currently Chromium-only (Chrome, Edge,
Brave, Arc, Vivaldi, Opera).  Firefox and Safari users can't
use this feature.  We surface this clearly in the UI and let
those users keep using passphrase unlock.

## Decision

**Adopt a layered-CEK keystore extension that supports any
combination of passphrase wraps and YubiKey wraps.**

### Envelope format

The existing single-passphrase envelope continues to work
unchanged.  New envelopes that mix passphrase + YubiKey use a
layered shape, distinguished by `scheme: 'layered-cek'`:

```ts
KeystoreEnvelope = SimplePassphraseEnvelope | LayeredCekEnvelope

SimplePassphraseEnvelope {
  scheme?: 'simple-passphrase'  // optional; default for legacy envelopes
  v: 1
  kdf: 'argon2id'
  kdfParams: { opslimit, memlimit }
  salt:       base64
  nonce:      base64
  ciphertext: base64           // identity-JSON encrypted directly
  createdAt:  number
}

LayeredCekEnvelope {
  scheme: 'layered-cek'
  v: 1
  cekNonce:   base64           // nonce for CEK→identity AEAD
  ciphertext: base64           // identity-JSON encrypted under the CEK
  wraps: WrappedCek[]          // one or more independent unwrap paths
  createdAt:  number
}

WrappedCek = WrappedCekPassphrase | WrappedCekYubikey

WrappedCekPassphrase {
  kind: 'passphrase'
  kdf:  'argon2id'
  kdfParams: { opslimit, memlimit }
  salt:       base64
  nonce:      base64
  ciphertext: base64           // CEK encrypted under Argon2id(passphrase, salt)
}

WrappedCekYubikey {
  kind:           'yubikey'
  schemaVersion:  1
  slot:           1 | 2
  challenge:      base64       // 64-byte random challenge
  kdf:            'argon2id'
  kdfParams:      { opslimit, memlimit }
  salt:           base64
  nonce:          base64
  ciphertext:     base64       // CEK encrypted under
                                // Argon2id(HMAC-SHA1(slot_secret, challenge), salt)
  label:          string       // user-supplied, ≤ 64 chars
  enrolledAt:     number
}
```

### Decryption

A CEK (32 random bytes) encrypts the identity-JSON via XSalsa20-
Poly1305 AEAD (libsodium `secretbox`).  Each wrap independently
encrypts the same CEK under a different derived key.  The
unwrap-then-decrypt flow:

1. Read envelope JSON.
2. If `scheme === 'simple-passphrase'` (or omitted): use the
   pre-Batch-I path — Argon2id(passphrase, salt) → key →
   decrypt identity directly.
3. If `scheme === 'layered-cek'`: pick a wrap (passphrase or
   YubiKey based on user choice), derive its wrap key, decrypt
   the CEK, then decrypt the identity with the CEK.

### State progression (A → B)

The user enrolls hardware-key support in two steps:

- **State A (default after enrollment):** envelope has both a
  passphrase wrap and a yubikey wrap.  Either factor unlocks.
  This is "convenient hardware key" — the YubiKey is a
  second unlock method but doesn't replace the passphrase.
- **State B (opt-in, hardened):** envelope has only yubikey
  wraps.  The passphrase wrap is removed.  Only the physical
  key unlocks.  Lose the YubiKey → recover via 12-word seed
  phrase only.

The (A)→(B) transition (`hardenToYubikeyOnly`) is gated behind
an explicit acknowledgment.  The reverse (`softenToAlsoPassphrase`)
requires a fresh YubiKey unlock to recover the CEK.

### CEK rotation on enrollment

Adding a YubiKey to an existing keystore rotates the CEK.  All
existing wraps must be rebuilt against the new CEK.  This is
the safer default — old wraps cannot decrypt the new envelope
even if their key material is leaked.  The trade-off: enrolling
a second YubiKey forces re-enrollment of the first.  The cost
is one extra Argon2id per wrap during enrollment, which only
happens once.

A future flag could preserve existing wraps if multi-YubiKey
users find this annoying; we prefer the safer default until
demand is shown.

## Threat model

### T1: Stolen device (no YubiKey present)

- **State A:** passphrase wrap still works.  Defense:
  passphrase entropy + Argon2id cost.  Same as pre-Batch-I.
- **State B:** no usable wrap.  Even a full memory dump of
  the running app shows no usable secret.  Strict
  improvement over (A).

### T2: Phished/keylogged passphrase (YubiKey not stolen)

- **State A:** attacker has passphrase, defeats the keystore.
  Same posture as pre-Batch-I.  YubiKey doesn't help here.
- **State B:** attacker has only the passphrase, which
  doesn't decrypt anything.  YubiKey unwrap is the only path.
  This is the security win of (B).

### T3: Stolen YubiKey alone

The YubiKey HMAC secret can be replayed forever, but the
attacker also needs the encrypted keystore blob — which sits
in the user's localStorage on their device.  No keystore = no
ciphertext = nothing to decrypt.  YubiKey alone is
insufficient.

### T4: Stolen YubiKey + access to encrypted keystore

(Via backup export, cloud sync of localStorage, malware on
the user's device, etc.)

- **State A:** attacker can use yubikey wrap to recover CEK.
  Argon2id over HMAC output is the only friction.  This is
  the known cost of (A) — the YubiKey gives you a SECOND
  unlock path, not a STRONGER one.
- **State B:** same — YubiKey alone is sufficient with the
  ciphertext.  Defense: keep the YubiKey safe.  Same posture
  as a stolen passphrase in (A).

### T5: Browser exploit during YubiKey unwrap

HMAC-SHA1 output transits the WebHID layer in browser memory
for one operation.  We Argon2id-stretch it before use so a
brief read of the HMAC raw bytes still requires GPU time to
brute-force the wrap key.  We `memzero()` the HMAC buffer
immediately after Argon2id consumes it.

### T6: WebHID transport interception

Same-origin policy + USB-permission UX prevents cross-origin
access.  No mitigation available against a malicious WebHID
polyfill or an attacker with arbitrary code execution on the
user's device; users with that level of compromise have
larger problems.

## Browser support

WebHID is Chromium-only as of writing (Chrome, Edge, Brave,
Arc, Vivaldi, Opera, and other Chromium derivatives).
Firefox and Safari do not expose `navigator.hid`.

Settings → Hardware key feature-detects via
`isWebHidSupported()` and renders an "your browser doesn't
support hardware keys" card on Firefox/Safari.  Login page
also feature-detects: state-A users on Firefox don't see the
"Unlock with YubiKey" button; state-B users on Firefox see
the YubiKey-required UI with the unlock button disabled
plus a clear message ("Use Chrome / Edge / Brave, or use
your seed phrase to enter").

## Wire fidelity caveat

The WebHID transport layer in `apps/web/src/lib/crypto/yubikey/transport.ts`
implements the OTP-applet HID feature-report protocol from
public Yubico documentation.  This implementation has NOT
been live-fired against a physical YubiKey from the dev
sandbox; the HID frame layout (8-byte feature reports, 7-byte
payload + 1 status, slot commands 0x30/0x38, RESP_PENDING +
WAIT polling) is best-effort.

The wrap/unwrap math (Argon2id over HMAC output, ChaCha20-
Poly1305 AEAD, CEK rotation) is independently smoke-tested
in `apps/indexer/scripts/yubikey-protocol-smoke.ts` with a
deterministic stub HMAC.  The remaining surface that can fail
at integration time is narrow: the byte-level USB feature-
report shape.

**A user with a real YubiKey must validate the integration
in the browser before this batch is declared production-
ready.**  The first-class test is: enroll a YubiKey in
Settings → Hardware key, sign out, log back in via "Unlock
with YubiKey", and observe that the identity store rehydrates.

## Rollback path

This change is non-destructive.  Pre-Batch-I keystores remain
valid forever — readers default `scheme` to `'simple-
passphrase'` when the field is missing.  A user who enrolls a
YubiKey can always:

- Remove the YubiKey wrap (`unenrollWrap`) — falls back to
  passphrase-only unlock.
- Soften from state B to state A (`softenToAlsoPassphrase`)
  — re-adds a passphrase wrap.
- Re-import from seed phrase — produces a fresh simple-
  passphrase envelope.

There is no path that silently loses access; the smallest
"unrecoverable" pre-condition (state B + lost YubiKey) is
recoverable via the user's 12-word seed phrase, which is the
universal fallback for non-custodial accounts.

## What this ADR doesn't decide

- **Multi-YubiKey backup convenience.**  Today, enrolling YK#2
  invalidates YK#1's wrap (CEK rotation).  A future ADR could
  add a `preserve_existing` flag for users who want to enroll
  N keys without re-enrolling each one.  Holding off until
  someone asks.
- **WebAuthn/passkeys integration.**  We chose WebHID for the
  HMAC-SHA1 reasons above.  If the platform later exposes a
  symmetric-friendly hardware-key API (e.g., HMAC over WebAuthn
  via a hypothetical extension), we could revisit.  Not on
  the roadmap.
- **Touch-required vs touch-optional slots.**  The user's
  YubiKey configuration determines this — if they programmed
  the slot with "require touch," the response holds until tap;
  otherwise it returns immediately.  We poll either way and
  show "tap your YubiKey" UI for both.
