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
#   automatic_updates_stalled    — WARN:     (v1.24.7) security updates wait
#                                  although this server installs them by
#                                  itself, and no automatic run succeeded for
#                                  MORPHIT_APT_STALL_DAYS (2) days
#   restart_pending              — INFO:     (v1.24.7) a restart has been needed
#                                  for MORPHIT_APT_RESTART_DAYS (2) days or more
#
# v1.24.7: a server that installs its security fixes by itself
# (unattended-upgrades on, as `morphit-ops upgrade` sets it from
# /etc/morphit/updates.env) is not reported for every fix waiting for its
# nightly run — only when that run stops working. With automatic updates off,
# pending security updates are reported as before (security_updates_*).
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
# and produce an intermittent flake (disclosure;
# fixed).  Continue even on timeout so a stale package
# list still produces usable upgrade counts.
#
# OBSERVABILITY: without this,
# repeated apt-update failures would silently degrade the
# operator's update visibility — stale package lists would
# produce stale "upgrades pending" counts with no signal that
# the refresh stopped working.  We now emit an INFO event
# `apt_refresh_failed` on non-zero exit (124 = timeout fired;
# other codes = mirror unreachable, dpkg lock held, etc.) so
# the daily digest surfaces persistently-stalled refreshes.
# INFO tier means single failures don't page; multi-day
# patterns accumulate in the digest where they're actionable.
# ─── v1.24.7: a restart needed for days ─────────────────────────
# Before anything can exit early: it holds whatever the update count says.
RESTART_DAYS=${MORPHIT_APT_RESTART_DAYS:-2}
REBOOT_FLAG=${MORPHIT_APT_REBOOT_FLAG:-/var/run/reboot-required}
if [ -f "$REBOOT_FLAG" ]; then
    flag_age=$(( ( $(date +%s) - $(stat -c %Y "$REBOOT_FLAG" 2>/dev/null || date +%s) ) / 86400 ))
    if [ "$flag_age" -ge "$RESTART_DAYS" ] 2>/dev/null; then
        pkgs=$(tr '\n' ' ' < "${REBOOT_FLAG}.pkgs" 2>/dev/null | cut -c1-160 | sed 's/ *$//')
        payload="{\"days\":$flag_age,\"packages\":\"$(json_str "$pkgs")\",\"hint\":\"This server has needed a restart for $flag_age day(s) to use the fixes it installed. It restarts by itself at night when MORPHIT_AUTO_RESTART is on in /etc/morphit/updates.env, unless someone is logged in when the day's updates finish. To restart now, on this server: sudo reboot\"}"
        emit info restart_pending "$payload"
    fi
fi

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

# v1.24.7: when this server installs its security fixes by itself, they are
# reported only when its automatic runs have stopped succeeding.
STALL_DAYS=${MORPHIT_APT_STALL_DAYS:-2}
UU_LOG=${MORPHIT_APT_UU_LOG:-/var/log/unattended-upgrades/unattended-upgrades.log}
auto_on=$(apt-config dump 2>/dev/null | sed -n 's/^APT::Periodic::Unattended-Upgrade "\(.*\)";$/\1/p' | tail -n 1)
UU_CMD=${MORPHIT_APT_UU_CMD:-unattended-upgrade}
if [ "$security_count" -gt 0 ] && [ "$auto_on" = "1" ] && command -v "$UU_CMD" >/dev/null 2>&1; then
    last=$(grep -E 'INFO (All upgrades installed|No packages found that can be upgraded unattended)' "$UU_LOG" 2>/dev/null \
           | tail -n 1 | cut -c1-19)
    last_epoch=$(date -d "$last" +%s 2>/dev/null || echo 0)
    [ -n "$last" ] || last_epoch=0
    since=$(( ( $(date +%s) - last_epoch ) / 86400 ))
    if [ "$last_epoch" -gt 0 ] && [ "$since" -lt "$STALL_DAYS" ]; then
        # Handled: the next automatic run installs them (Ubuntu also phases
        # some updates in over a few days). The digest says so, nothing more.
        payload='{"security_updates":'$security_count',"total_updates":'$total_count'}'
        emit info updates_pending_info "$payload"
        exit 0
    fi
    [ "$last_epoch" -gt 0 ] && when="$since day(s) ago" || when="never (no successful run in its log)"
    payload="{\"security_updates\":$security_count,\"total_updates\":$total_count,\"last_success\":\"$(json_str "$when")\",\"hint\":\"This server installs its security fixes by itself, but its last successful automatic run was $(json_str "$when"). To see why, on this server: sudo unattended-upgrade -v --dry-run ; sudo tail -n 30 $(json_str "$UU_LOG")\"}"
    emit warn automatic_updates_stalled "$payload"
    exit 0
fi

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
