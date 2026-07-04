# ADR-0013 — Third-party node operator incentives

**Status:** Accepted (implemented; pipeline shipped 2026-05-02).
**Amended 2026-07-04 (cp408):** payout mechanism changed from
relay-forwarded to a **payment-time split** — see the amendment
note directly below.
**Date:** 2026-04-19 (proposed); 2026-05-06 (status updated, Q1-Q6 resolved)
**Deciders:** project maintainer, Agorise leadership
**Related:** ADR-0011 (dynamic fee model), ADR-0010 (key custody)

> **Amendment (2026-07-04, cp408) — payment-time split supersedes
> the relay-forwarded payout.** The *decision* recorded here stands
> unchanged: BLURT listing fees are 90% to the instance owner / 10%
> to the canonical treasury; BTC/XMR fees 100% to the canonical
> treasury. Only the *delivery mechanism* changed. Originally the
> fee landed 100% in a treasury and the relay forwarded the
> operator's 90% (an `operator_payout` `relay_pending_transfers`
> row + `operator_payouts` audit row). That model only nets
> correctly when one entity owns both the treasury and the relay
> (the canonical case), so it misrouted money for independent
> federation owners. It is replaced by splitting the fee **at
> payment time**: the user's fee transaction carries a 90% transfer
> to the instance's fee recipient + a 10% transfer to the canonical
> treasury (collapsing to a single 100% transfer on the canonical
> instance / fallback). The owner is paid directly, with no
> forwarding. `operator_attribution_events` + `operator_earnings`
> remain as the audit/dashboard; the `operator_payouts` table and
> the relay payout are retired. See FEES-AND-REWARDS.md "How
> listing fees split" and `apps/indexer/src/indexer/fee.ts`
> (`sumFeeTransfers` / `canonicalShareOk`). Sections below that
> describe "immediate per-attribution payout via the relay" are
> historical; read them through this amendment.

> Originally a stub with six interdependent UNDECIDED design
> questions.  All six resolved during Phase 5b implementation;
> see **Design questions resolved** at the bottom of this
> document for the resolutions and the code that backs each.

## Context

Morphit's architecture today supports multiple operators
running their own instances (a SvelteKit frontend + indexer +
relay), but there's no economic incentive to do so. An
operator pays VPS costs, does initial setup work, and gets
nothing except the satisfaction of contributing. This is
fine for the project's three committed operators (Agorise
and two allied groups) but doesn't scale to the "dozens of
independent operators worldwide" model that makes Morphit
censorship-resistant in practice.

Phase 5 aims to fix this by financially rewarding operators
with a share of listing fees from orders posted through their
frontend. An operator-run instance earning modest monthly
revenue (say $20-100/month in BLURT) is self-sustaining;
Agorise is no longer the only entity keeping the network
alive.

### Constraints

- **On-chain accountability.** Operator earnings must be
  verifiable on the Blurt chain. No private-database-driven
  accounting that an operator has to trust Morphit to keep
  accurate.
- **No operator custody of user funds.** Operators ingest
  user traffic but never touch user keys or user BLURT. They
  earn from fees paid through their frontend, not by holding
  user balances.
- **Low barrier to entry.** Running an operator must be
  feasible for one person on a cheap VPS. No KYC, no legal
  entity, no business license.
- **Some barrier to entry.** An upfront fee or equivalent
  stake to discourage spam registrations and abandoned
  instances. Must be affordable to a solo hobbyist but not
  zero.
- **Revenue transparency.** An operator must be able to
  check "how much did I earn last month" in a public,
  auditable way.

### Technical state of play

- Every `morphit_order_v1` op currently omits a "referrer"
  or "operator" field. Adding one is a payload shape change
  — either a new op version or a new optional field.
- Fees flow to `@morphit-fees` via a sibling `transfer` op.
  The memo is `morphit-fee:<permlink>`. No operator metadata
  is recorded there.
- The relay broadcasts scheduled transfers from
  `relay_pending_transfers` (Phase 4a). We could add a new
  `kind='operator_payout'` row type for monthly earnings.
