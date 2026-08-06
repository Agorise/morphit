# ADR-0041 — Cross-instance peer price disagreement detector (cp129 Defense F)

**Status:** Accepted (shipped 2026-05; pre-launch hardening campaign)

**Date:** 2026-05-23
**Deciders:** project maintainer (Ken)
**Related:** ADR-0039 (self-sovereign pricing — designed 8 black-hat defenses A-H; Defense F was deferred from cp127 to "future work"; cp129 implements it).  ADR-0040 (denomination configurability — the same-denomination filter in Defense F builds on this).

## Context

ADR-0039 designed the `morphit_native` price fetcher with eight
specific manipulation defenses (A through H).  Seven shipped in
cp127.  Defense F — **cross-instance peer disagreement detector**
— was deferred because it required federation-aware code that
ADR-0039's scope didn't cover.

The threat Defense F addresses: **what if THIS indexer is the one
being manipulated?**

All other cp127 defenses assume the indexer's own code paths are
correct and the manipulation happens at the trader / data-source
level (sock-puppet whales, slow-drift attacks, post-and-cancel
races, etc.).  But what if an operator is compromised — pressured
by a regulator, bribed, captured — and starts patching their
indexer to report a fake derived price?  None of the in-indexer
defenses can catch this; the indexer IS the source of truth for
its own derivation.

Cross-instance peer disagreement DOES catch it.  If my indexer
reports BLURT/USD = $0.005 while every other indexer reports
$0.002, that disagreement is suspicious by construction.  An alert
surfaces; the operator can investigate; users get a warning surface
on `/v1/health`.

## Decision

Ship a new background module — `peerPriceMonitor.ts` — that
periodically samples peer instances' `/v1/price/morphit-native/receipt`
endpoint, stores observations to a dedicated DB table, computes
the peer median over a recent window, and compares against the
indexer's own derived price.  Sustained disagreement above
threshold fires an alert.

### Module

`apps/indexer/src/indexer/price/peerPriceMonitor.ts`
(~480 lines including doc-comment).  Exports:

- `runPeerPriceSampleCycle(cfg, now?)` — one sample cycle (query
  peers + store + compare + maybe alert).  Returns a
  `PeerSampleCycleResult` for testability.
- `startPeerPriceMonitor(cfg, intervalMinutes?)` — schedules
  recurring cycles via `setInterval`; returns a stop function.
- `fetchPeerReceipt(origin, asset, denomination_fiat, timeoutMs?)`
  — single-peer HTTP query with short timeout + graceful failure.
- `median(values)` — pure-function median (sort-invariant,
  resists single outlier).
- `disagreementExceedsThreshold(myPrice, peerMedian, threshold)`
  — pure-function comparison.
- `shouldFireAlert(aboveSince, now, lastAlert, sustained, cooldown)`
  — pure-function alert decision (testable without wall-clock).
- `pruneOldObservations(db, now?, retentionDays?)` — TTL cleanup.

### Storage

New schema-v36 table `price_peer_observations`:

| Column | Type | Notes |
|---|---|---|
| peer_origin | TEXT | URL of the peer instance |
| asset | TEXT | which asset's price (BLURT today; BTC/XMR future) |
| denomination_fiat | TEXT | which fiat (USD today; EUR/XDR/XAU future per cp128) |
| observed_price | NUMERIC(38,18) | peer's reported derived_price |
| observed_at | TIMESTAMPTZ | when we recorded it |
| source_native | TEXT | 'morphit_native' / 'unknown' — only morphit_native rows are used in the median |

Indexed on `(asset, denomination_fiat, observed_at DESC)` for
fast median-window queries.  TTL'd to 7 days; cleanup runs every
cycle.

### Configuration

Two new env vars (both with sane defaults):

| Env var | Default | Purpose |
|---|---|---|
| `MORPHIT_INDEXER_PEER_PRICE_MONITOR_ENABLED` | `false` | Opt-in master switch.  Off for new instances with no peers. |
| `MORPHIT_INDEXER_PEER_PRICE_SAMPLE_INTERVAL_MINUTES` | `30` | How often to sample peers.  ≥5 min recommended. |

Numeric thresholds (built into the code, not env-tunable):

