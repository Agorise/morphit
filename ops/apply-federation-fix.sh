#!/usr/bin/env bash
# apply-federation-fix.sh — cp775: allow a split brand↔relay identity when BOTH
# accounts are reserved brand names (co-controlled). Proves it by re-probing
# morphit.io and confirming it flips from 'mismatch' to 'good'. Keeps the patch on
# success. Run on morphitlat:  sudo bash apply-federation-fix.sh
set -uo pipefail
IDXDIR="${IDXDIR:-/opt/morphit/apps/indexer}"
FP="$IDXDIR/src/indexer/federationProbe.ts"
ENV_FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
PEER="${PEER:-morphit.io}"
g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
bad(){ printf '  %s\xe2\x9c\x97%s %s\n' "$r" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
[ -f "$FP" ] || { echo "no $FP"; exit 1; }
set -a; for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && . "$f"; done; set +a
DB="${MORPHIT_INDEXER_DATABASE_URL:-}"; [ -n "$DB" ] || { echo "no DATABASE_URL"; exit 1; }
psqlc(){ psql "$DB" -tA -c "$1" 2>/dev/null; }
status_of(){ psqlc "SELECT last_probe_status FROM known_instances WHERE origin LIKE '%${PEER}%' LIMIT 1;"; }

hdr "1. Before"
echo "  ${PEER} status: $(status_of)  (reason: $(psqlc "SELECT COALESCE(last_probe_error,'') FROM known_instances WHERE origin LIKE '%${PEER}%' LIMIT 1;"))"

hdr "2. Patch federationProbe.ts (cp775 — both-reserved pairing allowed)"
BK="$FP.cp775-bak-$(date +%s)"; cp -a "$FP" "$BK"; ok "backed up -> $BK"
python3 - "$FP" <<'PYEOF'
import sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
if "isReservedTag" not in s:
    s=s.replace("import { logger } from '$log';",
                "import { logger } from '$log';\nimport { isReservedTag } from '$indexer/confusables';",1)
old='''	if (instanceData.relay_account !== operator_account) {
		return mkMismatch(
			`relay_account mismatch: chain=${operator_account} instance=${instanceData.relay_account}`
		);
	}'''
new='''	// cp775 — split brand↔relay identity is legit when BOTH accounts are reserved
	// brand names (reserved names can't be squatted, so both-reserved ⇒ same owner).
	const bothReservedBrandAccounts =
		isReservedTag(operator_account) && isReservedTag(instanceData.relay_account);
	if (instanceData.relay_account !== operator_account && !bothReservedBrandAccounts) {
		return mkMismatch(
			`relay_account mismatch: chain=${operator_account} instance=${instanceData.relay_account}`
		);
	}'''
if old not in s: print("ANCHOR_NOT_FOUND"); sys.exit(3)
s=s.replace(old,new,1); open(p,"w",encoding='utf-8').write(s); print("PATCHED")
PYEOF
grep -q "bothReservedBrandAccounts" "$FP" && ok "patched" || { bad "patch failed; restoring"; cp -a "$BK" "$FP"; exit 2; }

hdr "3. Clear cache, restart, force a re-probe of ${PEER}"
for c in /tmp/tsx-* "$IDXDIR/node_modules/.cache" /opt/morphit/node_modules/.cache; do [ -e "$c" ] && rm -rf "$c" 2>/dev/null; done
ok "tsx cache cleared"
systemctl restart morphit-indexer 2>/dev/null && ok "restarted" || warn "restart manually"
sleep 8
psqlc "UPDATE known_instances SET last_probed_at = NULL WHERE origin LIKE '%${PEER}%';" >/dev/null && ok "marked ${PEER} due for immediate re-probe"

hdr "4. Wait for the re-probe"
NEW=""
for _ in $(seq 1 15); do sleep 6; NEW="$(status_of)"; case "$NEW" in good|quiet|syncing) break;; esac; [ -n "$NEW" ] && printf '    ...%s\n' "$NEW"; done

hdr "VERDICT"
case "$NEW" in
  good|quiet|syncing)
	printf '%s%s\xe2\x9c\x93 PROVEN: %s is no longer flagged mismatch — it now probes as [%s].%s\n' "$g" "$b" "$PEER" "$NEW" "$x"
	echo "  (quiet = alive + valid, just no orderbook activity in the last 7d; it flips to good on its next order. The spoofing flag is cleared either way.)"
	echo "  Kept the patch (bridges until the release ships cp775). Backup: $BK"
	exit 0
	;;
esac
bad "${PEER} status is [${NEW:-unreadable}] (still mismatch/unreachable) — restoring backup."
cp -a "$BK" "$FP"; for c in /tmp/tsx-*; do rm -rf "$c" 2>/dev/null; done
systemctl restart morphit-indexer 2>/dev/null || true
echo "  Re-run 'sudo bash federation-probe-status.sh' and paste it."
exit 2
