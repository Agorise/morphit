# Morphit metadata-leak catalog

**Date:** 2026-05-01 (refreshed 2026-05-22)
**Source:** Audit 2026-05 Part 10 enumeration
**Status:** Reference document — published openly so users can
see exactly what Morphit does and does not protect.

## Read this first

We wrote this document to be honest, not to be scary. Privacy
is a spectrum, and the only way to give you the tools to
choose your own posture is to tell you the truth about what
each surface of Morphit reveals — and what we've done to
shrink that surface as much as the architecture allows.

The summary in one paragraph: **Morphit logs no IP addresses,
no analytics, no cookies, no email, no phone, no KYC.** Trade
chat is end-to-end encrypted (ECIES with sender-ephemeral
keys; bodies are unreadable even to Morphit's indexer). Static
assets are self-hosted (no Google Fonts, no third-party CDNs,
no trackers). Every fee verifier query goes through a
multi-explorer quorum, and per-user payment data never leaves
your device. Your private keys never leave your browser; the
project couldn't decrypt your chats if a regulator demanded it.

What's left after all that hardening is a small set of leaks
that follow from Morphit being a **public-orderbook,
public-chain marketplace** rather than a centralized custodial
one. A public orderbook means orders are visible (that's what
makes federation work). A public chain means chat envelopes
(sender, recipient, timestamp, ciphertext-length) are
observable, even though the message bodies inside them aren't.
We didn't ship any of those leaks by accident — each one is
either documented in an ADR or sealed by a defense listed below.

For comparison: a centralized exchange knows your government
ID, your home address, your bank details, your IP address on
every login, your full trading history, your withdrawal
destinations, and (often) the plaintext of every chat you have
with their support team. Morphit's leak surface, by contrast,
is on the order of "an observer who runs an indexer can see
that some BLURT account posted an order, and chose certain
asset/payment-method/region values for it." That's
qualitatively different.

## What we already do to minimize leaks

Before reading any of the categories below, here is a partial
list of the defenses already shipped in the codebase. Every
one is enforced by code, not by promise, and most are pinned
by CI smokes that fail the build if a future change weakens
them.

**Network layer**
- TLS everywhere; no plaintext HTTP endpoints
- Strict CSP locks scripts to first-party (`connect-src` is an
  explicit allowlist; no third-party trackers, no CDNs, no
  fonts.googleapis.com, no Cloudflare in front of the indexer)
- No Google Analytics, no Hotjar, no Facebook Pixel, no
  third-party telemetry of any kind
- Fonts and assets self-hosted from your operator's domain
- No cookies; no sessions on the server
- Tor `.onion`, I2P `.b32`, Lokinet first-class transports
  (federation entry points are deliberately equal-class with
  clearnet — not "an onion mode" tacked on as an afterthought)
- No IP logging anywhere: `apps/relay/src/middleware/ip.ts`
  treats the client IP as a rate-limit bucket key in process
  memory only; never written to disk, never logged, never
  transmitted, discarded when the rate-limit window passes

**Chat & messages**
- End-to-end ECIES (X25519 + ChaCha20-Poly1305-IETF) with a
  fresh sender-ephemeral key per message (ADR-0015)
- Chat ciphertext stored on chain — not on Morphit's servers
- TOFU pin on the recipient's chat key with chain-anchored
  verification; out-of-band fingerprint comparison available
  for users who want belt-and-suspenders MITM defense
- Accidental-secret scanner in every chat box (WIF keys,
  64-char hex, seed phrases) — warns before send and truncates
  on confirmed override

**Identity & authentication**
- No email, no phone, no SMS, no KYC
- No password storage; you hold your own keys
- No central session database for an attacker to compromise
- Pubkey identicons everywhere user accounts appear, so
  `@morph1t` vs `@morphit` is visually obvious

**On-chain hardening (where we control it)**
- Order ops never include your IP, browser fingerprint, or
  device identifier — only fields you explicitly typed
- Chat envelope metadata is the minimum the chain can carry
  (sender, recipient, block-time, ciphertext-length)
- Amount-jitter on every shared address (BTC, BCH, LTC, DASH,
  DOGE, ZEC, ARRR, DCR, BLURT, SOL, ETH, XRP, XMR, USDT, USDC,
  DAI — all 16 supported assets) so the chat-shared figure
  doesn't link cleanly to a chain transfer
- PayJoin (BIP-78) support for BTC trades that want to break
  the common-input-ownership heuristic chain analysis uses
- XMR private view-key NEVER leaves the operator's box (no
  publishing on chain, no API, no logs)

