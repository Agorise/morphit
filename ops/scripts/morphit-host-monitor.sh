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
# Output is emitted by emit() (ops/scripts/lib/emit.sh).  Running as the
# morphit-host-monitor.service systemd unit, emit() writes the LogRecord to
# the service's own journal stream (stdout, StandardOutput=journal), so
# journald tags entries with _SYSTEMD_UNIT=morphit-host-monitor.service and
# the bot's `-u` filter picks them up.  (emit() falls back to systemd-cat
# only when run outside a journal-connected service.)

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

# ─── Emit helpers (shared lib) ─────────────────────────────────
# Resolve lib relative to this script so dev/test layout works too.
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="host-resource"
MORPHIT_EMIT_TAG="morphit-host-monitor"

# ─── Disk usage ────────────────────────────────────────────────
for path in $DISK_PATHS; do
    # df --output=pcent is GNU-specific.  POSIX awk fallback.
    pct=$(df -P "$path" 2>/dev/null \
            | awk 'NR==2 { gsub(/%/,"",$5); print $5 }')
    [ -z "$pct" ] && continue
    # AUDIT-NUMERIC: bounds-check pct before JSON embed.
    pct=$(json_num "$pct")
    payload='{"path":"'$(json_str "$path")'","percent":'$pct',"threshold":'
    if [ "$pct" -ge "$DISK_CRITICAL" ]; then
        emit error disk_critical "${payload}${DISK_CRITICAL}}"
    elif [ "$pct" -ge "$DISK_WARN" ]; then
        emit warn disk_warn "${payload}${DISK_WARN}}"
    elif [ "$pct" -ge "$DISK_INFO" ]; then
        emit info disk_info "${payload}${DISK_INFO}}"
    fi
done

# ─── All-mount sweep (bind mounts + tmpfs + extras) ────────────
# DISK_PATHS above is operator-configured and typically only covers
# the canonical mount points (/, /var, /home).  But operators can
# accidentally fill bind-mounts (Docker volumes, encrypted overlay
# mounts, persistent-but-mounted-elsewhere data dirs) or tmpfs
# instances that the operator-configured DISK_PATHS doesn't cover.
# This sweep enumerates ALL mounts via `df --output=target,pcent,fstype`
# (or POSIX fallback) and alerts on any writable filesystem crossing
# thresholds, skipping pseudo-filesystems (proc, sysfs, etc.).
#
# Emits distinct event names (`mount_critical`/`warn`/`info`) so
# operators can distinguish "the standard volumes are filling" from
# "some bind-mount I forgot about is filling."
#
# Opt-out via MORPHIT_HOST_SCAN_MOUNTS=0.

if [ "${MORPHIT_HOST_SCAN_MOUNTS:-1}" = "1" ]; then
    # GNU df supports `--output=target,pcent,fstype`.  POSIX df
    # doesn't, so fall back to parsing the standard 6-column output
    # plus reading /proc/mounts for fstype if needed.  We use the
    # GNU form when available because operator monitoring on
    # Ubuntu/Debian (Morphit's canonical target) ships GNU df.
    mount_listing=$(df --output=target,pcent,fstype 2>/dev/null || true)
    if [ -n "$mount_listing" ]; then
        # Skip the header line, iterate target / pcent / fstype.
        echo "$mount_listing" | tail -n +2 | while read -r mount_target mount_pct mount_fstype; do
            # Skip pseudo-filesystems.  This list matches what
            # `df` typically excludes implicitly when given -x, but
            # we're explicit so the operator can audit the rule.
            case "$mount_fstype" in
                proc|sysfs|cgroup|cgroup2|devtmpfs|devpts|mqueue|fusectl|\
configfs|securityfs|pstore|bpf|tracefs|debugfs|hugetlbfs|nsfs|\
binfmt_misc|fuse.gvfsd-fuse|fuse.portal|squashfs|ramfs|autofs|\
overlay|overlay2|fuse.fuse-overlayfs|aufs|rpc_pipefs|nfsd|\
fuse.rclone|fuse.s3fs|fuse.sshfs)
                    continue
                    ;;
            esac
            # Skip if mount target is already in DISK_PATHS — that's
            # already covered above with the disk_* events.
            already_covered=0
            for p in $DISK_PATHS; do
                if [ "$mount_target" = "$p" ]; then
                    already_covered=1
                    break
                fi
            done
            [ "$already_covered" = "1" ] && continue

            # Strip the trailing % and validate numeric.
            mount_pct_num=$(echo "$mount_pct" | tr -d '%')
            case "$mount_pct_num" in
                ''|*[!0-9]*) continue ;;
            esac

            payload='{"path":"'$(json_str "$mount_target")'","fstype":"'$(json_str "$mount_fstype")'","percent":'$mount_pct_num',"threshold":'
            if [ "$mount_pct_num" -ge "$DISK_CRITICAL" ]; then
                emit error mount_critical "${payload}${DISK_CRITICAL}}"
            elif [ "$mount_pct_num" -ge "$DISK_WARN" ]; then
                emit warn mount_warn "${payload}${DISK_WARN}}"
            elif [ "$mount_pct_num" -ge "$DISK_INFO" ]; then
                emit info mount_info "${payload}${DISK_INFO}}"
            fi
        done
    fi
fi

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
