/**
 * Operator-earnings attribution + immediate payout — tsx
 * smoke runner.
 *
 * Coverage focus is the REVISIT-LIST item 5 attribution +
 * immediate-payout pipeline.  Exercises:
 *
 *   - Pure share-computation (computeOperatorShareBlurt)
 *     including 3-decimal floor-rounding.
 *   - Pure tag-field validation (validateOperatorTagField).
 *   - End-to-end attributeBlurtFeeToOperator against a mock
 *     PoolClient covering every AttributionResult branch
 *     AND verifying immediate-payout side effects:
 *       • Successful attribution queues 1 relay transfer +
 *         1 operator_payouts audit row + 1 operator_earnings
 *         UPSERT.
 *       • Sub-precision share (rounds to 0) → attribution
 *         event recorded but NO relay queue (avoid
 *         dust-transfer mana waste).
 *       • Replay → ONE attribution event row total, NO
 *         downstream writes on the second attempt.
 *
 * Black-hat scenarios under test:
 *
 *   - Tag forging → tag_unknown, no DB writes
 *   - Inactive operator → tag_unknown via WHERE is_active=TRUE
 *   - Replay (UNIQUE 23505) → duplicate_attribution, NO
 *     downstream writes
 *   - Malformed tags (length, charset) → tag_malformed before
 *     any SQL fires
 *   - Missing tag → no_tag (no DB writes)
 *   - Sub-BLURT-precision rounding → 3-decimal output, no
 *     float drift, no over-credit
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
	console.log('operator-earnings + immediate-payout smoke');
	console.log(
		`  (split policy: ${OPERATOR_BLURT_SPLIT_PERCENT}% to operator, ${
			100 - OPERATOR_BLURT_SPLIT_PERCENT
		}% to treasury)`
	);

	// ─── computeOperatorShareBlurt ────────────────────────────────

	await scenario('share: 100 BLURT @ 90% → 90 / 10', () => {
		const r = computeOperatorShareBlurt(100);
		assertEqual(r, { operatorShareBlurt: '90.000', treasuryShareBlurt: '10.000' }, 'shares');
	});

	await scenario('share: 60 BLURT @ 90% → 54 / 6', () => {
		const r = computeOperatorShareBlurt(60);
		assertEqual(r, { operatorShareBlurt: '54.000', treasuryShareBlurt: '6.000' }, 'shares');
	});

	await scenario('share: 0.125 BLURT @ 90% → 0.112 / 0.013 (half-down to 3 decimals)', () => {
		const r = computeOperatorShareBlurt(0.125);
		assertEqual(r, { operatorShareBlurt: '0.112', treasuryShareBlurt: '0.013' }, 'shares');
	});

	await scenario(
		'share: tiny fractional fee — floor avoids over-credit (sub-precision dust)',
		() => {
			// 0.001 BLURT × 90 / 100 = 0.0009 → floor(0.9) = 0 milli-BLURT.
			// Treasury keeps it.  No relay queue at this level.
			const r = computeOperatorShareBlurt(0.001);
			assertEqual(r, { operatorShareBlurt: '0.000', treasuryShareBlurt: '0.001' }, 'shares');
		}
	);

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

	// ─── attributeBlurtFeeToOperator: end-to-end side effects ────

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

	function expectInsertAttributionReturning(id: string): QueryExpectation {
		return {
			match: 'INSERT INTO operator_attribution_events',
			rows: [{ id }],
			rowCount: 1
		};
	}

	function expectInsertRelayReturning(id: string): QueryExpectation {
		return {
			match: 'INSERT INTO relay_pending_transfers',
			rows: [{ id }],
			rowCount: 1
		};
	}

	function expectInsertPayout(): QueryExpectation {
		return {
			match: 'INSERT INTO operator_payouts',
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
		'attribute: known active operator, fee 60 → attributed + payout queued',
		async () => {
			const mock = makeMockClient([
				expectLookup([{ account: 'alice' }]),
				expectInsertAttributionReturning('100'),
				expectInsertRelayReturning('500'),
				expectInsertPayout(),
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
					operatorShareBlurt: 54,
					payoutQueued: true
				},
				'result'
			);
			assertEqual(
				mock.queries.length,
				5,
				'lookup + attribution + relay queue + payout audit + earnings upsert'
			);
		}
	);

	await scenario(
		'attribute: sub-precision share (0.001 BLURT fee) → attributed but NO relay queue',
		async () => {
			// 0.001 BLURT × 90% = 0.0009 → floors to 0 milli-BLURT.
			// We still record the attribution event for audit
			// completeness, AND update operator_earnings with 0
			// share + 1 to total_orders_attributed.  But we DON'T
			// queue a relay transfer for a 0-amount payment.
			const mock = makeMockClient([
				expectLookup([{ account: 'alice' }]),
				expectInsertAttributionReturning('101'),
				// NO relay queue, NO payout audit row
				expectUpsertEarnings()
			]);
			const r = await attributeBlurtFeeToOperator({
				client: mock.client,
				operatorTagRaw: 'alice',
				...baseArgs,
			instanceOperatorTag: 'alice',
				feeBlurt: 0.001
			});
			assertEqual(
				r,
				{
					kind: 'attributed',
					operatorAccount: 'alice',
					operatorShareBlurt: 0,
					payoutQueued: false
				},
				'result'
			);
			assertEqual(
				mock.queries.length,
				3,
				'lookup + attribution + earnings upsert (NO relay queue)'
			);
		}
	);

	await scenario(
		'attribute: replay (trx_id UNIQUE violation) → duplicate_attribution, NO downstream writes',
		async () => {
			// CRITICAL: if attribution insert fails with unique
			// violation, we must NOT proceed to the relay queue
			// or operator_earnings UPSERT.  Otherwise replays
			// would queue duplicate transfers.
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
			assertEqual(
				mock.queries.length,
				2,
				'lookup + failed attribution (NO relay queue, NO upsert)'
			);
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
				expectInsertAttributionReturning('102'),
				expectInsertRelayReturning('501'),
				expectInsertPayout(),
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
		// Lookup includes WHERE is_active = TRUE.  An inactive
		// operator's row is filtered out, so the lookup returns
		// 0 rows — same outward behavior as a non-existent tag.
		// In the immediate-payout model this means deactivated
		// operators stop earning new attribution; their PRIOR
		// earnings are already paid (no pending balance to
		// strand).
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

	await scenario('attribute: relay row reason format includes trx_id (linkability)', async () => {
		const mock = makeMockClient([
			expectLookup([{ account: 'alice' }]),
			expectInsertAttributionReturning('103'),
			expectInsertRelayReturning('502'),
			expectInsertPayout(),
			expectUpsertEarnings()
		]);
		await attributeBlurtFeeToOperator({
			client: mock.client,
			operatorTagRaw: 'alice',
			...baseArgs,
			instanceOperatorTag: 'alice'
		});
		// The relay queue insert is at index 2.  Its params
		// should include the operator-payout reason with the
		// trx_id embedded — gives operators a way to trace
		// each transfer back to the originating order op.
		const relayIns = mock.queries[2]!;
		const reason = relayIns.params[2];
		if (typeof reason !== 'string' || !reason.includes(TRX_ID)) {
			throw new Error(`reason must include trx_id, got: ${reason}`);
		}
		if (!reason.startsWith('operator_payout:')) {
			throw new Error(`reason must start with operator_payout:, got: ${reason}`);
		}
	});

	await scenario(
		'attribute: relay queue uses kind=liquid (BLURT transfer, not vesting)',
		async () => {
			const mock = makeMockClient([
				expectLookup([{ account: 'alice' }]),
				expectInsertAttributionReturning('104'),
				expectInsertRelayReturning('503'),
				expectInsertPayout(),
				expectUpsertEarnings()
			]);
			await attributeBlurtFeeToOperator({
				client: mock.client,
				operatorTagRaw: 'alice',
				...baseArgs,
			instanceOperatorTag: 'alice'
			});
			const relayIns = mock.queries[2]!;
			// kind is hardcoded 'liquid' in the SQL, so verify the
			// SQL text contains 'liquid'.
			if (!relayIns.text.includes("'liquid'")) {
				throw new Error(
					`relay queue must use kind='liquid' (literal in SQL); got: ${relayIns.text}`
				);
			}
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
