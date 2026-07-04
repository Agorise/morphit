/**
 * Operator-earnings attribution (audit) — tsx smoke runner.
 *
 * cp408 — the operator's 90% is now paid DIRECTLY at payment time by the fee
 * split (see feeTransfersFor / sumFeeTransfers). This module no longer queues a
 * relay payout; it only records attribution + earnings for the dashboard. This
 * smoke covers:
 *
 *   - Pure share-computation (computeOperatorShareBlurt), which now delegates to
 *     the same splitListingFeeBlurt the payment uses, so recorded earnings match
 *     what the operator was actually paid.
 *   - Pure tag-field validation (validateOperatorTagField).
 *   - End-to-end attributeBlurtFeeToOperator against a mock PoolClient covering
 *     every AttributionResult branch AND verifying the audit-only side effects:
 *       • Successful attribution → 1 operator_attribution_events INSERT +
 *         1 operator_earnings UPSERT. NO relay queue, NO operator_payouts.
 *       • Replay (trx_id UNIQUE 23505) → duplicate_attribution, NO earnings
 *         upsert on the second attempt.
 *
 * Black-hat scenarios under test:
 *   - Tag forging → tag_unknown, no DB writes
 *   - Inactive operator → tag_unknown via WHERE is_active=TRUE
 *   - Replay (UNIQUE 23505) → duplicate_attribution, NO downstream writes
 *   - Malformed / missing tags → tag_malformed / no_tag before any SQL
 *   - Sub-BLURT-precision rounding → 3-decimal output, no float drift
 *
 * Usage:
 *   tsx apps/indexer/scripts/operator-earnings-smoke.ts
 */

import {
	computeOperatorShareBlurt,
	validateOperatorTagField,
	attributeBlurtFeeToOperator,
	OPERATOR_BLURT_SPLIT_PERCENT
} from '../src/indexer/operatorEarnings.ts';
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

const TRX_ID = '0000000000000000000000000000000000000abc';
const BLOCK_NUM = 12_345;
const BLOCK_TIME = new Date('2026-05-02T12:00:00Z');

