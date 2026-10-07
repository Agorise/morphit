# Morphit — Security & Threat Model

## Non-negotiable security guarantees

### 1. Private keys never leave the device

- Keygen: `window.crypto.getRandomValues()` + libsodium, client-side only
- Storage: encrypted with Argon2id (KDF) + XSalsa20-Poly1305 (AEAD) using
  a user-chosen password. Ciphertext lives in `localStorage` (or
  `sessionStorage` in Privacy Mode)
- Reload hand-off: with **Remember me** on, a plain page reload (F5) keeps
  you signed in without ever writing a decrypted key to storage. At
  `pagehide` the page writes only a secretbox **ciphertext** of the session
  keys to that tab's `sessionStorage`; the 32-byte key that opens it is
  handed to the service worker, which holds it in memory only, gives it back
  once and forgets it after 30 seconds. Only the remembered session is
  stashed (never a "just this session" sign-in or a second account). No
  service worker, a hard reload, a tab restored after 30 s or a worker that
  was stopped all mean the page loads locked. The plaintext stash older
  builds wrote (`morphit.session.reload-stash-v1`) is deleted on every boot
  and never read.
- Signing: happens in browser memory, key material zeroed after use where
  the JS engine permits
- Transmission: no code path sends key material anywhere (the CSP's
  `connect-src` allows only this site and the Blurt RPC nodes). This rests
  on the code, the code-review checklist and locked dependency versions.
  The page compares the files that start the app with the hashes in the
  chain-signed release; that catches a changed file served by an honest
  operator's compromised server or proxy, not a hostile operator, who
  serves the check too.

#### 1a. Only the posting key lives in session memory

Blurt accounts have four keys: `owner`, `active`, `posting`, `memo`.
Morphit enforces a strict tier policy:

- **`posting`** is live in session memory. It signs every `custom_json` op
  (orders, feedback, chat ciphertext, profile updates). Routinely used.
  It also seeds the chat identity key (X25519, derived deterministically
  from posting via BLAKE2b — see ADR-0015).
- **`memo`**: only its PUBLIC key is held in the session. Morphit features
  do not use the memo private key (chat uses a posting-derived X25519
  identity), so it is not cloned to sibling tabs or put in the reload
  stash.
- **`active`** is NEVER held in session memory. Needed only to sign
  `transfer` ops (BLURT-denominated listing fee path). Accessed via the
  `useActiveKey(env, password, callback)` pattern: the keystore decrypts,
  hands the key to the callback for one signing operation, and wipes it
  in a `finally` block — success or exception.
- **`owner`** is NEVER held in session memory, and Morphit never signs
  with it: account creation needs only the new account's PUBLIC keys,
  and changing your password re-encrypts the keystore instead of
  rotating keys. It stays in the encrypted keystore (and is derivable
  from your seed) for use in a Blurt wallet if you ever rotate keys.

This is enforced at the type level: a running session holds a
`LiveIdentity`, which structurally has no `active` or `owner` private-key
fields. Code that wants to sign a transfer must go through
`useActiveKey()`; there is no way to "just grab it from the identity."

Rationale: compromise of posting exposes Morphit activity, and — because
the chat identity is derived from it — every chat message sent to or by
that account (there is no forward secrecy, §3); it cannot transfer funds,
rotate keys or take over the account. Active and
owner, the high-value keys, spend ~milliseconds in cleartext memory per
transaction and are otherwise only ciphertext under Argon2id.

**BLURT fee path** uses `active` once per listing. **BTC/XMR fee paths
never touch `active`** — payment happens directly on those chains; no
Blurt `transfer` op is involved.

