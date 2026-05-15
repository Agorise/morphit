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
}): KnownInstanceRow {
	return {
		origin: opts.origin ?? 'https://test.example',
		operator_account: opts.operator_account ?? 'alice',
		registered_at_time: opts.registered_at_time ?? new Date(0),
		last_probed_at: null,
		last_probe_status: 'never',
		consecutive_failures: 0
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

await scenario('/v1/instance malformed → mismatch', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: { not: 'an instance shape' } }
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'mismatch' as ProbeStatus, 'status');
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

await scenario('health=degraded → stale', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': {
			json: { ...(goodHealth() as Record<string, unknown>), status: 'degraded' }
		}
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'stale' as ProbeStatus, 'status');
});

await scenario('/v1/health malformed → stale', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: { wrong: 'shape' } }
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'stale' as ProbeStatus, 'status');
});

await scenario('chain lag > 30 blocks → stale', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: goodHealth(50) } // 50 blocks * 3s = 150s
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'stale' as ProbeStatus, 'status');
});

await scenario('chain lag exactly 30 blocks → stale (90s, threshold is < 90)', async () => {
	stubRoutes({
		'https://test.example/v1/instance': { json: goodInstance() },
		'https://test.example/v1/health': { json: goodHealth(31) } // 93s lag
	});
	const out = await probeOne(makeRow({}));
	assertEqual(out.status, 'stale' as ProbeStatus, 'status');
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

// ─── Cleanup ─────────────────────────────────────────────────────

unstub();

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
