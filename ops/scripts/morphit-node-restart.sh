#!/bin/sh
# morphit-node-restart — after apt replaced Node.js, restart the Morphit
# services that still run the old one (v1.24.8).
#
# Run by apt after every package change (DPkg::Post-Invoke in
# /etc/apt/apt.conf.d/52morphit-automatic-updates, which morphit-ops writes).
# A running program keeps the file it started from: when an update replaces
# /usr/bin/node, the relay, the indexer and the other Morphit services go on
# running the old, unpatched Node until they restart. This finds every running
# morphit-*.service with a process whose program is a node that is no longer on
# disk (/proc/<pid>/exe ends in "/node (deleted)") and restarts that service,
# then checks it is running again. Nothing else is touched, and a service that
# is not running is left alone. It never fails apt: it always exits 0.
#
# Each restart is written to the journal (tag morphit-node-restart).
#
# Env (tests): MORPHIT_SYSTEMCTL, MORPHIT_PROC, MORPHIT_CGROUP_ROOT,
# MORPHIT_LOGGER.
SYSTEMCTL=${MORPHIT_SYSTEMCTL:-systemctl}
PROC=${MORPHIT_PROC:-/proc}
CGROOT=${MORPHIT_CGROUP_ROOT:-/sys/fs/cgroup}
LOGGER=${MORPHIT_LOGGER:-logger}

say() {
	"$LOGGER" -t morphit-node-restart -- "$1" 2>/dev/null || true
}

command -v "$SYSTEMCTL" >/dev/null 2>&1 || exit 0
units=$("$SYSTEMCTL" list-units --type=service --state=running --no-legend --plain 'morphit-*.service' 2>/dev/null | awk '{print $1}')
for u in $units; do
	case "$u" in morphit-*.service) ;; *) continue ;; esac
	cg=$("$SYSTEMCTL" show -p ControlGroup --value "$u" 2>/dev/null)
	[ -n "$cg" ] || continue
	stale=0
	for p in $(cat "$CGROOT$cg/cgroup.procs" 2>/dev/null); do
		e=$(readlink "$PROC/$p/exe" 2>/dev/null) || continue
		case "$e" in
			*/node" (deleted)")
				stale=1
				break
				;;
		esac
	done
	[ "$stale" = 1 ] || continue
	if timeout 180 "$SYSTEMCTL" restart "$u" >/dev/null 2>&1 && "$SYSTEMCTL" is-active --quiet "$u" 2>/dev/null; then
		say "$u restarted: it ran a Node.js that an update replaced; it now runs the new one"
	else
		say "$u ran a Node.js that an update replaced, but restarting it did not succeed; on this server: sudo systemctl restart $u"
	fi
done
exit 0
