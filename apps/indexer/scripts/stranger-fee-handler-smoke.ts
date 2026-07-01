/**
 * Stranger-fee handler — tsx smoke runner.
 *
 * Exercises the layer-2 admission handler without vitest.
 * Same style as block-handler-smoke.ts and chat-handler-smoke.ts.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/stranger-fee-handler-smoke.ts
 */

import handler from '../src/indexer/handlers/strangerFee.ts';
import { makeCtx } from '../test/testutils/context.ts';
import { makeMockClient } from '../test/testutils/mockClient.ts';

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

/** Builds a realistic ctx for the stranger-fee handler.
 *  Callers override just the fields they're varying in a
 *  scenario.  After the BLURT-native fee refactor, fees are
 *  denominated directly in BLURT — no priceSource on context,
 *  no USD fields in the payload. */
function ctxFor(override: {
	signer?: string;
	payload?: unknown;
	transferAmountBlurt?: number | null;
	transferTo?: string;
	transferFrom?: string;
	transferMemo?: string;
}) {
	const signer = override.signer ?? 'alice';
	const recipient = (override.payload as { recipient?: string } | undefined)?.recipient ?? 'bob';

	const siblingOps: (readonly [string, Record<string, unknown>])[] = [];
	if (override.transferAmountBlurt !== null && override.transferAmountBlurt !== undefined) {
		siblingOps.push([
			'transfer',
			{
				from: override.transferFrom ?? signer,
				to: override.transferTo ?? 'morphit-fees',
				amount: `${override.transferAmountBlurt.toFixed(3)} BLURT`,
				memo: override.transferMemo ?? `morphit-stranger:${recipient}`
			}
		]);
	}

	return makeCtx({
		signer,
		payload: override.payload ?? {
			v: 1,
			recipient,
			amount_blurt: 5
		},
		siblingOps,
		// feeTolerance widened to 0.02 for test arithmetic ergonomics —
		// scenarios use whole-BLURT amounts that can drift by a few
		// thousandths under the strict 0.001 production default.
		config: {
			feeRecipient: 'morphit-fees',
			feeTolerance: 0.02
		} as unknown as Parameters<typeof makeCtx>[0]['config']
	});
}

console.log('\n── Stranger-fee handler ──────────────────────────────');

// ─── Validation ──────────────────────────────────────────────

await scenario('rejects non-object payload', async () => {
	const mock = makeMockClient();
	const r = await handler(ctxFor({ payload: 'nope' as unknown }), mock.client);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
});

await scenario('rejects invalid recipient', async () => {
	const mock = makeMockClient();
	const r = await handler(
		ctxFor({
			payload: { v: 1, recipient: 'X', amount_blurt: 5 }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'recipient_invalid' }, 'result');
});

await scenario('rejects self-fee', async () => {
	const mock = makeMockClient();
	const r = await handler(
		ctxFor({
			signer: 'alice',
			payload: { v: 1, recipient: 'alice', amount_blurt: 5 }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'self_fee' }, 'result');
});

await scenario('rejects out-of-range amount_blurt (> 1.5× current quote)', async () => {
	// Base quote is 5 BLURT; 1.5× = 7.5 BLURT.  10 BLURT exceeds.
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '0' }] }
	]);
	const r = await handler(
		ctxFor({
			payload: { v: 1, recipient: 'bob', amount_blurt: 100 }
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'amount_blurt_out_of_range' }, 'result');
});

// ─── Idempotency ─────────────────────────────────────────────

await scenario('accepts silently when row already exists', async () => {
	const mock = makeMockClient([{ match: 'EXISTS', rows: [{ exists: true }] }]);
	const r = await handler(ctxFor({ transferAmountBlurt: 5 }), mock.client);
	assertEqual(r, { ok: true }, 'result');
	if (mock.queries.length !== 1) {
		throw new Error(`expected existence check only, got ${mock.queries.length} queries`);
	}
});

await scenario('translates PK collision (23505) into ok:true', async () => {
	const pgErr = Object.assign(new Error('dup'), { code: '23505' });
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '0' }] },
		{ match: 'INSERT INTO stranger_fees', throwError: pgErr }
	]);
	const r = await handler(ctxFor({ transferAmountBlurt: 5 }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Fee verification ────────────────────────────────────────

await scenario('inserts when transfer matches and amount is sufficient', async () => {
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '0' }] },
		{ match: 'INSERT INTO stranger_fees' }
	]);
	const r = await handler(ctxFor({ transferAmountBlurt: 5 }), mock.client);
	assertEqual(r, { ok: true }, 'result');
	if (mock.queries.length !== 3) {
		throw new Error(`expected 3 queries, got ${mock.queries.length}`);
	}
});

await scenario('rejects fee_missing when no transfer sibling', async () => {
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '0' }] }
	]);
	const r = await handler(ctxFor({ transferAmountBlurt: null }), mock.client);
	assertEqual(r, { ok: false, reason: 'fee_missing' }, 'result');
});

