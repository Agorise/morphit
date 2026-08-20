#!/usr/bin/env bash
# relay-refresh-trace.sh — trace refresh() in the running indexer: is it called,
# does probeRelayAny fulfill or REJECT (with reason), and what gets merged.
# Writes to a SHARED path (PrivateTmp-safe). Restores at the end.
#   sudo bash relay-refresh-trace.sh
set -uo pipefail
IDXDIR="${IDXDIR:-/opt/morphit/apps/indexer}"
OH="$IDXDIR/src/api/operationalHealth.ts"
LOG=/opt/morphit/.relay-refresh-trace.log
ENV_FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
g=$'\e[32m'; y=$'\e[33m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
set -a; for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && . "$f"; done; set +a
IHOST="${MORPHIT_INDEXER_LISTEN_HOST:-172.18.0.1}"; IPORT="${MORPHIT_INDEXER_LISTEN_PORT:-8081}"

hdr "1. Inject refresh() trace"
BK="$OH.trace-bak-$(date +%s)"; cp -a "$OH" "$BK"; ok "backed up -> $BK"
python3 - "$OH" "$LOG" <<'PYEOF'
import sys
p, log = sys.argv[1], sys.argv[2]
s=open(p,encoding='utf-8').read()
if "appendFileSync" not in s:
    s=s.replace("import { readFileSync } from 'node:fs';","import { readFileSync, appendFileSync } from 'node:fs';",1)
s=s.replace("import { readFileSync, appendFileSync } from 'node:fs';",
            "import { readFileSync, appendFileSync } from 'node:fs';\nconst __RLOG='%s';\nfunction __rlog(m:string){ try{ appendFileSync(__RLOG, new Date().toISOString()+' '+m+'\\n'); }catch{} }" % log, 1)
# entry
s=s.replace("async function refresh(relayHealthUrl: string): Promise<void> {",
            "async function refresh(relayHealthUrl: string): Promise<void> {\n\t__rlog('REFRESH_ENTRY url='+JSON.stringify(relayHealthUrl));",1)
# after allSettled
anchor="\t\tprobeRelayAny(relayHealthUrl, 5000)\n\t]);"
s=s.replace(anchor, anchor+"\n\t__rlog('REFRESH_SETTLED ipfs='+ipfsRes.status+' sys='+sysRes.status+' relay='+relayRes.status+' relayVal='+JSON.stringify(relayRes.status==='fulfilled'?relayRes.value:('REJECTED:'+String((relayRes as any).reason&&(relayRes as any).reason.message||(relayRes as any).reason))));",1)
# after merge
s=s.replace("\tlastRefreshMs = Date.now();\n}",
            "\tlastRefreshMs = Date.now();\n\t__rlog('REFRESH_MERGED cached.relay='+JSON.stringify(cached.relay));\n}",1)
open(p,"w",encoding='utf-8').write(s)
print("TRACED" if "REFRESH_ENTRY" in s and "REFRESH_SETTLED" in s and "REFRESH_MERGED" in s else "PARTIAL")
PYEOF
grep -q "REFRESH_SETTLED" "$OH" && ok "refresh() trace injected" || { warn "inject failed; restoring"; cp -a "$BK" "$OH"; exit 2; }

hdr "2. Clear cache, restart, drive /v1/health for ~40s"
: > "$LOG"; chmod 666 "$LOG"
for c in /tmp/tsx-* "$IDXDIR/node_modules/.cache" /opt/morphit/node_modules/.cache; do [ -e "$c" ] && rm -rf "$c" 2>/dev/null; done
ok "tsx cache cleared"
systemctl restart morphit-indexer 2>/dev/null && ok "restarted" || warn "restart manually"
sleep 8
for _ in $(seq 1 8); do curl -s -o /dev/null "http://$IHOST:$IPORT/v1/health" 2>/dev/null || true; sleep 4; done
sleep 2

hdr "3. refresh() trace (the truth about the relay value in-process)"
if [ -s "$LOG" ]; then tail -20 "$LOG" | sed 's/^/  /'; else warn "trace log empty — refresh() may not be running at all"; fi

hdr "4. /v1/health relay right now"
printf '  %s\n' "$(curl -s --max-time 4 "http://$IHOST:$IPORT/v1/health" 2>/dev/null | grep -o '"relay":[[:space:]]*{[^}]*}')"

hdr "5. Restore"
cp -a "$BK" "$OH"; ok "restored"; for c in /tmp/tsx-*; do rm -rf "$c" 2>/dev/null; done
systemctl restart morphit-indexer 2>/dev/null && ok "restarted clean" || true
echo
echo "Read the trace:"
echo "  REFRESH_SETTLED relay=rejected relayVal=REJECTED:...  -> probeRelayAny THROWS (reason shown) = the bug"
echo "  REFRESH_SETTLED relay=fulfilled relayVal=false        -> probe returns false in-process (env)"
echo "  relayVal=true but cached.relay={up:false}             -> merge bug"
echo "  no REFRESH_ENTRY at all                               -> refresh never runs (kickRefresh/wedge)"
