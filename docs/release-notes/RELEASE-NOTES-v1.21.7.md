# Morphit v1.21.7

A fresh server goes from the guided install to a live, listed node without hand work: it fast-syncs,
sets up its warrant canary where you choose, lists itself when you say yes, and offers branding — and Ctrl+C at any point
says what stopped and what is left. The SSH safety net after an install no longer empties the firewall,
the hardening step no longer opens SSH wider than you had it, fast-sync checks every snapshot before
unpacking it and never serves a database that did not pass its checks, and the stats page's RPC card
measures the Blurt nodes only while someone is reading it.

**Upgrading:** `sudo morphit-ops upgrade` on every server. No database change. Like every change to the
upgrade, the new behaviour starts with the upgrade AFTER the one that installs it. **Every instance must
run v1.21.1 or later before 2026-11-01 00:00 UTC.** On a server installed with v1.21.6 or earlier whose
SSH question went unanswered, run `sudo morphit-ops health` after upgrading: it says whether the
firewall still lets SSH in (docs/UPGRADING.md, Troubleshooting).

## Installing a node

- **Run a node, step 6, now has the exact commands**: connect over SSH, update and restart the machine
  (with a three-minute wait and the reconnect), start `tmux`, download the offline release into
  `~/morphit` (or the normal one on an ARM machine), check it, unpack it, and run the installer. The old
  text pointed at a download-page anchor that did not exist. The README's install step links the same
  commands.
- **Ctrl+C during the guided install** now says that you stopped it, and the exact command to start
  again (`cd <your folder> && sudo bash morphit-setup.sh`), instead of "The install hit an unexpected
  problem" and a support address — also at a check under the spinner while the questions are asked (it
  used to end without a word there), and while Ansible is being installed; the file holding the database
  password is always removed. Every other install failure names that command too. Once the
  install itself has finished, Ctrl+C in one of the steps after it (fast-sync, the canary, the listing,
  branding) stops only that step; Ctrl+C at a question or a wait ends the wizard with a list of what was
  left and how to do each part later — the installed node is not called a failed install.
- **The "save your database password" screen** says how to copy without stopping the installer
  (Ctrl+Shift+C; Cmd+C on a Mac).
- **The guided install remembers your answers.** Stopped part-way (Ctrl+C, a dropped connection, a failed
  install), the next run shows what you entered and offers to reuse it, so you don't answer everything
  again. Asked again every time, because they are never written to disk: your relay account's active key,
  the alerts step (it holds a bot token) and, at home, the dynamic-DNS update URL. The database password is
  new on every run, and after any earlier run or install on the box the save screen says so. The saved answers are deleted once the install succeeds, or
  when you choose to start fresh. ("Configure only" already did this; the guide said the guided install did
  too, and it did not.)
- `docs/VERIFY-YOUR-DOWNLOAD.md` names the offline bundle by its real file name,
  `morphit-vX.Y.Z-offline.tar.gz`.
- **Inside tmux**, the guided install ends by saying so and how to leave: type `exit`, or Ctrl+B then D to
  keep it running (`tmux attach` to come back). It doesn't close tmux itself: that would wipe the summary
  you still need to read.
- **Encrypted backups: the key file's place is spelled out.** The wizard used to say
  `age-keygen -o morphit-backup-key.txt`, which saves the key in whatever folder the terminal is in, and
  never said where. It now gives a fixed path in the home folder, named for the instance
  (`age-keygen -o ~/morphit-backup-key-<your domain>.txt`), says where that is (`/home/<you>/…`,
  `/Users/<you>/…` on a Mac), and to keep it in your password manager. Keys for several nodes no longer
  overwrite each other.

## The SSH safety net after the install

- **An unanswered "a NEW SSH login still works?" no longer empties the firewall.** When that question went
  unanswered (at the end of a long install, nobody is watching), the safety revert put back the firewall
  rules from *before* the install. On a fresh VPS that is no rules at all with the firewall still on: SSH
  itself was no longer allowed (only the open session survived), and the rules the install added for the
  web containers were gone, so every `/v1` call from the site hung and other instances listed the node as
  "Clearnet blocked". The revert now only puts SSH's own settings back, and keeps the SSH port open to
  everyone only when it was open to everyone before; a port that only some addresses or a VPN
  could reach keeps those rules and is not widened, and one that was closed (SSH over Tor only, say) stays
  closed. It re-asserts Docker and never touches the firewall's other rules. The install's hardened SSH
  settings are kept, and `morphit-ops health` gives the one command that puts them back once you have
  checked your key login (`sudo bash /var/lib/morphit-root/reharden-ssh.sh`: it puts them back only if
  `sshd` accepts them, and otherwise leaves SSH exactly as it is; if SSH then fails to start with them,
  it puts the old ones back, starts SSH again and says which settings it runs now).