**Account creation** uses **none** of the user's keys.  The
relay's active key signs a direct `account_create` op that
pays the chain's live `account_creation_fee` (~100 BLURT)
from the relay's own liquid balance, plus a 2 BLURT dust
transfer — ~102 BLURT per signup (Blurt disabled
`claim_account` / `create_claimed_account` at hard fork 2, so
there are no pre-minted ACTs; see "Account-creation key
handling" below). The user supplies only the **public keys**
they want their new account governed by.  Their `owner`
private key never touches the network — the user generates
it locally and it is kept encrypted under their password.

#### 1b. Active/Owner key deep-audit findings (2026-05-07)

A black-hat-mindset audit of every code path that touches the active or
owner key was performed. Findings:

**Architecture is sound.** `LiveIdentity` (the in-memory session
identity) holds only public copies of owner and active. The private
keys for those roles exist exclusively in the encrypted keystore and
are JIT-decrypted via `useActiveKey()` (the active key; nothing
decrypts the owner key for signing), which:

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
`activePriv` and `wanted` are minified in the production build, raising
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

**Password change re-wraps; it never rotates keys.** Settings → change
password (`changePassword`, with finally-block password clearing)
re-encrypts the same keys under the new password. The keys themselves do
not change, so an old keyfile export together with the OLD password still
opens them. If a keyfile and its password may have leaked, rotate the keys
on chain instead.

### 2. Servers see signatures, never keys

- The indexer forwards transactions the browser has already signed
  (`/v1/broadcast`) and reads chain data; it cannot forge a user's op
- The relay creates accounts with its own key from public keys the user
  supplies, and pays welcome bonuses and refills; it holds no user key
- Avatars are part of the user's on-chain profile (a sanitized data URI);
  there is no avatar server

### 3. Chat is end-to-end encrypted (no forward secrecy)

- X25519 key agreement + ChaCha20-Poly1305 AEAD via libsodium; see
  `docs/CHAT-CRYPTO.md` and ADR-0015.
- v2 envelope: the message key is BLAKE2b over two Diffie-Hellman results
  (the sender's fresh ephemeral key with the recipient's chat key, and the
  sender's chat key with the recipient's), bound to both account names and
  the three public keys. The recipient opens it only with the sender's
  PINNED chat key, so nobody holding only public keys (an indexer
  included) can write a message "from" someone. Older v1 messages still
  open but are marked "Sender not verified" and never move a trade forward.
- **No forward secrecy in either mode.** The recipient's chat key, derived
  from their posting key, decrypts every message they ever received. In the
  default mode ('keep') the sender's key also reopens their own sent
  messages; 'destroy' only removes the sender's own ability to reread.
- Peers compare a 60-digit safety number. First contact is
  trust-on-first-use; a later change of a peer's chat key holds messages
  back until the user accepts the new key.
- Ciphertext on Blurt, plaintext only in participants' browsers. Who
  talks to whom, when, about which order, and read receipts are public
  (`docs/METADATA-LEAK-CATALOG.md`).

### 4. No tracking; visitor addresses kept in memory only

- No cookies (encrypted keystore uses localStorage / sessionStorage)
- No analytics, no third-party scripts, no telemetry
- **One browser → third-party request: the release check.** At most
  once a day per browser and running build (success or failure is
  remembered 24 h and shared by every tab), the browser asks ONE Blurt
  RPC node for `@morphit`'s latest release: two requests (one
  `get_account_history` of the last 100 entries, one `get_block` for the
  block that holds the release; browsers may add a CORS preflight before
  each). If the release op is older than those 100 entries, one more
  history read of up to ~115 KB. A second node is asked the same reads
  only when the first fails,
  serves a record that cannot be verified (unsigned, another key,
  malformed, none) or a genuine release whose version differs from the
  running build; never a third. A verified release OLDER than the build
  the site runs is not taken as the current release: its treasury is
  never used (the newest release this browser already verified keeps
  supplying the fee addresses, or they stay hidden and "About this
  instance" says the newest release could not be confirmed), and that
  answer is checked again within the hour instead of a day. An order numbered under a previous
  treasury BTC key is checked against releases this browser already
  verified, with no request. The node pool
  depends on the page's origin: any clearnet page (https or plain
  http) uses the 5 clearnet nodes, a `.onion` page the 7 onion nodes,
  an `.i2p` page the 7 `.b32.i2p` nodes.
  Each node sees the visitor's IP (on clearnet), `Origin`,
  `User-Agent` and `Accept-Language`; nothing about the account. A
  release is accepted only if the transaction id recomputed from the
  block matches and its signature recovers to `@morphit`'s pinned key,
  so a node can make the check fail but cannot make a forged release
  pass. Everything else (chain reads, broadcasts, prices) goes through
  the operator's own server.
