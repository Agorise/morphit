#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# morphit-setup.sh — the ONE command you run right after extracting a
# Morphit release.  It takes a bare, freshly-unzipped folder to a running setup
# wizard with no fuss, closing the chicken-and-egg where `morphit-ops` can't run
# yet because Node.js and the project's libraries aren't installed:
#
#   1. make sure Node.js 22+ is installed (install it from NodeSource if not);
#   2. install the project's libraries (`npm ci`, exactly the locked
#      versions, no dependency install scripts) so the `morphit-ops`
#      command exists at all;
#   3. hand off to `morphit-ops install`, which checks the remaining
#      prerequisites and walks you through the rest.
#
# Run it once, as root, from INSIDE the extracted folder:
#
#     sudo bash morphit-setup.sh
#
# It is safe to re-run — it only installs what is actually missing (idempotent),
# and it never deletes or overwrites your data.
#
# It automates the apt world (Ubuntu / Debian / Linux Mint).  On anything else
# it does NOT guess: it tells you the two things to install by hand and points
# at docs/RUN-A-MORPHIT-NODE.md, then stops so nothing is left half-done.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NODE_MAJOR_MIN=22
# NodeSource's apt signing key ("NSolid <nsolid-gpg@nodesource.com>").
NODESOURCE_KEY_FPR=6F71F525282841EEDAF851B42F59B5F99B1BE0B4

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m! \033[0m%s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# This script lives at the repo root; run from there so `npm ci` +
# `morphit-ops` resolve regardless of where the operator invoked it from.
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
[ -f package.json ] || die "Run this from inside the extracted Morphit folder (no package.json here)."

# Root is needed to install system packages now (and systemd units later).
if [ "$(id -u)" -ne 0 ]; then
	die "Please run this as root:  sudo bash morphit-setup.sh"
fi

# The automatic path is apt-only.  Anything else: explain, point at the docs,
# and STOP rather than guess a package manager and leave a mess.
if ! command -v apt-get >/dev/null 2>&1; then
	warn "Automatic setup supports Ubuntu / Debian / Linux Mint (apt)."
	warn "On your system, install Node.js ${NODE_MAJOR_MIN}+ and PostgreSQL yourself, then run:"
	warn "    npm ci --ignore-scripts && sudo node apps/ops-cli/bin/morphit-ops.mjs install"
	warn "Full step-by-step: docs/RUN-A-MORPHIT-NODE.md"
	die  "Unsupported package manager — stopping so nothing is left half-done."
fi

# True only when a Node is present AND its major version is new enough.
node_ok() {
	command -v node >/dev/null 2>&1 || return 1
	_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
	[ "${_major:-0}" -ge "$NODE_MAJOR_MIN" ] 2>/dev/null
}

if node_ok; then
	log "Node.js $(node -v) is already installed — good."
elif [ -x vendor/node/bin/node ]; then
	# Self-contained (offline) tarball: install the bundled Node.js runtime into
	# /usr/local so node + npm are on PATH, with no NodeSource and no network.
	log "Installing the bundled Node.js runtime (offline)…"
	cp -a vendor/node/. /usr/local/
	hash -r 2>/dev/null || true
	node_ok || die "the bundled Node.js runtime did not install cleanly — see docs/RUN-A-MORPHIT-NODE.md."
	log "Node.js $(node -v) installed from the bundle."
else
	log "Installing Node.js ${NODE_MAJOR_MIN} LTS (NodeSource's apt repository, its key checked)…"
	apt-get update -qq
	apt-get install -y ca-certificates curl gnupg
	# Not NodeSource's setup script piped into a root shell: their signing key
	# is fetched, and used only when its fingerprint is the pinned one (the
	# same pin as ops/ansible/group_vars/all.yml nodesource_key_fingerprint);
	# apt then checks every package against that key alone (signed-by).
	_nskey="$(mktemp)"
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$_nskey" \
		|| die "couldn't download NodeSource's signing key on this machine — check its connection, or use the offline bundle (it carries Node.js)."
	_nsfpr="$(gpg --show-keys --with-colons "$_nskey" 2>/dev/null | awk -F: '/^pub:/ {n++} /^fpr:/ && f == "" {f = $10} END {print n " " f}')"
	[ "$_nsfpr" = "1 $NODESOURCE_KEY_FPR" ] \
		|| die "NodeSource's signing key is not the one Morphit expects (got: ${_nsfpr:-nothing}), so nothing was installed. Use the offline bundle, or install Node.js ${NODE_MAJOR_MIN} yourself and re-run."
	install -d -m 0755 /etc/apt/keyrings
	gpg --dearmor <"$_nskey" >/etc/apt/keyrings/nodesource.gpg && chmod 0644 /etc/apt/keyrings/nodesource.gpg
	rm -f "$_nskey"
	echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_MIN}.x nodistro main" \
		>/etc/apt/sources.list.d/nodesource.list
	apt-get update -qq
	apt-get install -y nodejs
	node_ok || die "Node.js ${NODE_MAJOR_MIN}+ still isn't available after install — see docs/RUN-A-MORPHIT-NODE.md."
	log "Node.js $(node -v) installed."
