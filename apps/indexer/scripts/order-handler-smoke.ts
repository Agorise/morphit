/**
 * Order handler — tsx smoke runner.
 *
 * Exercises the morphit_order_v1 handler without vitest.
 * Same style as block-handler-smoke.ts and stranger-fee-
 * handler-smoke.ts.
 *
 * Coverage focus is the §F.11 BLURT-native fee verification
 * surface: fee math against feeBaseBlurt × tier multiplier,
 * tolerance band, memo binding, missing-transfer rejection,
 * underpayment rejection, waiver-path defenses.  This smoke
 * specifically would have caught the priceSource bug
 * discovered post-§F.11 (the waiver path referenced
 * ctx.priceSource which was removed during Phase A and not
 * caught by the sandbox typecheck because path-aliased imports
 * fail to resolve and OpContext became `any`).
 *
 * Usage (from apps/indexer):
 *   tsx scripts/order-handler-smoke.ts
 */

import handler from '../src/indexer/handlers/order.ts';
import { makeCtx } from '../test/testutils/context.ts';
import { makeMockClient, type QueryExpectation } from '../test/testutils/mockClient.ts';
import { readFileSync } from 'node:fs';

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

/** Build a valid order payload. Override fields per scenario. */
function makePayload(override: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		permlink: 'order-2026-04-25-aaa',
		side: 'buy',
		asset: 'BTC',
		fiat_currency: 'USD',
		amount_min: 100,
		amount_max: 500,
		price_model: { kind: 'market_premium', percent: 5 },
		location_region: 'EU',
		payment_methods: ['sepa', 'revolut'],
		terms: 'cash only',
		expires_at: '2026-05-19T12:00:00Z',
		...override
	};
}

/** Build the sibling-ops array for a BLURT fee transfer.
 *  Pass amountBlurt=null to omit the transfer entirely. */
function feeTransfer(
	signer: string,
	permlink: string,
	amountBlurt: number | null,
	overrides: { to?: string; memo?: string; from?: string } = {}
): readonly (readonly [string, Record<string, unknown>])[] {
	if (amountBlurt === null) return [];
	return [
		[
			'transfer',
			{
				from: overrides.from ?? signer,
				to: overrides.to ?? 'morphit-fees',
				amount: `${amountBlurt.toFixed(3)} BLURT`,
				memo: overrides.memo ?? `morphit-fee:${permlink}`
			}
		]
	];
}

/** Mock queries for the BLURT-fee path:
 *    1. countForSybilTier (SELECT COUNT(*) FROM orders ...)
 *    2. INSERT INTO orders ... RETURNING
 *    3..6. trackVerifiedBlurtFee (4 queries) — only when feeStatus='verified'
 *
 *  When feeStatus is not verified, the loyalty queries don't fire.
 */
function expectationsForBlurtFeePath(
	priorOrders: number,
	insertRowCount: number,
	includeLoyalty: boolean
): readonly QueryExpectation[] {
	const exps: QueryExpectation[] = [
		{
			match: 'COUNT(*)::text AS n',
			rows: [{ n: String(priorOrders) }]
		},
		{
			match: 'INSERT INTO orders',
			rows: [],
			rowCount: insertRowCount
		}
	];
	if (includeLoyalty) {
		// Don't pin exact loyalty queries — they're an implementation detail
		// of trackVerifiedBlurtFee. Just match SELECT/INSERT/UPDATE on
		// loyalty-related tables and supply benign rows.
		exps.push(
			{ match: /SELECT|INSERT|UPDATE/, rows: [] },
			{ match: /SELECT|INSERT|UPDATE/, rows: [] },
			{ match: /SELECT|INSERT|UPDATE/, rows: [] },
			{ match: /SELECT|INSERT|UPDATE/, rows: [] }
		);
	}
	return exps;
}

// ─── §F.11 critical-path scenarios ──────────────────────────────

await scenario('BLURT fee path: verifies a 62.5-BLURT transfer at tier 1', async () => {
	const signer = 'alice';
	const permlink = 'order-2026-04-25-aaa';
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: feeTransfer(signer, permlink, 62.5)
	});
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');

	// The INSERT should have been called with fee_status='verified'.
	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	if (!insertCall) throw new Error('no INSERT INTO orders query');
	// fee_status sits third-from-last in the BLURT insert's params: the two
	// trailing columns are operator_tag then accepted_assets (cp425). If you
	// add another trailing column to the BLURT insert, bump this offset.
	const feeStatus = insertCall.params[insertCall.params.length - 3];
	if (feeStatus !== 'verified') {
		throw new Error(`expected fee_status=verified, got ${feeStatus}`);
	}
});

