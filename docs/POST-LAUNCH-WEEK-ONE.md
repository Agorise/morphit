# Morphit — post-launch week-one runbook

> Days 1–7 after launch.  What to monitor, what counts
> as "everything fine," what counts as "page the
> operator."

**Audience:** node operator (probably you), or a
sysadmin you've handed off to.

**Assumption:** day-zero launched cleanly (per
`LAUNCH-DAY.md`).  If day-zero is still in progress,
finish that runbook first.

---

## Goal of week-one

Two goals, in priority order:

1. **Catch slow-burn problems** that didn't surface in
   the first 24 hours but reveal themselves with
   accumulated state.  Examples: DB index bloat, log
   directory filling up, relay balance running down,
   price-feed upstreams degrading.

2. **Establish what "normal" looks like** so you (or
   your sysadmin) recognize "abnormal" when it happens
   in week two and beyond.  Take measurements.

---

## What to monitor — daily

A morning + evening sanity check is enough for week
one.  Each takes ~2 minutes.

> **All the `?verbose=1` queries below require
> `MORPHIT_INDEXER_VERBOSE_HEALTH=true` in
> `ops/env/indexer.env`.**  Without it, the
> `diagnostics.*` blocks come back empty.  Set it once
> in your env file, restart the indexer, and these
> queries work as shown.  Operator-opt-in is by design
> (audit finding NEW-9-8: keeps an attacker from timing
> drain attempts against an unhardened instance via the
> public health endpoint).  Surfaced Part 119
> (Sally-operator finding So-3).

### Morning checks

```bash
# Indexer caught up?
curl -s http://localhost:PORT/v1/health \
  | jq '.lag_blocks'
# Healthy: 0 or 1.  Concerning: > 10.
# (lag_blocks is the canonical field; available on the
# plain endpoint without ?verbose=1, so this check works
# whether or not you've enabled verbose mode.)

# Relay account balance?
curl -s http://localhost:PORT/v1/health?verbose=1 \
  | jq '.diagnostics.operator_balances[] | select(.role == "relay")'
# Healthy: last_observed_blurt well above your refill threshold.
# Account creation costs ~100 BLURT/signup; keep
# enough float for several signups + bonuses.
# Suggested thresholds:
#   Top up at 500 BLURT (≈ headroom for 5 more signups)
#   Alert at 200 BLURT (≈ 2 more signups before dry)
# Tune via MORPHIT_INDEXER_OPERATOR_BALANCE_RELAY_THRESHOLD_BLURT.
# below_threshold:true is the scanner's signal.

# Fee account balance (separate from the relay)?
curl -s http://localhost:PORT/v1/health?verbose=1 \
  | jq '.diagnostics.operator_balances[] | select(.role == "fees")'
# Healthy: same shape; below_threshold:false ideally.
# The fees account is receive-only — alerts here mean
# the scanner can't reach Blurt RPC to fetch the balance,
# not that BLURT is dwindling.

# Treasury source — chain-pinned vs env fallback?
# The /v1/release endpoint surfaces this directly; the
# treasury block came from a signed morphit_release_v1
# op once the indexer has seen it.  Pre-release-op, the
# indexer falls back to whatever's in env.
curl -s http://localhost:PORT/v1/release \
  | jq '.treasury'
# Healthy: returns a treasury object with btc.address +
# xmr.address.  If you get null or a 404, your release op
# hasn't been broadcast or hasn't been seen by your
# indexer yet.

# Price feed status?
curl -s http://localhost:PORT/v1/health?verbose=1 \
  | jq '.diagnostics.price'
# Healthy: source=klingex or source=coingecko.
# Concerning: source=static_floor (means BOTH upstreams
# have been failing — investigate but not urgent because
# fee verification is BLURT-native and doesn't depend
# on USD prices).

# Disk usage on the indexer box
df -h /var/lib/morphit-indexer
# Healthy: < 50% on day 7.
# Concerning: > 80%.

# Log directory
du -sh /var/log/morphit-*
# Healthy: bounded by your logrotate config.
# Concerning: growing fast.  Check logrotate is running.
```

### Evening checks

```bash
# Today's signup count
psql "$MORPHIT_INDEXER_DATABASE_URL" -c "
  SELECT COUNT(*) FROM accounts
  WHERE created_block_time > NOW() - INTERVAL '1 day';
"

# Today's order count
psql "$MORPHIT_INDEXER_DATABASE_URL" -c "
  SELECT COUNT(*) FROM orders
  WHERE created_block_time > NOW() - INTERVAL '1 day';
"

# Pending fee verifications (should be small and
# trending down — accumulating pending verifications
# means orders that paid fees aren't getting promoted
# to `verified`)
psql "$MORPHIT_INDEXER_DATABASE_URL" -c "
  SELECT COUNT(*) FROM orders
  WHERE fee_status = 'pending_external';
"
```

