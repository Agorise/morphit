#!/usr/bin/env bash
# apply-relay-fix.sh — the ACTUAL fix: relayProbeCandidates threw because
# os.networkInterfaces() fails (EAFNOSUPPORT / "error 97") under the systemd
# sandbox, so the relay probe never ran and /v1/health stayed up:false. This
# wraps that call so it can't blank the probe, restarts, and verifies up:true.
# On success it KEEPS the fix (bridges until the release). Run on the box:
#   sudo bash apply-relay-fix.sh
set -uo pipefail
IDXDIR="${IDXDIR:-/opt/morphit/apps/indexer}"
OH="$IDXDIR/src/api/operationalHealth.ts"
ENV_FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
bad(){ printf '  %s\xe2\x9c\x97%s %s\n' "$r" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
[ -f "$OH" ] || { echo "no $OH"; exit 1; }
set -a; for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && . "$f"; done; set +a
IHOST="${MORPHIT_INDEXER_LISTEN_HOST:-172.18.0.1}"; IPORT="${MORPHIT_INDEXER_LISTEN_PORT:-8081}"

hdr "1. Wrap networkInterfaces() in relayProbeCandidates (cp774)"
BK="$OH.cp774-bak-$(date +%s)"; cp -a "$OH" "$BK"; ok "backed up -> $BK"
python3 - "$OH" <<'PYEOF'
import re, sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
m=re.search(r"function relayProbeCandidates\(", s)
if not m: print("NOT_FOUND"); sys.exit(3)
i=s.index("{", m.end()); depth=0; j=i
while j<len(s):
    if s[j]=="{": depth+=1
    elif s[j]=="}":
        depth-=1
        if depth==0: j+=1; break
    j+=1
newfn=('''function relayProbeCandidates(configured: string): string[] {
	const addrs: string[] = [];
	// cp774 — os.networkInterfaces() can THROW EAFNOSUPPORT ("Unknown system
	// error 97") under a systemd sandbox that omits AF_NETLINK from
	// RestrictAddressFamilies. If it throws here probeRelayAny rejects, refresh()
	// keeps the default, and /v1/health is stuck at up:false with no fetch ever
	// tried. Never let interface enumeration blank the probe.
	try {
		for (const list of Object.values(networkInterfaces())) {
			for (const a of list ?? []) {
				if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
			}
		}
	} catch {
		/* enumeration blocked by the sandbox — configured URL + loopback still probed */
	}
	return buildRelayCandidates(configured, addrs, defaultGatewayV4());
}''')
s=s[:m.start()]+newfn+s[j:]
open(p,"w",encoding='utf-8').write(s); print("PATCHED")
PYEOF
grep -q 'enumeration blocked by the sandbox' "$OH" && ok "relayProbeCandidates now catches the throw" || { bad "patch failed; restoring"; cp -a "$BK" "$OH"; exit 2; }

hdr "2. Clear cache, restart, verify /v1/health"
for c in /tmp/tsx-* "$IDXDIR/node_modules/.cache" /opt/morphit/node_modules/.cache; do [ -e "$c" ] && rm -rf "$c" 2>/dev/null; done
ok "tsx cache cleared"
systemctl restart morphit-indexer 2>/dev/null && ok "restarted" || warn "restart manually"
echo "  waiting for the snapshot to refresh..."
UP=""
for _ in $(seq 1 12); do sleep 6
	J="$(curl -s --max-time 4 "http://$IHOST:$IPORT/v1/health" 2>/dev/null)"; [ -z "$J" ] && continue
	UP="$(printf '%s' "$J" | grep -o '"relay":[[:space:]]*{[^}]*}' | grep -o '"up":[[:space:]]*[a-z]*' | grep -o '[a-z]*$')"
	[ "$UP" = "true" ] && break
done

hdr "VERDICT"
if [ "$UP" = "true" ]; then
	printf '%s%s\xe2\x9c\x93 PROVEN: /v1/health now reports relay: { up: true }.%s\n' "$g" "$b" "$x"
	echo "  Kept the fix in place (it bridges until the release ships the same change)."
	echo "  Backup: $BK  (revert with: sudo cp $BK $OH && sudo systemctl restart morphit-indexer)"
	exit 0
else
	bad "still not up:true (got '${UP:-unreadable}') — restoring the backup."
	cp -a "$BK" "$OH"; systemctl restart morphit-indexer 2>/dev/null || true
	echo "  Paste the output; I'll re-trace."
	exit 2
fi