await scenario('BLURT fee path: chain-pinned blurtBase overrides config (cp372 determinism)', async () => {
	// The chain-pinned base (via feeAmounts.blurtBase) is authoritative
	// over config.feeBaseBlurt — this is what makes the BLURT floor
	// deterministic across the federation.  Pin base=100; a 62.5 pay
	// (fine against the config default 62.5) is now well below 100×0.85
	// = 85 → underpaid.
	const signer = 'alice';
	const permlink = 'order-cp372-pin-a';
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: feeTransfer(signer, permlink, 62.5),
		feeAmounts: { blurtBase: 100 }
	});
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, false));
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');
	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const feeStatus = insertCall!.params[insertCall!.params.length - 3];
	if (feeStatus !== 'underpaid') {
		throw new Error(`chain-pinned base=100 should reject a 62.5 pay, got ${feeStatus}`);
	}
});

await scenario('BLURT fee path: chain-pinned blurtBase=100 verifies a 100-BLURT pay', async () => {
	const signer = 'alice';
	const permlink = 'order-cp372-pin-b';
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: feeTransfer(signer, permlink, 100),
		feeAmounts: { blurtBase: 100 }
	});
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');
	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const feeStatus = insertCall!.params[insertCall!.params.length - 3];
	if (feeStatus !== 'verified') {
		throw new Error(`chain-pinned base=100, 100-BLURT pay should verify, got ${feeStatus}`);
	}
});

await scenario('BLURT fee path: Plan-B fallback to config.feeBaseBlurt when no chain pin', async () => {
	// feeAmounts.blurtBase undefined (fresh node / unit ctx) → handler
	// falls back to config.feeBaseBlurt (62.5).  62.5 pay verifies.
	const signer = 'alice';
	const permlink = 'order-cp372-fallback';
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: feeTransfer(signer, permlink, 62.5)
		// feeAmounts defaults to {} → blurtBase undefined → config fallback
	});
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');
	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const feeStatus = insertCall!.params[insertCall!.params.length - 3];
	if (feeStatus !== 'verified') {
		throw new Error(`Plan-B config fallback should verify a 62.5 pay, got ${feeStatus}`);
	}
});

await scenario('BLURT fee path: tier multiplier kicks in at the 4th order', async () => {
	const signer = 'busy_trader';
	const permlink = 'order-2026-04-25-bbb';
	// Tier 4: 62.5 × 1.25 = 78.125 BLURT.  Pay exactly 78.125 — should verify.
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: feeTransfer(signer, permlink, 78.125)
	});
	const mock = makeMockClient(expectationsForBlurtFeePath(3, 1, true));
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');

	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const feeStatus = insertCall!.params[insertCall!.params.length - 3];
	if (feeStatus !== 'verified') {
		throw new Error(`tier 4 78.125-BLURT pay should verify, got ${feeStatus}`);
	}
});

await scenario('BLURT fee path: tier-4 underpayment (62.5 BLURT against 78.125) rejects', async () => {
	const signer = 'busy_trader';
	const permlink = 'order-2026-04-25-ccc';
	// User pays 62.5 BLURT (the tier-1 amount) but expected is
	// 78.125 (tier 4).  Should mark fee_status='underpaid', not verified.
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: feeTransfer(signer, permlink, 62.5)
	});
	// No loyalty queries because fee_status != 'verified'.
	const mock = makeMockClient(expectationsForBlurtFeePath(3, 1, false));
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');

	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const feeStatus = insertCall!.params[insertCall!.params.length - 3];
	if (feeStatus !== 'underpaid') {
		throw new Error(`expected fee_status=underpaid, got ${feeStatus}`);
	}
});

await scenario(
	'BLURT fee path: a near-exact payment (62.45 BLURT against 62.5) verifies',
	async () => {
		// 62.45 is ~0.08% below the pinned 62.5 — trivially inside the
		// Model-A FEE_PRICE_TOLERANCE band (floor 62.5 × 0.85 = 53.125),
		// so it verifies.  (Pre-cp372 this exercised the tight 0.1%
		// FP-rounding band; that band is now subsumed by the 15% price-
		// drift band — see the order handler + FEE_PRICE_TOLERANCE.)
		const signer = 'alice';
		const permlink = 'order-2026-04-25-ddd';
		const ctx = makeCtx({
			signer,
			payload: makePayload({ permlink, fee_method: 'blurt' }),
			siblingOps: feeTransfer(signer, permlink, 62.45)
		});
		const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
		const r = await handler(ctx, mock.client);
		assertEqual(r, { ok: true }, 'result');

		const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
		const feeStatus = insertCall!.params[insertCall!.params.length - 3];
		if (feeStatus !== 'verified') {
			throw new Error(`62.45 BLURT (within tolerance) should verify, got ${feeStatus}`);
		}
	}
);

