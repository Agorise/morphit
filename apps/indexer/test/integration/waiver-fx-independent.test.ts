/**
 * a first-buy waiver's verdict never depends on a node's FX
 * table. The $1 USD-equivalent minimum is checked by the client before it
 * signs; the indexer judges only what the chain says.
 *
 * Before: the handler converted amount_min with each node's live FX rate, so
 * EUR 0.93 was applied at 1.08 USD/EUR and rejected at 1.07 (HO poc6, IX2
 * fx_diverge), and a node without a rate for the currency rejected it.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const waiver = (permlink: string, fiat: string, min: number) => ({
	permlink,
	side: 'buy',
	asset: 'BLURT',
	fiat_currency: fiat,
	amount_min: min,
	amount_max: min * 10,
	price_model: { kind: 'spread', percent: 1 },
	payment_methods: ['cash_in_person'],
	fee_method: 'waived_first_buy'
});

const blockOf = (signer: string, payload: unknown, n: number) => ({
	timestamp: '2026-10-01T12:00:00',
	transaction_ids: [`w${n}`.padEnd(40, '0')],
	transactions: [
		{
			operations: [
				[
					'custom_json',
					{
						required_auths: [],
						required_posting_auths: [signer],
						id: 'morphit_order_v1',
						json: JSON.stringify(payload)
					}
				]
			]
		}
	]
});

const FX: Record<string, (a: number, f: string) => number | null> = {
	'EUR at 1.08': (a, f) => (f === 'EUR' ? a * 1.08 : f === 'USD' ? a : null),
	'EUR at 1.07': (a, f) => (f === 'EUR' ? a * 1.07 : f === 'USD' ? a : null),
	'no FX table (zero-clearnet, feed off)': (a, f) => (f === 'USD' ? a : null)
};

async function node(fx: IntegrationFixture, convert: (a: number, f: string) => number | null) {
	const ops: [string, unknown][] = [
		['alice', waiver('w-eur', 'EUR', 0.93)],
		['bob', waiver('w-irr', 'IRR', 50_000)],
		['carol', waiver('w-usd', 'USD', 1)]
	];
	let n = 500;
	for (const [signer, payload] of ops) {
		const c: pg.PoolClient = await fx.pool.connect();
		try {
			await c.query(`SET search_path TO "${fx.schema}"`);
			await c.query('BEGIN');
			await applyBlock(
				c,
				++n,
				blockOf(signer, payload, n) as never,
				mockBlurt({}),
				fakeConfig({}),
				{},
				{},
				convert as never
			);
			await c.query('COMMIT');
		} finally {
			c.release();
		}
	}
	const verdicts = await fx.db.query<{ s: string }>(
		`SELECT signer || ':' || status || ':' || COALESCE(reject_reason, '') AS s FROM ops ORDER BY block_num`
	);
	const orders = await fx.db.query(
		`SELECT account, permlink, fee_status, fee_method FROM orders ORDER BY account`
	);
	return { verdicts: verdicts.rows.map((r) => r.s), orders: orders.rows };
}

describe.skipIf(!INTEGRATION_ENABLED)('first-buy waivers do not depend on FX', () => {
	const fxs: IntegrationFixture[] = [];
	beforeAll(async () => {
		for (let i = 0; i < 3; i++) fxs.push(await setupWithMigrations());
	});
	afterAll(async () => {
		for (const fx of fxs) await fx.teardown();
	});

	it('the same waiver ops reach the same verdicts under three different FX tables', async () => {
		const results = [];
		const labels = Object.keys(FX);
		for (let i = 0; i < labels.length; i++) results.push(await node(fxs[i]!, FX[labels[i]!]!));
		for (const r of results.slice(1)) {
			expect(r.verdicts).toEqual(results[0]!.verdicts);
			expect(r.orders).toEqual(results[0]!.orders);
		}
		expect(results[0]!.verdicts).toEqual(['alice:applied:', 'bob:applied:', 'carol:applied:']);
	});
});
