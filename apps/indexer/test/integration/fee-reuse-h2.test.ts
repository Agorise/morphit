/**
 * (mitigation) — a reused BTC/XMR fee txid must be
 * RECORDED, visibly, as `reused`.
 *
 * rv6 A2: when a second order claimed a txid already claimed by an earlier
 * order, the handler's documented "insert the row with fee_status='reused' so
 * the user can see why" branch hit the partial UNIQUE index
 * `orders_external_tx_id_uniq (fee_method, external_tx_id)`, threw, and the
 * dispatcher logged handler_threw — the victim's order silently had no row at
 * all. Unit tests mock SQL, so the index never fired; this runs the real
 * handler against the real schema.
 *
 * The real fix (binding a BTC payment to the lister) needs a protocol change
 * and is deferred to a design discussion; this only makes the rejection
 * visible.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import { BitcoinExplorerFeeVerifier } from '../../src/indexer/fee/bitcoinExplorerVerifier';
import { recheckExternalFees } from '../../src/indexer/fee/externalFeeRecheck';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { makeCtx } from '../testutils/context';

const FEE_ADDR = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const NOW = new Date('2026-09-24T12:00:00Z');
const TXID = 'de'.repeat(32);

function verifier(): BitcoinExplorerFeeVerifier {
	return new BitcoinExplorerFeeVerifier(
		{
			feeAddress: FEE_ADDR,
			explorerUrls: ['https://blockstream.info/api'],
			minConfirmations: 1,
			requestTimeoutMs: 2000,
			minSuccessfulResponses: 1
		},
		(async (url: string) => {
			const txid = String(url).split('/tx/')[1] ?? '';
			if (txid !== TXID) return new Response('nf', { status: 404 });
			return new Response(
				JSON.stringify({
					txid,
					vout: [{ value: 416, scriptpubkey_address: FEE_ADDR }],
					status: { confirmed: true, block_height: 1 }
				}),
				{ status: 200 }
			);
		}) as unknown as typeof fetch
	);
}

function order(permlink: string) {
	return {
		permlink,
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'USD',
		amount_min: 100,
		amount_max: 1000,
		price_model: { kind: 'spread', percent: 0 },
		payment_methods: ['cash'],
		fee_method: 'btc',
		external_tx_id: TXID
	};
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'H2 — a reused fee txid is recorded as reused, not dropped',
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

		async function post(signer: string, permlink: string, at: Date) {
			return fx.db.withTx((c) =>
				orderHandler(
					makeCtx({
						signer,
						blockTime: at,
						payload: order(permlink),
						feeVerifiers: { btc: verifier() },
						feeAmounts: { btcSatoshis: 416 }
					}),
					c
				)
			);
		}

		it("the second claimant's order is written with fee_status='reused' and stays off the book", async () => {
			expect(await post('mallory', 'sell-btc-first', NOW)).toEqual({ ok: true });
			// Must not throw (it used to: orders_external_tx_id_uniq).
			expect(await post('victim', 'sell-btc-mine', new Date(NOW.getTime() + 60_000))).toEqual({
				ok: true
			});
			// The fee is verified by the re-check job, outside the block.
			await recheckExternalFees({
				db: fx.db,
				verifiers: { btc: verifier() },
				amounts: { btcSatoshis: 416 },
				now: new Date(NOW.getTime() + 120_000)
			});
			const rows = await fx.db.query<{ account: string; fee_status: string; status: string }>(
				`SELECT account, fee_status, status FROM orders ORDER BY account`
			);
			expect(rows.rows.map((r) => [r.account, r.fee_status])).toEqual([
				['mallory', 'verified'],
				['victim', 'reused']
			]);
			const visible = await fx.db.query(
				`SELECT 1 FROM orders WHERE account = 'victim'
			   AND fee_status IN ('verified', 'verified_by_attestation')`
			);
			expect(visible.rowCount).toBe(0);
		});

		it('replaying the reused op is idempotent (no throw, still one row)', async () => {
			await post('mallory', 'sell-btc-first', NOW);
			await post('victim', 'sell-btc-mine', NOW);
			expect(await post('victim', 'sell-btc-mine', NOW)).toEqual({ ok: true });
			const n = await fx.db.query<{ n: string }>(
				`SELECT COUNT(*)::text n FROM orders WHERE account = 'victim'`
			);
			expect(n.rows[0]!.n).toBe('1');
		});

		it('a third claimant is also recorded as reused', async () => {
			await post('mallory', 'sell-btc-first', NOW);
			await post('victim', 'sell-btc-mine', NOW);
			expect(await post('carol', 'sell-btc-too', NOW)).toEqual({ ok: true });
			const r = await fx.db.query<{ fee_status: string }>(
				`SELECT fee_status FROM orders WHERE account = 'carol'`
			);
			expect(r.rows[0]!.fee_status).toBe('reused');
		});
	}
);
