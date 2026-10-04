#!/usr/bin/env tsx
/**
 * Smoke for the live RPC-directory → stats-card wiring.
 *
 * The /v1/rpc-endpoints canonical list is now re-derived per request as
 * `config.hiddenRpcEndpoints ∪ <on-chain rpc_directory hidden endpoints>`
 * (cached ~60s), instead of a startup snapshot of config only. So a hidden node
 * pinned on-chain (morphit_rpc_v1) shows on the stats card network-wide WITHOUT
 * an indexer restart or a Morphit release, and a removed one drops off
 * (rpc_directory is latest-wins). Clearnet stays hardcoded and excluded on
 * tor-only boxes exactly as before.
 *
 * Coverage:
 *   - unionHidden dedupes, config-first
 *   - directoryHiddenEndpoints returns ONLY hidden URLs (drops clearnet), cached
 *   - a newly-pinned directory node appears in the canonical list (no restart)
 *   - a removed node drops (latest-wins directory)
 *   - tor-only guard: directory hidden nodes appear, clearnet never does
 */
import {
	directoryHiddenEndpoints,
	unionHidden,
	canonicalProbeUrls,
	directoryNodeNames,
	withNamesSorted,
	__resetDirectoryHiddenCacheForTest
} from '../src/api/rpcHealth.ts';

let failures = 0;
let scenarios = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
	scenarios++;
	const done = (err?: unknown): void => {
		if (err) {
			failures++;
			console.log(`  ✗ ${name}`);
			console.log(`      ${err instanceof Error ? err.message : String(err)}`);
		} else console.log(`  ✓ ${name}`);
	};
	try {
		const r = fn();
		if (r instanceof Promise) return r.then(() => done()).catch(done);
		done();
	} catch (e) {
		done(e);
	}
}
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

const SEED = 'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091';
const NEW_ONION = 'http://xpqyoeap42iwmi6c6ew6svvtv2qwnkrbxpcshqitwmb3z2jqcvjb2nid.onion:8091';
const NEW_I2P = 'http://xenmlfwajcaiavtt24a3lwzzjiv4pgvfjaps4etlpvgmvupvvcea.b32.i2p:8091';
const CLEARNET = 'https://rpc.example.com';

function fakeDb(endpoints: string[], counter?: { n: number }) {
	return {
		query: async (_sql: string): Promise<{ rows: Array<{ endpoints: string[] }> }> => {
			if (counter) counter.n++;
			return { rows: [{ endpoints }] };
		}
	};
}

