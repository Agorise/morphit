# ADR-0010 — Key custody for Morphit's Blurt accounts

**Status:** Accepted (Phase 4)
**Date:** 2026-04-19
**Deciders:** project maintainer
**Supersedes:** none
**Superseded by:** none
**Related:** ADR-0011 (dynamic fee model)

## Context

Morphit operates three Blurt accounts on behalf of the project:

- `@morphit` — signs release announcements (`morphit_release_v1`
  custom_json ops). Signed infrequently; posting authority is
  sufficient.
- `@morphit-relay` — creates Blurt accounts for new Morphit
  users and sends them a small BLURT "dust" to enable their
  first chain op. Account-creation ops on Blurt require
  **active** authority.
- `@morphit-fees` — receives listing fee transfers in BLURT,
  BTC, or XMR. Purely passive receipt of BLURT; BTC/XMR fees
  flow to externally-controlled addresses documented separately.
  No keys needed on any server to receive BLURT.

The project owner's closeout note raised the core concern
plainly:

> *"the morphit.io master server will have to hold the private
> keys of the morphit blurt account. that's a MASSIVE honeypot.
> ... so maybe we can keep both the owner AND the active
> private keys OFF of the server(s)."*

The project owner later clarified the key-custody posture
through a design discussion. This ADR documents the outcome.

## Chain mechanics (for reference)

Blurt forked from Steem and inherits Steem's two-phase account
creation:

1. **`claim_account`** — the claiming account pays the witness-
   set account creation fee in BLURT to mint an Account Creation
   Token (ACT). Requires **active** authority. ACTs don't
   expire, aren't transferable between accounts, and there's no
   upper limit per claiming account.
2. **`create_claimed_account`** — consumes one ACT to create a
   new account. Costs no BLURT beyond the original claim fee.
   Requires **active** authority.

Both ops need the claiming account's active key. Pre-minting
ACTs does NOT eliminate the need for an online active key —
`create_claimed_account` still needs it. But pre-minting
decouples the relay's BLURT BALANCE from the account creation
rate, which is the point.

A note on terminology: **"voucher" in Blurt community usage
(e.g., blurtplugin.online) refers to an application-layer
redemption code, NOT the chain ACT.** A community voucher
service issues redemption codes to users and internally
consumes its own ACTs when a code is redeemed. Morphit does
NOT use the community voucher system; we issue ACTs on-chain
directly.

Current fee levels (as observed on blocks.blurtwallet.com at
the time of this ADR):

- `account_creation_fee`: **100.000 BLURT per ACT**
- Operation flat fee: 0.050 BLURT
- Bandwidth fee: 0.200 BLURT/KB

These are witness-controlled and subject to change. ADR-0011
documents how Morphit tracks witness changes and adjusts the
listing fee to preserve margin.

## Decision

### 1. Three accounts, three key-custody postures

**`@morphit-fees`** — no online keys. Owner and active keys
exist on cold paper backup only. Memo key generated but not
used. The account accumulates BLURT from listing fees over
time; periodic ceremonial withdrawal from cold storage moves
funds as needed.

**`@morphit`** — posting key only, online. Release announcements
use `morphit_release_v1` custom_json ops which take posting
authority. Owner key and active key are paper-only. The posting
key sits on a dedicated release-signer machine, decrypted into
memory only when a release is being signed. If this machine is
compromised, an attacker can publish false release announcements
— but the frontend pins `MORPHIT_OFFICIAL_POSTING_PUBKEY` at
build time, so key rotation via the owner key (paper) recovers
cleanly.

**`@morphit-relay`** — active key online, with the blast-radius
mitigations below. Owner key paper-only.

### 2. Registration flow (new Morphit user)

The user-facing flow, landed in its final form:

1. User visits Morphit. Signup is **free** and requires no
   crypto. Users are explicitly encouraged to use VPN/Tor; no
   browser fingerprinting, no captchas.
2. Frontend generates user keys locally and calls the relay
   with a signed request to create their Blurt account.
3. Relay consumes one pre-minted ACT via `create_claimed_account`
   to create the user's account on-chain.
4. Relay sends the user **1 BLURT dust** via `transfer` so their
   fresh account has enough on-chain bandwidth to post their
   first Morphit order.
