/**
 * a paid feature bid that does not beat the slot it would take
 * by the minimum increment is accepted and QUEUED, not refused.
 *
 * Before: the bid's BLURT moved on chain with the op, the handler refused it
 * (`bid_increment_too_small`), and the bidder lost the fee for nothing — while
 * the handler's comment claimed the rejection "rolls the transfer back"
 * (MK repro-featurebid-burn). From CONSENSUS_V2_ACTIVATION_TIME the bid is
 * recorded and takes effect when the bid it would have displaced expires,
 * for its full hours; before that block the old verdict stands.
 *
 * Real dispatcher, real handlers, real Postgres.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

type Op = [string, unknown];
const cj = (signer: string, id: string, json: unknown): Op => [
	'custom_json',
	{ required_auths: [signer], required_posting_auths: [], id, json: JSON.stringify(json) }
];
const xfer = (from: string, amount: string, memo: string): Op => [
	'transfer',
	{ from, to: 'morphit-fees', amount, memo }
];
const order = (p: string) => ({
	permlink: p,
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 10,
	amount_max: 100,
	price_model: { kind: 'spread', percent: 1 },
	payment_methods: ['cash_in_person']
});
const listed = (who: string): Op[] => [
	xfer(who, '62.500 BLURT', `morphit-fee:${who}-o`),
	cj(who, 'morphit_order_v1', order(`${who}-o`))
];
const bid = (who: string, blurt: string): Op[] => [
	xfer(who, blurt, `morphit-feature:${who}-o`),
	cj(who, 'morphit_feature_bid_v1', { order_permlink: `${who}-o`, hours_requested: 6 })
];

const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
/** The old rule's chain starts a month before the activation time. */
const EARLIER = ACTIVATION - 30 * 86_400_000;

async function run(fx: IntegrationFixture, base: number, t0: number, carolCancels = false) {
	const blocks: [number, Op[][]][] = [
		[base, [listed('alice'), listed('bob'), listed('carol'), listed('dave')]],
		[base + 1, [bid('alice', '300.000 BLURT')]],
		[base + 2, [bid('bob', '300.000 BLURT')]],
		[
			base + 3,
			[
				bid('carol', '300.000 BLURT'),
				...(carolCancels
					? [
							[
								[
									'custom_json',
									{
										required_auths: [],
										required_posting_auths: ['carol'],
										id: 'morphit_order_cancel_v1',
										json: JSON.stringify({ permlink: 'carol-o' })
									}
								] as Op
							]
						]
					: [])
			]
		],
		// 51 BLURT/h against a 50 BLURT/h slot: under the max(1 BLURT/h, 5 %) increment.
		[base + 4, [bid('dave', '306.000 BLURT')]]
	];
	for (const [n, trxs] of blocks) {
		const c: pg.PoolClient = await fx.pool.connect();
		try {
			await c.query(`SET search_path TO "${fx.schema}"`);
			await c.query('BEGIN');
			await applyBlock(
				c,
				n,
				{
					timestamp: new Date(t0 + (n - base) * 3000).toISOString().slice(0, 19),
					transaction_ids: trxs.map((_, i) => `${n}-${i}`.padEnd(40, 'f')),
					transactions: trxs.map((operations) => ({ operations }))
				} as never,
				mockBlurt({ reachableOperatorCount: () => 1 }),
				fakeConfig({ feeBaseBlurt: 62.5 }),
				{},
				{},
				((a: number) => a) as never
			);
			await c.query('COMMIT');
		} catch (e) {
			await c.query('ROLLBACK').catch(() => undefined);
			throw e;
		} finally {
			c.release();
		}
	}
	const dave = await fx.db.query<{ s: string }>(
		`SELECT status || ':' || COALESCE(reject_reason, '') AS s FROM ops
		  WHERE signer = 'dave' AND op_id = 'morphit_feature_bid_v1'`
	);
	const visibleAt = async (t: number) =>
		(
			await fx.db.query<{ bidder: string }>(
				`SELECT bidder FROM featured_slot_bids
				  WHERE cancelled = FALSE AND effective_at <= $1 AND expires_at > $1
				  ORDER BY blurt_per_hour DESC, block_time_at ASC LIMIT 3`,
				[new Date(t)]
			)
		).rows.map((r) => r.bidder);
	const daveRow = await fx.db.query<{ hours: number }>(
		`SELECT EXTRACT(EPOCH FROM (expires_at - effective_at))::int / 3600 AS hours
		   FROM featured_slot_bids WHERE bidder = 'dave'`
	);
	return {
		verdict: dave.rows[0]?.s,
		now: await visibleAt(t0 + 15_000),
		afterCarolExpires: await visibleAt(t0 + 9_000 + 6 * 3_600_000 + 1_000),
		daveHours: daveRow.rows[0]?.hours
	};
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'a paid feature bid under the increment is queued, not burned',
	() => {
		let before: IntegrationFixture;
		let after: IntegrationFixture;
		beforeAll(async () => {
			before = await setupWithMigrations();
			after = await setupWithMigrations();
		});
		afterAll(async () => {
			await before?.teardown();
			await after?.teardown();
		});

		it('from the activation time: accepted, displaces nobody now, runs its full hours once the slot frees', async () => {
			const r = await run(after, 10, ACTIVATION);
			expect(r.verdict).toBe('applied:');
			expect(r.now).toEqual(['alice', 'bob', 'carol']);
			expect(r.afterCarolExpires).toEqual(['dave']);
			expect(r.daveHours).toBe(6);
		});

		// a bid whose order is no longer live does not hold a slot.
		it('from the activation time a bid on a cancelled order holds no slot: the next bid takes it at once', async () => {
			const fx = await setupWithMigrations();
			try {
				const r = await run(fx, 10, ACTIVATION, true);
				expect(r.verdict).toBe('applied:');
				expect(r.now.sort()).toEqual(
					['alice', 'bob', 'carol', 'dave'].filter((x) => x !== 'carol').sort()
				);
			} finally {
				await fx.teardown();
			}
		});

		it('before the activation time the old verdict stands (history unchanged)', async () => {
			const r = await run(before, 100, EARLIER);
			expect(r.verdict).toBe('rejected:bid_increment_too_small');
			expect(r.now).toEqual(['alice', 'bob', 'carol']);
		});
	}
);
