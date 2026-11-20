# Morphit v1.24.7

**Servers now keep themselves patched, and speak up only when they cannot.** Every server installs
Ubuntu's security fixes every day, Docker's own updates within its installed major version, and
restarts at night only when a fix needs it. A Morphit release marked as a
security release in its signed on-chain record installs itself early in the morning, which is how BunkerWeb and
the frontend's nginx get their fixes without the admin. Settings: `/etc/morphit/updates.env`. The
servers' own reports showed why: none had restarted for kernel and libc fixes waiting up to 6 days
(one ran the kernel of 84 days before), and a Linux Mint server had never installed a security fix,
because the usual setting names Ubuntu's security pocket in a way that matches nothing on Mint.

**The frontend container moves to nginx 1.30.7, as v1.24.6 meant it to.** v1.24.6 pinned the
frontend's nginx base image by a digest Docker Hub showed while nginx 1.30.7 was still being
published: an empty placeholder that lists no image. Every server's rebuild onto it failed ("no
match for platform"), and the frontend stayed on nginx 1.30.5. Sites kept working, and the frontend
was never open to the two HTTP/2 bugs v1.24.6 answered: it serves plain HTTP/1.1. v1.24.7 pins the
finished image list, and CI now refuses a pin that does not list the images servers need.

**A server Docker Hub refuses gets the new base through Tor.** Docker Hub refuses some servers
outright, for any image (it does that for some networks and countries). Such a server could never
move its frontend to a new base. Now the upgrade fetches the pinned image through Tor, without Docker
and without changing Docker's settings, checks every piece against the pinned digest, and loads it.

HTTP/2 stays off, as in v1.24.6, until a BunkerWeb with nginx 1.30.7 or newer exists.

The deadline v1.23.5 set still stands: every site must run v1.23.5 or later (so this release is
fine) before **2026-11-22 00:00 UTC**.

## For operators

### Automatic updates (OPERATIONS.md §37.2, §25b)

**Nothing to do: the upgrade sets it up and checks it.** It writes `/etc/morphit/updates.env` with
these defaults the first time, and sets apt up to match on every upgrade:

```
MORPHIT_SECURITY_UPDATES=on        # Ubuntu's security fixes, every day
MORPHIT_AUTO_RESTART=on            # restart when a fix needs it ...
MORPHIT_AUTO_RESTART_TIME=04:30    # ... at this time of the server's clock
MORPHIT_DOCKER_UPDATES=on          # Docker's own updates, same major version
MORPHIT_AUTO_INSTALL_RELEASES=security   # security | all | off
```

After a change, on that server: `sudo morphit-ops upgrade --heals`. The upgrade reads the result
back from apt and says it in one line.

- **Ubuntu's security fixes** are named by their real origin (`origin=Ubuntu`), so Linux Mint and
  other Ubuntu-based systems match them too.
- **The restart** happens only when a fix needs one, at `MORPHIT_AUTO_RESTART_TIME` by the server's
  own clock: the day's automatic run (early morning) schedules it for the next such time, unless
  someone is logged in when that run finishes (then a later day's run does). A restart already
  pending is scheduled too, so servers waiting on a kernel fix restart once after this upgrade.
  Morphit's services and containers come back by themselves.
- **Docker** Engine and containerd come from Docker's own repository, which Ubuntu's updates never
  touch. Their updates now install by themselves within the installed major version (Docker 29.x,
  containerd 2.x); a new major version waits for a Morphit release tested with it. Installing one
  restarts Docker: BunkerWeb and the frontend are away for a few seconds.
- **Security releases of Morphit** install themselves early each morning (05:15 by the server's clock, after the restart window, plus up
  to 45 minutes), with the same checks as an upgrade by hand: the release's SHA-256 against
  @morphit's signed on-chain record, a backup first, a rollback when a step fails. Only a record
  this server verified against @morphit's pinned key can mark a release as a security release.
  `MORPHIT_AUTO_INSTALL_RELEASES=all` installs every release; `off` leaves upgrades to you.
- **Fewer alerts.** The apt monitor no longer reports each security fix waiting for the nightly run.
  It reports when the server's own patching stops (no successful run for 2 days, WARN) and a restart
  needed for 2 days or more (the daily digest). A release that installs itself at the next early-morning check goes to the
  digest instead of asking you to upgrade; one that installed itself, too. An install that did not
  finish is a WARN with its log; a release record that failed its check is CRITICAL and installs
  nothing.
- **A fresh install** sets all of this up at its end.

### The frontend's nginx

**Upgrade as usual.** `sudo morphit-ops`, option 2, rebuilds the frontend onto
`nginx:1.30.7-alpine` and reads its label back. On a server behind BunkerWeb this happens in the
background checks; the upgrade's last lines say how they ended. A hidden-only server fetches the
image through Tor after the services restart, as before.

**If a frontend rebuild fails, the warning now says what Docker said.** v1.24.6's warning gave a
command to run, and the command failed the same way. Now it quotes Docker's own error line (for
example `failed to solve: … no match for platform in manifest`) and offers the command to try
again.