**Server data**
- Indexer database stores aggregate counts only for view
  surfaces (no per-viewer rows in `order_views`)
- Operator-supplied free text (block reasons, etc.) sanitized
  at intake AND at render (bidi/zero-width/control chars
  stripped, belt-and-braces)
- No long-lived analytics tables, no per-user activity logs
- Federation = your operator runs the server, not us — your
  data is on infrastructure controlled by whoever you trust

**Client storage**
- No third-party cookies; no fingerprinting libraries
- localStorage caches wiped on explicit lock
  (`runExplicitLockExtras()` in
  `apps/web/src/lib/chat/explicitLock.ts`)
- IndexedDB holds static assets only — never user data
- Service worker assets pinned at install time per ADR-0019

If any of the above looks aspirational, it's actually shipped
code with CI smokes preventing regression. The catalog below
is the **honest residual** after all of that has been done.

## Catalog format

Below: each leak surface, its category, what an observer
learns, **what we've done to shrink it as far as the
architecture permits**, and (if applicable) what the user can
do to take it further (Tor, federation, self-hosting).

The categories are stratified by who can observe what:

- **Category A — Network-observable**: visible to your ISP
  and to anyone running a server you connect to. The
  smallest, mostly-encrypted surface.
- **Category B — On-chain**: visible to anyone reading the
  Blurt blockchain (which is, by design, public). This is
  what "federated, public-orderbook marketplace" inherently
  implies.
- **Category C — Server-stored**: visible to the indexer
  operator running your instance. Federation lets you choose
  who that is — including yourself.
- **Category D — Client-stored**: visible to other tabs of
  the same origin, malicious browser extensions, or someone
  with post-compromise device access.
- **Category E — Side-channel / fingerprinting**: standard
  web-platform fingerprint surfaces common to every website.

---

## Category A — Network-observable

These leaks are visible to ISPs and to anyone running an
indexer or RPC node you connect to. Bodies are TLS-encrypted;
what's visible is connection metadata (who you're talking to,
when, for how long, how much data).

**The mitigation already done in code:** TLS on every endpoint;
no third-party connect-src targets except a small allowlist
(Blurt RPC + CoinGecko price API); no analytics; no IP
logging. **Run your own indexer or use Tor** to remove
this category entirely.

### A.1 Indexer SSE streams

**What an observer sees:** Your IP connecting to
`/v1/orderbook/stream`, `/v1/chat/stream`, or
`/v1/instances/stream`. Connection duration, traffic timing,
and total bytes are visible — but **message bodies are
TLS-encrypted**, so the observer can't read individual
orderbook updates or chat envelopes from network capture.

**Defenses applied:** SSE buffers capped at 500 events on both
chat and orderbook streams (Findings 2-11 and NEW-10-2) so a
hostile server can't OOM the client.

**Take it further:** Run your own indexer (federation), or
connect via Tor — the observer then sees only Tor traffic, not
a Morphit indexer endpoint.

### A.2 Federation probe

**What an observer sees:** When indexer A probes indexer B's
`/v1/health` endpoint to confirm B is still serving, B's web
server logs A's source IP. Federation directories can be
mapped this way.

**Defenses applied:** SSRF defenses (Finding 5-5) prevent
operator-supplied origins from coercing the probe into hitting
internal networks. Response body capped at 256KB (Finding
NEW-9-11). The probe touches `/v1/health` only — no
user-identifying data crosses the federation link.

