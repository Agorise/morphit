# Morphit STRIDE matrix — pre-launch security review

> **2026-05-07 forward note:** the "3-minute" replace-window
> values referenced in this matrix describe the system at the
> time of the review. Updated to **15 minutes** in Part 70;
> see ADR-0001 Amendment for the threat-model re-analysis.

Threat-modeling matrix for the four primary attack surfaces:
1. Frontend (SvelteKit static SPA, served from operator's nginx)
2. Indexer (Hono HTTP server, public-read-only, reads chain → DB)
3. Relay (Hono HTTP server, signs account_create + drains transfer queue)
4. Chain (Blurt blockchain — public, federated)

Each row is a threat category × surface, recording: the threat, the existing
mitigation, residual risk, and any open gaps. Generated 2026-05 in the final
pre-launch audit pass.

────────────────────────────────────────────────────────────────────────

## Spoofing

### S1 — Attacker impersonates @morphit to push hostile release
**Surface:** Frontend / Indexer
**Threat:** Attacker compromises a key controlling an account named `morphit`
on a wormhole'd Blurt fork, broadcasts `morphit_release_v1` with a malicious
hash_manifest pointing at attacker-controlled JS bundles.
**Mitigation:**
- Indexer's `release.ts` handler enforces 3-condition AND: signer ===
  officialAccountName, signer's posting pubkey on chain === pinned
  officialPostingPubkey, payload validates structurally
- Frontend pins the same officialPostingPubkey via the build
- Chain ID pinned, indexer refuses to operate against a different chain
**Residual risk:** if Posting key is compromised, the
canonical instance broadcasts a hostile release. Mitigation: posting
key is cold-signed for releases (canonical-operator procedure documented
in OPERATIONS.md §8 owner-key-rotation).
**Gap:** None observed.

### S2 — Attacker spoofs a legitimate user via on-chain custom_json forgery
**Surface:** Indexer
**Threat:** Attacker broadcasts `morphit_*` ops claiming to be from a victim.
**Mitigation:** Blurt's chain enforces signing — every custom_json carries
the broadcasting account's signature. Indexer takes `ctx.signer` from the
chain's verified signer field, never from the payload. Spoofing would
require compromising the victim's posting key, which is a chain-level
problem, not Morphit's.
**Residual risk:** Posting-key compromise is the user's responsibility.
**Gap:** None observable.

### S3 — Attacker uses display_name to impersonate operator accounts
**Surface:** Frontend rendering
**Threat:** User sets display_name = "@morphit" or homograph confusables
(Cyrillic м, fullwidth ＠, etc.), tries to look like a trust signal.
**Mitigation:**
- profile.ts handler rejects leading @ (or fullwidth ＠) with
  display_name_leading_at
- impersonatesReservedName confusable-skeleton check (Cyrillic/Greek/
  fullwidth substitutions for Latin)
- Forbidden char filter (control, bidi-override, ZWJ)
- NFC normalization before all checks
**Residual risk:** New homograph attacks against new reserved names will
require updating confusables.ts. Mitigated by the table-update process.
**Gap:** None observed.

### S4 — Off-host proxy lies about client IP
**Surface:** Relay rate limiter
**Threat:** Attacker on the loopback path forges X-Forwarded-For to bypass
per-IP rate limits and signup ceilings.
**Mitigation:**
- `clientIp()` only honors forwarded headers when peer is in
  LOOPBACK_PEERS = {127.0.0.1, ::1, ::ffff:127.0.0.1}
- Length cap on header values (64 chars)
- Leftmost XFF entry only
- C2 audit fix: leading-comma XFF (`, 1.1.1.1`) now correctly rejected
  rather than treated as a malformed leftmost entry that bypasses bucketing
**Residual risk:** If operator runs the relay directly on a public port
(not behind nginx loopback), socket peer IS the attacker's IP, so
forwarded-header forgery doesn't help. OPERATIONS.md §14 documents this
deployment requirement.
**Gap:** None observed (post-C2 fix).

────────────────────────────────────────────────────────────────────────

## Tampering

### T1 — Tampering with stored chain data after indexing
**Surface:** Indexer DB
**Threat:** Attacker with DB access modifies orders / feedback / profiles
to alter market signals or insert fake content.
**Mitigation:** Database access is operator-controlled — running the
indexer means trusting the operator. There's no in-band defense against
a malicious operator. Federation provides cross-instance comparison: a
user can switch to another operator's instance and re-derive state from
chain. The chain is the source of truth.
**Residual risk:** Yes — a single instance is only as honest as its
operator. Federation is the design response.
**Gap:** Not a gap; it's the threat model.

### T2 — Tampering with an order via replace within the 3-min window
**Surface:** Indexer order pipeline
**Threat:** User creates an order with substance X, swaps to substance Y
within the replace window to defeat policy.
**Mitigation:**
- Replace handler enforces side / asset / fiat_currency immutable
- B1 audit fix: waiver-floor (500 BLURT amount_min) re-enforced on
  replace when target.fee_method='waived_first_buy'
**Residual risk:** Other substantive fields (terms, location, payment_methods,
amount_max, price_model) ARE mutable in the 3-minute window — by design,
because that's the typo-fix purpose of the replace op.
**Gap:** None observed (post-B1 fix).

### T3 — Tampering with avatar SVG to inject XSS
**Surface:** Frontend rendering
**Threat:** Attacker submits profile op with `json_metadata.avatar_svg`
containing `<script>` or event handlers; victim viewing the profile gets
JS execution.
**Mitigation:**
- Frontend's avatar editor passes input through `sanitizeSvg` before
  broadcasting (script tags, event handlers, javascript: URLs all stripped)
- profileProps.ts re-sanitizes on read (G2.2 fix) — defense in depth
  against malicious indexer or chain-direct submission
- avatar_data_uri shape-validated to image/{webp,png,jpeg,gif} only
  (no SVG smuggling) (O3.2 fix)
**Residual risk:** A regression in sanitizeSvg's allowlist would expose
XSS. Mitigation: comprehensive test suite at `apps/web/src/lib/avatar/`.
**Gap:** None observed.

### T4 — Tampering with ciphertext-bearing chat message
**Surface:** Chat encryption
**Threat:** Attacker modifies a chat message's ciphertext mid-broadcast.
**Mitigation:** Chain signature covers the entire op including the
ciphertext field. Modifying after-the-fact breaks the signature; chain
rejects. ChaCha20-Poly1305 authentication tag inside the ciphertext
detects any modification post-broadcast even if signature was somehow
bypassed.
**Residual risk:** None.
**Gap:** None observed.

────────────────────────────────────────────────────────────────────────

## Repudiation

### R1 — User claims they didn't post an order
**Surface:** Chain layer
**Threat:** User posts an order, gets attestation/feedback consequences,
later denies posting.
**Mitigation:** Chain provides non-repudiable signed history. Signer is
verified by network; once on chain, it's permanent. Indexer's event_log
keeps an audit trail of every op processed.
**Residual risk:** None at chain layer. Off-chain trade-completion claims
are soft-rep — the indexer doesn't try to be a payment escrow.
**Gap:** None observed.

### R2 — Operator denies handling an HTTP request
**Surface:** Relay/Indexer logging
**Threat:** Operator claims a request never came in (e.g. abuse complaint).
**Mitigation:** The relay's access_log middleware (Part 47) records every
request with IP-elided rate-limit decisions, response codes, and trace IDs.
Sufficient for operator-side dispute resolution without storing IPs.
**Residual risk:** Operator could rotate logs. Mitigated by the federated
nature — abuse reports can include the on-chain trx_id which any honest
indexer can confirm.
**Gap:** None observed.

────────────────────────────────────────────────────────────────────────

## Information disclosure

### I1 — Indexer responses leak internal state via verbose errors
**Surface:** Indexer HTTP API
**Threat:** Stack traces, SQL errors, file paths in responses give attacker
recon data.
**Mitigation:** Every API endpoint wraps errors in stable code/message
shapes. Raw error messages never echoed to client (verified across all 4
relay endpoints, all 17 indexer handlers, all REST routes).
**Residual risk:** Low — log lines might leak under operator misconfiguration
(systemd stdout exposed). Mitigated by ops/systemd unit hardening (no
stdout-to-syslog by default).
**Gap:** None observed.

### I2 — Profile json_metadata reveals more than intended
**Surface:** Indexer /v1/profile
**Threat:** User sets json_metadata to include something they later regret;
chain history preserves it forever.
**Mitigation:** Documented in FAQ — chain is permanent, anything broadcast
becomes public forever. Frontend doesn't pre-populate metadata fields the
user didn't explicitly set.
**Residual risk:** Inherent in any chain-published profile. Not Morphit's
threat to mitigate.
**Gap:** None observed.

### I3 — Rate-limiter buckets leak who-is-active patterns
**Surface:** Relay
**Threat:** A side-channel observer measuring 429 response timing could
infer activity patterns by IP class.
**Mitigation:** Rate limiter buckets are in-memory only, never persisted,
never queryable from outside. Bucket keys are HMAC'd IPs (in invite tokens)
and bare IPs in the rate-limiter map (transient, GC'd).
**Residual risk:** Network observers can already see request volume; the
rate limiter doesn't add a new leak.
**Gap:** None observed.

### I4 — Chat metadata leaks even though ciphertext is encrypted
**Surface:** Chain / Indexer
**Threat:** Chat sender + recipient + timing are visible to any chain
observer. Pattern analysis can reveal social graph.
**Mitigation:** Documented in `docs/METADATA-LEAK-CATALOG.md`. The chat
encryption protects content; metadata is structurally public on Blurt.
Users who need metadata privacy should use Tor / out-of-band channels.
**Residual risk:** Inherent; documented; user-visible warning in chat
onboarding.
**Gap:** None observed.

### I5 — Operator-balance probe data could leak relay liquidity
**Surface:** Relay /v1/health
**Threat:** External observer polls health endpoint, learns when the
relay is low on funds, times an attack to coincide.
**Mitigation:** Verbose health gated by `verboseHealth` config knob —
operator can disable. Default ON for canonical instance because operators
need monitoring; community operators in adversarial contexts can flip
it off.
**Residual risk:** Verbose-on operators leak liquidity signal. Documented
trade-off.
**Gap:** None observed.

────────────────────────────────────────────────────────────────────────

## Denial of service

### D1 — Indexer storage exhaustion via huge custom_json payloads
**Surface:** Indexer DB
**Threat:** Attacker broadcasts max-size `custom_json` ops repeatedly to
fill DB.
**Mitigation:**
- Every JSONB-receiving handler has size cap via `checkJsonbSize` (4 KB
  general, 8 KB profile)
- Chain-level custom_json size cap (~8 KB) provides an upstream bound
- Per-account chain RC budget caps how many ops one attacker can post
**Residual risk:** Botnet of accounts could collectively spam, but each
account costs 100 BLURT (chain account_creation_fee) — economic floor.
**Gap:** None observed.

### D2 — Relay BLURT depletion via signup spam
**Surface:** Relay
**Threat:** Attacker exhausts the relay's BLURT balance by triggering
account_create requests up to the relay's funding limit.
**Mitigation (multi-layer "drain defense stack" per OPERATIONS.md §18):**
- Layer 1: Per-IP burst limiter (5/hour default)
- Layer 2: Per-IP daily limiter (2/day default, with spacing)
- Layer 3: Global daily ceiling (50/day default, atomic via tryReserve)
- Layer 4: Invite-token gate (HMAC-signed, IP-bound, 10-min TTL,
  single-use)
- Layer 5: ALTCHA proof-of-work after Nth invite/day per IP
- Layer 6: Kill-switch (env + file sentinel) for incident response
- Layer 7: Anomaly probe — indexer-side scanner correlates LOW_BALANCE
  alert with peak-hour signup spike, recommends kill-switch toggle
**Residual risk:** A determined botnet with thousands of fresh IPs and
ALTCHA-solving capability could still hit the daily ceiling. After that,
the kill-switch and operator alert close the loop.
**Gap:** None observed.

### D3 — Indexer poller starvation via slow Blurt RPC
**Surface:** Indexer chain reader
**Threat:** All configured Blurt RPC endpoints become slow/unavailable.
**Mitigation:** Multi-endpoint rotation in indexer config; staleLag-
threshold detection flips /v1/health to stale=true; circuit breakers
on BTC/XMR explorers (separate but same pattern).
**Residual risk:** All endpoints down simultaneously means no chain progress.
Recovery is automatic when any endpoint comes back.
**Gap:** None observed.

### D4 — Memory amplification via dailyInviteCounts map
**Surface:** Relay
**Threat:** Botnet floods invite endpoint with millions of distinct IPs;
the per-IP-per-day map grows unbounded.
**Mitigation:** MAX_DAILY_TRACKED_IPS=100k cap with FIFO eviction
(audit finding 16-B1 already shipped). Worst case: ~5 MB memory.
**Residual risk:** None observed.
**Gap:** None observed.

### D5 — Frontend rendering DoS via crafted price_model
**Surface:** Frontend orderbook UI
**Threat:** Attacker posts an order with deeply-nested price_model that
crashes the renderer.
**Mitigation:**
- Indexer enforces 4 KB JSONB cap on price_model
- Order handler shape-validates known kinds (`spread`, `fixed`); unknown
  kinds pass through but the frontend's priceModelDisplay falls back to
  "Custom price" string rather than recursively rendering
**Residual risk:** A truly novel kind with deeply-nested unknown shape
could still confuse renderers. Mitigation: priceModelDisplay treats
non-recognized shapes as opaque, never recurses.
**Gap:** None observed.

────────────────────────────────────────────────────────────────────────

## Elevation of privilege

### E1 — User claims operator privileges via display_name
**Surface:** Frontend rendering
**Threat:** A user sets display_name="Morphit Operator" or similar to
look authoritative.
**Mitigation:** display_name is just a free-text string with the hardening
described in S3. The frontend never grants privileges based on it. The
Verified Chat Badge (real verification) is computed deterministically from
chain history, not from user-claimed strings.
**Residual risk:** None observed.
**Gap:** None observed.

### E2 — Sock-puppet attestor self-promotes order to verified
**Surface:** Indexer fee verification fallback
**Threat:** Order author creates two sock accounts, has them attest each
other's orders to flip fee_status='pending_external' →
'verified_by_attestation', bypassing fee payment.
**Mitigation (ADR-0011 §3 + Finding I):**
- ≥2 distinct attestors required
- ≥1 must be NOT-the-poster
- Each attestor must pass eligibility gate (loyalty + age, phase-aware)
- All checked in the handler before quorum logic
**Residual risk:** A long-running attacker could grow accounts to meet the
eligibility thresholds, but the cost (account creation fee × 2 + months
of activity) exceeds the benefit (waiving a single 60-BLURT listing fee).
**Gap:** None observed.

### E3 — User flips operator-block list on someone else's instance
**Surface:** Indexer operator-block handler
**Threat:** Attacker broadcasts `morphit_operator_block_v1` claiming to be
an operator, blocks legitimate users.
**Mitigation:** Handler rejects unless ctx.signer === operatorAccountName
(B3 fix — was officialAccountName, now per-instance).
**Residual risk:** None — each instance accepts only its own operator's
ops.
**Gap:** None observed (post-B3 fix).

### E4 — Tag squatting via operatorRegister
**Surface:** Indexer operatorRegister handler
**Threat:** Attacker pre-registers `morphit`, `agorise`, etc. tags before
legitimate operators.
**Mitigation:**
- isReservedTag check (P6-3 fix)
- Tag-pattern restricts to `[a-z0-9._-]+` (no homographs)
- Tag is immutable post-registration (one-shot per account)
**Residual risk:** New reserved names not yet in the table. Mitigation:
the table is updatable; ADR amendment process documented.
**Gap:** None observed.

────────────────────────────────────────────────────────────────────────

## Summary

24 STRIDE rows examined across the four primary surfaces. **All have
mitigations in place; no open gaps observed.** Three findings discovered
during this audit pass (B1 waiver-replace bypass, B3 operator-account
gate conflation, C2 IP-extraction parseXff edge case) were closed as
part of this same session.

The most security-critical surfaces (relay account creation, indexer
fee verification, profile json_metadata rendering) all have layered
defenses with explicit test coverage on the trust boundaries.

────────────────────────────────────────────────────────────────────────

## Part 88 refresh — post-Part-29 attack surfaces (2026-05-08)

The matrix above (S1–E4) was generated Part 29 against four primary
surfaces.  Substantial new attack surface has shipped since.  This
section appends STRIDE rows for surfaces introduced or substantively
expanded between Part 30 and Part 87.

**Scope of this refresh:**
1. Desktop QR-pairing (ADR-0022, Part 30, brag-list entry on IPv6 prefix bucketing was dropped during a slim pass; defense lives in apps/relay/src/middleware/ip.ts)
2. Operator-payout automation (Part-47 era)
3. Kill-switch middleware (Part 47)
4. Layer 7-8 squatter defenses — Altcha PoW + RESERVED_NAMES +
   DICTIONARY_BRANDS + global daily ceiling persistence
5. Asset-registry runtime-immutable canonical list (brag-list entry on CSP-header inheritance was dropped during a slim pass; defense lives in nginx config + apps/web hooks.ts CSP middleware)
6. Witness fee delta-alert pipeline (brag #221)
7. IPv6 prefix bucketing at relay (brag-list entry on IPv6 prefix bucketing was dropped during a slim pass; defense lives in apps/relay/src/middleware/ip.ts)
8. CSP-header inheritance fix at nginx (brag-list entry on CSP-header inheritance was dropped during a slim pass; defense lives in nginx config + apps/web hooks.ts CSP middleware)
9. Build manifest + on-chain `morphit_release_v1` reproducibility
   (brag #222)
10. CI gate posture post-Part-87 (lint pipeline + workspaces test job)

────────────────────────────────────────────────────────────────────────

## Spoofing — refresh

### S5 — Phone-side QR-pairing signature replayed against chain ops
**Surface:** Frontend / Indexer / Phone signer
**Threat:** Attacker captures the user's signed pairing bundle in
transit (e.g., compromised operator relay, MITM on phone-to-operator
hop) and tries to replay the signature against an unrelated chain
operation — recovering the account's posting authority via a
phishing-flow that induced the user to sign a pairing request.
**Mitigation:**
- **Domain separation in the signing digest:**
  `SHA-256("morphit-pairing-v1\n" || canonical_bundle_bytes)` per
  ADR-0022.  The literal prefix `"morphit-pairing-v1\n"` is NOT a
  valid prefix for any chain transaction signing input (which uses
  Blurt's `chain_id || serialized_tx`).  A captured pairing
  signature decodes against the pairing digest and would fail
  verification against any chain-tx digest.  Verified at
  `apps/web/src/lib/auth/pairingClient.ts` and
  `apps/indexer/src/api/loginPairing.ts`.
- **Fresh nonce per pairing attempt:** desktop generates a fresh
  random nonce per request; phone refuses to sign a bundle whose
  nonce it has signed before (replay window).
- **Echo-check round trip:** desktop verifies the returned bundle
  matches the request's nonce + URL + display name before accepting.
**Residual risk:** Phone signs a pairing bundle for the wrong
website (`morph1t.io` phishing).  Mitigated by phone showing the
URL with explicit `dir="ltr"` (RTL-override homoglyph defense from
ADR-0022) and a "is this the site you intended?" confirmation card;
not eliminated — user may tap through.  Recommended UX: future
phone app could pin known-good origins.  Filed in REVISIT-LIST.
**Open gaps:** none structural.

### S6 — Operator-payout sender impersonates @morphit-fees in payout broadcast
**Surface:** Relay / Chain
**Threat:** Attacker compromises an operator's relay (or its host),
broadcasts a transfer FROM `@morphit-fees` (the treasury account)
TO an attacker address using the relay's posting key — claiming
"payout to operator" while actually draining the treasury.
**Mitigation:**
- **Relay holds the OPERATOR's active key, NOT @morphit-fees's
  active key.**  The treasury account's keys live with the
  project team, not with any operator's relay.  Verified at
  `apps/relay/src/queue/drainer.ts` lines 283–297: every queue
  row broadcasts with `from: this.config.relayAccount` +
  `fromActiveWif: this.config.relayActiveKeyWif` — both scoped
  to the operator's own account.
- **Operator-payout flow is queue-based**
  (`apps/indexer/src/indexer/operatorEarnings.ts`): when the
  indexer sees a BLURT listing-fee inflow, it computes the
  operator's 90/10 share, INSERTs a row into
  `relay_pending_transfers` with `reason = 'operator_payout:<trx_id>'`,
  and the relay drainer picks it up.  The relay's authority is
  scoped to broadcasting from the operator's own configured
  account — it has no key material that could spoof
  @morphit-fees.
- **Each operator's account is independently keyed** —
  compromise of one operator does not propagate to others or to
  the treasury.
**Residual risk:** Compromised operator can drain THEIR OWN
account.  This is the explicit operator-trust boundary — operators
take custody of their own balance, project takes custody of
@morphit-fees.  Documented in `docs/OPERATOR-TRUST-DESIGN.md`.
**Open gaps:** none.

### S7 — Witness-fee alert spoofed by malicious chain RPC
**Surface:** Indexer / Chain RPC
**Threat:** Attacker controls the operator's RPC endpoint (or
intercepts unencrypted RPC traffic — though chain RPC is
TLS-protected) and feeds the witness-fee poller a fake
`account_creation_fee` value, triggering a `FEE_CHANGED` alert
with attacker-chosen old/new values.  Operator panic-reacts by
broadcasting a corrective chain op or notifying users incorrectly.
**Mitigation:**
- **callMany chain rotator** — the indexer's RPC layer
  (`apps/indexer/src/rpc/rotator.ts`) requires quorum across N
  endpoints before accepting a chain-fact answer (S2 / 2-7 / 2-8
  audit fixes).  A single malicious endpoint cannot poison the
  fee-poller's reading.
- **Alert is INFORMATIONAL** — operator is told a fee changed,
  not directed to take any specific action.  Operators with
  Discord/Matrix bot integrations get rich delta context to make
  their own judgment.  No automatic chain broadcast triggered.
**Residual risk:** If quorum-many endpoints simultaneously lie
(e.g., Sybil attack against the RPC pool), the alert reflects a
false fee.  Chain RPC pools used in practice are operated by
distinct organizations; a coordinated lie across all of them is
very high-cost.
**Open gaps:** none structural.  The operator-judgment-required
disposition is intentional.

────────────────────────────────────────────────────────────────────────

## Tampering — refresh

### T5 — Tampering with asset-registry at runtime
**Surface:** Indexer / Frontend (in-memory)
**Threat:** Code somewhere in the binary mutates `ASSETS` or
`ASSET_TICKERS_SET` (e.g., via `(asset_registry as any).ASSETS.push(...)`)
to inject a fake ticker or override BTC's address regex with a
permissive one — bypassing the canonical-list invariant that
every asset trade is constrained to known-valid types.
**Mitigation:**
- **`Object.freeze` deep on `ASSETS`** — every entry's prototype
  is frozen, so `.push()`, `.length=`, property reassignment all
  throw in strict mode.
- **`Proxy` trap on `ASSET_TICKERS_SET`** — `add`/`delete`/`clear`
  trap and throw with a clear error referencing the package.
- **`packages/asset-registry/scripts/asset-registry-smoke.ts`**
  runtime-asserts the invariants in CI: exactly one coordination
  chain (Blurt), no duplicate tickers, every entry has all
  required fields, address-shape regex accepts known-valid
  addresses and rejects obvious typos, runtime mutation throws.
- **Canonical-list import enforced at every consumer site** —
  any new asset reference goes through the registry, no string
  literals scattered.
**Residual risk:** A compiled-out non-strict-mode shim could
silently swallow the freeze throw.  Mitigated by the build
pipeline always emitting strict-mode JS (vite default + `"use
strict"` at top of every TS file post-bundle).  Not zero — a
compromised build host could in principle disable strict mode.
That's the wider build-tampering threat covered by S1 / brag
#215 reproducibility.
**Open gaps:** none.

### T6 — Tampering with kill-switch state file
**Surface:** Relay
**Threat:** Attacker with file-system write access to the relay's
host flips the kill-switch state file from "off" to "on", bricking
the relay (so legitimate users see a lockout) — OR flips it from
"on" to "off" during a planned downtime, restoring service the
operator had intentionally killed.
**Mitigation:**
- **File-system access IS root-equivalent** for the relay's
  process — once an attacker can write the kill-switch file, they
  can also exfiltrate the relay's posting key envelope, restart
  the process with poisoned config, etc.  The kill-switch is not
  the weakest link in the host-compromise scenario; it is one of
  several capabilities the attacker would have anyway.
- **Audit trail in structured logs** — every kill-switch flip
  emits a `kill_switch_activated` or `kill_switch_deactivated`
  log line with timestamp.  An operator routinely reading their
  access-log can detect tampering after the fact.
**Residual risk:** No cryptographic protection on the kill-switch
state itself.  Acceptable because the threat model explicitly
trusts the operator's host (the project posture is "operators
take custody of their own infrastructure").  Filed: future
hardening could sign the state file with the operator's posting
key, but this trades complexity for value-at-risk that's already
covered by host-level access control.
**Open gaps:** none in current threat model.

### T7 — Tampering with on-chain `morphit_release_v1` to point at hostile bundles
**Surface:** Frontend integrity / Chain
**Threat:** Existing S1 row covered the spoofing dimension
(attacker-published release op).  This row covers the tampering
dimension: an attacker who legitimately controls the @morphit
posting key (e.g., a future maintainer who turns hostile) could
broadcast a malicious release op pointing to attacker-controlled
JS bundle hashes — and users' frontends would fetch and execute
those bundles after the next release-poll cycle.
**Mitigation:**
- **TOFU posting-key pin (S2 fix)** — the indexer's
  `release.ts` handler validates the signer's posting pubkey
  against a chain-anchored quorum before pinning.  A forked-chain
  injection cannot succeed.  However, this does not protect
  against the legitimate @morphit posting key being misused.
- **Build-from-source path is documented** — README §Build from
  source explicitly directs paranoid operators / users to clone
  the repo, build locally, and pin their own.  The whole point of
  AGPL-3.0 + `npm run build:manifest` reproducibility (brag #222)
  is that any user can verify "the bytes I'm running match the
  bytes I see in the repo at this commit."
- **Multi-eyes review of any release** — pre-launch, releases
  go through PR review on Forgejo before the @morphit posting key
  signs them.  This is process-not-code.
**Residual risk:** If the @morphit posting key is compromised,
the protocol cannot prevent a hostile release op.  Recovery path:
the project broadcasts a corrective release op from a recovered
account; users' frontends update on the next poll.  Net window of
exposure: typical release-poll interval (15 minutes — the
"why-15-minutes" justification carries through).
**Open gaps:** Threshold-multisig for the @morphit posting key
would eliminate the single-key-compromise scenario.  Filed in
REVISIT-LIST as long-term hardening.

────────────────────────────────────────────────────────────────────────

## Repudiation — refresh

### R3 — Operator denies they enabled the kill switch during user lockout
**Surface:** Relay
**Threat:** Operator flips kill-switch ON during a user's chain
broadcast, the broadcast fails, user complains.  Operator denies
ever flipping the switch.
**Mitigation:**
- **Structured `kill_switch_activated` / `kill_switch_deactivated`
  logs** with timestamp.
- **Operator-trust posture explicitly says "operators run their
  own instance"** — users dissatisfied with one operator's
  handling can move to a different operator (federation premise).
  No global trust requirement.
- **`docs/OPERATOR-TRUST-DESIGN.md`** documents the contract:
  operators are not custodians, they are facilitators; their
  failure modes are captured by federation choice, not by appeal.
**Residual risk:** A user who only ever uses one operator's
instance has no out-of-band record.  This is by design — the
project does not collect or attest user activity.
**Open gaps:** none in threat model.

### R4 — User repudiates a phone-signed pairing
**Surface:** Phone signer
**Threat:** User signs a pairing bundle, later denies it
("someone else used my phone").
**Mitigation:**
- **Pairing signs with the user's posting key** — same key that
  signs every chain op, so denial of one signature is denial of
  all signatures from that account.
- **Confirmation card displayed before signing** — explicit
  user gesture required.
- **Single-use / nonce-bound** — pairing signature cannot be
  retroactively claimed for a different desktop session.
**Residual risk:** Standard "stolen device" scenario applies —
mitigated by phone OS lock + Morphit's per-app password gate
(active-key wipe on lock per K1.2).
**Open gaps:** none.

### R5 — Operator repudiates a canary going stale
**Surface:** Frontend (operator transparency mechanism)
**Threat:** Operator's `/canary.txt` becomes stale (operator
fails to regenerate within the documented 14-day silence
window).  Operator later claims they DID regenerate and the
staleness was a publishing-pipeline bug.
**Mitigation:**
- **Canary template structure forces explicit declaration** —
  `apps/web/static/canary.txt.template` enumerates each
  warrant-canary clause (NSL, FISA, gag order, backdoor demand,
  IP-logging demand) so the operator can't claim "I forgot what
  the canary covered."
- **Generator + template drift caught by canary-template-smoke** —
  template changes that don't match the generator's substitution
  set fail CI.  A "I changed the template but forgot to update
  the generator" defense is closed.
- **Documented 14-day silence-implies-tripped window** — the
  template itself tells the reader "if more than 14 days old,
  treat as silent."  The operator can't redefine the silence
  semantics after the fact.
- **`scripts/canary/verify.ts`** for clients/auditors to
  programmatically check freshness + structural integrity.
**Residual risk:** Operator publishes a stale canary AND lies
about regenerating.  External auditors comparing the
`Generated` timestamp on canary fetches across time can detect
this; users can't from a single fetch.
**Open gaps:** none in current design.  Future: canary could be
signed by the operator's posting key with the timestamp included
in the signed payload, so a forged "I regenerated yesterday"
claim is provably false.  Filed as REVISIT-LIST hardening.

────────────────────────────────────────────────────────────────────────

## Information disclosure — refresh

### I6 — QR-pairing leaks pairing bundle to operator's relay
**Surface:** Indexer (operator's loginPairing endpoint)
**Threat:** The pairing bundle transits the operator's `loginPairing`
endpoint as ciphertext — but the operator could log enough metadata
(timestamps, source IPs, account names) to correlate "user X
authenticated to desktop Y at time T" even without decrypting.
**Mitigation:**
- **Bundle payload encrypted with desktop's ephemeral pubkey** —
  operator sees only ciphertext + routing metadata (account,
  nonce, timestamp).
- **Operator can log timestamps/IPs anyway** — this is the
  baseline operator-trust posture.  Pairing doesn't worsen it.
- **Privacy-preserving operator defaults** — the project's
  recommended operator config does NOT log IPs by default
  (per the brag-list privacy principles).  Compliant operators
  can independently audit their own log retention.
**Residual risk:** Hostile operator chooses to log everything.
The user's mitigation is operator choice (federation).
**Open gaps:** none — operator-trust boundary is explicit.

### I7 — Witness-fee alerts shape leaks operator's polling cadence to RPC providers
**Surface:** Indexer
**Threat:** Operator's chain-RPC provider can profile the
operator's instance based on `account_creation_fee` query
patterns — frequency, timing, source IP.
**Mitigation:**
- **Polling is hourly, low-volume** — does not stand out
  against any operator running an indexer + relay (which polls
  the chain dozens of times per minute for blocks).
- **The query itself is unauthenticated** — anyone running a
  Blurt indexer queries this; no special signature.
- **callMany rotator distributes queries across multiple RPC
  endpoints** — no single endpoint sees the full pattern.
**Residual risk:** Aggregate side-channel from cooperating RPC
providers.  Mitigated by the operator running their own RPC
node (documented as recommended for high-volume operators).
**Open gaps:** none structural.

### I8 — IPv6 prefix bucketing reveals which IPv6 buckets are "active" via rate-limit responses
**Surface:** Relay
**Threat:** An attacker sending requests from many /64 buckets
within a /48 can probe rate-limit responses to learn which
neighbors are recently active (since shared rate-limit slots
hint at concurrent activity).
**Mitigation:**
- **Rate-limit responses are uniform** (`429` with no
  per-bucket detail) — attacker learns "this bucket has been
  rate-limited" but not who else is in it.
- **/64 buckets are ALREADY a huge amount of address space** —
  even profiling at the /64 granularity gives the attacker no
  individual-user resolution.
- **Buckets expire** (per the rate-limiter's TTL window) — an
  attacker would have to keep probing to maintain the picture.
**Residual risk:** Aggregate "this whole /48 has been busy"
inference.  Acceptable under the threat model — IP-level
metadata is not what Morphit promises to protect.  Tor / I2P /
Lokinet operator paths are the privacy-preserving alternative.
**Open gaps:** none.

────────────────────────────────────────────────────────────────────────

## Denial of service — refresh

### D6 — Squatter farms exhaust the global daily ceiling
**Surface:** Relay (signup)
**Threat:** A squatter operates many residential IPs, each making
account-creation requests in tight succession.  The global daily
ceiling fires and blocks LEGITIMATE users from creating accounts
for the rest of the day, creating a denial-of-service against
real users.
**Mitigation (layered):**
- **Altcha PoW** from the second invite onward (`squatter-defense`
  layer 8) — increases the per-account compute cost for an
  attacker, raising the cost of farming.
- **`RESERVED_NAMES` + `DICTIONARY_BRANDS` deny-list** — bulk
  brand grabs hit the deny-list before consuming a ceiling slot.
- **IPv6 /64 + IPv4 /24 prefix bucketing** at the rate limiter —
  a /48 attacker can't trivially evade with sub-prefix rotation.
- **Global daily ceiling persists across relay restarts**
  (audit fix 5-4) — restart-evade attack closed.
- **Sequential-name detector** flags numeric-suffix farms and
  raises Altcha difficulty per match.
- **OPERATIONS §38 diamond-hardened preset** documents the
  squatter-resistance trade-off operators can opt into (5-char
  minimum names, Altcha from second invite, 90-minute spacing,
  ceiling 20, 24-hour window).
**Residual risk:** A determined attacker with sufficient compute
+ unique IPs CAN exhaust the ceiling.  This is the "absorb-and-
contain" posture: the ceiling LIMITS damage, doesn't ELIMINATE
it.  When the ceiling is exhausted, legitimate users see a
clear message and can try again the next day, or pick a
different operator (federation premise).
**Open gaps:** none — this is a fundamental cost-of-attack
trade-off, not a defect.

### D7 — Build manifest computation as DoS
**Surface:** Frontend integrity (CI / operator host)
**Threat:** An attacker submits a PR that pads the build output
with millions of tiny files — `npm run build:manifest` recurses
the build directory and the manifest computation becomes
expensive (slow CI, host disk I/O).
**Mitigation:**
- **`apps/web/scripts/build-manifest.mjs`** is a single sorted
  walk; runtime is O(N log N) on file count.
- **Bundle size check** — `find build/_app -type f -name '*.js'
  -exec cat {} + | wc -c` warns if total JS exceeds 500KB
  (Phase-1 budget ~100KB gzipped) — would be tripped before a
  malicious PR's bloat reached pathological scale.
- **Pre-launch: PR review is the gate** — any PR adding
  thousands of files is rejected at review.
**Residual risk:** A subtle PR adds many medium-size files
just below the bundle-size warning.  Caught by manual review.
**Open gaps:** none material.

────────────────────────────────────────────────────────────────────────

## Elevation of privilege — refresh

### E5 — Sock-puppet desktop pairs as a different account
**Surface:** Phone signer / Indexer
**Threat:** Desktop initiates a pairing as account A; attacker
intercepts the QR display, swaps in their own pairing nonce, and
gets the user's phone to sign account A's signature for the
attacker's desktop.  Attacker's desktop is now signed in as A.
**Mitigation:**
- **Bundle bound to desktop's ephemeral pubkey** — the
  encrypted permission slip is decryptable ONLY by the desktop
  whose pubkey was in the QR.  An attacker who swapped the QR
  has a different desktop pubkey; the phone's signed bundle
  decrypts to nothing useful for them.
- **URL/origin in the confirmation card** — phone displays the
  origin the desktop is at; if the user expects `morphit.io` and
  sees `attacker.example`, they can refuse.
- **One-time nonce + freshness window** — even if the attacker
  somehow captured the bundle, they can't replay it.
**Residual risk:** Attacker controls the user's network and
shows a phishing origin that the user mistakes for legitimate
(e.g., punycode homoglyphs).  RTL-override homoglyph attack is
explicitly mitigated by `dir="ltr"` rendering; other homoglyphs
are user-judgment-required.
**Open gaps:** Future: phone-app could pin a list of known-good
origins.  Filed.

### E6 — Operator-payout drainer rate-limit bypass
**Surface:** Relay
**Threat:** An operator's relay accepts payout-broadcast tasks
faster than the rate-limiter expects, causing the relay to drain
funds from the operator's account at a rate the operator didn't
authorize (e.g., an attacker who can submit payout tasks
floods the queue).
**Mitigation:**
- **Payout queue is operator-authoritative** — only the
  operator's own relay submits payout tasks.  External submission
  is not exposed via any public endpoint.  Verified at
  `apps/relay/src/queue/drainer.ts`.
- **Operator-balance scanner / low-balance alert** — operator
  is notified before the account is drained, with structured
  log at `low_balance` warn level.
- **Drain-defense smoke** + **drainer-defense-smoke** +
  **drain-defense-live-fire** all exercise the queue under
  adversarial conditions in CI.
**Residual risk:** Operator misconfigures the payout schedule
(too aggressive).  Operator-judgment-required, documented in
RUN-A-MORPHIT-NODE.md and OPERATIONS.md §payouts.
**Open gaps:** none.

### E7 — CI gate bypass via branch-protection misconfiguration
**Surface:** Build / CI
**Threat:** A maintainer with merge access pushes directly to
`main` bypassing the PR review process and the four CI jobs (web,
typecheck-sweep, unit-tests, smokes, indexer-integration), shipping
unaudited code to the @morphit release pipeline.
**Mitigation:**
- **Forgejo branch protection on `main`** — pre-launch posture
  documented in CONTRIBUTING.md is "PRs only, all checks must
  pass."
- **CI status visible publicly** — a release at a commit that
  doesn't have green CI is a visible anomaly anyone can detect.
- **`npm run build:manifest` reproducibility** — even if a
  hostile commit lands, users running `build:manifest` against
  their own clone get a divergent hash.  The on-chain release op
  would still hash to the hostile bundle, but a paranoid user
  can detect the divergence.
- **Multi-eyes review** is process-not-code; the project doesn't
  enforce two-reviewer-required at the chain level.
**Residual risk:** Single hostile maintainer with merge access.
Same single-key-compromise scenario as T7 — recovery is corrective
release op + key rotation.
**Open gaps:** Threshold-multisig at the release-signing layer
would eliminate this class.  Filed (with T7).

────────────────────────────────────────────────────────────────────────

## Part 88 refresh summary

**17 new STRIDE rows** added across the six categories
(S5–S7, T5–T7, R3–R5, I6–I8, D6–D7, E5–E7).  Combined with the
24 rows from the original Part 29 matrix, the matrix now covers
**41 threat scenarios** across the post-Part-87 codebase.

**Net new findings during this refresh: zero.**  Every threat
analyzed has existing mitigations that were verified in code.
Three residual-risk areas surfaced that are explicitly accepted
by the project's threat model:

1. **Single-key compromise of @morphit's posting key** (T7 / E7) —
   recovery via corrective release op; future hardening is
   threshold-multisig.  Filed in REVISIT-LIST.
2. **Phishing-origin homoglyphs other than RTL-override** (S5 / E5) —
   user-judgment-required; future hardening is phone-app
   origin-pinning.  Filed.
3. **Operator-host compromise** (T6, R3) — explicit operator-trust
   boundary; mitigation is federation choice, not technical
   countermeasure.

**No open gaps blocking pre-launch.**  The threat model is in a
state where every credible attacker behavior has either an
in-code mitigation or an explicitly-accepted residual.  Filed
items are long-term hardening, not pre-launch blockers.
