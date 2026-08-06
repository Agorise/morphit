#!/bin/sh
# morphit-treasury-repin.sh — MAINTAINER-ONLY sidecar (cp372).
#
# Runs the treasury auto-re-pin check on a timer.  Model A pins the
# listing-fee AMOUNTS on chain (deterministic across the federation);
# as BTC/XMR/BLURT drift against their canonical USD targets the pin
# goes stale, so this re-pins it.  Only the @morphit maintainer (who
# holds the posting key + authored the chain-pin) ever re-pins;
# community operators inherit the chain-pin automatically and run
# NOTHING.
#
# Module name: "treasury".  Event names:
#   treasury_repin_due           — INFO: a re-pin is due (detect-only
#                                         mode); the maintainer should
#                                         broadcast (Plan B) or enable
#                                         auto-broadcast
#   treasury_repin_broadcast     — INFO: a re-pin was auto-broadcast
#                                         (opt-in mode)
#   treasury_repin_current       — DEBUG/INFO: pin within tolerance
#                                         (suppressed unless verbose)
#   treasury_repin_check_failed  — INFO: couldn't fetch release/prices
#                                         (transient; NO re-pin made)
#
# TWO MODES (set in /etc/morphit/treasury-repin.env):
#   • DETECT-ONLY (default, SAFE, no key): emits treasury_repin_due
#     when the pin drifts; the maintainer broadcasts by hand via
#     release-build-payload.ts | release-broadcast.ts (Plan B).
#   • AUTO-BROADCAST (opt-in, TRUSTED SIGNING BOX ONLY): set
#     MORPHIT_REPIN_ENABLE_AUTO_BROADCAST=1 + MORPHIT_REPIN_POSTING_KEY_FILE.
#     NEVER enable this on the public production server — the posting
#     key can re-pin the treasury, so a leak diverts fees.

set -eu

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="treasury"
MORPHIT_EMIT_TAG="morphit-treasury-repin"

# ─── Tunables (env-overridable) ─────────────────────────────────
# Indexer to read the current chain-pin + (transitively) prices from.
NODE_URL=${MORPHIT_REPIN_NODE_URL:-https://indexer.morphit.io}
# Drift threshold (must be >0 and <0.15 — inside the verifier band).
THRESHOLD=${MORPHIT_REPIN_THRESHOLD:-0.1}
# Where the indexer workspace lives (scripts import ../src via tsx).
INDEXER_DIR=${MORPHIT_INDEXER_DIR:-/opt/morphit/apps/indexer}
# Suppress the "current" event unless verbose.
EMIT_CURRENT=${MORPHIT_REPIN_VERBOSE:-0}
# Opt-in auto-broadcast (default off → detect-only).
ENABLE_AUTO=${MORPHIT_REPIN_ENABLE_AUTO_BROADCAST:-0}

# ─── Preconditions ──────────────────────────────────────────────
if ! command -v npx >/dev/null 2>&1; then
    emit info treasury_repin_check_failed \
         '{"hint":"npx/node not in PATH; treasury-repin needs Node.js"}'
    exit 0
fi
if [ ! -d "$INDEXER_DIR" ]; then
    emit info treasury_repin_check_failed \
         "{\"hint\":\"indexer dir not at $INDEXER_DIR; set MORPHIT_INDEXER_DIR\"}"
    exit 0
fi

cd "$INDEXER_DIR"

if [ "$ENABLE_AUTO" = "1" ]; then
    # Opt-in auto-broadcast (trusted box).  The broadcast script
    # re-checks every failsafe + validates the payload before signing.
    set +e
    npx tsx --tsconfig ../../tsconfig.smoke.json scripts/treasury-repin-broadcast.ts \
        --node "$NODE_URL" --threshold "$THRESHOLD" \
        --enable-auto-broadcast --unattended >/tmp/morphit-repin.out 2>&1
    rc=$?
    set -e
    case "$rc" in
        0)
            if grep -q "Re-pin broadcast accepted" /tmp/morphit-repin.out 2>/dev/null; then
                emit info treasury_repin_broadcast '{"mode":"auto"}'
            elif [ "$EMIT_CURRENT" = "1" ]; then
                emit info treasury_repin_current '{}'
            fi
            ;;
        *)
            emit info treasury_repin_check_failed \
                 "{\"hint\":\"auto-broadcast exited $rc; check journal + the run output\"}"
            ;;
    esac
    exit 0
fi

# ─── DETECT-ONLY (default) ──────────────────────────────────────
set +e
npx tsx --tsconfig ../../tsconfig.smoke.json scripts/treasury-repin-check.ts \
    --node "$NODE_URL" --threshold "$THRESHOLD" >/tmp/morphit-repin.out 2>&1
rc=$?
set -e
case "$rc" in
    0)
        [ "$EMIT_CURRENT" = "1" ] && emit info treasury_repin_current '{}'
        ;;
    3)
        emit info treasury_repin_due \
             '{"hint":"listing-fee pin has drifted; broadcast a re-pin (release-build-payload.ts | release-broadcast.ts) or enable auto-broadcast"}'
        ;;
    *)
        emit info treasury_repin_check_failed \
             '{"hint":"could not fetch release/prices; no re-pin made (transient)"}'
        ;;
esac
exit 0
