# Seed-phrase import for WhaleVault (and other Blurt wallets)

*A guide to reusing Morphit's BIP-39 seed-phrase → Blurt-key derivation in
another wallet or browser extension.*

This document is written for an external developer (e.g. the WhaleVault
author) who wants to add "import your account from a 12-word seed phrase" to
their own software, reusing the exact code Morphit uses. It tells you which
files, which functions, what to copy, what to change, and how to verify your
copy matches Morphit bit-for-bit.

---

## 1. What this gives your users

A user types 12 words. Out come the four Blurt keys (owner, active, posting,
memo) as secp256k1 keypairs. No password, no email, no server round-trip — the
seed phrase *is* the account. Same 12 words always produce the same keys, on
any device, in any wallet that runs this derivation.

The seed phrase is a **standard BIP-39 mnemonic**. The first stage of the
pipeline (mnemonic → 64-byte seed) is interoperable with every BIP-39 tool on
earth. The second stage (seed → the four Blurt role keys) is **Morphit's own
domain-separated scheme** — so to land on the *same keys Morphit derives*, you
must reuse Morphit's second stage too. Both stages are below.

---

## 2. The one file you need

Everything lives in a single, dependency-light, framework-free module:

```
apps/web/src/lib/crypto/keygen.ts
```

It is plain TypeScript. It does **not** import Svelte, SvelteKit, or anything
browser-framework-specific. It depends only on three well-known crypto
libraries (all of which WhaleVault very likely already bundles or can add):

| Dependency | Version Morphit pins | Role in the pipeline |
| --- | --- | --- |
| `@scure/bip39` | `^1.4.0` | mnemonic validation + mnemonic→seed (the standard BIP-39 stage) |
| `libsodium-wrappers-sumo` | `0.7.15` | BLAKE2b (`crypto_generichash`) for the domain-separated expansion |
| `@noble/secp256k1` | `^2.1.0` | final scalar → secp256k1 public key |

All three are MIT/CC0-licensed, audited, and widely used. `@scure/bip39` and
`@noble/secp256k1` are by the same author (paulmillr) and are the de-facto
standard for modern JS crypto.

> **License note.** Morphit is **AGPL-3.0**. If you lift this code directly,
> your project inherits AGPL-3.0 obligations for that code (and AGPL's network-
> use clause is broad). The derivation *scheme itself* — the sequence of
> standard operations described in §4 — is not copyrightable; you are free to
> reimplement it from this spec in your own code under your own license. If you
> want the easy path (copy the file) talk to the Morphit/Agorise team first
> about licensing; if you want zero license entanglement, reimplement from the
> spec in §4. Either works.

---

## 3. The exact functions to call

`keygen.ts` exposes a clean public surface. For an importer you need exactly
three of them:

```ts
// 1. Validate what the user typed (12 words, English wordlist, valid checksum).
export function validateMnemonic(seed: string): boolean;

// 2. Turn a valid 12-word phrase into the full identity (all four role keys).
export async function importFullIdentityFromSeed(seed: string): Promise<FullIdentity>;

// 3. (Optional) Generate a fresh phrase, if you also want a "create account" flow.
export function generateMnemonic(): string;
```

`importFullIdentityFromSeed` returns a `FullIdentity`:

```ts
interface FullIdentity {
  createdAt: number;
  origin: 'morphit-seed';
  seedBytes: Uint8Array;          // 16-byte BIP-39 entropy (NOT the mnemonic string)
  keys: Record<KeyRole, Keypair>; // owner / active / posting / memo
}

interface Keypair {
  role: 'owner' | 'active' | 'posting' | 'memo';
  publicKey: Uint8Array;   // 33-byte compressed secp256k1 point
  privateKey: Uint8Array;  // 32-byte raw secp256k1 scalar
}
```

That's it. `keys.posting.privateKey` is the 32-byte scalar you'd hand to your
signer; `keys.posting.publicKey` is the compressed point you'd compare against
the account's on-chain `posting.key_auths[0]`.

### Formatting the public key for Blurt

The raw `publicKey` is 33 bytes. Blurt displays public keys as a base58check
string with a `BLT` prefix (e.g. `BLT6M…`). Morphit has a helper for that too:

```ts
export function formatPublicKey(pk: Uint8Array): string;     // raw hex (debugging)
// and, dynamically imported to keep bundle size down:
//   formatPublicKeyBLT(pk)  → the "BLT…" graphene address string
```

