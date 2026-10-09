#!/bin/sh
# morphit-release-monitor.sh — check twice a day for a newer Morphit
# release; emit an alert when one is available so operators can't miss it
# (the Matrix bot DMs it to the operator when alerts are set up).
#
# Since 2026-10-08 every install and upgrade installs and enables this timer
# (before, nothing did, so no operator was ever told). The check reads
# @morphit's on-chain release record from this node's own indexer
# (`upgrade --check-only`). Run as the unit's throwaway user it cannot read
# this node's config, so when the indexer does not answer it stops there
# (the private choice) and says why; it does not ask the code host.
#
# Module name: "release".  Event names:
#   release_available            — INFO: a newer release exists; show
#                                          tag + URL
#   release_check_failed         — INFO: the check could not check; its
#                                          hint carries the program's reason
#   release_up_to_date           — DEBUG/INFO: optionally suppressed
#                                          (no event unless --verbose)
#
# Cadence: every 12h via systemd timer (morphit-release-monitor.timer).
#
# A standing rule: this sidecar is OBSERVATION-ONLY.
# It NEVER applies the upgrade itself; the operator runs
# `morphit-ops upgrade` manually after the alert (or sets
# MORPHIT_AUTO_UPGRADE=1 + schedules a separate cron for auto-apply).

set -eu

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="release"
MORPHIT_EMIT_TAG="morphit-release-monitor"

# ─── Tunables ───────────────────────────────────────────────────
# Suppress the "up-to-date" event by default; emit only on
# state-change so the operator's alert feed isn't cluttered.
EMIT_UP_TO_DATE=${MORPHIT_RELEASE_MONITOR_VERBOSE:-0}

# Path to the ops-cli — must be runnable as the unit's throwaway user
# (DynamicUser; no DB and no root needed for --check-only).
OPS_CLI=${MORPHIT_OPS_CLI_PATH:-/opt/morphit/apps/ops-cli/src/main.ts}

# The install's OWN tsx (v1.18.0 review, O10). This used to be `npx tsx`,
# run from systemd's default working directory, `/`. From there npx cannot
# see the install's node_modules, so it went to the npm registry for tsx —
# which a tor-only box never reaches and no box should for a status check —
# and the check timed out every time. The install root is four levels above
# apps/ops-cli/src/main.ts.
INSTALL_ROOT=$(cd "$(dirname "$OPS_CLI")/../../.." 2>/dev/null && pwd || echo /opt/morphit)
TSX=${MORPHIT_TSX_PATH:-$INSTALL_ROOT/node_modules/.bin/tsx}

# ─── Bail if ops-cli or node unavailable ────────────────────────
if ! command -v node >/dev/null 2>&1; then
    emit info release_check_failed \
         '{"hint":"node not in PATH; release-monitor needs Node.js"}'
    exit 0
fi
if [ ! -f "$OPS_CLI" ]; then
    emit info release_check_failed \
         "{\"hint\":\"morphit-ops not at $OPS_CLI; set MORPHIT_OPS_CLI_PATH or fix install\"}"
    exit 0
fi
if [ ! -x "$TSX" ]; then
    emit info release_check_failed \
         "{\"hint\":\"tsx not at $TSX; run 'sudo morphit-ops upgrade' to repair the install, or set MORPHIT_TSX_PATH\"}"
    exit 0
fi

