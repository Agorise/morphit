#!/bin/sh
# morphit-upgrade-notify.sh (cp598) — pop a DESKTOP notification on the
# operator's screen when a newer Morphit release is available, telling them to
# run `sudo morphit-ops` and upgrade.
#
# This runs as the LOGGED-IN DESKTOP USER (a systemd --user unit), NOT as root —
# because a desktop toast has to reach the user's graphical session (its D-Bus +
# display).  A root system service can't do that.  On a headless VPS there's no
# desktop, so this simply no-ops; VPS operators still get the existing
# release-monitor alert (Matrix/log).  This is the grandma-at-home path.
#
# HOW IT DECIDES "a new release is out": it asks the local indexer, with curl
# only — no Node, no repo access, no morphit-ops in the user session:
#   GET /v1/health   -> "version": the RUNNING (deployed) version.
#   GET /v1/release  -> "version": the LATEST release anchored on the Blurt
#                        chain (the indexer learns it even while running the old
#                        build).  If latest > running, a new release is out.
# The chain is the source of truth, matching how the node learns releases.
#
# POSIX sh (dash-safe).  Non-fatal + quiet: never errors out the user session.
# Notifies ONCE per new version (a state file), so grandma isn't nagged every
# tick — the next NEW version notifies again.
set -u

BASE="${MORPHIT_LOCAL_API:-http://127.0.0.1:${MORPHIT_INDEXER_PORT:-8088}}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/morphit"
STATE_FILE="$STATE_DIR/upgrade-notified"

# notify-send (libnotify) is the desktop-toast tool.  No desktop → no tool → bail.
command -v notify-send >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0
command -v sort >/dev/null 2>&1 || exit 0

json_version() {
	# $1 = URL; echoes the top-level "version" string, or nothing.
	curl -fsS --max-time 10 "$1" 2>/dev/null \
		| grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' \
		| head -n1 \
		| sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/'
}

RUNNING="$(json_version "$BASE/v1/health")"
LATEST="$(json_version "$BASE/v1/release")"
RUNNING="${RUNNING#v}"
LATEST="${LATEST#v}"

# Couldn't read one (indexer not up yet / no release on-chain) → nothing to do.
[ -n "$RUNNING" ] && [ -n "$LATEST" ] || exit 0
# Already current → nothing.
[ "$RUNNING" = "$LATEST" ] && exit 0
# Is LATEST strictly newer than RUNNING?  Version-aware sort; if the newest of
# the two is LATEST (and they differ), a newer release is out.
NEWEST="$(printf '%s\n%s\n' "$RUNNING" "$LATEST" | sort -V 2>/dev/null | tail -n1)"
[ "$NEWEST" = "$LATEST" ] || exit 0

# Notify once per NEW version: skip if we've already toasted this exact latest.
if [ -r "$STATE_FILE" ] && [ "$(cat "$STATE_FILE" 2>/dev/null)" = "$LATEST" ]; then
	exit 0
fi

# Pop the toast.  Grandma-plain wording; the command is on its own line so she
# can read it and type it.  urgency=normal (stays up until dismissed on most
# desktops); an app name groups it tidily.  Only remember this version as
# "notified" if the toast ACTUALLY fired — so a session with no reachable
# display doesn't silently mark it done and skip the real notification later.
if notify-send \
	--app-name="Morphit" \
	--urgency=normal \
	--icon=system-software-update \
	"Morphit — update available" \
	"A new version ($LATEST) is ready.

Open a Terminal and type:
    sudo morphit-ops
then choose “Upgrade”." 2>/dev/null; then
	mkdir -p "$STATE_DIR" 2>/dev/null || true
	printf '%s\n' "$LATEST" > "$STATE_FILE" 2>/dev/null || true
fi
exit 0
