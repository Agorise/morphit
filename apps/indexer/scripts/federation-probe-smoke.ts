/**
 * Federation probe — tsx smoke runner.
 *
 * Exercises probeOne()'s status classification by stubbing the
 * global fetch with scripted responses per URL.  Doesn't touch
 * the DB; the scheduler's persistence layer is verified via
 * type-checking and visual inspection.
 *
 * Status classification matrix is the most regression-prone
 * part of Phase D.5 — a misclassified probe poisons the whole
 * directory.  Every code path through probeOne() gets a test.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/federation-probe-smoke.ts
 */

import {
	probeOne,
	selfReachableStatus,
	makePinnedLookup,
	_setDnsResolverForTesting,
	type KnownInstanceRow,
	type ProbeStatus
} from '../src/indexer/federationProbe.ts';

// Cp3 (Part 122) — stub the DNS resolver too.  Without this the
// new DNS-rebinding defense runs a real lookup before fetch, which
// fails offline for synthetic test hostnames like `https://test.example`.
// The fetch stub below handles the network side; this handles the
// pre-fetch resolution side.  Production-mode runs without this
// stub do real DNS + per-IP validation.
_setDnsResolverForTesting(async (_hostname: string) => ({
	address: '203.0.113.1', // RFC 5737 documentation IP — never reachable, always public-class
	family: 4 as const
}));

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => {
				console.log(`  ✓ ${name}`);
			},
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

// ─── Fetch stubbing ──────────────────────────────────────────────

interface StubResponseSpec {
	/** HTTP status code; default 200. */
	status?: number;
	/** Body to return as JSON.  If undefined, response is non-ok. */
	json?: unknown;
	/** Throw on the fetch (network failure, DNS, TLS error). */
	throws?: string;
}

let stubbedRoutes: Map<string, StubResponseSpec> = new Map();
const realFetch = globalThis.fetch;

globalThis.fetch = (async (url: unknown, _opts?: unknown): Promise<Response> => {
	const u = typeof url === 'string' ? url : String(url);
	const spec = stubbedRoutes.get(u);
	if (spec === undefined) {
		throw new Error(`fetch stub: unmocked URL ${u}`);
	}
	if (spec.throws !== undefined) {
		throw new Error(spec.throws);
	}
	const status = spec.status ?? 200;
	if (spec.json === undefined) {
		return new Response('not found', { status });
	}
	return new Response(JSON.stringify(spec.json), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}) as typeof fetch;

function stubRoutes(routes: Record<string, StubResponseSpec>): void {
	stubbedRoutes = new Map(Object.entries(routes));
}

function unstub(): void {
	stubbedRoutes = new Map();
	globalThis.fetch = realFetch;
}

// ─── Helpers ─────────────────────────────────────────────────────

function makeRow(opts: {
	origin?: string;
	operator_account?: string;
	registered_at_time?: Date;
	cached_indexed_block?: number | null;
}): KnownInstanceRow {
	return {
		origin: opts.origin ?? 'https://test.example',
		operator_account: opts.operator_account ?? 'alice',
		registered_at_time: opts.registered_at_time ?? new Date(0),
		last_probed_at: null,
		last_probe_status: 'never',
		consecutive_failures: 0,
		cached_indexed_block: opts.cached_indexed_block ?? null
	};
}

function goodInstance(): unknown {
	return {
		name: 'test-instance',
		tagline: 'A test',
		contact_url: null,
		alt_networks: { tor: null, lokinet: null, i2p: null, nostr: null },
		fee_recipient: 'morphit-fees',
		relay_account: 'alice'
	};
}

function goodHealth(lagBlocks: number = 5): unknown {
	return {
		status: 'ok' as const,
		version: '0.1.0',
		uptime_sec: 3600,
		chain_head_block: 100_000,
		indexed_block: 100_000 - lagBlocks,
		lag_blocks: lagBlocks,
		stale: false
	};
}

function ordersWithOne(): unknown {
	const yesterday = new Date(Date.now() - 86_400_000);
	return {
		orders: [{ created_at: yesterday.toISOString() }]
	};
}

function ordersEmpty(): unknown {
	return { orders: [] };
}

console.log('\n── Federation probe ────────────────────────────────────');

// ─── Happy paths ─────────────────────────────────────────────────

await scenario('all-good with recent orders → good', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: goodHealth(5) },
		'https://test.example/v1/orderbook?limit=1': { json: ordersWithOne() }
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'good' as ProbeStatus, 'status');
	assertEqual(out.cachedName, 'test-instance', 'name');
	assertEqual(out.cachedIndexedBlock, 99_995, 'indexed_block');
	assertEqual(out.cachedChainLagSec, 15, 'chain_lag_sec'); // 5 blocks × 3s
});

