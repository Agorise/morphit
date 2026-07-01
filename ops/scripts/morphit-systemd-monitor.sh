#!/bin/sh
# morphit-systemd-monitor.sh — systemd unit health
#
# Analog of morphit-compose-monitor.sh but for systemd-managed
# units rather than Docker Compose services.  Detects:
#   - Units in "failed" state (service crashed and won't auto-
#     restart, or hit StartLimitBurst).  CRITICAL because the
#     service is genuinely DOWN — and journalctl-based alerting
#     can't see this: a unit that fails to even start emits no
#     journal output for the bot to route.
#   - Units with high restart counts (NRestarts >= threshold)
#     where the unit is still running.  WARN because the
#     restart policy is masking a bug.
#
# Module name: "systemd".  Event names:
#   unit_failed                   — CRITICAL: systemd reports failed
#   unit_restart_loop             — WARN:     NRestarts >= threshold
#   unit_missing                  — WARN:     a watched unit doesn't exist
#                                   (config drift)
#   systemctl_unavailable         — INFO:     systemctl not in PATH
#
# Cadence: every 5 min via systemd timer.
#
# By default watches all morphit-*.service units it finds on
# the host.  Operators can extend via MORPHIT_SYSTEMD_WATCH=
# space-separated list.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
RESTART_THRESHOLD=${MORPHIT_SYSTEMD_RESTART_THRESHOLD:-10}
# Space-separated unit names to additionally watch.  Useful for
# operator-added services (e.g. backup, custom monitoring).
EXTRA_WATCH=${MORPHIT_SYSTEMD_WATCH:-}

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="systemd"
MORPHIT_EMIT_TAG="morphit-systemd-monitor"

# ─── Bail if systemctl missing ─────────────────────────────────
if ! command -v systemctl >/dev/null 2>&1; then
    emit info systemctl_unavailable \
         '{"hint":"systemctl not in PATH; this sidecar requires systemd"}'
    exit 0
fi

# ─── Enumerate units to watch ──────────────────────────────────
# All morphit-*.service units, plus operator-supplied extras.
# `systemctl list-unit-files --type=service --no-pager --no-legend`
# lists every service unit on the system regardless of state.
all_morphit=$(systemctl list-unit-files --type=service \
                                        --no-pager --no-legend \
                2>/dev/null \
              | awk '{print $1}' \
              | grep '^morphit-' \
              || true)

watch_units="$all_morphit $EXTRA_WATCH"

# ─── Iterate each watched unit ─────────────────────────────────
for unit in $watch_units; do
    [ -z "$unit" ] && continue

    # Check existence — `systemctl status` returns 4 for unknown unit.
    if ! systemctl status "$unit" >/dev/null 2>&1; then
        status_rc=$?
        # Distinguish "unit doesn't exist" (rc=4) from "unit failed"
        # (rc=3, which is what we want to alert on below).  rc=3 is
        # checked by is-failed.
        if [ "$status_rc" = "4" ]; then
            payload='{"unit":"'$(json_str "$unit")'"}'
            emit warn unit_missing "$payload"
            continue
        fi
    fi

    # is-failed: exit 0 if failed, non-zero otherwise.
    if systemctl is-failed --quiet "$unit" 2>/dev/null; then
        # Get the SubState (e.g. "failed", "auto-restart") for
        # the payload.
        substate=$(systemctl show -p SubState --value "$unit" 2>/dev/null || echo unknown)
        result=$(systemctl show -p Result --value "$unit" 2>/dev/null || echo unknown)
        payload='{"unit":"'$(json_str "$unit")'","sub_state":"'$(json_str "$substate")'","result":"'$(json_str "$result")'"}'
        emit error unit_failed "$payload"
        continue
    fi

    # Restart count.  `NRestarts` is a counter that resets on
    # `systemctl reset-failed` but persists across simple service
    # restarts.  Threshold reflects a real restart-loop situation.
    nrestarts=$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo 0)
    nrestarts=${nrestarts:-0}
    if [ "$nrestarts" -ge "$RESTART_THRESHOLD" ] 2>/dev/null; then
        active_state=$(systemctl show -p ActiveState --value "$unit" 2>/dev/null || echo unknown)
        payload='{"unit":"'$(json_str "$unit")'","n_restarts":'$nrestarts',"active_state":"'$(json_str "$active_state")'","threshold":'$RESTART_THRESHOLD'}'
        emit warn unit_restart_loop "$payload"
    fi
done

exit 0
