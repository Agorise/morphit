# ADR-0011 — Dynamic fee model, multi-asset fees, and user incentives

**Status:** Accepted (Phase 4)
**Date:** 2026-04-19
**Deciders:** project maintainer
**Supersedes:** supersedes parts of ADR-0009 (fee model)
**Superseded by:** none
**Related:** ADR-0010 (key custody), ADR-0009 (order posting)

> **2026-05-13 forward note (Part 121 — fee_method enum
> frozen):** the `fee_method` field type union described
> throughout this ADR — `'blurt' | 'waived_first_buy' | 'btc' |
> 'xmr'` — is now a **wire-format-frozen invariant**, not a
> configuration knob.  Per memory #23 (2026-05-13): listing fees
> can ONLY be paid in BLURT, XMR, or BTC.  New tradable assets
> added to Morphit (USDT, ARRR, etc.) are peer-to-peer TRADING
> ONLY — they get `canPayListingFee: false` in the asset registry
> and never appear in the `fee_method` enum.  Two sentinel-grep
> smokes guard the invariant in CI:
> `packages/asset-registry/scripts/fee-method-enum-frozen-smoke.ts`
> and
> `packages/asset-registry/scripts/first-buy-waiver-payment-agnostic-smoke.ts`.
> If either fails, the wire format or waiver gate has drifted and
> this ADR's fee-method assumptions no longer hold — treat such
> failures as charter-level decisions, not routine PR
> adjustments.  See `docs/FEES-AND-REWARDS.md` §"What is FROZEN"
> and `docs/ADDING-A-COIN.md` §"2026-05-13 architectural update"
> for the full rationale.

> **2026-06-27 forward note (cp370 — canonical economics
> source of truth):** the USD figures this ADR describes — the
> ~$0.25 BTC/XMR listing fee, the ~$0.125 (50%-discounted) BLURT
> listing fee, the $1 first-order minimum, and the Sybil
> multipliers — are now hardcoded in ONE place:
> `packages/asset-registry/src/index.ts` (the canonical economics
> was briefly factored into an `economics.ts` at cp370 but
> RE-INLINED into `index.ts` the same session — the package is
> consumed as raw source by the built mcp-server, which plain-Node
> ESM resolution requires to be a single self-contained file)
> (`LISTING_FEE_USD`, `FIRST_ORDER_MIN_USD`, `FEE_PRICE_TOLERANCE`,
> `FEE_FALLBACK`, and the `listingFee*` derivation helpers),
> imported by both the frontend (quote) and the indexer
> (validation) so the two cannot drift.  The
> `economics-canonical-smoke.ts` locks the numbers + the
> 50%-BLURT-discount invariant + black-hat garbage-price
> handling.
>
> **2026-06-27 forward note (cp372 — live tracking + chain-pinned
> BLURT base shipped):** the deferral below is now RESOLVED.  cp372
> built the BTC/XMR USD price subsystem (multi-source averaging +
> feed-health), made the *displayed* listing fee track the live
> canonical USD target (Model-A Option 1), chain-pinned the BLURT
> base in the `morphit_release_v1` `treasury.blurt.base` (so the
> BLURT floor is deterministic across the federation like BTC/XMR),
> and added an automated auto-re-pin (maintainer timer, failsafes, a
> manual Plan B) that keeps the on-chain amounts on their USD
> targets.  The enforced amount stays a fixed chain-pin (no price
> read in the verifier → no fork, no quote→pay race);
> `FEE_PRICE_TOLERANCE` absorbs the drift between re-pins.  See the
> cp372 entries in TARBALL.md / docs/REVISIT-LIST.md and
> `OPERATIONS.md §40.3a`.

## Context

ADR-0009 established Morphit's order-posting fee model:

- Flat $0.25 base listing fee per order
- Sybil escalation: 1× / 1× / 1.25× / 1.5× / ... based on prior
  order count in the last 24h
- Fee paid exclusively in BLURT via a `transfer` op sibling to
  the order's custom_json

Several decisions from Phase 4 planning require extending this
model:

1. **Grandma's first order is free** (buy-only, one per
   account) to onboard users with no crypto.
2. **Witness fees are not constant.** The `account_creation_fee`
   (currently 100 BLURT) is witness-controlled. If witnesses
   raise it, Morphit's unit economics break. Listing fees must
   auto-adjust to preserve margin.
3. **Multi-asset fee payment.** Users should be able to pay
   Morphit's listing fee in BLURT, BTC, or XMR. BLURT is the
   default.
4. **BLURT payment incentives.** 50% discount for BLURT-paid
   fees. Sybil tier escalation only applies to BLURT payments
   (flat tier-1 for BTC/XMR). Loyalty BP rewards at cumulative-
   BLURT milestones.
5. **Cross-fee interaction with delayed welcome bonus.** ADR-
   0010 delays the 10 BLURT liquid + 10 BLURT Power welcome bonus until the
   user's first successful trade, defined as the first
   `morphit_feedback_v1` submission from a counterparty (NOT
   the user themselves) on an order the user posted.  Self-
   feedback can't trigger the bonus — that would defeat the
   anti-grifting design.

This ADR specifies how all five interact.

## Important scope note: MVP vs. future

The FULL design below (multi-asset fees, witness fee polling,
loyalty milestones) represents the end-state. Implementation
sub-phases within Phase 4:

- **Sub-phase 4a (MVP):** BLURT-only fees, witness fee polling,
  first-order-free-for-BUY, delayed welcome bonus.
- **Sub-phase 4b:** Multi-asset fees (BTC/XMR fee verification),
  BLURT discount mechanics, tier escalation restriction.
- **Sub-phase 4c:** Loyalty milestones and BP reward payouts.

Each sub-phase is a shippable increment. The ADR defines the
contract; the sub-phases stage the delivery.

## Decision

### 1. Dynamic listing fee formula

The base USD-denominated listing fee is recomputed dynamically
from chain state:

```
base_fee_blurt = account_creation_fee_blurt × amortization_factor
                 + operational_margin_blurt

listing_fee_usd = base_fee_blurt × blurt_usd_price
```

Where:

- **account_creation_fee_blurt** — current witness-set value,
  polled hourly from `get_chain_properties`. Morphit caches the
  last observed value + timestamp.
- **amortization_factor** — how much of a new user's account-creation cost
  each listing pays toward. At a factor of 0.5, 2 listings
  amortize one full account-creation fee. At 1.0, every listing pays for one
  in full — suitable if most listings come from new users.
  Operator-configurable; default 0.5.
- **operational_margin_blurt** — Morphit's unit profit per
  listing. Operator-configurable; default ~25 BLURT so that at
  100-BLURT account-creation cost and factor 0.5, a listing covers 50 BLURT
  of that cost + 25 BLURT margin + some buffer ≈ $0.15 cost + $0.10
  margin = $0.25 listing fee.
- **blurt_usd_price** — price feed (Klingex via ADR-0004 + phase
  4 implementation). When unavailable, the indexer falls back
  to $0.002 and logs a warning.

The indexer republishes the current `listing_fee_blurt` via
`/v1/listing-fee` hourly (or whenever witness fees change),
and the frontend fetches it on the compose page to quote the
user. A user's quote has a **5-minute TTL**; if they delay past
5 minutes, the frontend re-fetches.

### 2. Payment-asset options

The user chooses one of three fee assets at compose time:

**BLURT (default):**
- Paid via a `transfer` op sibling to the order's custom_json
  (as today in ADR-0009).
- Recipient: `@morphit-fees`.
- Memo: `morphit-fee:<permlink>` (unchanged from ADR-0009).
- **50% discount applied.** User pays
  `listing_fee_blurt / 2`.
- **Sybil tier escalation applies** (1× / 1× / 1.25× / 1.5× /
  ... on prior BLURT-paid orders in last 24h).
- **Counts toward cumulative BLURT fee loyalty tracking.**

**BTC:**
- Paid via on-chain Bitcoin transaction to Morphit's BTC fee
  address.
