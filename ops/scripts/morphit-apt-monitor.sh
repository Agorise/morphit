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

# ─── Emit helper ───────────────────────────────────────────────
iso_now() {
    date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

emit() {
    ts=$(iso_now)
    payload=${3:-'{}'}
    printf '{"ts":"%s","level":"%s","module":"apt","event":"%s","context":%s}\n' \
           "$ts" "$1" "$2" "$payload" \
        | systemd-cat -t morphit-apt-monitor -p "$1"
}

# ─── Bail if apt unavailable ───────────────────────────────────
if ! command -v apt >/dev/null 2>&1; then
    emit info apt_unavailable \
         '{"hint":"apt not in PATH; this sidecar is Debian/Ubuntu-only"}'
    exit 0
fi

# Refresh apt package lists.  `apt-get update -qq` is quiet
# enough not to log noise but requires sudo / root.  We assume
# the service runs as root (per the systemd unit).
apt-get update -qq 2>/dev/null || true

# ─── Count pending upgrades ────────────────────────────────────
# `apt list --upgradable 2>/dev/null` prints "package/source [from] [to] [arch]"
# lines; security ones are flagged in the source like
# "noble-security".  This is the canonical approach Ubuntu's own
# /etc/update-motd.d uses.
upgradable=$(apt list --upgradable 2>/dev/null \
              | grep -v '^Listing\.\.\.' \
              || true)
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
