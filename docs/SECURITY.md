# Morphit — Security & Threat Model

## Non-negotiable security guarantees

### 1. Private keys never leave the device

- Keygen: `window.crypto.getRandomValues()` + libsodium, client-side only
- Storage: encrypted with Argon2id (KDF) + XSalsa20-Poly1305 (AEAD) using
  a user-chosen password. Ciphertext lives in `localStorage` (or
  `sessionStorage` in Privacy Mode)
- Signing: happens in browser memory, key material zeroed after use where
  the JS engine permits
- Transmission: **forbidden by architecture** (CSP `connect-src 'self'`),
  **forbidden by code review checklist**, **forbidden by SRI-pinned deps**

#### 1a. Only posting + memo keys live in session memory

Blurt accounts have four keys: `owner`, `active`, `posting`, `memo`.
Morphit enforces a strict tier policy:

- **`posting`** is live in session memory. It signs every `custom_json` op
  (orders, feedback, chat ciphertext, profile updates). Routinely used.
  It also seeds the chat identity key (X25519, derived deterministically
  from posting via BLAKE2b — see ADR-0015).
- **`memo`** is live in session memory. Reserved for Blurt-native memo
  encryption; not currently used by Morphit features (chat uses a
  posting-derived X25519 identity, not the memo key).
- **`active`** is NEVER held in session memory. Needed only to sign
  `transfer` ops (BLURT-denominated listing fee path). Accessed via the
  `useActiveKey(env, password, callback)` pattern: the keystore decrypts,
  hands the key to the callback for one signing operation, and wipes it
  in a `finally` block — success or exception.
- **`owner`** is NEVER held in session memory. Needed only for initial
  account creation (once, ever) and for key rotation. Accessed via the
  equivalent `useOwnerKey()` pattern.

This is enforced at the type level: a running session holds a
`LiveIdentity`, which structurally has no `active` or `owner` private-key
fields. Code that wants to sign a transfer must go through
`useActiveKey()`; there is no way to "just grab it from the identity."

Rationale: compromise of posting exposes Morphit activity but cannot
transfer funds, cannot rotate keys, cannot compromise the account.
Compromise of memo exposes chat history but nothing else. Active and
owner, the high-value keys, spend ~milliseconds in cleartext memory per
transaction and are otherwise only ciphertext under Argon2id.

**BLURT fee path** uses `active` once per listing. **BTC/XMR fee paths
never touch `active`** — payment happens directly on those chains; no
Blurt `transfer` op is involved.

**Account creation** uses **none** of the user's keys.  The
relay's active key signs a `create_claimed_account` op
(consuming one ACT from the relay's pre-minted pool per
ADR-0010 §4); the user supplies only the **public keys**
they want their new account governed by.  Their `owner`
private key never touches the network — the user generates
it locally, encrypts it under their password, and the
owner key is needed thereafter only for key rotation.

#### 1b. Active/Owner key deep-audit findings (2026-05-07)

A black-hat-mindset audit of every code path that touches the active or
owner key was performed. Findings:

**Architecture is sound.** `LiveIdentity` (the in-memory session
identity) holds only public copies of owner and active. The private
keys for those roles exist exclusively in the encrypted keystore and
are JIT-decrypted via `useActiveKey()` / `useOwnerKey()`, which:

1. Decrypt the full identity from the envelope.
2. M6 pubkey-pin check: verify the decrypted posting pubkey matches
   the live session's posting pubkey. If not (cross-tab envelope
   replacement attack), wipe everything and throw `identity_mismatch`.
3. Slice out the requested role's private key into a fresh
   `Uint8Array` ("wanted").
4. Immediately wipe every other role's private key, plus seedBytes,
   from the decrypted identity.
5. Run the caller's signing callback synchronously (~10ms).
6. In a `finally` block: wipe `wanted` regardless of success or
   throw.

This pattern makes it physically impossible for the active/owner
private key to outlive the callback frame. There is no
`getActiveKey()` accessor — every consumer must wrap their signing
in the JIT pattern.

**Call sites verified safe.** Every active-key consumer
(`FeatureBidForm`, `PayBlurtModal`, `StrangerFeeModal`, post route,
post-edit route does NOT use active) goes through `runWithActiveKey`
or `useActiveKey` directly. All clear the user's password on both
the success and error paths. All pass the live posting pubkey to
the M6 pin check.

**dblurt PrivateKey behavior verified.** dblurt's `PrivateKey`
constructor stores its 32-byte input by reference (not by copy).
When `useJitKey`'s `finally` block memzeros the buffer, the dblurt
PrivateKey object's internal reference now points to zeroed bytes —
the wrapper is harmless after the wipe. secp256k1's JS wrapper
also passes the seckey through without copying.

**Cross-tab envelope swap defended.** The cross-tab `storage`
listener structurally validates any new envelope before adopting
it. `useJitKey`'s M6 pubkey-pin check is the second line of
defense: if a hostile same-origin tab plants an envelope decrypting
to a different identity under the same password, useJitKey wipes
the attacker's keys and throws `identity_mismatch` rather than
handing those keys to the broadcast callback.

**Sourcemaps disabled in production builds.** Variable names like
`activePriv` and `wanted` are minified in `pnpm build`, raising
the cost of targeted heap-scraping attacks.

**No analytics, no error reporters, no telemetry.** Error stacks
are never sent off-device; raw `err.message` / `err.cause` is
console-warned in some paths but never serialized to the network.

**Known JS-immutable-string limitation (residual).** The
encrypt/decrypt path goes through `JSON.stringify` /
`JSON.parse` with a JSON document containing base64-encoded
private keys. The intermediate JS strings are not zeroable
and live on the heap until the next garbage collection. This
is the same fundamental constraint that K1.2 addressed for the
mnemonic. It cannot be eliminated without dropping JSON entirely.
The exposure window is short (microseconds for the buffer; until
GC for the strings) and any attacker with arbitrary heap-read
access has already won — they can hook the KDF before the wiping
ever happens. Documented here so future maintainers don't think
it's solved by `sodium.memzero(plaintext)` alone.

**User key-backup surface (seed + four WIF keys) is deliberate and
local-only.** On an explicit, opt-in reveal — the "Show my keys"
panel on the account-creation review screen and the `/backup-keys`
page (the latter behind a password unlock) — the user can view and
export their 12-word seed and all four Blurt private keys in
standard WIF form (`owner`/`active`/`posting`/`memo`), via per-line
copy or a downloadable `.txt`.  An account **imported** from an
existing Blurt login has no seed and never can (a seed *derives*
keys; it cannot be built backwards from keys the user already
had — ADR-0050).  Such an account exports an encrypted Keyfile
holding its Posting key, plus its Active key if the user chose to
keep one on the device; Owner and Memo are never held. This exists for backup and for
portability: a Morphit-created account's keys are otherwise only
reachable through Morphit's BIP-39 seed, which other Blurt tools
(e.g. blurtwallet.com) don't understand — they import the
individual WIF keys. The keys are derived on demand
(`crypto/keyExport.ts` → `deriveBackupKeys`, WIFs proven
byte-identical to dblurt) from the live/decrypted identity, shown
only after the user clicks reveal, and fronted by a prominent
don't-share warning baked into both the panel and the `.txt`. This
does **not** weaken "private keys never leave the device": the
clipboard and `.txt` are local to the user's own machine and make
no network calls (verified — the panel and crypto have zero
`fetch`/egress). The residual constraint is identical to the
mnemonic/JSON one above: the rendered WIF strings and the `.txt`
body are non-zeroable JS strings that live on the heap until GC;
the in-memory `backupKeys` array is cleared when the user leaves
the review stage. There is **no account-wide password** — Morphit
never derives keys via the legacy `account+role+password` formula,
so none exists to show. Where an existing Blurt user pastes a key,
Morphit accepts only a standard Active-key WIF and verifies it
against the account's on-chain authorities before signing anything
(`crypto/activeKeyUnlock.ts`); a non-WIF string is rejected outright
as invalid, never used to derive or sign with a key.

