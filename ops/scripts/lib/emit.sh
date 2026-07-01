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
#   MORPHIT_EMIT_TAG      Identifier used only on the systemd-cat
#                         FALLBACK path (manual / non-service runs).
#                         Under a real systemd service the unit name is
#                         the source identifier and this value is unused,
#                         but it is still required for interface stability.
#                         Conventionally the unit name minus ".service"
#                         (e.g. "morphit-host-monitor").
#
# Usage example:
#   . /opt/morphit/ops/scripts/lib/emit.sh
#   MORPHIT_EMIT_MODULE="host-resource"
#   MORPHIT_EMIT_TAG="morphit-host-monitor"
#   emit info disk_info '{"path":"/","pct":42}'
#
# Under a systemd service (StandardOutput=journal) the LogRecord goes to
# the service's own journal stream via stdout, so journald tags entries
# with _SYSTEMD_UNIT=<unit>.service; only the manual / non-service
# fallback pipes to systemd-cat.  The matrix-bot tails journalctl-by-unit
# (matching on _SYSTEMD_UNIT) and parses the JSON shape — see emit() for
# why the stdout path is what makes the bot actually see the alert.
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
# Handles backslash + double-quote (raw-illegal in JSON strings)
# AND all C0 control characters (0x00-0x1F).
#
# AUDIT-1 (cp17 deep-deep): without control-char encoding, an
# unprivileged user can forge journal entries via the dmesg-monitor
# code path.  Linux lets userspace set a process's `comm` name to
# anything (via prctl PR_SET_NAME or `exec -a $'name\n{evil}'`);
# kernel OOM-killer messages embed `comm` verbatim into dmesg;
# dmesg-monitor passes the raw line through json_str() and pipes
# the result to systemd-cat.  systemd-cat treats each newline-
# separated stdin chunk as a SEPARATE journal entry — so an
# embedded newline lets the attacker forge a fully-formed
# LogRecord that matrix-bot will route as a legitimate alert.
# Same vector applies to any sidecar handling attacker-influenced
# inputs (FUSE mount paths, third-party-repo package names, etc.).
#
# The fix: encode every C0 control char per RFC 8259 §7.  Short-
# form escapes for the named ones (\b, \t, \n, \f, \r); \uXXXX
# for the rest of 0x00-0x1F.  Non-ASCII bytes (UTF-8 multibyte
# sequences) pass through as-is since they're valid in JSON.
json_str() {
    # `printf '%s'` to avoid `echo`'s backslash interpretation.
    # `sed -z` treats input as NUL-separated records, so newlines
    # stay in the pattern space and `s/\x0a/.../g` actually fires.
    # (Without `-z`, GNU sed reads line-by-line and never sees
    # newlines INSIDE pattern space — the original bug this smoke
    # uncovered.)
    # `LC_ALL=C` makes sed operate byte-wise so it doesn't choke
    # on invalid-UTF-8 sequences in untrusted input.  The escape
    # order matters: backslash FIRST (otherwise the other escapes'
    # backslashes get doubled), then everything else.
    #
    # Known limitation: NUL bytes in `$1` are stripped by bash's
    # C-string variable semantics before json_str() sees them.
    # Not a real exposure: every untrusted-input path the sidecars
    # read from (dmesg, compose, apt, systemd, mount paths,
    # /proc/mdstat, smartctl device paths, cert names) is a domain
    # where NUL bytes are forbidden by the source tool's grammar.
    printf '%s' "$1" \
        | LC_ALL=C sed -z '
            s/\\/\\\\/g
            s/"/\\"/g
            s/\x08/\\b/g
            s/\x09/\\t/g
            s/\x0a/\\n/g
            s/\x0c/\\f/g
            s/\x0d/\\r/g
            s/\x00/\\u0000/g
            s/\x01/\\u0001/g
            s/\x02/\\u0002/g
            s/\x03/\\u0003/g
            s/\x04/\\u0004/g
            s/\x05/\\u0005/g
            s/\x06/\\u0006/g
            s/\x07/\\u0007/g
            s/\x0b/\\u000b/g
            s/\x0e/\\u000e/g
            s/\x0f/\\u000f/g
            s/\x10/\\u0010/g
            s/\x11/\\u0011/g
            s/\x12/\\u0012/g
            s/\x13/\\u0013/g
            s/\x14/\\u0014/g
            s/\x15/\\u0015/g
            s/\x16/\\u0016/g
            s/\x17/\\u0017/g
            s/\x18/\\u0018/g
            s/\x19/\\u0019/g
            s/\x1a/\\u001a/g
            s/\x1b/\\u001b/g
            s/\x1c/\\u001c/g
            s/\x1d/\\u001d/g
            s/\x1e/\\u001e/g
            s/\x1f/\\u001f/g
        '
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
    _emit_line=$(printf '{"ts":"%s","level":"%s","module":"%s","event":"%s","context":%s}' \
                 "$_emit_ts" "$1" "$MORPHIT_EMIT_MODULE" "$2" "$_emit_payload")
    # Route to the journal so matrix-bot — which tails `journalctl -u <unit>`
    # and matches on _SYSTEMD_UNIT — actually sees the alert.
    #
    # Under a systemd service with StandardOutput=journal (every Morphit
    # sidecar), systemd sets $JOURNAL_STREAM and OWNS the stdout stream, so
    # anything printed to stdout lands in the journal tagged with
    # _SYSTEMD_UNIT=<unit>.service.  That tag is exactly what the bot filters
    # on, so this is what lets the bot receive the alert at all.
    #
    # We previously piped to `systemd-cat -t TAG -p LEVEL` unconditionally.
    # That set SYSLOG_IDENTIFIER + priority, BUT on at least some
    # systemd/journald builds the resulting entries arrive with NO
    # _SYSTEMD_UNIT (the journal stream is opened by the short-lived
    # systemd-cat process, whose cgroup journald can't reliably resolve) —
    # so the bot's `-u` filter SILENTLY dropped every shell-sidecar alert.
    # Routing through the service's own stdout stream fixes that for all
    # sidecars at once.  (The unit name now identifies the source instead of
    # SYSLOG_IDENTIFIER; the bot ignores priority and classifies by
    # module+event.  json_str() escaping below stays REQUIRED — a stdout
    # stream still splits on newlines, so the C0/newline encoding still
    # prevents forged multi-line entries.)
    #
    # Fallback: when NOT under a journal-connected service (a manual run, a
    # cron job, etc.), $JOURNAL_STREAM is unset — pipe to systemd-cat so the
    # line still reaches journald.
    if [ -n "${JOURNAL_STREAM:-}" ]; then
        printf '%s\n' "$_emit_line"
    else
        printf '%s\n' "$_emit_line" | systemd-cat -t "$MORPHIT_EMIT_TAG" -p "$1"
    fi
}

