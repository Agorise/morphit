/**
 * v1.20.0 (G1) — a stranger-fee op names the instance it was paid through.
 *
 * The fee is verified on the RECIPIENT's instance, usually not the sender's.
 * That indexer accepts the 90 % leg to this instance's fees account only when
 * the op carries this instance's `operator_tag` (its operator registered that
 * account on chain). Without the tag the leg is ignored there and the
 * first-contact message is dropped.
 *
 * Drives the real `broadcastStrangerFee` with the chain layer mocked and
 * asserts on the custom_json payload it hands to the signer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prepared: Array<{ opId: string; payload: Record<string, unknown>; transfers: unknown }> = [];
let instanceTag: string | null = 'b-node';

vi.mock('$blurt/sign', () => ({
	prepareUnsignedOrderWithFee: vi.fn(
		async (opId: string, payload: Record<string, unknown>, _a: string, transfers: unknown) => {
			prepared.push({ opId, payload, transfers });
			return { operations: [] };
		}
	),
	broadcastSignedTransaction: vi.fn(async () => ({ block_num: 1, trx_id: 't' }))
}));
vi.mock('$blurt/ops/profile', () => ({
	getUserBlurtAccount: () => 'sam',
	BroadcastError: class extends Error {}
}));
vi.mock('$lib/stores/instance', () => ({
	getInstanceSnapshot: () => ({ operator_tag: instanceTag })
}));

const { broadcastStrangerFee } = await import('./strangerFee');

const sign = async (tx: unknown) => tx as never;

describe('broadcastStrangerFee — operator_tag', () => {
	beforeEach(() => {
		prepared.length = 0;
	});

	it("carries this instance's operator_tag", async () => {
		instanceTag = 'b-node';
		await broadcastStrangerFee({} as never, sign, 'rita', 5, 'b-fees');
		expect(prepared[0]!.payload).toEqual({
			v: 1,
			recipient: 'rita',
			amount_blurt: 5,
			operator_tag: 'b-node'
		});
		expect(prepared[0]!.transfers).toEqual([
			{ to: 'b-fees', amount: '4.500 BLURT' },
			{ to: 'morphit-fees', amount: '0.500 BLURT' }
		]);
	});

	it('omits the tag on an instance without one, or with a malformed one', async () => {
		for (const t of [null, '', 'Bad Tag!']) {
			instanceTag = t;
			await broadcastStrangerFee({} as never, sign, 'rita', 5, 'morphit-fees');
		}
		for (const p of prepared) expect('operator_tag' in p.payload).toBe(false);
	});
});
