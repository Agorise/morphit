#!/usr/bin/env bash
# ops/test/fastchat-three-leg-harness.sh — prove fastchat-three-leg-smoke.ts
# actually catches the regressions it claims to.
#
# WHY THIS EXISTS
# That smoke is the only thing behind the headline claim: that a message crosses
# from one person's browser to another's, across two zero-clearnet instances, in
# well under six seconds. A green run against correct code proves nothing about
# whether it would notice the code going wrong, and a latency smoke is unusually
# easy to get wrong in the flattering direction — a measurement that silently
# stops measuring still prints a small number.
#
# So each load-bearing claim is broken on purpose, and the smoke must notice.
#
#   N1  The chat send goes back to waiting for a block.
#         → the sender pays up to a full block interval again. Invisible on a
#           fast hop, fatal on a slow one, which is exactly where users are.
#   N2  The fan-out is moved to AFTER the chain call.
#         → delivery queues behind the chain, so a sick Blurt node silently
#           stops every conversation on the instance.
#   N3  The fan-out is removed from the broadcast route.
#         → nothing reaches the recipient by the fast path at all.
#
# A fifth plausible regression — the peer push ignoring a non-2xx answer and
# reporting success — is NOT checked here, because this smoke would still see
# the message delivered and would be right to pass. It is checked in
# federation-chat-fast-harness (M9), against the smoke that actually counts
# deliveries. A harness that claimed it here would be marking its own homework.
#
# Hermetic: operates on a COPY of the tree in a temp dir. The real source is
# never modified, so an interrupted run cannot leave a mutation behind.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -x "$REPO/node_modules/.bin/tsx" ]; then
	TSX="$REPO/node_modules/.bin/tsx"
elif command -v tsx >/dev/null 2>&1; then
	TSX="$(command -v tsx)"
else
	echo "ERROR: tsx not found. Run 'npm install' from the repo root." >&2
	exit 2
fi

pass=0; fails=0
ok(){ printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m\xe2\x9c\x97\033[0m %s\n' "$1"; fails=$((fails+1)); }

mkdir -p "$WORK"
cp -r "$REPO/apps" "$WORK/apps"
cp -r "$REPO/packages" "$WORK/packages"
cp "$REPO/tsconfig.smoke.json" "$WORK/" 2>/dev/null || true
cp "$REPO/tsconfig.json" "$WORK/" 2>/dev/null || true
cp "$REPO/package.json" "$WORK/" 2>/dev/null || true
ln -s "$REPO/node_modules" "$WORK/node_modules"

SMOKE="$WORK/apps/indexer/scripts/fastchat-three-leg-smoke.ts"
BCAST="$WORK/apps/indexer/src/api/broadcast.ts"

run_smoke(){
	# TSX_TSCONFIG_PATH must be cleared: run from the battery wrapper, the outer
	# tsx exports it to children as a RELATIVE path that does not resolve from
	# this temp directory, and tsx dies before the smoke runs at all.
	( cd "$WORK" && unset TSX_TSCONFIG_PATH && \
	  timeout 300 "$TSX" --tsconfig tsconfig.smoke.json "$SMOKE" 2>&1 )
}

verdict(){ # <output> -> pass | fail | crash
	if grep -q 'scenarios passed' <<<"$1"; then echo pass
	elif grep -q 'FAILED' <<<"$1"; then echo fail
	else echo crash; fi
}

snapshot(){ cp "$1" "$1.orig"; }
restore(){ mv "$1.orig" "$1"; }

# Exact literal substitution that REFUSES to continue when the text is not
# found. A mutation that silently fails to apply leaves the smoke running
# against correct source and reports a catch that never happened.
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

expect_caught(){ # <label> <file> <needle-or-empty>
	local label="$1" file="$2" needle="${3:-}" out v
	out="$(run_smoke)"; v="$(verdict "$out")"
	case "$v" in
		fail)
			# The needle is matched against the FAILING lines only.
			#
			# Grepping the whole output is a vacuous check: a passing run
			# prints the scenario names too, so a needle taken from a ✓ line
			# is satisfied by any failure whatsoever — which is the same as
			# not checking the reason at all. Several needles in these
			# harnesses were exactly that, and looked rigorous.
			if [ -z "$needle" ] || grep -qi -- "$needle" <<<"$(grep '✗' <<<"$out")"; then
				ok "$label — caught"
			else
				no "$label — the smoke failed, but not for the expected reason"
				printf '%s\n' "$out" | grep '✗' | head -4 | sed 's/^/        /'
			fi ;;
		pass)
			no "$label — SURVIVED. The smoke passes with this bug in place, so it is not guarding it." ;;
		crash)
			no "$label — the smoke CRASHED; no verdict. Not counted as a catch."
			printf '%s\n' "$out" | tail -6 | sed 's/^/        /' ;;
	esac
	restore "$file"
}

