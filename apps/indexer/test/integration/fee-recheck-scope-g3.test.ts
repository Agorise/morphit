/**
 * which rows the BTC/XMR fee re-check visits (real SQL).
 *
 * Expired orders stay status='live' (expiry is enforced at read time), and a
 * `pending_external` row was re-checked for as long as it existed. Both made the
 * candidate set grow without bound, feeding the starvation described in
 * test/indexer/fee/externalFeeRecheck.test.ts. Now: expired rows are skipped,
 * pending rows are re-checked for PENDING_RECHECK_DAYS, attested rows stay in
 * the rotation until they expire. Real handler + real re-check SQL + Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import { recheckExternalFees } from '../../src/indexer/fee/externalFeeRecheck';
import type { FeeVerifier } from '../../src/indexer/fee/verifier';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

const NOW = new Date('2026-09-27T12:00:00Z');
const DAY = 86_400_000;

describe.skipIf(!INTEGRATION_ENABLED)('G3 — re-check candidate scope', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		if (fx) await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
	});

	const pending: FeeVerifier = {
		name: 'stub',
		verify: async () => ({ kind: 'pending_external', reason: 'explorers down' })
	};

	async function post(permlink: string, txidByte: string) {
		const r = await fx.db.withTx((c) =>
			orderHandler(
				makeCtx({
					signer: 'alice',
					blockTime: NOW,
					payload: {
						permlink,
						side: 'sell',
						asset: 'BTC',
						fiat_currency: 'USD',
						amount_min: 100,
						amount_max: 1000,
						price_model: { kind: 'spread', percent: 0 },
						payment_methods: ['cash'],
						fee_method: 'btc',
						external_tx_id: txidByte.repeat(32)
					},
					feeVerifiers: { btc: pending },
					feeAmounts: { btcSatoshis: 416 }
				}),
				c
			)
		);
		expect(r).toEqual({ ok: true });
	}

	async function visited(): Promise<string[]> {
		const seen: string[] = [];
		const spy: FeeVerifier = {
			name: 'spy',
			verify: async (c) => {
				seen.push(c.permlink);
				return { kind: 'pending_external', reason: 'explorers down' };
			}
		};
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: spy },
			amounts: { btcSatoshis: 416 },
			now: NOW
		});
		return seen.sort();
	}

	it('skips expired rows and stale pending rows; keeps fresh pending and attested rows', async () => {
		await post('fresh-pending', '11');
		await post('expired-pending', '22');
		await post('stale-pending', '33');
		await post('old-attested', '44');
		await fx.db.query(`UPDATE orders SET expires_at = $1 WHERE permlink = 'expired-pending'`, [
			new Date(NOW.getTime() - DAY)
		]);
		await fx.db.query(`UPDATE orders SET created_at = $1 WHERE permlink = 'stale-pending'`, [
			new Date(NOW.getTime() - 30 * DAY)
		]);
		await fx.db.query(
			`UPDATE orders SET created_at = $1, fee_status = 'verified_by_attestation' WHERE permlink = 'old-attested'`,
			[new Date(NOW.getTime() - 30 * DAY)]
		);
		expect(await visited()).toEqual(['fresh-pending', 'old-attested']);
	});
});
