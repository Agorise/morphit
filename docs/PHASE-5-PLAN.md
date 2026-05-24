# Phase 5 — Plan

**Status:** Draft for review, pre-implementation
**Date:** 2026-04-19
**Depends on:** Phase 4 deployed, PHASE-5-BACKLOG.md,
ADR-0012 (cross-post), ADR-0013 (operator incentives),
ADR-0014 (chat + reputation) — all currently stubs awaiting
resolution of open questions.

> **2026-05-11 forward note (Part 120 audit):** Sub-phases
> 5a, 5b, and 5d have all shipped, much faster than the
> "summer 2026 / fall 2026 / winter 2026→2027" timeline
> projected below.  Specifically:
>
> - **Sub-phase 5a (ecosystem reach)** → ✅ shipped.  Cross-post
>   flow lives at SYNDICATION-CHECKPOINT.md (Post A + Post B
>   + ADR-0017 preview).  Real price feed (Klingex composite)
>   shipped.  Morphit Blurt community at `blurt-176570` is
>   live.
> - **Sub-phase 5b (operator incentives)** → ✅ shipped as
>   **ADR-0013** (accepted + implemented 2026-05-02).
>   Operator registration, tag claim, payout pipeline all in
>   place; per-order operator payouts active.
> - **Sub-phase 5c (encrypted chat + reputation)** → realised
>   as **Phase 5d** under ADR-0015 (not ADR-0014; the original
>   ADR-0014 forward-secrecy plan was replaced by simpler
>   per-message ECIES per ADR-0015).  See CHAT-CRYPTO.md +
>   CHAT-UI-DESIGN.md.  Shipped through Phase 5d.
>
> The original timeline projections at the end of this doc are
> historical; the actual sequencing was faster and the chat
> design shifted from forward-secrecy session protocols
> (ADR-0014) to stateless ECIES (ADR-0015).  This file is
> preserved as the historical plan; current state is reflected
> in REVISIT-LIST.md and the ADRs.

## Goals

Phase 5 is the **ecosystem reach + decentralization** phase.
Phase 4 built the economics (fees, loyalty, welcome bonus).
Phase 5 uses those economic primitives to grow Morphit beyond
the three committed operators into a self-sustaining network.

Three independent-but-related bodies of work, each ship-able
on its own:

1. **5a — Ecosystem reach.** User-facing features that push
   Morphit's presence out onto the Blurt social layer and
   into the daily lives of current users. Cross-post flow
   (ADR-0012), Morphit Blurt community, real price feed,
   Phase 4 loose ends.

2. **5b — Operator incentives.** The economic mechanism that
   rewards third-party node operators with a share of listing
   fees (ADR-0013). This is the structural change that
   unlocks decentralization.

3. **5c — Encrypted chat + reputation.** End-to-end encrypted
   counterparty chat replacing the current in-memory bridge
   (ADR-0014). The biggest feature in Phase 5; probably its
   own release.

Each of these has its own design doc to come
(`PHASE-5a-DESIGN.md` etc.) once the relevant ADR(s) land in
Accepted state. This plan document is the phase-level index
and sequencing view.

## Non-goals (explicitly out of Phase 5)

Carried from PHASE-5-BACKLOG.md:

- **No blockchain beyond Blurt.** Not adding Ethereum, Solana,
  or any other chain.
- **No custody, no escrow.** P2P stays P2P.
- **No KYC.** Ever, per ADR-0001.
- **No mobile native apps.** SvelteKit frontend on mobile web
  is the mobile story.
- **No in-protocol dispute resolution.** Reputation is
  chain-tracked; Morphit does not arbitrate.

Additional non-goals specific to Phase 5:

