#!/usr/bin/env bash
# Run on: the sandbox/dev container, or any box with a scratch Postgres
# (NOT a production node). Needs TEST_DATABASE_URL, e.g.
#   TEST_DATABASE_URL=postgres://morphit:morphit@localhost:5433/morphit_a \
#     bash ops/test/posting-key-trust-harness.sh
#
# posting-key-trust-harness — are the key-trust and push-queue tests actually
# tests? The seventeenth harness, and the first that needs a real database.
#
# WHY A DATABASE. What these guard is SQL and migrations:
#   F37 — a posting key recorded before v1.18.0 may be one its owner rotated
#         away from because it LEAKED, and the fast path verifies pushed chat
#         against that column. Migration v61 marks every such row unconfirmed,
#         the backfill confirms them against the chain, the fast path asks the
#         chain before trusting one.
#   F36 — a relay with push off ran no sender, and only the sender retired or
#         pruned push_pending, so the queue grew forever on every hidden-only
#         node with old subscriptions. The janitor applies the sender's rules.
# A fake database proves the code SENDS its SQL. Only a real one proves the SQL
# does what it says — and one of these mutations (the migration's default)
# survived every schema.sql-built fixture until a case drove the real runner.
#
# Without TEST_DATABASE_URL this FAILS rather than skipping: a harness that
# passes when it could not run is a harness that stops checking unnoticed.
#
#  K1  the fast path trusts an unconfirmed row again
#  K2  a chain that does not answer falls back to the stale row
#  K3  the reconcile UPDATE overwrites a rotation the dispatcher recorded
#  K4  a key the chain no longer names is kept
#  K5  an account_update no longer confirms the key it records
#  K6  an account created from the block stream is not born confirmed
#  K7  the migration's DEFAULT confirms every existing row — the upgrade path
#  K8  schema.sql's DEFAULT confirms every existing row — fresh installs
#  K9  the stored key ignores the authority's threshold (R2)
#  K10 an update that leaves no single signing key is skipped (R2)
#  K11 a durable record far behind the chain vouches for a key again (D6)
#  K12 the intake worker waits on the chain again (R3)
#  K13 the reconcile takes ONE endpoint's word again (D1)
#  K14 an account missing from the answer is written "no key" (D7)
#  K15 a restored snapshot keeps the publisher's confirmations (D4)
#  K16 the reconcile retry stops before every row is confirmed (D5)
#  Q1  the janitor retires fresh rows (the age comparison flipped)
#  Q2  the janitor deletes where the sender retires (dedup tombstones lost)
#  Q3  the janitor prunes before the tombstone retention
#  Q4  the janitor re-retires tombstones, restarting their retention

