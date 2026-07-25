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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseExpectedSchema } from '../src/db/schemaDrift.ts';

const SMOKE_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const readSmokeSrc = (p: string): string => readFileSync(resolve(SMOKE_SRC, p), 'utf8');

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
		// cp474 — REQUIRED by OrderbookStreamRow and previously absent from this
		// fixture, so every makeRow() produced a shape the SQL never emits.
		// `rowToWire` reads engagement_24h with no `??` default, so the wire
		// payload silently dropped the key. null here = a crypto (non-barter)
		// order, which is what this BTC row is.
		accepted_assets: null,
		engagement_24h: 3,
		terms: 'meet at café',
		fee_method: 'blurt',
		feedback_count: 5,
		// cp473 — a DIFFERENT number from feedback_count on purpose. The card
		// reads this; when the stream omitted it, every live orderbook card
		// rendered "no trades".
		trade_count: 9,
		weighted_rating: '4.5',
		// cp404 — reputation-score inputs + posting key now read by rowToWire.
		last_feedback_at: new Date('2026-04-20T00:00:00Z'),
		first_trade_complete_at: new Date('2026-02-01T00:00:00Z'),
		posting_pubkey: 'BLT6vSMDaw3sLdJP7SjSxHCbtwLQoyTA2oc9dWDdmKZ2Jjw6Bh7d',
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

