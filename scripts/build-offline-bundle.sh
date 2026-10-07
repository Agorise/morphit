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
# (morphit_kubo_version / morphit_kubo_sha512).  ── Node: major = morphit-setup.sh
# NODE_MAJOR_MIN, group_vars morphit_node_version and package.json engines.
KUBO_VERSION="v0.42.0"
KUBO_SHA512="054c38a0cf66f7d738e25085ad62cb3a42d03d4bac329b7dd25c1d71cf18e1ce87d55b1d1b705b04c65210dca9109973579e0eb1cd72f6341ecb3311d840d156"
# The ONE exact Node pin of an offline install (the roles and morphit-setup.sh
# require major 22 and take what the bundle carries). Keep it on the newest
# 22.x release: an installed offline node takes this runtime at its next
# bundled upgrade (morphit-ops upgrade, lib/nodeRuntimeHeal.ts).
NODE_VERSION="v22.22.2"

# Files the release job (and a maintainer's checkout) leave in the tree that
# must not ship: CI provenance scratch, IPFS/IPNS outputs, the IPNS signing
# tools' node_modules, signatures and tarballs, and ./private (the
# maintainer's private handoff, never published).
BUNDLE_EXCLUDES=(
	--exclude='./.git' --exclude='./out' --exclude='./dist'
	--exclude='./apps/*/dist' --exclude='./apps/*/.svelte-kit'
	--exclude='./packages/*/dist' --exclude='*.log'
	--exclude='./morphit-*.tar.gz*'
	--exclude='./distribution-anchor.env' --exclude='./release-signer.fpr'
	--exclude='./ipfs-cid.txt' --exclude='./ipns-*.txt' --exclude='./ipns-sign.json'
	--exclude='./scripts/ipns/node_modules'
	--exclude='./private'
)

# release-info.json names the release this tree is (morphit-ops reads it for
# the installed version; build-verify-json.mjs for provenance). The release
# job writes it before building the bundle; anywhere else (or when a stale one
# is in the tree) it is written here from package.json, never left as is.
write_release_info() {
	local ver tag commit
	ver="$(node -p "require('./package.json').version")"
	tag="v${ver}"
	if [ -f release-info.json ] && [ "$(node -p "require('./release-info.json').tag" 2>/dev/null)" = "${tag}" ]; then
		log "     release-info.json already names ${tag} — kept."
		return 0
	fi
	commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
	printf '{\n  "tag": "%s",\n  "commit": "%s",\n  "build_time": "%s",\n  "builder": "build-offline-bundle"\n}\n' \
		"${tag}" "${commit}" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > release-info.json
	log "     release-info.json written for ${tag}."
}

# Test seams: the two steps a smoke can run without Docker or a network.
if [ "${1:-}" = "--release-info-only" ]; then write_release_info; exit 0; fi
if [ "${1:-}" = "--tar-only" ]; then
	write_release_info
	tar --no-wildcards-match-slash "${BUNDLE_EXCLUDES[@]}" -czf "${2:?--tar-only <out.tar.gz>}" .
	exit 0
fi

# Options:
#   --without-docker  no apt closure and no saved images (both need Docker). The
#                     release job uses it: it runs in a container with no Docker.
#                     What an UPGRADE needs is all there (node_modules + marker,
#                     the prebuilt frontend, the canonical tarball); a fresh
#                     install from such a bundle fetches its OS packages and
#                     images online. A Node or Kubo download that fails is left
#                     out with a warning instead of failing.
#   --reuse-frontend  ship the apps/web/build already built and marked .shipped
#                     (the release job's canonical build, the same bytes as the
#                     slim tarball) instead of building a second, different one.
#   --no-tar          stage vendor/ + node_modules/ only.
WITHOUT_DOCKER=0
REUSE_FRONTEND=0
MAKE_TAR=1
for _a in "$@"; do
	case "${_a}" in
		--without-docker) WITHOUT_DOCKER=1 ;;
		--reuse-frontend) REUSE_FRONTEND=1 ;;
		--no-tar) MAKE_TAR=0 ;;
		*) die "unknown option: ${_a}" ;;
	esac
