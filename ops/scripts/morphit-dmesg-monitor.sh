#!/bin/sh
# morphit-dmesg-monitor.sh — kernel-log observability
#
# Scans the kernel ring buffer (`dmesg` with `-T` for human-
# readable timestamps and `-x` for facility/priority) for
# events that operators absolutely need to know about:
#
#   - OOM-killer activations (the kernel killed a process to
#     free memory — your service might be the next victim)
#   - Kernel oopses / panics
#   - Hardware errors (MCEs, EDAC, ATA bus errors)
#   - Segmentation faults in morphit services
#   - Out-of-file-descriptor / out-of-PID conditions
#
# These are events the host-monitor sidecar CANNOT detect:
# host-monitor sees memory pressure *building*; dmesg-monitor
# sees the consequences when it broke.
#
# Stateful: the script remembers the timestamp of the last
# event it surfaced in /var/lib/morphit-dmesg-monitor/last-cursor
# so successive runs don't re-alert on the same incident.
#
# Module name: "dmesg".  Event names:
#   oom_kill                   — CRITICAL: kernel killed a process
#   kernel_oops                — CRITICAL: kernel detected an error
#   kernel_panic               — CRITICAL: kernel paniced (host may be unstable)
#   hardware_error             — CRITICAL: hardware/MCE event
#   segfault_in_morphit        — CRITICAL: a morphit service segfaulted
#   segfault_other             — WARN:     some other process segfaulted
#   fd_exhausted               — WARN:     fork failed (out of FDs/PIDs)
#
# Run from a systemd timer every 5 minutes.  The cursor-based
# state means missed runs don't lose events.

set -eu

STATE_DIR=${MORPHIT_DMESG_STATE_DIR:-/var/lib/morphit-dmesg-monitor}
STATE_FILE="$STATE_DIR/last-cursor"
mkdir -p "$STATE_DIR"

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="dmesg"
MORPHIT_EMIT_TAG="morphit-dmesg-monitor"

# ─── Bail if dmesg unreadable ──────────────────────────────────
# On systems with dmesg_restrict=1 (the default since Debian 12),
# non-root users can't read dmesg.  This sidecar runs as root for
# that reason.
if ! dmesg --time-format iso > /dev/null 2>&1; then
    emit info dmesg_unreadable \
         '{"hint":"dmesg not readable; check kernel.dmesg_restrict, ensure service runs as root"}'
    exit 0
fi

# ─── Read dmesg with ISO timestamps ────────────────────────────
# --time-format iso gives us "2026-05-14T19:30:00,123456+00:00"
# prefixes, which sort lexically and let us cursor cleanly.
all_lines=$(dmesg --time-format iso 2>/dev/null || true)
[ -z "$all_lines" ] && exit 0

# Load previous cursor (last ISO timestamp we've surfaced).
last_cursor=""
[ -f "$STATE_FILE" ] && last_cursor=$(cat "$STATE_FILE" 2>/dev/null || echo "")

# Find the newest cursor candidate from the current dmesg.
newest_seen=$(echo "$all_lines" | awk '{print $1}' \
                | grep -E '^[0-9]{4}-' \
                | tail -1 || echo "")

# ─── Scan only NEW lines (those with timestamps > last_cursor) ──
# If we have no prior cursor, treat as bootstrap: scan everything
# but mark cursor at the newest, so next run doesn't re-alert.
new_lines=""
if [ -z "$last_cursor" ]; then
    new_lines="$all_lines"
