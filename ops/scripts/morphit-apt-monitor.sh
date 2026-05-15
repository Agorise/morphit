#!/bin/sh
# morphit-apt-monitor.sh — system update count + security
# update count, surfaced as alerts so operators can't just
# ignore the "5 updates available" motd line forever.
#
# Module name: "apt".  Event names:
#   security_updates_critical    — CRITICAL: pending security updates count >= threshold
#   security_updates_warn        — WARN:     security updates pending
#   updates_pending_info         — INFO:     non-security updates pending
#   apt_unavailable              — INFO:     apt not installed
#
# Cadence: daily via systemd timer.  Cadence higher than that
# is wasteful because the apt-package-lists update mechanism on
# Ubuntu/Debian itself runs roughly daily.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
SECURITY_CRITICAL=${MORPHIT_APT_SECURITY_CRITICAL:-10}
SECURITY_WARN=${MORPHIT_APT_SECURITY_WARN:-1}

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="apt"
MORPHIT_EMIT_TAG="morphit-apt-monitor"

# ─── Bail if apt unavailable ───────────────────────────────────
if ! command -v apt >/dev/null 2>&1; then
    emit info apt_unavailable \
         '{"hint":"apt not in PATH; this sidecar is Debian/Ubuntu-only"}'
    exit 0
fi

# Refresh apt package lists.  `apt-get update -qq` is quiet
# enough not to log noise but requires sudo / root.  We assume
# the service runs as root (per the systemd unit).
#
# WRAPPED IN `timeout 20`: a slow apt mirror (canonical mirrors
# under load, broken IPv6 routes, captive portals) can stall
# `apt-get update` for tens of seconds.  Without a cap, this
# sidecar can blow past the envelope-smoke's spawnSync budget
# and produce an intermittent flake (Part 121 cp21 disclosure;
# fixed in cp22).  Continue even on timeout so a stale package
# list still produces usable upgrade counts.
#
# OBSERVABILITY (Part 122 cp1, AV14 finding): without this,
# repeated apt-update failures would silently degrade the
# operator's update visibility — stale package lists would
# produce stale "upgrades pending" counts with no signal that
# the refresh stopped working.  We now emit an INFO event
# `apt_refresh_failed` on non-zero exit (124 = timeout fired;
# other codes = mirror unreachable, dpkg lock held, etc.) so
# the daily digest surfaces persistently-stalled refreshes.
# INFO tier means single failures don't page; multi-day
# patterns accumulate in the digest where they're actionable.
set +e
timeout 20 apt-get update -qq 2>/dev/null
apt_update_rc=$?
set -e
if [ "$apt_update_rc" -ne 0 ]; then
    payload='{"exit_code":'$apt_update_rc',"hint":"apt-get update failed; package list may be stale (124=timeout, 100=dpkg lock, other=mirror error)"}'
    emit info apt_refresh_failed "$payload"
fi

# ─── Count pending upgrades ────────────────────────────────────
# `apt list --upgradable 2>/dev/null` prints "package/source [from] [to] [arch]"
# lines; security ones are flagged in the source like
# "noble-security".  This is the canonical approach Ubuntu's own
# /etc/update-motd.d uses.
#
# Also wrapped in `timeout 10` because `apt list` can occasionally
# stall when /var/lib/apt/lists/ is locked by an unattended-upgrade
# run.  10s is generous for a local file scan.  Same observability
# pattern as above: emit `apt_list_failed` INFO on non-zero so
# operators see when the count itself is unreliable.
set +e
upgradable=$(timeout 10 apt list --upgradable 2>/dev/null | grep -v '^Listing\.\.\.')
apt_list_rc=$?
set -e
if [ "$apt_list_rc" -ne 0 ] && [ "$apt_list_rc" -ne 1 ]; then
    # rc=1 from grep means "no matching lines" which is fine
    # (legitimate zero-upgrades state).  rc=124 = timeout; other
    # non-zero = apt itself failed.
    payload='{"exit_code":'$apt_list_rc',"hint":"apt list --upgradable failed; count may be unreliable"}'
    emit info apt_list_failed "$payload"
    upgradable=""
fi
total_count=$(echo "$upgradable" | grep -c . || true)
total_count=${total_count:-0}

if [ "$total_count" -eq 0 ]; then
    # Nothing to update.  Don't emit (cleaner; informational
    # zero-state isn't useful to operators).
    exit 0
fi

# Security updates: lines containing "-security" or "esm" in
# the source ref.
security_count=$(echo "$upgradable" | grep -cE -- '-security|/[a-z]+\-security|esm' || true)
security_count=${security_count:-0}

if [ "$security_count" -ge "$SECURITY_CRITICAL" ] 2>/dev/null; then
    payload='{"security_updates":'$security_count',"total_updates":'$total_count',"threshold":'$SECURITY_CRITICAL'}'
    emit error security_updates_critical "$payload"
elif [ "$security_count" -ge "$SECURITY_WARN" ] 2>/dev/null; then
    payload='{"security_updates":'$security_count',"total_updates":'$total_count',"threshold":'$SECURITY_WARN'}'
    emit warn security_updates_warn "$payload"
else
    # Non-security updates only — INFO, surfaces in digest.
    payload='{"security_updates":0,"total_updates":'$total_count'}'
    emit info updates_pending_info "$payload"
fi

exit 0