done
warn() {
	printf '\033[1;33m!\033[0m %s\n' "$*" >&2
	printf '::warning title=offline bundle::%s\n' "$*"
}

if [ "${WITHOUT_DOCKER}" = 0 ]; then
	command -v docker >/dev/null 2>&1 \
		|| die "docker is required (to save the bunkerweb + postgres images); --without-docker builds a bundle without them."
fi
[ "$(dpkg --print-architecture 2>/dev/null || echo unknown)" = "amd64" ] \
	|| die "run on x86_64/amd64 — the .debs + images are arch-specific."

rm -rf "${VENDOR}"
mkdir -p "${VENDOR}/node" "${VENDOR}/kubo"
[ "${WITHOUT_DOCKER}" = 1 ] || mkdir -p "${VENDOR}/apt" "${VENDOR}/docker"

# ── 1. App dependencies → node_modules (+ marker) ──
# `npm ci` gives a deterministic, lockfile-exact tree.  The marker tells
# morphit-setup.sh + the morphit role to use it as-is and never touch the registry.
# The MCP deploy (ops/scripts/deploy-mcp.sh) copies its runtime packages out of
# this same tree, so nothing else needs an npm cache.
# No install scripts run; the Matrix bot's two native add-ons are fetched and
# checked against pinned SHA-256s (scripts/fetch-matrix-bot-natives.mjs).
log "1/6  Installing app dependencies (npm ci, no install scripts)…"
npm ci --ignore-scripts --no-audit --no-fund
node "${REPO_ROOT}/scripts/fetch-matrix-bot-natives.mjs" "${REPO_ROOT}"
touch node_modules/.morphit-bundle-complete

# ── Prebuild + ship the web frontend (CRITICAL for air-gapped/USB installs) ──
# An offline node (USB-stick delivery, NO internet ever) cannot build the
# SvelteKit frontend on-target: the build is memory-heavy, and — more to the
# point — a local rebuild is not byte-reproducible, so it would fail the on-chain
# build-integrity check. Worse, an incomplete on-target build (missing
# index.html) 500-loops the whole site (this took a real operator's node dark).
# So we build the canonical frontend HERE, ONCE, and ship it inside the bundle
# marked `.shipped`; the on-target build guard then serves these exact bytes and
# skips the vite build entirely. This mirrors what release.yml does for the
# online tarball, so online and offline nodes are byte-for-byte identical.
if [ "${REUSE_FRONTEND}" = 1 ]; then
	log "     Shipping the web frontend already built for this release (no second build)…"
	[ -f apps/web/build/.shipped ] \
		|| die "--reuse-frontend: apps/web/build carries no .shipped marker, so it is not this release's canonical build."
else
log "     Building the canonical web frontend to ship in the bundle…"
# A `.shipped` marker left by an earlier bundle run would make the build guard
# (apps/web/scripts/build-shipped-guard.mjs) skip the build and ship that OLD
# frontend inside this release's bundle. Drop it so this is always a fresh build.
rm -f apps/web/build/.shipped
npm run build -w apps/web
fi
if [ ! -f apps/web/build/index.html ]; then
	echo "FATAL: web frontend build did not produce apps/web/build/index.html — refusing to ship a bundle that would 500-loop on the target." >&2
	exit 1
fi
# The brand-slot record lets `morphit-ops branding` put an operator's site name
# into the prerendered pages (docs/BRANDING.md); a build without it cannot be
# branded.
if [ ! -f apps/web/build/.brand-slots.json ]; then
	echo "FATAL: web frontend build did not produce apps/web/build/.brand-slots.json (the brand-slot adapter did not run) — refusing to ship it." >&2
	exit 1
fi
touch apps/web/build/.shipped
log "     Frontend prebuilt + marked .shipped (target will serve these exact bytes, no on-box build)."


