# Upgrading Morphit

A practical guide to keeping your Morphit instance current with
upstream releases, written for sysadmins.

**TL;DR.** When you see a new release announced (Matrix channel,
`morphit-release-monitor` alert, or the Forgejo release page),
run:

```
sudo -u morphit npx morphit-ops upgrade
```

That command checks for a new release, shows you the notes, asks
for confirmation, backs up your current install, applies the new
tarball, runs `npm ci`, and restarts services. If anything fails,
it rolls back automatically.

The rest of this doc covers the details: how the trust chain
works, the manual procedure (for operators who prefer to apply
each step themselves), the automated mode, rollbacks, and
building from source.

---

## How releases work

A Morphit release is an annotated git tag of the form
`v<MAJOR>.<MINOR>.<PATCH>` (e.g. `v1.0.0-beta.3`). The release
workflow at `.forgejo/workflows/release.yml` runs on every tag
push, in this order:

1. **Verifies the tag is signed** by an authorized maintainer's
   GPG key (the public keys live in `.forgejo/release-signers/`
   in the repo — anyone with repo read access can audit who's
   authorized).
2. Runs the **full validation gate**: typecheck across all
   workspaces, ansible-lint in production profile, and the
   complete triple-pulse smoke suite (thousands of self-checking
   scenarios).
3. Builds the **release tarball** and **SHA-256 checksum file**.
4. Bakes a **provenance manifest** (`release-info.json`) into the
   tarball recording the tag, commit SHA, and CI build time.
5. Publishes both artifacts to the release page.

**What you trust to use a release:** Forgejo's HTTPS server. Once
the artifacts are signed in the release UI, the SHA-256 chains the
download to the announced version, and `release-info.json` chains
that to the signed commit. If you want one more layer (defense
against a compromised Forgejo), see the "Belt-and-braces
verification" section below.

> **Maintainer note — the pre-release flag and `morphit-ops
> upgrade`.** `morphit-ops upgrade` now finds the newest release
> even when it is flagged *pre-release* (it falls back from
> `/releases/latest` to the newest release of any kind when no
> stable exists). **But that fallback only runs in the version the
> operator already has installed.** An operator on a build that
> predates this fix (anything at or before `v1.0.0-beta.2`) is still
> running the old logic, which only sees the newest *non*-pre-release
> release. So until every operator has upgraded onto a build that
> contains the fallback, **leave the release they need to upgrade
> _to_ un-flagged as pre-release** (uncheck "pre-release" in the
> Forgejo release UI), or their `morphit-ops upgrade` will report
> "already on the latest" and never see it. Once operators are on a
> fixed build, you can flag betas pre-release freely.

## What if my instance is several releases behind?

Common case: you stood up an instance, didn't touch it for a
while, and now you're a number of releases out of date. **You do
not need to apply each intermediate release in order.** Morphit
releases are cumulative tarballs (a full install, not a diff), so
`morphit-ops upgrade` jumps you straight from whatever you're
running to the latest published release in one step — the same
check → backup → apply → `npm ci` → restart → auto-rollback flow.
Run exactly the same command no matter how far behind you are:

```
sudo -u morphit npx morphit-ops upgrade
```

Two things to do first when you've been away a while:

1. **Read the release notes for every version between yours and
   the latest**, not just the newest one. The upgrade prints the
   latest release's notes, but if you've skipped several, any
   manual step or behavior change called out in an *intermediate*
   release still applies to you. The notes for each tag are linked
   from the Forgejo release page; `--check-only` prints the URL.
2. **Confirm you're not crossing a major version.** This tool
   assumes same-major upgrades (e.g. `v1.x → v1.y`). A
   major-version bump (`v1.x → v2.0`) may have manual migration
   steps that the release notes for that major will spell out — do
   those by hand before/after as instructed. Within a major,
   schema changes apply automatically: the indexer runs any
   pending migrations on startup, which the upgrade flow triggers
   when it restarts services, so there's no separate migration
   command.