- **The hardening step no longer opens SSH to the whole internet on a box with its own firewall.** It
  always ran `ufw allow 22` and `ufw limit 22`: on a server whose firewall was already on with your own SSH
  rules (an office address, a VPN, SSH over Tor only) that opened SSH to everyone, and on a server whose SSH
  listens on another port (2222) the firewall it switched on locked you out. It now sets SSH rules only when
  the firewall was off (or let everything in) before it, on the port(s) SSH really listens on — read from
  where it listens (`ListenAddress 0.0.0.0:2222` is port 2222, though `sshd -T` still says "port 22"), and
  none at all when SSH listens on this box only (SSH over Tor).
- **`morphit-ops health` warns when the firewall lets no one in on SSH**, with the command that does
  (`sudo ufw limit 22/tcp`). On a fresh VPS installed with v1.21.6 or earlier, an unanswered SSH question
  left exactly that: the next login failed. `docs/UPGRADING.md` explains it.
- The question now waits 10 minutes (was 2), rings the terminal bell, and asks again on a bare Enter
  (Enter alone is not "no"). Answering "no" puts the SSH settings back at once. Ctrl+C at the question
  leaves the safety net armed and shows the command that cancels it. After "no" it waits (spinner) for the
  revert to finish before saying it did — it used to say "did not report back" while it was still
  running. A box with no SSH server gets no safety net (nothing to put back). If the revert does run,
  `morphit-ops health` says so ("SSH safety revert ran …") with how to check and re-apply the SSH
  hardening; the notice goes once the hardened settings are back, or after a later confirmed install.
- **The upgrade restores the web containers' firewall rules** (relay 8080, indexer 8081, IPFS gateway
  8082, MCP 8124 from the `bunkerweb_net` subnet) where they are missing, on the install's own layout only,
  and checks they took. It reads the subnet's IPv4 range even on a dual-stack network, and only ever a
  private range.

## Listing your instance

- **"List this instance?" → yes now lists it.** Two faults together kept a fresh VPS off `/instances`:
  - The wizard registered on the spot only if *every* row of the review was ✓. On a fresh VPS some rows
    never are at that point (the PGP contact key and the canary are signed later on your own computer;
    i2pd takes minutes), so it always deferred. It now registers right away when the node is ready to be
    listed: the chain is reachable and the database, relay, indexer and website are up, with the relay
    funded.
  - Deferring flipped a switch for the background finisher (morphit-first-online), which had already done
    its other jobs during the install and switched its own timer off, so nothing ever read the switch.
    Deferring now also starts the finisher again; it retries every 5 minutes. A registration that goes
    through on the spot no longer leaves a second one queued.
- **Declining at `register`'s own "Publish this registration?" question is no longer reported as listed.**
  `register` exits with its own code (5) then, so the wizard says "Not listed" and `edit` says "Not
  published", where both used to report success. Ctrl+C at that question counts as declining too, and is
  not queued for the background finisher. Having just said yes to "List this instance?", the wizard's own
  `register` question defaults to yes.
- **A Tor-only node whose `.onion` is not in its settings yet is never registered as a bare `https://`**;
  it is queued, and listed once the settings carry the onion. `register` (by hand or queued) now uses
  `http://<onion>` when the origin setting is empty and the onion is set, so the menu's "Set up a Tor /
  Lokinet / I2P address" is enough to list such a node.
- **The canary setup is never told the instance URL is a bare `https://`** (a Tor-only node before its
  onion is saved); it then finds the URL itself, onion included.
- **Why a peer probe failed is now in the indexer's log** (`peer_probe_failed`, with the peer and the
  reason), once per change. It was only in the database, so a new instance shown as "Clearnet blocked"
  had nothing to read. Text a peer chose (its error, its relay account, its treasury address) is cut short
  in the log, so a hostile peer cannot write huge log lines, and control characters are removed (a NUL in
  a peer's answer made the reason unstorable, so it was logged again on every probe).
- **A registration marker from an earlier install on the same box** no longer makes the queued listing
  think it is already done.
- **When the finisher cannot list the node, its log says why**: what `register` said (its ✗ lines and its
  last lines) is in `journalctl -t morphit-first-online`, instead of a generic list of possible causes,
  with terminal control characters and bytes that are not text removed, each line cut to 300 bytes. A
  ✗ line is kept even when the output holds such bytes.

## Fast-sync

- **The guided install offers fast-sync** (default yes), right after installing: the newest signed
  federation snapshot instead of a full replay from genesis. Only "Configure only" offered it, so a fresh
  VPS started millions of blocks behind. The indexer is started again (unless the restore left the
  database unusable, see below), and the step waits until it is connected before the review.
- **Fast-sync fetches the snapshot through the node's own IPFS** (on a node in the public IPFS network —
  never a Tor/I2P-only one), before the public gateways, which rate-limit (`429`). The node's own gateway
  serves only what it already holds.
