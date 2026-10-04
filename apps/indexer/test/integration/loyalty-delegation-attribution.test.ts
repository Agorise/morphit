/**
 * loyalty delegations are not paid twice across instances.
 *
 * A delegation SETS the level delegated from the relay that broadcasts it.
 * Each instance's relay used to queue the account's WHOLE cumulative reward,
 * so a user whose first milestones were reached through instance A and a later
 * one through instance B was delegated the early rewards by both relays.
 * Now each relay's target is the rewards reached through its own instance.
 *
 * The same chain is indexed by two nodes, one per instance tag; real
 * dispatcher, real order handler and loyalty tracking, real Postgres.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

type Op = [string, unknown];
const paidOrder = (n: number, tag: string): Op[] => [
	[
		'transfer',
		{ from: 'ulla', to: 'morphit-fees', amount: '100.000 BLURT', memo: `morphit-fee:o${n}` }
	],
	[
		'custom_json',
		{
			required_auths: ['ulla'],
			required_posting_auths: [],
			id: 'morphit_order_v1',
			json: JSON.stringify({
				permlink: `o${n}`,
				side: 'sell',
				asset: 'BTC',
				fiat_currency: 'USD',
				amount_min: 10,
				amount_max: 100,
				price_model: { kind: 'spread', percent: 1 },
				payment_methods: ['cash_in_person'],
				operator_tag: tag
			})
		}
	]
];

/** Two orders through instance A (100 + 100: welcome + the 100 milestone),
 *  then four through B (cumulative 600: the 500 milestone). */
const CHAIN: [number, Op[]][] = [
	[101, paidOrder(1, 'inst-a')],
	[102, paidOrder(2, 'inst-a')],
	[103, paidOrder(3, 'inst-b')],
	[104, paidOrder(4, 'inst-b')],
	[105, paidOrder(5, 'inst-b')],
	[106, paidOrder(6, 'inst-b')]
];

async function indexAs(fx: IntegrationFixture, instanceTag: string): Promise<number> {
	for (const [n, ops] of CHAIN) {
		const c: pg.PoolClient = await fx.pool.connect();
		try {
			await c.query(`SET search_path TO "${fx.schema}"`);
			await c.query('BEGIN');
			await applyBlock(
				c,
				n,
				{
					timestamp: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3000)
						.toISOString()
						.slice(0, 19),
					transaction_ids: [`${n}`.padEnd(40, 'f')],
					transactions: [{ operations: ops }]
				} as never,
				mockBlurt({ reachableOperatorCount: () => 1 }),
				// A high base so every fee is tier-1 verified whatever the order count.
				fakeConfig({ feeBaseBlurt: 62.5, instanceOperatorTag: instanceTag }),
				{},
				{},
				((a: number) => a) as never
			);
			await c.query('COMMIT');
		} finally {
			c.release();
		}
	}
	// The relay sets the delegation to its LAST queued target.
	const last = await fx.db.query<{ bp: string }>(
		`SELECT amount_bp::text AS bp FROM relay_pending_transfers
		  WHERE recipient = 'ulla' AND kind = 'delegation' ORDER BY id DESC LIMIT 1`
	);
	return Number(last.rows[0]?.bp ?? '0');
}

describe.skipIf(!INTEGRATION_ENABLED)('loyalty delegations per instance', () => {
	let a: IntegrationFixture;
	let b: IntegrationFixture;
	beforeAll(async () => {
		a = await setupWithMigrations();
		b = await setupWithMigrations();
	});
	afterAll(async () => {
		await a?.teardown();
		await b?.teardown();
	});

	it("the two relays together delegate the account's rewards once", async () => {
		const fromA = await indexAs(a, 'inst-a');
		const fromB = await indexAs(b, 'inst-b');
		const all = await b.db.query<{ bp: string }>(
			`SELECT COALESCE(SUM(bp_rewarded), 0)::text AS bp FROM account_loyalty_milestones WHERE account = 'ulla'`
		);
		expect({ fromA, fromB }).toEqual({ fromA: 11, fromB: 50 });
		expect(fromA + fromB).toBe(Number(all.rows[0]!.bp));
	});
});