async function run(): Promise<void> {
	console.log('operator-earnings attribution (audit-only) smoke');
	console.log(
		`  (split policy: ${OPERATOR_BLURT_SPLIT_PERCENT}% to operator, ${
			100 - OPERATOR_BLURT_SPLIT_PERCENT
		}% to treasury — both delivered at payment time by the fee split)`
	);

	// ─── computeOperatorShareBlurt ────────────────────────────────
	// Delegates to splitListingFeeBlurt: treasury = round(10% of total) in
	// integer milliBLURT, operator = remainder — so shares always sum to total.

	await scenario('share: 100 BLURT → 90 / 10', () => {
		const r = computeOperatorShareBlurt(100);
		assertEqual(r, { operatorShareBlurt: '90.000', treasuryShareBlurt: '10.000' }, 'shares');
	});

	await scenario('share: 60 BLURT → 54 / 6', () => {
		const r = computeOperatorShareBlurt(60);
		assertEqual(r, { operatorShareBlurt: '54.000', treasuryShareBlurt: '6.000' }, 'shares');
	});

	await scenario('share: 0.125 BLURT → 0.112 / 0.013 (round to milliBLURT)', () => {
		const r = computeOperatorShareBlurt(0.125);
		assertEqual(r, { operatorShareBlurt: '0.112', treasuryShareBlurt: '0.013' }, 'shares');
	});

	await scenario('share: shares always sum exactly to the fee total', () => {
		for (const fee of [60, 75, 100, 0.125, 123.456, 42.001]) {
			const r = computeOperatorShareBlurt(fee);
			const sum = Number(r.operatorShareBlurt) + Number(r.treasuryShareBlurt);
			// The fee itself is milliBLURT-rounded in the split; compare at 3dp.
			if (Math.round(sum * 1000) !== Math.round(fee * 1000)) {
				throw new Error(`fee ${fee}: shares ${r.operatorShareBlurt}+${r.treasuryShareBlurt} != total`);
			}
		}
	});

	await scenario('share: rejects negative fee', () => {
		try {
			computeOperatorShareBlurt(-1);
			throw new Error('expected throw');
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes('invalid')) {
				throw new Error(`wrong error: ${err}`);
			}
		}
	});

	await scenario('share: rejects zero fee', () => {
		try {
			computeOperatorShareBlurt(0);
			throw new Error('expected throw');
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes('invalid')) {
				throw new Error(`wrong error: ${err}`);
			}
		}
	});

	await scenario('share: rejects NaN', () => {
		try {
			computeOperatorShareBlurt(NaN);
			throw new Error('expected throw');
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes('invalid')) {
				throw new Error(`wrong error: ${err}`);
			}
		}
	});

	// ─── validateOperatorTagField ─────────────────────────────────

	await scenario('tag-validate: missing → reason=missing', () => {
		assertEqual(validateOperatorTagField(undefined), { reason: 'missing' }, 'r');
		assertEqual(validateOperatorTagField(null), { reason: 'missing' }, 'r');
		assertEqual(validateOperatorTagField(''), { reason: 'missing' }, 'r');
	});

	await scenario('tag-validate: non-string → reason=malformed', () => {
		assertEqual(validateOperatorTagField(123), { reason: 'malformed' }, 'r');
		assertEqual(validateOperatorTagField({}), { reason: 'malformed' }, 'r');
		assertEqual(validateOperatorTagField([]), { reason: 'malformed' }, 'r');
	});

	await scenario('tag-validate: too long → malformed', () => {
		const longTag = 'a'.repeat(65);
		assertEqual(validateOperatorTagField(longTag), { reason: 'malformed' }, 'r');
	});

	await scenario('tag-validate: bad charset → malformed', () => {
		assertEqual(validateOperatorTagField('Alice'), { reason: 'malformed' }, 'r');
		assertEqual(validateOperatorTagField('alice@bob'), { reason: 'malformed' }, 'r');
		assertEqual(validateOperatorTagField('alice bob'), { reason: 'malformed' }, 'r');
		assertEqual(validateOperatorTagField("alice'); DROP TABLE"), { reason: 'malformed' }, 'r');
	});

	await scenario('tag-validate: well-formed → tag returned', () => {
		assertEqual(validateOperatorTagField('alice'), { tag: 'alice' }, 'r');
		assertEqual(validateOperatorTagField('morphit-berlin'), { tag: 'morphit-berlin' }, 'r');
		assertEqual(validateOperatorTagField('a.b_c-d.0'), { tag: 'a.b_c-d.0' }, 'r');
	});

	// ─── attributeBlurtFeeToOperator: audit-only side effects ─────

	const baseArgs = {
		orderAccount: 'bob',
		orderPermlink: 'order-2026-05-02-aaa',
		feeBlurt: 60,
		trxId: TRX_ID,
		blockNum: BLOCK_NUM,
		blockTime: BLOCK_TIME
	};

	function expectLookup(rows: { account: string }[]): QueryExpectation {
		return {
			match: 'FROM operators',
			rows,
			rowCount: rows.length
		};
	}

	function expectInsertAttribution(): QueryExpectation {
		return {
			match: 'INSERT INTO operator_attribution_events',
			rows: [],
			rowCount: 1
		};
	}

	function expectUpsertEarnings(): QueryExpectation {
		return {
			match: 'INSERT INTO operator_earnings',
			rows: [],
			rowCount: 1
		};
	}

	await scenario('attribute: missing tag → no_tag, NO DB writes', async () => {
		const mock = makeMockClient([]);
		const r = await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: undefined,
			...baseArgs,
			instanceOperatorTag: 'alice'
		});
		assertEqual(r, { kind: 'no_tag' }, 'result');
		assertEqual(mock.queries.length, 0, 'no queries');
	});

	await scenario('attribute: malformed tag → tag_malformed, NO DB writes', async () => {
		const mock = makeMockClient([]);
		const r = await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: 'BAD CHARS',
			...baseArgs,
			instanceOperatorTag: 'BAD CHARS'
		});
		assertEqual(r, { kind: 'tag_malformed' }, 'result');
		assertEqual(mock.queries.length, 0, 'no queries');
	});

	await scenario('attribute: tag-too-long → tag_malformed, NO DB writes', async () => {
		const mock = makeMockClient([]);
		const r = await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: 'a'.repeat(65),
			...baseArgs,
			instanceOperatorTag: 'alice'
		});
		assertEqual(r, { kind: 'tag_malformed' }, 'result');
		assertEqual(mock.queries.length, 0, 'no queries');
	});

	await scenario('attribute: unknown tag → tag_unknown, lookup happened, no writes', async () => {
		const mock = makeMockClient([expectLookup([])]);
		const r = await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: 'ghost',
			...baseArgs,
			instanceOperatorTag: 'ghost'
		});
		assertEqual(r, { kind: 'tag_unknown' }, 'result');
		assertEqual(mock.queries.length, 1, 'lookup only');
	});

	await scenario(
		'attribute: known active operator, fee 60 → attributed (audit + earnings, NO relay queue)',
		async () => {
			const mock = makeMockClient([
				expectLookup([{ account: 'alice' }]),
				expectInsertAttribution(),
				expectUpsertEarnings()
			]);
			const r = await attributeBlurtFeeToOperator({
				client: mock.client,
				operatorTagRaw: 'alice',
				...baseArgs,
				instanceOperatorTag: 'alice'
			});
			assertEqual(
				r,
				{
					kind: 'attributed',
					operatorAccount: 'alice',
					operatorShareBlurt: 54
				},
				'result'
			);
			assertEqual(
				mock.queries.length,
				3,
				'lookup + attribution insert + earnings upsert (NO relay queue, NO payout audit)'
			);
			// Positively assert the retired writes are absent.
			for (const q of mock.queries) {
				if (q.text.includes('relay_pending_transfers') || q.text.includes('operator_payouts')) {
					throw new Error(`retired payout write present: ${q.text.slice(0, 60)}`);
				}
			}
		}
	);

	await scenario(
		'attribute: replay (trx_id UNIQUE violation) → duplicate_attribution, NO earnings upsert',
		async () => {
			// CRITICAL: if the attribution insert fails with a unique violation, we
			// must NOT proceed to the operator_earnings UPSERT — otherwise replays
			// would double-count earnings.
			const mock = makeMockClient([
				expectLookup([{ account: 'alice' }]),
				{
					match: 'INSERT INTO operator_attribution_events',
					throwError: Object.assign(new Error('duplicate'), {
						code: '23505'
					})
				}
				// NO further expectations: handler must abort.
			]);
			const r = await attributeBlurtFeeToOperator({
				client: mock.client,
				operatorTagRaw: 'alice',
				...baseArgs,
				instanceOperatorTag: 'alice'
			});
			assertEqual(r, { kind: 'duplicate_attribution' }, 'result');
			assertEqual(mock.queries.length, 2, 'lookup + failed attribution (NO earnings upsert)');
		}
	);

	await scenario('attribute: non-unique-violation throw bubbles up', async () => {
		const mock = makeMockClient([
			expectLookup([{ account: 'alice' }]),
			{
				match: 'INSERT INTO operator_attribution_events',
				throwError: new Error('connection lost')
			}
		]);
		try {
			await attributeBlurtFeeToOperator({
				client: mock.client,
				operatorTagRaw: 'alice',
				...baseArgs,
				instanceOperatorTag: 'alice'
			});
			throw new Error('expected handler to rethrow');
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes('connection lost')) {
				throw new Error(`wrong error: ${err}`);
			}
		}
	});

	await scenario(
		'attribute: lookup uses parameterized query (SQLi-proof structural test)',
		async () => {
			const mock = makeMockClient([
				expectLookup([{ account: 'alice' }]),
				expectInsertAttribution(),
				expectUpsertEarnings()
			]);
			await attributeBlurtFeeToOperator({
				client: mock.client,
				operatorTagRaw: 'alice',
				...baseArgs,
				instanceOperatorTag: 'alice'
			});
			const lookup = mock.queries[0]!;
			assertEqual(lookup.params, ['alice'], 'tag is a $1 parameter');
		}
	);

	await scenario('attribute: inactive operator (filter excluded) → tag_unknown', async () => {
		// Lookup includes WHERE is_active = TRUE. An inactive operator's row is
		// filtered out, so the lookup returns 0 rows — same outward behavior as a
		// non-existent tag. Deactivated operators simply stop earning new
		// attribution; nothing is stranded (they were paid at source).
		const mock = makeMockClient([expectLookup([])]);
		const r = await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: 'alice',
			...baseArgs,
			instanceOperatorTag: 'alice'
		});
		assertEqual(r, { kind: 'tag_unknown' }, 'result');
		const lookup = mock.queries[0]!;
		if (!lookup.text.includes('is_active')) {
			throw new Error('lookup must filter is_active = TRUE');
		}
	});

	await scenario(
		'attribute: Part-111 gate — op for another instance → attributed_other_instance, NO writes',
		async () => {
			const mock = makeMockClient([]);
			const r = await attributeBlurtFeeToOperator({
				client: mock.client,
				operatorTagRaw: 'other-community',
				...baseArgs,
				instanceOperatorTag: 'alice'
			});
			assertEqual(
				r,
				{ kind: 'attributed_other_instance', opTag: 'other-community', instanceTag: 'alice' },
				'result'
			);
			assertEqual(mock.queries.length, 0, 'no DB writes for another instance');
		}
	);

	console.log('');
	if (failures > 0) {
		console.log(`✗ ${failures}/${scenarios} scenarios failed`);
		process.exit(1);
	} else {
		console.log(`✓ all ${scenarios} scenarios passed`);
	}
}

await run();
