# ADR-0038 — Reputation hardening campaign: time decay + concentration detector + verifiable receipt + side distinction + dormancy signal (cp123–cp125)

**Status:** Accepted (shipped 2026-05; pre-launch hardening campaign)

**Date:** 2026-05-23
**Deciders:** project maintainer (Ken)
**Related:** ADR-0009 (order posting, Signal A/B framing), ADR-0014
(chat-and-counterparty-reputation, verified-chat badge), Part 113
audit (reputation attack-surface enumeration, 2026-05-10).

## Context

Pre-cp123, Morphit shipped a comprehensive sybil-resistant reputation
system audited in Part 113 (2026-05-10) across 15 attack vectors
(A1–A10 inflation, B1–B5 deflation, C1–C2 identity, D1–D3
aggregation). Of those 15, **4 remained open**:

| # | Vector | Part-113 status |
|---|---|---|
| **A4** | Signal B evasion via diversification | RESIDUAL — indirectly mitigated by A5 economics |
| A6 | Trade never happened (off-chain settlement) | STRUCTURALLY UNDECIDABLE |
| **D3** | Time decay / stale reputation | DEFERRED |
| D1 | New trader cold-start penalty | DESIGN CHOICE — `is_new_trader` badge |

Ken's cp123 ask ("make sure reputation scores cannot be spoofed,
faked, artificially pumped … real, verified feedbacks, successful
trade counts, factor in as many variables as we need to ensure
provability of one's reputation score") re-opened the deferred and
residual items, and added a new explicit requirement: **provability**.

Eight hardening opportunities were enumerated (H1–H8). Ken locked
in **H1 + H2 + H4 + H5 + H6**, skipping H3 (reviewer-credibility
weighting — too punitive for newcomers) and H7/H8 (asymmetric-feedback
signal and operator dashboard — lower-value).

## Decision

Five coordinated changes, shipped across cp123 (foundation) → cp124
(surfaces) → cp125 (docs).

### H1 — Time-decay weighting (closes D3)

The published `weighted_rating` becomes a **365-day-half-life
exponential-decay weighted average** instead of a flat AVG. Every
feedback row's contribution is scaled by:

```
weight(age_days) = 0.5 ^ (age_days / 365)
```

- Review today: weight 1.0
- Review 1 year old: weight 0.5
- Review 2 years old: weight 0.25
- Review 3 years old: weight 0.125

The aggregate becomes `SUM(rating × weight) / SUM(weight)`, computed
in SQL at the 3 aggregation sites (`apps/indexer/src/api/feedback.ts`
summary, `apps/indexer/src/api/orderbook.ts`,
`apps/indexer/src/api/orderbookStream.ts`).

**Rationale for exponential decay (rather than linear or step):**

- Exponential has the **memoryless property** — the ratio of any
  two reviews' weights depends only on their AGE DIFFERENCE, not
  their absolute ages. The formula is stable under clock skew
  between indexers.
- Linear decay has a "fall off a cliff" date after which reviews
  count zero, creating perverse incentives to game the cutoff.
- Step decay (e.g., reviews older than 1 year count zero) makes
  the boundary a target for manipulation.

**Rationale for 365-day half-life:**

- A year is the natural "long enough ago that things might have
  changed."
- Shorter (180d) penalizes seasonal traders too harshly.
- Longer (730d) defers the decay benefit unhelpfully far.
- At 365d, a 5-year-old review is worth ~3% of a fresh review —
  effectively forgotten but not erased.

**Rationale for SUM(weight) denominator (not COUNT):**

- A trader with 10 fresh 5-stars should rank above one with 100
  ancient 5-stars at the same numeric weighted_rating. Both
  would otherwise land at 5.00 (every row rating=5, COUNT
  denominator).
- The SUM(weight) denominator means fresh contributors get full
  influence; ancient contributors get partial.

**Raw COUNT preservation:** The `count` field is unchanged (raw
total). Only `weighted_rating` carries decay. By-rating histogram
unchanged (per-bucket raw).

