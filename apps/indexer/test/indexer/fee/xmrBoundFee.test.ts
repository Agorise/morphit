/**
 * v1.20.0 (MK-H2) — BOUND XMR fees: the explorer must prove the amount with
 * the payer's tx key AND the transaction's encrypted payment ID must decrypt
 * (with that same key) to the ID of THIS order.
 *
 * Explorer bodies follow onion-monero-blockchain-explorer's JSON API
 * (src/page.h): json_outputs → {status, data: {outputs[{amount, match,
 * output_idx, output_pubkey}], tx_hash, tx_confirmations}}; json_transaction
 * → {status, data: {tx_hash, extra, payment_id8, confirmations, …}} where
 * payment_id8 is the RAW (still encrypted) 8-byte nonce from tx extra
 * (get_payment_id → get_encrypted_payment_id_from_tx_extra_nonce) and extra is
 * the hex of tx.extra (get_extra_str).
 * Crypto vectors: PyPI `monero` 1.1.1 (see test/lib/xmrAddress.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';

import { MoneroProofFeeVerifier } from '$indexer/fee/moneroProofVerifier';
import type { FeeClaim } from '$indexer/fee/verifier';
import { parseXmrAddress, xmrFeePaymentId } from '@morphit/release-schema';

const PRIMARY =
	'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
const TXKEY = 'e5b4fe26ae0a3a2f7d2bbed8a0c2a1c6d66925ccdbcb6bcef67a0ad66a9b9807';
const ENC = 'e75f39371458536e';
const EXTRA =
	'01795b5d51f7d7ed6459559babccb0cc4943a56c79f58a90e9b250246fe749b1b5020901e75f39371458536e';
const OTHER_ENC = '21ef5479a14c4508';
const TXID = 'c'.repeat(64);
const VIEW = (() => {
	const p = parseXmrAddress(PRIMARY);
	if (!p.ok) throw new Error('bad vector');
	return p.value.viewPub;
})();

function claim(o: Partial<FeeClaim> = {}): FeeClaim {
	return {
		feeMethod: 'xmr',
		expectedAmount: 1_000_000_000n,
		externalTxId: TXID,
		txProof: null,
		txKey: TXKEY,
		permlink: 'order-kx2mq7p4n8za',
		signer: 'alice',
		xmrBinding: {
			primaryAddress: PRIMARY,
			viewPub: VIEW,
			paymentId: xmrFeePaymentId('alice', 'order-kx2mq7p4n8za')
		},
		...o
	};
}

function explorer(
	tx: { payment_id8?: string; extra?: string; status?: string },
	amount = 1_000_000_000
) {
	const urls: string[] = [];
	const f = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
		const url = typeof input === 'string' ? input : input.toString();
		urls.push(url);
		if (url.includes('/api/outputs')) {
			return new Response(
				JSON.stringify({
					status: 'success',
					data: {
						tx_hash: TXID,
						outputs: [
							{ output_pubkey: 'aa'.repeat(32), amount, match: true, output_idx: 0 },
							{ output_pubkey: 'bb'.repeat(32), amount: 0, match: false, output_idx: 1 }
						],
						tx_confirmations: 3,
						tx_prove: true
					}
				}),
				{ status: 200 }
			);
		}
		if (url.includes(`/api/transaction/${TXID}`)) {
			return new Response(
				JSON.stringify({
					status: tx.status ?? 'success',
					data: {
						tx_hash: TXID,
						payment_id: '',
						payment_id8: tx.payment_id8 ?? '',
						extra: tx.extra ?? '',
						confirmations: 3
					}
				}),
				{ status: 200 }
			);
		}
		throw new Error(`unmocked ${url}`);
	}) as unknown as typeof fetch;
	return { f, urls };
}

const cfg = {
	feeAddress:
		'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe',
	explorerUrls: ['https://xmrchain.net'],
	minConfirmations: 1,
	requestTimeoutMs: 2_000,
	minSuccessfulResponses: 1
};

describe('bound XMR fee verification', () => {
	it("verifies when the payment ID decrypts to this order's ID, proving the amount at the PRIMARY address", async () => {
		const { f, urls } = explorer({ payment_id8: ENC, extra: EXTRA });
		const v = new MoneroProofFeeVerifier(cfg, f);
		expect(await v.verify(claim())).toEqual({ kind: 'verified', observedAmount: 1_000_000_000n });
		const outputs = urls.find((u) => u.includes('/api/outputs'))!;
		expect(outputs).toContain(`address=${PRIMARY}`);
		expect(outputs).toContain(`viewkey=${TXKEY}`);
		expect(outputs).toContain('txprove=1');
	});

	it('refuses a payment whose ID belongs to another order (a copied txid + key)', async () => {
		const v = new MoneroProofFeeVerifier(cfg, explorer({ payment_id8: ENC, extra: EXTRA }).f);
		const r = await v.verify(
			claim({
				signer: 'mallory',
				xmrBinding: {
					primaryAddress: PRIMARY,
					viewPub: VIEW,
					paymentId: xmrFeePaymentId('mallory', 'order-kx2mq7p4n8za')
				}
			})
		);
		expect(r).toEqual({ kind: 'rejected', reason: 'payment_id_mismatch' });
	});

	it('refuses a payment with a different (or no) payment ID', async () => {
		const other = new MoneroProofFeeVerifier(
			cfg,
			explorer({ payment_id8: OTHER_ENC, extra: '020901' + OTHER_ENC }).f
		);
		expect(await other.verify(claim())).toEqual({
			kind: 'rejected',
			reason: 'payment_id_mismatch'
		});
		const none = new MoneroProofFeeVerifier(cfg, explorer({ payment_id8: '' }).f);
		expect(await none.verify(claim())).toEqual({ kind: 'rejected', reason: 'payment_id_mismatch' });
	});

	it("gives no verdict when the explorer's payment_id8 is not in the tx extra it returns", async () => {
		const v = new MoneroProofFeeVerifier(
			cfg,
			explorer({ payment_id8: ENC, extra: '01' + 'aa'.repeat(32) }).f
		);
		expect((await v.verify(claim())).kind).toBe('pending_external');
	});

	it('still checks the amount', async () => {
		const v = new MoneroProofFeeVerifier(cfg, explorer({ payment_id8: ENC, extra: EXTRA }, 10).f);
		const r = await v.verify(claim());
		expect(r.kind === 'rejected' && r.reason.startsWith('underpaid')).toBe(true);
	});

	it('unbound claims (no pin) never fetch the transaction and prove at the pinned fee address', async () => {
		const { f, urls } = explorer({});
		const v = new MoneroProofFeeVerifier(cfg, f);
		expect((await v.verify(claim({ xmrBinding: null }))).kind).toBe('verified');
		expect(urls.some((u) => u.includes('/api/transaction/'))).toBe(false);
		expect(urls[0]).toContain(`address=${cfg.feeAddress}`);
	});
});