If you already have graphene address-encoding in WhaleVault (you almost
certainly do), use yours on the 33-byte `publicKey` and skip Morphit's.

---

## 4. The derivation pipeline (the spec, if you reimplement)

If you'd rather reimplement than copy the AGPL file, here is the complete,
unambiguous recipe. Reproduce these steps exactly and you will produce
byte-identical keys to Morphit.

```
  user's 12 words
       │
       ▼  (a) BIP-39 validation: exactly 12 words, English wordlist, valid checksum
       │      @scure/bip39  validateMnemonic(words, englishWordlist)
       │
       ▼  (b) BIP-39 seed: PBKDF2-HMAC-SHA-512, 2048 rounds, EMPTY passphrase
       │      @scure/bip39  mnemonicToSeed(mnemonic)        → 64 bytes  [STANDARD]
       │
       ▼  (c) master seed: BLAKE2b-256 of the 64-byte seed,
       │      keyed/parameterised as crypto_generichash(outlen=32,
       │        message = utf8("morphit-v1/master"),
       │        key     = the 64-byte BIP-39 seed)            → 32 bytes  [MORPHIT]
       │
       ▼  (d) per role in {owner, active, posting, memo}:
       │      material = crypto_generichash(outlen=32,
       │        message = utf8("morphit-v1/<role>"),
       │        key     = the 32-byte master seed)            → 32 bytes  [MORPHIT]
       │
       │      if material is 0 or ≥ secp256k1 curve order (prob ≈ 2⁻¹²⁸),
       │      retry with message = utf8("morphit-v1/<role>/<counter>"),
       │      counter = 0,1,2,… until isValidPrivateKey(material).
       │
       ▼  (e) keypair: privateKey = material (32-byte scalar);
              publicKey  = secp256k1.getPublicKey(material, compressed=true) (33 bytes)
```

Notes that matter for exact reproduction:

- **Step (b) uses an empty BIP-39 passphrase.** Morphit does not use the
  optional 25th-word passphrase. `mnemonicToSeed(mnemonic)` with no second
  argument.
- **The domain strings are exact ASCII**, no trailing newline: `morphit-v1/master`,
  `morphit-v1/owner`, `morphit-v1/active`, `morphit-v1/posting`, `morphit-v1/memo`.
- **`crypto_generichash(outlen, message, key)`** is libsodium's BLAKE2b. The
  *seed is the key, the domain string is the message* — not the other way
  round. Get this order wrong and every key will be wrong.
- **The retry loop** (step d) is almost never taken, but it is part of the
  spec: omit it and you'd produce different keys for the ~1-in-2¹²⁸ seed that
  hits it. Cap it (Morphit caps at 1024) so a pathological seed can't hang.
- **12 words only.** Morphit deliberately supports only 12-word (128-bit)
  mnemonics — not 15/18/21/24 — so the validator rejects other lengths up
  front. If WhaleVault wants to support 24-word phrases from other wallets,
  that's a *different* feature; this code is specifically the Morphit form.

---

## 5. Minimal copy-paste extraction

If you want the smallest possible standalone function, here is the whole
pipeline distilled to one file with no Morphit-specific types. This is a
faithful reimplementation of §4 — drop it into WhaleVault, adjust imports to
your build, and it will produce the same keys as Morphit.

