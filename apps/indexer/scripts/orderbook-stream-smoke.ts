/**
 * Orderbook-stream pure helpers — tsx smoke runner.
 *
 * Covers buildWhereClauses (SQL fragment generation) and
 * rowToWire (DB row → wire shape).  Both are pure; testing
 * them ensures the SSE endpoint's filter and wire format
 * stay aligned with the REST endpoint.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/orderbook-stream-smoke.ts
 */

import {
	buildWhereClauses,
	makeFetchSerializer,
	rowToWire,
	type OrderbookStreamRow
} from '../src/api/orderbookStreamHelpers.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function asyncScenario(name: string, fn: () => Promise<void>): Promise<void> {
	scenarios++;
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Resolve after `n` macrotasks; lets the serializer's
 *  `await doFetch()` complete and the loop control logic
 *  to run. */
function tickN(n: number): Promise<void> {
	let p = Promise.resolve();
	for (let i = 0; i < n; i++) {
		p = p.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
	}
	return p;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

function assertTrue(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

function makeRow(overrides: Partial<OrderbookStreamRow> = {}): OrderbookStreamRow {
	return {
		account: 'alice',
		permlink: 'sell-btc-eur-2026-04',
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'EUR',
		amount_min: '50.00',
		amount_max: '500.00',
		price_model: 'mid+1%',
		location_region: 'Berlin',
		payment_methods: ['cash', 'sepa'],
		terms: 'meet at café',
		fee_method: 'blurt',
		feedback_count: 5,
		weighted_rating: '4.5',
		is_new_trader: false,
		created_at: new Date('2026-04-01T10:00:00Z'),
		updated_at: new Date('2026-04-26T12:00:00Z'),
		expires_at: new Date('2026-05-01T00:00:00Z'),
		...overrides
	};
}

console.log('\n── Orderbook stream helpers ────────────────────────────');

// ─── buildWhereClauses ───────────────────────────────────────────

scenario('buildWhereClauses: empty filter → base clauses only', () => {
	const { where, params } = buildWhereClauses({});
	assertEqual(
		where,
		[
			`o.status = 'live'`,
			`o.fee_status IN ('verified', 'verified_by_attestation')`,
			// BATCH19A-orderbook-1: filter past-expires_at orders
			`(o.expires_at IS NULL OR o.expires_at > NOW())`
		],
		'where'
	);
	assertEqual(params, [], 'no params');
});

scenario('buildWhereClauses: operator account adds the block-exclusion clause', () => {
	const { where, params } = buildWhereClauses({}, 0, 'morphit');
	assertTrue(where.length === 4, 'base clauses + block exclusion');
	assertTrue(
		where[3]!.includes('operator_blocks') && where[3]!.includes("ob.state = 'blocked'"),
		'block exclusion clause present'
	);
	assertEqual(params, ['morphit'], 'operator bound as a param');
});

scenario('buildWhereClauses: empty operator account skips the block clause', () => {
	const { where } = buildWhereClauses({}, 0, '');
	assertTrue(where.length === 3, 'no block clause when no operator supplied');
});

scenario('buildWhereClauses: asset filter binds correctly', () => {
	const { where, params } = buildWhereClauses({ asset: 'BTC' });
	assertTrue(where.length === 4, 'four clauses (3 base + asset)');
	assertEqual(where[3], 'o.asset = $1', 'asset clause');
	assertEqual(params, ['BTC'], 'params');
});

scenario('buildWhereClauses: side filter binds correctly', () => {
	const { where, params } = buildWhereClauses({ side: 'sell' });
	assertEqual(where[3], 'o.side = $1', 'side clause');
	assertEqual(params, ['sell'], 'params');
});

scenario('buildWhereClauses: fiat_currency filter binds correctly', () => {
	const { where, params } = buildWhereClauses({ fiat_currency: 'USD' });
	assertEqual(where[3], 'o.fiat_currency = ANY($1::text[])', 'fiat clause');
	assertEqual(params, [['USD']], 'params');
});

scenario('buildWhereClauses: location_region uses ILIKE prefix match', () => {
	const { where, params } = buildWhereClauses({ location_region: 'Berl' });
	assertTrue(
		where[3]!.includes('ILIKE') && where[3]!.includes("ESCAPE '\\'"),
		'ILIKE prefix with escape'
	);
	assertEqual(params, ['Berl%'], 'normalized + suffixed param');
});

scenario('buildWhereClauses: location_region NFC-normalizes input', () => {
	// "é" decomposed (e + combining acute) NFC-normalizes to
	// "é" precomposed.  After normalization + escapeLike + '%'.
	const decomposed = 'Caf\u0065\u0301'; // "Café" decomposed
	const { params } = buildWhereClauses({ location_region: decomposed });
	const normalized = decomposed.normalize('NFC');
	assertEqual(params, [normalized + '%'], 'normalized form');
});

scenario('buildWhereClauses: payment_methods splits + lowercases tokens', () => {
	const { where, params } = buildWhereClauses({
		payment_methods: 'PayPal, SEPA,cash  '
	});
	assertTrue(where[3]!.includes('EXISTS'), 'EXISTS subquery');
	assertEqual(params, [['paypal', 'sepa', 'cash']], 'lowercased + trimmed');
});

scenario('buildWhereClauses: payment_methods drops oversized tokens', () => {
	const { params } = buildWhereClauses({
		payment_methods: 'cash,' + 'a'.repeat(50)
	});
	assertEqual(params, [['cash']], 'oversized dropped');
});

scenario('buildWhereClauses: payment_methods empty after filter → no EXISTS', () => {
	const { where } = buildWhereClauses({
		payment_methods: 'a'.repeat(50)
	});
	assertEqual(where.length, 3, 'no EXISTS clause (3 base only)');
});

scenario('buildWhereClauses: min_trades > 0 adds clause', () => {
	const { where, params } = buildWhereClauses({ min_trades: 3 });
	assertEqual(where[3], 'COALESCE(f.c, 0) >= $1', 'min_trades clause');
	assertEqual(params, [3], 'params');
});

scenario('buildWhereClauses: min_trades = 0 omitted', () => {
	const { where } = buildWhereClauses({ min_trades: 0 });
	assertEqual(where.length, 3, 'no min_trades clause (3 base only)');
});

scenario('buildWhereClauses: combined filter binds in order', () => {
	const { where, params } = buildWhereClauses({
		asset: 'BTC',
		side: 'sell',
		fiat_currency: 'EUR',
		min_trades: 2
	});
	assertEqual(where[3], 'o.asset = $1', 'asset $1');
	assertEqual(where[4], 'o.side = $2', 'side $2');
	assertEqual(where[5], 'o.fiat_currency = ANY($3::text[])', 'fiat $3');
	assertEqual(where[6], 'COALESCE(f.c, 0) >= $4', 'min_trades $4');
	assertEqual(params, ['BTC', 'sell', ['EUR'], 2], 'params in order');
});

scenario('buildWhereClauses: startIndex offsets parameter numbering', () => {
	// Caller has already bound $1, $2 (account, permlink) — tells
	// builder to start at $3 for the filter params.
	const { where, params } = buildWhereClauses({ asset: 'XMR' }, 2);
	assertEqual(where[3], 'o.asset = $3', 'param starts at $3');
	assertEqual(params, ['XMR'], 'one param');
});

// ─── rowToWire ───────────────────────────────────────────────────

scenario('rowToWire: full row → full wire shape', () => {
	const r = makeRow();
	const w = rowToWire(r);
	assertEqual(w.account, 'alice', 'account');
	assertEqual(w.permlink, 'sell-btc-eur-2026-04', 'permlink');
	assertEqual(w.side, 'sell', 'side');
	assertEqual(w.asset, 'BTC', 'asset');
	assertEqual(w.amount_min, 50, 'amount_min as number');
	assertEqual(w.amount_max, 500, 'amount_max as number');
	assertEqual(w.weighted_rating, 4.5, 'weighted_rating as number');
	assertEqual(w.feedback_count, 5, 'feedback_count');
	assertEqual(w.created_at, '2026-04-01T10:00:00.000Z', 'created_at iso');
	assertEqual(w.updated_at, '2026-04-26T12:00:00.000Z', 'updated_at iso');
	assertEqual(w.expires_at, '2026-05-01T00:00:00.000Z', 'expires_at iso');
});

scenario('rowToWire: null amounts and rating preserved', () => {
	const r = makeRow({
		amount_min: null,
		amount_max: null,
		weighted_rating: null
	});
	const w = rowToWire(r);
	assertEqual(w.amount_min, null, 'amount_min null');
	assertEqual(w.amount_max, null, 'amount_max null');
	assertEqual(w.weighted_rating, null, 'weighted_rating null');
});

scenario('rowToWire: null expires_at preserved', () => {
	const r = makeRow({ expires_at: null });
	const w = rowToWire(r);
	assertEqual(w.expires_at, null, 'expires_at null');
});

scenario('rowToWire: numeric strings coerced to JS numbers', () => {
	// pg returns NUMERIC as string; the wire format coerces.
	const r = makeRow({ amount_min: '0.01', amount_max: '99999.99' });
	const w = rowToWire(r);
	assertEqual(w.amount_min, 0.01, 'min coerced');
	assertEqual(w.amount_max, 99999.99, 'max coerced');
});

scenario('rowToWire: payment_methods array passes through', () => {
	const r = makeRow({ payment_methods: ['cash', 'wise', 'paypal'] });
	const w = rowToWire(r);
	assertEqual(w.payment_methods, ['cash', 'wise', 'paypal'], 'arr passed');
});

scenario('rowToWire: is_new_trader boolean passes through', () => {
	const a = rowToWire(makeRow({ is_new_trader: true }));
	const b = rowToWire(makeRow({ is_new_trader: false }));
	assertEqual(a.is_new_trader, true, 'true');
	assertEqual(b.is_new_trader, false, 'false');
});

scenario('rowToWire: null fee_method preserved', () => {
	const r = makeRow({ fee_method: null });
	const w = rowToWire(r);
	assertEqual(w.fee_method, null, 'null fee_method');
});

// ─── makeFetchSerializer (F-6 audit fix) ─────────────────────────

await asyncScenario('serializer: single schedule triggers single fetch', async () => {
	const calls: string[] = [];
	let resolveOne: (() => void) | null = null;
	const doFetch = (orderId: string): Promise<void> =>
		new Promise<void>((resolve) => {
			calls.push(orderId);
			resolveOne = resolve;
		});
	const { schedule, state } = makeFetchSerializer(doFetch);
	schedule('alice/perma');
	assertEqual(state.get('alice/perma'), 'in-flight', 'state in-flight');
	assertEqual(calls.length, 1, 'one fetch started');
	resolveOne!();
	await tickN(2);
	assertEqual(state.has('alice/perma'), false, 'state cleared');
});

await asyncScenario(
	'serializer: coincident schedules coalesce (no second fetch starts)',
	async () => {
		const calls: string[] = [];
		let resolveOne: (() => void) | null = null;
		const doFetch = (orderId: string): Promise<void> =>
			new Promise<void>((resolve) => {
				calls.push(orderId);
				resolveOne = resolve;
			});
		const { schedule, state } = makeFetchSerializer(doFetch);
		schedule('alice/perma');
		schedule('alice/perma'); // 2nd while 1st in-flight
		schedule('alice/perma'); // 3rd should be no-op (already dirty)
		assertEqual(calls.length, 1, 'still one fetch in flight');
		assertEqual(state.get('alice/perma'), 'in-flight-dirty', 'dirty flag');
		// Resolve first fetch.  Loop should immediately fire a second.
		resolveOne!();
		await tickN(2);
		assertEqual(calls.length, 2, 'second fetch fired after dirty');
		assertEqual(state.get('alice/perma'), 'in-flight', 'back to in-flight');
		// Resolve second fetch.  No more dirty → state clears.
		resolveOne!();
		await tickN(2);
		assertEqual(state.has('alice/perma'), false, 'state cleared');
	}
);

await asyncScenario('serializer: distinct orderIds run independently', async () => {
	const inflight: Map<string, () => void> = new Map();
	const doFetch = (orderId: string): Promise<void> =>
		new Promise<void>((resolve) => {
			inflight.set(orderId, resolve);
		});
	const { schedule, state } = makeFetchSerializer(doFetch);
	schedule('alice/perma1');
	schedule('bob/perma2');
	assertEqual(inflight.size, 2, 'two distinct fetches');
	assertEqual(state.get('alice/perma1'), 'in-flight', 'alice in-flight');
	assertEqual(state.get('bob/perma2'), 'in-flight', 'bob in-flight');
	inflight.get('alice/perma1')!();
	await tickN(2);
	assertEqual(state.has('alice/perma1'), false, 'alice cleared');
	assertEqual(state.get('bob/perma2'), 'in-flight', 'bob still running');
	inflight.get('bob/perma2')!();
	await tickN(2);
	assertEqual(state.has('bob/perma2'), false, 'bob cleared');
});

await asyncScenario('serializer: cancelled mid-loop exits cleanly', async () => {
	const calls: string[] = [];
	let resolveOne: (() => void) | null = null;
	let cancelled = false;
	const doFetch = (orderId: string): Promise<void> =>
		new Promise<void>((resolve) => {
			calls.push(orderId);
			resolveOne = resolve;
		});
	const { schedule, state } = makeFetchSerializer(doFetch, () => cancelled);
	schedule('alice/perma');
	schedule('alice/perma'); // mark dirty so loop would refire
	assertTrue(state.get('alice/perma') === 'in-flight-dirty', 'dirty');
	cancelled = true;
	resolveOne!();
	await tickN(3);
	// On cancellation, the loop's `while (!isCancelled())` exits
	// after the current fetch resolves; no second fetch fires.
	assertEqual(calls.length, 1, 'no second fetch after cancel');
	assertEqual(state.has('alice/perma'), false, 'state cleared');
});

await asyncScenario('serializer: doFetch throwing does not break the loop', async () => {
	let attempt = 0;
	const doFetch = async (): Promise<void> => {
		attempt++;
		if (attempt === 1) throw new Error('first attempt fails');
		// Second attempt resolves normally.
	};
	const { schedule, state } = makeFetchSerializer(doFetch);
	schedule('alice/perma'); // attempt 1 (will throw)
	schedule('alice/perma'); // marks dirty
	await tickN(4);
	assertEqual(attempt, 2, 'loop continued after throw');
	assertEqual(state.has('alice/perma'), false, 'state cleared');
});

await asyncScenario('serializer: schedule after completion starts a fresh fetch', async () => {
	let attempt = 0;
	let resolveOne: (() => void) | null = null;
	const doFetch = (): Promise<void> =>
		new Promise<void>((resolve) => {
			attempt++;
			resolveOne = resolve;
		});
	const { schedule, state } = makeFetchSerializer(doFetch);
	schedule('alice/perma');
	resolveOne!();
	await tickN(2);
	assertEqual(state.has('alice/perma'), false, 'cleared after first');
	schedule('alice/perma');
	assertEqual(attempt, 2, 'fresh fetch started');
	assertEqual(state.get('alice/perma'), 'in-flight', 'in-flight again');
	resolveOne!();
	await tickN(2);
	assertEqual(state.has('alice/perma'), false, 'cleared');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