- Access logs are off: every shipped nginx server block sets
  `access_log off` (`ops/nginx/*.conf`, `ops/bunkerweb/frontend/nginx.conf`).
  The bare-metal configs log only critical errors (to the journal) and log
  rate-limit refusals below that level; a rare critical nginx error line
  can still name a client. BunkerWeb's `LOG_FORMAT` names no address and
  its container keeps no Docker log; BunkerWeb holds its bans in memory.
  The one exception: when CrowdSec reads BunkerWeb's log, BunkerWeb keeps a
  small local log (5 MB, one file) with addresses, because CrowdSec needs
  them. Existing installs are brought to this by `morphit-ops upgrade`.
- The indexer and relay see each visitor's address like any web server
  and keep it in memory only, for rate limiting: minutes for indexer
  reads, up to 1 hour for the relay's signup and push limits, up to
  24 hours for the relay's daily signup limit (the /24 or /64 network,
  never written to disk or logged). The relay's sequential-name detector
  keys its one-hour memory on a keyed hash of that network, regenerated at
  every restart.
- BunkerWeb, as Morphit configures it, contacts no third party: BunkerNet,
  DNSBL, the black/white/greylist plugins, the anonymous report and
  anti-bot are off, and its daily GeoIP download, update check and Pro
  plugin download are removed from its scheduler (the GeoIP files come
  with its image). It blocks no country, so people behind national
  firewalls can reach any instance: the upgrade empties a country list in
  BunkerWeb's settings file, removes one saved in BunkerWeb's web UI from
  its database, and checks BunkerWeb runs without one; a list set any
  other way (an Autoconf label, a compose `environment:` entry) is named,
  with where to clear it. Kubo's AutoConf, HTTP routers and delegated IPNS
  publishing are off too. Every remaining outbound connection of a server,
  and why it is needed, is listed in `docs/OPERATIONS.md` §37.13a.
- Push subscriptions link an account to a browser's push endpoint in the
  relay's database (no IP, no user-agent); see `METADATA-LEAK-CATALOG.md`.

### 5. Signed, hashed releases (not byte-reproducible)

- Every release is built from a tagged commit with locked dependencies
- The release op on chain carries the SHA-256 of the source tarball and
  the hashes of the files that start the app; the tag is GPG-signed
- Builds are **not** byte-for-byte reproducible today (the release
  pipeline says so): a third party can rebuild and compare file by file,
  but should expect differences and cannot treat a matching hash as proof
- The release job fails without the signing key (there is no unsigned
  release), it refuses to attach anything to a release that was already
  published from a different tag object (a tag moved after publication),
  and only a tag signed by a pinned fingerprint
  (`RELEASE_SIGNER_FINGERPRINTS` in `packages/operator-config`, mirrored in
  `release.yml`) on `main` releases. Optional one-time repository settings
  that strengthen this (none is part of a release): Forgejo protects `v*` tags; the release
  workflow runs on a runner label that runs no pull-request CI; the
  `morphit-ops` and `morphit-mcp` names and the `@morphit` scope are
  registered on npm as placeholders so nobody else can publish under them
  (Morphit itself is never installed from npm).

## Threat model

### In scope

- **Passive network adversary**: reads traffic between user and Morphit.
  Mitigation: TLS, hidden services, CSP, no third-party origins.
