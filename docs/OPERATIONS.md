# Morphit — operator runbook

Practical procedures for keeping Morphit running. Written for the
person who has to do something at 2am when an alert fires, not
for the person reading casually. Short and procedural by design.

If in doubt: **stop, don't improvise**. Most Morphit operations
have a "wait and think" alternative. The only irreversible actions
are key rotations and on-chain broadcasts. See the "escalation"
section for who to contact.

**⚠ This document is a template for the canonical operator.
Community operators running their own instances should adapt
paths, account names, and contact details to their own setup
before relying on any of it.**

> **First time setting up a Morphit instance?** This document is
> the reference manual, not the walkthrough. If you've never run
> a server before, start with [`RUN-A-MORPHIT-NODE.md`](./RUN-A-MORPHIT-NODE.md)
> — it's an ELI5 companion that walks you from zero to a running
> instance, with copy-paste commands and explanations of every
> step. Come back here once your instance is running and you
> need the operational reference content.
>
> **For experienced operators standing up an additional instance:**
> `scripts/vps-bootstrap.sh` (run once as root immediately after
> provisioning a fresh Ubuntu 24.04 host) bundles the host-prep
> steps from RUN-A-MORPHIT-NODE §5 — base packages, SSH hardening,
> UFW firewall, fail2ban, unattended-upgrades, unprivileged service
> users — into one idempotent script. It does NOT install Node,
> PostgreSQL, nginx, or any Morphit code; those steps remain
> manual so you can pick the versions and tunings appropriate to
> your host. Re-discovered Part 119 — the script existed but
> wasn't documented anywhere; manual-first setup is still the
> recommended path for first-time operators.

---

## Contents

0. [Initial account setup — names, roles, and tradeoffs](#0-initial-account-setup--names-roles-and-tradeoffs)
0a. [Initial account funding — the relay needs BLURT to operate](#0a-initial-account-funding--the-relay-needs-blurt-to-operate)
1. [Recurrent BLURT top-up setup (one-time)](#1-recurrent-blurt-top-up-setup-one-time)
2. [Weekly ACT minting ceremony](#2-weekly-act-minting-ceremony)
3. [Relay reboot](#3-relay-reboot)
4. [Responding to a witness fee change alert](#4-responding-to-a-witness-fee-change-alert)
5. [Responding to a relay-queue-stuck alert](#5-responding-to-a-relay-queue-stuck-alert)
6. [Responding to a signup velocity spike](#6-responding-to-a-signup-velocity-spike)
6a. [Moderating accounts — reviewing flags and blocking](#6a-moderating-accounts--reviewing-flags-and-blocking)
7. [Suspected relay compromise](#7-suspected-relay-compromise)
8. [Owner-key rotation ceremony](#8-owner-key-rotation-ceremony)
9. [Paper-key backup protocol](#9-paper-key-backup-protocol)
10. [Escalation](#10-escalation)
11. [Running integration tests](#11-running-integration-tests)
12. [XMR viewkey pre-deploy check (retired)](#12-xmr-viewkey-pre-deploy-check-retired)
13. [Responding to a stale BLURT/USD price feed](#13-responding-to-a-stale-blurtusd-price-feed)
14. [Deployment topology requirement — apps MUST be behind a loopback proxy](#14-deployment-topology-requirement--apps-must-be-behind-a-loopback-proxy)
15. [Frontend CSP + security headers for operators](#15-frontend-csp--security-headers-for-operators)
16. [Operator-account balance alerts](#16-operator-account-balance-alerts)
17. [Relay origin allowlist — protecting your instance from billing drift](#17-relay-origin-allowlist--protecting-your-instance-from-billing-drift)
18. [Signup-drain prevention — the full defense stack](#18-signup-drain-prevention--the-full-defense-stack)
19. [Chat anti-spam (Finding H) — operational reference](#19-chat-anti-spam-finding-h--operational-reference)
20. [Attestation phase transition (Finding I)](#20-attestation-phase-transition-finding-i)
21. [Schema v17 upgrade note — brief orderbook sequential-scan window](#21-schema-v17-upgrade-note--brief-orderbook-sequential-scan-window)
22. [Choosing Blurt RPC endpoints](#22-choosing-blurt-rpc-endpoints)
23. [The morphit.config.env file — operator-tunable knobs in one place](#23-the-morphitconfigenv-file--operator-tunable-knobs-in-one-place)
24. [HTTP/2 deployment requirement (Phase F.5 cross-page trade events)](#24-http2-deployment-requirement-phase-f5-cross-page-trade-events)
25. [Going live — staging procedure + chain-switch](#25-going-live--staging-procedure--chain-switch)
26. [Release signing (SHA-256 + GPG)](#26-release-signing-sha-256--gpg)
27. [Fees and rewards reference](#27-fees-and-rewards-reference)
28. [Operator-payout monitoring](#28-operator-payout-monitoring)
29. [Running a second instance — DO NOT share relay accounts](#29-running-a-second-instance--do-not-share-relay-accounts)
30. [Postgres provisioning — the password sentinel and the init script](#30-postgres-provisioning--the-password-sentinel-and-the-init-script)
31. [Daily DB backup automation](#31-daily-db-backup-automation)
32. [BunkerWeb — recommended WAF / reverse-proxy hardening](#32-bunkerweb--recommended-waf--reverse-proxy-hardening)
33. [Docker deployment — optional alternative to bare-metal](#33-docker-deployment--optional-alternative-to-bare-metal)
34. [UFW firewall + fail2ban — extended hardening](#34-ufw-firewall--fail2ban--extended-hardening)
35. [TLS auto-renewal — quick reference](#35-tls-auto-renewal--quick-reference)
36. [Warrant canary — weekly automated regeneration](#36-warrant-canary--weekly-automated-regeneration)
37. [Comprehensive server hardening — defense-in-depth checklist](#37-comprehensive-server-hardening--defense-in-depth-checklist)
38. [Diamond-hardened squatter defense — operator playbook](#38-diamond-hardened-squatter-defense--operator-playbook)
39. [Operating a home-hosted instance — concerns specific to running on residential internet](#39-operating-a-home-hosted-instance--concerns-specific-to-running-on-residential-internet)
40. [Treasury chain-pin + XMR per-payment proofs — broadcasting and verifying](#40-treasury-chain-pin--xmr-per-payment-proofs--broadcasting-and-verifying)
41. [Federation-cost attribution — only paying for ops served by YOUR instance](#41-federation-cost-attribution--only-paying-for-ops-served-by-your-instance)
Trade-only asset configuration — enabling/disabling tradable assets [(jump)](#trade-only-asset-configuration)
42. [Web Push notifications — VAPID setup and the push-sender worker](#42-web-push-notifications--vapid-setup-and-the-push-sender-worker)
43. [SEO override env vars — homepage title/description/keywords + Twitter card](#43-seo-override-env-vars--homepage-titledescriptionkeywords--twitter-card)
44. [User-side optional TOTP 2FA — operator-side notes](#44-user-side-optional-totp-2fa--operator-side-notes)
45. [MCP server — AI agent surface](#45-mcp-server--ai-agent-surface)

---

## 0. Initial account setup — names, roles, and tradeoffs

Read this before registering any Blurt accounts for your
instance. The choices you make here are permanent — Blurt
account names can't be renamed, and key rotations are
involved enough that you want to get the structure right
on the first try.

### How many accounts do you actually need?

Morphit uses three configurable roles. The canonical
operator (`morphit.io`) uses three distinct Blurt accounts
for them, but that's **not required** — the code reads each
role from an independent env var, so you can collapse any or
all of them.

| Role | Env var (indexer / relay) | What it does |
|---|---|---|
| **Operator** | `MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME` | Signs release-discovery ops. Posting-key pubkey is pinned on each instance's frontend build. |
| **Relay** | (relay's own Blurt keypair loaded at boot) | Spends Mana (Blurt's transaction fuel; "Resource Credits"/"RC" in older docs) to broadcast user-signed ops on the user's behalf. Hot wallet. |
| **Fees** | `MORPHIT_INDEXER_FEE_RECIPIENT` | Receives listing-fee BLURT transfers. Cold wallet in practice — operator sweeps periodically. |

**Why the canonical operator chose three separate accounts:**

- **Operator vs relay separation** keeps the relay's hot
  active key away from the operator's release-signing
  posting key. If the relay VPS is compromised, the
  attacker can burn BLURT on junk transactions but can't
  forge release-discovery ops claiming to be from the
  operator. The pinned `MORPHIT_OFFICIAL_POSTING_PUBKEY`
  in `$net/config.ts` makes this a hard wall.

- **Relay vs fees separation** keeps listing-fee income
  away from the hot wallet. If the relay VPS is
  compromised, the attacker doesn't automatically get the
  operator's accumulated fee revenue — they'd need to
  compromise `@morphit-fees`'s owner key too, which is
  held offline.

- **Operator vs fees separation** is the least important
  but still clarifies audit trails — when users inspect
  on-chain activity, `@morphit` only signs releases,
  `@morphit-fees` only receives transfers. Role purity
  makes "what happened and why" legible.

**Collapsing roles is defensible for small operators.**
The all-in-one variant (one account for all three) has a
much smaller blast radius if YOUR instance never grows
beyond you personally: less keys to track, one account to
fund, one to secure. The "relay + fees separate from
operator" middle variant is a common compromise — hot
wallet isolated from release-signing, but fee accumulation
in the same account that spends Mana.

Pick the separation level that matches your threat model
and operational overhead tolerance. **You can always
start with one account and migrate to three later**, but
the migration means re-pinning pubkeys on all frontend
builds — coordinate with any other operators running your
config.

### Naming — the domain-prefix pattern

If you own a domain you're confident you'll hold long-term
and it fits Blurt's account-name constraints, using it as
your account prefix gives users a visible link between
your web presence and your on-chain identity. The
canonical operator did this:

- `morphit.io` → `@morphit`, `@morphit-relay`, `@morphit-fees`

A user seeing a `custom_json` op from `@morphit` can
immediately guess where to check what software that
op came from. If they see `@morphit-fees` as the recipient
of a fee transfer, the connection to morphit.io is
obvious without needing a directory lookup.

**Example mappings that work:**

- `peertrade.org` → `@peertrade`, `@peertrade-relay`, `@peertrade-fees`
- `swap.fi` → `@swap`, `@swap-relay`, `@swap-fees`
- `otc-corner.net` → `@otc-corner`, `@otc-corner-relay`
  (16 chars exactly — at the limit but legal),
  `@otc-corner-fees` (15 chars)

Adding role suffixes costs 6 chars (`-relay`) or 5 chars
(`-fees`) on top of your base name. A 10-char base is the
practical maximum if you want all three suffixes to fit
without abbreviation.

### Blurt account name constraints

Morphit's indexer validates account names against
`/^[a-z][a-z0-9-]{2,15}$/`, which means:

- Length: **3 to 16 characters** total.
- First character: lowercase letter `a-z` (not a digit,
  not a hyphen).
- Remaining characters: lowercase `a-z`, digits `0-9`, or
  hyphen `-`.
- Permanent — once registered, the name exists forever
  and can't be renamed or transferred to a different
  identity without an ownership change ceremony.

Blurt itself permits some additional patterns (subaccounts
with dots, for example) that Morphit's handlers don't
accept. Stick to the constraints above and you'll be
compatible with every Morphit handler.

**Domain patterns that DON'T fit:**

- Compound TLDs (`trade.example.co.uk` — too long and
  dots aren't legal).
- Domains with underscores or uppercase (not legal in
  Blurt names).
- Long brand names (`community-barter-exchange.com` — the
  base is 25 chars, well over the 16-char cap).
- Very short brands that can't accommodate role suffixes
  (an 11-char base can fit `-fees` but not `-relay`; a
  12+ char base can't fit either).

If your domain doesn't fit, pick a short memorable
alternative that you're prepared to keep indefinitely.
Treat the Blurt name like an ENS registration or a
ham-radio callsign — you're committing to it.

### The "what if I lose the domain" risk

Blurt accounts are permanent; domains are not. If you
register `@swap`/`@swap-relay`/`@swap-fees` based on
owning `swap.fi`, then let the domain lapse, a new
owner of `swap.fi` now has no legitimate connection to
your on-chain identity — but the chain still carries your
historical activity under those names, and you're stuck
with two options:

1. Keep operating under the now-misaligned names (users
   searching for `swap.fi` land on someone else's site,
   but your on-chain presence still says `@swap`).
2. Migrate to new account names (complicated: re-pin
   pubkeys across frontend builds, coordinate with any
   other operators, old accounts still show up in
   historical indexer data).

**Mitigations:**

- Register the domain for the longest term your registrar
  allows, and enable auto-renewal.
- Use a domain you're personally emotionally committed
  to, not one you picked on a whim.
- Consider registering the same brand across multiple
  TLDs to make takeover impersonation harder.
- If you're unsure about the long-term domain, use a
  generic account name unconnected to any specific
  domain — less shiny but robust against future rebrands.

### Setup checklist

Once you've decided on account names and separation
level:

1. Register each account via a Blurt account-creation
   service or community helper. Record the owner, active,
   posting, and memo keys for each in an offline backup
   (paper + encrypted digital copy).
2. Fund the operator and relay accounts with enough
   BLURT to cover initial Mana needs (Mana, formerly called
   Resource Credits) — the relay especially will be
   broadcasting on users' behalf.
3. Publish the operator's posting pubkey as
   `MORPHIT_OFFICIAL_POSTING_PUBKEY` in your frontend
   build's `$net/config.ts`. This is the release-signing
   pinned key — users' clients won't trust release
   announcements signed by any other key, so get this
   right on the first build.
4. Configure the indexer's `MORPHIT_INDEXER_FEE_RECIPIENT`
   and `MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME` env vars
   to match.
5. Proceed to §0a (initial funding) and §1 (recurrent
   top-up setup), then §3 for relay reboot procedure.

---

## 0a. Initial account funding — the relay needs BLURT to operate

Your relay account needs BLURT on hand before launch.
This is the **single most common cause of failed
first-day launches** — operators assume the relay is
purely a service process and forget that it broadcasts
on-chain ops, which cost BLURT.

### Why the relay needs upfront BLURT

The relay performs four kinds of on-chain operations
that cost BLURT:

1. **Account creation for new user signups, via the
   weekly ACT minting ceremony (§2).**  Per
   ADR-0010 §4, the relay does NOT mint Account
   Creation Tokens at signup time.  Instead, the
   operator runs a weekly ceremony that broadcasts
   `claim_account` ops against `@morphit-relay`'s
   balance — each ACT mint burns the chain's
   `account_creation_fee` (currently **~100 BLURT
   per ACT**, witness-set; see §4 for the change-
   response runbook).  At signup time the relay
   broadcasts `create_claimed_account` (fee-free)
   consuming a pre-minted ACT.

   **The 100 BLURT is paid at ACT-mint time, not at
   signup time.**  But operator-side, the cost
   shows up as "you need to fund the relay enough
   to mint enough ACTs to cover expected signups."
   100 BLURT × expected weekly signups is the
   load-bearing number for sizing.  See §2 for the
   ceremony procedure.

2. **Welcome bonus + loyalty BP.**  Every user who
   completes their first trade and leaves feedback
   receives a 20 BLURT welcome bonus (10 liquid + 10
   vested) from your relay; the first verified
   BLURT-paid listing fee triggers a small loyalty
   BP delegation (default 1 BP, ~1 BLURT
   equivalent).  Per-user one-time cost — paid from
   the relay's running liquid balance at the moment
   the user earns it.

3. **Low-balance auto-refill (ADR-0010 §3).**  When a
   user runs critically low on BLURT (default threshold
   0.5 BLURT) and they've been active recently, your
   indexer signals the relay to top them up with a
   small refill (default 1 BLURT).  This keeps active
   users from getting stuck mid-flow because they ran
   out of chain gas.  This feature is **on by default**
   — disable via `MORPHIT_INDEXER_LOW_BALANCE_REFILL_INTERVAL_MS=0`
   if you don't want it.

4. **Routine relay ops** — chat-identity
   registrations, feedback ops, signups failure
   compensations, etc.  These are small (sub-BLURT) but
   add up over thousands of users.

### How much to fund up front

The account-creation cost (~100 BLURT per ACT minted,
roughly one ACT per signup expected) dominates.
Sizing assumes you'll run the weekly ACT minting
ceremony (§2) and want enough float to cover both
the next batch of ACTs and the welcome bonuses /
refills paid from the relay's running balance:

| Use case | Approx cost breakdown | Suggested initial float |
|---|---|---|
| 1 signup | 100 ACT + ~21 BLURT bonus | ~121 BLURT |
| 5 signups (quiet soft-launch with testers) | 500 ACT + ~105 BLURT bonuses | **~700 BLURT** |
| 50 signups (first-week small) | 5,000 ACT + ~1,050 BLURT bonuses | **~6,000 BLURT** |
| 100 signups (first-week medium) | 10,000 ACT + ~2,100 BLURT bonuses | **~12,000 BLURT** |
| 100 signups + 100 low-balance refills | 10,000 ACT + ~2,200 BLURT | **~12,500 BLURT** |

Operator-side this is "fund the relay enough BLURT
to cover next week's ACT minting batch plus the
week's expected welcome bonuses + refills."  The
ACT minting ceremony (§2) is run weekly so you can
size your batch to next-week-expected-signups,
which keeps the relay's standing balance lower than
the total expected cost.

**Don't get caught short.**  An operator who funds
just 250 BLURT (the pre-Part-112 "conservative"
figure, since corrected) cannot mint enough ACTs
for even 3 signups, let alone a meaningful launch.
The old sizing-table figures (50/250/500 BLURT)
were based on a mistaken "~1 BLURT/signup" claim;
the canonical default is ~100 BLURT/signup
(`MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT`
default 100, confirmed in
`apps/indexer/src/config/index.ts`).

You can top up any time without restart — the relay
checks its own balance on every signup and emits an
`operator_balance_low` log line when it's running thin.

### Where to send the BLURT

Send to whichever account name you set as
`MORPHIT_RELAY_ACCOUNT` in your relay env.  The wizard
defaults this to `@morphit-relay`, but if you used a
different name (e.g. `@your-org-relay`), use that.

You can confirm your configured relay account at any
time with:
```bash
grep MORPHIT_RELAY_ACCOUNT /etc/morphit/relay.env
```

### Funding the @morphit account (~10 BLURT, small fixed cost)

The `@morphit` account is the **trust-anchor account**
that signs the canonical `morphit_release_v1` op, which
pins BTC + XMR treasury addresses on chain.  Posting key
stays on the operator's personal laptop, OFF the
morphit.io production box — only the signed serialized
op is copied to a place where the broadcast can happen.

The **warrant canary** is a separate primitive — a
PGP-signed static file at `/canary.txt` regenerated
weekly by `scripts/canary/generate.sh` and signed by
the operator's release PGP key (see §36).  The canary
does NOT consume `@morphit` BLURT; it lives off-chain
and uses a PGP keypair, not the Blurt posting key.

Pre-fund `@morphit` with **~10 BLURT** before launch.
This is a small fixed cost, not signup-rate-dependent:

- Initial `morphit_release_v1` broadcast — sub-BLURT.
- Subsequent re-pins (rare: only when treasury
  addresses rotate or the frontend hash manifest
  changes) — sub-BLURT each.

Rounding up generously to ~10 BLURT covers many years
of releases with comfortable headroom.  Most operators
won't need to top this up for years.

### Funding the fees account (and whether it needs BLURT)

The `@morphit-fees` account (or whatever you set as
`MORPHIT_INDEXER_FEE_RECIPIENT`) **receives** BLURT-paid
listing fees and **has no signing key on any
production box** — it's genuinely receive-only.  No
upfront BLURT funding required.

**However:** the account must exist on chain before any
listing fees can land in it.  Default
`@morphit-fees` already exists on canonical morphit.io.
If you set a custom fees account name, ensure that
account is created on Blurt before your first listing
fee tries to deliver there — otherwise the user's
fee transfer fails, the order doesn't promote to
`verified`, and you have a confused user.

### Quick reference: all three Morphit accounts

| Account | Role | Upfront funding | Signing key location |
|---|---|---|---|
| `@morphit` | Trust anchor (release pin) | ~10 BLURT | Operator's laptop (OFF prod) |
| `@morphit-relay` | Service account (ACT minting + bonuses + refills + payouts) | ~700 BLURT (testers) – ~12,000 BLURT (100 signups/week) | Encrypted on prod box at `/etc/morphit/keys/relay-active.key` mode 0400 |
| `@morphit-fees` | Receive-only treasury | ~0 BLURT | Not on any production box |

The `@morphit-relay` figure dominates because of the
~100 BLURT/ACT chain account-creation fee burned at
weekly ACT minting time (§2).  Plan one ACT per
expected signup plus a safety margin.

### Long-term funding — see §1

§0a is about getting enough BLURT in the relay
account to launch.  §1 covers the recurrent-transfer
mechanism for keeping the relay topped up over time
without manual intervention.

### Monitoring the relay balance

The `/v1/health?verbose=1` endpoint exposes the
relay's last-known balance under
`diagnostics.operator_balances[] | select(.role == "relay")
| .last_observed_blurt` (the scanner reports one entry per
configured operator account; `relay` and `fees` are the
two default roles).  Add this to your monitoring; alert
when it falls below your refill threshold, or when the
matching entry's `below_threshold` flag goes true.  See
`docs/POST-LAUNCH-WEEK-ONE.md` for sample monitoring
scripts.

> **Verbose mode requires an env opt-in.**  Every
> `/v1/health?verbose=1` reference in the operator docs
> assumes you've set `MORPHIT_INDEXER_VERBOSE_HEALTH=true`
> in `ops/env/indexer.env`.  Without it, `?verbose=1`
> returns the same minimal `{ok}` payload as the plain
> endpoint — by design (audit finding NEW-9-8: verbose
> mode is operator-opt-in to keep attackers from timing
> drain attempts against unhardened instances).  Surfaced
> Part 119 (Sally-operator finding So-3).

### Monitoring RPC endpoint health

Both the indexer and the relay depend on a pool of public
Blurt RPC endpoints.  When **all** of them stop responding
(a DNS change, an upstream outage, a rate-limit wall), the
indexer stops advancing and the relay can't broadcast — but
the process keeps running, so the failure is easy to
misread.  `/v1/health` makes this visible without verbose
mode:

```
curl -s http://127.0.0.1:8081/v1/health \
  | jq '{rpc_endpoints_healthy, rpc_endpoints_total, lag_blocks}'
```

`rpc_endpoints_healthy` is how many endpoints are currently
reachable (out of cooldown), out of `rpc_endpoints_total`.
**If this reads `0` while the node is behind, RPC — not the
indexer — is the problem;** check your
`MORPHIT_INDEXER_RPC_ENDPOINTS` (indexer) /
`MORPHIT_RELAY_BLURT_RPC` (relay) list.  A non-zero count
with growing `lag_blocks` is normal during the initial
back-fill.

For deep triage, verbose mode adds per-endpoint detail:

```
curl -s "http://127.0.0.1:8081/v1/health?verbose=1" \
  | jq '.diagnostics.rpc_endpoints'
# [{ url, state: open|half_open|closed, consecutive_failures,
#    cooldown_remaining_ms, ewma_latency_ms, last_success_age_s }]
```

`state` is `open` while an endpoint is in cooldown after
transport failures, `half_open` just after cooldown expires
(eligible to retry, not yet proven), `closed` when healthy.
A rate-limited (`HTTP 429`) or overloaded (`HTTP 502/503/504`)
response counts as a transport failure too, so a throttled
endpoint shows `open`, the node rotates away from it, and the
cooldown ladder backs off automatically instead of hammering
it — which is what the relay needed during the firefight.
A single dead endpoint is harmless — the pool rotates to a
healthy one within the same call; the count and the `state`
fields exist so you can spot a *degrading* endpoint before
it takes the whole list down.  (Endpoint URLs appear only in
the verbose block, which is env-opt-in per the note above.)

> dblurt's own internal "Didn't failover for error code:
> [...]" console line is **suppressed** — that pool does the
> real failover for us, and this `/v1/health` view is the
> authoritative signal.  If you still see that line, you're
> on a pre-beta5 build.

**Catch dead endpoints before they bite.**  You don't have
to wait for a stalled sync to discover an endpoint is gone:

- `morphit-ops doctor` probes every configured endpoint
  (`MORPHIT_INDEXER_RPC_ENDPOINTS` + `MORPHIT_RELAY_BLURT_RPC`)
  with a real `get_dynamic_global_properties` call and reports
  which are reachable, as part of its normal run.  Pass
  `--no-rpc` for a purely-local check (no network).  The RPC
  result is advisory — it does not change doctor's
  boot-readiness exit code (a node still *starts* with dead
  endpoints; it just can't sync), but an `All N endpoints
  unreachable` line is your cue to fix the list.
- `morphit-ops init` probes the list you enter during setup
  and warns (offering to edit) if any endpoint doesn't
  respond — so a typo or a decommissioned node is caught at
  config time, not at 3 a.m.

**Sensible defaults, shared by both services.**  If you leave
`MORPHIT_INDEXER_RPC_ENDPOINTS` and `MORPHIT_RELAY_BLURT_RPC`
unset, the indexer and relay both fall back to the *same*
vetted set of independent public nodes — so a fresh node can
never end up with one service pointed at working endpoints
and the other pointed at nothing (an asymmetry that bit a
real operator).  The wizard also writes that same set to both
explicitly.  The list is defined in one place
(`@morphit/operator-config`); to change it project-wide, edit
that constant — adding more independent nodes increases your
resilience against the simultaneous rate-limiting that public
RPC nodes occasionally hit under load.

When the relay runs out of BLURT, signups silently
start failing (the user sees a generic error in the
UI; the underlying cause is logged as
`account_creation_failed_insufficient_balance` in
the relay's structured logs).  This is recoverable
— top up the account and signups resume — but
visible to users in the interim.

---

## 1. Recurrent BLURT top-up setup (one-time)

Per ADR-0010 §4, `@morphit-relay` is refilled on a weekly cadence
from a funding account via Blurt's native `recurrent_transfer`
operation. Set this up once. It runs autonomously until the
configured duration expires.

### Prerequisites

- A funding account on Blurt that is NOT `@morphit-relay` and
  NOT `@morphit-fees`. This account holds the weekly disbursement
  pool and its active key lives on paper, not on any server.
- An accurate estimate of your weekly signup rate. Start
  conservative — 20 signups/week × (100 BLURT ACT + 20 BLURT
  welcome + overhead) ≈ 2,500 BLURT/week.
- A period during which you plan to run Morphit. The
  `recurrent_transfer` op takes a `recurrence` in hours and an
  `executions` count. Reasonable defaults: `recurrence=168`
  (weekly), `executions=52` (one year).

### Procedure

1. On an air-gapped machine, load the funding account's active
   key. Use `dblurt` or any Blurt-compatible signer.

2. Build and sign a `recurrent_transfer` op:
   ```json
   [
     "recurrent_transfer",
     {
       "from":       "<funding-account>",
       "to":         "morphit-relay",
       "amount":     "2500.000 BLURT",
       "memo":       "morphit:weekly-topup",
       "recurrence": 168,
       "executions": 52,
       "extensions": []
     }
   ]
   ```

3. Broadcast the signed tx from the air-gapped machine to a
   Blurt RPC node (transfer the raw hex over sneakernet or QR
   code; never plug the air-gapped machine into a network).

4. Immediately **power down the air-gapped machine** and lock
   the funding account's active-key paper back in the safe.

5. Note the transaction ID in your operator journal along with
   the amount and end date. Set a calendar reminder for 11 months
   ahead to renew.

### Verifying the transfer is live

On any Blurt RPC, call `condenser_api.find_recurrent_transfers`
with the funding account name. You should see the new
recurrent_transfer with `remaining_executions` counting down
weekly.

### Stopping the recurrent transfer early

Broadcast another `recurrent_transfer` op with the same `from`
and `to` and `amount = "0.000 BLURT"`. Blurt interprets a zero
recurrent_transfer as a cancellation.

---

## 2. Weekly ACT minting ceremony

Per ADR-0010 §4, the relay does not mint ACTs at request time.
The operator mints them in a weekly ceremony so the relay's
working BLURT balance stays small.

### Prerequisites

- SSH access to the relay host as the `morphit-relay` service
  user.
- `@morphit-relay` has enough BLURT for the batch you're
  minting. At 100 BLURT per ACT and 20 ACTs, you need 2,000+
  BLURT available. The weekly `recurrent_transfer` from
  section 1 should be keeping it topped up.
- You know how many ACTs to mint. Target: slightly more than
  your expected weekly signup rate. For 20 signups/week, mint
  25 — gives buffer for a spike.

### Procedure

1. SSH to the relay host.

2. Change to the relay's working directory:
   ```sh
   cd /opt/morphit/apps/relay
   ```

3. Run the mint script:
   ```sh
   npm run mint-acts -- 25
   ```
   (Equivalent to running `npx tsx apps/relay/scripts/mint-acts.ts 25`
   from the repo root; the npm script wraps it for operators
   without `tsx` on PATH.)
   Output looks like:
   ```
   2026-04-19T12:00:00.000Z [mint-acts] loaded config; relay_account=morphit-relay endpoints=4
   2026-04-19T12:00:00.500Z [mint-acts] current account_creation_fee = 100.000 BLURT; minting 25 ACT(s) will burn ~2500.000 BLURT
   2026-04-19T12:00:03.123Z [mint-acts]   [1/25] minted  trx_id=abc123...
   ...
   2026-04-19T12:01:23.456Z [mint-acts] done; succeeded=25 failed=0
   ```

4. Verify on chain: look up `@morphit-relay` on
   `blocks.blurtwallet.com` and check `pending_claimed_accounts`
   has increased by the number of ACTs you just minted.

5. Record in your operator journal: date, count minted, current
   chain fee, any failures.

### Failures during minting

- **RPC timeout on one endpoint**: the script retries the next
  endpoint automatically. If all endpoints fail, log notes
  "FAILED rpc timeout" for that ACT index.
- **Insufficient balance**: minting stops for that op. Check
  the relay's BLURT balance. If it's low, wait for the weekly
  recurrent_transfer to land, then re-run with a smaller count.
- **`account_creation_fee` has changed**: you'll see a non-100
  value in the output. Safe to proceed — the chain-fee change
  doesn't invalidate ACTs. Consider re-running ADR-0011's
  listing-fee-formula math to check Morphit's margin is still
  positive.

### Unattended mode (recommended for low-maintenance operators)

The mint ceremony described above is the manual fallback. For
operators who want to spend less than 5 minutes per month
touching their instance, ship the ceremony off to a systemd
timer. After a one-time setup, the timer fires every Sunday at
04:00 UTC and you don't think about it again.

**Why it's safe to automate**: ADR-0010 §4 originally framed the
ceremony as operator-in-the-loop so a compromised relay couldn't
drain unbounded BLURT into ACTs. The cap is the operator-set
weekly count + the relay's working balance. A timer-driven mint
inherits the same caps — automating doesn't increase the
maximum loss on relay compromise. The operator's role of "yes,
mint 25 again this week" is a cron job.

**One-time setup:**

1. Decide your weekly mint count and add it to `/etc/morphit/relay.env`:
   ```
   MORPHIT_RELAY_WEEKLY_ACT_COUNT=25
   ```
   The script reads this when no argv[1] is provided. Default
   is 25 if the env var is unset.

2. Save your active-key passphrase to a root-only file:
   ```sh
   sudo install -m 0600 -o root -g root /dev/null /etc/morphit/relay.passphrase
   sudo $EDITOR /etc/morphit/relay.passphrase
   # type the passphrase, no trailing newline (the script trims one
   # trailing \n if echo adds it).
   ```

   **Recommended for any operator handling meaningful weekly fee
   volume (>$100/week or so): use `systemd-creds` instead.** The
   plaintext-file path above is the simple option; it works but
   the passphrase exists on disk in cleartext, protected only by
   filesystem permissions. `systemd-creds` keeps the passphrase
   encrypted at rest using the host's TPM (if available) or a
   per-host key, so a backup-tape leak or filesystem-level
   compromise does not directly expose the passphrase.

   **Why this matters beyond disk-at-rest:** the mint-acts
   script reads the passphrase, derives the active key, signs
   one transaction, and exits.  In between read and exit, the
   plaintext passphrase and the derived key live in process
   heap.  A core dump, a kernel oops with `kernel.core_pattern`
   pointing somewhere readable, or a debugger attached by a
   compromised root account can recover both.  `systemd-creds`
   doesn't fully eliminate this — once the credential is
   decrypted into the process, it's still in heap memory for
   the script's lifetime — but it dramatically narrows the
   exposure window: the encrypted blob on disk is useless to
   an attacker without the host's TPM/per-host key, and the
   plaintext only exists during the ~1 second the mint script
   runs (vs. 24/7 for the plaintext file).

   To set this up:
   ```sh
   # Create the encrypted credential.  systemd-creds prompts for
   # the value; type your passphrase and press Ctrl-D.
   sudo systemd-creds encrypt --name=passphrase - /etc/morphit/relay.passphrase.cred
   sudo chmod 0600 /etc/morphit/relay.passphrase.cred

   # Edit the service unit to use the encrypted form:
   sudo systemctl edit morphit-relay-mint-acts.service
   ```
   In the override drop-in, replace the LoadCredential= line with:
   ```
   [Service]
   LoadCredential=
   LoadCredentialEncrypted=passphrase:/etc/morphit/relay.passphrase.cred
   ```
   Then `sudo systemctl daemon-reload` and the timer fires use the
   encrypted credential on next run. See `man systemd-creds` for
   the full encryption / TPM-binding options.

   The plaintext-file path remains the documented default because
   it works on every Linux system without TPM hardware. But for
   any production-grade operator deployment, the systemd-creds
   path is the right call — and the heap-residue exposure window
   alone is reason enough to switch as soon as your weekly mint
   volume justifies the small operational complexity.

   **Pre-launch operator action checklist (also in
   `docs/RUN-A-MORPHIT-NODE.md` §3):** if your fees account is
   on track to receive >$100/week of listing-fee revenue,
   ship with `systemd-creds` from day one rather than
   migrating later.  Migration involves rotating the active
   key (because the plaintext passphrase touched disk), which
   is more disruptive than configuring `systemd-creds`
   correctly the first time.

3. Install and enable the timer:
   ```sh
   sudo cp ops/systemd/morphit-relay-mint-acts.service /etc/systemd/system/
   sudo cp ops/systemd/morphit-relay-mint-acts.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now morphit-relay-mint-acts.timer
   ```

4. Verify it's scheduled:
   ```sh
   systemctl list-timers morphit-relay-mint-acts.timer
   ```
   Output shows the next-fire time. The timer adds a randomized
   delay of up to 30 minutes so a fleet of operators don't all
   hammer the same RPCs at exactly 04:00 UTC.

**Ongoing maintenance:** check `journalctl -u morphit-relay-mint-acts`
once per month. The unit logs `done; succeeded=N failed=0` on
success. Any line containing `FAILED` triggers an alert via the
operator's normal journald-watch pipeline (see §1.6).

**To change the count later**: edit `/etc/morphit/relay.env`,
no daemon-reload needed (the env file is re-read on each timer
fire).

**To pause unattended minting**: `sudo systemctl disable --now
morphit-relay-mint-acts.timer`. The relay's queue keeps draining
existing ACTs in the meantime; you have a few weeks of buffer
before signups start backing up.

---

## 3. Relay reboot

The relay's active key is held in process memory only (ADR-0010
§4). After a reboot (planned or unplanned) an operator must
enter the passphrase to unlock the key and let the service
start.

### In-memory key handling (2026-05-07 audit)

For operators reasoning about the threat model: when the relay
decrypts its active-key envelope at boot, the scrypt-derived KDF
key and the intermediate plaintext Buffer are **explicitly zeroed
in a `finally` block** after use (see
`apps/relay/src/crypto/keyEnvelope.ts:decryptEnvelope`). The
`key-envelope-smoke.ts` runner enforces this discipline against
regressions — both the encrypt and decrypt paths must contain
`finally { key.fill(0); ... }` or the smoke fails.

**Residual surface (honest disclosure):** the decrypted WIF is
returned as a JS string and then stored in the in-memory
`UnlockedConfig`. JS strings are immutable and cannot be zeroed;
they live until V8 garbage collection or process exit. This is
intentional for the relay's persistent-signer role — it needs to
sign account_create ops continuously. An attacker who achieves
process-memory read access on the relay host can extract the WIF;
this is the threat the file-system permissions (0400 owner-only)
+ §37 server hardening + the passphrase-at-boot ceremony are
designed to defend against. There is no JS-level mitigation for
the immutable-string residue beyond the existing host-level
defenses.

**No operator action required for this audit.** The hardening
fixes are entirely in-process; existing key files, envelopes, and
passphrases continue to work unchanged. The guarantees you had
before this audit are still in place; the audit added defensive
zeroing for previously-unzeroed intermediate key material in the
KDF derivation step.

### Prerequisites (one-time setup)

The key file must be an encrypted envelope produced by
`apps/relay/scripts/encrypt-active-key.ts`. If you're still running with
a plaintext WIF file (dev / legacy), migrate now:

```sh
cd /opt/morphit/apps/relay
tsx apps/relay/scripts/encrypt-active-key.ts \
  /etc/morphit/keys/relay-active.key \
  /etc/morphit/keys/relay-active.enc
```

You'll be prompted for the passphrase twice. Choose something
you'll remember — there is no reset. Store it in your password
manager.

Then update the relay's env to point at the new file:

```sh
# /etc/morphit/relay.env
MORPHIT_RELAY_ACTIVE_KEY_FILE=/etc/morphit/keys/relay-active.enc
```

Verify by restarting the relay with a pty attached (see below)
and entering the passphrase. Once the service unlocks
successfully and serves `/v1/health`, securely destroy the
plaintext:

```sh
sudo shred -u /etc/morphit/keys/relay-active.key
```

The systemd unit must have `StandardInput=tty-force` so the
service can read the passphrase from a pty.

### Planned reboot

1. Notify the operator-on-call channel before rebooting.
2. `sudo systemctl stop morphit-relay.service` — this pauses
   the queue drainer. In-flight welcome bonuses finish; the
   queue stays on disk.
3. Reboot.
4. `sudo systemctl start morphit-relay.service` — the service
   will prompt for the relay active-key passphrase on stdin.
5. Paste the passphrase. The service verifies it, loads the
   key into memory, and begins normal operation.
6. Check `systemctl status morphit-relay.service` — should be
   `active (running)`.
7. Check `/v1/health` — should report `status: ok` within a
   minute.

### Unplanned reboot (systemd crash, kernel panic, VPS
migration)

Same as above but skip the pre-notification. The queue drainer
can be down for hours without user-visible impact: pending
bonuses land eventually, new signups route to the normal
signup endpoint which doesn't require the drainer.

### Forgot the passphrase

See section 8 (owner-key rotation). You'll need to rotate the
active key from paper backup.

---

## 4. Responding to a witness fee change alert

The indexer emits a `[witness-fee] fee_changed` log record when
it observes a change in Blurt's `account_creation_fee`. The
listing fee formula (ADR-0011) auto-adjusts; the alert is
informational.

To grep for this specifically in journalctl:

```sh
sudo journalctl -u morphit-indexer.service | grep '\[witness-fee\] fee_changed'
```

When logs are in JSON mode (`MORPHIT_LOG_FORMAT=json`):

```sh
sudo journalctl -u morphit-indexer.service \
  | jq 'select(.module=="witness-fee" and .event=="fee_changed")'
```

### What to check

1. Look at the new fee vs. old. A change of ±5% is normal
   witness adjustment; ±50% is unusual and worth investigating.
2. Check witness-governance channels (Blurt Discord, forum) for
   discussion of the change.
3. Re-evaluate Morphit's listing fee.

   **Note (2026-05-09 docs-fidelity audit):** Earlier
   versions of this doc referenced
   `MORPHIT_INDEXER_LISTING_FEE_AMORTIZATION_FACTOR` and
   `MORPHIT_INDEXER_LISTING_FEE_OPERATIONAL_MARGIN_BLURT` as
   the formula coefficients to adjust.  Those env vars are
   **not in the current code** — they were part of the
   USD-anchored fee model superseded by ADR-0011's BLURT-
   native amendment (Part 90).

   In the BLURT-native model, the listing fee is set
   directly by `MORPHIT_INDEXER_FEE_BASE_BLURT` (default
   `60`).  No amortization formula, no operational margin —
   the operator picks a flat BLURT amount per their
   tolerance.

   So the runbook step is now: review the chain's new
   account-creation fee, decide whether your current
   `MORPHIT_INDEXER_FEE_BASE_BLURT` still covers the
   account-creation cost (relay-funded) plus your operational
   margin in BLURT terms, and adjust if needed.  Restart
   the indexer to pick up the new value.

4. If the new fee makes Morphit unsustainable at your current
   signup rate, consider:
   - Raising `MORPHIT_INDEXER_FEE_BASE_BLURT` directly.
   - Suspending new signups via nginx while you negotiate with
     the community.
   - Posting a transparency update on the Morphit Blurt
     community.

### Don't do

- Don't panic-adjust the fee mid-hour. The indexer's hourly
  poll gives you time to think.
- Don't raise `MORPHIT_INDEXER_FEE_BASE_BLURT` more than 2x
  in a single change without a community conversation — that
  makes new-user onboarding meaningfully more expensive and
  surprises users mid-session.

---

## 5. Responding to a relay-queue-stuck alert

If you notice rows in `relay_pending_transfers` with
`error_count` near the `queueMaxRetries` ceiling (default 10),
something is stuck.

### Inspect the queue

```sql
SELECT id, recipient, kind, amount_blurt, reason,
       error_count, last_error, last_error_at, created_at
  FROM relay_pending_transfers
 WHERE broadcast_at IS NULL AND error_count > 3
 ORDER BY error_count DESC, created_at ASC;
```

Common causes:

- **Recipient account doesn't exist on chain.** Usually means
  the account was created but then deleted/never funded, or
  a bad recipient landed in the queue from a handler bug.
  Action: manually null this row's `broadcast_at` to something
  non-NULL (e.g. `NOW()`) with `broadcast_trx_id='manual-skip'`
  — the drainer will leave it alone.

- **Relay has no BLURT to fund the transfer.** Check the
  relay's balance on `blocks.blurtwallet.com`. If it's under
  the week's expected disbursement (20 BLURT × pending rows),
  top up from the funding account's paper active key.

- **All RPC endpoints unreachable.** Rare. Check
  `/v1/health` on the relay; if it reports `stale=true`,
  investigate network/DNS to the Blurt RPCs.

### Don't do

- Don't re-queue a row by decrementing `error_count`. The row
  is stuck for a reason — fix the root cause first, then
  either zero `error_count` (the drainer will retry) or leave
  it and let the operator pick it up manually.

---

## 6. Responding to a signup velocity spike

Not yet implemented as an automated alert, but the mechanism
is documented in ADR-0010 §4. Watch relay logs for unusual
signup rates: legitimate growth is gradual; a 10× spike in an
hour is not.

### Check first

1. Is this actual growth? A Reddit/HN mention can legitimately
   cause a spike. Look at Morphit's Blurt community for signs
   of organic interest.
2. Are the signups coming from distinct IP addresses, or is one
   IP making many requests? Nginx's `error_log` shows the
   per-IP rate-limit rejections.

### If it's abuse

1. Temporarily tighten nginx's `limit_req` for
   `/v1/account/create` to 1/day per IP. Reload nginx.
2. Check `relay_pending_transfers` for signup-dust entries from
   suspicious-looking accounts. Investigate patterns (shared
   creator, sequential timestamps).
3. If damage has been done (e.g., N fake accounts burned through
   an ACT pool), don't panic-mint more ACTs — wait for the
   pattern to die down. The relay will pause signups cleanly
   when ACTs run out.

### If it's genuine growth

1. Mint more ACTs (section 2).
2. Consider raising the `MORPHIT_RELAY_CREATE_RATE_PER_DAY`
   temporarily to avoid false positives on enthusiastic users
   who complete a form multiple times.

---

## 6a. Moderating accounts — reviewing flags and blocking

The indexer raises two account-level abuse signals as it follows
the chain:

- **suspicious_reciprocity** (Self-trade Signal B) — two accounts
  mutually exchanging high-star reviews with no other
  counterparties (a likely self-trade ring inflating reputation).
- **related_accounts** (Self-trade Signal A) — accounts created
  in close temporal proximity by the same creator.

A flag is a *signal, not a verdict.* Investigate before acting —
many legitimate users review each other or sign up together.

### Reviewing flags

```bash
morphit-ops moderation              # last 7d, both signals
morphit-ops moderation --since=30d  # wider window
morphit-ops moderation --type=related
morphit-ops moderation --json       # machine-readable, no prompt
```

Or run bare `morphit-ops` on a terminal and pick **Moderation —
review flags & block accounts** from the menu. The menu also shows
a `⚠ N to review` marker next to that item when there are recent
flags with no block applied to either named account.

The screen lists each flag annotated with the involved accounts'
current block status (`[BLOCKED]`). On an interactive terminal it
then offers block/unblock as the resolution action.

### Blocking an account (instance-local)

```bash
morphit-ops block <account> "optional reason"
morphit-ops unblock <account>
```

Blocking is **instance-local and reversible.** It is NOT a chain
ban and requires no posting key — nothing is broadcast. It records
a row in `operator_blocks` (origin `local`) that hides the
account's listings everywhere this instance serves them:

- the public orderbook (`/v1/orderbook`)
- the per-account view (`/v1/orders/:account`)
- featured slots, the RSS feeds, and the live SSE stream

What blocking does **NOT** do:

- It does not touch the account's BLURT, BTC, XMR, or any funds.
- It does not affect the account on the Blurt chain.
- It does not follow the account to other Morphit instances — the
  whole point of federation is that another operator can serve a
  user you've blocked, and vice-versa. Your block applies to
  **your instance only.**

A blocked user who visits your instance sees a banner explaining
that their posts are blocked on *this* instance, that they remain
visible on every other Morphit instance, and a link to the Agorise
Matrix room to appeal. The optional reason you pass is shown to
them.

> **Fees:** a listing fee already paid (BLURT/BTC/XMR) is not
> refunded on block — the fee bought a listing that is now hidden
> here but still visible on other instances. Blocking is a curation
> choice, not a billing action.

The legacy `morphit-ops abuse` (broadcast failures + signals, 24h)
and `morphit-ops flags` (signals + evidence) subcommands remain
available from the CLI for scripting/JSON, but the menu now routes
moderation through the unified screen above.

---

## 7. Suspected relay compromise

If you have reason to believe the relay VM has been
compromised (unexpected outbound connections, unknown
processes, missing files, sudo audit weirdness):

### Stop the bleeding — in order

1. **Immediately**: `sudo systemctl stop morphit-relay.service`.
   This flushes the active key from memory. Any attacker who
   was reading memory just lost their prize.
2. **Within 5 minutes**: revoke the weekly `recurrent_transfer`
   from the funding account (section 1 "Stopping the recurrent
   transfer early"). The funding account's active key is on
   paper — you'll need to do this from an air-gapped machine
   or trusted workstation. Requires you to leave the relay
   host.
3. **Within 30 minutes**: check the `@morphit-relay` account
   on chain for unauthorized transfers. If anything moved to
   an unknown account, you were compromised.

### Key rotation — within 24h

See section 8. You must rotate `@morphit-relay`'s active key
(and consider owner key) from paper backup. The old key is
presumed exfiltrated.

### Don't do

- Don't delete logs. You want them for forensics.
- Don't restart the service with the old key. If a key is
  suspected compromised, rotate before returning to service.

---

## 8. Owner-key rotation ceremony

This is a rare, high-stakes operation. Only do it when:
- An active key has been suspected compromised and you've
  rotated the active key from paper (simple case).
- An owner key itself has been suspected compromised (much
  harder — requires the recovery-account flow).

The active-key-only rotation is simpler and more common. I'll
document that; owner rotation is out of scope for this runbook
because the ceremony requires the second physical keyholder
(Blurt's recovery-account mechanism) and cannot be done alone.

### Active-key rotation (owner key is safe)

Precondition: you have the paper-backed owner key for
`@morphit-relay`, and a new paper active key you just
generated offline.

1. On an air-gapped machine, generate a new active key and
   write down its WIF + pubkey on a fresh sheet of paper.
   Burn the intermediate digital copies.

2. On the same air-gapped machine, build and sign an
   `account_update` op using the owner key:
   ```json
   [
     "account_update",
     {
       "account": "morphit-relay",
       "active": {
         "weight_threshold": 1,
         "account_auths": [],
         "key_auths": [["<new-active-pubkey>", 1]]
       },
       "memo_key": "<unchanged>",
       "json_metadata": ""
     }
   ]
   ```

3. Sneakernet the signed tx to a networked machine and
   broadcast. Verify on chain that `@morphit-relay`'s active
   authority now points to the new pubkey.

4. On the relay host, encrypt the new WIF into an envelope:
   ```sh
   cd /opt/morphit/apps/relay
   # Write the new WIF to a temporary file (memory-only ideally,
   # or tmpfs-backed /run if your host has one):
   echo "<new-wif>" > /run/relay-active.tmp
   chmod 0400 /run/relay-active.tmp
   tsx apps/relay/scripts/encrypt-active-key.ts \
     /run/relay-active.tmp \
     /etc/morphit/keys/relay-active.enc.new
   sudo shred -u /run/relay-active.tmp
   ```
   The `.new` suffix prevents a race if the relay is still
   running with the old envelope.

5. Atomically swap the envelope file into place:
   ```sh
   sudo mv /etc/morphit/keys/relay-active.enc.new \
           /etc/morphit/keys/relay-active.enc
   ```

6. Restart the relay (you'll need to enter the passphrase you
   chose in step 4 when it prompts). Verify `/v1/health`
   returns OK and the queue drainer runs a cycle successfully.

7. **Securely destroy the old active-key paper backup**. Shred
   or burn.

8. Update your operator journal: date, reason, new pubkey fingerprint
   (first 8 + last 4 chars of the base58 string).

### What NOT to do during rotation

- Don't generate keys on a networked machine. Ever.
- Don't email the new WIF. Don't put it on any sync service.
- Don't skip step 6. Old paper + fresh paper = two attack
  surfaces when only one is current.

---

## 9. Paper-key backup protocol

For `@morphit`, `@morphit-relay`, and `@morphit-fees` owner
keys, and for the funding account's active key:

### Creation

1. Generate on an air-gapped machine.
2. Print (not write) to paper — handwriting errors are common.
3. Include a checksum or fingerprint on the paper so the paper's
   integrity can be verified without decoding the full key.
4. Two copies minimum. Each in a physically separate location
   (e.g., your safe + a trusted agent's safe).

### Storage

- Fire-resistant safe (UL Class 350 or better).
- Not in plain view.
- Not in a safety-deposit box where the institution could be
  compelled to open it without your knowledge.

### Periodic check

- Every 6 months: verify both copies exist and are legible.
  DO NOT photograph them or bring them near any
  internet-connected device.

### Destruction

- When rotating keys, destroy the old paper within 24h of the
  rotation broadcast being confirmed on chain.
- Shred at DIN P-7 or burn. A cross-cut shredder at P-4 is
  not enough for cryptographic material.

---

## 10. Escalation

If you encounter something this runbook doesn't cover:

- Post in the Morphit Blurt community with `[OPERATOR]` in the
  title. Other operators can advise.
- For cryptography-level questions (a chain attack, an
  unexpected behavior in dblurt, etc.), the Blurt witness
  community on Discord is knowledgeable and responsive.
- For nothing is working and you need to bail out: pause the
  relay at nginx (return 503 for `/v1/account/create`) and
  post a notice on the Morphit community Blurt account. The
  indexer can run independently; users can still view the
  orderbook and chat. New signups pause gracefully.

The whole point of Morphit's architecture is that nothing is
lost when the relay is down. Take the time you need to think.

---

## 11. Running integration tests

Unit tests run without external dependencies — `npm test` works
on any developer machine. Integration tests additionally exercise
real Postgres semantics (UPSERT row locks, predicate correctness,
JSON operators, etc.) and only run when a test database is
available.

### When to run

Before any release that touches:

- Migration SQL (any `schema-v*.sql` file)
- Concurrent-path SQL (UPSERT, RETURNING, SELECT FOR UPDATE)
- Aggregations that feed into other queries in the same
  transaction (e.g. the loyalty module's SUM(bp_rewarded))
- Anything where "works on a mock client" isn't enough evidence

Concretely: all of Phase 4c (`trackVerifiedBlurtFee`), the fee
attestation handler's `COUNT(DISTINCT attestor)` logic, and any
future handler that compounds state across multiple statements.

### Prerequisites

- A Postgres 15+ instance you don't mind dropping schemas in
- The running user has `CREATE SCHEMA` and `DROP SCHEMA CASCADE`
  privileges
- No other Morphit tests pointed at the same database (each
  test suite creates its own schema, but dropping the DB while
  tests run is still destructive)

You can use a local Docker container:

```sh
docker run --rm -d --name morphit-test-pg \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=morphit_test \
  -p 5433:5432 \
  postgres:15
```

### Running

```sh
cd apps/indexer
export TEST_DATABASE_URL='postgres://postgres:test@localhost:5433/morphit_test'
npm test
```

Tests gated by the harness `INTEGRATION_ENABLED` flag will run;
the rest run as usual. Without `TEST_DATABASE_URL` set, those
suites print "skipped" and the suite still passes — the default
developer workflow stays fast.

### What to watch for

- **Schema leaks** — teardown runs in `afterAll`; if a test
  crashes before afterAll, its schema remains. Safe to manually
  clean up with `psql -c "DROP SCHEMA morphit_test_* CASCADE"`
  periodically.
- **Shared connection pool** — the harness creates one pg.Pool
  per suite. Long-running CI across many suites consumes file
  descriptors; set Postgres `max_connections` generously.
- **TEST_DATABASE_URL vs DATABASE_URL** — these are separate.
  Never point TEST_DATABASE_URL at your production database.
  The harness drops schemas by name; a misconfigured env var
  could destroy real data.

### First-run verification

The concurrent-write test in `test/integration/loyalty.test.ts`
is the canary for Phase 4c. If it passes on your database, the
UPSERT + SUM path is serializing correctly on your Postgres
installation's isolation level. If it fails with "lost writes"
or "duplicate milestones", open an issue — do not ship.

---

## 12. XMR viewkey pre-deploy check (retired)

This section previously documented a `verify-xmr-viewkey.ts`
helper script for sanity-checking a `(XMR address, view key)`
pair against a real test transaction.

**The script has been retired.**  Part 108++ replaced view-
key-based XMR fee verification with per-payment proofs, and
Part 109 removed the `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` env
var entirely.  No view key lives on any Morphit indexer's
box.  There is no `(address, viewkey)` pair to sanity-check
because there is no view key.

**What to do instead — verifying your XMR fee address is
correctly configured:**

1. After setting `MORPHIT_INDEXER_XMR_FEE_ADDRESS`, restart
   the indexer.
2. Query `/v1/release` and confirm the returned
   `treasury.xmr.address` matches what you configured.
3. Ask a trusted contact to send a small amount of XMR to
   your fee address and generate a tx_proof from their own
   wallet (`get_tx_proof <txid> <address>` in monero-wallet-
   cli, or the equivalent menu item in any modern Monero
   wallet).
4. Submit the txid + proof through the public Morphit UI
   the same way a real user would.  If the order verifies,
   your config is correct.

This end-to-end check exercises the exact code path users
will hit.  Misconfiguration surfaces immediately and looks
the same as a real-user error — no operator-only diagnostic
mode needed.

---

## 13. Responding to a stale BLURT/USD price feed

Under Phase 5, the indexer runs a composite BLURT/USD price
source with a Klingex → Coingecko → static floor fallback
chain. Values refresh every 5 minutes in the background. When
every upstream fails, the indexer keeps serving the last good
value with `stale=true`. If no upstream has ever succeeded
since boot, it falls back to the static floor
(`MORPHIT_INDEXER_BLURT_PRICE_USD`).

**cp128 update — denomination is operator-configurable**: by
default the BLURT price echo on `/v1/listing-fee` is expressed
in USD.  Operators serving non-USD markets (or hedging against
USD erosion / petrodollar collapse) can set
`MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT` to any 3-8
character uppercase ticker — `EUR`, `GBP`, `JPY`, `BRL`, `CNY`,
`INR`, `RUB`, `AED`, `XDR` (IMF Special Drawing Rights basket),
`XAU` (gold ounces, hard-currency hedge), etc.  The listing-fee
endpoint then returns a `denomination_fiat` field telling
frontends which unit the `blurt_price_fiat` and `base_fee_fiat`
values are expressed in.  This is purely a display-side change;
order matching and on-chain fees are unaffected.  See ADR-0040.

**cp129 update — Defense F cross-instance peer disagreement
detector**: opt-in via `MORPHIT_INDEXER_PEER_PRICE_MONITOR_ENABLED=true`.
When on, the indexer periodically (every 30 min) queries peer
Morphit instances' `/v1/price/morphit-native/receipt` and alerts
on sustained disagreement >25% for >4 hours.  Catches the case
where YOUR indexer is reporting a different price than the rest
of the federation (operator pressured, captured, compromised,
or geographically isolated).  Requires ≥3 reachable peers in
`/v1/instances` with `last_probe_status` good/quiet; below that
the monitor degrades silently to no-alert.  Alerts surface in
`peer_price_disagreement_alert` log entries with the deviation
percentage, peer median, and your own price.  Investigation
runbook: see "Responding to a peer-price-disagreement alert"
below.  See ADR-0041.

**cp130 update — multi-asset morphit_native (BTC + XMR added
alongside BLURT)**: when the price feed is enabled, the indexer
now creates three independent composite price sources at boot —
one per asset.  BLURT keeps its 4-tier chain (Klingex →
Coingecko → morphit_native → static floor); BTC and XMR get a
3-tier chain (Coingecko → morphit_native → static floor)
because Klingex doesn't trade BTC/USDT or XMR/USDT at scale.
Each source has its own cache and refresh schedule.  Two new
env vars set per-asset static floors:
`MORPHIT_INDEXER_PRICE_FEED_BTC_STATIC_FLOOR` (default 60000) and
`MORPHIT_INDEXER_PRICE_FEED_XMR_STATIC_FLOOR` (default 200).
The cp129 peer-price monitor now spawns one instance per asset,
so disagreement on BTC alerts separately from disagreement on
BLURT — and each asset is sampled independently from peers.
Receipt endpoint `/v1/price/morphit-native/receipt?asset=BTC`
returns a real BTC/USD derivation operators can inspect.
See ADR-0042.

### Responding to a peer-price-disagreement alert

If you see a `peer_price_disagreement_alert` event in the
indexer logs, the cp129 peer-price monitor has detected that
your indexer's derived BLURT price has been diverging from the
peer median by more than 25% for sustained 4+ hours.  This is a
warning signal, not a hard failure — your instance keeps
serving prices as normal.

The questions to investigate, in order:

1. **Is your morphit_native fetcher healthy?** Check
   `/v1/price/morphit-native/receipt` on your instance.  Look at
   `derived_price`, `tier_used`, `contributing_traders`.  If the
   tier is unexpected (e.g. you expected Tier 1 USD-direct but
   got Tier 3 hybrid), some trader population shifted.

2. **What are peers reporting?** Pick a few from `/v1/instances`
   and hit their `/v1/price/morphit-native/receipt` directly.
   Compare their numbers and contributing-trader sets to yours.

3. **Is there genuine market dislocation?** Check Klingex and
   Coingecko for BLURT/USD.  If both external sources agree
   with peers but your indexer's native fetcher disagrees, it's
   your instance.  If externals agree WITH your native price
   but disagree with peers, it's the peers (look for whether
   peers might be on a stale price-source state).

4. **Has someone manipulated your on-platform data?** This is
   the threat the alert exists for.  Check recent verified-fee
   orders for unusual patterns: new traders posting
   abnormally-priced BLURT-vs-fiat orders, large concentrated
   positions, etc.  The cp127 sybil filters should have caught
   most of this; an alert that survives the filters might mean
   a new attack pattern.

5. **Are you in a peer-poor segment?** Geographic or network-
   isolation scenarios can produce false alerts because your
   sample of "peers" is itself non-representative.  Check that
   you have ≥3 peers reachable across diverse networks (not all
   on the same hosting provider, not all on Tor only, etc.).

If the alert is a false positive (after investigation, your
price is correct and peers are wrong): the alert auto-suppresses
for 24h after firing, then re-fires if disagreement persists.
You can also temporarily set
`MORPHIT_INDEXER_PEER_PRICE_MONITOR_ENABLED=false` and restart;
this stops querying peers entirely.  Re-enable once the
underlying situation resolves.

If the alert is a true positive (your indexer is wrong): pause
fee acceptance until you've identified the root cause; users
trading against bad price displays could be misled about value.
Investigate as above; possibly restart with the price feed
disabled (`MORPHIT_INDEXER_PRICE_FEED_ENABLED=false`) so your
instance falls back to the static floor while you fix things.

**cp127 update — self-sovereign price source (morphit_native)**:
once your instance has enough on-platform trading volume, you
can flip on `MORPHIT_INDEXER_PRICE_FEED_NATIVE_ENABLED=true` to
add a new upstream slotted BETWEEN coingecko and the static
floor. The native fetcher derives BLURT/USD from real verified-
fee on-platform orders and survives external-feed outages
entirely (Klingex shutdowns, Coingecko rate-limits, etc.). See
ADR-0039 for full design and `/v1/price/morphit-native/receipt`
for live operator-side inspection of what it's producing.
Defaults to OFF so a brand-new instance with zero trade history
doesn't try to derive from empty data.

> **Quick action:** if you just need to update the static
> floor during an outage, set `MORPHIT_INDEXER_BLURT_PRICE_USD`
> in your SystemD `Environment=` directive (or wherever your
> deployment manages env vars) and restart the indexer. The
> runbook below is for when you also want to investigate why
> the upstreams are failing.

### When to investigate

- `/v1/health?verbose=1` reports `diagnostics.price.stale=true`
- `/v1/health?verbose=1` reports `diagnostics.price.source` as
  `static_floor` while `MORPHIT_INDEXER_PRICE_FEED_ENABLED=true`
  (means no upstream — klingex or coingecko — has succeeded
  since boot, so the indexer is falling back to
  `MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR`)
- Log aggregator shows repeated `[price] all_upstreams_failed_serving_cache`
  or `all_upstreams_failed_no_cache_serving_floor` events from
  the indexer
- Users report fee quotes that seem out of line with live BLURT
  price

### Quick diagnosis

Query the verbose health endpoint:

```sh
curl -s http://localhost:PORT/v1/health?verbose=1 | jq .diagnostics.price
```

Example healthy output:

```json
{
  "blurt_usd": 0.00423,
  "source": "klingex",
  "updated_at": "2026-04-20T12:35:00.000Z",
  "stale": false
}
```

Example stale output (upstream is down, cache is aging):

```json
{
  "blurt_usd": 0.00423,
  "source": "klingex",
  "updated_at": "2026-04-20T10:00:00.000Z",
  "stale": true
}
```

Example all-upstreams-failed-since-boot:

```json
{
  "blurt_usd": 0.002,
  "source": "static_floor",
  "updated_at": "1970-01-01T00:00:00.000Z",
  "stale": true
}
```

### What to check

1. **Is the price actually wrong?** The `static_floor` is your
   `MORPHIT_INDEXER_BLURT_PRICE_USD` — if you've kept that
   reasonably close to market, stale behavior is not
   user-visible as incorrect fees.

2. **Is Klingex reachable from your VPS?**
   ```sh
   curl -fsS --max-time 5 "$MORPHIT_INDEXER_KLINGEX_BASE_URL/ticker/BLURT_USD"
   ```
   If this fails from your box but works from a laptop, suspect
   firewall, outbound VPN, or a provider-level block.

3. **Is Coingecko reachable + not rate-limited?**
   ```sh
   curl -fsS --max-time 5 "$MORPHIT_INDEXER_COINGECKO_BASE_URL/simple/price?ids=blurt&vs_currencies=usd"
   ```
   A 429 response means you're rate-limited; the free tier
   allows ~10-30 req/min shared across all callers from your
   IP. With a 5-minute refresh this should be comfortable, but
   a shared IP (NAT, proxy) can exhaust it.

4. **Has the Klingex API shape drifted?** Our Klingex fetcher
   tries several field names defensively, but a wholesale rename
   could surface as `unexpected_shape` log events. Open a bug
   with the current endpoint's JSON payload and we'll extend
   the parser.

### Immediate mitigation

If the feed is stale and you need the live price reflected in
listing-fee quotes **right now**, adjust
`MORPHIT_INDEXER_BLURT_PRICE_USD` to match current market and
restart the indexer. The static floor becomes the served value
immediately. Revert to the live feed once the upstream is back
up — there's no penalty for overriding temporarily.

### Don't do

- Don't remove the static floor entirely. It exists so the
  indexer never hard-fails on a price lookup; without it, a
  total-upstream-outage would break fee verification entirely.
- Don't raise `MORPHIT_INDEXER_PRICE_REFRESH_INTERVAL_MS` to
  reduce traffic during an outage. The upstreams don't call
  you back when they recover — a longer interval just means
  longer staleness when they do.
- Don't switch `MORPHIT_INDEXER_PRICE_FEED_ENABLED` to `false`
  permanently "because it's simpler." The composite chain
  self-heals; static drifts from market and produces
  user-complaint fees within weeks.

### Consistency guarantee

The same `priceSource.current()` value is used for both the
quote at `/v1/listing-fee` AND fee-verification in the order
handler. So even during a stale episode, a user who pays the
quoted fee verifies correctly — you just may be quoting prices
slightly off market. Stale is a UX quality issue, not a
correctness bug.

---

## 14. Deployment topology requirement — apps MUST be behind a loopback proxy

The indexer and relay rate-limiters derive the client IP
from forwarded-address headers (`X-Real-IP`,
`X-Forwarded-For`) only when the immediate socket peer is
a loopback address. This is a security property
(preventing rate-limit bypass via forged headers) and it
dictates a deployment requirement:

**The indexer and relay MUST NOT be exposed directly to
the public internet.** They MUST be reached only through
an nginx (or equivalent) reverse proxy running on the
same host.

### Why this matters

If a user can connect directly to port 8080 (the relay)
or the indexer's listen port, they can send arbitrary
`X-Real-IP` / `X-Forwarded-For` headers. Before the fix
shipped for Findings B + E (April 2026), forwarded
headers were honored unconditionally — a direct
connection could forge a fresh IP per request and bypass
the rate limiter.

The fix now discards forwarded headers from non-loopback
peers. This closes the vulnerability **only if the
deployment actually fronts the apps with a loopback
proxy**. If you deploy the apps directly on a public
port, the socket peer will be the real attacker IP and
the rate limit will work correctly — but every attacker
shares one bucket per IP, so a botnet spread across
thousands of IPs would still bypass the limiter. A
proxy-fronted deployment is what the system is designed
for.

### Verification procedure (do this during setup)

```bash
# From a machine that is NOT the app host, try to reach
# the app directly.  Replace <PORT> with the indexer's
# listen port (default 8081) when probing /v1/health, or
# the relay's listen port (default 8080) for relay
# endpoints.  Replace <host> with the server's public IP
# or hostname.
curl -v -H "X-Real-IP: 1.2.3.4" http://<host>:<PORT>/v1/health
```

Expected outcome: **connection refused or times out**.
If you get a response, the app is reachable directly
and your deployment is vulnerable. Fix by binding the
app to `127.0.0.1` only:

- Indexer: `MORPHIT_INDEXER_LISTEN_HOST=127.0.0.1`
  in the systemd service env file.
- Relay: bind `127.0.0.1:8080` in the relay config (see
  `apps/relay/src/main.ts` and its config).
- Firewall: `ufw deny 8080 && ufw deny 8081` as
  defense-in-depth against misconfiguration.

### Spot-check during operation

The reference deployment (nginx on same host, apps bound
to loopback) keeps the invariant automatically. If you
ever move nginx off-host or add a CDN in front, update
the app's `LOOPBACK_PEERS` allowlist in both
`apps/relay/src/middleware/ip.ts` and
`apps/indexer/src/api/middleware/ratelimit.ts` to
include the proxy's source IP. Don't skip this — the
current hardcoded `['127.0.0.1', '::1', '::ffff:127.0.0.1']`
is correct for the reference deployment but wrong for
off-host-proxy deployments.

### Recommended single-hostname layout (zero DNS for relay/indexer)

The frontend's default `MORPHIT_RELAY_ORIGIN` is `/relay` and
`MORPHIT_INDEXER_ORIGIN` is `/api/indexer` — both are
**same-origin relative paths**. With the recommended nginx
config below, your users reach everything under one public
hostname and you do NOT need separate DNS entries for the
relay or indexer.

```nginx
# Public HTTPS virtual host — the only hostname users see.
server {
    listen 443 ssl http2;
    server_name morphit.example.com;

    ssl_certificate     /etc/letsencrypt/live/morphit.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/morphit.example.com/privkey.pem;

    # Security headers: see §15 for the full CSP and other
    # headers. This block is only about routing.

    # Frontend — static files from the Morphit build output.
    root /var/www/morphit-frontend;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Relay — fund-spending endpoints. Proxied to loopback.
    location /relay/ {
        # Strip the /relay prefix before forwarding so the
        # relay sees /v1/account/create, not /relay/v1/...
        rewrite ^/relay/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Indexer — read-only public API. Proxied to loopback.
    location /api/indexer/ {
        rewrite ^/api/indexer/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Indexer RSS feeds. Same backend as /api/indexer, but
    # mounted at the bare /rss/ path because feed readers
    # expect /rss/orderbook.xml (not /v1/rss/orderbook.xml or
    # /api/indexer/rss/orderbook.xml). Without this block,
    # the RSS pill in the frontend footer and the per-trader /
    # per-asset subscribe links return 404.
    location /rss/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Adjust the loopback ports to match your actual
`MORPHIT_RELAY_LISTEN_PORT` and
`MORPHIT_INDEXER_LISTEN_PORT` if they aren't 8080 / 8081.

With this layout:

- No `relay.morphit.example.com` DNS record required.
- No `indexer.morphit.example.com` DNS record required.
- `MORPHIT_RELAY_ALLOWED_ORIGINS` needs only the one public
  hostname (`https://morphit.example.com`) — see §17.
- CSP `connect-src` is covered by `'self'` (no extra hosts
  to allowlist) — see §15.

### Split topology (if you prefer distinct subdomains)

If you want the relay and indexer on their own subdomains
(e.g. to let different teams own them, or to deploy them on
different VPSes), build the frontend with overrides:

```
# In your frontend build environment:
MORPHIT_RELAY_ORIGIN=https://relay.morphit.example.com
MORPHIT_INDEXER_ORIGIN=https://indexer.morphit.example.com
```

In that case add those hostnames to your CSP `connect-src`
(see §15) and set `MORPHIT_RELAY_ALLOWED_ORIGINS` to the
frontend's origin (NOT the relay's — Origin is always the
page-loading origin). See §17 for details.

### SSE connection caps (mandatory hardening)

The indexer exposes three Server-Sent Events endpoints used by
the frontend for real-time updates:

- `/api/indexer/v1/orderbook/stream` — orderbook changes
- `/api/indexer/v1/chat/:a/:b/stream` — chat messages
- `/api/indexer/v1/instances/stream` — federation directory

These endpoints are deliberately **not** behind the per-minute
rate-limit middleware. A long-lived SSE connection is one HTTP
request; per-minute limit doesn't model resource cost. The right
control is a **concurrent-connection cap** at the reverse proxy.

**Without these caps, an attacker can open thousands of SSE
connections from a single IP and exhaust the indexer.** Add both
blocks below to your nginx config.

```nginx
# limit_conn zones — declared in the http {} block.
http {
    limit_conn_zone $binary_remote_addr zone=sse_per_ip:10m;
}

# Inside the indexer location block.
server {
    location /api/indexer/ {
        rewrite ^/api/indexer/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # SSE-specific tuning.
        proxy_read_timeout 5m;
        proxy_buffering off;
        proxy_cache off;

        # Per-IP cap: 20 concurrent SSE connections per source IP.
        limit_conn sse_per_ip 20;
        limit_conn_status 429;
    }
}
```

For Caddy, use a comparable connection-limit plugin. The cap value
(20) is adjustable; raise to 50 for high-traffic instances.

### TLS certificates and auto-renewal (Let's Encrypt + nginx)

The nginx config above references
`/etc/letsencrypt/live/morphit.example.com/{fullchain,privkey}.pem`.
This section is the canonical guide for obtaining and
auto-renewing those certificates. **Operators using Caddy can
skip this section** — Caddy handles TLS automatically when the
config has a public hostname (this is what RUN-A-MORPHIT-NODE.md
recommends).

> **`morphit-ops ssl` surfaces all of this.** Run `morphit-ops
> ssl` (or the "SSL/TLS certificate (HTTPS)" menu item) for a
> read-only status — whether you have a valid cert for your
> domain, when it expires, and whether the auto-renewal timer is
> actually running. `morphit-ops ssl setup` checks prerequisites
> and prints the exact certbot commands below, tailored to your
> configured domain. (It does not run certbot or edit nginx for
> you — cert issuance changes your web server, so you run the
> steps and review the changes, the same reason service install
> is a hands-on step.)

#### Prerequisites

- DNS A/AAAA records for your domain pointing at this server's
  public IP. Verify with `dig +short morphit.example.com`
  before proceeding — certbot's HTTP-01 challenge requires
  the domain to resolve to this host.
- Port 80 reachable from the public internet (the HTTP-01
  challenge is served over plain HTTP).
- The server's firewall (`ufw`, `firewalld`, etc.) allows
  inbound 80 and 443.

#### Initial certificate issuance

On Debian/Ubuntu:

```bash
apt update && apt install -y certbot python3-certbot-nginx
```

Stop nginx temporarily so certbot's standalone challenge can
bind to port 80, OR use the nginx plugin which can read your
existing config:

```bash
# Standalone mode (simplest; nginx must be stopped):
systemctl stop nginx
certbot certonly --standalone \
    -d morphit.example.com \
    --agree-tos \
    --email you@example.com \
    --no-eff-email
systemctl start nginx
```

Or the nginx plugin (no downtime, but requires your nginx
config to already serve the domain over HTTP):

```bash
certbot --nginx -d morphit.example.com \
    --agree-tos --email you@example.com --no-eff-email
```

After success, certs are in `/etc/letsencrypt/live/<domain>/`.
The nginx plugin also patches your config to redirect HTTP→HTTPS
and adds the `ssl_certificate*` directives — review the diff.

#### Auto-renewal (the part most operators get wrong)

certbot installs a systemd timer (or cron job) that runs twice
daily and renews any certificate within 30 days of expiry.
Verify it's enabled:

```bash
systemctl list-timers | grep certbot
# Expected: certbot.timer  active  ... certbot.service
```

If the timer isn't there, enable it:

```bash
systemctl enable --now certbot.timer
```

After renewal, nginx must reload to pick up the new cert.
certbot's package on Debian/Ubuntu includes a `--deploy-hook`
that handles this, but verify by checking the renewal config:

```bash
cat /etc/letsencrypt/renewal/morphit.example.com.conf | grep -i hook
# Expected: deploy_hook = systemctl reload nginx
```

If no deploy-hook is configured (standalone-mode installs may
miss this), add one:

```bash
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh << 'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

Hooks in `/etc/letsencrypt/renewal-hooks/deploy/` run after
every successful renewal regardless of the per-domain config.

#### Test the renewal flow end-to-end

```bash
certbot renew --dry-run
# Expected output ends with:
#   Congratulations, all simulated renewals succeeded
```

This exercises the full path (challenge, issuance, deploy hook)
without actually consuming a Let's Encrypt rate-limit slot.
Run this once when you set up, and once after any nginx config
change that touches the listening server block.

#### Monitor expiry independently

certbot can fail silently — the renewal timer might run but the
challenge might fail (DNS change, firewall change, port 80
blocked). Set a calendar reminder ~14 days out OR add a check:

```bash
# Add to /etc/cron.weekly/check-cert-expiry.sh:
#!/bin/sh
DAYS=$(echo | openssl s_client -servername morphit.example.com \
    -connect morphit.example.com:443 2>/dev/null | \
    openssl x509 -noout -enddate | \
    sed 's/notAfter=//' | xargs -I{} date -d {} +%s | \
    xargs -I{} expr \( {} - $(date +%s) \) / 86400)
if [ "$DAYS" -lt 21 ]; then
    echo "WARN: TLS cert expires in $DAYS days" | mail -s "Morphit cert expiry" you@example.com
fi
```

#### Cipher and protocol hardening

The default nginx + Let's Encrypt config is reasonable, but
add explicit modern-only protocols and a strong cipher list
to the server block:

```nginx
server {
    listen 443 ssl http2;
    server_name morphit.example.com;

    ssl_certificate     /etc/letsencrypt/live/morphit.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/morphit.example.com/privkey.pem;

    # Modern protocol set — TLS 1.2 minimum, TLS 1.3 preferred.
    # SSL 3, TLS 1.0 and 1.1 have been broken / are deprecated.
    ssl_protocols TLSv1.2 TLSv1.3;

    # Mozilla "intermediate" cipher list — works with everything
    # ≥ Firefox 27, Chrome 30, IE 11, Safari 9, Android 4.4.
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;  # TLS 1.3 makes this irrelevant.

    # Session reuse for performance.
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # OCSP stapling — clients verify cert revocation via the
    # server rather than calling the CA's OCSP responder.
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 1.1.1.1 9.9.9.9 valid=300s;
    resolver_timeout 5s;

    # rest of the server block…
}
```

Test your TLS posture with [SSL Labs](https://www.ssllabs.com/ssltest/)
— aim for an A or A+ rating.

### OS hardening (Debian/Ubuntu reference)

The config above protects the application surface; this section
covers the host. **All operators should apply these baselines.**
RUN-A-MORPHIT-NODE.md mirrors the same commands at a beginner-
friendly level, but this is the canonical reference.

#### Automatic security updates

Without unattended security upgrades, a kernel-level vulnerability
on your VPS sits unpatched until you remember to ssh in.

```bash
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades  # answer "Yes"
```

Verify the security pocket is enabled:

```bash
grep -E '^\s*"\${distro_id}:\${distro_codename}-security"' \
    /etc/apt/apt.conf.d/50unattended-upgrades
# Expected: line uncommented
```

For unattended kernel upgrades you'll need to add automatic
reboots on a maintenance window:

```bash
cat >> /etc/apt/apt.conf.d/50unattended-upgrades << 'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
```

Note: a relay reboot interrupts in-flight signups. Schedule the
reboot window for low-traffic hours.

#### Firewall (ufw)

```bash
apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp     # SSH
ufw allow 80/tcp     # HTTP (Let's Encrypt + redirect)
ufw allow 443/tcp    # HTTPS
ufw --force enable
```

**Critically: do NOT expose the relay (8080) or indexer (8081)
ports directly.** They MUST sit behind nginx (loopback only —
see §14). Verify with:

```bash
ss -ltnp | grep -E ':8080|:8081'
# Expected: 127.0.0.1:8080 / 127.0.0.1:8081 only
# NOT: 0.0.0.0:8080 or *:8080
```

If you see `0.0.0.0:` here, your relay/indexer is publicly
exposed and the loopback enforcement (§14) failed. Stop and
fix this before continuing.

#### SSH hardening

```bash
# Disable root login over SSH and require key authentication.
# Confirm you have a working SSH key login as a non-root user
# BEFORE running these — getting locked out of a fresh VPS is
# a real possibility otherwise.

# Edit /etc/ssh/sshd_config:
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

# Validate the config before reload.
sshd -t
systemctl reload ssh
```

#### Brute-force protection (fail2ban)

```bash
apt install -y fail2ban
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true

[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
logpath  = /var/log/nginx/error.log
maxretry = 10
EOF
systemctl enable --now fail2ban
fail2ban-client status
```

The `nginx-limit-req` jail catches IPs that hit nginx's
`limit_req_zone` (your application-level rate-limit) repeatedly.
Without it, an attacker hitting the relay's signup endpoint at
the rate-limit threshold from a single IP can stay just below
the per-IP velocity rules forever.

#### Filesystem permissions baseline

Verify the relay's data dir and config aren't world-readable:

```bash
chmod 700 /var/lib/morphit /var/lib/morphit/relay
chmod 600 /etc/morphit/relay.env  # if you use an env file
chown -R morphit:morphit /var/lib/morphit /etc/morphit
```

The relay's encrypted-keystore file is itself encrypted, but
defense in depth: don't let other users on the host read the
ciphertext or the env file with the passphrase pointer.

#### Logging discipline

```bash
# journald: cap log retention to bound disk use.
sed -i 's/^#*SystemMaxUse=.*/SystemMaxUse=2G/' /etc/systemd/journald.conf
sed -i 's/^#*SystemMaxFileSize=.*/SystemMaxFileSize=200M/' /etc/systemd/journald.conf
systemctl restart systemd-journald
```

The relay and indexer log via stdout/stderr captured by systemd's
journal. Without these caps, a chatty error loop can fill `/var`
until the disk is full and the host wedges.

#### Optional but recommended

- **AIDE / Tripwire** — file integrity monitoring. Catches
  rootkit / supply-chain compromise that modifies binaries.
  Beyond the scope of this guide; standard sysadmin work.
- **auditd** — kernel-level audit logging. Same comment.
- **Fail-closed swap** — if you use swap, encrypt it
  (`/etc/crypttab` with a random key per boot) so suspended
  process memory isn't recoverable from disk.

#### Securing operator-only routes (cp116)

Morphit exposes a small surface of operator-helpful routes
that don't make sense for end users.  Currently this is just
`/admin/setup-wizard` (cp116, config-line generator —
read-only, no mutation, but visually cluttery for end users),
but more may follow.

These routes are NOT auth-gated at the application level by
design — making them read-only sidesteps the need for an auth
system that adds attack surface for marginal benefit.  If you
prefer to hide the admin surface from your users anyway, two
common options:

**Nginx HTTP basic-auth:**

```nginx
location /admin/ {
    auth_basic "Operator only";
    auth_basic_user_file /etc/nginx/.morphit-admin-htpasswd;
    # If your frontend is served by nginx as static files
    # (production default), use `try_files` here instead of
    # proxy_pass.  The example below covers the dev-server
    # case (SvelteKit dev on :3000); production usually wants:
    #   try_files $uri $uri/ /index.html;
    proxy_pass http://localhost:3000;
}
```

Generate the htpasswd file with `htpasswd -c /etc/nginx/.morphit-admin-htpasswd <username>`.

**Caddy basicauth directive:**

```caddy
your-domain.example {
    handle /admin/* {
        basicauth {
            <username> <bcrypt-hash>
        }
        reverse_proxy localhost:3000
    }
    handle {
        reverse_proxy localhost:3000
    }
}
```

Generate the bcrypt hash with `caddy hash-password`.

For both: pick a username and password unrelated to any of
your Blurt account names — the admin surface is unauthenticated
in the application but you don't want a passive observer of the
HTTP traffic to learn your relay account name.

Locale-prefixed routes (`/en/admin/...`, `/es/admin/...`, etc.)
must all be covered.  The route's canonical URL form is
`/<locale>/admin/setup-wizard`; the bare `/admin/setup-wizard`
form gets client-side JS-redirected to the locale-prefixed
form on first hit (see `apps/web/src/routes/+page.svelte`), so
your auth rule should match `^/[a-z]{2}(?:-[A-Z]{2})?/admin/`
to cover all 10 locale variants.

---

## 15. Frontend CSP + security headers for operators

SvelteKit emits CSP as a `<meta http-equiv>` tag at
build time. Browsers honor that, but HTTP-header CSP is
more authoritative and some contexts (preflight,
service-worker scope, extensions) only see headers.
Operators serving the Morphit frontend MUST also set
these headers via their web server.

This addresses Finding N in docs/REVISIT-LIST.md §F.

### Required headers

Configure your frontend web server (nginx, Caddy, whatever
you use) to emit all of the following on every response:

```nginx
# HSTS — forces HTTPS for all subsequent requests
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# Content type sniffing protection
add_header X-Content-Type-Options "nosniff" always;

# Referrer policy — send no referrer on navigations
add_header Referrer-Policy "no-referrer" always;

# Prevent embedding in iframes (clickjacking defense)
add_header X-Frame-Options "DENY" always;

# Content Security Policy — MUST match what svelte.config.js
# emits. If you change one, change both. If you override
# either, an XSS payload that would be blocked in the other
# mode may not be blocked in this one.
#
# This is the TIGHTENED 2026-05 form (Audit Finding 6-5):
# explicit connect-src allowlist instead of `https:` wildcard.
# Lists the four default Blurt RPC endpoints plus the
# CoinGecko price API. If your users add custom RPC endpoints
# in Settings they will fail with a CSP error in the browser
# console — that's the correct behavior; either add the
# specific host below, or revert to `connect-src 'self' https:`
# if your community uses a wide pool of community-run RPCs.
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://rpc.blurt.blog https://blurt-rpc.saboin.com https://rpc.beblurt.com https://rpc.blurt.one https://api.coingecko.com; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'" always;
```

For reference, `ops/nginx/indexer.conf` and
`ops/nginx/relay.conf` already set the first four headers
on API responses. The CSP only applies to the frontend
(it has no meaning on JSON responses), so it goes on the
frontend's web server config, not the API nginx configs.

### What the CSP directives do

- `default-src 'self'` — only load resources from the
  same origin by default
- `script-src 'self'` — JS only from same origin; no
  inline scripts, no `eval` (SvelteKit emits content
  hashes to allow the specific inline scripts it
  generates)
- `style-src 'self'` — CSS only from same origin
- `img-src 'self' data:` — images from same origin plus
  inline `data:` URLs (identicons are base64-encoded
  PNG data URIs)
- `font-src 'self'` — fonts only from same origin
- `connect-src 'self' <RPC hosts> https://api.coingecko.com`
  — explicit allowlist tightened in audit 2026-05
  (Finding 6-5). Previously `'self' https:` which permitted
  any HTTPS host as a fetch target, defeating most of the
  purpose of CSP for exfiltration defense. The new form
  permits only the four default Blurt RPC endpoints plus
  the CoinGecko price API. Tradeoffs:
    - Users who add custom RPC endpoints in Settings get
      a browser-side CSP block until you add the host to
      this list. Operators serving community pools should
      either pre-populate their connect-src with the
      community's full RPC set OR revert to the looser
      `connect-src 'self' https:` form (in which case the
      CSP is documenting intent, not enforcing exfiltration
      bounds).
    - The wildcard `https:` form remains the right choice
      if your audience pulls RPCs from a federation-wide
      pool that you can't fully enumerate at deploy time.
- `frame-ancestors 'none'` — this page cannot be
  embedded in another site's iframe
- `form-action 'self'` — form submits only to same
  origin
- `base-uri 'self'` — `<base>` tag only points to same
  origin
- `object-src 'none'` — no Flash, Java, or other
  plugins

### HTTPS-only requirement

Serve the frontend over HTTPS only. HSTS will enforce
this on repeat visitors but doesn't help the first
request. A typical nginx pattern:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name morphit.example.org;
    return 301 https://$server_name$request_uri;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name morphit.example.org;
    # ... SSL config, headers above, root path to build/ ...
}
```

### Verification

From a different machine, run:

```bash
curl -sI https://morphit.example.org/ | grep -iE "(strict-transport|x-content|referrer|x-frame|content-security)"
```

Expected: all five headers present. If any are missing,
fix your web server config before making the deployment
public.

---

## 16. Operator-account balance alerts

The indexer can watch your relay and fees accounts on-chain and
alert you when either drops below a threshold. This catches
silent drain: a @morphit-relay that runs out of BLURT stops
processing welcome bonuses, dust refills, and loyalty grants
without crashing; without alerts you'd only hear about it when
users complain.

The scanner is OFF by default. To enable, set one or both
thresholds to a non-zero value. Both accounts are monitored
independently — you can alert on the relay without alerting on
fees, or vice versa.

### Configuration

Add to the indexer's systemd unit (or `.env` if that's how you
load environment variables):

> **Tip:** these two thresholds are operator-tunable via
> `morphit.config.env` (see §23) — copy
> `morphit.config.env.example` to `morphit.config.env` and
> uncomment the relevant lines.  OS-set env vars (SystemD
> `Environment=`, Docker `-e`, shell `export`) always win
> over the file, so existing env-driven deployments keep
> working unchanged.

```ini
# Alert when @morphit-relay drops below 100 BLURT. Set to 0 to
# disable monitoring for this account.
Environment="MORPHIT_INDEXER_OPERATOR_BALANCE_RELAY_THRESHOLD_BLURT=100"

# Alert when @morphit-fees drops below 10 BLURT. Fees normally
# accumulate rather than drain, so a drop below 10 typically
# indicates either an over-aggressive auto-sweep or something
# wrong with the account. Set to 0 to disable.
Environment="MORPHIT_INDEXER_OPERATOR_BALANCE_FEES_THRESHOLD_BLURT=10"

# Optional: how often the scanner polls. Default 15 min.
# Environment="MORPHIT_INDEXER_OPERATOR_BALANCE_INTERVAL_MS=900000"

# Optional: how many consecutive RPC failures trigger a
# SUSTAINED_RPC_FAILURE alert. Default 3.
# Environment="MORPHIT_INDEXER_OPERATOR_BALANCE_FAILURE_ALERT_THRESHOLD=3"
```

Reload + restart the indexer:

```sh
sudo systemctl daemon-reload
sudo systemctl restart morphit-indexer.service
```

### Choosing thresholds

The relay threshold is the most important. Rough rule: set it
to cover at least 24-48h of normal outflow (welcome bonuses +
loyalty delegations + dust refills) so you have time to notice
and top up before the relay actually empties. For a small
instance, 50-100 BLURT is typical; a busy instance might want
500+ BLURT of runway. You know your own volume better than we
do — look at 7 days of outgoing transfers from your relay on
`blocks.blurtwallet.com` to calibrate.

The fees threshold should be near zero. Fees accumulate
naturally; the only ways the balance drops are a manual sweep,
a misconfigured automated sweep, or a compromised account.
Setting fees threshold to ~10 BLURT catches all three.

### What the alerts look like

By default, alerts go to the structured logger (module
`operator-balance`). On a systemd box that means they land in
`journalctl` as JSON:

```sh
sudo journalctl -u morphit-indexer.service | grep '\[operator-balance\]'
```

Four alert kinds:

- `LOW_BALANCE` — downward crossing. Fires once per cross; as
  long as balance stays below threshold, the scanner stays
  quiet. Payload includes current balance, threshold, account,
  and role (`relay` / `fees`).
- `RECOVERED` — upward crossing after a `LOW_BALANCE`. Lets you
  confirm your top-up landed. Fires once per recovery.
- `SUSTAINED_RPC_FAILURE` — N consecutive failures to reach
  Blurt for the balance check. Important because "can't check"
  silently prevents alerts; you want to know your alerting is
  blind.
- `SHAPE_ERROR` — balance string unparseable. Rare; usually
  indicates a Blurt chain upgrade that changed response shape.

### Verifying the scanner is running

The `/v1/health?verbose=1` endpoint exposes the scanner's live
state:

```sh
curl -s http://localhost:$INDEXER_PORT/v1/health?verbose=1 \
  | jq .diagnostics.operator_balances
```

Expected shape (two accounts monitored, relay currently fine,
fees not yet observed this cycle):

```json
[
  {
    "account": "morphit-relay",
    "role": "relay",
    "threshold_blurt": 100,
    "below_threshold": false,
    "last_observed_blurt": 245.137
  },
  {
    "account": "morphit-fees",
    "role": "fees",
    "threshold_blurt": 10,
    "below_threshold": null,
    "last_observed_blurt": null
  }
]
```

An empty array means no thresholds are configured (scanner
opted out). A `below_threshold: null` means the scanner hasn't
completed a successful observation for that account yet —
usually this resolves within one scan interval of boot.

### Routing alerts elsewhere (Discord, email, webhook)

The default sink writes structured JSON to the logger. If you
want alerts in Discord, on your phone, or in an incident-
management system, you have two options:

1. Tail the log and route externally. Simplest, no code
   changes. A small sidecar reads `journalctl` output, filters
   on `"module":"operator-balance"` JSON lines, and forwards
   whatever payload matches your target (Discord webhook,
   email relay, Matrix bot, PagerDuty API).

2. Replace the AlertSink at indexer build time. The scanner
   accepts an injected sink; operators with TypeScript
   comfort can fork the indexer, swap the default sink for one
   that POSTs to a webhook, and deploy. Lower latency, but
   requires maintaining a fork.

Option 1 is what most instances should pick.

### Canonical Matrix routing — apps/matrix-bot

For operators picking Matrix as their alert channel, the morphit
repo ships a turnkey sidecar at `apps/matrix-bot/` that implements
Option 1 above with a tier-aware classifier.  Same shipping pattern
as `ops/bunkerweb/`, `ops/nginx/`, `ops/systemd/`, etc. — copy + edit
+ `systemctl enable --now morphit-matrix-bot`.

**What it does:**

The bot tails `journalctl -u morphit-indexer -u morphit-relay -o
json --follow`, parses each line, classifies the alert into one of
three tiers (CRITICAL, WARN, INFO), and DMs the operator's MXID
over end-to-end-encrypted private Matrix chat.  Three tiers,
deliberately tuned to prevent alert fatigue without losing
urgency:

- **CRITICAL** — delivered immediately, NO rate limit, NO
  aggregation.  Tamper-detection events (bundle hash mismatch,
  pubkey mismatch), kill-switch fired, sustained RPC failure (the
  alerting itself is blind), daily signup ceiling hit (active
  attack signal), `INVALID_FEE_METHOD` attempts (a Memory #23 USDT-
  as-listing-fee try), backup failures, AIDE integrity violations,
  operator account drained to 0 BLURT (relay halted).
- **WARN** — rate-limited to one per category per hour, DM'd
  individually.  Low-balance crossings (above zero), witness fee
  changes, stale BLURT/USD price feed, single-IP signup spikes
  below the daily ceiling, federation peer down >24h, sequential-
  signup pattern detected.
- **INFO** — aggregated into a single daily digest sent at 09:00
  UTC.  Skipped entirely on quiet days.  `RECOVERED` events,
  normal backup successes, federation discovery summaries.

**Two distinct Matrix addresses kept separate by design:**

- `MORPHIT_MATRIX_BOT_ALERT_MXID` — **PRIVATE** MXID for alert
  DMs (`@user:server`).  Bot-only; never exposed via
  `/v1/instance` or any other public API.  Comma-separate
  multiple MXIDs for vacation coverage — the bot DMs each
  recipient on every alert.
- `MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM` — **PUBLIC** room alias
  for user→operator contact (`#room:server`).  Exposed via
  `/v1/instance.operator_matrix_room`; rendered on /support,
  /about-this-instance, and the site footer as a matrix.to link.

These NEVER cross-pollinate.  A security alert routed to a public
room would be a privacy violation; an operator MXID exposed via
public API would leak the operator's private Matrix identity to
every API consumer.  The codebase enforces this at multiple
layers: branded TypeScript types (`MatrixMxid` vs
`MatrixRoomAlias`) make compile-time confusion impossible without
an explicit cast; the bot's config refuses to start if
`MORPHIT_MATRIX_BOT_ALERT_MXID` carries a `#`-prefixed value; the
indexer's config refuses to start if
`MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM` carries an `@`-prefixed
value; and adversarial smoke tests (`apps/matrix-bot/scripts/
surface-invariant-smoke.ts`) independently verify every boundary
on every CI run.

**Setup:**

```sh
# 1. Create a dedicated Matrix account for the bot (NOT your
#    personal account — the bot stores a long-lived access token).
#    Most Matrix clients support "Settings → Help & About →
#    Access Token" or equivalent.

# 2. Create the system user.
sudo useradd --system --no-create-home --shell /usr/sbin/nologin \
             --groups systemd-journal morphit-matrix-bot
sudo mkdir -p /var/lib/morphit-matrix-bot
sudo chown morphit-matrix-bot:morphit-matrix-bot \
           /var/lib/morphit-matrix-bot
sudo chmod 0750 /var/lib/morphit-matrix-bot

# 3. Write /etc/morphit/matrix-bot.env (0600, root:morphit-matrix-bot):
sudo install -m 0640 -o root -g morphit-matrix-bot /dev/stdin \
     /etc/morphit/matrix-bot.env <<'ENV'
MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org
MORPHIT_MATRIX_BOT_ACCESS_TOKEN=<bot-account-access-token>
MORPHIT_MATRIX_BOT_ALERT_MXID=@you:matrix.org,@your-backup:matrix.org
# Optional:
# MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS=morphit-indexer.service,morphit-relay.service
# MORPHIT_MATRIX_BOT_DIGEST_SEND_TIME_UTC=09:00
# MORPHIT_MATRIX_BOT_DRY_RUN=false
ENV

# 4. Install matrix-bot dependencies (native build for better-sqlite3).
#
# matrix-bot depends on better-sqlite3 (state persistence) and
# matrix-bot-sdk (Matrix client).  better-sqlite3 compiles native
# bindings against node headers downloaded from nodejs.org during
# `npm install` — your deploy box needs:
#
#   - build-essential or equivalent (gcc, make, python3)
#   - outbound HTTPS to nodejs.org for the node headers
#
# Both are present on a default Ubuntu/Debian VPS once you've run
# `sudo apt install -y build-essential python3` (from §1 of
# RUN-A-MORPHIT-NODE.md).  If you've sealed outbound HTTPS to a
# strict allowlist (BunkerWeb path or similar), add nodejs.org
# to the allowlist for the duration of `npm install`.
cd /opt/morphit
sudo -u morphit npm ci --workspaces --include-workspace-root \
                       --omit=optional --no-audit --no-fund
# Verify:
test -d /opt/morphit/node_modules/better-sqlite3/build \
    || (echo "better-sqlite3 native build did not produce build/ — see logs"; exit 1)

# 5. Install + enable the systemd unit.
sudo cp /opt/morphit/ops/systemd/morphit-matrix-bot.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-matrix-bot

# 6. Verify.
sudo systemctl status morphit-matrix-bot
sudo journalctl -u morphit-matrix-bot --since '5 minutes ago'
# Expect: "morphit-matrix-bot ready." in the logs.
```

**Vacation coverage:** put a comma-separated list of MXIDs in
`MORPHIT_MATRIX_BOT_ALERT_MXID`.  The bot DMs every recipient on
every alert.  Your backup operator gets the same CRITICALs you do
without any extra plumbing.

**Testing the wiring:** set `MORPHIT_MATRIX_BOT_DRY_RUN=true`,
restart the unit, and the bot logs what it WOULD have sent
without actually posting to Matrix.  Useful for verifying the
classifier sees your indexer/relay log lines correctly before
going live.

**For operators who prefer email/Discord/PagerDuty instead:** the
generic Option 1 advice above still applies.  matrix-bot is the
canonical sidecar but not the only one supported.

#### matrix-bot — known dependency vulnerabilities (cp138 audit)

`npm audit` reports 2 critical and several moderate CVEs that all
trace through `matrix-bot-sdk@0.7.1`'s dependency on the
deprecated `request@2.88.2` package and its transitives
(`form-data@2.3.3`, `qs`, `tough-cookie`, `uuid`).  Upgrading the
SDK to its current latest `0.8.0` does NOT fix this — `0.8.0`
still depends on the same `request@^2.88.2`.

**Practical exposure on a Morphit instance is near-zero because:**

1. matrix-bot is **opt-in** — the systemd unit only does work if
   `MORPHIT_MATRIX_BOT_ALERT_MXID` is set.  Operators who don't
   enable Matrix alerts never load the SDK into a running
   process.  If you're picking email or another channel for
   alerts, this section doesn't apply to you.
2. matrix-bot's network direction is **outbound only**.  It POSTs
   to a homeserver URL that **the operator configured via env
   var** (`MORPHIT_MATRIX_BOT_HOMESERVER`).  It does NOT accept
   inbound user URLs to fetch.  The `request`-package SSRF CVE
   requires user-controlled URLs; matrix-bot doesn't provide any.
3. The `form-data` unsafe-random-boundary CVE requires an
   attacker-controlled multipart upload.  matrix-bot doesn't
   accept multipart uploads; it only emits JSON to the
   homeserver.
4. The `qs` DoS and `tough-cookie` prototype-pollution CVEs
   require user-supplied query strings / cookies.  matrix-bot
   doesn't parse any.

**What this means for operators:**

- If you don't enable matrix-bot, you can ignore these CVEs.
- If you DO enable matrix-bot, the practical risk is minimal so
  long as you keep `MORPHIT_MATRIX_BOT_HOMESERVER` pointed at a
  homeserver you trust (which is the design intent: it's your
  Matrix homeserver, not a user's).
- An automated CVE scanner WILL flag your install.  This is
  expected; the scanner is right about the CVE numbers but
  doesn't model matrix-bot's input surface.

**Tracked for post-launch:** cp138-R-2 in `docs/REVISIT-LIST.md`.
Two real fix options under evaluation: swap to `matrix-js-sdk`
(official Matrix SDK with a larger surface but maintained deps),
or add `npm overrides` to force-resolve transitives (needs
testing matrix-bot's actual API surface still works with
overridden versions).  Neither is a pre-launch blocker.

### Host-resource monitoring sidecar — disk / memory / swap / CPU

The matrix-bot tails `morphit-indexer` + `morphit-relay` journals
by default, which surfaces application-level events.  Host-level
resource exhaustion (disk full, memory critical, swap thrashing,
CPU saturated) is monitored by a separate **bash-script sidecar**
shipped at `ops/scripts/morphit-host-monitor.sh` with an
accompanying systemd timer at `ops/systemd/morphit-host-monitor.timer`.

The sidecar:

1. Runs every 5 minutes (configurable via the `.timer` file).
2. Reads `/proc/meminfo`, `df -P`, `/proc/loadavg`, `/proc/vmstat`.
3. Compares against configurable thresholds (env-tunable).
4. Emits structured JSON to journalctl via `systemd-cat -t
   morphit-host-monitor`.
5. The bot picks these up automatically because
   `morphit-host-monitor.service` is in the default
   `MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS` list.

Three tiers per resource:

| Resource | INFO threshold | WARN threshold | CRITICAL threshold |
|---|---|---|---|
| Disk usage | >70% | >85% | >95% |
| Memory usage | >70% | >85% | >95% |
| Swap usage | >25% | >50% | >75% |
| Swap thrashing (pages/sec) | — | >100 | >1000 |
| CPU saturation (load/cores) | >1.5x | >3x | >5x |

All thresholds are env-tunable.  The defaults are reasonable for
a 1-4 vCPU / 2-8 GB RAM VPS — operators on heavier hardware may
relax them; operators on tighter hardware may tighten them.

**Setup:**

```sh
# 1. Create the system user.
sudo useradd --system --no-create-home --shell /usr/sbin/nologin \
             morphit-host-monitor
sudo mkdir -p /var/lib/morphit-host-monitor
sudo chown morphit-host-monitor:morphit-host-monitor \
           /var/lib/morphit-host-monitor
sudo chmod 0750 /var/lib/morphit-host-monitor

# 2. (Optional) Write /etc/morphit/host-monitor.env with operator-
#    tuned thresholds.  See ops/scripts/morphit-host-monitor.sh
#    for the full list.  Skip if the defaults are fine.

# 3. Install + enable the timer.
sudo cp /opt/morphit/ops/systemd/morphit-host-monitor.service \
        /etc/systemd/system/
sudo cp /opt/morphit/ops/systemd/morphit-host-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-host-monitor.timer

# 4. Verify (the timer fires once 30s after boot, then every 5m).
sudo systemctl list-timers morphit-host-monitor.timer
sudo journalctl -u morphit-host-monitor --since '10 minutes ago'
# Expect: structured JSON lines on stdout when any threshold is
# breached.  No output means everything is within INFO thresholds.
```

**Configurable env vars** (with defaults):

```ini
# /etc/morphit/host-monitor.env
MORPHIT_HOST_DISK_CRITICAL=95
MORPHIT_HOST_DISK_WARN=85
MORPHIT_HOST_DISK_INFO=70
MORPHIT_HOST_DISK_PATHS=/          # space-separated; add /var if separate

MORPHIT_HOST_MEM_CRITICAL=95
MORPHIT_HOST_MEM_WARN=85
MORPHIT_HOST_MEM_INFO=70

MORPHIT_HOST_SWAP_CRITICAL=75
MORPHIT_HOST_SWAP_WARN=50
MORPHIT_HOST_SWAP_INFO=25

MORPHIT_HOST_SWAP_THRASH_CRITICAL=1000   # pages/sec
MORPHIT_HOST_SWAP_THRASH_WARN=100

MORPHIT_HOST_CPU_CRITICAL=5.0      # loadavg / cores ratio
MORPHIT_HOST_CPU_WARN=3.0
MORPHIT_HOST_CPU_INFO=1.5

# All-mount sweep (cp15, skip-list extended cp22) — extends the
# operator-configured MORPHIT_HOST_DISK_PATHS check with a sweep
# of every writable mount that isn't a pseudo-filesystem.
# Catches Docker volumes, encrypted overlay mounts, runaway
# tmpfs.  Set to 0 to disable; uses the same DISK_* thresholds.
# Pseudo-fs are always skipped (proc, sysfs, cgroup, devtmpfs,
# squashfs; Docker storage drivers overlay/overlay2/aufs and
# their rootless fuse.fuse-overlayfs analog; NFS server-side
# pseudo-FS rpc_pipefs and nfsd; and network mounts
# fuse.rclone/fuse.s3fs/fuse.sshfs whose `df` percentages are
# meaningless and can stall the sweep).
MORPHIT_HOST_SCAN_MOUNTS=1
```

In addition to the operator-configured paths in `MORPHIT_HOST_DISK_PATHS`,
the all-mount sweep emits three additional event types:
`mount_critical` / `mount_warn` / `mount_info` (with the same
threshold tiering as `disk_*`).  Payload includes `path`,
`fstype`, `percent`, and `threshold`.  This catches the
filling-bind-mount and runaway-tmpfs cases the canonical
`DISK_PATHS` doesn't cover.

**Opt-in default, same as matrix-bot.** If you don't enable the
timer, the sidecar doesn't run and no host-resource alerts fire.
Operators not using Matrix at all skip both the bot and the
sidecar.

**Adding more host-watch targets later:** the bot is open to any
unit name listed in `MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS`.  If
you write your own monitor (e.g. a Nagios plugin wrapper) that
emits the same `{ts, level, module, event, context}` JSON shape
via `systemd-cat -t <your-name>`, the bot will tier-route it
through the classifier.  Unknown (module, event) pairs default
to INFO (digest); add an explicit matcher in
`apps/matrix-bot/src/classifier.ts` if you want CRITICAL or WARN
routing for a specific event.

### Extended monitoring sidecars — smartctl, fail2ban, mdadm

Three additional sidecars use the same emit-via-systemd-cat
pattern as the host-resource monitor.  Each is opt-in (operator
must enable the timer) and is included in the bot's default
`MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS` so alerts route
automatically once the timer is enabled.

#### Disk SMART health — `morphit-smartctl-monitor`

Polls `smartctl -H -A -l selftest` on every detected non-loop
block device every 6 hours.  Emits structured JSON via
`systemd-cat -t morphit-smartctl-monitor`.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `smart_failed` | CRITICAL | SMART overall-health self-assessment FAILED |
| `self_test_failed` | CRITICAL | Most recent self-test reports failure |
| `temperature_critical` | CRITICAL | Disk ≥ 60°C (env: `MORPHIT_SMART_TEMP_CRITICAL`) |
| `temperature_warn` | WARN | Disk ≥ 50°C (env: `MORPHIT_SMART_TEMP_WARN`) |
| `reallocated_sectors` | WARN | `Reallocated_Sector_Ct > 0` |
| `pending_sectors` | WARN | `Current_Pending_Sector > 0` |
| `temperature_sustained_high` | WARN | SCT thermal log: lifetime max temp ≥ `TEMP_WARN + 5°C` (drive hit WARN+ at least once even if cool right now) |
| `temperature_overlimit_count` | WARN | SCT thermal log: drive firmware's over-temperature counter is non-zero |
| `smartctl_unavailable` | INFO | smartmontools not installed |

The SCT thermal-log events (`temperature_sustained_high` and
`temperature_overlimit_count`) come from `smartctl -l scttempsts`,
which the drive itself maintains.  They surface trends the
instantaneous temperature check can't see: a drive that briefly
spiked above threshold between samples, and a drive whose own
firmware has flagged sustained thermal stress.  Drives that
don't support SCT thermal logging are silently skipped (no
event emitted).

Setup:

```sh
# 1. Install smartmontools.
sudo apt install -y smartmontools

# 2. (Optional) Operator-tuned thresholds.
sudo install -m 0644 -o root -g root /dev/stdin \
     /etc/morphit/smartctl-monitor.env <<'ENV'
MORPHIT_SMART_TEMP_CRITICAL=55   # tighter for hot data centres
MORPHIT_SMART_TEMP_WARN=45
ENV

# 3. Install + enable.
sudo cp /opt/morphit/ops/systemd/morphit-smartctl-monitor.service \
        /opt/morphit/ops/systemd/morphit-smartctl-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-smartctl-monitor.timer
```

Caveats: SMART monitoring is most useful on bare-metal hosts.
On most VPS providers the disks are virtualized and smartctl
reports either nothing or the host's own disks, so the alerts
may be uninformative.  Useful for self-hosted dedicated
hardware.

#### fail2ban observability — `morphit-fail2ban-monitor`

Polls `fail2ban-client status` every 5 minutes.  Alerts on
daemon-down (meaning brute-force is NOT being blocked) and
ban-count spikes (meaning attack in progress).  Delta-tracks
total bans across runs for ban-rate detection.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `daemon_unreachable` | CRITICAL | fail2ban-client cannot reach the daemon |
| `jail_critical_ban_count` | CRITICAL | currently-banned ≥ `MORPHIT_FAIL2BAN_BAN_CRITICAL` (50) |
| `jail_high_ban_count` | WARN | currently-banned ≥ `MORPHIT_FAIL2BAN_BAN_WARN` (15) |
| `jail_ban_rate_warn` | WARN | bans/hour rate ≥ 100 (delta-tracked) |
| `fail2ban_unavailable` | INFO | fail2ban-client not in PATH |

Per-jail overrides via env vars
`MORPHIT_FAIL2BAN_<UPPERCASE-JAIL>_CRITICAL` and `_WARN` — e.g.
a busy SSH jail might want `MORPHIT_FAIL2BAN_SSHD_CRITICAL=100`
while a quiet postfix jail uses the default 50.

Setup:

```sh
# 1. fail2ban itself must already be running (§34 covers install).

# 2. (Optional) operator-tuned thresholds.
sudo install -m 0644 -o root -g root /dev/stdin \
     /etc/morphit/fail2ban-monitor.env <<'ENV'
MORPHIT_FAIL2BAN_BAN_CRITICAL=50
MORPHIT_FAIL2BAN_BAN_WARN=15
MORPHIT_FAIL2BAN_SSHD_CRITICAL=100   # SSH jail is allowed to be loud
ENV

# 3. State dir for ban-rate delta tracking.
sudo mkdir -p /var/lib/morphit-fail2ban-monitor
sudo chmod 0750 /var/lib/morphit-fail2ban-monitor

# 4. Install + enable.
sudo cp /opt/morphit/ops/systemd/morphit-fail2ban-monitor.service \
        /opt/morphit/ops/systemd/morphit-fail2ban-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-fail2ban-monitor.timer
```

#### Linux software RAID — `morphit-mdadm-monitor`

Reads `/proc/mdstat` every 15 minutes.  No package install
needed — `/proc/mdstat` is in the kernel.  Safe to enable
defensively on any host: exits silently if no md arrays exist.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `array_failed` | CRITICAL | Array no longer functional (all devices gone) |
| `array_degraded` | CRITICAL | One or more devices failed/missing |
| `array_resyncing` | INFO | Array rebuilding (normal after disk replacement) |

Setup:

```sh
sudo cp /opt/morphit/ops/systemd/morphit-mdadm-monitor.service \
        /opt/morphit/ops/systemd/morphit-mdadm-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-mdadm-monitor.timer
```

No service user setup needed — the unit uses `DynamicUser=true`
since `/proc/mdstat` is world-readable.

#### Kernel-log monitor — `morphit-dmesg-monitor`

Scans the kernel ring buffer (`dmesg`) every 5 minutes for
events the host-resource sidecar can't see: the host-monitor
sees memory pressure *building*; the dmesg-monitor sees the
consequences when it broke.

State is cursor-based at `/var/lib/morphit-dmesg-monitor/last-cursor`
so successive runs don't re-alert on old events.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `oom_kill` | CRITICAL | Kernel killed a process to free memory |
| `kernel_oops` | CRITICAL | Kernel detected an internal error |
| `kernel_panic` | CRITICAL | Kernel panicked (host may be unstable) |
| `hardware_error` | CRITICAL | MCE / EDAC / ATA / I/O error |
| `segfault_in_morphit` | CRITICAL | A morphit-related process segfaulted |
| `segfault_other` | WARN | Some other process segfaulted |
| `fd_exhausted` | WARN | Fork failed (out of FDs/PIDs) |
| `dmesg_unreadable` | INFO | dmesg not readable (service must run as root) |

Each alert includes the raw kernel-log line (first 200 chars)
so you can pattern-match in `journalctl` for context.

Setup:

```sh
# 1. State dir.
sudo mkdir -p /var/lib/morphit-dmesg-monitor
sudo chmod 0750 /var/lib/morphit-dmesg-monitor

# 2. Install + enable.  (Service runs as root because
# kernel.dmesg_restrict=1 is the default since Debian 12.
# Hardening uses CapabilityBoundingSet=CAP_SYSLOG to confine it.)
sudo cp /opt/morphit/ops/systemd/morphit-dmesg-monitor.service \
        /opt/morphit/ops/systemd/morphit-dmesg-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-dmesg-monitor.timer
```

#### Docker image CVE rescan — `morphit-trivy-monitor`

Daily scan of running Docker images (typically just BunkerWeb,
when deployed) for CRITICAL + HIGH severity CVEs disclosed since
deploy.  Without this monitor, an operator wouldn't know they
were running a vulnerable BunkerWeb until they happened to read
a CVE advisory and remembered they had it deployed.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `image_critical_vulns` | CRITICAL | Image has ≥ `MORPHIT_TRIVY_CRITICAL_THRESHOLD` (default 1) CRITICAL CVEs |
| `image_high_vulns` | WARN | Image has ≥ `MORPHIT_TRIVY_HIGH_THRESHOLD` (default 5) HIGH CVEs |
| `image_scan_failed` | WARN | trivy returned no output for an image |
| `image_scan_clean` | INFO | No actionable findings (daily digest) |
| `trivy_unavailable` | INFO | trivy not installed |

Setup:

```sh
# 1. Install trivy from the Aqua Security apt repo.
sudo install -d -m 0755 /etc/apt/keyrings
wget -qO - https://aquasecurity.github.io/trivy-repo/deb/public.key \
   | sudo tee /etc/apt/keyrings/trivy.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/trivy.asc] \
https://aquasecurity.github.io/trivy-repo/deb $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/trivy.list > /dev/null
sudo apt update && sudo apt install -y trivy jq

# 2. (Optional) operator-tuned thresholds.
sudo install -m 0644 -o root -g root /dev/stdin \
     /etc/morphit/trivy-monitor.env <<'ENV'
MORPHIT_TRIVY_CRITICAL_THRESHOLD=1
MORPHIT_TRIVY_HIGH_THRESHOLD=5
ENV

# 3. Install + enable.
sudo cp /opt/morphit/ops/systemd/morphit-trivy-monitor.service \
        /opt/morphit/ops/systemd/morphit-trivy-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-trivy-monitor.timer
```

Outbound network requirements: trivy needs to pull its CVE DB
from `ghcr.io` (with `mirror.gcr.io` as fallback).  Add both to
your outbound firewall allowlist if you have one.

Note: most CVEs in base images are not exploitable in the way
you're using the container.  When trivy alerts on a CVE that
doesn't apply to your setup, add it to `/etc/morphit/.trivyignore`
to silence future alerts for that CVE ID specifically.

#### Postfix queue monitor — `morphit-postfix-monitor`

Watches the postfix mail queue depth + oldest-message age every
15 minutes.  Solves a critical observability gap: if email
alerting silently fails (smarthost credentials rotated, TLS
bumped, network down), emails pile up in the postfix queue and
the operator hears nothing.  This sidecar makes "alerts aren't
arriving" itself become an alert.

Useful only if you use postfix as your alerting smarthost (per
the §37.14 alerting role).  Skip if you use a different alerting
mechanism.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `queue_critical` | CRITICAL | Queue depth ≥ 100 OR oldest message > 120 min |
| `queue_warn` | WARN | Queue depth ≥ 25 OR oldest message > 30 min |
| `queue_clean` | INFO | Queue empty or below thresholds |
| `postfix_unavailable` | INFO | postqueue not in PATH |

All thresholds env-tunable in `/etc/morphit/postfix-monitor.env`.

Setup:

```sh
# Postfix itself must be installed already (per §37.14).
# Verify with:
which postqueue || sudo apt install -y postfix

# Install + enable the monitor.
sudo cp /opt/morphit/ops/systemd/morphit-postfix-monitor.service \
        /opt/morphit/ops/systemd/morphit-postfix-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-postfix-monitor.timer
```

#### TLS cert expiry + renewal-stall detector — `morphit-certbot-monitor`

Daily check of TLS cert expiry combined with a **renewal-stall
detector** that catches the killer pattern: cert is about to
expire AND certbot has not had a successful renewal in N days.
A cert renewing fine 6 months ago can silently start failing for
weeks before it actually expires; this sidecar finds that gap.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `cert_expiry_critical` | CRITICAL | Cert expires in ≤ 7 days |
| `cert_expiry_warn` | WARN | Cert expires in ≤ 30 days |
| `renewal_stalled` | CRITICAL | Cert expiring AND last successful renewal > 14 days ago |
| `certbot_unavailable` | INFO | openssl or `/etc/letsencrypt/live/` missing |

All thresholds env-tunable.  Reads `/var/log/letsencrypt/letsencrypt.log`
for the "Renewal was successful" line timestamps; falls back
gracefully if the log is rotated or unreadable.

Setup:

```sh
# certbot itself must be installed (per §35 TLS role).
# Verify with:
test -d /etc/letsencrypt/live || echo "certbot not configured yet"

# (Optional) operator-tuned thresholds.
sudo install -m 0644 -o root -g root /dev/stdin \
     /etc/morphit/certbot-monitor.env <<'ENV'
MORPHIT_CERTBOT_EXPIRY_CRITICAL_DAYS=7
MORPHIT_CERTBOT_EXPIRY_WARN_DAYS=30
MORPHIT_CERTBOT_RENEWAL_STALL_DAYS=14
ENV

# Install + enable.
sudo cp /opt/morphit/ops/systemd/morphit-certbot-monitor.service \
        /opt/morphit/ops/systemd/morphit-certbot-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-certbot-monitor.timer
```

#### Pending security updates monitor — `morphit-apt-monitor`

Daily count of pending security updates.  Surfaces the same
information the motd shows but operators stop reading after the
first month — this routes them through the same alert channel
as everything else.  Debian/Ubuntu only.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `security_updates_critical` | CRITICAL | Security updates pending ≥ 10 |
| `security_updates_warn` | WARN | Security updates pending ≥ 1 |
| `updates_pending_info` | INFO | Non-security updates only (daily digest) |
| `apt_unavailable` | INFO | apt not in PATH |

Setup:

```sh
# (Optional) operator-tuned thresholds.
sudo install -m 0644 -o root -g root /dev/stdin \
     /etc/morphit/apt-monitor.env <<'ENV'
MORPHIT_APT_SECURITY_CRITICAL=10
MORPHIT_APT_SECURITY_WARN=1
ENV

# Install + enable.
sudo cp /opt/morphit/ops/systemd/morphit-apt-monitor.service \
        /opt/morphit/ops/systemd/morphit-apt-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-apt-monitor.timer
```

Note: the sidecar runs `apt-get update` itself before counting,
so it always reports against fresh package lists.  Outbound
network requirements: same as your apt install (e.g.
archive.ubuntu.com).

#### Docker Compose service health monitor — `morphit-compose-monitor`

Watches Docker Compose service health-check status + restart
counts every 5 minutes.  Catches three patterns: services
reporting `health: unhealthy` (canonical compose signal),
services in state `exited` when they should be running, and
services in restart loops (high `RestartCount` over short time).

Most useful with the BunkerWeb deploy path (§32).  Useless on
bare-metal-only — the sidecar exits cleanly with an INFO event
in that case.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `service_unhealthy` | CRITICAL | docker compose ps reports `Health: unhealthy` |
| `service_exited` | CRITICAL | Service stopped unexpectedly |
| `service_restart_loop` | WARN | RestartCount ≥ 5 (env-tunable) |
| `docker_unavailable` | INFO | Docker / Compose v2 plugin missing |

Setup:

```sh
# (Optional) operator-tuned threshold + project list.
sudo install -m 0644 -o root -g root /dev/stdin \
     /etc/morphit/compose-monitor.env <<'ENV'
MORPHIT_COMPOSE_RESTART_THRESHOLD=5
MORPHIT_COMPOSE_PROJECTS=/opt/morphit/ops/bunkerweb
ENV

# Install + enable.
sudo cp /opt/morphit/ops/systemd/morphit-compose-monitor.service \
        /opt/morphit/ops/systemd/morphit-compose-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-compose-monitor.timer
```

For multiple compose stacks: `MORPHIT_COMPOSE_PROJECTS=` accepts
a space-separated list of project directories.

#### systemd unit-health monitor — `morphit-systemd-monitor`

Watches `morphit-*` units (plus any in `MORPHIT_SYSTEMD_WATCH`)
for **failed state** and **high restart counts**.  This closes
a gap journalctl-based alerting can't cover: a unit that fails
to even start emits no journal output for the bot to route, so
a failed-start would be silently invisible without this sidecar.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `unit_failed` | CRITICAL | `systemctl is-failed` returns true for a watched unit |
| `unit_restart_loop` | WARN | `NRestarts ≥ 10` (env-tunable) on a still-running unit |
| `unit_missing` | WARN | A unit named in `MORPHIT_SYSTEMD_WATCH` does not exist (config drift) |
| `systemctl_unavailable` | INFO | systemctl not in PATH |

Setup:

```sh
# (Optional) tuning + extra units to watch.
sudo install -m 0644 -o root -g root /dev/stdin \
     /etc/morphit/systemd-monitor.env <<'ENV'
MORPHIT_SYSTEMD_RESTART_THRESHOLD=10
MORPHIT_SYSTEMD_WATCH="postgres@16-main.service docker.service"
ENV

sudo cp /opt/morphit/ops/systemd/morphit-systemd-monitor.service \
        /opt/morphit/ops/systemd/morphit-systemd-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-systemd-monitor.timer
```

#### Journal disk-usage monitor — `morphit-journald-monitor`

Daily check of journald's own disk usage + time span covered.
Catches the "journal silently grew to 8 GB over six months"
pattern: without `SystemMaxUse=` in `/etc/systemd/journald.conf`,
the journal can fill the disk; operators usually find out only
when the disk is full.

Events emitted:

| Event | Tier | Trigger |
|---|---|---|
| `journal_size_critical` | CRITICAL | Journal disk usage > 4 GB |
| `journal_size_warn` | WARN | > 1 GB |
| `journal_rotation_stale` | WARN | Span > 90 days AND > 500 MB (config-drift indicator) |
| `journalctl_unavailable` | INFO | journalctl not in PATH |

Setup:

```sh
sudo cp /opt/morphit/ops/systemd/morphit-journald-monitor.service \
        /opt/morphit/ops/systemd/morphit-journald-monitor.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-journald-monitor.timer
```

Recommended companion: set `SystemMaxUse=1G` (or your preferred
cap) in `/etc/systemd/journald.conf` and
`sudo systemctl restart systemd-journald` so the disk-usage
ceiling is enforced.

### Deploying all sidecars at once via Ansible

The repository ships an Ansible playbook at `ops/ansible/` that
wraps all the above into opt-in roles.  Set `enable_*: true` for
the sidecars you want in `group_vars/all.yml`, populate the
`vault_matrix_bot_access_token` in `group_vars/vault.yml` if
using Matrix, and:

```sh
cd /opt/morphit/ops/ansible
ansible-playbook -i inventory/hosts.yml playbook.yml --tags monitors
```

The `monitors` tag runs only the sidecar roles, leaving the rest
of the deploy untouched — convenient for adding monitoring to an
already-deployed instance.

## 17. Relay origin allowlist — protecting your instance from billing drift

The relay consumes one of your pre-minted ACTs on every
`create_claimed_account` op it broadcasts. Without origin
enforcement, **any web page, `curl` invocation, or script
anywhere on the internet can POST to your relay's
`/v1/account/create` and you'll spend an ACT for it.** Three
concrete scenarios:

1. **Community mirror misconfiguration.** Another operator
   forks Morphit, forgets to update `MORPHIT_RELAY_ORIGIN` in
   their frontend build, and their users' signups hit your
   relay. You silently fund their community.
2. **Hostile frontend.** Someone deliberately runs a frontend
   that points at your relay to drain your funds.
3. **`curl` spam.** A signup-bot that doesn't care about
   browser CORS can POST directly.

The relay defends against all three with an **origin
allowlist** — a server-side check on `/v1/account/create` that
rejects any request whose `Origin` header isn't on your
allowlist.

### What goes in the allowlist?

The `Origin` header reflects **where the browser loaded the page
from** — not where your backend services live. Your frontend's
public URL is what the browser sends, regardless of whether the
backend is on the same server, a different VPS, a CDN, or
localhost. Two common topologies:

**Colocated (one host, one public hostname — the recommended
default).** Your frontend, relay, and indexer all run on
`vps.example.com`, fronted by nginx. Users browse to
`https://morphit.example.com/` and the browser sends `Origin:
https://morphit.example.com` on POSTs to the relay at
`https://morphit.example.com/relay/v1/account/create`. This is
still a "same-origin POST" and browsers include the Origin
header for POSTs even when same-origin.

In this topology — which is what the frontend defaults to (see
§14 "Recommended single-hostname layout") — the relay and
indexer do **not** need their own DNS entries. The frontend
hits `/relay/*` and `/api/indexer/*` as relative paths on the
same origin, and nginx reverse-proxies them to loopback. Your
allowlist needs only the one public hostname:

```
MORPHIT_RELAY_ALLOWED_ORIGINS=https://morphit.example.com
```

Note: "localhost" does NOT appear as the Origin even though the
nginx proxy internally forwards to `127.0.0.1:8080`. The browser
only sees the public URL. Use `http://localhost:5173` only for
local dev where you literally load the page from localhost.

**Split (relay on separate subdomain).** Your relay is on
`relay.morphit.example.com` while the frontend is on
`morphit.example.com`. This requires the frontend to be built
with `MORPHIT_RELAY_ORIGIN=https://relay.morphit.example.com`
overriding the default (see §14 "Split topology"). Users browse
the frontend; browser sends `Origin: https://morphit.example.com`
when POSTing to the relay on `relay.morphit.example.com`. This is
a cross-origin POST. The allowlist entry is still the FRONTEND's
origin, not the relay's:

```
MORPHIT_RELAY_ALLOWED_ORIGINS=https://morphit.example.com
```

**Multiple frontends against one relay.** If you run several
mirrors (.onion, i2p, a .com) all pointing at the same relay,
list them all:

```
MORPHIT_RELAY_ALLOWED_ORIGINS=https://morphit.example.com,http://abc123xyz.onion,http://b32addr.i2p
```

### Configuration

Set the allowed origins in your relay systemd unit:

```ini
# Comma-separated list of exact-match origins (scheme + host +
# optional port, no path, no wildcards). Every frontend that
# should be allowed to create accounts via this relay goes here.
Environment="MORPHIT_RELAY_ALLOWED_ORIGINS=https://morphit.example.com,https://mirror.example.com"
```

The relay already validates at startup that this env var is
non-empty — starting with an empty allowlist rejects all
signups by default, which is the safe behavior.

Reload + restart:

```sh
sudo systemctl daemon-reload
sudo systemctl restart morphit-relay.service
```

### Matching rules (read carefully)

- **Exact match.** `https://morphit.example.com` does NOT match
  `https://www.morphit.example.com` or
  `https://morphit.example.com:8443`. Add each variant
  explicitly if you serve the same frontend under multiple
  hostnames.
- **Scheme matters.** `http://` and `https://` are distinct
  origins. Production instances should only list `https://`.
- **Port matters.** If you serve on a non-default port, include
  it. For testing, `http://localhost:5173` is the usual Vite
  dev-server origin.
- **No wildcards.** The allowlist is a plain `Set<string>` and
  `includes` is exact.

### Behavior

- Request with `Origin` in the allowlist → proceeds normally.
- Request with `Origin` present but not in the allowlist → 403
  with `{ code: "origin_not_allowed" }`.
- Request with no `Origin` header at all → 403 with
  `{ code: "origin_required" }`. Modern browsers always send
  `Origin` on cross-origin POSTs, so a missing header almost
  always means a non-browser client.

Read-only endpoints (`/v1/account/availability`, `/v1/health`)
are NOT gated by the allowlist. Availability is expected to be
called from curl by operators debugging; health is a liveness
probe.

### Reading the logs

Rejections are logged under module `relay-origin`, deduplicated
per (code, origin) pair within a 5-minute window so a sustained
curl-storm doesn't flood the journal. Grep for the module name
when debugging:

```sh
sudo journalctl -u morphit-relay.service | grep '\[relay-origin\]'
```

Two log lines to expect:

- **`rejected_disallowed_origin`** (WARN) — someone's browser
  sent an Origin you haven't listed. The log payload includes
  the rejected origin AND your configured allowlist so you can
  see the fix in one line. This is the signal that matters
  during setup or when moving to a new hostname.
- **`rejected_missing_origin`** (INFO) — a request arrived with
  no Origin header. Almost always a non-browser client (curl,
  bot, or a custom script). Usually ignorable; frequent hits
  suggest someone is probing your endpoint.

### What if legitimate users see origin_required?

First, check `Origin` is actually being sent by their browser.
Ad-blockers and privacy extensions occasionally strip it, but
that's rare on POST. If a user consistently can't sign up and
reports that error, they're probably using an ancient browser
or an aggressive privacy tool — the relay is correctly
refusing to spend funds on an unverifiable request. Point them
at a standard browser.

If your OWN users are getting origin_not_allowed, it means your
frontend is serving from an origin you didn't list. Common
causes:

- You added a new hostname or moved to a CDN and forgot to add
  the new origin.
- You're testing from `http://localhost:5173` without adding
  it. Add it to `MORPHIT_RELAY_ALLOWED_ORIGINS` for the
  duration of testing; remove for production if localhost
  doesn't belong there.
- Your production frontend is on `https://example.com` but
  the allowlist says `https://www.example.com`. Add both or
  redirect one canonically.

### Limits of this defense

An attacker can still forge the `Origin` header with `curl` or
a custom HTTP client. The allowlist raises the friction from
"paste a URL into the browser" to "write a script that spoofs
Origin," which is material for most classes of casual abuse —
but it is NOT a rate-limit or a bot-defense. Your existing
per-IP rate limiters (hourly + daily) do that job. The origin
allowlist specifically closes the "other frontends billing my
relay" gap, nothing more.

If you need cryptographic assurance that a request came from
your own frontend, that requires a shared-secret scheme
(frontend embeds a token at build time, relay validates the
token). That's a larger design change not yet built.

## 18. Signup-drain prevention — the full defense stack

The relay's `/v1/account/create` endpoint consumes one pre-minted
Account Creation Token (ACT) from the relay's pool to create each
new Blurt account.  The BLURT that ACTs cost was paid earlier at
ACT-mint time during the relay's weekly `claim_account` ceremony
(see §2 and ADR-0010 §4), so signup itself is fee-free — but a
successful signup still depletes one ACT from a finite weekly
budget.  Without defenses, a third-party operator who forges the
`Origin` header (server-side scripts can) could attribute THEIR
users' registrations to YOUR relay, draining your ACT pool and
forcing you to either pause signups or mint extra ACTs out-of-cycle
(both BLURT-expensive).  The signup-drain defense is a layer cake;
each layer is cheap, additive, and tunable.  None alone is
sufficient; together they make drains **bounded, detectable fast,
and reversible**.

### Layer 1: Kill-switch

Instant halt. When something goes wrong, flip this first.

```ini
# Default: true (signups enabled). Flip to false to halt ALL
# account creation immediately.
Environment="MORPHIT_RELAY_SIGNUP_ENABLED=false"
```

Reload + restart:

```sh
sudo systemctl daemon-reload
sudo systemctl restart morphit-relay.service
```

While `SIGNUP_ENABLED=false`, both `/v1/account/invite` and
`/v1/account/create` return `503` with `code:
"signups_disabled"`. The frontend shows a "signups temporarily
unavailable, please try another Morphit mirror" message.

### Layer 2: Global daily ceiling

Hard cap on successful signups per UTC day.  Bounds worst-case ACT
depletion to `ceiling` ACTs per day; in BLURT terms that's
`ceiling × act_mint_cost` BLURT of pre-paid value at risk (where
`act_mint_cost` is whatever the chain's `account_creation_fee`
witness-parameter is at claim time, typically ~100 BLURT).  Reset
at UTC midnight.

```ini
# Default 50/day. Start conservative at launch — raise as you
# observe real traffic.
Environment="MORPHIT_RELAY_SIGNUP_DAILY_CEILING=50"
```

When the ceiling is hit, one structured log line fires (module
`signup-ceiling`):

```sh
sudo journalctl -u morphit-relay.service | grep '\[signup-ceiling\]'
```

Expect `ceiling_reached` at level `error`. Further signups that
day return `code: "daily_ceiling_reached"` with a `resets_at`
timestamp so the frontend can tell the user when to try again.

**When to raise:** you're regularly hitting the ceiling during
normal operation (not during attacks). Start at 50/day; at
steady state, you want the ceiling to be `2×` your observed
peak legitimate day. Raising mid-attack is exactly wrong — the
ceiling is your budget-backstop.

### Layer 3: Per-IP spacing

Two mechanisms stack per IP address:

1. A hard daily cap (`MORPHIT_RELAY_CREATE_RATE_PER_DAY`,
   default 2).
2. A minimum gap between this IP's signups
   (`MORPHIT_RELAY_CREATE_SPACING_MINUTES`, default 60). Even
   if the IP has daily capacity left, a second signup within
   the gap is rejected.

```ini
Environment="MORPHIT_RELAY_CREATE_RATE_PER_DAY=2"
Environment="MORPHIT_RELAY_CREATE_SPACING_MINUTES=60"
```

Rejected with `code: "spacing_cooldown"` and a
`retry_after_minutes` field. The frontend shows:

> You recently created an account. Please wait N more minute(s)
> before creating another.

This layer targets the "family of four on one Wi-Fi" UX case:
legitimate, allowed, but spaced out. It also defeats the
"cheap VPS, one IP, 50 signups/day" variety of attacker.

### Layer 4: Signed invite tokens (two-step signup)

Account creation is not a single request — it's two. First the
client POSTs to `/v1/account/invite`. If the relay approves,
it returns a short-lived HMAC-signed invite bound to the
client's IP hash. The client then POSTs to
`/v1/account/create` with the invite as part of the body. The
relay verifies the signature, expiry, IP binding, and marks
the invite used before broadcasting to the chain.

Why two steps:

- The signing secret is server-only. An attacker who downloads
  the frontend bundle gets nothing.
- The invite endpoint is where expensive checks live (rate
  limit + PoW). The create endpoint stays focused on
  signature verification + chain op.
- Short TTL (10 min default) makes stockpiling impractical.
- Single-use via in-memory nonce map prevents replay.

```ini
# Optional: persistent HMAC secret. If unset, the relay
# generates a random 32-byte secret at boot (ephemeral — invites
# in flight don't survive a restart, which is acceptable since
# TTL is only 10 min).
Environment="MORPHIT_RELAY_INVITE_HMAC_SECRET=your-32-byte-random-secret"
```

Most operators should leave the secret unset. The ephemeral
default is safe and avoids the "secret file on disk" problem.

### Layer 5: Altcha proof-of-work (3rd attempt per IP per day)

Altcha is self-hosted client-side PoW. The browser runs ~1-2
seconds of SHA-256 work in a Web Worker before the invite is
granted. **No Cloudflare, no third-party calls, no tracking.**

Triggered on the 3rd+ invite request per IP per UTC day. The
first two attempts are frictionless. Normal users never see
Altcha unless they're retrying a lot after failures.

```ini
# 3 = altcha fires on the 3rd attempt. Lower = more friction
# for legit retry-after-failure users; higher = less defense
# against attackers who bypass per-IP limits.
Environment="MORPHIT_RELAY_ALTCHA_TRIGGER_COUNT=3"

# PoW difficulty. Default 2_000_000 → ~1s on a modern phone.
# Old Android on slow CPUs: ~2-3s.
Environment="MORPHIT_RELAY_ALTCHA_MAXNUMBER=2000000"

# Optional persistent HMAC secret, same semantics as invite.
Environment="MORPHIT_RELAY_ALTCHA_HMAC_SECRET=your-32-byte-random-secret"
```

The Altcha solver is **lazy-loaded** on the frontend: only
users who hit the 3rd attempt download the PoW code. All other
users pay zero bandwidth for this layer.

Frontend UX during solving:

> Verifying you're human… → Verified ✓ → Claiming…

### Layer 6: Anomaly-aware LOW_BALANCE alerts

Ties it all together. When the indexer's operator-balance
scanner fires a `LOW_BALANCE` alert on the relay account, it
probes the relay's `/v1/health?verbose=1` for current signup
stats and decides whether to append a kill-switch
recommendation.

Wire the probe in the indexer's env:

```ini
# Indexer systemd unit: URL to the relay's health endpoint.
# For colocated deployments (relay on same host as indexer),
# this hits loopback — no public exposure needed.
Environment="MORPHIT_INDEXER_RELAY_HEALTH_URL=http://127.0.0.1:8080/v1/health?verbose=1"
```

With the probe wired, a `LOW_BALANCE` alert payload gains a
`signup_anomaly` sub-object. Two anomaly conditions recommend
the kill-switch:

1. Current UTC hour's signup count ≥ 1/3 of the daily ceiling
   (rate would exhaust capacity in under 3 hours).
2. Current hour ≥ 2× today's peak hour AND ≥ 5 signups (spike
   relative to the day's normal).

When either triggers, the alert includes the recommendation
text:

> "Consider setting MORPHIT_RELAY_SIGNUP_ENABLED=false while
> you investigate."

If neither triggers, the alert reports normal volume.

### Layer 7: High-value name policy

The first six layers bound the COUNT of signups an attacker can
extract. Layer 7 reduces the VALUE of each signup to the
attacker by refusing to register names that look like obvious
squatter targets. A determined attacker who exhausts the daily
ceiling now walks away with names like `usr-noob-2026` or
`bobtrades` — names with low resale value — instead of
`bitcoin`, `nike`, or `acct001`.

Six categories are recognized (in priority order):

1. **`short_name`** — name length ≤ threshold (default 4). Short
   names on Graphene-lineage chains are status symbols and
   sell for $50-$500 on secondary markets.
2. **`all_numeric`** — letter prefix followed entirely by digits
   and dashes (e.g., `a000000`). Pure enumeration value, no
   real-user appeal.
3. **`dictionary_brand`** — exact match against a curated list
   of ~100 well-known brand and crypto names (apple, google,
   bitcoin, nike, binance, etc.). Brands defensively buy these;
   squatters know it.
4. **`leet_brand`** — l33t-substituted brand (`m0nero`,
   `b1tcoin`). De-leet table: `0→o, 1→i, 3→e, 4→a, 5→s, 7→t,
   @→a`. Catches the lowest-effort obfuscation; not exhaustive.
5. **`common_dictionary`** — common English words with resale
   value (`money`, `wallet`, `news`, `media`, `premium`).
   Conservative list — focuses on nouns with clear identity-
   marketing value.
6. **`numeric_suffix`** — short prefix (≤4 chars) followed by
   EXACTLY 3 digits (`usr001`, `bob-001`, `acct999`). Enumerator
   signature. Intentionally narrow — 4-digit suffixes are
   year-suffix forms (`bob-1990`, `crypto-noob-2026`) which
   are legitimate user names; the cross-signup detector
   (Layer 8) catches actual enumeration patterns instead.

Configuration:

```ini
# strict (default) — block all six categories
# moderate — block only enumeration patterns (numeric / numeric_suffix);
#            allow brand/dictionary names through (only pick this if
#            you've decided your other defenses make brand-squatting
#            unprofitable)
# off — disable Layer 7 entirely (NOT recommended)
Environment="MORPHIT_RELAY_HIGHVALUE_NAME_POLICY=strict"

# Names this length or shorter trip the short_name category.
# Default 4 — blocks 3- and 4-char names.  Lower to 3 to allow
# 4-char.  Lower to 2 to disable short-name (still keeps brand/
# dictionary detection).
Environment="MORPHIT_RELAY_HIGHVALUE_SHORT_NAME_THRESHOLD=4"
```

When Layer 7 fires, the relay logs a structured
`highvalue_name_rejected` event with `name`, `classification`,
`policy` fields. The user receives `400 name_high_value` with
the localized error message:

> "That name is reserved for legitimate-claim review. Try a
> longer or more personal name. If you have a legitimate claim
> to this exact name, contact the operator."

**Honest limits.** Layer 7 catches obvious squatter targets;
it doesn't (and shouldn't) catch every valuable name. A novel
phrase, a niche meme, or a legitimate but generic name that
isn't on the dictionary list will still pass. Operators
periodically reviewing recent registrations may want to add
to `RESERVED_NAMES` (in `apps/relay/src/policy/name.ts`) when
they spot patterns. False positives are also possible — a real
user named `nike` who uses Blurt would be rejected by Layer 7.
For those, the legitimate path is to direct-broadcast their
account creation to the chain (not via the relay), or to
contact an operator with a moderate policy.

### Layer 8: Sequential signup pattern detection

Layer 7 examines a single name in isolation. Layer 8 watches
for ENUMERATION patterns ACROSS recent successful signups
within the same /24 (IPv4) or /64 (IPv6) bucket. A pattern of
`account001`, `account002`, `account003` from the same bucket
is the signature of an automated drainer; Layer 8 refuses the
3rd one even though Layer 7 lets each individual name pass on
shape alone (long prefix).

Three patterns are detected:

1. **`sequential_numeric_suffix`** — same prefix, differing
   numeric suffix (`acct001`, `acct002`, ...).
2. **`sequential_alpha_suffix`** — same prefix, differing
   single-letter suffix (`accta`, `acctb`, `acctc`).
3. **`sequential_close_similarity`** — same long prefix even
   when the tail isn't strictly numeric/alpha (`userfoo01`,
   `userfoo02`).

State is in-memory, per-bucket, with a rolling window. A relay
restart resets the state — acceptable, since an attacker
mid-restart loses their accumulated history too.

Configuration:

```ini
# Enable / disable Layer 8 entirely.  Default true.  Set false
# only if you run a service that legitimately creates batched
# accounts.
Environment="MORPHIT_RELAY_SEQUENTIAL_DETECTOR_ENABLED=true"

# Rolling window in milliseconds.  Default 1 hour.  An attacker
# who paces signups beyond the window bypasses Layer 8 (but is
# still bounded by global daily ceiling, per-IP spacing, and
# Altcha PoW).
Environment="MORPHIT_RELAY_SEQUENTIAL_WINDOW_MS=3600000"

# Number of prior matching signups before the next is rejected.
# Default 2 — meaning the 3rd sequential signup is the one
# blocked.  Higher = more permissive (allows operators who
# legitimately batch-create some accounts to do so before
# hitting the limit).
Environment="MORPHIT_RELAY_SEQUENTIAL_THRESHOLD=2"

# Minimum prefix length for the close-similarity check.  Names
# sharing fewer characters than this aren't considered similar.
# Default 3.
Environment="MORPHIT_RELAY_SEQUENTIAL_MIN_PREFIX=3"
```

When Layer 8 fires, the relay logs a structured
`sequential_pattern_rejected` event with `name`, `bucketKey`,
`reason`, and `matched` (the prior names that triggered the
pattern). The user receives `429 name_sequential_pattern`:

> "Recent account creations from your network have followed a
> sequential pattern that suggests automation. Try a name that
> doesn't share a prefix with recent signups, or wait an hour
> and retry."

**Honest limits.** Per-bucket isolation means an attacker who
controls multiple /24 ranges (a residential-proxy pool with
diverse upstream) can sustain enumeration — but each bucket
only allows `threshold` matching signups before being cut off.
At default settings (threshold=2, window=1h, daily ceiling=50),
defeating Layer 8 requires ~25 distinct /24 buckets per day
just to fully consume the ceiling — well within reach for a
serious attacker but a meaningful capital cost. False
positives can occur for legitimate batch workflows (e.g., a
company onboarding several staff accounts simultaneously);
those operators can tune the threshold up or temporarily
disable.

### Tuning playbook during a suspected attack

1. **Flip the kill-switch.** `MORPHIT_RELAY_SIGNUP_ENABLED=false`
   and restart. This stops the bleeding immediately with zero
   risk.
2. **Check the anomaly alert.** Was signup volume actually
   abnormal? If yes, you're under attack. If no, the
   low-balance alert was organic — top up and re-enable.
3. **Examine recent signups.** `blocks.blurtwallet.com` → your
   relay account → recent `create_claimed_account` ops. Look for
   similar naming patterns, sequential creation times, no
   follow-up on-chain activity after creation. Those are
   attacker signatures.
4. **Inspect Layer 7 + 8 rejection logs.** Search the relay's
   structured logs for `highvalue_name_rejected` and
   `sequential_pattern_rejected` events. Their volume tells
   you what the attacker is TRYING to register; their
   `bucketKey` field tells you which /24s are involved. If
   you see thousands of such events from a single /16, you
   have intelligence the attacker can't see.
5. **Lower the ceiling** if you decide to re-enable but want
   tighter guardrails: `MORPHIT_RELAY_SIGNUP_DAILY_CEILING=20`
   (or whatever feels safe).
6. **Lower the altcha trigger count** to `2` if you think the
   attacker is using 2 invites per IP to stay under the PoW
   gate.
7. **Tighten Layer 7 + 8 if you've been running on `moderate`
   policy.** Switch `MORPHIT_RELAY_HIGHVALUE_NAME_POLICY=strict`
   if it isn't already. Lower the sequential threshold to 1
   (`MORPHIT_RELAY_SEQUENTIAL_THRESHOLD=1`) so the SECOND
   sequential signup is the one blocked, not the third.
8. **Re-enable.** `MORPHIT_RELAY_SIGNUP_ENABLED=true`, restart.
9. **Watch for 24-48h.** Anomaly alerts will tell you if the
   attacker is still at it.

### Honest limits of this defense

A determined attacker with a large residential-proxy pool AND
the willingness to solve PoW challenges at scale can still
drain up to the daily ceiling. What you DON'T have:

- **Unlimited signups**: ceiling caps it.
- **Zero-friction drain**: per-IP + Altcha forces cost.
- **Undetected drain**: the anomaly detector raises the flag.
- **Unstoppable drain**: the kill-switch is one env var flip
  away.
- **Squatter-resellable names**: Layer 7 + 8 mean an attacker
  who DOES drain the ceiling walks away with names that have
  little resale value (long-prefix non-brand names that
  weren't in any sequential pattern).

What you DO have is exposure capped at `(ceiling × fee)` per
day. At 50/day × ~$0.20/fee that's a **$10/day maximum
financial loss** for an attacker who fully defeats every layer.

The economic argument before Layers 7 + 8 was "an attacker
might burn $10/day to acquire $X in resaleable names + the
satisfaction of the disruption." With Layers 7 + 8 in place,
the resaleable-names component drops sharply because the
attacker cannot get short, brand, or sequential names at all.
This shifts the attacker's cost-benefit: they're paying $10/day
for low-value names, against an operator whose response
bandwidth (kill-switch flip, ceiling adjustment) is ~30 seconds.
The attack becomes uneconomic for any motive other than pure
disruption.

For a stronger defense requiring cryptographic assurance (not
just friction + detection), you'd need a shared-secret scheme
where the frontend embeds a server-issued token at build time
and the relay validates it. That's future work; the current
stack gets you "cannot be catastrophically harmed," which is
the operational target.

## 19. Chat anti-spam (Finding H) — operational reference

The chat handler enforces a three-layer defense against
unsolicited message floods. Each layer is a runtime gate
that doesn't require operator intervention; this section
exists so you can diagnose user reports like "why was my
message rejected" or "why does this person need to pay to
message me."

**Layer 1 — block list.** A user blocks another via a
`morphit_block_v1` custom_json op. The `blocks` table
records the (blocker, blocked) pair. The chat handler
rejects `recipient_blocked_sender` before the INSERT.
Blocks are public on-chain (anyone scraping Blurt sees
them) but the UI never surfaces "you are blocked by @X" to
the blocked party — that would turn a defensive signal
into a provocation.

**Layer 2 — stranger-fee admission.** First-contact
messages between two accounts that have never exchanged
require either (a) a prior admitted message in either
direction, (b) a paid `morphit_stranger_fee_v1` op carrying
a $0.01-USD-equivalent BLURT transfer to @morphit-fees
with memo binding `morphit-stranger:<recipient>`. The memo
binding prevents a single paid transfer from admitting
conversations with multiple peers. The $0.01 fee is fixed
in indexer code — **operators cannot configure it** (this
is intentional: a lax operator lowering the fee would
undercut the anti-spam economics across the whole
ecosystem).

**Layer 3 — rate limits.** Two caps on "recipient has not
yet replied" conversations: fan-in (≤20 unique never-
replied senders per recipient per rolling 24h) and
per-pair no-reply cap (≤50 messages from one sender to a
non-replying recipient, ever). A single reply from the
recipient lifts both caps for the pair forever.

**Layer order.** Block check runs first (blocked senders
shouldn't push legit toward the fan-in cap), then
admission, then rate limits. A blocked sender's stranger-
fee payment is still accepted by the stranger_fees
handler (fees and admission are decoupled for auditability),
but their chat messages still won't reach the recipient.

**Diagnosing support tickets.** If a user says "my message
was rejected":
- Query `blocks` — has anyone blocked this sender-recipient
  pair?
- Query `chat_messages` — is there prior exchange between
  them? If no, does `stranger_fees` have a row for
  (sender, recipient)?
- Check the conversation message count for the sender's
  24h fan-in and per-pair accumulation.

None of these are operator-adjustable — the gates are
protocol-level. If a user is legitimately stuck, direct
them to (a) unblock if blocked, (b) pay the stranger fee
if first contact, (c) wait for the recipient to reply to
lift the rate caps.

## 20. Attestation phase transition (Finding I)

Finding I mitigates a sybil-attack path on BTC/XMR fee
attestation by requiring each attestor to meet loyalty
(≥100 BLURT cumulative fees paid) or age (≥30 days on
Blurt chain) thresholds. The gate runs in two phases
controlled by the `MORPHIT_INDEXER_ATTESTATION_PHASE`
env var.

**Default is `'launch'` (OR gate).** An attestor qualifies
by meeting **either** loyalty OR age. This is the
ecosystem-bootstrap mode: lower bar for early adopters
while still blocking same-day-farmed sock accounts (they
would need to pay $20+ in fees OR wait a month).

**Transition to `'steady'` (AND gate).** Attestor must
meet **both** loyalty AND age. Makes sustained sybil
abuse negative-ROI — attacker must wait 30 days AND pay
$20+ per sock puppet to bypass a $0.125-per-order
listing fee.

### When to flip

Whichever comes first of:
- **90 days** after the ADR-0011 activation (the calendar
  trigger guarantees migration eventually happens
  regardless of traffic).
- **500 accounts** on the chain that already meet BOTH
  gates (the traffic trigger lets us migrate sooner if
  the ecosystem grows faster than the calendar).

### How to check if the traffic trigger is met

```sh
psql "$MORPHIT_INDEXER_DATABASE_URL" <<'SQL'
SELECT COUNT(*) AS eligible_for_steady
  FROM accounts a
  LEFT JOIN account_loyalty al ON al.account = a.name
 WHERE a.created_block_time <= NOW() - INTERVAL '30 days'
   AND COALESCE(al.cumulative_blurt_paid, 0) >= 100;
SQL
```

If the result is ≥500, the traffic trigger is met.

### How to flip

Update the indexer's environment:

```sh
# systemd example:
sudo systemctl edit morphit-indexer.service
# Set:
#   Environment=MORPHIT_INDEXER_ATTESTATION_PHASE=steady
sudo systemctl restart morphit-indexer.service
```

Or in a docker-compose deployment, update the `environment`
block and restart the container. **No redeploy required** —
just an env var flip + process restart.

### Verifying the flip landed

```sh
# After restart, verify the new phase is active by
# checking a known-ineligible account's eligibility response
# and confirming the AND gate fires:
curl -s "http://localhost:PORT/v1/attestor-eligibility/<account>" | jq .phase
# Should report "steady"
```

### Don't flip before the trigger fires

Flipping prematurely locks legitimate early attestors out
of the feeAttest handler (returning `attestor_young_account`
or `attestor_insufficient_loyalty`) and prevents any BTC/XMR
orders from reaching `verified_by_attestation`. The whole
attestation path stalls. Wait for the trigger.

### Don't refuse to flip after the trigger fires

Leaving `launch` permanently means the AND gate never
activates, and any patient attacker can still sybil-attest
their own orders with two ≥30-day-old accounts. The OR gate
is a bootstrap mode, not a permanent posture.

## 21. Schema v17 upgrade note — brief orderbook sequential-scan window

When deploying an indexer build that includes schema-v17,
the migration runs a `DROP INDEX` + `CREATE INDEX` on the
`orders_verified_live_idx` → `orders_live_established_idx`
replacement. Postgres partial-index predicates are immutable,
so this is the only way to widen the filter to include
`verified_by_attestation`.

**Expected behavior:** the migration runs inside a
transaction. For the few seconds between DROP and
CREATE, orderbook queries fall back to a sequential
scan. Not using `CREATE INDEX CONCURRENTLY` because the
migration system wraps each migration in a transaction
for atomicity — CONCURRENTLY can't run inside a
transaction.

**At Morphit's scale** (indexer-sized, not exchange-scale)
the recreate completes in seconds. Operators running
unusually large orders tables (e.g. after months of
accumulation without VACUUM) should be aware that they'll
see a brief write lock + a few-second orderbook latency
spike during the deploy window.

**If the migration takes long enough to matter**, the
workaround is to run the equivalent SQL manually with
`CREATE INDEX CONCURRENTLY` BEFORE starting the indexer
with the new code, then comment out the v17 migration
registration in `migrations.ts` for that deploy only.
This is an expert-operator escape hatch; most deploys
don't need it.

## 22. Choosing Blurt RPC endpoints

Morphit components call Blurt RPC endpoints in three
places:

| Component | Purpose | Config |
|---|---|---|
| Frontend | User signs + queries from their browser | `DEFAULT_RPC_ENDPOINTS` in `apps/web/src/lib/net/config.ts`, overridable in Settings per-user |
| Relay | Broadcasts user-signed ops, spends Mana | `MORPHIT_RELAY_BLURT_RPC` env var (comma-separated) |
| Indexer | Follows the block stream | (indexer's own env, see ADR-0010 deployment notes) |

Each component has its own rotation logic (latency-based
pick with cooldown on failure). The default lists are
seeded from witnesses who were reliably serving a public
RPC endpoint at Morphit launch time.

### When to revisit your endpoint list

- A witness retires their public RPC (node goes offline
  permanently).
- A new high-quality RPC node becomes available in your
  region (latency win).
- Your relay's logs show one endpoint consistently
  timing out despite being up from your monitoring
  perspective (e.g. the endpoint has started
  geo-filtering or CGNAT-filtering).
- After a Blurt network upgrade — older nodes may lag
  in shipping the new version and return stale data.

### How to update your indexer's RPC list

The indexer reads `MORPHIT_INDEXER_RPC_ENDPOINTS` from
`morphit.env` at startup.  Three ways to change it, from
easiest to most low-level:

1. **`morphit-ops edit`** (recommended for an existing instance).
   The wizard's edit flow now includes "Blurt RPC endpoints"
   in its menu of editable sections.  It validates the list
   (https-only, dedup, well-formed URLs), backs up the
   previous version of `morphit.env` to a timestamped
   `.bak-` file, and writes atomically.  Available only
   when `morphit.env` exists at the repo root — operators
   who deploy via Docker/SystemD `Environment=` directives
   instead won't see this option.

   (Don't remember the subcommand?  Run bare `npx morphit-ops`
   on a terminal — cp186 — and pick **Edit settings → Blurt RPC
   endpoints** from the menu.  The menu lists every action with
   a one-line description; non-interactive/piped runs still
   print help as before.)

   The **`morphit-ops init`** wizard (fresh setup) also
   prompts for the RPC list as its 19th step
   (cp137 F-2 — pre-cp137 this prompt was missing and
   operators silently got hardcoded defaults).  Press
   Enter to accept the bundled defaults, or paste a
   comma-separated list of your preferred endpoints.

2. **Edit `morphit.env` by hand.**  Find the
   `MORPHIT_INDEXER_RPC_ENDPOINTS=` line and replace the
   comma-separated value.  Same atomic-replace discipline
   applies if you care about durability — write to
   `morphit.env.tmp`, then `mv morphit.env.tmp morphit.env`
   so a crash mid-edit doesn't leave a half-written file.

3. **Override via the OS environment.**  SystemD units
   can use `Environment="MORPHIT_INDEXER_RPC_ENDPOINTS=..."`,
   Docker compose can use the `environment:` block.  OS
   env wins over `morphit.env` (see operator-config
   package's loading order), so this is the right path
   for deployment automation.

**After ANY change**: restart the indexer to pick up the
new list:
```sh
sudo systemctl restart morphit-indexer
```
Watch journald for the `starting` log line confirming the
new endpoint count, then for the first successful block
poll.  If the indexer fails to start, the log will tell
you which endpoint refused — fix that one and restart.

### How to evaluate candidate nodes

Morphit's built-in rotator handles runtime health-based
selection. What it DOESN'T do is help you pick which
endpoints to seed the list with in the first place. For
that, a community-run tool is the fastest path:

**@nalexadre's Blurt Nodes Checker** — a library that
periodically probes every known Blurt RPC endpoint and
scores them on availability, response time, block-lag,
and Nexus compatibility. The checker drives the live
node list BeBlurt uses in its frontend.

- Article (2026-04): [Blurt Nodes Checker 2.2.0: from
  smart scoring to adaptive
  monitoring](https://blurt.blog/blurt-101010/@nalexadre/blurt-nodes-checker-from-smart-scoring-to-adaptive-monitoring-1777039040219)
- Source: <https://gitlab.com/beblurt/blurt-nodes-checker>
  (GPLv3+)
- Published as `@beblurt/blurt-nodes-checker` on npm

Morphit **does not** ship this library as a dependency
— our frontend bundle is deliberately lean, and our
rotator handles runtime failover without needing an
RxJS-based monitor inline. But as an operator picking
which endpoints to put in your config, the checker's
live scoring output is a better signal than guessing.

You can run the checker yourself (it's a small Node
package) or just read its most recent report on the
Blurt Discord / in nalexadre's blog posts, which
publish periodic roundups.

### Updating your endpoint list

**Frontend default list:** edit
`apps/web/src/lib/net/config.ts` → `DEFAULT_RPC_ENDPOINTS`
and rebuild. This is the list new users get on first
visit; existing users who customized their list in
Settings keep their own list.

**Relay:** update `MORPHIT_RELAY_BLURT_RPC` in the
relay's systemd/docker-compose env file and restart the
relay. Every entry must be `https://`.

**Indexer:** update per ADR-0010 deployment notes and
restart. The indexer is the most-sensitive component —
pick endpoints that are known to stay caught up with
the chain head.

### Common pitfalls

- **Don't list only one endpoint.** A single RPC is a
  single point of failure. Three endpoints is a
  reasonable minimum, five is robust.
- **Don't list only Cloudflare-fronted endpoints.** Part
  of Morphit's resilience promise is routing around
  single-vendor outages. Mix origins.
- **Don't list endpoints whose operators you distrust.**
  An RPC node can return falsified responses (e.g. lie
  about an account's balance) in ways the caller can't
  always detect. Witnesses are a reasonable trust
  heuristic — they have skin in the game via their
  witness position.
- **Don't hardcode endpoint lists in downstream forks
  without updating them.** The default list was accurate
  at ship time; a fork shipping stale defaults degrades
  the user experience of that fork's users.

## 23. The morphit.config.env file — operator-tunable knobs in one place

Morphit reads ~80 environment variables across the indexer
and relay. Most of them encode deployment specifics
(database URL, RPC endpoints, account names, log
destinations) that deployment automation manages — those
stay in your SystemD unit, Docker compose, or
`.env.production`. But a small set of variables are
operationally interesting *after* the service is up: the
BLURT/USD price fallback when klingex is down, the
registration kill-switch you'd flip during a spam wave,
alert thresholds you'd tune as the instance grows.

For those, there's `morphit.config.env`: a single file
at the repo root with the small set of operator-tunable
variables, with prose comments explaining each.

### Where the file lives

`morphit.config.env` at the repo root. A template is
shipped as `morphit.config.env.example` — copy it,
uncomment the lines you want to set, restart.

If your deployment runs from somewhere other than the repo
root, set `MORPHIT_OPERATOR_CONFIG_FILE` to the absolute
path of the file. The indexer and relay both honor this
env var.

### Precedence

Anything in the OS environment wins over this file. So:

- `export MORPHIT_INDEXER_BLURT_PRICE_USD=0.003`
  in your SystemD `Environment=` directive → wins
- `MORPHIT_INDEXER_BLURT_PRICE_USD=0.003` in
  `morphit.config.env` → loses to the SystemD setting,
  applied if SystemD doesn't set it

This means existing deployments that rely entirely on
env-var config keep working unchanged. The file is purely
additive.

### What's in the file

Seven keys, listed below with their purpose. Anything else
in the file causes a hard error at boot — so an operator
who pastes the wrong file (e.g., a deployment `.env` with
DATABASE_URL in it) gets a clear "you can't set that here"
message rather than silent corruption.

**Pricing — survives klingex/coingecko outage.**
`MORPHIT_INDEXER_BLURT_PRICE_USD` (default `0.002`) is the
absolute price floor used when klingex.io and coingecko
are both unreachable. Live feeds always win when reachable;
this only kicks in during an outage. Update it during
prolonged outages so the indexer's emergency fallback
matches reality. See §13 for the full price-feed runbook.

**Registration kill-switch.** `MORPHIT_RELAY_SIGNUP_ENABLED`
(default `true`). Flip to `false` to immediately stop new
account onboarding while existing users continue normally.
Use during active spam-account waves, maintenance, or
suspected drain attacks (§7, §18).

**Listing fee.** `MORPHIT_INDEXER_FEE_BASE_BLURT` (default
`60`) is the BLURT-denominated base fee per order listing.
At BLURT ≈ $0.002, that's about $0.12.  Rarely worth
changing on a single instance — listings posted on your
instance with non-standard fees look unusual to other
operators indexing the chain. Federation uniformity is
the value; deviation is a cost.

The fee model is BLURT-native (per ADR-0011 amendment,
Part 90).  Earlier versions of this doc referenced
`MORPHIT_INDEXER_FEE_BASE_USD`, which was simplified out
of the codebase along with the USD-oracle dependency at
verification time.  Operators who want to track USD
parity should adjust `_FEE_BASE_BLURT` periodically as
BLURT's price drifts.

**Featured-slot bid floor.**
`MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR` (default `50`).
BLURT cost per hour of featured-slot time. Raise to make
featured slots more exclusive; lower to encourage more
bidding.

**Verbose health.** `MORPHIT_INDEXER_VERBOSE_HEALTH`
(default `false`). Toggle on while debugging an
operational issue; revert when done. Verbose output
exposes indexer internals that aren't useful to public
consumers.

**Operator-balance alert thresholds.**
`MORPHIT_INDEXER_OPERATOR_BALANCE_RELAY_THRESHOLD_BLURT`
and `..._FEES_THRESHOLD_BLURT` (defaults `0` = disabled).
Set to non-zero values to receive LOW_BALANCE alerts when
your service accounts drop below the threshold. See §16
for the alert pipeline.

### What's NOT in the file (and why)

**Deployment specifics — DATABASE_URL, RPC_ENDPOINTS,
CHAIN_ID, OFFICIAL_POSTING_PUBKEY, FEE_RECIPIENT account
names.** A wrong value here corrupts state or takes the
service down. We want deployment automation (which gets
these right) to be the only path that sets them; a stray
paste of `morphit.config.env` mustn't be able to overwrite
them.

**Spam-economic constants — STRANGER_FEE_BASE_USD,
STRANGER_FEE_MAX_DOUBLINGS, STRANGER_FEE_WINDOW_MINUTES,
chat layer-3 caps.** These are deliberately uniform across
the federation. If a single operator could lower them,
their users get spammed and the whole federation's
reputation suffers. Changing them requires upstream code
changes and federation-wide consensus, not a local config
edit.

**Log destinations, listen ports, CORS allowlists.**
Operationally important but not "tunable in a hurry" —
they're set once at deployment and don't change in
response to live conditions. Keep them in your SystemD/
Docker config alongside the other deployment specifics.

### Example workflow — klingex.io is down, BLURT price moved

You notice klingex has been down for hours and another
exchange shows BLURT trading 30% higher than your last
known price.

1. SSH to the indexer box.
2. `cd /opt/morphit` (or wherever your repo lives).
3. If `morphit.config.env` doesn't exist yet:
   `cp morphit.config.env.example morphit.config.env`.
4. Edit `morphit.config.env`:
   ```
   MORPHIT_INDEXER_BLURT_PRICE_USD=0.0026
   ```
5. `sudo systemctl restart morphit-indexer.service`.
6. The indexer logs will show:
   `[operator-config] loaded /opt/morphit/morphit.config.env (1 applied, 0 skipped — env wins)`.
7. When klingex comes back up, the live feed takes over
   automatically. The fallback only matters during the
   outage.

You don't need to revert step 4 when klingex returns —
the live feed wins whenever it's reachable. Leaving the
fallback at the more accurate value just means future
outages start from a better baseline.

### Example workflow — spam-signup wave

Health endpoint shows abnormal signup velocity. You want
to stop the bleeding while you investigate.

1. Edit `morphit.config.env`:
   ```
   MORPHIT_RELAY_SIGNUP_ENABLED=false
   ```
2. `sudo systemctl restart morphit-relay.service`.
3. New signups now return a clear "registration
   temporarily disabled" message. Existing users keep
   working.
4. Investigate (§7, §18).
5. When safe, flip back to `true` and restart again.

### Example workflow — operator with strict deployment automation

You don't want to edit any config files on production
boxes; everything goes through Ansible/Terraform/whatever.
That's fine — the file is genuinely optional. Your
existing pipeline that sets `MORPHIT_*` env vars in the
SystemD unit continues to work exactly as before.
`morphit.config.env` is for operators who DO want a
human-edited file; if that's not you, ignore it.

### Verifying the file took effect

After restart, the indexer/relay logs include a line at
boot indicating what the loader did:

```
[operator-config] loaded /opt/morphit/morphit.config.env (2 applied, 1 skipped — env wins)
[operator-config] skipped (already in env): MORPHIT_INDEXER_BLURT_PRICE_USD
```

The `skipped` list is the key signal: if you edited a
value but it didn't take effect, it's because the OS env
already had it set. Either remove the env-var setting (in
SystemD/Docker) or accept that the env wins.

If the file is missing entirely:

```
[operator-config] no morphit.config.env found — using OS environment only
```

This is fine — it's the expected output for env-var-only
deployments.

### Adding new keys to the allowlist

Every key in the file is checked against an allowlist in
`packages/operator-config/src/index.ts`. Adding a new key
requires editing that allowlist (and the
`morphit.config.env.example` template, and this section
of the runbook). The deliberate friction is the point —
each new operator-tunable lever is a new responsibility
to document and a new federation-uniformity question to
think about. Keep the surface small.



```sh
# Service control (systemd)
sudo systemctl status morphit-relay.service
sudo systemctl restart morphit-relay.service
sudo journalctl -u morphit-relay.service -f

# Relay log grep (structured logger — module prefix in brackets)
sudo journalctl -u morphit-relay.service | grep '\[relay-drainer\]'
sudo journalctl -u morphit-indexer.service | grep '\[witness-fee\]'

# JSON log mode (set MORPHIT_LOG_FORMAT=json in the service unit
# if you want to pipe logs into loki/vector/etc)
# sudo journalctl -u morphit-indexer.service | jq 'select(.module=="witness-fee")'

# On-chain checks
# open blocks.blurtwallet.com in browser; search for @morphit-relay

# Queue peek
psql "$MORPHIT_INDEXER_DATABASE_URL" -c "
    SELECT kind, recipient, amount_blurt, reason, error_count, broadcast_at
      FROM relay_pending_transfers
     ORDER BY created_at DESC
     LIMIT 20;"

# Mint ACTs
cd /opt/morphit/apps/relay && npm run mint-acts -- 25

# Live price source status
curl -s http://localhost:PORT/v1/health?verbose=1 | jq .diagnostics.price

# Finding I — check attestor eligibility for an account
curl -s "http://localhost:PORT/v1/attestor-eligibility/<account>" | jq

# Finding I — count accounts eligible to attest under 'steady' phase
# (for planning the launch → steady transition)
psql "$MORPHIT_INDEXER_DATABASE_URL" -c \
  "SELECT COUNT(*) AS eligible_for_steady
     FROM accounts a
     LEFT JOIN account_loyalty al ON al.account = a.name
    WHERE a.created_block_time <= NOW() - INTERVAL '30 days'
      AND COALESCE(al.cumulative_blurt_paid, 0) >= 100;"

# Finding H layer-2 — check if a chat pair is admitted
curl -s "http://localhost:PORT/v1/chat-admission/<me>/<peer>" | jq

# Finding H layer-2 — count stranger-fee payments collected
# (useful for tracking spam-prevention revenue + abuse patterns)
psql "$MORPHIT_INDEXER_DATABASE_URL" -c \
  "SELECT COUNT(*) AS fee_payments,
          SUM(amount_blurt)::text AS total_blurt,
          MIN(paid_at) AS first_payment,
          MAX(paid_at) AS most_recent
     FROM stranger_fees;"

# Fee-status filter regression guard (run in CI or pre-deploy)
cd /opt/morphit/apps/indexer && npx tsx scripts/fee-status-filter-lint.ts
```

---

## 24. HTTP/2 deployment requirement (Phase F.5 cross-page trade events)

**Bottom line:** terminate TLS with HTTP/2 (or HTTP/3) enabled. The
cross-page trade-event listener won't work reliably under HTTP/1.1.

### Why

Phase F.5 introduced a global SSE listener that opens one chat
stream per recent peer.  Under HTTP/1.1, browsers limit
concurrent connections to **6 per origin**.  Each open SSE stream
holds one of those slots for its lifetime.  Beyond the limit,
new streams queue indefinitely — the user's badge stays at
"Payment pending" forever even after the buyer's funds-sent
message reaches the indexer.

The Phase F.5 audit fix (F-21) caps the listener to **5**
concurrent streams.  This leaves 1 connection slot free under
HTTP/1.1 for ad-hoc requests (profile fetches, stream
reconnects, image loads).  But if you're running HTTP/2, the
practical limit is 100+ streams over a single TCP connection,
and the cap is a soft optimization rather than a hard
requirement.

### How to verify

From a browser DevTools network tab on your deployment:

1. Load `/orderbook` or `/my/orders` while logged in
2. Inspect any SSE request (`/v1/chat/.../events/stream`)
3. **Protocol** column should show `h2` or `h3`, not `http/1.1`

From the command line:

```bash
curl -I --http2 https://your-instance.example/orderbook | head -1
# Should print: HTTP/2 200
```

### How to enable on nginx

```nginx
server {
    listen 443 ssl http2;          # ← http2 keyword
    listen [::]:443 ssl http2;
    # ... rest of config
}
```

For HTTP/3 (optional, recommended if your nginx supports it):

```nginx
server {
    listen 443 quic reuseport;
    listen 443 ssl;
    http2 on;
    http3 on;
    add_header Alt-Svc 'h3=":443"; ma=86400';
    # ...
}
```

### How to enable on Caddy

Caddy enables HTTP/2 by default for HTTPS sites.  Nothing to
configure.  Verify with `curl -I --http2`.

### Symptoms of HTTP/1.1 deployment

- /my/orders badges stuck at "Payment pending" indefinitely
  even though the chat page shows the funds-sent message
- Browser DevTools shows multiple SSE requests in `pending`
  state for several minutes
- Network panel shows >6 simultaneous requests blocking each
  other

If the user complains "I never see paid trades update on
/my/orders," check HTTP/2 first.

### Why not raise the cap to 20?

HTTP/2 multiplexing makes the cap mostly cosmetic — under
HTTP/2 you could safely run 20 streams.  But the listener
also has a CPU and memory cost (one EventSource per peer
+ decryption work on every message).  5 is a comfortable
default that covers active conversations and keeps the
listener's cost bounded.  Operators who want to raise it
can patch `MAX_LISTENER_STREAMS` in
`apps/web/src/lib/trades/tradeEventListener.ts`.


## 25. Going live — staging procedure + chain-switch

For pre-launch staging and the procedure to wipe-and-switch
to mainnet for real, see [`SWITCHING-NETWORKS.md`](SWITCHING-NETWORKS.md).

It walks through staging-on-mainnet (the recommended
pre-launch testing pattern) followed by a destructive
wipe-the-DB-and-switch-to-production procedure for the
launch transition.  Roughly 30 minutes for the staging
setup + 15 minutes for the launch switch.

Headline guidance:

- **Staging-on-mainnet is the recommended pre-launch
  pattern.**  Run a second Morphit instance with a separate
  Blurt account, separate Postgres database, separate config
  directory.  Same chain as production, isolated identity.
  This catches Postgres permissions, systemd setup, Caddy
  config, federation discovery, and the wizard end-to-end —
  everything a sysadmin shakedown actually needs.

- **The chain_id pin is a feature, not a bug.**  The indexer
  refuses to boot if its config's `MORPHIT_INDEXER_CHAIN_ID`
  differs from the value recorded in the `indexer_state`
  table.  This prevents accidental cross-chain corruption.
  To switch chains you MUST drop and recreate the database —
  there's no in-place switch.

- **Staging-and-production-on-mainnet is the same chain.**
  No chain-id change is needed when "switching" from staging
  to production in the recommended pattern; you just drop
  the staging DB, create a fresh production DB, and re-run
  the wizard with production credentials.  The wizard ships
  mainnet chain_id by default for both.

- **A community-maintained Blurt testnet exists** at
  `https://testnet-rpc.beblurt.com` but Morphit can't talk
  to it without code changes (mainnet asset symbol and
  address prefix are hardcoded in ~7 places).  Tracked in
  REVISIT-LIST §D as a deferred capability; not a pre-launch
  blocker.  See SWITCHING-NETWORKS.md appendix for context.

The full procedure including separate Postgres roles, separate
systemd units, archived configs for rollback safety, and
post-launch smoke testing is in `SWITCHING-NETWORKS.md`.

## 26. Release signing (SHA-256 + GPG)

When you publish a Morphit release tarball, sign it.  Users
verifying their downloads against tampering need an
authoritative source-of-truth, and your signing key
fingerprint is that source-of-truth.

### How it works

The script `scripts/release-sign.sh` produces:

- `morphit-v$VERSION-source.tar.gz` — the source release
- `*.sha256` and `*.sha512` files — independent hash records
- `*.asc` — detached ASCII-armored GPG signature on the tarball
- `CHECKSUMS` — one-file manifest combining the SHAs
- `CHECKSUMS.asc` — detached signature on the CHECKSUMS file

A user can verify with:

```sh
sha256sum -c morphit-v1.2.3-source.tar.gz.sha256
gpg --verify CHECKSUMS.asc CHECKSUMS
```

### Operator workflow

1. **Tag the release in git.**  Use semver: `git tag v1.2.3`.
2. **Run the signing script.**
   ```sh
   ./scripts/release-sign.sh
   ```
   The script reads the version from `package.json` (or
   accepts `./scripts/release-sign.sh v1.2.3` as override).
3. **Verify the artifact yourself before publishing.**
   ```sh
   cd release
   sha256sum -c morphit-v1.2.3-source.tar.gz.sha256
   gpg --verify morphit-v1.2.3-source.tar.gz.asc \
                morphit-v1.2.3-source.tar.gz
   ```
4. **Upload to forgejo's releases page.**  Drop all five
   files (tarball + .sha256 + .sha512 + .asc + CHECKSUMS +
   CHECKSUMS.asc) into the Forgejo release UI.
5. **Broadcast a `morphit_release_v1` op on the Blurt chain.**
   This puts the SHA-256 on-chain so the frontend can verify
   served bundles against it.  See
   `apps/indexer/src/indexer/handlers/release.ts` for the op
   shape.

### Setting up the GPG key

If you don't have a project signing key yet:

```sh
gpg --quick-generate-key "Morphit Releases <releases@your-instance>" rsa4096 sign 2y
gpg --list-secret-keys --keyid-format=long
```

Note the long key ID (16-char hex).  Set it as the default
for the release script:

```sh
export MORPHIT_GPG_KEY=<your-key-id>
./scripts/release-sign.sh
```

Then **publish the public key** somewhere durable — your
forgejo profile, a keyserver (`gpg --send-keys <id>` to
keyserver.ubuntu.com), and the Morphit `/security` page.
Users compare against THIS fingerprint to know they're
verifying the right key.

### Why both SHA-256 and GPG?

SHA-256 alone tells the user the file matches a published
hash.  GPG additionally tells them WHO published the hash
(provided they trust the key).

If your GPG key is compromised, an attacker can only sign
new bad releases — past releases verified against archived
hashes (e.g. on the Blurt chain via `morphit_release_v1`)
remain valid.  Publishing the SHA-256 on-chain at release
time creates a tamper-evident timestamp.

### What gets signed at the chain layer too

The frontend bundle (apps/web/build/) has its own per-file
SHA-256 manifest at `verify.json`, generated post-build by
`scripts/build-verify-json.mjs`.  The whole manifest is then
referenced by a `morphit_release_v1` chain op signed by the
project's posting key.  See
`apps/indexer/src/indexer/handlers/release.ts` for the
chain-side handler.

This means there are TWO independent verification paths:

1. **Source release**: GPG signature on the tarball/CHECKSUMS
2. **Frontend bundle**: chain-published manifest hash

Both should match.  If they don't, something's off — escalate.

## 27. Fees and rewards reference

The complete fee schedule, reward triggers, and operator
economics are in [`FEES-AND-REWARDS.md`](FEES-AND-REWARDS.md).

That document is the **single source of truth** with line-
number references back to the source code that defines each
figure.  If you're answering "how much does X cost" or "what
does the welcome bonus actually pay out", quote that doc, not
chat history or older copies of this runbook.

Headline numbers (for context — full breakdown in the doc):

- **Listing fee:** 60 BLURT per order (~$0.12), tunable via
  `MORPHIT_INDEXER_FEE_BASE_BLURT`.
- **Stranger fee:** 5 BLURT for cold messages, escalates with abuse.
- **Featured-slot bid:** 50 BLURT/hour, ≥6 hours minimum.
- **Account-creation cost:** ~100 BLURT per signup (operator's
  biggest expense — paid by the relay account to the chain;
  user signs up free).
- **Welcome bonus:** 10 BLURT liquid + 10 BLURT Power on first
  completed trade.
- **Loyalty:** up to 1,260 BP delegated as cumulative fees
  cross 100/500/2,000/10,000 BLURT thresholds.
- **Operator earnings:** 90% of BLURT-paid listing fees,
  immediate per-order payout (FEES-AND-REWARDS.md "How
  listing fees split" section). Treasury keeps 100% of
  BTC/XMR-paid fees; the BLURT/treasury asymmetry is
  structural, not greed.

The `fee-reward-copy-consistency-smoke` runs in the smoke
suite to detect drift between the source code and the
user-facing copy.  If you change a fee or reward in the code,
the smoke will fail until you update FEES-AND-REWARDS.md and
the relevant FAQ entries to match.

---

## 28. Operator-payout monitoring

If you've registered as an operator and wired
`MORPHIT_INSTANCE_OPERATOR_TAG` (see RUN-A-MORPHIT-NODE.md
Section 9.2), the indexer will start crediting your account
90% of every BLURT-paid listing fee that comes through orders
posted on your frontend. Payout is immediate per-order — see
RUN-A-MORPHIT-NODE.md Section 9.3 for the full mechanics.

### Verifying earnings are flowing

```
curl -s http://localhost:8080/v1/operators/yourtag | jq
```

Look for:
- `cumulative_blurt_earned` — should be > 0 if any BLURT-paid
  orders have been attributed to you.
- `total_orders_attributed` — count of orders that paid
  through your tag.
- `last_payout_at` — should be recent if traffic is flowing.

### When earnings should appear but don't

Walk this checklist in order:

1. **Did the order op even include your tag?** Inspect a
   recent order op on a chain explorer
   (https://blocks.blurtwallet.com or similar). The payload's
   `operator_tag` field must match your registered tag
   exactly. If missing, your frontend isn't sending it —
   check `MORPHIT_INSTANCE_OPERATOR_TAG` in
   `ops/env/indexer.env` and confirm the indexer was
   restarted after the env change.

2. **Is your tag in the operators table?**
   ```
   docker-compose exec postgres psql -U morphit_indexer -c \
     "SELECT account, tag, is_active FROM operators WHERE tag = 'yourtag';"
   ```
   If 0 rows, the on-chain registration didn't land or
   didn't index. Re-check the registration op's status.

3. **Was the order's BLURT fee actually verified?**
   Attribution only fires for `fee_status='verified'` orders.
   Orders paid in BTC or XMR don't trigger attribution at
   all (treasury keeps 100% of those — see FEES-AND-REWARDS).
   ```
   docker-compose exec postgres psql -U morphit_indexer -c \
     "SELECT permlink, fee_method, fee_status FROM orders \
      WHERE account = 'orderposter' ORDER BY created_at DESC LIMIT 5;"
   ```

4. **Did the attribution event get recorded?**
   ```
   docker-compose exec postgres psql -U morphit_indexer -c \
     "SELECT * FROM operator_attribution_events \
      WHERE operator_tag = 'yourtag' \
      ORDER BY observed_at DESC LIMIT 5;"
   ```
   If rows exist but no payout, jump to step 6.

5. **Is the payout audit row there?**
   ```
   docker-compose exec postgres psql -U morphit_indexer -c \
     "SELECT * FROM operator_payouts \
      WHERE operator_account = 'youraccount' \
      ORDER BY queued_at DESC LIMIT 5;"
   ```

6. **Did the relay actually broadcast?**
   ```
   docker-compose exec postgres psql -U morphit_indexer -c \
     "SELECT id, recipient, amount_blurt, broadcast_at, last_error \
      FROM relay_pending_transfers \
      WHERE reason LIKE 'operator_payout:%' \
      ORDER BY id DESC LIMIT 10;"
   ```
   `broadcast_at` should be non-null within seconds of
   `created_at`. If `last_error` is set, the relay couldn't
   reach the chain or the operator's account doesn't exist.
   Cross-reference with the relay logs.

### Edge cases to know about

**Sub-precision shares don't get queued.** If a single order's
fee is so small that 90% rounds to 0 BLURT (e.g. a 0.001-BLURT
fee, which 90% × floor → 0 milliBLURT), no transfer is queued
but the attribution event row is still recorded for audit
completeness. In practice this only happens at fee values
much smaller than realistic listing fees.

**Operator deactivation.** If `operators.is_active = FALSE`
for your row (a future moderation feature; not currently
controllable via CLI), new attributions skip you silently.
Earnings already paid stay paid; the immediate-payout model
means there's no pending balance to lose.

**Treasury self-dealing.** If a hostile user lists orders
through your instance with a different operator's tag in the
op, that other operator gets the 90%. The 10% to treasury is
unaffected. There's no way for your indexer alone to detect
this — it's a frontend-trust issue, mitigated by the public
audit trail (`operator_attribution_events.operator_tag` shows
which tag was actually credited per order).

## 29. Running a second instance — DO NOT share relay accounts

A natural question from operators considering running a
second instance (different domain, different VPS, different
host): "Can I just reuse my existing `@my-relay` and
`@my-fees` accounts, point both deployments at them, and
run two frontends in parallel?"

**Short answer: NO.** The chain itself doesn't reject the
attempt, but the two relays will conflict in ways that
silently corrupt user signups, cause double-spends on the
welcome-bonus drainer, and halve your abuse defenses.
This applies whether the "second instance" is a competing
brand or just a backup deployment — running two relays
signing with the same active key concurrently is broken.

### Why it breaks

**Drainer-queue double-spend.**  When a user X signs up via
Instance A and later completes their first trade, Instance
A's indexer atomically flips X's `first_trade_complete_at`
in A's Postgres and queues two `relay_pending_transfers`
rows for the welcome bonus (10 BLURT liquid + 10 BLURT
vesting).  Instance B's indexer, watching the same chain,
sees the same feedback op and atomically flips X's
`first_trade_complete_at` in B's Postgres (different
database, different guard, no cross-instance coordination)
and queues another two transfers in B's queue.  Now
**both** drainers, both signing as `@my-relay`, broadcast
their transfers.  The chain accepts both — they're
distinct transactions.  User X walks away with 20 BLURT
liquid + 20 BLURT vesting instead of 10 + 10.  Multiplied
across thousands of first-time traders, this drains the
relay account twice as fast as it should.

**Same problem on every other queued payout.**  The
welcome-bonus case above is just one example — the same
double-broadcast pattern applies to **every** transfer
the drainer queues: loyalty milestone BP delegations,
operator-payout splits (see §28), waiver bonuses, the
1-BLURT auto-refill dust.  Every single one of these
will fire from both relays independently because each
indexer's queue is local.  The chain is happy to accept
duplicate-payload transfers as long as the trx hashes
differ (different block refs make them differ
trivially), so there's no chain-level protection.

**Concurrent transaction signing race on retries.**  Blurt
uses TaPoS (transactions-as-proof-of-stake): every signed
op carries a `ref_block_num` / `ref_block_prefix` plus an
expiration window (default ~60 s).  Independent ops from
each relay land fine.  But on **retries** of the same op
(transient RPC failure, exponential backoff), if both
relays happen to sign the same operation with the same
ref-block, the chain rejects the second as a duplicate
trx hash — and the relay that retried thinks the signup
or transfer failed even though it already landed.  The
user sees "signup failed" while the account exists on
chain.  Hard to debug, easy to repeat, no telemetry to
catch it.

**Halved abuse defenses.**  The daily signup ceiling
(`max_signups_per_day`), per-IP invite-token spacing,
and Altcha PoW challenge counters all live in each
instance's own Postgres.  Two instances sharing a relay
account means an attacker gets two independent budget
pools — you've doubled your daily Sybil cap without
realizing it.

**Fee collection (the read-only side) is fine.**
`@my-fees` only RECEIVES transfers from users posting
orders; it never signs anything from the relay.  Two
indexers reading the same fee account's incoming transfer
stream is harmless — they're both observing the chain,
not writing to it.

### What to do instead

If you want to run a second instance:

1. **Generate fresh accounts for the second relay.**  Use
   `@my-relay-2` (active key separate from the first), and
   either share `@my-fees` (if you want one treasury for
   both deployments) or use `@my-fees-2`.
2. Each instance gets its own Postgres database, its own
   federation registration (`morphit_operator_register_v1`
   with a distinct operator tag), its own setup wizard
   run.
3. Both indexers read the same chain, so the orderbook is
   federated automatically — that's the design.

If you want a hot-standby DR setup (one relay live, one
ready to take over if the first dies), the standard
pattern is **shared Postgres + active/passive relay
processes** with a leader-election lock, NOT two
independently signing relays.  That's an unbuilt feature
on the backlog — for now, plan for restore-from-backup
rather than live failover.

## 30. Postgres provisioning — the password sentinel and the init script

The repo ships `ops/postgres/init.sql` to provision the
`morphit_indexer` Postgres role and database with the
correct privileges.  It is **opinionated about passwords**:
the script reads the password from the
`MORPHIT_INDEXER_DB_PASSWORD` environment variable and
refuses to run if the variable is unset, empty, or set to
one of the well-known placeholder strings that have
appeared in this repo's example `.env` files.

The reject list (kept in sync between the SQL script, the
indexer's Zod config, the relay's Zod config, and the
`db-password-placeholder-smoke`):

- `CHANGEME`
- `CHANGE_ME`
- `CHANGE_ME_BEFORE_PRODUCTION`
- `__SET_BEFORE_DEPLOY__`
- `password`
- `postgres`

This catches the most common pre-launch mistake: copying
`ops/env/indexer.env.example` to `ops/env/indexer.env`
without editing the password line.  Boot of either the
indexer or the relay will refuse to proceed if any of
these strings appear in the password component of the
DATABASE_URL.

### Provisioning procedure

```
# 1. Pick a strong password — at least 32 chars, mixed
#    classes, generated by `openssl rand -base64 32` or
#    similar.  Record it in your password manager.
export MORPHIT_INDEXER_DB_PASSWORD='<generated>'

# 2. Run the init script as the postgres superuser. The -E
#    flag preserves your env var across the sudo boundary.
sudo -E -u postgres psql -f ops/postgres/init.sql

# 3. Construct the DATABASE_URL with that password and
#    write it into ops/env/indexer.env and ops/env/relay.env:
echo "MORPHIT_INDEXER_DATABASE_URL=postgresql://morphit_indexer:${MORPHIT_INDEXER_DB_PASSWORD}@localhost:5432/morphit_indexer" \
    >> ops/env/indexer.env

# 4. Unset the env var so the password isn't sitting in
#    your shell history or process environment.
unset MORPHIT_INDEXER_DB_PASSWORD

# 5. chmod 0600 the env files.
chmod 0600 ops/env/indexer.env ops/env/relay.env
```

### What the script does

1. **Reads `MORPHIT_INDEXER_DB_PASSWORD` from the env**
   via `\getenv`. Defaults the psql variable to empty
   string so an unset env var falls through to the same
   reject branch as an empty value (clean exit code, no
   `\quit`-without-status footgun).
2. **Rejects empty / placeholder values via a `DO` block**
   that calls `RAISE EXCEPTION` with a human-readable
   message. Exit code is 3 (psql's standard "SQL error")
   so automated runners can detect failure.
3. **Creates the `morphit_indexer` role** with the
   provided password.
4. **Creates the `morphit_indexer` database** owned by
   that role, encoded UTF-8, locale `en_US.UTF-8`.
5. **Locks down the role**: `NOSUPERUSER NOCREATEDB
   NOCREATEROLE`. The role owns its own database so it
   can run migrations, but cannot create other databases
   or roles.
6. **Resets the session GUC** so the password doesn't
   linger in the connection.

### Runtime guardrails

The same reject list is enforced at boot time:

- `apps/indexer/src/config/index.ts` Zod schema refuses
  to accept a `MORPHIT_INDEXER_DATABASE_URL` whose
  password component is one of the placeholders.
- `apps/relay/src/config/index.ts` enforces the same
  refinement on `MORPHIT_RELAY_DATABASE_URL`.

If you forget to edit the example file, the indexer or
relay will fail at startup with a clear error message
instead of running on a guessable password. CI also
catches re-introduction of any placeholder string in
tracked source via the `db-password-placeholder-smoke`.

### Rotating the password later

The same procedure works for rotation. The role already
exists, so use `ALTER ROLE` instead of `CREATE ROLE`:

```
sudo -u postgres psql -c "ALTER ROLE morphit_indexer PASSWORD '<new-pw>';"
```

Then update the DATABASE_URL in both env files and
restart indexer + relay. The Zod schemas re-validate at
boot — there's no in-memory cached connection string.

---

## 31. Daily DB backup automation

Promoted from a copy-paste recipe in `docs/RUN-A-MORPHIT-NODE.md` to a first-class wizard step in Audit Part 32 (2026-05-04). The shipped files:

```
ops/backup/morphit-backup.sh      # the script (shipped, generic)
ops/backup/backup.env.example     # config template
ops/systemd/morphit-backup.service  # systemd oneshot service
ops/systemd/morphit-backup.timer    # daily at 04:00 local
```

### Verifying backups ran (status dashboard)

`morphit-ops status` (main-menu item #10, "Status dashboard") ends with a **Backups** section that lists the backup directory and the **3 most recent** backup files — each with its age and size — so you can confirm at a glance that the timer is actually producing backups. It resolves the directory from `MORPHIT_BACKUP_DIR`, else `BACKUP_DIR` in `/etc/morphit/backup.env`, else the default `/home/morphit/backups`. The section prints the on-disk path so you can copy a file off the host (e.g. `scp`) to download it or hand it to a developer. It is read-only — it never creates, deletes, or rotates backups; rotation stays the timer's job. (`--json` includes the same data under a `backups` key for scripting.)

### Wizard flow

`morphit-ops init` step 16 asks: "Enable daily DB backup automation?" — default **Yes**. If yes, also asks for:

- Backup directory (default `/home/morphit/backups`)
- Retention days (default 30)

The wizard writes `ops/backup/backup.env` to the repo with operator-specific values (the script and systemd units are static and stay generic). The post-install summary prints these install commands:

```
sudo install -m 600 -o root -g root ops/backup/backup.env /etc/morphit/backup.env
sudo install -d -m 755 /usr/local/lib/morphit
sudo install -m 755 ops/backup/morphit-backup.sh /usr/local/lib/morphit/
sudo install -m 644 ops/systemd/morphit-backup.service /etc/systemd/system/
sudo install -m 644 ops/systemd/morphit-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-backup.timer
```

The script is installed to `/usr/local/lib/morphit/morphit-backup.sh` (NOT executed in-place from the repo). This decouples the systemd unit from the operator's repo location: the unit's `ExecStart` is hardcoded to the stable system path, so it works regardless of whether the repo is at `/home/morphit/morphit`, `/opt/morphit`, or anywhere else. When `git pull` brings in script changes, the operator re-runs just the `sudo install -m 755 ops/backup/morphit-backup.sh ...` command.

### Why systemd timer (not cron)

- Failures land in `journalctl -u morphit-backup.service` alongside Morphit's other service logs.
- `Persistent=true` means a missed run (laptop suspended at 04:00, server rebooting) fires when the timer is next active — daily-ish becomes daily.
- `RandomizedDelaySec=30m` smears wakeup across operators in a fleet, so a coordinated 04:00:00 hammer doesn't hit Blurt RPCs simultaneously (the indexer might be mid-poll when the dump starts).
- `OnFailure=` directives can email or page on a failed backup (operator wires this to their existing alert chain).

### Why backup.env lives in /etc, not the repo

The systemd service runs as the `morphit` system user with hardening directives (`ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges=true`). For a service like that, the operator config file at `/etc/morphit/backup.env` is the standard pattern:

- Root-owned 600, so a compromised application user can't tamper with the backup target dir.
- Survives a `git pull` (the wizard writes to the repo, but the deployed copy lives outside).
- Operator can change retention days or backup dir without touching the repo or restarting anything — the script reads the env file at the start of each run.

The wizard does not write to `/etc` directly because it runs as the operator user (no sudo). It writes to the repo path, prints the install commands above, and the operator runs those once.

### Verifying

```
systemctl list-timers morphit-backup.timer
journalctl -u morphit-backup.service --since '1 day ago'
ls -lh /home/morphit/backups
```

If the most recent backup is older than 26 hours, something's wrong — start with `journalctl -u morphit-backup.service -e` to see the last failure.

### Quarterly restore drill

A backup that's never been tested isn't a backup. Once a quarter, restore the most recent backup to a throwaway database and diff the orderbook count against production:

```
createdb morphit_indexer_test
gunzip < /home/morphit/backups/morphit-YYYYMMDD-HHMMSS.sql.gz | psql morphit_indexer_test
psql morphit_indexer_test -c "SELECT COUNT(*) FROM orders WHERE expired = false"
psql morphit_indexer      -c "SELECT COUNT(*) FROM orders WHERE expired = false"
dropdb morphit_indexer_test
```

The two counts should be within ±1 (some orders may have expired between the snapshot and "now"). If they differ by more than that, your backups aren't capturing complete state — investigate before trusting the backups for real recovery.

### Off-server replication

The local timer keeps a 30-day rolling backup. If the server burns down, you lose those too. See `docs/RUN-A-MORPHIT-NODE.md §10` for rsync / rclone / S3 recipes. The simplest add-on cron runs 30 minutes after the dump, giving the .partial file time to land:

```
30 4 * * * rsync -az --delete /home/morphit/backups/ user@backup-host:/path/to/morphit/
```

### What this does NOT cover

- The posting key (`apps/relay/keystore.{wif,json}`) — back up separately, see §9 "Paper-key backup protocol" for the secure off-server pattern.
- Encryption at rest of the backup directory itself — operator's choice (filesystem-level LUKS on the backup partition is the simplest pattern).
- Verifying that the off-server copy is intact — rsync's `--checksum` or rclone's `verify` should be added to the off-server cron if losing both copies would be catastrophic.

---

## 32. BunkerWeb — recommended WAF / reverse-proxy hardening

[BunkerWeb](https://www.bunkerweb.io) is an open-source AGPLv3-licensed reverse proxy with built-in Web Application Firewall (WAF) features. Same license as Morphit; no licensing concern. **Recommended for any public-facing Morphit instance** — the morphit repo ships a canonical, tested-shape BunkerWeb deployment at `ops/bunkerweb/` (paralleling `ops/nginx/`, `ops/systemd/`, etc.).  Copy + edit + `docker compose up -d` and you have a WAF-fronted instance with OWASP CRS at paranoia 3, anti-`Referer: none` on the invite endpoint, real-IP forwarding wired correctly to the relay's trusted-proxy chain, and a fixed Docker network CIDR (`172.20.0.0/16`) you can hard-code into `MORPHIT_RELAY_TRUSTED_PROXY_IPS` without re-inspecting after rebuilds.

The Ansible playbook's `bunkerweb` role deploys this directory verbatim.  Operators not using Ansible follow the Quick Start in `ops/bunkerweb/README.md`.

> **Checking it's actually up:** `morphit-ops bunkerweb` (or the "Web firewall (BunkerWeb) status" menu item) reports whether the `bunkerweb` and `bunkerweb-scheduler` containers are running and healthy, and prints the bring-up commands if they aren't. It's read-only — it never runs `docker compose` for you (bringing the stack up is a hands-on step you run and review). BunkerWeb's Docker images are pulled from BunkerWeb's own registry; Morphit ships only the config, not the images.

Reasons you might NOT want BunkerWeb:

- **Small private instance with a single-operator audience** — the added complexity isn't worth the marginal defense.
- **Tor-only or Lokinet-only deployment** — squatters typically don't route through anonymity networks; the .onion path has natural friction (§38.6 item a) and adding a WAF in front of an onion service complicates the routing.
- **Resource-constrained VPS** (<1 GB RAM) — BunkerWeb + scheduler containers add ~150–250 MB resident.

For everyone else, deploy it. Reasons it's the default recommendation:

- OWASP-Top-10 protection out of the box (SQL injection, XSS, path traversal, etc.) without writing nginx ModSecurity rules.
- Curated bot lists + behavioral detection layered on top of basic User-Agent blocking.
- Per-country / per-AS rate limiting in addition to per-IP.
- Built-in GeoIP, slow-loris guards, connection-rate limits.
- Single dashboard for HTTPS certs, request rate limits, country blocking, and OWASP rule tuning.

### What BunkerWeb adds on top of Caddy/nginx

| Feature | Caddy / nginx alone | BunkerWeb |
|---|---|---|
| HTTPS auto-renewal | Caddy yes; nginx via certbot | yes (built-in) |
| OWASP Top-10 rules | nginx via ModSecurity (manual config); Caddy via plugins | built-in |
| Bot detection | basic User-Agent blocking | curated bot lists + behavioral |
| Rate limiting | per-IP, per-route | per-IP, per-route, per-country, per-AS |
| GeoIP / country blocking | manual | built-in |
| DDoS mitigation | per-IP rate limit only | per-IP + connection-rate + slow-loris + body-size guards |
| Web UI | none | yes |

Each layer is additive to Morphit's own defenses (signup-drain stack §18, indexer abuse mitigation, etc.). BunkerWeb does NOT replace any of those — it's a perimeter shield that catches generic web attacks before they reach the Morphit stack at all.

### Architecture choice

**Option A — BunkerWeb instead of Caddy.** Simplest; BunkerWeb terminates TLS and proxies to the indexer/relay/web on localhost. Use this if you're starting fresh.

**Option B — BunkerWeb in front of Caddy.** Use if you're already running Caddy and want to add WAF without changing the existing config. Slightly higher latency (~1-2ms per request from the second hop). Caddy listens on `127.0.0.1:8443`, BunkerWeb proxies to it from port 443.

### Linux install (Option A)

The official packages support Debian, Ubuntu, RHEL, Fedora. See https://docs.bunkerweb.io/latest/install for current install steps. After install, the configuration shape:

```yaml
# /etc/bunkerweb/variables.env (operator-tuned)
SERVER_NAME=morphit.example.com
USE_REVERSE_PROXY=yes
REVERSE_PROXY_URL=/
REVERSE_PROXY_HOST=http://127.0.0.1:3000  # the apps/web dev server, OR
                                          # the static-build path if served by nginx
AUTO_LETS_ENCRYPT=yes
EMAIL_LETS_ENCRYPT=you@example.com
USE_BLACKLIST=yes
USE_DNSBL=yes
USE_LIMIT_REQ=yes
LIMIT_REQ_RATE=10r/s
USE_BAD_BEHAVIOR=yes
USE_MODSECURITY=yes
MODSECURITY_CRS_VERSION=4
USE_ANTIBOT=auto    # serves a JS challenge to suspicious clients
```

Tune `LIMIT_REQ_RATE` for your traffic. Default `10r/s` is conservative — typical Morphit instances see a handful of orderbook fetches per second per browser, which fits.

### Docker install

If you're already running Morphit in Docker (see §33), BunkerWeb has an official `bunkerweb/bunkerweb` image. Compose snippet:

```yaml
services:
  bunkerweb:
    image: bunkerweb/bunkerweb:1.6
    ports:
      - "80:8080"
      - "443:8443"
    environment:
      SERVER_NAME: "morphit.example.com"
      USE_REVERSE_PROXY: "yes"
      REVERSE_PROXY_HOST: "http://web:3000"
      AUTO_LETS_ENCRYPT: "yes"
      EMAIL_LETS_ENCRYPT: "you@example.com"
      USE_BAD_BEHAVIOR: "yes"
      USE_MODSECURITY: "yes"
    depends_on:
      - web
```

### Tuning for Morphit specifically

Morphit serves three classes of traffic that need slightly different rules:

1. **Browser GET to /, /orderbook, /post**, etc. — normal web pages. Default ModSecurity + bot detection works.
2. **JSON API to /relay/v1/*, /indexer/v1/*** — rate limits should be MORE generous because a single browser may make 3-10 calls per second during normal use. Recommend `LIMIT_REQ_RATE=30r/s` and exclude these paths from the JS-challenge antibot (a JS challenge breaks JSON API calls).
3. **Server-Sent Events at /relay/v1/notifications** — long-lived connections. ModSecurity must NOT inspect the streaming response body (it'll buffer and break the SSE), and rate limiting must be by NEW connection, not by ongoing connection.

Sample BunkerWeb config carving these out (paste in `variables.env`):

```yaml
# Default rules: conservative for browser traffic
LIMIT_REQ_RATE=10r/s
USE_ANTIBOT=auto

# Per-URL overrides for the API + SSE
LIMIT_REQ_URL_1=/relay/v1
LIMIT_REQ_RATE_1=30r/s

LIMIT_REQ_URL_2=/indexer/v1
LIMIT_REQ_RATE_2=30r/s

ANTIBOT_IGNORE_URI=/relay/v1 /indexer/v1

# SSE: don't buffer the response body
USE_PROXY_BUFFERING_3=no
PROXY_BUFFERING_URL_3=/relay/v1/notifications
```

### What BunkerWeb does NOT do

- It does NOT prevent name-squatting on Blurt — that's the protocol's account-creation cost (~100 BLURT) plus Morphit's signup-drain stack (§18). Note that **the relay pays this cost**, not the attacker — every signup costs your relay ~100 BLURT regardless of who's behind it. BunkerWeb stops a *web bot* hitting `/v1/account/create` 1000 times a minute, but a determined attacker who's willing to burn through your relay's balance one signup at a time is, by design, allowed to create accounts up to the daily ceiling.
- It does NOT replace the operator-balance alert scanner (§16). A drain attack that's expensive enough to bypass rate limits will still hit that alarm.
- It does NOT replace `db-password-placeholder-smoke` (§30) or the rest of the static smoke suite.

### Where to monitor

```sh
journalctl -u bunkerweb.service -f
# Or via the web UI at https://your-host:7000 (if you enabled it)
```

`USE_REAL_IP=yes` is also worth setting — without it, all your indexer/relay logs show BunkerWeb's IP, not the user's, making downstream debugging harder.

### CRITICAL: trusted-proxy IPs for BunkerWeb deployments

Out of the box, the relay only trusts `X-Forwarded-For` headers from loopback addresses (`127.0.0.1`, `::1`). This is correct for the canonical single-host nginx topology where nginx and the relay run side-by-side and connect via loopback. **It is WRONG for BunkerWeb deployments** in several common topologies:

| Topology | Relay sees socket peer as | What happens without config |
|---|---|---|
| BunkerWeb in Docker compose alongside the relay | Docker bridge IP (e.g., `172.18.0.5`) | All signups from BunkerWeb users share ONE rate-limit bucket — one abuser exhausts the daily limit for everyone |
| BunkerWeb on a separate host from the relay | BunkerWeb's host IP (e.g., `10.0.0.5`) | Same — every user shares one bucket |
| BunkerWeb in front of nginx (Option B) on same host | Loopback (nginx is the trusted hop) | OK — nginx already trusted; X-Forwarded-For chain works |

To fix the Docker-compose case, set `MORPHIT_RELAY_TRUSTED_PROXY_IPS` to the Docker bridge CIDR.

**If you deploy the canonical morphit-shipped BunkerWeb compose** (`ops/bunkerweb/docker-compose.yml`, also deployed by the Ansible `bunkerweb` role), the CIDR is **PINNED at `172.20.0.0/16`** — set:

```
MORPHIT_RELAY_TRUSTED_PROXY_IPS=172.20.0.0/16
```

The Ansible playbook's group_vars default already sets this. The compose was deliberately pinned to `172.20.0.0/16` (instead of letting Docker auto-assign) precisely so this CIDR is stable and operators can hard-code it without re-inspecting after rebuilds.

**If you deploy your OWN compose** with a different network CIDR, the default Docker bridge networks are typically `172.17.0.0/16` (the default `bridge` network) and `172.18.0.0/16` through `172.31.0.0/16` for user-defined networks. To find YOUR bridge network's CIDR:

```sh
docker network inspect <your-compose-network> --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
# Example output: 172.18.0.0/16
```

Then set it in the relay's environment:

```ini
# /etc/morphit/relay.env (or your systemd Environment= directive)
MORPHIT_RELAY_TRUSTED_PROXY_IPS=172.18.0.0/16
```

For multi-host BunkerWeb (BunkerWeb on a separate machine):

```ini
# Pass the BunkerWeb host's actual IP, NOT a CIDR (the host
# is one fixed address, not a range)
MORPHIT_RELAY_TRUSTED_PROXY_IPS=10.0.0.5
```

For multiple proxies (e.g., BunkerWeb in Docker + a CDN in front of it):

```ini
# Comma-separated.  Each entry is either a bare IP or a CIDR.
MORPHIT_RELAY_TRUSTED_PROXY_IPS=172.18.0.0/16,10.0.0.5
```

**SECURITY WARNING.** This is the most dangerous knob in the relay's configuration. Setting it too broad — e.g., `0.0.0.0/0`, or a CIDR that covers more than your actual proxy — lets ANY remote client forge `X-Forwarded-For` to bypass per-IP rate limits and drain the relay's BLURT. Always pass the NARROWEST CIDR that covers your actual proxy. The relay logs `trusted_proxies_configured` at boot with the parsed exact-count and CIDR-count; verify it matches your expectation. Malformed entries (like a typo `172.18.0.0/3X`) are logged as `trusted_proxies_some_rejected` — an operator who sees that line in their boot log should fix their config immediately.

To verify the trust chain is working end-to-end after configuring, hit any rate-limited endpoint from two different real client IPs (your phone on cell + your laptop on Wi-Fi) and confirm the relay logs show DIFFERENT bucket keys per request. If both show the proxy's IP, the trust chain is broken.

### Compatibility with §37 server hardening

BunkerWeb interacts with several of §37's hardening directives. Check these before deploying both:

**§37.1 SSH hardening** — No conflict. BunkerWeb listens on 80/443; SSH is on 22. The two never touch the same port.

**§37.4 Mount hardening (`noexec` on /tmp).** If you run BunkerWeb in Docker, `noexec` on `/tmp` is fine because Docker's overlay filesystem isolates the container's `/tmp` from the host's. If you run BunkerWeb directly via `apt` package, BunkerWeb's nginx config-test step (`bw-cli` and ModSecurity rule compilation) may require executing scripts in `/tmp`. If `bw-cli` errors out citing permission-denied on /tmp scripts, temporarily remount /tmp executable for the upgrade window (see §37.4 for the procedure).

**§37.5 Systemd hardening.** BunkerWeb's official systemd unit ships with reasonable isolation defaults. If you've applied a custom `hardening.conf` drop-in to ALL services, audit BunkerWeb's drop-in too — `ProtectSystem=strict` is fine but `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` MUST allow `AF_NETLINK` if BunkerWeb's traffic-shaping plugin is loaded (it queries iptables via netlink).

**§37.13 Outbound egress allowlist.** BunkerWeb makes outbound connections to: Let's Encrypt (TCP 80 + 443), Maxmind GeoIP database updates (TCP 443), and DNSBL queries (TCP/UDP 53). If you applied the relay-host egress allowlist, those work. The BunkerWeb-bot-database refresh (`USE_BAD_BEHAVIOR=yes` enables a daily download from the BunkerWeb cloud) hits 443; also fine. If you see `geoip_update_failed` or `dnsbl_update_failed` in BunkerWeb logs, your egress policy is the likely culprit.

**§34 fail2ban.** Most fail2ban rules watch `/var/log/auth.log` (SSH) — no conflict. If you've added a Morphit-specific fail2ban rule that watches the relay's HTTP error log for `429`s, double-check the log format: BunkerWeb's nginx writes a different format than stock nginx. The simpler approach is to write fail2ban rules against BunkerWeb's own logs (`/var/log/bunkerweb/access.log` and `/var/log/bunkerweb/error.log`) which include the original client IP via `USE_REAL_IP=yes`.

**§37.8 Postgres hardening.** No interaction. BunkerWeb doesn't touch the Postgres port.

### Advanced WAF rule tuning for Morphit

BunkerWeb's default ModSecurity ruleset (CRS 4.x) catches OWASP Top-10 attacks. Morphit's signup endpoints have a few characteristics that benefit from tuning beyond the defaults:

**1. Whitelist the signup endpoint's request body.** Morphit's `/v1/account/create` body contains four base58-encoded BLT-prefixed public keys. CRS rule 920420 ("Request content type is not allowed") might false-positive on `application/json` bodies that look unusual to it. Add to BunkerWeb's variables.env:

```yaml
# Whitelist Morphit's signup endpoints from CRS rules that
# false-positive on legitimate signed-op payloads.
MODSECURITY_CRS_BLACKLIST_RULES=920420 921120 942100
# 920420 — content type whitelist (JSON acct-create body)
# 921120 — HTTP request smuggling (paranoid mode)
# 942100 — SQL injection regex (matches BLT-prefixed keys)
```

You can add per-URI whitelists rather than disabling rules globally:

```yaml
# Disable rules ONLY for /v1/account/create
MODSECURITY_CRS_REMOVE_RULES_BY_URI=^/v1/account/create$ 920420 921120 942100
```

**2. Tighten the rate limits for `/v1/account/invite` specifically.** The invite endpoint is where the real-money cost lives. BunkerWeb's per-URI rate limit can be MUCH tighter here than the default:

```yaml
# Default: 30/s for the JSON API surface
LIMIT_REQ_RATE=30r/s

# Per-URI override: invite endpoint specifically.  3/s is plenty
# for any real user (they call it once per signup).
LIMIT_REQ_URL_3=/v1/account/invite
LIMIT_REQ_RATE_3=3r/s
LIMIT_REQ_BURST_3=10
```

**3. Block known malicious IP ranges via the BunkerWeb blacklist.** If you've identified attacker /24s from previous incidents, add them:

```yaml
# Comma-separated IP / CIDR list of permanently-blocked sources
BLACKLIST_IP=203.0.113.0/24,198.51.100.50
```

**4. GeoIP-block from countries with disproportionate squatter activity.** This is operator's-call — Morphit is a global service, blocking entire countries denies access to legitimate users. But if you're in incident response and an attacker is concentrated in one CC, you can:

```yaml
USE_GEOIP=yes
BLACKLIST_COUNTRY=XX YY  # ISO-3166 alpha-2 codes
```

Reverse the policy if you want to RESTRICT to specific countries (rare for Morphit):

```yaml
USE_GEOIP=yes
WHITELIST_COUNTRY=US CA GB DE FR
```

**5. Per-AS rate limiting.** Cloudflare-tier defense. BunkerWeb supports per-ASN rate limits with the appropriate plugin; if you're seeing a coordinated drain from a single autonomous system (a cheap cloud provider's abuse-friendly hosting), you can rate-limit by AS rather than by IP:

```yaml
USE_LIMIT_REQ_BY_ASN=yes
LIMIT_REQ_BY_ASN_RATE=5r/m
```

Tune the rate to your traffic — too tight breaks legitimate users from large ISPs whose ASN you'd inadvertently throttle.

**6. Enable BunkerWeb's antibot challenge for `/v1/account/invite` only.** The default `USE_ANTIBOT=auto` covers everything, but the Morphit user flow is sensitive: a JS challenge during the invite step is fine because the browser is in "click-button" mode there, not in active API conversation. Don't enable antibot on `/v1/account/create` (the second-step submit) — by then the user has already solved Altcha and another challenge would be confusing.

```yaml
USE_ANTIBOT=auto
ANTIBOT_IGNORE_URI=/v1/account/create /relay/v1 /indexer/v1
```

**7. Bigger request-body limit ONLY for canary verification.** The canary endpoint at `/canary.txt` returns a few KB; defaults are fine. But if you ever serve large operator-disclosure documents (e.g., `/operator-disclosure.pdf`), bump `MAX_CLIENT_SIZE` to allow them:

```yaml
MAX_CLIENT_SIZE=10m
# For specific URIs:
MAX_CLIENT_SIZE_URL_1=/disclosures
MAX_CLIENT_SIZE_RATE_1=20m
```

### When to NOT add BunkerWeb

BunkerWeb is excellent for medium-traffic instances. It's overkill for:

- **A small private instance** (under ~50 daily signups). Caddy's built-in TLS + Morphit's own rate limits are sufficient.
- **Tor-only / I2P-only deployments.** Those run behind their respective network-layer protections; an additional WAF in front is mostly redundant and adds attack surface.
- **Resource-constrained VPS** (under 1GB RAM). BunkerWeb's nginx + ModSecurity + lua plugins use ~200-400MB resident; on a 1GB host that's a meaningful fraction of your headroom.

For those cases, stick with the Caddy-based default and tune Morphit's own §18 layers.

---

## 33. Docker deployment — optional alternative to bare-metal

The default install in `RUN-A-MORPHIT-NODE.md` is bare-metal: clone the repo, install Node.js, run `npm install`, run `systemctl enable` on the unit files. **That's the recommended path** for first-time operators because there's no extra abstraction layer to debug when something's wrong. This section is for operators who already use Docker for everything else and want consistency with their existing fleet.

### What Docker buys you

- **Consistent environment** — Node version, libsodium, Postgres client all pinned in the image.
- **Easier rollback** — `docker compose down && docker compose up -d --pull=always` swaps the running version without touching the host.
- **Isolation** — the indexer/relay run in containers; a compromise of those processes doesn't touch the host filesystem (with proper volume scoping).

### What Docker costs you

- **Slightly more complex backups** — the DB volume needs to be in your backup path, not just `/var/lib/postgresql`.
- **One more thing to keep updated** — the base image, in addition to the host OS and the Morphit code.
- **Networking hops** — adds 1-3 ms per request unless you use `network_mode: host`.

### Compose example

There's no `docker-compose.yml` shipped in the repo (deliberately — Docker is one of several deployment options, not the canonical one). Below is a tested-shape reference. Drop into the repo root or a sibling dir.

> **Caveat (2026-05-06 audit):** The `*_FILE` env-var-from-secret
> pattern shown below (`MORPHIT_INDEXER_DB_PASSWORD_FILE`,
> `MORPHIT_RELAY_DB_PASSWORD_FILE`, `MORPHIT_RELAY_KEYSTORE_PATH`,
> `MORPHIT_RELAY_PASSPHRASE_FILE`) is **not yet implemented** in
> the indexer or relay config loaders.  Today, those vars are
> ignored and the services read the password directly from
> `MORPHIT_INDEXER_DATABASE_URL` / `MORPHIT_RELAY_DATABASE_URL`.
>
> Until the `*_FILE` pattern lands, **inline credentials in the
> DATABASE_URL** for the Compose example to work — e.g.
> `postgres://morphit_indexer:<password>@postgres:5432/morphit_indexer`.
> Implementation tracked in REVISIT-LIST.

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: morphit_indexer
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
      POSTGRES_DB: morphit_indexer
    secrets:
      - db_password
    volumes:
      - pgdata:/var/lib/postgresql/data
      # Backup mount: the morphit-backup.sh script (§31) runs
      # ON THE HOST, but pg_dump connects via TCP to the
      # container.  Make sure the container's port 5432 is
      # bound to 127.0.0.1 only.
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U morphit_indexer"]
      interval: 10s
      timeout: 5s
      retries: 5

  indexer:
    build:
      context: .
      dockerfile: apps/indexer/Dockerfile
    restart: unless-stopped
    environment:
      MORPHIT_INDEXER_DATABASE_URL: "postgres://morphit_indexer@postgres:5432/morphit_indexer"
      MORPHIT_INDEXER_DB_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      # Indexer's loopback HTTP port — must match the
      # MORPHIT_INDEXER_LISTEN_PORT default of 8081.  nginx /
      # Caddy / BunkerWeb upstream points at 127.0.0.1:8081.
      - "127.0.0.1:8081:8081"

  relay:
    build:
      context: .
      dockerfile: apps/relay/Dockerfile
    restart: unless-stopped
    environment:
      MORPHIT_RELAY_DATABASE_URL: "postgres://morphit_indexer@postgres:5432/morphit_indexer"
      MORPHIT_RELAY_DB_PASSWORD_FILE: /run/secrets/db_password
      MORPHIT_RELAY_KEYSTORE_PATH: /run/secrets/relay_keystore
      MORPHIT_RELAY_PASSPHRASE_FILE: /run/secrets/relay_passphrase
    secrets:
      - db_password
      - relay_keystore
      - relay_passphrase
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      # Relay's loopback HTTP port — must match the
      # MORPHIT_RELAY_LISTEN_PORT default of 8080.
      - "127.0.0.1:8080:8080"

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"

secrets:
  db_password:
    file: ./secrets/db_password
  relay_keystore:
    file: ./apps/relay/keystore.json
  relay_passphrase:
    file: ./secrets/relay_passphrase

volumes:
  pgdata:
```

### Dockerfiles

The repo doesn't ship Dockerfiles (intentional — they're lightweight enough that operators who want them write them once for their fleet). A starter shape for `apps/relay/Dockerfile`:

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache postgresql-client
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/relay/package.json apps/relay/
COPY packages/*/package.json packages/*/
RUN npm ci --omit=dev
COPY . .
USER node
CMD ["npm", "start", "-w", "apps/relay"]
```

Same shape for `apps/indexer` and `apps/web` (the web one's CMD is `npm run start -w apps/web` after a build step).

### Backups in Docker

The `morphit-backup.sh` script from §31 still runs on the HOST, not inside a container. Update `backup.env`:

```sh
DB_NAME=morphit_indexer
DB_USER=morphit_indexer
PGHOST=127.0.0.1     # postgres container's port-mapped address
PGPORT=5432
```

Add `~/.pgpass` to the morphit system user's home with the same password as `secrets/db_password`. The systemd timer + service files are unchanged — they just connect via TCP instead of UNIX socket.

### What to NOT use Docker for

- **The wizard.** `morphit-ops init` is meant to run as the host operator user, write to the repo, and print sudo commands. Running it inside a container is a footgun (paths and permissions don't match the host's).
- **One-shot CLI commands** (`morphit-ops register`, the relay's `apps/relay/scripts/mint-acts.ts` script, etc.). Same reason.

These should run on the host with the same Node version your image uses, against the running container's exposed ports.

### Troubleshooting: a service won't start (use `morphit-ops doctor`)

When the indexer or relay exits immediately on start with a
configuration error — `config validation failed: … Required`,
`[operator-config] … not in the operator allowlist`, an empty/missing
key file, or a key-file permission complaint — the fastest path is
the read-only preflight:

```
cd /opt/morphit          # the install directory
npx morphit-ops doctor   # or: morphit-ops doctor, if symlinked onto PATH
```

What it does, and why it's trustworthy:

- It sources `morphit.env` exactly the way a real start does
  (`set -a; . morphit.env; set +a`) and runs each service's **own**
  config loader via an internal `--check-config` mode that loads
  config and exits. Because it uses the services' real loaders, its
  verdict cannot drift from what the services actually require.
- It reports `✓ will start` / `✗ will NOT start` per service, and for
  a failure it surfaces the validation lines (not a stack trace) plus
  the fix.
- It **mutates nothing** — no files, no database, no started
  services, no network calls. The relay check runs *before* the
  passphrase-unlock step, so it never prompts; instead it reports
  whether the active key is plaintext or an encrypted envelope (i.e.
  whether the relay will ask for a passphrase at real start).
- Exit code: `0` if both services validate, `1` if either fails, `2`
  if you're not in an install directory. `--json` emits a structured
  result for scripting.

This is the recommended first step before `systemctl start` on a
fresh install, and the first thing to reach for when a node that used
to boot suddenly won't after a config change. Note that `doctor`
validates *config*; it does not (and is not meant to) install or
start services or systemd units — that remains a manual/Ansible step.

`doctor` finishes with a read-only **security audit** (operator-only;
this is deliberately NOT exposed on the public `/v1/health` endpoint,
which would advertise a weak key to attackers). It reports:

- **Active-key encryption** — whether the relay key is an encrypted
  envelope (✓) or stored in **plaintext** (⚠, with the `morphit-ops
  edit-active-key` remediation). It detects this by reading only the
  first bytes of the key file to spot the envelope marker; it never
  prints key material. Reminder: encrypted keys are not auto-unlocked
  (by policy), so the relay needs a manual passphrase at each start.
- **Active-key file permissions** — ⚠ if group/other-readable (the
  relay also refuses to boot in that case).
- **Secret-file permissions** — ⚠ if `morphit.env` or
  `morphit.config.env` is group/other-readable; `morphit.env` holds
  the database password and is not permission-checked at boot, so
  this catches a real at-rest leak.

Security findings are **advisory** — they do not change doctor's exit
code (which reflects boot-readiness), but a hardened instance should
show all green here. `--json` includes a `security` array.

### Troubleshooting: `morphit-ops` says "command not found"

If `npx morphit-ops init` (or `register`, `edit`, `upgrade`) worked once and then stopped — or never worked on a fresh clone — there are two causes, in order of how often they bite:

**Cause 1 (most common): you're not in the repo directory, or `npm install` hasn't populated `node_modules` yet.**

`morphit-ops` is a workspace-local tool — it is *not* published to the public npm registry; it lives in this repo under `apps/ops-cli/`. `npx` finds it only when you run from **inside the Morphit repo** (it searches upward from your current directory for the workspace) **and** after `npm install` has populated `node_modules` at the repo root. If you run it from your home directory, from a subdirectory outside the repo, or from a fresh clone where you haven't installed yet, `npx` finds no local tool, falls through to the public registry, and you see something like:

```
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/morphit-ops - Not found
```

That E404 *is* the "command not found" — npx looked for a published package named `morphit-ops` (there is none — it's private to this repo).

The classic trap: yesterday you ran it from `~/morphit` and it worked; today after a `git pull` you happened to be in a different directory, or you're on a freshly-cloned second server where you haven't run `npm install` yet.

**Cause 2: the workspace bin symlink went stale.**

`npm install` creates a symlink at `node_modules/.bin/morphit-ops` pointing into the workspace. If a `git pull` changed `package.json` / `package-lock.json` / the workspace layout (this repo regenerates the lockfile at meaningful milestones), that symlink can be invalidated until you re-run `npm install`.

**Both causes have the same fix — run from the repo root, after installing:**

```
cd ~/morphit          # wherever you cloned it
npm install           # re-creates node_modules/.bin/morphit-ops
npx morphit-ops init  # now resolves the local bin
```

The rule: **re-run `npm install` after every `git pull`.** The repo's update procedure (§12 here and `RUN-A-MORPHIT-NODE.md §12`) already does this for `npm run build`; the same `npm install` is what restores the `morphit-ops` bin.

Two more things worth knowing:

- **Run it from inside the repo.** `npx` searches upward from your current directory for `node_modules/.bin`. If you `cd` somewhere outside the Morphit tree first, it won't find the local bin. Always run `morphit-ops` from the repo root.
- **It needs `tsx`.** The CLI runs from TypeScript source via `tsx`, which is a **production dependency** of `apps/ops-cli` (since cp161 — previously a devDependency, which broke the CLI under `NODE_ENV=production` or `npm install --omit=dev`). A plain `npm install` at the repo root installs it. If you deliberately install with `--omit=dev`, `tsx` is still present because it is a production dep.

If `npm install` doesn't fix it, you can bypass the symlink entirely and invoke the workspace directly:

```
npm exec --workspace apps/ops-cli morphit-ops -- init
```

or

```
cd apps/ops-cli && npm start -- init
```

Both run `tsx src/main.ts init` against the local source without relying on the root `node_modules/.bin` symlink.

**Ansible operators:** the playbook (`ops/ansible/`) handles `npm install` for you on each run, and since cp161 it verifies the `morphit-ops` bin is runnable as a post-install step — so a broken install fails the play with a clear error rather than surfacing later. If you re-deploy after a repo change, re-run the playbook; don't `git pull` on the target host out-of-band.

---

## 34. UFW firewall + fail2ban — extended hardening

`RUN-A-MORPHIT-NODE.md §5` covers the basic UFW setup (allow 22, 80, 443; enable). This section is for operators who want to go further.

### Default-deny inbound, default-allow outbound

The default Ubuntu UFW config is already this. Verify:

```sh
sudo ufw status verbose
# Default: deny (incoming), allow (outgoing), disabled (routed)
```

If the inbound default is anything else, fix it:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
```

### SSH rate-limit instead of plain allow

Plain `ufw allow 22/tcp` lets an attacker hammer the SSH login forever. Better:

```sh
sudo ufw delete allow 22/tcp 2>/dev/null
sudo ufw limit 22/tcp comment 'SSH (rate-limited: 6 attempts in 30s)'
```

`limit` invokes the kernel's connection-tracking rate limiter — 6 connections in 30 seconds from any single IP, after which UFW drops the packets entirely (no TCP RST, no auth attempt).

### IPv6

Most VPS providers give you both v4 and v6. UFW manages both by default; verify:

```sh
grep IPV6 /etc/default/ufw
# Expected: IPV6=yes
```

If `no`, edit and `sudo ufw reload`.

### Postgres must NOT be exposed to the public internet

The indexer and relay connect to Postgres over `localhost:5432`.
**Postgres should never accept connections from anything else.**
Stock Ubuntu 24's `postgresql-contrib` package defaults to
`listen_addresses = 'localhost'`, which is correct.  But if
you've installed Postgres a different way — Docker, a custom
image, a PaaS that gives you a public-by-default cluster, or
a manually-edited `postgresql.conf` — verify before booting
the indexer:

```sh
sudo -u postgres psql -t -c "SHOW listen_addresses;"
# Expected: 'localhost' or '127.0.0.1'
# DANGER:   '*' or '0.0.0.0' (publicly reachable)
```

If it's wrong, fix it in `/etc/postgresql/*/main/postgresql.conf`
(the `*` glob picks the active major version — typically `17` on
Ubuntu 24, `16` on 22.04, etc.):

```
listen_addresses = 'localhost'
```

then `sudo systemctl restart postgresql`.

Also verify UFW (or whatever firewall you use) explicitly
denies inbound 5432:

```sh
sudo ufw status verbose | grep 5432
# Expected: nothing (UFW's default-deny policy already blocks it)
# DANGER:   "5432/tcp ALLOW Anywhere"
```

If a previous step accidentally exposed it:

```sh
sudo ufw delete allow 5432/tcp
sudo ufw deny 5432/tcp comment 'morphit DB — never public'
```

The same applies to Docker: `127.0.0.1:5432:5432` not
`5432:5432` — the latter binds to all interfaces (see §28
Docker compose example, which gets this right).

### fail2ban — second-layer SSH defense

UFW's rate limit catches the noisy attempts; fail2ban catches the patient ones (one attempt every 31 seconds). Default install on Ubuntu 24:

```sh
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

The default `/etc/fail2ban/jail.d/defaults-debian.conf` only enables the `sshd` jail. Verify:

```sh
sudo fail2ban-client status
sudo fail2ban-client status sshd
```

A bantime of 10 minutes / 5 retries is the default. Increase for a public-facing operator instance:

```sh
sudo tee /etc/fail2ban/jail.d/morphit.local <<'EOF'
[sshd]
enabled = true
bantime = 1h
findtime = 10m
maxretry = 3
EOF
sudo systemctl restart fail2ban
```

### fail2ban for the relay — NOT VIABLE without breaking IP privacy

You might want to extend fail2ban to ban IPs that hammer
`/v1/account/create` after the per-IP spacing layer (§18 layer 3)
has already rejected them.  **This isn't possible with the relay's
default logging stance.**

The `access_log` middleware (`apps/relay/src/middleware/access_log.ts`)
is documented as an explicit no-IP-logging surface — see its
header comment, which references the PHASE-3a-DESIGN.md privacy
commitment.  Without IP addresses in the relay's structured logs,
fail2ban has nothing to extract a `<HOST>` from.

This is a **deliberate, per-operator-choice tradeoff**:

- **Default (privacy-preserving):** the relay logs request method,
  path, status, duration, and rejection code (e.g.
  `code=spacing_cooldown`).  No IP.  fail2ban-for-relay is
  unavailable, but operators are not building a per-IP signup
  history that could be subpoenaed or leaked.
- **Custom build (operator opt-in):** if an operator chooses to
  log IPs for their instance — for example, on a dedicated
  high-volume frontend instance where banning persistent abusers
  is more important than IP privacy — they can fork
  `access_log.ts` to include `ip: clientIp` in the structured
  context.  The fail2ban filter regex would then need to match
  the actual structured log shape:

  ```
  failregex = ^.*\[access\] request .*ip=<HOST>.*code=spacing_cooldown.*$
  ```

  Note the module is `[access]` (not `[signup-spacing]`) and the
  code is `spacing_cooldown` (not `too_soon`).

**Recommended path for most operators:** rely on §18 layers 1-4
(global daily ceiling, per-IP daily cap, per-IP spacing, signed
invite tokens) to bound abuse — these all run inside the relay
and don't depend on log shape.  Save fail2ban for SSH and other
non-relay surfaces where IP-banning is unambiguously appropriate.

UFW's `limit` keyword (covered earlier in this section) gives
you SSH-style brute-force protection that doesn't need IP logs:
the kernel's connection-tracking rate-limiter drops packets at
the network layer when an IP exceeds the rate, with no
application visibility required.  Apply the same idea to port
443 if a particular IP is hammering the relay's HTTPS
endpoint.

### Lockout-prevention — don't lock yourself out

Before turning on aggressive `fail2ban` rules, make sure your own admin IP is exempt:

```sh
sudo fail2ban-client set sshd addignoreip <your.admin.ip>
# Persistent: edit /etc/fail2ban/jail.d/morphit.local and add:
# [DEFAULT]
# ignoreip = 127.0.0.1/8 ::1 <your.admin.ip>
```

---

## 35. TLS auto-renewal — quick reference

The full TLS section is in §14.5 above (Let's Encrypt + nginx). This is the operator-facing summary card.

### If you used Caddy (the recommended path)

You don't need to do anything. Caddy renews automatically. Verify:

```sh
sudo journalctl -u caddy.service | grep -i 'certificate.*obtained\|renewed'
```

Should see entries every 60 days or so per domain.

### If you used nginx + certbot

Verify the timer is on:

```sh
systemctl list-timers | grep certbot
# Expected: certbot.timer  active  ...
```

If not, enable:

```sh
sudo systemctl enable --now certbot.timer
```

### If you used BunkerWeb

`AUTO_LETS_ENCRYPT=yes` in `variables.env` (§32) handles it. Verify:

```sh
sudo journalctl -u bunkerweb.service | grep -i 'certificate'
```

### Quarterly verification

Once a quarter, verify the cert chain on your live domain:

```sh
echo | openssl s_client -servername morphit.example.com -connect morphit.example.com:443 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer
```

Expected: `notAfter` is at least 30 days in the future. If less than 30 days and there's no recent renewal in your reverse-proxy logs, something's wrong with auto-renewal — investigate before it expires.

### What to do if auto-renewal breaks

Symptoms: cert expires, browsers show NET::ERR_CERT_DATE_INVALID, your monitoring (you DO have monitoring, right?) fires.

Manual renewal:

```sh
# Caddy:  systemctl reload caddy
# nginx + certbot:  certbot renew --force-renewal && systemctl reload nginx
# BunkerWeb:  the bunkerweb container's healthcheck triggers renewal on next interval
```

Then investigate WHY auto-renewal broke. Most common causes:

1. **DNS A record changed** — the new IP doesn't match what the renewal HTTP-01 challenge expects.
2. **Port 80 firewalled** — HTTP-01 challenge requires inbound 80 from Let's Encrypt's network.
3. **certbot's deploy-hook missing** — cert was renewed but the proxy never reloaded. See §14.5 for the fix.
4. **Rate limit hit** — Let's Encrypt limits 50 certs/week/registered-domain. If you're testing renewal repeatedly, you can hit this.

## 36. Warrant canary — weekly automated regeneration

Morphit ships a weekly warrant canary at `/canary.txt`.  The
canary explicitly declares no NSL / FISA / gag-order / backdoor
demand has been served, with freshness proofs from the Blurt
chain head, the Bitcoin chain head, and a current news headline.
PGP-signed by the operator's release key.

A canary that stops updating for >14 days is the silent signal
to users.  Automating the weekly regen via cron is essential:
if the cron breaks, the canary goes stale, users notice, and
they switch operators (which is the federation working as
designed).

### Setup

Operator does this once.

1. **Generate or pick a PGP signing key.**  If you don't already
   have a release/canary key:

   ```sh
   gpg --quick-gen-key 'Morphit Operator <op@morphit.example>' \
       ed25519 sign 5y
   ```

   Note the fingerprint in the gpg output.

2. **Export the public key to the static directory** so users
   can verify signatures without contacting key servers:

   ```sh
   FINGERPRINT="<from step 1>"
   gpg --armor --export "$FINGERPRINT" \
     > /opt/morphit/apps/web/static/pgp_keys.asc
   ```

3. **Set the canary env vars in your operator profile** (or
   in a dedicated `/etc/morphit/canary.env`):

   ```sh
   export MORPHIT_CANARY_PGP_KEY_ID="<your fingerprint>"
   export MORPHIT_CANARY_OPERATOR_NAME="<your operator display name, e.g. morphit.io>"
   export MORPHIT_CANARY_INSTANCE_ORIGIN="https://morphit.example.com"
   export MORPHIT_CANARY_OPERATOR_ACCOUNT="<your Blurt account, e.g. morphit-fees>"
   # Optional overrides:
   # export MORPHIT_CANARY_BLURT_RPC="https://rpc.blurt.blog"
   # export MORPHIT_CANARY_NEWS_RSS="https://feeds.bbci.co.uk/news/rss.xml"
   ```

4. **Run the generator manually once** to confirm everything
   is wired:

   ```sh
   cd /opt/morphit
   bash scripts/canary/generate.sh
   ```

   You should see output ending with `canary: wrote
   /opt/morphit/apps/web/static/canary.txt`.  Verify:

   ```sh
   curl https://morphit.example.com/canary.txt | gpg --verify
   # Should report: Good signature from "Morphit Operator <op@...>"
   ```

5. **Schedule weekly regeneration** via cron:

   ```cron
   # Weekly canary regeneration — Sundays at 03:14 UTC.
   # Output goes to /var/log/morphit/canary.log; rotate this
   # file with logrotate or systemd-tmpfiles as you prefer.
   14 3 * * 0  cd /opt/morphit && \
               . /etc/morphit/canary.env && \
               bash scripts/canary/generate.sh \
               >> /var/log/morphit/canary.log 2>&1
   ```

6. **Set up a freshness alert** so you know if the canary stops
   updating.  Two layers:

   - **Operator-side**: a daily cron that checks the canary's
     `Generated:` timestamp and pages you if it's >7 days old.
     This is YOUR safety net (catches: cron broke, gpg key
     expired, RPC endpoint changed).

     ```sh
     # /etc/cron.daily/morphit-canary-freshness
     #!/usr/bin/env bash
     cd /opt/morphit
     if ! npx tsx scripts/canary/verify.ts apps/web/static/canary.txt; then
         # Canary failed verify — wire this to your alerting.
         echo "Morphit canary stale or malformed" \
           | mail -s "morphit canary FAILED on $(hostname)" your-pager@example.com
     fi
     ```

   - **User-side**: Morphit's frontend (the page users load)
     fetches /canary.txt automatically on page load and shows
     a banner if it's >14 days old.  This is the documented
     contract; nothing for you to do beyond keeping the file
     fresh.

### What to do if you're served with a gag order

This is the canary's whole point.  Don't actively lie.  Stop
updating the canary.  Your users will switch to other operators
(the federation), and Morphit's marketplace continues without
you.  This is by design.

If you can't even tell anyone you've stopped (some legal
regimes go that far), the cron simply continues to fail — the
canary file's `Generated:` date stops advancing — and after 14
days users see the banner and switch.

### Privacy considerations

The canary.txt fetches three external resources:

- Blurt RPC for chain head (default rpc.blurt.blog) — a Blurt
  RPC anywhere works; you can use your own
- blockstream.info for Bitcoin chain head — currently
  hardcoded; file an issue if you need to swap to your own
  bitcoind
- An RSS feed for news entropy (default BBC news) — choose any
  high-frequency public feed you trust

These outbound requests happen ON YOUR SERVER, not on user
devices, when the cron runs.  Users fetching /canary.txt only
hit your own static file, so the canary doesn't leak user IPs
to third parties.

## 37. Comprehensive server hardening — defense-in-depth checklist

The earlier sections (§5 in `RUN-A-MORPHIT-NODE.md`, §32 BunkerWeb,
§34 UFW + fail2ban, §35 TLS) cover the application-layer defenses.
This section covers everything else — the OS / kernel / SSH /
database / process-isolation / monitoring / physical layers an
attacker will probe once they realize the application itself
isn't trivially exploitable.

**The threat model for this section** is a determined attacker
who has already seen the public source code and exhausted the
obvious application-layer attacks documented in `SECURITY.md`.
What's left is host-level intrusion: SSH brute-force, kernel
exploits, lateral movement from a low-priv compromise, log
tampering, backup theft, evil-maid attacks on a stolen disk.
Each subsection here is a concrete, copy-pasteable defense.

**This section is a *checklist*, not a step-by-step.**  Treat
each subsection as independent and skippable — every one of
them improves the security posture, and skipping any one of
them is a tradeoff you should make consciously, not by
default.  An operator who applies all of them is well above
the typical-VPS-deployment baseline.

### Before you start — the three highest-stakes gotchas

If you only remember three things from this section, remember
these.  Each one is a footgun that costs more than the time
spent reading it.

1. **SSH lockout (§37.1).**  Before reloading sshd after the
   key-only / no-root config change, open a SECOND ssh session
   to the host and confirm key-based login works in it.  Only
   then close the first session.  Every doc says this; people
   still get it wrong; the recovery path is console / KVM
   access to the VPS.

2. **BunkerWeb trusted-proxy IPs (§32).**  The relay only
   trusts `X-Forwarded-For` from loopback by default.  Behind
   BunkerWeb that's wrong in two opposite ways:
   - If you do NOT set `MORPHIT_RELAY_TRUSTED_PROXY_IPS`, the
     relay sees every user as the same IP (BunkerWeb's).  One
     abuser exhausts the daily rate limit for everyone.
   - If you set it too WIDE (e.g., `0.0.0.0/0`), anyone can
     spoof `X-Forwarded-For` and bypass rate limiting entirely.

   Set it to the exact CIDR/IP of your BunkerWeb upstream.  See
   §32 for the Docker-compose bridge case.

3. **Postgres binding (§37.8).**  If `postgresql.conf` has
   anything other than `localhost` / `127.0.0.1` in
   `listen_addresses`, you're exposed to the network.  Default
   is loopback-only; verify it wasn't changed by Docker or by
   a well-meaning previous admin.  Test from an external IP:
   `psql -h <public-ip> -U morphit_indexer` should time out,
   never connect.

### Suggested apply order

Subsections are independent and can be applied in any order,
but a sensible sequence for a fresh deployment is:

  §37.1 → §37.2 → §37.3 → §37.4 → §37.5 → §37.6 → §37.7
  → §37.8 → §37.9 → §37.10 → §37.11 → §37.12 → §37.13
  → §37.14 → §37.15 → §37.16 → §37.17 → §34 (UFW + fail2ban)
  → §35 (TLS) → §32 (BunkerWeb) → §38 (squatter defense)
  → §37.18 (verification map)

Test after each.  If you're triaging a partially-hardened
existing deployment, start with §37.18 to identify what's
missing and work backwards.

### 37.1 SSH hardening

Default Ubuntu sshd_config is OK but not great.  Tighten it.
Edit `/etc/ssh/sshd_config.d/99-morphit-hardening.conf` (a
new file in the `.d` directory wins over the main config):

```
# Refuse password authentication entirely.  Keys only.
# DANGER: lock yourself in via a working key BEFORE setting
# this!  Test from a SECOND ssh session that key login works,
# THEN apply this and reload sshd.
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM yes

# Refuse root login.  Use a sudo-capable operator account.
PermitRootLogin no

# Lower the brute-force surface.  Default is 6.
MaxAuthTries 3
MaxSessions 5

# Disconnect idle sessions after 10 minutes.
ClientAliveInterval 300
ClientAliveCountMax 2

# Whitelist by user.  Replace 'morphit' with whatever account
# you use to operate the host.
AllowUsers morphit
# (optional) AllowGroups sudoers

# Refuse X11 / agent / TCP forwarding unless you actually use
# them.  If you do, comment these out.
AllowTcpForwarding no
X11Forwarding no
AllowAgentForwarding no
PermitTunnel no

# Slow-loris defense — don't let half-open SSH connections
# linger.
LoginGraceTime 30s

# Modern crypto only — no RSA-1024 leftovers, no DSA, no MD5
# HMACs.  Ubuntu 24's defaults are already mostly fine; this
# is belt-and-suspenders.
HostKeyAlgorithms ssh-ed25519,rsa-sha2-512,rsa-sha2-256
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org,diffie-hellman-group16-sha512
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com

# Log every login (success/fail) to syslog, which auditd then
# captures (see §37.6).
LogLevel VERBOSE
```

Apply:

```sh
# CRITICAL: open a SECOND ssh session and confirm key-only
# login works in it BEFORE reloading sshd.  If you can't log
# in to the second session, fix sshd_config in the FIRST
# session (which is still alive) before reloading.
sudo sshd -t  # syntax check; must print nothing on success
sudo systemctl reload ssh
```

**Optional: change the SSH port.**  Moves you off the bot
firehose (port 22 is scanned constantly).  Doesn't add real
security against a targeted attacker, but reduces log noise
by 99%+.  If you do this, update UFW (`sudo ufw allow 2222/tcp`
or whatever you pick) BEFORE reloading sshd.

### 37.2 Unattended security upgrades

The biggest risk to a long-running Linux box is "operator
forgot to apply the kernel CVE patch from 8 months ago."
Automate the security-only patch stream:

```sh
sudo apt install -y unattended-upgrades apt-listchanges
sudo dpkg-reconfigure -plow unattended-upgrades
# Choose "Yes" to enable automatic updates.
```

Verify the config picks ONLY security upgrades (not feature
upgrades, which can break things mid-night):

```sh
grep -E '^[^/]*"[^"]*";' /etc/apt/apt.conf.d/50unattended-upgrades \
  | grep -v Allowed-Origins
```

The default Ubuntu 24 config enables ESM-Apps + ESM-InfraSec +
distro security updates.  It does NOT enable feature updates.
That's correct.

To make sure the timer actually runs:

```sh
systemctl status unattended-upgrades.service
systemctl status apt-daily.timer apt-daily-upgrade.timer
# All three should be active/enabled.
```

After a security upgrade lands, services that link the
upgraded library may need restart.  Install `needrestart`:

```sh
sudo apt install -y needrestart
# Default mode (interactive) prompts at next login.  For a
# headless production box, edit /etc/needrestart/needrestart.conf:
#   $nrconf{restart} = 'a';   # auto-restart services
#   $nrconf{kernelhints} = 0; # don't print kernel-needs-reboot to login MOTD if you handle that elsewhere
```

Apply changes:

```sh
sudo dpkg-reconfigure needrestart
```

For kernel updates — those need a reboot.  Either schedule one
manually after `needrestart` reports a kernel-pending state,
or accept Ubuntu's `Unattended-Upgrade::Automatic-Reboot
"true";` (commented-out by default).  Recommended posture:
**leave automatic-reboot OFF**, monitor `/var/run/reboot-required`,
and reboot on a maintenance window — your relay's BLURT-broadcast
in-flight transactions tolerate operator-initiated reboots
better than mid-night surprise ones.

### 37.3 Kernel sysctl hardening

Drop these into `/etc/sysctl.d/99-morphit-hardening.conf`:

```
# ─── Network: spoof / source-routing / redirect defenses ──
# Ignore source-routed packets (a 1990s LAN trick attackers
# still occasionally try).
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0

# Ignore ICMP redirects (used in MITM / route-poisoning).
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0

# Don't send ICMP redirects (we're not a router).
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# Reverse-path filter.  Drop packets whose source IP wouldn't
# normally route back the way it came (anti-spoof).
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Log martian packets.  Spammy but useful during incident response.
net.ipv4.conf.all.log_martians = 1

# Ignore broadcast pings (smurf-attack defense).
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Ignore bogus error responses.
net.ipv4.icmp_ignore_bogus_error_responses = 1

# SYN cookies — defends against SYN-flood DoS.
net.ipv4.tcp_syncookies = 1

# Increase the SYN backlog so a small SYN flood doesn't
# starve legitimate connections.
net.ipv4.tcp_max_syn_backlog = 4096

# ─── Kernel: information disclosure / privilege escalation ──
# Restrict /proc/kcore, /var/log/dmesg etc. to root.  Hides
# kernel pointers from local-unprivileged exploits.
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2

# Disable suid core dumps — they can leak secrets the suid
# binary handled.
fs.suid_dumpable = 0

# Restrict kernel logs.
kernel.printk = 3 4 1 3

# ptrace defense — prevent processes from attaching to OTHER
# processes' memory unless they're a parent or have CAP_SYS_PTRACE.
kernel.yama.ptrace_scope = 1

# Restrict perf_event so unprivileged users can't profile
# kernel addresses.
kernel.perf_event_paranoid = 3

# Disable BPF for non-root (Ubuntu default is 2 ≈ "root only").
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2

# ─── Filesystem ──
# Only allow regular users to follow symlinks they own (or
# the directory's owner).  Hardlinks similarly.  Defends
# against /tmp-race attacks.
fs.protected_symlinks = 1
fs.protected_hardlinks = 1

# Protect FIFOs and regular files against world-writable-tmp
# overwrite races (5.x kernel feature).
fs.protected_fifos = 2
fs.protected_regular = 2
```

Apply without reboot:

```sh
sudo sysctl --system
# Read-back to confirm the file took effect:
sudo sysctl -a 2>/dev/null | grep -E 'kptr_restrict|tcp_syncookies|rp_filter' | sort -u
```

### 37.4 Filesystem mount hardening

Add these mount options to `/etc/fstab` to reduce what an
attacker can do if they get a writable foothold in /tmp,
/var/tmp, or /dev/shm:

```
# /etc/fstab — additions / modifications
tmpfs   /tmp        tmpfs   defaults,nosuid,nodev,noexec   0 0
tmpfs   /dev/shm    tmpfs   defaults,nosuid,nodev,noexec   0 0
# /var/tmp — bind-mount to /tmp so it shares the same hardening
/tmp    /var/tmp    none    bind                            0 0
```

`nosuid` defangs attempt to drop a setuid binary in /tmp and
exploit it.  `nodev` blocks creation of device nodes.  `noexec`
blocks running binaries from /tmp — most fileless droppers
download to /tmp and chmod+x.  ⚠ **Some installers and apt
hooks expect /tmp to be executable**; if `apt upgrade` starts
failing, temporarily remount /tmp without noexec for the
upgrade window:

```sh
sudo mount -o remount,exec /tmp
sudo apt upgrade
sudo mount -o remount /tmp  # back to fstab settings
```

Alternative: skip noexec on /tmp specifically and only apply
to /var/tmp + /dev/shm.  That's the conservative posture — most
of the attack value is in /dev/shm (which legitimate apps
rarely write to) and /var/tmp (used by long-lived caches), not
/tmp.

Apply:

```sh
sudo mount -a   # remount everything per fstab; failure here means a typo
sudo systemctl daemon-reload
# Verify:
mount | grep -E '/tmp|/dev/shm|/var/tmp'
```

### 37.5 Process / capability hardening for the Morphit services

Morphit ships systemd units in `ops/systemd/`.  These run as
non-root users (`morphit` for the indexer, `morphit-relay` for
the relay) which is good, but defense-in-depth means tightening
the systemd-level isolation too.  Edit each service file (or
create a drop-in at `/etc/systemd/system/morphit-indexer.service.d/hardening.conf`,
similar for `morphit-relay.service`):

> **The web frontend has no systemd unit.**  The frontend is
> static HTML/CSS/JS built by `npm run build`; nginx serves it
> from `/var/www/morphit-web` (root path set in
> `ops/nginx/web.conf`).  Hardening for the web tier is an
> nginx-config concern, not a systemd one.

```ini
[Service]
# Filesystem isolation — paths here MUST match what the unit
# actually writes to (data dir, log dir).  Ubuntu's path
# conventions:
#
#   indexer:   /var/lib/morphit            (DB-adjacent state)
#   relay:     /var/lib/morphit-relay      (relay state, BLURT cache)
#   logs:      /var/log/morphit/<service>  (only if you log to file
#                                           rather than journald — most
#                                           Morphit services log to
#                                           journald, in which case
#                                           the log path can be omitted)
#
# Each service unit gets ONLY the paths it owns.  An indexer
# unit shouldn't list /var/lib/morphit-relay; a relay unit
# shouldn't list /var/lib/morphit.  This is part of the
# isolation goal — a compromised relay can't trample the
# indexer's data.
ProtectSystem=strict
ProtectHome=true
# Indexer service:
ReadWritePaths=/var/lib/morphit
# Relay service (use this line INSTEAD on the relay's drop-in):
# ReadWritePaths=/var/lib/morphit-relay
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
ProcSubset=pid

# Networking — Morphit needs IPv4/v6/UNIX, nothing exotic
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=any
# (then explicitly allow what we need; the strictest form
# requires you to allow each remote address individually,
# which is impractical for the indexer's chain RPC fanout.
# Pragmatic: allow everything but log it via auditd.  See §37.7.)
IPAddressAllow=any

# Privilege/capability isolation
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
RestrictRealtime=true
# Node's V8 JIT needs writable-AND-executable memory pages, so
# MemoryDenyWriteExecute=true crashes the runtime at startup.
# Leave this off for Morphit's services.  If you ever ship a
# version that runs through `--jitless` (much slower), you can
# turn this on.
MemoryDenyWriteExecute=false
SystemCallArchitectures=native
# Node needs more syscalls than @system-service alone provides
# (epoll variants, getrandom, eventfd, sched_*, mmap with PROT_EXEC).
# @system-service + @network-io + the listed allowlist works for
# typical Node 22.x.  If your service still fails to start,
# inspect `journalctl -u <service> -n 100` for "blocked syscall"
# messages and add the syscall to the filter explicitly.
SystemCallFilter=@system-service @network-io
SystemCallFilter=~@privileged @resources @debug @mount @reboot @swap @raw-io @cpu-emulation @obsolete

# Resource limits (defense against fork bombs / memory leaks)
LimitNOFILE=16384
LimitNPROC=512
TasksMax=1024
```

Apply:

```sh
sudo systemctl daemon-reload
sudo systemctl restart morphit-indexer.service
sudo systemctl restart morphit-relay.service
# Confirm tightened settings took effect:
sudo systemctl show morphit-indexer.service | grep -E 'ProtectSystem|NoNewPrivileges|SystemCallFilter' | head
```

If the relay refuses to start after applying these (signed
broadcasts use Node native crypto which may need more
syscalls than the filter covers), relax incrementally:

1. Check `journalctl -u morphit-indexer.service -n 100` for
   `seccomp` denial entries.  They name the syscall that was
   blocked — `audit: type=1326 ... syscall=257 ...` — and you
   can add that syscall name to a permissive `SystemCallFilter`
   line.
2. Try `SystemCallFilter=@common` instead of `@system-service @network-io`.
   `@common` is broader and will catch more legitimate Node usage.
3. As a last resort, comment out the SystemCallFilter lines
   entirely and keep the other ProtectSystem / NoNewPrivileges /
   ReadWritePaths defenses — those alone still block 80% of
   the post-compromise attack surface.

The tradeoff matrix is: tighter config = harder to exploit if
the service is compromised, but more fragile to legitimate
runtime needs.  Accept the loosest setting that actually works.

### 37.6 auditd — log everything that looks suspicious

`auditd` is the kernel-level audit framework.  It's noisy by
default but indispensable when investigating "did anyone log
in via SSH between Tuesday and now."

```sh
sudo apt install -y auditd audispd-plugins
sudo systemctl enable --now auditd
```

Drop a Morphit-specific ruleset at `/etc/audit/rules.d/morphit.rules`:

```
# Watch successful + failed SSH logins
-w /var/log/auth.log -p wa -k auth-events

# Watch sudoers and PAM config — any change here is interesting
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d -p wa -k sudoers
-w /etc/pam.d -p wa -k pam

# Watch the morphit user's authorized_keys — an attacker who
# wants persistence WILL drop a key here.
-w /home/morphit/.ssh/authorized_keys -p wa -k ssh-keys

# Watch crontabs — second favorite persistence mechanism.
-w /etc/cron.d -p wa -k cron
-w /etc/cron.daily -p wa -k cron
-w /etc/cron.hourly -p wa -k cron
-w /etc/crontab -p wa -k cron
-w /var/spool/cron -p wa -k cron

# Watch systemd unit dirs — third favorite.
-w /etc/systemd/system -p wa -k systemd
-w /lib/systemd/system -p wa -k systemd

# Watch Morphit's own files — config drift signals trouble.
-w /opt/morphit -p wa -k morphit-files

# Privileged escalation attempts
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=4294967295 -k privesc

# Rule editing protection — make the ruleset itself immutable
# until reboot.  Comment out during testing.
# -e 2
```

Apply:

```sh
sudo augenrules --load
sudo systemctl restart auditd
# Read recent events:
sudo aureport -i --summary
sudo ausearch -k ssh-keys -ts today
```

Configure auditd's own log rotation in `/etc/audit/auditd.conf`:

```
max_log_file = 50          # MB
num_logs = 8
max_log_file_action = ROTATE
disk_full_action = SYSLOG  # don't halt the system if /var fills
disk_error_action = SYSLOG
```

### 37.7 AppArmor profiles for Morphit services

Ubuntu ships AppArmor enabled by default; verify:

```sh
sudo aa-status
# Should show "apparmor module is loaded" and a list of confined
# profiles.  If it's not loaded, you're on a stripped image
# (or AppArmor was disabled deliberately).
```

Custom profiles for `morphit-indexer` and `morphit-relay` are
**aspirational** (writing a tight AppArmor profile that doesn't
break Node + libsodium + every npm transitive is a research
project).  The pragmatic posture:

1. Confine `nginx` (already covered by Ubuntu's stock profile).
2. Confine `postgresql` (also stock).
3. Leave the Node services in `unconfined` mode — the systemd
   hardening in §37.5 covers the same isolation surface for
   those.

If you want to explore writing a Morphit-specific profile,
start with `aa-genprof` while running the relay in a non-prod
environment and exercise the full surface.  Expect 2-4 hours
of profile tuning before it's stable.

### 37.8 Postgres hardening beyond `listen_addresses`

§34 covers `listen_addresses = 'localhost'`.  Three more
defenses to apply:

**a. SCRAM-SHA-256 password hashing.**  Ubuntu 24's default is
already SCRAM-SHA-256; older versions used MD5.  Verify:

```sh
sudo -u postgres psql -t -c "SHOW password_encryption;"
# Expected: scram-sha-256
# DANGER:   md5
```

If MD5, switch:

```sh
sudo -u postgres psql -c "ALTER SYSTEM SET password_encryption = 'scram-sha-256';"
sudo systemctl reload postgresql
# Now CHANGE every password (just-flipping the setting doesn't
# rehash existing passwords; they stay MD5 until reset):
sudo -u postgres psql -c "ALTER USER morphit WITH PASSWORD '<new password>';"
```

**b. pg_hba.conf — peer auth for local, scram for everything else.**
Edit `/etc/postgresql/*/main/pg_hba.conf`:

```
# TYPE   DATABASE    USER       ADDRESS         METHOD
local    all         postgres                   peer
local    all         all                        peer
host     morphit     morphit    127.0.0.1/32    scram-sha-256
host     morphit     morphit    ::1/128         scram-sha-256
# DENY EVERYTHING ELSE (implicit; anything not matched above rejects)
```

`peer` for local sockets means Postgres trusts the OS-level UID
of the connecting process, no password needed — that's how the
backup script and DB shell login work.  `scram-sha-256` for the
TCP loopback is what Morphit's indexer + relay use, and the
password is in the `.env` file (which has `chmod 600` per
§37.10).

Apply:

```sh
sudo systemctl reload postgresql
# Test that morphit user from localhost still works:
psql -h 127.0.0.1 -U morphit -d morphit -c 'SELECT 1;'
# Test that postgres user via socket still works:
sudo -u postgres psql -c 'SELECT 1;'
```

**c. Database-level CONNECT permission.**  Drop ambient
CONNECT for the morphit role on databases it doesn't need:

```sh
sudo -u postgres psql <<'PSQL'
REVOKE ALL ON DATABASE postgres FROM morphit;
REVOKE ALL ON DATABASE template0 FROM morphit;
REVOKE ALL ON DATABASE template1 FROM morphit;
GRANT  CONNECT ON DATABASE morphit TO morphit;
PSQL
```

**d. Statement-level audit (optional).**  `pg_audit` is an
extension that logs every DDL + DML — useful for detecting
tampering, but adds 5-15% overhead.  Recommended for a high-
value canonical operator host, optional otherwise.  Install
with `apt install postgresql-17-pgaudit` (match the major
version installed) and configure via
`shared_preload_libraries = 'pgaudit'` in `postgresql.conf`
plus `pgaudit.log = 'write,ddl'` in the morphit DB's
configuration.  Restart Postgres to take effect.

**e. `statement_timeout` — defense-in-depth against runaway
queries.**  Morphit's pg pool
(`apps/indexer/src/db/pool.ts`) sets `connectionTimeoutMillis:
5000` and `idleTimeoutMillis: 30000`, but deliberately does
**not** set a pool-level `statement_timeout` — doing so at the
client would force a single value across both the indexer
worker (which writes blocks one-at-a-time and stays sub-second
in steady state) and ad-hoc psql sessions an operator might
use for maintenance.  The right place to set this defense is
at the Postgres server, per-database, where the operator
owns the value:

```sh
# Set a 30-second per-statement ceiling for the indexer DB.
sudo -u postgres psql -d morphit_indexer -c \
    "ALTER DATABASE morphit_indexer SET statement_timeout = '30s';"
```

This applies to all **new** connections from this point on.
Existing pool connections keep the old value until they
recycle, so reload the services to pick it up promptly:

```sh
sudo systemctl restart morphit-indexer morphit-relay
```

**Choice of value.**  `30s` is comfortable for Morphit's normal
HTTP API + per-block indexer transactions (steady-state
queries run in sub-second; 30s is two orders of magnitude of
headroom).  Bump to `60s` if you're running unusually large
backfills or your instance has accumulated tables beyond
typical scale.  `0` (unlimited) is Postgres's unsafe default —
don't leave it there.

**Initial backfill on a fresh instance.**  The poller drains
the chain block-by-block with one transaction per block.  No
single statement is ever a deep replay; each block's write
stays well under the timeout even when catching up from
genesis on a brand-new instance.  No special handling needed.

**Ad-hoc long queries.**  If you ever need to run a one-off
long query (analytics from psql, a custom report), override
per-session without changing the database default:

```sql
SET statement_timeout = 0;
-- long query here
RESET statement_timeout;
```

**Verify it took effect:**

```sh
sudo -u postgres psql -d morphit_indexer -c \
    "SHOW statement_timeout;"
# Expected: 30s
```

You can also verify per-role from inside a Morphit-side psql
session by setting `MORPHIT_INDEXER_DATABASE_URL` and running
`psql "$MORPHIT_INDEXER_DATABASE_URL" -c 'SHOW
statement_timeout;'` — that proves the indexer user picks up
the database-level default through the connection string.

### 37.9 Filesystem integrity monitoring with AIDE

AIDE (Advanced Intrusion Detection Environment) baselines every
file's hash and reports changes.  Install once, run nightly,
review the diff in the morning:

```sh
sudo apt install -y aide
# Generate the initial baseline.  ⚠ Do this AFTER the system
# is fully configured — a baseline of a half-installed system
# won't tell you anything useful.
sudo aideinit
sudo cp /var/lib/aide/aide.db.new /var/lib/aide/aide.db
```

Configure to ignore noisy paths (logs, /var/cache, /tmp).  Edit
`/etc/aide/aide.conf` to taste — Ubuntu's default config is
reasonable but mentions the package's own paths heavily; trim
those before baselining.

Schedule nightly check:

```cron
# /etc/cron.d/aide-morphit
30 3 * * *  root  /usr/bin/aide --check 2>&1 | mail -s "AIDE on $(hostname)" your-pager@example.com
```

Three things to know:

1. AIDE will alert on every legitimate change too (apt
   upgrades, log rotation, `/var/lib/morphit` writes).  Tune
   the config to ignore those paths or accept the noise.
2. The AIDE database itself MUST be protected — an attacker
   who compromises root can update the baseline to hide their
   tracks.  Mitigations: store the baseline on read-only media
   (rare) or, more practically, rsync the baseline off-host
   nightly so an attacker can't quietly rewrite it.
3. AIDE does not replace antivirus.  It's a tripwire, not a
   scanner.

For a lighter-weight alternative, `debsums` checks the integrity
of installed Debian packages against the package manager's
manifests:

```sh
sudo apt install -y debsums
sudo debsums -c   # report changed package files
```

Less comprehensive than AIDE but zero-config.

### 37.10 Secrets file hygiene

The Morphit services read `MORPHIT_RELAY_ACTIVE_KEY_FILE`,
Postgres credentials, etc., from environment files (typically
`/etc/morphit/relay.env`, `/etc/morphit/indexer.env`).  These
files MUST be 0600-permissioned and owned by the runtime user:

```sh
sudo chown morphit:morphit /etc/morphit/indexer.env
sudo chmod 0600 /etc/morphit/indexer.env
sudo chown morphit-relay:morphit-relay /etc/morphit/relay.env
sudo chmod 0600 /etc/morphit/relay.env

# Verify:
ls -l /etc/morphit/*.env
# Expected: -rw------- 1 owner owner ... (octal 600)
```

The systemd unit then loads via `EnvironmentFile=/etc/morphit/indexer.env`
which respects the 0600 perm (systemd reads it as root before
dropping to the service user).

**Don't:**

- Store secrets in `/opt/morphit/.env` (world-readable in a
  default git checkout)
- Echo secrets to logs (Morphit's logger redacts context-object
  keys whose name matches a secret-suffix pattern — `*_KEY*`,
  `*_PASSWORD`, `*_PASSPHRASE`, `*_SECRET`, `*_TOKEN`, `*_WIF`,
  `*_MNEMONIC`, plus the camelCase variants `apiKey`,
  `activeKey`, `userPassword`, etc.  Public identifiers like
  `publicKey` / `VAPID_PUBLIC_KEY` are explicitly exempt.  See
  `isSecretContextKey` / `redactSecrets` in
  `apps/indexer/src/log/index.ts` for the canonical list and
  unit tests in `apps/indexer/test/log.test.ts` for coverage.
  If you add a new secret-shaped env var with a non-matching
  name, either rename it to fit the pattern or extend the
  allow-list)
- Commit `.env` files to your operator-config repo (use
  `.env.example` with placeholder values, .gitignore the real
  one)
- Pass secrets via command-line args (`/proc/<pid>/cmdline`
  is world-readable)

**Optional but recommended:** encrypted-at-rest secrets via
`age` or `sops`:

```sh
# Initial setup
sudo apt install -y age
age-keygen -o /root/.config/age/morphit-secrets.key
chmod 600 /root/.config/age/morphit-secrets.key

# Encrypt the env file
age -r "$(cat /root/.config/age/morphit-secrets.key | grep '#' | cut -d ' ' -f2)" \
    -o /etc/morphit/indexer.env.age \
    < /etc/morphit/indexer.env

# Wrap the systemd unit so it decrypts at boot:
ExecStartPre=/usr/bin/age -d -i /root/.config/age/morphit-secrets.key -o /run/morphit/indexer.env /etc/morphit/indexer.env.age
EnvironmentFile=/run/morphit/indexer.env
ExecStopPost=/bin/rm -f /run/morphit/indexer.env
```

This means the disk-image of a stolen drive doesn't reveal
secrets; only the running system can decrypt them.  An attacker
who has root on the live system can still read them, but disk
theft + offline forensics is defeated.

#### 37.10.1 The relay's active key — your single highest-value secret

Cross-references the **2026-05-07 deep-deep audit of active/owner
key handling** (`SECURITY.md` §1b).  The audit was user-side
(browser code), but this subsection captures the operator-side
implications a sysadmin needs to verify.

The relay holds **one long-lived hot active key** on disk: the
WIF (or encrypted envelope) at `MORPHIT_RELAY_ACTIVE_KEY_FILE`.
Inside the running process it's a long-lived `string` field on
the config object — `relayActiveKeyWif` — used to sign every
account-create, every welcome-bonus transfer, every loyalty-
milestone BP power-up.  This key is the operator's single
highest-value secret on the system.  If an attacker reads it,
they can drain the operator's BLURT balance and reassign
delegated BP.

**What the user-side audit gives the operator:** nothing direct.
The user's keys never touch your server.  Compromised user
keys are user problems, not operator problems.

**What you (the operator) must verify:**

1. **`MORPHIT_RELAY_ACTIVE_KEY_FILE` permissions.**  Mode `0400`,
   owned by the relay's systemd user.  The relay's config
   loader enforces this at boot — it refuses to start if
   the file is group- or world-readable.  Verify with:

   ```sh
   ls -l "$(grep '^MORPHIT_RELAY_ACTIVE_KEY_FILE' /etc/morphit/relay.env | cut -d= -f2)"
   # Expected: -r-------- 1 morphit-relay morphit-relay ...
   ```

2. **Encrypted-on-disk active key (recommended).**  Per ADR-0010
   §4, the active key file may be a passphrase-encrypted
   envelope rather than a bare WIF.  See `§3` of this doc for
   the migration script (`apps/relay/scripts/encrypt-active-key.ts`).  An
   encrypted envelope means a stolen disk image yields nothing
   without the passphrase, which is entered interactively at
   first boot and held in process memory thereafter.

3. **Systemd hardening covers process memory.**  §37.5 is
   already in effect for `morphit-relay.service` if you
   followed §37 in order.  The relevant directives that
   protect process memory of the running relay are:

   - `MemoryDenyWriteExecute=true` (no JIT-via-mmap exploit
     surface; Node V8 needs `false` for the web app but the
     relay is a non-V8-JIT path that handles this)
   - `RestrictNamespaces=yes`, `LockPersonality=yes`,
     `NoNewPrivileges=yes`
   - `ProtectSystem=strict`, `ProtectHome=yes`,
     `PrivateTmp=yes`
   - `CapabilityBoundingSet=` (empty — no caps)
   - `SystemCallFilter=@system-service @network-io`

   These don't prevent in-process memory reads (you'd need a
   kernel-level seccomp filter for that — out of scope for a
   user-space service), but they prevent the relay's
   process from being escalated, ptrace'd by a non-root
   peer, or used as a pivot to attack other services.

4. **AppArmor profile (optional but high-value).**  §37.7
   defines an AppArmor profile for `morphit-relay` that
   denies all filesystem access except the key file, the
   env file, and the IPC socket.  An attacker who finds an
   RCE in the relay's HTTP layer can't read `/etc/passwd`,
   `/proc/*/maps`, or the indexer's database file even if
   they get arbitrary code execution.

5. **No exfil channel.**  §37.13 (UFW egress allowlist)
   limits outbound connections to your Blurt RPC pool.
   Even with code execution inside the relay, an attacker
   can't `curl -d "$ACTIVE_WIF" attacker.example/`.

6. **Backup hygiene.**  §37.12 covers age-encrypted backups.
   **Do NOT include the bare WIF in any backup that isn't
   itself encrypted.**  If your `/etc/morphit/keys/` is in
   a snapshot, that snapshot needs to be encrypted with the
   same care.

7. **Owner key NEVER on the server.**  Per §0 (Initial
   account setup), the **owner key for `@morphit-relay`
   stays on paper, in a safe, off any networked machine**.
   Without the owner key offline, you cannot rotate the
   active key after a compromise.  Without rotation, a
   stolen active key is a stolen-forever active key.  This
   is the single most important sysadmin discipline for
   running a relay.

**What the audit tells you when something goes wrong:**

If a structured-log line `key_loaded` is emitted at boot but
the relay subsequently fails to broadcast a transfer with an
"invalid signature" error, the in-memory active key may have
been corrupted by an attacker who has root.  Stop the relay
immediately (§7 — Suspected relay compromise) and rotate.

If you find unexplained `transfer` ops on `@morphit-relay`'s
chain history that you didn't initiate (welcome-bonus drainer
ops are normal; ops to unknown accounts are not), the active
key is presumed compromised.  §7 + §8 documents the response.

**What this subsection does NOT cover:**

- Browser-side user-key handling.  See `SECURITY.md` §1b for
  that audit.
- Multi-instance setups where `@morphit-relay` and
  `@morphit-relay-2` share an owner.  See §11.5 of
  `RUN-A-MORPHIT-NODE.md` for sub-account architecture.
- Hardware-key-backed operator keys.  Out of scope today;
  Yubico's PKCS#11 path against secp256k1 isn't supported by
  any Blurt signing library, so the operator's active key
  is necessarily a software key.  This is a Blurt-protocol
  limitation, not a Morphit one.

### 37.11 Disk encryption (LUKS)

If the host could be physically stolen — VPS provider with
shared disks, on-prem hardware, anything you don't 100% trust
the supply chain on — encrypt the disk.  This is a setup-time
decision, not a post-hoc one (well, you CAN encrypt in-place
with cryptsetup-reencrypt, but it's a 12-hour ordeal you'd
rather avoid).

For VPS providers:

- **Vultr / Hetzner / DigitalOcean** — pick "encrypted disk" at
  provisioning time if offered.  If not, install Ubuntu via
  the provider's recovery/iso-boot path with full-disk
  encryption enabled in the installer.
- **AWS EC2** — enable EBS encryption at volume creation time
  (default-encrypt account-wide setting recommended).
- **Bare metal** — Ubuntu Server installer's "Use entire
  disk and set up encrypted LVM" option; pick a strong
  passphrase and store it offline.

The tradeoff: encrypted disk requires a passphrase at boot,
which means automated reboots no longer work without either
(a) a TPM that releases the passphrase to the kernel during
boot or (b) `dropbear-initramfs` so you can SSH in pre-boot
and unlock manually.

For a Morphit relay that processes signed BLURT broadcasts
and holds significant runway, the boot-passphrase friction is
worth it.  For a low-stakes secondary instance, default-
unencrypted-VPS is acceptable.

### 37.12 Backup encryption

`docs/RUN-A-MORPHIT-NODE.md §10` documents daily DB backups
via `ops/backup/morphit-backup.sh`.  The script has built-in
support for two protections — both off by default, both
enabled by editing `/etc/morphit/backup.env` (no script
modification needed):

1. **Per-backup age encryption.**  Set `AGE_RECIPIENT=age1...`
   to the operator's age public key.  Every backup is then
   encrypted with `age -r "$AGE_RECIPIENT"` before being
   written to disk; the resulting filename ends in
   `.sql.gz.age` instead of `.sql.gz`.

   Generate the keypair OFF this host (laptop, vault host,
   hardware token):
   ```sh
   age-keygen -o ~/.age/morphit-backup.key
   ```
   The first line of `morphit-backup.key` is the public key
   (`age1...`); copy it into `/etc/morphit/backup.env`.  The
   matching PRIVATE key MUST stay off the morphit host — an
   attacker who roots the box should not be able to decrypt
   your offsite backups.

2. **Off-host push.**  Set
   `REMOTE_DESTINATION=user@backup-host:/morphit/` (any
   rsync-compatible target) and optionally
   `SSH_KEY=/etc/morphit/backup-ssh-key`.  Every backup
   is then rsync'd off this host immediately after the
   local write.  rsync errors are warned but non-fatal —
   the local copy remains the source-of-truth.

**Placeholder-value guardrail (cp131):** if either
`AGE_RECIPIENT` or `REMOTE_DESTINATION` still contains a
placeholder marker (`REPLACE`, `XXXXX`, `example.com`,
`CHANGE_ME`), the script SKIPS that feature and logs a
journald warning rather than silently shipping plaintext
to a bogus host or producing unencrypted backups operators
believed were encrypted.  An operator following the
Ansible defaults (which leave both empty) gets local-only
plaintext backups — no silent leak.

To verify a backup is genuinely encrypted, try to read it
WITHOUT the age private key:
```sh
zcat /home/morphit/backups/morphit-20260523-040000.sql.gz.age 2>&1 | head
# Expected: gzip: stdin: not in gzip format
#   (because the bytes are age-encrypted, not gzipped)

age --decrypt -i ~/.age/morphit-backup.key \
    /home/morphit/backups/morphit-20260523-040000.sql.gz.age \
  | zcat | head
# Expected: real SQL dump content.
```

### 37.13 Outbound network policy

Morphit's services initiate outbound connections to:

- Blurt RPC nodes (default `https://rpc.blurt.blog:443`,
  others — see §22)
- Bitcoin block explorers (in the canary script + the BTC
  explorer-fee verifier)
- Monero block explorers (XMR explorer-fee verifier)
- The relay's chain-broadcast endpoint (Blurt p2p / RPC)
- An RSS feed for canary news entropy
- Optionally, Anthropic / Claude API for any operator-specific
  alerting tooling you've built (out of scope for the canonical
  install)

UFW's default-allow-outbound is fine for normal operation, but
"egress-deny by default with explicit allowlist" is the
strictest posture.  This is a high-friction defense — most
operators skip it because it breaks `apt upgrade`, npm installs,
and ad-hoc debugging — but it dramatically reduces the value
of a low-priv compromise (an attacker who got code execution as
the `morphit` user can't open a reverse shell to their C2 if
outbound is restricted).

If you want to apply it:

```sh
# Deny all outbound by default
sudo ufw default deny outgoing

# Allow DNS (most providers' resolver)
sudo ufw allow out 53/udp
sudo ufw allow out 53/tcp

# Allow NTP
sudo ufw allow out 123/udp

# Allow HTTPS (for Blurt RPC, BTC/XMR explorers, RSS feeds, npm)
sudo ufw allow out 443/tcp

# Allow Blurt p2p (default 9999, varies)
# sudo ufw allow out 9999/tcp

# Allow SSH out (so you can clone git repos via ssh:// and run
# operator-side scripts that call out)
sudo ufw allow out 22/tcp

# Allow SMTP if you use a relay for alerts (587 = STARTTLS)
sudo ufw allow out 587/tcp

# Apply
sudo ufw reload
```

Be ready to temporarily relax this for `apt upgrade` etc.
that hit non-443 mirrors:

```sh
sudo ufw default allow outgoing  # temporary
sudo apt upgrade
sudo ufw default deny outgoing
sudo ufw reload
```

**Recommended posture for Morphit:** apply the egress allowlist
on the relay host (high-value target, narrow scope of legitimate
outbound) but skip it on the indexer host (broad legitimate
outbound to RPC nodes, explorers, etc., where allowlist
maintenance becomes a chore).

### 37.14 Operator alerting — outbound email

Most of the alerting hooks in §16 (operator-account balance),
§37.6 (auditd), §37.9 (AIDE), and §31 (backup) reference
sending mail.  Configure outbound SMTP once:

```sh
# Lightweight: msmtp, a single-user SMTP relay (no full
# postfix install needed).
sudo apt install -y msmtp msmtp-mta mailutils

# Edit /etc/msmtprc:
sudo tee /etc/msmtprc > /dev/null <<'MSMTP'
defaults
auth           on
tls            on
tls_starttls   on
tls_trust_file /etc/ssl/certs/ca-certificates.crt
logfile        /var/log/msmtp.log

account        morphit-alerts
host           smtp.gmail.com
port           587
from           morphit-alerts@<your-domain>
user           morphit-alerts@<your-domain>
password       <app-specific-password>

account default : morphit-alerts
MSMTP

# Permissions: msmtp refuses to run if /etc/msmtprc is readable
# by non-root.
sudo chmod 0600 /etc/msmtprc

# Test:
echo "test from $(hostname)" | mail -s "morphit alert test" your-pager@example.com
```

Caveats:

- Don't put the SMTP password in version control.
- Use an "app-specific" or service-account password, not your
  primary email account password (so a host compromise doesn't
  give the attacker your email).
- Consider a dedicated alerting domain — `alerts@morphit.example`
  with a sieve rule to highlight messages from each of your
  operator hosts.

Once configured, every other section's `mail -s ...` invocation
just works.

### 37.15 Rootkit / malware scanners (optional)

`rkhunter` and `chkrootkit` scan for known signatures of
common rootkits.  False-positive heavy on a non-stock system,
but cheap to run weekly:

```sh
sudo apt install -y rkhunter chkrootkit
sudo rkhunter --update
sudo rkhunter --propupd        # baseline current state
# Schedule:
echo '30 4 * * *  root  /usr/bin/rkhunter --check --skip-keypress 2>&1 | mail -s "rkhunter on $(hostname)" your-pager@example.com' \
  | sudo tee /etc/cron.d/rkhunter-morphit
```

For a paranoid operator: `clamav` for full antivirus.  Heavy
(50-200MB RAM resident) but catches things rkhunter doesn't.
Optional — most Linux compromises are command-line tools an AV
won't recognize.

### 37.16 GRUB / boot hardening

If physical access is in your threat model (on-prem hardware,
colo, anything with a console you don't control), a GRUB
password prevents boot-time `init=/bin/bash` recovery:

```sh
sudo grub-mkpasswd-pbkdf2
# Enter and confirm a strong passphrase.  Copy the
# `grub.pbkdf2.sha512.10000.<long hash>` output line.

# Edit /etc/grub.d/40_custom:
sudo tee -a /etc/grub.d/40_custom > /dev/null <<'GRUB'
set superusers="morphit-boot"
password_pbkdf2 morphit-boot grub.pbkdf2.sha512.10000.<paste your hash here>
GRUB

# Edit /etc/grub.d/10_linux to allow the default boot entry to
# run UNLOCKED (otherwise every reboot prompts for the
# passphrase, which is fine if that's what you want):
sudo sed -i 's/CLASS="--class gnu-linux/CLASS="--unrestricted --class gnu-linux/' /etc/grub.d/10_linux

sudo update-grub
```

Result: normal boot proceeds without prompt; editing the boot
entry (the only path to passing `init=/bin/bash`) requires the
passphrase.

Skip this on a remote VPS — you have no console anyway, and
the boot passphrase just becomes operational friction.

### 37.17 Operator account password discipline

Even with key-only SSH, the OS-level operator account has a
password (used for sudo).  Strengthen:

```sh
# /etc/security/pwquality.conf — minimum quality bar
sudo tee -a /etc/security/pwquality.conf > /dev/null <<'PWQ'
minlen = 14
minclass = 3
maxrepeat = 3
maxsequence = 3
gecoscheck = 1
dictcheck = 1
PWQ

# /etc/login.defs — password aging
sudo sed -i 's/^PASS_MAX_DAYS\t.*/PASS_MAX_DAYS\t365/' /etc/login.defs
sudo sed -i 's/^PASS_MIN_DAYS\t.*/PASS_MIN_DAYS\t1/'   /etc/login.defs
sudo sed -i 's/^PASS_WARN_AGE\t.*/PASS_WARN_AGE\t14/' /etc/login.defs
```

PAM picks up pwquality.conf for `passwd` calls.  Existing
passwords aren't immediately rotated — set a reminder for
yourself to rotate within 30 days of applying this.

### 37.18 Final checklist — what an attacker would try, and your defense

| Attack | Defense | Section |
|---|---|---|
| SSH brute-force | Key-only + fail2ban + AllowUsers | 37.1, 34 |
| Stolen SSH key from operator laptop | MaxAuthTries + key passphrase + revocation drill | 37.1, 7 |
| Kernel privilege escalation via known CVE | unattended-upgrades + needrestart | 37.2 |
| Local kernel exploit needing kernel info disclosure | dmesg/kptr restrict + perf_event_paranoid | 37.3 |
| /tmp dropper + chmod+x exploit | tmp/dev/shm noexec | 37.4 |
| Service compromise → host takeover | systemd ProtectSystem/CapabilityBoundingSet | 37.5 |
| Persistence via cron / authorized_keys / systemd | auditd watches on each | 37.6 |
| AppArmor escape | (limited applicability — we run unconfined Node) | 37.7 |
| Postgres password sniff via MD5 | scram-sha-256 | 37.8 |
| File tampering after compromise | AIDE nightly diff + offsite baseline | 37.9 |
| Secret leak from world-readable .env | chmod 600 + age encryption | 37.10 |
| Disk theft | LUKS full-disk encryption | 37.11 |
| Backup theft → offline crack | age-encrypted backups | 37.12 |
| Reverse-shell exfiltration | UFW egress allowlist (relay host only) | 37.13 |
| Silent-failure of any of the above | msmtp + cron-driven alerting | 37.14 |
| Known rootkit signature | rkhunter weekly | 37.15 |
| Console-level recovery / init=/bin/bash | GRUB password | 37.16 |
| Sudo password brute | pwquality + login.defs | 37.17 |
| Name-squatting brand grab | Layer 7 high-value name policy | 18, 38 |
| Name-squatting enumeration | Layer 8 sequential pattern detector | 18, 38 |
| Bot signup flood | Altcha PoW + per-IP spacing + BunkerWeb rate limits | 18, 32 |
| Forged X-Forwarded-For for rate-limit bypass | trusted-proxy IP allowlist | 32 |
| Mass account creation drain | global daily ceiling + LOW_BALANCE alert | 18 |

If your threat model warrants it, also consider:

- A dedicated **bastion host** that's the only thing allowed
  to SSH into the production host (UFW: deny SSH from anywhere
  except the bastion's IP).
- A **separate read-replica Postgres** for query-heavy
  analytics so the production database serves only the
  indexer's writes.
- **Hardware security keys** (YubiKey) for SSH instead of
  on-disk private keys.
- **Audit-log shipping** to a separate "log host" so an
  attacker who roots the production box can't tamper with
  the evidence trail.
- **2-of-3 multisig BLURT operator accounts** — operationally
  more friction but a single key compromise no longer drains
  the relay (currently aspirational; tracked in
  `docs/REVISIT-LIST.md`).

**These are NOT requirements.** §37.1 through §37.17 alone put
you well above 95% of self-hosted Linux servers on the public
internet.  Apply them in order, test each, and stop when you
hit your operational risk tolerance.

### 37.19 Verification checklist — prove each defense actually fires

A hardening pass that wasn't verified isn't a hardening pass.
Ansible reporting success, a service starting cleanly, an
sshd reload not throwing an error — none of these prove the
defense itself works.  Each check below is a concrete command
that fails fast if the corresponding subsection didn't take
effect.

Run from your laptop unless noted; "host" means the morphit
server.

**SSH posture (§37.1):**

```sh
# Root login disabled
ssh root@host                 # should fail: "Permission denied (publickey)"

# Password auth disabled
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    youruser@host             # should fail: "Permission denied"

# Verify the actual sshd_config the daemon is running with
ssh youruser@host sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication)'
# Expect: permitrootlogin no
#         passwordauthentication no
#         kbdinteractiveauthentication no
```

**Network surface (§34, §37.13):**

```sh
# Only expected ports should be open externally
nmap -Pn -p 1-65535 host      # expect: 22, 80, 443 only

# Postgres NOT reachable externally (§37.8)
psql -h host -U morphit_indexer -d morphit_indexer
# expect: connection timeout, NOT a password prompt
```

**Trusted-proxy CIDR (§32) — the asymmetric footgun:**

From an IP NOT in `MORPHIT_RELAY_TRUSTED_PROXY_IPS`, send a
spoofed X-Forwarded-For and verify the relay does NOT trust it
for rate-limiting purposes.  Easiest way: hit a rate-limited
endpoint from your real IP, then hit it again with a spoofed
XFF claiming a different IP; the second request should be
rate-limited too (proving the relay is reading the socket
peer, not the XFF):

```sh
# Replace the URL with your relay's actual rate-limited endpoint
for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sI -H "X-Forwarded-For: 198.51.100.$i" \
         https://yourinstance.example/v1/relay/account/availability/test
done | grep -E 'HTTP|x-ratelimit'
# Expect: 429 (or rate-limit header decrementing) after a few
# requests, NOT 200 for all 10 with a fresh counter per XFF.
```

If every request returns 200 with a fresh rate-limit budget,
your trusted-proxy CIDR is too wide and any user can forge XFF
to bypass rate limiting.

**Secrets file hygiene (§37.10):**

```sh
ssh host 'ls -l /etc/morphit/'
# Expect: env files 0640, owned by root:morphit
#         keystore 0600, owned by morphit:morphit
#         directory itself 0750 root:morphit
```

**Service state (§37.6, §37.9, §37.14, §34):**

```sh
ssh host 'sudo systemctl is-active auditd fail2ban morphit-relay morphit-indexer'
# Expect: active × 4

ssh host 'sudo systemctl list-timers | grep -E "morphit-backup|certbot"'
# Expect: both timers scheduled, next run within the configured window

ssh host 'sudo aide --check' | head -5
# Expect: "AIDE found NO differences" or matching the count from
# the initial baseline.  Mismatch = something changed since baseline.

ssh host 'sudo ufw status'
# Expect: Status: active, with the expected ALLOW rules

ssh host 'sudo fail2ban-client status sshd'
# Expect: Currently failed: <small number>; ban list visible
```

**Squatter defense (§38.7) — the env vars are actually loaded:**

```sh
ssh host 'sudo systemctl show morphit-relay -p Environment | tr " " "\n" | grep MORPHIT_RELAY_'
# OR if /etc/morphit/relay.env is the EnvironmentFile:
ssh host 'sudo grep -E "SIGNUP_DAILY_CEILING|CREATE_SPACING_MINUTES|ALTCHA_TRIGGER_COUNT|ALTCHA_MAXNUMBER|HIGHVALUE_NAME_POLICY|HIGHVALUE_SHORT_NAME_THRESHOLD|SEQUENTIAL_DETECTOR_ENABLED|SEQUENTIAL_THRESHOLD|SEQUENTIAL_WINDOW_MS|SEQUENTIAL_MIN_PREFIX" /etc/morphit/relay.env'
# Expect: 10 lines matching the §38.7 diamond-hardened values.

# Confirm the relay actually parsed them — hit /v1/relay/limits or
# whatever your relay's introspection endpoint surfaces.  At
# minimum, journalctl should show the relay logging its loaded
# config on boot:
ssh host 'sudo journalctl -u morphit-relay --since "1 hour ago" | grep -E "ceiling|altcha|sequential"'
```

**Backup actually wrote + actually went off-host (§31, §37.12):**

```sh
# Local backup dir has recent backups
ssh host "ls -la $(grep BACKUP_DIR /etc/morphit/backup.env | cut -d= -f2 | tr -d \"'\")"

# Off-host destination has them too
ssh backups@your-backup-host 'ls -la /morphit/' | head -10
# Expect: recent .age files; size > 0; mtime within the last 24h

# Spot-test decryption with the age key (NOT on the morphit host!)
age -d -i /path/to/backup.key /tmp/sample-backup.sql.gz.age | head
# Expect: the start of a pg_dump (-- PostgreSQL database dump --)
```

**Application surface — relay + indexer respond + serve the right
JSON:**

```sh
curl -sf https://yourinstance.example/v1/instance | jq '.disabled_assets'
# Expect: an array (may be empty); confirms the indexer is up,
# /v1/instance is responding, and the cp6 disabled_assets field is
# wired.

curl -sf https://yourinstance.example/v1/relay/health
# Expect: 200 + JSON; confirms BunkerWeb is proxying to the relay
# and the relay is alive.
```

If any check above fails, fix that subsection before moving on
— a partial hardening pass with one broken layer is worse than
honest about the gap, because operational decisions will be
made assuming the layer is in place.

### 37.20 Active-key defense-in-depth — beyond the OS baseline

Subsections 37.1–37.19 above harden the **operating system** the
relay runs on.  This subsection layers on top: even after the OS
baseline is in place and verified, the active key still sits in
the relay's process memory and on disk (encrypted).  The items
below add successive layers above the OS so that compromise of
the OS itself doesn't immediately mean compromise of the key.

Each item declares: **why it helps**, **what it costs**, and
**when it makes sense to add it**.  The ordering is roughly by
value-per-effort — early items are cheap and high-value; later
items are operationally heavier but raise the ceiling further.

**The baseline starting point assumed by this subsection:**

- §3 boot-time passphrase ceremony with `systemd-creds`
- §37.5 systemd process / capability hardening (`PrivateTmp`,
  `ProtectSystem=strict`, etc.)
- §37.7 AppArmor profile for `morphit-relay`
- §37.10 secrets-file hygiene (mode `0400`, owned by
  `morphit-relay`, AIDE-monitored via §37.9)
- §3 in-process key-handling discipline (KDF buffer zeroed
  after use, decrypted WIF only in JS string scope)

Do not start on the items below until the baseline is in place
and the §37.19 verification checklist passes.  Layering
defense on top of a broken baseline is wasted effort.

#### 37.20.1 — YubiKey HMAC-SHA1 challenge-response as boot passphrase

**Why it helps.**  Today, the boot-time passphrase is something
the operator types.  An attacker with hypervisor access to the
VPS can power-cycle the box and wait for an auto-restart with a
cached passphrase — or, if the operator is using `systemd-creds`
encrypted with the TPM, hope to extract the credential.  Adding
a YubiKey challenge-response step means the relay literally
cannot decrypt its envelope without the physical YubiKey
inserted in a USB port.  The challenge lives in the boot
script; the YubiKey computes HMAC-SHA1(challenge, slot-2-secret)
and the result is the passphrase.

**What it costs.**

- Hardware: $45 for a YubiKey 5 (USB-A or USB-C variant — either
  works; YubiKey 5 NFC also works if you want the NFC option).
  Order TWO.  One stays plugged into the server; one is the
  backup, stored offline in a safe.  Both keys must be
  programmed with the SAME slot-2 secret so they're
  interchangeable.
- Setup time: ~1 hour.  Mostly programming the YubiKey slot via
  `ykman` + writing the unlock script that calls `ykchalresp`
  and pipes the result into `systemd-creds`.
- Operational change: at boot, the relay won't come up until
  the YubiKey is plugged in.  This means **unplanned reboots
  require physical access** (or a known-trusted remote-KVM
  with KVM-over-IP smart-card passthrough).  Plan accordingly.

**When it makes sense.**  As soon as the relay is on a
production server you don't physically touch daily.  The
defense is strongest precisely when the operator is NOT in the
data center — which is when remote reboots are the threat.

**Operational caveat — paper backup of the challenge response.**
Program the YubiKey slot-2 secret OFF-DEVICE first (compute the
secret on your laptop with `dd if=/dev/urandom bs=20 count=1 |
xxd -p`), then load it into both YubiKeys.  Mail an envelope
containing the hex secret to yourself (paper, multi-location).
A lost-AND-stolen pair of YubiKeys is not fatal: regenerate
from the paper backup onto new YubiKeys.

**Source.**  No code change required.  Wire as a boot-script
addition that runs before `systemctl start morphit-relay`.
Reference implementation:

```bash
#!/bin/sh
# /usr/local/sbin/morphit-relay-unlock-with-yubikey.sh
# Run by the operator interactively at boot, before starting
# the morphit-relay service.  Touches the YubiKey (you'll see
# the LED blink — press the button when it does), computes the
# challenge response, and feeds it into the relay's encrypted
# envelope passphrase.

set -eu

CHALLENGE_FILE=/etc/morphit/yubikey-challenge
CRED_NAME=morphit-relay-passphrase

if [ ! -f "$CHALLENGE_FILE" ]; then
  echo "ERROR: $CHALLENGE_FILE missing — see §37.20.1" >&2
  exit 1
fi

# Compute response; ykchalresp blocks until the user touches
# the YubiKey button.
CHALLENGE=$(cat "$CHALLENGE_FILE")
RESPONSE=$(ykchalresp -2 "$CHALLENGE")

# Pipe into systemd-creds to recreate the encrypted credential
# for this boot only.  The credential lives in tmpfs and is
# wiped when the service stops.
echo -n "$RESPONSE" | systemd-creds encrypt --name="$CRED_NAME" \
  - /run/credentials/morphit-relay/passphrase

systemctl start morphit-relay
echo "✓ morphit-relay started"
```

#### 37.20.2 — `mlock` + `MADV_DONTDUMP` on the decrypted-key buffer

**Why it helps.**  Standard process-memory hygiene above the
existing memzero-after-use pattern.  `mlock()` pins the live
key page in RAM so the kernel cannot page it to swap (where it
would persist after process termination unless swap is
encrypted).  `madvise(MADV_DONTDUMP)` marks the page as
excluded from coredumps — defense in depth alongside
`fs.suid_dumpable=0` from §37.3 and `LimitCORE=0` from
§37.5.  Together they harden against: (a) post-compromise
swap-scraping, (b) any accidental coredump path that §37.3
missed, and (c) `ptrace`-based memory inspection from a
non-root process running as `morphit-relay`.

**What it costs.**

- Code: ~15 lines in `apps/relay/src/crypto/keyEnvelope.ts`.
  Wrap the decrypted-WIF buffer's lifecycle with libsodium's
  `sodium_mlock()` + `sodium_munlock()`, which call
  `mlock()`/`madvise(MADV_DONTDUMP)` under the hood (and
  `memzero` on `munlock()`).
- Capability: needs `CAP_IPC_LOCK` for the relay process.  Add
  `AmbientCapabilities=CAP_IPC_LOCK` and
  `CapabilityBoundingSet=CAP_IPC_LOCK` to the morphit-relay
  systemd unit (these go alongside the existing §37.5
  capability lockdown).
- Runtime overhead: negligible (a single 32-byte page locked
  for the lifetime of the relay).

**When it makes sense.**  Now.  This is a code change in the
relay's crypto layer that costs an afternoon and tightens the
process-memory model regardless of any OS-level defense state.

**Verification.**

```sh
# From the morphit-relay user, with the relay running:
sudo -u morphit-relay cat /proc/$(pgrep -f morphit-relay)/status | grep -E 'VmLck|CoreDumping'
# Expect:
#   VmLck:    4 kB           (or some multiple of page size)
#   CoreDumping: 0
```

#### 37.20.3 — Out-of-band signature alerts (first 4-6 weeks of operation)

**Why it helps.**  The relay's existing matrix-bot integration
can DM the operator on every chain op the relay broadcasts.
Each DM includes: monotonic sequence number, op type
(`create_claimed_account` / `transfer` / `custom_json`),
recipient account (for transfers), BLURT amount (for
transfers), and timestamp.  The operator sees in real time
whether anything anomalous gets signed.  Catches compromise
within minutes instead of days.

This is observability, not prevention — but on a fresh
production relay where traffic patterns aren't yet baselined,
the asymmetric value of catching a compromise EARLY is huge.
After 4-6 weeks of legitimate-pattern data, the human-eye
oversight stops scaling and you turn it off (or keep it
filtered to anomalies only).

**What it costs.**

- Code: a `postBroadcastAlert(op)` hook in the relay's broadcast
  path.  Wire to the matrix-bot send API.
- Operator attention: ~30 DMs per day from a tester-scale
  relay; check them at coffee, lunch, end of day.  Use a
  dedicated Matrix room so they don't drown other DMs.
- After-baseline tuning: filter to only transfers above $1
  USD-equivalent, or only `create_claimed_account` ops, or
  only ops to recipients not in the operators table.

**When it makes sense.**  Days 0–42 of beta.  Disable (or
filter heavily) after that, once you trust the patterns.

**Source.**  `apps/relay/src/broadcast/` is the natural site;
add an `alertSink` next to the existing logging sinks.

#### 37.20.4 — In-app signer-policy fence

**Why it helps.**  Even if an attacker gets code-execution
inside the relay (e.g., via a malicious upstream npm dependency
breaking past the lockfile pin, or a 0-day in a runtime
dependency), they have to go through the relay's own signer
helper to broadcast — and that helper enforces business-logic
constraints regardless of caller.  The fence rejects:

1. **Transfer recipient not in `operators` table AND not a
   freshly-created signup account.**  The relay legitimately
   transfers BLURT only to (a) other operators (fee splits) or
   (b) brand-new signups (welcome bonus).  An attacker
   transferring to a fresh attacker-controlled account would
   fail (b)'s monotonicity gate.
2. **Per-recipient 24h cumulative cap.**  No single recipient
   can drain more than $X per day.  Configurable per operator.
3. **Global per-minute transfer rate ceiling.**  N transfers
   per minute max; an attacker trying to burst-drain hits this
   wall.
4. **`create_claimed_account` only when ALTCHA + invite-HMAC
   re-verify at sign time.**  Closes a race where the
   anti-bot evidence was valid at request-time but the actual
   sign happens later; the signer re-checks.

This is the natural home for the spending-limit logic
discussed in cp47 kill-switch territory — extended from
"refuse everything" to "refuse anything outside policy."

**What it costs.**

- Code: a new module living alongside the existing
  `apps/relay/src/policy/killSwitch.ts` — call it whatever you
  like (the obvious name is "signerPolicy" but that's a
  bikeshed choice).  ~150–300 lines including smoke coverage.
- Configuration: 4–6 new env vars (`MORPHIT_RELAY_DAILY_RECIPIENT_CAP_USD`,
  `MORPHIT_RELAY_GLOBAL_TPM_CEILING`, etc.).
- Operational tuning: the first week, you'll watch alerts (37.20.3)
  for false-positive policy rejections and tighten/loosen as needed.

**When it makes sense.**  Best paired with 37.20.5 (air-gapped
signer); the policy fence and the signing primitive belong
next to each other.  If 37.20.5 is in your plan, do them
together.  If not, do this alone — still meaningfully reduces
attacker leverage.

#### 37.20.5 — Air-gapped signer process

**Why it helps.**  Today, the active key is decrypted into the
SAME process that handles HTTP requests, talks to Postgres,
runs npm dependencies, parses JSON from chain RPC, etc.  Any
remote-code-execution vector in that process gives the attacker
the key in memory.

Air-gapped-signer means moving signing into a separate process,
running as a separate Unix user, with no network egress, that
talks to the relay over a Unix-domain socket.  The relay sends:
`{"op": "transfer", "to": "alice", "amount": "5.000 BLURT"}`.
The signer (a) re-validates the request against the §37.20.4
policy fence, (b) signs with the active key in its OWN process
memory, (c) returns the signed bytes back over the socket.

Compromise of the relay process now means:
- ✗ No filesystem access to the key envelope (signer's user
  owns the file, mode 0400)
- ✗ No memory access to the decrypted key (separate process,
  different ASLR layout, different cgroup, denied `ptrace`)
- ✓ An RPC interface to the signer — but that interface is
  exactly the §37.20.4 policy fence

The signer process is tiny, audited, deliberately
feature-frozen.  The relay process is allowed to evolve
rapidly; the signer is treated as cryptographic infrastructure.

**What it costs.**

- Code: ~500–800 lines for a minimal signer + socket protocol.
  Could be Rust, Go, or Node.js — whichever the team is most
  comfortable security-auditing.  Rust gets you memory-safety
  guarantees the JS process doesn't have.
- Deployment: a second systemd unit (`morphit-relay-signer.service`),
  a separate Unix user (`morphit-relay-signer`), a Unix socket
  with restrictive permissions, an AppArmor profile
  specifically for the signer that denies network egress
  entirely.
- Operational change: minimal once deployed.  Relay restart no
  longer prompts for the passphrase (signer holds it); signer
  restart does.  Decouples the two lifecycles.

**When it makes sense.**  After 37.20.1–37.20.4 are in place
and stable.  This is the largest architectural change in the
ladder; it should be a deliberate sprint, not a side project.
Target it for around the first quarterly maintenance window.

#### 37.20.6 — Quarterly active-key rotation

**Why it helps.**  Even with all the layers above, a
sufficiently determined attacker who somehow extracts the
active key could sit on it indefinitely, waiting for a
high-value window.  Rotating the key on a calendar bounds the
window: any silent compromise has a 90-day shelf life.

§3 already documents the rotation procedure (owner key signs
the new active-authority on chain; the old active becomes
useless the moment the chain confirms).  This subsection just
says: **make it a scheduled discipline, not a reactive one.**

**What it costs.**

- 30 minutes every 90 days.  Plus the ~10–15 minutes of
  one-time setup to put a calendar reminder somewhere visible
  (Matrix bot pings on the 1st of every 3rd month; cron job
  emails the operator; whatever fits your workflow).
- Owner-key handling for the actual rotation: must remain
  offline.  See §3 for the cold-signing flow.

**When it makes sense.**  Set the calendar reminder today.
First rotation: 90 days after relay first goes live.

#### 37.20.7 — YubiHSM 2 — hardware key isolation

**Why it helps.**  The endgame for hot-signing-key protection.
Replace the encrypted-envelope-on-disk model with a hardware
security module: the active key is generated INSIDE the YubiHSM
and physically cannot be extracted from it.  Every chain op
becomes an API call to the HSM ("here is a 32-byte hash;
please sign it with key handle 0x0042").  The HSM signs and
returns 65 bytes.  The relay never sees the key.

Even root on the box can't read the key.  Even physical
removal of the HSM doesn't yield the key — the HSM stores it
in tamper-resistant silicon and self-destructs the key
material on tamper detection.

YubiHSM 2 supports secp256k1 natively (Blurt's curve), which
not every HSM does.

**What it costs.**

- Hardware: ~$650 for YubiHSM 2.  Buy two — primary + backup
  with the same key material (HSM-to-HSM cloning via the
  audit-log mode).
- Code: ~200–400 lines.  Replace the in-process signer
  primitive (`sign(payload, wif)`) with a YubiHSM RPC call
  (`yubihsm.sign(payload, key_handle)`).  If §37.20.5
  air-gapped-signer is already in place, this slots into the
  signer process — the rest of the relay doesn't change.
- One-time provisioning: ~2 hours to set up the HSM, generate
  the key inside it, configure audit-log mode, mirror to the
  backup HSM.

**When it makes sense.**  When morphit.io has measurable
transaction volume and a real treasury balance that justifies
the capex.  Until then, 37.20.1 (cheap YubiKey for boot
unlock) + 37.20.5 (air-gapped signer) gets you 80% of the way
there for $45 + an afternoon.

#### 37.20.8 — Native Blurt 2-of-2 multi-auth with cold cosigner

**Why it helps.**  Blurt accounts support weighted multi-key
authorities natively.  Set the relay account's active
authority to weight-1 + weight-1, threshold 2: a key on the
relay box (weight 1) AND a key held offline by the operator
(weight 1).  Every broadcast requires BOTH signatures.

Even total compromise of the hot key + the YubiHSM cannot
move funds: the chain rejects single-signature broadcasts on
this account.  The attacker must also compromise the
operator's offline key, which is a different threat model
entirely (physical access to the operator).

**What it costs.**

- Operational: every broadcast must be cosigned offline.  The
  natural pattern is batch-signing: the relay queues ops; the
  operator goes online every 6 hours, reviews the queue,
  cosigns valid ops, and lets the relay broadcast the
  fully-signed bytes.
- That 6-hour batch-sign cadence is fundamentally incompatible
  with on-demand free signups (which expect an ACT mint within
  seconds).  Compatibility options: (a) accept a 6-hour SLA
  on signups, which is awful UX; (b) split the account
  topology so a fast-cycle "signup mint" key is single-sig
  on the relay while a slow-cycle "operator payout" key is
  2-of-2; (c) skip this layer entirely.
- Code: minimal once the multi-auth payload format is
  understood; chain-side support is in place.

**When it makes sense.**  Only if you accept a 6-hour-batch
signup SLA (option b above) or if signup ACT mints have been
delegated to a separate key with its own narrow authority.
Probably skip for v1.0; revisit if a real compromise event
forces the question.

---

### 37.20 — summary table

| # | Item | Cost | Value | When |
|---|---|---|---|---|
| 37.20.1 | YubiKey challenge-response boot passphrase | $45 + 1 hr | High — defeats unattended remote reboot | Now |
| 37.20.2 | `mlock` + `MADV_DONTDUMP` on key buffer | Afternoon | Medium — closes swap + coredump gaps | Now |
| 37.20.3 | Out-of-band signature alerts | 1 day + ops attention | High during beta-1 | Days 0–42 |
| 37.20.4 | In-app signer-policy fence | Week + smoke coverage | High — bounds blast radius | Before/with 37.20.5 |
| 37.20.5 | Air-gapped signer process | Sprint | Very high — isolates key from main process | First quarterly window |
| 37.20.6 | Quarterly active-key rotation | 30 min/90 days | High — bounds silent-compromise window | Calendar from launch day |
| 37.20.7 | YubiHSM 2 — hardware key isolation | $650 + sprint | Maximum — key never extractable | When volume justifies capex |
| 37.20.8 | Native Blurt 2-of-2 multi-auth | Operational complexity | Maximum — but breaks on-demand signups | Probably skip for v1.0 |

The natural sequencing:

- **Week 1 of beta:** 37.20.1 (YubiKey passphrase), 37.20.2
  (`mlock`), 37.20.3 (alerts), 37.20.6 (calendar reminder).
- **Weeks 2–6:** 37.20.4 + 37.20.5 together (policy fence and
  air-gapped signer; they belong next to each other).
- **Quarterly:** 37.20.6 (rotation) fires automatically from
  the calendar reminder.
- **When morphit.io has real volume:** 37.20.7 (YubiHSM 2)
  slots into the air-gapped signer.
- **Probably never (or only after an incident):** 37.20.8.

Don't try to do all of these at once.  Each is a layer; each
needs its own verification step (which is why every subsection
above declared what success looks like).  Layering hardening
without verification at each step compounds risk rather than
reducing it — see §37.19 preamble.


## 38. Diamond-hardened squatter defense — operator playbook

Squatter-driven account creation is the **single largest financial risk** to a Morphit relay. Every successful squatter signup costs the relay ~100 BLURT (the chain's account-creation fee) regardless of who's behind it. An attacker burning $1/day on a residential proxy + automated PoW solver could in theory consume the entire daily ceiling of the relay's runway.

This section is the tactical guide for an operator who wants their relay locked down as tightly as possible against squatters specifically. It complements §18 (which is the reference doc for the layered defense stack) by walking through what to configure, what to monitor, and what to do when you suspect an attack.

### 38.1 Set strict defaults for every squatter-relevant knob

Drop these into your relay's `Environment=` directives or `/etc/morphit/relay.env`:

```ini
# Layer 2 — global daily ceiling.  50 is the default; lower is
# tighter.  For a small instance starting out, 25 is a sensible
# tighter posture.
MORPHIT_RELAY_SIGNUP_DAILY_CEILING=25

# Layer 3 — per-IP spacing.  60 minutes (default) lets a real
# user retry-after-failure but bounds an attacker on one IP to
# 24 signups per day even if they bypass everything else.
MORPHIT_RELAY_CREATE_SPACING_MINUTES=60

# Layer 5 — Altcha proof-of-work trigger.  Default 3 = first
# two attempts frictionless.  Drop to 2 to cap real-user
# friction at "1 invisible 1s PoW for the third+ attempt"
# while making attackers pay PoW from the second invite onward.
MORPHIT_RELAY_ALTCHA_TRIGGER_COUNT=2

# Layer 7 — high-value name policy.  STRICT.  This is the
# whole point of Layer 7 — moderate or off mode here negates
# the protection.
MORPHIT_RELAY_HIGHVALUE_NAME_POLICY=strict

# Layer 7 short-name threshold.  4 is default.  Lower to 3 if
# you want to allow 4-char names (some operators may want this
# for branding).  Higher (5+) blocks more — at the cost of
# shutting out users with legitimately short preferred names.
MORPHIT_RELAY_HIGHVALUE_SHORT_NAME_THRESHOLD=4

# Layer 8 — sequential pattern detector.  Enable.
MORPHIT_RELAY_SEQUENTIAL_DETECTOR_ENABLED=true

# Layer 8 — block on the THIRD sequential signup (default).
# Lower to 1 to block on the SECOND if you've seen any
# sequential signups in the last 24 hours.
MORPHIT_RELAY_SEQUENTIAL_THRESHOLD=2

# Layer 8 — rolling window.  Default 1 hour.  Longer (e.g.
# 86_400_000 = 24h) catches slow attackers who pace signups
# beyond an hour.  Tradeoff: more memory + more false-positive
# risk on legitimate batch workflows.
MORPHIT_RELAY_SEQUENTIAL_WINDOW_MS=3600000
```

Restart the relay:

```sh
sudo systemctl daemon-reload
sudo systemctl restart morphit-relay.service

# Verify the boot log shows your settings took effect:
journalctl -u morphit-relay.service --since "1 minute ago" \
  | grep -E 'highvalue|sequential|loaded'
```

### 38.2 Monitor what's getting blocked

The relay logs structured events for every Layer 7 and Layer 8 rejection. Watch them:

```sh
# Live tail — useful during incident response
journalctl -u morphit-relay.service -f \
  | grep -E 'highvalue_name_rejected|sequential_pattern_rejected'

# Last 24 hours — count by category
journalctl -u morphit-relay.service --since "24 hours ago" \
  | grep -oE 'classification":"[a-z_]+"' \
  | sort | uniq -c | sort -rn

# Last 24 hours — bucket keys involved (Layer 8 only)
journalctl -u morphit-relay.service --since "24 hours ago" \
  | grep sequential_pattern_rejected \
  | grep -oE 'bucketKey":"[^"]+"' \
  | sort | uniq -c | sort -rn
```

Volume baseline for a healthy relay: **near zero** of either event type. A handful per week of `highvalue_name_rejected` is normal (curious users testing what's allowed). Anything above ~10/day is worth investigating.

### 38.3 The five attacker patterns to recognize

| Pattern | Signature | Defense |
|---|---|---|
| **Brand grab** | Single signup attempt for `nike` / `bitcoin` / `apple` from a fresh IP | Layer 7 `dictionary_brand` rejection |
| **Short-name farm** | Bursts of 3-char and 4-char names, varied prefixes, one IP | Layer 7 `short_name` rejection |
| **Sequential enumeration** | `acct001`, `acct002`, `acct003` — same /24, within hours | Layer 8 `sequential_numeric_suffix` rejection |
| **Distributed enumeration** | Same naming pattern but spread across many /24 buckets | Layer 7 catches each one if pattern matches; ceiling caps total |
| **Slow drip** | One signup per hour, varied long-prefix names, no obvious pattern | Daily ceiling caps it; LOW_BALANCE alert (Layer 6) raises the flag |

### 38.4 Periodic audit — review recent registrations

Schedule a weekly review. Look at your relay account on `blocks.blurtwallet.com` and inspect the last 50 `create_claimed_account` operations. Watch for:

- Names that look generic / patterns / brand-adjacent (e.g., `mybitcoin01`, `cryptotrader-fast`). These are squatter resale candidates that slipped past Layers 7-8 because they had long prefixes.
- Accounts with NO follow-up activity (no posts, no Morphit orders, no transfers). A real user creates an account TO USE it; squatters never log in.
- Sequential creation timestamps suspiciously close together.

If you see a pattern that's NOT being caught:

1. Add the specific names + close variants to `RESERVED_NAMES` in `apps/relay/src/policy/name.ts`. (Pre-launch this is a normal ad-hoc tightening; post-launch you'd issue a release.)
2. If they share a brand or dictionary signature, add to `DICTIONARY_BRANDS` or `COMMON_DICTIONARY` in `apps/relay/src/policy/highValueName.ts`.
3. Re-deploy and the next attempt at the pattern is blocked.

### 38.5 If you suspect an active attack

1. **Don't panic-flip the kill-switch yet.** Layers 7 + 8 may already be doing their job. Check the structured logs first (38.2 above). If the volume of `highvalue_name_rejected` and `sequential_pattern_rejected` spikes, the system is working correctly and the attacker is wasting their request budget.

2. **Check the operator-balance alert (§16).** If the relay's BLURT is draining despite the rejections, attempts ARE getting through. Most likely cause: the attacker is using long-prefix non-pattern names that pass Layer 7 + 8. In that case, drop to:

   ```ini
   # Tighten Layer 8 to block on the SECOND sequential signup
   MORPHIT_RELAY_SEQUENTIAL_THRESHOLD=1

   # Lower the ceiling to bound damage
   MORPHIT_RELAY_SIGNUP_DAILY_CEILING=10
   ```

3. **If you're STILL bleeding** — flip the kill-switch:

   ```ini
   MORPHIT_RELAY_SIGNUP_ENABLED=false
   ```

   Restart. Investigate. Don't re-enable until you understand what changed.

4. **Refill BLURT only when needed.** Don't auto-top-up during an active attack — you're handing the attacker more ammunition. Wait until the kill-switch is on, attack subsides, then refill.

5. **Post-incident: tighten the dictionaries.** Add the actual names the attacker registered to `RESERVED_NAMES` and `DICTIONARY_BRANDS` so they can't be re-registered.

### 38.6 Network-layer defenses against squatters

Layer 7-8 defenses run AFTER an attacker reaches the relay. Network-layer defenses keep them away in the first place. In addition to §32 (BunkerWeb) and §34 (UFW + fail2ban), a squatter-paranoid operator can:

**a. Run the relay behind Tor / I2P only, with a clearnet mirror sitting in front.**  
Squatters typically don't route through anonymity networks because the latency disrupts their automation. A relay only reachable via Tor onion address has natural friction. The clearnet mirror (BunkerWeb terminating TLS, proxying to localhost relay) gives normal users a fast path; the Tor address gives privacy-conscious users a private path. Both are documented in `RUN-A-MORPHIT-NODE.md` §11.

**b. Country-block from low-cost residential-proxy markets.**  
This is operator's-call and ethically fraught — Morphit serves global users. But if you're under active attack from a specific country and your user base is regional, a temporary `BLACKLIST_COUNTRY` (BunkerWeb) or geoip-based UFW rule narrows the attacker's options without breaking your real users.

**c. ASN-block from cheap-VPS providers.**  
Some hosting providers (DigitalOcean, Hetzner, OVH on certain ranges) are over-represented in attack traffic because they're cheap and don't scrutinize signups. Block their ASNs at the BunkerWeb layer (§32 advanced WAF tuning, item 5) if you see concentrated traffic from one. Real users almost never connect from a hosting provider's ASN — they're on residential ISPs.

**d. Require a `Referer:` header for `/v1/account/invite`.**  
Browsers send this; bots often don't. Easy to bypass for a serious attacker but kills the lazy ones. Add to BunkerWeb:

```yaml
# Reject /v1/account/invite without a referer
USE_BLOCK_REFERRER_NONE=yes
BLOCK_REFERRER_NONE_URL=/v1/account/invite
```

This is friction-only — not a real defense — but it filters the bot-script-using-curl tier of attacker.

### 38.7 The "diamond-hardened" preset

If you want maximum squatter defense and accept the user-friction tradeoff, copy this entire block into your relay's environment:

```ini
# === DIAMOND-HARDENED SQUATTER DEFENSE ===
# Documented in OPERATIONS.md §38.7.  Apply when squatter-
# defense is your primary concern and you accept moderately
# higher friction for real users.

# Layer 1 — kill-switch starts ON (signups enabled)
MORPHIT_RELAY_SIGNUP_ENABLED=true

# Layer 2 — tight daily ceiling
MORPHIT_RELAY_SIGNUP_DAILY_CEILING=20

# Layer 3 — 90 minutes between same-IP signups
MORPHIT_RELAY_CREATE_SPACING_MINUTES=90

# Layer 5 — PoW from the SECOND invite onward
MORPHIT_RELAY_ALTCHA_TRIGGER_COUNT=2
# 2x the default difficulty — ~2s on modern phone, ~4s on old
MORPHIT_RELAY_ALTCHA_MAXNUMBER=4000000

# Layer 7 — strict; 5-char minimum
MORPHIT_RELAY_HIGHVALUE_NAME_POLICY=strict
MORPHIT_RELAY_HIGHVALUE_SHORT_NAME_THRESHOLD=5

# Layer 8 — block on SECOND sequential, 24-hour window
MORPHIT_RELAY_SEQUENTIAL_DETECTOR_ENABLED=true
MORPHIT_RELAY_SEQUENTIAL_THRESHOLD=1
MORPHIT_RELAY_SEQUENTIAL_WINDOW_MS=86400000
MORPHIT_RELAY_SEQUENTIAL_MIN_PREFIX=3
```

The user-visible cost of this preset:

- 5-char minimum names (rejects 3 + 4-char preferred names some users want)
- Real users see Altcha PoW from their second attempt
- 90-minute lockout if a user fails their first signup attempt
- 20 max signups per day (caps growth — tighten OFF as your instance proves stable)

If your goal is "absolute minimum BLURT loss, accept user friction," this is the configuration. Watch the rejection logs (§38.2) to make sure you're not accidentally blocking a flood of legitimate users; if you are, dial back §38.1 instead.

---

## 39. Operating a home-hosted instance — concerns specific to running on residential internet

This section is the operator-grade reference for issues that come up only when your Morphit instance is running on a residential internet connection (Pi or laptop in the operator's house, as opposed to a rented VPS).

The grandma-friendly setup walkthrough — CGNAT detection, DDNS hostname registration, port forwarding, lid-closed laptop config, UPS sizing, dynamic IP + Let's Encrypt — is in `docs/RUN-A-MORPHIT-NODE.md` §3a, the section new operators read before §4. **§3a is the soup-to-nuts walkthrough; THIS section is the ongoing-operations reference for after the box is online.**

### 39.1 Uptime monitoring over a flaky home link

A residential internet connection has more outages and more ISP-driven hiccups than a datacenter VPS. Two changes from the standard monitoring posture (OPERATIONS.md §13 references `/v1/health`):

- **Don't alert on a single failed probe.** Configure your uptime monitor (UptimeRobot, BetterStack, self-hosted Uptime Kuma, etc.) to alert only after **3 consecutive failures with at least 2-minute spacing**. Cable / DSL / fiber transient drops of 30-90s are routine and don't represent a real outage.
- **Probe from multiple geographic regions.** If you only probe from one location and that probe shares a backbone with your home ISP, you'll see false outages during peering disputes. Most monitoring services let you pick 2-4 probe locations for free; pick ones in different continents.

### 39.2 Restarting after power loss

Cover all three legs of the restart story:

- **The hardware** — BIOS / UEFI "AC Power Recovery" set to "Power On" or "Last State" (laptop), or default Pi auto-boot. Verified at install time per `RUN-A-MORPHIT-NODE.md §3a.6`.
- **The OS services** — `systemctl is-enabled morphit-indexer morphit-relay morphit-backup.timer` should all return `enabled`. If any are `disabled`, run `systemctl enable` for them. Test annually by issuing `sudo reboot` and confirming everything comes back without manual intervention.
- **The encrypted-key passphrase** — if you're using the encrypted-envelope form for `MORPHIT_RELAY_ACTIVE_KEY_FILE` (`apps/relay/scripts/encrypt-active-key.ts`), the relay prompts for the passphrase on stdin at boot. **A reboot from outside your house — for example, the UPS dying during a long outage — will leave the relay waiting for the passphrase indefinitely.** Two mitigations:
  1. Configure the relay's systemd unit with `StandardInput=tty-force` AND a wrapper service that emails you when the relay is stuck waiting for input. You then SSH in and supply the passphrase.
  2. OR run the relay with the **plaintext-WIF form** of the key file (mode 0400, owned by the relay user, on an encrypted filesystem volume). This trades passphrase-at-boot for at-rest disk encryption. For a single-operator residential deployment, the disk-encryption-at-rest posture is usually appropriate; the passphrase-at-boot ceremony was designed for VPS deployments where the disk substrate isn't yours.

### 39.3 ISP terms of service

Most consumer ISPs technically prohibit "running servers" in their TOS, but enforcement is essentially never on real-world traffic — they care about open relays, port-25 spam abuse, and copyright-infringing torrent endpoints. A small Morphit instance handling normal user traffic is invisible to ISP enforcement. **Realistic risk: very low.** The two failure modes that have actually triggered ISP attention historically:

- **Sustained heavy upload bandwidth** (>50% of advertised cap, sustained over weeks). Morphit's bandwidth profile is bursty and small (a few KB per orderbook fetch, infrequent). Not a concern unless you have thousands of users.
- **Outbound spam reports.** This requires the relay's account to be compromised in a way that lets attackers send abusive ops, which is a security incident regardless of where you're hosted. Standard incident response (§7) applies.

If your ISP does send a TOS warning, the diplomatic response is "I'm running a personal cryptocurrency wallet — I can move it to a dedicated hosting provider if needed." Most ISP TOS teams accept this and don't escalate. The diplomatic-but-firmer response is "I'm running a small piece of software for my personal use and consuming less than 1% of my advertised bandwidth; please point me at the specific TOS clause you believe I'm violating." Most contact-center staff don't have an answer to that.

### 39.4 What if you move?

A home-hosted instance is tied to your physical address until you do something about it. When you move:

- **If you're moving to a new home WITH a non-CGNAT ISP**, the migration is straightforward: power down at the old address, transport the hardware, plug in at the new address, repeat the §3a.4 router port-forward setup (the new router won't have your old rules), update DDNS (the script will pick up the new IP automatically within 5 minutes). Total downtime: a few hours during transport.
- **If you're moving to an apartment with CGNAT or a hotel for a month**, you can't host from there. Two options: (a) leave the hardware powered on at the old address temporarily if you have a friend/family at that address willing to host it for a few weeks, or (b) migrate to a VPS. The migration to VPS is documented at the end of `RUN-A-MORPHIT-NODE.md §3` (Option B's "you can always migrate to a Pi later" sentence inverted) — set up the new VPS using §5–§9 of the grandma doc, point your domain at the VPS's IP (Path A in §4), and decommission the home machine. Your operator account, your fees account, and your reputation all stay the same — **users see no change** because nothing about the service identity is tied to the IP.

### 39.5 Cleartext local Postgres traffic in a residential WiFi context

OPERATIONS.md §14 establishes that the indexer and relay listen on `127.0.0.1` only (loopback) and Postgres connections are loopback-only. **This is still correct for home hosting** — but home networks have a quirk worth flagging.

If your Pi or laptop is on a wired ethernet connection to your router, Postgres-on-loopback is exactly as private as on a VPS. **If it's on WiFi**, the situation is the same as long as Postgres is bound to `127.0.0.1` (which is the default per `RUN-A-MORPHIT-NODE.md §7`'s setup) — WiFi doesn't change anything because the loopback interface doesn't traverse WiFi.

The risk only emerges if you accidentally bind Postgres to `0.0.0.0`. Verify periodically:

```
ss -tlnp | grep 5432
# Expected: 127.0.0.1:5432 only
# DANGER:   0.0.0.0:5432 or *:5432 (then any device on your home WiFi can connect)
```

A misconfigured Postgres on WiFi exposes it to every guest device on your network — including the smart TV that has a known CVE you didn't patch. Loopback-only is the right binding.

### 39.6 IPv6 considerations

Many residential ISPs are IPv6-by-default now. Two quick checks:

- **Does your home have a public IPv6 prefix?** Run `ip -6 addr show` on the Morphit machine; look for an address in `2000::/3` range (i.e., starts with a 2 or 3). If yes, you have IPv6.
- **Does your DDNS provider support IPv6?** DuckDNS does — pass `&ipv6=$(curl -s6 ifconfig.co)` to the update URL. Dynu does. No-IP charges extra for it.

If you have IPv6 and want to publish AAAA records alongside your CNAME, add an `AAAA` record at `@` and `www` pointing at your machine's GUA address. Modern browsers prefer IPv6 when available, which can improve user experience for IPv6-enabled visitors and reduce the load on your IPv4 NAT.

Most home operators leave IPv6 disabled at the router level and run IPv4-only — that's also fine. The walkthrough in `RUN-A-MORPHIT-NODE.md §3a` works either way.

### 39.7 Energy-cost monitoring

Optional — but if you're tracking the cost of running your home node:

- **Pi 4** drawing ~5W at idle, ~6W under typical Morphit load. At US average $0.16/kWh, that's `5W × 24h × 365d × 0.001 × 0.16 = $7.01/year`.
- **Old laptop** (10-15 years old) drawing ~20W at idle, ~25W under load. `25 × 24 × 365 × 0.001 × 0.16 = $35.06/year`.
- **Old desktop** (10-15 years old) drawing ~50W idle, ~80W under load. `80 × 24 × 365 × 0.001 × 0.16 = $112.20/year` — at this point, the VPS path is cheaper.

A $20 plug-in power meter (Kill-A-Watt or equivalent) gives you the actual number for your hardware. Worth doing once.

### 39.8 Backups — the off-site copy is mandatory for home operators

OPERATIONS.md §31 documents the daily local Postgres backup (`/home/morphit/backups/`). The companion `RUN-A-MORPHIT-NODE.md §10` has a sidebar emphasizing that for home hosters, **the off-site backup is mandatory, not optional**. The reason is the threat model: a VPS operator who loses the local backup still has the VPS provider's snapshot of the disk. A home operator who loses the local backup to a fire / flood / theft has lost everything.

The recommended off-site backup pattern:

- **Free option (S3-compatible bucket)**: `rclone` to a Backblaze B2 bucket (10 GB free, $0.005/GB/month after; a Morphit DB compresses to under 1 GB). Daily upload added as a step at the end of the systemd backup unit.
- **Privacy-preserving option (encrypted off-site)**: `rclone` with `crypt` backend pointed at the same B2 bucket. The bucket sees only encrypted blobs.
- **Self-hosted option (offsite friend/family)**: rsync over ssh to a relative's NAS or another Pi at a different physical address. Tradeoff: free, but the friend's setup has to stay running too.

Whatever you pick: **test the restore at least once a quarter.** Untested backups have a catastrophic-failure rate; tested ones don't. The procedure is in OPERATIONS.md §31 ("Quarterly restore drill").

### 39.9 Network-level privacy considerations specific to home hosting

A home-hosted Morphit instance leaks **your home's public IP address to every user who connects**. Most users don't care, but for an operator with a public-facing role under their real name, this can be a low-grade privacy concern. Mitigations:

- **Front the instance with a Tor onion service** (covered in OPERATIONS.md §11 reference and `RUN-A-MORPHIT-NODE.md §11`). Users who care can connect via the onion address; the home IP is only revealed to clearnet users. The Tor onion address itself reveals nothing about your home IP.
- **Front the instance with Cloudflare Tunnel.** Cloudflare's IP is what users see; your home IP is only known to Cloudflare. The tradeoff is that you're trusting Cloudflare to relay traffic without logging it long-term — which is a privacy regression for some operators and an improvement for others. Read Cloudflare's data-retention policies before adopting.
- **Move to a VPS.** The VPS provider sees your home IP (because that's where you SSH in from), but users see only the VPS IP. This is the path most operators take when home-hosting visibility becomes a concern.

Whichever you pick, it doesn't have to be permanent. The ability to migrate without disrupting users is the whole point of the federated, no-user-data model.

## 40. Treasury chain-pin + XMR per-payment proofs — broadcasting and verifying

This section is the operator-facing reference for **the
canonical Morphit operator** (currently `@morphit`) to
broadcast and rotate the treasury chain-pin shipped in Part
106 (2026-05-10), corrected in Part 107 (privacy fix —
view key removed from chain-pinned data), and structurally
improved in Part 108++ (per-payment tx_proof verification —
no view key required by any indexer).

If you are a **community operator** running your own
Morphit instance, skip to §40.7.  Part 108++ removed the
previous three-options dilemma: every operator can now
verify XMR fees independently, no shared secret needed.

### 40.1 What the chain-pin does and why it exists

Pre-Part-106, every operator's indexer trusted its own
`MORPHIT_INDEXER_BTC_FEE_ADDRESS` /
`MORPHIT_INDEXER_XMR_FEE_ADDRESS` env vars as gospel.  A
hostile fork could silently change those env vars to a
hostile address and divert all BTC/XMR fees from users on
that instance.  ADR-0011's 2026-05-09 amendment said
"BTC/XMR fees: 100% to treasury (`@morphit-fees`)" — the
**policy** — but **no code enforced the addresses
themselves**.

Part 106 closes that gap by extending the existing signed
`morphit_release_v1` op (already authenticated by the
`@morphit` posting key via the trust anchor pinned in
`apps/web/src/lib/net/config.ts`) with an optional
`treasury` block containing BTC/XMR addresses + amounts.
Every federated indexer prefers the chain-pinned canonical
over its own env-var fallback.  The frontend reads the
same chain-pinned addresses and renders them with copy +
QR + chain-pinned badge.

### 40.2 Three priorities: how Part 108++ realizes them

Morphit's three priorities, in order:

1. **Privacy & anonymity** for users.
2. **Decentralization** — no central authority, no
   chokepoints, every instance fully sovereign.
3. **Grandma-friendly UI/UX** — usable by people who
   have never used crypto.

Pre-Part-108++, XMR verification required the operator
to hold the treasury wallet's private view key in env on
their box.  Even with Part 107's fix (key never on chain),
this still meant **only canonical morphit.io** could
verify XMR fees — community operators inheriting
canonical's chain-pinned address had no view key, so
they faced a three-options dilemma:

- (a) Trust canonical's federated verdict — needed a
  federation-trust path that didn't exist.
- (b) Run their own treasury wallet — deviates from
  canonical, visible in federation.
- (c) Disable XMR fees — cleanest but reduces user
  options.

That dilemma violated priority #2: every community
operator was effectively dependent on canonical
morphit.io's existence and willingness to verify XMR.
Federation tolerates instances disappearing — but only
for the chains an instance can verify locally.  XMR
broke that.

**Part 108++ resolves it** with Monero's standard
per-payment proof mechanism.  The user generates a
proof from their own wallet after paying; any indexer
verifies the proof against the txid + treasury address
using a public Monero block explorer (or a local
`monerod` for maximum independence).  Properties:

- **Privacy:** the proof reveals only "this txid paid
  this address this amount."  No other wallet activity,
  no other payments to the address, no metadata.  The
  user is the only party that holds any verification
  secret (their tx_key, in their own wallet, never
  published).  Indexers hold nothing.
- **Decentralization:** every indexer verifies every
  payment independently using public information.  No
  shared secret, no central instance.  Canonical
  morphit.io is one indexer among many.
- **Grandma-friendliness:** trade-off — the user must
  generate a proof from their wallet (one extra step
  vs. just pasting a txid).  Mitigated by inline
  per-wallet instructions (CLI / GUI / Cake / Feather)
  in 10 locales, expandable on the post-order page.

### 40.3 What ships on the operator's box (Part 108++)

For the canonical morphit.io operator:

- **Public**: BTC address, XMR address, fee amounts.
  These go on chain via `morphit_release_v1`'s
  `treasury` block.
- **Operator-private**: nothing XMR-specific anymore.
  The Part 107-era `MORPHIT_INDEXER_XMR_FEE_VIEWKEY`
  env var was removed entirely in Part 109.  No view
  key lives on any operator's box.

For community operators:

- **Public**: nothing — they inherit canonical's
  chain-pinned XMR address automatically.
- **Operator-private**: nothing.  XMR verification works
  out of the box on every Morphit instance with no
  shared secret.

### 40.4 Choosing your XMR explorer backend

The XMR fee verifier sends `(txid, address, proof)`
over HTTPS to one or more Monero block explorers'
`/api/outputs?txprove=1` endpoint to verify each
per-payment proof.  You choose how many explorers to
ask, and which.

**The default ships with five.**  Multi-explorer
cross-check means the verifier accepts a result only
when all responding explorers agree on the proven
amount.  A single compromised or coerced explorer
cannot lie about a verification.

```bash
MORPHIT_INDEXER_XMR_EXPLORER_URLS=https://xmrchain.net,https://localmonero.co/blocks,https://monerohash.com/explorer,https://exploremonero.com,https://moneroexplorer.org
```

These five all run the
`moneroexamples/onion-monero-blockchain-explorer`
reference codebase — same API surface, same JSON shape.
They are operated by independent parties.  If you want
to add more or use different ones, the only constraint
is API compatibility: the URL must expose
`/api/outputs?txhash=…&address=…&viewkey=…&txprove=1`
returning JSON with `status: "success"` and
`data.outputs[*]: {amount, match}`.

> **Monero note — that `viewkey=` parameter does NOT carry a real
> view key.** It is the `onion-monero-blockchain-explorer`'s own
> API naming. Combined with `txprove=1`, the explorer interprets
> the value as a **single-use transaction proof** (the
> `OutProof…` string the payer generated with `get_tx_proof`),
> NOT a wallet view key. Morphit never holds, transmits, or logs
> a treasury view key — there isn't one (see §12 and §40.2). The
> indexer puts the payer's per-payment proof in that slot; it
> reveals only "this txid paid this address this amount" and
> nothing else about any wallet. (The indexer also logs only the
> explorer's base URL, never the full URL with the proof.)

**Explorers known to be API-compatible (5):**
- `https://xmrchain.net` (reference instance, run by
  moneroexamples)
- `https://localmonero.co/blocks`
- `https://monerohash.com/explorer`
- `https://exploremonero.com`
- `https://moneroexplorer.org`

**Explorers known to be NOT API-compatible:**
- `https://xmrscan.org` — different codebase
- `https://blockchair.com/monero` — different API
  shape, no `txprove=1` endpoint
- `https://monero.bar` — lightweight network-health
  dashboard (block height, difficulty, hashrate, pool
  distribution, RPC node status); useful for operators
  eyeballing the state of the Monero network and for
  spot-checking RPC node availability, but **not** a
  full block explorer and does NOT expose the
  `/api/outputs?txprove=1` endpoint.  Do not add to
  `MORPHIT_INDEXER_XMR_EXPLORER_URLS`.  Bookmark it as
  a sidebar tool, not a verification source.

**Option 1: Public multi-explorer (default).**  No
operator setup.  Cross-check among five independent
parties.  Each one sees the same per-payment data
(txid, address, proof) at verification time; none of
them accumulates any wallet-level secret (the proof is
single-payment).  This is the recommended default for
new operators.

```bash
# (this IS the default — set explicitly only if
# you want to customize the list)
MORPHIT_INDEXER_XMR_EXPLORER_URLS=https://xmrchain.net,https://localmonero.co/blocks,https://monerohash.com/explorer,https://exploremonero.com,https://moneroexplorer.org
```

**Option 2: Self-hosted Monero block explorer + local
monerod (priority #2 maximum independence).**  Spin up
your own monerod and `monero-block-explorer` on the
operator box; point the verifier at localhost.  No
third-party sees any verification request.

```yaml
# In docker-compose.yml on your operator box:
# (Pin both images to specific tags — never `:latest` — for
#  reproducibility.  Update by checking the upstream pages for
#  current stable releases before each deploy.)
services:
  monerod:
    # Check https://github.com/sethforprivacy/simple-monerod-docker/pkgs/container/simple-monerod
    # for the current Monero stable release; pin to that tag.
    image: ghcr.io/sethforprivacy/simple-monerod:v0.18.4.1
    volumes:
      - ./monero-data:/home/monero/.bitmonero
    command:
      - --restricted-rpc
      - --rpc-bind-ip=0.0.0.0
      - --rpc-bind-port=18081
      - --confirm-external-bind
      - --no-igd
      - --enable-dns-blocklist
    networks: [internal]

  block-explorer:
    # Locally-built image (the `build:` directive below compiles
    # from source).  Pin the local tag so `docker compose up`
    # rebuilds deterministically when the upstream changes.
    image: morphit-xmrblocks:v1
    build:
      context: https://github.com/moneroexamples/onion-monero-blockchain-explorer.git
    depends_on: [monerod]
    command: >
      ./xmrblocks
        --daemon-url=monerod:18081
        --enable-json-api
        --enable-ssl
    ports:
      - "127.0.0.1:8081:8081"
    networks: [internal]

networks:
  internal:
    driver: bridge
```

Then in `/etc/morphit/indexer.env`:

```bash
MORPHIT_INDEXER_XMR_EXPLORER_URLS=https://localhost:8081
```

(Use HTTPS via a local reverse proxy with a self-signed
cert, or relax the HTTPS-only check by patching your
own build — the public default enforces HTTPS for
network-bound calls; for `localhost`, the constraint is
defensible-in-depth, not security-critical.)

What this option costs: ~50 GB disk for the Monero
chain, sync time ~3-7 days, and ongoing block ingestion
(low CPU, but persistent).  For high-volume operators
who care about priority #2 maximum independence, this
is the right answer.

**Option 3: Hybrid (recommended for security-conscious
operators).**  Multiple explorer URLs combining
self-hosted + public.  Detect manipulation: if your
self-hosted result ever disagrees with the public ones,
you have evidence.

```bash
MORPHIT_INDEXER_XMR_EXPLORER_URLS=https://localhost:8081,https://xmrchain.net,https://localmonero.co/blocks
```

**How disagreement is handled.**  The verifier requires
all RESPONDING explorers to agree on the proven amount.
Non-responding explorers (timeout, network error,
circuit-breaker open) are skipped — they don't block
the verification, and the breaker handles per-explorer
flakiness.  If responding explorers disagree, the
verifier returns `rejected` with reason
`explorer disagreement on proven amounts: A vs B`.
This is conservative: a mismatch could indicate a
compromised explorer, a chain reorg, or simply a stale
view at one of the explorers.

**Failure modes by config size.**

- 1 explorer: any outage stops XMR verification (orders
  wait in `pending_external`).  Any compromise lies
  undetected.
- 2 explorers: outages tolerated by either; lies
  detectable as long as both don't lie identically.
- 5 explorers (default): high availability + strong
  cross-check.  Two would need to be compromised
  collude-style to lie undetected.
- 5 explorers including self-hosted: as above PLUS
  the self-hosted result is authoritative-to-you;
  divergence is evidence rather than a coin-flip.

### 40.5 Generating the keys (one-time, before first broadcast)

You need:

- A dedicated **Bitcoin address** for treasury inflows.
- A dedicated **Monero address** for treasury inflows.
- A way to **broadcast a signed `custom_json` op from
  `@morphit`** — typically a Blurt-aware wallet (Vessel,
  blurt-cli, beempy, dblurt-script).

**Bitcoin address.**  Create a fresh wallet for treasury
inflows.  Native segwit (`bc1q...`) is recommended for
the lower miner fees.  Whatever Bitcoin wallet you use
is fine; just make sure the seed is backed up offline
and the spending key never reaches the morphit.io
production server.

**Monero address.**  Create a fresh wallet for treasury
inflows:

```
$ monero-wallet-cli --generate-new-wallet=morphit-treasury.wallet \
                    --restore-height=<recent-block> \
                    --mnemonic-language=English

# Inside the prompt:
[wallet]: address                # → primary address (95 chars, starts with `4`)
[wallet]: spendkey               # NEVER publish this — it lets anyone spend your funds.
[wallet]: seed                   # Back up the 25-word seed offline.
```

**Note (Part 108++):** you do NOT need to extract or
record the wallet's private view key.  Earlier parts of
this guide (105/106/107) instructed operators to put the
view key in env; that's no longer required.  XMR
verification uses per-payment proofs from users'
wallets, which are checked against the public address
alone.

**Note (Part 110): the previous `verify-xmr-viewkey.ts`
diagnostic-only helper script was retired in Part 110.**
Wallet creation can be sanity-checked end-to-end with the
modern flow: configure `MORPHIT_INDEXER_XMR_FEE_ADDRESS`,
restart the indexer, have a trusted contact send a small
test payment with a tx_proof, and submit it through the
real Morphit UI.  If the order verifies, your XMR
configuration is correct.  This exercises the exact code
path users will hit.

### 40.6 Broadcasting the release op

Once your keys are ready, build a `morphit_release_v1`
payload carrying the `treasury` block.  Full shape
(Part 108++ — no viewkey field):

```json
{
    "version": "1.0.0",
    "hash_manifest": {
        "/index.html": "sha256-...",
        "/_app/...": "sha256-..."
    },
    "endpoints": {
        "blurt_rpc": [
            "https://rpc.blurt.blog",
            "https://rpc.beblurt.com"
        ]
    },
    "signature": "(optional)",
    "treasury": {
        "btc": {
            "address": "bc1q...",
            "satoshis": 416
        },
        "xmr": {
            "address": "4...",
            "piconero": "781250000"
        }
    }
}
```

A helper script generates this for you interactively:

```
cd /opt/morphit
tsx apps/indexer/scripts/release-build-payload.ts > release.json
```

The script:

- Walks you through entering each field
- Validates against the same rules the indexer enforces
- Refuses to emit any payload containing a 64-hex
  string (defense against accidentally including a view
  key — the Part 107 invariant carried forward into
  108++)
- Does NOT prompt for the view key

Sign + broadcast as a `custom_json` op:

```javascript
{
    required_auths: [],
    required_posting_auths: ["morphit"],
    id: "morphit_release_v1",
    json: "<the JSON string you just built>"
}
```

Sign with the `@morphit` posting key.  This key lives
**off** the morphit.io production server, on a personal
machine you trust — typically your laptop with a
Blurt-aware wallet.

### 40.7 For community operators (running your own Morphit instance)

Default behavior:

1. **Leave `MORPHIT_INDEXER_BTC_FEE_ADDRESS` empty.**
   Your indexer inherits the chain-pinned canonical
   BTC address.  Users on your instance pay BTC fees
   to the canonical Morphit treasury.

2. **Leave `MORPHIT_INDEXER_XMR_FEE_ADDRESS` empty.**
   Your indexer inherits the chain-pinned canonical
   XMR address.

3. **You still get your 90% operator share on
   BLURT-paid fees** (separate pipeline, see §28).
   Only BTC/XMR fees go 100% to canonical's treasury;
   BLURT fees split 90/10 to you.

4. **Choose your XMR explorer backend** (§40.4 above).
   Default ships with FIVE independent Monero explorers
   (xmrchain.net, localmonero.co/blocks,
   monerohash.com/explorer, exploremonero.com,
   moneroexplorer.org) running the same reference codebase
   but operated by independent parties.  Multi-explorer
   cross-check rejects single-source manipulation.
   Self-host a `monero-block-explorer` Docker container
   against your own `monerod` for maximum independence.

5. **No view key needed, no shared secret needed.**
   Every Morphit instance verifies XMR fees
   independently using user-submitted per-payment
   proofs.  Canonical morphit.io has no privileged
   role in your verification.

If you want to run your own treasury wallet (collect
XMR fees yourself instead of forwarding to canonical),
fill in `MORPHIT_INDEXER_XMR_FEE_ADDRESS` with your
own address.  Your XMR-fee orders won't appear on
canonical's orderbook (the txid paid your address, not
canonical's), but you keep 100% of the XMR.  Federation
health monitors comparing `/v1/release.treasury` will
show the divergence.  Permitted but visible.

### 40.8 Verifying federation propagation

Within a few minutes of broadcasting a release op,
every federated indexer should reflect the new pin in
its `/v1/release` response.  Verify by polling:

```
# Canonical
curl https://morphit.io/api/indexer/v1/release | jq .treasury

# Community operators (from /v1/instances list)
for instance in alice.example.com bob.example.org; do
    echo "== $instance =="
    curl -sS "https://$instance/api/indexer/v1/release" | jq .treasury
done
```

Each response should show the **same** `treasury`
object you broadcast.  Specifically, every response's
`treasury.xmr` should have **only `address` and
`piconero` fields** — no `viewkey` (Part 107
invariant; the response is passed through `stripViewkey`
on output as defense-in-depth).

### 40.9 Rotating the addresses later

To rotate the BTC or XMR address (e.g., new wallet),
broadcast a **new** `morphit_release_v1` op with
updated treasury fields.  The indexer's `/v1/release`
query returns "the most recent valid release," so the
new op supersedes the previous one within ~3 seconds.

**Don't rotate frequently.**

- BTC: rarely (every few years, if at all).
- XMR address: as needed.  Pre-Part-108++, XMR
  rotation also required a coordinated env-update.
  Now it's just the chain-pin update.  No more env
  coordination overhead.

If you do rotate, **announce it on the Matrix channel
`#agorise:matrix.org` and the canonical Morphit Blurt
account's blog before broadcasting**, so users in
flight can wait out the transition.

### 40.10 The keys reference table

| Key | Account | Where it lives | Used for | Frequency |
|---|---|---|---|---|
| Posting | `@morphit` | YOUR personal laptop, OFF the morphit.io server | Release ops (incl. treasury chain-pin) | Rare (4-12/year) |
| Active | `@morphit-relay` | `/etc/morphit/keys/relay-active.key`, mode 0400, encrypted envelope | Account creation, operator payouts, all relay broadcasts | Constant (hundreds/day at scale) |
| Owner (both accounts) | `@morphit` and `@morphit-relay` | Paper, in a safe, off any networked machine | Active-key rotation, posting-key rotation | Almost never |
| **XMR private view key** | **morphit-treasury wallet** | **NOT REQUIRED on operator box (Part 108++; env var removed Part 109).**  Stays in your wallet's seed/keystore for personal access only. | None — diagnostic script retired Part 110. | **Generated once, never read by indexer code, never on chain, never in any API.** |
| Posting (per-user, syndication) | Each individual user | User's own keychain / in-page WIF unlock | Their own syndication posts | Per-user |
| **XMR tx_proof** | **The user, per payment** | User's own Monero wallet (CLI / GUI / Cake / Feather) | Verifying THIS specific XMR fee payment.  Submitted with the order op, per payment. | Per-payment, user-generated |

The treasury chain-pin specifically uses the
`@morphit` posting key — the key you keep off the
production server.

The Part 108++ design eliminates the operator's role
in holding any XMR-specific secret on the production
box.  The user is the only party that holds anything
verification-related (their per-payment tx_key in their
own wallet, used to generate proofs and never
published).

### 40.11 Migration path from Part 107

If you're upgrading from a Part 107 deployment:

1. **Pull and deploy** the Part 109 release.  Your
   `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` env var line (if
   present) is harmless — zod ignores unknown env vars,
   so the line is silently dropped.  You can delete the
   line from `/etc/morphit/indexer.env` next time you
   touch the file.
2. **Restart the indexer.**  It will start using
   `MoneroProofFeeVerifier` (per-payment proofs) instead
   of the deleted `MoneroExplorerFeeVerifier` (view-key
   decryption).
3. **No coordinated migration with users.**  Pre-Part-
   108++ XMR orders that submitted only a txid will be
   rejected by the new structural validator with reason
   `tx_proof_required_for_xmr` — but pre-launch, there
   are zero such orders, so this is a no-op.
4. **You can safely remove your view key from env**
   once you're confident the new path works.  Or leave
   it; it's ignored.
5. **Optional:** if you want priority #2 maximum
   independence, set up a self-hosted Monero block
   explorer (§40.4 option 2) and switch
   `MORPHIT_INDEXER_XMR_EXPLORER_URLS` to point at it.

Pre-launch (zero live instances), there's no user-
impact migration concern.  Post-launch, the same
upgrade path would require coordinating with users
about the new tx_proof requirement — but that
coordination simply doesn't apply yet.

## 41. Federation-cost attribution — only paying for ops served by YOUR instance

**Origin:** Part 111 (2026-05-10).

### What this section covers

How Morphit's federation guarantees that each
operator's relay pays only for the ops that route
through their own instance — not for ops happening
on every other operator's instance in the
federation.

### The problem (pre-Part-111)

Morphit's federation worked correctly for the
orderbook layer: every indexer in the federation
saw every Morphit op on chain, and every indexer
kept a consistent view of orders, feedback, and
operator-attribution events.

But the **payout** layer had a gap.  Five payout
categories are queued to `relay_pending_transfers`
(which the relay drainer broadcasts):

| Payout | Trigger |
|---|---|
| Account creation chain fee | HTTP endpoint on the relay (`/v1/account/create`) |
| Welcome bonus (20 BLURT) | `morphit_feedback_v1` op on chain with `order_permlink` |
| Low-balance dust refill (~1 BLURT) | Scanner finds user active in last N days, balance below threshold |
| Operator-payout (90% of BLURT fee) | `morphit_order_v1` on chain with `operator_tag` |
| Loyalty milestone BP delegation | Cumulative-BLURT-paid threshold crossed |

Account creation was correctly scoped — an HTTP
endpoint on the relay, so only the operator the
user actually hit pays.  The other four were not:
each was triggered by an on-chain op that EVERY
indexer in the federation processed independently.
Result: N operators in the federation → N× relay
spend on every payout-triggering op.

### The fix (Part 111)

Use the existing `operator_tag` field on order ops
as the gate.  Each operator's indexer compares the
op's `operator_tag` against the indexer's own
`MORPHIT_INSTANCE_OPERATOR_TAG` env var; only the
operator named on the op queues the payout.  Other
operators see the op, record it for orderbook /
audit / federation-consistent global state, and
skip the payout queue insert.

Why this is robust:
- The 90% operator-payout flows to the operator
  named by `operator_tag`.  The same operator is
  also obligated for the consequences (10% treasury
  via the BLURT fee transfer, welcome bonus,
  refills, loyalty BP).  Economic alignment: a
  spammer attacking by attributing to a victim
  operator must pay 90% of every fee TO that
  victim — net break-even, zero leverage.
- `operator_tag` is already on chain, already
  public.  Zero new on-chain data, zero new privacy
  leak.

### Configuration

`MORPHIT_INSTANCE_OPERATOR_TAG` in
`morphit.config.env`.  Canonical morphit.io uses
`morphit`.  Community operators pick their own
(e.g. `example-community`).

```
# In morphit.config.env:
MORPHIT_INSTANCE_OPERATOR_TAG=morphit
```

Wizard step 16 captures this at `morphit-ops init`
time.  Same step is reachable via
`morphit-ops edit → Operator tag (federation attribution)`
for ongoing maintenance.

### Conservative default

If `MORPHIT_INSTANCE_OPERATOR_TAG` is unset, the
indexer treats every op as "for a different
operator" and queues NO payouts.  The relay does
nothing.  Better to pay nothing than to pay for
ops you can't prove are yours.

A community operator who skips wizard step 16 will
see their indexer running fine (orderbook updates,
chat works, fee verification works) but their
relay queue will be empty.  The fix is to set the
env var and restart the indexer, or re-run
`morphit-ops edit` to pick the section.

### Community-operator onboarding sequence

For a community operator standing up
`example-community.com`:

1. **Pick your operator tag.**  Wizard step 16
   prompts, and now defaults it to your domain
   (e.g. `example-community.com`) — a great choice
   since it's unique and recognizable.  Constraints:
   lowercase letters, digits, dots, underscores,
   hyphens; 1..64 chars.  Cannot equal an
   already-registered operator's tag, and cannot be
   a project-reserved name (`morphit`, `agorise`,
   etc.) — the wizard blocks those up front.  This
   tag is also what's shown publicly: your entry in
   the federated `/instances` directory and on your
   `/about-this-instance` page.  It's permanent once
   registered.
2. **Register on chain.**  Run `npx morphit-ops
   register`.  It broadcasts
   `morphit_operator_register_v1` from your operator
   account claiming the tag — using
   `MORPHIT_INSTANCE_OPERATOR_TAG` (so the registered
   tag and your earnings tag match by construction).
   First-come-first-served; once claimed, no other
   operator can use it.  Before broadcasting it shows
   the public key your active key derives to; if the
   account is low on **mana** (Blurt's transaction
   fuel) it tells you how much BLURT Power to add
   (≈50 BP floor) and lets you retry in place after
   powering up — no full re-run.  See the
   morphit_operator_register_v1 handler in
   apps/indexer/src/indexer/handlers for the op shape.
   - To verify the saved key at any time:
     `npx morphit-ops show-key` prints the public key
     it derives to (never the private key) so you can
     compare it to your account's active authority on
     a Blurt explorer.
3. **Restart the indexer.**  It will pick up the
   new env var and start queueing payouts for ops
   carrying your tag.
4. **Verify with a test order.**  Have a trusted
   contact post an order through your instance,
   pay the BLURT fee, then leave feedback citing
   the order.  Your relay should queue +20 BLURT
   welcome bonus + 1 BP delegation + the 90%
   operator-payout share.  Check
   `SELECT * FROM relay_pending_transfers WHERE
   recipient = '<that account>'`.

If steps 2-4 yield nothing in the queue, the most
likely cause is steps 1+3 — verify the env var
matches what `morphit_operator_register_v1`
claimed.

### What "served by us" means in practice

An order op carrying `operator_tag: <YOUR-tag>` was
submitted by a user through your instance's
frontend (the frontend writes the tag from your
indexer's `/v1/instance.operator_tag` endpoint).
That op's payouts (operator-payout, loyalty BP,
welcome bonus if the user leaves feedback) are
your relay's obligation.

An order op carrying `operator_tag: <other-tag>`
was submitted through another instance.  Your
indexer records it (for federation-consistent
orderbook + audit) but queues nothing.

### What stays consistent across the federation

These are NOT gated by operator tag — every
indexer in the federation keeps the same view:

- `orders` table contents (modulo `operator_tag`
  column, which records which operator served the
  op)
- `feedback` table contents
- `account_loyalty.cumulative_blurt_paid` per user
- `account_loyalty_milestones` rows
- `accounts.first_trade_complete_at` per user
- `operator_attribution_events` per op

Why: these are "what happened on chain" — every
indexer must agree to keep the orderbook and audit
trail consistent.

These ARE gated:

- `relay_pending_transfers` rows (only your
  operator's are queued by your indexer)
- `operator_payouts` audit rows (only when you
  queue the payout)
- `operator_earnings` rolling totals (only your
  operator's)

### Tests + smoke

- `apps/indexer/test/indexer/federationScopeGate.test.ts`
  — 11 scenarios covering all 4 gating sites with
  both gate-passes and gate-fails flows.
- `operatorEarnings.attributeBlurtFeeToOperator`
  returns `attributed_other_instance` when the op's
  tag doesn't match — no DB writes at all in that
  branch.
- `loyalty.trackVerifiedBlurtFee` extended with
  `orderOperatorTag` + `instanceOperatorTag` params;
  gates both first-fee welcome BP and milestone
  delegation queue inserts.
- `feedback` handler looks up cited order's
  `operator_tag` from the `orders` table; queues
  welcome bonus only when matched.
- `lowBalanceScanner.selectCandidates` JOINs
  `orders.operator_tag = MY tag` instead of the
  pre-Part-111 `EXISTS ops` (which matched
  federation-wide activity).

**Smoke-suite troubleshooting — `ERR_MODULE_NOT_FOUND` on
`@morphit/asset-registry` (or other `@morphit/*` packages).**
If `bash scripts/run-smokes.sh` fails several runners (typically
single digits — the count drifts each release as smokes are added
or refactored — examples that have historically been affected:
`order-handler`, `rss-orderbook`, `rss-orderbook-xml-validate`,
`edit`, `edit-rpc`, `surface-invariant`) all with the same
`ERR_MODULE_NOT_FOUND` error referencing a `@morphit/*` package,
the cause is that `npm install` hasn't been run at the workspace
root yet, so the symlinks under `node_modules/@morphit/*` that
the workspace setup creates don't exist.  Fix:

```bash
cd ~/morphit      # repo root, where the root package.json lives
npm install --no-audit --no-fund
```

Then re-run the smoke suite; the affected runners should pass.
This is NOT a code regression — `@morphit/asset-registry`,
`@morphit/indexer-client`, `@morphit/operator-config`, etc. are
internal packages whose source lives under `packages/`, and the
workspace symlinks under `node_modules/@morphit/*` are what let
`apps/*/src/...` resolve their imports.  Pure environment setup.


### Migration

Schema migration v30 adds `orders.operator_tag TEXT`
column (nullable) + index `(operator_tag, account,
created_at)`.  Pre-Part-111 rows stay NULL.  Pre-
launch reality (zero live instances) means this
compat is for replay tests only.

### What "rotating to a new operator account" means

If a community operator decides to switch from
`example-community-old` to `example-community-new`,
they must:

1. Register the new tag on chain.
2. Update `MORPHIT_INSTANCE_OPERATOR_TAG` in
   `morphit.config.env` and restart.
3. Update their frontend's `/v1/instance.operator_tag`
   response (the indexer does this automatically
   from the same env var).

Past ops with the old tag continue to credit the
old operator account (operator-payouts already
queued before the switch will still broadcast).
Going forward, new ops will carry the new tag and
queue to the new operator's relay.

Currently no automated migration — operators
rotating accounts handle this manually.  Filed in
REVISIT-LIST as a defer until operational evidence
of demand.

---

## Trade-only asset configuration

**Audience:** operators deciding which trade-only assets their
instance accepts, and how transaction-explorer links resolve for
single-network trade-only assets (BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP) and multi-network trade-only assets (USDT, USDC, DAI).

### How to set this (two paths)

**At install time (recommended):** the `morphit-ops init`
wizard, step 13 "Trade-only asset policy" (Part 122 cp22), walks
through every shipped trade-only asset and asks per-ticker
whether to enable it.  Default for each is YES per Memory #25.
The wizard emits the right
`MORPHIT_INDEXER_DISABLED_ASSETS=` line into
`morphit.config.env` — no manual env-file editing needed.

**Post-deploy on a running instance, in your browser (cp116):**
visit `/admin/setup-wizard` on your domain.  Toggle the asset
checkboxes (BTC/XMR/BLURT are locked enabled — core federation
assets), hit Copy, paste the emitted line into
`morphit.config.env`, restart the indexer
(`docker compose restart indexer`).  Read-only page — never
mutates your server, no auth-gating needed.  See
RUN-A-MORPHIT-NODE.md "Browser setup-wizard" for the full
operator UX.

**Post-deploy or on an existing instance:** edit
`MORPHIT_INDEXER_DISABLED_ASSETS` directly in
`/etc/morphit/morphit.config.env` (or wherever your
`EnvironmentFile=` points) and restart the indexer service.
Browsers see the change at most 5 minutes after restart (the
`/v1/instance` response carries a 5-minute `Cache-Control`
header).

All three paths write the same env var — the CLI wizard, the
browser wizard, and direct env-file editing differ only in
ergonomics.  Re-running any path overwrites the previous
value; there is no merge logic.

### Disabling specific assets instance-wide

**`MORPHIT_INDEXER_DISABLED_ASSETS`** — comma-separated list of
uppercase tickers from the canonical asset registry.  Orders
posted with a disabled asset are rejected at handler time with
`reason: 'asset_disabled_on_instance'`.  Default empty (every
canonical-registry asset is enabled).

**Parser is tolerant** of whitespace, mixed case, and trailing
commas — write it however you like, the indexer normalizes
internally.  All of these produce the same `['USDT']` value:

```bash
MORPHIT_INDEXER_DISABLED_ASSETS="USDT"
MORPHIT_INDEXER_DISABLED_ASSETS="usdt"
MORPHIT_INDEXER_DISABLED_ASSETS=" USDT "
MORPHIT_INDEXER_DISABLED_ASSETS="USDT,"
```

Multi-coin examples:

```bash
# Refuse one specific asset
MORPHIT_INDEXER_DISABLED_ASSETS="USDT"

# Refuse USDC (Part 122 cp30 — operators preferring to avoid
# a Circle-custodial stablecoin)
MORPHIT_INDEXER_DISABLED_ASSETS="USDC"

# Refuse DAI (Part 122 cp31 — operators preferring to keep
# stablecoin exposure to USDT/USDC only; see ADR-0029)
MORPHIT_INDEXER_DISABLED_ASSETS="DAI"

# Refuse Bitcoin Cash (privacy-focused operators may prefer
# BTC + XMR only)
MORPHIT_INDEXER_DISABLED_ASSETS="BCH"

# Refuse Litecoin (some operators specialize in Bitcoin +
# privacy-coin trading without BTC-fork variants)
MORPHIT_INDEXER_DISABLED_ASSETS="LTC"

# Refuse Dash (operators preferring to limit the surface to
# Bitcoin-family chains without masternode-coordinated coins)
MORPHIT_INDEXER_DISABLED_ASSETS="DASH"

# Refuse Dogecoin (Part 122 cp33 — brand/audience choice for
# operators specializing in serious-money trading; see ADR-0030)
MORPHIT_INDEXER_DISABLED_ASSETS="DOGE"
# Refuse only ZEC trades (cp39):
MORPHIT_INDEXER_DISABLED_ASSETS="ZEC"
# Refuse only ARRR trades (cp41):
MORPHIT_INDEXER_DISABLED_ASSETS="ARRR"
# Refuse only DCR trades (cp43):
MORPHIT_INDEXER_DISABLED_ASSETS="DCR"
# Refuse only SOL trades (cp45):
MORPHIT_INDEXER_DISABLED_ASSETS="SOL"
# Refuse only ETH trades (cp47):
MORPHIT_INDEXER_DISABLED_ASSETS="ETH"
# Refuse only XRP trades (cp49):
MORPHIT_INDEXER_DISABLED_ASSETS="XRP"

# Refuse two assets (any future stablecoin additions)
MORPHIT_INDEXER_DISABLED_ASSETS="USDT,DAI"

# Refuse three or more
MORPHIT_INDEXER_DISABLED_ASSETS="USDT,DAI,USDC"

# Refuse BCH AND USDT (focus on every other Category-B asset
# plus BTC/XMR/BLURT)
MORPHIT_INDEXER_DISABLED_ASSETS="BCH,USDT"

# Refuse all four Bitcoin-fork variants (still keeps BTC + XMR
# + BLURT + USDT + USDC + DAI + ZEC + ARRR + DCR + SOL + ETH +
# XRP enabled)
MORPHIT_INDEXER_DISABLED_ASSETS="BCH,LTC,DASH,DOGE"
# Refuse all centralized + partly-centralized stablecoins (privacy-pure operator stance: BTC/XMR/BLURT/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL/ETH/XRP only)
MORPHIT_INDEXER_DISABLED_ASSETS="USDT,USDC,DAI"

# Refuse everything that isn't BLURT + XMR + BTC (all 13
# Category-B trade-only assets disabled — keeps only the three
# Category-A fee-payable assets)
MORPHIT_INDEXER_DISABLED_ASSETS="USDT,USDC,DAI,BCH,LTC,DASH,DOGE,ZEC,ARRR,DCR,SOL,ETH,XRP"

# Whitespace-tolerant — same result as above
MORPHIT_INDEXER_DISABLED_ASSETS="USDT, DAI, USDC"

# Accept everything (default — same as omitting the var)
MORPHIT_INDEXER_DISABLED_ASSETS=""
```

**Federation semantics:** disabling an asset is OPERATOR-level,
not user-level.  Orders for a disabled asset still appear in
your instance's read-only orderbook feeds (the chain history
is shared across the federation), but your indexer refuses to
accept NEW orders for that asset from your own users.  Users
who prefer an instance that supports the asset switch to a
different Morphit operator — federation is the point.

**Do NOT disable Category-A (fee-payable) assets — BTC, XMR,
BLURT.**  The wizard step 13 cannot offer this (the
Category-B filter excludes them).  An operator manually editing
the env file to set `MORPHIT_INDEXER_DISABLED_ASSETS="BLURT"`
or similar will create a weird state: trading in that asset is
disabled, but listing-fee payments in that asset still work
(fee_method enum is independent of asset registry per Memory
#23).  Don't do this.  If you genuinely don't want to trade
BTC/XMR/BLURT, you're running a different product — start by
opening an issue describing what you actually want.

**Why the canonical morphit.io ships with USDT enabled:** active
traders find dollar-stable assets useful for parking value
between trades, and the canonical operator's stance is to
support that use case.  Operators with different focuses
(privacy-pure, XMR-only, BTC-and-BLURT-only, etc.) override.
The federated marketplace keeps trading; users self-route to
the instance whose asset list matches their preferences.

The parser tolerance is pinned in CI by
`apps/indexer/scripts/disabled-assets-parse-smoke.ts` (12
scenarios covering empty, one coin, multi-coin, whitespace,
case, leading/trailing commas, double commas, etc.) so future
refactors can't accidentally break the multi-coin form.

Memory #23 (BLURT/BTC/XMR-only for listing fees) and Memory #25
(default-on + operator override for new assets) together define
this knob's posture.  See `docs/adr/0023-usdt-multi-network.md`
for the full design.

### Frontend surfaces showing your instance's disabled-assets list (Part 121 cp6)

The `MORPHIT_INDEXER_DISABLED_ASSETS` value flows through the
indexer's `/v1/instance` endpoint as the `disabled_assets` field
(an uppercase-tickers JSON array, e.g. `["USDT"]` or
`["USDT","DAI"]`).  Two frontend pages surface this to users:

- **`/about-this-instance`** renders a "This instance's asset
  policy" section that shows the current disabled-assets list.
  Empty array → emerald "None — this instance accepts every
  tradable asset"; populated → "USDT (operator-disabled on this
  instance; tradeable on peer instances)".  Federation note in
  the same panel reminds users that peer instances' orders still
  appear in the orderbook regardless — the gate is only on NEW
  orders posted from THIS instance.
- **`/run-a-node`** carries a "Your instance, your asset policy"
  panel explaining the env var to prospective operators with
  three pillars (default-on, opt-out env var, federation stays
  intact) and a pointer back to this section of OPERATIONS.md.

The `/operators` page does NOT yet surface peer-instance
disabled-assets badges — that's deferred to a follow-on Part
(needs a v33 schema migration to cache `disabled_assets` per
peer in the `known_instances` table + a federation-probe
handler extension).  Until then, users can check each peer's
own `/about-this-instance` to see its stance.  REVISIT-LIST §A
"Federation-probe extension for peer-instance asset stance"
tracks this deferral.

If you change `MORPHIT_INDEXER_DISABLED_ASSETS` after deploy,
clients will see the new value at most 5 minutes later (the
`/v1/instance` response carries `Cache-Control: public,
max-age=300`).  Restart the indexer service for the env-var
change to take effect; the cache header is the only delay
between restart and full propagation to all browsers.

### Per-network explorer URL overrides (USDT only)

USDT is Morphit's first multi-network asset (ERC-20, TRC-20,
SPL, BEP-20).  Each network has a bundled-default explorer URL
template (etherscan.io for ERC-20, tronscan.org for TRC-20,
solscan.io for SPL, bscscan.com for BEP-20).  Operators
running self-hosted alternatives override per-network via
frontend env vars exposed in the instance config payload.

Operator-config example for a privacy-conscious operator:

```bash
# Override all four — point at self-hosted instances
MORPHIT_FRONTEND_USDT_ERC20_CHAT_LINK_URL="https://my-self-hosted-blockscout.example.org/tx/{txid}"
MORPHIT_FRONTEND_USDT_TRC20_CHAT_LINK_URL="https://my-self-hosted-tron.example.org/#/transaction/{txid}"
MORPHIT_FRONTEND_USDT_SPL_CHAT_LINK_URL="https://my-self-hosted-solana.example.org/tx/{txid}"
MORPHIT_FRONTEND_USDT_BEP20_CHAT_LINK_URL="https://my-self-hosted-bsc.example.org/tx/{txid}"
```

`{txid}` is the placeholder substituted at render time with
the lowercased transaction ID.  SPL txids are base58 and
case-preserved; the others are hex and lowercased.

If you choose to disable USDT instance-wide via
`MORPHIT_INDEXER_DISABLED_ASSETS=USDT`, the per-network
explorer config has no effect on your instance.

### BCH chat-link explorer URL override (Part 122 cp21)

BCH is single-network (mainnet only), so there's just one
explorer URL to think about.  Like the BTC and XMR chat-link
URLs (`MORPHIT_FRONTEND_BTC_CHAT_LINK_URL`,
`MORPHIT_FRONTEND_XMR_CHAT_LINK_URL`), the BCH override is a
single env var:

```bash
# Default (bundled) — operators don't need to set anything to
# get this behavior:
# MORPHIT_FRONTEND_BCH_CHAT_LINK_URL="https://blockchair.com/bitcoin-cash/transaction/{txid}"

# Override to a self-hosted or alternative explorer:
MORPHIT_FRONTEND_BCH_CHAT_LINK_URL="https://my-self-hosted-bch-explorer.example.org/tx/{txid}"
```

`{txid}` is the placeholder substituted at render time with the
lowercased transaction ID (BCH txids are hex like BTC).
Validation: must be `https://`, must contain literal `{txid}`,
must parse as a URL after substitution.  An invalid template
fails indexer startup with a clear error message rather than
silently shipping a broken link.

Alternative BCH explorers operators can point at — surveyed at
Part 122 cp21 addition time:
- https://blockchair.com/bitcoin-cash (bundled default)
- https://www.blockchain.com/explorer
- https://bitinfocharts.com/bitcoin%20cash/explorer/
- https://bchexplorer.info/
- https://www.oklink.com/bch
- https://bch.tokenview.io/
- https://blockexplorer.one/bitcoin-cash/mainnet
- https://explorer.cloverpool.com/bch

The ops-cli wizard step 12 (Chat-link external explorer URLs)
asks for the BCH URL after BTC and XMR with the same
probe-reachability check that the BTC and XMR URLs get.

If you choose to disable BCH instance-wide via
`MORPHIT_INDEXER_DISABLED_ASSETS=BCH`, the chat-link config
has no effect on your instance.

### LTC chat-link explorer URL override (Part 122 cp24)

LTC is single-network (mainnet only), so there's just one
explorer URL to think about.  Same shape as BTC/XMR/BCH:

```bash
# Default (bundled) — operators don't need to set anything to
# get this behavior:
# MORPHIT_FRONTEND_LTC_CHAT_LINK_URL="https://litecoinspace.org/tx/{txid}"

# Override to a self-hosted or alternative explorer:
MORPHIT_FRONTEND_LTC_CHAT_LINK_URL="https://my-self-hosted-ltc-explorer.example.org/tx/{txid}"
```

`{txid}` is the placeholder substituted at render time with the
lowercased transaction ID (LTC txids are hex like BTC).
Validation: must be `https://`, must contain literal `{txid}`,
must parse as a URL after substitution.  Invalid templates
fail indexer startup with a clear error message.

Alternative LTC explorers operators can point at — surveyed at
Part 122 cp24 addition time:
- https://litecoinspace.org (bundled default — community-led,
  mempool.space-style, no JS tracking, open-source)
- https://blockchair.com/litecoin
- https://www.oklink.com/litecoin
- https://bitinfocharts.com/litecoin/explorer/
- https://chain.so/LTC
- https://blockexplorer.one/litecoin/mainnet
- https://ltc.tokenview.io/

The ops-cli wizard step 12 (Chat-link external explorer URLs)
asks for the LTC URL after BTC, XMR, and BCH with the same
probe-reachability check that the others get.

If you choose to disable LTC instance-wide via
`MORPHIT_INDEXER_DISABLED_ASSETS=LTC`, the chat-link config
has no effect on your instance.

### DASH chat-link explorer URL override (Part 122 cp27)

DASH is single-network (mainnet only), so there's just one
explorer URL to think about.  Same shape as BTC/XMR/BCH/LTC:

```bash
# Default (bundled) — operators don't need to set anything to
# get this behavior:
# MORPHIT_FRONTEND_DASH_CHAT_LINK_URL="https://insight.dash.org/insight/tx/{txid}"

# Override to a self-hosted or alternative explorer:
MORPHIT_FRONTEND_DASH_CHAT_LINK_URL="https://my-self-hosted-dash-explorer.example.org/tx/{txid}"
```

`{txid}` is the placeholder substituted at render time with the
lowercased transaction ID (DASH txids are hex like BTC).
Validation: must be `https://`, must contain literal `{txid}`,
must parse as a URL after substitution.  Invalid templates
fail indexer startup with a clear error message.

Alternative DASH explorers operators can point at — surveyed at
Part 122 cp27 addition time:
- https://insight.dash.org/insight/ (bundled default — official
  Dash project, community-led, open-source, no third-party ads)
- https://explorer.dash.org/insight/
- https://blockchair.com/dash
- https://chainz.cryptoid.info/dash/
- https://www.oklink.com/dash
- https://bitinfocharts.com/dash/explorer/
- https://blockexplorer.one/dash/mainnet
- https://www.blockchain.com/explorer/assets/dash
- https://dash.tokenview.io/

The ops-cli wizard step 12 (Chat-link external explorer URLs)
asks for the DASH URL after BTC, XMR, BCH, and LTC with the same
probe-reachability check that the others get.

If you choose to disable DASH instance-wide via
`MORPHIT_INDEXER_DISABLED_ASSETS=DASH`, the chat-link config
has no effect on your instance.

### Single-network chat-link explorer URL overrides for DOGE / ZEC / ARRR / DCR / SOL / ETH / XRP (Part 122 cp33 / cp39 / cp41 / cp43 / cp45 / cp47 / cp49)

Each of these assets shares the same single-network, single-URL
shape as the BCH/LTC/DASH sections above.  The pattern is:

```bash
# Default (bundled — operators don't set anything to get this)
# MORPHIT_FRONTEND_<TICKER>_CHAT_LINK_URL="<bundled-explorer>/{txid}"

# Override to self-hosted or alternative explorer:
MORPHIT_FRONTEND_<TICKER>_CHAT_LINK_URL="https://my-explorer.example.org/tx/{txid}"
```

`{txid}` is the placeholder substituted at render time with the
lowercased transaction ID.  Validation: must be `https://`, must
contain literal `{txid}`, must parse as a URL after substitution.
Invalid templates fail indexer startup with a clear error.

The ops-cli `morphit-ops init` wizard step 12 (Chat-link external
explorer URLs) walks through all 13 single-network chat-link
explorer overrides in canonical asset-registry order
(BTC → XMR → BCH → LTC → DASH → DOGE → ZEC → ARRR → DCR → SOL →
ETH → XRP), each with the same probe-reachability check.

Bundled defaults + alternative-explorer surveys at addition time:

- **DOGE (cp33)** — bundled `https://blockchair.com/dogecoin/transaction/{txid}` (chosen from a 9-explorer survey: dogechain.info, blockchair.com/dogecoin, bitinfocharts.com/dogecoin, live.blockcypher.com/doge, blockexplorer.one/dogecoin/mainnet, blockchain.com/explorer/assets/doge, sochain.com/DOGE, chain.so/DOGE, oklink.com).  See ADR-0030.
- **ZEC (cp39)** — bundled `https://zcashblockexplorer.com/transactions/{txid}` (chosen for transparent+shielded coverage; see ADR-0031).  Note: shielded-only transactions don't expose data to ANY explorer by design — the chat link works for transparent payments and shows a privacy-respecting summary for shielded ones.
- **ARRR (cp41)** — bundled `https://explorer.pirate.black/tx/{txid}` (the official Pirate Chain explorer; all transactions on ARRR are shielded by construction, so the explorer shows only the proof-of-inclusion summary — no amount or recipient info ever leaks).  See ADR-0032.
- **DCR (cp43)** — bundled `https://explorer.dcrdata.org/tx/{txid}` (the official Decred dcrdata explorer; see ADR-0033).
- **SOL (cp45)** — bundled `https://explorer.solana.com/tx/{txid}` (the official Solana project explorer; chosen from a 5-explorer survey).  See ADR-0034.
- **ETH (cp47)** — bundled `https://eth.blockscout.com/tx/{txid}` (chosen for being an open-source non-aggregator project explorer with no SQL trackers; alternatives surveyed: etherscan.io, ethplorer.io, beaconcha.in/block-explorer).  See ADR-0035.
- **XRP (cp49)** — bundled `https://livenet.xrpl.org/transactions/{txid}` (the official XRP Ledger Foundation explorer — a non-profit organization; chosen for the non-aggregator + non-Ripple-Labs criteria).  See ADR-0036.

If you choose to disable any of these instance-wide via
`MORPHIT_INDEXER_DISABLED_ASSETS=<TICKER>`, the corresponding
chat-link config has no effect on your instance.

### Schema migration v32 (Part 121)

`apps/indexer/src/db/schema.sql` adds an `orders.asset_network
TEXT` column for multi-network assets.  Pre-Part-121 rows
have `asset_network IS NULL`, which is the correct value for
single-network assets too (BTC, XMR, BLURT, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP
all single-network; USDT, USDC, DAI multi-network; all
single-network assets write NULL).
USDT orders carry one of `'erc20'|'trc20'|'spl'|'bep20'`;
USDC orders carry one of `'erc20'|'spl'|'base'|'polygon'`;
DAI orders carry one of `'erc20'|'polygon'|'base'|'arbitrum'`.

The migration is idempotent (`ADD COLUMN IF NOT EXISTS`) and
applied automatically on indexer startup.  No operator action
required beyond the standard `npm run migrate` flow.

## 42. Web Push notifications — VAPID setup and the push-sender worker

**Part 122 cp13.**  Morphit's notification system shipped its
in-tab channels (title-bar prefix, favicon canvas badge, PWA
App Badge, OS notifications via the Notification API, audio
cue, vibration cue) across phases 1–4.  Phase 3 — **Web Push**,
which delivers notifications even when the user's Morphit tab
is closed or their phone is locked — landed in cp13.

This section covers the operator-facing pieces: generating the
VAPID keypair, plugging it into your config, what the
push-sender worker does and how to monitor it, and the
privacy/security trade-offs you should be aware of.

### 42.1 What ships

| Component | Location | Purpose |
| --- | --- | --- |
| VAPID keygen | `scripts/generate-vapid-keys.sh` | Generate the operator's keypair once at install time |
| Schema v33 — `push_subscriptions` | `apps/indexer/src/db/schema.sql` | One row per (account, browser) pairing |
| Schema v33 — `push_pending` | same | Durable delivery queue (FIFO drain) |
| Subscribe endpoints | `apps/relay/src/api/push.ts` | `GET /v1/push/vapid-public-key`, `POST /v1/push/subscribe`, `POST /v1/push/unsubscribe` |
| Push-sender worker | `apps/relay/src/policy/pushSender.ts` | Drains `push_pending` every `MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS` (default 30 s) |
| Indexer enqueue | per-handler in `apps/indexer/src/indexer/handlers/` | Each notify-worthy event writes a `push_pending` row |
| Service worker | `apps/web/src/service-worker.ts` | Decrypts pushes and shows OS notifications |
| Client subscribe | `apps/web/src/lib/notifications/push.ts` | `pushManager.subscribe()` + relay registration |
| UI | `NotificationSettings.svelte` | Subscribe / unsubscribe button + privacy radios |

### 42.2 One-time install — generate the VAPID keypair

Web Push (RFC 8292) requires the operator to hold a VAPID
keypair.  The public half identifies your instance to the
push service so it knows pushes from your relay are
legitimate.  Generate once, store the private half like any
other secret, and never rotate without warning your users
(rotating invalidates every existing subscription on your
instance).

```bash
# From the repo root, after `npm install`:
bash scripts/generate-vapid-keys.sh
```

The script prints three lines that go into your relay's env
configuration (typically `/etc/morphit/relay.env`):

```text
MORPHIT_RELAY_VAPID_PUBLIC_KEY=BH5ZK...   # ~88 chars
MORPHIT_RELAY_VAPID_PRIVATE_KEY=AzbhfY... # ~44 chars — TREAT AS SECRET
MORPHIT_RELAY_VAPID_SUBJECT=mailto:operator@your-domain.example
```

The subject MUST be either `mailto:<address>` or `https://<url>`
— it identifies you to the push services (FCM / autopush /
APNS) so they can contact you if your pushes start misbehaving.

If **any** of the three env vars is unset, the relay starts
with push disabled (`/v1/push/vapid-public-key` returns 503,
the client UI shows "Not supported on this device", and users
fall back to the in-tab channels).  This is the correct
behavior for operators who don't want to participate in Web
Push.

### 42.3 Optional tuning knobs

| Variable | Default | What it does |
| --- | --- | --- |
| `MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS` | `30000` | How often the worker drains the queue.  Lower = snappier deliveries, more DB load |
| `MORPHIT_RELAY_PUSH_BATCH_SIZE` | `50` | Max queue rows per tick.  Caps worst-case latency |
| `MORPHIT_RELAY_PUSH_MAX_AGE_SECONDS` | `3600` | Drop pushes older than this.  Stale notifications are worse than no notifications |
| `MORPHIT_RELAY_PUSH_MAX_CONSECUTIVE_FAILURES` | `5` | Delete a subscription after this many consecutive failed pushes (presumed dead browser) |
| `MORPHIT_RELAY_PUSH_REQUIRE_SIGNED` | `true` | When `true` (default, cp14), `/v1/push/subscribe` rejects requests without a valid posting-key signature. Set to `false` only during a brief frontend roll-forward window |

### 42.4 What the push-sender worker actually does

Every `MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS` (default 30 s),
the worker runs one tick:

1. `SELECT … FROM push_pending ORDER BY enqueued_at ASC LIMIT
   <batch_size>` — drain the oldest rows.
2. For each row, drop if `event_at` is older than
   `MORPHIT_RELAY_PUSH_MAX_AGE_SECONDS` ago.
3. Join against `push_subscriptions` to find every device the
   target account is subscribed on.
4. For each device, call `webpush.sendNotification()` — the
   library signs a VAPID JWT, encrypts the payload per
   RFC 8291 (E2E vs the push service), and POSTs to the push
   service.
5. On 2xx, mark `last_delivery_at = NOW()` and reset
   `consecutive_failures = 0`.
6. On 410 Gone or 404, the subscription is dead — delete it.
7. On transient failures (429, 5xx), increment
   `consecutive_failures`.  When it crosses
   `MORPHIT_RELAY_PUSH_MAX_CONSECUTIVE_FAILURES`, delete the
   subscription.
8. Always delete the `push_pending` row after fan-out —
   re-trying after a delivery attempt invites duplicates.

Logs are emitted on every non-empty tick under
`relay-push-sender`.  Per-device push failures log status
codes only — never endpoint URLs or payload content (privacy
invariant).

### 42.5 Privacy and security model

- **Payload content is end-to-end encrypted.**  The web-push
  library encrypts every payload per RFC 8291 using the
  recipient's p256dh ephemeral public key and an auth secret;
  the push service sees ciphertext, not text.  An operator
  who controls the relay can see what they're enqueuing (the
  title and body are stored in `push_pending` before
  encryption), but the push service downstream cannot.

- **No subscriber IPs are stored.**  The subscribe endpoint
  is rate-limited by IP, but the IP never goes into the DB.

- **Subscription endpoint URLs reveal which push service
  the user's browser uses** (fcm.googleapis.com = Google;
  updates.push.services.mozilla.com = Mozilla;
  web.push.apple.com = Apple).  This is unavoidable for Web
  Push to function.  Privacy-preserving users can either
  decline push (in-tab channels still work) or use a custom
  push server on Firefox via `dom.push.serverURL`.

- **Posting-key signature verification on subscribe (cp14).** As
  of Part 122 cp14, `/v1/push/subscribe` requires every request
  to carry a valid posting-key signature over the canonical
  message
  `morphit:push:subscribe:<account>:<sha256(endpoint)>:<timestamp>`.
  The signature is verified against the account's posting public
  key fetched from the chain.  ±5 minute timestamp skew is
  accepted.  Requests without a signature, or with an invalid
  signature, are rejected with HTTP 401.

  This closes the cp13 trade-off ("rate-limited-only auth").
  The flag `MORPHIT_RELAY_PUSH_REQUIRE_SIGNED=false` exists
  for the narrow case where you're rolling a new frontend out
  ahead of the relay and want to accept unsigned requests
  briefly; in normal operation, leave it `true`.

  Multi-key posting authorities are NOT fully supported — only
  the first listed key in the posting authority is accepted.
  This is documented because every Morphit user account is
  single-key in practice; if you operate a multisig posting
  authority, push subscribe will fail for you and we'll need
  a follow-on checkpoint.

- **End-to-end vs the push service, NOT vs the operator
  (DD-2 audit clarification).**  Payload encryption per RFC 8291
  protects the message body from Google FCM, Mozilla autopush,
  and Apple — they see ciphertext, not text.  The OPERATOR's
  relay, however, sees the localized `title` and `body` strings
  pass through the `push_pending` table before encryption.
  Everything that ends up in those fields is derived from
  PUBLIC chain events (sender names, ratings, order permlinks)
  that the operator could already observe by reading the chain;
  the queue cache adds no leak beyond chain visibility.  Chat
  *content* is never in any push payload — the indexer doesn't
  hold chat encryption keys.

- **Unsubscribe is signed + rate-limited
  (cp131 MED-009 — supersedes the pre-cp131 DD-4 audit
  clarification).**  `/v1/push/unsubscribe` requires the
  same posting-key signature as subscribe over the
  canonical message
  `morphit:push:unsubscribe:<account>:<sha256(endpoint)>:<timestamp>`,
  and the endpoint is per-IP rate-limited (20/hour, same
  shape as subscribe).  Pre-cp131 reasoning ("if we
  required sig-verify on unsubscribe, a user who locked
  their session couldn't stop notifications") is preserved
  by accepting unsigned unsubscribes in cp13-compat mode
  when `MORPHIT_RELAY_PUSH_REQUIRE_SIGNED=false` AND by
  the client falling back to unsigned when the session is
  locked (the browser-side `PushSubscription.unsubscribe()`
  already cuts off future deliveries; the relay-side
  delete is best-effort cleanup).  ACTION-binding in the
  canonical message prevents subscribe↔unsubscribe
  signature replay (verified by 5 scenarios in
  `apps/relay/scripts/canonical-message-cross-check-smoke.ts`).
  Real attack closed: an adversary with a DB-leaked
  (account, endpoint) list could pre-cp131 mass-fire
  unsubscribes and DoS notifications federation-wide.

- **Captured-signature replay window is bounded but non-zero
  (DD-7 audit clarification).**  The subscribe signature has
  a ±5 minute timestamp skew tolerance.  An adversary who
  captured a subscribe request from a user could replay it
  within 5 minutes.  Replay creates a subscription for the
  USER'S device (the endpoint is bound to that device by the
  push service), so the adversary can't divert push delivery
  to themselves.  The realized attack is "user unsubscribed
  but their device starts receiving notifications again until
  they unsubscribe a second time."  Nuisance, not security
  failure.  Mitigation cost (server-side nonce cache for 5
  minutes) outweighs the attack value.

### 42.6 Monitoring + troubleshooting

**Single-relay assumption (DD-10 audit clarification).**  The
push-sender worker does NOT use `SELECT … FOR UPDATE SKIP
LOCKED` when draining `push_pending`.  If two relay processes
ran against the same database — not the current Morphit topology
per ADR-0011 — both workers would SELECT the same rows and
double-deliver.  A future HA deployment would need to add row
locking; today's single-relay-per-instance pattern makes this a
non-issue.

**The worker is silent on a quiet queue.**  If no events are
enqueued, no logs.  The first sign of trouble is usually a
matrix-bot alert that `push_pending` row count is growing
unbounded (set up via the resource-monitor sidecar pattern in
§16.5).

**Common operator-side issues:**

- *Subscribe endpoint returns 503 push_disabled.*  Your VAPID
  env vars aren't all set.  Re-run the keygen and verify each
  line is present in your relay's env file.

- *Pushes are delivered but the user reports not seeing
  them.*  Three checks: (a) the user's browser has notification
  permission for your origin (`chrome://settings/content/notifications`,
  `about:preferences#privacy` etc); (b) the user has subscribed
  on the device that should receive (browsers don't share
  subscriptions across devices); (c) the user hasn't muted
  notifications via the in-app mute-for / quiet-hours controls.

- *Subscriptions table grows without bound.*  The auto-cleanup
  on 410 Gone handles browsers that gracefully unsubscribed,
  but stale rows can accumulate.  Periodically check
  `SELECT COUNT(*) FROM push_subscriptions WHERE last_delivery_at < NOW() - interval '90 days'`
  and consider pruning manually if the count grows large.

### 42.7 Rotating VAPID keys

Avoid this unless your private key is exposed.  Rotating the
public key invalidates every existing subscription on your
instance — users will need to re-subscribe.  Procedure:

1. Generate a new keypair via `scripts/generate-vapid-keys.sh`.
2. Post a notice to your community channel (Matrix, etc.):
   "Web Push subscriptions will reset on <date>; please re-enable
   in Settings if you use push."
3. Update your env file with the new values.
4. Restart the relay.
5. `TRUNCATE push_subscriptions;` — all rows are now bound to
   the old public key and won't work.
6. Users re-subscribe via the Settings UI.


## 43. SEO override env vars — homepage title/description/keywords + Twitter card

**Audience:** operators who want to override the bundled homepage SEO copy with
something tailored to their audience without forking the frontend.  All fields
are optional — leave any of them unset and the bundled svelte-i18n value (or no
emission, for the Twitter handle) is used.

The frontend reads these via `/v1/instance`, so changes propagate after the
indexer config is re-read (restart `morphit-indexer` after editing the env file).

### Available env vars

**`MORPHIT_INSTANCE_SEO_TITLE`** — overrides the homepage `<title>` and
`<meta property="og:title">`.  Max 200 chars.  Operators with curated audiences
(e.g. a Persian-speaking community) can swap in language-specific or
audience-specific copy here.  When set, the override applies AS-IS — no `— InstanceName`
suffix is appended (you author the full title you want).

**`MORPHIT_INSTANCE_SEO_DESCRIPTION`** — overrides `<meta name="description">`
and `<meta property="og:description">`.  Max 500 chars; Google truncates after
about 155 chars in SERPs, so aim for ≤150.

**`MORPHIT_INSTANCE_SEO_KEYWORDS`** — overrides `<meta name="keywords">`.
Most modern crawlers ignore this, but Yandex, Baidu, and some federated
indexers still consume it.  Max 500 chars; comma-separated.

**`MORPHIT_INSTANCE_SEO_TWITTER_SITE`** (cp119-A4) — optional X / Twitter handle
for `<meta name="twitter:site">`.  When set (e.g. `@morphit`), Twitter cards
include "via @morphit" attribution.  When unset, the meta tag is omitted
entirely — the card still renders without it.  Format: must start with `@`,
1-15 alphanumeric/underscore chars (Twitter's handle limit).  Operators who
don't have or don't want an X presence simply leave this unconfigured.

### Example morphit.config.env block

```env
# Optional: override homepage SEO copy
MORPHIT_INSTANCE_SEO_TITLE="My Instance — privacy-first P2P crypto trading"
MORPHIT_INSTANCE_SEO_DESCRIPTION="Trade BTC, XMR, BLURT and more directly with people in your region. No KYC, non-custodial, federated."
MORPHIT_INSTANCE_SEO_KEYWORDS="p2p crypto, no kyc, bitcoin, monero, federated marketplace"
# Optional: X handle for Twitter Card attribution
MORPHIT_INSTANCE_SEO_TWITTER_SITE="@morphit"
```

Restart the indexer after editing, then verify via:

```bash
curl -sf https://yourinstance.example/v1/instance | jq '.seo'
```

## 44. User-side optional TOTP 2FA — operator-side notes

**TL;DR for operators: zero action required.** 2FA is a purely
client-side, opt-in feature. The Morphit web app offers it as an
option from Settings → Two-factor authentication. The TOTP secret
and backup-code hashes are stored inside the user's encrypted
keystore, alongside their identity. The indexer and relay are not
involved in the 2FA flow at any point.

### What you (the operator) should know

- **The user enrolls — not you.** There is no operator-side
  toggle to enable, disable, or require 2FA for users of your
  instance. Morphit users own their keys; we don't gate them.
- **There's no server-side state.** The relay holds no TOTP
  secrets, no backup codes, no 2FA enabled/disabled flag for
  any user. The encrypted keystore lives in the user's browser
  storage (or wherever they exported it).
- **Reports of "I lost my 2FA, can you reset it?" — you can't.**
  The correct response is: "I can't reset your 2FA because
  Morphit doesn't hold your keystore or your secrets. If you
  still have your 12-word seed phrase, you can sign out and
  re-import to recover. If you saved your 10 backup codes at
  enrollment, type one of those at the unlock screen instead
  of the 6-digit code. If you don't have either, the keystore
  isn't recoverable." This is documented in the user-facing
  FAQ (`totp_2fa_lost_authenticator`).
- **No support for "force 2FA before withdrawing $X" or
  similar paternalism.** ADR-0043 documents the rejection of
  this pattern: gating user funds on a second factor that the
  user can lose, on a non-custodial wallet, is contradictory.
- **No telemetry on enrollment.** The relay does not know which
  users on your instance have 2FA enabled. No metric is
  reported, no log line surfaces the fact. This is intentional.

### Recommending apps to users

Morphit's recommended-apps list ships in
`apps/web/src/lib/auth/recommendedAuthenticatorApps.ts` and is
surfaced to the user at enrollment time. It currently
recommends Aegis (Android), 2FAS (iOS + Android), and Ente Auth
(cross-platform). All three are open source.

The same file also explicitly tells users why Morphit does NOT
recommend Google Authenticator, Microsoft Authenticator, or
Authy. Operators who get pushback on this from a user who
prefers a closed-source authenticator can point them at
ADR-0043 §"Open-source-only recommended-app policy" or the FAQ
entry `totp_2fa_why_not_google_authenticator`. The user is
free to use any TOTP-compatible app — Morphit accepts the
standard otpauth:// URI — but Morphit will only recommend
open-source options.

### If a user reports "the TOTP code never works"

Almost always device clock drift. TOTP requires the user's
device clock to be within 90 seconds of NTP-correct time
(Morphit's TOTP verifier accepts ±1 step on either side of
the current 30-second window, so up to ±90s drift). On
desktops, this is almost never an issue. On phones with
buggy NTP sync, it can be — direct the user to enable
automatic date/time in their system settings.

### Source pointers

- ADR-0043 — design rationale
- `apps/web/src/lib/auth/totp.ts` — RFC 6238 implementation
- `apps/web/src/lib/crypto/keystoreTotp.ts` — unlock-time gate
- `apps/web/src/lib/crypto/keystoreTotpEnroll.ts` — enrollment
- `apps/web/src/routes/[lang]/settings/security/2fa/+page.svelte`
  — user-facing UI

## 45. MCP server — AI agent surface

The Morphit MCP server (`apps/mcp-server`) exposes this instance's
federated orderbook to MCP-compatible AI agents — Claude Desktop,
Cursor, Cline, Continue, Windsurf, Zed, and any local LLM stack
built on `@modelcontextprotocol/sdk`.  Five read-only tools:

| Tool                          | What it does                                                       |
| :---------------------------- | :----------------------------------------------------------------- |
| `morphit_search_orders`       | Query the live orderbook with filters (asset, side, fiat, region). |
| `morphit_get_listing`         | Fetch one listing in full detail by `(account, permlink)`.         |
| `morphit_list_operators`      | Federation directory: operator tags, instance URLs, asset stance.  |
| `morphit_account_reputation`  | Look up a trader's completion rate, age, recent feedback.          |
| `morphit_federation_summary`  | Federation health snapshot — peer count, recent activity.          |

### Why operators are encouraged to enable this

AI agents are becoming the new search layer.  When a user asks
their LLM "where can I buy XMR with cash near me," an
MCP-connected agent can answer from your orderbook in real time
and hand them a deeplink to your frontend.  Your instance appears
in answers, not just in search-engine results.

Federation-wide effect: every Morphit instance running MCP
enlarges the shared AI-discoverable surface for the project.
Opting out shrinks it.

### Security posture

The MCP server holds **no keys, no privileges, no write paths**.
Tools return public orderbook data (the same data already served
at `/v1/orderbook` etc.) plus deeplinks back to your frontend.
The user's wallet still executes the actual trade — the agent is
strictly a discovery surface.

Default bind: `127.0.0.1:8124` (loopback only).  Reverse-proxy
via nginx at `/mcp/*` if you want public exposure.  No CORS
needed because the MCP protocol is request/response over HTTP
without browser-origin restrictions in the agent runtime.

### Resource cost

~30 MiB RAM at idle, negligible CPU.  The systemd unit
(`ops/systemd/morphit-mcp.service`) caps memory at 256 MiB and
task count at 128 — plenty of headroom for legitimate spikes.

### Setup

The wizard (`morphit-ops init`, step 20) installs MCP by default.
If you accepted that, you'll see `MORPHIT_MCP_ADVERTISE=true`
in your `morphit.config.env` and the systemd unit is shipped at
`ops/systemd/morphit-mcp.service`.  Enable + start:

```
sudo systemctl enable --now morphit-mcp.service
```

If you skipped MCP at wizard time and want to enable it later:

```
# Flip the advertise flag in morphit.config.env:
sudo sed -i 's/^MORPHIT_MCP_ADVERTISE=false/MORPHIT_MCP_ADVERTISE=true/' \
  /etc/morphit/morphit.config.env

# Start the service:
sudo systemctl enable --now morphit-mcp.service

# Restart the indexer so /v1/instance starts advertising mcp_url:
sudo systemctl restart morphit-indexer.service
```

### Reverse proxy (optional — public exposure)

If you want AI agent users to reach your MCP endpoint from
outside your VPN, add a location block to your nginx config:

```nginx
location /mcp/ {
    proxy_pass http://127.0.0.1:8124/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # MCP responses can be long-running for federation queries.
    proxy_read_timeout 120s;
}
```

The indexer's `/v1/instance` response will then include
`mcp_url: "https://<your-origin>/mcp"` (built from
`MORPHIT_INDEXER_PUBLIC_ORIGIN` plus `/mcp`).  AI agent operators
discover this via the federation directory and configure their
clients accordingly.

### Disabling

Two switches:

- **Stop advertising** (still serve to local clients):
  set `MORPHIT_MCP_ADVERTISE=false` in `morphit.config.env`,
  restart `morphit-indexer.service`.
- **Stop the service entirely**:
  `sudo systemctl disable --now morphit-mcp.service`.

### Source pointers

- `apps/mcp-server/README.md` — protocol overview, tool schemas
- `apps/mcp-server/src/tools/` — implementations
- `ops/systemd/morphit-mcp.service` — hardened systemd unit
- `apps/indexer/src/api/instance.ts` — `/v1/instance.mcp_url` field
- `packages/operator-config/src/index.ts` — `MORPHIT_MCP_ADVERTISE`
  allowlist entry