scenario('buildWhereClauses: asset filter matches traded OR pays-with OR accepted (REST parity)', () => {
	const { where, params } = buildWhereClauses({ asset: 'BTC' });
	assertTrue(where.length === 4, 'four clauses (3 base + asset)');
	// v1.8.15 — broadened to match the REST orderbook.ts asset filter: an order
	// INVOLVING the crypto (traded asset OR pay_<ticker> payment method OR
	// barter-accepted via accepted_assets). Binds TWO params: asset + pay_<ticker>.
	assertEqual(
		where[3],
		'(o.asset = $1 OR EXISTS (SELECT 1 FROM unnest(o.payment_methods) pm WHERE lower(pm) = $2) OR $1 = ANY(o.accepted_assets))',
		'asset clause (broadened)'
	);
	assertEqual(params, ['BTC', 'pay_btc'], 'asset + pay_<ticker> params');
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

scenario('buildWhereClauses: location_region uses ILIKE substring match', () => {
	const { where, params } = buildWhereClauses({ location_region: 'Berl' });
	assertTrue(
		where[3]!.includes('ILIKE') && where[3]!.includes("ESCAPE '\\'"),
		'ILIKE substring with escape'
	);
	// v1.8.15 — case-insensitive SUBSTRING (contains) match, was prefix region%,
	// so "mzt" finds "Mazatlán MZT". Param is wrapped %...%.
	assertEqual(params, ['%Berl%'], 'normalized + wrapped param');
});

scenario('buildWhereClauses: location_region NFC-normalizes input', () => {
	// "é" decomposed (e + combining acute) NFC-normalizes to
	// "é" precomposed.  After normalization + escapeLike + wrapping in %...%.
	const decomposed = 'Caf\u0065\u0301'; // "Café" decomposed
	const { params } = buildWhereClauses({ location_region: decomposed });
	const normalized = decomposed.normalize('NFC');
	assertEqual(params, ['%' + normalized + '%'], 'normalized form, wrapped');
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
	// cp473 — was pinned to `COALESCE(f.c, 0)`, i.e. this scenario ENCODED the
	// bug: a filter named min_TRADES that actually counted REVIEWS, disagreeing
	// with the REST endpoint the stream's snapshot then overwrote.
	assertEqual(where[3], 'COALESCE(tc.c, 0) >= $1', 'min_trades clause');
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
	// v1.8.15 — the asset clause now binds TWO params (asset + pay_<ticker>),
	// so every subsequent placeholder shifts up by one.
	assertEqual(
		where[3],
		'(o.asset = $1 OR EXISTS (SELECT 1 FROM unnest(o.payment_methods) pm WHERE lower(pm) = $2) OR $1 = ANY(o.accepted_assets))',
		'asset clause (broadened)'
	);
	assertEqual(where[4], 'o.side = $3', 'side $3');
	assertEqual(where[5], 'o.fiat_currency = ANY($4::text[])', 'fiat $4');
	assertEqual(where[6], 'COALESCE(tc.c, 0) >= $5', 'min_trades $5');
	assertEqual(params, ['BTC', 'pay_btc', 'sell', ['EUR'], 2], 'params in order');
});

scenario('buildWhereClauses: startIndex offsets parameter numbering', () => {
	// Caller has already bound $1, $2 (account, permlink) — tells
	// builder to start at $3 for the filter params.
	const { where, params } = buildWhereClauses({ asset: 'XMR' }, 2);
	// v1.8.15 — broadened asset clause binds two params starting at the offset,
	// so $3 (asset) and $4 (pay_<ticker>).
	assertEqual(
		where[3],
		'(o.asset = $3 OR EXISTS (SELECT 1 FROM unnest(o.payment_methods) pm WHERE lower(pm) = $4) OR $3 = ANY(o.accepted_assets))',
		'param numbering offset by startIndex'
	);
	assertEqual(params, ['XMR', 'pay_xmr'], 'asset + pay_<ticker> params');
});

// ─── v1.7.0: watch-one-order filter (ADR-0051) ───────────────────
//
// The order detail page subscribes with account+permlink so it gets a one-row
// snapshot and only that order's events, instead of every order the trader has
// live. The safety property being pinned is that this NARROWS — it must never
// let a row through that the unfiltered stream wouldn't already serve.

scenario('buildWhereClauses: account+permlink narrow to one order', () => {
	const { where, params } = buildWhereClauses({ account: 'kentest3', permlink: 'sell-btc-1' });
	assertTrue(where.includes('o.account = $1'), 'account predicate');
	assertTrue(where.includes('o.permlink = $2'), 'permlink predicate');
	assertEqual(params, ['kentest3', 'sell-btc-1'], 'both bound as params');
});

scenario('buildWhereClauses: the watch filter never drops a base predicate', () => {
	// This is the whole safety argument. If account/permlink were ever built
	// BEFORE the base clauses (or replaced them), the detail page could subscribe
	// to an unpaid, cancelled, expired, or operator-blocked order and be told it
	// was live. They must ADD to the same chokepoint every other path shares.
	const { where } = buildWhereClauses({ account: 'kentest3', permlink: 'sell-btc-1' }, 0, 'morphit');
	assertTrue(where.includes(`o.status = 'live'`), 'still live-only');
	assertTrue(
		where.includes(`o.fee_status IN ('verified', 'verified_by_attestation')`),
		'still fee-verified-only — the gate that keeps unpaid orders unpublished'
	);
	assertTrue(
		where.includes(`(o.expires_at IS NULL OR o.expires_at > NOW())`),
		'still unexpired-only'
	);
	assertTrue(
		where.some((w) => w.includes('operator_blocks')),
		'still honours the operator block list'
	);
});

scenario('buildWhereClauses: account alone is legal (all of a trader\'s live orders)', () => {
	const { where, params } = buildWhereClauses({ account: 'kentest3' });
	assertTrue(where.includes('o.account = $1'), 'account predicate');
	assertTrue(!where.some((w) => w.startsWith('o.permlink')), 'no permlink predicate');
	assertEqual(params, ['kentest3'], 'one param');
});

scenario('buildWhereClauses: the watch filter composes with the others', () => {
	const { where, params } = buildWhereClauses({ account: 'kentest3', asset: 'BTC', side: 'sell' });
	assertTrue(where.includes('o.account = $1'), 'account');
	// v1.8.15 — asset clause broadened + binds two params ($2 asset, $3 pay_btc),
	// so side shifts to $4.
	assertTrue(
		where.includes(
			'(o.asset = $2 OR EXISTS (SELECT 1 FROM unnest(o.payment_methods) pm WHERE lower(pm) = $3) OR $2 = ANY(o.accepted_assets))'
		),
		'asset (broadened)'
	);
	assertTrue(where.includes('o.side = $4'), 'side');
	assertEqual(params, ['kentest3', 'BTC', 'pay_btc', 'sell'], 'param order matches placeholder order');
});

scenario('buildWhereClauses: watch filter respects startIndex (per-row lookup path)', () => {
	// The per-row lookup binds account+permlink as $1,$2 and starts filter params
	// at $3. An off-by-one here would silently bind the wrong value to the wrong
	// column — a filter that matches the wrong order.
	const { where, params } = buildWhereClauses({ account: 'kentest3' }, 2);
	assertTrue(where.includes('o.account = $3'), 'placeholder offset by startIndex');
	assertEqual(params, ['kentest3'], 'params unaffected by offset');
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
	// cp473 — trade_count MUST cross the wire. The orderbook page treats this
	// stream's snapshot as authoritative and replaces the REST rows with it, so
	// a missing field here doesn't degrade the live path — it wipes the trade
	// count off cards the REST fetch had already rendered correctly.
	assertEqual(w.trade_count, 9, 'trade_count crosses the wire');
	assertEqual(
		w.trade_count !== w.feedback_count,
		true,
		'trades and ratings stay two different numbers'
	);
	assertEqual(w.created_at, '2026-04-01T10:00:00.000Z', 'created_at iso');
	assertEqual(w.updated_at, '2026-04-26T12:00:00.000Z', 'updated_at iso');
	assertEqual(w.expires_at, '2026-05-01T00:00:00.000Z', 'expires_at iso');
	// cp404 — composite reputation score, earliest-trade ISO, posting key.
	assertEqual(typeof w.reputation_score, 'number', 'reputation_score is a number');
	assertEqual(w.first_trade_at, '2026-02-01T00:00:00.000Z', 'first_trade_at iso');
	assertEqual(
		w.posting_pubkey,
		'BLT6vSMDaw3sLdJP7SjSxHCbtwLQoyTA2oc9dWDdmKZ2Jjw6Bh7d',
		'posting_pubkey passthrough'
	);
});

scenario('rowToWire: null reputation inputs → null score, null first_trade_at', () => {
	const w = rowToWire(
		makeRow({ weighted_rating: null, last_feedback_at: null, first_trade_complete_at: null })
	);
	assertEqual(w.reputation_score, null, 'null score when no rating');
	assertEqual(w.first_trade_at, null, 'null first_trade_at when none');
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

// cp405 regression guard — the beta.44 outage: the orderbook query joined
// `accounts a` on `a.account`, but the accounts table keys on `name` (every
// OTHER table uses `account`, so the typo looked right). No smoke executes the
// SQL, so it shipped and 500'd every orderbook load. This asserts every `a.<col>`
// reference in BOTH orderbook query files is a real accounts column (inline
// columns from the drift parser + ALTER-added ones, which that parser omits).
scenario('orderbook query only references real accounts columns via alias a.', () => {
	const schema = readSmokeSrc('db/schema.sql');
	const accountsCols = new Set<string>(parseExpectedSchema(schema).get('accounts') ?? []);
	const alterRe =
		/ALTER\s+TABLE\s+accounts\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
	let am: RegExpExecArray | null;
	while ((am = alterRe.exec(schema)) !== null) accountsCols.add(am[1]!.toLowerCase());

	if (accountsCols.size === 0) throw new Error('parsed 0 accounts columns — parser/schema drift');
	if (!accountsCols.has('name')) throw new Error('expected accounts.name (PK) in parsed columns');

	const bad: string[] = [];
	for (const f of ['api/orderbook.ts', 'api/orderbookStream.ts']) {
		const src = readSmokeSrc(f);
		const refRe = /\ba\.([a-z_][a-z0-9_]*)/gi;
		let rm: RegExpExecArray | null;
		while ((rm = refRe.exec(src)) !== null) {
			const col = rm[1]!.toLowerCase();
			if (!accountsCols.has(col)) bad.push(`${f}: a.${col}`);
		}
	}
	if (bad.length > 0) {
		throw new Error(
			`orderbook query references non-existent accounts column(s): ${bad.join('; ')}. ` +
				`accounts keys on "name", not "account". Real columns: ${[...accountsCols].sort().join(', ')}`
		);
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