- **Active MitM**: attempts to inject malicious JS. Mitigation: TLS +
  HSTS + CSP restricting script sources to this site + the running-bundle
  check against the chain-signed release manifest.
- **Compromised Morphit server**: attacker controls morphit.io host.
  Mitigation: cannot steal keys from a page it has not changed (never
  sent); CAN serve malicious JS that steals keys as they are typed. The
  in-page check against the chain-signed release does not stop this — the
  operator serves the checker too. Real mitigations: the PWA cache, the
  signed release anyone can compare against out of band, and choosing an
  operator you trust (or running your own instance).
- **Compromised relay**: cannot forge user ops (it holds no user key); can
  refuse to create accounts or pay bonuses, and can spend its own BLURT.
- **Cross-site requests to the indexer**: the indexer is a public read
  API: `Access-Control-Allow-Origin: *` on GET/HEAD only, never
  credentials. Every write must be `application/json` (415 otherwise) and
  carries no Allow-Origin, so another website cannot drive or read the
  write endpoints from its visitors' browsers. Nothing relies on CORS to
  keep a route private; the routes' own checks and rate limits do.
- **Compromised indexer**: the page talks only to its own operator's
  indexer, which can serve a stale, filtered or false orderbook, false
  balances and false chain reads. Mitigation: the instance directory
  (switch to another operator), the "Verify on a block explorer" links,
  and running your own instance. There is no automatic fallback to
  another indexer.
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
  self-trade detection + account-age weighting; a review needs a real
  two-way chat and only a reviewer's latest order-bound review of a trader
  counts.
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
- **Quantum adversary**: current crypto (secp256k1, X25519, XSalsa20, SHA-2)
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
   `useActiveKey` with a callback; nothing signs with `owner`.)
6. Does this code pass a `FullIdentity` (all four private keys) to any
   code path other than the keystore encrypt/decrypt pair? (It must not
   — only the keystore module holds full sets; everything else receives
   a `LiveIdentity` with the `posting` private key only.)

The checklist is applied in review; it is not an automated CI gate.

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

