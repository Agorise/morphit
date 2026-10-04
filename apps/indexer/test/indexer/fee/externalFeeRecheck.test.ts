/**
 * Unit tests for the BTC/XMR fee re-check.
 *
 * The G3 fairness guarantees (no starvation under a steady flood or a burst of
 * fake orders; per-account share; persisted last-checked time) are SQL, so
 * they are tested against real Postgres in
 * test/integration/fee-recheck-flood-g3.test.ts and fee-recheck-scope-g3.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { FeeVerifier } from '$indexer/fee/verifier';
import type { Database } from '$db/pool';

/**
 * the re-check must accept a payment that was correct
 * for the treasury pin in force when the order was POSTED. It used to verify
 * against today's pin only: a payer who paid the exact quoted amount, whose
 * order was still pending when BTC fell ~18% and the maintainer re-pinned a
 * higher satoshi amount, was flipped to `underpaid`.
 */
describe('recheckExternalFees — pin in force at posting time (G9)', () => {
	it('verifies against the lower of the posting-time pin and the current pin', async () => {
		const { recheckExternalFees } = await import('$indexer/fee/externalFeeRecheck');
		const seen: Array<number | bigint> = [];
		const btc: FeeVerifier = {
			name: 'b',
			verify: async (c) => {
				seen.push(c.expectedAmount);
				return { kind: 'pending_external', reason: 'x' };
			}
		};
		const db = {
			query: async (text: string) => {
				if (text.includes('SELECT account')) {
					return {
						rows: [
							{
								account: 'alice',
								permlink: 'p',
								fee_status: 'pending_external',
								fee_method: 'btc',
								external_tx_id: 'ab'.repeat(32),
								tx_proof: null,
								created_at: new Date('2026-09-27T10:00:00Z'),
								pin_at_post: { btc: { address: 'bc1q', satoshis: 417 }, xmr: null }
							}
						],
						rowCount: 1
					};
				}
				return { rows: [{ n: '0' }], rowCount: 1 };
			}
		} as unknown as Database;
		await recheckExternalFees({
			db,
			verifiers: { btc },
			amounts: { btcSatoshis: 520 },
			now: new Date('2026-09-27T12:00:00Z')
		});
		expect(seen).toEqual([417]);
	});
});
