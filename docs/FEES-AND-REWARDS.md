# Morphit fees and rewards — authoritative reference

This document is the **single source of truth** for every monetary
flow in Morphit.  Every figure here is grounded with a line-number
reference to the source file that defines it, so anyone (including
future contributors and AI assistants) can verify against the
actual configuration rather than relying on memory.

If you change a fee or reward in the codebase, you MUST update this
document at the same time — the diff should touch both files in one
commit.

> **The mental model that's easy to get wrong:**
> Account creation is the **operator's biggest cost**, not income.
> The user signs up for free.  The operator's relay account pays
> ~100 BLURT to the Blurt chain to create the new account on the
> user's behalf.  Don't put signup in the "income" column.

---

## Money INTO the operator (income)

These are the things users pay that flow into the operator's
fee-recipient account.

### 1. Listing fee — paid per posted order

- **Default: 60 BLURT (~$0.12 at BLURT ≈ $0.002)**
- Source: `apps/indexer/src/config/index.ts` line 395
  (`MORPHIT_INDEXER_FEE_BASE_BLURT.default(60)`)
- Sybil tier multiplier scales for prolific posters within 24h:
  4th order = 1×, 5th = 2×, 6th = 4×, 7th+ = 8×.  See
  `apps/indexer/src/indexer/fee.ts` for `expectedFeeBlurt(nth, base)`.
- User can also pay in BTC or XMR (operator-configured equivalent),
  see `apps/indexer/src/api/feeAttest.ts`.
- First-time waiver: free, buy-side only, once per account.  See
  `apps/web/src/lib/blurt/ops/order.ts` `fee_method='waived_first_buy'`.
- Memo: `morphit-fee:<order-permlink>` — binds the fee transfer to
  exactly one listing.

### 2. Cold-message fee — paid by strangers DMing for the first time

- **Default: 5 BLURT (~$0.01)**, escalates if abused
- Source: `apps/indexer/src/indexer/strangerFeePricing.ts` line 37
  (`STRANGER_FEE_BASE_BLURT = 5`)
- Multiplier rises with `n` recent strangers contacted by the same
  sender; see `strangerFeePricing.computePrice(n)` for the curve.
- Idempotent — sender→recipient pair is UNIQUE; one fee per pair.

### 3. Featured-slot bid — paid to occupy a top-of-orderbook slot

- **Default: 50 BLURT/hour**, minimum 6 hours = 300 BLURT floor per bid
- Source: `apps/indexer/src/config/index.ts`
  (`MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR.default(50)`)
- Source: `apps/indexer/src/indexer/handlers/featureBid.ts` line 61
  (`MIN_HOURS = 6` — the authoritative enforcement)