Morphit pages do **not** carry `integrity="sha384-…"` (SRI) attributes: the
build emits none, and every script and stylesheet is same-origin. The
release op `@morphit` signs on chain lists the hashes of the files that
start the app. When the site runs that signed version, About this instance
fetches each of those files and compares it with the signed hash ("N of N
signed files match"). That catches a file changed by accident, by a partial
break-in or in transit, and stale caches. It cannot protect against the
operator itself, who serves the check too.

## CSP (what ships)

The header every shipped config sends (`ops/nginx/web.conf`,
`ops/bunkerweb/frontend/nginx.conf`, the BunkerWeb env files; the
`csp-header-consistency` smoke keeps them identical to OPERATIONS §15):

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self' https://rpc.drakernoise.com https://blurtrpc.dagobert.uk https://rpc.blurt.blog https://rpc.beblurt.com https://blurt-rpc.saboin.com;
media-src 'none';
object-src 'none';
child-src 'none';
frame-src 'none';
worker-src 'self' blob:;
manifest-src 'self';
form-action 'self';
frame-ancestors 'none';
base-uri 'self'
```

- `script-src 'self' 'wasm-unsafe-eval'`: script from this origin only. No
  `'unsafe-inline'` (the build moves every inline script into a hashed file
  and fails if one is left) and no `'unsafe-eval'`. `'wasm-unsafe-eval'`
  lets WebAssembly compile (argon2, signing); it does not allow JavaScript
  `eval`.
- `style-src` keeps `'unsafe-inline'` (Svelte transitions and the branding
  theme use inline styles).
- `connect-src` lists only this origin and the five HTTPS Blurt RPC nodes
  the browser uses. A `.onion` or `.i2p` mirror sends its own list (its
  hidden RPC nodes). There is no setting for a user to add another
  node. Every request the browser makes to
  an RPC node sets `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`
  and `cache: 'no-store'`; payloads are JSON-RPC reads, never key material.
- No CDNs, no Google Fonts, no analytics origins; `frame-ancestors 'none'`.

## Responsible disclosure

The root [`SECURITY.md`](../SECURITY.md) is the one procedure: a **Matrix
DM to `@agorise:matrix.org`** (a user, not a room). If you cannot DM, say
in the public room `#agorise:matrix.org` that you have a report — with no
details — and a maintainer will DM you. Never use a public issue, a public
room message with details, or anything posted on chain: all of those are
public.

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
    - the address-reuse history — one-way tags only:
      HMAC-SHA256(per-install random salt, asset ‖ address), truncated to
      16 bytes; never the address, a date or an order id. An attacker
      reading them (with the salt, which sits beside them) can only
      confirm whether a specific candidate address was shared before.
      Older plaintext records are converted and deleted on load
    - `morphit.locale` — the user's chosen UI language
    - `morphit.updateDismissed` — a flag (sessionStorage only)
  **Mitigation:** no plaintext private-key material is stored in
  `localStorage` or `sessionStorage` (the reload hand-off in §1 stores a
  ciphertext whose key lives only in the service worker's memory). An
  attacker with a local-script vector (XSS, supply-chain compromise) can
  read these values but cannot impersonate the user, broadcast ops, or
  recover addresses from them. Script running in the page can, however,
  read the posting private key from memory (next item); that key signs
  Morphit ops and decrypts the account's chats (no forward secrecy). It
  cannot move funds or recover the account.
  **Why not encrypt these:** they're inputs to a display layer that
  must work before the user unlocks their keystore. Encrypting them
  would require prompting for a password on every page load.
  The cost-benefit favors leaving them plain.

- **Session-memory-only exfiltration of the `posting` private key.**
  The LiveIdentity's posting private key is in browser heap
  while the user is signed in. A rogue script in the same origin can
  read it via the identity store's exported subscriber. **Mitigation:**
  a CSP that runs script from this origin only (no inline script, no
  `eval`), so injected markup cannot run code; no external resources at
  all; and the chain-signed release that lets anyone compare what a host
  serves. None of this stops script the host itself serves. Phase 4 adds the
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
  opaque. Anyone can see that two accounts exchanged a message at a
  specific block height, which order it is about, and the plaintext read
  receipts. The full list is in `docs/METADATA-LEAK-CATALOG.md`.

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
responsibility). It is a 2026-04 snapshot (amendments at its end
record later changes); the current threat model is
`docs/audit/2026-10-stride-matrix.md`,
`docs/audit/2026-10-attack-tree.md` and
`docs/audit/2026-10-red-team-narrative.md`.

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
- **Supply chain.** The committed `package-lock.json` pins versions
  and integrity hashes. Node installs run npm with `--ignore-scripts`
  (no dependency's install script runs on a node); the Matrix bot's
  two native binaries are fetched only when the bot is enabled and are
  checked against pinned SHA-256 values; a tor-only box takes them from
  the offline bundle. Dev dependencies are installed too (the services
  run TypeScript through `tsx`). Residual risk: npm's own signing is
  what it is, and every runtime dependency runs with the service's
  rights.
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
  scrubbing from your VPS provider. (A CDN proxy in front of the
  site would see every visitor's address and every request, which
  conflicts with Morphit's privacy model; Morphit does not
  recommend one.) Morphit's
  application-layer mitigations (rate limits, body caps, tight
  resource ceilings) handle L7 abuse but cannot absorb L3/L4
  volumetric attacks. Document your DDoS response plan.
- **OS and runtime patching.** Keep Node.js, nginx, and the host
  kernel current with security updates. `unattended-upgrades` on
  Ubuntu or equivalent is the minimum baseline.
- **Key rotation.** The relay's active key should be rotated
  quarterly or on suspicion of compromise, per OPERATIONS.md §8
  (`sudo morphit-ops edit-active-key` installs the new key and
  re-seals the unlock credential).
- **Balance monitoring.** Watch the relay's BLURT balance. A
  sudden drop suggests either heavy legitimate use (good signal
  to top up) or abuse (investigate). The Matrix bot alerts on low
  balance (OPERATIONS.md §16).
- **No IP-based banning from logs.** The relay and the shipped nginx
  configs log no visitor addresses, so there is nothing for
  `fail2ban` to read; fail2ban guards SSH only. Abuse is bounded by
  the in-memory rate limits (OPERATIONS.md §18, §34).
- **The dependency audit gate.** CI and the release run
  `scripts/audit-gate.mjs`, with ONE allowlist
  (`.audit-allowlist.json`, every entry with its reason and review
  date). It fails when the audit cannot run, on any untriaged
  moderate/high/critical advisory, on an allowlisted advisory npm no
  longer reports, and on an advisory an in-range update fixes.

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
  used for relay-funded account creation and 2-BLURT signup
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

**Enforced by CI:** the accepted entries live in ONE allowlist,
`.audit-allowlist.json`, which `scripts/audit-gate.mjs` (CI and
release) and `apps/web/scripts/npm-audit-gate-smoke.ts` both read.
That file, not this table, is authoritative; the table is a
snapshot.

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
runtime findings are the entries in `.audit-allowlist.json`
(the `matrix-bot-sdk` / `request` cluster matters only if you
enabled the optional Matrix bot). If anything beyond those shows
up, triage before deploying.
The build/test advisories above are real but exposed only on the
build host (CI or dev machine), which should already be
isolated from production.

**Status:** `elliptic` is gone from the tree since dblurt 0.17.0
(dblurt signs with `@noble/secp256k1`; there is no `elliptic` in
`node_modules` or `package-lock.json`), and the frontend's own
signing path also uses `@noble/secp256k1` (ADR-0046). The
assessment above is kept as history.

### Legal considerations for operators

Morphit's non-custodial, no-KYC, chain-native design narrows legal
exposure significantly, but does not eliminate it. These are not
code concerns but should shape deployment posture:

- **Sanctioned-country trades.** Without KYC, a Morphit frontend
  cannot block a user in a sanctioned jurisdiction from reading
  the orderbook. However, Morphit itself never facilitates the
  atomic trade — two users agree in Morphit's encrypted chat (or
  anywhere else), and the per-asset settlement transfer
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
  release-discovery ops claiming to be from `@morphit`. The
  browser accepts a release op only if the transaction id
  recomputed from the block matches and its signature recovers to
  this pinned key; anything else is ignored. The signature decides,
  not the node: a second node is asked only when the first fails or
  serves something that does not verify. Two genuine releases are
  ordered by their signed version, never by the block number a node
  reports. Stated limit: a node can withhold the newest release (serve
  an older genuine one) when the second node is unreachable or does the
  same, so an update notice can be late; nothing forged is accepted.

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

ADR-0011 §3 requires two distinct attestors, both independent of the
poster (a poster's own attestation is rejected outright with
`attestor_is_poster`, and accounts flagged as a pair with the poster
do not count), to promote a BTC/XMR order's fee status from
`pending_external` to `verified_by_attestation`. Without
further gating, a grifter could cheaply farm accounts (the
@morphit-relay welcome waiver creates them for free), have
each throwaway attest their own never-paid fee, and bypass the
$0.125 listing fee.

The indexer now requires each attestor to satisfy a **loyalty
threshold** OR/AND an **age threshold** (account created ≥30
days ago on the Blurt chain). The loyalty threshold is 100 BLURT
paid to the **canonical Morphit treasury** in listing fees. Only
the treasury's share counts, because the operator's share can go
to an account the payer controls (anyone can register an operator
naming itself as the fee recipient): on a federated instance the
treasury gets 10% of each fee, so this is about 1,000 BLURT of
fees there; on the canonical instance, 100 BLURT. (Attestation ops
in blocks stamped before 2026-11-01 00:00 UTC, the consensus-v2
activation time, keep the old measure, all
fee legs.) The gate runs in two phases controlled by the
`MORPHIT_INDEXER_ATTESTATION_PHASE` env var:

- **Launch** (OR gate): attestor qualifies by meeting either
  condition. Plainly: an account at least 30 days old qualifies
  **without paying anything**, so aged sock accounts cost an
  attacker only time.
- **Steady** (AND gate): attestor must meet both — 30 days AND
  the treasury-share threshold for every sock account.

**Known gap:** the phase is a node-local setting, yet it decides
whether an attestation op is applied or rejected — a verdict every
node should reach the same way. Until it is pinned on chain, nodes on
different phases can disagree about attested orders.

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

### Operator and RPC trust in payment checks (audit F-11)

The browser does not read the chain itself for this: it asks the
operator's own indexer (`POST /v1/chain/condenser`,
`apps/web/src/lib/net/chainRelay.ts`), which reads from its RPC
pool. So the user trusts their chosen operator for this answer, as
for the orderbook and balances. A hostile operator, or a hostile
RPC node the indexer happens to use, can:

