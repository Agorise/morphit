/**
 * v1.20.0 (MK-H2) — a bound XMR fee is paid for one (account, permlink): the
 * order must be posted under exactly those, or the payment counts for nothing.
 */
import { describe, expect, it, vi } from 'vitest';

const sent: { payload: Record<string, unknown>; account: string }[] = [];
vi.mock('$blurt/ops/profile', async () => {
	class BroadcastError extends Error {
		constructor(
			public readonly code: string,
			message: string
		) {
			super(message);
		}
	}
	return { getUserBlurtAccount: () => 'alice', BroadcastError };
});
vi.mock('../accountBinding', () => ({
	resolveBroadcastAccount: async () => signer,
	assertKeyControlsAccount: async () => undefined
}));
vi.mock('$blurt/sign', () => ({
	broadcastCustomJson: async (
		_live: unknown,
		_id: string,
		payload: Record<string, unknown>,
		account: string
	) => {
		sent.push({ payload, account });
		return { block_num: 1, trx_id: 't' };
	}
}));
let signer = 'alice';

import { broadcastNewOrder } from './order';

const input = {
	side: 'sell' as const,
	asset: 'BTC' as const,
	fiatCurrency: 'USD',
	amountMin: null,
	amountMax: null,
	priceModel: {},
	locationRegion: null,
	paymentMethods: ['cash'],
	terms: null,
	expiresAt: null,
	feeMethod: 'xmr' as const,
	externalTxId: 'a'.repeat(64),
	txKey: 'b'.repeat(64),
	permlink: 'order-prechosen1',
	xmrBoundAccount: 'alice'
};
const live = {} as Parameters<typeof broadcastNewOrder>[0];

describe('broadcastNewOrder with a bound XMR fee', () => {
	it('posts under the permlink the fee was paid for', async () => {
		signer = 'alice';
		sent.length = 0;
		const r = await broadcastNewOrder(live, null, input, 0, 0);
		expect(r.permlink).toBe('order-prechosen1');
		expect(sent[0]!.payload).toMatchObject({
			permlink: 'order-prechosen1',
			tx_key: 'b'.repeat(64)
		});
	});
	it('refuses to post when the signing key belongs to another account', async () => {
		signer = 'bob';
		sent.length = 0;
		await expect(broadcastNewOrder(live, null, input, 0, 0)).rejects.toThrow(/paid for @alice/);
		expect(sent).toHaveLength(0);
	});
	it('refuses a malformed pre-chosen permlink', async () => {
		signer = 'alice';
		await expect(
			broadcastNewOrder(live, null, { ...input, permlink: 'Bad Permlink' }, 0, 0)
		).rejects.toThrow();
	});
});
