# ADR-0050: `origin` is provenance, not capability — and the `posting-active` keystore

**Status:** Accepted
**Date:** 2026-07-09
**Supersedes:** nothing. **Amends:** the identity model established alongside ADR-0007 (keygen) and the posting-only import path.

## Context

A `FullIdentity` carried `origin: 'morphit-seed' | 'posting-only'`, recording **where the identity came from**. Every feature that needed to know whether a transfer could be signed asked the same question:

```ts
const hasActiveKey = $derived($liveIdentity?.origin === 'morphit-seed');
```

That is a provenance check standing in for a capability check, and it was wrong in a way that shipped:

- The wallet's **Send button was hidden outright** from anyone who signed in with a Blurt posting key.
- Chat "Pay now" was blocked, and the `/post` BLURT listing fee was unreachable.
- The copy explaining all this told users to *"sign in with your 12-word seed or Keyfile"* — artefacts that **no existing Blurt user has**, because Morphit invented both.

A user who owned their Active key and could have spent was told, by a control that simply wasn't there, that Morphit could not send BLURT.

## Decision

**1. `origin` stays provenance. Capability is asked for directly.**

`origin` gains a third value, `'posting-active'`: a posting-only import that later chose to keep a verified Active key on this device. Every gate in front of money now asks the honest question:

```ts
const hasActiveKey = $derived(($liveIdentity?.activePublicKey ?? null) !== null);
```

`LiveIdentity.activePublicKey` already existed. Nothing needed inventing — only the discipline to ask the right question. Four call sites were corrected: `PayBlurtModal`, `SendBlurtModal`, `MyBalanceCard`, `/post`.

**2. The keystore payload gains a legal origin. The crypto container does not change.**

`upgradeToPostingActive(env, password, activeScalar, activePub)` re-encrypts the envelope with `posting` + `active` under the *same* password. Invariants enforced inside the function rather than trusted from callers:

- **The password is the gate.** It decrypts the existing envelope before anything is written, so possession of the Active key alone cannot rewrite someone's keystore.
- Refuses a `morphit-seed` envelope; refuses to run twice.
- `owner`, `memo`, and `seedBytes` stay `null`. An Active key cannot derive them.
- Every private byte is zeroed in a `finally`, including throw paths. The old envelope is untouched; a new one is returned.

`jsonToIdentity` now enforces **both halves** of the schema — required roles present *and* unexpected roles absent. Its doc-comment had claimed this for months; only the "missing role" half was implemented.

**Why the container version (`v: 1`) was NOT bumped.** The Argon2id + XChaCha20-Poly1305 container is byte-identical; nothing about it changed. What changed is the *payload schema*. Bumping the container version would mean touching the layered-cek (2FA) envelope, `persistentKeystore`, and every `readonly v: 1` literal type — more surface, no added safety, for a change that isn't in the container. The property the bump was meant to buy — *an old build must not silently mishandle a new keystore* — holds anyway: an older build hitting a `posting-active` envelope fails loudly and actionably ("This keystore was saved by a newer version of Morphit. Refresh the page to update, then unlock again.").

**3. Keeping the key is never silent, and never touches a clean device.**

`keepActiveKeyOnThisDevice()` is reachable only from an explicit choice whose default is *"forget it"*. It writes to disk **only if a keystore is already persisted** — a user who deliberately kept this device clean does not suddenly get keys written to it. Envelope and live capability move together via `updateUnlockedIdentity()`; `updateEnvelope()` alone would leave `live.activePublicKey === null`, i.e. the user keeps their key and the UI refuses to believe in it.

**4. There is no seed for an imported account, and there cannot be.**

Two independent reasons, either fatal:

1. **Preimage.** `mnemonic → entropy → masterSeed → deriveAll` is one-way. A seed that derives two *pre-existing* secp256k1 keys requires inverting BIP-39 and the master-seed KDF.
2. **Pigeonhole.** 12 words is 128 bits of entropy; two 256-bit private keys is 512 bits.

The only way to hand a long-time Blurt user a real seed is to rotate their on-chain authorities to seed-derived keys — and an Active key **cannot rotate Owner**. The seed's owner key would not control the account. The backup card would be lying to the user about their own recovery, which is the kind of thing that gets people robbed.

Imported accounts therefore receive an **encrypted Keyfile holding Posting + Active**, labelled honestly as containing neither Owner nor Memo, and `/backup-keys` explains *why* there is no seed rather than implying the user is missing out on something we could have given them.

**5. The account a signature speaks for is a property of the key.**

The Blurt account name lived in one origin-wide `localStorage` key, with a `storage` listener that rewrote it whenever another tab signed in — while keys live per-session in memory. Signing in as `@a` in one tab and `@b` in another left the first tab signing with `@a`'s posting key while declaring `required_posting_auths: ["b"]`. The chain answered `Missing Posting Authority b`.

`resolveBroadcastAccount(live, hint)` resolves the account **from the posting key**; the stored name is only a hint used to disambiguate a key that controls several accounts. It refuses (`no_account_for_key` / `ambiguous` / `lookup_failed`) rather than guessing, memoizes per pubkey, and **never caches a failure**. Applied at `broadcastCustomJson` *and* `broadcastNewOrder`, which builds its own two-op fee transaction and had bypassed the boundary entirely.

## Consequences

- Anyone with an existing Blurt account can trade with the fee method of their choice, pay a counterparty, and send BLURT — without a Morphit-invented artefact.
- The blast radius of a Morphit password widens from "can post" to "can spend" **only** for users who explicitly opted in. A red dot on the avatar marks key material that has never been backed up.
- Rolling a deployment *backwards* past this change leaves `posting-active` keystores unreadable until the user refreshes onto the newer build. That is a loud, recoverable failure, not silent corruption.
- `origin` must never again be consulted to decide what an identity may *do*. `posting-active-upgrade-smoke` fails if any money gate reverts to a provenance check.

## Alternatives considered

- **Bump the keystore container version.** Rejected: the container is unchanged; see above.
- **Encode both keys into a ~48-word phrase.** Rejected: a bespoke format no other wallet reads, four times the transcription-error surface, and the same two secrets in a costume.
- **Rotate posting/active/memo on-chain to seed-derived keys.** Rejected as a side effect of paying for a trade. It would break every other wallet the user owns, silently kill their master password, and still leave the seed's Owner key fictional. If ever offered, it belongs in an explicit, Owner-key-gated migration flow with its own copy and its own warnings.