- `accounts` table tracks registered Morphit users.
  Operators would be a disjoint table (or an augmenting
  column on `accounts`) with different semantics.

## Decision

**Three interlocking mechanisms (as shipped Phase 5b, 2026-05-02):**

1. **Operator registration op.** A `morphit_operator_register_v1`
   custom_json op signed by the operator account's posting key
   claims a tag.  No registration fee — anyone with a Blurt account
   can register.  Tags are first-come-first-served via a UNIQUE
   constraint on `operators.tag`.  See
   `apps/indexer/src/indexer/handlers/operatorRegister.ts`.

2. **Referrer tracking.** Orders carry an optional `operator_tag`
   payload field.  When set and matching a registered, active
   operator, the order's BLURT-paid listing fee is split per
   the policy below.  Forging another operator's tag on your own
   orders is allowed (handler doesn't reject it) — it just gives
   that operator your fee, which makes self-dealing an
   own-goal.  See `apps/indexer/src/indexer/operatorEarnings.ts`.

3. **Immediate per-attribution payout.** When an order's BLURT
   fee is verified, the same indexer transaction that records
   the attribution also queues the operator's share as a
   `relay_pending_transfers` row with `kind='liquid'`.  The
   relay drainer broadcasts within seconds.  No monthly batch,
   no `last_payout_at` cron — the column is kept for backward
   compatibility but reinterpreted as "block_time of most recent
   immediate payout."  See schema-v27.sql for the model
   transition.

**Fee-split policy of record (resolves Q3):**
- **BLURT-paid listing fees:** 90% to the attributed operator,
  10% to the Morphit treasury (`@morphit-fees`).
- **BTC-paid and XMR-paid listing fees:** 100% to the Morphit
  treasury, 0% to operators.  This path doesn't go through
  `operatorEarnings.ts` — it's enforced by `attributeBlurtFee`
  only being called from the BLURT branch of the order handler.

**Why 90/10 and not 50/50** (the originally-considered split):
50/50 was anchored by classic-marketplace economics where the
platform incurs ~equal cost-of-acquisition vs the operator.
For Morphit the cost asymmetry runs the other way: the operator
provides the user-facing surface (frontend hosting, support,
language localization, regional payment-method curation), while
Morphit-the-protocol provides the chain logic that runs once
upstream.  Tilting heavily toward operators (90%) makes the
math work for a serious operator at modest user volumes ($20-
100/month sustains a small VPS), which is the population we
need to reach to be censorship-resistant in practice.  The
treasury 10% covers project-wide costs (chain-fee subsidies
for signup-relay account creation, welcome bonuses, occasional
emergency operator funding) without depending on the operators.

**Why BTC/XMR-paid fees go 100% to treasury:** External-asset
fees fund the chain-side accounting and dust-cleanup work that
Morphit-the-protocol does centrally.  They're rarer than BLURT
fees (the waiver path biases new users toward BLURT) so the
revenue impact on operators is small, while the operational
overhead of multi-asset operator payouts (stablecoin custody,
multi-chain broadcasts, exchange-rate slippage) would consume
much of any payout amount.

## Alternatives considered

- **Status quo (no incentives).** Rejected because it's the
  current state and doesn't scale past committed volunteers.

- **Uniform flat payout per operator per month.** All
  registered operators get the same amount regardless of
  traffic. Rejected because it rewards zombie operators with
  no traffic equally to productive ones; it also caps total
  payout at N × flat, which doesn't scale with Morphit's
  growth.

- **Operator-side ad revenue.** Let operators run whatever
  ads they want on their frontend and keep the revenue.
  Rejected because ads compromise the non-custodial,
  privacy-first positioning and create operator incentives
  misaligned with user experience. A user who sees ads on
  one operator's frontend has reasonable doubt that the
  operator isn't also instrumenting other surveillance —
  the trust story unravels quickly.

- **Staking model.** Operators stake BLURT proportional to
  expected revenue, earning in proportion to stake + traffic.
  Rejected as over-complicated for the current scale; worth
  reconsidering in a future phase if the simple-fee-split
  model shows too much noise.

- **Donations only.** Users tip operators via a "support this
  node" button. Rejected because tipping is a weak incentive
  (empirically low conversion in crypto communities) and adds
  UI complexity on the frontend.

## Consequences

### Positive

- Decentralization becomes economically viable. Running a
  Morphit instance goes from "act of goodwill" to "modest
  side income," which unlocks operators in jurisdictions
  and communities where Agorise doesn't have presence.
- On-chain accountability. Every operator payout is a Blurt
  transaction with a parseable memo. No one can claim they
  were "shorted" without presenting chain evidence.
- Creates a natural redundancy path. If the Agorise-run
  instance goes down, users find working operator instances
  via the operator directory (if we build one).

### Negative

- New attack surface: operators can try to forge referrer
  claims to inflate their earnings. Mitigation depends on
  which tracking mechanism we pick (see Open Q2).
- Spam registrations if the upfront fee is too low. Mitigation
  is the fee amount itself.
- Accounting complexity: operator earnings ledger, monthly
  aggregation, payout dispute handling.
- Increased indexer storage: `operators` + `operator_earnings`
  tables grow over time, especially if we track per-order
  attribution rather than aggregated monthly.
- If the split percentage is wrong (too high), Morphit runs
  out of money. Too low and operators don't bother.

### Follow-up work

- Specific schema for the `operators` and `operator_earnings`
  tables (depends on Open Q2).
- New op version: `morphit_operator_register_v1`.
- If Open Q2 resolves to "payload field": new order op
  version `morphit_order_v2` with the field.
- Operator-facing CLI tool to register, check earnings,
  update metadata.
- Public operator directory page (`/operators`) on the
  Morphit website.
- Three new FAQ entries: "how do I run a Morphit node,"
  "how do operators earn," "how do I find a good
  operator."

## Design questions resolved

All six interdependent UNDECIDEDs are resolved in shipped Phase 5b
code.  This section records the resolution and the supporting
rationale; the original options-considered prose is kept for
historical context.

**Q1 — Registration fee. RESOLVED: free.**

No upfront BLURT transfer required.  The `morphit_operator_register_v1`
handler does not verify or require any sibling fee transfer.
Anti-spam relies instead on:
- Tag is one-shot per account (UNIQUE on `operators.account` AND
  on `operators.tag`).  An attacker farming spam registrations
  needs a fresh Blurt account per registration, which already
  costs ~100 BLURT in chain account-creation fees.
- Reserved-tag list (`isReservedTag` in
  `apps/indexer/src/indexer/confusables.ts`) blocks impersonation
  of project-controlled names (morphit, agorise, etc.).
- TAG_PATTERN `^[a-z0-9._-]+$` restricts to URL/log-safe characters,
  preventing homograph or RTL-override shenanigans.

The original "$50 equivalent" suggestion was anchored to SaaS-style
spam prevention.  At Blurt's account-creation fee floor, a
spammer already pays 100 BLURT/account; doubling-down with a
registration fee adds friction for legitimate small operators
without meaningfully raising the spam floor.

Originally-considered alternatives below.

- $50 equivalent: classic SaaS "serious intent" signal. But
  at BLURT ≈ $0.002, that's 25,000 BLURT — a lot for a
  non-commercial operator to acquire.
- $10 equivalent: 5,000 BLURT. More accessible; enough to
  prevent casual spam registrations.
- Free + moderator approval: no upfront cost, but creates a
  human gatekeeper which is itself a bottleneck.
- Free + automatic probation: register free, earn 0% for
  the first month, then automatic activation if the
  operator has actually served traffic in that month.

**Q2 — Referrer tracking mechanism. RESOLVED: payload field on the order op (option a).**

Orders carry an optional `operator_tag` payload field.  The
indexer's order handler extracts it, looks up the active operator
by tag, and credits the BLURT fee accordingly.  Implementation in
`apps/indexer/src/indexer/operatorEarnings.ts` (function
`attributeBlurtFee`).

Why (a) over (b) memo extension or (c) separate attestation op:
- Option (b) — memo extension — was rejected because the user
  controls the memo of their own fee transfer; tag forging would
  cost the attacker their own fee but could also be used to grief
  an unwitting operator's reputation by attaching their tag to
  hostile orders.  Eliminating user-controlled tagging closes that
  surface.
- Option (c) — separate operator attestation op — was rejected for
  doubling per-order indexer load and adding a coordination delay
  between order broadcast and attribution.

Self-dealing under option (a) is a money-loser for the attacker
(see operatorEarnings.ts §"Black-hat audit"), so the tag-trust
property is acceptable: the chain-side trust contract is "the
order's signer chose to attribute to this tag," not "this tag
endorses this order."

Originally-considered alternatives:

- **(a) New payload field.** Orders get an optional
  `operator_tag: string` field in `morphit_order_v1` (or v2).
  Indexer validates against the operators table at order
  ingestion. Pros: clean data model, verifiable on-chain,
  impossible to forge post-hoc. Cons: new op version, all
  frontends need to upgrade to include it, legacy orders get
  no attribution.

- **(b) Extended fee memo.** The fee transfer memo becomes
  `morphit-fee:<permlink>:<operator_tag>`. Pros: no op version
  bump; works with existing order structure. Cons: memos can
  be spoofed by a malicious user (user controls what goes in
  the memo of their OWN transfer). An operator whose users
  like them gets credit; a user pretending to be from
  operator X can inflate X's numbers.

- **(c) Separate attestation op.** After the order lands, the
  operator (not the user) submits a signed
  `morphit_operator_claim_v1` referencing the order permlink.
  Pros: cryptographically attributable to the operator; they
  can only claim orders they actually saw. Cons: adds a whole
  second op per order; doubles the indexer's dispatch load.

**Q3 — Fee-split percentage. RESOLVED: 90/10 BLURT, 100/0 BTC/XMR.**

- BLURT-paid listing fees: **90% to the attributed operator**,
  10% to the Morphit treasury (`@morphit-fees`).
- BTC-paid and XMR-paid listing fees: **100% to the Morphit
  treasury**, 0% to operators.

This supersedes the originally-recorded 50/50 self-amendment.
The 50/50 number was placeholder, recorded in the Phase 5
scaffolding session before operator-economics modeling was
done.  The 90/10 model emerged from working through what a
serious operator needs to clear monthly costs at modest user
volumes ($20-100/month sustains a small VPS) and from a
deliberate philosophy of tilting toward operators in the
growth phase to incentivize the federated topology that
makes Morphit censorship-resistant in practice.

The asymmetry (BLURT 90/10 vs BTC/XMR 100/0) reflects an
operational reality: BLURT splits atomically on-chain in a
single transfer.  BTC/XMR fees land in cold-stored treasury
wallets — splitting per-receipt would require either a
custodial bookkeeper (defeats non-custodial design) or a
batch-and-convert with exchange-rate risk.  The aggressive
90/10 BLURT split is the compensating mechanism: operators
whose users mostly pay in BLURT (the loyalty-milestone-rewarded
default path) earn close to the full fee value in expectation,
exceeding what an even 50/50-on-everything model would have
produced.

Per-event split is recorded in `operator_attribution_events.split_percent_at_event`
so a future policy change doesn't retroactively rewrite history.

User-facing copy in all 10 locales (`apps/web/src/lib/i18n/locales/*.json`,
key `faq.entries.how_operators_earn`) describes this model
fully and transparently, including the rationale for why
BTC/XMR is 0%.  Treat that copy as a tied source of truth
with this ADR.

**Q4 — Payout automation. RESOLVED: fully automatic, immediate per attribution.**

When an order's BLURT fee is verified and attributed to an
operator, the same indexer transaction queues a
`relay_pending_transfers` row with `kind='liquid'` for the
operator's 90% share.  The relay drainer picks it up on its
next cycle (~seconds).  No monthly batch, no operator-initiated
claim op.

Why immediate over the originally-leaning "operator-initiated
trigger": Blurt's mana-based economics (effectively zero
per-transfer cost) eliminate the cost-of-batching argument that
makes monthly payouts attractive on EVM-like chains.  The
relay account already does dozens of welcome-bonus transfers
daily without strain.  Immediate payout removes the operator-side
"when do I claim" decision and the "did the indexer compute my
totals correctly this month" doubt.