fi

# git is handy for updates later; install it if absent (cheap, non-fatal).  A
# self-contained (offline) tarball ships git + its dependencies in the bundled
# apt closure (vendor/apt), so we install it FROM THERE with no network — a
# truly air-gapped box gets git too, and an online box doesn't waste a download.
# Only when there's no bundle (source-tarball install) do we reach the registry.
if ! command -v git >/dev/null 2>&1; then
	log "Installing git…"
	if [ -f vendor/apt/Packages ]; then
		# Offline-first: resolve git (+ its deps) from ONLY the bundled repo, so
		# apt never touches the network even on a box that has connectivity.
		_bl="/etc/apt/sources.list.d/morphit-bundle-git.list"
		printf 'deb [trusted=yes] file://%s ./\n' "$HERE/vendor/apt" >"$_bl"
		apt-get -o Dir::Etc::SourceList="$_bl" -o Dir::Etc::SourceParts=/dev/null \
			-o APT::Sandbox::User=root -o APT::Get::List-Cleanup=0 update >/dev/null 2>&1 || true
		apt-get -o Dir::Etc::SourceList="$_bl" -o Dir::Etc::SourceParts=/dev/null \
			-o APT::Sandbox::User=root install -y git 2>/dev/null \
			|| dpkg -i vendor/apt/git_*.deb vendor/apt/git-man_*.deb vendor/apt/liberror-perl_*.deb 2>/dev/null \
			|| warn "git not installed from the bundle — Morphit runs fine without it; git-based updates just won't be available."
		rm -f "$_bl"
	else
		apt-get install -y git 2>/dev/null || warn "git not installed (offline?) — Morphit runs fine without it; git-based updates just won't be available."
	fi
fi

# Libraries: a self-contained (offline) tarball ships a complete, prebuilt
# node_modules with a marker file — use it as-is, with no network.  Otherwise
# install normally (this reaches the npm registry, so it needs internet).
if [ -f node_modules/.morphit-bundle-complete ]; then
	log "Using the bundled libraries (offline — skipping the library install)."
else
	log "Installing Morphit's libraries (npm ci — a few hundred MB, this is normal)…"
	# Exactly the versions package-lock.json pins, and no dependency's install
	# script runs as root (the Matrix bot's two native add-ons are fetched
	# against pinned sums only when the bot is used). update_notifier off:
	# keeps npm's "New major version available" banner off the screen.
	npm_config_update_notifier=false npm ci --ignore-scripts --no-audit --no-fund
fi

log "Handing off to the guided installer…"
echo ""
# morphit-ops now exists in node_modules/.bin; --no-install keeps it offline-safe
# and prevents npx from trying to fetch anything.  `install` checks the rest of
# the prerequisites and walks the operator through configuration.
# The update-notifier is also off in the repo's .npmrc; set it here too so
# the npx wrapper — which prints npm's "New major version" notice when it
# exits, AFTER the whole wizard — can never show it.
exec env npm_config_update_notifier=false npm_config_fund=false npx --no-install morphit-ops install