If any of these numbers look *very* different from
yesterday's, dig in.  If they look stable + plausibly
trending the right direction, you're done for the day.

---

## What to monitor — weekly (end of week one)

These rolled-up checks make sense once you have a few
days of data:

### Signup conversion

```sql
-- New accounts vs new orders.  A healthy ratio is
-- highly variable; what you're looking for is whether
-- the trend is moving in the direction you expected.
SELECT
  DATE_TRUNC('day', created_block_time) AS day,
  COUNT(*) AS new_accounts
FROM accounts
WHERE created_block_time > NOW() - INTERVAL '7 days'
GROUP BY day
ORDER BY day;
```

### Fee revenue by method

```sql
SELECT
  fee_method,
  COUNT(*) AS orders,
  SUM(CASE WHEN fee_method = 'blurt' THEN fee_amount ELSE 0 END) AS blurt_collected
FROM orders
WHERE fee_status = 'verified'
  AND created_block_time > NOW() - INTERVAL '7 days'
GROUP BY fee_method;
```

### Fee verification health by method

```sql
-- Watch for high "rejected" rates on any method.
-- BTC/XMR rejected often means user submitted a bad
-- proof or wrong address; some baseline rejection rate
-- is normal (user error).  But if rejection > 20% on
-- any single method, the verification path probably
-- has a problem.
SELECT
  fee_method,
  fee_status,
  COUNT(*)
FROM orders
WHERE created_block_time > NOW() - INTERVAL '7 days'
GROUP BY fee_method, fee_status
ORDER BY fee_method, fee_status;
```

### Low-balance refills

```sql
SELECT
  DATE_TRUNC('day', broadcast_at) AS day,
  COUNT(*) AS refills,
  SUM(amount_blurt) AS total_blurt_paid_out
FROM relay_pending_transfers
WHERE kind = 'low_balance_refill'
  AND status = 'broadcast'
  AND broadcast_at > NOW() - INTERVAL '7 days'
GROUP BY day
ORDER BY day;
```

This is part of your operator cost.  Track it.

### Error events

```bash
# Indexer errors in the last 24h
journalctl -u morphit-indexer --since "1 day ago" \
  | grep -E "ERROR|FATAL" | wc -l

# Relay errors in the last 24h
journalctl -u morphit-relay --since "1 day ago" \
  | grep -E "ERROR|FATAL" | wc -l
```

Both should be small (< 10/day for a quiet launch).
If either is spiking, read the actual log lines.

---

## What triggers "page the operator"

These are the symptoms where a sysadmin should
escalate to the operator immediately, regardless of
time of day:

### 🚨 Hair-on-fire

- **Indexer crash-looping** (systemctl shows
  repeated restarts in < 5 minutes).
- **Relay can't pay account-creation fees** (balance
  below chain `account_creation_fee` AND signups
  trying to happen).
- **Database connection failures** (queries timing
  out, connection pool exhausted).
- **Postgres disk full** (`df` shows 95%+).
- **Public-facing API returning 5xx > 10% of
  requests** (broken or under attack).
- **`/v1/release` returning a treasury block with
  unexpected addresses** (chain-pin compromise or DB
  corruption).

### ⚠ Worth a call within business hours

- **Block lag persistently > 50** (indexer is
  falling behind).
- **Relay balance below 200 BLURT** (≈ 2 more signups
  before dry; account-creation costs ~100 BLURT/signup
  on Blurt as set by witnesses).  Top up immediately
  unless you're winding down on purpose.
- **Price feed stuck on `static_floor` > 24h**
  (Klingex + Coingecko both failing for an extended
  period).
- **Pending fee verifications > 100 and growing**
  (something is wrong with the verifier pipeline).
- **Federation peer divergence** (other Morphit
  instances reporting different chain-pinned
  treasury than yours).

### 📋 Track and report at next sync

- **Locale parity drift** (shouldn't happen without
  a code change; if it does, someone manually edited
  a JSON file).
- **Logs filling faster than expected** (might just
  mean more traffic, but check).
- **`account_creation_fee` divergence from chain**
  (witnesses changed the fee; update env to track).

---

## Common week-one situations

### "The price feed shows `static_floor`"

The composite price source has fallen back to the
operator-configured static floor (default $0.002
BLURT/USD).  This happens when BOTH Klingex and
Coingecko have been failing.

**Immediate impact:** none on fee verification (fees
are BLURT-native; USD prices are display-only).

