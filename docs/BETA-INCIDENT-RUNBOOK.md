# Morphit beta-test incident-response runbook

This is a one-page triage guide for the operator (you) during
paid beta testing.  When a tester reports something broken,
work top-to-bottom.

The mental model: every layer is a gate.  Find which gate is
saying "no," fix it, signups resume.

Run every command below **on the server that runs your relay**
(as root or with `sudo`).

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
| `already_registered` | Name is taken (HTTP 409 — also when a retry after `broadcast_outcome_unknown` finds the name created with a DIFFERENT owner key) | Tester picks a different name |
| `invite_expired` / `invite_already_used` / `invite_ip_mismatch` | Invite token problem | Tester refreshes the page (gets a fresh invite) |
| `altcha_required` | PoW puzzle delivered; tester's frontend should solve it | If the frontend doesn't solve it, that's a frontend bug — escalate |
| `altcha_bad_solution` | Tester's frontend solved the puzzle wrong | Frontend bug, escalate |
| `origin_required` / `origin_not_allowed` | Tester's frontend Origin header isn't in the allowlist | Add their frontend's origin to `MORPHIT_RELAY_ALLOWED_ORIGINS` and restart |
| `relay_fee_spike` | The chain's live `account_creation_fee` is more than 1.5× your configured `MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT`; the relay refuses and spends nothing (journal: `relay_fee_spike_refused`) | Confirm the witnesses really changed the fee (`condenser_api.get_chain_properties` or a Blurt explorer), then set the new value in `/etc/morphit/relay.env` and `sudo systemctl restart morphit-relay` |
| `broadcast_outcome_unknown` | No RPC node confirmed the `account_create` and the chain can't yet say whether it landed. The relay counts it as spent and never re-signs it | Tester waits a minute and retries with the SAME name. The relay checks the chain first: if the account exists with the tester's owner key it answers success (`note: "already_created"`) before any invite, spacing or ceiling check; the tester's per-IP slot is held 30 min so the retry is not refused for spacing. The register page keeps that name submittable even though availability shows it "taken" |
| `broadcast_failed` | Chain rejected the tx for an unmapped reason | Real bug or chain weirdness; check journalctl for the upstream error |
| `chunked_unsupported` | Tester's frontend used chunked encoding | Frontend bug, escalate |
| `request_too_large` | Body > 64KB | Almost certainly a malformed/malicious request; ignore |

---

## 3. Signups paused — is it me or the system?

```sh
# Is the kill-switch file present?
ls -la /var/lib/morphit/relay/SIGNUPS_DISABLED 2>/dev/null

# Is the env-var disable on?  (The unit reads this file; a systemd
# Environment= override does NOT win over it.)
grep MORPHIT_RELAY_SIGNUP_ENABLED /etc/morphit/relay.env

# Is the kill-switch file watched at all? (Since v1.20.0: always.)
sudo journalctl -u morphit-relay -b | grep -E 'kill_switch_armed|signup_state_dir'

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

2. **Env-var is `false`** → edit `/etc/morphit/relay.env`, set
   `MORPHIT_RELAY_SIGNUP_ENABLED=true`, restart:
   `sudo systemctl restart morphit-relay`.  Note: env-var
   change requires restart; the kill-switch file does NOT.

3. **Daily ceiling reached** → from `signup_stats`, if
   `successful_today >= daily_ceiling`, the cap is hit until
   UTC midnight (the count survives relay restarts: it is kept in
   `/var/lib/morphit/relay/signup-ceiling.json`).  Real `signup_stats` shape:
   `{enabled, daily_ceiling, successful_today,
   current_hour_count, peak_hour_count, peak_other_hours,
   resets_at}`.  This is normal during high beta volume.
   Either wait, or raise `MORPHIT_RELAY_SIGNUP_DAILY_CEILING`
   in `/etc/morphit/relay.env` and restart (think about whether the higher number is
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
# What's the current balance, and the live chain fee the relay
# checks it against? (relay's /v1/health is on port 8080)
curl -s http://localhost:8080/v1/health?verbose=1 | jq '{blurt_balance, account_creation_fee_blurt, stale}'

# How many more signups can we afford?
# Compute as daily_ceiling - successful_today:
curl -s http://localhost:8080/v1/health?verbose=1 \
  | jq '.signup_stats | (.daily_ceiling - .successful_today)'
```

Each signup costs the live `account_creation_fee` (~100 BLURT)
plus a 2 BLURT dust transfer, so ~102 BLURT; the relay refuses a
signup unless it holds the fee plus a 3 BLURT margin.  `stale: true`
means the last balance poll is over 90 s old — signups are refused
until a poll succeeds again.

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

The relay reads and broadcasts through the whole default Blurt
RPC pool — 6 clearnet nodes plus 14 hidden ones (7 nodes, each as
`.onion` and `.b32.i2p`) — and picks the healthiest.  A shell on the
host cannot probe the hidden ones directly, so ask the services
themselves:

```sh
# The relay's view of its pool (port 8080): healthy / total,
# then each endpoint's circuit state.
curl -s http://localhost:8080/v1/health?verbose=1 \
  | jq '{rpc_endpoints_healthy, rpc_endpoints_total, hidden_only}, [.rpc_endpoints[]? | {url, state, consecutive_failures}]'

# The indexer's view (port 8081) — the same pool, read independently.
curl -s http://localhost:8081/v1/health | jq '{rpc_endpoints_healthy, rpc_endpoints_total}'
```

- **Some endpoints unhealthy, at least one healthy** → nothing to
  do; the pool routes around them and retries them later.
- **Zero healthy on a clearnet node** → check the box's outbound
  internet (`curl -sI https://rpc.beblurt.com`), then Tor
  (`systemctl status tor`) and i2pd (`systemctl status i2pd`).
- **Zero healthy on a Tor-only node** → check Tor and i2pd only.
  **Never add a clearnet endpoint to a Tor-only node's relay**: an
  empty `MORPHIT_RELAY_BLURT_RPC=` is what keeps it hidden-only, and
  a clearnet entry would make the relay contact public servers from
  your own address.

Custom lists live in `/etc/morphit/relay.env`
(`MORPHIT_RELAY_BLURT_RPC` for clearnet, `MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS`
for hidden, comma-separated); when a variable is absent the relay
uses the built-in default set.  Change them only if you know an
endpoint is permanently gone, then `sudo systemctl restart morphit-relay`.

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

# What is being refused right now? (counts by response code — the
# access log deliberately records no IP addresses)
sudo journalctl -u morphit-relay --since "5m ago" \
    | grep '\[access\]' | grep -o 'code=[a-z_]*' | sort | uniq -c | sort -rn | head
```
