/**
 * no request and no indexing step waits on a block explorer.
 *
 * Explorers are now reached over Tor, where one answer takes 5–40 s. Two
 * places waited for them:
 *   - POST /v1/orders/:account/:permlink/check-fee ran the explorer quorum
 *     inside the request ("I've paid — check now" hung for as long as the
 *     slowest explorer);
 *   - the poller AWAITED the fee re-check pass in its loop, so a slow explorer
 *     round held up indexing the next block.
 * Both are driven here with an explorer that never answers.
 */
import { describe, expect, it } from 'vitest';

import { feeCheckRoute } from '$api/feeCheck';
import { ExternalFeeRechecker } from '$indexer/fee/externalFeeRecheck';
import type { Database } from '$db/pool';
import type { FeeVerifier } from '$indexer/fee/verifier';

const NEVER = new Promise<never>(() => undefined);

/** An explorer-backed verifier whose explorers never answer. */
const hanging: FeeVerifier = {
	name: 'btc-explorer',
	verify: () => NEVER,
	checkAddressPayment: () => NEVER
};

/** A database holding one live order awaiting its BTC fee address payment
 *  and one pending txid order; it answers the queries the two paths make. */
function db(): Database {
	const row = {
		account: 'alice',
		permlink: 'order-abc',
		fee_status: 'awaiting_payment',
		btc_fee_address: 'bc1qexample',
		btc_fee_sats: '1000',
		btc_fee_received_sats: null,
		btc_fee_unconfirmed_sats: null,
		rechecked: null,
		r: null,
		u: null
	};
	const pending = {
		account: 'bob',
		permlink: 'order-def',
		fee_status: 'pending_external',
		fee_method: 'btc',
		external_tx_id: 'b'.repeat(64),
		tx_proof: null,
		btc_fee_address: null,
		btc_fee_sats: null,
		btc_fee_received_sats: null,
		btc_fee_unconfirmed_sats: null,
		created_at: new Date(Date.now() - 60_000)
	};
	return {
		query: async (text: string) => {
			if (/^\s*UPDATE/i.test(text)) return { rows: [], rowCount: 1 };
			if (/WITH cand AS/.test(text)) return { rows: [pending], rowCount: 1 };
			return { rows: [row], rowCount: 1 };
		}
	} as unknown as Database;
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> =>
	Promise.race([p, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))]);

describe('no request or indexing step waits on an explorer', () => {
	it('"check my payment now" answers at once; the explorer look runs in the background', async () => {
		const app = feeCheckRoute({
			db: db(),
			current: () => ({ verifiers: { btc: hanging }, amounts: { btcSatoshis: 1000 } }),
			onChange: () => {}
		});
		const res = await within(
			Promise.resolve(app.request('/alice/order-abc/check-fee', { method: 'POST' })),
			1500
		);
		expect(res, 'the request waited for the explorers').not.toBe('still waiting');
		const r = res as Response;
		expect(r.status).toBe(200);
		expect(await r.json()).toMatchObject({
			fee_status: 'awaiting_payment',
			checked: false,
			queued: true
		});
	});

	it('the poller step that runs the fee re-check pass returns while the explorers are still silent', async () => {
		const rechecker = new ExternalFeeRechecker(
			db(),
			() => ({ verifiers: { btc: hanging }, amounts: { btcSatoshis: 416 } }),
			() => {}
		);
		expect(await within(rechecker.maybeRun(), 1500)).not.toBe('still waiting');
		// And a second call while the first pass is still out does not start another.
		expect(rechecker.running()).toBe(true);
		expect(await within(rechecker.maybeRun(), 1500)).not.toBe('still waiting');
	});
});
