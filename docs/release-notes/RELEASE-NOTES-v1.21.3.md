# Morphit v1.21.3

Every server now tells its operator when a newer release is out. The relay no longer restarts itself
over an abandoned node request. Blurt Power rewards that a node refuses now stop and say why. The site
now says plainly what operators earn and pay and what users get, and the first-trade bonus is no longer
lost to a reply.

**Upgrading:** `sudo morphit-ops upgrade` on every server, Tor/I2P-only ones included. No database change.
This upgrade is run by v1.21.2's upgrade program; the release check, the backup question's removal and
the after-restart wait below run from this release during the upgrade. **Every instance must run
v1.21.1 or later before 2026-11-01 00:00 UTC**, when the stricter consensus rules start. This release
adds one rule from that same time, about what uses up a user's first-trade bonus (below); instances that
have not upgraded by then still pay the bonus, by the old rule.

## Knowing a release is out

- **The main menu reads @morphit's on-chain release record.** Before, it asked only git.agorise.net and
  gave it 2.5 seconds. When that host was slow, the menu showed "(couldn't check for updates — network)"
  even though the record of the new release was already on chain, and an operator who opens the menu
  now and then would read that as "nothing to do".
  - The menu now reads the record from this server's own indexer, on the server with no network. It
    uses the answer only after checking that the process listening on that address is the indexer
    service.
  - The record names exactly what an upgrade installs, so it decides.
  - The code host is asked only when the record does not answer, never on a Tor/I2P-only server, and
    once instead of twice. "Tor/I2P-only" is now decided the way the upgrade decides it; when that
    cannot be told, the node is treated as Tor/I2P-only.
  - "Update available" appears only for a release newer than the installed one.
  - It says "couldn't check" only when nothing answered.
- **The release check runs on every server, twice a day.** `morphit-release-monitor` shipped from v1.9
  but nothing installed it. It sends an alert through the Matrix bot when Matrix alerts are set up.
  - Every install and every upgrade now puts it in place and turns its timer on.
  - The upgrade also runs it once, reads what it logged, and says so if that run did not succeed,
    with the command to look at it.
  - It runs every 12 hours (it was written for 6), as a throwaway user systemd makes for each run.
  - It reads the record from this server's indexer. It asks the code host only when the indexer
    answers but holds no record.
  - When it cannot check, its alert now gives the reason.
- **`morphit-ops upgrade --check-only` reads the on-chain record first** on every server, and stops at
  the first release source that answers.
- **A real upgrade says when the record names a newer release than the code host offers**, for example
  when git.agorise.net is blocked or has not published it yet, so the operator knows to run it again
  later.
- **Requests to the code host get the time they are given.** Node's own limit ended every connection
  attempt after 10 seconds, whatever wait was set, so a slow code host failed a 30-second check after
  20 seconds. The upgrade's release lookup and its download now use the wait they were given.

## The relay and the indexer

- **The relay no longer restarts itself over a node request nobody waits for.** On 2026-10-08 it
  restarted twelve times with "unhandled_rejection", logged as "AbortError" or "TypeError: fetch failed".
  The cause was a request to a second node that ended after the relay had already moved on, with nothing
  catching its failure. Two things did that:
  - the node pool could still send its backup request after the first node had answered;
  - a request cancelled before it started was left unwatched.

  Both are fixed, in the indexer as well. Should such a request ever end unwatched again, the relay
  logs it as a warning with its stack and keeps running. Any other unexpected error still stops it.
- **A node answer the indexer cannot read no longer stalls its block reading.** Before, it was left
  unhandled, and the request waiting on it never finished.
- **A database error while the relay settled a payment no longer gets it sent twice.** It erased the
  record of the signed transaction, so the next cycle signed and sent a new one. The record is now kept
  and the payment is settled from the chain history; the failure is still counted, so a row that keeps
  failing stops and reaches the operator.