**What to do:**
1. Check if Klingex is reachable from your box:
   ```bash
   curl -sS https://klingex.io/api/v1/ticker/BLURT_USDT
   ```
   (This is the canonical endpoint path the indexer
   uses; override base URL via
   `MORPHIT_INDEXER_KLINGEX_BASE_URL` if Klingex has
   moved the API since this doc was written.)
2. Check Coingecko:
   ```bash
   curl -sS "https://api.coingecko.com/api/v3/simple/price?ids=blurt&vs_currencies=usd"
   ```
3. If both fail, the fallback is working as designed.
   Wait for them to come back.
4. If only one fails, the indexer will use the other.
   You'll see `source=klingex` or `source=coingecko`
   instead of `source=static_floor`.
5. If you need to update the fallback value (BLURT
   moved a lot during the outage), edit
   `MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR` in your
   `morphit.config.env`, restart the indexer.  You can
   also use the wizard:
   ```bash
   morphit-ops edit
   ```
   and navigate to "Fallback BLURT price."

### "Relay account is running low on BLURT"

Send more BLURT to the relay account.  No restart
needed; the relay queries its own balance on every
signup attempt.

If you find yourself topping up frequently, consider:
- Lowering the low-balance refill amount
  (`MORPHIT_INDEXER_LOW_BALANCE_REFILL_AMOUNT_BLURT`).
- Raising the activity threshold
  (`MORPHIT_INDEXER_LOW_BALANCE_ACTIVITY_WINDOW_DAYS`)
  so only highly-active users qualify.
- Letting the chain `account_creation_fee` push you
  out of the signup market by raising your own
  signup ceiling (`MORPHIT_RELAY_SIGNUP_DAILY_CEILING`).

### "A community operator is reporting their fee
verifier marks my treasury txids as `pending_external`"

Most likely cause: their explorer URL list is
configured differently than yours, and one or more of
their explorers is currently slow/down.  Their
verifier returns `pending_external` (quorum not met)
rather than committing to a verdict based on one
explorer.  This is the **Part 109 quorum gate working
as designed** — not a defect.

What they should do:
- Wait — the next polling cycle will retry, often
  successfully.
- Lower their `MORPHIT_INDEXER_{BTC,XMR}_MIN_SUCCESSFUL_RESPONSES`
  to 1 (back-compat mode, weaker guarantee).
- Or add more explorers to their configured list.

There's nothing for *you* to do; it's their
configuration, not your treasury.

### "The brag list says X but I'm observing Y"

The brag list is operator-facing marketing claims.
Per Memory #15, every entry must be verifiable in
code or honestly disclosed as backlog.  If you find a
mismatch in production, that's a real bug — file an
issue.

---

## When to move past week-one monitoring

After 7 days of clean operation:

- You've seen "normal" traffic patterns.
- You know roughly what your relay BLURT burn rate is.
- You've handled at least one minor incident (price
  feed glitch, slow explorer, locale typo) and know
  the playbook.

At that point, dial monitoring down to "once-daily
spot check + alerts on the hair-on-fire conditions."
Don't keep watching everything aggressively forever
— sustainable operations means delegating to alerts.

---

## Backups

Set up automated DB backups if you haven't already.  The
canonical path is the systemd timer the wizard installs
during `morphit-ops init` (step 12, "Daily DB backup
automation"); see `docs/OPERATIONS.md §31` for the full
recipe.  The wizard installs:

- `/usr/local/lib/morphit/morphit-backup.sh` (script,
  mode 0755, owned by root, decoupled from your repo
  location so `git pull` updates don't break the timer)
- `/etc/systemd/system/morphit-backup.service` + `.timer`
- `/etc/morphit/backup.env` (retention + destination,
  mode 0600)

Then `sudo systemctl enable --now morphit-backup.timer`
fires it daily at 02:30 local time by default.  Failures
land in `journalctl -u morphit-backup.service` alongside
your other Morphit logs.

If you skipped the wizard's backup step or your install
predates Part 32, re-run `morphit-ops init` and answer
**Yes** to the backup prompt — your existing config files
won't be touched if you answer **No** at the "write
configuration" review prompt, only the backup section
gets generated.

Retain at least 7 days locally, 30 days offsite.

The relay's pending-transfer queue is the only piece
of state that's *not* derivable from chain — if you
lose the relay DB without a backup, queued refills
and account creations in flight are lost (the user
sees the signup but their account is never created).
Don't skip backups.

---

## Memory rule

**Per Memory #5: this file must be updated in the
same turn as any change that adds new monitoring
surfaces, alerts, or operational concerns for the
post-launch period.**