set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fails=0
ok(){ printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m\xe2\x9c\x97\033[0m %s\n' "$1"; fails=$((fails+1)); }

echo 'posting-key-trust-harness — are the key-trust and push-queue tests actually tests?'
echo ''

if [ -z "${TEST_DATABASE_URL:-}" ]; then
	no 'TEST_DATABASE_URL is not set — these checks need a real Postgres, and did NOT run'
	printf '\033[31m✗ not run: set TEST_DATABASE_URL to a scratch database\033[0m\n'
	exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── Hermetic copy, as fastchat-transport-harness does and for the same reason:
# mutate a COPY, and redirect @morphit/* into it so a package edit is seen.
cp -r "$REPO/apps" "$WORK/apps"
cp -r "$REPO/packages" "$WORK/packages"
cp "$REPO/tsconfig.json" "$WORK/" 2>/dev/null || true
cp "$REPO/package.json" "$WORK/" 2>/dev/null || true
mkdir -p "$WORK/node_modules/@morphit"
for entry in "$REPO"/node_modules/* "$REPO"/node_modules/.[!.]*; do
	[ -e "$entry" ] || continue
	name="$(basename "$entry")"
	[ "$name" = '@morphit' ] && continue
	ln -s "$entry" "$WORK/node_modules/$name"
done
for pkg in "$REPO"/node_modules/@morphit/*; do
	ln -s "$WORK/packages/$(basename "$pkg")" "$WORK/node_modules/@morphit/$(basename "$pkg")"
done

FED="$WORK/apps/indexer/src/indexer/chatFastFederation.ts"
BF="$WORK/apps/indexer/src/indexer/postingKeyBackfill.ts"
DSP="$WORK/apps/indexer/src/indexer/dispatcher.ts"
MIG="$WORK/apps/indexer/src/db/migrations.ts"
SCHEMA="$WORK/apps/indexer/src/db/schema.sql"
JAN="$WORK/apps/relay/src/policy/pushQueueJanitor.ts"
TESTS=(test/integration/posting-key-rotation.test.ts test/integration/posting-key-quorum.test.ts test/integration/push-queue-janitor.test.ts)
ROUTE="$WORK/apps/indexer/src/api/federationChatFast.ts"

run_tests(){
	local out
	out="$( cd "$WORK/apps/indexer" && timeout 300 npx vitest run --config vitest.integration.config.ts "${TESTS[@]}" 2>&1 )"
	printf '%s\n' "$out"
	# Both files must have RUN: a suite that skipped (no database reached) is
	# not a verdict, and neither is one that crashed on an import.
	printf '%s' "$out" | grep -qE 'Test Files +[0-9]+ (failed|passed)' || echo 'RUN-INCOMPLETE'
	printf '%s' "$out" | grep -qE 'skipped' && echo 'RUN-SKIPPED'
}
verdict(){
	if printf '%s' "$1" | grep -qE 'RUN-INCOMPLETE|RUN-SKIPPED'; then echo crash
	elif printf '%s' "$1" | grep -qE 'Tests +[0-9]+ failed'; then echo fail
	elif printf '%s' "$1" | grep -qE 'Tests +[0-9]+ passed'; then echo pass
	else echo crash; fi
}

# Exact literal substitution; refuse a needle that is not found exactly once.
mutate(){ # <file> <needle> <replacement>
	python3 - "$1" "$2" "$3" <<'PYEOF'
import sys
path, needle, repl = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
if src.count(needle) != 1:
    sys.stderr.write(f"mutation target found {src.count(needle)} times, expected exactly 1\n")
    sys.exit(3)
open(path, 'w').write(src.replace(needle, repl))
PYEOF
}
try(){ # <label> <file> <needle> <replacement>
	local label="$1" file="$2" out v
	cp "$file" "$file.orig"
	if ! mutate "$file" "$3" "$4"; then
		no "$label — mutation did not apply (the code moved; update this harness)"
		mv "$file.orig" "$file"; return
	fi
	out="$(run_tests)"; v="$(verdict "$out")"
	case "$v" in
		fail) ok "$label — caught" ;;
		pass) no "$label — SURVIVED. The tests pass with this bug in place." ;;
		*) no "$label — the run CRASHED or SKIPPED; no verdict. Not counted as a catch."
		   printf '%s\n' "$out" | tail -4 | sed 's/^/        /' ;;
	esac
	mv "$file.orig" "$file"
}

base="$(run_tests)"
if [ "$(verdict "$base")" = pass ]; then
	ok 'baseline — both suites run against the database and pass on unmutated source'
else
	no 'baseline FAILED or did not run — nothing below means anything'
	printf '%s\n' "$base" | tail -12 | sed 's/^/        /'
	printf '\033[31m✗ aborting: the baseline must be green\033[0m\n'; exit 1
fi

# ── F37: the posting key a pushed message is checked against ─────────
# K1, K2 and K11 re-aimed after the v1.18.0 deep-deep (rv1-3): the unconfirmed-row
# (F37) and durable-behind (D6) conditions merged into one `if` whose chain read
# is charged to a `verify` or `mismatch` budget. K1 and K11 each drop their own
# half of that condition; K2 falls back to the stale column when the read is empty.
try 'K1 the fast path trusts an unconfirmed row again' "$FED" \
	'			(row.posting_key_reconciled === false || options.durableIsCurrent?.() === false)
' \
	'			(options.durableIsCurrent?.() === false)
'
try 'K2 a chain that does not answer falls back to the stale row' "$FED" \
	'			return refreshKey(refreshFromChain, account, opts?.network, budget);
' \
	'			return (await refreshKey(refreshFromChain, account, opts?.network, budget)) ?? row.posting_pubkey ?? null;
'
try 'K3 the reconcile overwrites a rotation the dispatcher recorded' "$BF" \
	'				  WHERE name = $1 AND posting_key_reconciled = FALSE`,' \
	'				  WHERE name = $1`,'
try 'K4 a key the chain no longer names is kept' "$BF" \
	'				[row.name, chainKey]' \
	'				[row.name, chainKey ?? row.posting_pubkey]'
try 'K5 an account_update no longer confirms the key it records' "$DSP" \
	"			'UPDATE accounts SET posting_pubkey = \$2, posting_key_reconciled = TRUE WHERE name = \$1'," \
	"			'UPDATE accounts SET posting_pubkey = \$2 WHERE name = \$1',"
try 'K6 an account created from the block stream is not born confirmed' "$DSP" \
	'			) VALUES ($1, $2, $3, $4, $5, $6, $6::text IS NOT NULL)' \
	'			) VALUES ($1, $2, $3, $4, $5, $6, FALSE)'
try 'K7 the migration confirms every existing row (the upgrade path)' "$MIG" \
	'    ADD COLUMN IF NOT EXISTS posting_key_reconciled BOOLEAN NOT NULL DEFAULT FALSE;' \
	'    ADD COLUMN IF NOT EXISTS posting_key_reconciled BOOLEAN NOT NULL DEFAULT TRUE;'
try 'K8 schema.sql confirms every existing row (fresh installs)' "$SCHEMA" \
	'    ADD COLUMN IF NOT EXISTS posting_key_reconciled BOOLEAN NOT NULL DEFAULT FALSE;' \
	'    ADD COLUMN IF NOT EXISTS posting_key_reconciled BOOLEAN NOT NULL DEFAULT TRUE;'

# ── v1.18.0 review: R2, R3, D1, D4, D5, D6, D7 ──────────────────────
try 'K9 the stored key ignores the authority threshold' "$BF" \
	'		if (weight >= threshold) return key;' \
	'		return key;'
try 'K10 an update leaving no single signing key is skipped' "$DSP" \
	'			out.push({ account: b.account, postingPubkey: signingPostingKey(b.posting) });' \
	'			const k = signingPostingKey(b.posting); if (k !== null) out.push({ account: b.account, postingPubkey: k });'
try 'K11 a durable record far behind the chain vouches for a key again' "$FED" \
	'			(row.posting_key_reconciled === false || options.durableIsCurrent?.() === false)
' \
	'			(row.posting_key_reconciled === false)
'
try 'K12 the intake worker waits on the chain again' "$ROUTE" \
	'					const verdict = await verifyPushedChatOp({ trx }, lookupPostingKey, undefined, {
						network: false
					});' \
	'					const verdict = await verifyPushedChatOp({ trx }, lookupPostingKey);'
try 'K13 the reconcile takes one endpoint'"'"'s word again' "$BF" \
	'	if (blurt.getAccountsAgreed !== undefined) return blurt.getAccountsAgreed(names, keyAgreement);' \
	'	void keyAgreement;'
try 'K14 an account missing from the answer is written as having no key' "$BF" \
	'			const acc = map.get(row.name);' \
	'			const acc = map.get(row.name) ?? {};'
try 'K15 a restored snapshot keeps the publisher'"'"'s confirmations' "$BF" \
	"		'UPDATE accounts SET posting_key_reconciled = FALSE WHERE posting_key_reconciled'" \
	"		'UPDATE accounts SET posting_key_reconciled = posting_key_reconciled WHERE posting_key_reconciled'"
try 'K16 the reconcile retry stops before every row is confirmed' "$BF" \
	'		if (r.remaining === 0) return; // done: nothing left to confirm' \
	'		return;'

# ── F36: push_pending with nothing sending ───────────────────────────
try 'Q1 the janitor retires fresh rows' "$JAN" \
	'		    AND event_at < NOW() - ($1::int * INTERVAL '"'"'1 second'"'"')`,' \
	'		    AND event_at < NOW() + ($1::int * INTERVAL '"'"'1 second'"'"')`,'
try 'Q2 the janitor deletes where the sender retires' "$JAN" \
	'		`UPDATE push_pending
		    SET sent_at = NOW()
		  WHERE sent_at IS NULL' \
	'		`DELETE FROM push_pending
		  WHERE sent_at IS NULL'
try 'Q3 the janitor prunes before the tombstone retention' "$JAN" \
	'		    AND sent_at < NOW() - ($1::int * INTERVAL '"'"'1 second'"'"')`,' \
	'		    AND sent_at < NOW() + ($1::int * INTERVAL '"'"'1 second'"'"')`,'
try 'Q4 the janitor re-retires tombstones, restarting their retention' "$JAN" \
	'		  WHERE sent_at IS NULL
		    AND event_at' \
	'		  WHERE TRUE
		    AND event_at'

# A mutation series ends with the baseline — the rule from round fourteen, when
# a bad restore was caught only because the baseline was re-run.
if [ "$(verdict "$(run_tests)")" = pass ]; then
	ok 'baseline again — every mutation was restored'
else
	no 'the baseline FAILS after the mutations — a restore went wrong'
fi

echo ''
echo '────────────────────────────────────────────────────────'
if [ "$fails" -eq 0 ]; then
	printf '\033[32m✓ all %d posting-key-trust-harness checks passed\033[0m\n' "$pass"; exit 0
fi
printf '\033[31m✗ %d FAILED, %d passed\033[0m\n' "$fails" "$pass"; exit 1