5. User's first order is a BUY (any supported asset). The
   listing fee is **waived** for the first buy order per
   account — this is grandma's onboarding: she posts her
   first buy-BLURT order and acquires her first crypto through
   Morphit. See ADR-0011 for the multi-asset fee mechanics.
6. When the user's first order successfully completes a trade
   (detected by the indexer), the relay transfers the welcome
   bonus: **10 BLURT liquid + 10 BLURT Power** (via
   `transfer_to_vesting`). This bonus is delayed until first
   successful trade — not granted at signup.
7. Thereafter, the user pays the standard listing fee (in
   BLURT, BTC, or XMR — their choice, BLURT default) for each
   new order.

This flow is deliberately designed so that **grifters cannot
profitably spam-register accounts.** A grifter who signs up
N accounts and never completes a trade receives N × (1 BLURT
dust) = N × $0.002 of extractable value. The 10+10 welcome
bonus is only paid on successful trade completion, which
requires real counterparty interaction and a paid listing fee
on any subsequent orders. The economics are negative-sum for
grifters and are disclosed publicly in the FAQ.

### 3. Low-balance auto-refill

Users who remain active on Morphit but exhaust their BLURT on
chain-bandwidth fees get an automatic **1 BLURT dust refill**
from the relay whenever their balance drops below 0.5 BLURT,
gated on recent Morphit activity (they must have a Morphit op
in the last N days; exact threshold operator-configured). This
keeps grandma from getting stuck mid-session without BLURT to
pay bandwidth.

Grifter exploitation: a bot signing up many accounts to farm
the 1 BLURT dust still needs real counterparty trades (or
Morphit ops) to trigger the refill. Dust value is $0.002 per
refill; extraction is slow.

### 4. Active-key blast-radius mitigations for `@morphit-relay`

- **Always use `claim_account` + `create_claimed_account`.**
  Never use the one-shot `account_create` op. This keeps the
  account's BLURT balance decoupled from the creation rate.
- **Keep `@morphit-relay` at near-zero BLURT during operation.**
  The relay's working liquid balance is sized to cover
  approximately **one week of expected signups + dust refills**.
  At an initial rate of 20 signups/week (project owner's
  estimate), the relay holds about 20 BLURT for dust + some
  buffer — roughly 50 BLURT at any time. At a later rate of
  500 signups/week, the weekly float rises to ~500 BLURT + the
  week's expected welcome bonuses of ~5,000 BLURT if most
  signups complete trades → ~5,500 BLURT working balance.
- **Passphrase-at-boot for the active key.** The relay service
  does NOT hold the decrypted active key on disk. At startup,
  the operator SSHes in and enters a passphrase interactively;
  the service holds the decrypted scalar in memory only. A
  service restart requires a human.
- **ACT minting is a weekly manual ceremony.** Minting tickets
  (`claim_account`) happens via a weekly script that the
  operator runs by hand with the active-key passphrase. It is
  separate from the persistent relay service; the relay
  consumes ACTs it cannot mint. (As of beta.24 this can instead
  be handled in-process by the opt-in auto-minter — see §5 —
  which keeps the active key in the relay's memory rather than
  requiring a separate passphrase session, a tradeoff that
  section makes explicit.)
- **BLURT top-ups via `recurrent_transfer`.** Blurt supports
  native recurrent transfers. The operator configures a
  recurrent transfer from a funding account (cold-storage-
  replenished) to `@morphit-relay` on a weekly cadence. The
  funding account's active key is NOT on any server — the
  recurrent_transfer is set up once with the funding account's
  active key (entered from cold), then runs autonomously
  on-chain for its configured duration. Reduces operator burden
  to a single weekly ACT minting session, not two.
- **Dedicated host.** `@morphit-relay`'s key material lives
  only on the relay VM — not on the indexer host, not on
  developer machines, not in backups. Owner-key backup is
  paper, stored in a physical location separate from the
  maintainer's home office.
- **Nginx rate limit: 2 signups per IP per day.** Weak — defeated
  by VPN/Tor/mobile carrier NAT — but establishes a floor
  against casual abuse. No fingerprinting; no captchas.
  Privacy-positive posture is a deliberate tradeoff: we accept
  higher grifting risk in exchange for VPN/Tor-friendly UX.
