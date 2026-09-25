/**
 * v1.18.0 deep-deep, H1 — free "verified" listings through BTC fee attestation.
 *
 * The chain the red team reproduced (rv6 A1): post a BTC order with a random
 * txid, every explorer answers 404, the verifier called that "no usable
 * answer" and the order landed as `pending_external`; then the POSTER plus one
 * aged sock attested it and it flipped to `verified_by_attestation` — a live,
 * public, "fee-paid" listing for nothing, repeatable forever with the same two
 * accounts. Nothing ever re-checked a pending or attested order afterwards.
 *
 * These cases run the real order handler, the real fee-attest handler, the real
 * Bitcoin explorer verifier and the real re-check job against real Postgres.
 * Only the explorer HTTP responses are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import feeAttestHandler from '../../src/indexer/handlers/feeAttest';
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
const SATS = 416;
const NOW = new Date('2026-09-24T12:00:00Z');
const OLD = new Date(NOW.getTime() - 31 * 86400_000);

type ExplorerMode = { kind: 'paid'; sats: number } | { kind: '404' } | { kind: '500' };

/** Explorer stub. `modes` maps txid → how BOTH explorers answer; unknown → 404. */
function explorerFetch(modes: Record<string, ExplorerMode>): typeof fetch {
	return (async (url: string) => {
		const txid = String(url).split('/tx/')[1] ?? '';
		const m = modes[txid] ?? { kind: '404' };
		if (m.kind === '404') return new Response('not found', { status: 404 });
		if (m.kind === '500') return new Response('down', { status: 503 });
		return new Response(
			JSON.stringify({
				txid,
				vout: [{ value: m.sats, scriptpubkey_address: FEE_ADDR }],
				status: { confirmed: true, block_height: 900000 }
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	}) as unknown as typeof fetch;
}

function btcVerifier(modes: Record<string, ExplorerMode>, minOk = 1): BitcoinExplorerFeeVerifier {
	return new BitcoinExplorerFeeVerifier(
		{
			feeAddress: FEE_ADDR,
			explorerUrls: ['https://blockstream.info/api', 'https://mempool.space/api'],
			minConfirmations: 1,
			requestTimeoutMs: 2000,
			minSuccessfulResponses: minOk
		},
		explorerFetch(modes)
	);
}

function btcOrder(permlink: string, txid: string) {
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
		external_tx_id: txid
	};
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'H1 — BTC fee attestation cannot mint free verified listings',
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
			for (const n of ['mallory', 'sock1', 'sock2', 'alice', 'bob', 'carol']) {
				await fx.db.query(
					`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id)
				 VALUES ($1, 'relay', 1, $2, 'x') ON CONFLICT DO NOTHING`,
					[n, OLD]
				);
			}
		});

		async function post(
			signer: string,
			permlink: string,
			txid: string,
			v: BitcoinExplorerFeeVerifier
		) {
			return fx.db.withTx((c) =>
				orderHandler(
					makeCtx({
						signer,
						blockTime: NOW,
						payload: btcOrder(permlink, txid),
						feeVerifiers: { btc: v },
						feeAmounts: { btcSatoshis: SATS }
					}),
					c
				)
			);
		}
		async function attest(attestor: string, account: string, permlink: string) {
			return fx.db.withTx((c) =>
				feeAttestHandler(
					makeCtx({
						signer: attestor,
						blockTime: NOW,
						trxId: `${attestor}-${permlink}`.padEnd(40, '0').slice(0, 40),
						payload: { order_account: account, order_permlink: permlink },
						config: { ...makeCtx().config, attestationPhase: 'launch' }
					}),
					c
				)
			);
		}
		async function feeStatus(permlink: string): Promise<string> {
			const r = await fx.db.query<{ fee_status: string }>(
				`SELECT fee_status FROM orders WHERE permlink = $1`,
				[permlink]
			);
			return r.rows[0]!.fee_status;
		}

		it('a txid every explorer answers 404 for is missing, not pending_external', async () => {
			expect(await post('mallory', 'sell-btc-fake', 'ab'.repeat(32), btcVerifier({}))).toEqual({
				ok: true
			});
			expect(await feeStatus('sell-btc-fake')).toBe('missing');
			// ...so the attestation path can never reach it.
			await attest('sock1', 'mallory', 'sell-btc-fake');
			await attest('sock2', 'mallory', 'sell-btc-fake');
			expect(await feeStatus('sell-btc-fake')).toBe('missing');
		});

		it('a 404 below the quorum (other explorer down) stays pending, never missing', async () => {
			const txid = 'cd'.repeat(32);
			// minSuccessfulResponses=2: one 404 is not a definitive "not found".
			let n = 0;
			const mixed = new BitcoinExplorerFeeVerifier(
				{
					feeAddress: FEE_ADDR,
					explorerUrls: ['https://blockstream.info/api', 'https://mempool.space/api'],
					minConfirmations: 1,
					requestTimeoutMs: 2000,
					minSuccessfulResponses: 2
				},
				(async () =>
					n++ % 2 === 0
						? new Response('nf', { status: 404 })
						: new Response('down', { status: 503 })) as unknown as typeof fetch
			);
			await post('alice', 'sell-btc-mixed', txid, mixed);
			expect(await feeStatus('sell-btc-mixed')).toBe('pending_external');
		});

		it('the poster can never count as an attestor', async () => {
			const txid = 'ef'.repeat(32);
			await post('mallory', 'sell-btc-down', txid, btcVerifier({ [txid]: { kind: '500' } }));
			expect(await feeStatus('sell-btc-down')).toBe('pending_external');
			const self = await attest('mallory', 'mallory', 'sell-btc-down');
			expect(self.ok).toBe(false);
			await attest('sock1', 'mallory', 'sell-btc-down');
			// poster + one other = only ONE independent attestor → still pending.
			expect(await feeStatus('sell-btc-down')).toBe('pending_external');
		});

		it('attestors flagged as related to the poster do not count', async () => {
			const txid = '12'.repeat(32);
			await post('mallory', 'sell-btc-ring', txid, btcVerifier({ [txid]: { kind: '500' } }));
			await fx.db.query(
				`INSERT INTO related_accounts (account_a, account_b, reason) VALUES ('mallory', 'sock1', 'test')`
			);
			await fx.db.query(
				`INSERT INTO suspicious_reciprocity (account_a, account_b, mutual_review_count, avg_rating)
			 VALUES ('mallory', 'sock2', 3, 5)`
			);
			await attest('sock1', 'mallory', 'sell-btc-ring');
			await attest('sock2', 'mallory', 'sell-btc-ring');
			expect(await feeStatus('sell-btc-ring')).toBe('pending_external');
			// A genuinely independent pair still works (explorer-outage fallback kept).
			await attest('alice', 'mallory', 'sell-btc-ring');
			await attest('bob', 'mallory', 'sell-btc-ring');
			expect(await feeStatus('sell-btc-ring')).toBe('verified_by_attestation');
		});

		it('re-check promotes a pending order once the explorers confirm the payment', async () => {
			const txid = '34'.repeat(32);
			await post('alice', 'sell-btc-late', txid, btcVerifier({ [txid]: { kind: '500' } }));
			expect(await feeStatus('sell-btc-late')).toBe('pending_external');
			const res = await recheckExternalFees({
				db: fx.db,
				verifiers: { btc: btcVerifier({ [txid]: { kind: 'paid', sats: SATS } }) },
				amounts: { btcSatoshis: SATS },
				now: NOW
			});
			expect(res.changed).toBe(1);
			expect(await feeStatus('sell-btc-late')).toBe('verified');
		});

		it('re-check demotes an attested order the explorers now say does not exist', async () => {
			const txid = '56'.repeat(32);
			await post('mallory', 'sell-btc-att', txid, btcVerifier({ [txid]: { kind: '500' } }));
			await attest('alice', 'mallory', 'sell-btc-att');
			await attest('bob', 'mallory', 'sell-btc-att');
			expect(await feeStatus('sell-btc-att')).toBe('verified_by_attestation');
			await recheckExternalFees({
				db: fx.db,
				verifiers: { btc: btcVerifier({}) },
				amounts: { btcSatoshis: SATS },
				now: NOW
			});
			expect(await feeStatus('sell-btc-att')).toBe('missing');
		});

		it('re-check demotes an already-indexed row attested under the old poster-counts rule', async () => {
			// Simulate a row an older indexer promoted with the poster as one of two attestors.
			const txid = '78'.repeat(32);
			await post('mallory', 'sell-btc-legacy', txid, btcVerifier({ [txid]: { kind: '500' } }));
			await fx.db.query(
				`INSERT INTO fee_attestations (order_account, order_permlink, attestor, observed_in_block)
			 VALUES ('mallory', 'sell-btc-legacy', 'mallory', 1), ('mallory', 'sell-btc-legacy', 'sock1', 1)`
			);
			await fx.db.query(
				`UPDATE orders SET fee_status = 'verified_by_attestation' WHERE permlink = 'sell-btc-legacy'`
			);
			// Explorers still unreachable: no definitive answer, so the attestation
			// quorum is re-derived under the current rule — and no longer holds.
			await recheckExternalFees({
				db: fx.db,
				verifiers: { btc: btcVerifier({ [txid]: { kind: '500' } }) },
				amounts: { btcSatoshis: SATS },
				now: NOW
			});
			expect(await feeStatus('sell-btc-legacy')).toBe('pending_external');
		});

		it('the rv6 A1 loop no longer yields any public listing', async () => {
			for (let i = 0; i < 5; i++) {
				const p = `sell-btc-free-${i}`;
				await post('mallory', p, (i + 10).toString(16).padStart(64, 'c'), btcVerifier({}));
				await attest('mallory', 'mallory', p);
				await attest('sock1', 'mallory', p);
			}
			const n = await fx.db.query<{ n: string }>(
				`SELECT COUNT(*)::text n FROM orders WHERE account='mallory' AND status='live'
			   AND fee_status IN ('verified','verified_by_attestation')`
			);
			expect(Number(n.rows[0]!.n)).toBe(0);
		});
	}
);
