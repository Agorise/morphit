#!/usr/bin/env bash
# federation-probe-status.sh — read-only. Shows why each peer is classified the
# way it is (the exact last_probe_error), from THIS node's known_instances table.
# Run on the box:  sudo bash federation-probe-status.sh
set -uo pipefail
ENV_FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
set -a; for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && . "$f"; done; set +a
DB="${MORPHIT_INDEXER_DATABASE_URL:-}"
[ -n "$DB" ] || { echo "MORPHIT_INDEXER_DATABASE_URL not set in the env files"; exit 1; }
Q="SELECT origin, operator_account, last_probe_status AS status, COALESCE(last_probe_error,'') AS reason, to_char(last_probed_at,'HH24:MI:SS UTC') AS probed FROM known_instances ORDER BY origin;"

echo "== federation probe status (this node's view of every known instance) =="
if command -v psql >/dev/null 2>&1; then
	psql "$DB" -P pager=off -x -c "$Q"
else
	# fall back to a postgres docker container if psql isn't installed on the host
	CID="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'postgres|morphit.*db|pg' | head -1)"
	if [ -n "$CID" ]; then
		echo "(psql not on host; using container $CID)"
		docker exec -i "$CID" psql "$DB" -P pager=off -x -c "$Q" 2>/dev/null \
			|| docker exec -i "$CID" sh -lc "psql \"\$DATABASE_URL\" -P pager=off -x -c \"$Q\"" 2>/dev/null \
			|| echo "couldn't run psql in $CID — paste: docker ps  and I'll adjust"
	else
		echo "psql not found and no postgres container detected."
		echo "Your DATABASE_URL host is: ${DB#*@}"
		echo "Run psql against it however you reach Postgres, with this query:"
		echo "  $Q"
	fi
fi
echo ""
echo "Read the 'reason' for the morphit.io row:"
echo "  treasury_*_address mismatch  -> canonical-treasury baseline (likely the tor-only mid-sync false-flag; re-probes hourly)"
echo "  relay_account mismatch       -> morphit.io advertises a relay_account != its on-chain operator account (a real config issue there)"
echo "  (empty) + status good        -> already self-resolved"
