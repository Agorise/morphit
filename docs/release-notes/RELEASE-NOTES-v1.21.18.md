# Morphit v1.21.18

**Operators: every instance must run v1.21.18 before 1 November 2026, 00:00 UTC (by block time).** From that time
every Morphit indexer judges fees with the same rules and the same numbers, whatever its own settings say. Until now
some of those numbers were each instance's own settings, so two instances fed the same blocks could store different
results — an order paid on one and unpaid on another, and with it a different trade, review or featured slot. An
instance still on an older release then would store results its peers do not.

## The new rules, from 1 November 2026

They apply to orders, fees, bids and attestations in blocks stamped from 1 November 2026, 00:00 UTC. Everything in
older blocks keeps the result every instance already recorded.

- **The fee-attestation quorum is the same everywhere.** A BTC or XMR order that the block explorers cannot settle
  counts as paid once at least two attestors vouch for it. An attestor does not count when it is the poster, or is
  linked to the poster: the same account created both (an instance's relay, which creates all its users' accounts,
  does not count as such) and their first Morphit activity was within five minutes of each other, or the two gave
  each other high-star reviews and nobody else. Each instance used to judge that link with its own flag tables, its
  own clearances and its own relay setting; now it is judged from chain data only, as of the order's newest
  attestation.
- **The attestation phase is `launch` on every instance**: an attestor qualifies by at least 100 BLURT of fees paid
  to the Morphit treasury (counted from 1 November) or by an account at least 30 days old. `MORPHIT_INDEXER_ATTESTATION_PHASE` only counts for older blocks.
  Moving to `steady` now needs a release of its own.
- **The fee tolerance is 0.1%** on every instance (`MORPHIT_INDEXER_FEE_TOLERANCE` only counts for older blocks).
- **The BLURT listing fee base** is the one pinned by the release in force at the listing's block, or 125 BLURT when
  no release pins one (`MORPHIT_INDEXER_FEE_BASE_BLURT` only counts for older blocks).
- **BTC and XMR listing fees** are judged by the amounts the release in force at the order's block pins, and such an
  order is accepted on every instance. An instance that does not check that coin (it switched it off, or no explorer
  answers) still stores the order, but keeps it pending and does not show it on its own pages; instances that do
  check it settle it. With no amount pinned, every instance refuses the order alike.
- **BTC and XMR fees always go to the Morphit treasury.** An address of your own in
  `MORPHIT_INDEXER_XMR_FEE_ADDRESS` or `MORPHIT_INDEXER_BTC_FEE_ADDRESS` never collected them while a release pinned
  the treasury (your site shows its users only the pinned address), and from 1 November it is not used at all. If
  you set one, XMR-paid and BTC-paid listings on your site work as before: your users pay the treasury and every
  instance checks it the same way. You earn the 90% share of BLURT fees.
- **A featured slot costs 50 BLURT per hour** on every instance
  (`MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR` only counts for older bids).
- **The 90% share of a BLURT fee** (listing fees, featured bids, first messages to strangers) counts when it goes to
  any operator's fees account that was registered on chain before the payment. Your own fees-account setting no
  longer counts by itself, not even on your own instance. **While your fees account is not registered, your site
  tells its users to pay the whole fee to the Morphit treasury instead**, until you run `sudo morphit-ops register`
  on your server.
- **Coins and payment methods you switched off are hidden, not refused.** Such orders are stored like on every other
  instance, and only hidden from your own pages (orderbook, live stream, feeds, the featured strip, order pages and
  lists). Before, your instance refused them, so its records differed from its peers'. Replacing an order is never
  refused for its payment methods either.

## What to do