The "real money flowing on a cron" risk that motivated the
operator-trigger model is mitigated by:
- Per-event audit row (`operator_attribution_events`) with the
  split percentage frozen at event time
- UNIQUE constraint on `(order_account, order_permlink)` and on
  `trx_id` rejects double-credit
- The relay's per-transfer broadcast retry cap and error_count
  tracking
- Operator can read live earnings via `/v1/operators/<tag>/earnings`
  and reconcile against on-chain transfers without trusting the
  indexer's accounting

Originally-considered alternatives:

- Full automation: indexer computes monthly totals, queues
  payouts automatically via the existing relay queue.
  Fastest UX for operators but introduces "real money
  flowing on a cron" risk — any bug in the accounting
  pass is a money bug.
- Automation with operator-initiated trigger: operator
  invokes `morphit_operator_claim_payout_v1` at any time,
  indexer emits the queued payout. Trades slower payout
  for operator-side agency (operators can claim less often
  if they want, or batch).
- Manual: Agorise does monthly payouts by hand. Reliable,
  transparent, labor-intensive.

**Q5 — Tag registry governance. RESOLVED: first-come-first-served, immutable, reserved-list filter, no central revocation.**

- **Collision:** First registration wins, enforced via UNIQUE on
  `operators.tag`.  Subsequent attempts to register a claimed tag
  return `tag_already_claimed`.
