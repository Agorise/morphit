/**
 * the 365-day `expires_at` cap is measured from the op's BLOCK time,
 * so a node applying an order live and a node replaying it years later reach
 * the same verdict. It used `Date.now()`: the same op was rejected live and
 * applied on replay (HO poc4, MK repro-expiry-wallclock).
 */
import { describe, expect, it } from 'vitest';
import orderHandler from '$indexer/handlers/order';
import orderReplaceHandler from '$indexer/handlers/orderReplace';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

const DAY = 86_400_000;
const order = (expiresAt: Date) => ({
	permlink: 'exp-1',
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 10,
	amount_max: 100,
	price_model: { kind: 'spread', percent: 1 },
	payment_methods: ['cash_in_person'],
	expires_at: expiresAt.toISOString()
});

describe('expires_at is capped from the block time, never the wall clock', () => {
	for (const [name, handler] of [
		['order', orderHandler],
		['orderReplace', orderReplaceHandler]
	] as const) {
		it(`${name}: 400 days after an OLD block is too far, whatever today is`, async () => {
			const blockTime = new Date(Date.now() - 730 * DAY);
			const r = await handler(
				makeCtx({ blockTime, payload: order(new Date(blockTime.getTime() + 400 * DAY)) }),
				makeMockClient().client
			);
			expect(r).toEqual({ ok: false, reason: 'expires_at_too_far_future' });
		});

		it(`${name}: 300 days after a block is within the cap, even when that is > 365 days from today`, async () => {
			const blockTime = new Date(Date.now() + 100 * DAY);
			const r = await handler(
				makeCtx({ blockTime, payload: order(new Date(blockTime.getTime() + 300 * DAY)) }),
				makeMockClient().client
			);
			expect(r.ok ? 'ok' : r.reason).not.toBe('expires_at_too_far_future');
		});
	}
});
