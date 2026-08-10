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
#   SIDE-EFFECT-FREE on the build box's SYSTEM state: it does NOT modify the
#   build box's apt sources/keyrings and installs NOTHING on the host — the whole
#   apt closure (incl. adding the Docker repo) happens inside an ephemeral
#   `--rm ubuntu:24.04` container.  The host contributions are only: writing the
#   build OUTPUTS (node_modules/, vendor/, the tarball) into the repo tree, host
#   `curl` for the Node + Kubo runtimes (step 2/3), and `docker pull`/`docker save`
#   which leaves the three compose images in the host's Docker image CACHE (benign;
#   left in place so repeat builds don't re-pull).  Nothing else on the host is
#   touched.
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
#
# SIDE-EFFECT-FREE: the container is FULLY self-contained — it fetches the Docker
# repo key and adds the Docker apt source ENTIRELY inside itself (an ephemeral
# --rm container), so the BUILD BOX's apt config, keyrings, and installed packages
# are never touched.  The host does nothing here but `docker run`; there is no
# host-side curl, no staging dir, no mount of host files.
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
apt-transport-https docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin ansible"
docker run --rm -e PKGS="${PKGS}" -v "${VENDOR}/apt:/out" \
	ubuntu:24.04 bash -c '
		set -eu
		export DEBIAN_FRONTEND=noninteractive
		apt-get update -qq
		# ca-certificates + curl to fetch/trust the Docker repo key (neither is
		# in the base image); both come from the base repos, before the Docker
		# repo is added.  Everything in $PKGS is downloaded, not installed.
		apt-get install -y --no-install-recommends ca-certificates curl
		install -m 0755 -d /etc/apt/keyrings
		curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
		chmod a+r /etc/apt/keyrings/docker.asc
		# Derive the codename from the container itself so it can never drift from
		# the base image tag (24.04 = noble).
		. /etc/os-release
		printf "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n" \
			"${VERSION_CODENAME}" > /etc/apt/sources.list.d/docker.list
		apt-get update -qq
		apt-get install --download-only -y ${PKGS}
		cp /var/cache/apt/archives/*.deb /out/
		chmod a+r /out/*.deb
	' || die "apt closure download (in the ubuntu:24.04 container) failed — see the log above."
# cp677 — write the Packages index in the formats apt probes, uncompressed
# FIRST plus .xz and .gz. apt tries the compressed variants before the plain
# file; if none of the ones it probes exist it logs `Err:` lines (harmless — it
# falls back to the plain Packages), but Linux Mint's Update Manager treats
# those Err lines as "APT configuration is corrupt". Shipping .xz (which modern
# apt prefers) makes the first probe succeed, so there are no Err lines at all.
( cd "${VENDOR}/apt" \
	&& dpkg-scanpackages -m . /dev/null > Packages \
	&& xz -9ec Packages > Packages.xz \
	&& gzip -9c Packages > Packages.gz )
log "     $(ls "${VENDOR}/apt"/*.deb 2>/dev/null | wc -l) .deb files harvested."

# cp690 — download the ansible galaxy collections the playbook needs into the
# bundle, so a truly offline install installs them from here, never Ansible
# Galaxy. `ansible-galaxy collection download` writes the collection tarballs
# plus a requirements.yml (referencing those local tarballs) into the output
# dir; the installer then does `collection install -r <that>/requirements.yml`
# with no network. Run in the same ubuntu:24.04 container (ansible-galaxy needs
# ansible present) so the build box needs nothing but Docker.
log "  downloading ansible galaxy collections (community.general/postgresql/docker)…"
mkdir -p "${VENDOR}/ansible-collections"
docker run --rm \
	-v "${VENDOR}/ansible-collections:/out" \
	-v "${REPO_ROOT}/ops/ansible/collections:/reqs:ro" \
	ubuntu:24.04 bash -c '
		set -eu
		export DEBIAN_FRONTEND=noninteractive
		apt-get update -qq
		apt-get install -y --no-install-recommends ansible
		ansible-galaxy collection download -r /reqs/requirements.yml -p /out
	' || die "ansible galaxy collection download (in the ubuntu:24.04 container) failed — see the log above."
log "     ansible collections staged into vendor/ansible-collections."

# ── 5. Docker images → vendor/docker (docker save) ──
# The bunkerweb compose (roles/bunkerweb/templates/docker-compose.yml.j2) is the
# ONLY consumer of docker images in a guided install, and it pins exactly two:
# bunkerweb_image + bunkerweb_scheduler_image.  Read them straight from group_vars
# so the saved tags ALWAYS match the tags compose requests offline — a mismatch (or
# a missing scheduler image, the cp653 bug) makes `docker compose up` try to pull
# from Docker Hub and die with no network.  The guided install uses HOST postgres,
# so NO postgres image is bundled (Ken's manual dockerized VPS doesn't use bundles).
_gv="${REPO_ROOT}/ops/ansible/group_vars/all.yml"
BW_IMAGE="$(awk '/^bunkerweb_image:/{print $2; exit}' "${_gv}")"
BW_SCHED_IMAGE="$(awk '/^bunkerweb_scheduler_image:/{print $2; exit}' "${_gv}")"
# The frontend service is BUILT (docker compose up --build) from ops/bunkerweb/
# frontend/Dockerfile; its FROM base image must be present locally too or the build
# pulls it from Docker Hub and dies offline.  Read it from the Dockerfile so it can't
# drift from what the build actually needs.
FE_BASE="$(awk '/^FROM /{print $2; exit}' "${REPO_ROOT}/ops/bunkerweb/frontend/Dockerfile")"
[ -n "${BW_IMAGE}" ] && [ -n "${BW_SCHED_IMAGE}" ] && [ -n "${FE_BASE}" ] \
	|| die "could not read bunkerweb_image / bunkerweb_scheduler_image / frontend FROM base image"
log "5/6  Pulling + saving docker images (${BW_IMAGE} + ${BW_SCHED_IMAGE} + ${FE_BASE})…"
for img in "${BW_IMAGE}" "${BW_SCHED_IMAGE}" "${FE_BASE}"; do
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

