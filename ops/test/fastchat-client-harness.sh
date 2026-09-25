#!/usr/bin/env bash
# ops/test/fastchat-client-harness.sh — prove the BROWSER-side fast-chat tests
# actually catch the failures they claim to catch.
#
# WHY THIS EXISTS
#
# Everything the federation does ends at a browser, and two of the properties
# that decide whether fast chat is correct live there rather than in the
# indexer: how the browser talks to its own instance about a chat broadcast,
# and what it does when the same message reaches it twice by two routes.
#
# Both had tests. Neither had a harness. ADR-0052 says so about the first in as
# many words — "five of them were watched to fail against the bug they guard,
# BY HAND: there is no permanent mutation harness for this file, so that check
# does not repeat itself and the claim should not be read as if it does." That
# is the right thing to write when it is true and the wrong thing to leave true.
# This file makes it false.
#
# THE MUTATIONS.
#
#   C1  The provisional/durable collapse is removed.
#         → every incoming message in every conversation shows twice, because
#           since v1.18.0 the normal path is a peer push followed by the
#           durable copy a minute later.
#   C2  The collapse adopts the durable id but does not stop.
#         → the twin falls through into the payload decode, and a funds-sent
#           claim or a shared payment address is recorded against the order a
#           SECOND time. A marketplace problem, not a rendering one, and the
#           subtlest of these: the transcript still looks right.
#   C3  A provisional adopts an id from another provisional.
#         → a message pushed by two peers is marked durable without ever having
#           reached a block, so it stops being distinguishable from one that
#           did.
#   C8  Twins are matched on the sender's tag alone again (v1.18.0 review, W1).
#         → a sender who reuses a tag makes the recipient's view put one
#           message's words beside another message's on-chain proof, or fold a
#           second on-chain message away unseen.
#   N16 The sweep calls a send failed without asking the chain (review W3).
#   N17 An unconfirmed send is not restored after leaving the chat (W2).
#   N18 A restored send gets a fresh clock, so the sweep never fails it (W2).
#   C4  A chat broadcast stops asking for the asynchronous answer.
#         → the browser waits for block inclusion again, which is the three
#           seconds this release exists to remove.
#   C5  A chat broadcast accepts a response with no transaction id.
#         → nothing identifies the message, so it can never be reconciled and
#           sits unconfirmed until the sweeper calls it failed.
#   C6  The NON-chat broadcast accepts a null block_num.
#         → the version-skew guard goes: an older instance answering a newer
#           browser hands back a result that reads as success and is not one.
#   C7  A chain rejection is reported as the instance being unavailable.
#         → the user is told to retry something the chain will refuse again,
#           instead of being shown the real reason.
#
#   N1–N15  A message the chain never records (neverRecorded.test.ts). The
#         fast path puts a message on the recipient's screen BEFORE the chain
#         has it, so the chain can refuse or drop what someone has already
#         read. These guard both sides of that:
#           • the SENDER is told (N1–N4). The old sweep looked only at
#             'broadcast', and this instance's own provisional copy moves every
#             accepted send to 'confirmed' first — so it almost never fired;
#           • a RETRY is the same message on the wire (N5–N6): it keeps its
#             order_permlink, which it had lost, and names what it replaces;
#           • the RECIPIENT is shown which copies the chain never recorded, on
#             this device's clock, and a late durable copy clears it (N7–N9);
#           • a retry is folded into the attempt it resends, its side effects
#             run once (N10–N11) — and only when tag AND words match, only for
#             the same sender, never on unreadable placeholders or a malformed
#             list (N12–N15), because a tag link alone lets a sender hide new
#             words behind old ones, or a peer swallow ours.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fails=0
ok(){ printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m\xe2\x9c\x97\033[0m %s\n' "$1"; fails=$((fails+1)); }

# ── Hermetic copy ────────────────────────────────────────────────────
# Mutate a COPY, never the tree the operator is working in. Everything these
# tests import resolves through the web workspace's own tsconfig paths out of
# this copy, so node_modules is symlinked whole — unlike the transport harness,
# which mutates a PACKAGE and has to redirect @morphit/* to see its own edits.
mkdir -p "$WORK"
cp -r "$REPO/apps" "$WORK/apps"
cp -r "$REPO/packages" "$WORK/packages"
cp "$REPO/tsconfig.json" "$WORK/" 2>/dev/null || true
cp "$REPO/package.json" "$WORK/" 2>/dev/null || true
ln -s "$REPO/node_modules" "$WORK/node_modules"

CHAT="$WORK/apps/web/src/lib/chat/chatService.ts"
TRANSPORT="$WORK/apps/web/src/lib/blurt/broadcastTransport.ts"

TESTS=(
	src/lib/chat/provisionalTwin.test.ts
	src/lib/chat/neverRecorded.test.ts
	src/lib/blurt/broadcastTransport.test.ts
)

run_tests(){
	( cd "$WORK/apps/web" && timeout 300 npx vitest run "${TESTS[@]}" 2>&1 )
}

verdict(){ # <output> -> pass | fail | crash
	if printf '%s' "$1" | grep -qE 'Tests +[0-9]+ failed'; then echo fail
	elif printf '%s' "$1" | grep -qE 'Tests +[0-9]+ passed'; then echo pass
	else echo crash; fi
}

snapshot(){ cp "$1" "$1.orig"; }
restore(){ mv "$1.orig" "$1"; }

# Apply an exact literal substitution and REFUSE to continue if the text was not
# found. A mutation that silently fails to apply produces a green run against
# unmutated source — the single most misleading outcome a harness can have.
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

# A mutation must make the tests FAIL. A crash is never a catch: a run that died
# on a syntax error detected nothing.
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

echo 'fastchat-client-harness — are the browser-side tests actually tests?'
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

# ── the same message arriving twice ──────────────────────────────────
try 'C1 the provisional/durable collapse is removed' "$CHAT" \
	'					if (twin) {' \
	'					if (false) {'

try 'C2 the collapse adopts the id but does not stop' "$CHAT" \
	'							adoptDurable(twin, rec);
						}
						added = true;
						continue;
					}
				}' \
	'							adoptDurable(twin, rec);
						}
						added = true;
					}
				}'