- No sibling op on Blurt — payment happens out-of-band.
- User declares `fee_method: "btc"` in their order's
  custom_json payload and includes the Bitcoin transaction ID
  they used as `fee_external_txid`.
- **Verification via public block explorer.** The indexer queries
  a public explorer (blockchain.info, blockstream.info, or a
  configured alternative) to confirm the declared txid sent at
  least the expected amount to Morphit's BTC address.
- **If explorer verification fails or the explorer is
  unavailable**, the fee is NOT auto-verified. The order enters
  `fee_status = "pending_external"` and both parties (the order
  poster and their counterparty on the first matched trade) can
  collectively attest via a `morphit_fee_attest_v1` custom_json
  op that the fee payment occurred. Two independent attestations
  flip the status to `"verified_by_attestation"`. This is the
  manual fallback for degraded explorer availability.
- **No discount, flat full price.**
- **No Sybil tier escalation — flat tier-1.**
- **Does NOT count toward BLURT loyalty tracking.**

**XMR:**
- Same structure as BTC but via Monero. User sends to
  Morphit's XMR subaddress; declares `fee_method: "xmr"` and a
  transaction ID + optional tx_key (Monero's receive-side
  proof mechanism).
- **Verification via public explorer** (xmrchain.net or
  configured alternative). Monero's view-key/tx-key proof
  mechanism lets an external explorer confirm a transfer
  landed at a specific address without revealing wallet
  balances.
- **If explorer verification fails**, the same two-party
  attestation fallback applies as for BTC.
- Same economics as BTC (no discount, flat tier-1, no loyalty
  credit).

**Rationale for external explorers over self-hosted nodes:**
Morphit deliberately does not operate Bitcoin or Monero nodes.
Running those nodes would expand the operational surface
significantly (disk, bandwidth, sync time, reorg handling, key
management for Monero). Public explorers provide read-only
verification at zero infrastructure cost. The two-party
attestation fallback closes the availability gap — if the
explorer is unreachable, mutual user confirmation substitutes.

**Rationale for the BLURT-favored economics:** Morphit benefits
from BLURT circulation in the ecosystem. BLURT payments are
cheaper to verify (single-chain, existing tooling), grow the
Blurt economy, and align our users with the platform. BTC/XMR
are accepted for users who don't want to deal with BLURT, but
with worse economics to nudge preference.

### 3. Fee-verification interface (abstraction)

The indexer defines a `FeeVerifier` interface with one
implementation per fee method:

```typescript
interface FeeVerifier {
  /** Given an order's declaration and context, verify that
   *  the fee was paid correctly. Returns 'verified', 'missing',
   *  'underpaid', or 'pending' (for off-chain methods where
   *  payment may arrive within a grace period). */
  verify(order: Order, context: VerificationContext): Promise<FeeStatus>;
}
```

Implementations:
- `BlurtFeeVerifier` — reads sibling ops as today (ADR-0009).
  Shipped in sub-phase 4a.
- `BitcoinExplorerFeeVerifier` — queries a public Bitcoin
  explorer (configurable: blockchain.info / blockstream.info /
  mempool.space). Shipped in sub-phase 4b.
- `MoneroExplorerFeeVerifier` — queries a public Monero
  explorer (configurable: xmrchain.net / localmonero.co).
  Uses Monero's tx-key proof mechanism for confirmation.
  Shipped in sub-phase 4b.
- `AttestationFeeVerifier` — flips orders from
  `pending_external` to `verified_by_attestation` when two
  independent `morphit_fee_attest_v1` ops are observed.
  Shipped in sub-phase 4b alongside BTC/XMR.

The dispatcher routes to the right verifier based on the
order's declared `fee_method`. Orders with unknown or missing
`fee_method` default to BLURT (backward-compat with ADR-0009
orders).

**New op: `morphit_fee_attest_v1`** — a custom_json op with
payload `{"order_permlink": "...", "order_account": "..."}`.
Signed with posting authority. An order in `pending_external`
requires exactly two attestations from distinct accounts —
the poster and their counterparty on the first matched trade
— before transitioning to `verified_by_attestation`.

Counterparty identification: the first `morphit_feedback_v1`
submission against the order identifies the counterparty. A
subsequent `morphit_fee_attest_v1` from either the poster or
that specific counterparty counts as an attestation. This
prevents grifting by self-attestation: the order poster alone
cannot flip their own fee to verified.

### 4. First-order-free for BUY

Once per account, the first order the account posts may be a
BUY order with **`fee_method: "waived_first_buy"`**. The
indexer verifies:

1. The account has no prior orders in the indexer's `orders`
   table.
2. The order's `side` is `"buy"`.
3. The `fee_method` field is exactly `"waived_first_buy"`.

If all three pass, the order is marked `fee_status: "verified"`
and becomes live. The `accounts` table gains a column
`first_buy_waived_at TIMESTAMPTZ` recording when the waiver was
used, preventing re-use.

If conditions fail (wrong side, not first order, etc.) — the
order is rejected with `reject_reason: "waiver_invalid"`.

