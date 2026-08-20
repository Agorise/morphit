#!/usr/bin/env bash
#
# relay-updown-proof.sh — settle relay:up:false once and for all. Run on the box:
#   sudo bash relay-updown-proof.sh
#
# It does NOT guess. It (1) tests EVERY way of reaching the relay WITH the
# indexer's real Tor/I2P router installed, (2) applies the one that works to the
# running indexer, and (3) reads /v1/health back to PROVE relay:up:true. Backs up
# before changing anything; prints how to revert. No release involved.
#
set -uo pipefail
IDXDIR="${IDXDIR:-/opt/morphit/apps/indexer}"
OH="$IDXDIR/src/api/operationalHealth.ts"
ENV_FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
TSX="${TSX:-/opt/morphit/node_modules/.bin/tsx}"
g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
bad(){ printf '  %s\xe2\x9c\x97%s %s\n' "$r" "$x" "$1"; }
hdr(){ printf '\n%s====== %s ======%s\n' "$b" "$1" "$x"; }

[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo bash relay-updown-proof.sh"; exit 1; }
[ -f "$OH" ] || { bad "indexer operationalHealth.ts not found at $OH (set IDXDIR=...)"; exit 1; }
[ -x "$TSX" ] || command -v tsx >/dev/null 2>&1 || { bad "tsx not found (set TSX=/path/to/tsx)"; exit 1; }

# load the indexer's exact env so the router + relay URL match what it runs with
set -a; for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && . "$f"; done; set +a

# ── figure out the relay URL the same way + discover a working one ────
RELAY_URL="${MORPHIT_INDEXER_RELAY_HEALTH_URL:-}"
if [ -z "$RELAY_URL" ] || ! curl -s --max-time 3 -o /dev/null -w '%{http_code}' "$RELAY_URL" 2>/dev/null | grep -q 200; then
	for h in "${MORPHIT_RELAY_LISTEN_HOST:-}" 172.18.0.1 127.0.0.1 $(ip -4 -o addr show 2>/dev/null | awk '$2 ~ /^(docker0|br-)/{print $4}' | cut -d/ -f1); do
		[ -z "$h" ] && continue
		u="http://${h}:${MORPHIT_RELAY_LISTEN_PORT:-8080}/v1/health"
		if curl -s --max-time 3 -o /dev/null -w '%{http_code}' "$u" 2>/dev/null | grep -q 200; then RELAY_URL="$u"; break; fi
	done
fi
[ -n "$RELAY_URL" ] || { bad "the relay does not answer /v1/health on any local address — it's genuinely down. Fix the relay first."; exit 2; }
hdr "0. Relay endpoint"
ok "relay answers (via curl, no router) at: $RELAY_URL"

# ── PART 1: test EVERY reach mechanism WITH the indexer's real router ──
hdr "1. Every mechanism, WITH the indexer's real Tor/I2P router installed"
TESTTS="$IDXDIR/_relay_mech_test.$$.ts"
cat > "$TESTTS" <<'TESTEOF'
import { installHiddenServiceDispatcher } from './src/indexer/hiddenServiceDispatcher.ts';
import { hiddenServiceProxyConfigFromEnv } from './src/indexer/hiddenServiceFetch.ts';
import { get as httpGet } from 'node:http';
import { request as undiciRequest, Agent, fetch as undiciFetch } from 'undici';
installHiddenServiceDispatcher(hiddenServiceProxyConfigFromEnv(process.env)); // EXACTLY like main.ts
const url = process.env.PROBE_URL!;
const T = 4000;
const nodeHttp = () => new Promise<string>((res) => {
	try { const q = httpGet(url, { timeout: T }, (s) => { s.resume(); res(String(s.statusCode)); });
		q.on('error', (e: any) => res('ERR ' + (e.code || e.message))); q.on('timeout', () => { q.destroy(); res('TIMEOUT'); }); }
	catch (e: any) { res('ERR ' + (e.message)); }
});
const builtinFetch = async () => { try { const rr = await fetch(url, { signal: AbortSignal.timeout(T) }); return String(rr.status); } catch (e: any) { return 'ERR ' + (e.cause?.code || e.message); } };
const undFetch = async () => { try { const rr = await undiciFetch(url, { signal: AbortSignal.timeout(T) }); return String(rr.status); } catch (e: any) { return 'ERR ' + (e.cause?.code || e.message); } };
const undFetchAgent = async () => { try { const rr = await undiciFetch(url, { signal: AbortSignal.timeout(T), dispatcher: new Agent() }); return String(rr.status); } catch (e: any) { return 'ERR ' + (e.cause?.code || e.message); } };
const undReqAgent = async () => { try { const rr = await undiciRequest(url, { dispatcher: new Agent(), headersTimeout: T, bodyTimeout: T }); rr.body.dump(); return String(rr.statusCode); } catch (e: any) { return 'ERR ' + (e.code || e.message); } };
(async () => {
	const rows: [string, string][] = [
		['node:http.get           (cp773 fix)', await nodeHttp()],
		['built-in fetch          (the bug)  ', await builtinFetch()],
		['undici fetch                       ', await undFetch()],
		['undici fetch + fresh Agent (cp772) ', await undFetchAgent()],
		['undici request + fresh Agent       ', await undReqAgent()]
	];
	for (const [name, code] of rows) console.log(`RESULT|${code.startsWith('2') ? 'OK ' : 'NO '}|${name}|${code}`);
})();
TESTEOF
# tsx must run FROM the indexer dir with its tsconfig so the $log/$indexer path
# aliases resolve (same as how the indexer itself launches). Run ONCE, capture.
MECH_OUT="$(cd "$IDXDIR" && PROBE_URL="$RELAY_URL" "$TSX" --tsconfig tsconfig.json "./$(basename "$TESTTS")" 2>&1)"
rm -f "$TESTTS"
printf '%s\n' "$MECH_OUT" | while IFS='|' read -r tag st name code; do
	if [ "$tag" = "RESULT" ]; then
		if [ "$st" = "OK " ]; then ok "$name -> $code"; else bad "$name -> $code"; fi
	else
		[ -n "${tag:-}" ] && echo "    $tag"
	fi
done
NODEHTTP_OK="$(printf '%s\n' "$MECH_OUT" | awk -F'|' '/node:http/ && $2=="OK "{print "yes"}')"

if [ "$NODEHTTP_OK" != "yes" ]; then
	bad "node:http did NOT reach the relay even with a direct connection. This is deeper than the router."
	echo "     Nothing changed. Paste the whole output above."
	exit 2
fi
ok "node:http reaches the relay through the router — this is the fix. Applying it to the running indexer."

# ── PART 2: apply node:http probeRelay to the DEPLOYED indexer ────────
hdr "2. Apply the node:http probe to the running indexer"
BK="$OH.bak-$(date +%s)"; cp -a "$OH" "$BK"; ok "backed up operationalHealth.ts -> $BK"
python3 - "$OH" <<'PYEOF'
import re, sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
# 1) ensure node:http/https imports
if "from 'node:http'" not in s:
    s = s.replace("import { readFileSync } from 'node:fs';",
                  "import { readFileSync } from 'node:fs';\nimport { get as httpGet, type IncomingMessage } from 'node:http';\nimport { get as httpsGet } from 'node:https';", 1)
# 2) remove any cp772 undici Agent import + directRelayDispatcher block
s = re.sub(r"\nimport \{ Agent \} from 'undici';\n", "\n", s)
s = re.sub(r"\n// cp772[^\n]*\n(?:// [^\n]*\n)*const directRelayDispatcher = new Agent\(\);\n", "\n", s)
# 3) replace the probeRelay function (async or sync) via brace-counting
m = re.search(r"(?:async )?function probeRelay\(", s)
if not m:
    print("PROBE_NOT_FOUND"); sys.exit(3)
i = s.index("{", m.end()); depth = 0; j = i
while j < len(s):
    if s[j] == "{": depth += 1
    elif s[j] == "}":
        depth -= 1
        if depth == 0: j += 1; break
    j += 1
newfn = ('''function probeRelay(url: string, timeoutMs: number): Promise<boolean> {
	if (url.length === 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (v: boolean): void => { if (!settled) { settled = true; resolve(v); } };
		try {
			const getter = url.startsWith('https:') ? httpsGet : httpGet;
			const req = getter(url, { headers: { accept: 'application/json', 'user-agent': 'morphit-indexer/operational-health-relay-probe' }, timeout: timeoutMs }, (res: IncomingMessage) => {
				const code = res.statusCode ?? 0; res.resume(); finish(code >= 200 && code < 300);
			});
			req.on('error', () => finish(false));
			req.on('timeout', () => { req.destroy(); finish(false); });
		} catch { finish(false); }
	});
}''')
s = s[:m.start()] + newfn + s[j:]
open(p, "w", encoding="utf-8").write(s)
print("PATCHED")
PYEOF
grep -q "httpGet" "$OH" && grep -q "function probeRelay" "$OH" && ok "operationalHealth.ts now probes via node:http" || { bad "patch failed; restoring backup"; cp -a "$BK" "$OH"; exit 2; }

# ── PART 3: restart + read /v1/health back ───────────────────────────
hdr "3. Restart the indexer and read /v1/health back"
systemctl restart morphit-indexer 2>/dev/null && ok "restarted morphit-indexer" || warn "restart it however you run it"
IHOST="${MORPHIT_INDEXER_LISTEN_HOST:-127.0.0.1}"; IPORT="${MORPHIT_INDEXER_LISTEN_PORT:-8081}"
echo "  waiting for the snapshot to refresh (up to ~60s)..."
UP=""
for _ in $(seq 1 10); do sleep 6
	for ih in "http://${IHOST}:${IPORT}/v1/health" "http://127.0.0.1:${IPORT}/v1/health"; do
		J="$(curl -s --max-time 4 "$ih" 2>/dev/null)"; [ -z "$J" ] && continue
		UP="$(printf '%s' "$J" | grep -o '"relay":[[:space:]]*{[^}]*}' | grep -o '"up":[[:space:]]*[a-z]*' | grep -o '[a-z]*$')"
		[ -n "$UP" ] && break
	done
	[ "$UP" = "true" ] && break
done

hdr "VERDICT"
if [ "$UP" = "true" ]; then
	printf '%s%s\xe2\x9c\x93 PROVEN: /v1/health now reports relay: { up: true }.%s\n' "$g" "$b" "$x"
	echo "  The node:http probe is the fix. Safe to cut the release with the same change."
	echo "  (If you ever want to undo this hot-patch: sudo cp $BK $OH && sudo systemctl restart morphit-indexer)"
	exit 0
else
	bad "/v1/health still not up:true (got: '${UP:-unreadable}'). Restoring the backup so nothing is left half-changed."
	cp -a "$BK" "$OH"; systemctl restart morphit-indexer 2>/dev/null || true
	echo "  Part 1 above shows which mechanisms reached the relay — paste the whole output."
	exit 2
fi
