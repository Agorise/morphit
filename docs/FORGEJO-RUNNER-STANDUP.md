# Forgejo runner standup — runbook

**Audience:** the project maintainer, standing up (or rebuilding) the Forgejo Actions runner that the release ceremony depends on.

**Time required:** ~30-45 minutes once you have a host machine.

**Hardware needed:** any machine that can run Docker and reach `git.agorise.net` over the public internet. A `$5/mo` VPS works fine for this. The runner does NOT need to be the same machine as the production morphit.io deploy — separation is preferred.

---

## Why this matters

The release ceremony has 10 steps. Steps 1-7 are repo-state and tag-publication actions that the maintainer performs manually (the full step-by-step ceremony lives at the head of `.forgejo/workflows/release.yml` and in each release's RELEASE-NOTES checklist). Steps 8, 9, and 10 are CI-driven:

- **Step 8** — On `v*` tag push, run the test matrix against a fresh checkout and produce a signed manifest of the tarball SHAs.
- **Step 9** — On manifest verification, produce the release tarball and attach it to the Forgejo release page.
- **Step 10** — On tarball attach, mirror to `morphit.io/releases` and the public mirrors known to the federation directory (see `docs/ARCHITECTURE.md` §Federation for the mirror-discovery model).

None of those steps execute until a Forgejo runner is registered with the `git.agorise.net` instance.

## Threat model for the runner

The runner has access to whatever its repo workflows need. For Morphit, that's:

- The repo source code (public — `git.agorise.net/agorise/morphit` is public-clone).
- Build artifacts (tarballs the runner produces).
- The Forgejo API token used to attach release assets.

The runner does NOT need:

- Production deploy keys (separation: production deploys happen on the morphit.io host, not on the runner).
- The Blurt active key, owner key, or any chain credential.
- The Monero view key or any treasury-wallet data.
- The matrix-bot Matrix access token.

Keep this list short — a compromised runner should only be able to publish bad release tarballs (which would be caught by the signed-manifest verification flow in Step 8), not directly attack production.

## Prerequisites

1. A Forgejo admin account on `git.agorise.net` (the maintainer's account).
2. A host machine (VPS or dedicated) with:
   - Linux (Ubuntu 22.04+ recommended; Debian 12 fine).
   - Docker 24+ installed and the host user added to the `docker` group.
   - Outbound TCP/443 to `git.agorise.net`.
   - At least 4 GB RAM, 20 GB disk (the runner caches workflow artifacts).

## Step 1 — Register the runner with Forgejo

On `git.agorise.net` as the admin user:

```
Site Administration → Actions → Runners → Create new Runner
```

Set the **Scope** to repo-level (`agorise/morphit`). Avoid instance-wide registration — the runner only ever needs to run jobs for this one repo, and instance-wide scope is broader access than the threat model justifies.

Copy the registration token. It looks like `frt_XXXXXXXXXXXXXXXXXXXXXXXX`. Don't lose this — it's only shown once.

## Step 2 — Install `forgejo-runner` on the host

```bash
# As a non-root user with docker access:
mkdir -p ~/forgejo-runner && cd ~/forgejo-runner
curl -L -o forgejo-runner \
  https://code.forgejo.org/forgejo/runner/releases/download/v6.0.0/forgejo-runner-6.0.0-linux-amd64
chmod +x forgejo-runner

# Verify the binary:
sha256sum forgejo-runner
# Compare against the published SHA at code.forgejo.org/forgejo/runner/releases.
```

Pin the version. Don't pull `latest` — a compromised release would be a supply-chain attack on the morphit release pipeline.

## Step 3 — Register the runner

```bash
cd ~/forgejo-runner
./forgejo-runner register \
  --no-interactive \
  --instance https://git.agorise.net \
  --token frt_XXXXXXXXXXXXXXXXXXXXXXXX \
  --name "morphit-release-runner-01" \
  --labels "morphit-build,linux,docker"
```

This creates `~/forgejo-runner/.runner` with the registered token. Treat that file like a secret — it grants job-running privileges on the registered scope.

## Step 4 — Configure runner permissions

Edit `~/forgejo-runner/config.yaml` (create it if absent):

```yaml
log:
  level: info

runner:
  capacity: 2          # max parallel jobs; release pipeline never needs more
  timeout: 30m         # release builds take 5-15 min; 30m is the SAFETY ceiling
  fetch_timeout: 5s

cache:
  enabled: true
  dir: /var/cache/forgejo-runner

container:
  network: bridge
  privileged: false    # release builds never need privileged
  options: "--cpus=2 --memory=4g"
  workdir_parent: /workspace
  # Only allow images from the project's own published list.  This
  # is the single most important defense against malicious workflow
  # changes — a PR that switches the image to a backdoored one is
  # rejected at runner boot.
  valid_volumes: []
```

## Step 5 — Run as a systemd service

```bash
sudo tee /etc/systemd/system/forgejo-runner.service > /dev/null <<EOF
[Unit]
Description=Forgejo Actions runner for morphit
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=/home/$(whoami)/forgejo-runner
ExecStart=/home/$(whoami)/forgejo-runner/forgejo-runner daemon
Restart=on-failure
RestartSec=10s

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/$(whoami)/forgejo-runner /var/cache/forgejo-runner

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now forgejo-runner
```

Verify:

```bash
sudo systemctl status forgejo-runner
# Should show "active (running)" — and the runner appears in
# git.agorise.net's Actions → Runners list as "Idle".
```

## Step 6 — Smoke-test the runner with a no-op workflow

Push a trivial workflow to a feature branch to confirm the runner picks up jobs before relying on it for the actual release.

`.forgejo/workflows/runner-smoke-test.yml`:

```yaml
name: runner-smoke-test
on:
  workflow_dispatch:

jobs:
  hello:
    runs-on: morphit-build
    container: alpine:3.20
    steps:
      - run: echo "Runner is alive on $(uname -a)"
```

Trigger via the Forgejo UI (`Actions → runner-smoke-test → Run workflow`). Expect a green check inside 60s. If it hangs in "queued" for more than 90s, the runner labels don't match — verify `morphit-build` is in the runner's `--labels` (Step 3).

## Step 7 — Run the release-ceremony steps 8/9/10

With the runner registered and smoke-tested, the existing release workflows at `.forgejo/workflows/release.yml` will execute on the next `v*` tag push. The full ceremony walkthrough lives at the head of that workflow file and in each release's RELEASE-NOTES checklist.

## Troubleshooting

**Runner shows "Offline" in the UI:** check the systemd unit — `journalctl -u forgejo-runner -f`. Most-common cause: outbound firewall blocking the runner from reaching `git.agorise.net`.

**Workflow stays "queued":** label mismatch. Compare the workflow's `runs-on:` against the registered labels in `~/forgejo-runner/.runner`.

**Docker image pull fails:** the runner pulls images from Docker Hub by default. If you're behind a registry mirror, set `DOCKER_CONFIG` in the runner's environment to point at the mirror's auth.

**Permission denied on Docker socket:** the runner user is not in the `docker` group, or the `docker` group's gid is different in the container. Fix: `sudo usermod -aG docker $(whoami) && systemctl restart forgejo-runner`.

## What this unblocks

Once Step 7 completes successfully, the release ceremony moves from "9 of 10 steps complete, blocked on runner" to "fully shippable on next tag push". The remaining work is:

1. Maintainer tags the release (e.g. `v1.0.0-beta.18`) on the canonical branch.
2. Runner picks up the tag, runs the test matrix (Step 8), produces the signed manifest.
3. Runner produces the tarball (Step 9) and attaches to the Forgejo release page.
4. Runner triggers mirror upload (Step 10).
5. Release is live.

## Operating the runner long-term

- **Update cadence:** check `code.forgejo.org/forgejo/runner` monthly for new releases. Update by replacing the binary and `systemctl restart forgejo-runner`. The runner's protocol with the Forgejo instance is forward-compatible.
- **Disk:** the runner caches workflow artifacts at `/var/cache/forgejo-runner`. If disk fills, run `forgejo-runner cache clean` (or just `rm -rf /var/cache/forgejo-runner/*`).
- **Reboots:** systemd handles re-registration automatically. The `.runner` token persists across restarts.
- **Compromise response:** if the runner host is suspected compromised, immediately revoke the runner from `git.agorise.net → Site Administration → Actions → Runners → Remove`. Re-register from clean hardware following Step 1.
