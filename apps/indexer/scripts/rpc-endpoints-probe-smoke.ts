/**
 * rpc-endpoints-probe-smoke
 *
 * The stats page's "RPC endpoints" card shows how each public Blurt node is
 * doing, as this site's indexer measures it (v1.21.6: continuously, by
 * RpcHealthProber). Invariants:
 *
 *   ACCURATE AT ONCE — every node is measured on its own clock from boot, so a
 *   plain GET answers with real figures; one slow or dead node never delays
 *   the others; a node not measured yet is "not measured" (no latency, no
 *   failures), never "down"; a failure carries its reason and no stale latency.
 *
 *   DDoS guard — a forced re-measure (the refresh button, ?probe=1) happens at
 *   most once per 5 s across every caller, a burst sharing one round, and a node
 *   is never measured twice at once.
 *
 *   PRIVACY #1 — the browser never touches a Blurt node; the INDEXER probes
 *   them, and only the PUBLIC nodes, never the operator's private upstreams.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	probeEndpoints,
	canonicalProbeUrls,
	RpcHealthProber,
	PROBE_EVERY_MS,
	type ProbeResult
} from '../src/api/rpcHealth.ts';

let failures = 0;
let total = 0;
function check(name: string, cond: boolean): void {
	total++;
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Invalid hosts: the probe fetches fail fast, so we test SHAPE, not the network.
const urls = ['https://node-a.invalid', 'https://node-b.invalid'];
const r = await probeEndpoints(urls);
check(
	'probeEndpoints returns exactly the URLs it was given (never invents a host)',
	r.endpoints.length === 2 && r.endpoints.map((e) => e.url).join(',') === urls.join(',')
);
check(
	'a failed probe is unhealthy + null latency + two misses, never throws',
	r.endpoints.every((e) => e.healthy === false && e.latency_ms === null && e.consecutive_failures === 2)
);

// ── the background prober, with a fake clock and fake probes ──
const OK = (ms: number): ProbeResult => ({ ok: true, latencyMs: ms, reason: null, httpStatus: null });
const DOWN: ProbeResult = { ok: false, latencyMs: null, reason: 'timeout', httpStatus: null };
let now = 1_000_000;
const calls: string[] = [];
const pending = new Map<string, (r: ProbeResult) => void>();
const nodes = ['https://fast.example', 'http://slow.onion', 'https://dead.example'];
let list = nodes;
const prober = new RpcHealthProber(() => list, {
	now: () => now,
	probe: (u) =>
		new Promise<ProbeResult>((res) => {
			calls.push(u);
			pending.set(u, res);
		})
});
await prober.tick();
check('the first tick measures every listed node at once', calls.length === 3);
let snap = prober.snapshot(nodes);
check(
	'before any answer: every node "not measured" (no latency, no failures, checked_at null), never down',
	snap.endpoints.every((e) => e.latency_ms === null && e.consecutive_failures === 0 && e.checked_at === null)
);
pending.get('https://fast.example')!(OK(120));
await tick();
snap = prober.snapshot(nodes);
check(
	'a fast node shows its real latency while a slow one is still being measured (no waiting for the slowest)',
	snap.endpoints[0]!.healthy && snap.endpoints[0]!.latency_ms === 120 && snap.endpoints[1]!.checked_at === null
);
await prober.tick();
check('a node is never measured twice at once', calls.length === 3);
pending.get('https://dead.example')!(DOWN);
pending.get('http://slow.onion')!(OK(6200));
await tick();
snap = prober.snapshot(nodes);
const dead = snap.endpoints[2]!;
check(
	'a failed node shows its reason, two misses, no latency, and when it was measured',
	!dead.healthy && dead.failure_reason === 'timeout' && dead.consecutive_failures === 2 && dead.latency_ms === null && dead.checked_at !== null
);
check('a slow hidden node shows its real latency', snap.endpoints[1]!.latency_ms === 6200);
calls.length = 0;
// Due PROBE_EVERY_MS after the round STARTED, less half a 2 s tick of slack (so
// a round that started a few ms after its tick is taken at the tick 20 s on).
now += PROBE_EVERY_MS - 1_001;
await prober.tick();
check('nothing is re-measured before it is due', calls.length === 0);
now += 1;
await prober.tick();
check('every node is re-measured when due', calls.length === 3);
pending.get('https://dead.example')!(DOWN);
pending.get('https://fast.example')!(OK(90));
pending.get('http://slow.onion')!(OK(5000));
await tick();
check('a second failed round counts four misses', prober.snapshot(nodes).endpoints[2]!.consecutive_failures === 4);
check('a node that answers again shows its new latency', prober.snapshot(nodes).endpoints[0]!.latency_ms === 90);

// forced re-measure (refresh): rate-limited and coalesced
calls.length = 0;
const f1 = prober.checkAllNow();
const f2 = prober.checkAllNow();
await tick();
check('a burst of refreshes shares one round (one probe per node)', calls.length === 3);
for (const u of nodes) pending.get(u)!(OK(50));
await Promise.all([f1, f2]);
calls.length = 0;
now += 1000;
await prober.checkAllNow();
check('another refresh within 5 s pings nothing', calls.length === 0);

// the node list follows the directory
list = ['https://fast.example'];
await prober.tick();
check(
	'a node that leaves the list is forgotten',
	prober.snapshot(['https://dead.example']).endpoints[0]!.checked_at === null
);

// PRIVACY: main.ts must wire the CANONICAL public list to the route, never the
// raw clearnet config (`config.blurtRpcEndpoints`, which may include the
// operator's private upstream URLs). The published hidden-service endpoints
// (`config.hiddenRpcEndpoints`) ARE allowed — they're validated to be .onion /
// .b32.i2p (self-authenticating, public, can't be a private IP), so showing them
// with a transport badge leaks nothing.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const main = readFileSync(join(repo, 'apps/indexer/src/main.ts'), 'utf8');
check(
	'PRIVACY+cp767: route wires the CANONICAL clearnet list via publishedRpcEndpoints, gated on usesClearnet, and never SPREADS raw private upstreams',
	/publishedRpcEndpoints\([\s\S]*?clearnetCanon:\s*DEFAULT_BLURT_RPC_ENDPOINTS/.test(main) &&
		/usesClearnet:\s*config\.blurtRpcEndpoints\.length\s*>\s*0/.test(main) &&
		!/\.\.\.config\.blurtRpcEndpoints/.test(main)
);

// The route: a plain GET answers from the prober; ?probe=1 forces a round first.
const health = readFileSync(join(repo, 'apps/indexer/src/api/rpcHealth.ts'), 'utf8');
check(
	'the route serves the prober (?probe=1 re-measures first; 5 s forced-round limit)',
	/query\('probe'\) === '1'\) await prober\.checkAllNow\(\)/.test(health) &&
		/prober\.snapshot\(canonicalUrls\)/.test(health) &&
		/PROBE_MIN_INTERVAL_MS = 5_000/.test(health)
);
check(
	'main.ts starts the prober on the same public list the route shows, and stops it on shutdown',
	/new RpcHealthProber\(publishedRpcUrls\)/.test(main) &&
		/rpcProber\.start\(\)/.test(main) &&
		/rpcEndpointsRoute\(\s*rpcProber,\s*publishedRpcUrls/.test(main) &&
		/rpcProber\.stop\(\)/.test(main)
);

// ── a tor-only node's probe allow-list must EXCLUDE the clearnet canon ──
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
	console.log(`✓ all ${total} rpc-endpoints-probe scenarios passed`);
} else {
	console.log(`\n✗ ${failures}/${total} rpc-endpoints-probe scenarios failed`);
	process.exit(1);
}