```ts
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import * as secp256k1 from '@noble/secp256k1';
import sodium from 'libsodium-wrappers-sumo';

export type BlurtRole = 'owner' | 'active' | 'posting' | 'memo';

export interface BlurtKey {
  role: BlurtRole;
  publicKey: Uint8Array;   // 33-byte compressed secp256k1 point
  privateKey: Uint8Array;  // 32-byte scalar
}

/** Exactly 12 English BIP-39 words with a valid checksum. */
export function isValidMorphitSeed(phrase: string): boolean {
  const norm = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (norm.split(' ').length !== 12) return false;
  return bip39.validateMnemonic(norm, wordlist);
}

function deriveRole(masterSeed: Uint8Array, role: BlurtRole): BlurtKey {
  const enc = new TextEncoder();
  let material = sodium.crypto_generichash(32, enc.encode(`morphit-v1/${role}`), masterSeed);
  let counter = 0;
  while (!secp256k1.utils.isValidPrivateKey(material)) {
    sodium.memzero(material);
    material = sodium.crypto_generichash(32, enc.encode(`morphit-v1/${role}/${counter}`), masterSeed);
    counter++;
    if (counter > 1024) {
      sodium.memzero(material);
      throw new Error(`could not derive valid scalar for ${role}`);
    }
  }
  const publicKey = secp256k1.getPublicKey(material, true);
  const privateKey = new Uint8Array(material);
  sodium.memzero(material);
  return { role, publicKey, privateKey };
}

/** 12 words → all four Blurt role keys. Identical output to Morphit. */
export async function morphitKeysFromSeed(phrase: string): Promise<Record<BlurtRole, BlurtKey>> {
  await sodium.ready;
  const norm = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (!isValidMorphitSeed(norm)) throw new Error('Invalid seed phrase (need 12 valid BIP-39 words)');
  const enc = new TextEncoder();
  const bip39Seed = await bip39.mnemonicToSeed(norm);                              // (b) 64 bytes
  const masterSeed = sodium.crypto_generichash(32, enc.encode('morphit-v1/master'), bip39Seed); // (c)
  const keys = {
    owner:   deriveRole(masterSeed, 'owner'),
    active:  deriveRole(masterSeed, 'active'),
    posting: deriveRole(masterSeed, 'posting'),
    memo:    deriveRole(masterSeed, 'memo'),
  };
  sodium.memzero(bip39Seed);
  sodium.memzero(masterSeed);
  return keys;
}
```

(The Morphit original adds heap-hygiene touches — zeroing intermediate buffers,
not retaining the mnemonic string — which the snippet above preserves. Whatever
you do, zero the `privateKey` buffers when you're done with them.)

---

## 6. Verify your copy is correct (test vector)

Use the canonical all-`abandon` BIP-39 test mnemonic. Run your derivation on it
and you must get **exactly** these compressed-public-key hex strings (33 bytes,
66 hex chars). These were produced by Morphit's actual `keygen.ts`:

```
mnemonic: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about

owner    031ce2762f73bfba17bd146eb9fe4b52d07dd1014d066645b54c710df31289dac2
active   02314e93d7eaa545df0073549fb3e4368ce21738261939f7b36baa82219c1a4b61
posting  03e2a6093b11e6da67c22e2e03ebeb6b29fa4f5a6b6e875216e84aa5ce2336ff39
memo     03b0bb2c77c15351cb3900d0d6f22dd4138a21f40bab3712ed17ca460851c6d28a
```

If your output matches all four, your extraction is bit-for-bit compatible with
Morphit. (Run your graphene address-encoder over these 33-byte points to get
the `BLT…` strings your UI will display, and confirm they match what the same
seed shows in Morphit.)

> Reminder: this is a *test* mnemonic published in every BIP-39 spec — never let
> a real user's funds touch an account derived from it.

---

## 7. Things to get right in the UX (hard-won from Morphit)

- **Validate before deriving, and tell the user *why* it failed.** "Invalid
  seed phrase (bad word or checksum)" beats a silent no-op. The word count and
  checksum are the two failure modes.
- **Never log, persist, or transmit the phrase or the derived private keys.**
  Derive in memory, use, zero. The phrase is bearer-access to the account.
- **Zero the buffers.** `sodium.memzero()` the master seed, the BIP-39 seed,
  and the private-key scalars once you've handed them to your signer/keystore.
  JS can't guarantee it, but it shrinks the window.
- **Don't accept 24-word phrases silently.** If a user pastes a 24-word phrase
  expecting it to work, derive *something*, and it doesn't match their account,
  that's a confusing footgun. Reject non-12-word input with a clear message, or
  build 24-word support as a deliberate, separately-tested path.
- **Confirm against the chain.** A seed always derives *some* keys, even from a
  typo that happens to checksum. Before treating the import as "logged in,"
  fetch the account by name and confirm the derived public key matches the
  on-chain authority. Morphit does this in its import route, not in `keygen.ts`
  (the crypto layer has no network access by design).

---

## 8. Where to ask

- Code: `git.agorise.net/agorise/morphit` → `apps/web/src/lib/crypto/keygen.ts`
  (and `crypto.test.ts` next to it for the test cases).
- Design rationale for the secp256k1 choice: `docs/adr/0007-*` in the repo.
- Chat: `#agorise:matrix.org` (public room) for questions; the Morphit/Agorise
  team can sort out the licensing path in §2 if you want to copy rather than
  reimplement.

Seed phrases make key import genuinely easy for non-technical users — glad to
have WhaleVault offering it too.
