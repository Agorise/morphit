# Morphit attack tree — drain the relay's BLURT balance

The relay is the only Morphit-controlled wallet on chain. Indexer + frontend
hold no funds. So "drain Morphit" reduces to "drain the relay." This document
walks the attack tree against that goal.

```
GOAL: drain the relay's BLURT balance
│
├── A1. Make many account_create requests succeed
│       (relay pays ~100 BLURT/account in chain fees)
│   │
│   ├── A1.1. Bypass per-IP rate limits
│   │   ├── A1.1.1. Distribute across many IPs (botnet)
│   │   │   └── BLOCKED at: global daily ceiling (default 50/day)
│   │   ├── A1.1.2. Forge X-Forwarded-For
│   │   │   └── BLOCKED at: clientIp() loopback-peer-only trust
│   │   ├── A1.1.3. Send malformed XFF to bypass bucketing
│   │   │   └── BLOCKED at: parseXff length cap + leading-comma fix (C2)
│   │   └── A1.1.4. Abuse IPv6 address-space breadth
│   │       └── PARTIALLY MITIGATED: per-/64 buckets would help
│   │           (currently bucket per full IP); covered by global
│   │           ceiling. Note in REVISIT-LIST.
│   │
│   ├── A1.2. Bypass invite-token gate
│   │   ├── A1.2.1. Forge an invite signature
│   │   │   └── BLOCKED at: HMAC-SHA256 with timingSafeEqual,
│   │   │                   secret never leaves server memory
│   │   ├── A1.2.2. Replay a used token
│   │   │   └── BLOCKED at: nonce tracked in consumedNonces map
│   │   ├── A1.2.3. Use someone else's token (different IP)
│   │   │   └── BLOCKED at: ip_hash binding in payload
│   │   └── A1.2.4. Replay a token whose IP has changed (NAT
│   │       transition during user's signup flow)
│   │       └── BLOCKED at: invite_ip_mismatch — user has to
│   │           request a fresh invite. Mild UX cost; only path.
│   │
│   ├── A1.3. Bypass ALTCHA proof-of-work
│   │   ├── A1.3.1. Submit fake solution
│   │   │   └── BLOCKED at: HMAC verification on issued challenge
│   │   ├── A1.3.2. Replay a solved challenge
│   │   │   └── BLOCKED at: usedSalts tracked, single-use
│   │   ├── A1.3.3. Outsource to CAPTCHA-solving farm (~$0.001/solve)
│   │   │   └── Economically unattractive: cost-per-account =
│   │   │       0.001 (PoW solve) + 100 BLURT fee paid by relay
│   │   │       — but the FOR ATTACKER cost is ALSO the IP/account
│   │   │       to send the request. The relay loses 100 BLURT,
│   │   │       attacker spends near-zero. So this attack DOES
│   │   │       work past the per-IP ceiling.
│   │   │       BLOCKED at: global daily ceiling (50/day cap)
│   │   └── A1.3.4. Solve PoW at scale on free tier
│   │       └── Same as above; gated by global ceiling.
│   │
│   ├── A1.4. Bypass global daily ceiling
│   │   ├── A1.4.1. Race condition between canAccept() and recordSuccess()
│   │   │   └── BLOCKED at: tryReserve() does atomic
│   │   │       canAccept-then-increment (synchronous in JS event loop)
│   │   ├── A1.4.2. Wait for UTC midnight rollover
│   │   │   └── PARTIAL: ceiling resets at midnight, attacker can
│   │   │       try again. But total daily damage is bounded.
│   │   │       Operator can lower ceiling or kill-switch.
│   │   └── A1.4.3. Trick the rollover into firing early
│   │       └── BLOCKED at: utcDateKey() uses Date.UTC*; clock
│   │           manipulation requires server access.
│   │
│   ├── A1.5. Bypass kill-switch
│   │   ├── A1.5.1. Race the env-var change
│   │   │   └── Env-var change requires restart; no in-flight bypass
│   │   ├── A1.5.2. Bypass the file sentinel
│   │   │   └── BLOCKED at: KillSwitch polls every N seconds; once
│   │   │       sentinel exists, every request rejects with
│   │   │       signups_disabled. Polling cadence creates a few-
│   │   │       seconds window after `touch` before requests
│   │   │       reject — acceptable.
│   │   └── A1.5.3. Delete the sentinel file
│   │       └── Requires server filesystem write access, which is
│   │           server compromise (out of scope).
│   │
│   └── A1.6. Bypass health-gate (relay_out_of_funds short-circuit)
│       └── Health is INTERNAL — not user-facing. Cannot be bypassed
│           from external requests. The endpoint refuses requests
│           when balance is below the safety floor.
│
├── A2. Make the relay broadcast a free transfer to attacker
│   ├── A2.1. Inject a transfer op into a signup flow
│   │   └── BLOCKED at: only the literal account_create op is
│   │       broadcast; relay-built transaction structure is
│   │       hardcoded in broadcastAccountCreate().
│   ├── A2.2. Trick the relay into sending signup_dust to wrong account
│   │   └── BLOCKED at: dust transfer's `to` is the freshly-created
│   │       name from the validated request, not user-controllable
│   │       beyond the name they paid for.
│   └── A2.3. Submit malicious payload that exploits a parser bug
│       └── BLOCKED at: zod schema with .strict() on every nested
│           object — no extra keys, no arbitrary values, no
│           prototype pollution surface.
│
├── A3. Compromise the relay's active key
│   ├── A3.1. Read it from the running process
│   │   └── Requires server compromise (out of scope at relay-level)
│   ├── A3.2. Read it from disk
│   │   └── BLOCKED at: relay refuses to start if keyfile mode is
│   │       group-or-other-readable (must be 0400 owned by morphit-relay)
│   ├── A3.3. Read it from logs
│   │   └── BLOCKED at: key is never logged; SECURITY.md contract
│   ├── A3.4. Read it from a response
│   │   └── BLOCKED at: only public keys are ever in responses
│   ├── A3.5. Brute-force the encrypted-envelope passphrase
│   │   └── Argon2id KDF with strong defaults; envelope format
│   │       in $crypto/keyEnvelope.ts. Brute-force impractical
│   │       against a strong passphrase.
│   └── A3.6. MITM the operator setting up the relay
│       └── Out of scope (operator OS-level threat model).
│
├── A4. Witness emergency-raise account_creation_fee to drain via signups
│   ├── A4.1. Witness sets fee to 1000 BLURT, signups still flow
│   │   └── BLOCKED at: relay refuses broadcast if chain fee >
│   │       110% of operator-configured MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT
│   ├── A4.2. Witness slowly increases fee just below 110% trigger
│   │   └── PARTIAL: a slow steady increase under 110% per check
│   │       could compound. Mitigation: witness fee changes are
│   │       publicly visible on chain; operator can monitor via
│   │       OPERATIONS.md §4 procedure.
│   └── A4.3. Witness colluding with attacker to time-coordinate raise
│       └── Same as A4.2; operator monitoring is the defense.
│
└── A5. Exploit the queue drainer to send unintended transfers
    ├── A5.1. Insert hostile rows into relay_pending_transfers
    │   └── Requires DB write access (operator compromise; out of scope)
    ├── A5.2. Trick the indexer into queueing hostile rows
    │   └── BLOCKED at: only feedback handler queues welcome
    │       bonuses, only on first-trade-complete with order_permlink
    │       owned by subject; loyalty handler queues BP rewards
    │       on trade volume, deterministically.
    └── A5.3. Replay-attack the drainer to double-broadcast
        └── BLOCKED at: per-row error_count + retry cap;
            broadcast_at marks row done; concurrent drainer
            invocations are single-process so no external
            replay surface.

LEAVES MARKED "BLOCKED" — defended.
LEAVES MARKED "PARTIAL" — bounded; operator-monitoring closes the loop.
LEAVES MARKED "Out of scope" — relay-level threat model assumes the host
                                 isn't compromised.
```

## Discoveries from the attack-tree walk

### REVISIT-LIST item: per-/64 IPv6 bucketing for rate limits

A1.1.4 notes that per-full-IPv6-address bucketing isn't very effective
because IPv6 prefixes give attackers /64 (or wider) breadth. A polished
deployment would bucket by /64 prefix (and /24 for IPv4). The global
daily ceiling closes the worst-case loop, but a more granular per-prefix
limit would catch botnet abuse earlier in the funnel.

This isn't a launch-blocker — the ceiling already caps absolute damage.
Logging in REVISIT-LIST as a future polish item.

### Witness-coordinated fee creep (A4.2)

The 110% trip-wire detects abrupt fee increases. A patient adversarial
witness who raises the fee 5% per check could compound to 2× over 14
checks without ever triggering. The OPERATIONS.md §4 procedure tells
operators to monitor fee changes; but there's no automated alerter.

REVISIT-LIST item: add a chain-fee delta alert that fires when the live
chain fee has moved more than X% over the last Y days. Same channel as
the operator-balance alerter.
