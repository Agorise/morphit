# Morphit — launch-day runbook

> The morning-of and first-24-hour procedure for a Morphit
> node operator going live.  This is distinct from
> `PRE-LAUNCH-CHECKLIST.md` (which covers everything you must
> have *done* before this morning) and from
> `POST-LAUNCH-WEEK-ONE.md` (which covers ongoing monitoring
> after day-zero).

**Audience:** node operator (probably you, possibly a
sysadmin handed this doc).

**Assumption:** every box in `PRE-LAUNCH-CHECKLIST.md` is
already ticked.  If anything is unchecked, this runbook is
not yet for you — go finish the checklist first.

---

## T-minus 24 hours

These checks are best done the day *before* launch so any
problem has time to surface without crisis pressure.

- [ ] **Final rehearsal of `morphit-ops init` end-to-end.**
      On a fresh VM (or in a throwaway directory), run the
      wizard, look at the generated files in
      `/etc/morphit-staging`, and confirm:
       - `morphit.config.env` contains your intended fee
         addresses, explorer URL lists, chat-link URLs,
         BLURT fallback price, and listing fee USD target.
       - `morphit.env` (mode 0600) contains your posting
         key wrapped (or in plaintext per your choice).
       - `keystore` directory and files are mode 0600.
       - The wizard's printReview summary matches your
         intent.

- [ ] **Fund the relay account.**  Your relay needs BLURT
      on hand to pay the **`account_creation_fee`** for each
      signup — currently ~100 BLURT each (witness-set, can
      change via witness consensus).  As of beta.28 the relay
      creates each account with a direct `account_create` op
      and pays that fee **inline at signup time** from its
      liquid BLURT; there are no Account Creation Tokens to
      pre-mint (Blurt disabled `claim_account` /
      `create_claimed_account` at hard fork 2).  See the
      §"Funding the relay" section below for the sizing
      tables.

- [ ] **Fund the fees account** *(if you set
      `MORPHIT_INDEXER_FEE_RECIPIENT` to something other
      than `@morphit-fees`)*.  No upfront BLURT is needed
      here — this account *receives* fees rather than
      paying them out — but it should exist on chain
      before launch so the first incoming fee transfer
      doesn't bounce.  Verify with a chain explorer that
      the account name resolves.

- [ ] **Cold-start the indexer and relay** with production
      env, watch the first 60 seconds of logs.  Confirm:
       - Indexer: `block_apply` events progressing
       - Indexer: `treasury_resolve_ok` (or equivalent)
         with the right chain-pinned addresses
       - Relay: `boot_complete`, no `chain_props_*` errors
       - Both: no zod validation errors at startup, no
         fatal clock-drift warnings

- [ ] **Hit `/v1/health` from outside the box** (cellphone
      tethered, not your home connection) to confirm
      reverse proxy + DNS + TLS are working end-to-end.
      Response should be HTTP 200 with JSON body.

- [ ] **Hit the frontend** from outside the box.  Hard-
      refresh, check for:
       - Console errors (open browser devtools first)
       - Locale switcher works
       - Dark mode toggle works
       - `/post` page loads (you don't need to *post*, just
         confirm the flow renders cleanly)

- [ ] **Run the smoke suite locally** one last time:
      ```bash
      bash scripts/run-smokes.sh
      ```
      Expect 3,300+ scenarios passed, 0 runners failed
      (baseline ticks up as smokes are added each release;
      Part 122 cp27 baseline was 3,327; subsequent checkpoints
      from cp30 through cp52 added scenarios on top — current
      lower-bound floor is whatever your `run-smokes.sh` prints
      against the repo state, with 0 runners failed being the
      load-bearing assertion).
      A failure here means *don't* launch tomorrow.

- [ ] **Take a snapshot of your DB.**  PostgreSQL
      `pg_dump`, store offsite.  This is your "rollback
      point" if something goes catastrophically wrong on
      day-zero.

- [ ] **Decide your launch-window monitoring posture.**
      Are you watching live for 24h?  Watching 1h then
      checking every 4h?  Got a sysadmin on call?  Be
      explicit about who's watching what and when.

