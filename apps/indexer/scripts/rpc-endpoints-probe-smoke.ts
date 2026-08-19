/**
 * rpc-endpoints-probe-smoke — cp453 (t.txt #1)
 *
 * The Settings "RPC endpoints" refresh button asks the indexer to ACTIVELY ping
 * every canonical Blurt node for fresh latency. Two invariants matter:
 *
 *   DDoS guard — a GLOBAL 5s cache means no volume of clicks can make the indexer
 *   ping the upstream nodes more than once per 5s (Ken: "we don't want some kid
 *   trying to ddos our server with massive clicks").
 *
 *   PRIVACY #1 — the browser never touches a Blurt node; the INDEXER probes them,
 *   and only the canonical PUBLIC nodes (`DEFAULT_BLURT_RPC_ENDPOINTS`), never the
 *   operator's private upstreams. main.ts must wire the canonical list, not the
 *   raw config endpoints.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	probeEndpoints,
	cachedProbeEndpoints,
	canonicalProbeUrls,
	__resetProbeCacheForTests
} from '../src/api/rpcHealth.ts';

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// Invalid hosts: the probe fetches fail fast, so we test SHAPE + CACHE, not net.
const urls = ['https://node-a.invalid', 'https://node-b.invalid'];

const r = await probeEndpoints(urls);
check(
	'probeEndpoints returns exactly the URLs it was given (never invents a host)',
	r.endpoints.length === 2 && r.endpoints.map((e) => e.url).join(',') === urls.join(',')
);
check(
	'a failed/unreachable probe is unhealthy + null latency, never throws',
	r.endpoints.every((e) => e.healthy === false && e.latency_ms === null)
);

// 5s server-side cache (DDoS guard): two calls within 5s share ONE probe.
__resetProbeCacheForTests();
const a = await cachedProbeEndpoints(urls);
const b = await cachedProbeEndpoints(urls);
check('cachedProbeEndpoints serves the SAME cached object within 5s (no re-ping)', a === b);

__resetProbeCacheForTests();
const c = await cachedProbeEndpoints(urls);
check('after the cache is cleared, a fresh probe is produced', c !== a);

// PRIVACY: main.ts must wire the CANONICAL public list to the route, never the
// raw clearnet config (`config.blurtRpcEndpoints`, which may include the
// operator's private upstream URLs). The published hidden-service endpoints
// (`config.hiddenRpcEndpoints`) ARE allowed — they're validated to be .onion /
// .b32.i2p (self-authenticating, public, can't be a private IP), so showing them
// with a transport badge leaks nothing.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const main = readFileSync(join(repo, 'apps/indexer/src/main.ts'), 'utf8');
check(
	'PRIVACY+cp767: route wires the CANONICAL clearnet list via canonicalProbeUrls, gated on usesClearnet, and never SPREADS raw private upstreams',
	/canonicalProbeUrls\([\s\S]*?clearnetCanon:\s*DEFAULT_BLURT_RPC_ENDPOINTS/.test(main) &&
		/usesClearnet:\s*config\.blurtRpcEndpoints\.length\s*>\s*0/.test(main) &&
		!/\.\.\.config\.blurtRpcEndpoints/.test(main)
);

// The route rate-limits probes AND keeps the passive default cheap.
const health = readFileSync(join(repo, 'apps/indexer/src/api/rpcHealth.ts'), 'utf8');
check(
	'the probe is gated behind ?probe=1 (default stays the cheap passive snapshot)',
	/query\('probe'\) === '1'/.test(health) && /PROBE_MIN_INTERVAL_MS = 5_000/.test(health)
);

// ── cp767: a tor-only node's probe allow-list must EXCLUDE the clearnet canon ──
// so the active ?probe=1 never fetches a clearnet RPC (IP leak) and the widget
// matches the real hidden-only pool instead of listing phantom clearnet nodes.
const clearnetCanon = ['https://rpc.a.example', 'https://rpc.b.example'];
const hidden = ['http://aaa.onion:8091', 'http://bbb.b32.i2p:8091'];
{
	// tor-only: clearnet pool empty → usesClearnet=false → clearnet excluded.
	const list = canonicalProbeUrls({ usesClearnet: false, clearnetCanon, hidden, local: [], autoLocal: [] });
	check('tor-only allow-list drops the clearnet canon entirely', !list.some((u) => clearnetCanon.includes(u)));
	check('tor-only allow-list keeps the hidden endpoints', hidden.every((h) => list.includes(h)));
	check('tor-only allow-list would probe ONLY hidden (no clearnet fetch → no IP leak)', list.length === hidden.length);
}
{
	// clearnet node: usesClearnet=true → clearnet canon included as before.
	const list = canonicalProbeUrls({ usesClearnet: true, clearnetCanon, hidden, local: ['http://127.0.0.1:8091'], autoLocal: [] });
	check('clearnet node keeps the clearnet canon + hidden + local', clearnetCanon.every((c) => list.includes(c)) && hidden.every((h) => list.includes(h)) && list.includes('http://127.0.0.1:8091'));
}

if (failures === 0) {
	console.log('✓ all 10 rpc-endpoints-probe scenarios passed');
} else {
	console.log(`\n✗ ${failures}/10 rpc-endpoints-probe scenarios failed`);
	process.exit(1);
}
