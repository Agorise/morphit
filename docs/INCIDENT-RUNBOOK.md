# Morphit — Incident Runbook (active attack / DoS)

One page. When the service is under attack, work top to bottom. Every lever here
is reversible. The single most important one is #1.

Run every command below **on the server that runs your relay** (logged in as
root or with `sudo`). Paths assume the defaults; substitute your own
`MORPHIT_RELAY_DATA_DIR` and BunkerWeb env file if you changed them.

---

## 1. Halt signups NOW (the money lever)

Each successful signup spends ~102 liquid BLURT from the relay wallet, so
mass-signup abuse is the one attack that costs you real money. Stop it instantly
— **no restart, no deploy**:

```
sudo touch /var/lib/morphit/relay/SIGNUPS_DISABLED
```

The relay polls for this file every second and, while it exists, answers every
invite and create request with `503` (`signups_disabled`). Everything else
(browsing, chat, trading, the explorer) keeps working. Reverse when the wave
passes:

```
sudo rm /var/lib/morphit/relay/SIGNUPS_DISABLED
```

Check that the switch is armed (since v1.20.0 it is on every install; before,
no installer set the relay's state directory, so this file did nothing):

```
journalctl -u morphit-relay -b | grep -E 'kill_switch_armed|signup_state_dir'
```

`kill_switch_armed` names the file the relay watches. If you see
`signup_state_dir_not_writable` instead, the line gives the fix command; until
then use the fallback below.

**Fallback (needs a restart):** in `/etc/morphit/relay.env` set
`MORPHIT_RELAY_SIGNUP_ENABLED=false`, then `sudo systemctl restart morphit-relay`.
Edit that file itself — an `Environment=` line in a systemd drop-in does **not**
work, because the relay's unit reads `/etc/morphit/relay.env` after systemd has
set the environment, and the file's value wins.

You do **not** need this if the automatic guards are holding — the global daily
ceiling (persisted in `/var/lib/morphit/relay/signup-ceiling.json`, so a relay
restart does not reset it), the per-IP limits (5 per hour, 2 per day by
default), the invite gate, the fail-closed low-balance pre-check and the
fee-spike refusal already bound the loss. Use the kill switch when the automatic
bounds are being probed hard or you want zero doubt.

## 2. Watch the money

Tail the relay journal for these keys — any of them means "signups are eating
BLURT, consider #1":

```
journalctl -u morphit-relay -f | grep -E 'low_balance|relay_out_of_funds|relay_low_balance_for_signups|CEILING_REACHED|relay_fee_spike_refused'
```

`relay_out_of_funds` / `low_balance` = the fail-closed balance check is already
refusing new signups. `CEILING_REACHED` = the daily ceiling has capped the day.
`relay_fee_spike_refused` = the chain's account-creation fee is more than 1.5×
your configured `MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT`, so the relay
refuses to create accounts (code `relay_fee_spike`) and spends nothing. All are
the guards doing their job — the kill switch (#1) is the hard stop.

If the fee really changed (check `condenser_api.get_chain_properties` or any
Blurt block explorer), set the new value as
`MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT=<fee>` in `/etc/morphit/relay.env`
and `sudo systemctl restart morphit-relay`; signups resume once the live fee is
within 1.5× of it.

## 3. Watch the price feeds

A manipulated external FX source can only move prices if it overwhelms the
median + outlier rejection. The monitor alerts on sustained divergence:

```
journalctl -u morphit-indexer -f | grep -E 'peer_price_disagreement_alert'
```

If an external source is compromised, prefer the on-chain witness feed by
setting `MORPHIT_INDEXER_PRICE_PREFER_NATIVE_WHEN_DISAGREEING=true` and
restarting the indexer.

## 4. Shed abusive traffic at the edge (BunkerWeb)

Rate limits (`limit_req`), the per-IP connection cap (`limit_conn`), and
automatic bad-behavior bans (`BAD_BEHAVIOR_*`, ban time 3600s) run by default.
To ban manually, edit the BunkerWeb env file and reload:

- Specific IPs: `BLACKLIST_IP=1.2.3.4 5.6.7.8`
- Whole hosting/VPS ranges (most floods come from a few ASNs): `BLACKLIST_ASN=AS12345 AS67890`
- Country-level (last resort — blunt): `BLACKLIST_COUNTRY=...`

Then reload BunkerWeb (`docker compose … reload` or your deploy's reload path).
If you edited any `ops/nginx/*.conf` (e.g. tightened `limit_conn`), validate and
reload nginx first: `sudo nginx -t && sudo systemctl reload nginx`.

## 5. Check for a hostile federation clone

An attacker running an instance that advertises **your** relay account would
cause double-credited welcome bonuses. The probe detects and alerts:

```
journalctl -u morphit-indexer -f | grep -E 'shared_relay_account_detected'
```

If you see it: that peer is using your relay account — treat it as hostile, and
the kill switch (#1) protects your wallet meanwhile.

## 6. Escalate / disclose privately

Report or coordinate over an **encrypted, private** channel — the Matrix user,
not the public room:

- Private security DM: **`@agorise:matrix.org`** (MXID — end-to-end encrypted by default)
- Do **NOT** post details in the public room `#agorise:matrix.org`, and do not
  open a public issue.

---

## Quick reference — the reversible levers

| Lever | Command | Reverse |
|---|---|---|
| Halt signups | `sudo touch /var/lib/morphit/relay/SIGNUPS_DISABLED` | `sudo rm` the file |
| Prefer on-chain price | set `…PREFER_NATIVE_WHEN_DISAGREEING=true` + restart indexer | unset + restart |
| Ban IPs / ASNs | `BLACKLIST_IP` / `BLACKLIST_ASN` in BunkerWeb env + reload | remove + reload |

## What is already defending you (no action needed)

Multi-layer rate limits (edge + app), per-IP connection caps, tight request-body
caps, slowloris timeouts, the keyless indexer broadcast proxy (no secret to
steal), the fee-spike refusal (above 1.5× the configured account-creation fee
the relay creates no accounts until you confirm the new fee), and configs that
refuse to start with placeholder secrets. The layered signup-drain defences are
described in `docs/OPERATIONS.md` §18 ("Signup-drain prevention") and
`docs/SECURITY.md`.
