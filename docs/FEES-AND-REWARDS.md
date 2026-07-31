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

## Canonical money-flow policy (the forever rule)

This is the authoritative statement of **where listing-fee money
goes**.  Everything else in this document is mechanism; this
section is policy.  If mechanism and policy ever disagree, policy
wins and the mechanism is the bug.

**BLURT-paid listing fees:**

- On the **canonical instance** (morphit.io, using the
  `@morphit-relay` and `@morphit-fees` accounts): the canonical
  project receives **100%** of the BLURT fees paid on that
  instance.
- On a **federation instance**: the **federation owner receives
  90%** of the BLURT fees paid on their instance — into the Blurt
  account they configure (`MORPHIT_INDEXER_FEE_RECIPIENT`) — and
  the **canonical `@morphit-fees` receives the remaining 10%**.
- Federation owners can **set and edit** their fees account easily:
  via `morphit-ops edit` → **Fees account**, or by editing
  `MORPHIT_INDEXER_FEE_RECIPIENT` in the env file directly.
- If a federation owner sets an **invalid** Blurt account name, or
  **removes** it entirely, then **100% of that instance's BLURT
  fees fall back to the canonical fees account** (currently
  `@morphit-fees`).

The canonical project must **never lose its 10%** of federation
BLURT fees, and a federation instance must **not** be able to keep
that 10%.  (In an open-source federated system the default honest
code enforces this; a hostile fork that rewrites the split is
outside what any code can prevent — but such a fork is no longer
running Morphit.)

**BTC- and XMR-paid listing fees:**

- **100%** of *all* Bitcoin and Monero listing fees, from **every
  instance worldwide**, flow to the **canonical BTC/XMR accounts**.
  No federation split, no operator share.

**On-chain verification (shipped — Part 106, NOT future):** the
canonical BTC and XMR fee-receiving addresses are pinned on-chain in
the signed `morphit_release_v1` **treasury block** (the release-anchor
pattern), so anyone can verify them independently. When present, the
pin *authoritatively* declares those addresses: the post-order page
renders them with copy + QR, and every federated indexer uses them for
fee verification. The BLURT fee base is chain-pinned the same way
(`treasury.blurt.base`, cp372). The pin is optional per release and
carries only public information (address + memo policy) — see
`packages/release-schema/src/release.ts` (`ReleaseTreasuryBlock`) and
the Part 107 privacy invariant.

---

## Money INTO the operator (income)

These are the things users pay that flow into the operator's
fee-recipient account.

### 1. Listing fee — paid per posted order

- **Target: ~12.5¢ USD-equivalent when paid in BLURT** — half the
  ~25¢ BTC/XMR rate (a deliberate 50% discount for paying in the
  native token).  The USD targets are the **canonical source of
  truth** in `LISTING_FEE_USD` (`packages/asset-registry/src/index.ts`,
  inlined): `{ blurt: 0.125, btc: 0.25, xmr: 0.25 }`.  Both the
  frontend quote and the indexer validation import from there, so
  they cannot drift.  At BLURT ≈ $0.002 that's roughly 60–62 BLURT;
  the env default base is `125` BLURT.
- **Chain-pinned + auto-tracked (cp372).**  The enforced BLURT base
  — like the BTC/XMR amounts — comes from the most recent signed
  `morphit_release_v1` `treasury.blurt.base`, resolved chain-pin →
  env, so every federated indexer enforces the *same* floor (the
  last fee input that used to be per-node).  The *displayed* fee
  tracks the live canonical USD target; a maintainer timer
  (`morphit-treasury-repin.timer`) auto-re-pins the on-chain base as
  the market moves, with failsafes + a manual Plan B.  See
  `docs/OPERATIONS.md §40.3a`.
- Source: `apps/indexer/src/config/index.ts`
  (`MORPHIT_INDEXER_FEE_BASE_BLURT.default(125)` — now the Plan-B
  fallback/override), with the USD target in `@morphit/asset-registry`
- Sybil tier multiplier scales for prolific posters within 24h: the
  first **3 orders are 1×** (base), then the multiplier **compounds
  ×1.25 per order from the 4th through the 10th** (4th = 1.25×,
  5th ≈ 1.56×, 6th ≈ 1.95×, 7th ≈ 2.44×, 8th ≈ 3.05×, 9th ≈ 3.81×,
  10th ≈ 4.77×), and **×1.5 per additional order beyond the 10th**.
  See `apps/indexer/src/indexer/fee.ts` — `sybilMultiplier(nth)` /
  `expectedFeeBlurt(nth, base)`.
- User can also pay in BTC or XMR (operator-configured equivalent),
  see `apps/indexer/src/indexer/handlers/feeAttest.ts`.