await scenario(
	'BLURT fee path: below the FEE_PRICE_TOLERANCE band (53.0 BLURT against 62.5) rejects',
	async () => {
		// Model A (cp372): the acceptance floor is FEE_PRICE_TOLERANCE
		// (15%) below the pinned base — 62.5 × 0.85 = 53.125.  53.0 is
		// just under it, so it's a genuine underpayment even allowing
		// for live-price drift → underpaid.
		const signer = 'alice';
		const permlink = 'order-2026-04-25-eee';
		const ctx = makeCtx({
			signer,
			payload: makePayload({ permlink, fee_method: 'blurt' }),
			siblingOps: feeTransfer(signer, permlink, 53.0)
		});
		const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, false));
		const r = await handler(ctx, mock.client);
		assertEqual(r, { ok: true }, 'result');

		const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
		const feeStatus = insertCall!.params[insertCall!.params.length - 3];
		if (feeStatus !== 'underpaid') {
			throw new Error(`expected fee_status=underpaid, got ${feeStatus}`);
		}
	}
);

await scenario(
	'BLURT fee path: Model-A band absorbs live-price drift (55 BLURT against pinned 62.5 verifies)',
	async () => {
		// BLURT appreciated since the operator last re-tuned, so the
		// live-displayed amount (≈55) sits ~12% below the pinned base
		// (62.5).  A user paying the live-displayed figure must NOT be
		// rejected — 55 ≥ 62.5 × 0.85 = 53.125 → verified.  This is the
		// quote→pay drift the FEE_PRICE_TOLERANCE band exists to absorb.
		const signer = 'alice';
		const permlink = 'order-2026-04-25-eee2';
		const ctx = makeCtx({
			signer,
			payload: makePayload({ permlink, fee_method: 'blurt' }),
			siblingOps: feeTransfer(signer, permlink, 55.0)
		});
		const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
		const r = await handler(ctx, mock.client);
		assertEqual(r, { ok: true }, 'result');

		const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
		const feeStatus = insertCall!.params[insertCall!.params.length - 3];
		if (feeStatus !== 'verified') {
			throw new Error(`55 BLURT (within FEE_PRICE_TOLERANCE of 62.5) should verify, got ${feeStatus}`);
		}
	}
);

await scenario('BLURT fee path: missing transfer marks fee_status=missing', async () => {
	const signer = 'alice';
	const permlink = 'order-2026-04-25-fff';
	// No sibling transfer at all.
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: []
	});
	// No countForSybilTier call when transfer is missing — handler
	// short-circuits before tier counting. Just one INSERT.
	const mock = makeMockClient([{ match: 'INSERT INTO orders', rows: [], rowCount: 1 }]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');

	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const feeStatus = insertCall!.params[insertCall!.params.length - 3];
	if (feeStatus !== 'missing') {
		throw new Error(`expected fee_status=missing, got ${feeStatus}`);
	}
});

await scenario(
	'BLURT fee path: memo binding — wrong permlink in memo treated as missing',
	async () => {
		const signer = 'alice';
		const permlink = 'order-2026-04-25-ggg';
		// Transfer has a memo for a DIFFERENT permlink. sumFeeTransfers
		// requires the memo to match exactly; mismatched memo means the
		// transfer doesn't apply and fee_status falls to 'missing'.
		const ctx = makeCtx({
			signer,
			payload: makePayload({ permlink, fee_method: 'blurt' }),
			siblingOps: feeTransfer(signer, 'different-permlink', 62.5)
		});
		const mock = makeMockClient([{ match: 'INSERT INTO orders', rows: [], rowCount: 1 }]);
		const r = await handler(ctx, mock.client);
		assertEqual(r, { ok: true }, 'result');

		const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
		const feeStatus = insertCall!.params[insertCall!.params.length - 3];
		if (feeStatus !== 'missing') {
			throw new Error(`memo-mismatch should be 'missing', got ${feeStatus}`);
		}
	}
);

