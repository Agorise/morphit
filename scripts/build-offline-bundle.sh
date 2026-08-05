#!/usr/bin/env bash
# build-offline-bundle.sh
#
# Assemble the SELF-CONTAINED ("appliance") bundle so a Morphit node installs
# with the network cable unplugged — no npm registry, no NodeSource, no apt
# mirrors, no Docker Hub, no dist.ipfs.tech.  The operator downloads ONE tarball
# (however they can — a good connection elsewhere, a mirror, a USB stick) and
# then `morphit-setup.sh` runs to completion offline; the network-dependent tail
# (real TLS cert, Blurt RPC connect, opt-in on-chain registration) is finished
# automatically by morphit-first-online the moment the box sees the internet.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHERE TO RUN THIS
#   On Ubuntu 24.04 x86_64 WITH docker available — a CI runner or a throwaway VM
#   that MATCHES the deployment target.  The apt .debs and docker images this
#   collects are architecture- AND release-specific: a bundle built on 24.04
#   x86_64 installs on 24.04 x86_64 (and its derivatives, e.g. Linux Mint 22).
#   Do NOT run it on your workstation expecting a portable result.
#
# WHAT IT PRODUCES (all under ./vendor, plus ./node_modules)
#   node_modules/                    prebuilt app deps  (+ .morphit-bundle-complete marker)
#   vendor/node/                     Node.js runtime    (bin/ lib/ …)
#   vendor/kubo/                     Kubo (IPFS) tarball (SHA-512 pinned)
#   vendor/apt/                      local apt repo      (.deb closure + Packages.gz)
#   vendor/docker/                   saved docker images (.tar)
#   vendor/BUNDLE-MANIFEST.txt       inventory + checksums
#
# The install side is already wired to use these when present and fall back to
# the network when absent (morphit-setup.sh, the vendor preflight role, the
# ipfs/nodejs roles).  So an ordinary source tarball still installs online, and
# a tarball built with this script installs offline.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_ROOT}"
VENDOR="${REPO_ROOT}/vendor"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Keep these in lock-step with the roles.  ── Kubo pin: ipfs role
# (morphit_kubo_version / morphit_kubo_sha512).  ── Node major: morphit-setup.sh
# NODE_MAJOR_MIN and group_vars morphit_node_version.
KUBO_VERSION="v0.42.0"
KUBO_SHA512="054c38a0cf66f7d738e25085ad62cb3a42d03d4bac329b7dd25c1d71cf18e1ce87d55b1d1b705b04c65210dca9109973579e0eb1cd72f6341ecb3311d840d156"
NODE_VERSION="v22.14.0"   # any 22.x LTS >= the roles' floor

command -v docker >/dev/null 2>&1 || die "docker is required (to save the bunkerweb + postgres images)."
[ "$(dpkg --print-architecture 2>/dev/null || echo unknown)" = "amd64" ] \
	|| die "run on x86_64/amd64 — the .debs + images are arch-specific."

rm -rf "${VENDOR}"
mkdir -p "${VENDOR}/node" "${VENDOR}/kubo" "${VENDOR}/apt" "${VENDOR}/docker"

# ── 1. App dependencies → node_modules (+ marker) + a shippable npm cache ──
# `npm ci` gives a deterministic, lockfile-exact tree.  The marker tells
# morphit-setup.sh + the morphit role to use it as-is and never touch the registry.
# --cache points the download cache at vendor/npm-cache so it ships in the bundle:
# the offline MCP deploy (ops/scripts/deploy-mcp.sh) installs its lean runtime tree
# with `npm install --offline` against THIS cache — the one registry read left in
# the whole offline install.
log "1/6  Installing app dependencies (npm ci) + priming the offline npm cache…"
npm ci --cache "${VENDOR}/npm-cache"
touch node_modules/.morphit-bundle-complete

# ── 1b. Warm the cache for the offline MCP deploy ──
# deploy-mcp.sh builds a lean runtime tree with `npm install` against a REWRITTEN
# package.json — that needs npm's PACKUMENT metadata (the version listing) to
# RESOLVE tsx + the MCP SDK, which `npm ci` (lockfile-exact, integrity-keyed
# tarballs only) does NOT cache.  So run the real deploy once here, ONLINE, into a
# throwaway dir with the cache pointed at vendor/npm-cache: npm resolves + fetches
# exactly what the runtime `npm install --offline` will need, and it lands in the
# shipped cache.  MORPHIT_MCP_CACHE_WARM=1 forces deploy-mcp's online branch even
# though vendor/npm-cache already exists; a non-existent service user makes it skip
# the chown.  set -e means a warm failure fails the build (better than a bundle
# that can't deploy the MCP offline).
log "     …warming the npm cache for the offline MCP deploy"
_mcpwarm="$(mktemp -d)"
env MORPHIT_MCP_CACHE_WARM=1 npm_config_cache="${VENDOR}/npm-cache" \
	bash "${REPO_ROOT}/ops/scripts/deploy-mcp.sh" "${REPO_ROOT}" "${_mcpwarm}" morphit-mcp-cache-warm-nouser