- First-time waiver: free, buy-side only, once per account.  See
  `apps/web/src/lib/blurt/ops/order.ts` `fee_method='waived_first_buy'`.
- Memo: `morphit-fee:<order-permlink>` — binds the fee transfer to
  exactly one listing.

### 2. Cold-message fee — paid by strangers DMing for the first time

- **Default: 5 BLURT (~$0.01)**, escalates if abused
- Source: `apps/indexer/src/indexer/strangerFeePricing.ts`
  (`STRANGER_FEE_BASE_BLURT = 5`)
- Multiplier rises with `n` recent strangers contacted by the same
  sender; see `strangerFeePricing.computePrice(n)` for the curve.
- Idempotent — sender→recipient pair is UNIQUE; one fee per pair.

### 3. Featured-slot bid — paid to occupy a top-of-orderbook slot

- **Default: 50 BLURT/hour**, minimum 6 hours = 300 BLURT floor per bid
- Source: `apps/indexer/src/config/index.ts`
  (`MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR.default(50)`)
- Source: `apps/indexer/src/indexer/handlers/featureBid.ts`
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

## How listing fees split: owner vs canonical treasury

The BLURT fee is split **at payment time**, inside the very
transaction that carries the order op. There is no separate
"collect then forward" step.

### BLURT-paid listing fees: 90% to the instance owner, 10% to the canonical treasury

- The user's fee transaction carries **two transfers**: 90% to the
  instance's configured fee recipient (the owner's account,
  `MORPHIT_INDEXER_FEE_RECIPIENT`) and 10% to the canonical
  treasury (`@morphit-fees`). Both are signed by the same active
  authority in the one transaction.
- On the **canonical instance** (or when a federation owner's
  account is blank/invalid and falls back to canonical), both
  halves are the same account, so it collapses to a **single 100%
  transfer** to `@morphit-fees`.
- The canonical **10%** funds the ongoing development and
  maintenance of the Morphit software itself. (Welcome bonuses,
  loyalty delegations, and account-creation costs are NOT paid by
  the treasury — each operator funds those from their own relay
  account; see "Money OUT from the operator" below.)
- The split math is the shared `splitListingFeeBlurt`
  (`@morphit/asset-registry`), imported by BOTH the frontend that
  builds the fee transaction (`feeTransfersFor` in
  `apps/web/src/lib/orders/fee.ts`) and the indexer that verifies
  it (`sumFeeTransfers` / `canonicalShareOk` in
  `apps/indexer/src/indexer/fee.ts`), so the two can never drift.
  Shares are computed in integer milliBLURT and always sum back to
  the exact total.

### BTC- and XMR-paid listing fees: 100% to the canonical treasury, from every instance

- BTC/XMR fees land in cold-stored, canonical Morphit-controlled
  wallets, off the BLURT chain, and do NOT split — 100% goes to the
  canonical BTC/XMR accounts from every instance worldwide.
  Splitting them per-receipt would require a custodial off-chain
  bookkeeper (defeats the non-custodial design) or batch-and-convert
  (introduces exchange-rate risk and complexity).
- The generous 90/10 BLURT split is the compensating mechanism —
  operators whose users mostly pay in BLURT earn close to the full
  fee value.
- Source: `apps/indexer/src/indexer/handlers/order.ts` verifies the
  BLURT split; the BTC/XMR fee paths verify a single 100%-to-canonical
  transfer.

### Delivery mechanics — direct, at payment

Because the split happens in the user's own fee transaction, the
owner's 90% and the canonical 10% both land **immediately**, with
no relay forwarding and nobody trusted to remit a share afterward.
Total latency from the user clicking "Post" to BLURT landing in the
owner's account is one Blurt block (~3 seconds).

Per-order, in the same transaction that applies the order op, the
indexer also records **earnings attribution** for the operator
dashboard (audit only — the money already moved):

1. Insert an audit row in `operator_attribution_events` (UNIQUE on
   `trx_id` rejects replays), recording the fee, the owner's 90%
   share, and the canonical 10% share.
2. UPSERT `operator_earnings` running totals
   (`cumulative_blurt_earned`, `total_orders_attributed`).

No `relay_pending_transfers` row and no `operator_payouts` row are
written for the fee — the operator was already paid by the split.
(The relay still handles welcome bonuses + loyalty, unchanged.)

### Edge case: an operator paying a BLURT fee on their OWN instance

When the account signing a BLURT fee **is** the instance's own fee
recipient — most commonly an operator who **features their own
order**, but also a solo operator posting a listing with a BLURT
fee on their own instance — the 90% owner leg would be a transfer
from that account back to itself. Blurt (Graphene) **rejects a
self-transfer at consensus** (`from != to`), which would make the
whole transaction un-broadcastable.

