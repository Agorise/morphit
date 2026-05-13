# ADR-0009 — Phase 3c order posting + enforcement architecture

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** project maintainer
**Supersedes:** none
**Superseded by:** none

## Context

Phase 3b delivered the indexer's **read** path: users can browse
orders that already exist on chain. Phase 3c delivers the **write**
path: a user composes an order in the browser, signs and broadcasts
it to Blurt, and pays the Morphit listing fee.

Several decisions couldn't be made in Phase 3b because they depend
on the compose flow:

1. **Fee payment mechanics.** The PLAN says listing costs "$0.25
   USD-equivalent, 50% off in BLURT." How does the indexer verify
   the user actually paid? What happens if the user underpays?
2. **Transaction composition.** The `morphit_order_v1` op is a
   `custom_json` signed by the posting key. A BLURT transfer is
   signed by the active key. These are different auth levels. Do
   they go in one transaction or two?
3. **Replace-window enforcement.** ADR-0001 mandates 3 minutes.
   Enforced where — on the client (so the UI hides the button),
   on the indexer (so late replaces are ignored), or both?
4. **Sybil fee escalation.** "Orders 1–3 at $0.25, 4–10 at +25%,
   11+ at +50%, resets when old orders cancel or expire" is
   prescriptive but underspecified. What counts as "an order"
   for the purpose of counting? Rolling 24 hours, calendar day, or
   since-last-reset?
5. **Self-trade detection.** "Indexer correlates fee-payment
   patterns" — concretely, which signals?

## Decision

### 1. Fee payment — single Blurt transaction, two operations

Posting an order is a single Blurt transaction containing two
operations in order:

1. `custom_json` — the `morphit_order_v1` op, signed by the
   signer's posting key
2. `transfer` — a BLURT transfer from the signer to the Morphit
   fee-collection account `@morphit-fees`, signed by the active
   key, with a specific memo format

Both ops go in **one** signed transaction. This gives atomicity:
either both land on chain or neither does. A user cannot post an
order without paying, nor pay without posting. The frontend asks
the user to unlock their active key once, signs the whole
transaction, and broadcasts.

The transfer memo format is:

```
morphit-fee:<permlink>
```

This ties the fee to the specific order. The indexer's order
handler looks for a matching transfer op in the same transaction,
with the correct amount (±1% tolerance for price-feed drift) and
recipient. If not found, the order is marked `rejected:fee_missing`
and invisible in the orderbook.

### 2. Fee currency and amount calculation

BLURT-only in Phase 3c. Paying in BTC or XMR would require
waiting for confirmations before the order goes live —
unreasonable for a listing that may only be up for 24h anyway.
The $0.25 ✕ 50% BLURT discount nets to **$0.125 USD-equivalent in
BLURT**, which at the fallback price of $0.002/BLURT is 62.5
BLURT. A round-up to 63 BLURT is what the compose UI quotes; the
indexer accepts anything in 62.5..65 BLURT to allow for price-feed
drift (see below).

The frontend fetches the current BLURT price, computes the fee,
and displays it in three ways simultaneously:

- The USD-equivalent number ($0.125 at list; more for escalation
  tiers)