rm -rf "${_mcpwarm}"

# ── 2. Node.js runtime → vendor/node ──
log "2/6  Fetching the Node.js ${NODE_VERSION} runtime…"
_ntar="node-${NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${_ntar}"
curl -fsSL  "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
	| grep " ${_ntar}\$" | sha256sum -c - || die "Node tarball checksum mismatch."
tar -xJf "${_ntar}" --strip-components=1 -C "${VENDOR}/node"
rm -f "${_ntar}"

# ── 3. Kubo (IPFS) → vendor/kubo (SHA-512 verified, must match the ipfs role) ──
log "3/6  Fetching Kubo ${KUBO_VERSION}…"
_ktar="kubo_${KUBO_VERSION}_linux-amd64.tar.gz"
curl -fsSLO "https://dist.ipfs.tech/kubo/${KUBO_VERSION}/${_ktar}"
printf '%s  %s\n' "${KUBO_SHA512%% *}" "${_ktar}" | sha512sum -c - \
	|| die "Kubo checksum mismatch — does KUBO_SHA512 match the ipfs role pin?"
mv "${_ktar}" "${VENDOR}/kubo/${_ktar}"

# ── 4. apt closure → vendor/apt (local repo) ──
# Download every package the playbook installs PLUS its full recursive dependency
# set, then build a Packages.gz so apt can install from file:// with no network.
#
# We do this inside a FRESH ubuntu:24.04 container (the build host has Docker), so
# the closure is COMPLETE — nothing is skipped as "already installed" — and it
# matches a fresh 24.04 target exactly, regardless of what the build host has.
# No sudo: the container is root (which also sidesteps host sudo quirks).
log "4/6  Downloading the apt dependency closure in a clean ubuntu:24.04 container…"
# The union of packages the default-ENABLED roles apt-install (base, hardening,
# ddns, tls, postgres, bunkerweb, tor, i2pd).  A smoke (ansible-structural,
# "offline bundle PKGS covers every enabled-role apt install") diffs this against
# the roles and FAILS on drift — so a fresh, minimal target installs with zero
# network.  Node is NOT here: vendor/node covers it and nodejs.yml skips
# NodeSource.  Monitors / matrix_bot / trivy are default-off and not bundled.
PKGS="ca-certificates curl wget gnupg git lsb-release jq age rsync build-essential \
chrony cron ufw fail2ban auditd audispd-plugins aide aide-common apparmor apparmor-utils \
rkhunter libpam-pwquality unattended-upgrades apt-listchanges postfix libsasl2-modules \
certbot postgresql postgresql-client postgresql-contrib python3-psycopg2 tor i2pd \
apt-transport-https docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
# Fetch Docker's repo key on the host (which has curl) so the container stays clean.
APTSTAGE="$(mktemp -d)"
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "${APTSTAGE}/docker.asc"
chmod a+r "${APTSTAGE}/docker.asc"
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
	> "${APTSTAGE}/docker.list"
