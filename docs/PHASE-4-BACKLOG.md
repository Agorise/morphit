# Phase 4 backlog

Items captured during the Phase 3 closeout that are deliberately
deferred. This is NOT a plan — it's the raw working list for
Phase 4 design discussion. Each item includes rough scope and
any open design questions so we can prioritise cleanly.

> **2026-05-11 forward note (Part 120 audit):** This backlog
> dates from Phase 3 closeout.  Most items have since shipped
> via specific ADRs or sub-phases:
>
> - Item 1 (operator incentives) → **ADR-0013 ✅ shipped 2026-05-02**.
> - Item 2 (key custody) → **ADR-0010 ✅ accepted + implemented**.
> - Item 3 (PWA + notifications) → **Phases 1, 2, 4 ✅ shipped;
>   Phase 3 (Web Push tab-closed) deferred**.  See
>   NOTIFICATIONS-DESIGN.md for status.
> - Item 5 (blog integration) — profile pages + blog cross-post
>   + follow flows all shipped under SYNDICATION-CHECKPOINT.md.
> - Item 7 (Klingex price provider) → ✅ shipped; composite
>   price source `Klingex → Coingecko → static_floor`.
> - Item 8 (featured-slot auction) → ✅ shipped via
>   `apps/indexer/src/indexer/handlers/featureBid.ts`.
> - Item 9 (chat + feedback + reputation) → ✅ shipped under
>   ADR-0015 + Phase 5d.  See CHAT-CRYPTO.md, CHAT-UI-DESIGN.md.
>
> Items still open or only partially shipped: integration test
> harness (item 6 → design at INTEGRATION-TEST-HARNESS-DESIGN.md,
> implementation pending) and self-hosted third-party
> dependencies (item 4 → still open).
>
> This file is preserved as a historical backlog snapshot; current
> backlog is in REVISIT-LIST.md and PHASE-5-BACKLOG.md.

---

## 1. Third-party node operator incentives

**Idea (from project owner):** Financially incentivize people to
run their own Morphit VPS + indexer + relay by giving them a
fee-split on transactions that happen through their frontend.
One-time $50 upfront fee to prevent throwaway operators, then a
recurring BLURT-denominated cut of fees from orders posted via
their instance.

**Open questions for phase 4 design:**
- How does an indexer identify which frontend a user came from?
  The fee transfer memo is `morphit-fee:<permlink>` — there's no
  operator tag. Would need a new memo format or a referrer
  field in the `morphit_order_v1` payload.
- Fee split mechanics: who pays out? Automated on-chain? Monthly
  manual distribution? Each has tradeoffs.
- How do we prove "orders that happen on operator X's server"
  vs. "orders that happen anywhere but were signed while
  someone was viewing X's frontend"? The latter is unverifiable.
- What exactly is the $50 upfront fee for? Registration into
  some registry of verified operators? Trust proxy? This affects
  the design.

**Deliverable for this item includes a sales-pitch FAQ entry**
(working title: "How can I help in making Morphit unstoppable?").
That ties to the broader decentralization narrative and is worth
landing alongside whatever mechanism we pick.

---

## 2. Key-custody security design

**Context:** The Morphit organisation operates at least three
Blurt accounts — `@morphit` (release announcements),
`@morphit-relay` (creates user accounts), `@morphit-fees`
(receives listing fees). Any online active-key storage is a
honeypot.

**Proposal to be written as an ADR:**
- **Voucher-based account creation.** Pre-purchase account
  creation vouchers from the Blurt chain in batches. The relay
  redeems vouchers instead of signing `account_create` ops.
  **Net effect: the relay never needs the `@morphit-relay`
  active key online.** This is the biggest security win on the
  table.
- **Owner keys: paper-only, air-gapped.** Always. No exceptions.
  Key rotation requires physical access to the paper backup.
- **Remaining online keys (release-signer at most):**
  passphrase-at-boot, held in memory only, re-entered on every
  service restart. Never stored on disk in any form —
  "super-encrypted" storage adds complexity without adding
  security if the decryption key lives on the same machine.