- **Blurt Power rewards (delegations) below the chain's minimum are held, not re-sent.** Blurt accepts a
  new delegation only of at least a third of its account fee (about 33.4 BP at today's 100 BLURT fee),
  and a change to one only of at least a thirtieth (about 3.4 BP). The 1 BP welcome stake and the 10 BP
  first loyalty reward are below that, so the chain refused them every time: on morphit.io two rewards
  to one account were signed again about once a minute for five days, without the relay looking at the
  chain, and the retry count never rose, so they never stopped or reached the operator.
  - The relay now reads the chain's limits and the current delegation before sending. A reward below
    the minimum is held ("held: … below the chain's minimum delegation …" in `drain-queue`), checked
    again every 6 hours, and lent once the account's rewards add up to it, usually at the 500 BLURT
    milestone (61 BP). A target the chain already holds is marked done without a transaction.
  - A delegation is now looked up in the relay's account history, like a transfer.
  - Only the newest reward for an account is sent. Each one carries the account's whole amount, so
    an older one is retired as replaced.
  - A reward is never sent while an older one for that account may still land.
  - Rewards waiting on each other no longer hold up the rest of the payout queue.
  - What the nodes answered is kept, in the queue and in the log, so a refusal the chain repeats ends
    the retries and shows its reason.
  - An older reward that has reached the retry limit no longer blocks newer ones for that account, and
    an older one is retired only for a newer one that can still be sent.
- **`morphit-ops drain-queue` shows a delegation's amount in BP** (it showed "0.00 BLURT"). It marks a
  row that is waiting on the chain as waiting, and shows what the nodes answered in full.

## Upgrades and the command line

- **The upgrade no longer asks about encrypting database backups.**
- **The checks after the restart wait for the services to answer.** systemd reports a service as
  started before it listens, so the relay check could run against a relay that was not yet answering,
  and warn.
  - The checks now wait up to 5 minutes in all for the services to answer on their health addresses,
    and say which one did not.
  - The indexer is asked where its unit says it listens.
  - The relay check's own wait is 30 seconds of time, not a count of tries.
- **The braille spinner shows during the waits at the terminal**, for example:
  - the database commands (`status`, `signups`, `drain-queue`, moderation and the like);
  - `doctor`'s configuration checks;
  - `fast-sync`'s stop and start;
  - the guided install's pre-flight and the silent stretches of the playbook;
  - the unpack and each restart of an upgrade;
  - the release check's run and retry;
  - the service restarts that `edit`, `alt-address` and `mcp` offer.

  Its label is cut to fit the terminal; a longer one used to fill the screen with copies. Ctrl-C while
  it turns gives the cursor back. The database commands no longer print the label into piped or
  logged output, and under `--json` the output is still only JSON.
- **`fast-sync` reads the indexer's state from systemctl's answer alone.** A warning on its error output
  made the state unreadable, which fast-sync took as "stopped".

## Rewards

- **A reply to someone else's listing no longer uses up a user's first-trade bonus** (10 BLURT + 10
  BLURT Power), from blocks dated 2026-11-01 00:00 UTC. The bonus is paid for the first completed trade
  on a listing the user paid for. Before, the user's first reviewed trade of any kind used up the
  one-time flag, so a new user whose first trade answered someone else's listing was never paid. Older
  blocks keep the old rule, so a resync pays exactly what was paid before, and an account whose flag
  was already used up that way stays as it is.
- **What the site says about rewards now matches what is paid.** These statements were false and are
  corrected in all ten languages:
  - "Leave feedback after your free first buy to unlock the 10 + 10 bonus": the free buy has no listing
    fee, so it cannot unlock it.
  - "Save the free buy for later, it never expires": it is offered for the first order only.
  - "500 signups a week need about $1 of Blurt": about 51,000 BLURT.
  - "Morphit" delegates and can withdraw rewards "for abuse": the relay of the site lends them.
  - The 1 BP welcome stake "arrives instantly": it is set aside and lent once the rewards reach the
    chain's minimum delegation.
  - The four FAQ answers on the free first buy, the welcome rewards, loyalty rewards and operator
    earnings are retranslated in full from the English, since some translations had drifted.

## The website

- **The run-a-node page is rewritten.** It is shorter and plainer. The download button names the
  current version, and the install step shows the one command to run. The operator-tag form is gone:
  the guided install offers to register the tag.
- **The run-a-node page shows what an operator earns and pays.** It lists the income (90% of BLURT
  listing fees, featured-slot bids and first-message fees on the site) and what the relay pays (about
  102 BLURT per new account, the first-trade bonus, Blurt Power lent as rewards, top-ups), with a rule
  of thumb for how many paid listings cover one new account.
- **The home page invites visitors to run a site**, with a link to the run-a-node page and to the
  running sites.
- **Visitors see what an account gets.** A "What you get" panel on the orderbook lists every reward,
  when it arrives and how, with the signup button. After signing up, the success screen shows the same
  list and stays up for 20 seconds, with a button to go on at once. A site without an operator tag pays
  no rewards, so it does not show the panel.
- **"Run a node!" is in the footer's Federation menu**, between Instances and Compare.

## The repository

- **A tidier top level.**
  - `SECURITY.md` and `THIRD-PARTY-LICENSES.md` are now in `docs/`.
  - The configuration example is `ops/env/morphit.config.env.example`.
  - The audit allowlist and the smoke typecheck configuration are in `scripts/`.
  - The Prettier settings are the `"prettier"` key of `package.json`.
- **`scripts/run-smokes-chunk.sh` now fails when a smoke fails.** It printed "N runners failed" and
  still exited 0, so a battery run in chunks read every failing chunk as passed. It now exits non-zero,
  as `scripts/run-smokes.sh` does.

## Releases (maintainer)

- **Block 3 is one code block.** If the dry-run printed the payload, Block 3 is done. Only a release
  without an IPFS CID needs more, and the payload builder then prints the command for morphit.io and
  how to retry.
- **The ceremony writes its files to `/tmp`** (`/tmp/morphit-build-manifest.json`,
  `/tmp/morphit-release.json`), not into the repository, and Block 3 clears them first.
- **Block 4 confirms the broadcast by reading the new blocks.** A node that accepts the transaction
  without its block number no longer leaves it "NOT confirmed". The other nodes are asked for the blocks
  produced since the broadcast, and the transaction is confirmed when one of them holds exactly this id.
