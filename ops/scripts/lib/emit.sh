# ops/scripts/lib/emit.sh
#
# Shared LogRecord-emit helpers for morphit-* sidecars.
#
# Every sidecar that emits structured journal lines uses these
# three helpers; before this lib they were copy-pasted into
# each ~15 lines per script.  Now: source this file, set the
# module + tag variables, call emit/json_str/iso_now.
#
# Required variables (callers MUST set both before invoking emit):
#   MORPHIT_EMIT_MODULE   The `module` field of the LogRecord.
#                         Use lowercase-kebab (e.g. "host-resource",
#                         "smartctl", "fail2ban").  Matches the
#                         classifier's matcher predicates.
#   MORPHIT_EMIT_TAG      The systemd-cat -t tag.  Conventionally
#                         the same as the systemd unit name minus
#                         the .service suffix (e.g.
#                         "morphit-host-monitor").
#
# Usage example:
#   . /opt/morphit/ops/scripts/lib/emit.sh
#   MORPHIT_EMIT_MODULE="host-resource"
#   MORPHIT_EMIT_TAG="morphit-host-monitor"
#   emit info disk_info '{"path":"/","pct":42}'
#
# All output is piped to systemd-cat for journald ingestion.  The
# matrix-bot tails journalctl-by-unit and parses the JSON shape.
#
# Schema: matches the LogRecord interface in
# apps/{indexer,relay}/src/log/index.ts and the zod schema in
# apps/matrix-bot/scripts/sidecar-envelope-smoke.ts.

# ─── iso_now ─────────────────────────────────────────────────────
# Emit an ISO-8601 UTC timestamp.  GNU date supports `+%N` for
# nanos; fall back to second-precision for non-GNU date.
iso_now() {
    date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# ─── json_str ────────────────────────────────────────────────────
# Escape a string for safe embedding in a JSON-string position.
# Handles backslashes and double-quotes (the only characters that
# can't appear bare in a JSON string literal).  Newlines and
# control chars are passed through — sidecars emitting payloads
# with newlines should pre-strip them.
json_str() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ─── emit ────────────────────────────────────────────────────────
# Emit one LogRecord line to journald via systemd-cat.
# Args:
#   $1  level: debug | info | warn | error
#   $2  event: lowercase_snake event name (must match the
#       classifier matcher predicates exactly)
#   $3  payload: a complete JSON object literal for the
#       `context` field.  Defaults to '{}' if omitted.
#
# Sidecar must have MORPHIT_EMIT_MODULE + MORPHIT_EMIT_TAG set.
emit() {
    if [ -z "${MORPHIT_EMIT_MODULE:-}" ] || [ -z "${MORPHIT_EMIT_TAG:-}" ]; then
        echo "emit: MORPHIT_EMIT_MODULE and MORPHIT_EMIT_TAG must be set" >&2
        return 1
    fi
    _emit_ts=$(iso_now)
    _emit_payload=${3:-'{}'}
    printf '{"ts":"%s","level":"%s","module":"%s","event":"%s","context":%s}\n' \
           "$_emit_ts" "$1" "$MORPHIT_EMIT_MODULE" "$2" "$_emit_payload" \
        | systemd-cat -t "$MORPHIT_EMIT_TAG" -p "$1"
}
