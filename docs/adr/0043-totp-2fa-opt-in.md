# ADR-0043: Two-factor authentication as an opt-in session gate

**Status:** Accepted
**Date:** 2026-05-24
**Supersedes:** —
**Superseded by:** —

## Context

Morphit is a non-custodial peer-to-peer marketplace. The user's
identity material — four BLURT role keys plus a BIP-39 seed —
lives only on the user's device, encrypted under their password
via Argon2id + XChaCha20-Poly1305 (ADR-0017).

Users in our target population are accustomed to two-factor
authentication (2FA) on every other consumer service they use.
"Does Morphit have 2FA?" is one of the first questions a
security-conscious newcomer asks. Answering "no" is technically
defensible (the keystore IS encrypted; if your password is good
the keys are safe) but it costs trust with users who don't draw
the distinction between custodial 2FA and crypto-wallet 2FA.

This ADR documents the design of an OPT-IN TOTP-based 2FA layer
that protects against a real-but-narrow threat model, while being
honest about what it does NOT add.

## Decision

Morphit ships TOTP-based 2FA as a **session gate**, layered after
the existing password-decrypts-keystore flow.

### Opt-in, never required

The user MUST initiate enrollment from Settings → Security → 2FA.
There is no:

- Nag banner suggesting enrollment
- "Your account is insecure" interrupt at login
- Onboarding step that mentions 2FA
- Push to enroll after first trade, after first withdrawal,
  or at any other milestone

Users who never click "Set up 2FA" experience Morphit identically
to a pre-2FA build. The `totpSecret` field on `FullIdentity` is
optional and defaults to null; the `bootFromEnvelope` gate only
fires `if (full.totpSecret)`.

This is a privacy/agency stance. On a non-custodial wallet, a
required second factor is contradictory with the design: if the
user loses the second factor, NOBODY can recover access — there
is no admin, no support email, no "lost 2FA" support form. So
2FA on Morphit can only be opt-in, and the UI must respect that.

### Honest threat-model framing in the UI itself

The enrollment page surfaces, in plain language, what 2FA does
and doesn't protect against:

**Does protect against:**
- Shoulder-surfing: someone watching you type the password
- Borrowed-device replay: a friend who saw you log in once
- Casual local malware: malware that grabs the encrypted
  keystore + sniffs the password but doesn't know to extract
  the TOTP secret from the same blob

**Does NOT protect against:**
- A determined offline attacker who has BOTH the encrypted
  keystore AND a cracked password. The TOTP secret lives in
  the same encrypted blob as the keys; once that blob is
  decrypted, the attacker has all of it.

For cryptographically-meaningful 2FA where the second factor's
secret never lives on the protected device, the path forward is
FIDO2/WebAuthn hardware keys (see ADR-0017 §3 — YubiKey-protected
keystores). Morphit has exploratory support; it's not
production-ready yet. The TOTP layer documented here is
explicitly the lesser cryptographic guarantee, but it covers
the actually-common threat scenarios that users worry about.

### Open-source-only recommended-app policy

Morphit's recommended-apps list (in `recommendedAuthenticatorApps.ts`)
is curated under a strict policy. To be on it, an app MUST:

1. Be open source under an OSI-approved license
2. Offer encrypted backups (cloud or local)
3. Not phone home with telemetry by default
4. Be available on at least one of: F-Droid, iOS App Store,
   Android Play Store, or direct platform distribution

The current list (in display order):

- **Aegis Authenticator** (GPL-3.0, Android-only): encrypted
  local backups, biometric lock, no cloud sync. The gold
  standard for privacy-conscious Android users.
- **2FAS Authenticator** (GPL-3.0, iOS + Android): optional
  encrypted iCloud/Google Drive backup is **opt-in, not the
  default**.
- **Ente Auth** (AGPL-3.0, all platforms): end-to-end-encrypted
  cross-device sync via Ente's E2E infrastructure.

Apps **explicitly not recommended**, with reasons surfaced in
the UI under an expandable "apps we don't recommend" section:

- **Google Authenticator**: closed source; cloud backup syncs
  unencrypted secrets to Google by default (opt-out, not
  opt-in).
- **Microsoft Authenticator**: closed source; mandatory
  Microsoft-account telemetry.
- **Authy**: closed source; cloud-only backups with a history
  of SIM-swap account-recovery exploits; desktop app
  deprecated 2024.

Users with other authenticators they trust (KeePassXC, Bitwarden,
Yubico Authenticator, andOTP, OpenOTP) are welcome to use them —
the list is "what we recommend to a new user," not a denylist.

### Backup codes

10 single-use Crockford-base32 backup codes generated at
enrollment, displayed once, hashed with Argon2id MODERATE.
Each code is 8 characters → ~40 bits of entropy, which combined
with Argon2id MODERATE makes offline brute force infeasible even
with the keystore stolen.

