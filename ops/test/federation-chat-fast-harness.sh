#!/usr/bin/env bash
# ops/test/federation-chat-fast-harness.sh — prove federation-chat-fast-smoke.ts
# actually catches the failures it claims to catch.
#
# WHY THIS EXISTS
# The rule here is that a test never seen to fail is not a test, and this smoke
# is the only thing standing behind a claim that matters a great deal: that two
# people on two separate zero-clearnet instances get each other's messages in
# under six seconds, without the fast path becoming a way to inject chat events
# nobody signed.
#
# A smoke that prints twenty-four ticks against correct code has demonstrated
# nothing whatsoever. What makes it a test is that each of its load-bearing
# assertions has been SEEN to fail when the thing it guards is broken. So this
# harness breaks them, one at a time, and requires the smoke to notice.
#
# The mutations are not arbitrary damage. Each one is a plausible change:
# something a later edit might do believing it harmless, or the shortcut the
# original design deliberately did not take.
#
#   M1  Signature verification accepts any signature.
#         → anyone could inject a chat event as anyone. The single most
#           dangerous thing that could regress here.
#   M2  The unknown-sender check is dropped (no posting key on file → allowed).
#         → an attacker invents an account name the instance has never seen and
#           there is no key to check the signature against.
#   M3  Replay suppression removed.
#         → the same signed message replays into the recipient's stream forever.
#   M4  The block check's failure is swallowed and treated as "not blocked".
#         → a database hiccup silently reopens a channel a user closed. This is
#           the fail-OPEN mistake, and it is the easy one to make.
#   M5  The push gate always allows.
#         → any stranger can ring a phone. The spam door.
#   M6  The connection pool is defeated (a fresh dispatcher per call).
#         → every message pays circuit setup again; the six-second target is
#           missed on real transports while loopback tests still look fine.
#   M7  The op-id check is dropped, so any custom_json is dispatched.
#         → the whole federation fan-out fires for unrelated traffic.
#   M8  Peer fan-out runs in series instead of concurrently.
#         → one dead hidden peer delays every live one behind it.
#   M9  A non-2xx answer from a peer is counted as a successful delivery.
#         → the federation reports perfect health while delivering nothing,
#           which is worse than being down: nobody looks.
#   M10 Batching is disabled, so each push carries one transaction.
#         → a peer is capped at one message per round trip; fan-out stops
#           scaling long before the federation does.
#   M11 Batching is made timed instead of opportunistic.
#         → every idle conversation pays a delay to buy throughput that is
#           only needed under load.
#   M12 The receiving endpoint delivers only the first of a batch.
#         → batching becomes actively harmful: perfect coalescing, a 202 back,
#           and every message but the first silently lost.
#   M13 The batch cap is removed.
#         → an unbounded array of signatures to recover, on demand.
#   M14 One malformed entry discards the whole batch.
#         → unrelated senders lose their messages to someone else's bad one.
#   M15 The event-loop yield is removed.
#         → the instance goes deaf while it verifies: no SSE frames, no user
#           requests, exactly when a peer is busiest.
#   M16 Verification moves back onto the response path.
#         → a batch of CPU inside the sender's round trip, and a timing oracle
#           for whether a given account reads its mail here.
#   M17 The intake queue becomes unbounded.
#   M48 The intake bound stops tracking the machine (back to a flat ceiling).
#   M49 The replay memory evicts entries that are still protecting a replay.
#         → an attacker floods the table with their own cheap signed pushes,
#           flushes a captured one out of it, and replays it. The faster the
#           box, the sooner the table turns over.
#         → a slow box accepts messages it cannot verify inside six seconds and
#           tells the sending peer it has them; shedding them would have been
#           honest, because the chain carries a shed message.
#         → a flood becomes memory instead of being shed to the chain.
#   M18 The per-IP ceiling is restored to a single-caller value.
#         → on a hidden transport every peer is 127.0.0.1, so it throttles the
#           whole federation.
#
# M19-M27 came out of the first independent review of this release, M28-M34 out
# of the second — which reviewed the FIXES, and found two more serious bugs in
# them. Both sets are listed because a catalogue that stops halfway reads as the
# full inventory, and the next person to add a mutation copies whatever shape
# they find at the bottom.
#
#   M19 The signature array becomes unbounded again.
#         → dozens of key recoveries per request, no key required, on the loop
#           that serves the SSE streams.
#   M20 The future-expiry bound is removed.
#         → a captured message stays replayable for an hour against a
#           ten-minute memory: wait it out, push again.
#   M21 Batches are bounded by COUNT only.
#         → a quarter-megabyte request against a kilobyte body cap, formed only
#           when a peer is busy, so the fast path turns itself off under load.
#   M22 A 413 discards the batch instead of splitting it.
#         → a peer with a tighter cap silently loses the fast path for every
#           pair it serves.
#   M23 The delivery path stops reading the fast-emit ledger.
#         → two peers pushing the same message emit it twice, to the stream,
#           the replay ring and the push queue alike.
#   M24 The event is stamped with OUR clock instead of the sender's.
#         → transcripts can render out of order, and a replay always lands past
#           the reader's cursor.
#   M25 A JSON body of `null` crashes into a 500.
#         → a peer with a serialisation bug is told THIS instance is broken.
#   M26 The junk-batch 400 reads a process-lifetime counter.
#         → after the first shed ever, an all-rubbish batch is answered 202
#           forever and the peer never learns.
#   M27 One database error abandons the whole verify queue.
#         → the fast path goes quiet until an unrelated push restarts it, while
#           the orphans hold the queue full.
#   M28 The first-contact budget is spent against the VICTIM.
#         → one hostile account empties a seller's allowance and denies the
#           next real buyer. A control turned into a weapon.
#   M29 A refused attempt records itself.
#         → the window never drains, so an attacker holds a pair closed
#           indefinitely at no cost.
#   M30 A peer refusing every batch leaves no trace.
#         → deliveries look healthy while that peer costs one round trip per
#           message.
#   M31 More than one connection per hidden origin.
#         → a second circuit build, which is the entire cost this pool exists
#           to refuse. Invisible to a sequential test.
#   M32 A rotated posting key is never re-read.
#         → a stolen key keeps working after its owner rotates it away, and the
#           owner's own messages stop verifying, silently, forever.
#   M33 The chain correction is written back to the database.
#         → voids ADR-0048's invariant, and lets a hostile RPC node poison a
#           key on demand rather than only at first observation. Caught by
#           fastpath-always-on, not by this smoke — deliberately; see M33.
#   M34 The refresh cooldown is refunded on an empty chain answer.
#   M35 A peer's clearnet origin is discarded once it publishes a hidden one.
#         → a clearnet-only instance (no Tor daemon — the state of a fresh
#           install) picks every peer's .onion, drops the working address in
#           the same row, and has federated chat DEAD with those peers. The
#           highest-consequence bug in this subsystem: it does not degrade the
#           feature, it removes it, on the commonest configuration.
#   M36 A local transport fault is indistinguishable from a peer failure.
#         → our own dead daemon is recorded against a healthy peer, and the
#           sender never learns there is another address worth trying.
#   M37 A PEER failure triggers a failover as well.
#         → the same batch is delivered twice to one instance by two roads.
#   M38 The instance never records which network is down.
#         → one refused connection per peer per message, indefinitely.
#   M39 The breaker may leave a peer with no candidate address.
#         → a peer whose only address is on a briefly-down network is never
#           attempted again, including the attempt that would have found the
#           network back.
#   M40 A hidden peer is dialled over the clearnet transport.
#         → the SOCKS5/CONNECT/tun branches stop being exercised at all.
#   M42 Every local fault is treated as conclusive (Lokinet included).
#         → one peer's stale .loki record takes the network away from every
#           other .loki peer for a minute, and downgrades them to clearnet.
#   M43 Corroboration is raised beyond what one batch can supply.
#         → the Lokinet breaker never fires, so a dead router costs a refused
#           dial per peer per message.
#   M44 Every local fault is treated as ambiguous (Tor included).
#         → every onion peer pays a refused dial while it is collected.
#   M46 The transport stops normalising, so a refused CONNECT is the peer's.
#         → a router configured to refuse tunnels has I2P chat dead, with the
#           failures recorded against healthy peers.
#   M47 The fault's confidence never reaches the breaker.
#         → one refused CONNECT takes I2P away from every other peer.
#   M45 Corroboration is counted per network rather than per address.
#         → the count never passes one; the breaker never fires; the code
#           still reads correctly.
#   M41 A received message is fanned out again by the receiver.
#         → one message becomes one push per peer PER PEER. Forty peers is
#           sixteen hundred requests over hidden transports for a single chat
#           line. It terminates on the replay memory rather than running away,
#           which is what makes it look survivable in a three-instance test.
#         → every junk signature buys a fresh RPC call: a reflected amplifier
#           pointed at whichever node this instance is using.
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