# ─── Call morphit-ops upgrade --check-only --json ──────────────
# Wrapped in `timeout 90`: the check reads this node's own indexer (on the
# box) and only falls back to the code host over HTTPS, whose own limit is
# 30 s; the program's start-up takes seconds of its own. It used to be 30 s
# for everything, so a slow code host meant no alert at all.
#
# Capture the exit code CORRECTLY. The obvious `VAR=$(cmd) || true; rc=$?`
# is a trap under `set -e`: `|| true` swallows the failure but also
# clobbers `$?` to 0, so a "newer release" (exit 1) reads as 0 (up-to-date)
# and we'd NEVER alert. The if/else form keeps set -e happy AND preserves
# the real exit code.
#
# Exit codes from morphit-ops upgrade --check-only:
#   0 — up-to-date
#   1 — newer release available (this is what we care about)
#   5 — preflight error (network, missing release-info.json, ...)
# Run from the ops-cli's own directory so its tsconfig and workspace
# packages resolve exactly as they do for `morphit-ops`.
# Its error output is kept (in this run's private /tmp) so a failed check's
# alert says WHY: the program's last error line.
ERR_FILE=$(mktemp 2>/dev/null || echo "/tmp/morphit-release-check.$$.err")
if JSON_OUT=$(cd "$(dirname "$OPS_CLI")/.." && timeout 90 "$TSX" "$OPS_CLI" upgrade --check-only --json 2>"$ERR_FILE"); then
    EXIT_CODE=0
else
    EXIT_CODE=$?
fi

case "$EXIT_CODE" in
    0)
        if [ "$EMIT_UP_TO_DATE" = "1" ]; then
            CURRENT=$(printf '%s' "$JSON_OUT" | grep -oE '"current": *"[^"]*"' | cut -d'"' -f4 || echo unknown)
            emit info release_up_to_date \
                 "{\"current\":\"$CURRENT\"}"
        fi
        ;;
    1)
        # Newer release available.  Extract fields from the JSON
        # output without requiring jq (which may not be installed).
        # The ops-cli pretty-prints (`"current": "v1.17.15"`, with a
        # space); the patterns used to demand no space, so every alert
        # went out with empty versions (v1.18.0 review).
        CURRENT=$(printf '%s' "$JSON_OUT" | grep -oE '"current": *"[^"]*"' | cut -d'"' -f4 || echo unknown)
        LATEST=$(printf '%s' "$JSON_OUT" | grep -oE '"latest": *"[^"]*"' | cut -d'"' -f4 || echo unknown)
        RELEASE_URL=$(printf '%s' "$JSON_OUT" | grep -oE '"release_url": *"[^"]*"' | cut -d'"' -f4 || echo "")
        emit info release_available \
             "{\"current\":\"$CURRENT\",\"latest\":\"$LATEST\",\"release_url\":\"$RELEASE_URL\",\"hint\":\"Run 'morphit-ops upgrade' to apply (or set MORPHIT_AUTO_UPGRADE=1 first to skip the confirmation prompt).\"}"
        ;;
    *)
        # Network error, malformed response, or other failure.
        # Don't alarm noisily — this can be transient.  Operators
        # who care can grep for repeat occurrences over time.
        # The program's own last error line, made safe for a JSON string:
        # colour codes, control characters, quotes and backslashes removed.
        # Its last line that says something: not blank, not a stack frame,
        # not node's closing "Node.js vX" line (a program that died at load).
        # Cut to whole characters (GNU cut counts bytes; iconv -c drops a
        # character split at the edge).
        LINE=$(grep -v -e '^[[:space:]]*$' -e '^[[:space:]]*at ' -e '^Node\.js v' "$ERR_FILE" 2>/dev/null \
              | tail -n 1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | tr -d '\000-\037\177"\\')
        WHY=$(printf '%s' "$LINE" | cut -c1-240 | iconv -c -f UTF-8 -t UTF-8 2>/dev/null)
        # A reason cut short says so (morphitir, 2026-10-08: "…trusted as it. I.
        # To see it" read as if whole), and its own full stop is not doubled.
        SEP='. '
        [ "${#WHY}" -lt "${#LINE}" ] && SEP='… '
        WHY=$(printf '%s' "$WHY" | sed 's/[.[:space:]]*$//')
        [ "$EXIT_CODE" = 124 ] && { WHY="it did not finish within 90 s"; SEP='. '; }
        [ -n "$WHY" ] || { WHY="no reason given (exit status $EXIT_CODE)"; SEP='. '; }
        emit info release_check_failed \
             "{\"exit_code\":$EXIT_CODE,\"hint\":\"The release check could not check: ${WHY}${SEP}To see it on this server: sudo morphit-ops upgrade --check-only\"}"
        ;;
esac
rm -f "$ERR_FILE"
