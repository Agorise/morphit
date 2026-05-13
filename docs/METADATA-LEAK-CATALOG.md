# Morphit metadata-leak catalog

**Date:** 2026-05-01
**Source:** Audit 2026-05 Part 10 enumeration
**Status:** Reference document (extracted from
docs/AUDIT-2026-05.md Part 10; standalone copy for operators
and security reviewers who want the leak catalog without
the rest of the audit).

This catalog enumerates what a passive observer learns about
a Morphit user from each surface of the system. It is the
result of a deliberate enumeration pass — not an exhaustive
formal threat model, but a complete catalog of what the
auditor could identify in the code.

The system as a whole does NOT promise metadata privacy.
ADR-0008 (indexer architecture) and ADR-0015 (chat crypto)
both state this in plain language: chain ops are public, and
even with E2E-encrypted message bodies, envelope metadata
(sender, recipient, timestamp, ciphertext-length) is visible
to anyone reading the chain. Federation is the long-term
mitigation: an instance you trust serves you, and the leaks
that go to the indexer happen against an indexer you control.

Below: each leak surface, its category, what it leaks, and
either the seal applied or the documented architectural
acceptance.

---

## Category A — Network-observable leaks

These leaks are visible to ISPs, network-level adversaries,
and anyone running an indexer or RPC node.

### A.1 Indexer SSE streams

**What leaks:** A passive observer of the user's network
traffic sees they're connected to `/v1/orderbook/stream`,
`/v1/chat/stream`, or `/v1/instances/stream`. Connection
duration, traffic timing, and total bytes are observable
but bodies are TLS-encrypted.

**Status:** Inherent to a non-mixnet design. ADR-0008
acknowledges. Mitigation is to run your own indexer
(federation) or use Tor.

**Defenses applied this audit:** SSE buffers capped at 500
events on both chat and orderbook streams (Findings 2-11
and NEW-10-2) so a hostile server can't OOM the client.

### A.2 Federation probe

**What leaks:** When indexer A probes indexer B's
`/v1/health` endpoint, B's web server logs A's source IP.
Federation directories can be mapped this way.

**Status:** Inherent to federation. The probe is necessary
to know whether a registered instance is actually serving.

**Defenses applied this audit:** SSRF defenses (Finding 5-5)
prevent operator-supplied origins from coercing the probe
into hitting internal networks. Response body capped at
256KB (Finding NEW-9-11).

### A.3 Blurt RPC traffic

**What leaks:** Every chain action (orderbook fetch, profile
fetch, broadcast) hits one of the 4 default Blurt RPC
endpoints. ISPs and the RPC operator both see "this IP is
using a Blurt frontend at roughly this rate."

**Status:** Inherent to using Blurt. Mitigation is to add
your own RPC endpoint (Settings) or run a Blurt node locally.

### A.4 CoinGecko price API

**What leaks:** Browser sends `Origin: yourinstance.example.com`
to CoinGecko on each price refresh (every 5 min). CoinGecko
sees "this IP uses a Morphit-branded frontend."

**Status:** Acceptable tradeoff vs hosting our own price
feed. Minor — same class as fetching any public CDN.

**Defenses applied this audit:** Response body capped at
64KB (Finding NEW-10-3) so a compromised CoinGecko endpoint
can't OOM the client. CSP `connect-src` allowlists CoinGecko
explicitly (Finding 6-5).

---

## Category B — On-chain leaks

These leaks are visible to anyone reading the Blurt blockchain
(which is public and indefinitely-archived).

### B.1 Per-account posting key

**What leaks:** Every Morphit action is signed by a Blurt
posting key. All activity by one account correlates.

**Status:** ADR-0002 design. The user's account name is
their identity on Morphit. Privacy is via account-creation
hygiene (use Tor + fresh account if you need
unlinkability), not via key obfuscation.

### B.2 Order patterns

**What leaks:** Order side, asset, payment methods, hours,
regions all on chain forever. A user's regional/preference
fingerprint is permanent.

**Status:** ADR-0009 design. Inherent to a public-orderbook
system.

### B.3 Chat envelope

**What leaks:** sender, recipient, block-time, ciphertext
length on every chat message. Message bodies are
E2E-encrypted (ADR-0015) but the envelope is public.