---

## Funding the relay

### Why the relay needs upfront BLURT

The Morphit relay pays for these BLURT-cost activities:

1. **Account creation (OPERATIONS §2)** — at signup
   time the relay broadcasts a direct `account_create`
   op and pays the chain's `account_creation_fee`
   (currently **~100 BLURT**, witness-set) **inline**
   from its liquid balance. There is no pre-minting and
   no weekly ceremony — Blurt disabled `claim_account` /
   `create_claimed_account` at hard fork 2, so Account
   Creation Tokens no longer exist. Operator-side, the
   cost is "fund the relay enough to cover the ~100 BLURT
   fee for each expected signup." This is the load-
   bearing cost.

2. **Welcome bonus + loyalty BP** — every user who
   completes their first trade gets 20 BLURT (10
   liquid + 10 vested) + a small BP delegation
   (~1 BLURT-equivalent).  Per-user one-time cost
   paid from the relay's running balance.

3. **Low-balance auto-refill (ADR-0010 §3)** — when a
   user runs critically low on BLURT (default threshold
   0.5 BLURT) and they've been active recently, your
   indexer signals the relay to top them up with a small
   refill (default 1 BLURT).  This keeps active users
   from getting stuck mid-flow because they ran out of
   chain gas.

4. **Routine relay ops** — chat-identity registrations,
   feedback ops, etc.  These are small (sub-BLURT) but
   add up.

### How much to fund up front

The ~100 BLURT account-creation fee dominates.  Sizing
covers the inline fee charged per signup plus the
bonuses/refills paid from the running balance:

| Use case | Approx cost breakdown | Suggested initial float |
|---|---|---|
| 1 signup | ~100 BLURT fee + ~21 BLURT bonus | ~121 BLURT |
| 5 signups (quiet soft-launch with testers) | ~500 BLURT fees + ~105 BLURT bonuses | **~700 BLURT** |
| 50 signups (first-week small) | ~5,000 BLURT fees + ~1,050 BLURT bonuses | **~6,000 BLURT** |
| 100 signups (first-week medium) | ~10,000 BLURT fees + ~2,100 BLURT bonuses | **~12,000 BLURT** |
| 100 signups + 100 refills | ~10,000 BLURT fees + ~2,200 BLURT | **~12,500 BLURT** |

**Don't get caught short.**  An operator who funds
just 250 BLURT (the pre-Part-112 figure, since
corrected) cannot cover the creation fee for even 3
signups.  The old sizing (50/250/500 BLURT) assumed
a ~1 BLURT/signup chain fee; the canonical default
in `apps/indexer/src/config/index.ts` is ~100 BLURT,
which the relay pays inline per `account_create`.

You can top up any time without restart — the relay
checks its own balance on every signup and emits an
`operator_balance_low` log line when it's running thin.

### Where to send the BLURT

Send to whichever account name you set as
`MORPHIT_RELAY_ACCOUNT` in your relay env.  The wizard
defaults this to `@morphit-relay`, but if you used a
different name (e.g. `@your-org-relay`), use that.

You can check your configured relay account at any time
with:
```bash
grep MORPHIT_RELAY_ACCOUNT /etc/morphit/relay.env
```

### What about `@morphit-fees`?

The fees account **receives** BLURT-paid listing fees —
it doesn't *pay* anything.  No upfront funding is needed.
However the account itself must exist on chain.  If you
configured `MORPHIT_INDEXER_FEE_RECIPIENT=morphit-fees`
(the default), the canonical `@morphit-fees` account
already exists.  If you set a custom name, ensure the
account is created before your first listing-fee transfer
attempts to deliver to it.

### Monitoring relay balance day-of

The `/v1/health?verbose=1` endpoint exposes the relay's
last-known balance under `diagnostics.relay`.  Watch for
that number to trend down, not for it to hit zero — once
the relay can't pay an account-creation fee, signups
silently start failing.  Top up well before zero.

---

## T-minus 1 hour

- [ ] **Re-run health checks.**  `/v1/health` returns 200.
      Frontend loads.  No new error events in the last
      hour's logs.

