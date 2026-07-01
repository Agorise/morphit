/**
 * feeAttest handler — tsx smoke runner.
 *
 * Drives the full handler with mocked DB queries to verify:
 *   - Finding I eligibility gate rejects with the four
 *     distinct reason codes.
 *   - The existing promotion flow (≥2 attestors, ≥1
 *     non-poster → verified_by_attestation) still works after
 *     the eligibility check was added.
 *
 * Same pattern as the other smoke runners. Pairs with the
 * isolated attestor-eligibility-smoke which tests the helper
 * directly.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/fee-attest-handler-smoke.ts
 */

import handler from '../src/indexer/handlers/feeAttest.ts';
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

const NOW = new Date('2026-04-24T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function ctxFor(override: { signer?: string; orderAccount?: string; phase?: 'launch' | 'steady' }) {
	return makeCtx({
		signer: override.signer ?? 'charlie',
		payload: {
			order_account: override.orderAccount ?? 'bob',
			order_permlink: 'order-1'
		},
		blockTime: NOW,
		config: {
			attestationPhase: override.phase ?? 'launch'
		} as unknown as Parameters<typeof makeCtx>[0]['config']
	});
}

function orderSeed(feeStatus: string, account = 'bob') {
	return {
		match: 'SELECT fee_status, account FROM orders',
		rows: [{ fee_status: feeStatus, account }],
		rowCount: 1
	};
}

function eligibilitySeed(ageDays: number, loyaltyBlurt: number) {
	return {
		match: 'created_block_time',
		rows: [
			{
				created_block_time: new Date(NOW.getTime() - ageDays * DAY_MS),
				cumulative_blurt_paid: String(loyaltyBlurt)
			}
		]
	};
}

function eligibilityEmptySeed() {
	return { match: 'created_block_time', rows: [], rowCount: 0 };
}

console.log('\n── feeAttest handler (Finding I gate) ────────────────');

// ─── Eligibility rejections ─────────────────────────────────

await scenario('rejects attestor_account_not_found', async () => {
	const mock = makeMockClient([orderSeed('pending_external'), eligibilityEmptySeed()]);
	const r = await handler(ctxFor({}), mock.client);
	assertEqual(r, { ok: false, reason: 'attestor_account_not_found' }, 'result');
	if (mock.queries.length !== 2) {
		throw new Error(`expected 2 queries (order + elig), got ${mock.queries.length}`);
	}
});

await scenario('launch phase: rejects both-gates-fail with composite code', async () => {
	const mock = makeMockClient([
		orderSeed('pending_external'),
		eligibilitySeed(10, 10) // 10 days, 10 BLURT — both short
	]);
	const r = await handler(ctxFor({ phase: 'launch' }), mock.client);
	assertEqual(
		r,
		{ ok: false, reason: 'attestor_insufficient_loyalty_and_young_account' },
		'result'
	);
});

await scenario('steady phase: rejects young_account when age short but loyalty ok', async () => {
	const mock = makeMockClient([orderSeed('pending_external'), eligibilitySeed(10, 500)]);
	const r = await handler(ctxFor({ phase: 'steady' }), mock.client);
	assertEqual(r, { ok: false, reason: 'attestor_young_account' }, 'result');
});

await scenario('steady phase: rejects insufficient_loyalty when old but poor', async () => {
	const mock = makeMockClient([orderSeed('pending_external'), eligibilitySeed(100, 10)]);
	const r = await handler(ctxFor({ phase: 'steady' }), mock.client);
	assertEqual(r, { ok: false, reason: 'attestor_insufficient_loyalty' }, 'result');
});

// ─── Eligibility admissions ─────────────────────────────────

