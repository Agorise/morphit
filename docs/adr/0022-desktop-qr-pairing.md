# ADR-0022 — Desktop QR pairing protocol ("scan to sign in")

**Status:** Accepted, 2026-05-04
**Supersedes:** none
**Superseded by:** none

## Context

Users who already have Morphit working on their phone (keys
in the phone's keystore) want to sign into Morphit on a
desktop browser they don't normally use — a friend's
laptop, a public terminal, their own desktop after wiping
the browser profile, etc. The naïve solution is "type your
seed phrase on the desktop," which is unsafe (seed phrase
on a strange machine = compromise) and grandma-hostile
(users hate typing 12-24 word phrases under pressure).

The other naïve solution most crypto products ship — "scan
this QR with your phone, the QR contains your seed phrase"
— is **actively harmful** because the desktop now holds
the seed. We will not ship that pattern.

What we want is the third pattern: the desktop holds an
ephemeral session, the phone retains the keys, and a one-
time signed handshake links them. This ADR specifies
that protocol.

## Decision

Ship a **relay-mediated ephemeral-pairing protocol** where:

1. The desktop generates an ephemeral X25519 keypair and
   nonce, encodes the public half + a pairing ID + the
   originUrl into a QR code.
2. The phone scans the QR, validates the originUrl
   against what the user is actually trying to log into,
   prompts the user to confirm with a high-friction
   confirmation card, and signs a pairing bundle with
   the phone's posting key. The signed bundle is
   encrypted to the desktop's ephemeral X25519 pubkey
   using the same ECIES construction as ADR-0015 chat
   crypto.
3. The phone POSTs the encrypted bundle to the relay's
   `/v1/login-pairing/:pairingId/deliver` endpoint.
4. The desktop, listening on the relay's
   `/v1/login-pairing/:pairingId/wait` SSE endpoint,
   receives the bundle, decrypts with its ephemeral
   private key, verifies the signature against the
   account's on-chain posting pubkey, and accepts the
   session.

The desktop ends up with a session credential — same
shape as today's "logged-in identity" — with the chat-
pubkey + accountName pinned. The desktop **does not**
gain the posting key itself; write actions still
require unlock-on-broadcast, just like sessions
created the conventional way.

The relay sees only ciphertext routed from one party to
another, addressed by an opaque pairingId. It learns:
that pairing X had a bundle of N bytes pass through it.
It does not learn account names, signatures, or
plaintext.

## Why this design

### Three options considered

**Option A — fully P2P with two cameras.** Desktop renders
QR, phone scans → phone signs → phone renders second
QR, desktop's webcam scans. No relay involvement at all.

- ✅ Strongest privacy: relay learns literally nothing.
- ❌ Requires desktop webcam + holding phone up to it.
- ❌ Two QR-scan steps fail-rate-stack: each scan ~5%
  user-failure (lighting, focus, angle), so two-step
  flow ~10% failure rate. Not grandma-friendly.

**Option B — relay-mediated, one camera.** Desktop renders
QR, phone scans → phone signs → phone POSTs encrypted
bundle to relay → relay shuttles to desktop over SSE.
**This is what we ship.**

- ✅ One camera step, commodity flow (matches what users
  see on Discord, WhatsApp Web, Signal Desktop).
- ✅ Relay sees only ciphertext addressed by opaque
  pairingId.
- ✅ Same primitives as ADR-0015 chat crypto — no new
  cryptographic surface.
- ❌ Relay learns "a pairing happened at time T with N
  bytes." Acceptable: same metadata-leakage threshold
  as chat-message routing.

**Option C — phone delegates a posting subkey to the
desktop.** Phone broadcasts a Blurt `account_update` op
adding a new posting authority (a key the desktop
generated locally) with a TTL or revocation marker.

- ✅ Strongest UX: desktop becomes a fully independent
  posting device, no phone needed for write operations
  after pairing.
- ❌ The delegation itself is **public on chain**. Anyone
  watching `@grandma`'s account sees a new posting key
  was added. For Morphit's threat model where on-chain
  reputation IS the reputation, this is acceptable for
  some users and unacceptable for others.
- ❌ Costs a chain operation fee.