- Fabricate a `verified` result for a transfer that doesn't
  actually exist on chain
- Hide a real on-chain transfer (return `not_found` or
  `wrong_op`)
- Tamper with transfer fields (memo, amount, sender, recipient)

Mitigations in place:

- **An independent check:** the UI offers "Verify on a block
  explorer" next to a payment result, so a cautious user can
  confirm without trusting the operator.
- **Defense via observability:** the same chain is observable
  by both parties (buyer and seller).  If a quorum-passing
  result later turns out to be wrong, the buyer can
  independently verify via their own wallet's transaction
  history.  Phase F.5 audit fix (F-14) added buyer-side
  self-verification, which fires from the buyer's RPC
  perspective — disagreement between buyer's view and seller's
  view of the same txid would surface as contradictory mismatch
  reports.
- **Operator-chosen RPC pool:** an operator concerned about RPC
  trust can point the indexer at nodes they run or trust
  (`MORPHIT_INDEXER_RPC_ENDPOINTS`, OPERATIONS.md §22).
- **Verification is not the primary settlement mechanism:**
  the on-chain transfer is what actually settles the trade.
  The verifier is a UX aid that surfaces mismatches faster than
  the seller/buyer would otherwise discover them.  A wrong
  "verified" result might briefly mislead the seller, but they
  would discover the missing funds when reconciling their
  wallet.

