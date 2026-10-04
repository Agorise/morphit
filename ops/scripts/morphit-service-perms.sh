#!/usr/bin/env bash
#
# morphit-service-perms.sh — run by systemd as root just before the indexer or
# the relay starts (ExecStartPre=+…), so the unprivileged service can read
# exactly the files it needs and nothing else:
#
#   indexer:  the env files it sources              → root:morphit 0640
#   relay:    the env files it sources              → root:morphit 0640
#             its keystore (MORPHIT_RELAY_ACTIVE_KEY_FILE) → root:morphit-relay 0640
#
# Why at every start: a tool that rewrites one of these files atomically (a
# temp file renamed over it) leaves it root:root 0600, and the service would
# then refuse to start ("cannot read …", exit 78).
#
# It only ever touches a REGULAR file (never a link) that root owns, inside a
# directory that root owns and nobody else can write — so no other user can
# point it at a different file, and it never makes anything writable.  It never
# sources or runs anything it reads.  It always exits 0: the service itself
# says clearly if a file is still unreadable.
#
# Usage: morphit-service-perms.sh indexer|relay
# Installed to /usr/local/lib/morphit/ (root-owned) by the Ansible role and by
# `morphit-ops upgrade`.
set -u

ROOT_DIR="${MORPHIT_PERMS_ROOT:-}" # tests only: prefix for every path
GROUP_ENV="${MORPHIT_PERMS_GROUP:-morphit}"
GROUP_KEY="${MORPHIT_PERMS_KEY_GROUP:-morphit-relay}"

log() { printf 'morphit-service-perms: %s\n' "$*" >&2; }

# The same lists the units source (ops/systemd/morphit-{indexer,relay}.service).
case "${1:-}" in
	indexer)
		FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
		;;
	relay)
		FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/relay.env /etc/morphit/relay-vapid.env)
		;;
	*)
		log "usage: $0 indexer|relay"
		exit 0
		;;
esac

# Safe to change: a regular file (not a link), owned by root, whose directory
# is owned by root and not writable by group or others.
safe_target() {
	local f="$1" d mode
	[ -f "$f" ] && [ ! -L "$f" ] || return 1
	[ "$(stat -c %u -- "$f")" = 0 ] || return 1
	d="$(dirname -- "$f")"
	[ ! -L "$d" ] || return 1
	[ "$(stat -c %u -- "$d")" = 0 ] || return 1
	mode="$(stat -c %a -- "$d")"
	[ $((8#$mode & 8#022)) -eq 0 ] || return 1
	return 0
}

# Give `f` group `grp` and mode 0640 when it is not already exactly that.
own_for() {
	local f="$1" grp="$2" cur
	if ! safe_target "$f"; then
		log "left $f as it is (not a root-owned file in a root-only directory)"
		return 0
	fi
	cur="$(stat -c '%G %a' -- "$f")"
	[ "$cur" = "$grp 640" ] && return 0
	if chgrp --no-dereference -- "$grp" "$f" 2>/dev/null && chmod 0640 -- "$f" 2>/dev/null; then
		log "$f: $cur -> $grp 640"
	else
		log "could not set $f to $grp 640 (is there a group $grp?)"
	fi
}

for f in "${FILES[@]}"; do
	[ -e "$ROOT_DIR$f" ] || continue
	own_for "$ROOT_DIR$f" "$GROUP_ENV"
done

if [ "$1" = relay ]; then
	# The keystore path, read as text (never sourced): the last assignment wins,
	# as when the relay's start-up sources these files.
	key=""
	for f in "${FILES[@]}"; do
		[ -f "$ROOT_DIR$f" ] || continue
		v="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}MORPHIT_RELAY_ACTIVE_KEY_FILE=//p' -- "$ROOT_DIR$f" | tail -n 1)"
		v="${v%\"}"
		v="${v#\"}"
		v="${v%\'}"
		v="${v#\'}"
		[ -n "$v" ] && key="$v"
	done
	case "$key" in
		/*) own_for "$ROOT_DIR$key" "$GROUP_KEY" ;;
		'') ;;
		*) log "MORPHIT_RELAY_ACTIVE_KEY_FILE is not an absolute path; left it as it is" ;;
	esac
fi
exit 0