await scenario('new instance + no orders → good (grace period)', async () => {
	const justRegistered = new Date(Date.now() - 60 * 1000); // 1 min ago
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: goodHealth(5) },
		'https://test.example/v1/orderbook?limit=1': { json: ordersEmpty() }
	});
	const out = await probeOne(makeRow({ registered_at_time: justRegistered }));
	assertEqual(out.status, 'good' as ProbeStatus, 'new-grace status');
});

await scenario('old instance + no orders → quiet', async () => {
	const oldRegistration = new Date(Date.now() - 30 * 86_400_000); // 30 days
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: goodHealth(5) },
		'https://test.example/v1/orderbook?limit=1': { json: ordersEmpty() }
	});
	const out = await probeOne(makeRow({ registered_at_time: oldRegistration }));
	assertEqual(out.status, 'quiet' as ProbeStatus, 'quiet status');
});

await scenario('orderbook fetch fails (old instance) → quiet', async () => {
	const oldRegistration = new Date(Date.now() - 30 * 86_400_000);
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: goodHealth(5) },
		'https://test.example/v1/orderbook?limit=1': { throws: 'connect ETIMEDOUT' }
	});
	const out = await probeOne(makeRow({ registered_at_time: oldRegistration }));
	assertEqual(out.status, 'quiet' as ProbeStatus, 'orderbook-fail-quiet status');
});

// ─── Mismatches ──────────────────────────────────────────────────

await scenario('relay_account mismatch → mismatch', async () => {
	stubRoutes({
		'https://test.example/v1/instance': {
			json: { ...(goodInstance() as Record<string, unknown>), relay_account: 'bob' }
		}
	});
	const out = await probeOne(makeRow({ operator_account: 'alice' }));
	assertEqual(out.status, 'mismatch' as ProbeStatus, 'status');
});

await scenario('/v1/instance unparseable → unreachable (cp770, not a fee-redirection accusation)', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: { not: 'an instance shape' } }
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'unreachable' as ProbeStatus, 'status');
});

// ─── Unreachable ─────────────────────────────────────────────────

await scenario('/v1/instance fetch throws → unreachable', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { throws: 'getaddrinfo ENOTFOUND' }
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'unreachable' as ProbeStatus, 'status');
});

await scenario('/v1/instance returns 503 → unreachable', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { status: 503 }
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'unreachable' as ProbeStatus, 'status');
});

await scenario('/v1/health fetch throws → unreachable', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { throws: 'connect ECONNREFUSED' }
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'unreachable' as ProbeStatus, 'status');
});

// ─── Stale ───────────────────────────────────────────────────────

// A reachable peer whose health is well-formed but 'degraded' is BEHIND, not
// broken. The health endpoint sets 'degraded' purely from chain lag, so a
// brand-new peer mid-initial-sync reports 'degraded' — it must show as
// 'syncing' (advertise itself the moment it registers), not 'stale'.
await scenario('health=degraded, first probe (no prior block) → syncing', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': {
			json: {
				...(goodHealth() as Record<string, unknown>),
				status: 'degraded',
				indexed_block: 40_000,
				lag_blocks: 60_000
			}
		}
	});
	// cached_indexed_block null = never probed before (a freshly-registered peer).
	const out = await probeOne(makeRow({ cached_indexed_block: null }));
	assertEqual(out.status, 'syncing' as ProbeStatus, 'status');
	assertEqual(out.cachedIndexedBlock, 40_000, 'indexed_block cached for next probe');
});

await scenario('health=degraded, indexed_block ADVANCING since last probe → syncing', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': {
			json: {
				...(goodHealth() as Record<string, unknown>),
				status: 'degraded',
				indexed_block: 50_000,
				lag_blocks: 50_000
			}
		}
	});
	// Prior probe saw 45_000; now 50_000 → advancing → still syncing.
	const out = await probeOne(makeRow({ cached_indexed_block: 45_000 }));
	assertEqual(out.status, 'syncing' as ProbeStatus, 'status');
	assertEqual(out.cachedIndexedBlock, 50_000, 'indexed_block');
});

await scenario('health=degraded, indexed_block FROZEN (not advancing) → stale', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': {
			json: {
				...(goodHealth() as Record<string, unknown>),
				status: 'degraded',
				indexed_block: 50_000,
				lag_blocks: 50_000
			}
		}
	});
	// Prior probe ALSO saw 50_000 → not advancing → stuck → stale, but the
	// snapshot is KEPT (frozen block cached) so it doesn't oscillate.
	const out = await probeOne(makeRow({ cached_indexed_block: 50_000 }));
	assertEqual(out.status, 'stale' as ProbeStatus, 'status');
	assertEqual(out.cachedIndexedBlock, 50_000, 'frozen block kept (no oscillation)');
	assertEqual(out.cachedName, 'test-instance', 'name kept while stale-behind');
});

