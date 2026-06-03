# Start here

New to running a Morphit node? You're in the right place. This
page tells you **exactly which document to open for what you want
to do** — so you never have to guess.

You do not need to read everything. Pick the one row that matches
what you're trying to do right now.

---

## I want to…

### …set up a brand-new Morphit node (first time)
👉 Open **[../RUN-A-MORPHIT-NODE.md](../RUN-A-MORPHIT-NODE.md)**

That's the full, friendly, step-by-step install walkthrough — from
picking a server to your node being live. Plan two sessions: one to
install, one to fix whatever didn't work the first time. It assumes
no prior blockchain experience and explains each piece as you go.

### …update my node to a newer version
👉 Open **[../UPGRADING.md](../UPGRADING.md)**

Short version: from your install directory, run
`npx morphit-ops upgrade`. It downloads the new version, checks it,
backs up your current setup, keeps your settings and keys, and
restarts everything. **Do not** update by re-running `git pull` —
the upgrade tool does it safely for you.

### …fix "No release-info.json" when I try to upgrade
👉 Open **[../MIGRATE-TO-RELEASE-TRACK.md](../MIGRATE-TO-RELEASE-TRACK.md)**

This means your node was installed with `git clone` instead of from
an official release. It's a one-time fix to get you onto the proper
release track, after which upgrades "just work."

### …change settings on a node that's already running
👉 Open **[../OPERATIONS.md](../OPERATIONS.md)**, or just run
`npx morphit-ops` from your install directory.

Running `morphit-ops` with no arguments opens a menu — edit
settings (RPC URLs, description, fees), check on your node, manage
keys, harden the server, and more. Each menu item explains itself.

### …make my server more secure
👉 Run `npx morphit-ops harden` (or pick "Harden this server" from
the `morphit-ops` menu), and see **[../SECURITY.md](../SECURITY.md)**.

The harden wizard generates a personalized checklist (SSH, firewall,
automatic updates, TLS, optional web-application firewall, backups)
and walks you through each step.

### …get ready for launch day / the first week
👉 Open **[../LAUNCH-DAY.md](../LAUNCH-DAY.md)** for the morning-of
runbook, then **[../POST-LAUNCH-WEEK-ONE.md](../POST-LAUNCH-WEEK-ONE.md)**
for the first-week monitoring routine.

### …deal with something going wrong
👉 Open **[../BETA-INCIDENT-RUNBOOK.md](../BETA-INCIDENT-RUNBOOK.md)**.
If specifically your relay's signing key is wrong or compromised,
see **[../RECOVERING-FROM-WRONG-RELAY-KEY.md](../RECOVERING-FROM-WRONG-RELAY-KEY.md)**.

### …understand fees and operator rewards
👉 Open **[../FEES-AND-REWARDS.md](../FEES-AND-REWARDS.md)**.

### …switch which networks my node is reachable on (Tor, I2P, etc.)
👉 Open **[../SWITCHING-NETWORKS.md](../SWITCHING-NETWORKS.md)**.

---

## The two commands you'll use most

From inside your install directory (e.g. `/opt/morphit`):

| What you want | Command |
|---|---|
| Open the menu of everything | `npx morphit-ops` |
| Update to the latest version | `npx morphit-ops upgrade` |

> **Why `npx`?** `morphit-ops` is a tool that ships *inside* your
> Morphit install, not a system-wide program. `npx` runs the copy
> that belongs to your install, from your install directory. If you
> type just `morphit-ops` and get "command not found," that's
> normal — add `npx` in front. (If you'd rather type it without
> `npx`, the install can set up a shortcut for you — see
> RUN-A-MORPHIT-NODE.md.)

---

## A note on who should self-host

Running a Morphit node means running real server software —
a database, a web server, a blockchain relay, and key management.
The guides above make it as smooth as possible and assume **no**
blockchain background, but they do assume you're comfortable
typing commands into a terminal and following steps carefully.

If that's not you, the friendlier path is to **use** a Morphit
instance someone else runs (any public instance lists the others
it knows about at `/instances`), rather than hosting your own.

---

*Looking for engineering internals — architecture, design
decisions (ADRs), audit reports, development guides? Those live in
the main `docs/` folder and its `adr/` and `audit/` subfolders.
This "start here" hub is for people running a node, not building
the software.*

---

## For testers: validate a fresh install on a throwaway VM

If you're helping prove the install is smooth before others rely on
it, there's a non-interactive checker. On a **disposable** Ubuntu
24.04 VM (one you'll delete afterward — it installs packages and
writes under `/opt`):

```
git clone https://git.agorise.net/agorise/morphit.git
cd morphit
sudo MORPHIT_VALIDATE_YES=1 bash scripts/validate-fresh-install.sh
```

It checks prerequisites, that `morphit-ops install` and its
preflight run, that the systemd units parse and whether they're
installed, and that release discovery reaches the API — then prints
a PASS/FAIL/WARN summary of the real-world rough edges. Send the
output to the maintainers.

