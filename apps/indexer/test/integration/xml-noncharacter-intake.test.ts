/**
 * (A1 part) — U+FFFE / U+FFFF are refused at intake.
 *
 * Before: an order whose text held U+FFFF was stored and served; one such
 * character made every RSS/Atom feed that carried the order unparseable
 * (IX2-14). From CONSENSUS_V2_ACTIVATION_TIME the op is rejected
 * `invalid_text`, like a NUL or half a surrogate pair; earlier ops keep their
 * verdicts.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';

const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const order = (permlink: string, region: string) => ({
	permlink,
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 10,
	amount_max: 100,
	price_model: { kind: 'spread', percent: 1 },
	payment_methods: ['cash_in_person'],
	location_region: region
});

/** An order in block `n`, stamped `secondsAfter` the activation time. */
async function post(
	fx: IntegrationFixture,
	n: number,
	secondsAfter: number,
	permlink: string,
	region: string
) {
	const c: pg.PoolClient = await fx.pool.connect();
	try {
		await c.query(`SET search_path TO "${fx.schema}"`);
		await c.query('BEGIN');
		await applyBlock(
			c,
			n,
			{
				timestamp: new Date(ACTIVATION + secondsAfter * 1000).toISOString().slice(0, 19),
				transaction_ids: [`${n}`.padEnd(40, 'f')],
				transactions: [
					{
						operations: [
							[
								'custom_json',
								{
									required_auths: [],
									required_posting_auths: ['alice'],
									id: 'morphit_order_v1',
									json: JSON.stringify(order(permlink, region))
								}
							]
						]
					}
				]
			} as never,
			mockBlurt({}),
			fakeConfig({}),
			{},
			{},
			((a: number) => a) as never
		);
		await c.query('COMMIT');
	} finally {
		c.release();
	}
	const op = await fx.db.query<{ s: string }>(
		`SELECT status || ':' || COALESCE(reject_reason, '') AS s FROM ops WHERE block_num = $1`,
		[n]
	);
	const row = await fx.db.query(`SELECT 1 FROM orders WHERE permlink = $1`, [permlink]);
	return { verdict: op.rows[0]?.s, stored: (row.rowCount ?? 0) > 0 };
}

describe.skipIf(!INTEGRATION_ENABLED)('U+FFFE / U+FFFF are refused at intake', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('from the activation time an order holding U+FFFF or U+FFFE is rejected invalid_text and not stored', async () => {
		expect(await post(fx, 301, 0, 'nc1', 'Berlin￿')).toEqual({
			verdict: 'rejected:invalid_text',
			stored: false
		});
		expect(await post(fx, 302, 3, 'nc2', '￾Berlin')).toEqual({
			verdict: 'rejected:invalid_text',
			stored: false
		});
		// ordinary text is untouched
		expect(await post(fx, 303, 6, 'ok1', 'Berlin')).toEqual({
			verdict: 'applied:',
			stored: true
		});
	});

	it('before the activation time the old verdict stands', async () => {
		expect((await post(fx, 100, -1, 'old1', 'Berlin￿')).verdict).toBe('applied:');
	});
});