Not in place: a quorum of RPC operators for these
reads. The indexer reads each answer from one node of its pool; a
periodic chain-consistency sample is an alarm, not a filter.

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
campaign documented in the internal audit record AUDIT-2026-05 (Parts 1-14).
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
fixed inline (the majority), deferred to the project backlog
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
backlog under BATCH14-2; pre-launch the working signal is
preferred over the harder-to-debug filtered version.

### Real-time balance card

`MyBalanceCard.svelte` polls the user's balance through the
operator's indexer (`/v1/chain/condenser`) every 5 seconds
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
from the indexer's chain reads; the bus only accelerates
legitimate refreshes.

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
handling secrets. The unit already loads the passphrase with
`LoadCredentialEncrypted=` from a credential sealed to the host's
systemd key (`--with-key=host`, no TPM): a copy of the whole disk
unseals it, so use full-disk encryption and size host physical
security to the fee volume you process. See
ADR-0010 §4 for the relay's in-memory key posture.

### Price-feed posture

BLURT/USD comes from **`api.blurt.blog` first**: whenever its value
is plausible, it is the price (`apps/indexer/src/indexer/price/factory.ts`).
Only when it fails or is implausible does the indexer fall back to an
outlier-rejected median across independent external feeds (CoinGecko,
CoinPaprika, CryptoCompare, and — for the assets they list —
Kraken/Binance/Coinbase/OKX/Bybit, plus the optional key-gated
CoinCap/Messari); a feed that returns nothing is dropped from the
median, never replaced by a guess. So one provider does decide the
price in normal operation, and could skew it within the plausibility
band. A hidden-only (zero-clearnet) node does not call these at all:
it takes the federation price, the median of peers' own prices. Behind
the external median sit the opt-in self-sovereign morphit_native
source and the static floor, so the chain degrades rather than breaks.

