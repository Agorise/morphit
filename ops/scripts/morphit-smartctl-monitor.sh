#!/bin/sh
# morphit-smartctl-monitor.sh — disk SMART health check
#
# Polls smartctl on every detected non-loop block device,
# parses the health line + key pre-fail attributes, and emits
# structured JSON alerts to journalctl when problems are
# detected.  The matrix-bot picks these up via
# MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS containing
# morphit-smartctl-monitor.service.
#
# Run from a systemd timer every 6 hours (default).  SMART
# attributes change slowly; more frequent polling adds noise
# without catching anything earlier.
#
# Module name: "smartctl".  Event names:
#   smart_failed          — CRITICAL: device reports FAILED
#   self_test_failed      — CRITICAL: most recent self-test failed
#   reallocated_sectors   — WARN: non-zero reallocated_sector_count
#   pending_sectors       — WARN: non-zero current_pending_sector
#   temperature_critical  — CRITICAL: temp >= 60C
#   temperature_warn      — WARN: temp >= 50C
#
# Requires: smartmontools package installed.  Install with
#   sudo apt install -y smartmontools
# on Debian/Ubuntu.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
TEMP_CRITICAL=${MORPHIT_SMART_TEMP_CRITICAL:-60}
TEMP_WARN=${MORPHIT_SMART_TEMP_WARN:-50}

# Devices to skip (loop devices, ramdisks, etc. — smartctl will
# refuse them anyway, this just avoids the noise).
SKIP_PATTERN='^(loop|ram|sr|fd)'

# ─── Emit helper ───────────────────────────────────────────────
iso_now() {
    date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

emit() {
    # $1 = level, $2 = event, $3 = JSON payload
    ts=$(iso_now)
    payload=${3:-'{}'}
    printf '{"ts":"%s","level":"%s","module":"smartctl","event":"%s","context":%s}\n' \
           "$ts" "$1" "$2" "$payload" \
        | systemd-cat -t morphit-smartctl-monitor -p "$1"
}

json_str() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ─── Bail if smartctl not installed ────────────────────────────
if ! command -v smartctl >/dev/null 2>&1; then
    emit info smartctl_unavailable \
         '{"hint":"install smartmontools: sudo apt install -y smartmontools"}'
    exit 0
fi

# ─── Iterate detected block devices ────────────────────────────
# Use lsblk to list devices.  -d = direct devices only (no
# partitions).  -n = no headers.  -o NAME = just the names.
# Falls back to /sys/block listing if lsblk unavailable.
if command -v lsblk >/dev/null 2>&1; then
    devices=$(lsblk -d -n -o NAME 2>/dev/null \
                | grep -vE "$SKIP_PATTERN" || true)
else
    devices=$(ls /sys/block 2>/dev/null \
                | grep -vE "$SKIP_PATTERN" || true)
fi

[ -z "$devices" ] && exit 0

for dev in $devices; do
    devpath="/dev/$dev"
    [ -e "$devpath" ] || continue

    # Run smartctl with -H (health) -A (attributes) -l selftest
    # (most recent self-test).  Suppress errors — many devices
    # don't support SMART (USB drives, etc.) and that's OK.
    output=$(smartctl -H -A -l selftest "$devpath" 2>/dev/null || true)
    [ -z "$output" ] && continue

    # Skip devices that don't support SMART.
    echo "$output" | grep -qE 'SMART support is:.*Enabled|SMART overall-health' \
        || continue

    # ─── Health line ───
    # Look for "SMART overall-health self-assessment test result: FAILED"
    # or "SMART Health Status: FAILED".
    if echo "$output" | grep -qE 'SMART (overall-health|Health Status).*FAILED'; then
        payload='{"device":"'$(json_str "$devpath")'"}'
        emit error smart_failed "$payload"
        # No need to check other attributes; the device is going.
        continue
    fi

    # ─── Most recent self-test ───
    selftest_line=$(echo "$output" \
                    | grep -E '^# 1' \
                    | head -1 \
                    || true)
    if echo "$selftest_line" | grep -qiE 'failed|fail_'; then
        result=$(echo "$selftest_line" | awk '{$1=""; $2=""; print}' | sed 's/^  *//')
        payload='{"device":"'$(json_str "$devpath")'","result":"'$(json_str "$result")'"}'
        emit error self_test_failed "$payload"
    fi

    # ─── Reallocated sectors (attribute 5) ───
    realloc=$(echo "$output" \
              | awk '/Reallocated_Sector_Ct|Reallocated_Event_Count/ {print $10; exit}')
    if [ -n "$realloc" ] && [ "$realloc" -gt 0 ] 2>/dev/null; then
        payload='{"device":"'$(json_str "$devpath")'","count":'$realloc'}'
        emit warn reallocated_sectors "$payload"
    fi

    # ─── Current pending sectors (attribute 197) ───
    pending=$(echo "$output" \
              | awk '/Current_Pending_Sector/ {print $10; exit}')
    if [ -n "$pending" ] && [ "$pending" -gt 0 ] 2>/dev/null; then
        payload='{"device":"'$(json_str "$devpath")'","count":'$pending'}'
        emit warn pending_sectors "$payload"
    fi

    # ─── Temperature (attribute 194) ───
    # smartctl reports this in different columns depending on
    # device firmware.  Try the most common: column 10 (RAW_VALUE)
    # for sectorized attributes.
    temp=$(echo "$output" \
           | awk '/Temperature_Celsius|Airflow_Temperature/ {print $10; exit}' \
           | awk '{print $1}')
    if [ -n "$temp" ] && [ "$temp" -gt 0 ] 2>/dev/null; then
        payload='{"device":"'$(json_str "$devpath")'","temperature_c":'$temp',"threshold":'
        if [ "$temp" -ge "$TEMP_CRITICAL" ]; then
            emit error temperature_critical "${payload}${TEMP_CRITICAL}}"
        elif [ "$temp" -ge "$TEMP_WARN" ]; then
            emit warn temperature_warn "${payload}${TEMP_WARN}}"
        fi
    fi
done

exit 0
