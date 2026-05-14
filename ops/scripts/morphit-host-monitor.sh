#!/bin/sh
# morphit-host-monitor.sh — periodic host-resource check
#
# Polls /proc/meminfo + df + /proc/loadavg + /proc/vmstat, emits
# structured JSON alerts to journalctl when thresholds are
# crossed.  The matrix-bot tails this unit and tier-routes the
# alerts (cp9 + cp10) to the operator's MXID.
#
# Run from a systemd timer every 5 minutes (default — see the
# accompanying .timer file).
#
# Module name: "host-resource".  Event names (all lowercase
# with underscores):
#   disk_critical / disk_warn / disk_info
#   mem_critical / mem_warn / mem_info
#   swap_critical / swap_warn / swap_info
#   swap_thrashing_critical / swap_thrashing_warn
#   cpu_saturated_critical / cpu_saturated_warn / cpu_saturated_info
#
# Payload shape matches what the classifier's ALERT_COPY templates
# expect — DO NOT rename fields without updating both ends.
#
# Output goes through `systemd-cat -t morphit-host-monitor`
# which is run as the morphit-host-monitor.service systemd unit
# (set in the accompanying unit file), so journalctl entries
# carry _SYSTEMD_UNIT=morphit-host-monitor.service and the bot's
# unit filter picks them up.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
# Three tiers per resource.  Defaults tuned for a reasonable
# operator-facing signal-to-noise ratio — adjust to your VPS class.

DISK_CRITICAL=${MORPHIT_HOST_DISK_CRITICAL:-95}
DISK_WARN=${MORPHIT_HOST_DISK_WARN:-85}
DISK_INFO=${MORPHIT_HOST_DISK_INFO:-70}

MEM_CRITICAL=${MORPHIT_HOST_MEM_CRITICAL:-95}
MEM_WARN=${MORPHIT_HOST_MEM_WARN:-85}
MEM_INFO=${MORPHIT_HOST_MEM_INFO:-70}

SWAP_CRITICAL=${MORPHIT_HOST_SWAP_CRITICAL:-75}
SWAP_WARN=${MORPHIT_HOST_SWAP_WARN:-50}
SWAP_INFO=${MORPHIT_HOST_SWAP_INFO:-25}

# Swap thrashing — pages in+out per second (delta across runs).
SWAP_THRASH_CRITICAL=${MORPHIT_HOST_SWAP_THRASH_CRITICAL:-1000}
SWAP_THRASH_WARN=${MORPHIT_HOST_SWAP_THRASH_WARN:-100}

# CPU load — ratio of loadavg(1m) to physical cores.  >1.0 means
# more runnable processes than cores.
CPU_CRITICAL=${MORPHIT_HOST_CPU_CRITICAL:-5.0}
CPU_WARN=${MORPHIT_HOST_CPU_WARN:-3.0}
CPU_INFO=${MORPHIT_HOST_CPU_INFO:-1.5}

# Disk paths to check (space-separated).  Default: just root.
# Operators with separate /var or /home should add them.
DISK_PATHS=${MORPHIT_HOST_DISK_PATHS:-/}

# Where to stash the last vmstat reading for swap-thrashing rate.
# /var/lib/morphit-host-monitor must exist and be writable by the
# service user (the systemd unit sets ReadWritePaths= for this).
STATE_DIR=${MORPHIT_HOST_STATE_DIR:-/var/lib/morphit-host-monitor}
STATE_FILE="$STATE_DIR/last-vmstat"
mkdir -p "$STATE_DIR"

# ─── Emit helper ───────────────────────────────────────────────
# Writes a JSON line in the LogRecord envelope the matrix-bot
# expects: { ts, level, module, event, context: {...payload} }.
# `level` is "error" for CRITICAL, "warn" for WARN, "info" for
# INFO — matches the indexer/relay logger convention.

iso_now() {
    # POSIX-portable: use date -u with strftime + microseconds
    # via /proc/uptime fallback.  GNU date supports +%N for nanos;
    # fall back to milliseconds if not.
    date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

emit() {
    # $1 = level (error|warn|info)
    # $2 = event name (e.g. "disk_critical")
    # $3 = JSON-encoded payload object (e.g. '{"path":"/","percent":96}')
    ts=$(iso_now)
    payload=${3:-'{}'}
    printf '{"ts":"%s","level":"%s","module":"host-resource","event":"%s","context":%s}\n' \
           "$ts" "$1" "$2" "$payload" \
        | systemd-cat -t morphit-host-monitor -p "$1"
}

# JSON-quote a string value (escapes backslashes + double quotes).
json_str() {
    # shellcheck disable=SC2039
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ─── Disk usage ────────────────────────────────────────────────
for path in $DISK_PATHS; do
    # df --output=pcent is GNU-specific.  POSIX awk fallback.
    pct=$(df -P "$path" 2>/dev/null \
            | awk 'NR==2 { gsub(/%/,"",$5); print $5 }')
    [ -z "$pct" ] && continue
    payload='{"path":"'$(json_str "$path")'","percent":'$pct',"threshold":'
    if [ "$pct" -ge "$DISK_CRITICAL" ]; then
        emit error disk_critical "${payload}${DISK_CRITICAL}}"
    elif [ "$pct" -ge "$DISK_WARN" ]; then
        emit warn disk_warn "${payload}${DISK_WARN}}"
    elif [ "$pct" -ge "$DISK_INFO" ]; then
        emit info disk_info "${payload}${DISK_INFO}}"
    fi
done

# ─── Memory ────────────────────────────────────────────────────
mem_total=$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo)
mem_available=$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo)
if [ -n "$mem_total" ] && [ "$mem_total" -gt 0 ] && [ -n "$mem_available" ]; then
    mem_used_pct=$(( 100 * (mem_total - mem_available) / mem_total ))
    payload='{"percent":'$mem_used_pct',"threshold":'
    if [ "$mem_used_pct" -ge "$MEM_CRITICAL" ]; then
        emit error mem_critical "${payload}${MEM_CRITICAL}}"
    elif [ "$mem_used_pct" -ge "$MEM_WARN" ]; then
        emit warn mem_warn "${payload}${MEM_WARN}}"
    elif [ "$mem_used_pct" -ge "$MEM_INFO" ]; then
        emit info mem_info "${payload}${MEM_INFO}}"
    fi
