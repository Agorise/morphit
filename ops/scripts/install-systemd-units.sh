#!/usr/bin/env bash
#
# install-systemd-units.sh — install Morphit's core systemd units,
# pointed at THIS checkout wherever it happens to live.
#
# Why this exists
# ---------------
# The shipped unit files in ops/systemd/ reference /opt/morphit by
# default (the path morphit-ops uses).  If you cloned the repo
# somewhere else — e.g. ~/morphit following the manual guide —
# copying the units verbatim would point WorkingDirectory/ExecStart
# at a path that doesn't exist, and the services would fail to start.
# Rather than hand-editing each unit (or layering a `systemctl edit`
# drop-in), this script detects the real repo root from its own
# location and writes the three core units to /etc/systemd/system/
# with the correct paths substituted in.  Run it from wherever you
# cloned; it just works.
#
# Scope
# -----
# Handles the three services that run out of the monorepo checkout:
#   - morphit-indexer   (the Blurt-chain indexer + REST API)
#   - morphit-relay     (broadcasts user-signed chain ops)
#   - morphit-matrix-bot (operator alert DMs; only if you run it)
#
# It deliberately does NOT touch morphit-mcp or the weekly
# morphit-relay-mint-acts oneshot: those run from their own
# restricted directories as separate low-privilege users (a
# least-privilege isolation so they can't read the main install's
# secrets).  If you run those, install their units per
# docs/OPERATIONS.md — that isolation is intentional.
#
# Usage
# -----
#   sudo bash ops/scripts/install-systemd-units.sh
# then enable the services you actually run, e.g.:
#   sudo systemctl enable --now morphit-indexer
#   sudo systemctl enable --now morphit-relay
#
# Note: services run as a non-root user (matrix-bot) need their
# WorkingDirectory readable by that user.  Under /opt/morphit that's
# automatic; if you cloned into a home directory, make sure the path
# is traversable (a home on the root filesystem with normal perms is
# fine; an encrypted or 0700 home is not).
#
set -euo pipefail

# Repo root = two levels up from this script (ops/scripts/ -> repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

UNIT_SRC="$REPO_DIR/ops/systemd"
UNIT_DEST="/etc/systemd/system"

# The base path the shipped units hardcode.  Every occurrence is
# rewritten to $REPO_DIR.  This is the ONLY thing the installer
# changes in each unit.
DEFAULT_DIR="/opt/morphit"

# The three monorepo services (see "Scope" above).
CORE_UNITS=(
	morphit-indexer.service
	morphit-relay.service
	morphit-matrix-bot.service
)

echo "Morphit systemd unit installer"
echo "  repo:   $REPO_DIR"
echo "  target: $UNIT_DEST"
echo

if [[ ! -d "$UNIT_SRC" ]]; then
	echo "ERROR: $UNIT_SRC not found — run this from inside the Morphit repo." >&2
	exit 1
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
	echo "ERROR: must run as root (writes to $UNIT_DEST)." >&2
	echo "       Try: sudo bash $0" >&2
	exit 1
fi

installed=0
for unit in "${CORE_UNITS[@]}"; do
	src="$UNIT_SRC/$unit"
	dest="$UNIT_DEST/$unit"
	if [[ ! -f "$src" ]]; then
		echo "  skip      $unit  (not found in repo)"
		continue
	fi
	# Rewrite the hardcoded base path to this checkout.  '#' delimiter
	# so the '/' in paths needs no escaping.
	sed "s#${DEFAULT_DIR}#${REPO_DIR}#g" "$src" >"$dest"
	if [[ "$REPO_DIR" == "$DEFAULT_DIR" ]]; then
		echo "  installed $unit  (paths already $DEFAULT_DIR)"
	else
		echo "  installed $unit  ($DEFAULT_DIR -> $REPO_DIR)"
	fi
	installed=$((installed + 1))
done

if [[ "$installed" -eq 0 ]]; then
	echo "Nothing installed." >&2
	exit 1
fi

systemctl daemon-reload
echo
echo "Done ($installed unit(s) written, systemd reloaded)."
echo
echo "Enable + start the services you run:"
echo "  sudo systemctl enable --now morphit-indexer"
echo "  sudo systemctl enable --now morphit-relay"
echo "  sudo systemctl enable --now morphit-matrix-bot   # only if you run the alert bot"
echo
echo "If any of these were running manually (not under systemd), stop those"
echo "processes first so the systemd-managed ones can bind their ports."