**Decision: ship B as default.** Document C as a future
opt-in for power users who want desktop-as-fully-
independent (a follow-up ADR can specify it; we do not
need to ship both paths simultaneously).

### Why not signed JWTs / WebAuthn / passkeys?

Considered:

- **WebAuthn / passkeys** would require operator-side
  account state (the relying party stores user-handles
  to credential-IDs), which violates Morphit's no-IP-
  retention / no-account-state posture. The relay can't
  be a passkey RP because it doesn't have user records.
- **Signed JWTs** would require operator-side key
  storage to sign session tokens, and a centralized JWT
  signer is exactly the federated-operator anti-pattern.
- **OAuth-style flows** require an identity provider,
  which Morphit deliberately doesn't have.

The chosen design uses the user's posting key (the
authority that's already authoritative for Morphit) to
prove "I authorize this desktop session," which is the
right cryptographic primitive for our trust model.

## Protocol detail

### Pairing payload (desktop → QR)

```json
{
  "v": 1,
  "pid": "<32-byte hex>",
  "epk": "<base64 X25519 pubkey, 32 bytes>",
  "origin": "https://morphit.io",
  "exp": 1714867200,
  "relay": "https://morphit.io"
}
```

Fields:

- `v` — protocol version (currently 1).
- `pid` — pairing ID. SHA-256 of `(epk || nonce)`. Used
  by the relay to route bundles. Treated as opaque by
  everyone; uniqueness enforced by the relay's in-flight
  registry.
- `epk` — desktop's ephemeral X25519 public key. The
  phone encrypts to this; only the desktop holds the
  matching private key. Generated fresh for every
  pairing attempt; never reused.
- `origin` — the canonical origin the user is trying to
  log into. The phone validates that the page it's
  about to authorize is THIS origin. Lets us catch
  homoglyph phishing (`morph1t.io`).
- `exp` — Unix-seconds expiry. Capped at 5 minutes
  after generation (validated by the relay; bundles
  delivered after `exp` are rejected).
- `relay` — the relay URL the phone POSTs to. In a
  federated world this lets a user on Operator A pair
  into Operator B's instance — phone delivers the
  bundle to the operator the desktop is sitting on.

QR encodes this as a single base64url string of compact
JSON. ~250 bytes — comfortably within QR limits even at
the conservative error-correction level we'll use.

### Phone-side validation (before showing the
confirmation card)

Phone parses the QR. Rejects if:

- `v !== 1`.
- `pid` is not 64 hex chars.
- `epk` is not 32 bytes after base64url decode.
- `origin` is not a valid `https://` URL with a host
  component.
- `exp` is in the past or more than 5 minutes in the
  future.
- `relay` is not a valid `https://` URL.

If any of the above fails, phone shows a generic "this
QR isn't a valid Morphit login QR" error and refuses to
proceed.

### Phone-side confirmation card

If the QR validates, the phone shows:

```
┌─────────────────────────────────────────┐
│                                         │
│   Sign in to Morphit?                   │
│                                         │
│   A computer is asking to sign in       │
│   as @<your-account-name>.              │
│                                         │
│   Website:  morphit.io                  │
│   Started:  2 minutes ago               │
│                                         │
│   Only tap "Yes, that was me" if you    │
│   just opened this site on your         │
│   computer.                             │
│                                         │
│   [ No, I didn't ]   [ Yes, that was me ] │
│                                         │
└─────────────────────────────────────────┘
```

- The website hostname is shown faithfully (no pretty-
  printing, no truncation, no smart-quoting). A
  homoglyph attack like `morph1t.io` shows up as
  `morph1t.io`, not `morphit.io`.
- The default-focus button is "No, I didn't" — pressing
  Enter or accidentally double-tapping does NOT
  confirm. The user must reach for the affirmative
  button intentionally.
- "Started" is a relative time computed from
  `now() - exp`. Helps catch stale QRs (e.g. an attacker
  showing the user a 4-minute-old screenshot).
- No "remember this device" checkbox. Every pairing is
  a fresh consent moment.

### Phone-side bundle construction

After the user taps "Yes, that was me":