BTC and XMR prices, and the USD→fiat table, come first from the Haveno
and Bisq pricenodes, reached as Tor onion services on a fresh circuit
per request (`apps/indexer/src/indexer/price/pricenodes.ts`): a value is
taken only when at least two pricenodes agree within the tolerance and
form a majority of those that answered (their median); no consensus
means no new value, never one node's word. The clearnet feeds above are
only their fallback where clearnet is allowed, and a zero-clearnet node
never asks them. The BTC/XMR fee explorers are reached the same way,
onion first (docs/OPERATIONS.md §40.4a).

The price is **display-only**: fee verification reads no price (the
BLURT fee floor is chain-pinned in the signed release), so a wrong
price can mislead a user about fiat value but cannot make a payment
fail or pass. Operators who anticipate an upstream outage or
compromise can disable the price feed entirely; the BLURT-denominated
fees and amounts continue to work without the fiat overlay.

Operator-trust assumption (BATCH14-4): a malicious operator
can lie about the fiat price displayed alongside BLURT amounts
(`blurt_price_fiat` on `/v1/listing-fee`, formerly `usdPerBlurt`
in the frontend state) to mislead users about how much fiat
their BLURT actually represents. This is the pre-existing
operator-trust boundary; users cross-check by comparing
instances or by visiting `/v1/price/morphit-native/receipt`
to see exactly what data the operator's indexer used to
derive the displayed price.  The denomination is
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

The daily backup (`ops/backup/morphit-backup.sh`, set up by the
installer; `RUN-A-MORPHIT-NODE.md` §9) writes gzipped `pg_dump`s to
`/home/morphit/backups/` mode 0600, keeps 30 days, and renames from
`.partial` → final so a half-written file is never mistaken for a
backup. **They are plain text unless you give an age public key**:
the install wizard asks for one ("Encrypt your daily backups"), and
`morphit-ops upgrade` asks once about plain-text backups already on
the box. Contents include chat ciphertexts (which only the
participants can decrypt), feedback, engagement aggregates, and also
local data the chain does not have (operator blocks, moderation
records, view counters). Push subscription rows are left out of the
dumps. Off-server copies are opt-in (`REMOTE_DESTINATION` in
`/etc/morphit/backup.env`, OPERATIONS.md §37.12).

## Responsible disclosure (updated)

Security researchers, please report findings via one of these
channels in order of preference:

1. **Matrix DM** to **`@agorise:matrix.org`** (a user, not a
   room) — the one channel for every vulnerability report.
   End-to-end encrypted by default in Element/most Matrix
   clients.
2. If you cannot use Matrix: say so in the public room
   **`#agorise:matrix.org`** WITHOUT any details, and ask a maintainer to
   DM you. Do not open a public issue on git.agorise.net for an
   exploitable problem — issues there are public.

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
   if you want it — public attribution in our release notes.

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
  code we wrote or in the signing libraries we ship
  (`@noble/secp256k1`, libsodium) — report those upstream as well
- The release pipeline — anything that lets a release, or the
  files an honest instance serves, differ from what the on-chain
  `morphit_release_v1` op signs (builds are not byte-reproducible
  today; a way to exploit that is in scope)
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

Researchers who've helped harden Morphit are credited in the
release notes of the release that ships the fix. Inclusion is
opt-in.  We list:

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
  you don't hear back in 72 hours, say in the public room
  `#agorise:matrix.org` that a security report is waiting for an
  answer — still with **no details** — and a maintainer will DM
  you. Never move the details to a public channel.
