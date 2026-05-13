/**
 * featureBid handler — tsx smoke runner.
 *
 * Exercises `morphit_feature_bid_v1` validation paths.  Coverage
 * focus is the MIN-BID INCREMENT rule shipped 2026-05-02 (REVISIT-LIST
 * §G "Featured-slot auction refinements"):
 *
 *   - When < MAX_SLOTS_VISIBLE active bids exist, any new bid is
 *     accepted (no displacement).
 *   - When >= MAX_SLOTS_VISIBLE active bids exist:
 *     • New bid below the displaced rank's blurt_per_hour: accept
 *       (queues at position N+1, no visible displacement).
 *     • New bid equal to displaced rank: accept (per the
 *       featuredOrderbook tiebreak rule, older bid keeps the slot).
 *     • New bid above displaced rank by less than max(1 BLURT, 5%):
 *       reject as `bid_increment_too_small`.
 *     • New bid above displaced rank by exactly the threshold: accept.
 *
 * Plus regression coverage for the pre-existing reject paths
 * (payload validation, fee verification, order ownership).
 *
 * NOTE on fee floor: tests override `featureFeeBlurtPerHour: 1` so
 * the rates we pick (0.5..200 BLURT/hour for displaced-bid math)
 * comfortably clear the floor.  The default in fakeConfig is 50,
 * which would mask the increment logic behind underpayment rejects.
 *
 * Usage:
 *   tsx apps/indexer/scripts/featurebid-handler-smoke.ts
 */

import handler from '../src/indexer/handlers/featureBid.ts';
import { makeCtx, fakeConfig } from '../test/testutils/context.ts';
import { makeMockClient, type QueryExpectation } from '../test/testutils/mockClient.ts';

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

const SIGNER = 'alice';
const PERMLINK = 'order-2026-05-02-aaa';
const FEE_RECIPIENT = 'morphit-fees';
// Floor of 1 BLURT/hour means our 0.5..200/hour displaced-bid
// rates land safely above floor for every accept-path scenario.
const TEST_FLOOR = 1;

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		order_permlink: PERMLINK,
		hours_requested: 24,
		...over
	};
}

function feeTransfer(
	amountBlurt: number,
	overrides: { from?: string; to?: string; memo?: string } = {}
): readonly (readonly [string, Record<string, unknown>])[] {
	return [
		[
			'transfer',
			{
				from: overrides.from ?? SIGNER,
				to: overrides.to ?? FEE_RECIPIENT,
				amount: `${amountBlurt.toFixed(3)} BLURT`,
				memo: overrides.memo ?? `morphit-feature:${PERMLINK}`
			}
		]
	];
}

function ctxWith(
	over: {
		siblingOps?: ReturnType<typeof feeTransfer>;
		payload?: Record<string, unknown> | string;
		floor?: number;
	} = {}
) {
	return makeCtx({
		signer: SIGNER,
		siblingOps: over.siblingOps ?? feeTransfer(TEST_FLOOR * 24),
		payload: (over.payload ?? payload()) as unknown as object,
		config: fakeConfig({ featureFeeBlurtPerHour: over.floor ?? TEST_FLOOR })
	});
}

function expectOrderLookup(): QueryExpectation {
	return {
		match: 'FROM orders',
		rows: [{ status: 'live', fee_status: 'verified' }],
		rowCount: 1
	};
}

function expectVisibleTop(displacedRate: number | null): QueryExpectation {
	if (displacedRate === null) {
		return { match: 'OFFSET $2 LIMIT 1', rows: [], rowCount: 0 };
	}
	return {
		match: 'OFFSET $2 LIMIT 1',
		rows: [{ blurt_per_hour: displacedRate.toFixed(3) }],
		rowCount: 1
	};
}

function expectInsertBid(): QueryExpectation {
	return { match: 'INSERT INTO featured_slot_bids', rows: [], rowCount: 1 };
}