# ── Hermetic copy ────────────────────────────────────────────────────
# The smoke imports across the indexer's source, so the copy has to carry the
# workspace layout the tsconfig paths resolve against. node_modules is symlinked
# rather than copied — it is large, and nothing here mutates it.
mkdir -p "$WORK"
cp -r "$REPO/apps" "$WORK/apps"
cp -r "$REPO/packages" "$WORK/packages"
# ops/ too: M33 runs fastpath-always-on-smoke inside this copy, and that smoke
# reads ops/env/indexer.env.example. Without it the smoke dies on ENOENT — which
# a naive check reads as "the mutation survived", the exact crash-as-pass trap
# this harness refuses to fall into everywhere else.
cp -r "$REPO/ops" "$WORK/ops"
cp "$REPO/tsconfig.smoke.json" "$WORK/" 2>/dev/null || true
cp "$REPO/tsconfig.json" "$WORK/" 2>/dev/null || true
cp "$REPO/package.json" "$WORK/" 2>/dev/null || true
ln -s "$REPO/node_modules" "$WORK/node_modules"

SMOKE="$WORK/apps/indexer/scripts/federation-chat-fast-smoke.ts"
FED="$WORK/apps/indexer/src/indexer/chatFastFederation.ts"
POOL="$WORK/apps/indexer/src/indexer/hiddenServicePool.ts"
ROUTE="$WORK/apps/indexer/src/api/federationChatFast.ts"
BUDGET="$WORK/apps/indexer/src/indexer/fastNotifyBudget.ts"
# The notify gate moved into one shared module in the v1.18.0 deep-deep (FC-2);
# the first-contact budget is spent there now, not in the intake route.
GATE="$WORK/apps/indexer/src/indexer/fastNotifyGate.ts"

run_smoke(){
	# TSX_TSCONFIG_PATH must be cleared: when this harness runs from the battery
	# wrapper, the outer tsx exports it to every child as a RELATIVE path, which
	# does not resolve from this temp directory, and tsx dies before the smoke
	# runs at all. verdict() additionally refuses to read a crash as a result.
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

# Apply an exact literal substitution, and REFUSE to continue if the text was
# not found. A mutation that silently fails to apply produces a green run
# against unmutated source, which is the single most misleading outcome this
# harness could have.
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

# A mutation must make the smoke FAIL, and fail for the stated reason. A crash
# is never counted as a catch: a smoke that died on a syntax error did not
# detect anything, and treating that as success is exactly how a guard ends up
# guarding nothing.
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
			printf '%s\n' "$out" | tail -5 | sed 's/^/        /' ;;
	esac
	restore "$file"
}

echo 'federation-chat-fast-harness — is the smoke actually a test?'
echo ''

# ── 0. Baseline: the smoke passes against unmutated source ───────────
# If this fails, every "caught" below is meaningless — a smoke that fails on
# correct code fails on everything.
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

# ── M1. Signature verification accepts anything ──────────────────────
# Re-aimed after the v1.18.0 deep-deep (rv1-3): recovery is lazy now, behind a
# `signedBy(key)` helper, so "accepts any signature" is its verdict forced true.
snapshot "$FED"
printf '%s\n' '	let signedByPostingKey = signedBy(postingKey);' > "$WORK/.needle"
printf '%s\n' '	let signedByPostingKey = true;' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M1 signature check accepts any signature' "$FED" 'forged'
else
	no 'M1 — mutation did not apply (the verification shape changed; update this harness)'
	restore "$FED"
fi

# ── M2. Unknown sender is allowed through ────────────────────────────
# The previous version of this mutation renamed the REJECT CODE and nothing
# else — the push was still refused, so all it proved was that the smoke reads a
# string literal. This opens the actual hole: skip the refusal, and let the
# absent key verify anything.
snapshot "$FED"
printf '%s' '	if (postingKey === null || postingKey.length === 0) {' > "$WORK/.needle"
printf '%s' '	if (false) {' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	# Second half re-aimed after the v1.18.0 deep-deep (rv1-3, lazy recovery):
	# the absent key is what makes the signature check pass.
	printf '%s\n' '	let signedByPostingKey = signedBy(postingKey);' > "$WORK/.needle"
	printf '%s\n' '	let signedByPostingKey = postingKey === null || signedBy(postingKey);' > "$WORK/.repl"
	if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
		expect_caught 'M2 a sender with no posting key on file is accepted' "$FED" 'unverifiable sender'
	else
		no 'M2 — the second half of the mutation did not apply (update this harness)'
		restore "$FED"
	fi
else
	no 'M2 — mutation did not apply (the unknown-sender guard changed; update this harness)'
	restore "$FED"
