#!/usr/bin/env bash
# ops/test/fast-emit-ledger-harness.sh — prove fast-emit-ledger-smoke.ts catches
# the ways the two smallest modules in v1.18.0 can lose a message.
#
# WHY THIS EXISTS
# `fastEmitLedger` makes the head tailer skip a message the fast path already
# delivered. That saves duplicate work, and it is the one change in this release
# that can SILENTLY LOSE a message: mark a transaction that was never actually
# delivered and the chain copy — the only thing left standing behind it — is
# skipped too. The message still arrives durably a minute later, which is the
# kind of fault that surfaces as "chat is sometimes slow" and never as a bug
# report anyone can act on.
#
#   R1  The ledger is marked BEFORE the gates run.
#         → a message the block list dropped, or one whose gate could not be
#           evaluated because the database faltered, is recorded as delivered.
#           The head tailer then skips it and it never reaches the fast path.
#   R2  The head tailer stops consulting the ledger.
#         → every message is delivered twice: once fast, once from the chain.
#   R3  The ledger's bound is removed.
#         → it grows with message volume, which is not ours to control.
#   R4  The outbound memory stops being directional.
#         → "I wrote to them" and "they wrote to me" become the same fact, and a
#           stranger who messages you looks like someone you had replied to.
#           That is the anti-spam gate quietly coming off.
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

SMOKE="$WORK/apps/indexer/scripts/fast-emit-ledger-smoke.ts"
FED="$WORK/apps/indexer/src/indexer/chatFastFederation.ts"
TAILER="$WORK/apps/indexer/src/indexer/headTailer.ts"
LEDGER="$WORK/apps/indexer/src/indexer/fastEmitLedger.ts"
OUTBOUND="$WORK/apps/indexer/src/indexer/recentOutboundChat.ts"
BCAST="$WORK/apps/indexer/src/api/broadcast.ts"

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

echo 'fast-emit-ledger-harness — can the ledger lose a message without being noticed?'
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