- The web side at `apps/web/src/lib/blurt/ops/featureBid.ts` does
  defensive input checks against the same values via comment-pinned
  constants (so a UI bug can't produce a malformed op), but the
  on-chain indexer is the trust boundary.
- Auctioned: highest-bidder takes the slot; earlier bidders' hours
  are NOT refunded (they bought "right to participate," not
  "guaranteed slot")

### Total income: only these three.  That's it.

---

## How listing fees split: operator vs treasury

When a user posts an order through an operator-branded
frontend (the post-form sends the operator's tag in the order
op's `operator_tag` field), the indexer attributes the listing
fee and splits it asymmetrically.

### BLURT-paid listing fees: 90% to operator, 10% to treasury

- **Operator: 90%** of the BLURT fee (immediate per-order
  payout — see "Payout mechanics" below).
- **Treasury: 10%** retained to fund welcome bonuses, loyalty
  milestone delegations, and account-creation costs.
- Source: `apps/indexer/src/indexer/operatorEarnings.ts`
  `OPERATOR_BLURT_SPLIT_PERCENT = 90`
- Computed in milli-BLURT integer arithmetic with floor
  rounding so the operator never receives more than their
  exact share — sub-precision residuals (≤0.001 BLURT) flow
  to the treasury.

### BTC- and XMR-paid listing fees: 100% to treasury, 0% to operator

- The Blurt chain's payout mechanism splits BLURT atomically
  per-receipt. BTC/XMR fees land in cold-stored Morphit-
  controlled wallets, off the BLURT chain. Splitting BTC/XMR
  per-receipt would require a custodial off-chain bookkeeper
  (defeats the non-custodial design) or batch-and-convert
  (introduces exchange-rate risk and operational complexity).
- The aggressively generous 90/10 BLURT split is the
  compensating mechanism — operators whose users mostly pay
  in BLURT (the loyalty-milestone-rewarded path) earn close
  to the full fee value.
- Source: `apps/indexer/src/indexer/handlers/order.ts` calls
  the attribution module ONLY from the BLURT-verified fee
  branch.

### Payout mechanics — immediate, not periodic

Per-order, in the same transaction that the indexer applies
the order op:

1. Insert audit row in `operator_attribution_events` (UNIQUE
   on `trx_id` rejects replays).
2. Queue a `relay_pending_transfers` row with the operator's
   90% share. Reason field embeds the originating `trx_id`
   for traceability.
3. Insert audit row in `operator_payouts` linking attribution
   event ↔ relay row.
4. UPSERT `operator_earnings` with running totals.

The relay drainer (already running for welcome bonuses) picks
up the queued row on its next cycle (~5-10 seconds) and
broadcasts a `transfer` op from `morphit-relay` to the
operator's account. Total latency from user clicking "Post"
to BLURT landing in the operator's wallet: typically 10-15
seconds.

This works because Blurt has 3-second blocks and effectively
no per-transfer fee (mana-based). Periodic batching would
delay operator gratification by up to a week without any
real cost saving.

### Auditing per-operator earnings

```
GET /v1/operators/:tag
```

Returns `cumulative_blurt_earned`, `lifetime_paid_blurt`,
`total_orders_attributed`, `last_payout_at`, and
`last_payout_blurt`. Per-attribution detail is in
`operator_attribution_events`; per-payout detail in
`operator_payouts`.

### What if the configured operator_tag doesn't match a
registered operator?

Silent no-op. Order goes through, fee transfers to treasury
in full, no attribution credited. This is the right failure
mode: a typo or unregistered tag never blocks order posting,
just forfeits the operator share. Operators should verify
their `MORPHIT_INSTANCE_OPERATOR_TAG` matches their on-chain
registration after first config.

---

## Money OUT from the operator (costs and rewards)

### 1. Account creation — paid TO the Blurt chain when a user signs up

- **Cost: ~100 BLURT (~$0.20) per new user**, set by Blurt
  witness consensus (subject to change without notice on the
  chain side).
- Source: `apps/relay/src/config/index.ts` line ~166–236
  (operator-tunable mirror of chain `account_creation_fee`)
- Source: `apps/relay/src/blurt/client.ts`
  `broadcastAccountCreate()` — the relay's active key signs and
  the relay's BLURT balance pays.
- **The user pays NOTHING.**  Signup is free.  The relay absorbs
  this as a cost of doing business.
- Sybil defenses: invite tokens (PoW-gated after N/day per IP),
  IP-spacing, global daily ceiling.  See
  `apps/relay/src/api/invite.ts`.

### 2. Welcome bonus — paid to new users on their first completed trade

- **20 BLURT total: 10 BLURT liquid + 10 BLURT vesting**
- Source: `apps/indexer/src/indexer/handlers/feedback.ts` lines 365–366
  ```
  ($1, 'liquid',  10, 'welcome_bonus_liquid',  $2),
  ($1, 'vesting', 10, 'welcome_bonus_vesting', $2)
  ```
- Trigger: when the new user receives their first feedback row
  with a non-null `order_permlink`.  Once-per-account
  (idempotent UPSERT into `accounts.first_trade_complete_at`).
- Bonus is queued in `relay_pending_transfers`; the relay
  drainer picks it up and broadcasts the actual transfer.
- The "vesting" half delegates to vested BLURT, which earns
  the recipient BP (Blurt Power, the chain's voting/social
  weight token).  Vesting BLURT is still BLURT; it's just
  staked.  Roughly 10 BLURT vesting ≈ 13 BP at current ratios.
- Paid by the **relay** account, drawn from accumulated
  listing-fee revenue accumulated by the operator's relay
  balance.

### 3. First-fee welcome BP — separate, smaller welcome reward

- **1 BP delegated** on the user's first verified BLURT listing fee
- Source: `apps/indexer/src/indexer/loyalty.ts` line ~60
  (`FIRST_FEE_WELCOME_BP = 1`)
- Rationale documented at `loyalty.ts` lines 41–55: "real fee paid
  → not a Sybil farm" + baseline ecosystem stake.
- Independent from the 20-BLURT welcome bonus above; both can fire
  on the same account.

### 4. Loyalty milestones — BP delegated as the user pays cumulative fees

| Cumulative BLURT in fees | BP rewarded |
|---|---|
| 100 BLURT  | 10 BP   |
| 500 BLURT  | 50 BP   |
| 2,000 BLURT  | 200 BP  |
| 10,000 BLURT | 1,000 BP |
| **Total at top tier** | **1,260 BP** |

- Source: `apps/indexer/src/indexer/loyalty.ts` lines 25–33
  (`LOYALTY_MILESTONES` constant array)
- Tracked by **cumulative BLURT-denominated fees paid**, NOT trade
  count.  A user paying high fees crosses milestones faster.
- Each milestone fires once per account, idempotent via UNIQUE
  `(account, milestone_blurt)` constraint on
  `account_loyalty_milestones`.
- Paid by the **relay** account as a delegate_vesting_shares op.

### 5. Witness/chain fees — tiny operational cost on every broadcast

- The Blurt chain charges a sub-cent BLURT fee per transaction
  signed by the relay (welcome bonus, loyalty BP, account
  creation).
- Built into the cost of running a node; not separately
  trackable per-transaction.

---

## Money that NEVER touches Morphit (the trade itself)

This is what makes Morphit non-custodial:

- **The actual buyer↔seller trade**: cash, bank transfer, PayPal,
  Wise, Cash App, etc.  Goes directly between the two parties.
  Morphit cannot see this, cannot intervene, cannot pause it.
- **The crypto leg of the trade** (BTC, XMR, BLURT, USDT, USDC,
  DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, or ETH moving from seller's wallet to buyer's
  wallet): also direct.  Morphit doesn't proxy the transaction
  or see the keys.

The only way Morphit "sees" the trade is post-hoc: each party can
attest to what happened by leaving feedback on chain after the
fact.  That feedback IS visible.  But the money flow is not.

---

## Net economics for an operator at steady state

To break even on chain costs, an operator needs roughly
**5 listing fees for every 1 new user signup**.

- Income per listing: 60 BLURT
- Cost per signup: ~100 BLURT
- 5 listings × 60 = 300 BLURT income
- 1 signup × 100 = 100 BLURT cost
- Net: +200 BLURT per (5-listing × 1-signup) cycle

Welcome bonuses paid out (20 BLURT × users who actually trade)
come from the same revenue pool.  Loyalty BP delegations are
"free" from a BLURT cash-flow standpoint — BP comes from staking
existing BLURT in the relay account, not from spending it.

Real-world numbers will diverge from steady-state averages.  The
operator-balance scanner (see `OPERATIONS.md §16`) alerts before
the relay's BLURT balance approaches zero so the operator can
top up.  Auto-top-up via Cash-style in-app payment is in design
but not shipped.

---

## The flowchart

The visual reference is at `apps/web/static/brand/morphit-fee-flow.svg`.

**If you spot a discrepancy between this document and the
flowchart, the source code wins** — both should be re-derived
from `apps/indexer/src/config/index.ts`,
`apps/indexer/src/indexer/handlers/feedback.ts`,
`apps/indexer/src/indexer/loyalty.ts`, and
`apps/indexer/src/indexer/strangerFeePricing.ts`.

---

## When fees and rewards are operator-tunable

Almost everything documented here has a default value and an
env-var override.  The key file is
`apps/indexer/src/config/index.ts` (search for the relevant
`MORPHIT_INDEXER_*` env var).  Tunables:

- `MORPHIT_INDEXER_FEE_BASE_BLURT` (listing fee base)
- `MORPHIT_INDEXER_FEE_TOLERANCE` (how much the user can underpay)
- `MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR`
- `MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT` (chain fallback)
- `MORPHIT_INDEXER_FEE_RECIPIENT` (the account that gets paid)

The welcome bonus amounts (10 BLURT liquid, 10 BLURT vesting),
loyalty tier thresholds, and stranger-fee base (5 BLURT) are
currently hardcoded constants — making them env-tunable is a
post-launch refactor.  See `docs/REVISIT-LIST.md` if a tunable
is needed for your operator setup.

---

## What is FROZEN — fees cannot be paid in new assets

The set of assets that may pay listing fees is permanently
fixed at **BLURT, BTC, XMR**.  This is a wire-format-frozen
invariant, NOT a configuration knob.  The indexer's
`fee_method` enum at
`apps/indexer/src/indexer/handlers/order.ts:94` is exactly the
4-member set `'blurt' | 'waived_first_buy' | 'btc' | 'xmr'`,
and the asset registry enforces the rule that
`canPayListingFee: true → ticker ∈ {BLURT, BTC, XMR}`.

This applies to all fee surfaces, not just listing fees:

| Fee surface              | Allowed payment assets         |
| ------------------------ | ------------------------------ |
| Listing fee              | BLURT, BTC, XMR                |
| Stranger / cold-message  | BLURT only                     |
| Featured-slot bid        | BLURT only                     |
| Account creation cost    | BLURT (operator's relay pays)  |

**New tradable assets added to Morphit (USDT, ARRR, future
additions) are peer-to-peer TRADING ONLY.**  Users can post
"buy BLURT for USDT" or "sell USDT for cash" orders; the
listing fee for those orders is still paid in BLURT (or BTC or
XMR), not in USDT.

The first-buy waiver (free first BLURT-buy) fires on
`(side='buy', asset='BLURT')` regardless of what the buyer
pays the seller with.  A new user buying their first BLURT and
paying their counterparty in USDT or fiat still gets the
waiver — the waiver covers the LISTING FEE (which is paid in
BLURT or waived entirely), not the trade settlement currency.

Two sentinel-grep smokes guard this invariant in CI:
- `packages/asset-registry/scripts/fee-method-enum-frozen-smoke.ts`
- `packages/asset-registry/scripts/first-buy-waiver-payment-agnostic-smoke.ts`

If either smoke fails, the wire-format enum or the waiver gate
has drifted and the project's fee-payment model is no longer
what this document describes.  Treat such failures as
charter-level decisions, not routine PR adjustments.

---

*Document created 2026-05-02 in response to user-flagged factual
errors in an earlier flowchart.  Updated 2026-05-13 (Part 121)
with the trade-only-assets invariant.  Authority: this document
supersedes any conflicting figure in chat history, prompts, or
older docs.*