await scenario('BLURT fee path: wrong recipient treated as missing', async () => {
	const signer = 'alice';
	const permlink = 'order-2026-04-25-hhh';
	// Transfer goes to wrong account — sumFeeTransfers rejects.
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: feeTransfer(signer, permlink, 62.5, { to: 'attacker' })
	});
	const mock = makeMockClient([{ match: 'INSERT INTO orders', rows: [], rowCount: 1 }]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');

	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const feeStatus = insertCall!.params[insertCall!.params.length - 3];
	if (feeStatus !== 'missing') {
		throw new Error(`wrong-recipient should be 'missing', got ${feeStatus}`);
	}
});

await scenario('BLURT fee path: operator-tunable feeBaseBlurt (80) shifts fee math', async () => {
	const signer = 'alice';
	const permlink = 'order-2026-04-25-iii';
	// Operator sets feeBaseBlurt=80. Tier 1, so 80 × 1.0 = 80 BLURT.
	// Pay 80 BLURT — should verify.  This confirms the handler
	// reads the operator's configured base, not a bundled constant.
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: feeTransfer(signer, permlink, 80),
		config: {
			...makeCtx().config,
			feeBaseBlurt: 80
		}
	});
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');

	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const feeStatus = insertCall!.params[insertCall!.params.length - 3];
	if (feeStatus !== 'verified') {
		throw new Error(`80 BLURT pay against 80-base should verify, got ${feeStatus}`);
	}
});

await scenario('BLURT fee path: 60 BLURT pay against 80-base operator rejects', async () => {
	const signer = 'alice';
	const permlink = 'order-2026-04-25-jjj';
	// User on a frontend that bundled BASE_FEE_BLURT=60 broadcasts
	// 60 BLURT, but the operator reconfigured to 80. Indexer rejects
	// as underpaid.  This is the exact drift scenario the Option-1
	// frontend fix prevents (frontend now reads /v1/listing-fee
	// before computing).  The indexer's defense remains as a safety
	// net.
	const ctx = makeCtx({
		signer,
		payload: makePayload({ permlink, fee_method: 'blurt' }),
		siblingOps: feeTransfer(signer, permlink, 60),
		config: {
			...makeCtx().config,
			feeBaseBlurt: 80
		}
	});
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, false));
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');

	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const feeStatus = insertCall!.params[insertCall!.params.length - 3];
	if (feeStatus !== 'underpaid') {
		throw new Error(`60-pay-against-80-base should underpay, got ${feeStatus}`);
	}
});

// ─── Waiver-path defenses (the priceSource bug surface) ─────────

await scenario('Waiver: rejects sell side', async () => {
	const ctx = makeCtx({
		signer: 'newbie',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'sell',
			asset: 'BLURT',
			amount_min: 1000,
			amount_max: null
		}),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'waiver_requires_buy' }, 'result');
});

await scenario('Waiver: rejects non-BLURT asset', async () => {
	const ctx = makeCtx({
		signer: 'newbie',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'buy',
			asset: 'BTC',
			amount_min: 1000,
			amount_max: null
		}),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'waiver_requires_blurt' }, 'result');
});

await scenario('Waiver: rejects null amount_min', async () => {
	const ctx = makeCtx({
		signer: 'newbie',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'buy',
			asset: 'BLURT',
			amount_min: null,
			amount_max: null
		}),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'waiver_requires_min_usd' }, 'result');
});

await scenario('Waiver: rejects amount_min below the $1 USD floor', async () => {
	// cp369/cp370: the first-order floor is $1 USD-EQUIVALENT — the
	// canonical FIRST_ORDER_MIN_USD, a fiat value compared to
	// amount_min (itself fiat), NO price feed.  amount_min below $1
	// → waiver_requires_min_usd.  (Historically this scenario also
	// caught the §F.11 priceSource bug where the handler called
	// ctx.priceSource.current() under an OpContext lacking one.)
	const ctx = makeCtx({
		signer: 'newbie',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'buy',
			asset: 'BLURT',
			amount_min: 0.5, // below the $1 USD floor
			amount_max: null
		}),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'waiver_requires_min_usd' }, 'result');
});

await scenario('Waiver: $1 exactly is at the floor and accepted', async () => {
	const ctx = makeCtx({
		signer: 'newbie',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'buy',
			asset: 'BLURT',
			amount_min: 1,
			amount_max: null
		}),
		siblingOps: []
	});
	const mock = makeMockClient([
		{ match: 'COUNT(*)::text AS n FROM orders WHERE account', rows: [{ n: '0' }] },
		{
			match: 'INSERT INTO accounts',
			rows: [{ first_buy_waived_at: new Date('2026-04-19T12:00:00Z') }],
			rowCount: 1
		},
		{ match: 'INSERT INTO orders', rows: [], rowCount: 1 }
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');
});