# ── R1. The ledger is marked before the gates ────────────────────────
# The tempting simplification: record it once, at the top, where you can see it.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
): Promise<DeliveryOutcome> {
	let blocked: boolean;
NEEDLE
cat > "$WORK/.repl" <<'REPL'
): Promise<DeliveryOutcome> {
	markFastEmitted(trxId);
	let blocked: boolean;
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'R1 an undelivered message is recorded as delivered' "$FED" 'was recorded'
else
	no 'R1 — mutation did not apply (deliverVerifiedPush changed; update this harness)'
	restore "$FED"
fi

# ── R2. The head tailer stops consulting the ledger ──────────────────
# BOTH checks, because there are two: one before the gate queries (which saves
# the queries in the common case) and one immediately after them (which closes
# the window those queries open, during which a peer's push of the same
# transaction can land). Removing either alone leaves the other doing the work,
# so "the tailer stops consulting the ledger" means removing both.
snapshot "$TAILER"
cat > "$WORK/.needle" <<'NEEDLE'
				if (trxId !== undefined && wasFastEmitted(trxId)) {
					tailerDbg('tailer.SKIP_ALREADY_FAST', { trxId });
					continue;
				}
NEEDLE
printf '%s' '' > "$WORK/.repl"
if mutate "$TAILER" "$WORK/.needle" "$WORK/.repl"; then
	cat > "$WORK/.needle" <<'NEEDLE'
				if (trxId !== undefined && wasFastEmitted(trxId)) {
					tailerDbg('tailer.SKIP_ALREADY_FAST_LATE', { trxId });
					continue;
				}
NEEDLE
	printf '%s' '' > "$WORK/.repl"
	if mutate "$TAILER" "$WORK/.needle" "$WORK/.repl"; then
		expect_caught 'R2 every message is delivered twice' "$TAILER" 're-emitted'
	else
		no 'R2 — the second half of the mutation did not apply (update this harness)'
		restore "$TAILER"
	fi
else
	no 'R2 — mutation did not apply (the tailer skip changed; update this harness)'
	restore "$TAILER"
fi

# ── R3. The ledger grows without bound ───────────────────────────────
snapshot "$LEDGER"
printf '%s' '	while (emitted.size > MAX_ENTRIES) {' > "$WORK/.needle"
printf '%s' '	while (false) {' > "$WORK/.repl"
if mutate "$LEDGER" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'R3 the ledger is unbounded' "$LEDGER" 'without limit'
else
	no 'R3 — mutation did not apply (the ledger bound changed; update this harness)'
	restore "$LEDGER"
fi

# ── R4. The outbound memory stops being directional ──────────────────
# A plausible "tidy-up": key the pair canonically, the way the chat tables do.
# Here it is exactly wrong — it turns "I wrote to them" into "we have spoken".
snapshot "$OUTBOUND"
cat > "$WORK/.needle" <<'NEEDLE'
const keyOf = (from: string, to: string): string =>
	`${from.toLowerCase()}\u0000${to.toLowerCase()}`;
NEEDLE
cat > "$WORK/.repl" <<'REPL'
const keyOf = (from: string, to: string): string =>
	[from.toLowerCase(), to.toLowerCase()].sort().join('\u0000');
REPL
if mutate "$OUTBOUND" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'R4 the outbound memory is no longer directional' "$OUTBOUND" 'directional'
else
	no 'R4 — mutation did not apply (keyOf changed; update this harness)'
	restore "$OUTBOUND"
fi

# ── R5. The ledger never forgets ─────────────────────────────────────
# A stale entry does not leak memory — the table is bounded by count too — it
# suppresses a real message: the head tailer sees a transaction the fast path
# delivered minutes ago, finds it marked, and skips it forever.
snapshot "$LEDGER"
printf '%s' '	return now - t <= TTL_MS;' > "$WORK/.needle"
printf '%s' '	return true;' > "$WORK/.repl"
if mutate "$LEDGER" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'R5 a ledger entry outlives its TTL' "$LEDGER" 'outlived its TTL'
else
	no 'R5 — mutation did not apply (the ledger expiry changed; update this harness)'
	restore "$LEDGER"
fi

# ── R6. The relay log never forgets ──────────────────────────────────
# This entry is what lets someone notify a person who has not replied to them
# yet. It is supposed to lapse when the durable table catches up and can answer
# properly; left standing, the permission is permanent.
snapshot "$OUTBOUND"
printf '%s' '	if (now - t > TTL_MS) return false;' > "$WORK/.needle"
printf '%s' '	if (false) return false;' > "$WORK/.repl"
if mutate "$OUTBOUND" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'R6 a relay-log entry outlives its TTL' "$OUTBOUND" 'outlived its TTL'
else
	no 'R6 — mutation did not apply (the relay-log expiry changed; update this harness)'
	restore "$OUTBOUND"
fi

# ── R7. The ledger forgets before the tailer has finished ────────────
# The two numbers live in different modules, because importing one into the
# other would be a cycle. This is what stops them drifting apart — and the
# original five-minute value WAS shorter than the tailer's reach, so a tailer
# catching up after any stall re-emitted everything the fast path had delivered.
snapshot "$LEDGER"
printf '%s' 'export const TTL_MS = HEAD_TAILER_MAX_CATCHUP_BLOCKS * BLOCK_INTERVAL_MS * 2;' > "$WORK/.needle"
printf '%s' 'export const TTL_MS = 5 * 60 * 1000;' > "$WORK/.repl"
if mutate "$LEDGER" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'R7 the ledger TTL is shorter than the tailer can reach back' "$LEDGER" 'forgets after'
else
	no 'R7 — mutation did not apply (the TTL derivation changed; update this harness)'
	restore "$LEDGER"
fi

# ── R8. The relay log is written BEFORE the node accepts ─────────────
# The entry means "a Blurt node took this transaction from us", and that is the
# whole reason it can be trusted to relax the notification gate. Recorded before
# the broadcast, anyone can assert a pair by posting a transaction that was
# never going to be accepted.
snapshot "$BCAST"
cat > "$WORK/.needle" <<'NEEDLE'
			const located = structuralCheckChatOp(trx);
			if (located.ok) noteOutboundChat(located.located.signer, located.located.recipient);
NEEDLE
printf '%s' '			const located = structuralCheckChatOp(trx);' > "$WORK/.repl"
if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
	cat > "$WORK/.needle" <<'NEEDLE'
		const chatOnly = isChatMessageOnly(trx);
NEEDLE
	cat > "$WORK/.repl" <<'REPL'
		const chatOnly = isChatMessageOnly(trx);
		{
			const early = structuralCheckChatOp(trx);
			if (early.ok) noteOutboundChat(early.located.signer, early.located.recipient);
		}
REPL
	if mutate "$BCAST" "$WORK/.needle" "$WORK/.repl"; then
		expect_caught 'R8 the relay log is written before the node accepts' "$BCAST" 'REJECTED chat send was recorded'
	else
		no 'R8 — the second half of the mutation did not apply (update this harness)'
		restore "$BCAST"
	fi
else
	no 'R8 — mutation did not apply (the relay-log write moved; update this harness)'
	restore "$BCAST"
fi

# ── R9. The ledger is claimed after the await again (v1.18.0 review) ─
# The check and the mark straddled the notify-gate query, so two routes
# delivering the same transaction at once both passed the check and both emitted.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
	if (!trxId.startsWith('tag:')) markFastEmitted(trxId);

	const lo = located.signer < located.recipient ? located.signer : located.recipient;
NEEDLE
cat > "$WORK/.repl" <<'REPL'
	const lo = located.signer < located.recipient ? located.signer : located.recipient;
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	cat > "$WORK/.needle" <<'NEEDLE'
	if (fastAllowed) {
		await gates.enqueuePush(located, trxId, createdAt).catch(() => undefined);
	}
	return 'emitted';
NEEDLE
	cat > "$WORK/.repl" <<'REPL'
	if (!trxId.startsWith('tag:')) markFastEmitted(trxId);
	if (fastAllowed) {
		await gates.enqueuePush(located, trxId, createdAt).catch(() => undefined);
	}
	return 'emitted';
REPL
	if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
		expect_caught 'R9 the ledger is claimed after the await, so a concurrent twin emits' "$FED" 'concurrent deliveries emitted'
	else
		no 'R9 — the second half of the mutation did not apply (update this harness)'
		restore "$FED"
	fi
else
	no 'R9 — mutation did not apply (the ledger claim moved; update this harness)'
	restore "$FED"
fi

# A mutation series ENDS WITH THE BASELINE (round fourteen's rule).
if [ "$(verdict "$(run_smoke)")" = pass ]; then
	ok 'baseline again — every mutation was restored'
else
	no 'the baseline FAILS after the mutations — a restore went wrong'
fi

echo ''
echo '────────────────────────────────────────────────────────'
if [ "$fails" -eq 0 ]; then
	printf '\033[32m✓ all %d fast-emit-ledger-harness checks passed\033[0m\n' "$pass"
	exit 0
else
	printf '\033[31m✗ %d FAILED, %d passed\033[0m\n' "$fails" "$pass"
	exit 1
fi