**On a server Docker Hub refuses** (`curl -s -o /dev/null -w '%{http_code}\n'
https://registry-1.docker.io/v2/` prints `403`; a server it answers gets `401`), the upgrade says so
calmly and leaves the frontend as it is. Then, after the services restart, it fetches the image
through Tor and rebuilds the frontend onto it in the background. `sudo morphit-ops status` shows how
that ended. A zero-clearnet server whose Docker does not pull through Tor gets the image the same
way, instead of waiting.

**A rebuild that must first download the new base gets up to 5 minutes**, as the upgrade's own
frontend rebuild does, instead of 50 seconds.

### Held delegations no longer look like failures

A loyalty delegation too small for the chain (11 BP, below its 33.333 BP minimum) waits in the
relay's queue by design until the account's rewards add up to it. `sudo morphit-ops status` showed
two such delegations on morphit.io as a red "Oldest pending age: 47d" and one as a failed
broadcast. Now they get a line of their own, "Held delegations: 2 … not an error, nothing to do",
and are left out of the oldest-pending age and the failed broadcasts. `failed-broadcasts`,
`drain-queue` and `loyalty` mark them "held, not an error" and say once what that means.
`loyalty` also stops showing a ✓ row in red when a newer target replaced it.

## For developers

### Automatic updates (`lib/autoUpdates.ts`, new)

- `healAutomaticUpdates` (after-restart heals; also `morphit-ops __automatic-updates`, which the
  Ansible playbook runs last on a fresh install): reads `/etc/morphit/updates.env`
  (`parseUpdateSettings`; written with `UPDATES_ENV_DEFAULT_TEXT` when missing), finds the Ubuntu
  base from `/etc/os-release` (`ubuntuBase`: `UBUNTU_CODENAME`, so Mint gives `noble`), installs
  unattended-upgrades when missing (over Tor only on a zero-clearnet node whose apt goes through
  Tor), and writes `/etc/apt/apt.conf.d/52morphit-automatic-updates` (`aptConfText`) and
  `/etc/apt/preferences.d/morphit-docker-major` (`dockerPinText`), only when their bytes differ. The one-line stopgap `52morphit-security-updates` given to a Linux Mint server's admin on 2026-11-19 is removed, and only when it holds exactly that line.
- Docker's repository is the `apt-cache policy` source whose site is `download.docker.com`
  (`parsePolicyReleases`, `dockerRelease`); its pattern names its origin, codename, label and site
  (`dockerPattern`). The pin gives each installed Docker package its major version at priority 500
  and every other version -1; apt takes the first matching record.
- Read back: `apt-config dump` (`aptConfigValues`) must list the Ubuntu security pattern and the
  Docker one and hold the restart values; apt must know an `o=Ubuntu,a=<codename>-security`
  source; Docker's candidate must stay on its installed major; the `apt-daily` timers must be
  enabled and active. Anything else is a warning naming it.