try 'C3 a provisional adopts an id from another provisional' "$CHAT" \
	'						if (isDurable && (twin.id === null || twin.id === 0)) {' \
	'						if (twin.id === null || twin.id === 0) {'

try 'C8 twins are matched on the sender'"'"'s tag alone again' "$CHAT" \
	'							m.wire === wire' \
	'							true'

# ── a message the chain never records (neverRecorded.test.ts) ────────
# The sender's side. Each of these was a real way for a dropped message to sit
# in the sender's transcript looking delivered.
try 'N1 the sweep looks only at broadcast, not at a provisionally-confirmed send' "$CHAT" \
	'				(m.state === '"'"'broadcast'"'"' || m.state === '"'"'confirmed'"'"')' \
	'				m.state === '"'"'broadcast'"'"''

try 'N2 the durable clock starts only if the node answers before the copy arrives' "$CHAT" \
	'		if (m.id === null) {
			m.sentAtMs = Date.now();' \
	'		if (m.id === null) {
			if (m.state === '"'"'broadcast'"'"' && false) m.sentAtMs = Date.now();'

try 'N3 a lost answer after a provisional copy leaves the send off the clock' "$CHAT" \
	'		} else if (m.id === null && m.sentAtMs === undefined) {' \
	'		} else if (false) {'

try 'N4 the window no longer covers expiry plus irreversibility' "$CHAT" \
	'export const NEVER_RECORDED_AFTER_MS = 150_000;' \
	'export const NEVER_RECORDED_AFTER_MS = 120_000;'

# The retry on the wire.
try 'N5 a retry leaves the order it is about' "$CHAT" \
	'			payload.order_permlink = deps.orderPermlink;' \
	'			void 0;'

try 'N6 a retry stops naming the attempt it replaces' "$CHAT" \
	'		const payload = wirePayload(newTag, envelope, target.priorTags ?? []);' \
	'		const payload = wirePayload(newTag, envelope, []);'

# The recipient's side.
try 'N7 a durable copy no longer clears the unrecorded mark' "$CHAT" \
	'		delete m.sentAtMs;
		m.unrecorded = false;
	}' \
	'		delete m.sentAtMs;
	}'

