#!/usr/bin/env bash
# relay-filelog-debug.sh — capture the running indexer's probe result to a FILE
# (robust vs journald), and confirm the process is even running this source file.
# Restores everything at the end. Run on the box:  sudo bash relay-filelog-debug.sh
set -uo pipefail
IDXDIR="${IDXDIR:-/opt/morphit/apps/indexer}"
OH="$IDXDIR/src/api/operationalHealth.ts"
LOG=/opt/morphit/.relay-debug.log
ENV_FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
g=$'\e[32m'; y=$'\e[33m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
[ -f "$OH" ] || { echo "no $OH"; exit 1; }
set -a; for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && . "$f"; done; set +a
IHOST="${MORPHIT_INDEXER_LISTEN_HOST:-127.0.0.1}"; IPORT="${MORPHIT_INDEXER_LISTEN_PORT:-8081}"

hdr "1. Inject file-logging into operationalHealth.ts (module-load marker + probe result)"
BK="$OH.flog-bak-$(date +%s)"; cp -a "$OH" "$BK"; ok "backed up -> $BK"
python3 - "$OH" "$LOG" <<'PYEOF'
import re, sys
p, log = sys.argv[1], sys.argv[2]
s=open(p,encoding='utf-8').read()
# 1) add appendFileSync to the node:fs import
if "appendFileSync" not in s:
    s=s.replace("import { readFileSync } from 'node:fs';","import { readFileSync, appendFileSync } from 'node:fs';",1)
# 2) module-load marker right after that import
marker=f"\ntry {{ appendFileSync('{log}', new Date().toISOString() + ' MODULE_LOADED pid=' + process.pid + '\\n'); }} catch {{}}\n"
s=s.replace("import { readFileSync, appendFileSync } from 'node:fs';","import { readFileSync, appendFileSync } from 'node:fs';"+marker,1)
# 3) replace probeRelayAny body to log to file
m=re.search(r"async function probeRelayAny\(", s)
if not m: print("NOT_FOUND"); sys.exit(3)
i=s.index("{", m.end()); depth=0; j=i
while j<len(s):
    if s[j]=="{": depth+=1
    elif s[j]=="}":
        depth-=1
        if depth==0: j+=1; break
    j+=1
newfn=("async function probeRelayAny(configured: string, timeoutMs: number): Promise<boolean> {\n"
       "\tconst cands = relayProbeCandidates(configured);\n"
       "\tconst results = await Promise.all(cands.map((u) => probeRelay(u, timeoutMs)));\n"
       f"\ttry {{ appendFileSync('{log}', new Date().toISOString() + ' PROBE configured=' + JSON.stringify(configured) + ' candidates=' + JSON.stringify(cands) + ' results=' + JSON.stringify(results) + '\\n'); }} catch {{}}\n"
       "\treturn results.some(Boolean);\n}")
s=s[:m.start()]+newfn+s[j:]
open(p,"w",encoding="utf-8").write(s); print("INJECTED")
PYEOF
grep -q "MODULE_LOADED" "$OH" && grep -q "PROBE configured" "$OH" && ok "file-logging injected" || { warn "inject failed; restoring"; cp -a "$BK" "$OH"; exit 2; }

hdr "2. Clear the log, restart, drive /v1/health"
rm -f "$LOG"; : > "$LOG"; chmod 666 "$LOG"; ok "log reset (world-writable so the indexer user can append)"
for c in /tmp/tsx-* "$IDXDIR/node_modules/.cache" /opt/morphit/node_modules/.cache; do [ -e "$c" ] && rm -rf "$c" 2>/dev/null && echo "    cleared tsx cache: $c"; done
ok "tsx cache cleared (so the injected file actually recompiles)"
systemctl restart morphit-indexer 2>/dev/null && ok "restarted" || warn "restart manually"
sleep 8
for _ in 1 2 3 4 5; do curl -s -o /dev/null "http://${IHOST}:${IPORT}/v1/health" 2>/dev/null || true; sleep 4; done
sleep 2

hdr "3. What the RUNNING process wrote"
if [ -s "$LOG" ]; then sed 's/^/  /' "$LOG" | tail -12
else warn "log is EMPTY — the running process is NOT executing $OH (stale/cached/other process serving /v1/health)"; fi

hdr "4. /v1/health right now"
printf '  %s\n' "$(curl -s --max-time 4 "http://${IHOST}:${IPORT}/v1/health" 2>/dev/null | grep -o '"relay":[[:space:]]*{[^}]*}')"

hdr "5. Also: which process actually listens on :$IPORT ?"
ss -ltnp 2>/dev/null | grep ":$IPORT" | sed 's/^/  /' || warn "nothing on :$IPORT?"

hdr "6. Restore + restart clean"
cp -a "$BK" "$OH"; ok "restored"; for c in /tmp/tsx-*; do rm -rf "$c" 2>/dev/null; done; systemctl restart morphit-indexer 2>/dev/null && ok "restarted clean" || true
echo
echo "MODULE_LOADED present + PROBE lines => we see the real in-process result."
echo "MODULE_LOADED ABSENT => the process serving /v1/health is NOT running this src file (the real problem)."