The unlock-flow gate accepts EITHER a 6-digit TOTP code OR an
8-char backup code (with optional dash); auto-detection happens
in `keystoreTotp.ts`. On successful backup-code redemption, the
keystore is re-encrypted with the slot's `used` flag flipped
and persisted before returning — this prevents replay by an
attacker who reads the same encrypted blob between redemption
and re-save.

### Rate limiting

Session-local: 5 invalid TOTP attempts trigger a 30-second
lockout. This is meant to slow down a human typing wildly,
not to defeat automated brute force (which would need to
also break the keystore encryption first; the TOTP secret
isn't reachable until then anyway). Reloading the page
resets the counter, which is fine for the threat model.

## Consequences

### Positive

- Users who want 2FA can have it
- No degradation for users who don't enroll
- Honest framing avoids over-promising
- Open-source-only policy avoids leaking secrets to
  closed-source backup paths that contradict Morphit's
  privacy stance
- The same code path will support layered envelope
  + 2FA in a future iteration when needed

### Negative

- Adds a code surface that didn't exist before
- Users who enroll and then lose both their authenticator
  AND all 10 backup codes need to recover via seed phrase
  (which they should have anyway, but it's a real
  operational risk)
- TOTP requires the user's device clock to be roughly in
  sync; clock drift > 90s (1 step on either side of
  current) fails validation
- The TOTP code field is autocomplete="one-time-code"
  which on iOS Safari can sometimes interfere with
  paste; documented in FAQ

### Neutral

- The decision NOT to nag users about enrolling means
  some users who would benefit from 2FA won't enable it
  because they don't think about it. This is acceptable
  given the explicit anti-paternalism stance — we tell
  the user 2FA exists, we tell them where to find it,
  and we trust them to decide.

## Rejected alternatives

### Hardcoded "you must enable 2FA before withdrawing more than $X"

Rejected: contradicts the non-custodial design. The user's
keys are the user's keys; Morphit must not impose
operational requirements that can lock the user out of their
own funds. Some other crypto services do this; Morphit does
not.

### Server-stored TOTP shared secret

Rejected: requires a server-side account, which Morphit
doesn't have. The relay holds no per-user state of this
kind; the indexer holds chain-replicated public data only.
Storing TOTP secrets server-side would create a custodial
component where none exists today.

### WebAuthn / FIDO2 only

Rejected as the only 2FA path because:

- WebAuthn hardware keys are not yet ubiquitous in the
  user population
- Mobile WebAuthn implementations vary in completeness
  across browsers
- A subset of users want 2FA but don't own a hardware key

WebAuthn IS the cryptographically stronger path and remains
on the roadmap (see the `/dev/yubikey-probe` exploratory
route). TOTP is the bridge available today.

### "Recommend Google Authenticator because it's familiar"

Rejected: contradicts Morphit's privacy stance. Recommending
an authenticator that backs up secrets to Google's cloud by
default would undo the secrecy of the second factor for
exactly the users (privacy-conscious Bitcoin/Monero traders)
who chose Morphit specifically to avoid that pattern.

## Implementation

- `apps/web/src/lib/auth/totp.ts` — RFC 6238 HMAC-SHA1 TOTP
  primitives + base32 codec + otpauth:// URI builder
- `apps/web/src/lib/auth/backupCodes.ts` — Crockford-base32
  code generation + Argon2id MODERATE hashing + redemption
- `apps/web/src/lib/auth/recommendedAuthenticatorApps.ts` —
  canonical apps list with explicit policy
- `apps/web/src/lib/crypto/keystoreTotp.ts` — unlock-time
  TOTP-or-backup-code verification gate
- `apps/web/src/lib/crypto/keystoreTotpEnroll.ts` — enroll,
  unenroll, regenerate-backup-codes operations
- `apps/web/src/lib/crypto/keygen.ts` — `FullIdentity` extended
  with optional `totpSecret` + `totpBackupCodes`
- `apps/web/src/lib/crypto/keystore.ts` — `identityToJson` /
  `jsonToIdentity` serialize/parse the new fields; new
  `KeystoreErrorKind` values `'totp_required'` and `'totp_invalid'`
- `apps/web/src/lib/stores/identity.ts` — `bootFromEnvelope`
  gates on TOTP after password decrypt; backup-code redemption
  re-encrypts + persists
- `apps/web/src/routes/[lang]/settings/security/2fa/+page.svelte`
  — full enrollment + status + regen + unenroll state machine
- `apps/web/src/routes/[lang]/login/+page.svelte` — handles
  `totp_required` by surfacing a TOTP entry field; session-local
  rate limit on `totp_invalid`
- `apps/web/src/lib/i18n/locales/*.json` — `settings.totp.*`
  subtree in all 10 locales