docker run --rm -e PKGS="${PKGS}" -v "${APTSTAGE}:/mnt:ro" -v "${VENDOR}/apt:/out" \
	ubuntu:24.04 bash -c '
		set -eu
		export DEBIAN_FRONTEND=noninteractive
		apt-get update -qq
		# ca-certificates only, to enable the https Docker repo (present on every real
		# target); everything else in the list is downloaded, not installed.
		apt-get install -y --no-install-recommends ca-certificates
		install -m 0755 -d /etc/apt/keyrings
		cp /mnt/docker.asc /etc/apt/keyrings/docker.asc
		cp /mnt/docker.list /etc/apt/sources.list.d/docker.list
		apt-get update -qq
		apt-get install --download-only -y ${PKGS}
		cp /var/cache/apt/archives/*.deb /out/
		chmod a+r /out/*.deb
	' || die "apt closure download (in the ubuntu:24.04 container) failed — see the log above."
rm -rf "${APTSTAGE}"
( cd "${VENDOR}/apt" && dpkg-scanpackages -m . /dev/null | gzip -9c > Packages.gz )
log "     $(ls "${VENDOR}/apt"/*.deb 2>/dev/null | wc -l) .deb files harvested."

# ── 5. Docker images → vendor/docker (docker save) ──
log "5/6  Pulling + saving docker images…"
for img in bunkerity/bunkerweb:latest postgres:16-alpine; do
	docker pull "${img}"
	_safe="$(printf '%s' "${img}" | tr '/:' '__')"
	docker save "${img}" | gzip -9c > "${VENDOR}/docker/${_safe}.tar.gz"
	[ -s "${VENDOR}/docker/${_safe}.tar.gz" ] \
		|| die "docker save produced an empty file for ${img} — image not present / save failed."
	log "     saved ${img} → $(du -h "${VENDOR}/docker/${_safe}.tar.gz" | cut -f1)"
done

# ── Manifest ──
{
	echo "Morphit offline bundle — built $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
	echo "host: $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}") $(dpkg --print-architecture)"
	echo "node: ${NODE_VERSION}   kubo: ${KUBO_VERSION}"
	echo
	echo "node_modules: $(du -sh node_modules 2>/dev/null | cut -f1)"
	echo "vendor/apt:   $(ls "${VENDOR}/apt"/*.deb 2>/dev/null | wc -l) debs, $(du -sh "${VENDOR}/apt" | cut -f1)"
	echo "vendor/docker:$(ls "${VENDOR}/docker"/*.tar.gz 2>/dev/null | wc -l) images, $(du -sh "${VENDOR}/docker" | cut -f1)"
} > "${VENDOR}/BUNDLE-MANIFEST.txt"

log "Done.  vendor/ + node_modules/ are ready to include in the self-contained tarball."
log "Total added: $(du -shc "${VENDOR}" node_modules 2>/dev/null | tail -1 | cut -f1) (see vendor/BUNDLE-MANIFEST.txt)."

# ── 6. Package the self-contained tarball (unless --no-tar) ──
# The result installs completely offline: extract it, `sudo bash morphit-setup.sh`,
# with no network.  Named -offline so it sits alongside the slim source tarball on
# the release page; operators pick whichever fits their connectivity.
if [ "${1:-}" != "--no-tar" ]; then
	VER="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
	OUT="morphit-v${VER}-offline.tar.gz"
	log "6/6  Packaging ${OUT} (this includes node_modules + vendor — it will be large)…"
	STAGE="$(mktemp -d)"
	# Include node_modules + vendor; exclude only VCS/build junk.  --strip nothing:
	# the tarball's top-level is the repo, same shape as the source tarball.
	# --no-wildcards-match-slash is CRITICAL: without it GNU tar lets `*` cross `/`,
	# so `./apps/*/dist` also matches nested apps/web/node_modules/<pkg>/dist (jspdf,
	# dompurify, …) and silently strips those packages' prebuilt output from the
	# bundle → the offline build later fails with "Cannot find module …/dist/…".
	# The flag keeps the excludes anchored to the project's OWN build dirs only.
	tar --no-wildcards-match-slash \
		--exclude='./.git' --exclude='./out' --exclude='./dist' \
		--exclude='./apps/*/dist' --exclude='./apps/*/build' \
		--exclude='./packages/*/dist' --exclude='*.log' \
		--exclude='./morphit-*.tar.gz*' \
		-czf "${STAGE}/${OUT}" .
	mv "${STAGE}/${OUT}" "./${OUT}"
	rmdir "${STAGE}"
	# Fail LOUD if packaging dropped a critical piece.  The docker images and kubo
	# are saved as .tar.gz, and a stray `--exclude='*.tar.gz'` once silently dropped
	# them — the bundle looked fine (~316MB) but could not install offline (cp646).
	# List the tarball ONCE, then grep a here-string: `tar … | grep -q` would let
	# grep close the pipe early, SIGPIPE tar, and (under pipefail) report a false miss.
	_manifest="$(tar -tzf "./${OUT}")"
	for _need in 'vendor/docker/.*[.]tar[.]gz' 'vendor/kubo/.*[.]tar[.]gz' \
		'vendor/apt/.*[.]deb' 'vendor/node/bin/node' 'vendor/npm-cache/' 'node_modules/'; do
		grep -qE "${_need}" <<< "${_manifest}" \
			|| die "offline bundle is INCOMPLETE — missing ${_need} (packaging bug); NOT shipping this."
	done
	sha256sum "${OUT}" > "${OUT}.sha256"
	log "Wrote ./${OUT} ($(du -sh "${OUT}" | cut -f1)) + ${OUT}.sha256"
	log "Attach both to the release, or distribute via any of the mirrors."
fi