await scenario('/v1/health malformed → stale', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: { wrong: 'shape' } }
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'stale' as ProbeStatus, 'status');
});

await scenario('chain lag > 30 blocks (reachable, health ok) → syncing', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: goodHealth(50) } // 50 blocks * 3s = 150s
	});
	const out = await probeOne(makeRow({}));
	// Reachable + health 'ok' but behind = catching up, not broken.
	assertEqual(out.status, 'syncing' as ProbeStatus, 'status');
	// Snapshot is cached like a healthy probe (instance data is valid).
	assertEqual(out.cachedName, 'test-instance', 'name');
	assertEqual(out.cachedIndexedBlock, 99_950, 'indexed_block'); // 100_000 - 50
	assertEqual(out.cachedChainLagSec, 150, 'chain_lag_sec'); // 50 blocks * 3s
});

await scenario('chain lag 31 blocks = 93s (just over threshold) → syncing', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: goodHealth(31) } // 93s lag > 90s threshold
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'syncing' as ProbeStatus, 'status');
});

await scenario('chain lag at boundary (29 blocks = 87s) → still good', async () => {
	const justRegistered = new Date(Date.now() - 60 * 1000);
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: goodHealth(29) },
		'https://test.example/v1/orderbook?limit=1': { json: ordersWithOne() }
	});
	const out = await probeOne(makeRow({ registered_at_time: justRegistered }));
	assertEqual(out.status, 'good' as ProbeStatus, 'status');
});

// ─── Self-reachable status (own-instance hairpin path) ───────────
//
// We can't network-probe our own public URL, so the scheduler marks
// the self row reachable locally — but it reads our OWN chain lag to
// distinguish 'good' (current) from 'syncing' (still catching up).
// This is Ken's exact scenario: our row showed a misleading status
// during initial sync; it should read 'syncing' until caught up.

await scenario('self-reachable: null lag (poller not running) → good', async () => {
	assertEqual(selfReachableStatus(null), 'good' as ProbeStatus, 'null-lag self status');
});

await scenario('self-reachable: 0 blocks behind → good', async () => {
	assertEqual(selfReachableStatus(0), 'good' as ProbeStatus, 'caught-up self status');
});

await scenario('self-reachable: 10 blocks behind (30s) → good', async () => {
	assertEqual(selfReachableStatus(10), 'good' as ProbeStatus, 'small-lag self status');
});

await scenario('self-reachable: 30 blocks = 90s (at threshold) → good', async () => {
	// 90s is NOT > 90s, so still good — matches the peer-probe boundary.
	assertEqual(selfReachableStatus(30), 'good' as ProbeStatus, 'boundary self status');
});

await scenario('self-reachable: 31 blocks = 93s (just over) → syncing', async () => {
	assertEqual(selfReachableStatus(31), 'syncing' as ProbeStatus, 'just-behind self status');
});

await scenario('self-reachable: huge lag (initial sync) → syncing', async () => {
	assertEqual(selfReachableStatus(2_000_000), 'syncing' as ProbeStatus, 'initial-sync self status');
});

// ─── Cleanup ─────────────────────────────────────────────────────

unstub();

// ─── cp672 — pinned-agent lookup must speak undici's { all: true } array shape ───
// Regression for ERR_INVALID_IP_ADDRESS: undici 6/7 calls connect.lookup with
// { all: true } and expects [{ address, family }]. The old single-address
// callback returned undefined for the address, silently breaking EVERY peer
// probe. These tests exercise the exact callback contract.
await scenario('cp672: lookup returns an ARRAY when undici passes { all: true }', () => {
	const lookup = makePinnedLookup('peer.example', '203.0.113.7', 4);
	let got: unknown;
	lookup('peer.example', { all: true }, (err, addr) => {
		if (err) throw err;
		got = addr;
	});
	assertEqual(got, [{ address: '203.0.113.7', family: 4 }], 'all:true → array of {address,family}');
});

await scenario('cp672: lookup returns single (address, family) when all is falsy', () => {
	const lookup = makePinnedLookup('peer.example', '203.0.113.7', 4);
	let addr: unknown, fam: unknown;
	lookup('peer.example', {}, (err, a, f) => {
		if (err) throw err;
		addr = a; fam = f;
	});
	assertEqual([addr, fam], ['203.0.113.7', 4], 'no-all → (address, family)');
});

await scenario('cp672: lookup refuses an unexpected hostname (DNS-rebinding closure)', () => {
	const lookup = makePinnedLookup('peer.example', '203.0.113.7', 4);
	let err: unknown;
	lookup('evil.example', { all: true }, (e) => { err = e; });
	assertEqual(err instanceof Error, true, 'mismatched hostname → Error');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