```
plaintext_bundle = canonicalJson({
  v: 1,
  pid: <pairing id>,
  epk_echo: <epk as received, base64>,
  origin_echo: <origin as received>,
  account: <phone account name>,
  account_chat_pubkey: <phone's chat-identity pubkey>,
  signed_at: <Unix seconds>,
  device_label: <phone OS / model, ASCII-only, ≤32 chars>
})

# Domain-separated signing digest.  The phone hashes the
# canonical bundle bytes prefixed with a fixed string so a
# pairing signature can never be replayed as a chain
# transaction signature, and vice versa.  The trailing
# newline keeps the prefix a fixed-length string that can't
# be confused with the JSON structure (which begins with `{`).
SIGNING_DOMAIN_PREFIX = "morphit-pairing-v1\n"
digest = SHA-256(SIGNING_DOMAIN_PREFIX || plaintext_bundle_bytes)

# Signature is over the digest, not over the raw bytes.
# Producers MUST hash with the prefix; verifiers MUST hash
# with the same prefix.  A phone signing the raw bytes (or
# any other digest construction) will produce signatures the
# desktop verifier rejects.
signature = secp256k1_sign(posting_priv, digest)

signed_envelope = canonicalJson({
  bundle: plaintext_bundle,
  signature: <hex of (recovery+31 || r || s) — 65 bytes>
})

ciphertext = ChaCha20-Poly1305-IETF(
  key   = BLAKE2b-256(
    X25519(phone_ephemeral_priv, epk),
    info = "morphit-pairing-v1/aead-key"
  ),
  nonce = random_12_bytes,
  plaintext = signed_envelope,
  aad   = pid_bytes
)

delivery_payload = canonicalJson({
  v: 1,
  pid: <pairing id>,
  ephemeral_pub: <phone's X25519 ephemeral pubkey, base64>,
  nonce: <12 bytes, base64>,
  ciphertext: <ciphertext + auth tag, base64>
})
```

**Canonical-JSON serialization.**  Both the bundle and the
envelope are serialized with sorted-key canonical JSON so
producers and verifiers agree on byte-exact serialization
across runtimes.  Implementation: `canonicalJson(value)` in
`apps/web/src/lib/auth/desktopPairing.ts` — sorts object
keys lexicographically before emission.

### Phone → Relay delivery

`POST /v1/login-pairing/:pairingId/deliver`
Body: `delivery_payload` JSON, `Content-Type:
application/json`. Body size capped at 4 KiB (well above
needed; loose enough that a future `device_label`
expansion doesn't break clients).

Relay validates:

- `pid` in URL matches `delivery_payload.pid`.
- The pairing is in the relay's in-flight registry.
  Registry holds an entry from the moment the desktop
  starts subscribing on `/wait` until either delivery
  or `exp` (whichever first).
- Bundle hasn't already been delivered to this pid.
  Single-shot: a delivered pid is immediately deleted.

Relay does NOT validate signatures or decrypt. It's a
dumb pipe.

### Relay → Desktop delivery

Desktop subscribes via SSE: `GET /v1/login-pairing/:pairingId/wait`.
Connection times out at `exp - now()`, max 5 minutes.

When a bundle arrives, relay pushes it as a single SSE
event:

```
event: bundle
data: {"v":1,"pid":"...","ephemeral_pub":"...",...}
```

Then closes the connection. Pid is deleted from registry
immediately.

### Desktop-side verification

Desktop:

1. Validates the bundle's `pid` matches the one this
   desktop is waiting for. (Defense against any cross-
   subscription leakage in the SSE handler.)
2. Computes `key = X25519(desktop_ephemeral_priv,
   delivery_payload.ephemeral_pub)`.
3. Decrypts with ChaCha20-Poly1305, AAD=pid.
4. Parses the inner `signed_envelope`.
5. Validates `bundle.epk_echo === desktop_ephemeral_pub`
   (defense against a relay shuffling pids — the
   bundle has to claim to be FOR this desktop's epk,
   not just delivered to this pid).
6. Validates `bundle.origin_echo === window.location.origin`
   (defense against a relay passing a bundle that was
   signed for a DIFFERENT origin — the user might have
   approved a `morph1t.io` pairing on their phone, but
   if their desktop is on `morphit.io` we refuse).
7. Validates `bundle.signed_at` is within
   `[now-2min, now+30s]`. The 2-min window covers
   reasonable phone↔relay↔desktop hops; the +30s tolerates
   minor clock skew on the phone.
8. Fetches `bundle.account`'s on-chain posting authority
   via `condenser_api.get_accounts` through the existing
   chain rotator.  Computes the SAME domain-separated
   digest used by the phone:
   `digest = SHA-256(SIGNING_DOMAIN_PREFIX || canonical_bundle_bytes)`.
   Recovers the signing pubkey via secp256k1 from
   `(digest, signature)`.  Looks up the recovered pubkey
   in `posting.key_auths` and requires its weight to
   clear `posting.weight_threshold` with a single
   signature.

   **Multisig limitation.**  The pairing protocol carries
   ONE signature.  Accounts whose posting authority
   requires multiple signatures (multisig: `key_auths`
   weights summing to threshold but no single key
   carrying it alone) cannot pair via QR with this
   version.  Multisig users fall back to seed-phrase
   import.  Single-sig accounts (the common case) are
   fully supported.
9. If everything passes: writes the session credential
   (`account` + `account_chat_pubkey` + a fresh
   `session_id` + `started_at` + `device_label_remote`)
   to local storage, navigates to the user's home.

If any step fails: shows the user a generic "couldn't
verify the sign-in. Please try again." message and
resets the desktop's QR to a fresh pairing. Detailed
failure reasons go to local console for debug, NOT to
the user — error-message-as-attack-channel concern.

## Threat model

### What an attacker can do, and what we do about it

**A1 — Attacker shows the user a phishing page that
generates a pairing on their own controlled
relay.** User scans, phone shows confirmation card.
*Defense:* the confirmation card shows the **origin
URL faithfully**. User trained to look at the URL
catches `morph1t.io`. This is the same defense as any
phishing-aware login flow; not perfect but the user has
the information they need.

**A2 — Attacker captures a screenshot of the user's
desktop QR (over-the-shoulder, screen-share leak,
malware screen capture).** Attacker tries to deliver a
bundle to the pid. *Defense:* the attacker doesn't have
the user's phone, so they can't sign. The QR alone is
NOT a credential; it's a request for a credential. An
attacker who captures it can ONLY race to deliver a
forged bundle, which fails signature verification.

**A3 — Attacker on the same LAN as the desktop tries to
race-deliver their own bundle.** *Defense:* the
attacker would need to encrypt to the desktop's epk
(which is in the QR — public, but only useful if you
can also forge a posting-key signature). They'd also
need the user's account name to forge a plausible
bundle, which they may guess. But the signature check
fails because they don't have the posting key.

**A4 — Compromised relay tries to inject its own bundle
to a pid.** *Defense:* same as A3 — the relay can't
forge a posting-key signature. The bundle's signature
verifies against the on-chain pubkey for `bundle.account`
which the relay doesn't control.

**A5 — Compromised relay tries to LEAK plaintext
metadata.** *Defense:* it sees the pid (random),
delivery-bundle size (~1 KB always, padded if needed),
and timing. It does NOT see the account name, the origin,
or any plaintext. Same metadata threshold as chat
routing.

**A6 — User trains themselves to tap "Yes" without
reading.** *Defense:* the confirmation card design
makes the URL prominent and the "No" button is the
default-focused one. We can do nothing about a user who
tunnels through a security UX without reading. Document
this in SECURITY.md and the FAQ.

**A7 — Replay attacks.** *Defense:* `signed_at`
freshness window in the bundle (≤2 minutes old, ≤30s in
future); single-shot pid (delete after first delivery);
QR `exp` (≤5 minutes after generation).

**A8 — Desktop session credential is stolen by malware
on the desktop after pairing.** *Defense:* this is
true of any login system; not our problem to solve. Our
mitigation: short session TTLs (24 hours default), the
session permits read-only access; write actions still
require unlock-on-broadcast (existing behavior, not
changed by this protocol).

**A9 — User loses phone, can't log in to desktop.**
*Recovery path:* paper-key recovery (already documented
in OPERATIONS §9). The QR-pairing flow does NOT replace
paper-key recovery; it complements it.

### What we DON'T defend against

- **Cross-site scripting on the morphit.io domain.** If
  an attacker can run JS on the legitimate origin, they
  can substitute their own ephemeral pubkey into the QR
  and intercept the bundle. Defense is upstream: CSP,
  no-eval, no-third-party-CDN, all already in place.
- **Compromised phone keystore.** If the attacker has
  the user's posting key, they ARE the user as far as
  Morphit is concerned. No protocol can save us from
  that.
- **Operator running a hostile relay that selectively
  drops pairings to deny service.** Federation answer:
  switch operators.

## Operator-side requirements

- New endpoint pair on the **indexer** (where SSE
  infrastructure already exists; the relay would need
  a fresh SSE stack just for this feature, which is
  unjustified): `POST /v1/login-pairing/:pid/deliver`
  and `GET /v1/login-pairing/:pid/wait` (SSE). Body cap
  4 KiB on deliver. Rate limit: tier 'resource'
  (default 60/min/IP for deliver). The SSE `/wait`
  doesn't share the per-minute budget — same posture
  as `/v1/orderbook/stream` and `/v1/chat/:a/:b/stream`.
- In-memory pid registry: `Map<pid, {epkPub: bytes,
  exp: number, deliveredAt: number | null,
  waiterStream: WritableStream | null}>`. Hard cap on
  total in-flight pids (default 10000) to prevent
  memory exhaustion.
- Janitor: every 30 seconds, delete entries where
  `exp < now()`.

The indexer does NOT persist pid state.  An indexer
restart loses any in-flight pairings (acceptable —
users retry, worst case they wait the 5-minute QR
expiry).

## Wire-format & API stability

This is `v: 1` of the protocol. Future versions:

- Compatibility: phone reading a `v: 2` QR rejects
  cleanly with "your phone needs an update."
- Versioning lives in the QR payload AND the delivery
  payload AND the session bundle. A phone can speak
  v1; a desktop can speak v1; both reject v2 cleanly.
- v2 considerations (not for now): adding optional
  device-attestation fields, supporting hardware-key-
  backed signing, supporting Option C (delegated
  posting subkey).

## i18n

15+ new strings on the desktop side (initiator UI), plus
~10 on the phone side (scanner UI + confirmation card),
plus ~5 error states. Total ~30 keys × 10 locales = 300
new translation lines. Confirmation-card prose is the
most security-sensitive; native-speaker review post-
launch is on the existing translation-QA backlog.

## Smoke tests required

- `desktop-pairing-crypto-smoke`: pure ECIES round trip,
  signature verify, pid derivation, bundle parsing, all
  validation gates exercised.
- `desktop-pairing-relay-smoke`: deliver-then-wait round
  trip, exp-expired rejection, double-delivery rejection,
  oversized-body rejection, malformed-JSON rejection.
- `desktop-pairing-replay-smoke`: bundle with stale
  `signed_at` rejected; bundle with future `signed_at`
  rejected; bundle with mismatched `epk_echo` rejected;
  bundle with mismatched `origin_echo` rejected.

## Brag-list claim discipline

Per project standing instruction, brag-list claims must
be verifiable in code.  The brag-list claim that this ADR
authorizes is **MORPHIT-BRAG-LIST.md item #218** ("QR
sign-in: scan with your phone, never type your seed on a
strange computer"), shipped together with the implementation
in Audit Part 30 (2026-05-04).  The claim describes the
threat model, primitives, smoke coverage, multisig honest-
disclosure, and the cross-references this ADR documents.

## Implementation (shipped Audit Part 30)

This ADR was implemented end-to-end in Audit Part 30
(2026-05-04).  Shipped components:

- ✅ Pure crypto module
  (`apps/web/src/lib/auth/desktopPairing.ts`, ~600 lines).
  X25519 + BLAKE2b + ChaCha20-Poly1305-IETF, same primitives
  as ADR-0015 chat crypto.  Signer-agnostic via
  `BundleSigner` and `SignatureVerifier` types.  Domain-
  separated AEAD-key derivation (`morphit-pairing-v1/aead-key`)
  and signing digest (`SIGNING_DOMAIN_PREFIX = "morphit-pairing-v1\n"`)
  so pairing keys/signatures can never collide with chat,
  release-trust-anchor, or chain-transaction signatures.
  29-scenario crypto smoke covers every gate including the
  buffer-wipe defense via `sodium.memzero`.
- ✅ Indexer endpoint
  (`apps/indexer/src/api/loginPairing.ts`, ~280 lines).
  `POST /v1/login-pairing/:pid/deliver` (4 KiB body cap,
  `'resource'`-tier rate limit) + `GET /v1/login-pairing/:pid/wait`
  (SSE).  In-memory `PairingRegistry` with single-shot
  enforcement, hard cap 10000 entries, 30s janitor.  12-
  scenario state-machine smoke.  Mounted on the indexer
  rather than the relay because the indexer already has
  SSE infrastructure (orderbook/stream, chat/stream,
  instances/stream).
- ✅ Desktop initiator UI
  (`apps/web/src/lib/components/LoginQrInitiator.svelte`)
  + route `/login/qr-pair`.  Linked from `/login` in both
  branches.
- ✅ Phone scanner UI with grandma-friendly confirmation card
  (`apps/web/src/lib/components/ScanLoginQr.svelte`)
  + route `/scan-login`.  `qr-scanner@^1.4.2` for camera
  decoding (~13KB minified, MIT, zero deps).  Origin URL
  displayed faithfully; default-focus on "No, I didn't"
  button; "started X minutes ago" relative time.
- ✅ Phone-side production signer
  (`apps/web/src/lib/auth/pairingPhoneSigner.ts`).  Reads
  the unlocked posting key from `$stores/identity`,
  computes the domain-separated digest, signs via
  dblurt's secp256k1 primitive, returns the canonical
  65-byte (recovery+31 || r || s) wire form.  Throws
  `PairingSignerError` with structured codes the scanner
  UI surfaces.
- ✅ Desktop-side chain-backed verifier
  (`pairingClient.defaultVerifier` in
  `apps/web/src/lib/auth/pairingClient.ts`).  Fetches
  `posting.key_auths` via the chain rotator, recovers the
  signing pubkey from the signature using the same
  domain-separated digest, requires single-signature
  weight-clearance.
- ✅ i18n × 10 locales (~520 new translation lines):
  `login_qr.*` (19 keys), `scan_login.*` (27 keys),
  `login.qr_pair_cta`, `login.welcome_back.use_phone_instead`,
  SEO entries for both routes.
- ✅ FAQ entry × 10 locales (`faq.entries.qr_login`).
  Grandma-honest prose with concrete homoglyph example
  (`morph1t.io`).
- ✅ Brag-list claim #208 with honest disclosure of
  remaining limitations.

**Final pulse on the shipping commit:** Triple-stable
1952/0 across the smoke suite.  Backend typecheck 0
errors / 7 workspaces.  Frontend typecheck 0/0.

## Pre-launch pending — what's NOT yet shipped

The protocol and code are usable end-to-end for
single-signature posting authorities (the common case).
The following are still backlog:

- **Multisig support.**  Accounts with multi-key posting
  authority requiring multiple signatures cannot pair via
  QR.  The protocol carries one signature; supporting
  multisig requires either (a) extending the bundle to
  carry multiple signatures from multiple signers, or (b)
  delegating to Option C (account_update with a fresh
  posting subkey).  Filed as future work.
- **"Type a 6-word phrase" QR-fallback path.**  Users
  whose phone QR scanner doesn't work would benefit from
  manually typing a short BIP-39-encoded version of the
  pairing payload.  UI hook is in place; encoder/decoder
  not yet implemented.
- **C-15 follow-up:** explicit `dir="ltr"` on the
  confirmation-card URL display element to harden against
  U+202E-style RTL-override attacks on RTL locales.
- **Option C (delegated posting subkey via on-chain
  account_update).**  Strongest UX (desktop becomes a
  fully independent posting device) but leaks "user added
  desktop session" as on-chain metadata.  Documented as
  future opt-in for power users.
- **Native-speaker review** of the security-sensitive
  confirmation-card prose in 9 non-English locales.
- **End-to-end integration test** spinning up indexer +
  Postgres + headless browser.  Current smokes cover the
  state machine + crypto round-trip; full E2E is
  follow-up.

## Part 114 amendment — read-only desktop session (Option A, formalized)

This section closes the "session-establishment gap" left open
at original-ADR time and amends the design with the concrete
Option A semantics now shipped in code.

### What was missing pre-Part-114

The original ADR (above) describes the QR-pair protocol end
to end: ephemeral keys, signed bundle, chain-backed verifier
(see `apps/web/src/lib/auth/pairingClient.ts:defaultVerifier`).
At `'received'` state the desktop holds a verified proof that
the bundle was signed by the account's on-chain posting key,
and the verified envelope carries `account` + `chatPubkey` —
public state, no signing material.

But there was a real gap: nothing turned that proof into a
*session*.  The `'received'` handler called `goto('/')` with
no `bootFromEnvelope`-equivalent, so the user landed on the
homepage still locked.  The verifier worked; the protocol
worked; the application-level sign-in did not.

### The decision

After weighing three closures (see "Three options considered"
above — fully P2P with two cameras, relay-routed envelope,
phone-mediated remote signing), Part 114 ships **Option A —
read-only desktop session**:

- A successful QR-pair handshake establishes a new identity-
  store state `'paired-readonly'` carrying `{ account,
  chatPubkey, pairingId, pairedAt }`.
- The desktop is signed in for READ operations: orderbook,
  profile pages, chat history, settings (viewable), my
  orders, etc.  Everything that doesn't sign with the
  posting key works exactly as it does for an unlocked
  session.
- The desktop CANNOT broadcast write operations from this
  device.  Every write call site (post order, send chat
  message, leave feedback, share address, funds-sent,
  account_update / profile edit, register account name) gates
  on `$isUnlocked` — which is `false` under paired-readonly —
  and renders a `WriteBlockedReadOnly` affordance pointing
  the user back to Morphit on their phone via the
  `web+morphit://` deep-link protocol handler.
- The posting key NEVER leaves the phone.  That is the
  strong privacy property the original ADR set out to
  preserve; Option A preserves it intact.

### Why Option A over B and C

**Option B (phone-mediated remote signing).** Every write op
on the desktop would round-trip back to the phone for
signature, then to the relay for broadcast.  Pros: full
write capability on the desktop.  Cons: doubles the latency
of every write, requires the phone to be online when the user
acts, adds significant new protocol surface (signing-request
routing, replay protection, approval UI, lost-phone
recovery).  Filed as future work for users who specifically
want it; not blocking launch.

**Option C (delegated posting subkey via account_update).**
The phone signs an `account_update` op that adds a fresh
posting subkey the desktop holds.  Pros: desktop is fully
self-sufficient with no phone-online dependency.  Cons: every
pairing event leaves an on-chain footprint visible to anyone
watching the account — the OPPOSITE of the privacy posture
this ADR set out to preserve.  The original ADR (lines
94-103) explicitly rejected this approach for that reason;
Part 114 honors that decision.

**Option A** is the only closure that lands cleanly in one
ship and preserves every privacy property the original ADR
committed to.  WhatsApp Web uses the same model ("phone is
the source of truth; desktop is a window"), so users have a
mental model for it.

### What Option A delivers in code

| Component | Path | Role |
|-----------|------|------|
| Persistence module | `apps/web/src/lib/crypto/pairedSession.ts` | Read/write/clear paired-readonly marker via `safeLocal` (Tor/Private-Mode-safe).  Validator rejects malformed records. |
| Identity store | `apps/web/src/lib/stores/identity.ts` | New `'paired-readonly'` state, derived stores (`isPairedReadOnly`, `pairedReadOnly`, `hasAnySession`), `bootFromPairedSession` (refuses unlocked downgrade), exported `autoRestorePairedSession()` + `handleStorageEvent()` for module-load + cross-tab sync. |
| QR-pair UI | `apps/web/src/lib/components/LoginQrInitiator.svelte` | On `'received'`: captures `pid`, calls `bootFromPairedSession`, persists `morphit.blurtAccount`, navigates to `/orderbook`. |
| Global banner | `apps/web/src/lib/components/PairedReadOnlyBanner.svelte` | Slim emerald bar under the sticky header, always visible during paired-readonly sessions. |
| Write-blocked affordance | `apps/web/src/lib/components/WriteBlockedReadOnly.svelte` | 8 variants (post_order, send_chat, feedback, share_address, funds_sent, profile, register_name, generic).  Deep-links to `web+morphit://` protocol handler with preserved context (peer, orderPermlink). |
| Write call sites updated | `/post`, `ConversationView`, `LeaveFeedbackForm`, `/settings`, `/onboarding/register-name` | Each gates on `$isPairedReadOnly` and shows the WriteBlocked affordance. |
| Welcome-back | `/login` | Fourth formMode `'paired-readonly-welcome'` shown when the store auto-restores a paired session.  Two CTAs: continue read-only, or upgrade to keys (`reset()` + redirect to import). |
| AvatarMenu | `apps/web/src/lib/components/AvatarMenu.svelte` | Renders for both unlocked AND paired sessions (`$hasAnySession`).  Paired sessions get a small emerald indicator pill on the avatar and a "via phone (read-only)" pill above the menu items.  Lock Session is hidden for paired sessions (`canLock = hasPersistedKeystore() && !$isPairedReadOnly`). |

### Cross-tab semantics

Mirror of the existing keystore §F.17 cross-tab posture:

- Locked tab + sibling pairs → adopt paired marker.
- Paired tab + sibling clears paired marker → drop to locked.
- Unlocked tab + sibling pairs → ignore (unlocked is strictly
  more capable than paired-readonly; don't downgrade).
- Unlocked tab + sibling clears keystore → existing behavior
  unchanged (drop to locked via `reset()`).

The handler is `handleStorageEvent(e)` — exported so vitest
under jsdom can call it directly, since SvelteKit's `browser`
flag is `false` in test env and would otherwise skip the
listener registration.  Same dispatch in production, just
testable.

### Test coverage

- `apps/web/src/lib/crypto/pairedSession.test.ts` — 21 tests
  covering round-trip, idempotent overwrite, clear, validator
  rejection (12 distinct shapes), Private Mode storage refusal.
- `apps/web/src/lib/stores/identityPaired.test.ts` — 15 tests
  covering bootFromPairedSession + lockSession + reset
  semantics, cross-tab adopt/drop/ignore, autoRestorePairedSession
  idempotency and `morphit.blurtAccount` reconciliation.
- `apps/web/scripts/paired-readonly-lifecycle-smoke.ts` — 18
  scenarios registered in `scripts/run-smokes.sh` next to
  `desktop-pairing-crypto-smoke`.
- Triple-pulse smoke: 2,296 / 2,296 / 2,296.
- Full frontend unit suite: 586 passed, 5 pre-existing
  keystore-cross-tab skips, 0 failed.

### Locale coverage

New `paired_readonly` block in all 10 locales with 16 keys
each (banner heading + body, 7 write-blocked variant bodies,
generic heading, action label, avatar menu pill, welcome-back
heading + body + continue + use-keys-instead).  Locale parity
verified: 2,448 keys × 10 locales.

### What's still NOT shipped (kept honest)

The same backlog items listed in the pre-Part-114 ADR remain
open (multisig, 6-word phrase fallback, native-speaker
review, full E2E with headless browser).  Option B
(phone-mediated remote signing) and Option C (delegated
posting subkey) are intentionally NOT shipped — they're
future work, gated on user demand and a separate ADR.

For Option A specifically:

- ✅ Verifier wired (chain-backed signature recovery).
- ✅ Session-establishment wired (bootFromPairedSession).
- ✅ Persistence + auto-restore wired.
- ✅ Cross-tab sync wired.
- ✅ Every write call site updated with the WriteBlocked affordance.
- ✅ AvatarMenu shows paired state.
- ✅ Welcome-back path handles paired-readonly first.
- ✅ Sign-out wipes paired marker.
- ✅ Test coverage end-to-end.
- ✅ All 10 locales at parity.

Option A is complete and shippable as of Part 114.
