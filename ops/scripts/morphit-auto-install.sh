#!/bin/sh
# morphit-auto-install — install a new SECURITY release by itself, early in the
# morning (05:15 by the server's clock, after the night's restart window)
# (v1.24.7; morphit-auto-install.timer).
#
# Asks `morphit-ops __auto-install-check` (apps/ops-cli/src/lib/
# autoInstallRelease.ts) whether a newer release should be installed now: one
# whose on-chain release record — verified against @morphit's pinned posting
# key — marks it as a security release, or any newer release when the admin
# chose MORPHIT_AUTO_INSTALL_RELEASES=all in /etc/morphit/updates.env. If so,
# it runs the ordinary `morphit-ops upgrade --yes`: the same checks as an
# upgrade by hand (the tarball's SHA-256 against the record, a backup first, a
# rollback when a step fails). Its output goes to the log below.
#
# Alerts (the Matrix alert bot):
#   auto_install_done           INFO (the daily digest): installed, and the
#                               installed release now reads the new version
#   auto_install_failed         WARN: the upgrade did not finish; the log
#   auto_install_refused        CRITICAL: the release record failed its check
#   auto_install_check_failed   INFO: the check itself could not run
# Nothing to install is logged to the journal only.
#
# Env (tests): MORPHIT_OPS_CLI_PATH, MORPHIT_TSX_PATH, MORPHIT_AUTO_INSTALL_LOG,
# MORPHIT_INSTALL_DIR.

set -eu

. "$(dirname "$0")/lib/emit.sh"

MORPHIT_EMIT_MODULE="auto-install"
MORPHIT_EMIT_TAG="morphit-auto-install"

OPS_CLI=${MORPHIT_OPS_CLI_PATH:-/opt/morphit/apps/ops-cli/src/main.ts}
INSTALL_ROOT=$(cd "$(dirname "$OPS_CLI")/../../.." 2>/dev/null && pwd || echo /opt/morphit)
INSTALL_DIR=${MORPHIT_INSTALL_DIR:-$INSTALL_ROOT}
TSX=${MORPHIT_TSX_PATH:-$INSTALL_ROOT/node_modules/.bin/tsx}
LOG=${MORPHIT_AUTO_INSTALL_LOG:-/var/log/morphit/auto-install.log}

if ! command -v node >/dev/null 2>&1; then
    emit info auto_install_check_failed '{"hint":"node is not in PATH, so the nightly check for a security release could not run"}'
    exit 0
fi
if [ ! -f "$OPS_CLI" ] || [ ! -x "$TSX" ]; then
    emit info auto_install_check_failed '{"hint":"morphit-ops or its tsx is missing from the install; run sudo morphit-ops upgrade to repair it"}'
    exit 0
fi

# One field of the check's one-line JSON (values never hold a quote: they are
# versions and plain sentences; json_str escapes them again for the alert).
field() {
    printf '%s' "$1" | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p"
}
installed_tag() {
    sed -n 's/.*"tag": *"\([^"]*\)".*/\1/p' "$INSTALL_DIR/release-info.json" 2>/dev/null | head -n 1
}

set +e
OUT=$(cd "$(dirname "$OPS_CLI")/.." && timeout 900 "$TSX" "$OPS_CLI" __auto-install-check 2>/dev/null)
RC=$?
set -e

case "$RC" in
    0)
        WHY=$(field "$OUT" why)
        echo "morphit-auto-install: nothing to install (${WHY:-no reason given})"
        exit 0
        ;;
    11)
        WHY=$(field "$OUT" why)
        emit error auto_install_refused \
             "{\"hint\":\"$(json_str "${WHY:-the on-chain release record failed its check}"). Nothing was installed. On this server: sudo morphit-ops upgrade --check-only\"}"
        exit 0
        ;;
    10) ;;
    124)
        emit info auto_install_check_failed '{"hint":"the nightly check for a security release did not finish within 15 minutes; the next night tries again"}'
        exit 0
        ;;
    *)
        emit info auto_install_check_failed "{\"hint\":\"the nightly check for a security release could not run (exit status $RC); the next night tries again\"}"
        exit 0
        ;;
esac

FROM=$(field "$OUT" from)
TO=$(field "$OUT" to)
mkdir -p "$(dirname "$LOG")"
{
    echo ""
    echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) morphit-auto-install: ${FROM} -> ${TO}"
} >>"$LOG"
echo "morphit-auto-install: installing ${TO} (from ${FROM}); its output: ${LOG}"

set +e
(cd "$(dirname "$OPS_CLI")/.." && NO_COLOR=1 timeout 10800 "$TSX" "$OPS_CLI" upgrade --yes) >>"$LOG" 2>&1
URC=$?
set -e

NOW=$(installed_tag)
if [ "$URC" -eq 0 ] && [ "$NOW" = "$TO" ]; then
    emit info auto_install_done \
         "{\"from\":\"$(json_str "$FROM")\",\"to\":\"$(json_str "$TO")\",\"log\":\"$(json_str "$LOG")\"}"
else
    [ "$URC" -eq 124 ] && HOW="did not finish within 3 hours" || HOW="ended with exit status $URC"
    emit warn auto_install_failed \
         "{\"from\":\"$(json_str "$FROM")\",\"to\":\"$(json_str "$TO")\",\"running\":\"$(json_str "${NOW:-unknown}")\",\"log\":\"$(json_str "$LOG")\",\"hint\":\"The nightly install of ${TO} ${HOW}; this server runs ${NOW:-an unknown release}. An upgrade puts the previous install back by itself when a step fails. To see what happened, on this server: sudo tail -n 80 $(json_str "$LOG")\"}"
fi
exit 0