### H2 — Signal D: review-concentration detector (closes A4 residual)

Signal B requires `distinct_subjects=1` (the reviewer reviewed
ONLY the target). A smart attacker reviews 2-3 throwaway third
parties to evade Signal B while still pumping the primary target.

**Signal D** triggers when a reviewer concentrates ≥80% of their
reviews on a single high-star target across a 30-day window:

- Minimum 5 total reviews in the 30-day window (noise floor)
- Concentration ≥ 80% on one subject
- Avg rating to dominant subject ≥ 4.5 stars (inflation case;
  deflation cases captured by Signal C)
- Pair stored in new `review_concentration (reviewer,
  dominant_subject)` table; PK on the pair

**Aggregation filter** updated in all 3 sites to exclude rows
where `(reviewer, subject)` matches a `review_concentration` row.

**Scheduling:** runs hourly from `poller.maybeRunSignals` alongside
Signals A/B/C. Same advisory-not-dispositive treatment, same
`ON CONFLICT DO NOTHING` semantics, same operator-side false-
positive recovery (DELETE row).

### H4 — Verifiable reputation receipt endpoint

New endpoint `GET /v1/accounts/:account/reputation-receipt`. The
"show your work" endpoint. Returns the FULL set of inputs that go
into the published weighted_rating so any third party can re-derive
the score locally.

Response fields:

- `account`, `as_of` (ISO), `decay_half_life_days` (365), `formula`
  (human-readable string describing both the math AND the
  exclusion rules)
- `summary` with `count_total`, `count_included`, `count_excluded`,
  `weight_sum`, `weighted_rating`
- `rows[]` — every feedback row about the subject, including
  excluded ones, with per-row fields: `source_trx_id`, `reviewer`,
  `rating`, `created_at`, `order_permlink`, `age_days`,
  `decay_weight`, `included`, `excluded_reason`

`excluded_reason` is one of: `null` (counted), `no_order_permlink`,
`suspicious_reciprocity`, `related_accounts`, `one_way_pile_on`,
`review_concentration`.

**Provability path:** A reader can fetch the chain feedback ops
for an account, apply the documented exclusion rules, run
`computeWeightedRating()` (same function the indexer uses,
exported from `apps/indexer/src/indexer/reputation/decay.ts`),
and verify the published score. Without this endpoint, "provable
reputation" requires running an indexer. WITH this endpoint,
"provable reputation" requires only the ability to read the
chain.

**`as_of` parameter:** Optional ISO timestamp. Used for
deterministic comparison and archival re-verification. **Honest
limitation:** signal-table flags are always evaluated at REQUEST
time (no historical flag-state reconstruction). Two indexers with
different signal-table states will produce different receipts —
this is intentional transparency.

**Caching:** ETag + Cache-Control: 60s.

### H5 — Buy/sell side distinction

The feedback summary endpoint now returns `by_side: { buy: {count,
weighted_rating}, sell: {count, weighted_rating} }` alongside the
single conflated `weighted_rating`. Computed via SQL `FILTER (WHERE
side='buy')` / `FILTER (WHERE side='sell')` clauses after JOINing
feedback to its cited order's side.

**Rationale:** A trader great as a buyer but careless as a seller
(or vice versa) deserves to be visible to readers. The previous
single-number rating conflated both roles.

**UI:** profile page renders separate chips for each side when
that side has count > 0. Hidden gracefully when only one side has
history.

### H6 — Dormancy signal (last_traded_at)

The feedback summary endpoint now returns `last_traded_at` (ISO or
null). Computed as `GREATEST(MAX(orders.created_at WHERE
account=$1 AND fee_status='verified'), MAX(feedback.created_at
WHERE subject=$1))`.

**UI:** profile page renders "Last traded: N ago" using the
existing `RelativeTime` component. Hidden when null (account never
posted a verified order AND never received feedback).

**Rationale:** A trader with great old reviews who hasn't traded
in 18 months may no longer hold their key. Visible freshness
informs trust without changing the numeric score.

