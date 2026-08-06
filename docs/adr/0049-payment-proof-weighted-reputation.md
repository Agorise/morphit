# ADR-0049 — Payment-proof-weighted reputation

**Status:** Proposed — XMR / privacy-asset exclusion **CONFIRMED** (@agorise, 2026-07-04: "for monero it's a disaster; we do not want to sacrifice privacy"). The transparent-chain tier itself is still pending a privacy-vs-value decision (see the Update note under Decision).
**Date:** 2026-07-04
**Deciders:** @agorise
**Supersedes:** —
**Superseded by:** —

## Context

Reputation today (ADR-0014 + the cp421 hardening) is a time-decay
weighted average of 1–5 ratings with a 365-day half-life. Only
order-tethered feedback counts, reviews from detector-flagged pairs
(`suspicious_reciprocity` / `related_accounts` / `one_way_pile_on` /
`review_concentration`) are excluded from the aggregate, and — as of
cp421 — a review is only *accepted at all* if the two parties have a
substantiated two-way on-chain conversation (≥2 `morphit_chat_v1` each
way, ≥15-min span, unflagged = the `has_verified_chat` bar). So the
current floor is "you provably had a real conversation with this
person." There is **no** notion of proof *strength* in the weight —
every accepted review counts the same.

The ask (Ken): a review backed by a **provable full-amount crypto
payment** should carry materially more weight than a conversation-only
review. Working assumption for the threat model: **a majority of users
will, at some point, try to inflate their reputation by nefarious
means**, so any "payment-verified" tier must be *substantially* harder
to forge than a conversation — otherwise it just moves the gaming
target.

This ADR works out whether that tier is achievable, what it can and
cannot prove, and — critically — how it collides with Morphit's #1
priority (privacy / anonymity).

### The three hard constraints

1. **The fiat leg is never on-chain.** Every Morphit trade is
   fiat↔crypto. The cash/bank side leaves no TxID, ever. So a payment
   proof can only ever attest the **crypto** leg. Consequence: a
   verified payment is a signal about the **crypto sender's**
   reliability (they delivered), so it can only boost the review *of
   the crypto sender, by the crypto receiver*. The cash payer's
   reliability stays conversation-only — it is structurally
   unprovable. A pure "cash both directions" trade cannot exist (one
   leg is always crypto), but a trade can only ever earn the tier for
   the one party who sent crypto.

2. **The agreed amount and the recipient address live in E2E chat.**
   The indexer never sees the negotiated amount or (for external
   chains) the payee address — they are exchanged inside encrypted
   `morphit_chat_v1` payloads (ADR-0015). So the indexer *cannot
   autonomously judge* "was this the full agreed amount to the right
   person." Any design that tries to derive "full amount" from the
   order alone is wrong: orders are frequently ranges/rates, and the
   actual trade size is negotiated in chat.

3. **Assets are asymmetric in verifiability.**
   - **BLURT:** a transfer between two Morphit accounts is *fully*
     on-chain — sender, recipient (a Morphit account), amount, and
     memo are all public and directly indexable. Recipient identity
     is proven with no attestation needed.
   - **BTC / LTC / BCH / DOGE / stablecoins (transparent chains):**
     the existing fee verifiers can confirm "txid delivered ≥ amount
     to address Y," but the address-Y-belongs-to-the-counterparty
     binding is *not* on-chain — it was exchanged in chat. So this
     tier needs the recipient to attest.
   - **XMR (and any privacy asset):** see the privacy tension below —
     an on-chain-*verifiable* proof is fundamentally incompatible
     with the reason someone chose XMR.

### The central tension: this feature trades privacy for reputation

A publicly verifiable payment proof is, by definition, published
evidence that links *you* to a *counterparty* for a *specific amount*
on a public ledger. For a privacy-first marketplace that is a real
cost, and it is **not uniform across assets**:

- For transparent chains (BLURT/BTC/…), the payment is *already*
  visible on-chain; a settlement proof mainly adds the
  *linkage*(this txid ↔ this Morphit trade ↔ these two accounts),
  which aids chain analysis. A meaningful but bounded privacy loss.