- **Operator velocity alerts.** Indexer monitors signup rate per
  hour and per day. Signups exceeding configured thresholds
  auto-pause registration and page the operator.
- **Operator incident response:** if velocity alerts fire, the
  operator can pause the relay at nginx while investigating,
  rotate keys from paper backup if compromise is suspected.

### 5. ACT auto-minter (in-process buffer maintenance)

The weekly manual ceremony (§4) keeps the active key out of any
routine automation: the operator SSHes in and runs `mint-acts.ts`
with the passphrase. That is the most conservative posture, but
it puts a human in the loop for routine refills and risks the
relay running out of ACTs between sessions — signups then fail
with `relay_out_of_funds` even though the relay holds plenty of
BLURT, because the gate is ACT availability, not balance.

The **auto-minter** (`MORPHIT_RELAY_AUTOMINT_ENABLED`, default ON as of
beta.24 — a relay that can't create accounts is a broken relay, so
self-refill is the right default) removes the routine human step. The persistent relay service —
which already holds the decrypted active key in memory to run
`create_claimed_account` for signups — periodically:

1. reads its own `pending_claimed_accounts` (ACT buffer) and
   liquid balance;
2. if the buffer is at/above the low-water mark, does nothing;
3. otherwise mints `claim_account` ops back up toward the target,
   capped per cycle, **spending only liquid BLURT above a
   configured reserve** (the reserve protects welcome bonuses,
   dust refills, and fees from being starved by minting);
4. if it cannot afford even one ACT without dipping into the
   reserve, it mints nothing and logs `automint_insufficient_blurt`.

**Tradeoff (deliberate, documented).** Auto-minting does NOT
widen the key's storage posture — `create_claimed_account`
already requires the active key in memory, so the relay is
already an online-active-key service (§1, §4). Auto-minting adds
*more frequent use* of that same key for `claim_account`, but no
new exposure surface: same key, same memory, same op family. It
trades the weekly passphrase session for continuous unattended
operation. Operators who prefer the human-in-the-loop posture set
`MORPHIT_RELAY_AUTOMINT_ENABLED=false` and keep the weekly ceremony.

**Direct "signups are down" alert.** Independent of minting, the relay's
health poller watches its own `pending_claimed_accounts`; when it falls
below the reject gate (`MIN_PENDING_CLAIMED_ACCOUNTS` = 3) — i.e. signups
are being refused with `relay_out_of_funds` — it emits a CRITICAL
`relay-acts:act_buffer_depleted` alert (hysteresis: once per downward
cross), which the matrix-bot routes to the operator. This is the alert
that was MISSING when a signup failed while the relay held plenty of
BLURT: the balance scanner can't catch it because the gate is ACT
availability, not balance.