fi

# ── M3. Replay suppression removed ───────────────────────────────────
snapshot "$FED"
printf '%s' '	if (seen.has(trxId)) return false;' > "$WORK/.needle"
printf '%s' '	if (false) return false;' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M3 replay suppression removed' "$FED" 'replay'
else
	no 'M3 — mutation did not apply (the replay check shape changed; update this harness)'
	restore "$FED"
fi

# ── M4. The block check fails OPEN instead of closed ─────────────────
snapshot "$FED"
printf '%s' "		return 'block_check_failed';" > "$WORK/.needle"
printf '%s' "		return 'emitted';" > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M4 a failing block check fails OPEN' "$FED" 'block check'
else
	no 'M4 — mutation did not apply (the fail-closed branch changed; update this harness)'
	restore "$FED"
fi

# ── M5. The push gate always allows ──────────────────────────────────
# Mutating the smoke's OWN gate stub would prove nothing, so this mutates the
# federation module's use of the gate: the result is ignored and a push is
# always enqueued, which is precisely the spam door.
snapshot "$FED"
# The gate is judged at ARRIVAL time since the v1.18.0 deep-deep (FC-6), so the
# call reads `gateAt`; the mutation is unchanged in kind.
printf '%s\n' '	const fastAllowed = await gates.fastNotifyAllowed(located, gateAt).catch(() => false);' > "$WORK/.needle"
printf '%s\n' '	const fastAllowed = true;' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M5 the push gate always allows' "$FED" 'spam door'
else
	no 'M5 — mutation did not apply (the push gate call changed; update this harness)'
	restore "$FED"
fi

# ── M6. The connection pool is defeated ──────────────────────────────
# A fresh dispatcher every call — which is exactly what the pre-existing
# fetchJsonViaHiddenService does, and the reason this module had to be written.
snapshot "$POOL"
printf '%s' '	const existing = pool.get(key);' > "$WORK/.needle"
printf '%s' '	const existing = undefined as ReturnType<typeof pool.get>;' > "$WORK/.repl"
if mutate "$POOL" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M6 the connection pool is defeated (fresh dispatcher per call)' "$POOL" 'reuse'
else
	no 'M6 — mutation did not apply (the pool lookup changed; update this harness)'
	restore "$POOL"
fi

# ── M7. Any custom_json is dispatched to the whole federation ────────
snapshot "$FED"
printf '%s' 'if ((op[1] as { id?: unknown })?.id === CHAT_OP_ID) return true;' > "$WORK/.needle"
printf '%s' 'return true;' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M7 any custom_json is fanned out to the federation' "$FED" 'non-chat'
else
	no 'M7 — mutation did not apply (containsChatOp changed; update this harness)'
	restore "$FED"
fi

# ── M8. Peer fan-out runs in series ──────────────────────────────────
# NOTE: the obvious mutation — swapping a Promise.all for a serial await loop —
# was not a mutation at all back when the fan-out mapped over already-started
# promises, and an earlier version of this harness reported "SURVIVED" while
# blaming the smoke for its own bug. Production now pushes per peer from
# PeerSender, so serialisation has to be imposed where the push actually
# happens: a process-wide lock around the one function that talks to a peer.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
				const res = await sendBatchToPeer(q.peer, batch, this.deps, this.reachability, (f) =>
					this.note(f)
				);
NEEDLE
cat > "$WORK/.repl" <<'REPL'
				const res = await serialiseForMutationTest(() =>
					sendBatchToPeer(q.peer, batch, this.deps, this.reachability, (f) => this.note(f))
				);
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	cat >> "$FED" <<'EOF'

let __mutationLock: Promise<unknown> = Promise.resolve();
async function serialiseForMutationTest<T>(fn: () => Promise<T>): Promise<T> {
	const prev = __mutationLock;
	let release: () => void = () => undefined;
	__mutationLock = new Promise<void>((r) => {
		release = r;
	});
	await prev;
	try {
		return await fn();
	} finally {
		release();
	}
}
EOF
	expect_caught 'M8 peer fan-out runs in series' "$FED" 'serial fan-out'
else
	no 'M8 — mutation did not apply (the peer push call changed; update this harness)'
	restore "$FED"
fi

# ── M9. A peer that answers badly is counted as delivered ────────────
# The status check is one line, and dropping it produces a federation that
# reports perfect health while delivering nothing — the worst failure mode
# available, because nobody has any reason to investigate it.
snapshot "$FED"
printf '%s' '		if (res.status >= 200 && res.status < 300) return null;' > "$WORK/.needle"
printf '%s' '		return null;' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M9 a peer answering 500 is counted as a delivery' "$FED" 'answering 500'
else
	no 'M9 — mutation did not apply (the status check changed; update this harness)'
	restore "$FED"
fi

# ── M10. Batching is disabled (one transaction per push) ─────────────
# The shape the code had before batching, and the shape a "simplification" would
# produce. It is invisible on a single message and caps a peer at one message
# per round trip, which a federation of any size outruns.
snapshot "$FED"
printf '%s' '				const batch = this.takeBatch(q.pending);' > "$WORK/.needle"
printf '%s' '				const batch = q.pending.splice(0, 1).map((e) => e.trx);' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M10 messages are no longer batched' "$FED" 'round trips'
else
	no 'M10 — mutation did not apply (the batch splice changed; update this harness)'
	restore "$FED"
fi

# ── M11. Batching is made TIMED rather than opportunistic ────────────
# The tempting "improvement": wait a moment before sending, so more messages can
# join. It raises batch sizes and taxes every idle conversation to do it — the
# exact trade this design refused.
snapshot "$FED"
printf '%s' '			if (!q.inFlight) void this.pump(key);' > "$WORK/.needle"
printf '%s' '			if (!q.inFlight) setTimeout(() => void this.pump(key), 250);' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M11 an idle peer is made to wait before its push leaves' "$FED" 'before leaving'
else
	no 'M11 — mutation did not apply (the pump trigger changed; update this harness)'
	restore "$FED"
fi

# ── M12. The endpoint processes only the first of a batch ────────────
# The failure that makes batching actively harmful: the sender coalesces
# perfectly, the peer answers 202, and every message but the first is silently
# lost. Nothing in a delivery count would show it.
snapshot "$ROUTE"
printf '%s' '		for (const trx of batch) {' > "$WORK/.needle"
printf '%s' '		for (const trx of batch.slice(0, 1)) {' > "$WORK/.repl"
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M12 only the first message in a batch is delivered' "$ROUTE" 'delivered message'
else
	no 'M12 — mutation did not apply (the batch loop changed; update this harness)'
	restore "$ROUTE"
fi