- The BLURT amount the user will actually pay
- The fresh-ness of the price (per ADR-0004 "prices updated X
  seconds ago" indicator)

The indexer also fetches BLURT prices, but its verification
allows a **±1% tolerance** around the expected fee amount to
absorb the mismatch between the price the frontend saw and the
price the indexer sees one block later.

### 3. Replace-window enforcement — indexer is authoritative

The 3-minute edit window is enforced at the **indexer**, per
ADR-0001. The client also respects it (hides the Edit button
after 3 minutes) but only as a UX courtesy — a misbehaving or
out-of-sync client cannot bypass the rule because the indexer
silently drops late `morphit_order_replace_v1` ops.

This means the client computes the window from *block time* of
the original order, not local wall-clock time. The indexer uses
block time too. The `orderReplace` handler checks:

```
current_block_time - original.created_at <= 3 minutes
```

If exceeded: `rejected:replace_window_expired`. The original
order remains on chain, unchanged.

### 4. Sybil fee escalation — 24h rolling window, per account

The listing fee escalates as an account posts more orders in a
rolling 24-hour window. "Orders posted" means orders that are
currently `live` OR that were created in the last 24h (even if
since cancelled/expired). Cancellation does not retroactively
reduce the fee for the cancelled order, but it removes that
order from the *count* so the *next* order pays less.

Concretely, at the moment of posting, the indexer computes:

```
n = count of orders where:
      account = signer AND
      (status = 'live' OR created_at >= now - 24h)
```

The expected fee for the nth order is:

| n        | Multiplier | Expected USD |
|----------|-----------|--------------|
| 1, 2, 3  | 1.00×     | $0.125       |
| 4        | 1.25×     | $0.156       |
| 5        | 1.56×     | $0.195       |
| 6        | 1.95×     | $0.244       |
| 7        | 2.44×     | $0.305       |
| 8        | 3.05×     | $0.381       |
| 9        | 3.81×     | $0.477       |
| 10       | 4.77×     | $0.596       |
| 11+      | 1.50× per additional, compounding on top of tier-10 |

These numbers grow fast by design: an honest user rarely posts
more than 3 orders a day; a spammer pays real BLURT in
escalating amounts. A user who posts and cancels, posts and
cancels, still pays escalating fees as long as they're doing it
within a 24h window.

The compose UI shows the user which tier they're in and what the
fee is, before they sign. No surprises.

### 5. Self-trade detection — two signals

An indexer cannot prove two accounts belong to the same person,
but it can flag patterns that strongly suggest it:

**Signal A — fee-address timing.** Two accounts that:
- Post orders within 5 minutes of each other
- Have never previously broadcast to chain before their
  respective `morphit_profile_v1` ops
- Have their `account_create` ops signed by the same creator
  account

→ flagged as `related_accounts`. Feedback between flagged pairs
is weighted to zero in their reputation totals.

**Signal B — feedback reciprocity.** Two accounts that:
- Exchange ≥3 mutual 5-star reviews within 7 days
- Have no other feedback from third parties

→ flagged as `suspicious_reciprocity`. Same weighting treatment.

Both signals are advisory, not dispositive. Flagged pairs are
publicly visible on their profile pages so other users can judge
for themselves. No automated penalties beyond the feedback
weighting.

## Schema changes

Three new indexer tables:

- `fee_transfers` — records of observed BLURT transfers to
  `@morphit-fees` with parsed memo. Indexed on `memo_permlink`
  and on `signer` for the Sybil counting query.
- `related_accounts` — self-trade Signal A output. Rows written
  when the pattern is detected; never deleted.
- `suspicious_reciprocity` — Signal B output. Same write-once
  semantics.

And one new field on `orders`:

- `fee_status` — one of `unverified`, `verified`, `missing`,
  `underpaid`. Set by the order handler based on what it finds
  in `fee_transfers`.

Migration version bumps to 2 in `src/db/migrations.ts`.

## Alternatives considered

### Two separate transactions for order + fee

- **Pros:** simpler crypto ceremony — one op per signature.
- **Cons:** race conditions (fee paid but order broadcast fails;
  order broadcast but fee payment times out). No atomicity.
- **Rejected.**

### BTC or XMR fees accepted

- **Pros:** user doesn't need to hold BLURT to list.
- **Cons:** waiting for BTC/XMR confirmations (10+ minutes for
  BTC) makes listing unusable for the "post now while I'm
  grocery shopping" case. Also creates an on-chain feedback
  loop: the indexer would need to watch BTC/XMR networks too.
- **Rejected for Phase 3c.** Revisit if BLURT price crashes and
  the fee becomes prohibitive on a per-listing basis.

### Client-only replace window

- **Pros:** no server-side state to track.
- **Cons:** a misbehaving client bypasses the rule entirely, and
  the chain would accumulate replacement ops that the indexer has
  to silently swallow anyway. Better to make the indexer
  authoritative and have the client match.
- **Rejected.**

### Calendar-day Sybil window instead of rolling 24h

- **Pros:** simpler to reason about.
- **Cons:** a spammer posts their 11th, 12th, 13th orders at
  23:55, then 11th, 12th, 13th again at 00:05. Calendar-day
  window lets them pay tier-1 fees for all 20.
- **Rejected.**

## Consequences

### Positive

- A user who honestly posts 1-3 orders per day pays exactly
  $0.125 per order, every time, forever. No surprises.
- A spammer faces steeply escalating costs within a 24h window.
- The "edit a typo" case works for 3 minutes after posting, which
  is plenty of time for the user to notice the typo during their
  own "did I spell everything right?" review.
- The fee payment and order posting are atomic. No "I paid but
  my order isn't showing up" scenarios.

### Negative

- BLURT price volatility means the USD-equivalent fee shifts.
  A user fetching the price at T=0 and broadcasting at T=30s may
  be ±0.5% off the indexer's later price; we absorb this with the
  1% tolerance band.
- The fee-collection account (`@morphit-fees`) is a centralised
  point. Compromise of this account's owner keys lets an
  attacker divert fees. Mitigation: owner/active keys are cold-
  stored, posting key used only for public announcements.
- A user who pays the fee but whose order is rejected for
  *other* reasons (malformed payload, for example) loses the
  BLURT. This is acceptable: the fee is a cost of trying to
  post, not a refundable prepayment.

### Neutral

- The Sybil escalation table is tunable via config without
  schema changes. If real-world usage shows the numbers are
  too aggressive or too lenient, adjust and redeploy.

## Non-goals (explicit, for future phases)

- Featured-slot auction (Phase 3c is "minimum viable orderbook";
  featured slots are Phase 4+).
- Multi-currency fee acceptance (Phase 3c is BLURT-only).
- Automated chargeback or refund mechanism for rejected orders
  (Phase 5 at earliest).
- Email notification when an order's fee is rejected (Phase 5;
  the UI shows the fee_status inline on the user's own orders
  page).