try 'N8 the window runs from created_at instead of arrival on this device' "$CHAT" \
	'					...(declared.length > 0 ? { priorTags: declared } : {}),
					...(isDurable ? {} : { provisionalSinceMs: Date.now() })' \
	'					...(declared.length > 0 ? { priorTags: declared } : {}),
					...(isDurable ? {} : { provisionalSinceMs: Date.parse(rec.created_at) })'

try 'N9 a provisional from our other session is stored with the id 0 it arrived with' "$CHAT" \
	'					// from our other session until its durable copy arrived.
					id: isDurable ? rec.id : null,' \
	'					// from our other session until its durable copy arrived.
					id: rec.id,'

try 'N10 an absorbed retry runs the side effects again' "$CHAT" \
	'						absorbRetryCopy(linked, rec, incomingTag, declared);
						added = true;
						continue;' \
	'						absorbRetryCopy(linked, rec, incomingTag, declared);
						added = true;'

try 'N11 a fresh provisional retry inherits the old verdict' "$CHAT" \
	'			m.provisionalSinceMs = Date.now();
			m.unrecorded = false;
		}' \
	'		}'

# The link's two halves, and who may use it.
try 'N12 a retry links on its tag alone, whatever it says' "$CHAT" \
	'				m.text === text &&' \
	'				true &&'

try 'N13 two unreadable placeholders count as the same words' "$CHAT" \
	'		if (text === ENCRYPTED_PLACEHOLDER) return undefined;' \
	'		if (text === '"'"'\u0000never'"'"') return undefined;'

try 'N14 a peer naming one of our tags can swallow our own message' "$CHAT" \
	'			if (m.sender !== deps.me) continue;' \
	'			if (false) continue;'

try 'N15 an over-long prior_tags list is half-honoured' "$CHAT" \
	'	if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PRIOR_TAGS) return [];' \
	'	if (!Array.isArray(v) || v.length === 0) return [];'

# ── how the browser asks for a chat broadcast ────────────────────────
try 'N16 the sweep calls a send failed without asking the chain' "$CHAT" \
	'				if (m.sentTrxId !== undefined && deps.transactionOnChain !== undefined) {' \
	'				if (false) {'

try 'N17 an unconfirmed send is not restored when the sender comes back' "$CHAT" \
	'			restoreUnconfirmed();
' \
	''

try 'N18 a restored send gets a fresh clock, so it never fails' "$CHAT" \
	'				sentAtMs: u.sentAtMs,' \
	'				sentAtMs: Date.now(),'

try 'C4 a chat broadcast stops asking for the async answer' "$TRANSPORT" \
	'	const body = await postSignedTransaction(signed, true);' \
	'	const body = await postSignedTransaction(signed, false);'

try 'C5 a chat broadcast accepts a response with no transaction id' "$TRANSPORT" \
	'	if (typeof body.trx_id === '"'"'string'"'"' && body.trx_id.length > 0) {' \
	'	if (true) {'

try 'C6 the non-chat broadcast accepts a null block_num' "$TRANSPORT" \
	'	if (typeof body.block_num === '"'"'number'"'"' && typeof body.trx_id === '"'"'string'"'"') {' \
	'	if (typeof body.trx_id === '"'"'string'"'"') {'

try 'C7 a chain rejection is reported as the instance being unavailable' "$TRANSPORT" \
	'		throw new ChainRejectedError(message);' \
	'		throw new BroadcastUnavailableError(message);'

# A mutation series ENDS WITH THE BASELINE (the standing rule from round
# fourteen): every restore above looked fine one at a time; only the unmutated
# tree passing again proves none of them went wrong.
if [ "$(verdict "$(run_tests)")" = pass ]; then
	ok 'baseline again — every mutation was restored'
else
	no 'the baseline FAILS after the mutations — a restore went wrong'
fi

echo ''
echo '────────────────────────────────────────────────────────'
if [ "$fails" -eq 0 ]; then
	printf '\033[32m✓ all %d fastchat-client-harness checks passed\033[0m\n' "$pass"
	exit 0
else
	printf '\033[31m✗ %d FAILED, %d passed\033[0m\n' "$fails" "$pass"
	exit 1
fi