**Closing the loop with notifications.** Because minting spends
BLURT, a busy instance eventually needs a top-up. The indexer's
operator-balance scanner already watches `@morphit-relay`'s
on-chain balance and emits `operator-balance:low_balance` when it
crosses a threshold; the matrix-bot turns that into a Matrix DM.
The auto-minter additionally emits `automint_insufficient_blurt` /
`automint_partial_insufficient_blurt` the moment minting is
constrained by BLURT, which the matrix-bot also routes to Matrix.
Operators set the balance threshold ABOVE the auto-mint reserve
(plus a cycle's worth of fees) so the warning arrives BEFORE
minting stalls. See docs/OPERATIONS.md §47 for the exact knobs.

**Invariants (enforced at boot when enabled).** The low-water
mark must be greater than the relay's signup reject gate
(`MIN_PENDING_CLAIMED_ACCOUNTS` = 3) and no greater than the
target, so the minter refills before signups are rejected and
never computes a negative mint count. The `claim_account` op
shape is single-sourced in `BlurtClient.broadcastClaimAccount`,
shared with the manual `mint-acts.ts`, so the two paths can't
drift.

### 6. Blast radius analysis

In the worst case — full compromise of the relay VM while it
holds the decrypted active key in memory — the attacker can:

1. **Consume all pre-minted ACTs** to create junk accounts. At
   ~1 week of ACT buffer (say 50 tickets early, 500 later), the
   attacker can create that many junk accounts. Morphit loses
   the prepaid claim cost (~$10-100 of BLURT). Each junk account
   also triggers a 1 BLURT dust, increasing the loss.
2. **Transfer the working liquid BLURT balance** to an attacker-
   controlled account. At the sizing above, ~$0.10-$11 of direct
   theft depending on weekly rate.
3. **Transfer BLURT received via the `recurrent_transfer`**
   during the compromise window. The recurrent_transfer is
   one-way (funding → relay); the attacker can steal each
   weekly disbursement until the operator revokes the recurrent
   transfer. Bounded by detection time.

Total direct monetary damage in a worst-case full compromise:
**one week of Morphit's operating float plus pre-minted ACT
value.** Under $25 early, under $150 at 500 signups/week. This
is not zero, but it is bounded and affordable.

What the attacker CANNOT do (because those keys are paper-only):

- Drain `@morphit-fees` accumulated revenue
- Steal owner-key authority over any Morphit account
- Publish false release announcements signed by `@morphit` (the
  release-signer machine is a separate host; its compromise is
  independent and is mitigated by frontend pubkey pinning)
- Change the registered recovery account on `@morphit-relay`
  without the owner key (Blurt's recover_account mechanism
  requires owner-or-recovery-partner authority)

### 7. Owner keys — always paper, always air-gapped

For all three accounts, the owner key is generated in an
air-gapped environment, printed to paper, and stored in a
physical safe. A copy exists at a second physical location
controlled by a trusted agent for disaster recovery.

Owner keys are NEVER:
- Stored on any internet-connected machine, even encrypted
- Transmitted over any network, even end-to-end encrypted
- Photographed with a device that has ever been online
- Stored in any password manager, cloud or otherwise
- Typed on any machine that has ever accessed the internet

Owner-key events are rare: the initial account creation (once),
key rotations after a suspected compromise (hopefully never),
and periodic withdrawals from `@morphit-fees` to pay operating
costs (maybe quarterly). Each event is a one-time ceremony with
deliberate friction.

### 8. "Super-encrypt everything" is not the right mental model

The original closeout note raised the possibility of "super-
encrypt[ing], salt[ing], hash[ing], whatever you call it with
the strongest security known to mankind." This is a common
instinct, but layered disk encryption adds zero marginal
security if the decryption key lives on the same machine. The
correct mental model is:

- **Minimize keys present online.** Biggest win. `@morphit-fees`
  and paper-only owner keys follow this.
- **If a key MUST be online, use passphrase-at-boot.** The
  decryption input lives in the operator's head, not on the
  machine. Disk compromise yields an encrypted blob;
  running-process-memory compromise yields the decrypted key.
  The attack surface is running memory, not disk.
- **If a key must be online AND must survive reboots without a
  human, use a hardware security module.** YubiHSM2 or
  equivalent holds key material in tamper-resistant hardware;
  the service can sign via the HSM but cannot extract the key.
  This is overkill for Morphit's current scale but is the right
  answer if operational needs change.

Morphit uses the first two. HSM stays as the escalation path.

## Alternatives considered

### Charge a small upfront registration fee

**Rejected by project owner.** Grandma has no crypto yet;
Morphit's value proposition is helping her acquire her first
crypto. Any upfront fee defeats the core use case.

### Keep `@morphit-relay` always well-funded

**Rejected.** A compromised relay with a large BLURT balance
can be drained for real money. Near-zero balance + weekly
top-up bounds the damage.

### Browser fingerprinting to detect multi-account signup abuse

**Rejected by project owner.** Conflicts with the privacy-
positive posture (VPN/Tor encouragement). We accept more
grifting exposure for a cleaner privacy story — and we
compensate with delayed-bonus economics that make spam-signup
unprofitable.

### CAPTCHAs at signup

**Rejected by project owner.** Bad UX, privacy concerns, and
defeated by modern CAPTCHA-solving services anyway.

### Hardware security module for `@morphit-relay`

**Reserved as escalation path.** Current passphrase-at-boot is
sufficient for the projected load. Revisit if the relay needs
to run unattended.

### Multi-sig account auths on @morphit-relay

**Rejected.** Adds operational complexity (multiple operators
must coordinate each ACT mint) without meaningful security
gain at our scale.

## Consequences

### Positive

- Grandma can sign up for Morphit with no crypto, receive 1
  BLURT of dust to pay chain fees, post her first buy order for
  free, and complete her first crypto trade — the core use case
  works.
- Grifter economics are negative-sum: welcome bonuses are
  delayed until first paid trade, so spam-signup yields at most
  the 1 BLURT dust ($0.002 per attempt) until real trades are
  completed.
- `@morphit-relay`'s BLURT balance is kept near-zero during
  normal operation; worst-case compromise damage is ~$25-150
  depending on traffic rate.
- Owner keys never touch online systems; full service compromise
  does not escalate to account takeover.
- The privacy-friendly posture (no fingerprinting, no captcha,
  VPN/Tor welcomed) is a marketing differentiator, disclosed
  prominently in the FAQ.

### Negative

- Relay service restarts require a human operator to enter a
  passphrase. Unattended reboots leave the relay dark.
- Once a week, a human must run the ACT-minting script. If
  skipped, the ticket pool eventually drains and new user
  registration fails.
- Paper owner-key backups require physical security discipline.
- The first-order-free-for-new-accounts policy means Morphit
  eats the listing fee for every first buy. This is bounded:
  limited to one per account, one-time.
- Grifters can still create junk Blurt accounts via Morphit at
  the cost of the ACT fee (100 BLURT per account), paid by
  Morphit. Operator monitors velocity; nginx rate limits set a
  floor; the FAQ discloses the economics publicly as a
  disincentive.

### Neutral

- `@morphit-fees` accumulates BLURT over time; periodic
  withdrawal ceremonies move funds to cold storage or pay
  operating costs.
- The BTC and XMR listing-fee-receipt addresses are managed
  outside this ADR (they're regular Bitcoin and Monero addresses,
  not Blurt accounts).

## Implementation plan

This ADR is a design document; the code and operational changes
it implies land over multiple Phase 4 turns:

### Code

1. **Relay: ACT pre-minting script** (`scripts/mint-acts.ts`)
   — standalone tool; prompts for active-key passphrase;
   mints N tickets; logs operation.
2. **Relay: passphrase-at-boot flow.** Replace env-var active
   key with stdin prompt at service start.
3. **Relay: signup flow updated.** Use `create_claimed_account`
   (not `account_create`). Send 1 BLURT dust after account
   creation.
4. **Relay: low-balance auto-refill.** Indexer detects active
   users whose BLURT balance drops below 0.5 BLURT; relay sends
   1 BLURT dust.
5. **Indexer: velocity monitor.** Track signups per hour/day;
   pause relay if thresholds exceeded; page operator.
6. **Indexer: delayed welcome bonus trigger.** On first
   successful trade completion, instruct relay to send 10
   BLURT + 10 BP to the user.
7. **Nginx: 2 signups/IP/day rate limit.**
8. **Frontend: pubkey pin audit.** Verify all trust-anchor
   pubkeys are build-time-pinned.

### Documentation

9. **Operator runbook** (`docs/OPERATIONS.md`) — weekly ACT
   minting procedure, reboot procedure, owner-key rotation
   ceremony, incident response for suspected key compromise,
   `recurrent_transfer` setup instructions.
10. **FAQ: attack-vector disclosure.** Publicly documents why
    self-trading and multi-accounting don't pay.

### One-time setup (pre-launch)

11. Physical owner-key ceremony for `@morphit`,
    `@morphit-relay`, `@morphit-fees`.
12. Fund a cold-controlled source account for the
    `recurrent_transfer` to `@morphit-relay`.
13. Configure recurrent_transfer from funding account →
    `@morphit-relay`, weekly cadence, appropriate amount
    based on projected signup rate.
14. Deploy release-signer machine; transfer `@morphit`
    posting key to it; pin the corresponding pubkey in the
    frontend build.

Items 1–8 and 10 are per-turn deliverables during Phase 4. Item
9 is written incrementally as pieces land. Items 11–14 are
operational milestones coordinated with deployment.

## Non-goals

- Multi-sig account auths. Out of scope.
- HSM deployment. Reserved as escalation path.
- Key rotation automation. Rare ceremonial events only.
- Replacement of the release-signer host with a cloud HSM
  service (e.g., AWS KMS). Operator-choice decision outside
  this ADR.
