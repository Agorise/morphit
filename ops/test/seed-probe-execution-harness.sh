#!/usr/bin/env bash
# ops/test/seed-probe-execution-harness.sh — EXECUTE the seed script's
# frontend-probe region under `set -u`, for every shape of origin.
#
# WHY THIS EXISTS, AND WHY THE OBVIOUS TOOLS DO NOT WORK
# A hidden-origin skip was added that read `$_fe` before any assignment. On a
# CLEARNET box the branch that sets it never ran, so `set -u` aborted the whole
# seed step — after announcing the CID but BEFORE the Tor/I2P verification. It
# shipped in a release and an operator hit it on the first upgrade.
#
# Three things that CANNOT catch it, all tried:
#   - `dash -n` / `bash -n`: syntax only. An unset read is valid syntax and
#     fails at runtime, on the branch that does not run.
#   - shellcheck SC2154: flags a variable assigned NOWHERE in the file. `_fe`
#     IS assigned — in the else branch — so SC2154 stays silent. Verified by
#     reintroducing the bug: shellcheck passed.
#   - the test written for that change: it pre-set `_fe=""` before executing the
#     block, so the variable that was unset in production was initialised in the
#     test. It passed for the wrong reason.
#
# What works is running the region with the SAME shell options production uses,
# for a host value that takes each branch, and asserting it does not abort.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SEED="$REPO/ops/ipfs/morphit-ipfs-seed.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fails=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

# Pull out the region from the hidden-origin comment through the probe branch.
python3 - "$SEED" "$WORK/region.sh" <<'PY'
import sys
src = open(sys.argv[1], encoding='utf-8').read()
start = src.index('# A HIDDEN origin cannot be probed this way')
# back up to include any initialisation immediately preceding the comment
head = src.rindex('done\n', 0, start) + len('done\n')
end = src.index('if [ "$_gw" != "200" ]; then', start)
open(sys.argv[2], 'w', encoding='utf-8').write(src[head:end])
PY

echo "── seed frontend-probe region, executed under set -u ───────────"

# `_code` is the script's curl wrapper; stub it so nothing leaves the box.
for host in "morphit.io" "example.org" "$(printf 'a%.0s' $(seq 56)).onion" \
            "$(printf 'b%.0s' $(seq 52)).b32.i2p" "morphit.loki" ""; do
	label="${host:-<empty>}"
	case "$host" in
		*.onion|*.b32.i2p|*.loki) kind="hidden" ;;
		"") kind="none" ;;
		*) kind="clearnet" ;;
	esac
	out="$(dash -c "
set -u
log(){ :; }
_code(){ echo 200; }
PROBE_PATH=/ipfs/x
_host='$host'
_hostsrc=test
. '$WORK/region.sh'
echo \"OK fe=[\$_fe]\"
" 2>&1)" || true
	case "$out" in
		*"OK fe="*) ok "origin '${label}' (${kind}) does not abort under set -u" ;;
		*"parameter not set"*)
			no "origin '${label}' (${kind}) ABORTED: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-70)" ;;
		*) no "origin '${label}' (${kind}) failed: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-70)" ;;
	esac
done

# The hidden branch must actually SKIP the clearnet probe, not merely survive it.
skipped="$(dash -c "
set -u
log(){ echo \"LOG \$*\"; }
_code(){ echo 200; }
PROBE_PATH=/ipfs/x
_host='$(printf 'a%.0s' $(seq 56)).onion'
_hostsrc=test
. '$WORK/region.sh'
" 2>&1 || true)"
case "$skipped" in
	*"not reachable over the clearnet edge"*)
		ok "a hidden origin skips the clearnet probe and says why" ;;
	*) no "a hidden origin did not skip the clearnet probe" ;;
esac

echo ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m✗ %d seed-probe check(s) failed\033[0m (%d passed)\n' "$fails" "$pass"; exit 1
fi
printf '\033[32m✓ all %d seed-probe checks passed\033[0m\n' "$pass"