## Amendment — 2026-05-07 (Part 70)

The replace-window referenced throughout this ADR ("3 minutes")
was extended to **15 minutes** in Part 70. The full rationale,
threat-model re-analysis, and complete list of updated call
sites lives in `docs/adr/0001-custom-json-replacement.md`
under "Amendments → 2026-05-07."

This ADR's enforcement-point claim still holds: the window is
indexer-enforced, the client respects it as a UX courtesy, and
a misbehaving or out-of-sync client cannot bypass the rule.
Only the numeric value changed. References in the body of
this document to "3 minutes" should be read as "the
replace-window value, now 15 minutes per the 2026-05-07
amendment."

---

## Part 113 amendment (2026-05-10) — Signal C + cited-order fee_status gate

### Reputation attack surface enumerated

A from-scratch audit of every way someone's
reputation score can be **faked** (inflation) or
**hurt** (deflation) caught two real gaps in the
pre-Part-113 defenses.

**Vector A5 — feedback citing an order whose
`fee_status` is NOT 'verified'.**  The feedback
handler's cited-order check (added per Finding R17)
only required that the order exists and belongs to
the subject.  An order with `fee_status='missing'`
or `'underpaid'` — meaning the listing fee was
never paid — was still a valid citation target.
An attacker could broadcast many `morphit_order_v1`
ops without paying any fee and use those rows as
free citation targets for fake feedback from sock
puppets.  Forging a citation target was effectively
free (sub-BLURT op-broadcast cost).

**Vector B3 — coordinated low-rating pile-on.**
Signal A catches same-creator close-timed clusters
(reputation inflation via tightly-related sock
puppets).  Signal B catches mutual 5-star exchange
clusters (inflation via reciprocal sock-puppet
reviews).  Neither catches the deflation case: a
malicious actor coordinates 3+ sock-puppet accounts
from different creators to leave 1-2 star reviews
on a victim's orders, cratering their visible
average rating.

### Fixes shipped in Part 113

**Fix #1 — fee_status='verified' on cited orders.**
The feedback handler's order EXISTS check now
includes `AND fee_status = 'verified'`.  Rejection
reason renamed `order_permlink_not_found` →
`order_permlink_not_found_or_unverified` to make
the distinction explicit.