| Constant | Default | Purpose |
|---|---|---|
| `PEER_DISAGREEMENT_THRESHOLD` | 0.25 | 25% deviation triggers the over-threshold flag |
| `PEER_DISAGREEMENT_WINDOW_HOURS` | 4 | Time window for median computation |
| `PEER_DISAGREEMENT_SUSTAINED_HOURS` | 4 | Hours over-threshold before alert fires |
| `PEER_ALERT_COOLDOWN_HOURS` | 24 | Hours between alerts (anti-spam) |
| `PEER_MIN_OBSERVATIONS` | 3 | Below this, comparison is silent |
| `PEER_OBSERVATION_RETENTION_DAYS` | 7 | TTL for stored observations |
| `PEER_FETCH_TIMEOUT_MS` | 10000 | Per-peer HTTP timeout |

These are constants to keep the trust model legible.  An
operator who wants to tune them needs to fork the code, which is
a feature: peer-disagreement thresholds are a federation-level
concern that shouldn't drift per-instance.

### Wiring

- `apps/indexer/src/main.ts` starts the monitor on boot when
  enabled.  Stop function registered for graceful shutdown.
- Federation discovery uses the existing `known_instances` table,
  filtered to `last_probe_status IN ('good', 'quiet')` — peers
  the federation prober already vetted.

### Why median, not mean

A single malicious peer feeding a wildly wrong price (e.g.
$1 BLURT/USD instead of $0.002) shouldn't be able to move the
result.  Mean is shifted by extreme values; median is not.

This means an attacker needs to compromise **a majority of peers
in the comparison window** to manipulate the median — not just
one or two.  Combined with the federation prober's existing
operator chain-registration checks (which require costly setup
to get a peer into the directory at all), Sybil-ing the peer set
becomes expensive enough to deter the attack class.

### Why ≥3 peers minimum

Below 3 peers, the median is trivially moved by any single outlier
(with 2 peers, median = average of the two; with 1, median = that
value).  At 3 peers, a single outlier is the min or max and gets
filtered out by the median.

Operators with fewer than 3 reachable peers see the monitor
degrade gracefully — no alert is ever fired.  This is a feature:
no signal is better than a misleading signal.  An operator running
on a brand-new federation should leave the monitor off until they
have enough peers.

### Same-denomination filter

Cp128 made denomination configurable per-operator.  A USD-
denominated indexer cannot meaningfully compare its BLURT/USD
price to a EUR-denominated peer's BLURT/EUR price without a
USD/EUR oracle, which would defeat the self-sovereign premise.

So the monitor filters peers to those reporting the SAME
denomination_fiat.  A USD-denominated indexer in a mostly-EUR
federation will see few comparable peers and skip the comparison
entirely (which is correct).

### Same-source filter

The receipt endpoint can return prices from various sources
(external feeds, native fetcher, static fallback).  Comparing my
native-derived price to a peer's external-feed-derived price is
apples-to-oranges.  So the median only includes peer observations
where `source = 'morphit_native'` — apples to apples.

Peers running older versions that don't include a `source` field
get tagged `'unknown'` and excluded from the median.

## Resilience scenarios

### Single peer compromised, reporting wildly wrong price
- Their observation is one data point among ≥3.
- Median is unmoved.
- No alert.  Defense works as designed (resistant to outliers).

### Half the peers compromised, all reporting same wrong price
- The compromised group sets the median.
- I'd appear to be the outlier from MY perspective; my alert
  would fire on innocent me.
- **This is the inherent limit** of any majority-based defense.
  Same blind spot as cp127's "consensus from compromised
  sources."  Cross-federation peer-Sybil is expensive but not
  impossible.
- Mitigation: the federation prober's chain-registration check
  (each peer must have a chain-broadcasted `morphit_operator_register_v1`
  op) raises the cost.

### My indexer compromised, reporting wildly wrong price
- Healthy peers' median is correct.
- I'm the outlier.
- Alert fires within 4 hours of sustained disagreement.
- **This is the primary attack class Defense F catches.**

### My indexer + few peers compromised, but most peers healthy
- The median is mostly determined by the healthy majority.
- I'm flagged as the outlier (correct).
- Alert fires.  Defense works.

### Genuine market disagreement (e.g. flash crash)
- Different peers may have updated their native price at
  different cadences.