**Take it further:** Operator-level only; federation members
choose whether to allow direct probes or run behind a relay.

### A.3 Blurt RPC traffic

**What an observer sees:** Every chain action (orderbook
fetch, profile fetch, broadcast) hits one of the configured
Blurt RPC endpoints. ISPs and the RPC operator see "this IP
is using a Blurt frontend at roughly this rate."

**Defenses applied:** All RPC calls TLS-encrypted; the user's
account name and posting key never appear in plaintext in
network captures. Multiple RPC endpoints in default config so
no single operator sees all your traffic.

**Take it further:** Add your own RPC endpoint via Settings,
or run a Blurt node locally and point your client at
`localhost`.

### A.4 CoinGecko price API

**What an observer sees:** Your browser sends
`Origin: yourinstance.example.com` to CoinGecko on each price
refresh (every 5 min). CoinGecko sees "this IP uses a
Morphit-branded frontend."

**Defenses applied:** Response body capped at 64KB (Finding
NEW-10-3) so a compromised CoinGecko endpoint can't OOM the
client. CSP `connect-src` allowlists CoinGecko explicitly
(Finding 6-5) so a script-injection can't redirect price
queries to an attacker. **No personal data crosses this hop**
— just a generic CORS `Origin` header that every browser
sends for every cross-origin fetch.

**Take it further:** Operators can configure a self-hosted
price feed; the indexer doesn't depend on CoinGecko for
fee-verification math (that's BLURT-native and CoinGecko
data is display-only).

---

## Category B — On-chain

These leaks are visible to anyone reading the Blurt blockchain
(which is, by design, a public ledger). Morphit publishes
exactly four things on chain: orders, chat ciphertexts,
feedback ratings, and operator-administrative ops. Everything
else stays off chain.

**The mitigation already done in code:** Chat bodies are
E2E-encrypted (ADR-0015) so even though envelopes are public,
**message content is unreadable** to chain observers. Orders
contain only fields you typed (no IP, no fingerprint, no
device identifier). Amount-jitter on every shared address
breaks the chat-amount-to-chain-transfer link for all 16
supported assets. **This is the surface that federation can't
shrink** — it's inherent to using a public blockchain as the
coordination layer.

### B.1 Per-account posting key

**What an observer sees:** Every Morphit action is signed by a
Blurt posting key. All activity by one account correlates to
the same posting key.

**Why we accept this:** ADR-0002 design — your Blurt account
name IS your Morphit identity. Reputation only works if it
sticks to a stable identifier.

**Take it further:** Use Tor + a fresh account if you need
unlinkability between separate slices of activity. Multiple
accounts are explicitly supported and the relay's
related-account detection only catches **coordinated abuse
patterns** (same-day creation, immediate trade-between-self
behavior) — using two unrelated accounts at different times
for different purposes is normal and untracked.

### B.2 Order patterns

**What an observer sees:** Order side (buy/sell), asset,
payment methods, hours, regions — all on chain forever. A
user's regional/preference fingerprint accumulates over time
if all orders post under the same account.

**Why we accept this:** ADR-0009 design — a federated
orderbook needs to be readable by all federated indexers, and
"readable by federation" means "readable by anyone." It's the
same tradeoff every public-orderbook DEX makes.

**Defenses applied:** Order ops contain only fields you
typed. No metadata is silently attached at broadcast — no IP
hash, no timezone derived from Date, no language preference,
no browser fingerprint. **What you see in the order form is
what goes on chain, nothing more.**

**Take it further:** Per-trade fresh accounts (a Blurt account
creation is free for new Morphit users) + Tor breaks the
across-orders correlation.

### B.3 Chat envelope

**What an observer sees:** Sender, recipient, block-time,
ciphertext-length — for every chat message. The **content of
the message is E2E-encrypted** and unreadable.