- [ ] **Open the monitoring window.**  Whatever tool
      you'll use to watch logs for the next 24h —
      `journalctl -fu morphit-indexer` in a tmux pane is
      perfectly fine if that's your style — start it now.

- [ ] **Have the rollback plan one keypress away.**  See
      §"Rollback" below.

- [ ] **Tell your community / waitlist** that you're
      about to go live.  Set expectations: "first 24h is
      monitoring window, please report anything weird."

---

## T-zero (launch)

Morphit doesn't have a "launch button" — going live is
literally "stop telling people not to use it yet."  The
node has been running for at least 24h by now; you're
just opening it to traffic.

- [ ] **Remove any geofence / waitlist gate** if you had
      one.

- [ ] **Post the launch announcement.**

- [ ] **Watch logs.**  See §"What to watch in the first
      hour" below.

---

## What to watch in the first hour

These are the **leading indicators** that something is
about to go wrong.  Tail them aggressively for the first
hour, then back off to spot-checks for the rest of day-
zero.

### Indexer logs (`journalctl -fu morphit-indexer`)

- ✅ `block_apply` events progressing every ~3 seconds
- ✅ Occasional `treasury_resolve_ok`, `price_refresh_ok`
- ⚠ `chain_props_account_creation_fee_diverges_from_config`
  appearing — means witnesses changed the chain fee and
  your env var is out of date.  Not urgent (relay uses
  chain value for live ops) but update the env when you
  can.
- 🚨 `block_apply_error`, `fee_verifier_throwing`,
  `treasury_resolve_error` — these are real problems.
  Stop and investigate.

### Relay logs (`journalctl -fu morphit-relay`)

- ✅ `signup_complete` events as users sign up
- ✅ `operator_balance_check_ok` periodic events
- ⚠ `operator_balance_low` — top up the relay account
- 🚨 `operator_balance_insufficient` or
  `account_creation_failed` — signups are failing.
  Top up immediately.

### Frontend (from a real user browser)

- Open `/post`, try posting a test order with your own
  account (don't pay the fee — just confirm the form
  works).  Cancel before signing.
- Check that locale switching, dark-mode toggle, and
  navigation work.

### `/v1/health?verbose=1` polled every minute

> **Sally-operator finding So-3 (Part 119): you must enable verbose
> mode in your env first.**  The `diagnostics` block (containing
> `operator_balances`, `price`, `explorers`, `sse_subscribers`,
> `last_error`, `started_at`) only renders when
> `MORPHIT_INDEXER_VERBOSE_HEALTH=true` is set in
> `ops/env/indexer.env`.  Without it, `?verbose=1` returns the
> same minimal payload as the plain endpoint — by design (audit
> finding NEW-9-8: verbose mode is operator-opt-in to keep an
> attacker from timing a drain attempt against an unhardened
> instance).  Set it before launch day or you'll waste 20 minutes
> wondering why the loop emits empty objects.

A minimal monitoring loop:
```bash
while true; do
  curl -s http://localhost:PORT/v1/health?verbose=1 \
    | jq '{
        status: .status,
        block_lag: .lag_blocks,
        stale: .stale,
        relay_balance: (.diagnostics.operator_balances[] | select(.role == "relay") | .last_observed_blurt),
        price_source: .diagnostics.price.source
      }'
  sleep 60
done
```

(Field paths re-verified against `apps/indexer/src/api/health.ts`
in the Part 119 audit — the canonical fields are `status`
(values: `ok` / `degraded`), `lag_blocks`, `stale`, and the
verbose-only `diagnostics.{operator_balances,price,explorers,
sse_subscribers,last_error,started_at}`.  Earlier doc drafts
referenced `diagnostics.indexer.blocks_behind`,
`diagnostics.relay.balance_blurt`, and
`diagnostics.treasury.address_source`; those fields do not
exist in the actual response.  For treasury verification,
poll `/v1/release` separately — the chain-pinned treasury
block lives there, not in `/v1/health`.)

Watch for:
- `status="degraded"` ever → page yourself (the indexer is
  beyond the configured `staleLagThreshold`)