If you're so far behind that you're unsure what changed, the
safest path is: take a database backup (see `OPERATIONS.md`),
read the notes for each skipped release, then run the upgrade.
Your config and signing key (`morphit.config.env`, `morphit.env`,
`apps/relay/keystore.*`, `apps/relay/altnet/`) live inside the
install dir, so the upgrade explicitly **carries them forward**
into the new release (step 8b above) with their permissions
intact — your settings and active key survive every upgrade, and
your PostgreSQL database is never touched.

## Recommended: `morphit-ops upgrade`

The fast path for trusted operators. Reads the current installed
version from `/opt/morphit/release-info.json`, polls the Forgejo
release API, and walks you through the upgrade.

### Check without applying

```
sudo -u morphit npx morphit-ops upgrade --check-only
```

Exits 0 if up-to-date, 1 if a newer release exists. Suitable for
cron and the `morphit-release-monitor` sidecar (see below).

Add `--json` to get machine-readable output:

```
sudo -u morphit npx morphit-ops upgrade --check-only --json
{
  "current": "v1.0.0-beta.3",
  "latest": "v1.0.0-beta.3",
  "up_to_date": true,
  "release_url": "https://git.agorise.net/agorise/morphit/releases/tag/v1.0.0-beta.3",
  "published_at": "2026-05-22T15:30:00Z"
}
```

### Apply an upgrade

```
sudo -u morphit npx morphit-ops upgrade
```

Steps the command takes, in order:

1. Reads `/opt/morphit/release-info.json` for the current version.
2. Finds the release to offer you. It first asks Forgejo for the
   latest **stable** release (`/releases/latest`, which by Forgejo's
   rules returns the newest release *not* marked pre-release). If
   there is no stable release yet — which is the case throughout the
   beta period, when every release is a pre-release — it falls back to
   the newest release of any kind (`/releases?limit=1`). So during
   beta you always get the newest beta even if it's flagged
   pre-release; once a stable ships, the stable is preferred and you
   are not pushed onto a newer beta automatically.
3. If you're already on it, exits 0 (no-op).
4. Otherwise, **shows you the release notes** and prompts y/N.
5. Downloads the tarball + `.sha256` to `/tmp/morphit-upgrade-<ts>/`.
6. Verifies the SHA-256 against the downloaded checksum file.
   **Refuses to proceed if it doesn't match.**
