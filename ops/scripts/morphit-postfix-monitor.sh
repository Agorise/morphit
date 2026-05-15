#!/bin/sh
# morphit-postfix-monitor.sh — postfix mail queue depth + age
#
# Morphit operators commonly run postfix as a smarthost for
# outbound alert emails (per OPERATIONS.md §37.14 alerting role).
# If alerting silently fails — credentials rotated, smarthost
# unreachable, TLS bumped — emails pile up in the postfix queue
# and the operator hears nothing.  This sidecar reports queue
# depth + age so the absence of alerting becomes its own alert.
#
# Module name: "postfix".  Event names:
#   queue_critical            — CRITICAL: queue depth >= threshold
#                                 OR oldest message > max-age
#   queue_warn                — WARN:     queue depth/age above warn thresholds
#   queue_clean               — INFO:     queue empty or small
#   postfix_unavailable       — INFO:     postqueue not installed
#
# Cadence: every 15 min via systemd timer.  Queues built up
# due to credential rot don't drain on their own; you don't
# need tighter cadence than this.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
QUEUE_CRITICAL=${MORPHIT_POSTFIX_QUEUE_CRITICAL:-100}
QUEUE_WARN=${MORPHIT_POSTFIX_QUEUE_WARN:-25}
# Oldest-message-age in minutes.  Anything stuck >2h means the
# smarthost has been unreachable for that long.
AGE_CRITICAL=${MORPHIT_POSTFIX_AGE_CRITICAL_MIN:-120}
AGE_WARN=${MORPHIT_POSTFIX_AGE_WARN_MIN:-30}

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="postfix"
MORPHIT_EMIT_TAG="morphit-postfix-monitor"

# ─── Bail if postqueue missing ─────────────────────────────────
if ! command -v postqueue >/dev/null 2>&1; then
    emit info postfix_unavailable \
         '{"hint":"install postfix: sudo apt install -y postfix"}'
    exit 0
fi

# ─── Get queue depth ───────────────────────────────────────────
# `postqueue -p` prints the queue.  Empty queue prints just
# "Mail queue is empty".  Otherwise the last line is
# "-- 12 Kbytes in 5 Requests."
queue_output=$(postqueue -p 2>/dev/null || echo '')

if echo "$queue_output" | grep -q "Mail queue is empty"; then
    payload='{"queue_depth":0,"oldest_age_min":0}'
    emit info queue_clean "$payload"
    exit 0
fi

# Extract the request count from the last line.
queue_depth=$(echo "$queue_output" \
              | grep -E '^-- .* in [0-9]+ Request' \
              | sed -nE 's/.*in ([0-9]+) Request.*/\1/p')
queue_depth=${queue_depth:-0}

# ─── Oldest message age ────────────────────────────────────────
# Queue entries look like:
#   <queueid> <size> <date>  <sender>
#   eg: "3B8F8C0123A     1432 Mon Jan  6 04:31:00  <user@example.com>"
# We need the oldest queued-time.  Get the date column (cols 3-7
# "Mon Jan  6 04:31:00"), convert each via `date -d` to epoch,
# pick minimum, compare to now.
now_epoch=$(date +%s)
oldest_epoch=$now_epoch
while IFS= read -r line; do
    # Match lines starting with a queue ID (10 chars hex/alphanum
    # followed by whitespace).
    case "$line" in
        [0-9A-Fa-f]*\ *)
            # Extract "Mon Jan  6 04:31:00" — cols 3-7.
            date_str=$(echo "$line" | awk '{print $3, $4, $5, $6}')
            line_epoch=$(date -d "$date_str" +%s 2>/dev/null || echo "$now_epoch")
            if [ "$line_epoch" -lt "$oldest_epoch" ] 2>/dev/null; then
                oldest_epoch=$line_epoch
            fi
            ;;
    esac
done <<EOF
$queue_output
EOF

oldest_age_min=$(( (now_epoch - oldest_epoch) / 60 ))
[ "$oldest_age_min" -lt 0 ] && oldest_age_min=0

# ─── Tier check ────────────────────────────────────────────────
# CRITICAL if either threshold breached.
if [ "$queue_depth" -ge "$QUEUE_CRITICAL" ] || \
   [ "$oldest_age_min" -ge "$AGE_CRITICAL" ]; then
    payload='{"queue_depth":'$queue_depth',"oldest_age_min":'$oldest_age_min',"queue_threshold":'$QUEUE_CRITICAL',"age_threshold_min":'$AGE_CRITICAL'}'
    emit error queue_critical "$payload"
elif [ "$queue_depth" -ge "$QUEUE_WARN" ] || \
     [ "$oldest_age_min" -ge "$AGE_WARN" ]; then
    payload='{"queue_depth":'$queue_depth',"oldest_age_min":'$oldest_age_min',"queue_threshold":'$QUEUE_WARN',"age_threshold_min":'$AGE_WARN'}'
    emit warn queue_warn "$payload"
else
    payload='{"queue_depth":'$queue_depth',"oldest_age_min":'$oldest_age_min'}'
    emit info queue_clean "$payload"
fi

exit 0
