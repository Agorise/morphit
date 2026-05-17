# Morphit — automation audit of manual interventions (Q6)

**Last reviewed:** 2026-05-01

This catalog enumerates every place in Morphit where a human
operator, admin, or user has to do something manually that
could potentially be automated. For each item: the current
state, the automation potential (HIGH / MEDIUM / LOW), the
cost, and the recommendation.

The goal isn't to automate everything — some manual gates
exist deliberately to preserve operator control over
expensive, irreversible, or high-trust actions. The goal is
to surface where automation would meaningfully reduce
operator load without increasing risk.

This audit complements `docs/OPERATIONS.md` (the operator
runbook) and `docs/RUN-A-MORPHIT-NODE.md` (the new-operator
walkthrough). Both must stay aligned with this catalog.

---

## 1. Operator-side manual tasks

### 1.1 Weekly ACT minting ceremony — ✅ AUTOMATED (was: HIGH automation potential)

**Today** (manual fallback): Operator SSHes weekly, runs
`npm run mint-acts -- 25` (or `npx tsx scripts/mint-acts.ts 25`),
verifies on-chain, journals.

**Today** (recommended path, since 2026-05): operator runs the
one-time systemd setup (`ops/systemd/morphit-relay-mint-acts.{service,timer}`),
which fires every Sunday 04:00 UTC and mints
`MORPHIT_RELAY_WEEKLY_ACT_COUNT` ACTs (default 25). Operator
checks `journalctl -u morphit-relay-mint-acts` once per month
to confirm green; alerts fire on failed runs via the existing
journald-watch pipeline.

**Why automation is fine**: the cap is the operator-set
weekly count + the relay's working balance. Automating doesn't
increase the maximum loss on relay compromise — the timer
inherits the same caps.

**Implementation:**
1. SystemD timer `morphit-relay-mint-acts.timer` runs
   `OnCalendar=Sun *-*-* 04:00:00 UTC` weekly with up to 30 min
   randomized delay.
2. The script reads `MORPHIT_RELAY_WEEKLY_ACT_COUNT` env var
   (default 25, operator-tunable in `/etc/morphit/relay.env`).
3. Active-key access via `LoadCredential=` pointing at a
   root-owned 0600 file, or `LoadCredentialEncrypted=` with
   `systemd-creds` for higher-threat-model operators.  The
   script reads `MORPHIT_RELAY_PASSPHRASE_FILE` from systemd's
   `$CREDENTIALS_DIRECTORY`.
4. Failure mode: oneshot exit non-zero with detail in journal;
   operator's existing alert pipeline (see §1.6) catches it.

**Saves**: ~10 min/week × 52 weeks = ~9 hr/year per operator,
plus the cognitive overhead of "am I going to forget the
ceremony this week?" which is the real cost.

**STATUS**: ✅ Implemented 2026-05-01. See OPERATIONS.md §2
"Unattended mode" for the operator-facing setup steps.

---

### 1.1-archive: original framing (preserved for ADR-0010 traceability)

**Why manual originally**: ADR-0010 §4 framed this as a
deliberate operator-in-the-loop step so the relay's working
BLURT balance stays small and a compromised relay can't drain
unbounded BLURT into ACTs. The 2026-05 review concluded the
caps still hold under timer-driven minting (§1.1 above), so
the in-the-loop confirmation became a cron job.

---

### 1.2 Recurrent BLURT top-up to relay — ALREADY AUTOMATED

**Today**: ADR-0010 §3 ships a `recurrent_transfer` op the
operator broadcasts ONCE at setup time. Blurt natively
recurses the transfer weekly for `executions=52` (one year).

**Why this is good**: Native chain primitive. No off-chain
cron, no hot key on a server. The operator re-broadcasts
once a year (or sooner if their fee-account address changes)
— that's a quarterly-or-better cadence, not weekly.

**STATUS**: Already automated; no work to do.

---

### 1.3 TLS certificate renewal — ALREADY AUTOMATED

**Today**: certbot installs a systemd timer that runs twice
daily and auto-renews when the cert is within 30 days of
expiry.