- **The "127.0.0.1" source was the relay.** The default source list included `http://127.0.0.1:8080` —
  kubo's stock gateway port, which on a Morphit node is the relay — so it always answered 404. The node's
  own IPFS gateway is now read from its IPFS configuration (it is on 8082).
- **The hidden Blurt RPC nodes are asked for the snapshot too**, at `/ipfs/<cid>` on their own
  `.onion`/`.b32.i2p` and port: they are the one set of hidden addresses a brand-new Tor/I2P-only node always
  knows. One that does not mirror answers 404. What they serve, and a ready script for their operators:
  `docs/HIDDEN-RPC-SNAPSHOT-MIRROR.md`. The snapshot mirror on every Morphit node asks them too.
- **Re-installing over a box that already ran a node**, the wizard's fast-sync defaults to no and says
  that a restore replaces that node's own data (pending payouts, push subscriptions, moderation). Offline,
  it is not offered (it could only fail).
- **The chain check after a restore shows a turning spinner** with the time taken and how far it is
  ("block 12 of 41"), and the RPC library's "Didn't failover…" notes are gone from fast-sync's output.
  It used to sit for minutes with nothing moving.
- **No more double "Start the indexer"** after fast-sync when fast-sync (or the wizard) starts it itself.
- **The first-online job never starts a stopped indexer or relay** (`try-restart`): one may be stopped for
  a restore.
- **A failed fast-sync starts the indexer again.** It stopped the indexer, and only a success started it
  again, so a failed download left the node's indexer stopped. **Ctrl+C during the restore** now stops only
  the restore: `morphit-ops` (and its launcher) stay up long enough to start the indexer again. Before, on
  an installed node the whole command died on Ctrl+C and left the indexer stopped. A closed terminal
  (a dropped SSH session) no longer ends it before it has started the indexer again either. Ctrl+C, a
  closed terminal or a stop before the restore begins stops at once and leaves nothing in `/tmp`.
- **A hidden snapshot source can no longer redirect the download** (it could have pointed a Tor/I2P-only
  node at a clearnet address through its proxy). A source that stalls is dropped: after two minutes for
  a clearnet source or a hidden RPC node, ten for a hidden snapshot mirror (an I2P tunnel can take minutes
  before the first byte), five for the node's own IPFS (with a turning spinner while it waits).
- **A snapshot is checked before it is unpacked.** A download larger than the signed record says is cut
  off at that size, one of the wrong size or hash is refused and the next source is tried, and the archive
  is read by fast-sync itself: only the two files a snapshot holds, never a link or a path outside its
  folder, and never much more than the signed size (a full disk is a refused source like any other).
- **A restore that replaced the database but could not finish is reported as such** (exit code 4: the
  check after the restore failed, the tidy-up failed, or Ctrl+C after the database was replaced). The
  indexer is left stopped, with what to do: run fast-sync again, or wait for the next snapshot (published
  daily). The guided install does not then list the node, and does not call it "running". A Ctrl+C during
  the check on a busy server used to end the restore so abruptly that fast-sync read it as "nothing
  changed" and started the indexer on the unchecked database; fast-sync now knows the restore had begun
  even when it is killed outright.
- **While the wizard restores the snapshot, the first-online job is paused**, so it cannot restart Tor or
  i2pd under a download going over them.
- **The wizard waits up to a minute for the chain connection** before deciding whether to offer fast-sync,
  instead of one early look.

## Backups and health

- **Encrypted backups count as backups.** With an age key, dumps are `….sql.gz.age`; `morphit-ops health`
  looked only for `….sql.gz` and showed "Backups ✗ missing — no dump has ever been written" on every node
  with encrypted backups. The install's own wait for the first backup had the same fault, so it retried
  for five minutes on every encrypted install. Half-written dumps (`.partial`) still never count.
- **`printf: I/O error` is gone from every backup's log.** The "is the schema migrated yet?" check stopped
  reading early, and under systemd that made `printf` fail on the rest of a large schema. Harmless, but it
  read like a failure.