fi

# ─── Swap ──────────────────────────────────────────────────────
swap_total=$(awk '/^SwapTotal:/ {print $2; exit}' /proc/meminfo)
if [ -n "$swap_total" ] && [ "$swap_total" -gt 0 ]; then
    swap_free=$(awk '/^SwapFree:/ {print $2; exit}' /proc/meminfo)
    swap_used_pct=$(( 100 * (swap_total - swap_free) / swap_total ))
    payload='{"percent":'$swap_used_pct',"threshold":'
    if [ "$swap_used_pct" -ge "$SWAP_CRITICAL" ]; then
        emit error swap_critical "${payload}${SWAP_CRITICAL}}"
    elif [ "$swap_used_pct" -ge "$SWAP_WARN" ]; then
        emit warn swap_warn "${payload}${SWAP_WARN}}"
    elif [ "$swap_used_pct" -ge "$SWAP_INFO" ]; then
        emit info swap_info "${payload}${SWAP_INFO}}"
    fi
fi

# ─── Swap thrashing (delta across runs) ────────────────────────
# Read pswpin/pswpout from /proc/vmstat, compare against last run.
now_secs=$(date +%s)
pswpin=$(awk '/^pswpin/ {print $2; exit}' /proc/vmstat)
pswpout=$(awk '/^pswpout/ {print $2; exit}' /proc/vmstat)

if [ -n "$pswpin" ] && [ -n "$pswpout" ] && [ -f "$STATE_FILE" ]; then
    last_ts=$(awk 'NR==1' "$STATE_FILE")
    last_in=$(awk 'NR==2' "$STATE_FILE")
    last_out=$(awk 'NR==3' "$STATE_FILE")
    if [ -n "$last_ts" ] && [ "$now_secs" -gt "$last_ts" ]; then
        elapsed=$(( now_secs - last_ts ))
        in_delta=$(( pswpin - last_in ))
        out_delta=$(( pswpout - last_out ))
        # Negative deltas can happen on counter reset (reboot) —
        # treat as zero.
        [ "$in_delta" -lt 0 ] && in_delta=0
        [ "$out_delta" -lt 0 ] && out_delta=0
        in_rate=$(( in_delta / elapsed ))
        out_rate=$(( out_delta / elapsed ))
        total_rate=$(( in_rate + out_rate ))
        payload='{"pages_per_sec":'$total_rate',"pages_in":'$in_rate',"pages_out":'$out_rate'}'
        if [ "$total_rate" -ge "$SWAP_THRASH_CRITICAL" ]; then
            emit error swap_thrashing_critical "$payload"
        elif [ "$total_rate" -ge "$SWAP_THRASH_WARN" ]; then
            emit warn swap_thrashing_warn "$payload"
        fi
    fi
fi
# Persist current reading for next run.
{
    printf '%s\n' "$now_secs"
    printf '%s\n' "${pswpin:-0}"
    printf '%s\n' "${pswpout:-0}"
} > "$STATE_FILE"

# ─── CPU saturation (loadavg / cores) ──────────────────────────
cores=$(nproc 2>/dev/null || echo 1)
load1=$(awk '{print $1; exit}' /proc/loadavg)
if [ -n "$load1" ] && [ -n "$cores" ] && [ "$cores" -gt 0 ]; then
    # POSIX shell doesn't do floats — use awk for comparison + ratio.
    ratio=$(awk -v l="$load1" -v c="$cores" 'BEGIN { printf "%.2f", l / c }')

    crit_breach=$(awk -v r="$ratio" -v t="$CPU_CRITICAL" 'BEGIN { print (r+0 >= t+0) ? 1 : 0 }')
    warn_breach=$(awk -v r="$ratio" -v t="$CPU_WARN" 'BEGIN { print (r+0 >= t+0) ? 1 : 0 }')
    info_breach=$(awk -v r="$ratio" -v t="$CPU_INFO" 'BEGIN { print (r+0 >= t+0) ? 1 : 0 }')

    payload='{"load1":'$load1',"cores":'$cores',"ratio":'$ratio',"threshold":'
    if [ "$crit_breach" = "1" ]; then
        emit error cpu_saturated_critical "${payload}${CPU_CRITICAL}}"
    elif [ "$warn_breach" = "1" ]; then
        emit warn cpu_saturated_warn "${payload}${CPU_WARN}}"
    elif [ "$info_breach" = "1" ]; then
        emit info cpu_saturated_info "${payload}${CPU_INFO}}"
    fi
fi

exit 0