# Every download is bounded: a stalled mirror must not hang the release job.
CURL_BOUNDS=(--connect-timeout 30 --max-time 900 --retry 2)
# A required part that could not be fetched: fatal for a full bundle; left out
# with a warning by --without-docker (an upgrade does not need it).
optional_or_die() {
	if [ "${WITHOUT_DOCKER}" = 1 ]; then warn "$1 — left out of this bundle."; return 0; fi
	die "$1"
}

# ── 2. Node.js runtime → vendor/node ──
log "2/6  Fetching the Node.js ${NODE_VERSION} runtime…"
_ntar="node-${NODE_VERSION}-linux-x64.tar.xz"
NODE_INCLUDED=0
if curl -fsSLO "${CURL_BOUNDS[@]}" "https://nodejs.org/dist/${NODE_VERSION}/${_ntar}" \
	&& curl -fsSL "${CURL_BOUNDS[@]}" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
		| grep " ${_ntar}\$" | sha256sum -c - \
	&& tar -xJf "${_ntar}" --strip-components=1 -C "${VENDOR}/node"; then
	NODE_INCLUDED=1
else
	rm -rf "${VENDOR}/node"
	optional_or_die "Node.js ${NODE_VERSION} could not be downloaded and checked"
fi
rm -f "${_ntar}"

# ── 3. Kubo (IPFS) → vendor/kubo (SHA-512 verified, must match the ipfs role) ──
log "3/6  Fetching Kubo ${KUBO_VERSION}…"
_ktar="kubo_${KUBO_VERSION}_linux-amd64.tar.gz"
KUBO_INCLUDED=0
# dist.ipfs.tech first, then the same release on GitHub (the release job saw
# dist.ipfs.tech time out); the SHA-512 pin checks whichever answered.
for _kurl in "https://dist.ipfs.tech/kubo/${KUBO_VERSION}/${_ktar}" \
	"https://github.com/ipfs/kubo/releases/download/${KUBO_VERSION}/${_ktar}"; do
	rm -f "${_ktar}"
	if curl -fsSL "${CURL_BOUNDS[@]}" "${_kurl}" -o "${_ktar}" \
		&& printf '%s  %s\n' "${KUBO_SHA512%% *}" "${_ktar}" | sha512sum -c -; then
		KUBO_INCLUDED=1
		break
	fi
	warn "Kubo ${KUBO_VERSION}: no good copy from ${_kurl}"
done
if [ "${KUBO_INCLUDED}" = 1 ]; then
	mv "${_ktar}" "${VENDOR}/kubo/${_ktar}"
else
	rm -f "${_ktar}"
	rm -rf "${VENDOR}/kubo"
	optional_or_die "Kubo ${KUBO_VERSION} could not be downloaded or does not match KUBO_SHA512 (the ipfs role pin)"
fi

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
if [ "${WITHOUT_DOCKER}" = 1 ]; then
	log "4/6  Skipped (--without-docker): no apt closure; a fresh install fetches its packages online."
	log "5/6  Skipped (--without-docker): no saved images; a fresh install pulls them online."