- Proven before it shipped, with apt and unattended-upgrades 2.9.1 (the servers' version): against
  a stand-in Docker repository served over HTTP (29.8 installed; 29.9.2 and 30.0.0 offered)
  unattended-upgrades takes 29.9.2 and containerd 2.4.2 with the pin, 30.0.0 and 3.0.0 without it,
  and nothing when the pattern names another site; with only `Linuxmint:zena-security` allowed (the
  Mint case) it takes nothing, and with `origin=Ubuntu,archive=noble-security` it takes Ubuntu's
  security fixes.
- Tests: `autoUpdates.test.ts` (24; one runs the real apt and unattended-upgrades with
  `MORPHIT_TEST_APT=1`).

### Security releases install themselves (`lib/autoInstallRelease.ts`, new)

- The release record may carry `"security": true` (`ReleasePayloadV1.security`). The payload
  builder adds it with `--security` (a flag, never an environment value, so one left in the terminal
  cannot mark the next release); `scripts/eli5-release.sh <ver> "<msg>" --security` passes it in
  BLOCK 3 and says so. Validators of every version ignore fields they do not know, so older nodes
  accept the record unchanged.
- `ReleaseAnchor.security` (`lib/releaseAnchor.ts`): `payload.security === true` from the verified
  transaction only.
- `decideAutoInstall`: off, not newer, no indexer answer, or a record not readable yet → nothing; a
  record that failed its check → `refused`; `security` mode installs only a verified security
  record; `all` installs any newer release (the upgrade itself verifies it). `morphit-ops
__auto-install-check` prints the decision as one JSON line and exits 0 / 10 / 11.
- `ops/scripts/morphit-auto-install.sh` + `morphit-auto-install.{service,timer}` (root, 4 h limit;
  05:15 + up to 45 min, after the 04:30 restart window, not on boot): runs `upgrade --yes` when told to, logs to
  `/var/log/morphit/auto-install.log`, and emits `auto_install_done` only when `release-info.json`
  reads back as the new version; otherwise `auto_install_failed`; `auto_install_refused` for a
  failed record; `auto_install_check_failed` when the check could not run.
- `healAutoInstall` installs the units, turns the timer on (read back enabled + active), and asks
  the decision once (installs nothing).
- `morphit-release-monitor.sh`: a release the early-morning check would install emits
  `release_installs_tonight` (INFO) instead of `release_available`.
- Alert bot (`classifier.ts`): `auto_install_refused` CRITICAL; `auto_install_failed` and
  `apt:automatic_updates_stalled` WARN; the rest INFO, with their texts.
- Tests: `autoInstallRelease.test.ts` (17, the security mark read from real signed transactions),
  `auto-install-exec-smoke` (18, the script against a stand-in install), `release-monitor-exec-smoke`
  (+3), `classifier-smoke` (+7), `eli5-release-blocks-smoke` (+6),
  `releasePayloadDistribution.test.ts` (+2).

### apt monitor (`ops/scripts/morphit-apt-monitor.sh`)

- With unattended-upgrades on: pending security fixes are reported (`automatic_updates_stalled`)
  only when the last successful automatic run in its log is 2 days old or more
  (`MORPHIT_APT_STALL_DAYS`), else they go to the digest. With it off, as before.
- `restart_pending` (INFO): `/var/run/reboot-required` 2 days old or more
  (`MORPHIT_APT_RESTART_DAYS`), with its packages; checked before the early exit.
- Tests: `apt-monitor-exec-smoke` (11).

### Held delegations (`failedBroadcasts.ts`, `status.ts`, `drainQueue.ts`, `loyalty.ts`)

- New shared rule: `HELD_SQL(cap)` and the pure `isHeldRow(row, cap)`: not sent, under the relay's
  retry limit, and `last_error` starting `held:` (the relay drainer's two hold texts; a test reads
  `apps/relay/src/queue/drainer.ts` and fails if a hold stops starting with it). NULL-safe, so
  `NOT HELD_SQL` keeps rows that have no `last_error` yet.
- `broadcastState` gains `'held'`. `failed-broadcasts`: totals gain `held` (JSON
  `held_until_the_chain_allows`), its rows are `·` with their whole reason, and a window with only
  held rows reads "No broadcast failures in this window".
- `status`: `drain_queue.held` (JSON) and a "Held delegations" row (INFO); "Oldest pending age" is
  the oldest row waiting to be sent ("(none to send)" when only held rows wait); the failed
  broadcast count leaves held rows out.
- `drain-queue` and `loyalty`: held rows are dim, with `HELD_NOTE` once; `loyalty`'s mark and note
  follow `broadcastState` (a retired ✓ row's note is no longer red; in flight `⏳`, may have been
  sent `?`).
- Tests: `failedBroadcastsReal.test.ts` +6 on the real schema (held rows queued 47 days ago, one
  with an earlier counted error, a row with no `last_error`, a held row at the retry limit, the
  loyalty and drain-queue views), `drainQueue.test.ts` +2. Each rule was broken once to see a test
  fail (21 breaks, all caught).

### Docs

- OPERATIONS.md §37.2 rewritten (what the server does, the settings, the alerts, how to look, how
  to turn it off); §25b gains "Security releases install themselves"; SECURITY.md's patching bullet;
  the FAQ answer on attack vectors (10 languages; `llms-full.txt` regenerated); brag list #58 (media
  kit rebuilt); FEES-AND-REWARDS.md, "The chain's minimum delegation", on how the operator views
  show held delegations.

### Frontend base pin (`ops/bunkerweb/frontend/Dockerfile`, `proxyConfigHeal.ts`)

