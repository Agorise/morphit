#!/bin/sh
# morphit-fail2ban-monitor.sh — fail2ban observability
#
# Polls `fail2ban-client status` for each jail, emits structured
# JSON when:
#   - a jail is configured but unreachable (fail2ban daemon down)
#   - a jail's currently-banned count spikes above a threshold
#     (potential active attack)
#   - a jail's banned count crosses a high-water mark
#
# Module name: "fail2ban".  Event names:
#   daemon_unreachable        — CRITICAL: fail2ban-client error
#   jail_high_ban_count       — WARN: jail.currently_banned >= warn threshold
#   jail_critical_ban_count   — CRITICAL: jail.currently_banned >= critical threshold
#   jail_ban_rate_warn        — WARN: bans/hour rate elevated
#
# Requires: fail2ban installed + fail2ban-client in PATH.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
# These are PER-JAIL — if you have one busy jail (ssh) and one
# quiet (postfix-sasl), set the per-jail var.  Falls back to
# defaults.
BAN_CRITICAL=${MORPHIT_FAIL2BAN_BAN_CRITICAL:-50}
BAN_WARN=${MORPHIT_FAIL2BAN_BAN_WARN:-15}

STATE_DIR=${MORPHIT_FAIL2BAN_STATE_DIR:-/var/lib/morphit-fail2ban-monitor}
STATE_FILE="$STATE_DIR/last-counts"
mkdir -p "$STATE_DIR"

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="fail2ban"
MORPHIT_EMIT_TAG="morphit-fail2ban-monitor"

# ─── Bail if fail2ban-client not installed ─────────────────────
if ! command -v fail2ban-client >/dev/null 2>&1; then
    emit info fail2ban_unavailable \
         '{"hint":"install fail2ban: sudo apt install -y fail2ban"}'
    exit 0
fi

# ─── List active jails ─────────────────────────────────────────
# `fail2ban-client status` reports "Jail list: jail1, jail2, ..."
# Returns non-zero if the daemon isn't running.
status_output=$(fail2ban-client status 2>&1) || {
    _f2b_payload='{"error":"'$(json_str "$status_output")'","hint":"check sudo systemctl status fail2ban"}'
    emit error daemon_unreachable "$_f2b_payload"
    exit 0
}

jails=$(echo "$status_output" \
        | awk -F: '/Jail list/ {print $2}' \
        | tr ',' ' ')

[ -z "$jails" ] && exit 0

# ─── Iterate jails ─────────────────────────────────────────────
now_ts=$(date +%s)

# Build new state for the run.
> "$STATE_FILE.new"
echo "ts=$now_ts" >> "$STATE_FILE.new"

for jail in $jails; do
    jail=$(echo "$jail" | tr -d ' ')
    [ -z "$jail" ] && continue

    j_output=$(fail2ban-client status "$jail" 2>/dev/null || true)
    [ -z "$j_output" ] && continue

    currently_banned=$(echo "$j_output" \
                       | awk -F: '/Currently banned/ {gsub(/[ \t]/,"",$2); print $2}')
    total_banned=$(echo "$j_output" \
                   | awk -F: '/Total banned/ {gsub(/[ \t]/,"",$2); print $2}')

    [ -z "$currently_banned" ] && continue
    # AUDIT-NUMERIC: bounds-check before JSON embed.
    currently_banned=$(json_num "$currently_banned")
    total_banned=$(json_num "$total_banned")

    # Per-jail threshold override: MORPHIT_FAIL2BAN_<UPPERCASE-JAIL>_CRITICAL
    jail_upper=$(echo "$jail" | tr '[:lower:]-' '[:upper:]_')
    crit_var="MORPHIT_FAIL2BAN_${jail_upper}_CRITICAL"
    warn_var="MORPHIT_FAIL2BAN_${jail_upper}_WARN"
    eval "jail_crit=\${$crit_var:-$BAN_CRITICAL}"
    eval "jail_warn=\${$warn_var:-$BAN_WARN}"

    if [ "$currently_banned" -ge "$jail_crit" ] 2>/dev/null; then
        payload='{"jail":"'$(json_str "$jail")'","currently_banned":'$currently_banned',"threshold":'$jail_crit'}'
        emit error jail_critical_ban_count "$payload"
    elif [ "$currently_banned" -ge "$jail_warn" ] 2>/dev/null; then
        payload='{"jail":"'$(json_str "$jail")'","currently_banned":'$currently_banned',"threshold":'$jail_warn'}'
        emit warn jail_high_ban_count "$payload"
    fi

    # Persist current count for ban-rate detection next run.
    echo "${jail}_total=${total_banned:-0}" >> "$STATE_FILE.new"
done

# ─── Ban-rate detection (delta vs previous run) ────────────────
if [ -f "$STATE_FILE" ]; then
    last_ts=$(awk -F= '/^ts=/ {print $2; exit}' "$STATE_FILE")
    if [ -n "$last_ts" ] && [ "$now_ts" -gt "$last_ts" ]; then
        elapsed=$(( now_ts - last_ts ))
        # For each jail in new state, find delta vs old.
        for line in $(grep '_total=' "$STATE_FILE.new" 2>/dev/null); do
            jail_key=$(echo "$line" | cut -d= -f1 | sed 's/_total$//')
            new_total=$(echo "$line" | cut -d= -f2)
            old_total=$(awk -F= -v k="${jail_key}_total" '$1==k {print $2; exit}' "$STATE_FILE")
            [ -z "$old_total" ] && continue
            [ "$elapsed" -lt 1 ] && continue
            delta=$(( new_total - old_total ))
            [ "$delta" -lt 0 ] && delta=0
            # bans per hour (extrapolated from observed interval)
            rate=$(( delta * 3600 / elapsed ))
            if [ "$rate" -ge 100 ] 2>/dev/null; then
                payload='{"jail":"'$(json_str "$jail_key")'","bans_per_hour":'$rate',"delta":'$delta',"elapsed_sec":'$elapsed'}'
                emit warn jail_ban_rate_warn "$payload"
            fi
        done
    fi
fi

mv "$STATE_FILE.new" "$STATE_FILE"

exit 0
