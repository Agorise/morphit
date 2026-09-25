#!/bin/sh
# morphit-release-monitor.sh — check Forgejo every ~6h for a newer
# Morphit release; emit an alert when one is available so operators
# can't miss it.
#
# Module name: "release".  Event names:
#   release_available            — INFO: a newer release exists; show
#                                          tag + URL
#   release_check_failed         — INFO: couldn't reach Forgejo or
#                                          parse response (transient)
#   release_up_to_date           — DEBUG/INFO: optionally suppressed
#                                          (no event unless --verbose)
#
# Cadence: every 6h via systemd timer.  Aligned with the
# OnCalendar pattern used by other sidecars.
#
# Per the maintainer's memory entry #29: this sidecar is OBSERVATION-ONLY.
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

# Path to the ops-cli — must be runnable as the morphit-host-monitor
# user (no DB needed for --check-only).
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
# Wrapped in `timeout 30` because the Forgejo API call goes over
# HTTPS to an external host; a slow network must not block the
# system-timer slot indefinitely.
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
if JSON_OUT=$(cd "$(dirname "$OPS_CLI")/.." && timeout 30 "$TSX" "$OPS_CLI" upgrade --check-only --json 2>/dev/null); then
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
        emit info release_check_failed \
             "{\"exit_code\":$EXIT_CODE,\"hint\":\"morphit-ops upgrade --check-only could not reach a release source; on a clearnet node check git.agorise.net, on a hidden-only node check this node's indexer (sudo morphit-ops health)\"}"
        ;;
esac