echo 'fastchat-three-leg-harness — is the end-to-end measurement actually a test?'
echo ''

out="$(run_smoke)"; v="$(verdict "$out")"
if [ "$v" = pass ]; then
	ok 'baseline — the smoke passes against unmutated source'
else
	no "baseline — the smoke does not pass on correct code (verdict: $v). Nothing below can be trusted."
	printf '%s\n' "$out" | tail -20 | sed 's/^/        /'
	echo ''
	echo "✗ harness aborted: no usable baseline"
	exit 1
fi

# ── N1. The chat send waits for a block again ────────────────────────
snapshot "$BCAST"
printf '%s' '		const chatAsync = chatOnly && chatAsyncRequested === true;' > "$WORK/.needle"
printf '%s' '		const chatAsync = false;' > "$WORK/.repl"
if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'N1 a chat send waits for block inclusion again' "$BCAST" 'broadcast_transaction_synchronous'
else
	no 'N1 — mutation did not apply (the chat-only branch changed; update this harness)'
	restore "$BCAST"
fi

# ── N2. The fan-out moves to AFTER the chain call ────────────────────
# Removing it from before and re-adding it after the broadcast returns, which is
# the shape a careless reorder produces.
#
# Re-aimed after an audit finding: the call now returns a handle the
# send path uses once the node has accepted, so the handle is declared where the
# call was and assigned after the chain call returns.
snapshot "$BCAST"
printf '%s\n' '		const fast = fastDispatch?.dispatchIfChat(trx);' > "$WORK/.needle"
printf '%s\n' '		let fast: { chainAccepted(): void } | undefined; // assigned below for this mutation' > "$WORK/.repl"
if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
	printf '%s\n' '		let trx_id = (result?.trx_id ?? result?.id) as string | undefined;' > "$WORK/.needle"
	printf '%s\n' '		fast = fastDispatch?.dispatchIfChat(trx);' \
		'		let trx_id = (result?.trx_id ?? result?.id) as string | undefined;' > "$WORK/.repl"
	if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
		expect_caught 'N2 delivery queues behind the chain call' "$BCAST" 'node stalled'
	else
		no 'N2 — the second half of the mutation did not apply (update this harness)'
		restore "$BCAST"
	fi
else
	no 'N2 — mutation did not apply (the dispatch call changed; update this harness)'
	restore "$BCAST"
fi

# ── N3. The fan-out is removed entirely ──────────────────────────────
# Re-aimed after an audit finding, as Q5 in the instance-matrix
# harness: deleting the fan-out means no handle at all.
snapshot "$BCAST"
printf '%s\n' '		const fast = fastDispatch?.dispatchIfChat(trx);' > "$WORK/.needle"
printf '%s\n' '		const fast = undefined as { chainAccepted(): void } | undefined; void fastDispatch;' > "$WORK/.repl"
if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'N3 the federation fan-out never fires' "$BCAST" 'never reached'
else
	no 'N3 — mutation did not apply (the dispatch call changed; update this harness)'
	restore "$BCAST"
fi

# ── N4. `.every` becomes `.some` ─────────────────────────────────────
# One word, and the money half of a mixed transaction gets a receipt for a block
# it is not in. No scenario covered this before, because every other one sends
# chat alone or a transfer alone — the two cases where `.every` and `.some` agree.
snapshot "$BCAST"
printf '%s' '	return trx.operations.every(' > "$WORK/.needle"
printf '%s' '	return trx.operations.some(' > "$WORK/.repl"
if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'N4 a chat op alongside a transfer takes the async path' "$BCAST" 'mixed chat+transfer'
else
	no 'N4 — mutation did not apply (isChatMessageOnly changed; update this harness)'
	restore "$BCAST"
fi

# ── N5. The fast answer stops being opt-in ───────────────────────────
# The indexer deciding for itself is what breaks a cached browser tab: an older
# bundle reads `block_num: null` as a malformed reply and shows a permanent
# failure for a message that was in fact delivered — then duplicates it on retry.
snapshot "$BCAST"
printf '%s' '		const chatAsync = chatOnly && chatAsyncRequested === true;' > "$WORK/.needle"
printf '%s' '		const chatAsync = chatOnly;' > "$WORK/.repl"
if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'N5 an un-flagged chat send is answered before its block' "$BCAST" 'un-flagged chat send'
else
	no 'N5 — mutation did not apply (the opt-in check changed; update this harness)'
	restore "$BCAST"
fi

echo ''
echo '────────────────────────────────────────────────────────'
if [ "$fails" -eq 0 ]; then
	printf '\033[32m✓ all %d fastchat-three-leg-harness checks passed\033[0m\n' "$pass"
	exit 0
else
	printf '\033[31m✗ %d FAILED, %d passed\033[0m\n' "$fails" "$pass"
	exit 1
fi