7. Renames `/opt/morphit` → `/opt/morphit.bak-<timestamp>` (backup).
8. Extracts the new tarball to `/opt/morphit`.
8b. **Carries your config and signing key forward** from the backup
    into the freshly-extracted tree — `morphit.config.env`,
    `morphit.env`, `apps/relay/keystore.json` (or `.wif`),
    `apps/relay/altnet/` (your Tor/Lokinet/I2P keys), and
    `morphit-hardening-checklist.md`, all with their `0600`
    permissions preserved. The release tarball deliberately does
    **not** contain these (they're your secrets), so the upgrade
    copies them across for you. You do **not** re-run `morphit-ops
    init` after an upgrade, and you don't re-enter your passphrase
    config — your instance comes back up exactly as it was, on the
    new code.
9. Runs `npm ci --no-audit --no-fund` in the new install dir.
10. Restarts these systemd services if they're active:
    - `morphit-indexer.service`
    - `morphit-relay.service`
    - `morphit-matrix-bot.service`
11. Prunes old backups, keeping the 3 most recent (tunable via
    `MORPHIT_BACKUP_KEEP`).

If **any** step from 7 onwards fails, the command:

- Removes the partial extract at `/opt/morphit`
- Renames the backup back to `/opt/morphit`
- Restarts services on the previous version
- Exits with code 3 ("upgrade failed, rolled back")

In the rare case rollback itself fails (filesystem error, etc.),
it exits with code 4 and prints the manual recovery steps.

### Automated mode (opt-in)

By default the command prompts y/N before applying. To skip the
prompt — for cron jobs or unattended automation — set:

```
export MORPHIT_AUTO_UPGRADE=1
sudo -u morphit -E npx morphit-ops upgrade
```

`MORPHIT_AUTO_UPGRADE=1` is opt-in, not the default, by design:
Morphit's posture is that an operator should consciously decide
to upgrade. Auto-upgrade is a power-user feature for sites that
want to track upstream tightly.

Equivalent inline:

```
sudo -u morphit npx morphit-ops upgrade --yes
```

### Configuration

| Env var | Default | What it does |
|---|---|---|
| `MORPHIT_AUTO_UPGRADE` | unset | Set to `1` to skip the y/N prompt |
| `MORPHIT_RELEASE_HOST` | `git.agorise.net` | Forgejo host |
| `MORPHIT_RELEASE_REPO` | `agorise/morphit` | repo path |
| `MORPHIT_INSTALL_DIR` | `/opt/morphit` | install location |
| `MORPHIT_BACKUP_KEEP` | `3` | how many `.bak-*` backups to retain |

## Get notified about new releases — `morphit-release-monitor`

If you'd rather not poll manually, the `morphit-release-monitor`
sidecar runs every 6 hours, calls `morphit-ops upgrade --check-only`,
and emits an INFO event when a newer release is available. The
event surfaces via `journalctl -u morphit-release-monitor`, the
matrix-bot alert relay (if enabled), or whatever else you point
your structured-event ingestion at.

The sidecar **never applies upgrades itself** — it only watches.
You still run `morphit-ops upgrade` manually (or with
`MORPHIT_AUTO_UPGRADE=1` cron) when you decide to apply.

Enable it via the Ansible role `release_monitor` (default OFF;
opt-in via `enable_release_monitor: true` in `group_vars/all.yml`).

## Manual upgrade procedure

If you'd rather apply each step by hand — for review, for an
air-gapped install, or because something about the automated
flow doesn't fit your environment — here's the explicit recipe.

```
# 1. Download the release artifacts (replace VERSION).
cd /tmp
VERSION=v1.0.0-beta.3
curl -fLO "https://git.agorise.net/agorise/morphit/releases/download/${VERSION}/morphit-${VERSION}.tar.gz"
curl -fLO "https://git.agorise.net/agorise/morphit/releases/download/${VERSION}/morphit-${VERSION}.tar.gz.sha256"

# 2. Verify the checksum.  Output must say "OK"; refuse to proceed otherwise.
sha256sum -c "morphit-${VERSION}.tar.gz.sha256"

# 3. Stop the running services.
sudo systemctl stop morphit-indexer morphit-relay
# Matrix bot is optional; stop if installed:
sudo systemctl is-active --quiet morphit-matrix-bot && sudo systemctl stop morphit-matrix-bot

# 4. Backup the current install.
sudo mv /opt/morphit /opt/morphit.bak-$(date -u +%Y%m%dT%H%M%S)

# 5. Extract the new tarball.
sudo mkdir -p /opt/morphit
sudo tar -xzf "morphit-${VERSION}.tar.gz" -C /opt/morphit
sudo chown -R morphit:morphit /opt/morphit  # adjust to match your install

# 6. Install workspace dependencies.
cd /opt/morphit
sudo -u morphit npm ci --no-audit --no-fund

# 7. Verify the new version's release-info.json matches what you downloaded.
cat /opt/morphit/release-info.json
# Confirm "tag" field === "${VERSION}"

# 8. Restart services.
sudo systemctl start morphit-indexer
sudo systemctl start morphit-relay
sudo systemctl is-active --quiet morphit-matrix-bot.service || true && sudo systemctl start morphit-matrix-bot

# 9. Tail logs for a minute to confirm clean startup.
journalctl -fu morphit-indexer -u morphit-relay
```

If the new version misbehaves, see Rollback below.

## Belt-and-braces verification (optional)

The default SHA-256 chain trusts Forgejo's HTTPS server to serve
the right `.sha256` file. To add a layer — defense against a
compromised Forgejo — verify the underlying git tag's GPG
signature directly:

```
# 1. Clone the source (anywhere, doesn't have to be /opt/morphit).
git clone https://git.agorise.net/agorise/morphit.git /tmp/morphit-verify
cd /tmp/morphit-verify

# 2. Import all authorized signer keys.
gpg --import .forgejo/release-signers/*.asc

# 3. Verify the tag is signed by one of those keys.
git tag -v v1.0.0-beta.3
# Output should end with "Good signature from..." and the
# fingerprint should match an authorized signer.

# 4. Optional: confirm the released tarball's git tree matches
#    the tag's tree.  This is brittle (depends on tar's filename
#    ordering matching git's), so the easier check is to compare
#    individual file contents:
git checkout v1.0.0-beta.3
diff -r . /opt/morphit
# Should show only node_modules/ and similar build-artifact paths
# as different (those aren't in the source tree).
```

If `git tag -v` says "Good signature" and the diff is clean, the
tarball you applied is provably the source the tag points to.

## Rollback

`morphit-ops upgrade` automatically rolls back on any failure
between extract and service-restart. If you find a problem AFTER
the upgrade completes — slow startup, missing feature, bug
reported by a user — you can manually swap to the previous
install:

```
# 1. Stop services.
sudo systemctl stop morphit-indexer morphit-relay
sudo systemctl is-active --quiet morphit-matrix-bot && sudo systemctl stop morphit-matrix-bot

# 2. Find the most recent backup.
ls -ltd /opt/morphit.bak-* | head -1

# 3. Swap.
sudo mv /opt/morphit /opt/morphit.bad-$(date -u +%Y%m%dT%H%M%S)
sudo mv /opt/morphit.bak-<timestamp> /opt/morphit

# 4. Restart services.
sudo systemctl start morphit-indexer morphit-relay
```

If the issue is a database-side bug (e.g. a new schema migration
broke something), additional steps may be needed — these would
be called out in the release notes.

## Building from source

For maximum trust, or to develop locally, build from the git
source instead of the released tarball:

```
git clone https://git.agorise.net/agorise/morphit.git
cd morphit

# Verify the tag (optional but recommended).
gpg --import .forgejo/release-signers/*.asc
git tag -v v1.0.0-beta.3

# Check out the release tag.
git checkout v1.0.0-beta.3

# Install + run the validation gates (same gates CI runs).
npm ci
bash scripts/typecheck-sweep.sh
bash scripts/run-smokes.sh

# Now follow docs/RUN-A-MORPHIT-NODE.md for the first-time
# install, or — if upgrading — stop services, sync this tree
# to /opt/morphit, npm ci, restart services.
```

This is the path for the savviest operators (and for developers).
You're not bound to released tarballs; you can run any commit
on `main`, you can audit changes between tags by reading
`git log`, you can build and verify locally.

## When upgrades happen

Morphit follows a "stable releases" model: tagged releases come
when the maintainer decides a milestone is shippable. There's no
fixed cadence. Major releases (`vX.0.0`) may include breaking
changes called out in the release notes; minor (`vX.Y.0`) and
patch (`vX.Y.Z`) releases are intended to be drop-in safe.

Pre-release tags (`-alpha.N`, `-beta.N`, `-rc.N`) are valid release
versions with the same release tooling — they're explicitly less
stable and intended for operators participating in beta-testing.

## Troubleshooting

**"No release-info.json at /opt/morphit/release-info.json"** —
your install predates the release-tooling provenance manifest
(v1.0.0-beta.3+). For first-time upgrades from a manual install,
copy this file manually:

```
echo '{"tag":"unknown","commit":"unknown","build_time":"unknown","builder":"manual"}' \
  | sudo tee /opt/morphit/release-info.json
```

Then re-run `morphit-ops upgrade`. It will detect the latest
version and apply normally.

**"SHA-256 mismatch on downloaded tarball"** — the download was
corrupted or tampered with. Don't proceed. Retry the download; if
the mismatch persists, alert the maintainers via the Matrix
channel (`#agorise:matrix.org`) — this could indicate a Forgejo
compromise.

**"Service restart failed for morphit-indexer; rolling back"** —
the new version's startup failed. Check
`journalctl -u morphit-indexer -n 200` for the error. The
rollback runs automatically; once you've diagnosed the issue,
either work around it or wait for a fixed release.

**"Manual intervention needed: /opt/morphit is in a partial state"** —
both upgrade AND rollback failed. Don't restart services. Inspect
`/opt/morphit` and the `*.bak-*` backups; manually move the
most-recent backup into place and restart. This case is rare and
indicates a filesystem-level issue (full disk, permission drift,
...).