- `block_lag` climbing → indexer falling behind chain
- `relay_balance` < 50 → top up
- `price_source=static_floor` for sustained periods →
  upstreams (Klingex/Coingecko) are failing; not urgent
  but investigate
- `/v1/release` returning null treasury block after you
  broadcast the release-op → release didn't land properly
  or hasn't been seen by your indexer yet; investigate

---

## Rollback

If something goes catastrophically wrong on day-zero,
your rollback plan should already exist.  This section
documents the minimum viable rollback.

### Symptoms requiring rollback

- Indexer crash-looping with no path forward
- Database corruption
- Fee verifier accepting payments it shouldn't (would
  require user money recovery)
- Privacy leak in API responses or logs (user IPs, full
  txids leaking inappropriately, etc.)

### What rollback actually looks like

1. **Stop services:**
   ```bash
   systemctl stop morphit-frontend morphit-indexer morphit-relay
   ```

2. **Take maintenance page live** (or remove DNS record):
   - Replace the frontend with a static "we're back
     shortly" page, OR
   - Drop the A record so users get DNS-fail (less
     graceful but fast).

3. **Announce on community channels** that you're paused
   and you'll be back when fixed.

4. **Restore from yesterday's DB snapshot** if database
   state is the problem.

5. **Investigate calmly.**  Don't ship a fix at 3am.

6. **When fixed, bring services up in order:** indexer
   first (let it catch up to head of chain), then relay,
   then frontend.

### What rollback is NOT

- Reverting code commits in production.  By the time you
  need rollback, you don't need code surgery — you need
  the site down so people stop hitting the broken thing.

- Refunding users.  Morphit is non-custodial; there is
  no operator-side money to refund.  Listing fees that
  paid your treasury are already on-chain and yours;
  failed fees that didn't pay your treasury are still in
  the user's wallet.

---

## First 24 hours — pacing

| Hours after launch | Action |
|---|---|
| 0–1 | Aggressive log tailing.  Spot-check frontend manually. |
| 1–4 | Spot-check every 15 minutes.  Watch the monitoring loop. |
| 4–12 | Spot-check every hour.  Reply to community questions. |
| 12–24 | Spot-check every 4 hours.  Get some sleep if you have someone watching. |
| 24+ | Move to `POST-LAUNCH-WEEK-ONE.md` monitoring posture. |

---

## End-of-day-zero retrospective

Before going to bed (or handing off to a sysadmin):

- [ ] **Snapshot the DB again.**  You now have two
      snapshots: pre-launch + end-of-day-zero.  Both
      stored offsite.

- [ ] **Note any oddities** you saw in the logs that
      weren't already in this runbook.  Add them to a
      personal post-launch journal so you have a memory
      of what "normal day-zero traffic looks like" for
      the next time you do this.

- [ ] **Top up the relay account** if it's drifted down
      meaningfully.

- [ ] **Check `MORPHIT-BRAG-LIST.md` claims against
      reality** — anything in there that turned out
      different in production?  Flag for amendment.

- [ ] **If everything went smoothly:** good.  Reward
      yourself in a way that doesn't involve looking at
      the screen.

- [ ] **If you're handing off to a sysadmin:** point them
      at `POST-LAUNCH-WEEK-ONE.md` and this file.

---

## Federation behavior

On day-zero you're not yet federated — yours is the
canonical morphit.io launch, or you're a community
operator standing up the first instance alongside it.
Federation health monitoring properly belongs in
post-launch week-one.

If you're a community operator launching alongside
canonical morphit.io, your indexer will start verifying
against canonical's chain-pinned treasury automatically
once you've configured the same Blurt RPC endpoint.  No
explicit "join the federation" step exists; federation
is implicit in running the code with the same trust
anchor (`MORPHIT_OFFICIAL_POSTING_PUBKEY`, hardcoded).

---

## Memory rule

**Per Memory #5: this file must be updated in the same
turn as any change that adds or removes a day-zero
operator action.**  If a future Part adds a new
operator-facing concern that affects launch-day
behavior, this file is one of the docs that must be
touched.
