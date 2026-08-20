#!/usr/bin/env bash
# relay-snapshot-diag.sh — read-only. Exercises the REAL snapshot code path the
# indexer uses for relay.up, and prints where it breaks. Run on the box:
#   sudo bash relay-snapshot-diag.sh
set -uo pipefail
IDXDIR="${IDXDIR:-/opt/morphit/apps/indexer}"
ENV_FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
TSX="${TSX:-/opt/morphit/node_modules/.bin/tsx}"
b=$'\e[1m'; x=$'\e[0m'
[ -f "$IDXDIR/src/api/operationalHealth.ts" ] || { echo "operationalHealth.ts not found (set IDXDIR=)"; exit 1; }
set -a; for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && . "$f"; done; set +a

printf '%s== Exercising the REAL relay-snapshot code path ==%s\n' "$b" "$x"
T="$IDXDIR/_snap_diag.$$.ts"
cat > "$T" <<'TESTEOF'
import { getOperationalSnapshot, primeOperationalSnapshot, buildRelayCandidates } from './src/api/operationalHealth.ts';
import { installHiddenServiceDispatcher } from './src/indexer/hiddenServiceDispatcher.ts';
import { hiddenServiceProxyConfigFromEnv } from './src/indexer/hiddenServiceFetch.ts';
import { networkInterfaces } from 'node:os';
import { get as httpGet } from 'node:http';
installHiddenServiceDispatcher(hiddenServiceProxyConfigFromEnv(process.env)); // like main.ts

const relayUrl = (process.env.MORPHIT_INDEXER_RELAY_HEALTH_URL ?? '').trim();
console.log('  config.relayHealthUrl = "' + relayUrl + '"' + (relayUrl === '' ? '   <-- EMPTY' : ''));

const addrs: string[] = [];
for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
console.log('  non-internal IPv4 seen = ' + JSON.stringify(addrs));

const cands = buildRelayCandidates(relayUrl, addrs, null);
console.log('  buildRelayCandidates -> ' + JSON.stringify(cands));

const probe = (u: string) => new Promise<string>((res) => {
	try { const q = httpGet(u, { timeout: 4000 }, (s) => { s.resume(); res(String(s.statusCode)); });
		q.on('error', (e: any) => res('ERR ' + (e.code || e.message))); q.on('timeout', () => { q.destroy(); res('TIMEOUT'); }); }
	catch (e: any) { res('ERR ' + e.message); }
});
(async () => {
	for (const u of cands) console.log('    candidate ' + u + ' -> ' + await probe(u));
	console.log('  priming the operational snapshot (real refresh: probeRelayAny + system + ipfs)...');
	primeOperationalSnapshot(relayUrl);
	await new Promise((r) => setTimeout(r, 8000));
	const snap = getOperationalSnapshot(relayUrl);
	console.log('  >>> snapshot.relay  = ' + JSON.stringify(snap.relay) + '   (this is what /v1/health shows)');
	console.log('      snapshot.system = mem_pct:' + JSON.stringify(snap.system?.mem_pct) + ' (sanity: non-null => refresh IS running)');
	console.log('      snapshot.ipfs   = ' + JSON.stringify(snap.ipfs_seeding?.state));
})();
TESTEOF
(cd "$IDXDIR" && "$TSX" --tsconfig tsconfig.json "./$(basename "$T")" 2>&1)
rm -f "$T"
echo ""
echo "Interpretation:"
echo "  - relayHealthUrl EMPTY + candidates still include 172.18.0.1  -> cp771 OK, look at probe result"
echo "  - a candidate 172.18.0.1:8080 -> 200 but snapshot.relay=up:false -> bug is probeRelayAny/refresh, NOT the fetch"
echo "  - snapshot.system non-null but relay false -> refresh runs; relay merge/probe is the culprit"