**Status:** ADR-0015 explicitly states this in its security-
properties section. Inherent to using a public chain as the
chat transport.

### B.4 Block-time correlation

**What leaks:** Multi-account same-user behavior can be
correlated across blocks (similar IP source signs ops on
multiple accounts within seconds).

**Status:** Inherent to using a public timestamped log.
Mitigation requires Tor or per-account isolation.

---

## Category C — Server-stored leaks

These are observable to indexer operators (or anyone who
breaches the indexer database).

### C.1 stranger_fees table

**Rows:** `(sender, recipient, paid_at, amount_blurt)`.

**What leaks:** Which pairs of accounts have engaged in
first-contact chat exchanges and when.

**Status:** Derived from public chain ops, so no new
exposure beyond Category B. The indexer table is just a
queryable index over data that's already public.

### C.2 operator_blocks reasons

**What leaks:** Operator-supplied free text justifying a
block. Could include identifying detail about the blocked
party.

**Status:** ADR-0021 design. Operator's responsibility.
Sanitized at intake (bidi/zero-width/control chars
stripped per Finding #10 from Batch I) and at render
(Finding #15 belt-and-braces).

### C.3 order_views

**Schema:** Single row per permlink with `count` + `updated_at`.
**Verified aggregate-only** — no per-viewer rows. Order author
sees their order's total view count; no individual viewer
identity is stored or queryable.

---

## Category D — Client-stored leaks

These are observable to anyone with local-storage access:
other tabs of the same origin, malicious browser
extensions, or someone with post-compromise device access.

### D.1 localStorage caches

**Stores:** recent peers, chat read-state, pubkey TOFU pins,
drafts (chat / post / feedback / feedback-response),
trade-status entries, BLURT-verifier result cache.

**What leaks:** Reveals who the user has been chatting with,
what they've drafted, what trades are in progress.

**Status:** Cleared on explicit lock. The
`runExplicitLockExtras()` function in
`apps/web/src/lib/chat/explicitLock.ts` (Finding F-44)
clears every privacy-sensitive cache: drafts (all
categories), recent peers, read state, pub pins, all trade
states, verify cache. **Auto-lock (idle timeout)
intentionally preserves drafts** — the user's intent to send
is still there. Only explicit user-initiated lock wipes.

### D.2 IndexedDB / cache storage

**Contents:** Service worker holds static assets only (HTML,
JS, CSS, fonts). No user data. Assets are pinned at install
time per ADR-0019; updates require explicit user consent.

### D.3 Notification permission state

**What leaks:** Browser-managed; reveals "user has granted
notification permission to this origin." Standard browser
fingerprint surface.

**Status:** Permission request is point-of-relevance (not
page-load) with 3-step decline backoff. Default-off until
user explicitly opts in.

---

## Category E — Side-channel / fingerprinting

### E.1 Notification permission timing

**Mitigated:** request only fires on first relevant event,
not page load. Decline backoff: 1 wk → 1 mo → never. Banner
respects user pacing.

### E.2 Audio context

**What leaks:** AudioContext fingerprint (a known browser
fingerprinting vector).

**Status:** Gated by user opt-in (default off in
notification preferences). AudioContext is created lazily
on first chime play. Acceptable.

### E.3 Bundle version

**What leaks:** `__MORPHIT_VERSION__` (from package.json) is
in the global scope, readable by any script that runs.
Useful for compatibility detection but also a fingerprint
bit.

**Status:** Acceptable. Other Blurt frontends do the same.

---

## Sealings applied this audit

Inline fixes from the metadata-leak enumeration:

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

## What can't be sealed in code

- Categories A.1–A.4 (network observables) require Tor, a
  VPN, or self-hosted infrastructure to fully mitigate.
- Categories B.1–B.4 (on-chain) are inherent to using a
  public blockchain. Mitigated only by careful account
  hygiene at the human level.
- Category D.3, E.1, E.2 (browser-managed surfaces) are
  fingerprint vectors common to all web applications.

The federation model addresses what code can't: by running
your own indexer, you eliminate the server-stored leak
class (C.*) for your own users, and you control whose
indexer your users' SSE traffic goes to.