- **`morphit-ops health` has an Addresses section** (a Tor-only node's onion origin is not shown as
  "Clearnet"; a daemon still starting shows `?`, not ✗; run without sudo, it says the settings need root
  instead of calling every address "none yet"): your clearnet origin as set, and your `.onion` and
  `.b32.i2p`, each with ✓ when the service behind it runs (✗ when it does not, ○ never created). The Tor
  check follows the Tor service that really runs (`tor@default` on Debian and Ubuntu), in health and in
  the install review. The release-sharing line is
  in plain words ("This node keeps a copy of the Morphit release for other nodes to download…"), and the
  canary line says how to set one up, here or on your own computer.
- **The install review shows the `.b32.i2p` too**, and marks the `.onion` / `.b32.i2p` ✓ only when they are
  also in your settings (what the node advertises), not just created.
- **`morphit-ops health` shows your addresses.** It never loaded the instance's settings, so it
  printed no "Reachable at" rows and "No hidden address yet" on nodes whose `.onion` and `.b32.i2p` were
  configured and serving.

## Warrant canary

- **The guided install asks where a VPS's warrant canary is signed**: here on the server, automatically
  every week (the same turnkey setup `upgrade` offers), on your own computer (the key never sits on the
  server), or later. It used to be offered on home installs only, so a VPS ended with no canary and no
  `/pgp_keys.asc`. Its first publish waits for the weekly timer only when the chain cannot be reached at
  install time (it used to wait whenever the offline bundle was used, which the guide now uses on every
  x86 VPS).
- **`morphit-ops health`'s canary hint gives the right command** for where the canary is signed: the
  server's own refresh script when it is signed here.

## Branding

- **The setup wizard offers branding** (optional) just before its final review: the same guided setup as
  `sudo morphit-ops branding setup`.
- **Branding setup first says exactly what it needs**: three SVG files — `logo.svg` (header, 32 px tall;
  homepage, 44–96 px tall; any width), `logo-footer.svg` (footer, 40 px tall; optional) and `icon.svg`
  (a square symbol that reads at 16 × 16 px) — each at most 2 MB with a `viewBox`, nothing loaded from
  elsewhere, how to copy them to the server, and that they are saved under those names.
- **Colours from one colour, or from your logo.** Answer the colour question with just your main colour
  (`#d4a017`) or `logo`, and the rest is worked out: a gradient from a lighter tint to a deeper shade (or
  the logo's two main colours), a near-black page background with a trace of that colour, bright or deep
  buttons to suit, everything checked for readability. Setup shows the result and asks before using it.
  Two or three colours and the presets work as before, except that two or three colours now replace the
  whole theme (an earlier preset's middle stop or button style is no longer left over).
- **Colours are read from any logo, quickly.** A large logo kept the colour suggestion busy for minutes
  (9 for a 2 MB file); it now takes a moment whatever the size. Colours written as names (`navy`), `hsl()`
  or 4/8-digit hex are now read too, where such a logo was called "no colour".
- **`edit`'s "publish the change?"** hints say `sudo`, Ctrl+C there is reported as not published, and
  having said yes, `register`'s own question defaults to yes (Enter, Enter used to mean "not published").

## The stats page's RPC card

- **The card stops when nobody is there.** It re-read the figures every 10 s for as long as the tab was
  visible, even a tab left open on a second screen for days. It now pauses after 3 minutes without mouse,
  touch, keyboard or scroll input (and while the tab is hidden, as before), says "Paused while you're
  away", and reads again the moment there is input.
- **The indexer measures the nodes only while someone reads the card.** It measured every published Blurt
  node every 20 s from boot, forever, page open or not: about one request a second from every instance,
  Tor and I2P circuits included. It now measures nothing until the card is read and stops a minute after
  the last read; the first read after a quiet spell measures at once, and when the figures it gets are
  more than a minute old (first load, back from a pause, back to the tab) the card reads again 3 s later
  so old figures don't stay on screen.
- **No number of open pages, clicks or scripted requests makes an instance contact a node more often.**
  The refresh (`?probe=1`, open to anyone) re-measured every node every 5 s for as long as someone kept
  asking — a single script could make an instance contact all ~20 nodes four times as often as the
  schedule. A refresh now re-measures only nodes not measured in the last 10 s, and waits for a
  measurement already running instead of starting another: each node is measured at most once per 10 s
  (a measurement that misses retries once), whatever the load. A refresh answers within 8 s even when a
  hidden node never does: that node keeps its previous figure, with how long ago it was measured (or shows
  as not measured yet).
- **The card has its own request limit**, so a flood of it can no longer use up an address's limit for
  the other public reads (sending a transaction, say). The directory reads behind it are shared between
  requests arriving together.
- **`morphit-ops health` measures fresh** (it asks for a refresh), and a node whose figure is over two
  minutes old shows as "being measured" with no latency, instead of an old number.
