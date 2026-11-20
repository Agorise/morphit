# Morphit v1.24.8

**Node.js and Tor now keep themselves patched too.** v1.24.7 set the servers up to install
Ubuntu's and Docker's security fixes by themselves. The servers' own answers (a read-only check run
on all four on 2026-11-20) showed two parts it did not reach:

- **Node.js**, which runs every Morphit service. Three of the four servers ran a Node from
  `/usr/local` that came with the offline bundle and that no upgrade ever replaced: 22.14.0 on one,
  22.22.2 on two, behind every Node security release since (the latest, 22.23.4 and 22.23.5, fix
  several high-severity bugs in HTTPS, HTTP/2 and DNS handling). The fourth took Node from
  NodeSource's repository, which Ubuntu's updates never touch, and was two security releases
  behind.
- **Tor.** Every server ran Ubuntu's Tor 0.4.9.11 from June 2026. The Tor Project has published six
  security releases since (0.4.9.12–0.4.9.17), and its own instructions say not to use Ubuntu's copy.

Both now update themselves. Also, a security fix for a package whose settings file the server
changed no longer gets skipped by the automatic updates.

This is a security release: servers on v1.24.7 install it by themselves early in the morning.

## For operators

### Node.js (OPERATIONS.md §37.2)

**Nothing to do.**

- A server whose Node comes from `/usr/local` (installed from the offline bundle) gets the Node this
  release names, **22.23.5**, during the upgrade: from the bundle when it carries it, otherwise
  downloaded from nodejs.org (directly, else through this server's Tor; through Tor only on a
  zero-clearnet server). The download is kept only when its SHA-256 is the one this release names,
  and the Node inside must report 22.23.5 before it replaces the old one. Each later release names
  its Node the same way, and security releases install themselves.
- A server whose Node comes from NodeSource now takes NodeSource's updates by itself, within the
  installed major version (Node 22.x; Node 24 waits for a Morphit release tested with it).
- A running program keeps the file it started from. After apt replaces Node, the Morphit services
  still running the old one are restarted onto the new one (`journalctl -t morphit-node-restart`
  shows each restart).
- Turn the NodeSource updates off with `MORPHIT_NODE_UPDATES=off` in `/etc/morphit/updates.env`.

### Tor from the Tor Project (OPERATIONS.md §37.2)

**Nothing to do.** The upgrade moves Tor to the Tor Project's own repository, keeping your
`/etc/tor/torrc`:

- It reaches the repository at its site, or, where that is blocked (one server cannot reach
  torproject.org at all), at the Tor Project's onion through this server's Tor. A zero-clearnet
  server uses only the onion.
- Nothing is written until the Tor Project's key has its published fingerprint
  (`A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89`) and its release file for this Ubuntu release is
  signed by it.
- A copy of the installed Tor is downloaded first. Tor is then installed from the Tor Project and
  must connect again within a few minutes. If it does not, the copy is reinstalled and the
  repository removed: Tor is as it was.
- From then on, Tor's updates install by themselves. Each one restarts Tor, so the .onion and I2P
  paths are away for a moment.
- Turn it off with `MORPHIT_TOR_UPDATES=off` in `/etc/morphit/updates.env`. The repository Morphit
  added is then removed, and Tor stays as installed.

### Settings files you changed

unattended-upgrades skips any package whose update would ask about a settings file the server
changed and the package also changed. Such a security fix never installed by itself. Now the
server's file is kept in that case (the package's new default is left beside it as
`<file>.dpkg-dist`), and the fix installs.

### `/etc/morphit/updates.env`

A file written by v1.24.7 gets the two new settings added at its end (`MORPHIT_NODE_UPDATES=on`,
`MORPHIT_TOR_UPDATES=on`). Your own lines stay as they are.

### Not in this release

- **i2pd 3.0.0** (2026-10-20) is offered by the i2pd repository on three servers, but Morphit has
  not been tested with it yet. It moves in its own release.
- **Kubo (IPFS) 0.43** fixes a bug where malformed blocks stop the daemon (systemd restarts it). The
  move needs testing with a real daemon and comes in its own release.

The daily security watch now also checks Node.js, Tor, i2pd, Kubo, and the npm packages of the
newest release.

## For developers

### Automatic updates (`lib/autoUpdates.ts`)