- **HSM option for the release-signer key** if we ever need
  24/7 automated release publishing (unlikely — releases are
  infrequent human-initiated events).

**Deliverable:** ADR-0010 on key custody, rewrite of any code
that currently assumes an online active key.

---

## 3. Installable PWA + notifications

**Scope:**
- `manifest.webmanifest` for installability on Windows/Mac/Linux
  (desktop Chromium) and mobile Android
- Service worker for offline shell caching and notification
  delivery
- Web `Notification` API for "your offer was accepted" alerts,
  gated on user opt-in
- Audible alert with user-selected sound (browser autoplay
  policy means the sound needs a prior user gesture to register
  — usually granting notification permission counts)
- Optional email notification path — this requires a mail-send
  infrastructure (we don't have one), so probably deferred
  further to Phase 5

**Open questions:**
- iOS Safari's PWA story is weaker — full feature parity is
  unlikely. Acceptable to ship Chromium-first?
- What triggers a notification? The frontend can't run when the
  page is closed (service worker can, but needs a push source).
  The indexer would need to push events — probably over Web
  Push with a VAPID key pair. Another honeypot concern (VAPID
  private key on the indexer server).

---

## 4. Self-hosted third-party dependencies

**Concern:** Morphit currently depends on npm-hosted packages:
`dblurt`, `@noble/secp256k1`, `@scure/bip39`,
`libsodium-wrappers-sumo`. An npm registry outage or
compromise would break `npm install`.

**Options:**
- Vendor critical packages into `packages/vendored/` with
  upstream hashes pinned
- Run a Verdaccio/npm-mirror on morphit infrastructure
- Fork the critical packages into the agorise org on
  git.agorise.net so we can build from source without touching npm

**Tradeoffs:**
- Vendoring means we take on maintenance of security updates
- A mirror is infrastructure burden
- Forking gives us control but requires tracking upstream
- `dblurt` is already a community fork (@beblurt maintains); a
  further Morphit fork would create drift

**Deliverable:** ADR-0011 on dependency independence strategy.

---

## 5. Blog integration — social link + cross-posting

**5a — Blog link on profiles (small).** Every Morphit profile
page (to be built) includes an external icon-link to
`https://blurt.blog/@<account>/posts`. Opens in a new tab.

**5b — Cross-post new offers to blurt.blog (medium).** When a
user posts an order, offer a checkbox "Also publish this as a
Blurt post so my followers see it." This requires:
- A generated PNG thumbnail with the Morphit logo and the
  offer's key fields (side/asset/range/fiat). Server-side image
  generation is straightforward; doing it fully client-side
  would need a canvas render that produces a deterministic
  image — doable.
- A `comment` op (Blurt's standard blog-post op) signed with
  the user's posting key, with the thumbnail embedded + a link
  back to the Morphit offer
- Compose-page UI for the opt-in toggle

**5c — Follow & notifications (medium-large).** Morphit users
can follow each other; when a followed user posts a new offer,
the follower gets notified:
- In-Morphit notification (requires the PWA notification
  infrastructure from item 3 above)
- On Blurt (via `custom_json` with id `follow`, which all Blurt
  frontends natively respect) — so a user who follows someone
  on Morphit ALSO appears as a follower in their beblurt.com /
  blurt.blog profile. Nice integration with the wider ecosystem.

**Dependency note:** 5b and 5c both need profile pages to exist
first. No profile-page route lives in Phase 3. Build order:
profile page → blog link → cross-post → follow.

---

## 6. Full block-replay integration tests

Inherited deferral from Phase 3c. Covered in
`docs/PHASE-3c-STATUS.md`. Not urgent; SQL-level integration
tests shipped in Phase 3c close the highest-risk gap.

---

## 7. Klingex price provider

Also deferred from Phase 3c. Both frontend and indexer use the
$0.002 BLURT fallback. Phase 4 priority because fees are mis-
computed when BLURT's real price drifts from the fallback.

---

## 8. Featured-slot auction

Deferred from Phase 3c scope (it was listed as optional in the
original Phase 3c spec). Would let users pay extra to pin their
order to the top of the orderbook for a time-limited window.

**Open questions:** Price discovery (floor + minimum increment
bid), display (subtle highlight vs. explicit "featured" label),
how long a featured slot lasts, what happens when multiple
orders are bid-tied.

---

## 9. Chat + feedback + reputation

Phase 4 in the original PLAN.md. Large. Includes:
- ECIES chat (X25519 + ChaCha20-Poly1305 with per-message
  sender ephemerals; one-sided forward secrecy by design — see
  ADR-0015)
- Feedback with trader/counterparty role attribution
- Reputation display that weighs in the self-trade signal flags
  from Phase 3c

---

## Priority ordering (updated after Phase 4 opener)

**Accepted ADRs driving Phase 4:**
- **ADR-0010 — Key custody.** Accepted. Implementation spans
  multiple turns within the Phase 4 opener sub-phases.
- **ADR-0011 — Dynamic fee model.** Accepted. Implementation
  structured into sub-phases 4a / 4b / 4c (see ADR-0011).

**Currently in progress — Phase 4 opener:**

1. **Sub-phase 4a — MVP indexer + relay changes** for key
   custody and dynamic fees. Includes:
   - Migration v4 (accounts columns, relay_pending_transfers,
     witness_fee_history)
   - Witness fee polling + dynamic listing fee + operator alert
   - First-order-free-for-BUY logic
   - Delayed welcome bonus trigger (on feedback = trade complete)
   - 1 BLURT dust at signup + low-balance auto-refill
   - ACT pre-minting script + passphrase-at-boot
   - nginx rate limits
2. **Sub-phase 4b — multi-asset fees.** Bitcoin + Monero fee
   verification. Depends on 4a.
3. **Sub-phase 4c — loyalty program.** Cumulative BLURT tracking
   + BP milestone rewards. Depends on 4a.

**Queued Phase 4 items after the ADR-0010/0011 implementation:**

4. **Klingex price provider** (item 7) — blocks the dynamic
   fee formula from being fully accurate (currently uses
   $0.002 BLURT fallback). Small.
5. **Profile page + blog link** (item 5a). Small; unlocks 5b/5c.
6. **6 FAQ entries** per the Phase 4 conversation:
   - "How can I help make Morphit unstoppable?" (operator
     recruitment, item 1)
   - "Why trading with yourself doesn't pay"
   - "Why multi-accounting doesn't pay"
   - "Is Morphit safe from attack?" (attack-vector disclosure)
   - "Why use BLURT on Morphit?" (BLURT benefits)
   - "How does Morphit protect my privacy?" (VPN/Tor, no
     fingerprinting)
7. **Morphit Blurt community creation.** One-time operational
   setup — Morphit creates a Blurt community where
   first-trade cross-posts land. Pre-launch task.
8. **Sprout (🌱) new-trader chip + pulse animation** for
   orderbook rows from users without completed trades. Small
   frontend turn.
9. **Cross-post flows** (item 5b/5c):
   - Post-first-trade cross-post to the Morphit community
   - Optional cross-post when user posts a new order
   - Follow/notifications (requires PWA from item 3)
10. **PWA + notifications** (item 3). Medium.
11. **Privacy/Terms update** to mention VPN/Tor friendliness +
    delayed-bonus anti-abuse posture. Small.
12. **Operator runbook** (`docs/OPERATIONS.md`). Written
    incrementally.

**Not yet scheduled:**

13. **Third-party node operator incentives** (item 1). Big
    design conversation required first.
14. **Block-replay integration tests** (item 6). Low priority.
15. **Featured-slot auction** (item 8).
16. **Dependency self-hosting** (item 4).
17. **Encrypted chat + counterparty reputation** (item 9). Own sub-phase.
