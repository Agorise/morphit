#!/usr/bin/env bash
# ops/test/federation-health-summary-harness.sh — prove the ops-CLI's reading of
# the federated-chat health block actually catches the ways it could misread it.
#
# WHY THIS EXISTS
#
# v1.18.0 put a complete diagnostic story on `/v1/health`: which of THIS box's
# hidden networks are unusable, how many recent failures never left the machine,
# how many faults are held against a network that has not been convicted, and
# what the receiving side is doing. `morphit-ops health` sent the operator-local
# header that reveals all of it — and displayed none of it. It parsed the head
# TAILER, which is a different subsystem that happens to share the block. The
# operator guide meanwhile told operators to read the federation fields "with
# the ops CLI".
#
# So the reading is new code on the path an operator actually uses to decide
# whether their instance is healthy, and a misreading here is worse than no
# reading: a confident wrong line sends them to look in the wrong place, which
# is precisely the failure the whole block exists to prevent.
#
# Its test was written first and the mutations below were watched to fail
# against it by hand. That is what this file makes repeatable — the same reason
# `fastchat-client-harness.sh` exists, and the same admission ADR-0052 had to
# retire once.
#
# THE MUTATIONS.
#
#   H1  An older indexer's body reports zeros instead of nothing.
#         → a mixed-version federation is the NORMAL state during an upgrade,
#           and "0 delivered, 0 failed" is not a missing field, it is an
#           alarming claim. The operator goes looking for a fault that is
#           actually a version difference.
#   H2  A suspicion count of zero is still reported.
#         → the CLI accuses a network of faults it has not had.
#   H3  Every recent failure is counted as ours.
#         → the one number that says "the problem is on your machine" starts
#           counting the peers' failures too, which inverts its meaning.
#   H4  The OLDEST failure is shown as the last.
#         → "last failure" is the line an operator reads first; showing a stale
#           one sends them after something already fixed.
#   H5  Network names from the body are trusted without checking.
#         → a field of an unexpected shape reaches the renderer. A health report
#           that crashes is worse than one that omits a line: it takes the
#           database, relay and RPC verdicts down with it.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fails=0
ok(){ printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m\xe2\x9c\x97\033[0m %s\n' "$1"; fails=$((fails+1)); }

# ── Hermetic copy ────────────────────────────────────────────────────
# Mutate a COPY. Everything this test imports resolves through the ops-cli
# workspace out of this copy, so node_modules is symlinked whole — unlike the
# transport harness, which mutates a PACKAGE and has to redirect @morphit/* to
# see its own edits.
mkdir -p "$WORK"
cp -r "$REPO/apps" "$WORK/apps"
cp -r "$REPO/packages" "$WORK/packages"
cp "$REPO/tsconfig.json" "$WORK/" 2>/dev/null || true
cp "$REPO/package.json" "$WORK/" 2>/dev/null || true
ln -s "$REPO/node_modules" "$WORK/node_modules"

HEALTH="$WORK/apps/ops-cli/src/commands/health.ts"
TEST=test/federationHealthSummary.test.ts

run_tests(){
	( cd "$WORK/apps/ops-cli" && timeout 300 npx vitest run "$TEST" 2>&1 )
}

verdict(){ # <output> -> pass | fail | crash
	if grep -qE 'Tests +[0-9]+ failed' <<<"$1"; then echo fail
	elif grep -qE 'Tests +[0-9]+ passed' <<<"$1"; then echo pass
	else echo crash; fi
}

snapshot(){ cp "$1" "$1.orig"; }
restore(){ mv "$1.orig" "$1"; }

# Apply an exact literal substitution and REFUSE to continue if the text was not
# found. A mutation that silently fails to apply produces a green run against
# unmutated source — the single most misleading outcome a harness can have, and
# one this release hit four separate times.
mutate(){ # <file> <needle-file> <replacement-file>
	python3 - "$1" "$2" "$3" <<'PYEOF'
import sys
path, needle_path, repl_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
needle = open(needle_path).read()
repl = open(repl_path).read()
if src.count(needle) != 1:
    sys.stderr.write(f"mutation target found {src.count(needle)} times, expected exactly 1\n")
    sys.exit(3)
open(path, 'w').write(src.replace(needle, repl))
PYEOF
}

expect_caught(){ # <label> <file>
	local label="$1" file="$2" out v
	out="$(run_tests)"; v="$(verdict "$out")"
	case "$v" in
		fail) ok "$label — caught" ;;
		pass) no "$label — SURVIVED. The tests pass with this bug in place, so they are not guarding it." ;;
		crash)
			no "$label — the run CRASHED; no verdict. Not counted as a catch."
			printf '%s\n' "$out" | tail -5 | sed 's/^/        /' ;;
	esac
	restore "$file"
}

try(){ # <label> <file> <needle> <replacement>
	local label="$1" file="$2"
	snapshot "$file"
	printf '%s' "$3" > "$WORK/.needle"
	printf '%s' "$4" > "$WORK/.repl"
	if mutate "$file" "$WORK/.needle" "$WORK/.repl"; then
		expect_caught "$label" "$file"
	else
		no "$label — mutation did not apply (the code moved; update this harness)"
		restore "$file"
	fi
}

echo 'federation-health-summary-harness — does the ops CLI read the block correctly?'
echo ''

base_out="$(run_tests)"
if [ "$(verdict "$base_out")" = pass ]; then
	ok 'baseline — the tests pass against unmutated source'
else
	no 'baseline FAILED — nothing below means anything.'
	printf '%s\n' "$base_out" | tail -15 | sed 's/^/        /'
	echo ''
	printf '\033[31m✗ aborting: the baseline must be green\033[0m\n'
	exit 1
fi

try 'H1 an older indexer reports zeros instead of nothing' "$HEALTH" \
	"	if (fed === null || fed === undefined || typeof fed !== 'object') return null;" \
	'	if (false) return null;'

try 'H2 a suspicion count of zero is still reported' "$HEALTH" \
	'			if (count !== null && count > 0) suspected.push({ network: safe(net), count });' \
	'			if (count !== null) suspected.push({ network: safe(net), count: count ?? 0 });'

try 'H3 every recent failure is counted as ours' "$HEALTH" \
	'	const localFaults = failures.filter((r) => r.localFault === true).length;' \
	'	const localFaults = failures.length;'

try 'H4 the oldest failure is shown as the last' "$HEALTH" \
	'	const last = failures.at(-1);' \
	'	const last = failures.at(0);'

try 'H5 network names are trusted without checking their shape' "$HEALTH" \
	"		? (diag.networksDown as unknown[]).flatMap((n) => (typeof n === 'string' ? [safe(n)] : []))" \
	'		? (diag.networksDown as string[])'

echo ''
echo '────────────────────────────────────────────────────────'
if [ "$fails" -eq 0 ]; then
	printf '\033[32m✓ all %d federation-health-summary-harness checks passed\033[0m\n' "$pass"
	exit 0
else
	printf '\033[31m✗ %d FAILED, %d passed\033[0m\n' "$fails" "$pass"
	exit 1
fi