# ─── json_num ────────────────────────────────────────────────────
# Validate a value is a JSON-safe number and echo it back; echo `0`
# if not.  Permits: optional leading `-`, digits, optional decimal
# point with more digits.  Rejects: scientific notation (matrix-bot
# classifier doesn't expect it), embedded letters, control chars,
# spaces, anything that could break JSON or look like injection.
#
# AUDIT-NUMERIC (cp18 deep-deep): sidecars embed external-tool
# output in numeric JSON positions:
#   payload='{"percent":'$pct',"threshold":'$DISK_CRITICAL'}'
# If $pct comes from a hostile FUSE filesystem reporting `"95; junk"`
# in df output, the resulting JSON is malformed; matrix-bot drops it
# silently — operator never learns the disk is full.  Not RCE (the
# variable is inside a string-literal context, no shell interpret-
# ation), but a real alert-suppression DoS.  Mount-sweep (cp15)
# already validates via `case "$mount_pct_num" in *[!0-9]*) ...`;
# this helper generalizes the pattern.
#
# Usage:
#   payload='{"percent":'$(json_num "$pct")',"threshold":'$(json_num "$DISK_CRITICAL")'}'
json_num() {
    case "${1:-}" in
        ''|*[!0-9.-]*|-|.|*..*|-*-*|.*-*)
            # Empty, contains non-numeric, or pathological forms
            # like `--5`, `1..2`, `.`.
            echo 0
            ;;
        *)
            # Permit at most one leading `-` and at most one `.`.
            # case-glob above already rejected multi-dot/multi-dash;
            # safe to echo.
            echo "$1"
            ;;
    esac
}
