#!/bin/sh
# morphit-clock-fallback.sh — the CLOCK FALLBACK on a node that keeps clearnet
# NTP. (v1.21.15)
#
# While the system's NTP client reports the clock synchronised (timedatectl
# NTPSynchronized=yes) this does nothing and asks no one. Only when NTP cannot
# keep the clock (UDP 123 blocked, the pools unreachable) does it run the Tor
# time check, morphit-tor-timesync.sh, from the same directory: the clock is
# then set from onion time sources over Tor, only when at least three agree it
# is more than 30 s off. When timedatectl cannot say, the time check decides.
#
# A separate script (not a flag of the time check) so that a node downgraded
# to a release whose time check has no such flag still runs: this one stays,
# and it passes the time check only the options every release knows.
#
# Usage:  morphit-clock-fallback.sh [--check]
#   --check   measure and report only; never change the clock.
# The last line is the time check's own MORPHIT_TOR_TIME line, or
#   MORPHIT_TOR_TIME result=ntp-synced answered=0 agreed=0 offset=0 sources=
# Exit status: as the time check (0 consensus or NTP synced, 1 no consensus,
# 2 usage/config error). Runs as root from morphit-clock-fallback.service.
set -u

log() { printf 'morphit-clock-fallback: %s\n' "$*" >&2; }

for arg in "$@"; do
	case "$arg" in
		--check) : ;;
		*) echo "usage: morphit-clock-fallback.sh [--check]" >&2; exit 2 ;;
	esac
done

if command -v timedatectl >/dev/null 2>&1; then
	if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then
		log "NTP keeps this clock synchronised; nothing to do."
		echo "MORPHIT_TOR_TIME result=ntp-synced answered=0 agreed=0 offset=0 sources="
		exit 0
	fi
	log "NTP is not keeping this clock synchronised; checking it against onion time sources over Tor."
fi

here="$(dirname "$0")"
[ -r "$here/morphit-tor-timesync.sh" ] || { log "$here/morphit-tor-timesync.sh is missing"; exit 2; }
exec sh "$here/morphit-tor-timesync.sh" "$@"
