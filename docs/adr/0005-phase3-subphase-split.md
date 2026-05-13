# ADR-0005: Split Phase 3 into three subphases

**Status:** Accepted

> **2026-05-07 forward note:** the "3-minute replace-window
> enforcement" line items below describe the value as
> originally implemented. Updated to **15 minutes** in Part
> 70; see ADR-0001 Amendment 2026-05-07 for the rationale.
**Date:** 2026-04-18
**Deciders:** project maintainer
**Supersedes:** Plan v1.3 §348 description of Phase 3 as a single phase

## Context

Plan v1.3 described Phase 3 as a single deliverable covering: posting
relay, account creation UI, indexer, peer gossip, REST + RSS,
order browse + filter UI, 3-minute replace-window enforcement, sybil
fee logic, and self-trade detection.

After completing Phases 1 and 2, several properties of that original
scope became clear:

1. **Scope is large.** Each bullet above is at least one development
   session of focused work, several are two or three. A single-tarball
   phase would mean 10+ turns between testable deliverables.

2. **Infrastructure precedes feature work.** The relay and indexer
   are Go services, new to the repo; they need scaffolding (module
   layout, Postgres schema, build system, deployment scripts)
   before feature code can land. Without a mid-phase checkpoint,
   the user has to accept a long stretch of "trust me, this is all
   necessary" work before anything is visible.

3. **Each bullet has distinct value on its own.** Account creation
   works without the orderbook UI. Orderbook browse works before
   posting is wired. Each slice is individually shippable to a
   staging environment, which means the user can poke at real
   services and report issues mid-phase rather than at the end.

4. **The operator has now completed the Blurt account registration
   prerequisites.** `morphit` and `morphit-relay` exist on-chain as
   of 2026-04-18. This unblocks the relay subphase specifically —
   we can start it immediately rather than gate it behind user
   action.

## Decision

Phase 3 is split into three subphases, each producing a standalone
tarball:

- **Phase 3a — Relay + account creation.** Go relay service that
  accepts signed `account_create_with_delegation` ops from users and
  pays the Blurt RC cost. Client-side account-registration UI that
  collects a chosen Blurt account name, signs locally with the user's
  owner key via `useOwnerKey()`, hands the op to the relay, and
  activates the user's display-name broadcast flow. Exit criterion:
  a first-time user can onboard end-to-end and end up with a real
  Blurt account without Morphit ever holding their keys.

- **Phase 3b — Indexer + orderbook read.** Go indexer service that
  streams the Blurt chain and materializes Morphit ops into a
  queryable Postgres database. REST + RSS endpoints with the full
  filter set promised in the `rss_feeds` FAQ entry. SvelteKit
  orderbook route wired to live data. Peer-to-peer gossip between
  indexer instances (so the user's app has more than one data
  source). Exit criterion: a visitor can browse live orders on
  morphit.io, filter them, and subscribe to an RSS feed of
  matching orders — even before any orders exist to browse.

- **Phase 3c — Order posting + enforcement.** Client-side compose UI
  for new orders. `morphit_order_v1` + `morphit_order_replace_v1`
  ops with on-chain signing via `useActiveKey()` for BLURT fee
  payments. 3-minute replace-window enforcement at the indexer
  (per ADR-0001). Sybil fee logic (escalating-per-24h). Self-trade
  detection. Optional featured-slot auction. Exit criterion: a user
  can post an order and another user can see it; the fee path works
  for all three fee currencies (BTC / XMR / BLURT).

## Alternatives considered

### Single monolithic Phase 3

- **Pros:** less ADR bookkeeping; one tarball to track.
- **Cons:** no intermediate testability; 10+ turns of work with no
  user-facing deliverable until the end; any scope creep pushes the
  whole phase out; harder to roll back a problematic piece without
  unpicking unrelated work.
- **Rejected.**

### Split into two subphases (relay+account vs indexer+orderbook+post)

- **Pros:** only one mid-phase checkpoint to manage.
- **Cons:** the indexer-plus-post bundle is still 6+ turns and
  inherits the same "no intermediate testability" problem between
  them. Also conflates "read path works" with "write path works,"
  which are genuinely separate engineering concerns worth isolating.
- **Rejected.**

### Four+ subphases

- **Pros:** even finer granularity.
- **Cons:** diminishing returns. Relay and account-creation really
  do belong together (the relay exists to serve the account-creation
  flow and little else for now). Similarly, order posting and its
  enforcement/anti-abuse logic belong together — shipping posting
  without enforcement would be a live abuse vector on mainnet Blurt.
- **Rejected.**

## Consequences

### Positive

- Each subphase ends with a testable deliverable on staging.
- Scope creep in one subphase doesn't block the others from shipping.
- The user gets three opportunities to redirect the design mid-phase
  rather than one opportunity at the end.
- Go infrastructure scaffolding (module layout, Postgres wiring,
  build system) lands in 3a and is amortized across 3b and 3c.

### Negative

- Three tarball handoffs instead of one. Each has its own
  extract-and-review overhead for the user.
- Two `REVIEW-PHASE3a.md` / `REVIEW-PHASE3b.md` / `REVIEW-PHASE3c.md`
  documents instead of one. Disciplined but not hard.
- Subphase boundaries may need to move as reality pushes back.
  E.g., if the relay ends up smaller than expected, we might pull
  some indexer scaffolding into 3a. The three-phase structure is
  the plan, not a contract — an ADR-0006 can re-draw the lines if
  needed.

### Follow-up work

- `REVIEW-PHASE2.md` entries P2-1 (Blurt account registration)
  and the operator-action-items section in PLAN.md are now
  marked complete; 3a can reference those as done rather than
  blocking on them.
- Carry-forward item #11 from Phase 1 (self-hosting docs) lands
  in 3b, when the indexer is the first Go service users might
  want to self-host.
- Carry-forward items #16 (WhaleVault / Gravity) and the posting
  relay's owner-key-never-in-browser invariant interact in
  Phase 3a; the relay protocol must accept an externally-signed
  transaction blob so extension-based signing works out of the box.

## References

- Plan v1.3 §348 — original Phase 3 single-phase definition.
- ADR-0001 — `custom_json` replacement ops (3c enforcement).
- ADR-0002 — live keys policy (3a `useOwnerKey()` pattern).
- REVIEW-PHASE2.md — Phase-1/2 carry-forward items that land in
  each subphase.