- **No paid promotion.** Cross-post flow reaches users via
  organic content only. No ads, no sponsored slots outside
  the featured-slot auction (which is a backlog item
  deferred past Phase 5's initial scope).
- **No governance infrastructure.** Operator fee-split
  percentages, policy decisions, and tag-revocation rules
  remain Agorise-set in Phase 5. A governance token or
  DAO structure is out of scope.
- **No migration to a new indexer storage layer.** Postgres
  stays. No Redis, no ClickHouse, no distributed anything.

## Sub-phase 5a — Ecosystem reach

**Scope:** frontend + Blurt-side work that increases Morphit's
visibility and closes UX gaps from Phase 4.

**Dependencies:**
- ADR-0012 Accepted (open questions resolved)
- Morphit Blurt community created on the Blurt chain
  (one-time manual step, depends on ADR-0012 Q2 resolution)

### Milestones

**5a-M1: Feedback-submit UI.**
The precondition for the cross-post flow. Users currently see
counterparty feedback but have no way to submit their own
feedback from the Morphit UI. Add:
- A feedback-submit card on the completed-order detail page
- Form: 5-star rating + optional short comment (same shape as
  `morphit_feedback_v1`'s payload)
- Posting-key signing + broadcast path
- Success state that segues into cross-post UI (see 5a-M3)

*Done when:* a user can successfully submit feedback for a
trade they completed, and it lands indexed on the next block.

**5a-M2: Klingex/real price feed.**
Replace the `$0.002 BLURT` hardcoded fallback with a real
price source. Fetches from Klingex primarily, Coingecko
secondary, hardcoded floor as ultimate fallback.
- New `BlurtPriceSource` module in the indexer with fallback
  chain
- 5-minute in-memory cache with background refresh
- Existing `/v1/listing-fee` endpoint returns fresh prices

*Done when:* the indexer's quoted listing fee tracks BLURT's
actual USD price to within ~5% during a typical day.

**5a-M3: Cross-post flow.**
Implements ADR-0012. The frontend offers post-trade cross-
posting via the user's own posting key.
- Cross-post modal appearing after feedback submission
- Template in 10 locales
- Posting-key re-unlock prompt (even though the key is
  session-unlocked, per ADR-0012 rationale)
- Analytics: count opt-in rate (local storage only, no
  server reporting — privacy constraint)

*Done when:* a user completing their first trade can post a
localized "first trade on Morphit" entry to Blurt signed with
their own posting key, with Morphit never touching the post
content after submission.

**5a-M4: Morphit Blurt community creation + homepage
integration.**
One-time Blurt-side setup, plus small frontend integration.
- Create the community on Blurt with agreed name (currently
  proposed: `morphit`) via `create_community` op
- Moderator roster: Agorise + one-two community volunteers
- Homepage tile linking to the community's recent posts
  feed (fetched live from Blurt)

*Done when:* the community exists, has moderation rules
documented, and appears on the Morphit homepage.

**5a-M5: Phase 4 loose ends cluster.**
From PHASE-5-BACKLOG.md §8:
- Structured logging migration (handler `console.log` →
  `logger.info({handler, signer, reason}, msg)`)
- `/v1/health?verbose=1` integration tests
- XMR viewkey verification script for operators
- Persian and Chinese translation quality audit pass
- FAQ search scoring tweaks

*Done when:* each of these sub-items either lands or gets
explicitly deferred to Phase 6 with reason recorded.

### Size: MEDIUM

Rough fuzzy estimate: 5-8 weeks of engineering across the
five milestones. M1 and M3 are the largest; M4 is a one-day
task; M5 is cumulative small items.

### Risks

- **M1 blocks M3.** Cross-post flow can't ship without
  feedback-submit UI. If feedback-submit hits a design snag,
  M3 slips.
- **Klingex API stability.** If Klingex rate-limits us or
  goes down, the fallback chain protects the feature but
  operators see log noise. Mitigation: add circuit breaker
  from Phase 4 explorer work to the price source too (code
  reuse).
- **Translation fidelity.** Native-speaker review of Persian
  and Chinese could surface real errors that need locale-
  specific fixes, not just polish.

## Sub-phase 5b — Operator incentives

**Scope:** the economic mechanism that converts Morphit from
a single-operator project into a network of aligned operators.

**Dependencies:**
- ADR-0013 Accepted — this includes resolving all six of
  its open questions, which requires Agorise policy input
  alongside the technical decisions.
- At least one external-party operator identified as a
  pilot deploy partner (to prove the mechanism works end-
  to-end before general launch).

### Milestones

**5b-M1: Operator registration op.**
New `morphit_operator_register_v1` custom_json + its indexer
handler + the `operators` table. Depends on ADR-0013 Q1
(registration fee amount) being resolved.
- Payload shape: `{ tag, display_name, contact_url,
  registration_fee_transfer_permlink? }`
- Handler validates tag uniqueness, verifies fee transfer
  sibling, inserts into operators table
- Introduces an operator-registration schema migration (v7)

*Done when:* an operator can register via CLI and is
persistent + discoverable via a `/v1/operators` API.

**5b-M2: Referrer tracking in order op.**
The biggest interface decision, per ADR-0013 Q2. Assuming
we land on option (a) — a new payload field:
- `morphit_order_v2` with optional `operator_tag` field
- Indexer handler accepts both v1 and v2
- Frontend includes operator_tag when the instance config
  provides one
- Tag attribution recorded in `operator_earnings` table per
  order

*Done when:* an order posted through an operator-branded
frontend can be unambiguously attributed to that operator
at indexing time, and operator earnings accumulate.

**5b-M3: Monthly payout automation.**
The indexer runs a monthly pass that computes per-operator
earnings and queues payouts via the existing
`relay_pending_transfers` path.
- New `kind='operator_payout'` on the queue
- Idempotent — safe to re-run if a pass crashes mid-way
- Operator-initiated claim op for the "pull don't push"
  pattern (per ADR-0013 Q4 leaning)

*Done when:* an operator can claim their accumulated
earnings via a signed op and receive the payout in a
subsequent block.

**5b-M4: Operator directory + frontend integration.**
A public-facing `/operators` page with the list of
registered operators, their tags, contact info, and
optional stats (if operators opt in to showing trade
volume). Also a "run a Morphit node" landing page with
the one-time setup steps and CLI tools.

*Done when:* anyone curious about running Morphit themselves
has a single page with the economics, the setup instructions,
and links to join the existing operators.

**5b-M5: Three new FAQ entries + 10-locale translation.**
- "How do I run a Morphit node?"
- "How do operators earn?"
- "How do I find a good operator?"
(Last one is new — users seeing multiple operator instances
will ask.)

*Done when:* the three entries land in all 10 locales,
wired into `FAQ_KEYS` in the frontend-side index.

### Size: LARGE

Fuzzy estimate: 6-10 weeks of engineering, plus Agorise
policy input time that's not engineering but gates M1.

### Risks

- **ADR-0013 open questions.** Six open questions, some
  policy-heavy. ADR closure could itself take weeks.
- **First-operator bootstrap.** Who's the pilot partner?
  The mechanism is testable in isolation but genuine
  usefulness requires a real external operator trying it
  for a real deployment. Without that, we ship a feature
  no one verified end-to-end.
- **Spam registration risk.** If the registration fee
  lands low (e.g., free + probation per Q1), we could
  see spam registrations. Mitigation: add a rate limit
  on the handler, cap total registered operators per IP.
- **Fee-split economics.** If the split percentage is
  set wrong, either Morphit treasury drains too fast
  (too generous) or operators don't bother (too stingy).
  The fallback plan: treat the initial number as a
  governance parameter that Agorise can adjust in future
  phases without requiring new op versions.

## Sub-phase 5c — Encrypted chat + reputation

**Scope:** replace the in-memory/websocket chat with an
end-to-end encrypted protocol per ADR-0015 (per-message
ECIES via X25519 + ChaCha20-Poly1305). Add reputation
signals derived from chat and feedback data.

**Dependencies:**
- ADR-0014 Accepted
- ADR-0015 Accepted (resolves the cipher choice for ADR-0014
  Q1, replacing the original heavier-protocol proposal).
- A storage-model sub-ADR (ADR-0014 Q2) — big enough decision
  that squashing it into the parent ADR would make it
  unreadable.

### Milestones

**5c-M1: Crypto module.**
Implement `apps/web/src/lib/chat/crypto.ts` per ADR-0015:
- X25519 chat-identity derivation from Blurt posting key
- Per-message ephemeral keypair generation
- ECDH-derived per-message key with BLAKE2b domain separation
- ChaCha20-Poly1305-IETF AEAD on the ciphertext
- Wipe ephemerals after use for sender-side PFS

*Done when:* a pair of Morphit-browser clients can
exchange encrypted messages end-to-end in an integration
test, without any network round-trips to Morphit servers.

**5c-M2: Chat identity key management.**
Per the sub-ADR resolving ADR-0014 Q1. Leaning toward option
2 (published long-term chat identity via
`morphit_chat_identity_v1` op).
- New op + indexer handler
- Frontend "first-time chat setup" UI that generates the
  key, publishes the pubkey, and stores the privkey in
  the encrypted-envelope pattern from Phase 4a
- Key-rotation flow (user-initiated, e.g. if they suspect
  compromise)

*Done when:* every Morphit account that wants to use chat
has a chat identity published to chain; private key stored
encrypted on the user's device.

**5c-M3: `morphit_chat_v1` op + indexer handler.**
The transport for ciphertexts.
- Payload: `{ order_permlink, recipient, ciphertext, header }`
- Handler verifies sender is a counterparty in the
  referenced order
- `chat_messages` table with appropriate indexes
- HTTP API endpoint: `GET /v1/chat/:order_permlink` returns
  all ciphertexts for that order (clients decrypt locally)

*Done when:* messages flow through the Blurt chain and
land in the indexer, ciphertexts persisted and retrievable,
no plaintext ever in indexer logs.

**5c-M4: Chat UI replacement.**
Retire the in-memory chat. New chat UI that:
- Reads from the indexer's `/v1/chat/:permlink` endpoint
- Decrypts locally with the user's chat identity
- Queues outgoing messages, signs them, broadcasts
- Handles offline-recipient case (they see the messages
  when they come online and decrypt)

*Done when:* users can conduct a full counterparty
conversation, leave, come back a day later, see the
full history, continue the conversation.

**5c-M5: Reputation signals in UI.**
Display-only, no chain-inclusion (per ADR-0014 Q4 leaning).
- "N messages exchanged" displayed on completed-trade detail
- Response-time stat (average turnaround)
- Rendered in orderbook as an optional column for users
  who've been in chats with the counterparty before

*Done when:* a user browsing the orderbook sees at-a-glance
reputation signals from previous counterparty interactions.

**5c-M6: Key-loss onboarding + documentation.**
Losing the chat identity private key = losing all past chat
history. This is scary; users need to know upfront.
- Backup flow: on chat-identity creation, show the user
  their chat privkey encoded as a Blurt-style recovery
  phrase + offer to print it
- Clear warnings in the UI when a user imports a chat
  identity key
- FAQ entry: "What happens if I lose my chat key?"

*Done when:* the key-loss implications are documented
and the backup flow is working.

### Size: LARGE+

Fuzzy estimate: 12-16 weeks. This is genuinely a new crypto
protocol layered onto a new transport; the biggest feature
Morphit has shipped.

### Risks

- **libsignal JS port maturity.** The official JS port is
  less actively maintained than the Rust or mobile versions.
  Mitigation: assess at M1 start; if it's stale, consider
  libsignal's Rust+wasm path (more maintenance but more
  current).
- **On-chain storage load.** If chat volume is high, we
  contribute meaningful bytes to the Blurt chain. Need a
  community conversation with Blurt witnesses before
  launch. Mitigation: land the storage decision (ADR-0014
  Q2 sub-ADR) early and socialize it.
- **Key-loss UX is the single biggest UX risk.** If users
  routinely lose chat history due to key loss, the feature
  is worse than the current in-memory chat (which loses
  on reload but at least doesn't pretend to be durable).
  Mitigation: obsess over the backup + warning flow in M6.
- **Scope creep into "Morphit Messenger".** Chat could
  easily grow into a standalone messaging app. Phase 5c
  stays scoped to counterparty-per-order chat. General
  messaging stays out of scope explicitly.

## Cross-cutting sequencing

Three sub-phases, each independently ship-able:

```
Phase 4 ships (Q2 2026)
         │
         ├─────► 5a — Ecosystem reach (5-8 weeks)
         │         Start: immediately after Phase 4 ops-review
         │         Blocks: nothing; dependent: none
         │
         ├─────► 5b — Operator incentives (6-10 weeks + ADR time)
         │         Start: after ADR-0013 Accepted
         │         Blocks: decentralization goal
         │         Dependent: 5a's price feed (for accurate
         │                    fee attribution); not strict
         │
         └─────► 5c — Encrypted chat (12-16 weeks + sub-ADR time)
                   Start: after ADR-0014 + sub-ADRs Accepted
                   Blocks: the current chat weakness
                   Dependent: could use 5b's operator list for
                              key-discovery fallback, not strict
```

### Recommended order

**5a first** — small, user-visible, resolves Phase 4 gaps,
builds team momentum. ADR-0012 has only three open
questions; they resolve in normal design review, not
multi-party negotiation.

**5b second** — higher leverage (decentralization), but
gated by ADR-0013's open questions which have policy
content needing external input. While ADR-0013 is being
resolved in parallel, engineering proceeds on 5a.

**5c last** — biggest investment; worth starting only once
team has capacity. Might actually be Phase 6 depending on
team size.

### Parallel paths

Within a sub-phase, milestones can go in parallel:

- 5a: M1 (feedback UI) and M2 (price feed) are independent.
  M4 (community) is a one-day task that can fit anywhere.
  M3 (cross-post) depends on M1.
- 5b: M1 (registration) and M2 (referrer tracking) can
  develop in parallel once ADR-0013 is accepted.
- 5c: M1 (libsignal) and M2 (identity keys) are independent
  foundations; M3 builds on both; M4-6 build on M3.

## Open questions at the phase level

- **Parallelism vs. focus.** Can the team do 5a and 5b in
  parallel tracks? Depends on team size. Solo engineer
  should do them sequentially; two+ can split.
- **Sub-phase release cadence.** Do we ship 5a as its own
  release, then 5b, then 5c? Or bundle them? I lean toward
  separate releases — Phase 4 taught us that smaller
  releases catch issues earlier.
- **Do we do ADR-0013 before 5a ships, or concurrently?**
  If ADR-0013 work (which is partly policy, not engineering)
  runs in the background during 5a engineering, 5b can
  start immediately after 5a ends with no dead time.
- **Do we incorporate any 5c work into 5b?** Some chat
  infrastructure (e.g., the new custom_json op shape
  patterns, the indexer handler patterns) could be
  pre-built during 5b idle time. Low value, probably not
  worth optimizing.

## Timeline anchor

None committed. Rough ballpark assuming solo engineering:

- 5a: **summer 2026** realistic
- 5b: **fall 2026** realistic
- 5c: **winter 2026 into 2027** realistic

With two engineers these can overlap significantly.

## Design-doc changelog

- 2026-04-19 initial draft post-Phase-4 closeout