# ── M13. The batch cap is removed ────────────────────────────────────
# Each entry costs a signature recovery, so an unbounded array is a cheap way to
# make an instance burn CPU on demand.
snapshot "$ROUTE"
printf '%s' '			if (many.length > BATCH_MAX) {' > "$WORK/.needle"
printf '%s' '			if (false) {' > "$WORK/.repl"
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M13 an oversized batch is accepted' "$ROUTE" 'expected 400'
else
	no 'M13 — mutation did not apply (the batch cap changed; update this harness)'
	restore "$ROUTE"
fi

# ── M14. One bad entry discards the whole batch ──────────────────────
# A batch is an accident of timing: unrelated messages from unrelated senders.
# Failing all of them because one was malformed loses other people's messages.
snapshot "$ROUTE"
# The check's result is now held in `structural` (the post-cut review made the
# call itself per-entry safe, R6, and the canonical copy rides on it, R1).
cat > "$WORK/.needle" <<'NEEDLE'
			if (!structural.ok) {
				rejected++;
				continue;
			}
NEEDLE
cat > "$WORK/.repl" <<'REPL'
			if (!structural.ok) {
				return c.json(errorBody('bad_request', 'malformed entry'), 400);
			}
REPL
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M14 one malformed entry discards the good messages beside it' "$ROUTE" 'mixed batch'
else
	no 'M14 — mutation did not apply (the per-entry handling changed; update this harness)'
	restore "$ROUTE"
fi

# ── M15. The event-loop yield is removed ─────────────────────────────
# TWO changes, because one is not enough to expose the bug and it took a
# measurement to find that out. Removing the yield alone changes nothing today:
# verifyPushedChatOp does `await import('@beblurt/dblurt')` per call, and Node's
# ESM loader settles that on a macrotask, so the loop keeps breathing by
# accident. Hoisting that import is an obvious optimisation someone will make.
# Do both — cache the import, drop the yield — and the instance goes deaf while
# it verifies, which is the regression actually worth guarding.
snapshot "$ROUTE"
snapshot "$FED"
printf '%s' '				await yieldToEventLoop();' > "$WORK/.needle"
printf '%s' '				await Promise.resolve();' > "$WORK/.repl"
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	printf '%s' '	const { cryptoUtils, Signature } = await import(FED_DBLURT);' > "$WORK/.needle"
	printf '%s' '	const { cryptoUtils, Signature } = __dblurtCachedForMutationTest;' > "$WORK/.repl"
	# The real line has a literal module specifier; substitute it in.
	sed -i "s|FED_DBLURT|'@beblurt/dblurt'|" "$WORK/.needle"
	if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
		cat >> "$FED" <<'EOF'

const __dblurtCachedForMutationTest = await import('@beblurt/dblurt');
EOF
		expect_caught 'M15 the event loop is starved while a batch verifies' "$ROUTE" 'went silent'
		restore "$FED"
	else
		no 'M15 — the import half of the mutation did not apply (update this harness)'
		restore "$ROUTE"
		restore "$FED"
	fi
else
	no 'M15 — mutation did not apply (the yield changed; update this harness)'
	restore "$ROUTE"
	restore "$FED"
fi

# ── M16. Verification moves back onto the response path ──────────────
# Puts a batch's worth of signature recovery inside the sender's round trip, and
# makes the answer take measurably longer for a message we cared about than for
# one we did not — a stopwatch that says whether an account reads its mail here.
snapshot "$ROUTE"
printf '%s' '		void work();' > "$WORK/.needle"
printf '%s' '		await work();' > "$WORK/.repl"
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M16 the crypto is back on the response path' "$ROUTE" 'inline verification'
else
	no 'M16 — mutation did not apply (the deferred work call changed; update this harness)'
	restore "$ROUTE"
fi

# ── M17. The intake queue becomes unbounded ──────────────────────────
# A flood then becomes memory, and the instance queues work it cannot finish
# inside anyone's six seconds instead of letting the chain carry it.
# RETARGETED in round twelve. The needle used to be
# `if (queue.length >= VERIFY_QUEUE_MAX) {`, and F18 replaced that constant with
# a bound derived from the measured verification cost. The property — the queue
# is bounded at all — did not move; the line it lives on did. `mutate()` refused
# the stale needle rather than reporting a pass, which is the entire reason that
# refusal exists and the third time in this release it has earned its keep.
snapshot "$ROUTE"
printf '%s' '			if (queue.length >= admissionDepth()) {' > "$WORK/.needle"
printf '%s' '			if (false) {' > "$WORK/.repl"
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M17 the intake queue is unbounded' "$ROUTE" 'unbounded'
else
	no 'M17 — mutation did not apply (the queue bound changed; update this harness)'
	restore "$ROUTE"
fi

# ── M48. The admission bound stops tracking the machine ──────────────
# F18's whole point: the depth that still fits six seconds depends on what a
# verification COSTS on this box. Pin the bound back to the flat ceiling and a
# fast machine behaves identically — which is exactly why three mutations
# against this fix survived when it was first written, and why the arithmetic
# was extracted into a pure function the smoke can drive at costs no CI machine
# produces. A slow VPS would go back to accepting messages it cannot deliver
# inside the budget, and telling the sending peer it had them.
snapshot "$ROUTE"
printf '%s' '	const derived = Math.floor(QUEUE_WAIT_ALLOWANCE_MS / Math.max(verifyCostMs, 0.1));' > "$WORK/.needle"
printf '%s' '	const derived = VERIFY_QUEUE_MAX;' > "$WORK/.repl"
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M48 the intake bound ignores the measured cost' "$ROUTE" 'not derived'
else
	no 'M48 — mutation did not apply (the derivation changed; update this harness)'
	restore "$ROUTE"
fi

# ── M49. The replay memory forgets an entry that is still protecting ─
# `seen` is what stops a captured push being delivered twice. It is bounded, and
# if it evicts the oldest entry whenever it is full then an attacker — who signs
# transactions of their own for free — decides when it forgets. Measured: 50,000
# entries turn over in 288 s at this box's verification speed, inside the 480 s a
# captured push stays valid, and a FASTER box turns over sooner. Refusing to
# evict a protected entry is the fix; this mutation takes it back out.
snapshot "$FED"
# The entry records its signer since the v1.18.0 deep-deep (FC-4, per-signer
# quota), so the eviction rule reads `oldest.at`.
printf '%s\n' '		if (now - oldest.at < REPLAY_PROTECTED_MS) {' > "$WORK/.needle"
printf '%s\n' '		if (false) {' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M49 the replay memory can be flushed to make room for a replay' "$FED" 'REPLAYED'
else
	no 'M49 — mutation did not apply (the eviction rule changed; update this harness)'
	restore "$FED"
fi

