/**
 * an EXPIRED order must not count toward the Sybil fee
 * tier.
 *
 * Nothing ever writes status='expired' (expiry is enforced at read time from
 * expires_at), so the tier query `status = 'live' OR created_at >= cutoff`
 * counted every order that simply ran out as "live" forever. A user whose 12
 * old orders all expired — none visible anywhere — was charged 16.09× for the
 * next listing, and 1.5× more for every further expired order. Runs the real
 * order handler (and so the real tier SQL) against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

const DAY = 86_400_000;
const NOW = new Date('2026-09-27T12:00:00Z');
const BASE = 62.5;

function order(permlink: string, expiresAt: Date | null) {
	return {
		permlink,
		side: 'sell',
		asset: 'BLURT',
		fiat_currency: 'USD',
		amount_min: 10,
		amount_max: 20,
		price_model: { kind: 'spread', percent: 0 },
		payment_methods: ['cash'],
		...(expiresAt ? { expires_at: expiresAt.toISOString() } : {})
	};
}

function feeOp(signer: string, permlink: string, blurt: number) {
	return [
		'transfer',
		{
			from: signer,
			to: 'morphit-fees',
			amount: `${blurt.toFixed(3)} BLURT`,
			memo: `morphit-fee:${permlink}`
		}
	] as const;
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'G2 — expired orders do not inflate the Sybil fee tier',
	() => {
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

		async function post(permlink: string, at: Date, expiresAt: Date | null, paid: number) {
			return fx.db.withTx((c) =>
				orderHandler(
					makeCtx({
						signer: 'alice',
						blockTime: at,
						payload: order(permlink, expiresAt),
						siblingOps: [feeOp('alice', permlink, paid)] as never,
						feeAmounts: { blurtBase: BASE }
					}),
					c
				)
			);
		}
		async function status(permlink: string): Promise<string | undefined> {
			const r = await fx.db.query<{ fee_status: string }>(
				`SELECT fee_status FROM orders WHERE permlink = $1`,
				[permlink]
			);
			return r.rows[0]?.fee_status;
		}

		it('12 orders that all expired weeks ago leave the next listing at the base fee', async () => {
			for (let i = 0; i < 12; i++) {
				const at = new Date(NOW.getTime() - (60 - i) * DAY);
				// Each paid its (then correct) fee; expired 7 days after posting.
				await post(`old-${i}`, at, new Date(at.getTime() + 7 * DAY), BASE * 5);
			}
			expect(await post('fresh', NOW, new Date(NOW.getTime() + 7 * DAY), BASE)).toEqual({
				ok: true
			});
			expect(await status('fresh')).toBe('verified');
		});

		it('orders that are still live (unexpired) DO count', async () => {
			for (let i = 0; i < 3; i++) {
				const at = new Date(NOW.getTime() - (10 - i) * DAY);
				await post(`live-${i}`, at, new Date(NOW.getTime() + 30 * DAY), BASE);
			}
			// 4th order in the window → 1.25× — paying 1× is underpaid.
			await post('fourth', NOW, new Date(NOW.getTime() + 7 * DAY), BASE);
			expect(await status('fourth')).toBe('underpaid');
		});

		it('an order created in the last 24h counts even if it already expired', async () => {
			for (let i = 0; i < 3; i++) {
				const at = new Date(NOW.getTime() - (6 - i) * 3_600_000);
				await post(`recent-${i}`, at, new Date(at.getTime() + 60_000), BASE);
			}
			await post('next', NOW, new Date(NOW.getTime() + 7 * DAY), BASE);
			expect(await status('next')).toBe('underpaid');
		});
	}
);