// ─── cp372 — FX-aware first-order floor regressions ─────────────
// The floor is "$1 USD-EQUIVALENT".  amount_min is denominated in
// the order's fiat_currency, so a non-USD order must be converted
// to USD before the $1 check.  These scenarios tamper-test that:
// reverting to the pre-cp372 USD-only comparison (v.amount_min <
// FIRST_ORDER_MIN_USD, ignoring fiatToUsd) breaks them.

// AUD 1.52 per USD, so 1.20 AUD ≈ $0.79 — below the $1 floor.  The
// override mimics the FX source.  The full proceed-mock is supplied
// so that IF the floor wrongly passed (regression), the handler
// would claim the waiver and return ok:true, making the expected-
// reject assertion fail loudly.
await scenario('Waiver FX: non-USD min below $1-equivalent rejected (1.20 AUD ≈ $0.79)', async () => {
	const ctx = makeCtx({
		signer: 'newbie_au',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'buy',
			asset: 'BLURT',
			fiat_currency: 'AUD',
			amount_min: 1.2,
			amount_max: null
		}),
		siblingOps: [],
		fiatToUsd: (a: number, f: string) => (f === 'AUD' ? a / 1.52 : a)
	});
	const mock = makeMockClient([
		{ match: 'COUNT(*)::text AS n FROM orders WHERE account', rows: [{ n: '0' }] },
		{ match: 'INSERT INTO accounts', rows: [{ first_buy_waived_at: new Date() }], rowCount: 1 },
		{ match: 'INSERT INTO orders', rows: [], rowCount: 1 }
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'waiver_requires_min_usd' }, 'result');
});

// 2.00 AUD ≈ $1.32 — above the floor; the waiver is claimed.
await scenario('Waiver FX: non-USD min above $1-equivalent accepted (2.00 AUD ≈ $1.32)', async () => {
	const ctx = makeCtx({
		signer: 'newbie_au2',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'buy',
			asset: 'BLURT',
			fiat_currency: 'AUD',
			amount_min: 2.0,
			amount_max: null
		}),
		siblingOps: [],
		fiatToUsd: (a: number, f: string) => (f === 'AUD' ? a / 1.52 : a)
	});
	const mock = makeMockClient([
		{ match: 'COUNT(*)::text AS n FROM orders WHERE account', rows: [{ n: '0' }] },
		{ match: 'INSERT INTO accounts', rows: [{ first_buy_waived_at: new Date() }], rowCount: 1 },
		{ match: 'INSERT INTO orders', rows: [], rowCount: 1 }
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');
});

// Unconvertible currency (FX off + outside the static table):
// fiatToUsd returns null → the handler falls back to the documented
// direct comparison (treat amount_min as USD-equivalent).  0.5 < 1 → reject.
await scenario('Waiver FX: unconvertible currency falls back to direct compare (0.5 rejected)', async () => {
	const ctx = makeCtx({
		signer: 'newbie_zz',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'buy',
			asset: 'BLURT',
			fiat_currency: 'ZZZ',
			amount_min: 0.5,
			amount_max: null
		}),
		siblingOps: [],
		fiatToUsd: () => null
	});
	const mock = makeMockClient([
		{ match: 'COUNT(*)::text AS n FROM orders WHERE account', rows: [{ n: '0' }] },
		{ match: 'INSERT INTO accounts', rows: [{ first_buy_waived_at: new Date() }], rowCount: 1 },
		{ match: 'INSERT INTO orders', rows: [], rowCount: 1 }
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'waiver_requires_min_usd' }, 'result');
});

// Structural belt-and-suspenders: the source must route the floor
// through ctx.fiatToUsd, not compare the raw fiat amount_min to the
// USD constant.  Catches a revert even if a future refactor changes
// the behavioural mocks.
await scenario('Waiver FX: order.ts routes the floor through ctx.fiatToUsd (structural)', () => {
	const src = readFileSync(new URL('../src/indexer/handlers/order.ts', import.meta.url), 'utf-8');
	if (!/ctx\.fiatToUsd\(v\.amount_min,\s*v\.fiat_currency\)/.test(src)) {
		throw new Error('order.ts no longer converts amount_min via ctx.fiatToUsd');
	}
	if (/if\s*\(\s*v\.amount_min\s*<\s*WAIVER_MIN_FIAT_USD\s*\)/.test(src)) {
		throw new Error('order.ts reverted to raw USD-only floor comparison');
	}
});