await scenario('launch phase: admits on age-only', async () => {
	const mock = makeMockClient([
		orderSeed('pending_external'),
		eligibilitySeed(60, 0),
		{ match: 'INSERT INTO fee_attestations', rowCount: 1 },
		{
			match: 'COUNT(DISTINCT attestor)',
			rows: [{ total_attestors: '1', non_poster_attestors: '1' }],
			rowCount: 1
		}
	]);
	const r = await handler(ctxFor({ phase: 'launch' }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('launch phase: admits on loyalty-only', async () => {
	const mock = makeMockClient([
		orderSeed('pending_external'),
		eligibilitySeed(5, 150),
		{ match: 'INSERT INTO fee_attestations', rowCount: 1 },
		{
			match: 'COUNT(DISTINCT attestor)',
			rows: [{ total_attestors: '1', non_poster_attestors: '1' }],
			rowCount: 1
		}
	]);
	const r = await handler(ctxFor({ phase: 'launch' }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

await scenario('steady phase: admits when both gates pass', async () => {
	const mock = makeMockClient([
		orderSeed('pending_external'),
		eligibilitySeed(60, 500),
		{ match: 'INSERT INTO fee_attestations', rowCount: 1 },
		{
			match: 'COUNT(DISTINCT attestor)',
			rows: [{ total_attestors: '1', non_poster_attestors: '1' }],
			rowCount: 1
		}
	]);
	const r = await handler(ctxFor({ phase: 'steady' }), mock.client);
	assertEqual(r, { ok: true }, 'result');
});

// ─── Pre-gate paths unchanged by Finding I ──────────────────

await scenario('pre-gate validation still rejects invalid payload shape', async () => {
	const mock = makeMockClient();
	const r = await handler(makeCtx({ signer: 'charlie', payload: 'nope' as unknown }), mock.client);
	assertEqual(r, { ok: false, reason: 'payload_not_object' }, 'result');
	if (mock.queries.length !== 0) {
		throw new Error('validation failures should not touch DB');
	}
});

await scenario('order_not_found still short-circuits before eligibility', async () => {
	const mock = makeMockClient([
		{ match: 'SELECT fee_status, account FROM orders', rows: [], rowCount: 0 }
	]);
	const r = await handler(ctxFor({}), mock.client);
	assertEqual(r, { ok: false, reason: 'order_not_found' }, 'result');
	if (mock.queries.length !== 1) {
		throw new Error('order_not_found should stop at order lookup');
	}
});

// ─── Promotion flow ─────────────────────────────────────────

await scenario(
	'promotes order when ≥2 attestors + ≥1 non-poster + eligibility passes',
	async () => {
		const mock = makeMockClient([
			orderSeed('pending_external'),
			eligibilitySeed(60, 500),
			{ match: 'INSERT INTO fee_attestations', rowCount: 1 },
			{
				match: 'COUNT(DISTINCT attestor)',
				rows: [{ total_attestors: '2', non_poster_attestors: '1' }],
				rowCount: 1
			},
			{ match: 'UPDATE orders', rowCount: 1 }
		]);
		const r = await handler(ctxFor({ phase: 'launch' }), mock.client);
		assertEqual(r, { ok: true }, 'result');
		// UPDATE ran.
		const updateRan = mock.queries.some((q) => q.text.includes('UPDATE orders'));
		if (!updateRan) throw new Error('expected UPDATE to run');
	}
);

await scenario('does NOT promote when self-attestation alone (non_poster=0)', async () => {
	const mock = makeMockClient([
		orderSeed('pending_external'),
		eligibilitySeed(60, 500),
		{ match: 'INSERT INTO fee_attestations', rowCount: 1 },
		{
			match: 'COUNT(DISTINCT attestor)',
			// 1 total, 0 non-poster = self-attesting.
			rows: [{ total_attestors: '1', non_poster_attestors: '0' }],
			rowCount: 1
		}
	]);
	const r = await handler(
		ctxFor({ signer: 'bob', orderAccount: 'bob', phase: 'launch' }),
		mock.client
	);
	assertEqual(r, { ok: true }, 'result');
	const updateRan = mock.queries.some((q) => q.text.includes('UPDATE orders'));
	if (updateRan) throw new Error('self-only promotion should not run UPDATE');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