async function run(): Promise<void> {
	console.log('rpc-directory live-endpoints smoke:\n');

	check('unionHidden dedupes and keeps configured first', () => {
		const u = unionHidden([SEED, NEW_ONION], [NEW_ONION, NEW_I2P]);
		assert(u.length === 3, `expected 3 unique, got ${u.length}`);
		assert(u[0] === SEED, 'configured should come first');
		assert(u.includes(NEW_I2P), 'directory-only node should be present');
	});

	await check('directoryHiddenEndpoints returns ONLY hidden URLs (drops clearnet)', async () => {
		__resetDirectoryHiddenCacheForTest();
		const got = await directoryHiddenEndpoints(fakeDb([NEW_ONION, NEW_I2P, CLEARNET]), 1000);
		assert(got.includes(NEW_ONION) && got.includes(NEW_I2P), 'hidden URLs must be returned');
		assert(!got.includes(CLEARNET), 'clearnet URL must be filtered out of the directory hidden list');
	});

	await check('directory read is cached within the TTL, re-read after reset', async () => {
		__resetDirectoryHiddenCacheForTest();
		const counter = { n: 0 };
		const db = fakeDb([NEW_ONION], counter);
		await directoryHiddenEndpoints(db, 0);
		await directoryHiddenEndpoints(db, 30_000); // within 60s TTL
		const afterCached = counter.n;
		assert(afterCached === 1, `expected 1 DB read within TTL, got ${afterCached}`);
		__resetDirectoryHiddenCacheForTest();
		await directoryHiddenEndpoints(db, 30_000);
		const afterReset = counter.n;
		assert(afterReset === 2, `expected a re-read after reset, got ${afterReset}`);
	});

	await check('a newly-pinned directory node appears in the canonical list (no restart)', async () => {
		__resetDirectoryHiddenCacheForTest();
		const dirHidden = await directoryHiddenEndpoints(fakeDb([NEW_ONION, NEW_I2P]), 1000);
		const list = canonicalProbeUrls({
			usesClearnet: true,
			clearnetCanon: [CLEARNET],
			hidden: unionHidden([SEED], dirHidden),
			local: [],
			autoLocal: []
		});
		assert(list.includes(NEW_ONION) && list.includes(NEW_I2P), 'pinned nodes must appear without a restart');
		assert(list.includes(SEED), 'configured seed must still appear');
		assert(list.includes(CLEARNET), 'clearnet canon still present when usesClearnet');
	});

	await check('a removed node drops off (latest-wins directory)', async () => {
		__resetDirectoryHiddenCacheForTest();
		// directory now only has NEW_I2P (NEW_ONION was removed in the latest op)
		const dirHidden = await directoryHiddenEndpoints(fakeDb([NEW_I2P]), 1000);
		const list = canonicalProbeUrls({
			usesClearnet: true,
			clearnetCanon: [CLEARNET],
			hidden: unionHidden([SEED], dirHidden),
			local: [],
			autoLocal: []
		});
		assert(!list.includes(NEW_ONION), 'a node removed from the directory must not appear');
		assert(list.includes(NEW_I2P), 'a node still in the directory must appear');
	});

	await check('tor-only guard: directory hidden nodes appear, clearnet never does', async () => {
		__resetDirectoryHiddenCacheForTest();
		const dirHidden = await directoryHiddenEndpoints(fakeDb([NEW_ONION]), 1000);
		const list = canonicalProbeUrls({
			usesClearnet: false, // tor-only box
			clearnetCanon: [CLEARNET],
			hidden: unionHidden([SEED], dirHidden),
			local: [],
			autoLocal: []
		});
		assert(list.includes(NEW_ONION), 'directory hidden node must appear on a tor-only box');
		assert(!list.includes(CLEARNET), 'clearnet must NOT be probed/listed on a tor-only box');
	});

	// ── optional operator names + latency sort on /v1/rpc-endpoints ──────────
	await check('directoryNodeNames reads the url→name map (cached)', async () => {
		__resetDirectoryHiddenCacheForTest();
		const nameDb = {
			query: async (_sql: string): Promise<{ rows: Array<{ node_names: Record<string, unknown> }> }> => ({
				rows: [{ node_names: { [NEW_ONION]: 'kc', [NEW_I2P]: 'kc', bad: 42 } }]
			})
		};
		const names = await directoryNodeNames(nameDb, 1000);
		assert(names.get(NEW_ONION) === 'kc' && names.get(NEW_I2P) === 'kc', 'names must map by url');
		assert(!names.has('bad'), 'non-string name values must be dropped');
	});

	await check('withNamesSorted attaches names and sorts by latency ascending (nulls last)', async () => {
		const resp = {
			network: 'morphit' as const,
			generated_at: new Date(0).toISOString(),
			endpoints: [
				{ url: NEW_I2P, transport: 'i2p' as const, healthy: true, latency_ms: 1400, consecutive_failures: 0, cooldown_ms: 0 },
				{ url: CLEARNET, transport: 'clearnet' as const, healthy: true, latency_ms: 20, consecutive_failures: 0, cooldown_ms: 0 },
				{ url: NEW_ONION, transport: 'tor' as const, healthy: false, latency_ms: null, consecutive_failures: 1, cooldown_ms: 0 }
			]
		};
		const names = new Map([[NEW_I2P, 'kc']]);
		const out = withNamesSorted(resp, names);
		assert(out.endpoints[0]?.url === CLEARNET, 'fastest (20ms) must come first');
		assert(out.endpoints[1]?.url === NEW_I2P, 'next fastest (1400ms) second');
		assert(out.endpoints[2]?.url === NEW_ONION, 'null latency sorts last');
		assert(out.endpoints[1]?.name === 'kc', 'name attached to the matching url');
		assert(out.endpoints[0]?.name === undefined, 'unnamed url has no name field');
	});

	console.log(
		`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} rpc-directory live-endpoints scenarios passed`
	);
	process.exit(failures === 0 ? 0 : 1);
}

void run();
