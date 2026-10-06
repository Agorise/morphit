# Morphit v1.17.1

Smooth-install / self-heal release. A run of real operator pain — a fresh OS
reinstall, a Tor-only upgrade, and a censored-region node — surfaced a handful of
places where an install or upgrade needed a human to notice and fix something by
hand. Every one of them now handles itself, or fails loud with the exact fix. No
protocol or consensus change.

## Fixed

- **An upgrade no longer leaves a containerized frontend serving the OLD build.**
  The BunkerWeb/containerized frontend bind-mounts the built site, and a rebuilt
  image is byte-identical, so `docker compose up` left the running container pinned
  to the pre-upgrade build — the upgrade reported success while `/verify.json` still
  showed the old version. The frontend is now **force-recreated** so it re-binds the
  fresh build, and the post-upgrade check **self-heals** (restart + re-verify) before
  it will warn.
- **`operator_tag` now shows on containerized instances.** The tag was stamped into
  the served `verify.json` only on the bare-metal deploy path, so every
  container-served instance read `operator_tag: null` despite a correct config and
  on-chain registration. The stamp now runs before both deploy paths. (Cosmetic —
  fee attribution always used the runtime config and was never affected.)
- **A reinstalled IPFS origin host no longer goes publicly dark on IPFS.** Stock
  firewall opened only 22/80/443, so a fresh install left the IPFS swarm port closed
  and public gateways couldn't fetch the seeded release. Hardening now opens **4001
  (tcp + udp)** automatically when the box hosts IPFS, and the post-harden self-test
  flags it if it's ever not open.
- **The warrant-canary upload survives a reinstall.** A fresh OS re-keys only root,
  so the canary's `morphit@` upload failed with "Permission denied". Install now
  propagates the operator's login keys to the `morphit` service user.
- **Canary autorenew no longer fails silently under nvm.** The weekly timer runs with
  a minimal PATH and couldn't find a version-manager `node`; the generated service now
  pins node's directory into its PATH.

## Added

- **Turnkey canary setup.** Remote (laptop-signed) setup now offers to generate a
  dedicated passphrase-less upload key, wires it behind an SSH alias, and points the
  refresh at it — so the weekly timer never prompts and the canary can't go falsely
  stale. Same-box setup is drivable with near-zero data entry.
- **Upgrade offers a canary when the footer link would 404.** If the site footer's
  canary link has no canary behind it (bad for visitors and SEO), the upgrade offers a
  turnkey same-box setup — signing key, first canary, and weekly schedule, automatic —
  and is a single keystroke to decline. It stays silent for operators who already run
  a remote canary.
- **Every instance self-verifies it's a working release seeder.** After seeding a
  release to IPFS, the instance now confirms its own gateway actually *serves* it (the
  path a peer uses) and says so plainly — or warns loudly if it doesn't — so the
  federation never silently loses a seeder.
- **Hidden-only nodes get a clear, verified offline path.** When no federation peer
  yet serves a release over Tor/I2P, the fail-closed message now points to
  `morphit-ops upgrade --from-file`, which verifies the tarball against the SHA-256
  @morphit anchored on-chain (read from the node's own indexer — zero clearnet).

## Changed

- `morphit-ops edit` already offered to re-publish your on-chain registration after a
  name/tag/origin/contact change; this is a reminder that the operator tag attributes
  fee earnings, so a config that drifts to a wrong/reserved tag is now easy to catch
  and correct.

## Security

- Every change is hidden-only-safe: the 4001 rule is gated on the box actually hosting
  IPFS; the canary offer never fights a remote-signed canary; and the offline upgrade
  path verifies against the on-chain anchor with no clearnet dependency. No new network
  exposure on a Tor/I2P-only box.

## Notes

- No protocol/consensus change. All changes are operator-facing install, upgrade,
  recovery, and seeding robustness.
