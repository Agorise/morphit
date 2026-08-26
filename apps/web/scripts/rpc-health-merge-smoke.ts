#!/usr/bin/env tsx
/**
 * Smoke for the stats-card fresh/passive health merge (rpcHealthMerge).
 *
 * A single fresh ?probe=1 miss on a node the smoothed pool still calls healthy
 * (flaky WiFi / jittery i2p) must NOT render as a hard "unreachable" — it stays
 * up with its last-known latency. A genuine outage (sustained, or a non-blip
 * reason) still shows through.
 */
import { mergeFreshOverPassive, passiveIndex } from '../src/lib/net/rpcHealthMerge.ts';
import type { RpcEndpointHealth } from '@morphit/indexer-client';

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

function ep(url: string, o: Partial<RpcEndpointHealth> = {}): RpcEndpointHealth {
	return {
		url,
		transport: 'i2p',
		healthy: true,
		latency_ms: 1400,
		consecutive_failures: 0,
		cooldown_ms: 0,
		failure_reason: null,
		http_status: null,
		...o
	} as RpcEndpointHealth;
}

const URL_WIFI = 'http://5cfk2jmub7gnte536sxezapgkykirje6v6omouhpymfo52eh473a.b32.i2p:8091';
const URL_OK = 'http://xenmlfwajcaiavtt24a3lwzzjiv4pgvfjaps4etlpvgmvupvvcea.b32.i2p:8091';
const URL_DOWN = 'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091';

console.log('rpc-health-merge smoke:\n');

// passive: everything healthy (the smoothed truth)
const passive = passiveIndex([
	ep(URL_WIFI, { latency_ms: 4600 }),
	ep(URL_OK, { latency_ms: 1397 }),
	ep(URL_DOWN, { transport: 'tor', latency_ms: 1463 })
]);

// 1. lone transient network miss on a passive-healthy node → shown healthy (last-known latency)
{
	const fresh = [
		ep(URL_WIFI, { healthy: false, latency_ms: null, failure_reason: 'network', consecutive_failures: 1 })
	];
	const merged = mergeFreshOverPassive(fresh, passive);
	check('transient network miss on passive-healthy → stays UP', merged[0].healthy === true);
	check('  keeps last-known latency', merged[0].latency_ms === 4600, `got ${merged[0].latency_ms}`);
}

// 2. lone transient timeout miss → same treatment
{
	const fresh = [ep(URL_WIFI, { healthy: false, latency_ms: null, failure_reason: 'timeout', consecutive_failures: 1 })];
	const merged = mergeFreshOverPassive(fresh, passive);
	check('transient timeout miss on passive-healthy → stays UP', merged[0].healthy === true);
}

// 3. fresh SUCCESS is trusted (current latency wins)
{
	const fresh = [ep(URL_OK, { healthy: true, latency_ms: 900 })];
	const merged = mergeFreshOverPassive(fresh, passive);
	check('fresh success trusted (current latency)', merged[0].healthy === true && merged[0].latency_ms === 900);
}

// 4. SUSTAINED failure (consecutive_failures >= 2) is NOT suppressed → shows red
{
	const fresh = [ep(URL_WIFI, { healthy: false, latency_ms: null, failure_reason: 'network', consecutive_failures: 3 })];
	const merged = mergeFreshOverPassive(fresh, passive);
	check('sustained failure shows through (not suppressed)', merged[0].healthy === false);
}

// 5. non-transient reason (rpc_error / http) is NOT suppressed even if 1 failure
{
	const fresh = [ep(URL_DOWN, { transport: 'tor', healthy: false, latency_ms: null, failure_reason: 'http', http_status: 503, consecutive_failures: 1 })];
	const merged = mergeFreshOverPassive(fresh, passive);
	check('non-transient reason (http 503) shows through', merged[0].healthy === false);
}

// 6. transient miss but passive ALSO unhealthy → genuine outage, shows red
{
	const passiveDown = passiveIndex([ep(URL_WIFI, { healthy: false, latency_ms: null, failure_reason: 'network', consecutive_failures: 4 })]);
	const fresh = [ep(URL_WIFI, { healthy: false, latency_ms: null, failure_reason: 'network', consecutive_failures: 1 })];
	const merged = mergeFreshOverPassive(fresh, passiveDown);
	check('transient miss + passive-unhealthy → stays red (real outage)', merged[0].healthy === false);
}

console.log(`\n${failures === 0 ? '✓ all' : '✗'} ${n - failures}${failures === 0 ? '' : '/' + n} rpc-health-merge scenarios passed`);
process.exit(failures === 0 ? 0 : 1);
