#!/bin/sh
# morphit-mdadm-monitor.sh — Linux software RAID health
#
# Reads /proc/mdstat for the state of each md array and emits
# structured JSON alerts when:
#   - an array is degraded (one or more devices failed/missing)
#   - an array has failed (no longer functional)
#   - an array is resyncing/rebuilding (informational)
#   - an array is at risk (degraded + no spare available)
#
# Module name: "mdadm".  Event names:
#   array_failed     — CRITICAL: array no longer functional
#   array_degraded   — CRITICAL: missing/failed devices, data at risk
#   array_resyncing  — INFO:     normal during rebuild, surfaces in digest
#   array_healthy    — (not emitted; absence of others implies healthy)
#
# No package install required — /proc/mdstat is in the kernel.
# Useful only on hosts running md raid.

set -eu

# ─── Emit helper ───────────────────────────────────────────────
iso_now() {
    date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

emit() {
    ts=$(iso_now)
    payload=${3:-'{}'}
    printf '{"ts":"%s","level":"%s","module":"mdadm","event":"%s","context":%s}\n' \
           "$ts" "$1" "$2" "$payload" \
        | systemd-cat -t morphit-mdadm-monitor -p "$1"
}

json_str() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ─── Bail if /proc/mdstat absent OR has no arrays ──────────────
[ -r /proc/mdstat ] || exit 0

# Quick check: does this host actually have any md arrays?
if ! grep -qE '^md[0-9]+' /proc/mdstat 2>/dev/null; then
    # No arrays configured — silently exit.  This is the common
    # case on hosts that don't use software RAID.
    exit 0
fi

# ─── Parse /proc/mdstat ────────────────────────────────────────
# Format example:
#   md0 : active raid1 sdb1[1] sda1[0]
#         976630464 blocks super 1.2 [2/2] [UU]
#         bitmap: 0/8 pages [0KB], 65536KB chunk
#
# Degraded: any [_] in the device-state bracket means a device
# is missing/failed.  Format is [UU] (2-device mirror, all up)
# vs [U_] (one down).
#
# We process arrays in pairs of lines: header (with devices),
# then a status line with size + [n/m] + device states.

# Convert /proc/mdstat to a per-array record.  Each array
# typically spans 2-3 lines; we collect lines until the next
# blank line OR next mdX line.

# A simpler robust approach: use awk to extract per-array state
# strings.
awk '
    /^md[0-9]+/ {
        if (name != "") {
            printf "%s|%s|%s|%s\n", name, level, devices, statestr;
        }
        name=$1
        level=$4
        devices=""
        statestr=""
        for (i=5; i<=NF; i++) devices = devices " " $i
        next
    }
    /\[.*\]/ && /blocks/ {
        # The state-bracket line:  ... [2/2] [UU]
        match($0, /\[[^]]+\]$/)
        if (RSTART > 0) statestr = substr($0, RSTART, RLENGTH)
    }
    /^[[:space:]]*$/ || /^Personalities/ || /^unused devices/ {
        if (name != "") {
            printf "%s|%s|%s|%s\n", name, level, devices, statestr;
            name=""
        }
    }
    END {
        if (name != "") {
            printf "%s|%s|%s|%s\n", name, level, devices, statestr;
        }
    }
' /proc/mdstat | while IFS='|' read -r name level devices statestr; do
    [ -z "$name" ] && continue

    # Devices string: " sdb1[1](F) sda1[0]" — (F) means failed.
    has_failed=0
    if echo "$devices" | grep -q '(F)'; then
        has_failed=1
    fi

    # Statestr like "[UU]" or "[U_]" or "[__]" (all dead).
    bracket=$(echo "$statestr" | grep -oE '\[[U_]+\]' | head -1)
    if [ -n "$bracket" ]; then
        # All-dead?
        if echo "$bracket" | grep -qE '^\[_+\]$'; then
            payload='{"array":"'$(json_str "$name")'","level":"'$(json_str "$level")'","state":"'$(json_str "$bracket")'"}'
            emit error array_failed "$payload"
            continue
        fi
        # Any underscore at all? — degraded.
        if echo "$bracket" | grep -q '_'; then
            payload='{"array":"'$(json_str "$name")'","level":"'$(json_str "$level")'","state":"'$(json_str "$bracket")'"}'
            emit error array_degraded "$payload"
            continue
        fi
    elif [ "$has_failed" = 1 ]; then
        # Couldn't parse bracket but a (F) device exists.
        payload='{"array":"'$(json_str "$name")'","level":"'$(json_str "$level")'","note":"failed_device_marker"}'
        emit error array_degraded "$payload"
        continue
    fi

    # Resyncing/rebuilding (in-progress)?
    if echo "$devices $statestr" | grep -qE 'resync|recovery|rebuild'; then
        payload='{"array":"'$(json_str "$name")'","level":"'$(json_str "$level")'"}'
        emit info array_resyncing "$payload"
    fi
done

exit 0
