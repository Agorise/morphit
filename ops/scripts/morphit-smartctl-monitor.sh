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

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="smartctl"
MORPHIT_EMIT_TAG="morphit-smartctl-monitor"

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

    # ─── SCT thermal log (trend analysis) ───
    # The instantaneous temperature check above can MISS a drive
    # that briefly spikes above threshold between samples.  The
    # SCT (SMART Command Transport) thermal log records the
    # drive's OWN view of temperature history — including
    # max-recorded temperature since power-on, lifetime max, and
    # an over-temperature counter the drive firmware increments
    # itself.  We surface two events the instantaneous check
    # can't:
    #   temperature_sustained_high (WARN): max recorded temp >=
    #     TEMP_WARN + 5C, meaning the drive has hit WARN+ for at
    #     least one sample even if it's cooler now.
    #   temperature_overlimit_count (WARN): drive firmware's
    #     over-temperature counter is non-zero — strong signal
    #     of past sustained thermal stress.
    #
    # smartctl -l scttempsts output (truncated example):
    #     Current Temperature:                    32 Celsius
    #     Power Cycle Max Temperature:            45 Celsius
    #     Lifetime    Max Temperature:            58 Celsius
    #     Lifetime    Min Temperature:            18 Celsius
    #     Under/Over Temperature Limit Count:   0/3
    #
    # Not every drive supports SCT thermal logging; smartctl
    # exits non-zero or prints "SCT Temperature support: No"
    # when unavailable.  We silently skip those drives.
    sct_output=$(smartctl -l scttempsts "$devpath" 2>/dev/null || true)
    if [ -n "$sct_output" ]; then
        # Lifetime Max — strongest signal because it includes
        # the drive's entire history, not just current power cycle.
        lifetime_max=$(echo "$sct_output" \
                       | awk '/Lifetime[[:space:]]+Max Temperature:/ {print $4; exit}')
        # Over-limit count — second number in "Under/Over ... : X/Y"
        overlimit=$(echo "$sct_output" \
                    | awk -F'[ /]+' '/Under\/Over Temperature Limit Count/ {print $7; exit}')

        if [ -n "$lifetime_max" ] && [ "$lifetime_max" -gt 0 ] 2>/dev/null; then
            # Sustained-high threshold: TEMP_WARN + 5C buffer to
            # avoid alerting on a brief spike that happened to be
            # captured in the lifetime max.
            sustained_threshold=$(( TEMP_WARN + 5 ))
            if [ "$lifetime_max" -ge "$sustained_threshold" ] 2>/dev/null; then
                payload='{"device":"'$(json_str "$devpath")'","lifetime_max_c":'$lifetime_max',"threshold":'$sustained_threshold'}'
                emit warn temperature_sustained_high "$payload"
            fi
        fi

        if [ -n "$overlimit" ] && [ "$overlimit" -gt 0 ] 2>/dev/null; then
            payload='{"device":"'$(json_str "$devpath")'","overlimit_count":'$overlimit'}'
            emit warn temperature_overlimit_count "$payload"
        fi
    fi
done

exit 0