- `FRONTEND_BASE`, the Dockerfile's `FROM` and its label:
  `nginx:1.30.7-alpine@sha256:3bc3836dc0be3b811f238210360bf8e7ca8a2d0effdae46160bf1f3578710051`
  (was `…@sha256:eb37f586…`, an index Docker Hub created at 16:51 UTC on 2026-11-18 with no
  manifests in it; the finished index went up by 19:54 UTC). Read from Docker Hub's `stable-alpine`
  and `1.30-alpine` tags and from the official image's repo-info: the same per-platform digests
  (linux/amd64 `4d1d4ce0…`, linux/arm64 `efd51f02…`, and six more). Pulled by digest on a real
  server before release.
- New `scripts/check-frontend-base.mjs`, run by a new `frontend-base` job in `ci.yml` on every push:
  it signs in to Docker Hub, fetches the pinned index, checks its bytes hash to the pinned digest,
  that the Dockerfile's `FROM` and `LABEL` name the same reference, and that the index lists
  linux/amd64 and linux/arm64 (attestations do not count). Not reaching Docker Hub fails too.
  `scripts/check-frontend-base-smoke.ts` (15 scenarios, against a local stand-in registry; 7
  mutations of the check caught).

### The base through Tor without Docker (`registryOverTor.ts`, new)

- `fetchImageOverTor(ref, outFile, { socks, platform, timeoutMs }, host)`: a pull token from
  `auth.docker.io`, then the pinned image list, this server's platform manifest (`docker version`'s
  Server.Os/Arch), its config and layers from `registry-1.docker.io`, all with curl through Tor's
  SocksPort (`--noproxy '' --socks5-hostname`, as the other Tor fetches). Each object is kept only if
  its bytes hash to the digest that names it: the list to the pinned digest, the manifest to the
  list's entry, config and layers to the manifest's. Blobs follow Docker Hub's redirect to its CDN,
  and curl does not carry the token to another host. The archive is what `docker save` writes for
  one platform: `oci-layout`, `index.json` naming the pinned list
  (`io.containerd.image.name`, `org.opencontainers.image.ref.name`), `manifest.json` for the classic
  store, and the blobs. It is written to the install's offline-bundle path
  (`vendor/docker/…`), so `loadBundledFrontendBase` loads it and proves it as before, and a
  classic-store rebuild names the tag once proven.
- `dockerHubRefusesThisServer()`: `GET /v2/` answers 403 (401 means Docker Hub answers). Asked
  directly, so only on a server that may use clearnet, and only when the base is wanted.
- `lib/frontendBaseFetch.ts` (after-restart checks): on a clearnet server it does nothing unless the
  frontend is not on the pinned base, the base is not here, and Docker Hub refuses the server; then,
  as on a hidden-only node whose Docker does not pull through Tor (before: `waiting`), it fetches
  with `fetchOverTor`, and the frontend is rebuilt onto the result. A hidden-only node whose Docker
  pulls through Tor still lets Docker pull. The offline bundle still comes first.
- `proxyConfigHeal.ts` `baseReach`: a new `'refused'` way (clearnet, the base not here, Docker Hub
  refuses): no rebuild onto the base and no warning, a calm note instead; a config rebuild keeps the
  old base.
- Tests: `registryOverTor.test.ts` (13: real curl and tar against a local registry whose blobs
  redirect to another host name; tampered layer, wrong list bytes, missing platform, a single
  manifest pinned, refused sign-in, no token sent to the CDN). With `MORPHIT_TEST_DOCKER=1` it also
  loads the archive into a real Docker and builds `FROM` it with Docker Hub unreachable: done on
  Docker 29.9.1 with the containerd store (by digest) and the classic overlay2 store (by tag, once
  proven). `frontendBaseFetch.test.ts` +12, `proxyConfigHeal.test.ts` +5. Each new rule was broken
  once to see a test fail (11 breaks, all caught).

### Frontend rebuild (`proxyConfigHeal.ts`)

- `refreshError()` (new, optional in `ProxyHealRuntime`): Docker's reason the last
  `refreshFrontend` failed, from the new pure `dockerFailureReason()`: the last line starting
  `failed to solve`, `error` or `Error response from daemon`, else the last line, cut at 400
  characters; a stopped rebuild says so with its limit.
- `verifyFrontendForwarding`: a failed rebuild's warning carries that reason and says "To try again,
  run:"; a rebuild that ran but did not help claims no reason.
- `PULL_MAX_MS` (300 s) for a rebuild onto a base not yet on the box, instead of `UP_MAX_MS` (50 s).
- The hidden-node notes about the base image (`baseReach`) are printed after the spinner stops; one
  ran into the spinner's line on a hidden-only server.
- Tests: `proxyConfigHeal.test.ts` +7 (the v1.24.6 failure with Docker's words, no reason after a
  rebuild that ran, the download time, notes never under a spinner, and `dockerFailureReason` on the
  real BuildKit and daemon errors); each change was reverted once to see its test fail.