1. **Upgrade every instance before 1 November 2026, 00:00 UTC.** On each server: `sudo morphit-ops upgrade`.
2. **Check, on each server, that its fees account is registered:**

   ```sh
   sudo morphit-ops status
   ```

   In the section **Fees account (federation)**, the line **BLURT fees go to:** says "registered on chain — accepted
   by other instances" (or "shared treasury — accepted everywhere" when you use the shared treasury). If it says
   "not registered on chain" (or, from 1 November, "the Morphit treasury, until your fees account … is registered on
   chain"), run, on that server: `sudo morphit-ops register`.

## A server with no clearnet, still on v1.21.16 or v1.21.17

**Such a server cannot upgrade itself to v1.21.18 the usual way.** Its installed upgrade reads @morphit's signed
release record over Tor, in one read of the newest 1000 entries of the account's history, and over Tor that read
never arrives. v1.21.18 fixes it (it reads small pages, or the one block its own indexer names), but the fix only
works once v1.21.18 is installed.

To get v1.21.18 onto such a server, it needs the release's offline bundle (`morphit-v1.21.18-offline.tar.gz`) and,
next to it, a detached signature of that bundle (`morphit-v1.21.18-offline.tar.gz.asc`) made with a release key the
server already trusts. Copy both onto the server, then run there
`sudo morphit-ops upgrade --from-file=<path to the bundle>`. The upgrade checks the signature before it installs
anything. The exact commands for each such server come separately.

## For people using the site

**"Load it now" shows up soon after an upgrade.** When an instance is upgraded while you have it open, the prompt at
the bottom of the page ("A Morphit update is available … Load it now") now appears without a reload, much sooner than
before. The page asks a small file, `/version.json`, which release the instance runs, and asks again regularly while
the page is on screen.

**The red "changed code" warning names one more cause.** It now reads "Otherwise this site is serving old, or changed
code — by accident, after a break-in, or on purpose."

**About this instance says where unregistered fees go.** On an instance whose fees account is not registered yet,
the note on *About this instance* now also says that from 1 November 2026, until it is registered, fees paid on that
site go to the Morphit treasury. From that day it says just that: the fees paid there go to the Morphit treasury
until the operator registers the account.

**Switched-off coins and payment methods: what *About this instance* says.** It used to say that orders from other
instances for a coin (or payment method) switched off here still show in this orderbook. They do not: such orders
are not shown here, whichever instance they were posted on; instances that offer that coin still show them. The
text now says so, in every language.

## For operators

Every item of the `sudo morphit-ops` menu was checked by hand on a real install, and what did not work, or did not
say plainly what to do, was fixed.

**www now works behind BunkerWeb.** A request for `www.<your domain>` was answered "403 Forbidden", and every upgrade
said to run `sudo morphit-ops upgrade --heals`, which never helped. The cause is in BunkerWeb itself (1.5 and 1.6, on
a single site): it only serves the names in its own site list, and it only ever puts the first name of `SERVER_NAME`
there. The upgrade now adds `www.<your domain>` to that list (after keeping a copy of BunkerWeb's database, and only
when that database is BunkerWeb's default SQLite file), checks the web server BunkerWeb really runs, and says in one
sentence what it found and did. Once www answers, the upgrade adds it to your certificate by itself. If it cannot fix
it, it names the cause and the one step to take, never the same command again.

**Upgrading is safer to interrupt and says plainly what happened.**

- Pressing Ctrl+C, or losing the SSH connection, while the new release is being put in place now puts the previous
  release back and says so (the last lines are also kept in `/var/log/morphit/upgrade-stopped-<time>.log`). Before,
  it could leave `/opt/morphit` empty.
- Run without `sudo`, it stops at once, changes nothing and says "Run it with sudo: sudo morphit-ops upgrade".
- When the release server cannot be reached, it says what was tried, "Nothing was changed; this server still runs
  vX", and what to do next. A failed upgrade ends with "Not upgraded — this server is back on vX".
- An MCP server you turned off stays off.
- Each problem is shown once and counted once; routine checks that found nothing to change are folded into one line.
  Release notes are shown as plain text.
- `--yes` skips the question. `MORPHIT_AUTO_UPGRADE=1` still does the same, but `sudo` normally drops your shell's
  variables, so a value set in your shell usually does not reach the upgrade: use `--yes`.
- The frontend's nginx.conf is kept as a dated copy before it is replaced.
- **Exit codes, for scripts:** a stop by Ctrl+C ends with 130, a closed SSH session with 129, a `kill` with 143
  (also once the new release is already running). On a server that is already up to date, `upgrade` exits 0, even
  when a repair warned. `upgrade --heals` exits 1 when a repair warned, else 0. `--json` (like `--check-only`) only
  reports: it never runs the repairs, and it prints its JSON.

**Snapshots say how old they are.** A new node that fast-syncs starts from the newest snapshot anchored on the chain,
and anchoring is a step on your laptop. Fast-sync now shows the snapshot's block, its age and the version that made
it before it asks anything. On the server that publishes snapshots, the upgrade and the weekly mirror job say how old
the anchored snapshot is and, once it is more than two days old, give the exact commands to run on your laptop, with
your server's name filled in, and the two-step copy for a server that refuses root logins (`PermitRootLogin no`). The weekly mirror timer could go weeks without running; it is now a calendar timer that
also catches up a run missed while the server was off. A restored snapshot's spot-check now also compares each
sampled account's creator and creation time with the chain.

**A server with no clearnet reads @morphit's records again.** Its upgrade, its fast-sync and its indexer's
`/v1/release` read @morphit's history over Tor in small pages (or straight from the one block its own indexer names),
instead of one read that never arrived. Before, every upgrade of such a server stopped with "@morphit's signed record
could not be read".

**Laptop scripts use the best node, hidden ones too.** The release, RPC-directory and snapshot broadcast scripts used
only clearnet Blurt nodes. When Tor or I2P runs on your laptop, they now also try the .onion and .b32.i2p nodes and
use the best of all of them (`--no-hidden` to skip them).

**The relay will not sign with a key that is not on the account.** If the relay's key file is neither the account's
active key nor its owner key on the chain, the relay keeps running but pauses signups and payouts — nothing queued is
lost. It decides that the key is wrong only when two Blurt RPC operators agree; with only one RPC operator configured
it can say the key is right, never that it is wrong. Once the chain has said the key is wrong, a later check that
gets no answer does not let it start signing again. Its log line `active_key_not_on_chain` says what is wrong and the
exact commands that fix it; `/v1/health` (asked from the server itself) shows the state in its `active_key` block, and
`sudo morphit-ops health` and `sudo morphit-ops status` show it with the fix. `sudo morphit-ops edit-active-key` checks
a new key against the chain before saving it, and `show-key` says whether the saved key matches.

**A command that needs root says so first.** Typed without `sudo`, a command that needs it (`doctor`, `status`,
`edit-active-key`, `register`, …) stops at once and prints the same command with `sudo` in front, instead of failing
half-way with "EACCES" or advice that was not true.

**Answers can be piped in.** Every question reads the next line of the input when it is not a terminal, one line
per question, secrets included. When the answers run out (or none comes within 20 seconds), a question with a
default takes it; a question asked again without an answer stops the run with "Stopped — the input ended …" instead
of asking for ever.

**The menu, item by item.**

- **Install** stops on a server that already runs Morphit (Edit / Install again / Cancel), and says what really
  happened when stopped.
- **Upgrade**: see above.
- **Fast-sync** asks everything before it stops anything, says what would be lost, stops and restarts the relay
  too, and starts both again if you press Ctrl+C. On a server without Morphit it says to install first.
- **Edit settings**: pressing Enter keeps the current value (it used to wipe the origin, and could change the
  permanent operator tag). Each value is read from the file the service really uses, and the review names that file
  ("(from /etc/morphit/indexer.env)"). Values the indexer would refuse are refused at the question; "Nothing changed"
  when nothing did; restarts are confirmed before "the change is live". A new list of Blurt nodes goes to the relay
  too; when the list is kept but the relay already uses a different one, it asks whether to give the relay the same
  list (default No). The listing-fee amounts start from "Keep your current amounts" (the default), and new ones are
  worked out from live prices only when you choose that. In the setup wizard, the fallback BLURT price is offered as
  "Suggested $0.002".
- **Tor / I2P address**: the steps to install a key you made on your laptop are now exact and correct (Tor refused
  the old ones), and the command checks that Tor or I2P really serve the address.
- **Offline notifications**: a Matrix account saved without a test note is still checked with its homeserver; only a
  Session account saved that way is marked "not tested". A new XMPP account whose password the wizard made is saved
  without a test note by default (that password is kept nowhere else).
- **Payment methods**: adding and removing works on a standard install (it signs with the relay account's key, as
  registration does).
- **Branding**: the progress indicator keeps turning while icons are made.
- **Show / rotate the key, register**: no passphrase prompt when the sealed copy works; wrong-key and missing-setting
  advice names the exact command.
- **Harden, SSL, web firewall**: each option checks what is already set up first; certificate advice fits a server
  where BunkerWeb holds the web ports; nothing overwrites an existing BunkerWeb setup.
- **Doctor** works on installed servers, reads the same settings files the services start with, and checks that each
  service's own user (not root) can read them, with the exact `sudo chown` / `sudo chmod` line when it cannot.
- **Health and status** show the relay's balance and state with exact commands; status counts only broadcasts that
  are really stuck, and reads the relay's daily signup limit from the relay's own settings.
- **MCP and Matrix alerts** check that the service really runs after a change; Matrix alerts can be changed, tested
  or turned off.
- **Moderation** shows all four kinds of flag, all time by default, the same count as the menu, and offers Block /
  Unblock / Clear / Undo even when there is nothing to review. A cleared pile-on stays cleared. `flags` and `abuse`
  list all four kinds too (`--since=all` for every flag).
- Ctrl+C or Ctrl+D anywhere says "Stopped" instead of "fatal"; "(needs sudo)" is shown only when you did not use
  sudo.

**A tor-only server's Matrix alerts through Tor count as hidden.** An alert bot that reaches a .onion homeserver
through Tor on the same server was counted as a clearnet contact, so the instance could not say it had no clearnet
connections. It now counts as hidden; a .onion reached any other way, or an .i2p homeserver, still does not.

## For monitoring scripts: changed JSON

- **`sudo morphit-ops health --json`, `relay`:** `outcome` is now `up`, `degraded`, `unreachable`, `http-error` or
  `not-relay` (it used to take the indexer's values: `synced`, `behind`, `unknown`, …). `up` stays `true` for a relay
  that answers but is `degraded` (balance not current or low, key mismatch); it is `false` when the relay does not
  answer, answers with an HTTP error, is not the relay, or reaches no Blurt RPC node. New keys: `verdict` (the one-line
  verdict), `hints` (what to do), `balance_status` (`ok`, `warn`, `error` or `null`) and `active_key` (the relay's
  key check: `ok`, `mismatch`, `unknown`, `unchecked` or `null`). The exit code is unchanged.
- **`signups`, `drain-queue` and `failed-broadcasts --json`:** new `offset` (from `--offset=N`), `total` and
  `truncated`. `failed-broadcasts` also has `sent`, `waiting_for_confirmation`, `may_have_been_sent` and `not_sent`,
  and each entry has `amount_bp`, `state` (`sent`, `waiting`, `maybe-sent` or `stuck`) and `trx_id`.
- **`status --json`:** `failed_broadcasts_24h` now has `may_have_been_sent` and `not_sent` besides `count`, and
  `count` leaves out payments the relay is still sending or settling. New: `relay_balance`, `relay_key`,
  `signups_today.ceiling_source` and `drain_queue.delegation_pending`.
- **`flags --json`:** the `evidence` field is gone; `pile_on` and `concentration` lists are added; `since_sec` is
  `null` for `--since=all`.
- **`moderation --json`:** all time by default (`since_sec: null`); its `counts` are the full counts, not the length
  of the listed rows, and add `unresolved`.