- For **XMR**, it is catastrophic. Monero's privacy comes precisely
  from *not* being able to prove amounts/recipients. The only way to
  prove an XMR payment is to publish the **transaction key** (plus the
  address and amount), which **permanently deanonymizes that
  transaction** to anyone. That directly contradicts (a) the platform's
  #1 priority, (b) the reason XMR users are here, and (c) the standing
  invariant that the XMR private view key is env-only and never
  published. Building an XMR settlement proof would hand privacy-
  seeking users a footgun.

This tension is the crux of the decision, not a footnote.

## Decision

> **Update (2026-07-04, @agorise):** the XMR / privacy-asset exclusion
> below is confirmed — we will not publish anything that deanonymizes a
> Monero transaction. That leaves one open question: whether the
> *transparent-chain* tier is worth building at all. Even for BTC/LTC/…
> a settlement proof adds an on-chain **linkage** (this txid ↔ this
> trade ↔ these two accounts) that aids chain analysis — a bounded but
> real privacy cost on a privacy-first platform. Given (a) that cost and
> (b) that the cp421 verified-chat gate *already* makes ghost/self-boost
> reviews impossible and gives reputation a strong, spoof-resistant
> floor, the **standing recommendation is to NOT build the payment tier
> and keep reputation conversation-based** — holding this ADR as the
> worked-out record so the option is one decision away if a concrete
> need appears. The rest of this section documents the design *if* the
> transparent-chain tier is ever green-lit.

**Adopt a two-sided, opt-in, transparent-assets-only settlement
proof, and use it as a weight multiplier — never for XMR/privacy
assets, and never automatically.**

### 1. Scope — which assets

Settlement proofs are offered **only for transparent-chain assets**
already governed by ADR-0026 (BLURT, BTC, LTC, BCH, DOGE, and
transparent-chain stablecoins). **XMR and any privacy asset are
explicitly excluded** — a trade whose crypto leg is a privacy asset
earns reputation through the verified-chat baseline only. This is a
deliberate *privacy-over-reputation* choice for the privacy core, and
it is the correct one: you cannot have both a public payment proof and
transaction privacy; those are fundamentally opposed.

### 2. Mechanism — a `morphit_settlement_v1` op with two roles

- **Payer claim** (crypto sender):
  `{ order_permlink, counterparty, asset, amount, txid[, address] }`
  — "I paid `amount` `asset` to `counterparty` for order O; proof
  is `txid`." `address` is required for external chains, omitted for
  BLURT (recipient is the Morphit account).
- **Recipient acknowledgment** (crypto receiver):
  `{ order_permlink, counterparty, settlement_ref }` — "I received the
  **full agreed amount** from `counterparty` for order O," referencing
  the payer's claim.

Both ops are **opt-in** and surfaced with an explicit privacy warning
("this publishes a link between your trade and a public transaction")
before broadcast.

### 3. Verification — what makes a settlement "payment-verified"

A settlement is payment-verified iff **all** hold:

1. **On-chain payment reality** (reuse the existing fee-verification
   machinery — `bitcoinExplorerVerifier`, the transparent-chain
   verifiers, BLURT transfer indexing):
   - *BLURT:* the transfer op exists with sender = payer, recipient =
     `counterparty` (a Morphit account), amount ≥ claimed. Recipient
     is *proven* — no ack needed for identity, but the ack is still
     required for "full amount" (see 3).
   - *Transparent external chains:* the txid delivered ≥ `amount` to
     `address`. Address→counterparty is unproven on-chain, so it rides
     on the recipient ack.
2. **Mutual, order-bound reference:** payer claims paying
   `counterparty`; recipient acknowledges receiving from
   `counterparty`; both cite the same `order_permlink`.
3. **"Full amount" via the recipient, not the indexer:** we do **not**
   ask the indexer to judge sufficiency (constraint 2 makes that
   impossible). The **receiver** — who *does* know the agreed amount —
   attests "full." Combined with on-chain proof that a payment of that
   magnitude actually moved to them, this is strong.
4. **Clean pair + existing gate:** the (payer, receiver) pair passes
   the same verified-chat gate and is not detector-flagged.

### 4. Weight treatment (tunable)

Two effects, both driven off payment-verified settlements where the
**subject** was the crypto sender:

- **Rating multiplier** in the existing decay formula:
  `SUM(rating · decay · proof_weight) / SUM(decay · proof_weight)`,
  with `proof_weight ∈ {1 (conversation-only), W (payment-verified)}`.
  Recommend **W = 3** as a starting point (a payment-backed review
  counts like ~3 conversation-only ones); expose as a constant.
- **A distinct "payment-verified trades" count** surfaced alongside
  the rating. This is arguably the *stronger* anti-gaming display — a
  number that costs real on-chain crypto movement to inflate, not just
  a fabricated conversation.

## Alternatives considered

- **Indexer derives the expected amount from the order.** Rejected:
  orders are ranges/rates; the real amount is negotiated in chat, so
  the order can't pin "full." Would either false-negative real
  payments or be trivially gamed by claiming a tiny amount.
- **Payer-only self-attestation (no recipient ack).** Rejected: the
  payer could cite a real *small* txid and claim it was the full
  trade. Proves a payment happened, not that it settled the deal.
- **On-chain-only, no ack, for all assets.** Works for BLURT (recipient
  is a verifiable Morphit account); fails for external chains
  (address→counterparty unprovable). Adopted *only* for the BLURT
  identity sub-case; the ack still carries "full amount."
- **Support XMR settlement proofs (opt-in, with a warning).**
  Rejected: even opt-in, it normalizes publishing a tx key that
  permanently deanonymizes the transaction, on the one asset where that
  is most harmful, for the exact users who most need privacy. The
  privacy cost is not worth a reputation nicety. XMR stays
  conversation-only.
- **Trusted escrow / oracle attesting settlement.** Rejected:
  violates non-custodial + decentralization principles.

## Consequences

### Positive
- A payment tier that is *materially* harder to forge than a
  conversation: a sockpuppeteer must actually move real crypto between
  addresses they control (real cost + on-chain footprint) **and** pass
  the verified-chat gate **and** evade the reciprocity detector.
- Reuses the existing, proven fee-verification machinery.
- Degrades gracefully — no proof ⇒ the cp421 verified-chat baseline
  still applies; the floor never drops.
- Respects privacy priority #1 by construction (XMR excluded, opt-in,
  warned).

### Negative
- Only the crypto leg is ever provable; **cash payers can never earn
  the tier** (inherent, by design).
- **Privacy-core users (XMR) get no payment tier** — a deliberate
  tradeoff, but it means the tier skews toward transparent-chain
  traders. Reputation must not *punish* XMR-only traders for opting
  out; the multiplier lifts payment-verified reviews rather than
  demoting others below the baseline, and the "verified-trades" count
  must be presented as a *bonus signal*, not a badge of honor whose
  absence implies distrust.
- Second op (the ack) is UX friction — mitigate by prompting for it at
  feedback time, when both parties are already closing the trade.
- Residual gaming: a determined actor moving real crypto between
  controlled addresses + faking a sustained chat + dodging detectors
  *can* forge one settlement. It is expensive and pattern-detectable,
  but not impossible — the tier raises cost, it doesn't make fraud
  impossible.
- Asset-tiered complexity (BLURT path ≠ external-chain path).

### Follow-up work
- Final `W` and whether to also weight by **trade size** (bigger
  verified trades → more weight, with strong diminishing returns to
  avoid a "one huge self-trade dominates" vector).
- Exact copy + placement of the privacy warning on the opt-in flow.
- A settlement-specific detector (e.g. flag a cluster of accounts
  circulating the same crypto to manufacture verified trades).
- Whether the "verified-trades" count should itself be subject to the
  suppression filters the rating aggregate already applies.

## References
- ADR-0014 — Chat and counterparty reputation (the verified-chat badge
  and the base reputation model this extends).
- ADR-0015 — Chat crypto (why amount/recipient live in E2E payloads).
- ADR-0026 — Transparent-chain privacy framework (the asset-privacy
  boundary this decision leans on; XMR's privacy guarantees).
- cp421 (TARBALL.md / REVISIT-LIST.md) — the verified-chat *gate* this
  builds the weight tier on top of.
- `apps/indexer/src/indexer/fee/*` — the existing on-chain
  payment-verification machinery to be reused.
