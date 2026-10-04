/**
 * the low-balance dust refill.
 *
 *  - an account whose only orders never paid their listing fee
 *    ('missing') was refilled like a paying user, every cooldown.
 *  - the "atomic" WHERE NOT EXISTS check-and-insert is not atomic
 *    under READ COMMITTED; two scanners on one database (two indexer
 *    processes) both queued a refill for the same account (DB-9). The v66
 *    partial unique index plus ON CONFLICT makes the second a no-op.
 *
 * Real scanner, real Postgres; only the chain balance read is stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LowBalanceScanner } from '../../src/indexer/lowBalanceScanner';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { mockBlurt } from '../testutils/context';

const config = {
	intervalMs: 0,
	thresholdBlurt: 1,
	activityWindowDays: 30,
	refillCooldownDays: 7,
	refillAmountBlurt: 0.5,
	maxBatch: 50
};

describe.skipIf(!INTEGRATION_ENABLED)('low-balance dust refill', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		for (const [who, fee] of [
			['payer', 'verified'],
			['freeloader', 'missing']
		]) {
			await fx.db.query(
				`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id)
				 VALUES ($1, 'morphit-relay', 1, NOW(), 'x')`,
				[who]
			);
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method, operator_tag)
				 VALUES ($1, 'o1', 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], 'live', NOW(), NOW(), $2, 'blurt', 'mine')`,
				[who, fee]
			);
		}
	});

	const scanner = () =>
		new LowBalanceScanner(
			fx.db,
			mockBlurt({
				getAccounts: (async (names: readonly string[]) =>
					new Map(names.map((n) => [n, { balance: '0.010 BLURT' }]))) as never
			}),
			'morphit-relay',
			config as never,
			'mine'
		);

	it('only an account that paid a listing fee is refilled', async () => {
		await scanner().scanOnce();
		const rows = await fx.db.query<{ recipient: string }>(
			`SELECT recipient FROM relay_pending_transfers WHERE reason = 'dust_refill' ORDER BY 1`
		);
		expect(rows.rows.map((r) => r.recipient)).toEqual(['payer']);
	});

	it('two scanners running at once queue one refill, not two', async () => {
		for (let round = 0; round < 5; round++) {
			await fx.db.query(`DELETE FROM relay_pending_transfers`);
			await Promise.all([scanner().scanOnce(), scanner().scanOnce(), scanner().scanOnce()]);
			const n = await fx.db.query<{ n: number }>(
				`SELECT COUNT(*)::int AS n FROM relay_pending_transfers WHERE recipient = 'payer'`
			);
			expect(n.rows[0]!.n).toBe(1);
		}
	});
});