**Why we accept this:** ADR-0015 explicitly states this in its
security-properties section. Using a public chain as the chat
transport means envelope metadata is observable; the
alternative (storing chat on Morphit's servers) would let the
operator read everything, which we judged a worse tradeoff.

**Defenses applied:** ChaCha20-Poly1305-IETF AEAD with
per-message sender-ephemeral X25519 keys (sender-side forward
secrecy: even if your posting key leaks later, **past messages
you sent stay confidential**). TOFU pinning prevents
mid-conversation key swap. Ciphertext-length is the minimum
that AEAD chunking allows.

**Take it further:** Tor + per-trade fresh account + opt-in
out-of-band fingerprint verification (the "Verify peer" item
in the conversation menu).

### B.4 Block-time correlation

**What an observer sees:** Two accounts posting ops within
seconds of each other from similar transaction patterns can
be probabilistically linked.

**Why we accept this:** Inherent to using a public timestamped
log.

**Take it further:** Use Tor and avoid posting from multiple
accounts in rapid succession.

---

## Category C — Server-stored

These are observable to indexer operators (or anyone who
breaches the indexer database). **Federation is the primary
mitigation:** you choose which operator's indexer you use
(including running your own), so the question becomes "who do
you trust with the same data you'd give a friend who runs a
node."

### C.1 stranger_fees table

**Rows:** `(sender, recipient, paid_at, amount_blurt)`.

**What an observer sees:** Which pairs of accounts have
engaged in first-contact chat exchanges and when.

**Why we accept this:** Derived from public chain ops, so
**no new exposure beyond Category B**. The indexer table is
just a queryable index over data that's already public on chain.

### C.2 operator_blocks reasons

**What an observer sees:** Operator-supplied free text
justifying a block. Could contain identifying detail about
the blocked party.

**Defenses applied:** Sanitized at intake (bidi/zero-width/
control chars stripped per Finding #10 from Batch I) and at
render (Finding #15 belt-and-braces). Operator's
responsibility to keep reasons abstract; the indexer enforces
character-class limits.

### C.3 order_views

**Schema:** Single row per permlink with `count` +
`updated_at`. **Verified aggregate-only — no per-viewer rows.**
Order author sees their order's total view count; **no
individual viewer identity is stored or queryable**, by
construction. Even the indexer operator can't recover a
viewer list because the data isn't there to recover.

---

## Category D — Client-stored

These are observable to other tabs of the same origin,
malicious browser extensions, or someone with post-compromise
device access.

**The mitigation already done in code:** every privacy-
sensitive cache is wiped on explicit lock; only static assets
go in IndexedDB. The threat model here is "your device, after
someone else has it" — and the defense is the explicit lock,
plus Morphit storing the minimum needed to make the app work
offline.

### D.1 localStorage caches

**Stores:** recent peers, chat read-state, pubkey TOFU pins,
drafts (chat / post / feedback / feedback-response),
trade-status entries, BLURT-verifier result cache.

**What's at risk:** Reveals who the user has been chatting
with, what they've drafted, what trades are in progress —
**to someone with local access to the device**.

**Defenses applied:** All privacy-sensitive caches wiped on
explicit lock. The `runExplicitLockExtras()` function in
`apps/web/src/lib/chat/explicitLock.ts` (Finding F-44) clears
every cache: drafts (all categories), recent peers, read
state, pub pins, all trade states, verify cache.

**Why auto-lock keeps drafts:** Auto-lock (idle timeout)
intentionally preserves drafts — the user's intent to send
is still there, and discarding mid-compose work would be
hostile. **Only explicit user-initiated lock wipes.** If you
share your device, explicit lock before stepping away.

### D.2 IndexedDB / cache storage

**Contents:** Service worker holds **static assets only**
(HTML, JS, CSS, fonts). **No user data.** Assets are pinned
at install time per ADR-0019; updates require explicit user
consent.

### D.3 Notification permission state

**What's at risk:** Browser-managed; reveals "user has
granted notification permission to this origin" — a standard
browser fingerprint surface that every website that uses Web
Push exposes.

**Defenses applied:** Permission request is at point-of-
relevance (not page-load), with 3-step decline backoff (1
week → 1 month → never). Default-off until the user
explicitly opts in. **You can decline forever and Morphit
works fine** — Web Push is opt-in, not required.

---

## Category E — Side-channel / fingerprinting

These are standard web-platform fingerprint surfaces common
to every modern website. Mitigated as far as the browser API
allows; the residual matches every other web app.

### E.1 Notification permission timing

**Defenses applied:** Request fires only on first relevant
event, not page load. Decline backoff: 1 week → 1 month →
never. Banner respects user pacing.

### E.2 Audio context

**What's at risk:** AudioContext fingerprint (a known browser
fingerprinting vector).

**Defenses applied:** Gated by user opt-in (default-off in
notification preferences). AudioContext is created lazily on
first chime play. **If you don't enable chime sounds, no
AudioContext is ever created on your behalf.**

### E.3 Bundle version

**What's at risk:** `__MORPHIT_VERSION__` is readable in the
global scope by any script that runs.

**Why we accept this:** Useful for compatibility detection and
bug reports. **Acceptable** — every web app exposes version
information this way; bundle version is one of the lowest-
entropy fingerprint bits in existence.

---

## How Morphit's leak surface compares

For grounding, here's what each kind of alternative is known
to collect on you:

| Source | They collect |
|---|---|
| Centralized exchange (CEX) | Gov ID, address, bank info, login IPs, full trade history, withdrawal destinations, support-chat plaintext, often device fingerprints |
| Fake DEX with KYC | Same as CEX + the marketing claim of "decentralized" |
| Bisq desktop app | Tor IP (if Tor not running), full local trade DB, Tor bandwidth signature |
| Haveno desktop app | Same as Bisq + Monero RPC traffic |
| **Morphit** | Public orderbook entries you posted; public chat envelopes (ciphertexts unreadable); aggregate view counts. Plus localStorage drafts on your own device, until you explicit-lock. **Zero IP logging. Zero KYC. Zero analytics.** |

The leak surface above is what we couldn't seal in code
without breaking the federated/public-orderbook architecture.
**Everything we could seal, we have sealed,** and the
catalog will keep getting smaller as we ship more defenses —
this document gets refreshed every audit cycle.

---

## Sealings applied this audit (2026-05)

Concrete inline fixes from the metadata-leak enumeration:

- **Chat-route noindex** (`/chat/*`): sealed search-engine
  indexing of conversation URLs (peer account names in URL).
- **Backup-keys noindex** (`/backup-keys`): sealed indexing
  of the private backup-prompt page.
- **Orderbook SSE buffer cap** (NEW-10-2): capped at 500
  events; mirror of chat-stream Finding 2-11.
- **CoinGecko response body cap** (NEW-10-3): 64KB cap;
  mirror of federation-probe Finding NEW-9-11.
- **CSP connect-src allowlist** (Finding 6-5): tightened to
  explicit hosts at both runtime (nginx) and build-time
  (svelte.config.js) layers.

## What's left that code can't seal

A short list of residuals that are inherent to the
architecture (and the user-level tools available to mitigate
each):

- **A.1–A.4 (network observables)** → run Tor or a VPN, or
  self-host an indexer to remove the indexer-side observability
- **B.1–B.4 (on-chain)** → inherent to a public-blockchain
  marketplace; mitigated by careful account hygiene at the
  human level (separate accounts for separate purposes, fresh
  account + Tor when unlinkability matters)
- **D.3, E.1, E.2 (browser fingerprint surfaces)** → common
  to all web applications; gated by explicit user opt-in
  where the browser API allows

**Federation is the meta-mitigation.** Running your own
indexer eliminates the entire server-stored class (C.*) for
your own users, gives you control over whose indexer sees
your SSE traffic, and lets you point at a self-hosted Blurt
RPC. The wizard at `morphit-ops init` walks you through the
setup in roughly 20 prompts; the operator runbook lives at
`docs/RUN-A-MORPHIT-NODE.md`.

If you find a leak surface this catalog doesn't cover, open
an issue at git.agorise.net/agorise/morphit. The
catalog gets refreshed each audit cycle and grows on
disclosure, not on time.