- NodeSource's repository (`nodeSourceRelease`, by its site `deb.nodesource.com`). Its pattern is
  read from apt: on morphit.io apt reports its origin and label as `. nodistro`. A real
  unattended-upgrades 2.9.1 run against a stand-in repository with that origin took 22.23.5 and not
  24.0.0. The pin is `/etc/apt/preferences.d/morphit-node-major`, the same shape as Docker's (shared
  `majorPinText`).
- The Tor Project's repository (`torProjectRelease`, by its site or its onion) joins the patterns.
  It has no pin: the Tor Project's stable suite holds stable releases only.
- `DPkg::Options { "--force-confdef"; "--force-confold"; }` is always written. Proven with the real
  unattended-upgrades: without it, a stand-in package with a changed conffile was skipped ("has
  conffile prompt"); with it, it installed and kept the local file.
- `DPkg::Post-Invoke` runs `ops/scripts/morphit-node-restart.sh` (new). The heal only names that
  script when it is a regular file owned by root that nobody else can write, because apt runs it as
  root. The script restarts each running `morphit-*.service` with a process whose
  `/proc/<pid>/exe` ends in `/node (deleted)`, checks it is active again, logs to the journal and
  always exits 0. It was tested against a real process whose node binary was renamed over, as dpkg
  does, and in the real apt run above (the hook ran after the upgrade).
- Pattern values escape fnmatch's `*`, `?` and `[` (unattended-upgrades compares values with
  fnmatch).
- New settings `MORPHIT_NODE_UPDATES` and `MORPHIT_TOR_UPDATES`, added to an older Morphit-written
  `updates.env` (`ADDED_SETTINGS`); that addition is reported once, not counted as routine.

### Node runtime (`lib/nodeRuntimeHeal.ts`)

`NODE_RUNTIME` (version and the linux-x64/arm64 SHA-256 from nodejs.org's SHASUMS256.txt, read on
two servers that agreed) is the release's Node. A test keeps it equal to `NODE_VERSION` in
`scripts/build-offline-bundle.sh`, now `v22.23.5`.

Without a bundle that brings that Node, the tarball is downloaded (`curl`, then through Tor's SOCKS
port; Tor only on a zero-clearnet server), its SHA-256 compared, unpacked (`tar -xJf`), its
`bin/node --version` checked, and put in place by rename as before. The work folder is removed in
every case. Within an upgrade the services restart on the new Node right after. Under
`upgrade --heals` (`servicesAlreadyRunning`), the restart script runs. An `/usr/bin` (apt) Node is
left to apt.

### Tor Project repository (`lib/torProjectRepoHeal.ts`, new)

Runs in the after-restart unit, after the Tor version heal and before the bridges heal, under the
Tor bridges lock. Its time limit, `TOR_REPO_HEAL_MAX_MS`, is part of `UNIT_MAX_S`. It also runs in
`__automatic-updates` on a fresh install, before the automatic updates heal.

The order is: route (site, then onion; onion only when zero-clearnet), key fingerprint, InRelease
signature (`gpgv` against the dearmored key), Codename and Architectures. Then the rollback copy
(`apt-get download tor=<v> tor-geoipdb=<v>`; every package must come). Then the keyring (unless the
keyring package owns it), the onion proxy (clearnet with the onion only;
`Acquire::http::Proxy::<onion> "socks5h://…"`), and the deb822 source (`tor+http://<onion>` on a
zero-clearnet server with apt's Tor transport). Then `apt-get update` of that source only (a
failure counts even when older lists exist), a candidate from the Tor Project, the install with
confold plus the keyring package, the installed version read back from the Tor Project, and Tor
connecting (a hidden Blurt node answers through it). Anything short of that runs `putBack`: remove
what was written, `dpkg -i` the copy when Tor changed, restart Tor, check it.

The fixtures are the servers' real `apt-cache policy` and Release fields. The real `gpg`/`gpgv`
checks run with a key generated in the test.

Tests: `autoUpdates.test.ts` (+20, the restart script run for real), `nodeRuntimeHeal.test.ts`
(rewritten, 13, real `.tar.xz`), `torProjectRepoHeal.test.ts` (new, 22). 58 mutations, each
caught: 23 in the automatic updates and the restart script, 35 in the Tor and Node heals.

### Docs

OPERATIONS.md §37.2 (Node.js, Tor, settings files, the two new settings).