Economic effect: forging a citation target now
costs the actual listing fee (~$0.25 in
BLURT/BTC/XMR equivalent).  An attacker
provisioning 5 sock puppets to leave reviews about
themselves now pays $1.25 in real fees just for
the citation targets, plus the cost of provisioning
the sock accounts.  Reputation inflation is no
longer free.

### Signal C — one-way pile-on

**Trigger criteria (all must hold):**

1. ≥3 distinct reviewers targeting the same subject
2. Each reviewer's avg rating to that subject ≤2 stars
3. All reviews posted within a 7-day window
4. All reviewer `first_activity_at` clusters within
   a 14-day window (newly-active cluster vs
   varied-history real users)
5. Each reviewer's `distinct_subjects` in last 30
   days ≤2 (focused on the target, not diversified
   across the marketplace)

→ flagged as `one_way_pile_on`. Same advisory-not-
dispositive treatment as Signals A and B: feedback
from flagged reviewer→subject pairs is excluded
from the reputation summary aggregate but still
appears on the subject's public profile list.

**False-positive guard:**  Criterion 5 is the
backbone.  A real user reviewing five different
counterparties in the last month and giving one a
1-star has `distinct_subjects=5` and isn't
flagged.  A sock-puppet whose only Morphit activity
is a few low-star reviews on one target has
`distinct_subjects=1`.  Criterion 4 (clustered
first-activity timing) is the secondary guard
against patient-attacker sock puppets that activate
spread out over months.

### New schema (migration v31)

```sql
CREATE TABLE IF NOT EXISTS one_way_pile_on (
    id              BIGSERIAL PRIMARY KEY,
    subject         TEXT NOT NULL,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    detection_date  DATE NOT NULL DEFAULT CURRENT_DATE,
    attacking_reviewers JSONB NOT NULL,
    avg_rating      NUMERIC(3, 2) NOT NULL,
    review_count    INTEGER NOT NULL,
    review_window_days INTEGER NOT NULL,
    activity_cluster_days INTEGER NOT NULL,
    UNIQUE (subject, detection_date)
);
```

UNIQUE (subject, detection_date) means same-day re-
runs don't insert duplicate rows; an expanding
attack appears as a new row the next day with the
larger attacker set.

### Aggregate exclusion

Both summary aggregates that drive user-visible
"reputation" — the per-account
`/v1/accounts/:account/feedback` summary and the
orderbook `weighted_rating` column — now filter out
rows where the (reviewer, subject) pair appears in
ANY of:

- `suspicious_reciprocity` (Signal B)
- `related_accounts` (Signal A)
- `one_way_pile_on` attacking_reviewers JSONB array
  (Signal C — new)

The list view (`/v1/accounts/:account/feedback`
list response) still returns the suppressed rows
so the subject can see what's been said about
them; only the aggregate excludes them.

### Priority-lens evaluation

- **Privacy (#1)**: zero new on-chain data; uses
  existing `feedback` + `accounts` tables.
  Detector runs locally on each indexer; results
  are local DB state, not federated.
- **Decentralization (#2)**: each operator's
  indexer runs the detectors independently.
  Different operators may flag different subsets
  if their indexers see different chain ranges
  (e.g. operator started later, missed early
  history) — that's expected and acceptable.
- **Grandma-friendliness (#3)**: end-user visible
  behavior is "the rating average ignores
  obviously-coordinated review clusters."  No new
  UX, no new operator config.

### What's NOT done (deferred)

- **Per-row "this review excluded by Signal C"
  badge in the list view.**  Filed as future UX
  improvement.  Currently the subject sees the
  flagged review in their list but no indicator
  that it's excluded from the aggregate.  Reviewing
  attackers via the database directly works for
  operators.

- **Display name-only "Signal A/B/C flagged"
  badge on profile.**  ADR-0009 says flagged
  pairs are "publicly visible on their profile
  pages."  Currently this is implicit — the
  rating is suppressed but the profile doesn't
  say "this account was flagged."  Filed as
  future UX work.

- **Time-decay of reputation.**  Old reviews
  weighted same as recent ones.  Acceptable per
  the FAQ design ("permanent and public").

- **A6 — verifying the reviewer was a counterparty
  on the trade.**  Structurally undecidable
  (Morphit trade settlement is off-chain).
  Acknowledged limitation.
