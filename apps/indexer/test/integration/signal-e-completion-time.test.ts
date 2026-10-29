/**
 * Signal E (completed-trade concentration) places a trade in its 30-day
 * window by when it was completed — from the consensus activation time.
 *
 * It used to read orders.updated_at, which is not the completion time: an
 * attestation or the partner named later moves it to that op's block time,
 * and a fee re-check to the node's own wall clock. Two nodes that re-checked a
 * fee at different moments then counted different trades in the same window
 * and stored different flags. From CONSENSUS_V2_ACTIVATION_TIME the window
 * reads orders.completed_at (the completion's block time, the same on every
 * node); before it, updated_at as always, so history keeps its verdicts.
 *
 * Skips without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { detectTradeConcentration, tradeWindowColumn } from '../../src/indexer/signals';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';

describe.skipIf(!INTEGRATION_ENABLED)('Signal E window: the completion time', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	}, 60_000);
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
	});

	/** Five trades of `owner` naming `peer`, completed at `completed`, last
	 *  changed (a fee re-check) at `updated`. */
	const trades = async (owner: string, peer: string, completed: string, updated: string) => {
		for (let i = 0; i < 5; i++) {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, completed_counterparty, completed_at)
				 VALUES ($1, $2, 'sell', 'BLURT', 'EUR', '{"kind":"spread","spread":0}'::jsonb, ARRAY['pay_xmr'],
				         'completed', $3, $4, 'verified', $5, $3)`,
				[owner, `order-e${i}`, completed, updated, peer]
			);
		}
	};
	const flagged = async (account: string): Promise<boolean> =>
		((await fx.db.query(`SELECT 1 FROM trade_concentration WHERE account = $1`, [account]))
			.rowCount ?? 0) > 0;

	const ACTIVE = new Date(Date.parse(CONSENSUS_V2_ACTIVATION_TIME) + 5 * 86_400_000);
	const BEFORE = new Date(Date.parse(CONSENSUS_V2_ACTIVATION_TIME) - 86_400_000);
	const daysBefore = (t: Date, d: number) => new Date(t.getTime() - d * 86_400_000).toISOString();

	it('from activation: trades completed long ago are outside the window, however recently re-checked', async () => {
		await trades('kim', 'lou', daysBefore(ACTIVE, 90), daysBefore(ACTIVE, 1));
		await detectTradeConcentration(fx.db, { asOf: ACTIVE });
		expect(await flagged('lou')).toBe(false);
	});

	it('from activation: trades completed inside the window count, whatever their last change', async () => {
		await trades('max', 'ned', daysBefore(ACTIVE, 3), daysBefore(ACTIVE, 3));
		await detectTradeConcentration(fx.db, { asOf: ACTIVE });
		expect(await flagged('ned')).toBe(true);
	});

	it('before activation: the window reads updated_at, as it always did', async () => {
		await trades('oli', 'pat', daysBefore(BEFORE, 90), daysBefore(BEFORE, 1));
		await detectTradeConcentration(fx.db, { asOf: BEFORE });
		expect(await flagged('pat')).toBe(true);
		expect(tradeWindowColumn(BEFORE)).toBe('o.updated_at');
		expect(tradeWindowColumn(ACTIVE)).toBe('o.completed_at');
		expect(tradeWindowColumn(new Date(CONSENSUS_V2_ACTIVATION_TIME))).toBe('o.completed_at');
	});
});
