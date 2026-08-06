# ADR-0002: Session memory holds only posting + memo private keys

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** project maintainer

## Context

Blurt accounts have four key roles: `owner`, `active`, `posting`, `memo`.

| Role    | What it authorizes                                         | Exposure budget |
|---------|------------------------------------------------------------|-----------------|
| owner   | Account recovery, key rotation                             | Rare — minutes per year, at most |
| active  | BLURT token `transfer` ops (listing fees paid in BLURT)    | Occasional — one transfer per fee-paid listing |
| posting | `custom_json` / `comment` ops (orders, chat, feedback, profile) | Constant — signs every Morphit action |
| memo    | End-to-end encrypted chat key derivation                    | Constant — every chat message |

If Morphit keeps all four keys in live browser memory, a single XSS or
supply-chain compromise exposes the user's entire account, including
recovery. That's a disproportionate blast radius for a frontend bug.

## Decision

A running Morphit session holds the **posting** and **memo** private keys
only. `owner` and `active` private keys live exclusively inside the
Argon2id-encrypted keystore and are reached via callback-style
just-in-time functions (`useActiveKey`, `useOwnerKey` in
`$crypto/keystore`) that decrypt, hand the key to one signing operation,
and zero it in a `finally` block regardless of success or exception.

The `LiveIdentity` type enforces this structurally — it has no `active`
or `owner` *private* field. Code cannot accidentally sign a transfer
with its posting key because the relevant type is absent.

## Alternatives considered

- **Keep all four in live memory.** Simplest code path. Rejected —
  disproportionate blast radius as explained above.

- **Prompt for password on every action.** Safest possible, but the UX
  is punishing when a user is browsing and chatting. Rejected in favor
  of the tiered policy: common-path operations (posting, chat) need no
  password; rare high-value operations (`transfer`, account creation)
  do.

- **Delegate active/owner to a browser extension (WhaleVault, Gravity).**
  Strictly stronger than the JIT-unlock pattern, because the keys
  physically never enter Morphit's origin. Added to carry-forward list
  for Phase 4 (depends on extension interoperability). Phase 2 ships
  the JIT-unlock as the fallback that works without an extension.

## Consequences

### Positive

- Compromise of posting key exposes Morphit activity but cannot transfer
  funds, rotate keys, or impersonate the user in any way that survives
  a key rotation.
- Compromise of memo key exposes chat history but nothing else.
- Active and owner privates spend only milliseconds in cleartext memory
  per transaction.

### Negative

- User must enter their password to pay a listing fee in BLURT. UX
  friction, but users pay only when posting orders (not when browsing
  or chatting).
- JIT unlock is still vulnerable to a compromised page origin observing
  the password at the prompt. Documented in `docs/SECURITY.md` as a
  known v1 limitation; Phase 4's extension integration removes it.

### Follow-up work

- Phase 4: WhaleVault / Gravity browser-extension signing path (Phase 1
  review item #16).
- Phase 5: consider secure-enclave signing on platforms that have it
  (WebAuthn / Passkey-backed private keys).

## References

- `apps/web/src/lib/crypto/keygen.ts` — `FullIdentity` / `LiveIdentity`
  type split.
- `apps/web/src/lib/crypto/keystore.ts` — `useActiveKey`, `useOwnerKey`.
- Phase 1 review log entry 2026-04-17 (docs/REVIEW-PHASE1.md).