### H7 — Composite reputation score (cp404)

Order cards show TWO distinct trust signals side by side: the raw
trade **count** (`feedback_count`, e.g. "852" / "1.4K") and a 0–5
**reputation score** (e.g. "4.06"). Prior to cp404 the only numeric
was `weighted_rating` (the H1 time-decayed mean), which answers
"what's the average rating" but not "how much should I trust this,
accounting for how much history exists and whether the trader
earned it." The reputation score is that composite, computed by
`apps/indexer/src/indexer/reputation/score.ts` from the SAME
sock-puppet-filtered feedback (H2/Signal-B/C/D exclusions already
applied):

```
base  = (n·avg + K·μ) / (n + K)                      # Bayesian shrink
bonus = BONUS_MAX · exp_frac · rec_frac · aboveNeutral
score = clamp(base + bonus, 0..5)
```

- `avg` = the H1 time-decayed mean rating; `n` = included count.
- **Bayesian shrinkage** toward a neutral prior (`μ`=3.0, `K`=4)
  so a newcomer with one glowing (possibly fake) review can't spike
  to 5.0 — trust is earned as good trades accumulate and the shrunk
  mean rises toward the true high average.
- `exp_frac = ln(1+n)/ln(1+40)` (experience, saturates at 40 trades);
  `rec_frac = 0.5^(days_since_last_feedback/180)` (recency).
- **The bonus gate** `aboveNeutral = max(0, (base−μ)/(5−μ))` is the
  key fairness property: it is **zero at or below the neutral prior**,
  so experience and recency can only reward a trader whose rating is
  already above neutral, and never rescue a poor or mediocre one. A
  500-trade scammer rated 2.0 stays ~2.0; a 5-star veteran climbs
  toward 5.0.

Behaviours (locked by `reputation-score-smoke`, 10 scenarios): zero
feedback → `null` (card shows nothing; the 🌱 new-trader chip signals
newness instead); one 5-star → ~3.4, not 5; 200 recent 5-stars → ≥4.8;
more good trades strictly raise the score; a dormant good trader
scores below an active one; always bounded to [0, 5].

**Constants are tunable** (`REPUTATION_PRIOR_MEAN`,
`REPUTATION_PRIOR_WEIGHT`, `REPUTATION_EXPERIENCE_FULL`,
`REPUTATION_RECENCY_HALF_LIFE_DAYS`, `REPUTATION_BONUS_MAX`) — a
future instance could expose them via env like the H1 half-life.

**Transparent + verifiable:** the H4 receipt endpoint now also
returns the score plus its factor breakdown (`reputation_score`,
`reputation_base`, `reputation_bonus`, `reputation_experience_frac`,
`reputation_recency_frac`) and an extended `formula` string, so any
reader can re-derive the "⭐ 4.06" from the raw feedback rows — the
same "show your work" posture as the underlying `weighted_rating`.

## Privacy posture

Per Morphit's standing priority #1 (privacy):

1. **No new on-chain data.** All changes operate on already-chain-
   anchored feedback ops + locally-derived signal tables. No new
   custom_json types. No new fields on existing ops.
2. **Receipt endpoint reveals which (X, Y) pairs are flagged** —
   but this is already implicit in the missing rows of X's
   published aggregate. No new privacy leak.
3. **The receipt does NOT reveal flags for pairs (Y, Z) that don't
   involve X.** Each account's receipt is scoped to its own
   relationships.
4. **Signal D detector reads existing tables only.** No new
   chain-data inputs.
5. **`as_of` parameter is caller-controlled.** No information
   leak in either direction.

## Decentralization posture

Per Morphit's priority #2:

- **Per-instance signal-table state** is the same posture as the
  pre-existing Signals A/B/C. Two indexers can show slightly-
  different scores based on their local signal-table state. The
  receipt endpoint surfaces this disagreement explicitly when
  comparing receipts across instances.
- **No new federation-wide constants.** Half-life is per-indexer
  configurable (future enhancement); default 365 days hardcoded.