**Settled policy (decided — this is the intended behavior, not a
bug):** in that case the fee collapses to a **single 100%-to-
canonical-treasury transfer**. The operator does **not** receive
the 90% owner share on a fee they pay to themselves — you cannot
pay yourself the operator cut. The indexer accepts this unchanged
(100% ≥ the required canonical 10%, and the total still meets the
fee floor). This is also a fair, mild disincentive against an
operator cheaply self-promoting their own listings for free.

This is implemented in `feeTransfersFor` (frontend `fee.ts`) via
the `signer` collapse and is pinned by a regression test
(`fee.test.ts` — "sends 100% to canonical when the owner recipient
IS the signer"). It applies to all three BLURT fee types (listing,
featured-slot, cold-message) whenever the signer is the recipient.

### Auditing per-operator earnings

```
GET /v1/operators/:tag
```

Returns `cumulative_blurt_earned` and `total_orders_attributed`.
Per-order earnings detail is in `operator_attribution_events`.

### What if the configured operator_tag doesn't match a
registered operator?

The fee **still splits** to the instance's fee recipient (90%) and
the canonical treasury (10%) — the split is driven by the
instance's configured `MORPHIT_INDEXER_FEE_RECIPIENT`, not by the
tag. The `operator_tag` only drives the earnings-dashboard
attribution, which is silently skipped for an unknown tag. A typo
or unregistered tag never blocks order posting and never misroutes
the money; it just omits the dashboard credit. Operators should
verify their `MORPHIT_INSTANCE_OPERATOR_TAG` matches their on-chain
registration after first config.

---

## Money OUT from the operator (costs and rewards)

### 1. Account creation — paid TO the Blurt chain when a user signs up

- **Cost: ~100 BLURT (~$0.20) per new user**, set by Blurt
  witness consensus (subject to change without notice on the
  chain side).
- Source: `apps/relay/src/config/index.ts`
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
- Source: `apps/indexer/src/indexer/handlers/feedback.ts`
  ```
  ($1, 'liquid',  10, 'welcome_bonus_liquid',  $2),
  ($1, 'vesting', 10, 'welcome_bonus_vesting', $2)
  ```
- Trigger: when the new user receives their first feedback row
  with a non-null `order_permlink`.  Once-per-account
  (idempotent UPSERT into `accounts.first_trade_complete_at`).
- Bonus is queued in `relay_pending_transfers`; the relay
  drainer picks it up and broadcasts the actual transfer.
- The "vesting" half is powered up into vested BLURT — a
  `transfer_to_vesting` op (the relay drainer's `kind: 'vesting'`
  branch calls `broadcastTransferToVesting`), so the recipient
  **owns** it; this is NOT a delegation (delegations are the
  separate `kind: 'delegation'` → `delegate_vesting_shares` path
  used by the 1-BP first-fee reward and the loyalty milestones
  below).  Vested BLURT earns the recipient BP (Blurt Power, the
  chain's voting/social weight token).  Vesting BLURT is still
  BLURT; it's just staked.  Roughly 10 BLURT vesting ≈ 13 BP at
  current ratios.
- Paid by the **relay** account, drawn from accumulated
  listing-fee revenue accumulated by the operator's relay
  balance.

### 3. First-fee welcome BP — separate, smaller welcome reward

- **1 BP delegated** on the user's first verified BLURT listing fee
- Source: `apps/indexer/src/indexer/loyalty.ts` line ~60
  (`FIRST_FEE_WELCOME_BP = 1`)
- Rationale documented at `loyalty.ts`: "real fee paid
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

- Source: `apps/indexer/src/indexer/loyalty.ts`
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
  DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, or XRP moving from seller's wallet to buyer's
  wallet): also direct.  Morphit doesn't proxy the transaction
  or see the keys.

The only way Morphit "sees" the trade is post-hoc: each party can
attest to what happened by leaving feedback on chain after the
fact.  That feedback IS visible.  But the money flow is not.

---

## Net economics for an operator at steady state

At the current calibration a single listing fee (125 BLURT)
already exceeds the cost of a new-user signup (~100 BLURT), so an
operator is net positive at roughly **1 listing fee per new user
signup**.

- Income per listing: 125 BLURT
- Cost per signup: ~100 BLURT
- 5 listings × 125 = 625 BLURT income
- 1 signup × 100 = 100 BLURT cost
- Net: +525 BLURT per (5-listing × 1-signup) cycle

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
`apps/indexer/src/indexer/handlers/order.ts` is exactly the
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
