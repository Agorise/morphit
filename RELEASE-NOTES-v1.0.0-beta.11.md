# Morphit v1.0.0-beta.11

A large operator-experience release. The `morphit-ops` command-line tool
gains a **guided BunkerWeb installer**, an **API-based indexer-health
view** that works without root or database access, a **redesigned
top-to-bottom setup menu**, and **broader OS recognition** across the
Debian/Ubuntu family — including hardened, lightweight servers like
Kicksecure and popular derivatives like Linux Mint and Pop!_OS. It also
ships the **real fix** for the post-beta.10 "frontend stale after
upgrade" problem (now detected by the build-directory mount rather than a
container name, so custom reverse-proxy stacks are handled too), plus a
right-to-left display fix on the coin carousel. **Recommended for every
operator.**

## Added

- **Guided BunkerWeb installer — `morphit-ops bunkerweb`.** When the WAF
  isn't up yet and you're at an interactive terminal, the command now
  walks you through bringing up the canonical `ops/bunkerweb/` stack:
  it confirms before each step, copies the shipped config into
  `/etc/bunkerweb` (never clobbering an existing one), prompts for and
  validates your domain (`SERVER_NAME`), guards against the missing-TLS-
  certificate crash-loop (pointing you at `morphit-ops ssl` first), then
  runs `docker compose pull` and `docker compose up -d` and re-verifies.
  Status checks (when the stack is already up, with `--json`, or
  non-interactively) remain read-only.

- **`morphit-ops health` — indexer health over HTTP.** A new menu view
  that queries the running indexer's `/v1/health` endpoint and prints a
  one-line verdict — **synced**, **behind** (with the lag in blocks), or
  **unreachable** — plus the healthy/total RPC count. Because it talks
  HTTP rather than reading the database or config, it works as the
  unprivileged `morphit` user even when the full Status dashboard can't.
  Exit code is `0` synced, `1` behind, `2` unreachable — drops straight
  into a cron health-check.

- **Broader operating-system support.** The setup pre-flight now
  green-lights the whole Debian/Ubuntu family as first-class: Ubuntu
  24.04/26.04 LTS and Debian 12+, plus popular derivatives recognized
  automatically from their base codename — Linux Mint, Pop!_OS, Zorin
  OS, KDE neon, elementary OS — and hardened-Debian distributions like
  Kicksecure, which make excellent lean, security-focused nodes. The
  pre-flight also gained PostgreSQL and Docker checks.

## Changed

- **Redesigned `morphit-ops` main menu.** Reorganized into four
  lifecycle groups — *Install & upgrade*, *Configure the instance*,
  *Secure the server*, *Check & operate* — in a newbie-friendly
  top-to-bottom order, with plain-language blurbs and recommendations
  that state their tradeoffs. Three similarly-named commands (doctor /
  health / status) are now disambiguated by purpose.

- **"● update available" is now bright yellow** in the menu, so a
  pending upgrade is easy to spot at a glance.

## Fixed

- **`morphit-ops upgrade` reliably republishes the web frontend on any
  Docker deployment.** The upgrade now finds the frontend container by
  the `apps/web/build` bind-mount it carries — regardless of the
  container's name (`morphit-frontend`, `bunkerweb-frontend-1`, a
  hand-rolled stack, …) — and `docker restart`s it so it serves the
  freshly-built files. Earlier releases recreated a container matched by
  name through the example compose file, which missed custom or renamed
  stacks; mount-based detection handles them with no manual steps.

- **Coin carousel renders left-to-right in right-to-left locales.** On
  the Farsi interface the asset carousel is now pinned to `dir="ltr"` so
  ticker symbols and prices read in the correct order.

- **Removed a dead, unused translation key** left over from an earlier
  release.

## Notes for operators

- **Debian 12+ and Kicksecure** are supported via the **manual** setup
  path (`morphit-ops install`), not the one-command Ansible playbook —
  the playbook targets the Ubuntu 24.04 "noble" family (Ubuntu 24.04,
  Mint 22, Pop!_OS, Zorin 17, KDE neon, elementary). See
  `docs/RUN-A-MORPHIT-NODE.md` §3.

- If a custom BunkerWeb stack left your frontend stale after a previous
  upgrade, beta.11's `morphit-ops upgrade` detects and restarts your
  container automatically — no by-hand `--force-recreate` needed.

---

*Morphit is non-custodial and no-KYC. As always, verify the release
signature against the published fingerprint before deploying.*
