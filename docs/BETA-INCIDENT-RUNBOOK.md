# Morphit beta-test incident-response runbook

This is a one-page triage guide for the operator (you) during
paid beta testing.  When a tester reports something broken,
work top-to-bottom.

The mental model: every layer is a gate.  Find which gate is
saying "no," fix it, signups resume.

---

## 0. First, is the relay even running?

```sh
sudo systemctl status morphit-relay
sudo journalctl -u morphit-relay -n 20
```

If not running: see §6.

---

## 1. Did the request reach the relay?

Every request now produces a single access-log line.  Grep for
the time window the tester reported:

```sh
sudo journalctl -u morphit-relay --since "5 minutes ago" \
    | grep '\[access\] request'
```

Look for the tester's request.  Each line shows:
`method=POST path=/v1/account/create status=503 dur_ms=4 code=signups_disabled`

- **No matching line?**  The request never reached the relay.
  Either: (a) DNS/firewall problem (check the public origin
  resolves and accepts connections), (b) the tester's frontend
  is talking to the wrong relay, (c) the request hit your
  reverse proxy but didn't proxy through (check nginx logs).

- **Line present, status 4xx or 5xx?**  Read the `code` field
  and consult §2 below.

- **Line present, status 200, but the tester says it failed?**
  The relay accepted, but something downstream (chain, dust
  transfer, frontend rendering) failed.  See §4.

---

## 2. Response code lookup

| `code` | What it means | What to check |
|---|---|---|
| `signups_disabled` | Kill-switch is on | §3 |
| `daily_ceiling_reached` | Today's quota is full | §3 |
| `rate_limited` | This IP exceeded the burst cap (5/hour default) | Tester needs to wait 1h, OR they're behind a NAT/CGNAT shared with other testers — see §5 |
| `rate_limited_daily` | This IP hit the daily cap (2/day default) | Tester waits until UTC midnight, OR shared NAT — §5 |
| `spacing_cooldown` | This IP signed up recently; next allowed in `retry_after_minutes` | Working as intended; tell the tester to wait |
| `relay_out_of_funds` | Relay's BLURT balance can't cover the next signup | §6 — refill the relay account |
| `chain_unavailable` | Blurt RPC isn't responding | §7 |
| `invalid_pubkey` | Frontend sent a malformed BLT key | Real bug; collect their browser console + relay logs and send to me |
| `malformed_operation` | Body shape doesn't match the schema | Real bug, same as above |
| `name_not_allowed` | Account name failed validation (reserved, bad chars, etc.) | Tester picks a different name |
| `already_registered` | Name is taken | Tester picks a different name |
| `invite_expired` / `invite_already_used` / `invite_ip_mismatch` | Invite token problem | Tester refreshes the page (gets a fresh invite) |
| `altcha_required` | PoW puzzle delivered; tester's frontend should solve it | If the frontend doesn't solve it, that's a frontend bug — escalate |
| `altcha_bad_solution` | Tester's frontend solved the puzzle wrong | Frontend bug, escalate |
| `origin_required` / `origin_not_allowed` | Tester's frontend Origin header isn't in the allowlist | Add their frontend's origin to `MORPHIT_RELAY_ALLOWED_ORIGINS` and restart |
| `fee_higher_than_configured` | Chain fee jumped above your configured budget | Update `MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT` and restart |
| `broadcast_failed` | Chain rejected the tx for an unmapped reason | Real bug or chain weirdness; check journalctl for the upstream error |
| `chunked_unsupported` | Tester's frontend used chunked encoding | Frontend bug, escalate |
| `request_too_large` | Body > 64KB | Almost certainly a malformed/malicious request; ignore |

---

## 3. Signups paused — is it me or the system?

```sh
# Is the kill-switch file present?
ls -la /var/lib/morphit/relay/SIGNUPS_DISABLED 2>/dev/null

# Is the env-var disable on?
grep MORPHIT_RELAY_SIGNUP_ENABLED /etc/morphit/relay.env

# What does today's ceiling status look like?
# Note: the relay's /v1/health is on port 8080 (the indexer
# is 8081; don't mix them up).  Both expose /v1/health with
# different field shapes.
curl -s http://localhost:8080/v1/health?verbose=1 | jq .signup_stats
```

Three ways signups get paused:

1. **Kill-switch file exists** → if you put it there during an
   incident, removing it resumes signups within ~1 second.
   `sudo rm /var/lib/morphit/relay/SIGNUPS_DISABLED`

2. **Env-var is `false`** → edit relay.env, set
   `MORPHIT_RELAY_SIGNUP_ENABLED=true`, restart:
   `sudo systemctl restart morphit-relay`.  Note: env-var
   change requires restart; the kill-switch file does NOT.

3. **Daily ceiling reached** → from `signup_stats`, if
   `successful_today >= daily_ceiling`, the cap is hit until
   UTC midnight.  Real `signup_stats` shape:
   `{enabled, daily_ceiling, successful_today,
   current_hour_count, peak_hour_count, peak_other_hours,
   resets_at}`.  This is normal during high beta volume.
   Either wait, or raise `MORPHIT_RELAY_SIGNUP_DAILY_CEILING`
   and restart (think about whether the higher number is
   covered by your wallet — see §6).