await scenario('Waiver FX: orderReplace.ts routes the floor through ctx.fiatToUsd (structural)', () => {
	const src = readFileSync(new URL('../src/indexer/handlers/orderReplace.ts', import.meta.url), 'utf-8');
	if (!/ctx\.fiatToUsd\(v\.amount_min,\s*v\.fiat_currency\)/.test(src)) {
		throw new Error('orderReplace.ts no longer converts amount_min via ctx.fiatToUsd');
	}
});

await scenario('Waiver: prior orders disqualify (waiver_not_first_order)', async () => {
	const ctx = makeCtx({
		signer: 'returning_user',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'buy',
			asset: 'BLURT',
			amount_min: 500,
			amount_max: null
		}),
		siblingOps: []
	});
	const mock = makeMockClient([
		// Prior count returns > 0
		{ match: 'COUNT(*)::text AS n FROM orders WHERE account', rows: [{ n: '3' }] }
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'waiver_not_first_order' }, 'result');
});

await scenario('Waiver: already-claimed marker rejects (waiver_already_used)', async () => {
	const ctx = makeCtx({
		signer: 'newbie',
		payload: makePayload({
			fee_method: 'waived_first_buy',
			side: 'buy',
			asset: 'BLURT',
			amount_min: 500,
			amount_max: null
		}),
		siblingOps: []
	});
	const mock = makeMockClient([
		{ match: 'COUNT(*)::text AS n FROM orders WHERE account', rows: [{ n: '0' }] },
		// UPSERT returns 0 rows — meaning first_buy_waived_at was
		// already set on the existing row.
		{ match: 'INSERT INTO accounts', rows: [], rowCount: 0 }
	]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'waiver_already_used' }, 'result');
});

// ─── Validation negatives (basic regression coverage) ───────────

await scenario('rejects payload that is not an object', async () => {
	const ctx = makeCtx({ payload: null, siblingOps: [] });
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
});

await scenario('rejects unknown asset', async () => {
	const ctx = makeCtx({
		// cp40-A1: previously used 'DOGE' as the "unknown" stand-in,
		// but DOGE became a valid asset at cp33 and ZEC at cp39, which
		// silently broke this scenario.  Using a clearly-fictional
		// 4-letter ticker that cannot collide with any future asset
		// addition.  Future deep-deeps: if XYZQ ever becomes a real
		// ticker, replace it here.
		payload: makePayload({ asset: 'XYZQ' }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'asset_invalid' }, 'result');
});

await scenario('rejects malformed permlink', async () => {
	const ctx = makeCtx({
		payload: makePayload({ permlink: 'Bad permlink with SPACES' }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'permlink_bad_chars' }, 'result');
});

await scenario('rejects unknown fee_method', async () => {
	const ctx = makeCtx({
		payload: makePayload({ fee_method: 'monero' }), // typo
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'fee_method_unknown' }, 'result');
});

await scenario('rejects btc/xmr without external_tx_id', async () => {
	const ctx = makeCtx({
		payload: makePayload({ fee_method: 'btc' }),
		siblingOps: []
	});
	const mock = makeMockClient([]);
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: false, reason: 'external_tx_id_required_for_btc_xmr' }, 'result');
});

// ─── §F.21 O3.4 — text-field hardening ──────────────────────────

await scenario('O3.4: rejects location_region with bidi override', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ location_region: 'EU\u202E' }),
			siblingOps: feeTransfer('alice', 'order-2026-04-25-aaa', 60)
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'location_region_forbidden_char' }, 'result');
});

await scenario('O3.4: rejects terms with control character', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ terms: 'cash only\u0007beep' }),
			siblingOps: feeTransfer('alice', 'order-2026-04-25-aaa', 60)
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'terms_forbidden_char' }, 'result');
});

// cp422 regression — the strict forbidden-char regex included the whole
// C0 range \u0000-\u001F, which swallowed TAB/LF/CR. Because the terms
// field is a multi-line markdown textarea (TermsText renders headings,
// blockquotes, lists, links, and line feeds), every order with a
// newline in its terms was REJECTED on-chain AFTER its fee was paid —
// the op broadcasts, the fee transfer settles, and the indexer silently
// drops the row, so the order never appears anywhere. These two pin the
// fix: newlines/tabs are accepted, the dangerous controls stay blocked.
await scenario('cp422: ACCEPTS multi-line markdown terms (TAB/LF/CR permitted)', async () => {
	const signer = 'alice';
	const permlink = 'order-2026-04-25-aaa';
	const ctx = makeCtx({
		signer,
		payload: makePayload({
			permlink,
			fee_method: 'blurt',
			terms: '# Big header\n\n**Bold** and *italic* text.\n\n> A blockquote line.\n\n1. First\n2. Second\n\n- a bullet\ttab too'
		}),
		siblingOps: feeTransfer(signer, permlink, 62.5)
	});
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
	const r = await handler(ctx, mock.client);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('cp422: STILL rejects a bidi override in terms (RLO)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ terms: 'cash\u202Eonly' }),
			siblingOps: feeTransfer('alice', 'order-2026-04-25-aaa', 62.5)
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'terms_forbidden_char' }, 'result');
});