- **Edits:** None.  Tag is immutable post-claim; `display_name`
  and `contact_url` are mutable via a separate update op (not
  part of this ADR's scope).
- **Reserved-list filter:** `isReservedTag` rejects names that
  impersonate the project (morphit, morphit-bot, agorise, etc.)
  before the UNIQUE check fires.  Updatable list — see
  `apps/indexer/src/indexer/confusables.ts`.
- **Revocation:** No central revocation mechanism.  An operator
  who misbehaves loses traffic via user-side instance switching
  (operators are competitive, not exclusive); the federation
  topology means there's no central authority to revoke from.
  The user-facing signal is the public operator directory at
  `/operators`, where an operator's attribution count and recency
  give users the information they need to choose.
- **Dispute process:** Public — abuse reports go to the operator's
  Blurt account directly (chain-native communication) or to the
  project's Matrix room.  No private moderation queue.

Why no central revocation: Morphit-the-protocol explicitly does
not have central authority to revoke operator status.  An
operator who runs a hostile fork loses competitive position to
honest operators (this is why first-class instance-switching is
in the frontend Settings); there's no place a project-level "ban"
would land that wouldn't undermine the federated story.

The originally-considered "Agorise can revoke" model was
rejected because it would have created a project-level
deplatforming vector that an operator-level adversary could
exploit.

**Q6 — Retroactive credit. RESOLVED: start clean.**

Earnings accumulate from the moment an `operator_attribution_events`
row is recorded.  Phase 4 orders (placed before Phase 5b
shipped) carry no `operator_tag` in their payload, so they
don't fire `attributeBlurtFee`.  Existing operators (Agorise's
canonical instance, allied instances) start at zero alongside
new entrants.

Why start clean over backdating: the originally-considered
backdate option required identifying historical traffic per
operator, which under any of Q2's options is structurally
impossible for pre-Phase-5b orders (no tag in the payload).
A deterministic-from-IP-or-Origin reconstruction would not
match the Q2 chain-recorded model and would establish a precedent
of "the project assigns earnings" that contradicts ADR-0013's
non-custodial framing.

Net effect: Agorise (the project's operating org) ends Phase
5b with zero accumulated earnings, same as a brand-new operator
who registers tomorrow.

## References

- PHASE-5-BACKLOG.md item 3
- PHASE-4-BACKLOG.md item 1 (original framing)
- ADR-0011 — fee model that this extends
- Open-source operator economics: Mastodon operator tip jars,
  SimpleX relay operator fees, Tor exit relay sponsorship
  models (different-but-adjacent prior art)