**Recommended addition**: a weekly `cron.weekly` job that
checks expiry and pages the operator if certs ARE near
expiry but renewals haven't fired (catches certbot
configuration drift). This is in OPERATIONS.md §14.5
already.

**STATUS**: Already automated; the optional alert wrapper
is documented but not shipped as a default unit.

---

### 1.4 Witness fee change response — MEDIUM automation potential

**Today**: When Blurt witnesses change `account_creation_fee`,
the operator sees an alert and manually updates
`MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT` and
`MORPHIT_RELAY_ACCOUNT_CREATION_FEE_BLURT` env vars,
restarts services.

**Why manual today**: Setting a wrong fallback value silently
breaks signup. Operator-in-the-loop catches misreads.

**Why automation is constrained**: The fallback is exactly
that — a fallback for when chain RPCs are unreachable.
Auto-updating it from the chain would create a
self-referential bootstrap problem if the auto-update path
itself relies on chain RPCs.

**Recommended partial automation**:
- Indexer + relay should both observe `account_creation_fee`
  changes via their normal block-walk and EMIT a structured
  log line at WARN level when the observed fee differs from
  the configured fallback by more than 10%. This is already
  partly there for the indexer (chain-fee tracker); not yet
  for the relay.
- Operator gets an alert via their journald-watching pipeline
  when the warning fires; manual restart is fast.

**Cost**: ~20 lines (relay-side warn-log of fee divergence).

**STATUS**: ✅ Both shipped.  Indexer-side tracker existed at
audit time; relay-side warn-log shipped in Part 117 —
`apps/relay/src/blurt/client.ts:157` defines
`FEE_DIVERGENCE_WARN_THRESHOLD = 0.1` and
`analyzeFeeDivergence()` at line 168 emits a structured
`chain_props_account_creation_fee_diverges_from_config`
warn-log when the observed fee differs from the configured
fallback by more than 10%, throttled once-per-process-startup.
Smoke regression at `apps/relay/scripts/fee-divergence-smoke.ts`
registered in `scripts/run-smokes.sh`.

---

### 1.5 Stale price feed alert — ALREADY AUTOMATED

**Today**: Indexer's price source emits `stale=true` after
N minutes without a successful upstream fetch. The frontend
hides the USD echo when stale. Operator sees journald
`price.fetch.failed` lines.

**STATUS**: Already automated; alerting is via the
operator's normal journald pipeline.

---

### 1.6 Operator-account balance monitoring — ALREADY AUTOMATED

**Today**: Indexer scans operator-fees balances and emits
structured alerts when below operator-configured thresholds.
Documented at OPERATIONS.md §16.

**STATUS**: Already automated.

---

### 1.7 Relay queue stuck — MEDIUM automation potential

**Today**: A signup queue entry can get stuck (network errors,
RC depletion, etc.). The operator manually nulls the
`broadcast_at` to retry.

**Why manual today**: Stuck entries can mask deeper relay
problems (RC depletion, key issues, broken endpoints). An
automated retry loop could mask these.

**Recommended partial automation**:
- Auto-retry up to 3 times with exponential backoff (1m, 5m,
  15m). After 3 failures, the entry stays stuck and waits
  for operator review.
- Today the relay does retry on transient network errors but
  not on the stuck-entry flagged-for-manual case.

**Cost**: ~80 lines (queue-entry retry counter + scheduler).

**STATUS**: Documented as a future hardening pass. Not
urgent — operator manual flow is rare and well-documented.

---

### 1.8 Schema migrations — ALREADY AUTOMATED

**Today**: Indexer auto-runs migrations on boot via
`apps/indexer/src/db/migrations.ts`. v17 has a brief
sequential-scan window during the upgrade documented at
OPERATIONS.md §21; otherwise transparent to the operator.

**STATUS**: Already automated.

---

### 1.9 Server OS package updates — DOCUMENTED + RECOMMENDED

**Today**: OPERATIONS.md §14.6 recommends `unattended-upgrades`
for security patches. Operator chooses to enable.

**STATUS**: Documented; not enforced by Morphit's installer
because the installer doesn't exist as a single thing — the
operator runs through RUN-A-MORPHIT-NODE.md. The walkthrough
SHOULD include enabling unattended-upgrades as a checklist
item. (See §3.3 below.)

