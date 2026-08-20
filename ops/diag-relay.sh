#!/usr/bin/env bash
# diag-relay.sh — show EXACTLY what the indexer process sees + can reach, so the
# relay:up:false cause is observed, not guessed. Run on morphit.io:
#   sudo bash diag-relay.sh
# Changes nothing. Just prints. Paste the whole output back.
set -uo pipefail
echo "==== 1. what interfaces does a node process actually see? ===="
node -e '
const os=require("os"); const out=[];
for(const [name,list] of Object.entries(os.networkInterfaces())) for(const a of list||[]) if(a.family==="IPv4") out.push(`${name} ${a.address}${a.internal?" (internal)":""}`);
console.log(out.join("\n"));
' 2>&1 || echo "(node not on PATH here — try: cd /opt/morphit && node -e ...)"

echo ""
echo "==== 2. default gateway (as /proc/net/route reports it) ===="
awk 'NR>1 && $2=="00000000"{printf("%d.%d.%d.%d\n", strtonum("0x" substr($3,7,2)),strtonum("0x" substr($3,5,2)),strtonum("0x" substr($3,3,2)),strtonum("0x" substr($3,1,2)))}' /proc/net/route 2>/dev/null | head -1

echo ""
echo "==== 3. can a PLAIN node fetch reach the relay? (default dispatcher) ===="
node -e '
(async()=>{
  for(const url of ["http://172.18.0.1:8080/v1/health","http://127.0.0.1:8080/v1/health"]){
    try{ const r=await fetch(url,{signal:AbortSignal.timeout(4000)}); const t=(await r.text()).slice(0,60); console.log(url,"->",r.status,r.ok,"| body:",t.replace(/\n/g," "));}
    catch(e){ console.log(url,"-> ERROR",e.message,(e.cause&&e.cause.code)||"");}
  }
})();
' 2>&1

echo ""
echo "==== 4. same URLs via curl (shell), for comparison ===="
for u in http://172.18.0.1:8080/v1/health http://127.0.0.1:8080/v1/health; do
  printf '%s -> HTTP %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$u" 2>/dev/null || echo ERR)"
done

echo ""
echo "==== 5. what does the indexer ACTUALLY have configured + which env files feed it? ===="
systemctl show morphit-indexer -p EnvironmentFiles -p ExecStart 2>/dev/null | sed 's/^/  /'
echo "  --- RELAY_HEALTH_URL / LISTEN_HOST across likely files ---"
grep -RnE 'MORPHIT_INDEXER_RELAY_HEALTH_URL|MORPHIT_(INDEXER|RELAY)_LISTEN_HOST' /etc/morphit /opt/morphit 2>/dev/null | grep -v '\.bak-' | sed 's/^/  /'

echo ""
echo "==== 6. is the indexer even on 1.12.12 code? (cp771 present in the running tree?) ===="
grep -c 'cp771' /opt/morphit/apps/indexer/src/api/operationalHealth.ts 2>/dev/null | sed 's/^/  cp771 markers in operationalHealth.ts: /'
echo "  (0 = the running code predates cp771; >0 = cp771 is on disk)"