else
log "4/6  Downloading the apt dependency closure in a clean ubuntu:24.04 container…"
# The union of packages the default-ENABLED roles apt-install (base, hardening,
# ddns, tls, postgres, bunkerweb, tor, i2pd).  A smoke (ansible-structural,
# "offline bundle PKGS covers every enabled-role apt install") diffs this against
# the roles and FAILS on drift — so a fresh, minimal target installs with zero
# network.  Node is NOT here: vendor/node covers it and nodejs.yml skips
# NodeSource.  Monitors / matrix_bot / trivy are default-off and not bundled.
# librsvg2-bin is not a role install: `morphit-ops branding apply` offers it to
# draw the phone icons and launch screens, and an offline node must be able to
# say yes without a network (docs/BRANDING.md).
# apt-transport-tor (v1.20.0, C13): the tor role installs it on a tor-only node
# so apt fetches over Tor. A tor-only node must get it with NO clearnet, and on
# an offline install this closure is its only source; `morphit-ops upgrade`
# also looks for it here (vendor/apt) before fetching it over Tor.
PKGS="ca-certificates curl wget gnupg git lsb-release jq age rsync build-essential \
chrony cron ufw fail2ban auditd audispd-plugins aide aide-common apparmor apparmor-utils \
rkhunter libpam-pwquality unattended-upgrades apt-listchanges postfix libsasl2-modules \
certbot postgresql postgresql-client postgresql-contrib python3-psycopg2 tor i2pd \
apt-transport-https docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin ansible \
librsvg2-bin apt-transport-tor"
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
		# The Ubuntu distro i2pd (2.49.0) crash-loops on startup; vendor the
		# maintained purplei2p build (2.61.0+) instead so offline installs get a
		# stable i2pd. add-apt-repository fetches the PPA signing key itself.
		apt-get install -y --no-install-recommends software-properties-common
		add-apt-repository -y ppa:purplei2p/i2pd
		apt-get update -qq
		apt-get install --download-only -y ${PKGS}
		cp /var/cache/apt/archives/*.deb /out/
		chmod a+r /out/*.deb
	' || die "apt closure download (in the ubuntu:24.04 container) failed — see the log above."
# write the Packages index in the formats apt probes, uncompressed
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

# download the ansible galaxy collections the playbook needs into the
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
# a missing scheduler image, the bug) makes `docker compose up` try to pull
# from Docker Hub and die with no network.  The guided install uses HOST postgres,
# so NO postgres image is bundled (a manual dockerized VPS does not use bundles).
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
	# A digest-pinned image (name:tag@digest) is saved BY ITS TAG: saved by
	# the full reference, `docker save` records no name, so the loaded image
	# would have an ID and no name and nothing could find it (Docker 29.8.2,
	# both image stores).  Saved by tag, its original index (the pinned digest)
	# rides inside, which is how the installed box proves the loaded image is
	# the pinned one (apps/ops-cli/src/lib/frontendBaseImage.ts).
	_save="${img}"
	case "${img}" in *@sha256:*) _save="${img%@*}"; docker tag "${img}" "${_save}" ;; esac
	docker save "${_save}" | gzip -9c > "${VENDOR}/docker/${_safe}.tar.gz"
	[ -s "${VENDOR}/docker/${_safe}.tar.gz" ] \
		|| die "docker save produced an empty file for ${img} — image not present / save failed."
	case "${img}" in *@sha256:*)
		_hex="${img##*@sha256:}"
		# (whole-stream reads: an early exit would SIGPIPE gzip under pipefail)
		_got="$(tar -xzOf "${VENDOR}/docker/${_safe}.tar.gz" "blobs/sha256/${_hex}" 2>/dev/null | sha256sum | cut -d' ' -f1)" || _got=''
		[ "${_got}" = "${_hex}" ] || die "the saved ${_save} does not carry the pinned index ${img#*@} — this Docker uses its classic image store, whose saves rewrite manifests. Build the bundle with Docker's containerd image store (the default of a new Docker 29+ install; or add {\"features\":{\"containerd-snapshotter\":true}} to /etc/docker/daemon.json and restart Docker), then run this again."
		_mf="$(tar -xzOf "${VENDOR}/docker/${_safe}.tar.gz" manifest.json 2>/dev/null)" || _mf=''
		case "${_mf}" in *"\"${_save}\""*) ;; *) die "the saved ${_save} carries no name for docker load to give it." ;; esac
		;;
	esac
	log "     saved ${img} → $(du -h "${VENDOR}/docker/${_safe}.tar.gz" | cut -f1)"
done
fi

# ── Manifest ──
{
	echo "Morphit offline bundle — built $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
	echo "host: $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}") $(dpkg --print-architecture)"
	echo "node: ${NODE_VERSION} ($([ "${NODE_INCLUDED}" = 1 ] && echo included || echo NOT included))   kubo: ${KUBO_VERSION} ($([ "${KUBO_INCLUDED}" = 1 ] && echo included || echo NOT included))"
	if [ "${WITHOUT_DOCKER}" = 1 ]; then
		echo "contents: built without Docker — no apt packages (vendor/apt) and no Docker images (vendor/docker)."
		echo "  An upgrade (morphit-ops upgrade --from-file) needs neither. A fresh install from"
		echo "  this bundle fetches those online."
	fi
	echo
	echo "node_modules: $(du -sh node_modules 2>/dev/null | cut -f1)"
	if [ "${WITHOUT_DOCKER}" = 0 ]; then
		echo "vendor/apt:   $(ls "${VENDOR}/apt"/*.deb 2>/dev/null | wc -l) debs, $(du -sh "${VENDOR}/apt" | cut -f1)"
		echo "vendor/docker:$(ls "${VENDOR}/docker"/*.tar.gz 2>/dev/null | wc -l) images, $(du -sh "${VENDOR}/docker" | cut -f1)"
	fi
} > "${VENDOR}/BUNDLE-MANIFEST.txt"

log "Done.  vendor/ + node_modules/ are ready to include in the self-contained tarball."
log "Total added: $(du -shc "${VENDOR}" node_modules 2>/dev/null | tail -1 | cut -f1) (see vendor/BUNDLE-MANIFEST.txt)."

# ── 6. Package the self-contained tarball (unless --no-tar) ──
# The result installs completely offline: extract it, `sudo bash morphit-setup.sh`,
# with no network.  Named -offline so it sits alongside the slim source tarball on
# the release page; operators pick whichever fits their connectivity.
if [ "${MAKE_TAR}" = 1 ]; then
	VER="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
	OUT="morphit-v${VER}-offline.tar.gz"
	log "6/6  Packaging ${OUT} (this includes node_modules + vendor — it will be large)…"
	STAGE="$(mktemp -d)"
	# v1.16.10 — ship the CANONICAL standard tarball inside the bundle so a
	# hidden-only node that upgrades offline can seed the REAL bytes (the CID that
	# matches the on-chain anchor) and become a Tor/I2P seeder itself — not just a
	# consumer. It goes under ./.canonical-release/ (a subdir the root-anchored
	# `./morphit-*.tar.gz*` exclude below does NOT match). ~13 MB on a ~700 MB
	# bundle. Best-effort: if the canonical tarball isn't beside us (non-CI build),
	# the bundle just ships without it and the offline seed cleanly skips.
	rm -rf ./.canonical-release
	if [ -f "morphit-v${VER}.tar.gz" ]; then
		mkdir -p ./.canonical-release
		cp "morphit-v${VER}.tar.gz" ./.canonical-release/ 2>/dev/null || true
		[ -f "morphit-v${VER}.tar.gz.sha256" ] && cp "morphit-v${VER}.tar.gz.sha256" ./.canonical-release/ 2>/dev/null || true
		log "     Shipping canonical morphit-v${VER}.tar.gz inside the bundle (hidden nodes seed it)."
	fi
	# Include node_modules + vendor; exclude only VCS/build junk.  --strip nothing:
	# the tarball's top-level is the repo, same shape as the source tarball.
	# --no-wildcards-match-slash is CRITICAL: without it GNU tar lets `*` cross `/`,
	# so `./apps/*/dist` also matches nested apps/web/node_modules/<pkg>/dist (jspdf,
	# dompurify, …) and silently strips those packages' prebuilt output from the
	# bundle → the offline build later fails with "Cannot find module …/dist/…".
	# The flag keeps the excludes anchored to the project's OWN build dirs only.
	# NOTE: apps/web/build is DELIBERATELY NOT excluded — it is the prebuilt
	# canonical frontend (marked .shipped above) that an air-gapped/USB node serves
	# without building. We only drop the .svelte-kit build cache that producing it
	# leaves behind.
	write_release_info
	tar --no-wildcards-match-slash "${BUNDLE_EXCLUDES[@]}" -czf "${STAGE}/${OUT}" .
	mv "${STAGE}/${OUT}" "./${OUT}"
	rmdir "${STAGE}"
	rm -rf ./.canonical-release  # don't leave it in the working tree after packaging
	# Fail LOUD if packaging dropped a critical piece.  The docker images and kubo
	# are saved as .tar.gz, and a stray `--exclude='*.tar.gz'` once silently dropped
	# them — the bundle looked fine (~316MB) but could not install offline.
	# List the tarball ONCE, then grep a here-string: `tar … | grep -q` would let
	# grep close the pipe early, SIGPIPE tar, and (under pipefail) report a false miss.
	_manifest="$(tar -tzf "./${OUT}")"
	_needs=('node_modules/' 'vendor/BUNDLE-MANIFEST[.]txt')
	[ "${WITHOUT_DOCKER}" = 1 ] || _needs+=('vendor/docker/.*[.]tar[.]gz' 'vendor/apt/.*[.]deb')
	[ "${KUBO_INCLUDED}" = 0 ] || _needs+=('vendor/kubo/.*[.]tar[.]gz')
	[ "${NODE_INCLUDED}" = 0 ] || _needs+=('vendor/node/bin/node')
	for _need in "${_needs[@]}"; do
		grep -qE "${_need}" <<< "${_manifest}" \
			|| die "offline bundle is INCOMPLETE — missing ${_need} (packaging bug); NOT shipping this."
	done
	# The runtime-critical SOURCE must survive the packaging excludes too.  The
	# long-running services run straight from TypeScript source via tsx (no
	# compiled dist is shipped), and every @morphit/* workspace package is a
	# src-entry import — so a future --exclude edit that stripped any of these
	# would ship a bundle that INSTALLS but then crash-loops with "Cannot find
	# module …", exactly the failure class we chase on a fresh node.  Assert the
	# entrypoints, the tsx launcher, the offline marker, the web source (rebuilt
	# on the target), and EVERY workspace package's source are present.  The
	# package list is derived from disk so a newly-added package is covered with
	# no edit here.
	for _need in 'apps/indexer/src/main[.]ts' 'apps/relay/src/main[.]ts' \
		'apps/web/src/' 'node_modules/[.]bin/tsx' 'node_modules/[.]morphit-bundle-complete'; do
		grep -qE "${_need}" <<< "${_manifest}" \
			|| die "offline bundle is INCOMPLETE — missing ${_need} (packaging stripped runtime-critical source); NOT shipping this."
	done
	for _pkgsrc in packages/*/src/index.ts; do
		[ -e "${_pkgsrc}" ] || continue
		grep -qE "${_pkgsrc//./[.]}" <<< "${_manifest}" \
			|| die "offline bundle is INCOMPLETE — missing ${_pkgsrc} (a workspace package's source was stripped); NOT shipping this."
	done
	# The PREBUILT frontend must ship: an air-gapped/USB node serves these exact
	# bytes and must NOT build on-target. Assert the root entry point (index.html —
	# without it the site 500-loops) AND the .shipped marker (without it the target
	# guard would try to rebuild, which an offline box can't do) both survived the
	# packaging excludes. This is the guard against a future --exclude edit
	# silently dropping apps/web/build again.
	tar -xzOf "./${OUT}" ./release-info.json | grep -q "\"tag\": \"v${VER}\"" \
		|| die "offline bundle's release-info.json does not name v${VER}; NOT shipping this."
	for _need in 'apps/web/build/index[.]html' 'apps/web/build/[.]shipped' 'apps/web/build/[.]brand-slots[.]json'; do
		grep -qE "${_need}" <<< "${_manifest}" \
			|| die "offline bundle is INCOMPLETE — missing ${_need} (the prebuilt frontend was not shipped); an offline node would have no servable site. NOT shipping this."
	done
	sha256sum "${OUT}" > "${OUT}.sha256"
	log "Wrote ./${OUT} ($(du -sh "${OUT}" | cut -f1)) + ${OUT}.sha256"
	log "Attach both to the release, or distribute via any of the mirrors."
fi