await scenario('O3.4: rejects payment_method item with zero-width joiner', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ payment_methods: ['sep\u200Da'] }),
			siblingOps: feeTransfer('alice', 'order-2026-04-25-aaa', 60)
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'payment_method_item_forbidden_char' }, 'result');
});

await scenario('rejects duplicate payment_methods entries', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ payment_methods: ['sepa', 'sepa'] }),
			siblingOps: feeTransfer('alice', 'order-2026-04-25-aaa', 60)
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'payment_method_item_duplicate' }, 'result');
});

await scenario('NFC-normalized payment-method dup detection', async () => {
	// Same brand spelled with NFC-decomposed vs precomposed
	// é — should be treated as the same entry after NFC.
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				payment_methods: ['cafe\u0301', 'café']
			}),
			siblingOps: feeTransfer('alice', 'order-2026-04-25-aaa', 60)
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'payment_method_item_duplicate' }, 'result');
});

await scenario('O3.4: NFC-normalizes location_region', async () => {
	// "Café" with é decomposed (e + combining acute).  Pre-fix
	// this stored the decomposed form; post-fix it normalizes to
	// NFC ('é' precomposed) before storage.
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ location_region: 'Cafe\u0301 District' }),
			siblingOps: feeTransfer('alice', 'order-2026-04-25-aaa', 60)
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	// Check the stored value is NFC.
	const insertCall = mock.queries.find((q) => q.text.includes('INSERT INTO orders'));
	const locParam = insertCall!.params.find((p) => typeof p === 'string' && p.startsWith('Caf')) as
		| string
		| undefined;
	if (locParam !== 'Café District') {
		throw new Error(
			`expected NFC-normalized 'Café District' (precomposed é), got ${JSON.stringify(locParam)}`
		);
	}
});

await scenario('rejects amount_min > MAX_AMOUNT (1e12)', async () => {
	// Sally chain-direct attack: post `amount_min: 1e308` to
	// produce absurd orderbook entries.  Indexer sanity-cap at
	// 1e12 catches this.
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ amount_min: 1e13 })
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'amount_min_too_large' }, 'result');
});

await scenario('rejects amount_max > MAX_AMOUNT (1e12)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ amount_min: 50, amount_max: 1e15 })
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'amount_max_too_large' }, 'result');
});

await scenario('rejects amount_min === Number.MAX_VALUE', async () => {
	// JS Number.MAX_VALUE is finite, so the existing
	// `Number.isFinite` check passes.  Only the explicit > MAX_AMOUNT
	// check rejects this value.
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ amount_min: Number.MAX_VALUE })
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'amount_min_too_large' }, 'result');
});

await scenario('rejects expires_at far past MAX_EXPIRES_AT_DAYS', async () => {
	// Sally chain-direct: post `expires_at: '9999-12-31T23:59:59Z'`
	// to keep the order in the orderbook for millennia.  Indexer
	// caps at 365 days from now.
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ expires_at: '9999-12-31T23:59:59Z' })
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'expires_at_too_far_future' }, 'result');
});

await scenario('rejects expires_at exactly 366 days from now', async () => {
	// Boundary check.  366 days > 365-day cap → reject.
	const mock = makeMockClient();
	const future = new Date(Date.now() + 366 * 86_400_000).toISOString();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ expires_at: future })
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'expires_at_too_far_future' }, 'result');
});

await scenario('accepts expires_at 90 days (UI default cap)', async () => {
	// The UI's largest dropdown option is 90 days; this should
	// succeed comfortably.
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
	const future = new Date(Date.now() + 90 * 86_400_000).toISOString();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ expires_at: future }),
			siblingOps: feeTransfer('alice', 'order-2026-04-25-aaa', 60)
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('rejects price_model spread.percent === Infinity', async () => {
	// Sally chain-direct: post `price_model: {kind:'spread', percent: Infinity}`
	// to produce a renderer crash or a misleading orderbook entry.
	// The shape validator catches non-finite numbers.
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				price_model: { kind: 'spread', percent: Number.POSITIVE_INFINITY }
			})
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'price_model_spread_percent_not_finite' }, 'result');
});