- Window is 4 hours — short-term volatility is averaged in.
- Sustained-disagreement window adds another 4 hours of dwell.
- For a true 8-hour disagreement to fire, the market must
  genuinely be reporting a divergent price.  Reasonable.

### Geographic isolation (peer-poor federation)
- <3 peers reachable → monitor degrades silently.
- No false alarms.  Operator can investigate manually via
  `/v1/instances` and `/v1/price/morphit-native/receipt`.

### All peers offline (network partition)
- 0 observations → silent.
- Operator sees `peersQueried: N, observationsInWindow: 0` in
  debug logs.

## What this design DOESN'T solve (honest limitations)

- **All-federation collusion / shared poisoned source.**  If
  every operator is reporting the same wrong price (e.g. because
  they all rely on the same compromised external data), no
  cross-instance comparison can detect it.  Same limitation as
  ADR-0039's Defense C documented.
- **Geographic-isolation false negatives.**  An operator in a
  region where most peers are unreachable just sees fewer peer
  observations and may degrade to silent.  Mitigation: monitor
  multiple federation peers across Tor + I2P + clearnet for
  reachability redundancy.
- **Per-peer trust weighting.**  All peers count equally in the
  median.  A future enhancement could weight peers by their
  age, trade volume, or federation-prober "goodness."  Cp129
  ships the simpler equal-weight approach; weighted-median is a
  REVISIT item.

## Operator action required

- **None mandatory.**  Default `MORPHIT_INDEXER_PEER_PRICE_MONITOR_ENABLED=false`
  is safe for any instance.

- **Optional for operators with federation peers:** set the env
  var to `true` after confirming you have ≥3 reachable peers via
  `/v1/instances`.  No code change needed.

## Privacy + decentralization posture

Per priorities #1 and #2:

- **Peer queries are over normal HTTPS** — same as the federation
  prober's existing queries.  No new privacy surface.
- **Observations live in this indexer's own DB** — never federated,
  never on-chain, never logged externally.
- **No new central authority.**  Each indexer makes its own
  comparison; alerts are local-only (operator logs + own
  `/v1/health`).
- **No new mandatory peer.**  Disable the env var and the monitor
  doesn't run at all.

## Smokes

`apps/indexer/scripts/peer-price-monitor-smoke.ts` — 28 structural
scenarios covering: public surface area, sane numeric defaults,
median pure-function correctness (including outlier-resistance),
disagreementExceedsThreshold correctness (both directions, edge
cases), shouldFireAlert correctness (sustained, cooldown, edge
cases), and doc-comment defense manifest.

## Future work

- **Weighted peer median** (REVISIT cp130+) — weight peers by
  federation-prober goodness score, age, or trade volume.
- ~~**/v1/health surface** for the peer-disagreement state~~ —
  **Done, cp233.**  The latest peer-comparison cycle now surfaces on
  `/v1/health?verbose=1` under `price.peer` (peers queried, peer
  median vs own price, deviation, above-threshold flag, alert),
  captured via an optional `onResult` callback on
  `startPeerPriceMonitor` so F's core logic was untouched.  Surfaced
  alongside the cp233-wired defenses B (`price.drift`) and C
  (`price.disagreement`) — see ADR-0039's cp233 update.  (The cp129
  `schema.sql` comment claimed F already surfaced here; that was
  aspirational until cp233 — this future-work item was the accurate
  record.)
- ~~**Cross-asset extension**~~ — **Done, cp130.**  The monitor is
  started per-asset for every configured (asset, denomination_fiat)
  pair (BLURT/BTC/XMR); cp233 captures each asset's latest result.

## Related code/docs

- `apps/indexer/src/indexer/price/peerPriceMonitor.ts` — module
- `apps/indexer/src/db/schema.sql` — schema-v36 table
- `apps/indexer/src/config/index.ts` — env vars + Config fields
- `apps/indexer/src/main.ts` — startup + graceful shutdown wiring
- `apps/indexer/src/api/health.ts` — `/v1/health` `price.peer` surface (cp233)
- `apps/indexer/scripts/peer-price-monitor-smoke.ts` — 39 scenarios
- `apps/indexer/scripts/price-source-hardening-smoke.ts` — B/C/F wiring + surface scenarios (`BW-*`, `CW-*`, `FS-*`, cp233)
- `ops/env/indexer.env.example` — documented env vars
- `scripts/run-smokes.sh` — smoke registered in runner