async function run(): Promise<void> {
	console.log('featureBid handler smoke');

	// ─── Min-bid increment scenarios ──────────────────────────────

	await scenario('min-bid: < MAX_SLOTS_VISIBLE active bids — accept any', async () => {
		const mock = makeMockClient([expectOrderLookup(), expectVisibleTop(null), expectInsertBid()]);
		const ctx = ctxWith({ siblingOps: feeTransfer(2 * 24) });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: true }, 'result');
	});

	await scenario('min-bid: new bid below displaced rank — accept (queues behind)', async () => {
		const mock = makeMockClient([expectOrderLookup(), expectVisibleTop(5), expectInsertBid()]);
		const ctx = ctxWith({ siblingOps: feeTransfer(4.5 * 24) });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: true }, 'result');
	});

	await scenario('min-bid: equal to displaced rank — accept (older wins tiebreak)', async () => {
		const mock = makeMockClient([expectOrderLookup(), expectVisibleTop(5), expectInsertBid()]);
		const ctx = ctxWith({ siblingOps: feeTransfer(5 * 24) });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: true }, 'result');
	});

	await scenario('min-bid: above displaced by 0.05 BLURT/hour (1%) — REJECT', async () => {
		const mock = makeMockClient([expectOrderLookup(), expectVisibleTop(5)]);
		const ctx = ctxWith({ siblingOps: feeTransfer(5.05 * 24) });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: false, reason: 'bid_increment_too_small' }, 'result');
	});

	await scenario('min-bid: exactly +1 BLURT/hour at low rate — accept', async () => {
		const mock = makeMockClient([expectOrderLookup(), expectVisibleTop(2), expectInsertBid()]);
		const ctx = ctxWith({ siblingOps: feeTransfer(3 * 24) });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: true }, 'result');
	});

	await scenario('min-bid: exactly +5% at high rate — accept', async () => {
		const mock = makeMockClient([expectOrderLookup(), expectVisibleTop(100), expectInsertBid()]);
		const ctx = ctxWith({ siblingOps: feeTransfer(105 * 24) });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: true }, 'result');
	});

	await scenario('min-bid: +4.99% at high rate — REJECT (5% threshold dominates)', async () => {
		const mock = makeMockClient([expectOrderLookup(), expectVisibleTop(100)]);
		const ctx = ctxWith({ siblingOps: feeTransfer(104.99 * 24) });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: false, reason: 'bid_increment_too_small' }, 'result');
	});

	// ─── Pre-existing rejection paths (regression) ────────────────

	await scenario('payload: not an object → payload_not_object', async () => {
		const mock = makeMockClient([]);
		const ctx = ctxWith({ payload: 'not an object' });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: false, reason: 'payload_not_object' }, 'result');
	});

	await scenario('payload: hours_requested below MIN_HOURS → out_of_range', async () => {
		const mock = makeMockClient([]);
		const ctx = ctxWith({
			payload: payload({ hours_requested: 1 })
		});
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: false, reason: 'hours_requested_out_of_range' }, 'result');
	});

	await scenario('payload: hours_requested above MAX_HOURS → out_of_range', async () => {
		const mock = makeMockClient([]);
		const ctx = ctxWith({
			payload: payload({ hours_requested: 200 })
		});
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: false, reason: 'hours_requested_out_of_range' }, 'result');
	});

	await scenario('order: not found for signer → referenced_order_not_found', async () => {
		const mock = makeMockClient([{ match: 'FROM orders', rows: [], rowCount: 0 }]);
		const ctx = ctxWith();
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: false, reason: 'referenced_order_not_found' }, 'result');
	});

	await scenario('order: not live → referenced_order_not_live', async () => {
		const mock = makeMockClient([
			{
				match: 'FROM orders',
				rows: [{ status: 'cancelled', fee_status: 'verified' }],
				rowCount: 1
			}
		]);
		const ctx = ctxWith();
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: false, reason: 'referenced_order_not_live' }, 'result');
	});

	await scenario('fee: missing → fee_missing', async () => {
		const mock = makeMockClient([expectOrderLookup()]);
		const ctx = ctxWith({ siblingOps: [] });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: false, reason: 'fee_missing' }, 'result');
	});

	await scenario('fee: underpaid → fee_underpaid', async () => {
		const mock = makeMockClient([expectOrderLookup()]);
		// Floor is 1 BLURT/hour × 24h = 24 BLURT.  Pay 5; underpaid.
		const ctx = ctxWith({ siblingOps: feeTransfer(5) });
		const result = await handler(ctx, mock.client);
		assertEqual(result, { ok: false, reason: 'fee_underpaid' }, 'result');
	});

	console.log('');
	if (failures > 0) {
		console.log(`✗ ${failures}/${scenarios} scenarios failed`);
		process.exit(1);
	} else {
		console.log(`✓ all ${scenarios} scenarios passed`);
	}
}

await run();