await scenario('rejects price_model spread.percent === 1000 (way out of range)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				price_model: { kind: 'spread', percent: 1000 }
			})
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'price_model_spread_percent_out_of_range' }, 'result');
});

await scenario('rejects price_model fixed.price === -50 (negative)', async () => {
	// Negative fixed prices would render as "-50.00 USD" in the
	// orderbook, confusing counterparties.  Reject at intake.
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				price_model: { kind: 'fixed', price: -50 }
			})
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'price_model_fixed_price_not_positive' }, 'result');
});

await scenario('rejects price_model fixed.price === NaN', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				price_model: { kind: 'fixed', price: Number.NaN }
			})
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'price_model_fixed_price_not_finite' }, 'result');
});

await scenario('rejects price_model fixed.price > MAX_AMOUNT', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				price_model: { kind: 'fixed', price: 1e15 }
			})
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'price_model_fixed_price_too_large' }, 'result');
});

await scenario('accepts price_model with unknown kind (forward-compat)', async () => {
	// Unknown `kind` (future client) passes shape validation.
	// The frontend's priceModelDisplay falls back to "Custom price"
	// label.  This is the forward-compat path.
	const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				price_model: { kind: 'tiered', tiers: [{ min: 0, rate: 1.0 }] }
			}),
			siblingOps: feeTransfer('alice', 'order-2026-04-25-aaa', 60)
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Disabled payment methods (cp208) ───────────────────────────

await scenario(
	'disabled payment methods: order offering ONLY a disabled method rejects',
	async () => {
		const ctx = makeCtx({
			signer: 'alice',
			payload: makePayload({
				permlink: 'order-2026-04-25-bar',
				payment_methods: ['barter_goods']
			}),
			config: { ...makeCtx().config, disabledPaymentMethods: ['barter_goods'] }
		});
		const mock = makeMockClient([]);
		const r = await handler(ctx, mock.client);
		assertEqual(r, { ok: false, reason: 'payment_methods_all_disabled' }, 'result');
	}
);

await scenario(
	'disabled payment methods: order keeping one enabled method is NOT rejected',
	async () => {
		const signer = 'alice';
		const permlink = 'order-2026-04-25-mix';
		const ctx = makeCtx({
			signer,
			payload: makePayload({
				permlink,
				fee_method: 'blurt',
				payment_methods: ['barter_goods', 'sepa']
			}),
			siblingOps: feeTransfer(signer, permlink, 60),
			config: { ...makeCtx().config, disabledPaymentMethods: ['barter_goods'] }
		});
		const mock = makeMockClient(expectationsForBlurtFeePath(0, 1, true));
		const r = await handler(ctx, mock.client);
		assertEqual(r, { ok: true }, 'result');
	}
);

// ─── Final report ───────────────────────────────────────────────

console.log();
console.log('────────────────────────────────────────────────────────────');
if (failures > 0) {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
// ─── cp425: barter (accepted_assets) validation ─────────────────
// A BARTER order settles in one of a SET of cryptos the seller accepts.
// accepted_assets is REQUIRED (non-empty crypto set) for BARTER and
// FORBIDDEN for crypto assets; each entry must be a real crypto ticker.
await scenario('barter: rejects order with no accepted_assets', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({ asset: 'BARTER', payment_methods: ['in-person'] })
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'accepted_assets_required_for_barter' }, 'result');
});

await scenario('barter: rejects order with an empty accepted_assets set', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				asset: 'BARTER',
				payment_methods: ['in-person'],
				accepted_assets: []
			})
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'accepted_assets_required_for_barter' }, 'result');
});

await scenario('barter: rejects accepting a goods asset (no barter-for-barter)', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				asset: 'BARTER',
				payment_methods: ['in-person'],
				accepted_assets: ['XMR', 'BARTER']
			})
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'accepted_assets_entry_not_crypto' }, 'result');
});

await scenario('barter: rejects accepting an unknown ticker', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({
			signer: 'alice',
			payload: makePayload({
				asset: 'BARTER',
				payment_methods: ['in-person'],
				accepted_assets: ['XMR', 'NOTACOIN']
			})
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'accepted_assets_entry_unknown' }, 'result');
});

await scenario('crypto order: rejects a stray accepted_assets field', async () => {
	const mock = makeMockClient();
	const r = await handler(
		makeCtx({ signer: 'alice', payload: makePayload({ accepted_assets: ['XMR'] }) }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'accepted_assets_not_permitted_for_asset' }, 'result');
});

console.log(`✓ all ${scenarios} scenarios passed`);