# ── M18. The per-IP ceiling is restored to a single-caller value ─────
# The original 240/min. Harmless-looking, and on a hidden instance it throttles
# the entire federation, because every peer arrives as 127.0.0.1.
snapshot "$ROUTE"
printf '%s' 'const PUSHES_PER_MIN = 6_000;' > "$WORK/.needle"
printf '%s' 'const PUSHES_PER_MIN = 240;' > "$WORK/.repl"
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M18 the federation is throttled by a single-caller rate limit' "$ROUTE" 'rate-limited'
else
	no 'M18 — mutation did not apply (the rate limit changed; update this harness)'
	restore "$ROUTE"
fi

# ── M19. The signature array is unbounded again ──────────────────────
# Every signature costs a full elliptic-curve recovery, in a loop that does not
# yield, and a request full of canonical garbage needs no key and no valid
# message. This is the cheapest way to hold the event loop that serves the SSE
# streams this whole mechanism exists to feed.
snapshot "$FED"
printf '%s' '	if (trx.signatures.length > MAX_SIGNATURES) {' > "$WORK/.needle"
printf '%s' '	if (false) {' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M19 a transaction may carry unlimited signatures' "$FED" 'unbounded signature array'
else
	no 'M19 — mutation did not apply (the signature cap changed; update this harness)'
	restore "$FED"
fi

# ── M20. The replay window is reopened ───────────────────────────────
# Graphene allows an expiry an hour out; the replay memory remembers ten
# minutes. Without the future bound, a captured message stays pushable long
# after the instance has forgotten seeing it — so an attacker waits, and pushes
# it again.
snapshot "$FED"
# Since the post-cut review (R1) the expiration is a validated canonical string
# before this line runs, so the finite check moved up and the bound stands alone.
printf '%s\n' '	if (exp > now.getTime() + MAX_FUTURE_MS) {' > "$WORK/.needle"
printf '%s\n' '	if (false) {' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M20 a transaction may declare an hour-long replay window' "$FED" 'replay window for itself'
else
	no 'M20 — mutation did not apply (the future-expiry bound changed; update this harness)'
	restore "$FED"
fi

# ── M21. Batches are bounded by COUNT only ───────────────────────────
# The bound the feature shipped with. Sixty-four maximum-length messages is a
# quarter of a megabyte against a body cap measured in kilobytes — and batches
# form only when a peer is already busy, so the fast path works while idle and
#413s itself off under exactly the load it exists to carry.
snapshot "$FED"
printf '%s' '			if (n > 0 && total + next.bytes > BATCH_MAX_BYTES) break;' > "$WORK/.needle"
printf '%s' '			if (false) break;' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M21 a batch may exceed any peer body cap' "$FED" 'over the'
else
	no 'M21 — mutation did not apply (the byte budget changed; update this harness)'
	restore "$FED"
fi

# ── M22. A 413 drops the batch ───────────────────────────────────────
# What the code did before: a peer with a tighter body cap silently loses the
# fast path for every pair it serves, and the sender's counters say "failed"
# with no indication that the messages were perfectly acceptable one at a time.
snapshot "$FED"
printf '%s' '				if (res !== null && res.status === 413 && batch.length > 1) {' > "$WORK/.needle"
printf '%s' '				if (false) {' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M22 a peer that refuses the batch SIZE loses the messages' "$FED" 'of 12 arrived'
else
	no 'M22 — mutation did not apply (the 413 fallback changed; update this harness)'
	restore "$FED"
fi

# ── M23. The delivery path stops consulting the ledger ───────────────
# The replay memory does not cover this: it is written inside verification, and
# local delivery never goes through verification. Two peers pushing the same
# message, or an instance that does not recognise its own directory row, emit it
# twice — to the SSE stream, the replay ring and the push queue alike.
snapshot "$FED"
printf '%s' '	if (wasFastEmitted(trxId)) return '"'"'emitted'"'"';' > "$WORK/.needle"
printf '%s' '	if (false) return '"'"'emitted'"'"';' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M23 the same transaction is emitted twice' "$FED" 'emitted twice'
else
	no 'M23 — mutation did not apply (the ledger check changed; update this harness)'
	restore "$FED"
fi

# ── M24. The event is stamped with OUR clock ─────────────────────────
# The two routes then disagree: the head tailer uses the block timestamp and
# this uses arrival. A transcript sorts strictly on it, and a replayed message
# stamped "now" always lands past the reader's cursor.
snapshot "$FED"
# Read off the CANONICAL copy since the post-cut review (R1), not the peer's object.
printf '%s\n' '	return { ok: true, located, trxId, sentAt: sentAtFromExpiry(canonical.expiration, now) };' > "$WORK/.needle"
printf '%s\n' '	return { ok: true, located, trxId, sentAt: new Date() };' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M24 the delivered event carries arrival time, not send time' "$FED" 'from when the sender actually sent it'
else
	no 'M24 — mutation did not apply (sentAt changed; update this harness)'
	restore "$FED"
fi

# ── M25. A malformed body is answered 500 ────────────────────────────
snapshot "$ROUTE"
cat > "$WORK/.needle" <<'NEEDLE'
		const body: { trx?: unknown; trxs?: unknown } =
			typeof json === 'object' && json !== null ? (json as { trx?: unknown; trxs?: unknown }) : {};
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		const body = json as { trx?: unknown; trxs?: unknown };
REPL
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M25 a JSON body of `null` crashes into a 500' "$ROUTE" 'was answered 500'
else
	no 'M25 — mutation did not apply (the body guard changed; update this harness)'
	restore "$ROUTE"
fi

# ── M26. `shed` is read as a per-request flag again ──────────────────
# A lifetime counter used as a per-request condition: once the instance has ever
# shed a single message, an all-rubbish batch is answered 202 forever and the
# peer never learns it is sending garbage.
snapshot "$ROUTE"
printf '%s' '		if (queued === 0 && shedHere === 0 && rejected > 0) {' > "$WORK/.needle"
printf '%s' '		if (queued === 0 && shed === 0 && rejected > 0) {' > "$WORK/.repl"
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M26 the junk-batch 400 depends on process history' "$ROUTE" 'after shedding once'
else
	no 'M26 — mutation did not apply (the shed condition changed; update this harness)'
	restore "$ROUTE"
fi