---

## 2. User-side manual tasks (Q9 setup-checklist territory)

These are the user/operator's checklist responsibilities
during account setup or daily use. Q9's "operator setup
checklist + nudges" answer expands on this — see that
section.

### 2.1 Backup the 12-word seed — ✅ AUTOMATED 2026-05-01

**Today**: Signup flow displays the seed once with a "I've
saved it" gate.  Plus, after 7 days of active use on this
device, a soft amber banner appears at the top of every page
asking "have you backed up your seed somewhere durable?" with
a "Show me how →" link to the recovery FAQ and a one-tap
permanent dismissal.

**Implementation**:
- localStorage anchor `morphit.keystore.first_persist_at`
  stamped on first successful `writeEnvelope` (in
  `apps/web/src/lib/crypto/persistentKeystore.ts`).
- Banner component `SeedBackupNudge.svelte` calls
  `shouldShowSeedBackupNudge()` on mount; renders only when
  ≥7 days since first persist AND not dismissed.
- "Got it" sets `morphit.keystore.backup_nudge_dismissed = '1'`,
  hiding the banner permanently on this device.
- Full sign-out (`clearKeystore`) wipes both anchors so
  re-onboarding restarts the prompt schedule.

**STATUS**: Shipped.

---

### 2.2 Verify counterparty's chat-pub on first contact — ✅ SHIPPED

**Today**: `apps/web/src/lib/components/VerifyPeerPanel.svelte`
renders an explicit Verify-peer panel inside `ConversationView`
showing the deterministic `(my_chat_pub, peer_chat_pub)`
fingerprint pair (computed in `apps/web/src/lib/chat/fingerprint.ts`).
Users compare fingerprints out-of-band (voice, in-person,
side-channel) and confirm.  That's a manual user action by
design — the machine can't out-of-band compare.

**STATUS**: Shipped (panel + fingerprint helper + locale
strings in all 10 locales).

---

### 2.3 Mark trade complete + leave feedback — MANUAL BY DESIGN

**Today**: After receiving funds, the buyer/seller manually
clicks "Trade complete" and "Leave feedback". This is
deliberately manual — Morphit doesn't run any wallet, so
"funds received" is something only the user can attest to.

**STATUS**: Cannot be automated without breaking the
non-custodial design. Already as automated as it can be.

---

## 3. Operator setup tasks (Q9 territory — feeds into the checklist)

### 3.1 Enable unattended-upgrades — should be in setup checklist

**Cost**: 1 command in the walkthrough.

**STATUS**: Documented in OPERATIONS.md §14.6. Should be
flagged in `ops-cli init` as a checkbox + ufw / fail2ban /
SSH key-only mode.

### 3.2 Configure systemd timers for auto-tasks — should be in setup checklist

If §1.1 (weekly ACT mint) becomes auto-cron'd, the operator's
setup wizard should install + enable the timer alongside the
relay.

### 3.3 ops-cli should verify everything's in place — Q9 deliverable

The `ops-cli init` wizard already does: chain RPC reachability,
account existence check, key-file perms check, fee-address
viewkey verification, etc. It should ALSO run a final
checklist verification step that pings each of these and
prints "✅ done" or "⚠ missing — run X to fix":

| Check | Today | Recommended |
|---|---|---|
| `morphit-fees` account exists | ✅ done | Keep |
| Active-key file mode 0400 | ✅ done | Keep |
| Indexer DB connection works | ✅ done | Keep |
| RPC endpoint reachability | ✅ done | Keep |
| Relay BLURT balance > floor | ✅ done | Keep |
| TLS cert valid + auto-renew configured | ✅ done | Keep |
| `unattended-upgrades` installed + enabled | ❌ not yet | **Add** |
| `ufw` enabled + correct ruleset | ❌ not yet | **Add** |
| SSH `PasswordAuthentication no` | ❌ not yet | **Add** |
| `fail2ban` installed + sshd jail enabled | ❌ not yet | **Add** |
| journald disk cap configured | ❌ not yet | **Add** |
| weekly-mint timer installed (§1.1 shipped 2026-05-01) | ❌ not yet | **Add** |
| witness-fee-divergence warn-log configured | ❌ not yet | **Add** |
| frontend CSP headers verified | ✅ done (§15) | Keep |
| Tor onion mirror reachability | ❌ not yet | **Add** |

