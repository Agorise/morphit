# Morphit — Incident Runbook (active attack / DoS)

One page. When the service is under attack, work top to bottom. Every lever here
is reversible. The single most important one is #1.

Paths below assume the defaults; substitute your own `MORPHIT_RELAY_DATA_DIR`
and BunkerWeb env file if you changed them.

---

## 1. Halt signups NOW (the money lever)

Each successful signup spends ~102 liquid BLURT from the relay wallet, so
mass-signup abuse is the one attack that costs you real money. Stop it instantly
— **no restart, no deploy**:

```
touch /var/lib/morphit/relay/SIGNUPS_DISABLED
```

The relay checks for this sentinel file on every create request and returns
`503` while it exists. Everything else (browsing, chat, trading, the explorer)
keeps working. Reverse when the wave passes:

```
rm /var/lib/morphit/relay/SIGNUPS_DISABLED
```

You do **not** need this if the automatic guards are holding — the global daily
ceiling, per-IP `createRatePerHour` (2/day), the invite gate, and the
fail-closed low-balance pre-check already bound the loss. Use the kill switch
when the automatic bounds are being probed hard or you want zero doubt.

## 2. Watch the money

Tail the relay journal for these keys — any of them means "signups are eating
BLURT, consider #1":

```
journalctl -u morphit-relay -f | grep -E 'low_balance|relay_out_of_funds|relay_low_balance_for_signups|CEILING_REACHED'
```

`relay_out_of_funds` / `low_balance` = the fail-closed balance check is already
refusing new signups. `CEILING_REACHED` = the daily ceiling has capped the day.
Both are the guards doing their job — the kill switch (#1) is the hard stop.

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
- Do **NOT** post details in the public room `#agorise:matrix.org`.
- Confidential ticket: git.agorise.net (mark confidential).

---

## Quick reference — the reversible levers

| Lever | Command | Reverse |
|---|---|---|
| Halt signups | `touch $DATADIR/SIGNUPS_DISABLED` | `rm` the file |
| Prefer on-chain price | set `…PREFER_NATIVE_WHEN_DISAGREEING=true` + restart indexer | unset + restart |
| Ban IPs / ASNs | `BLACKLIST_IP` / `BLACKLIST_ASN` in BunkerWeb env + reload | remove + reload |

## What is already defending you (no action needed)

Multi-layer rate limits (edge + app), per-IP connection caps, tight request-body
caps, slowloris timeouts, the keyless indexer broadcast proxy (no secret to
steal), the fee-divergence guard (a witness fee spike can't quietly drain the
wallet), and configs that refuse to start with placeholder secrets. See
`SECURITY-AUDIT-attack-resilience.md` for the full picture.