- **No new operator-mandatory actions.** Existing operators
  upgrade and the new aggregation logic + Signal D detector run
  automatically.

## Operator action required

- **None mandatory.** Schema migration adds one new table
  (`review_concentration`) idempotently via `CREATE TABLE IF NOT
  EXISTS`. Existing instances pick this up on next indexer
  restart.
- **Optional:** operators may DELETE rows from `review_concentration`
  to clear false-positive flags. Same recovery path as the
  existing signal tables.

## Performance posture

- **Decay computation** adds ~2 POWER + 2 EXTRACT calls per
  feedback row in 3 aggregation sites. Postgres handles these as
  scalar functions on small per-row inputs; cost is negligible
  against the existing GROUP BY scan.
- **Signal D detector** is hourly; runs alongside Signal C with
  the same query-cost profile (CTE + JSONB-free).
- **Receipt endpoint** is O(N) in feedback rows about the
  subject. A subject with 10,000 reviews produces a 10,000-row
  receipt. 60s ETag caching mitigates repeat-call cost.

## Consequences

**Positive:**

- D3 (time decay) and A4 (Signal B evasion via diversification)
  both closed.
- Provability gained: any chain-readable party can verify the
  published score without trusting any indexer.
- Buy/sell asymmetry visible to readers (H5).
- Dormancy visible to readers (H6) — no numeric change to the
  score, just freshness context.
- 2-decimal precision throughout (server already at NUMERIC(3,2);
  UI was truncating to 1).

**Negative / accepted tradeoffs:**

- **Score now requires NOW()-dependent computation.** Cross-
  indexer determinism limited by clock skew. Mitigated by
  `as_of` parameter for explicit comparison.
- **Receipt endpoint is heavier than the existing summary** —
  ~1 KB per feedback row. Acceptable; transparent reputation
  outweighs payload size.
- **Stale 5-star reviews now matter less** — some long-time
  traders may see their headline number drop slightly until they
  trade again. This is the intended behavior; raw COUNT is
  preserved separately so historical context isn't lost.
- **Signal D can false-positive** on a real trader who happens
  to have many repeat trades with one counterparty (e.g., a
  regular trading partner). Mitigation: 5-review noise floor +
  operator DELETE recovery + the dominant-subject pair flagging
  semantics (only the pair is flagged, not the reviewer
  globally).

## Honest limitations

- **A6 remains structurally undecidable.** Settlement is off-chain
  by design; no software can verify that a trade actually
  happened. Reputation is built on the PATTERN of consistent
  verified-fee orders + mutual feedback over time, not on any
  individual claim.
- **D1 (cold start) remains a design choice.** Brand-new accounts
  still get the `is_new_trader` orderbook badge until they have
  4+ verified-fee trades. The H1 decay benefits old-trader
  recency but doesn't accelerate newcomer onboarding.
- **A10 (stolen private key) remains out of scope.** User opsec
  problem; reputation system cannot defend against a compromised
  key.

## Related

- ADR-0009 §5 (Signal A/B framing — Part 113 closure context)
- ADR-0014 Component C (verified-chat badge framing)
- `apps/indexer/src/indexer/reputation/decay.ts` (the new
  shared formula module)
- `apps/indexer/src/indexer/reputation/score.ts` (H7 composite
  reputation score — cp404)
- `apps/indexer/src/api/reputationReceipt.ts` (H4 endpoint; cp404
  extends its summary with the score breakdown)
- `apps/indexer/scripts/reputation-decay-smoke.ts` (13 scenarios)
- `apps/indexer/scripts/reputation-score-smoke.ts` (10 scenarios —
  cp404)
- `apps/indexer/scripts/reputation-receipt-shape-smoke.ts`
  (7 scenarios)
- `docs/faq/how_to_build_high_reputation.md` (cp125 companion FAQ
  — Ken's explicit ask: "make sure an faq article explains the
  best ways to get yourself a high reputation score"; updated for
  the cp404 composite score)