**Password-change flow is shipped but UI not yet wired** for the
end user (`useActiveKeyForPasswordChange` exists, `changePassword`
exists; settings page calls the latter with proper finally-block
password clearing). When the change-password UI lands, this
audit's invariants must be re-checked against any new call site.

### 2. Servers see signatures, never keys

- Relay accepts signed ops and broadcasts them; cannot forge user ops
- Indexer reads chain data; cannot author anything on a user's behalf
- Avatar server stores bytes with hashes; user's chain profile is the
  source of truth for which bytes are theirs

### 3. Chat is end-to-end encrypted

- X25519 key agreement + ChaCha20-Poly1305 AEAD (ECIES-style,
  via libsodium); see ADR-0015 for the full protocol.
- Per-message sender ephemerals: each outbound message generates
  a fresh ephemeral keypair, used once and wiped. Provides
  one-sided forward secrecy (sender's posting-key compromise
  doesn't retroactively decrypt past sent messages).
- Recipient's long-term chat identity is derived from their
  posting key. NO per-message receiver-key rotation — by
  deliberate design, see the "Does Morphit chat have forward
  secrecy?" FAQ entry for the full tradeoff rationale.
- Ciphertext on Blurt, plaintext only in participants' browsers.

### 4. Zero tracking, zero logging

- No cookies (encrypted keystore uses localStorage / sessionStorage)
- No analytics, no third-party scripts, no telemetry
- nginx configured with no access logs on user-facing vhosts
- Rate limiting is memory-only per time window, no IP persisted to disk

### 5. Reproducible builds

- Every release is built from a tagged commit with locked dependencies
- Release artifacts include a manifest of SHA-256 hashes
- Third parties can rebuild and compare

## Threat model

### In scope

- **Passive network adversary**: reads traffic between user and Morphit.
  Mitigation: TLS, hidden services, CSP, SRI, no third-party origins.
- **Active MitM**: attempts to inject malicious JS. Mitigation: TLS +
  HSTS + SRI on all scripts + CSP restricting script sources.
- **Compromised Morphit server**: attacker controls morphit.io host.
  Mitigation: cannot steal user keys (never sent); can serve malicious JS
  (partially mitigated by SRI + reproducible builds + PWA cache + PGP-signed
  release pointers on Blurt; user community can detect divergence).
- **Compromised relay**: cannot forge user ops (signatures); can refuse to
  broadcast. Mitigation: multi-relay client-side failover.
- **Compromised indexer**: can serve stale or filtered orderbook.
  Mitigation: peer gossip + client-side fallback indexer list + users can
  consume RSS or run their own indexer.
- **Phishing clone**: attacker stands up fake Morphit site. Mitigation:
  vanity .onion / .loki / .i2p addresses + Blurt discovery op + PGP-signed
  release announcements.
- **Malicious counterparty (scam)**: primary safety mechanism is reputation.
  Secondary: clear "Morphit holds no funds" warnings. Morphit is a pure
  reputation-based bulletin board — there is no escrow, multisig, or
  arbitration service, and there never will be. Reintroducing any of these
  would reintroduce a middleman, which contradicts the project's core
  trust-minimization design.
- **Sybil / fake reputation**: listing fees + escalating fees per 24h +
  self-trade detection + account-age weighting.
- **Order-edit fraud** (replace an accepted order's terms mid-negotiation):
  15-min replace-window lock + state-based lock on `negotiating`. `custom_json`
  ops are natively immutable; Morphit "edits" are layer-2 replacement ops
  the indexer ignores after 15 minutes or after state transition.
  (Window extended from 3 to 15 minutes 2026-05-07; see ADR-0001
  Amendment for threat-model re-analysis.)
- **Display-name spoofing**: display names are user-chosen and not unique.
  The UI ALWAYS renders an identicon (deterministic visual hash from the
  user's identity bytes) next to the username via the project's `IdentityLabel`
  component — the policy is that no render site writes raw `@{account}`
  without the avatar.  Identicons are visually distinct even between
  account names that collide textually (e.g. `@morphit` vs `@morph1t`),
  making phishing / typosquat attacks measurably harder.  Input is
  filtered to disallow control chars, zero-width joiners, and
  bidirectional-override codepoints — all classic spoofing vectors.
  Homoglyph attacks (e.g. Cyrillic "а" for Latin "a") are not blocked
  textually but cannot fake the identicon, since the identicon is derived
  from the actual identity bytes (different on-chain account = different
  identicon, regardless of how similar the display name looks).
- **Feedback tampering**: feedback is never editable.

### Out of scope (v1)

- **Compromised user device**: if the user's device is rooted / malware-
  infested / physically stolen while unlocked, Morphit cannot protect keys.
  This is a platform-level problem.
- **Coerced disclosure**: user forced to reveal password. Mitigation
  (partial): Privacy Mode (sessionStorage) + fresh-key-per-trade option +
  plausibly deniable encrypted-volume backups (documented, not enforced).
- **Quantum adversary**: current crypto (ed25519, X25519, XSalsa20, SHA-2)
  is not post-quantum. Migration path to PQ primitives is a future ADR.
- **Sovereign state attacker**: a well-resourced state can block Tor /
  Lokinet / I2P / clearnet. Mitigation: multiple transports, but this is
  an arms race we cannot claim to win.

## Key handling contract

Every PR touching key-handling code must explicitly answer:

1. Does this code call any network API with key material in scope?
2. Does this code log any variable derived from a key?
3. Does this code write key material to any storage other than the
   encrypted keystore?
4. Is the key zeroed (where possible) after use?
5. Does this code hold an `active` or `owner` private key in any scope
   that outlives a single signing operation? (It must not — use
   `useActiveKey` / `useOwnerKey` with a callback.)
6. Does this code pass a `FullIdentity` (all four private keys) to any
   code path other than the keystore encrypt/decrypt pair? (It must not
   — only the keystore module holds full sets; everything else receives
   a `LiveIdentity` with `posting` + `memo` only.)

CI blocks merges that fail the key-handling checklist (Phase 2+).

## Cryptographic primitives

| Purpose                 | Primitive                      | Library        |
|-------------------------|--------------------------------|----------------|
| Keypair (signing)       | secp256k1 (Blurt-compatible)   | dblurt         |
| Chat identity           | X25519 (BLAKE2b from posting)  | libsodium      |
| Chat key agreement      | X25519 (per-message ephemeral) | libsodium      |
| Chat AEAD               | ChaCha20-Poly1305 (IETF)       | libsodium      |
| Keystore AEAD           | XSalsa20-Poly1305 (secretbox)  | libsodium      |
| Password KDF            | Argon2id                       | libsodium      |
| Hash                    | SHA-256, BLAKE2b               | libsodium      |
| Signed ops on chain     | Blurt native (secp256k1)       | dblurt         |
| Identicon               | deterministic from pubkey      | internal       |

The chat AEAD and keystore AEAD use distinct sodium primitives:
chat encryption goes through `crypto_aead_chacha20poly1305_ietf_*`
(audited code at `apps/web/src/lib/chat/crypto.ts`), keystore
encryption goes through `crypto_secretbox_easy` /
`crypto_secretbox_open_easy` (XSalsa20-Poly1305, audited code
at `apps/web/src/lib/crypto/keystore.ts`).  Both are
authenticated; the choice differs because the chat path uses
the IETF nonce shape required for compatibility with future
inter-implementation interoperability, whereas the keystore is
purely local and uses the more storage-compact secretbox form.

## Subresource integrity

All `<script>` and `<link rel="stylesheet">` tags on Morphit pages include
an `integrity="sha384-..."` attribute. The build pipeline generates these
automatically and rejects builds where any asset is served without SRI.

## CSP (per-vhost)

Baseline CSP (Phase 2 revision; tightened per-vhost in Phase 5):

```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
font-src 'self';
connect-src 'self' https:;
frame-ancestors 'none';
form-action 'self';
base-uri 'self';
object-src 'none';
```

`connect-src 'self' https:` allows the endpoint rotator to reach the
Blurt RPC pool (rpc.drakernoise.com, blurtrpc.dagobert.uk,
rpc.blurt.blog, rpc.beblurt.com, rpc.blurt.one, blurt-rpc.saboin.com) plus any user-added community mirrors. A narrower
per-endpoint CSP isn't feasible because the user can add their own
endpoint through Settings. Mitigation: every outbound RPC request goes
through the rotator, which sets `credentials: 'omit'`,
`referrerPolicy: 'no-referrer'`, and `cache: 'no-store'` — no cookies,
no referer leakage, no cache poisoning opportunity. Request payloads
are JSON-RPC envelopes only; no key material is ever in the body.

No `'unsafe-inline'`, no `'unsafe-eval'`, no CDNs, no Google Fonts, no
analytics origins. `frame-src` remains absent (implicit `default-src`
= `'self'`); Phase 2's FAQ explicitly links out to blurt.media for
video tutorials rather than embedding, preserving the strict frame
policy.

## Reproducible build protocol (Phase 1 draft)

1. Lock dependencies with exact versions in `package-lock.json`
2. Build in a containerized, deterministic environment (Phase 5: Nix or
   Docker pinned digest)
3. Strip build timestamps and random IDs from output
4. Produce `build-manifest.json` with SHA-256 of every emitted file
5. Sign the manifest with the release key; publish signature alongside

Phase 1 establishes the scaffolding; Phase 5 closes the last gaps.

## Responsible disclosure

Security researchers: please contact via Matrix (address in repo post-
Phase 5) or by posting an encrypted `custom_json` to the `morphit` Blurt
account using a published GPG key (Phase 5 deliverable).

## Phase 2 addendum — additional threat-model entries

### In scope (added in Phase 2)

- **Malicious local script reading unencrypted `localStorage` keys.**
  Morphit stores several non-key values unencrypted in `localStorage`:
    - `morphit.blurtAccount` — the user's chosen Blurt account name
      (public; visible on the blockchain anyway)
    - `morphit.displayName` — the user's chosen display name (public;
      broadcast as `morphit_profile_v1` when registered)
    - `morphit.rpcEndpoints` — the user's customized RPC endpoint list
      (low-sensitivity; reveals which community mirrors they prefer)
    - `morphit.btc.hashes` / `morphit.xmr.hashes` — SHA-256 hashes of
      receiving addresses the user has previously entered (for the
      address-reuse warning). The hashes are one-way, so an attacker
      reading them cannot recover the addresses, only confirm whether
      a specific candidate address has been used before
    - `morphit.locale` — the user's chosen UI language
    - `morphit.updateDismissed` — a flag (sessionStorage only)
  **Mitigation:** no private-key material is stored here. An attacker
  with a local-script vector (XSS, supply-chain compromise) can read
  these values but cannot impersonate the user, broadcast ops, or
  recover addresses. The only key material in process memory is the
  posting + memo private keys (ADR-0002); compromising those is bounded
  to "can sign Morphit ops" — no funds movement, no account recovery,
  no chat history reconstruction of past sent messages (sender-side
  PFS holds — sender ephemerals are wiped after use).
  **Why not encrypt these:** they're inputs to a display layer that
  must work before the user unlocks their keystore. Encrypting them
  would require prompting for a password on every page load.
  The cost-benefit favors leaving them plain.

- **Session-memory-only exfiltration of `posting` / `memo` privates.**
  The LiveIdentity's posting and memo private keys are in browser heap
  while the user is signed in. A rogue script in the same origin can
  read them via the identity store's exported subscriber. **Mitigation:**
  strict CSP (no `'unsafe-inline'`, no `'unsafe-eval'`, no third-party
  origins), SRI on every external resource, reproducible builds that
  let the community detect a compromised host. Phase 4 adds the
  WhaleVault / Gravity extension path which removes these keys from
  Morphit's origin entirely. See ADR-0002 for the full key-handling
  policy.

### Tiered key-handling policy (ADR-0002, now authoritative)

Section 1a above states the policy informally; ADR-0002
(`docs/adr/0002-live-keys-policy.md`) is the authoritative write-up,
including alternatives considered and follow-up work. Future PRs that
propose relaxing this policy must supersede ADR-0002 with a new ADR.

### On-chain data is public by design

Every order, feedback, profile update, and encrypted chat ciphertext
Morphit broadcasts is readable by anyone running a Blurt full node. This
is a feature, not a bug — it's what makes Morphit's reputation system
verifiable and what makes the orderbook survive any single server going
offline. Users should understand that:

- **Orders** reveal trading intent, approximate geography, and the
  user's Blurt account name.
- **Feedback** is permanent, signed, and publicly associated with the
  reviewer's account.
- **Chat ciphertext** is visible as a blob on chain; only its content is
  opaque. An adversary cannot read it but can see that two accounts
  exchanged a message at a specific block height.

The FAQ entries `data_collection`, `chat_privacy`, and `feedback_immutable`
communicate this to users; the orderbook UI will surface it again at
post-time in Phase 3.

## Addendum changelog

- 2026-04-17 — Phase 2 sign-off addendum: localStorage threat-model,
  ADR-0002 pointer, CSP `connect-src` revision for RPC pool,
  on-chain-publicness reminder.
- 2026-04-18 — Phase 3a security pass: attack-class review
  (ADR-0006), operator responsibilities, known minor threat-model
  items. See "Phase 3a addendum" below.

## Phase 3a addendum

### Attack-class review

A formal review of attack vectors — HPP, SSRF, CSRF, RCE, OAuth
vulnerabilities, GuzzleHttp CVEs, xmlrpc.php, DDoS, parameter
validation, and related classes — lives in
[`docs/adr/0006-security-posture-phase3a.md`](adr/0006-security-posture-phase3a.md).
Each vector is classified as *covered* (mitigated in code or
config), *not-applicable* (structurally prevented — e.g. no PHP
means no PHP-specific CVEs), *deferred* (tracked for a specific
later phase), or *out-of-scope* (operator/infrastructure
responsibility). That ADR is the authoritative answer to "Is
Morphit vulnerable to X?"

The public-facing FAQ entry `security_attack_vectors` (available
in all 10 supported locales) summarises the headline defenses for
users who don't want to read an ADR. It points the technically
inclined here.

### Known minor threat-model items

These are accepted residual risks for Phase 3a, documented so they
are not mistaken for missed coverage.

- **Timing on dedupe check.** The relay's account-creation
  dedupe uses linear scan + string equality on SHA-256 hashes of
  public material (the user's new pubkeys). A timing side-channel
  here would leak at most "is this exact fingerprint in the
  one-minute dedupe window?" — information the attacker already
  has from their own submission. The scan is bounded to ~5
  entries by the rate limiter. Not fixed in 3a.
- **TOCTOU on availability.** Between the pre-broadcast chain
  check and the actual broadcast, another actor could claim the
  name. The chain rejects the double-registration and the relay
  returns `already_registered` — the same error code the
  pre-check returns — so the user experience is consistent. No
  funds are spent on the rejected transaction (Blurt validates
  before collecting the fee).
- **Log-injection surface.** The relay's log function interpolates
  configuration values (relay account name, endpoint URLs) which
  are schema-validated at boot to contain no newline or control
  characters. No user-supplied string reaches a log line.
  Structured logging with a library like Pino is a Phase-4
  improvement but not a safety gap.
- **Supply chain.** `npm ci --omit=dev` with a committed lockfile
  pins versions and integrity hashes. Dependency count is
  deliberately small (~4 runtime deps for the relay). Residual
  risk: npm's own signing is what it is. Phase 5 can evaluate
  `socket.dev`, `npm-audit-resolver`, or similar.
- **Password-string memory residue.** The keystore-decrypt path
  takes the user's passphrase as a JS `string` (see
  `apps/web/src/lib/crypto/keystore.ts`). Everything the code
  derives from the password — symmetric keys, salts, intermediate
  buffers — is scrubbed via `sodium.memzero()` after use. The
  **password string itself** cannot be scrubbed: JS strings are
  immutable, so whatever the user typed sits in V8's string
  table until non-deterministic GC reclaims it. A memory-dump
  attacker reading the renderer process during that window
  could recover the plaintext password.

  **Attacker model required for exploitation:** live browser-
  process read access. An attacker at that privilege level has
  already compromised the device — they can also read the
  decrypted posting key from `LiveIdentity`, the active chat
  plaintext, session cookies, and anything else the renderer
  holds. The password residue is the least of the user's
  concerns.

  **Why we don't refactor to `Uint8Array` throughout:**
  byte-array passwords *can* be zeroed, but the refactor
  touches every login / unlock / password-change site and
  closes exactly one window in a house where every other
  window is already open at the same privilege level. Not a
  meaningful hardening trade against the engineering cost.
  This is a universal ceiling of browser-based password
  handling (libsodium's own docs call it out); every web-
  crypto app has it. Accepted residual risk; not treated as
  a gap.

### Operator responsibilities

Some attack surfaces cannot be closed in Morphit's code alone.
These are the operator's responsibility:

- **Volumetric DDoS.** Network-layer floods require upstream
  scrubbing (VPS provider, Cloudflare, or equivalent). Morphit's
  application-layer mitigations (rate limits, body caps, tight
  resource ceilings) handle L7 abuse but cannot absorb L3/L4
  volumetric attacks. Document your DDoS response plan.
- **OS and runtime patching.** Keep Node.js, nginx, and the host
  kernel current with security updates. `unattended-upgrades` on
  Ubuntu or equivalent is the minimum baseline.
- **Key rotation.** The relay's active key should be rotated
  quarterly or on suspicion of compromise, per the procedure in
  `apps/relay/README.md`. An ADR for the formal rotation policy
  lands in Phase 4.
- **Balance monitoring.** Watch the relay's BLURT balance. A
  sudden drop suggests either heavy legitimate use (good signal
  to top up) or abuse (investigate). Phase 5 adds Zabbix
  alerting; until then, a simple cron job polling
  `/v1/health` is enough.
- **Abuse response via fail2ban.** The relay does not log IPs
  (privacy commitment). However, systemd journal entries of
  rate-limit rejections are transient and can be consumed by
  `fail2ban` to install iptables bans without persisting IP data
  to disk. A `jail.local` snippet is documented in the relay
  README.
- **`npm audit` on every deploy.** Run `npm audit` before every
  production deploy and before bumping any dependency. If an
  advisory is found, decide explicitly: upgrade, pin to a fork,
  or accept the risk with a note in the relevant ADR.

### Known supply-chain advisories (May 2026 audit)

This is the snapshot accepted-risk set as of the May 2026 audit.
A new operator running `npm audit` should expect to see these
and should investigate **only the diff** — anything new beyond
this list deserves immediate triage.

**Production (runtime):**

| Package | Severity | Status |
|---|---|---|
| `elliptic <=6.6.1` (previously via `secp256k1@^4.0.3`'s pure-JS fallback under `@beblurt/dblurt@0.10.9`) | Medium (CVSS ~5.6) | **Resolved (v1.8.0)** — removed from the tree |

`elliptic` carries two relevant advisory classes:
- The long-standing timing-side-channel advisory
  ([GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84))
  in its secp256k1 implementation.
- **CVE-2025-14505** (published 2026-01-08), an ECDSA flaw: when
  computing the nonce `k` per RFC 6979, `elliptic` may incorrectly
  truncate `k` if the interim value has leading zeros (the
  byte-length of `k` is mis-computed), producing invalid
  signatures. The serious tail: given both a faulty signature and
  a correct signature over the same input + key, an attacker could
  potentially derive the secret key.

**RESOLVED in v1.8.0 by upgrading `@beblurt/dblurt` 0.10.9 → 0.17.0.**
When first assessed, `elliptic` reached Morphit transitively through
`@beblurt/dblurt@0.10.9`'s `secp256k1@^4.0.3` dependency, whose
pure-JS/browser fallback is `elliptic`; no dblurt release then dropped
that chain, so it was accepted with the threat model below. dblurt
**0.17.0** replaced that dependency with `@noble/secp256k1` +
`@noble/hashes` internally, so upgrading removed `elliptic` from the
dependency tree **entirely** — for both the browser and the relay in a
single move (verified: zero `elliptic` directories under `node_modules`,
zero entries in `package-lock.json`). Morphit's own signing already used
`@noble/secp256k1` for key-derivation and the power-down path; the
upgrade also modernized dblurt's internal ECDSA to noble. CVE-2025-14505
(the RFC-6979 nonce-truncation flaw above) and the timing-side-channel
advisory no longer apply — the package is gone. The upgrade was certified
before shipping with byte-identity serialization + round-trip signing
tests across every op-class (transfer, custom_json, comment, feature_bid,
stranger_fee, withdraw_vesting, account_create, delegate_vesting_shares).

**Threat model assessment for Morphit:**
- *Browser signing* (frontend, user's keys): exploitation requires
  local timing-attack precision against the user's own machine.
  An attacker who already has that capability has easier paths.
  Not reasonably exploitable from a remote attacker.
- *Relay signing* (server, relay active key): the active key is
  used for relay-funded account creation and 1-BLURT signup
  dust transfers. A remote timing attack against `/v1/account/
  create` would need to extract bits from response timing —
  but the relay batches, makes upstream chain calls, and is
  rate-limited at multiple layers. Network-level jitter
  dominates any signing-time signal. Not reasonably exploitable.
- *Indexer*: read-only, no signing, no exposure.
- *CVE-2025-14505 specifically* (paired-signature key derivation):
  the key-extraction path requires an attacker to obtain BOTH a
  faulty signature AND a correct signature over the **same**
  message + key. Morphit never re-signs the same operation with
  the same key twice (each chain op is unique — nonces, permlinks,
  and timestamps differ), so the "same input, two signatures"
  precondition does not arise in normal operation. The invalid-
  signature failure mode (a mis-truncated `k` producing a
  rejected op) is a liveness nuisance, not a key-disclosure event,
  and the chain rejects the malformed signature rather than acting
  on it. Re-evaluate if any future feature signs identical payloads
  repeatedly with a long-lived key.

**Build/test (not in production bundles):**

| Package | Severity | Note |
|---|---|---|
| `cookie <0.7.0` (via `@sveltejs/kit`) | Low | Morphit doesn't use cookies (privacy commitment); not exploitable |
| `esbuild <=0.24.2` | Moderate | Dev-server only; production builds emit static files |
| `vite`, `vite-node`, `@vitest/mocker`, `vitest` | Moderate | Test/build tooling; never in production |
| `@sveltejs/vite-plugin-svelte`, `svelte-i18n` | Moderate | Build deps; not runtime |

**Optional sidecar — only if the operator enables the Matrix
incident-pager bot (`apps/matrix-bot`):**

The Matrix bot is an OPTIONAL operator component (see
OPERATIONS.md §16 "Routing alerts elsewhere").  Operators who
don't run it ship NONE of the advisories below.  When it IS
installed it is a *runtime* dependency, so these surface under
`npm audit --omit=dev` too.

| Package | Severity | Status |
|---|---|---|
| `request *` (deprecated; via `matrix-bot-sdk`) | Critical — SSRF (GHSA in `request`) | Accepted (optional sidecar) |
| `form-data <2.5.4` (via `request`) | Critical (GHSA-fjxv-7rqg-78g4) | Accepted (optional sidecar) |
| `qs <=6.15.1` (via `request`) | Moderate | Accepted (optional sidecar) |
| `tough-cookie <4.1.3` (via `request`/`request-promise`) | Moderate | Accepted (optional sidecar) |
| `uuid <11.1.1` (via `request`) | Moderate | Accepted (optional sidecar) |

All of these chain from `matrix-bot-sdk`'s dependency on the
deprecated `request` HTTP library.  **No fix is available** —
`matrix-bot-sdk@0.8.0` (the latest release as of this audit)
still pins `request: ^2.88.2` + `request-promise: ^4.2.6`, and
`request` itself was deprecated in 2020 and will not be patched.
Bumping the SDK does not remove the chain.

**Enforced by CI:** the two CRITICALs here (`request` SSRF and
`form-data` boundary) are the allowlisted entries in
`apps/web/scripts/npm-audit-gate-smoke.ts`, which runs
`npm audit --json` on every build and fails on any **new**
HIGH/CRITICAL — or any new CVE title for an already-allowlisted
package — that isn't reviewed there.  This table and that gate
are two views of the same accepted-risk set; keep them in sync.

**Threat-model assessment for Morphit:**
- *Optionality.* The bot only runs if the operator opts into
  Matrix alerting.  It is a sidecar, not part of the indexer or
  relay; it holds **no Morphit keys**, touches **no user funds**,
  and is not on any trade path.
- *Input surface.* The bot's only inputs are the operator's own
  `journalctl` stream (which it tails and classifies) and its
  only outbound traffic is posting alert messages to the
  operator's **own** Matrix homeserver.  It accepts no requests
  from untrusted parties.
- *`form-data` (the critical).* The advisory is a predictable
  multipart boundary chosen with a non-cryptographic RNG — it
  matters when an attacker can observe or inject boundaries to
  smuggle multipart content.  The bot sends simple text alerts to
  a trusted homeserver and accepts no untrusted multipart upload,
  so there is no attacker-controlled boundary surface here.
- *`qs` / `tough-cookie` / `uuid`.* Reachable only via the bot's
  own outbound requests to its trusted homeserver; no remote
  attacker drives the bot's HTTP layer.  Worst-case compromise is
  scoped to the alerting path, not the indexer/relay/funds.

**Recommended operator practice for the bot:** if your threat
model can't accept a deprecated transitive HTTP dependency, route
alerts via one of the non-bot paths in OPERATIONS.md §16 (the bot
is the convenience option, not the only one) and don't install
`apps/matrix-bot`.  Either way, monitor `matrix-bot-sdk` upstream
for a `request`-free release.

**Recommended operator practice:** when deploying, run
`npm audit --omit=dev` for the runtime-only view. The expected
runtime diff is `elliptic` always, plus the `matrix-bot-sdk` /
`request` cluster above **iff** you installed the optional Matrix
bot. If anything beyond those shows up, triage before deploying.
The build/test advisories above are real but exposed only on the
build host (CI or dev machine), which should already be
isolated from production.

**Recommended Morphit-project practice:** `elliptic` is
effectively unmaintained (no release in ~12 months) and
CVE-2025-14505 is unfixed across all published versions, so the
durable path is to move off it rather than wait for a patch.
The frontend already depends directly on `@noble/secp256k1`
(constant-time, actively maintained).

**Migration status (cp173–cp174):** a `@noble/secp256k1`-based
Blurt signer has been built, proven, and **wired** into the
frontend signing path behind the `SIGNER_BACKEND` flag in
`apps/web/src/lib/net/config.ts` (see ADR-0046). Feasibility is
proven against dblurt's own verifier — graphene chains verify by
public-key recovery, and noble signatures recover to the correct
key (`scripts/blurt-noble-signer-recovery-proof.ts`, 300/300;
full-transaction coverage incl. transfer/order/comment/custom_json
in `scripts/blurt-noble-tx-signature-proof.ts`). Every signer in
`apps/web` honors the flag (enforced by
`scripts/signer-backend-consistency-smoke.ts`). The default remains
`'dblurt'` deliberately: flipping to `'noble'` is gated on one real
Blurt chain broadcast per op class confirming end-to-end
acceptance, which cannot be done without chain access. Until that
flip, `elliptic` remains in the tree transitively and its
advisories are accepted risk per the threat model above. Also
monitor `@beblurt/dblurt` upstream for a `@noble`-based signer that
would let the dependency be dropped entirely. Tracked as a standing
REVISIT item.

### Legal considerations for operators

Morphit's non-custodial, no-KYC, chain-native design narrows legal
exposure significantly, but does not eliminate it. These are not
code concerns but should shape deployment posture:

- **Sanctioned-country trades.** Without KYC, a Morphit frontend
  cannot block a user in a sanctioned jurisdiction from reading
  the orderbook. However, Morphit itself never facilitates the
  atomic trade — two users agree off-platform (Matrix chat,
  external wallets), and the per-asset settlement transfer
  (BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, or XRP) happens
  between their own wallets. The operator hosts a reader over
  public chain data, not a money-transmission service.
- **Takedown requests.** Orders live on the Blurt blockchain and
  cannot be deleted by any frontend operator. If a local
  authority demands a particular order be filtered from the
  morphit.io frontend, that is a *display* decision, not a
  data-integrity issue. Other frontends — including
  self-hosted ones — continue to index and show the same data.
- **Release-discovery impersonation.** The pinned
  `MORPHIT_OFFICIAL_POSTING_PUBKEY` constant in
  `$net/config.ts` defends against a malicious actor forging
  release-discovery ops claiming to be from `@morphit`. Clients
  verify the signature against this pinned key and ignore ops
  that don't match.

## Phase 5d addendum — chat anti-spam and attestation sybil defenses

### Finding H mitigations — chat anti-spam triad (SHIPPED 2026-04-24)

A belt-and-suspenders defense against unsolicited chat message
floods, designed so no single layer has to stop a motivated
attacker alone.

**Layer 1 — block list.** `morphit_block_v1` op records a block
from one account against another in the `blocks` table. The
chat handler consults this table before persisting any message
and rejects `recipient_blocked_sender` on match. The UX does
NOT notify the blocked user; the op is public on-chain (anyone
scraping Blurt can see it) but the Morphit frontend
deliberately does not surface "you are blocked by @X" —
raising awareness of the block turns it into a provocation
vector rather than a defensive signal.

**Layer 2 — stranger-fee admission.** First-contact messages
between two accounts that have never exchanged require either:
(a) a prior admitted message in either direction, (b) a paid
`morphit_stranger_fee_v1` op carrying a $0.01-USD-equivalent
BLURT transfer to @morphit-fees with memo binding
`morphit-stranger:<recipient>`. The memo binding prevents a
single paid transfer from being replayed to pay for messaging
100 different people. The fee amount is fixed in indexer code
(not configurable) so a lax operator cannot undercut the
anti-spam economics. Deploy-safety condition (a) ensures
pre-existing conversations are not retroactively broken when
the gate first lands.

**Layer 3 — rate limits.** The chat handler enforces two
complementary caps, both gated on "recipient has not replied":
fan-in (≤20 unique never-replied senders per recipient per
rolling 24h) and per-pair no-reply cap (≤50 messages from one
sender to one recipient with no reply, ever). A single reply
from the recipient lifts both caps for the pair forever. The
values are permissive enough that normal usage (asking
follow-up questions of an unresponsive correspondent) is
unaffected; only flood-scale patterns are throttled.

The three layers run in order (block → admit → rate-limit) so
blocked senders' messages cannot push legitimate senders toward
the fan-in cap.

### Finding I mitigation — attestor eligibility (SHIPPED 2026-04-24, indexer side)

ADR-0011 §3 requires ≥2 distinct attestors with ≥1 non-poster
to promote a BTC/XMR order's fee status from
`pending_external` to `verified_by_attestation`. Without
further gating, a grifter could cheaply farm accounts (the
@morphit-relay welcome waiver creates them for free), have
each throwaway attest their own never-paid fee, and bypass the
$0.125 listing fee.

The indexer now requires each attestor to satisfy a **loyalty
threshold** (cumulative 100 BLURT paid in listing fees —
matching the first loyalty milestone) OR/AND an **age
threshold** (account created ≥30 days ago on the Blurt chain).
The gate runs in two phases controlled by the
`MORPHIT_INDEXER_ATTESTATION_PHASE` env var:

- **Launch** (OR gate): attestor qualifies by meeting either
  condition. Lower bar for ecosystem bootstrap while still
  blocking same-day-farmed sock accounts (they would need to
  pay $20+ OR wait a month).
- **Steady** (AND gate): attestor must meet both. Makes
  sustained sybil abuse negative-ROI — the attacker must both
  wait 30 days AND pay $20+ per sock puppet, to bypass a
  $0.125-per-order fee.

The phase flip is an operator config change, not a redeploy.
Per the ADR-0011 addendum, the transition trigger is whichever
comes first: 90 days after the ADR-0011 activation OR 500
accounts on the chain that already meet both thresholds.

Failed attestations record four distinct rejection reasons
(`attestor_account_not_found`,
`attestor_insufficient_loyalty_and_young_account`,
`attestor_insufficient_loyalty`, `attestor_young_account`) so
the frontend can tell a legitimate user exactly what they're
missing — "wait 12 more days" or "pay 52 more BLURT in fees"
rather than a generic "not eligible."

## Phase F.5 addendum — known residual trust assumptions

Phase F.5 introduced on-chain verification of BLURT trade
payments.  The following residual trust assumptions apply to
this feature:

### Single Blurt RPC trust (audit F-11)

The verifier fetches transaction details from one of the
shipped Blurt RPC nodes (the six documented in
`apps/web/src/lib/net/config.ts`).  A hostile RPC can:

- Fabricate a `verified` result for a transfer that doesn't
  actually exist on chain
- Hide a real on-chain transfer (return `not_found` or
  `wrong_op`)
- Tamper with transfer fields (memo, amount, sender, recipient)

Mitigations in place:

- **Defense via quorum:** the chain-RPC verifier (audit 2-7)
  fans out to multiple endpoints and requires 2-of-3 agreement
  before treating a result as authoritative. A single hostile
  RPC cannot forge or hide a transaction unilaterally.
- **Defense via observability:** the same chain is observable
  by both parties (buyer and seller).  If a quorum-passing
  result later turns out to be wrong, the buyer can
  independently verify via their own wallet's transaction
  history.  Phase F.5 audit fix (F-14) added buyer-side
  self-verification, which fires from the buyer's RPC
  perspective — disagreement between buyer's view and seller's
  view of the same txid would surface as contradictory mismatch
  reports.
- **Operator-extensible endpoint list:** the canonical Morphit
  deployment ships six endpoints (rpc.drakernoise.com,
  blurtrpc.dagobert.uk, rpc.blurt.blog, rpc.beblurt.com,
  rpc.blurt.one, blurt-rpc.saboin.com).
  Operators concerned about RPC trust can add their own node
  via Settings.
- **Verification is not the primary settlement mechanism:**
  the on-chain transfer is what actually settles the trade.
  The verifier is a UX aid that surfaces mismatches faster than
  the seller/buyer would otherwise discover them.  A wrong
  "verified" result might briefly mislead the seller, but they
  would discover the missing funds when reconciling their
  wallet.

Future architectural mitigation: multi-node quorum verification
(verify against 2-of-3 RPCs).  Heavier engineering cost; not
landed pre-launch.  Tracked as a post-launch enhancement.

### tradeStatus lock-on-engagement (audit F-40)

The trade-status entry for a given `orderPermlink` is
**peer-locked** the moment the local user sends an outgoing
structured payload (address-shared or funds-sent) for that
permlink.  Once locked, incoming payloads from a peer other
than the engaged peer are dropped at the store layer.

This prevents a third-party chat partner — who knows a public
orderPermlink because Blurt posts are public — from poisoning
the entry's `expectedMemo` to fool the verifier into a false
mismatch.

Residual: until the user engages, **any** chat partner can
populate a tentative entry.  The verifier guards against
this by consulting the stored `expectedMemo` ONLY when
`engagedPeer === message.sender`; otherwise it falls back to
the buyer's echoed memo (Phase F.4 baseline).

### Listener decrypts every recent-peer chat (audit F-23)

The cross-page trade event listener decrypts every incoming
chat message across the user's recent-peers list (capped at 5
streams per F-21) just to check whether the plaintext is a
structured Morphit payload.  Plaintext briefly resides in
memory for messages the user never reads from the chat page.

Mitigations: the decrypted plaintext is only retained long
enough to call `decodePayload`; after that, the surrounding
function frame goes out of scope and the plaintext is GC'd.
Memory inspection by a malicious browser extension or
attached debugger could intercept this transient plaintext —
same class as any other in-memory secret.

Operators or privacy-conscious users can disable browser
notifications via the `tradeNotificationsEnabled` preference
(Settings).  This suppresses the OS-level notification but does
NOT stop the listener from running — toasts still appear and
ambient decryption still happens.  A future enhancement (audit
F-23) would add a separate toggle for the listener itself, fully
disabling cross-page trade events at the cost of losing badge
updates.


## Phase 5e addendum — 2026-05 audit campaign

This addendum captures security-relevant invariants and known
residual trust assumptions added during the multi-session audit
campaign documented in `docs/AUDIT-2026-05.md` (Parts 1-14).
Read the audit doc for the full STRIDE matrices, attack trees,
and red-team narratives; this addendum extracts the
externally-relevant invariants for operators and security
researchers.

### Audit posture summary

The 2026-05 campaign performed a sustained per-subsystem review
covering identity & key handling, chat crypto, custom-json op
handlers, trade settlement, federation & relay surface,
frontend, cross-cutting & temporal concerns, build & supply
chain, and a deeper audit on the user-question-driven feature
batch (Q1-Q11 + their follow-ups #4-#6). Each pass produced a
STRIDE matrix, attack trees, red-team narratives, and a
findings catalogue with severity ratings. Findings were either
fixed inline (the majority), deferred to `docs/REVISIT-LIST.md`
with full context, or accepted with documented rationale. The
campaign is ongoing; the audit document is a living log that
gets a new part each time we audit a meaningful change.

### Q11 chat handler — order-permlink bypass

A chat-payload field `order_permlink` (plaintext on chain) was
added so that recipients of an order can be messaged for free
about that specific order without paying the stranger fee. The
field is **deliberately plaintext** (not inside the encrypted
envelope) because it must be readable by the indexer for the
gate decision, AND because the on-chain transaction's
existence already discloses sender→recipient at time T — adding
"about order X" reduces the attacker's correlation work from
"scrape + correlate" to "read directly," which is a marginal
but real privacy regression.

Validation invariants (apps/indexer/src/indexer/handlers/chat.ts):
1. Block list fires FIRST — bypass cannot override a block
2. `order_permlink` validated as a string matching
   `^[a-z0-9][a-z0-9-]{2,255}$`
3. Orders lookup binds `account = $recipient` (NOT `$signer`)
   so the claimed order must be owned by the message recipient,
   not the sender — closing "post my own order to unlock chat"
4. Rate limits (per-pair PER_PAIR_NO_REPLY_CAP=50,
   per-recipient FAN_IN_UNIQUE_SENDERS_24H=20) apply
   uniformly — bypass shaves the per-sender stranger fee but
   does not change the per-recipient ceiling

Residual: an attacker provisioning sock accounts can amplify
spam up to the fan-in cap (~$4 in account-creation fees for
20 distinct senders per victim per 24h). This is documented
and considered acceptable given the bounded amplification and
existing Sybil-detection signals.

### Engagement counter (schema-v25) — known limitation

The orderbook surfaces a per-order engagement signal
(`engagement_24h`: distinct-senders-in-last-24h who messaged
about this order). Computed from
`chat_messages.order_permlink` (added in v25 migration) which
itself is the Q11 plaintext field above.

Same Sybil amplification applies: an attacker can inflate this
chip up to the fan-in rate limit. Mitigation options
(`feedback_count > 0` filter, "5+" cap on display) tracked in
REVISIT-LIST under BATCH14-2; pre-launch the working signal is
preferred over the harder-to-debug filtered version.

### Real-time balance card

`MyBalanceCard.svelte` polls the user's RPC every 5 seconds
when the tab is visible (paused on hidden) and additionally
listens on an in-process pub/sub bus that producers fire on
known balance-changing events (BLURT-paid broadcast success,
verified BLURT receipt). In-flight refresh dedup added in
BATCH14-3 — a tick or bus-nudge while a refresh is mid-flight
is silently dropped to prevent RPC pile-up on slow upstreams.

The bus is **in-process only** — no cross-tab or cross-origin
signal channel. An attacker controlling another tab cannot fire
the bus. An attacker who controls page JS (via XSS) can fire
arbitrary bus events, but the underlying balance values come
from chain RPC; the bus only accelerates legitimate refreshes.

### Account-creation key handling (ACT-mint timer removed)

The weekly ACT-mint ceremony — and its dedicated
`morphit-relay-mint-acts` systemd timer, which loaded the
relay's active-key passphrase via a `LoadCredential=` mount —
was **removed at beta.28** (Blurt disabled `claim_account` /
`create_claimed_account` at hard fork 2). Account creation is
now a direct `account_create` op the relay's **main** service
broadcasts inline at signup time, so there is no longer a
separate periodic process loading the passphrase.

The passphrase residual that section described still applies to
the relay's main service: the active-key passphrase enters the
V8 heap as a JavaScript string at unlock and stays there until
garbage collection — a known limitation of any JS service
handling secrets. High-threat-model operators should use
`LoadCredentialEncrypted=` (see `man systemd-creds`) and size
host physical security to the fee volume they process. See
ADR-0010 §4 for the relay's in-memory key posture.

### Price-feed posture

The indexer's price feed reads BLURT/USD as an outlier-rejected
**median across several independent external feeds** (Coingecko,
CoinPaprika, CryptoCompare, and — for the assets they list —
Kraken/Binance/Coinbase/OKX/Bybit, plus the optional key-gated
CoinCap/Messari). (Klingex, the former BLURT-only primary, went
out of business in 2026 and was removed; rather than depend on a
single replacement, the external tier averages many feeds.) No
single provider banning us, rate-limiting us to nothing, or
returning a bad number can move the published price — any feed
that returns nothing is dropped from the median, never
substituted with a guess. The USD echo on
Morphit's benefits ladder and other UI surfaces is
**display-only** — not a settlement reference. Operators who
anticipate an upstream outage or compromise can disable the
price feed entirely; the BLURT-denominated fees and amounts
continue to work without the USD overlay. Behind the external
median sit the opt-in self-sovereign morphit_native source and
the static floor, so the chain degrades rather than breaks.

Operator-trust assumption (BATCH14-4): a malicious operator
can lie about the fiat price displayed alongside BLURT amounts
(`blurt_price_fiat` on `/v1/listing-fee`, formerly `usdPerBlurt`
in the frontend state) to mislead users about how much fiat
their BLURT actually represents. This is the pre-existing
operator-trust boundary; users cross-check by comparing
instances or by visiting `/v1/price/morphit-native/receipt`
(cp127) to see exactly what data the operator's indexer used to
derive the displayed price.  Cp128: the denomination is now
operator-configurable (USD/EUR/XDR/XAU/...); the same trust
analysis applies regardless of the chosen unit.  Not remedied
in code beyond the receipt endpoint; documented as a known
assumption.

### Federation cache + contact_url hardening

The federation probe layer caches peer instances'
`contact_url` from their `/v1/instance` responses. A hostile
peer could populate this cache with a hostile URL. The
indexer's op-intake handler (`operatorRegister.ts`) already
rejects non-`https:` schemes for chain-broadcasted contact_url;
the frontend `PaymentMethodsPicker` adds a defense-in-depth
client-side scheme allowlist (`https/http/mailto/matrix/xmpp/
nostr`) before rendering as `<a href>`. The allowlist also
covers the federation-cached peer values, which never went
through the chain validator.

### nginx/indexer port + body-cap alignment

Operations note: `ops/nginx/indexer.conf` upstream points at
`127.0.0.1:8081` (not 8080) to match the indexer's default
`MORPHIT_INDEXER_LISTEN_PORT=8081` — distinct from the relay's
default 8080 so both services coexist on the same host. The
nginx `client_max_body_size 4k` matches the indexer's
`MORPHIT_INDEXER_MAX_BODY_BYTES` default. Operators
overriding either default should adjust both files.

### Database backup posture

The recommended backup script (RUN-A-MORPHIT-NODE.md §10)
writes nightly gzipped pg_dumps to `/home/morphit/backups/`
mode 0600, prunes after 30 days, and atomically renames from
`.partial` → final to prevent half-written files being
mistaken for valid backups. Backup contents include chat
ciphertexts (which only the participants can decrypt),
feedback content, and engagement aggregates. None of it is
"secret" in the cryptographic sense (all derivable from chain
ops), but the backup file's mode 0600 prevents other local
users from reading it.

Off-server copy is documented but not automated — operators
must add their own rsync/rclone target.

## Responsible disclosure (updated)

Security researchers, please report findings via one of these
channels in order of preference:

1. **Matrix DM** to **`@agorise:matrix.org`** — fastest path
   to a real human on the project.  End-to-end encrypted by
   default in Element/most Matrix clients; no infrastructure
   we run handles the message in cleartext.  Use this for
   anything sensitive enough you wouldn't want a passive
   observer to see.
2. **Confidential issue** at git.agorise.net/agorise/morphit
   (Forgejo supports private issues; mark them as `Confidential`)

For **non-sensitive** questions, general security discussion,
or hardening suggestions that aren't actively exploitable
vulnerabilities, the public room **`#agorise:matrix.org`**
is the right channel.  Do NOT use the public room for active
vulnerabilities — that's what channel 1 above is for.

We commit to:
- Acknowledging receipt within **72 hours**
- Triaging severity within **7 days**
- Coordinating a fix-and-disclose timeline with you
- Crediting your finding in the project changelog (with your
  consent)

We do not run a fixed-tier paid bug bounty.  Instead, Morphit
operates a **discretionary security recognition program** — see
the next section for the full structure.  In short: the canonical
operator (`@morphit-fees`) maintains a treasury that funds bounty
awards on a case-by-case basis, scaled to severity and practical
exploitability.  Significant findings that materially improve
Morphit's security posture are recognized in BLURT or BTC at the
operator's discretion.

What we ask of you:
- Don't publish details of un-patched issues
- Don't access data belonging to other users
- Don't degrade service for other users (no DoS testing
  against production instances; please target a local clone)
- Give us reasonable time to fix before public disclosure
  (90 days is the industry default)

What you can expect from us:
- A real human reading your report, not an auto-responder
- Honest triage — including "we judged this lower-severity
  than you did" with reasoning
- Visible work on the fix, often within hours for
  high-severity issues
- Public credit if you want it

<a id="bounty"></a>

## Bug bounty program

Morphit runs a **discretionary** security-recognition program.
We don't publish a fixed dollar-per-severity table because we
don't want to make a promise we can't keep, and because the
community's idea of "Critical" varies more than the term
suggests.  Instead, we promise:

1. **Every actionable finding gets reviewed by a real engineer.**
2. **Every actionable finding gets an answer** — including
   findings we ultimately decide not to act on, with the reasoning.
3. **Findings that materially improve Morphit's security
   posture get rewarded.**  The reward is set case-by-case in
   BLURT (paid from `@morphit-fees`) or BTC (from a treasury
   address shared at payment time), based on severity, exploit
   complexity, and the report's quality.
4. **Reports we don't pay for still get hall-of-fame credit**
   if you want it — public attribution at /security-credits, in
   `docs/AUDIT-2026-05.md`, and in our release notes.

This posture follows pre-launch reality: the project's funding
is bootstrapped, the canonical operator's BLURT runway is finite,
and we'd rather direct resources toward fixing real issues than
maintaining the appearance of a fully-funded bounty.  As the
project grows, this program is expected to evolve toward a
structured tier model.

### In scope

A vulnerability for the purposes of this program is a flaw that
lets an attacker do something the system was clearly designed to
prevent.  In scope:

- The Morphit frontend (`apps/web`) — XSS, CSRF, clickjacking,
  CSP bypasses, supply-chain attacks via dependency chains, any
  session-fixation or auth-bypass we missed
- The Morphit indexer (`apps/indexer`) — chain-event handler
  bugs that mis-attribute funds, accept invalid payloads, emit
  incorrect data, or expose information across users; any path
  that lets an attacker poison another instance's view of the
  orderbook
- The Morphit relay (`apps/relay`) — rate-limit bypasses,
  account-creation bypass, signing-oracle abuse, key
  exfiltration, anything that lets an attacker drain the relay's
  BLURT or RC budget faster than the documented defenses bound it
- The end-to-end encrypted chat module — anything that lets
  someone other than the intended recipient read messages,
  inject messages with a forged sender, or correlate users
  beyond what the published privacy model allows
- The QR sign-in / desktop pairing protocol — replay, signature
  substitution, downgrade
- The federation directory — operator-impersonation,
  release-discovery forgery, rejection of legitimate operators,
  denial-of-service against the directory itself
- Cryptography misuse — wrong primitive choices, insufficient
  randomness, key-reuse, misuse of nonces, any side channel in
  code we wrote (we accept the timing-side-channel advisory in
  `elliptic` as documented in this file's Known supply-chain
  advisories section; new findings AT THAT LAYER are also in
  scope, and should be reported upstream as well)
- The build-from-source pipeline — anything that lets a build
  produce different bytes than the on-chain `morphit_release_v1`
  manifest, in a way that compromises reproducibility
- Privacy regressions — IP retention, telemetry leaks,
  third-party requests we didn't disclose, cookie or fingerprint
  surfaces

### Out of scope

These are not vulnerabilities for the purposes of the program:

- **Privacy properties of public chain data.** Order metadata
  (account, asset, region, payment methods) is public on Blurt
  by design — analyzing it is not an exploit, it's reading the
  chain.  See "On-chain data is public by design" earlier in
  this document.
- **Self-XSS and clickjacking on the user's own browser state.**
  If the attack requires the victim to first paste
  attacker-controlled JavaScript into their console or click a
  button while accepting a permission dialog, that's user
  defeat-in-depth, not a Morphit bug.
- **Automated scanner output without an exploit.**  "nmap
  reports port 80 is open" or "your TLS profile gets a B+ on
  Qualys" is not a vulnerability.  We're happy to discuss
  hardening, but that's a different conversation.
- **Rate-limit values.**  We tune these based on real attack
  patterns; "your rate limit is too generous" or "too strict"
  is a tuning suggestion, not a vulnerability, unless you have
  a specific exploit demonstrating bypass.
- **DoS against a SINGLE federated instance.**  Any operator
  can be DoS'd from sufficient bandwidth.  The federation is
  Morphit's defense against single-operator unavailability;
  losing one instance does not lose the marketplace.  DoS
  research that affects ALL Morphit instances simultaneously
  (e.g., a malformed chain payload that crashes every indexer's
  poller) IS in scope.
- **Volunteer / third-party infrastructure.**  Findings against
  Blurt RPC nodes, Bitcoin block explorers, or operator
  websites running modified Morphit forks should be reported to
  those projects directly.  We coordinate gladly but we're not
  the primary respondent.
- **Theoretical-only crypto risk.**  "secp256k1 might be broken
  in 2050" is interesting but not actionable.

### Severity guidance

Use these as informal anchors when reporting; we'll triage your
finding fresh on receipt.

- **Critical** — direct loss or theft of user funds; full key
  exfiltration; unauthorized issuance of chain ops on a user's
  behalf; root access on the canonical operator host; total
  bypass of the relay's funding controls
- **High** — single-user account takeover; targeted privacy
  leak (one user identified or correlated against their will);
  bypass of an explicit privacy commitment in this document;
  ability to inject arbitrary content into the orderbook
  display for visitors of any instance
- **Medium** — denial-of-service across the federation;
  rate-limit bypass that reduces an attacker's cost-of-Sybil by
  an order of magnitude; chat metadata leak (e.g., who
  messaged whom and when, beyond what the chain reveals);
  pairing-flow downgrade
- **Low** — information disclosure of low-sensitivity data;
  small-radius rate-limit bypass; UI confusion that makes
  legitimate phishing easier; hardening suggestions with
  concrete fix paths
- **Informational** — no exploit, but worth a thanks.  Hall of
  fame eligible.

### How payment works

We don't have a Bugcrowd / HackerOne front-end (intentional —
adding a third-party broker introduces a trust anchor we'd
rather not depend on).  Workflow:

1. You report the finding via the disclosure channels in the
   previous section.
2. We acknowledge within 72 hours, triage within 7 days, propose
   a severity, and propose an award amount.
3. You review the proposed amount.  If you disagree (e.g.,
   "I think this is Critical not High"), say so — we'll
   reconsider with reasoning.  Final adjudication rests with
   the canonical operator's discretion.
4. Once you accept, you provide:
   - A Blurt account (for BLURT payment), OR
   - A Bitcoin address (for BTC payment, paid from a treasury
     address we'll share at payment time), OR
   - A request for non-monetary recognition (hall of fame
     credit, contribution attribution, etc.)
5. We pay within 30 days of acceptance and confirm via the same
   channel you used to report.
6. After the fix is deployed, we coordinate public disclosure
   on a timeline you and we agree on (industry default: 90 days
   from initial report).

### Hall of fame

A list of researchers who've helped harden Morphit lives at
`/security-credits` on the canonical operator's instance.
Inclusion is opt-in.  We list:

- Researcher name (or pseudonym, your choice)
- Brief finding summary (you can review and approve the wording
  before it goes live)
- Severity at time of fix
- Fix-deployed date
- A link to your preferred attribution target (your blog,
  Twitter, BlueSky, Mastodon, GitHub — whatever)

We don't list reports that didn't pan out, reports that weren't
actionable, or your own dollar amount (unless you specifically
request that).  Hall-of-fame credit is about recognition of work
that improved Morphit, not about a running scoreboard.

### What we won't do

To be explicit about what's NOT part of this program:

- **No exclusive disclosure.**  You're welcome to publish your
  finding after the agreed-on disclosure timeline.  We don't ask
  for permanent silence in exchange for a bounty.
- **No NDA.**  Researching Morphit doesn't require signing
  anything.
- **No "we'll get back to you in three months."**  72-hour
  acknowledgment is a firm commitment, not a stretch goal.  If
  you don't hear back in 72 hours, the disclosure channel
  failed (Matrix server down, agorise account compromised,
  whatever) and you should escalate via a different channel.
