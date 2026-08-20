#!/usr/bin/env bash
# relay-runtime-debug.sh — see what probeRelayAny returns INSIDE the running
# indexer (not in isolation). Injects one debug log, restarts, reads the journal,
# then RESTORES the original + restarts. Run on the box:
#   sudo bash relay-runtime-debug.sh
set -uo pipefail
IDXDIR="${IDXDIR:-/opt/morphit/apps/indexer}"
OH="$IDXDIR/src/api/operationalHealth.ts"
ENV_FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
[ -f "$OH" ] || { echo "no $OH"; exit 1; }
set -a; for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && . "$f"; done; set +a
IHOST="${MORPHIT_INDEXER_LISTEN_HOST:-127.0.0.1}"; IPORT="${MORPHIT_INDEXER_LISTEN_PORT:-8081}"

hdr "1. Inject a debug log into probeRelayAny (temporary)"
BK="$OH.dbg-bak-$(date +%s)"; cp -a "$OH" "$BK"; ok "backed up -> $BK"
python3 - "$OH" <<'PYEOF'
import re, sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
m=re.search(r"async function probeRelayAny\(", s)
if not m: print("NOT_FOUND"); sys.exit(3)
i=s.index("{", m.end()); depth=0; j=i
while j < len(s):
    if s[j]=="{": depth+=1
    elif s[j]=="}":
        depth-=1
        if depth==0: j+=1; break
    j+=1
newfn=('''async function probeRelayAny(configured: string, timeoutMs: number): Promise<boolean> {
	const cands = relayProbeCandidates(configured);
	const results = await Promise.all(cands.map((u) => probeRelay(u, timeoutMs)));
	console.error('[relay-debug] configured=' + JSON.stringify(configured) + ' candidates=' + JSON.stringify(cands) + ' results=' + JSON.stringify(results) + ' -> up=' + results.some(Boolean));
	return results.some(Boolean);
}''')
s=s[:m.start()]+newfn+s[j:]
open(p,"w",encoding="utf-8").write(s); print("INJECTED")
PYEOF
grep -q '\[relay-debug\]' "$OH" && ok "debug log injected into probeRelayAny" || { warn "inject failed; restoring"; cp -a "$BK" "$OH"; exit 2; }

hdr "2. Restart + drive a few /v1/health requests to trigger refreshes"
systemctl restart morphit-indexer 2>/dev/null && ok "restarted" || warn "restart manually"
sleep 8
for _ in 1 2 3 4 5; do curl -s -o /dev/null "http://${IHOST}:${IPORT}/v1/health" 2>/dev/null || true; sleep 4; done
sleep 3

hdr "3. What probeRelayAny logged INSIDE the running process"
journalctl -u morphit-indexer --since "90 sec ago" --no-pager 2>/dev/null | grep -F '[relay-debug]' | tail -6 | sed 's/^/  /' || warn "no [relay-debug] lines found (is journald capturing the unit? try: journalctl -u morphit-indexer -n 50)"

hdr "4. What /v1/health shows right now"
J="$(curl -s --max-time 4 "http://${IHOST}:${IPORT}/v1/health" 2>/dev/null)"
printf '  relay -> %s\n' "$(printf '%s' "$J" | grep -o '"relay":[[:space:]]*{[^}]*}')"

hdr "5. Restore the original operationalHealth.ts + restart"
cp -a "$BK" "$OH"; ok "restored from $BK"
systemctl restart morphit-indexer 2>/dev/null && ok "restarted clean" || warn "restart manually"
echo
echo "Read the [relay-debug] line(s) above:"
echo "  results=[...,true,...]  -> probe SUCCEEDS in-process; bug is downstream (merge/getOperationalSnapshot/handler)"
echo "  results=[false,false,false] while the same URL is 200 in isolation -> the LIVE router/app breaks the in-process probe"
echo "  no line at all -> refresh() isn't calling probeRelayAny in the running process"