await scenario('rejects fee_missing when memo targets different recipient', async () => {
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '0' }] }
	]);
	const r = await handler(
		ctxFor({
			transferAmountBlurt: 5,
			transferMemo: 'morphit-stranger:carol'
		}),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'fee_missing' }, 'result');
});

await scenario('rejects fee_missing when transfer goes to wrong account', async () => {
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '0' }] }
	]);
	const r = await handler(
		ctxFor({ transferAmountBlurt: 5, transferTo: 'some-attacker' }),
		mock.client
	);
	assertEqual(r, { ok: false, reason: 'fee_missing' }, 'result');
});

await scenario('rejects fee_missing when transfer is from a different signer', async () => {
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '0' }] }
	]);
	const r = await handler(ctxFor({ transferAmountBlurt: 5, transferFrom: 'eve' }), mock.client);
	assertEqual(r, { ok: false, reason: 'fee_missing' }, 'result');
});

await scenario('rejects fee_underpaid when amount is below tolerance', async () => {
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '0' }] }
	]);
	// 3 BLURT vs 5 BLURT expected → clearly short.
	const r = await handler(ctxFor({ transferAmountBlurt: 3 }), mock.client);
	assertEqual(r, { ok: false, reason: 'fee_underpaid' }, 'result');
});

await scenario('accepts over-payment (user paid extra BLURT)', async () => {
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '0' }] },
		{ match: 'INSERT INTO stranger_fees' }
	]);
	const r = await handler(ctxFor({ transferAmountBlurt: 8 }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Escalation ──────────────────────────────────────────────
// The doubling cap kicks in when the sender has paid for prior
// strangers in the last 5 minutes. count=N → multiplier=2^N
// (capped at 128 = 640 BLURT).

await scenario('escalation: count=3 → multiplier 8 → accepts 40 BLURT claim', async () => {
	const mock = makeMockClient([
		{ match: 'EXISTS', rows: [{ exists: false }] },
		{ match: 'paid_at >', rows: [{ count: '3' }] },
		{ match: 'INSERT INTO stranger_fees' }
	]);
	const r = await handler(
		ctxFor({
			payload: { v: 1, recipient: 'bob', amount_blurt: 40 },
			transferAmountBlurt: 40
		}),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
});

await scenario(
	'escalation: count=3 but user claims base 5 BLURT → rejects amount_blurt_below_current_quote',
	async () => {
		const mock = makeMockClient([
			{ match: 'EXISTS', rows: [{ exists: false }] },
			{ match: 'paid_at >', rows: [{ count: '3' }] }
		]);
		const r = await handler(
			ctxFor({
				payload: { v: 1, recipient: 'bob', amount_blurt: 5 },
				transferAmountBlurt: 5
			}),
			mock.client
		);
		assertEqual(r, { ok: false, reason: 'amount_blurt_below_current_quote' }, 'result');
	}
);

await scenario(
	'escalation: count=10 (capped) → multiplier 128 → accepts 640 BLURT claim',
	async () => {
		const mock = makeMockClient([
			{ match: 'EXISTS', rows: [{ exists: false }] },
			{ match: 'paid_at >', rows: [{ count: '10' }] },
			{ match: 'INSERT INTO stranger_fees' }
		]);
		const r = await handler(
			ctxFor({
				payload: { v: 1, recipient: 'bob', amount_blurt: 640 },
				transferAmountBlurt: 640
			}),
			mock.client
		);
		assertEqual(r, { ok: true }, 'result');
	}
);

await scenario(
	'escalation: count=3 with claim 100 BLURT (>1.5× quote of 40) → rejects amount_blurt_out_of_range',
	async () => {
		const mock = makeMockClient([
			{ match: 'EXISTS', rows: [{ exists: false }] },
			{ match: 'paid_at >', rows: [{ count: '3' }] }
		]);
		const r = await handler(
			ctxFor({
				payload: { v: 1, recipient: 'bob', amount_blurt: 100 },
				transferAmountBlurt: 100
			}),
			mock.client
		);
		assertEqual(r, { ok: false, reason: 'amount_blurt_out_of_range' }, 'result');
	}
);

await scenario(
	'escalation: count=3, claim 40 BLURT but transfer is base 5 BLURT → rejects fee_underpaid',
	async () => {
		// User claimed the right escalating BLURT but didn't pay the
		// matching transfer — the indexer's transfer-amount check
		// catches this independently of the claim.
		const mock = makeMockClient([
			{ match: 'EXISTS', rows: [{ exists: false }] },
			{ match: 'paid_at >', rows: [{ count: '3' }] }
		]);
		const r = await handler(
			ctxFor({
				payload: { v: 1, recipient: 'bob', amount_blurt: 40 },
				transferAmountBlurt: 5
			}),
			mock.client
		);
		assertEqual(r, { ok: false, reason: 'fee_underpaid' }, 'result');
	}
);

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