# ── M27. One database error abandons the whole verify queue ──────────
# The try goes INSIDE the loop. Around it, a single transient pg failure unwinds
# the loop and orphans every transaction still queued, with nothing scheduled to
# come back for them — the fast path goes quiet until the next inbound push
# happens to restart the worker, while the orphans occupy the queue until it is
# permanently full and shedding everything.
snapshot "$ROUTE"
# The worker's call gained `network: false` and a comment above it (R3); the
# try is the line before that comment now.
cat > "$WORK/.needle" <<'NEEDLE'
				try {
					// network:false — THE WORKER NEVER WAITS ON THE CHAIN. A message
NEEDLE
cat > "$WORK/.repl" <<'REPL'
				{
					// network:false — THE WORKER NEVER WAITS ON THE CHAIN. A message
REPL
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	# The `catch` that used to pair with that `try` is now orphaned, so remove it
	# too — leaving the loop body unguarded, which is the bug.
	cat > "$WORK/.needle" <<'NEEDLE'
				} catch {
					// Counted, not swallowed silently: a rising `refused` with no
					// corresponding peer complaint is how an operator sees that
					// something local is failing. The message is not lost — the
					// chain is still carrying it.
					refused++;
				}
NEEDLE
	printf '%s' '				}' > "$WORK/.repl"
	if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
		expect_caught 'M27 one database error abandons the verify queue' "$ROUTE" 'healthy messages were delivered'
	else
		no 'M27 — the second half of the mutation did not apply (update this harness)'
		restore "$ROUTE"
	fi
else
	no 'M27 — mutation did not apply (the per-item guard changed; update this harness)'
	restore "$ROUTE"
fi

# ── M28. The first-contact budget goes back to being per-VICTIM ──────
# The shape this control had when it was first written, and the reason it was
# rewritten: order permlinks are public and this endpoint is unauthenticated, so
# a budget belonging to the RECIPIENT is spendable by anyone. One hostile
# account empties a seller's allowance every minute for free, and the next real
# buyer gets no push, no badge and no replay — a targeted denial aimed at the
# victim, built out of a control meant to protect them.
#
# Re-aimed after the v1.18.0 deep-deep (FC-2): the budget is spent inside the
# one shared gate, fastNotifyGate.ts, which the intake route now calls with
# `meterFirstContact: true`. The smoke drives that real gate.
snapshot "$GATE"
cat > "$WORK/.needle" <<'NEEDLE'
		return spendFastNotifyBudget(located.signer, located.recipient);
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		return spendFastNotifyBudget(located.recipient, located.recipient);
REPL
if mutate "$GATE" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M28 the gate spends the victim allowance' "$GATE" 'refused because the first had flooded'
else
	no 'M28 — mutation did not apply (the budget call changed; update this harness)'
	restore "$GATE"
fi

# ── M29. A refused attempt holds its own window open ─────────────────
# Recording the refusal re-arms the window on every attempt, so a pair under
# sustained flooding never drains — the attacker holds it closed indefinitely at
# no cost, which is worse than having no cap.
snapshot "$BUDGET"
cat > "$WORK/.needle" <<'NEEDLE'
		budget.delete(key);
		budget.set(key, live);
		return false;
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		live.push(now);
		budget.delete(key);
		budget.set(key, live);
		return false;
REPL
if mutate "$BUDGET" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M29 refusals hold the window open forever' "$BUDGET" 'kept the window from draining'
else
	no 'M29 — mutation did not apply (the refusal path changed; update this harness)'
	restore "$BUDGET"
fi

# ── M30. A peer refusing every batch is invisible ────────────────────
# The split-and-retry keeps messages flowing, which is exactly why it can hide
# the condition: deliveries look healthy while that peer turns each batch into
# up to sixty-four sequential round trips.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
					this.note({
						origin: q.peer.origin,
						reason: `HTTP 413 — batch of ${batch.length} refused, sent one at a time`,
						status: 413
					});
NEEDLE
printf '%s' '' > "$WORK/.repl"
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M30 a batch-refusing peer leaves no trace' "$FED" 'no trace at all'
else
	no 'M30 — mutation did not apply (the 413 record changed; update this harness)'
	restore "$FED"
fi

# ── M31. More than one connection per hidden origin ──────────────────
# A second connection to a .onion is a second CIRCUIT BUILD — 30-60 seconds on a
# real hidden transport, and the entire cost this pool exists to refuse. The
# sequential reuse check cannot see this (one connection is reused at any pool
# size when requests are awaited one at a time), which is why this constant went
# unpinned through the whole first draft.
snapshot "$POOL"
printf '%s' 'const CONNECTIONS_PER_ORIGIN = 1;' > "$WORK/.needle"
printf '%s' 'const CONNECTIONS_PER_ORIGIN = 4;' > "$WORK/.repl"
if mutate "$POOL" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M31 a hidden origin opens more than one connection' "$POOL" 'extra tunnel'
else
	no 'M31 — mutation did not apply (the connection cap changed; update this harness)'
	restore "$POOL"
fi

# ── M32. A rotated posting key stops verifying ───────────────────────
# `accounts.posting_pubkey` is write-once, so without the re-read a stolen key
# keeps working after its owner rotates it away — and the owner's own messages
# stop verifying, silently, for as long as the stale column survives.
snapshot "$FED"
# The re-read now carries the worker's network flag and can report "pending"
# (R3), so it is a statement inside a try rather than a one-line const.
cat > "$WORK/.needle" <<'NEEDLE'
			fresh = await lookupPostingKey(located.signer, {
				refresh: true,
				...(network === false ? { network: false } : {})
			});
NEEDLE
cat > "$WORK/.repl" <<'REPL'
			fresh = null;
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M32 a rotated key is never re-read from the chain' "$FED" 'rotated key was refused'
else
	no 'M32 — mutation did not apply (the refresh call changed; update this harness)'
	restore "$FED"
fi

# ── M33. The chain correction is written back to the database ────────
# The line that voided ADR-0048's invariant the first time. It is also a
# security regression on its own: a write-once column can be poisoned by a
# hostile RPC node only at first observation, while a persisted re-read can be
# poisoned on demand, for any account, by answering one query.
snapshot "$FED"
# The store moved into `readFromChain` (v1.18.0 deep-deep, rv1-5: one read in
# flight per account), one indent shallower; `db` is still in scope there.
printf '%s\n' '		rememberFreshKey(account, fresh, Date.now());' > "$WORK/.needle"
cat > "$WORK/.repl" <<'REPL'
		await db
			.query('UPDATE accounts SET posting_pubkey = $2 WHERE name = $1', [account, fresh])
			.catch(() => undefined);
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	# Caught by the INVARIANT smoke, not the federation one. That is the point:
	# the federation smoke has no opinion about where a posting key is stored,
	# and would stay green. The thing that must notice a write on this path is
	# the check that exists to defend "the fast path never writes the database" —
	# and until this release it read only headTailer.ts, which is exactly how the
	# original write got in.
	out="$( ( cd "$WORK" && unset TSX_TSCONFIG_PATH && timeout 300 "$TSX" --tsconfig tsconfig.smoke.json apps/ops-cli/scripts/fastpath-always-on-smoke.ts 2>&1 ) )"
	# THREE outcomes, not two. A smoke that crashes prints neither marker, and
	# reading that as "survived" would be wrong in the same way as reading it as
	# "caught" — it is no verdict at all. This cost a debugging round when the
	# harness did not copy ops/ and the smoke died on a missing file.
	if grep -q 'checks failed' <<<"$out"; then
		ok 'M33 the chain correction is persisted — caught by fastpath-always-on'
	elif grep -q 'fastpath-always-on checks passed' <<<"$out"; then
		no 'M33 SURVIVED. A write on the fast path is no longer detected.'
	else
		no 'M33 — fastpath-always-on CRASHED; no verdict. Not counted as a catch.'
		printf '%s\n' "$out" | tail -4 | sed 's/^/        /'
	fi
	restore "$FED"
else
	no 'M33 — mutation did not apply (the correction store changed; update this harness)'
	restore "$FED"
fi

# ── M34. The refresh cooldown is released on any failure ─────────────
# A failing signature costs an attacker nothing. Release the cooldown whenever
# the chain is unhelpful and every junk signature buys a fresh RPC call — a
# reflected amplifier pointed at whichever node this instance is using.
snapshot "$FED"
# Same branch, now in `readFromChain` (v1.18.0 deep-deep, rv1-5), one indent
# shallower.
cat > "$WORK/.needle" <<'NEEDLE'
		if (fresh === null || fresh.length === 0) {
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		if (fresh === null || fresh.length === 0) {
			releaseRefresh(account);
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M34 an empty chain answer refunds the cooldown' "$FED" 'chain reads'
else
	no 'M34 — mutation did not apply (the null-answer branch changed; update this harness)'
	restore "$FED"
fi

# ── M35. The peer's clearnet origin is discarded, as it used to be ────
# THE BUG THIS RELEASE'S TRANSPORT WORK EXISTS FOR. Prefer a hidden address and
# throw the rest away, and a clearnet-only instance — a fresh install, with no
# Tor daemon — picks the .onion of every onion-publishing peer and has federated
# chat completely dead, silently, forever.
snapshot "$FED"
#
# Re-aimed after the v1.18.0 deep-deep (TP-C1): the origin is now added under a
# hidden-only condition, so the mutation adds the old "only if nothing hidden
# was found" guard to that condition. Re-aimed again in v1.20.0: a hidden
# origin is now dialled as http (S9, hiddenOriginForDial) and the call wraps.
cat > "$WORK/.needle" <<'NEEDLE'
	if (originHidden || !hiddenOnly)
		add(originHidden ? hiddenOriginForDial(row.origin) : row.origin, originHidden);
NEEDLE
cat > "$WORK/.repl" <<'REPL'
	if (addresses.length === 0 && (originHidden || !hiddenOnly))
		add(originHidden ? hiddenOriginForDial(row.origin) : row.origin, originHidden);
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M35 a hidden address discards the clearnet origin' "$FED" 'did not reach the peer'
else
	no 'M35 — mutation did not apply (the address builder changed; update this harness)'
	restore "$FED"
fi

# ── M36. A local transport fault is never detected ───────────────────
# Without this the sender cannot tell "our Tor is down" from "the peer is down",
# so it never fails over and it blames a healthy peer for a fault on this box.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
		const localFault = isProxyUnavailable(err);
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		const localFault = false;
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M36 our own dead daemon is blamed on the peer' "$FED" 'did not reach the peer'
else
	no 'M36 — mutation did not apply (the failure classifier changed; update this harness)'
	restore "$FED"
fi

# ── M37. A peer failure triggers a failover too ──────────────────────
# A peer that ANSWERED has been reached. Dialling its other address is not a
# retry, it is a second delivery of the same batch — and the peer cannot tell
# those apart.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
		if (res.localFault !== true) {
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		if (false) {
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M37 a peer that refused is dialled again elsewhere' "$FED" 'two roads'
else
	no 'M37 — mutation did not apply (the failover condition changed; update this harness)'
	restore "$FED"
fi

# ── M38. The instance never learns which network is down ─────────────
# One refused connection per peer per message, forever. On a federation of any
# size that is the dominant cost of a dead daemon.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
		reach.reportAddressFault(network, peerKey(peer), Date.now(), res.confidence);
		supersede(res);
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		supersede(res);
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M38 a dead network is re-dialled for every message' "$FED" 'dead transport'
else
	no 'M38 — mutation did not apply (the reachability tracker changed; update this harness)'
	restore "$FED"
fi

# ── M39. The breaker can silence a peer entirely ─────────────────────
# Drop the "unless that leaves nothing" clause and a peer whose only address is
# on a briefly-down network is never attempted again — including the attempt
# that would have discovered the network is back.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
	const order = usable.length > 0 ? usable : all;
NEEDLE
cat > "$WORK/.repl" <<'REPL'
	const order = usable;
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M39 a down network silences a peer that has no other address' "$FED" 'only network is down'
else
	no 'M39 — mutation did not apply (the candidate ordering changed; update this harness)'
	restore "$FED"
fi

# ── M40. The I2P branch is routed like clearnet ──────────────────────
# The three hidden networks are three separate implementations. Until this
# release only Tor was exercised anywhere, so a change that collapsed the I2P
# branch would have been invisible.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
		const res = addr.hidden
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		const res = false
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M40 a hidden peer is dialled over the clearnet transport' "$FED" ''
else
	no 'M40 — mutation did not apply (the transport branch changed; update this harness)'
	restore "$FED"
fi

# ── M41. A received message is fanned out again ──────────────────────
# The fan-out is ONE hop, and nothing enforces that except `dispatchIfChat`
# being called from the broadcast route and nowhere else. Re-dispatch on receipt
# turns one message into one push per peer PER PEER: forty peers means sixteen
# hundred requests over hidden transports for a single chat line. It terminates
# on the replay memory rather than running away, which is exactly what makes it
# dangerous — it looks survivable in a three-instance test and melts a real
# federation. It is also an easy line to write with a plausible reason attached
# ("relay it on, in case the sender could not reach that peer"), and the answer
# is that the chain already carries that case durably.
snapshot "$ROUTE"
printf '%s' 'export function federationChatFastRoute(' > "$WORK/.needle"
cat > "$WORK/.repl" <<'REPL'
function refanForMutationTest(d: { dispatchIfChat(t: unknown): void }, t: unknown): void {
	d.dispatchIfChat(t);
}

export function federationChatFastRoute(
REPL
if mutate "$ROUTE" "$WORK/.needle" "$WORK/.repl"; then
	# Caught by the INVARIANT smoke, like M33 — the federation smoke has no
	# opinion about who fans out, and would stay green.
	out="$( ( cd "$WORK" && unset TSX_TSCONFIG_PATH && timeout 300 "$TSX" --tsconfig tsconfig.smoke.json apps/ops-cli/scripts/fastpath-always-on-smoke.ts 2>&1 ) )"
	if grep -q 'checks failed' <<<"$out"; then
		ok 'M41 a received message is re-fanned to every peer — caught by fastpath-always-on'
	elif grep -q 'fastpath-always-on checks passed' <<<"$out"; then
		no 'M41 SURVIVED. The one-hop fan-out is no longer guarded.'
	else
		no 'M41 — fastpath-always-on CRASHED; no verdict. Not counted as a catch.'
		printf '%s\n' "$out" | tail -4 | sed 's/^/        /'
	fi
	restore "$ROUTE"
else
	no 'M41 — mutation did not apply (the route signature changed; update this harness)'
	restore "$ROUTE"
fi

# ── M42. Lokinet treated as if its errors named our end ──────────────
# The breaker's evidence rule, inverted. A .loki DNS miss carries THEIR name,
# so reading one as our router being gone takes the network away from every
# other .loki peer for a minute — and, on an instance that also publishes a
# clearnet origin, quietly moves their traffic onto the clearnet.
#
# NOTE ON WHAT THIS MUTATES, because it changed once already. The rule used to
# live in `SELF_IDENTIFYING_NETWORKS`, and mutating that set is now an
# EQUIVALENT mutant: since F12 the confidence is classified at the transport
# entry point and CARRIED on the failure, and a carried verdict overrides the
# per-network fallback. So the set no longer decides anything for a real fault,
# and mutating it changes nothing the smoke can see. The thing that decides is
# the verdict this module attaches, which is what these two force.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
			confidence: localFault ? localFaultConfidence(err, hiddenNetworkOf(addr.origin)) : undefined
NEEDLE
cat > "$WORK/.repl" <<'REPL'
			confidence: localFault ? 'conclusive' : undefined
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M42 every local fault is treated as conclusive' "$FED" 'marked the whole network down'
else
	no 'M42 — mutation did not apply (the evidence rule changed; update this harness)'
	restore "$FED"
fi

# ── M43. Corroboration set beyond what a batch can supply ────────────
# Raise the bar and the breaker stops firing on Lokinet at all: a dead router
# costs one refused dial per peer per message, which is what it exists to avoid.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
const CORROBORATING_PEERS = 2;
NEEDLE
cat > "$WORK/.repl" <<'REPL'
const CORROBORATING_PEERS = 3;
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M43 the Lokinet breaker can no longer fire' "$FED" 'left the network on the list'
else
	no 'M43 — mutation did not apply (the corroboration constant changed; update this harness)'
	restore "$FED"
fi

# ── M44. Tor made to wait for corroboration it does not need ─────────
# The other half of the rule. Tor's marker is raised only by our OWN proxy
# failing, so a second opinion buys nothing and costs every onion peer a
# refused dial while it is collected.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
			confidence: localFault ? localFaultConfidence(err, hiddenNetworkOf(addr.origin)) : undefined
NEEDLE
cat > "$WORK/.repl" <<'REPL'
			confidence: localFault ? 'ambiguous' : undefined
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M44 every local fault is treated as ambiguous' "$FED" 'no longer marks Tor down'
else
	no 'M44 — mutation did not apply (the evidence rule changed; update this harness)'
	restore "$FED"
fi

# ── M45. Corroboration counted per network, not per address ──────────
# The subtlest of the four: the suspicion map still fills, the rule still reads
# as written, and the count never passes one — so the breaker never fires and
# nothing about the code looks wrong.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
		seen.set(addressKey, now);
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		seen.set(network, now);
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M45 distinct addresses collapse into one suspect' "$FED" 'left the network on the list'
else
	no 'M45 — mutation did not apply (the suspicion map changed; update this harness)'
	restore "$FED"
fi

# ── M46. The transport stops normalising, so a refused CONNECT is theirs ──
# A router configured to refuse CONNECT (the Java router's
# `i2ptunnel.httpclient.allowInternalSSL=false`, which refuses in-network
# destinations on every port including 80) answers every tunnel request with a
# status. Unnormalised, that reads as the PEER refusing the message.
#
# NOTE FOR WHOEVER ADDS THE NEXT ONE: the rule itself lives in
# `packages/hidden-transport`, which this harness CANNOT mutate — it symlinks
# node_modules wholesale, so `@morphit/*` resolves to the real tree and a
# mutation there would be applied to a file the smoke never reads. That is the
# F6 trap, and it is why these two target the indexer's own copies instead.
# The package-level rules are mutated in `fastchat-transport-harness.sh`
# (T43/T44), which proves its redirection before applying anything.
snapshot "$POOL"
cat > "$WORK/.needle" <<'NEEDLE'
		throw asLocalTransportFault(err, network, config);
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		throw err;
REPL
if mutate "$POOL" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M46 a refused CONNECT is recorded as the peer refusing' "$POOL" 'refused CONNECT was recorded'
else
	no 'M46 — mutation did not apply (the transport entry point changed; update this harness)'
	restore "$POOL"
fi

# ── M47. The fault's confidence is dropped on the way to the breaker ──
# The evidence is classified at the transport entry point and carried on the
# failure. Drop it and the breaker falls back to what the NETWORK implies —
# I2P is otherwise conclusive — so one refused CONNECT takes I2P away from
# every other peer for a minute.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
		reach.reportAddressFault(network, peerKey(peer), Date.now(), res.confidence);
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		reach.reportAddressFault(network, peerKey(peer), Date.now());
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M47 the fault confidence never reaches the breaker' "$FED" 'marked the whole I2P network down'
else
	no 'M47 — mutation did not apply (the breaker call changed; update this harness)'
	restore "$FED"
fi

# ── M50. The breaker counts ADDRESSES again (v1.18.0 review, S2) ────
# One registration may publish two I2P names. Keyed by address, one instance
# whose names the proxy refuses convicts I2P for every peer by itself.
snapshot "$FED"
cat > "$WORK/.needle" <<'NEEDLE'
		reach.reportAddressFault(network, peerKey(peer), Date.now(), res.confidence);
NEEDLE
cat > "$WORK/.repl" <<'REPL'
		reach.reportAddressFault(network, addr.origin, Date.now(), res.confidence);
REPL
if mutate "$FED" "$WORK/.needle" "$WORK/.repl"; then
	expect_caught 'M50 the breaker counts one instance'"'"'s two names as two witnesses' "$FED" 'two refused I2P names'
else
	no 'M50 — mutation did not apply (the breaker call changed; update this harness)'
	restore "$FED"
fi

echo ''
echo '────────────────────────────────────────────────────────'
if [ "$fails" -eq 0 ]; then
	printf '\033[32m✓ all %d federation-chat-fast-harness checks passed\033[0m\n' "$pass"
	exit 0
else
	printf '\033[31m✗ %d FAILED, %d passed\033[0m\n' "$fails" "$pass"
	exit 1
fi