else
    new_lines=$(echo "$all_lines" | awk -v cursor="$last_cursor" '
        {
            ts = $1
            if (ts > cursor) print
        }
    ')
fi

[ -z "$new_lines" ] && {
    # Persist cursor even if no new lines (no-op safe).
    [ -n "$newest_seen" ] && echo "$newest_seen" > "$STATE_FILE"
    exit 0
}

# ─── OOM-killer ────────────────────────────────────────────────
# Linux OOM-killer prints lines like:
#   "Out of memory: Killed process 1234 (myproc) total-vm:..."
# Or "oom-kill: ..." headers.  We grep for either.
oom_hits=$(echo "$new_lines" | grep -E -i 'out of memory|oom-kill|oom_reaper' || true)
if [ -n "$oom_hits" ]; then
    # Extract the process name + pid from the "Killed process"
    # line if present.
    killed=$(echo "$oom_hits" | grep -i 'Killed process' | head -1)
    proc_name=$(echo "$killed" | sed -nE 's/.*Killed process [0-9]+ \(([^)]+)\).*/\1/p')
    proc_pid=$(echo "$killed" | sed -nE 's/.*Killed process ([0-9]+).*/\1/p')
    payload='{"victim_proc":"'$(json_str "${proc_name:-unknown}")'","victim_pid":'${proc_pid:-0}',"raw_line":"'$(json_str "$(echo "$oom_hits" | head -1 | cut -c1-200)")'"}'
    emit error oom_kill "$payload"
fi

# ─── Kernel oops / panic ───────────────────────────────────────
oops_hits=$(echo "$new_lines" | grep -E -i 'kernel: Oops|Oops:|BUG:' || true)
if [ -n "$oops_hits" ]; then
    line=$(echo "$oops_hits" | head -1 | cut -c1-200)
    payload='{"raw_line":"'$(json_str "$line")'"}'
    emit error kernel_oops "$payload"
fi

panic_hits=$(echo "$new_lines" | grep -E -i 'Kernel panic|kernel: panic' || true)
if [ -n "$panic_hits" ]; then
    line=$(echo "$panic_hits" | head -1 | cut -c1-200)
    payload='{"raw_line":"'$(json_str "$line")'"}'
    emit error kernel_panic "$payload"
fi

# ─── Hardware errors (MCE / EDAC / ATA) ────────────────────────
hw_hits=$(echo "$new_lines" | grep -E -i 'mce:|EDAC|ata.*error|I/O error|Buffer I/O error' | head -3 || true)
if [ -n "$hw_hits" ]; then
    # Combine up to 3 lines for context, truncated.
    summary=$(echo "$hw_hits" | head -3 | tr '\n' ' ' | cut -c1-300)
    payload='{"raw_line":"'$(json_str "$summary")'"}'
    emit error hardware_error "$payload"
fi

# ─── Segfaults ─────────────────────────────────────────────────
# Format example:
#   "node[1234]: segfault at 0 ip 00007f... sp 00007f... error 4 in libc-..."
seg_hits=$(echo "$new_lines" | grep -E 'segfault at|general protection fault' || true)
if [ -n "$seg_hits" ]; then
    morphit_seg=$(echo "$seg_hits" | grep -E -i 'morphit|node|tsx' || true)
    other_seg=$(echo "$seg_hits" | grep -v -E -i 'morphit|node|tsx' || true)
    if [ -n "$morphit_seg" ]; then
        line=$(echo "$morphit_seg" | head -1 | cut -c1-200)
        payload='{"raw_line":"'$(json_str "$line")'"}'
        emit error segfault_in_morphit "$payload"
    fi
    if [ -n "$other_seg" ]; then
        line=$(echo "$other_seg" | head -1 | cut -c1-200)
        payload='{"raw_line":"'$(json_str "$line")'"}'
        emit warn segfault_other "$payload"
    fi
fi

# ─── FD / PID exhaustion ───────────────────────────────────────
fd_hits=$(echo "$new_lines" | grep -E -i 'fork failed|cannot allocate.*pid|file table overflow' || true)
if [ -n "$fd_hits" ]; then
    line=$(echo "$fd_hits" | head -1 | cut -c1-200)
    payload='{"raw_line":"'$(json_str "$line")'"}'
    emit warn fd_exhausted "$payload"
fi

# ─── Persist cursor for next run ───────────────────────────────
[ -n "$newest_seen" ] && echo "$newest_seen" > "$STATE_FILE"

exit 0
