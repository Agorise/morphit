#!/usr/bin/env bash
# ops/test/fastchat-instance-matrix-harness.sh — prove
# fastchat-instance-matrix-smoke.ts actually catches what it claims.
#
# WHY THIS EXISTS
# That smoke stands behind the broadest promise in the release: that a legitimate
# buyer/seller conversation reaches the other person's INBOX in under six
# seconds, in BOTH directions, whatever kind of instance either of them is on.
# It is also the smoke most able to pass for the wrong reason — an inbox ping
# arrives whether or not the notification gate allowed it, so a test that only
# watched the ping would have been green against a bug that leaves a closed
# browser silent.
#
#   Q1  Local delivery is removed.
#         → two people on ONE instance lose the fast path entirely and wait for
#           the head tailer to read the message back off the chain. Up to 6.8
#           seconds on a privacy-only instance, for the most ordinary case there
#           is.
#   Q2  The gate stops consulting our own relay log.
#         → the reply direction stops clearing the notification gate: the person
#           who STARTED the conversation gets no push if their browser is shut,
#           and nothing replayed if they open it a moment later. The ping still
#           arrives, so only the gate assertion catches this.
#   Q3  The order tag is dropped from the delivered event.
#         → the inbox can light a badge but cannot draw the right card, because
#           it does not know which thread the message belongs to.
#   Q4  The activity frame renames a field the browser parses.
#   Q8  The federation push timeout is lowered below the slowest transport
#       the matrix walks.
#         → a peer on that network has every push abandoned mid-flight. The
#           six-second latency budget becomes irrelevant, because nothing
#           arrives to be timed. This is the ceiling that bites first, and it
#           is invisible in a matrix pinned to a single Tor-shaped hop.
#         → badges stop working for everyone, silently, with no error on either
#           side. This is the half of that contract the indexer owns.
#
# Hermetic: operates on a COPY of the tree in a temp dir.
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

SMOKE="$WORK/apps/indexer/scripts/fastchat-instance-matrix-smoke.ts"
BCAST="$WORK/apps/indexer/src/api/broadcast.ts"
ROUTE="$WORK/apps/indexer/src/api/federationChatFast.ts"
# The notify gate moved into one shared module in the v1.18.0 deep-deep (FC-2).
GATE="$WORK/apps/indexer/src/indexer/fastNotifyGate.ts"
FED="$WORK/apps/indexer/src/indexer/chatFastFederation.ts"
ACTIVITY="$WORK/apps/indexer/src/api/chatActivityStream.ts"
DISPATCH="$WORK/apps/indexer/src/indexer/chatFastDispatcher.ts"