This expanded checklist becomes Q9's deliverable — see the
Q9 plan in this session's notes.

---

## 4. What we deliberately do NOT automate

A list of "could automate, but shouldn't":

- **Trade matching.** Buyers and sellers pick each other based
  on reputation, terms, location. Auto-matching breaks the
  trust model.
- **Dispute resolution.** Morphit has no arbitrator role
  (FAQ `no_escrow_arbitration`). A bot that "decides who's
  right" would be a centralization vector.
- **Fund release.** Non-custodial means the seller releases
  funds when the buyer pays. No bot can decide when payment
  has arrived in a non-custodial flow — only the human
  actually receiving the funds knows.
- **Reputation moderation.** Feedback is permanent and
  signed. A bot that "removes spam reviews" is a
  centralization vector. (Operators can suppress display on
  their own instance; the chain record is permanent.)
- **Owner-key rotation.** OPERATIONS.md §8 — must be human
  with cold-storage backups verified.
- **Initial ACT-key passphrase entry on relay first boot.**
  Documented in OPERATIONS.md §3. Subsequent reboots can use
  systemd `LoadCredentialEncrypted=` if the operator chooses;
  first boot is human.

---

## 5. Cross-cutting automation ideas

### 5.1 Health endpoints for external monitoring

The indexer already exposes `/v1/health`. The relay should
too (today it has a `/v1/health` but coverage is thin).
Operators can wire these into their existing monitoring
(Uptime Kuma, Statping, etc.).

### 5.2 Structured log shipping

Both indexer and relay log to journald. Operators wanting
remote log aggregation can ship via journald → Vector → any
sink. Documented in OPERATIONS.md.

### 5.3 Automated backup of operator config + key envelopes

Encrypted active-key envelopes are at `/etc/morphit/*.key.enc`.
The operator should back these up off-host (not the relay's
own filesystem). OPERATIONS.md should add a recommendation
for an automated nightly rsync to a backup destination,
encrypted at rest. Currently silent on this.

---

## Summary table

| # | Task | Auto today? | Recommend automating? | Effort |
|---|---|---|---|---|
| 1.1 | Weekly ACT minting | ❌ Manual | ✅ HIGH | ~80 lines + systemd unit |
| 1.2 | Recurrent BLURT top-up | ✅ Native chain | n/a | done |
| 1.3 | TLS renewal | ✅ certbot | n/a | done |
| 1.4 | Witness fee change response | ❌ Manual | 🟡 Partial — log warn | ~20 lines |
| 1.5 | Stale price feed | ✅ stale flag + log | n/a | done |
| 1.6 | Operator-account balance | ✅ scanner + alerts | n/a | done |
| 1.7 | Relay queue stuck | ❌ Manual | 🟡 Partial — auto-retry 3× | ~80 lines |
| 1.8 | Schema migrations | ✅ on-boot | n/a | done |
| 1.9 | OS package updates | 🟡 Documented | ✅ Add to setup checklist | doc only |
| 2.1 | Backup-seed nudge | ❌ Manual | ✅ Add a 7-day prompt | ~30 lines |
| 2.2 | Counterparty pub verify | ❌ Manual UX gap | 🟡 Tracked (Option 6) | ~150 lines |
| 2.3 | Mark trade complete | ❌ Manual by design | ❌ Cannot — non-custodial | n/a |
| 3.x | Setup checklist | 🟡 Partial | ✅ Q9 deliverable | ~200 lines |

---

## Next steps

1. Implement §1.1 (weekly ACT mint via systemd timer + env var
   count). High value; medium effort. Tracked in REVISIT-LIST §G.
2. Implement §3.3 (expanded setup checklist) as part of Q9.
3. Implement §2.1 (7-day backup-seed nudge). Small.
4. Document §1.9 + §5.3 in OPERATIONS.md and
   RUN-A-MORPHIT-NODE.md.

These can be picked up in any order; they don't depend on
each other.
