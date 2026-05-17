# Lock Session vs Sign Out — design note

**Status:** ✅ SHIPPED.  Persistent keystore + Lock Session
landed via `apps/web/src/lib/crypto/persistentKeystore.ts`
and `lockSession()` at `apps/web/src/lib/stores/identity.ts:225`.
Onboarding-time keystore-mode choice ("Password (fast)" vs
"Seed every time (most private)") is wired through
`keystoreMode` state in the onboarding form, with the password
gate on the persist path.  Sign Out (the nuclear option) now
wipes the envelope from localStorage; Lock Session preserves
the envelope for next-session password unlock.

This doc captures the original design rationale.  The header
"Decision needed from you" section below documents what was
ratified before implementation; the body matches what shipped.

**Last updated:** 2026-04-21 (design ratification); shipped
shortly after.

## Problem

The avatar dropdown currently has one destructive action: **Sign Out**.
You asked for both **Lock Session** and **Sign Out** with confirmation
modals. This doc explains why only Sign Out shipped this turn, and
what's required for Lock Session to be genuinely different rather
than a lie to the user.

## Current behavior

`reset()` in `apps/web/src/lib/stores/identity.ts` does exactly this:

1. Zero the in-memory `LiveIdentity` (posting + memo privates wiped)
2. Set the store back to `{ state: 'locked' }`

That's it. **The encrypted keystore envelope is never written to
localStorage.** Each session starts from nothing — the user has to
either paste their seed phrase or upload a keyfile to unlock.

So today, "Lock" and "Sign Out" would produce an identical end state:
the user needs their seed/keyfile to get back in. Shipping two buttons
that do the same thing is misleading.

## What Lock Session should actually do

- **Lock**: clear in-memory privates, KEEP encrypted envelope in
  localStorage → user can unlock on same device with just their
  password, no seed re-entry.
- **Sign Out**: clear in-memory privates AND wipe envelope from
  localStorage → user needs full re-import next time.

For this distinction to be real, the envelope must actually live in
localStorage between sessions.

## The security gotcha: fallback passwords

Look at `apps/web/src/routes/[lang]/onboarding/+page.svelte`, the point where
the envelope gets created after the seed-confirmation quiz:

```typescript
if (!sessionPassword || sessionPassword.length < 8) {
    // Derive a temporary password. User will set a real one via
    // Settings later; this is a placeholder for the session.
    const rnd = crypto.getRandomValues(new Uint8Array(24));
    sessionPassword = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
}
const env = await encryptIdentity(full, sessionPassword);
await bootFromEnvelope(env, sessionPassword);
```

The onboarding flow accepts a session without the user setting a
password — it falls back to a random 24-byte hex string. That works
fine for **in-memory unlock** (the password is in JS memory already
anyway), but it's **useless for persistent storage**:

- Random password exists only in JS memory
- When tab closes, password is gone forever
- Envelope-in-localStorage without its password is unrecoverable

So: persisting the envelope to localStorage is only meaningful if the
user set a real password during onboarding. If they used the random
fallback, we cannot meaningfully persist.

## Proposed implementation

### Onboarding flow changes

Change the onboarding password step from "optional placeholder" to
"required if you want to persist." Two-option choice:

> **How do you want to unlock next time?**
>
> [ ] Password (fast) — set a password now. Your encrypted keys stay
>     on this device. You can Lock Session instead of signing out,
>     and just re-enter the password to unlock.
>
> [ ] Seed phrase every time (most private) — nothing stored on this
>     device. You'll re-enter your 12-word seed each session.

If they pick password: require min-8 password, store envelope in
localStorage under `morphit.keystore.envelope`.

If they pick seed-every-time: don't write anything to localStorage.
In that mode, "Lock" and "Sign Out" collapse to a single option,
which is honest.

### Storage shape

```typescript
// localStorage key: morphit.keystore.envelope
// Value: JSON of KeystoreEnvelope (ciphertext, salt, IV, KDF params)
interface StoredEnvelope {
  version: 1;
  envelope: KeystoreEnvelope;
  createdAt: number;  // unix ms
}
```

Use `safeStorage.ts` (already shipped) so Private Mode and Tor
Browser at high security gracefully fall back to seed-every-time.

### App boot path

On `+layout.svelte` mount:

1. Check `localStorage.getItem('morphit.keystore.envelope')`
2. If present → set identity store to new state `{ state: 'keystore-present' }`
3. Login page renders "Unlock with password" form when state is
   `keystore-present`, "Import seed or keyfile" form when state is
   `locked`.

### Lock Session action

`lockSession()` on the identity store:

1. Zero live privates (same as `reset()`)
2. Keep envelope in localStorage (do not remove)
3. Set state to `{ state: 'keystore-present' }`

Next time user visits, login shows "Welcome back — enter your
password" instead of the seed import flow.

### Sign Out action (changes)

Today's `reset()` stays the same in behavior but gains a localStorage
wipe:

1. Zero live privates
2. `safeLocal.remove('morphit.keystore.envelope')`
3. `safeLocal.remove('morphit.displayName')`
4. `safeLocal.remove('morphit.nostrUrl')`
5. `safeLocal.remove('morphit.blurtMediaUrl')`
6. State to `{ state: 'locked' }`

Sign Out becomes a **real** clean slate on this device. The user's
on-chain data remains untouched.

## Modal copy (already needed next turn)

Lock Session modal:
- Title: "Lock this session?"
- Body: "Your encrypted keys stay on this device. You can unlock again
  with your password — no seed phrase needed. Choose Sign Out if
  you're on a shared computer and want everything wiped."
- Confirm: "Lock session"
- Cancel: "Stay signed in"

Sign Out modal (existing, copy refined):
- Title: "Sign out of Morphit?"
- Body: "This wipes your encrypted keys from this device. You'll need
  your 12-word seed phrase or keyfile to sign back in. Your on-chain
  data, orders, and reputation aren't affected — they live on Blurt,
  not in this browser."
- Confirm: "Sign out completely"
- Cancel: "Stay signed in"

The two modals' bodies are clearly different, so the user's choice
matters.

## Decision needed from you

1. **Approve the onboarding password choice screen** — "Password (fast)
   vs Seed every time (most private)" as the two options at signup.
2. **Approve localStorage as the persistence store** (alternative:
   IndexedDB, which survives some storage-pressure eviction scenarios
   better but adds complexity).
3. **Approve `safeStorage` as the access layer** — gracefully degrades
   to seed-every-time in Private Mode / Tor Browser.
4. **Approve auto-lock timeout?** — optional: auto-lock the session
   after N minutes of inactivity. Would need a Settings toggle. Yes/no
   and default duration (30 min? 2 hours?).

Once ratified, this is ~1 day of work:
- Onboarding flow update
- Login page "unlock with password" form
- identity store new state variant + `lockSession()` action
- Sign Out localStorage wipe
- Lock Session menu item + modal in AvatarMenu
- Settings section for password change + auto-lock timeout