**New-user indicator:** an account with low rep (the
trustworthy `feedback_count < 4` per the orderbook
endpoint's sock-puppet-filtered count) is marked with
an `is_new_trader: true` field in `/v1/orderbook`
responses.  The frontend renders these with the 🌱 sprout
chip and gentle pulse animation per the project owner's
UI direction.  As trustworthy feedback accumulates, the
flag clears at the count-≥4 threshold.

### 5. Witness fee polling

The indexer runs an hourly job:

1. Call Blurt RPC `database_api.get_chain_properties`.
2. Extract `account_creation_fee.amount` (in BLURT).
3. If the value differs from the last cached value, log the
   change, update the cache, recompute `listing_fee_blurt`,
   and **emit an operator alert** (webhook or structured log
   entry consumable by the operator's monitoring stack).
4. Update the indexer's `/v1/listing-fee` response.

If the RPC call fails, the indexer retains the last known fee
and retries on the next hourly tick. Operator alerted after 3
consecutive failures.

**Operator alert format** — structured log record, parseable by
syslog, discord webhook, jq pipeline, or email extract. Text-sink
form (dev / default journalctl):

```
[witness-fee] fee_changed old_blurt=100 new_blurt=150 observed_at=2026-04-19T12:00:00.000Z
```

JSON-sink form (`MORPHIT_LOG_FORMAT=json`):

```json
{"ts":"2026-04-19T12:00:00.000Z","level":"warn","module":"witness-fee",
 "event":"fee_changed","context":{"old_blurt":100,"new_blurt":150,
 "observed_at":"2026-04-19T12:00:00.000Z"}}
```

Operator has discretion to adjust `operational_margin_blurt` or
`amortization_factor` if the new economics change the margin
strategy. No automatic parameter changes beyond the formula
recomputation.

### 6. Sybil tier escalation — BLURT-only

ADR-0009's tier system (1× / 1× / 1.25× / 1.5× / 1.75× / 2×)
applies ONLY when computing BLURT fees. It escalates based on
the user's count of **BLURT-paid orders in the last 24h**, not
total orders across all fee methods.

A user who pays 10 orders in 24h with BTC remains tier-1 for
their 11th order. If that 11th order pays in BLURT, it is
tier-1 (first BLURT order in window). If they THEN switch to
BLURT for subsequent orders, each counts toward the tier.

This protects the BLURT-paying active user from being penalized
for mixed-method usage. BTC/XMR payments are simply flat-priced.

### 7. Cumulative BLURT loyalty tracking

Each time a user pays a listing fee in BLURT, the indexer adds
the amount to a running per-account cumulative. Milestones
trigger a BP reward from `@morphit-relay`:

| Cumulative BLURT fees | BP reward | Approx. spend |
|-----------------------|-----------|---------------|
| 100 BLURT | 10 BP | $0.20 |
| 500 BLURT | 50 BP | $1.00 |
| 2,000 BLURT | 200 BP | $4.00 |
| 10,000 BLURT | 1,000 BP | $20.00 |

These values are placeholders; operator can adjust via config
without an ADR change. The schema supports arbitrary thresholds
configured at startup.

**Implementation:** a new `account_loyalty` table tracks:
- `account` (pk)
- `cumulative_fees_blurt` (total BLURT fees ever paid)
- `last_milestone_blurt` (the most recent milestone threshold
  crossed)

When processing a BLURT fee payment, indexer updates
`cumulative_fees_blurt`. If the new total crosses a configured
milestone threshold higher than `last_milestone_blurt`, the
indexer triggers a reward: relay sends BP via
`transfer_to_vesting` from `@morphit-relay` to the user.

Triggering happens via the same delayed-bonus mechanism as the
welcome reward (ADR-0010 §2 step 6): the indexer writes a row
to `relay_pending_transfers`; the relay polls that table and
broadcasts the transfer on its next active-key session.

**Risk:** loyalty rewards are real BLURT paid by Morphit.
Operator-configurable thresholds + BP amounts let us tune the
program to match revenue. Default values above assume an active
user who pays ~10,000 BLURT in fees ($20) gets ~$2 of BP back
over their journey — 10% of spend. Adjust as data warrants.

### 8. Delayed welcome bonus — per ADR-0010

When the indexer processes a `morphit_feedback_v1` op where:
- The feedback is from a counterparty (not the user themselves)
- The subject is a user who has `first_trade_complete_at IS
  NULL` in their `accounts` row
- The feedback references an order the subject posted

Then the indexer:
1. Sets `accounts.first_trade_complete_at` to the block
   timestamp.
2. Writes a row to `relay_pending_transfers`:
   - 10 BLURT liquid via `transfer`
   - 10 BLURT via `transfer_to_vesting` (staked as BP)
3. The relay polls this table on its next session and executes
   both transfers in one transaction.

**Why the relay polls instead of the indexer pushing:** the
relay has the active key; the indexer does not. Keeping the
active-key operations in the relay's purview maintains the
key-custody boundary from ADR-0010.

### 9. Schema migration v4

New/modified tables:

```sql
-- Track first-trade completion + first-buy-waiver per account.
ALTER TABLE accounts
    ADD COLUMN first_buy_waived_at TIMESTAMPTZ,
    ADD COLUMN first_trade_complete_at TIMESTAMPTZ;

-- Cumulative BLURT fee tracking for loyalty milestones.
CREATE TABLE account_loyalty (
    account TEXT PRIMARY KEY,
    cumulative_fees_blurt NUMERIC NOT NULL DEFAULT 0,
    last_milestone_blurt NUMERIC NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL
);

-- Queue of pending transfers the relay should execute. The
-- relay polls this table during its active-key session and
-- clears rows as it broadcasts.
CREATE TABLE relay_pending_transfers (
    id BIGSERIAL PRIMARY KEY,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('liquid', 'vesting')),
    amount_blurt NUMERIC NOT NULL,
    reason TEXT NOT NULL, -- 'welcome_bonus', 'loyalty_milestone', 'dust_refill', etc.
    created_at TIMESTAMPTZ NOT NULL,
    broadcast_at TIMESTAMPTZ,
    broadcast_trx_id TEXT
);
CREATE INDEX relay_pending_transfers_unbroadcast_idx
    ON relay_pending_transfers (created_at)
    WHERE broadcast_at IS NULL;

-- Record of witness-fee changes Morphit has observed.
CREATE TABLE witness_fee_history (
    observed_at TIMESTAMPTZ NOT NULL,
    account_creation_fee_blurt NUMERIC NOT NULL,
    PRIMARY KEY (observed_at)
);
```

### 10. Payload schema extensions

`morphit_order_v1` gains an optional `fee_method` field:

```json
{
  "permlink": "...",
  "side": "buy",
  "asset": "BTC",
  "...": "...",
  "fee_method": "blurt" | "btc" | "xmr" | "waived_first_buy"
}
```

Default if omitted: `"blurt"` (back-compat with ADR-0009).

For BTC/XMR, additional fields are required:

```json
{
  "...": "...",
  "fee_method": "btc",
  "fee_external_txid": "<bitcoin tx id>"
}
```

The indexer's verifier for the chosen method uses these fields
to locate the payment.

## Alternatives considered

### Keep a fixed listing fee indefinitely

**Rejected.** Witness fee changes would silently destroy
Morphit's margin. Dynamic tracking is table-stakes.

### Morphit runs its own price oracle

**Rejected.** Out of scope. Klingex polling (ADR-0004 + Phase 4
implementation) is sufficient.

### Accept fees in any ERC-20 / cross-chain token

**Rejected.** BTC and XMR cover the main privacy-focused
crypto users. Additional assets expand verifier complexity
without user demand evidence.

### Charge small upfront registration fees instead of amortizing account-creation cost across listings

**Rejected per ADR-0010.** Grandma has no crypto at signup.

### Pre-purchased vouchers from community services (e.g., blurtplugin.online)

**Rejected.** Would make Morphit dependent on a third-party
service for its core registration flow. We create accounts
ourselves via `account_create`.

## Consequences

### Positive

- Fee economics auto-adjust to witness changes; Morphit always
  profits on each registration.
- BLURT becomes the preferred fee asset via explicit discount
  and Sybil tier benefit — grows the Blurt ecosystem.
- Loyalty program rewards long-term users with BP, staking them
  further into Morphit.
- First-order-free-for-BUY onboards zero-crypto users cleanly.
- BTC/XMR fee payment removes the "you must hold BLURT" barrier
  for privacy-maximalist users.

### Negative

- **Multi-asset fee verification depends on public block
  explorers for BTC and XMR.** Morphit does not run those
  nodes, so verification is only as reliable as the explorer
  APIs we consult. When explorers are degraded, orders enter
  `pending_external` and require two-party attestation to
  verify. This is a UX tax on BTC/XMR payers.
- Loyalty BP payouts consume BP voting mana from `@morphit-
  relay`. Needs monitoring; if abused, the relay's mana runs
  dry and the rewards pause until regen.
- The `relay_pending_transfers` table creates a queue the relay
  must drain. If the relay is down for a week, users don't
  receive their bonuses until it comes back up. Deferred, not
  lost.
- Listing-fee quote TTL introduces a minor UX wrinkle: a user
  who pauses for 6 minutes during compose may see a slightly
  different fee when they resume.
- The two-party attestation path is attackable if a poster
  colludes with their counterparty to falsely attest payment.
  But doing so requires successfully completing a real trade
  (the counterparty is identified by feedback submission), so
  the attacker cost is the same as for any trade-level fraud.
  The attestation doesn't meaningfully lower the attack bar.

### Neutral

- The witness fee change history is preserved for operator
  auditing.
- Sub-phase structure (4a, 4b, 4c) means BLURT-only fees are
  the initial behavior. Users will know this is MVP; BTC/XMR
  payment arrives later.

## Implementation plan (per sub-phase)

**Sub-phase 4a — MVP (2-3 turns):**
- Migration v4 (accounts cols + relay_pending_transfers +
  witness_fee_history; skip account_loyalty for now)
- Witness fee polling
- Dynamic listing fee formula + `/v1/listing-fee` endpoint
- First-order-free-for-BUY indexer logic
- `fee_method: "waived_first_buy"` handler path
- Delayed welcome bonus trigger (on feedback submission)
- `relay_pending_transfers` queue writer (indexer side)
- Relay polling the queue and broadcasting

**Sub-phase 4b — BTC/XMR fees (2-3 turns):**
- `FeeVerifier` interface refactor
- `BitcoinExplorerFeeVerifier` (blockchain.info / blockstream.info)
- `MoneroExplorerFeeVerifier` (xmrchain.net with tx-key proof)
- `morphit_fee_attest_v1` op handler for two-party attestation
  fallback
- `AttestationFeeVerifier` that consumes attestations
- Frontend fee-method selector with BLURT default
- Sybil tier escalation restricted to BLURT
- 50% BLURT discount applied

**Sub-phase 4c — Loyalty (1 turn):**
- `account_loyalty` table added
- Cumulative BLURT tracking during fee processing
- Milestone threshold checking + `relay_pending_transfers`
  writes for BP rewards

## Non-goals

- Fee discounts for power users beyond the Sybil tier
  interaction.
- Refunds for fees paid on cancelled orders (ADR-0009
  established cancellation doesn't refund).
- Fee payment via fiat (Morphit never touches fiat).
- Integrated BTC/XMR wallets in Morphit for paying the fee from
  the same UI. Users manage their own BTC/XMR wallets.

## Amendments

### 2026-05-09 (Part 90, Category I ADR-fidelity audit) — fee model evolved to BLURT-native

The body of this ADR describes a USD-denominated fee
($0.25 base, $0.125 BLURT-discounted, computed via dynamic
USD-to-BLURT conversion at verification time).  What
actually shipped is **BLURT-native**: fees are denominated
directly in BLURT, with no USD anchor at verification
time.  The canonical reference is
`docs/FEES-AND-REWARDS.md`, which carries line-cited
figures.

**What actually shipped (Phase 4 onward):**

- `apps/indexer/src/config/index.ts` line 332:
  `MORPHIT_INDEXER_FEE_BASE_BLURT` defaults to `60` (BLURT
  units).  At BLURT ≈ $0.002 this is ~$0.12 — close to
  the original $0.125 BLURT-discounted target, but
  decoupled from the USD oracle.  Operators can tune
  per-instance.
- `apps/indexer/src/indexer/fee.ts` — Sybil multiplier
  table indexed by per-account 24h post count: tiers 1-3
  flat at 1.0×, then escalating 1.25× / 1.5625× / ... up
  to ~4.77× at tier 10 with compounding 1.5× per tier
  beyond.  Indexer and frontend compute the same formula
  from the same `feeBaseBlurt × sybilMultiplier(nth)`
  signature; tolerance band absorbs floating-point
  rounding.
- BTC and XMR fees: 100% to treasury (`@morphit-fees`)
  rather than the 90/10 split — see ADR-0013 §"Q3 Fee
  split" for the rationale (BTC/XMR are paid by the
  buyer to a treasury-owned address, no operator
  attribution path that's chain-verifiable).

**Why it changed:** the USD-denominated model required
a live, authenticated USD-to-BLURT oracle at every fee
verification, which (a) added a privacy and reliability
dependency the operator-class doesn't want, (b) made
fees non-deterministic at submit time (the user sees one
number, the indexer sees another), and (c) created
operator-tunability headaches when BLURT prices moved
fast.  BLURT-native fees are deterministic, locally
computable, and let operators set their own price
without either side blocking on an oracle.

**What's preserved from the original model:**

- Sybil tier escalation (multiplier-based, scales
  per-account, 24h rolling window).
- BLURT incentive (BTC/XMR pay treasury 100% so users
  paying in BLURT enjoy the operator's split-back
  rebate as a discount-by-other-means).
- Loyalty (`account_loyalty` table tracks BLURT-paid
  cumulative; thresholds trigger BP delegation
  rewards via `relay_pending_transfers`).
- First-buy waiver (one free order per account, BLURT
  buy only, BLURT-paid fee only).

**Net:** the spirit of ADR-0011 (Sybil-resistant,
BLURT-incentivized, loyalty-rewarded) is fully
implemented.  The USD-anchored verification mechanism
was simplified out.  The "Flat $0.25" and "$0.125 in
BLURT" figures in the body should be read as historical
target prices, not current configuration.

### 2026-05-10 (Part 106) — treasury chain-pin closes the BTC/XMR fork-attack vector

**Background.**  ADR-0011's 2026-05-09 amendment established
the policy that "BTC and XMR fees: 100% to treasury
(`@morphit-fees`)" — but no code enforced the **addresses
themselves**.  Each operator's indexer trusted its own
`MORPHIT_INDEXER_BTC_FEE_ADDRESS` and
`MORPHIT_INDEXER_XMR_FEE_ADDRESS` env vars as gospel.  This
left a real fork-attack vector unmitigated until Part 106:

  1. A hostile fork edits its env vars to the attacker's
     own BTC/XMR addresses.
  2. A user posts a buy/sell order through the hostile
     instance and pays the listing fee in BTC.  The
     pre-Part-106 frontend never displayed the actual
     address — the locale string just said "Send the
     fee to **our** Bitcoin address" — so the hostile
     operator was free to surface their own address via
     a help link or sidebar.
  3. The hostile indexer verifies the txid against its
     own configured address, marks the order
     `fee_status='verified'`, and the order goes live on
     the hostile orderbook.
  4. The federated `morphit.io` indexer scrapes the
     same chain ops, fetches the txid from a BTC
     explorer, checks against `morphit.io`'s configured
     address — mismatch → marks the order
     `fee_status='underpaid'`/`missing` → the order
     never appears on canonical's orderbook.
  5. **Hostile operator pockets the BTC.  Treasury
     gets nothing.**  No alarm anywhere.

**The fix.**  Extend the existing signed
`morphit_release_v1` op (already authenticated by the
`@morphit` posting key via the trust anchor pinned in
`apps/web/src/lib/net/config.ts`) with an optional
`treasury` block:

```
{
  "version": ...,
  "hash_manifest": {...},
  "endpoints": {...},
  "treasury": {
    "btc": { "address": "bc1q...", "satoshis": 416 } | null,
    "xmr": { "address": "4...", "viewkey": "<64-hex>",
             "piconero": "781250000" } | null
  }
}
```

A `TreasurySource` in the indexer (`apps/indexer/src/indexer/
treasurySource.ts`) resolves the canonical address with this
precedence:

  1. Most recent valid `morphit_release_v1` row's
     `treasury.{btc|xmr}` field — chain-pinned canonical.
  2. The operator's env-var fallback (existing pre-Part-106
     env vars) — bootstrap fallback for fresh indexers
     that haven't seen a treasury-bearing release op yet.
  3. `null` — meaning that fee method is disabled on this
     instance.

The poller queries TreasurySource on each cycle (cached
30s); when the canonical address changes, the BTC/XMR
verifiers are rebuilt to use the new address.  No restart
required.

The frontend reads the same chain-pinned addresses from
`/v1/release` (validated by
`@morphit/release-schema` (cp170; formerly
`apps/web/src/lib/net/releaseValidate.ts`) with rules that
mirror the indexer's), and renders them on the post-order
page (`ListingFeeAddressPanel.svelte`) with copy-button +
QR code + "chain-pinned by @morphit" badge.  This closes
both the indexer-side authority gap AND the frontend-side
social-engineering surface.

**Validation rules** (mirrored on indexer + frontend so any
release the indexer accepts also passes the frontend's
validator and vice versa):

  - BTC address: mainnet only — bech32 (`bc1q...`),
    legacy (`1...`), or P2SH (`3...`).  Testnet (`tb1`,
    `m`, `n`) rejected to prevent fat-finger config from
    reaching mainnet indexers.
  - BTC satoshis: positive integer, sanity-bounded at
    1000 BTC per listing.
  - XMR address: mainnet primary (95 chars, starts `4`)
    or subaddress (95 chars, starts `8`).  Testnet
    (`9`/`B`) and stagenet (`5`/`7`) rejected.
  - XMR viewkey: exactly 64 lowercase hex characters,
    no `0x` prefix.  Despite the term "private", this
    key is publish-safe by Monero design — it reveals
    only INCOMING transactions to the address.
  - XMR piconero: positive decimal string, 16-digit
    sanity bound (~1000 XMR).

**Hostile-fork containment.**  After Part 106, a hostile
fork that edits its own indexer to ignore the chain pin
only succeeds in marking orders `verified` on **its
own** instance — every other federated indexer still
marks them unverified, and the orderbook fork is
visibly inconsistent with the federation.  This is a
defection signal that anyone scraping multiple
instances can detect.  The treasury cannot be silently
diverted anymore.

**XMR view-key publication.**  Publishing the private
view key on chain is intentional and benign per Monero's
design — view keys reveal incoming transactions to an
address only, never outgoing spends or balance after
spend.  This is the standard mechanism for transparency-
required wallets (charity, escrow, treasury).  The
`apps/indexer/scripts/verify-xmr-viewkey.ts` helper
validates that a candidate (address, viewkey) pair
actually decodes a known transaction before broadcast —
operators MUST run it before any release op carrying a
treasury XMR field, since a typo in the viewkey looks
identical to a working config until the first XMR fee
silently fails.

**Operational discipline (OPERATIONS.md §40).**  The
`@morphit` posting key signs release ops including the
treasury chain-pin.  This key lives **off** the
morphit.io production server, on a personal machine
the operator trusts — typically a laptop with a Blurt-
aware wallet (Vessel, beempy, blurt-cli, dblurt-script).
Same offline-key discipline as the rest of the release-
op infrastructure.

**Community-operator deviation.**  Community operators
running their own Morphit instance default to inheriting
the canonical's chain-pinned addresses (leave their env
vars empty).  Operators who deliberately fill in their
own env vars accept BTC/XMR fees to their own address
but are visibly inconsistent with the federation —
their orders won't appear on other instances' orderbooks
because the txids paid the wrong address from canonical's
perspective.  This deviation is permitted (federation,
not centralization) but not in the spirit of the design.

### 2026-05-10 (Part 107) — XMR view key REMOVED from chain-pin (privacy correction)

**Background.**  Part 106's design embedded the Monero
private view key in the chain-pinned `treasury` block
under the rationale "the private view key is publish-safe
by Monero design."  That framing is true narrowly (no
theft risk) and **wrong for privacy**.

**The privacy harm.**  Publishing the private view key
reveals:
- Every incoming payment to the treasury wallet.
- Every amount, every timing, every subaddress, forever.
- Future inflows, not just past ones.

For a treasury wallet receiving recurring listing fees,
this means any analyst can:
- See the entire fee-flow history of the project.
- Correlate XMR fee payments to user Blurt accounts (the
  order op naming the user is broadcast on Blurt at
  roughly the same time as the XMR payment lands).
- Track payment patterns to deanonymize users at scale.

This is incompatible with Morphit's positioning
(privacy-preserving, federated, no KYC) and is
particularly egregious because the treasury wallet
receives high-volume, statistically-rich payment data
from many users.

**The fix.**  Remove `viewkey` from the chain-pinned
`treasury` block:

  - Frontend `releaseValidate.ts` and indexer handler's
    `validateTreasury()` no longer accept a `viewkey`
    field.  If a payload contains one (legacy/hostile),
    it is silently stripped — never persisted, never
    surfaced.
  - `TreasurySource.resolveXmr()` resolves the view key
    ONLY from `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` env, never
    from chain.  When the chain-pinned XMR address is
    present but env viewkey is empty (community-operator
    case), `XmrTreasury.viewkey` is `undefined` — the
    poller leaves the verifier disabled and the order
    handler rejects xmr orders cleanly.
  - `/v1/release` endpoint strips any viewkey from
    response output (defense-in-depth — the handler
    should already prevent persistence, but a third strip
    point catches any DB-write bypass).
  - `release-build-payload.ts` does not prompt for the
    viewkey; refuses to emit any payload containing a
    64-hex string (catches any future regression).
  - `ListingFeeAddressPanel.svelte` no longer displays
    a "view key" disclosure in the UI.

**Federation behavior change for XMR.**  Pre-Part-107,
community operators inheriting canonical's chain-pinned
XMR address would automatically also inherit the view
key (because it was on chain).  Post-Part-107, they
inherit the address but NOT the view key.  Three
options for them:

  (a) **Trust canonical's federated XMR verdict** —
      requires a federation-trust path that doesn't
      exist yet.  Tracked as Part 108+ work.

  (b) **Run their own XMR treasury wallet** with their
      own env address + view key.  Deviates from
      canonical (their XMR-fee orders won't appear on
      canonical's orderbook), but they keep 100% of the
      XMR that flows in.

  (c) **Disable XMR fee acceptance** on their instance.
      Cleanest option today.

**The Part 106 chain-pin defense for ADDRESS still
holds.**  Part 107 only changes the view key handling.
The fork-attack vector of "hostile fork redirects to a
different XMR address" is closed by the address-
chain-pin alone; the view key was never the defense for
that — it was just a convenience for community-operator
verification.

**Operational discipline (OPERATIONS.md §40.2).**  The
view key now has the same operational discipline as
the @morphit-relay active key: lives in env on the
production server only, mode 0600, owned by
`morphit-indexer`, read into process memory at boot,
never published in any form.  Operators who broadcast
release ops MUST NOT include a viewkey field (the
builder script enforces this; the handler strips it
defense-in-depth).

### 2026-05-10 (Part 108++) — XMR per-payment tx_proof verification (no view key required by any indexer)

**Background.**  Part 107 corrected the Part 106 design
error of broadcasting the treasury wallet's private
view key on chain (privacy regression).  The fix kept
the view key env-only on the canonical operator's box
— but that meant only canonical morphit.io could
verify XMR fees.  Community operators inheriting
canonical's chain-pinned XMR address had no view key,
so they faced a three-options dilemma documented in
`OPERATIONS.md §40.8` (Part 107):

  (a) Trust canonical's federated verdict — required a
      federation-trust path that never shipped.
  (b) Run their own treasury wallet.
  (c) Disable XMR fees.

**Why (a) was a priority #2 violation.**  A federation-
trust path for XMR verification would have made every
community indexer dependent on canonical morphit.io's
existence and willingness to verify.  That contradicts
priority #2 (decentralization, fully distributed,
unstoppable — no chokepoints, no "morphit.io must be
up" assumptions).  The path was tracked as a Part 108+
TODO but plowing it would have built the wrong thing.

**Part 108++ resolves the dilemma structurally.**
Use Monero's standard per-payment proof mechanism
(`get_tx_proof` / `prove_tx`).  The user generates a
proof from their own wallet after paying; any indexer
verifies the proof against the txid + treasury address
using a public Monero block explorer endpoint or a
local monerod RPC.  NO view key is required by any
indexer.

**Properties under the three priorities:**

- **Priority #1 — Privacy.**  The proof reveals only
  "this txid paid this address this amount."  It does
  NOT reveal: other payments to the address, other
  transactions in the user's wallet, the user's other
  addresses, wallet balance, or any wallet metadata.
  The user is the ONLY party that holds any
  verification secret (their tx_key, in their own
  wallet, never published).  Indexers hold nothing.

  Compared with the Part 107 status quo (treasury view
  key on canonical operator's box, sent over HTTPS to
  the explorer for every verification), the proof
  approach is strictly less leaky:
  - View key approach: explorer learns about EVERY
    incoming payment to the treasury, forever (one
    request → cumulative wallet-history visibility).
  - Proof approach: explorer learns about ONE payment
    per verification request (one request → one
    payment, period).

- **Priority #2 — Decentralization.**  Every Morphit
  indexer can verify every XMR payment independently.
  No shared secret.  No central instance.  Canonical
  morphit.io is one indexer among many, with no
  privileged role in verification.  Federation
  tolerates any single instance disappearing —
  including canonical — without breaking XMR for
  anyone else.

  Operators can self-host a `monero-block-explorer` +
  local `monerod` Docker stack to eliminate any
  third-party dependency.  Documented in
  `OPERATIONS.md §40.4`.

- **Priority #3 — Grandma-friendliness.**  Trade-off:
  the user must generate a proof from their wallet
  after paying (one extra step vs. just pasting a
  txid).  Mitigated by inline per-wallet instructions
  on the post-order page in 10 locales:

  - **Monero CLI:** `get_tx_proof <txid> <address>`
  - **Monero GUI:** Advanced → Prove transaction →
    fill in txid + address → Generate
  - **Cake Wallet:** Settings → Privacy → Verify a
    transaction → Generate proof
  - **Feather:** Tools → Prove/check transaction →
    Generate

  All four wallets implement this feature in their
  standard UI.  An expandable details block on the
  post-order page walks the user through each.

  An FAQ entry (`xmr_tx_proof`) provides extended
  explanation including the privacy invariant ("the
  proof reveals only this one payment, nothing else").

**The fix scope.**

Code changes:
- New `MoneroProofFeeVerifier` (`apps/indexer/src/
  indexer/fee/moneroProofVerifier.ts`).  Same circuit-
  breaker + multi-explorer pattern as BTC.  Uses
  `txprove=1` mode of xmrchain.net's `/api/outputs`,
  passing the user's proof in place of a viewkey.
  Includes tx_hash echo check (Item 4 / Audit Part 26
  parity with BTC verifier).
- Old `MoneroExplorerFeeVerifier` deleted along with
  its 2 test files.
- `FeeClaim` interface gains `txProof: string | null`
  field.
- Order handler structural validator requires +
  validates `tx_proof` for `fee_method=xmr` only
  (BTC unchanged).
- Schema migration v29 adds nullable `tx_proof TEXT`
  column to `orders` table.
- Indexer poller bootstrap + refresh paths rewritten:
  no more viewkey-required gate, address-only rebuild
  trigger.
- `/v1/release.treasury` API endpoint already strips
  any viewkey (Part 107 defense-in-depth) — invariant
  preserved.
- `release-build-payload.ts` already refuses to emit
  payloads containing 64-hex strings (Part 107
  defense-in-depth) — invariant preserved.
- Frontend post-order page: new tx_proof state +
  validator + UI section (privacy reassurance banner,
  per-wallet instructions, textarea, error feedback).
  Submit-gate + draft persistence include tx_proof.

Config changes:
- `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` is now a
  deprecated stub.  No code path reads it.  Removed
  entirely in Part 109 (see Part 109 amendment below).

Test additions:
- 25 new MoneroProofFeeVerifier unit tests (happy
  path, all rejection paths, explorer health, two
  privacy-invariant tests).
- 3 new MoneroProofFeeVerifier breaker integration
  tests (parity with BTC).
- 5 new order handler tx_proof validation tests.
- 5 new frontend payload tests.
- explorer-txid-echo-smoke rewritten — XMR scenario
  4-6 use the new proof verifier.
- Old MoneroExplorerFeeVerifier tests (15) deleted.

Locale additions:
- 19 new strings × 10 locales = 190 string additions
  for the proof workflow UI.
- New FAQ entry `xmr_tx_proof` × 10 locales.
- Locale parity 2,401 → 2,422 keys × 10.

Doc updates:
- `OPERATIONS.md §40` — major rewrite (~400 lines).
  New §40.2 "Three priorities: how Part 108++
  realizes them."  New §40.4 "Choosing your XMR
  explorer backend" with self-hosted Docker recipe.
  Simplified §40.7 community-operator section (was
  three-options dilemma; now one default flow).  New
  §40.11 migration path.
- `RUN-A-MORPHIT-NODE.md §8` community-operator
  callout simplified — every operator can verify
  XMR independently now.
- This ADR-0011 Part 108++ amendment.
- `AUDIT-2026-05.md` Part 108++ entry.
- `MORPHIT-BRAG-LIST.md` new entry on per-payment
  proofs eliminating any need for view keys on any
  indexer.

**The Part 106 ADDRESS chain-pin defense and Part 107
privacy invariant both remain in force.**  Part 108++
is additive on top: it changes XMR verification
mechanics, not the address-pinning trust model and not
the view-key-never-published invariant.  All three
parts compose:

- Part 106: BTC/XMR addresses + amounts pinned on
  chain by `@morphit`.
- Part 107: View key NEVER on chain, NEVER in API,
  NEVER in logs.
- Part 108++: View key NEVER required at all.  Per-
  payment proofs replace it.

**Federation behavior change (positive).**  Pre-Part-
108++, only canonical morphit.io could verify XMR
fees.  Post-Part-108++, every Morphit instance can.
The "three options for community operators" dilemma is
obsolete; the canonical flow now works for everyone.
Federation health is strictly improved.

---

## Part 109 amendment (2026-05-10)

**Title: cleanup + hardening — viewkey env removed,
multi-explorer quorum gate, per-instance chat-link
URLs, wizard explorer configurability.**

This part is mostly cleanup and tightening on top of
Parts 106/107/108++.  No fundamental design changes;
the priorities lens (#1 privacy, #2 decentralization,
#3 grandma-friendliness) drove each individual fix.

### Changes

**1. `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` removed
entirely.**  Part 108++ marked the env var "deprecated
stub" pending one transitional cycle.  Part 109 deletes
it:

- env-var dropped from `apps/indexer/src/config/index.ts`
- `xmrFeeViewKey` field removed from Config interface
- loader assignment removed
- `viewkey` field removed from `XmrTreasury` interface
- `xmrViewkey` field removed from
  `TreasurySourceEnvFallback`
- `resolveXmr()` no longer references view keys
- poller TreasurySource construction no longer passes
  `xmrViewkey`
- `release-build-payload.ts` no longer prints the
  pre-broadcast viewkey-verify nudge
- env example, OPERATIONS.md, RUN-A-MORPHIT-NODE.md
  swept clean
- treasurySource.ts header comment block rewritten
  for Part 109
- schema.sql `treasury` column comment updated

Stale `viewkey` fields on Part 106-vintage chain-pin
rows continue to be silently stripped at parse time
(belt-and-suspenders: the validator has never persisted
the field, and the resolver never reads it).

**2. minSuccessfulResponses quorum gate on both BTC
and XMR fee verifiers.**  Pre-Part-109 behavior: if N-1
of N configured explorers fail (or return
`data_not_found`), the verifier promotes a payment to
`verified` based on the single remaining response.  A
1-of-5 result during a degraded outage is structurally
weaker than the multi-explorer cross-check the operator
signed up for.

Part 109 adds a `minSuccessfulResponses` config field
(both verifiers; default 1 preserves back-compat),
plumbed from new env vars:

- `MORPHIT_INDEXER_BTC_MIN_SUCCESSFUL_RESPONSES`
- `MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES`

The loader cross-validates: if the threshold exceeds
the URL count, the indexer refuses to start with a
clear error message ("quorum can never be met").

When the configured threshold isn't met at verify
time, the verifier returns `pending_external` with
reason `quorum not met: <got>/<wanted> explorers
returned usable data`.  The order can still be
promoted later (next polling cycle) or via the
attestation path.

With the default 5-explorer XMR list, operators can
set the threshold to 2 or 3 for genuine multi-source
cross-check.  BTC operators with both Esplora explorers
configured can set 2 for the same effect.

**3. Per-instance chat-link external explorer URLs.**
The frontend's `apps/web/src/lib/explorer/urls.ts` now
consults the `instance` store for operator-configured
templates, falling back to bundled defaults
(`mempool.space/tx/{txid}` for BTC,
`xmrchain.net/tx/{txid}` for XMR) when no override is
set.

Plumbing:
- new env vars `MORPHIT_FRONTEND_BTC_CHAT_LINK_URL`
  and `MORPHIT_FRONTEND_XMR_CHAT_LINK_URL` with
  zod refinement (`https://`, contains `{txid}`,
  parses as URL after substitution, no credentials)
- new fields on `InstanceResponse.chat_link_urls`
  (indexer + indexer-client + frontend store)
- `urls.ts` refactored: pure helpers moved into
  `urlsCore.ts` (no Svelte-store import) so node-
  side smokes can test the substitution / validator
  without pulling SvelteKit's `$lib` alias

Privacy framing: every click on a BTC/XMR txid in
chat sends the user's IP + browser fingerprint to
the configured explorer's host.  Operators who
self-host their own explorer (or who trust a
different third party) can override per-instance.
The override is per-OPERATOR (not per-user) — a
user who wants different behavior chooses a different
Morphit instance.

**4. Setup wizard extended for fee-verifier explorer
URLs and chat-link URLs.**  The `morphit-ops init`
CLI gains:
- step 11: fee-verifier explorer URL editor for BTC
  and XMR with live parallel health-probes on screen
  load.  Edit / keep / reset-to-defaults menu per
  asset.  Probes hit the explorer's standard health
  endpoints (`/blocks/tip/height` for Esplora,
  `/api/networkinfo` for Monero) — no user data sent.
- step 12: chat-link URL editor for BTC and XMR,
  with template-shape validator and reachability
  probe per host.
- existing SEO and Backup steps renumbered (13/14).
  TOTAL_STEPS bumped from 12 to 14.

**5. `docs/PRE-LAUNCH-CHECKLIST.md` consolidated.**
A single document tracks every pre-launch operator
action item across Parts 106/107/108++/109, with
explicit memory-rule binding ("update in same turn as
any change that adds or closes an item") so it never
goes stale.

### Test additions

- 7 new quorum-gate tests (3 BTC + 4 XMR)
- 7 new explorer-urls-smoke scenarios (regexes,
  bundled defaults, substitution, validator,
  privacy invariant on distinct hosts)
- existing 4 verifier test files updated with the
  required `minSuccessfulResponses: 1` field

### Numbers

- Indexer tests: 406 → 413 (+7 net)
- Frontend tests: 550 (unchanged)
- Relay tests: 244 (unchanged)
- explorer-urls smoke: 20 → 27 scenarios (+7)
- Locale parity: 2,424 × 10 (unchanged — no
  user-facing UI strings changed)
- TypeScript projects: 0 errors (all 8)
- svelte-check: 0 / 0

### Priority-lens evaluation

Each change was checked against the three priorities:

- **Privacy (#1)**: chat-link configurability respects
  user-IP privacy by giving operators a mechanism to
  point users at self-hosted explorers.  Quorum gate
  reduces the attack surface of a single compromised
  explorer (verifier needs N agreeing responses, not
  just N=1).  Viewkey removal completes the Part 107
  privacy invariant.
- **Decentralization (#2)**: every change keeps
  morphit.io optional.  No new central dependencies.
  Wizard URL-configurability lets operators substitute
  any explorer they trust (including self-hosted).
- **Grandma-friendliness (#3)**: wizard health-checks
  surface bad URLs with a clear ✓/⚠/✗ indicator before
  the operator commits.  Cross-validation at config
  load catches misconfigurations at boot rather than
  at first verification attempt (clear error message
  instead of mysterious `pending_external` results).

### Federation behavior

No federation behavior changes.  Quorum and chat-link
URLs are per-instance operator decisions; community
operators who keep defaults see the same behavior they
saw in Part 108++.

**The Part 106 ADDRESS chain-pin defense, Part 107
privacy invariant, and Part 108++ no-view-key
verification model all remain in force.**  Part 109
is additive cleanup + hardening; it changes operator
configurability and adds defensive gates, not the
fundamental design.

---

## Part 110 amendment (2026-05-10)

**Title: operator-facing cleanup + listing-fee
configurability in the wizard.**

This part is mostly cleanup and one operator-requested
UX improvement.  No design changes; the BLURT-native
fee verification model from Part 105+ and the per-
payment XMR proof model from Part 108++ are unchanged.

### Changes

**1. `verify-xmr-viewkey.ts` retired.**  The Part 107-
era diagnostic helper for sanity-checking a (XMR
address, view key) pair against a real test
transaction is gone.  Part 108++ replaced view-key-
based verification with per-payment proofs; Part 109
removed the view-key env var; Part 110 retires the
script.  Sanity-checking your XMR fee address now
flows through the modern path: configure
`MORPHIT_INDEXER_XMR_FEE_ADDRESS`, restart the
indexer, have a trusted contact send a small test
payment with a tx_proof, and submit it through the
real Morphit UI.  This exercises the exact code path
users will hit (better than any operator-only
diagnostic).

Files swept: file deleted; OPERATIONS.md §12 rewritten
as a Part-110-retirement notice; OPERATIONS.md §40
keys-table updated; OPERATIONS.md runbook command-ref
cleaned; `release-build-payload.ts` header + trailer
comments updated; `releaseValidate.ts` stale comment
fixed; PRE-LAUNCH-CHECKLIST.md XMR setup entry
updated.

**2. Listing fee USD target now configurable in the
wizard with live Coingecko recompute.**  Pre-Part-110,
the operator had to run a separate CLI helper
(`recommend-fee-amounts.ts --target-usd 0.25`) and
paste BTC sat + XMR piconero values into
`morphit.config.env` by hand.  Part 110 promotes this
to a first-class wizard step (new step 13, after fee-
explorer URLs and chat-link URLs):

- Operator enters USD target (default 0.25).
- Wizard fetches live BTC/USD + XMR/USD from
  Coingecko's free public ticker (10s timeout).
- Wizard computes amounts via
  `computeFeeAmounts(targetUsd, prices)` (round half-
  up); displays them; asks operator to accept or
  override.
- On Coingecko unreachable: operator can enter
  amounts manually or keep hardcoded defaults
  (calibrated for $0.25 at ~$60K BTC / ~$320 XMR,
  flagged as likely stale).
- Same step prompts for the fallback BLURT/USD
  price (used by the indexer's composite price
  source only when both Klingex and Coingecko have
  been failing).
- `WizardAnswers.listingFee.source` records
  `'coingecko' | 'manual' | 'default'` for the
  post-wizard review.

**3. Same wizard step reachable via
`morphit-ops edit`.**  The `edit` subcommand's menu
gained a "Listing fee + fallback BLURT price" option
that calls the same `stepListingFee()` and writes the
results back to `morphit.config.env` atomically.
Use case: re-recompute amounts when BTC/XMR drift
significantly.

**4. 50% BLURT-paid discount stays separate.**
`MORPHIT_INDEXER_FEE_BASE_BLURT` (default 60 BLURT,
representing the ~$0.125 BLURT-paid fee = half of the
$0.25 USD target) is intentionally NOT exposed in the
wizard.  Per operator decision: it's not a knob most
operators routinely tune, and surfacing it would
clutter the wizard for a marginal use case.
Operators who need to change it can edit
`morphit.config.env` by hand.

**5. Pre-launch + day-zero + post-launch docs.**
Three new operator-facing documents:
- `docs/PRE-LAUNCH-CHECKLIST.md` (Part 109; extended
  in Part 110 with relay-funding `[blocking]` item
  and listing-fee review `[recommended]` item).
- `docs/LAUNCH-DAY.md` (Part 110, new): T-minus 24h,
  T-minus 1h, T-zero, what-to-watch first hour,
  rollback, 24h pacing, end-of-day retrospective.
- `docs/POST-LAUNCH-WEEK-ONE.md` (Part 110, new):
  daily AM/PM checks, weekly rollups, paging
  thresholds, common situations playbook.

### Test additions

- 12 new tests for the shared `feeAmountCalc.ts`
  helpers (math: defaults, zero target, linear
  scaling; fetch: happy path, non-2xx, network
  failure, missing fields, zero/negative, string
  coercion, garbage).

- No new smoke files; the init-smoke fixture gained
  one `listingFee` field on the WizardAnswers
  sample, exercising the env-render path.

### Numbers

- Indexer tests: 413 → 425 (+12 net for
  feeAmountCalc)
- Frontend tests: 550 (unchanged)
- Relay tests: 244 (unchanged)
- Smoke scenarios: 2,271 (no change; Part 110 adds
  no new smoke files)
- Locale parity: 2,424 × 10 (unchanged — wizard
  text is operator-facing, English-only)
- Wizard TOTAL_STEPS: 14 → 15 (+1 listing-fee step)
- Brag list: 259 → 261 (+2 new entries)
- New code files: 1 (`feeAmountCalc.ts` shared
  helper)
- New doc files: 2 (LAUNCH-DAY.md,
  POST-LAUNCH-WEEK-ONE.md)
- Files retired: 1 (verify-xmr-viewkey.ts)

### Priority-lens evaluation

- **Privacy (#1)**: no change.  The wizard hits
  Coingecko from the operator's box (the operator
  chose to use Coingecko by accepting the live-
  recompute path); the indexer doesn't gain or lose
  any data flow.  The retired viewkey script's last
  remaining "operator runs it locally with the view
  key in env" pattern is gone entirely.
- **Decentralization (#2)**: no change.  Wizard
  Coingecko dependency is opt-out (manual entry +
  defaults available).  Indexer continues to verify
  fees BLURT-native with no live USD oracle.
- **Grandma-friendliness (#3)**: wizard surfaces a
  setting that previously required CLI fluency.
  `morphit-ops edit` flow for ongoing maintenance.
  Three operator-facing runbooks help newcomers walk
  through launch without ad-hoc knowledge.

### Federation behavior

No federation behavior changes.

**All previous parts' invariants remain in force:**

- Part 106: BTC/XMR addresses + amounts pinned on
  chain by `@morphit`.
- Part 107: View key NEVER on chain, NEVER in API,
  NEVER in logs.
- Part 108++: View key NEVER required at all.  Per-
  payment proofs replace it.
- Part 109: View-key env var REMOVED.  Wizard
  configures fee-verifier explorer URLs + chat-link
  URLs with live health probes.  Quorum gate on both
  verifiers.
- Part 110: Wizard configures listing-fee USD target
  + fallback BLURT price.  Retired diagnostic
  helper.  Pre-launch / launch-day / week-one
  runbooks shipped.

---

## Part 111 amendment (2026-05-10)

**Title: federation-cost attribution via `operator_tag` gating.**

This part closes a federation-design gap that pre-
dated Part 110: pre-Part-111, every operator's relay
queued payouts on every chain-op it saw, multiplying
treasury spend by the federation count.  Account
creation was already correctly scoped (HTTP endpoint)
but the chain-op-triggered payouts (welcome bonus,
low-balance refill, operator earnings, loyalty BP)
were not.

> **cp408 amendment (2026-07-04):** operator earnings
> no longer flow through a relay payout — the owner's
> 90% is paid directly by the payment-time fee split
> (see ADR-0013 amendment + FEES-AND-REWARDS.md). The
> Part-111 gate below still applies to the operator
> **earnings attribution** (which instance books the
> dashboard credit); the three remaining relay-queued
> payouts (welcome bonus, low-balance refill, loyalty
> BP) are gated exactly as described.

### Design

Use the EXISTING `operator_tag` field on order ops as
the gate.  No new on-chain fields, no new privacy
leak, uses already-published data.

Each operator's indexer compares the op's tag
against `MORPHIT_INSTANCE_OPERATOR_TAG` (set via the
new wizard step 16); only the operator whose tag
matches queues the payout.  Global state (orders,
account_loyalty, account_loyalty_milestones,
accounts.first_trade_complete_at) is still updated
on every indexer for federation-consistent
orderbook + audit; only the payout queue insert is
per-operator.

### Why not on-chain `served_by`?

Original instinct was to add a new field
`served_by: <operator-account-name>` to every user-
signed Morphit op.  Two problems caught BEFORE
shipping:

1. **Priority #1 privacy regression.**  Publishing
   "which Morphit instance this user routed through"
   on chain forever doxes the user-base of niche
   operators (Tor-only, language-specific) and
   defeats the privacy benefit of choosing those
   operators in the first place.  Naive `served_by`
   fails Priority #1.

2. **Brittleness.**  Tying obligations to a relay
   account name on chain creates a coordination
   problem when operators rotate accounts, go
   offline, or get seized.

`operator_tag` is already on chain and already
public (the user-readable directory of operators is
keyed on it), so gating on it adds no new
information disclosure.  Operators are already
self-doxing by registering a public tag; gating
payouts on that tag is consistent with that
existing public commitment.

### Gating sites

Four queue insertion sites, each guards on
`operator_tag === instanceOperatorTag`:

1. `apps/indexer/src/indexer/operatorEarnings.ts:
   attributeBlurtFeeToOperator` — operator-payout
   (90% BLURT fee share).  New `AttributionResult`
   discriminant `attributed_other_instance`.  Zero
   DB writes when the gate fails.

2. `apps/indexer/src/indexer/loyalty.ts:
   trackVerifiedBlurtFee` — first-fee welcome BP +
   cumulative milestone BP delegations.  New params
   `orderOperatorTag`, `instanceOperatorTag`.
   Global state (account_loyalty +
   account_loyalty_milestones) still UPSERTs;
   only the relay queue insert is gated.

3. `apps/indexer/src/indexer/handlers/feedback.ts`
   — welcome bonus (20 BLURT).  Looks up cited
   order's `operator_tag` from the `orders`
   table.  Global state
   (`accounts.first_trade_complete_at`) still
   flips on the upsert; only the queue insert is
   gated.

4. `apps/indexer/src/indexer/lowBalanceScanner.ts:
   selectCandidates` — refill scope.  Now JOINs
   `orders.operator_tag = MY tag` instead of
   `EXISTS ops` (which matched federation-wide
   activity).

### Schema migration v30

Adds `orders.operator_tag TEXT` column (nullable)
plus index `(operator_tag, account, created_at)` for
the scanner's JOIN.  Backward-compat: pre-Part-111
rows stay NULL.  Pre-launch reality means this
compat is for replay tests only.

### Economic alignment

The operator getting the 90% reward is the same
operator obligated for the 10% treasury + welcome
bonus + refills + loyalty BP consequences.  A
spammer trying to dump payouts onto a victim
operator would have to pay 90% of every fee TO
that victim — net break-even, zero leverage.

### Wizard step 16

`MORPHIT_INSTANCE_OPERATOR_TAG`.  Captured at init
time; canonical morphit.io uses `morphit`.
Community operators MUST pick a unique tag AND
register it on chain via
`morphit_operator_register_v1` before launch
(otherwise their indexer recognizes no incoming
ops as theirs and queues nothing — conservative
default).  Same step reachable via
`morphit-ops edit → Operator tag (federation
attribution)`.

### Default behavior

When `MORPHIT_INSTANCE_OPERATOR_TAG` is undefined,
the gate refuses everything — the relay queues
NOTHING.  Better to pay nothing than to pay for
ops you can't prove are yours.  Community
operators standing up an instance will see this
explicitly in the wizard's "Operator tag" prompt
and in the env file comments.

### Test additions

`apps/indexer/test/indexer/federationScopeGate.test.ts`
— 11 new scenarios covering all four gating sites
with both gate-passes and gate-fails flows.
Loyalty test fixture extended with
`orderOperatorTag` + `instanceOperatorTag`
overrides.  Feedback test mocks gained the cited-
order operator_tag SELECT.  Smoke files updated for
the new function signatures.

### Numbers

- Indexer tests: 425 → 436 (+11 federation-scope
  scenarios)
- Schema version: v29 → v30
- Wizard TOTAL_STEPS: 15 → 16
- Smoke: 2,271 / 100 stable (triple-pulse)
- Brag list: 261 → 262 (+1)
- TypeScript: 0 errors all 8 projects

### Priority-lens evaluation

- **Privacy (#1)**: zero new on-chain data; uses
  existing `operator_tag` field.  No new leak class.
- **Decentralization (#2)**: each operator
  independently gates; no central coordination
  needed.  Federation health unchanged.
- **Grandma-friendliness (#3)**: zero UX change for
  users.  Operators get a clear wizard step
  explaining the tag's purpose and the
  consequences of leaving it unset.

### Federation behavior

**Federation-cost is now properly scoped.**  All
previous-part invariants remain in force:

- Part 106: BTC/XMR addresses + amounts pinned on
  chain by `@morphit`.
- Part 107: View key NEVER on chain.
- Part 108++: View key NEVER required at all.
- Part 109: View-key env var REMOVED.  Wizard
  configures fee-verifier + chat-link URLs with
  health probes.  Quorum gate on both verifiers.
- Part 110: Wizard configures listing-fee USD
  target + fallback BLURT price.  Retired
  diagnostic helper.  Pre-launch / launch-day /
  week-one runbooks.
- **Part 111: Federation-cost attribution via
  `operator_tag` gating.  Each operator's relay
  pays only for ops served by their own instance.**
