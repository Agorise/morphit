# Morphit v1.0.0-beta.3

Third public beta. This release is focused on **install and upgrade
reliability** — fixing a setup bug that could stop a fresh node from
starting, and making the install/upgrade experience smoother for
operators of every skill level.

If you are running beta.1 or beta.2, see **Upgrading** below — the
path is slightly different this time because of the boot fix.

## Fixed

- **Setup wizard wrote two settings into the wrong file, which
  stopped the indexer from starting.** `morphit-ops init` placed
  `MORPHIT_RELAY_SIGNUP_DAILY_CEILING` and
  `MORPHIT_RELAY_TRUSTED_PROXY_IPS` into `morphit.config.env`, which
  is restricted to a small allowlist of operator-tunable values. The
  indexer correctly refuses to boot when it finds non-allowlisted
  keys there, so a freshly-configured node failed to start with
  `[operator-config] ... contains keys not in the operator
  allowlist`. These two settings now go into `morphit.env` (matching
  the relay's environment, the env templates, and the Ansible role),
  where the relay reads them as intended. New installs are
  unaffected by the old behavior; existing operators who hit this,
  see **Upgrading**.

## Added

- **`morphit-ops install` — a guided first-time install.** Checks
  prerequisites (Node, PostgreSQL, git), runs the setup wizard,
  offers server hardening, and offers to put `morphit-ops` on your
  `PATH` so you can drop the `npx` prefix. On a fresh Ubuntu box, the
  Ansible playbook in `ops/ansible/` still does the OS-level install
  (Node/PostgreSQL/services); `morphit-ops install` is the
  interactive, learn-as-you-go path.

- **`docs/start-here/` — a plain-language navigation hub.** Tells you
  exactly which document to open for what you want to do (install,
  upgrade, fix a problem, change settings, launch). New operators
  should start there.

- **`docs/MIGRATE-TO-RELEASE-TRACK.md`** — a one-time procedure for
  nodes that were installed with `git clone` and therefore can't use
  `morphit-ops upgrade` yet (they lack the `release-info.json` that
  ships inside release tarballs).

- **A throwaway-VM install validator** at
  `scripts/validate-fresh-install.sh` for operators helping certify
  the install path.

## Improved

- **`morphit-ops upgrade` now finds the newest release even when it
  is flagged as a pre-release.** Previously it only looked at the
  latest *stable* release, so during the all-beta period it could
  report "already on the latest" and never upgrade. It now prefers a
  stable release when one exists and otherwise falls back to the
  newest release of any kind.

## Upgrading from beta.1 / beta.2

The boot fix changes what the setup wizard *writes*; it does not
change what an already-installed node has on disk. So:

- **If your `morphit.config.env` contains
  `MORPHIT_RELAY_SIGNUP_DAILY_CEILING` or
  `MORPHIT_RELAY_TRUSTED_PROXY_IPS`** (any node configured by the
  beta.1/beta.2 wizard will), the cleanest path is a fresh install
  of this release followed by re-running `npx morphit-ops init`,
  which writes correct config. Back up your relay key
  (`apps/relay/keystore.json` or `.wif`) and `apps/relay/altnet/`
  first; your PostgreSQL database and on-chain registration are not
  affected. Full steps: `docs/MIGRATE-TO-RELEASE-TRACK.md`.

- **Or**, to keep your existing config, remove those two lines from
  `morphit.config.env` (the relay reads them from `morphit.env`
  instead) and restart. If they aren't already in `morphit.env`, add
  `MORPHIT_RELAY_SIGNUP_DAILY_CEILING=50` (or your chosen value)
  there.

- From this release onward, `npx morphit-ops upgrade` carries your
  config and keys forward automatically.

## Verify the download

```
sha256sum -c morphit-v1.0.0-beta.3.tar.gz.sha256
```

Output must say `OK` before you extract.

## Status

Pre-launch beta. Not yet recommended for production traffic. The
canonical public instance is morphit.io. Community operators
welcome — start at `docs/start-here/`.