---

## 4. Request succeeded but tester says it failed

Order of suspects:

1. **Frontend rendering bug.**  The trx hit the chain (you can
   verify: paste the `trx_id` from the access log into a
   blurt explorer).  If the chain has the account, the relay
   did its job; the frontend must be misrendering.  Get the
   tester's browser console and screenshot.

2. **Slow chain confirmation.**  Sometimes blurt witnesses are
   slow; the trx is in mempool but the tester's frontend
   timed out waiting.  Check journalctl for the broadcast
   confirmation; if it's there but a minute late, this is
   normal under chain congestion.

3. **Frontend caching.**  The tester may be hitting a cached
   version of the page.  Ask them to hard-refresh (cmd-shift-R).

---

## 5. Multiple testers behind a shared IP

Several paid betas in the same office / on the same VPN /
behind the same CGNAT will all share an IP from the relay's
perspective.  The per-IP rate limits (5/hour, 2/day) and
spacing cooldown will gate them collectively.

Fixes:

- **Tell the testers to spread out.**  An hour between signups
  is plenty.
- **Whitelist their VPN's IP** in nginx's geo block, but ONLY
  if you trust the testers — a shared whitelist removes the
  attack defense too.
- **Raise the per-IP daily cap** (`MORPHIT_RELAY_CREATE_RATE_PER_DAY`,
  default 2; or `MORPHIT_RELAY_CREATE_RATE_PER_HOUR`, default 5)
  during the beta, then lower it back at launch.  Trade-off:
  raises the drain ceiling per attacker IP.

---

## 6. Relay out of funds

```sh
# What's the current balance?
# (relay's /v1/health is on port 8080)
curl -s http://localhost:8080/v1/health?verbose=1 | jq .blurt_balance

# How many more signups can we afford?
# Compute as daily_ceiling - successful_today:
curl -s http://localhost:8080/v1/health?verbose=1 \
  | jq '.signup_stats | (.daily_ceiling - .successful_today)'
```

If the headroom is low or zero, the relay account
needs more BLURT.  Transfer in BLURT from your operator
wallet to the relay account.  Within 30 seconds the
HealthService background poll picks up the new balance and
signups resume.

If you've been draining unexpectedly fast, check
`signup_stats.successful_today` and `peak_hour_count` — a
sudden spike with the kill-switch off is the drain pattern;
flip the kill-switch on (`§3`) and investigate before
refilling.

---

## 7. Chain RPC unavailable

The relay talks to Blurt via HTTP RPC.  If the configured
endpoint is down or slow:

```sh
# The env var is a comma-separated list of HTTPS endpoints
grep MORPHIT_RELAY_BLURT_RPC /etc/morphit/relay.env

# Pick the first one, test it directly
endpoint=$(grep MORPHIT_RELAY_BLURT_RPC /etc/morphit/relay.env | cut -d= -f2- | tr -d "'\"" | cut -d, -f1)
curl -m 5 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"condenser_api.get_dynamic_global_properties","params":[],"id":1}' \
    "$endpoint"
```

If the curl fails or times out, that specific RPC node is
down.  The relay rotates through all endpoints in the
comma-separated list, so as long as one of them works the
relay keeps going.  Add a fallback endpoint to the list and
restart — or rotate out a dead one — pick from the Blurt
witness directory or community channels.

---

## 8. Information to collect when escalating to me

When you have a real bug to report (codes that the runbook
calls "Real bug, escalate"), bundle these:

1. The access-log line(s) for the failing request.
2. The full journalctl output from the relay for the same
   minute (`sudo journalctl -u morphit-relay --since "1 minute ago"`).
3. The tester's browser console output (Settings → Developer
   tools → Console, screenshot or copy-paste).
4. The exact error message they saw on screen.
5. (If applicable) the `trx_id` if they got one but the trx
   "didn't work."

Drop these into a chat with me and I'll start triage.

---

## 9. Quick-reference cheat sheet

```sh
# Pause signups RIGHT NOW
sudo touch /var/lib/morphit/relay/SIGNUPS_DISABLED

# Resume signups
sudo rm /var/lib/morphit/relay/SIGNUPS_DISABLED

# How many signups today? (relay's /v1/health on port 8080)
curl -s localhost:8080/v1/health?verbose=1 | jq .signup_stats.successful_today

# Wallet balance (port 8080 = relay)
curl -s localhost:8080/v1/health?verbose=1 | jq .blurt_balance

# Recent access log
sudo journalctl -u morphit-relay --since "5m ago" | grep '\[access\]'

# Recent errors only
sudo journalctl -u morphit-relay --since "5m ago" -p err

# Who's hammering me right now?
sudo journalctl -u morphit-relay --since "5m ago" \
    | grep '\[access\]' | awk '{print $NF}' | sort | uniq -c | sort -rn | head
```