run_smoke(){
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

echo 'fastchat-instance-matrix-harness — is the matrix actually a test?'
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

# ── Q1. Local delivery is removed ────────────────────────────────────
snapshot "$BCAST"
cat > "$WORK/.needle" <<'NEEDLE'
			if (located.ok && localChatDeliver !== undefined) {
				localChatDeliver(located.located, trx_id);
			}
NEEDLE
cat > "$WORK/.repl" <<'REPL'
			void localChatDeliver;
REPL
if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'Q1 two people on one instance lose the fast path' "$BCAST" 'never arrived'
else
	no 'Q1 — mutation did not apply (the local delivery call changed; update this harness)'
	restore "$BCAST"
fi

# ── Q2. The gate stops consulting our own relay log ──────────────────
snapshot "$GATE"
printf '%s\n' '	if (hasRecentOutboundChat(located.recipient, located.signer)) return true;' > "$WORK/.needle"
printf '%s\n' '	if (false) return true;' > "$WORK/.repl"
if mutate "$GATE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'Q2 the reply no longer clears the notification gate' "$GATE" 'did NOT clear'
else
	no 'Q2 — mutation did not apply (the gate changed; update this harness)'
	restore "$GATE"
fi

# ── Q3. The order tag is dropped from the delivered event ────────────
snapshot "$FED"
printf '%s' '		orderPermlink: located.orderPermlink,' > "$WORK/.needle"
printf '%s' '		orderPermlink: null,' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'Q3 the inbox ping loses the order it is about' "$FED" 'order permlink'
else
	no 'Q3 — mutation did not apply (the emitted event changed; update this harness)'
	restore "$FED"
fi

# ── Q4. The activity frame renames a field the browser parses ────────
# The browser needs `inbound`, `peer` and `order` by those exact names. Rename
# one and nothing lights up and nothing errors — on either side. The browser's
# half of this contract is globalChatActivityStream.test.ts; this is the other
# half, and between them a rename cannot pass unnoticed.
snapshot "$ACTIVITY"
printf '%s' "safePush(sseEvent('chat_activity', { peer, order, inbound, at: atMs ?? null }));" > "$WORK/.needle"
printf '%s' "safePush(sseEvent('chat_activity', { peer, order, is_inbound: inbound, at: atMs ?? null }));" > "$WORK/.repl"
if mutate "$ACTIVITY" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'Q4 the activity frame renames a field the browser parses' "$ACTIVITY" 'browser requires'
else
	no 'Q4 — mutation did not apply (the activity frame changed; update this harness)'
	restore "$ACTIVITY"
fi

# ── Q5. The federation fan-out is deleted ────────────────────────────
# THE MUTATION THIS HARNESS DID NOT HAVE, and the one that mattered most.
# `chatEventBus` is a process-wide singleton, so before the smoke was fixed both
# "instances" shared one bus: instance A's LOCAL delivery was heard by instance
# B's activity route, and every cross-instance row passed with the entire
# federation removed. Thirty scenarios, all green, measuring nothing. The smoke
# now wires local delivery only for the same-instance rows, so the cross-instance
# rows have no route to the recipient except this call.
snapshot "$BCAST"
# Since the deep-deep (FC-1) the call returns a handle the send path uses once
# the node has accepted; deleting the fan-out means no handle at all.
printf '%s\n' '		const fast = fastDispatch?.dispatchIfChat(trx);' > "$WORK/.needle"
printf '%s\n' '		const fast = undefined as any; void fastDispatch;' > "$WORK/.repl"
if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'Q5 nothing is pushed to peers at all' "$BCAST" 'never arrived'
else
	no 'Q5 — mutation did not apply (the fan-out call changed; update this harness)'
	restore "$BCAST"
fi

# ── Q6. The receiving endpoint accepts and does nothing ──────────────
# The other end of the same wire. A peer answering 202 while quietly dropping
# every message is the worst shape this failure can take: the sender's counters
# say delivered, the peer's say nothing, and the conversation silently falls back
# to chain timing.
snapshot "$ROUTE"
printf '%s' '		void work();' > "$WORK/.needle"
printf '%s' '		void 0;' > "$WORK/.repl"
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'Q6 the peer accepts pushes and never delivers them' "$ROUTE" 'never arrived'
else
	no 'Q6 — mutation did not apply (the intake changed; update this harness)'
	restore "$ROUTE"
fi

# ── Q7. The first-contact gate is forced closed ──────────────────────
# The release's headline promise is that a STRANGER's opening message reaches a
# seller's inbox — including a seller whose browser is shut, which is decided by
# the gate and not by the ping. The smoke asserted the ping only, and its own
# order fixture was returning the wrong answer to the gate the whole time.
snapshot "$GATE"
printf '%s\n' '		orderResponseBypass = oc.ownedByRecipient && oc.live;' > "$WORK/.needle"
printf '%s\n' '		orderResponseBypass = false;' > "$WORK/.repl"
if mutate "$GATE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'Q7 a buyer opening a chatroom no longer clears the gate' "$GATE" 'did NOT clear'
else
	no 'Q7 — mutation did not apply (the order bypass changed; update this harness)'
	restore "$GATE"
fi

# ── Q8. The federation push is abandoned before a slow transport answers ─
# The matrix now walks its worst case (privacy → privacy, three hidden legs,
# no fallback underneath it) across the range of round trips Morphit's three
# hidden networks actually produce — a fast Lokinet hop up to an I2P tunnel
# pair having a bad day. That range only means something if the smoke would
# NOTICE a transport it can no longer serve.
#
# The push timeout is the second ceiling. Lower it beneath the slowest band and
# the smoke must say so.
#
# WHAT IT CATCHES, PRECISELY — because the first draft of this note claimed more
# than the run supports. Lowering the timeout to 1,200 ms does NOT make the slow
# band's delivery rows go red, and that is correct rather than a weakness: the
# recipient's instance has already received and emitted the push by the time the
# SENDER abandons it, so the message still lands inside the target. What is lost
# is the sender's knowledge of it — the delivery is recorded as a failure, the
# batch's accounting is wrong, and every subsequent message to that peer is
# pushed as though the last one had not arrived.
#
# So what goes red is the derived headroom check, which compares the timeout
# read out of the dispatcher against the slowest band this matrix walks. That is
# the honest assertion here, and it is why the check reads the constant from
# source rather than restating it.
snapshot "$DISPATCH"
printf '%s' 'const PUSH_TIMEOUT_MS = 4_000;' > "$WORK/.needle"
printf '%s' 'const PUSH_TIMEOUT_MS = 1_200;' > "$WORK/.repl"
if mutate "$DISPATCH" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'Q8 a slow hidden transport is cut off mid-push' "$DISPATCH" 'push timeout'
else
	no 'Q8 — mutation did not apply (the push timeout changed; update this harness)'
	restore "$DISPATCH"
fi

echo ''
echo '────────────────────────────────────────────────────────'
if [ "$fails" -eq 0 ]; then
	printf '\033[32m✓ all %d fastchat-instance-matrix-harness checks passed\033[0m\n' "$pass"
	exit 0
else
	printf '\033[31m✗ %d FAILED, %d passed\033[0m\n' "$fails" "$pass"
	exit 1
fi
