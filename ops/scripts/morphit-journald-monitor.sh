#!/bin/sh
# morphit-journald-monitor.sh — journal disk usage + rotation health
#
# journald can silently fill the disk if SystemMaxUse isn't
# configured or if the journal storage is on a filesystem that
# bypasses normal rotation (e.g. tmpfs that's persistently
# bind-mounted to disk).  Most operators don't realize their
# journal has been growing for 6 months until they hit "no space
# left on device".
#
# This sidecar reports:
#   - Journal disk usage in MB
#   - Time span the journal covers (newest minus oldest entry).
#     A multi-year journal on a 4 GB SystemMaxUse means rotation
#     ISN'T happening.
#
# Module name: "journald".  Event names:
#   journal_size_critical         — CRITICAL: journal > 4 GB
#                                   (configurable; default catches
#                                   the rotation-misconfigured case)
#   journal_size_warn             — WARN:     journal > 1 GB
#   journal_rotation_stale        — WARN:     journal covers > 90 days
#                                   AND > 500 MB
#                                   (config drift indicator)
#   journalctl_unavailable        — INFO:     journalctl not in PATH

set -eu

# ─── Thresholds (env-tunable, all in MB except days) ──────────
SIZE_CRITICAL_MB=${MORPHIT_JOURNALD_SIZE_CRITICAL_MB:-4096}
SIZE_WARN_MB=${MORPHIT_JOURNALD_SIZE_WARN_MB:-1024}
ROTATION_STALE_DAYS=${MORPHIT_JOURNALD_ROTATION_STALE_DAYS:-90}
ROTATION_STALE_MIN_MB=${MORPHIT_JOURNALD_ROTATION_STALE_MIN_MB:-500}

# ─── Emit helper ───────────────────────────────────────────────
iso_now() {
    date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

emit() {
    ts=$(iso_now)
    payload=${3:-'{}'}
    printf '{"ts":"%s","level":"%s","module":"journald","event":"%s","context":%s}\n' \
           "$ts" "$1" "$2" "$payload" \
        | systemd-cat -t morphit-journald-monitor -p "$1"
}

# ─── Bail if journalctl missing ───────────────────────────────
if ! command -v journalctl >/dev/null 2>&1; then
    emit info journalctl_unavailable \
         '{"hint":"journalctl not in PATH; this sidecar requires systemd-journald"}'
    exit 0
fi

# ─── Disk usage ────────────────────────────────────────────────
# `journalctl --disk-usage` prints a line like
# "Archived and active journals take up 2.3G in the file system."
# Parse the size.  Output format is stable.
usage_line=$(journalctl --disk-usage 2>/dev/null || echo '')
# Extract the number+unit (e.g. "2.3G", "512M", "12.0M").
size_str=$(echo "$usage_line" | grep -oE '[0-9.]+[KMGT]' | head -1)
# Convert to MB (rounded).
size_mb=0
if [ -n "$size_str" ]; then
    unit=$(echo "$size_str" | grep -oE '[KMGT]$')
    num=$(echo "$size_str" | sed 's/[KMGT]$//')
    case "$unit" in
        K) size_mb=$(echo "$num" | awk '{printf "%d", $1 / 1024}') ;;
        M) size_mb=$(echo "$num" | awk '{printf "%d", $1}') ;;
        G) size_mb=$(echo "$num" | awk '{printf "%d", $1 * 1024}') ;;
        T) size_mb=$(echo "$num" | awk '{printf "%d", $1 * 1024 * 1024}') ;;
    esac
fi
[ -z "$size_mb" ] && size_mb=0

# ─── Time span covered ─────────────────────────────────────────
# Oldest entry: journalctl --header / --output=short --reverse | tail -1 is slow.
# Instead use `journalctl -n 1 --no-pager --output=short --quiet` for newest
# and `journalctl --no-pager --output=short --quiet | head -1` for oldest.
# Both can be slow on huge journals.  Use `journalctl --boot=0` plus
# `--header` for fast metadata-only read.  But simplest reliable:
# parse "head" + "tail" timestamps.
oldest_line=$(journalctl --output=short-iso --no-pager --quiet 2>/dev/null \
              | head -1 || true)
newest_line=$(journalctl --output=short-iso --no-pager --quiet -n 1 2>/dev/null || true)

span_days=0
if [ -n "$oldest_line" ] && [ -n "$newest_line" ]; then
    oldest_iso=$(echo "$oldest_line" | awk '{print $1}')
    newest_iso=$(echo "$newest_line" | awk '{print $1}')
    oldest_epoch=$(date -d "$oldest_iso" +%s 2>/dev/null || echo 0)
    newest_epoch=$(date -d "$newest_iso" +%s 2>/dev/null || echo 0)
    if [ "$oldest_epoch" -gt 0 ] && [ "$newest_epoch" -gt 0 ]; then
        span_days=$(( (newest_epoch - oldest_epoch) / 86400 ))
        [ "$span_days" -lt 0 ] && span_days=0
    fi
fi

# ─── Tier check ────────────────────────────────────────────────
if [ "$size_mb" -ge "$SIZE_CRITICAL_MB" ] 2>/dev/null; then
    payload='{"size_mb":'$size_mb',"span_days":'$span_days',"threshold_mb":'$SIZE_CRITICAL_MB'}'
    emit error journal_size_critical "$payload"
elif [ "$size_mb" -ge "$SIZE_WARN_MB" ] 2>/dev/null; then
    payload='{"size_mb":'$size_mb',"span_days":'$span_days',"threshold_mb":'$SIZE_WARN_MB'}'
    emit warn journal_size_warn "$payload"
elif [ "$span_days" -ge "$ROTATION_STALE_DAYS" ] \
     && [ "$size_mb" -ge "$ROTATION_STALE_MIN_MB" ] 2>/dev/null; then
    # Journal covers months and isn't huge yet — but the long
    # span suggests rotation isn't happening.  Lower priority
    # but worth surfacing.
    payload='{"size_mb":'$size_mb',"span_days":'$span_days',"threshold_days":'$ROTATION_STALE_DAYS',"threshold_min_mb":'$ROTATION_STALE_MIN_MB'}'
    emit warn journal_rotation_stale "$payload"
fi

exit 0
