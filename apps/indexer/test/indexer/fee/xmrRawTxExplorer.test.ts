/**
 * v1.20.0 (wave 4) — a 'raw-tx' explorer (moneroblocks.info API) in the XMR
 * verifier's quorum. Response shapes are moneroblocks.info's, as fetched on
 * 2026-09-28: get_transaction_data → {status:'OK', transaction_data:{…}} or
 * {status:'ERROR', error:'Transaction not found', …}; get_block_data/<h> →
 * {status:'OK', block_data:{result:{block_header:{height, depth, …},
 * tx_hashes:[…]}}}; the tx page /tx/<hash> links /block/<height>. The
 * transactions are the PyPI-`monero`-built vectors of xmrRawTx.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MoneroProofFeeVerifier, parseXmrExplorer } from '$indexer/fee/moneroProofVerifier';
import type { FeeClaim } from '$indexer/fee/verifier';
import { parseXmrAddress, xmrFeePaymentId } from '@morphit/release-schema';

const V = JSON.parse(
	readFileSync(resolve(__dirname, '../../fixtures/xmr-rawtx-vectors.json'), 'utf8')
);
const byName = (n: string) => V.vectors.find((v: { name: string }) => v.name === n);
const RAW = 'raw-tx+https://moneroblocks.info';
const FEE = 781_250_000n;

type Route = (url: string) => { status?: number; json?: unknown; text?: string } | undefined;
function fetcher(route: Route) {
	const urls: string[] = [];
	const f = (async (input: Parameters<typeof fetch>[0]) => {
		const url = String(input);
		urls.push(url);
		const r = route(url);
		if (r === undefined) throw new Error(`unrouted ${url}`);
		const status = r.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => r.json,
			text: async () => r.text ?? JSON.stringify(r.json)
		} as unknown as Response;
	}) as typeof fetch;
	return { f, urls };
}

/** moneroblocks.info serving vector `v`, mined at height 100, depth `depth`. */
function moneroblocks(
	v: { tx: unknown; txid: string },
	o: { depth?: number; blockLink?: boolean; inBlock?: boolean; tx?: unknown } = {}
): Route {
	return (url) => {
		if (url === `https://moneroblocks.info/api/get_transaction_data/${v.txid}`) {
			return { json: { status: 'OK', transaction_data: o.tx ?? v.tx } };
		}
		if (url.startsWith('https://moneroblocks.info/api/get_transaction_data/')) {
			return {
				json: { status: 'ERROR', error: 'Transaction not found', method: 'get_transaction_data' }
			};
		}
		if (url === `https://moneroblocks.info/tx/${v.txid}`) {
			return {
				text: `<html><dt>Confirmations</dt><dd>${(o.depth ?? 4) + 1}</dd>${
					o.blockLink === false ? '' : '<dt>From Block</dt><dd><a href="/block/100">100</a></dd>'
				}</html>`
			};
		}
		if (url === 'https://moneroblocks.info/api/get_block_data/100') {
			return {
				json: {
					status: 'OK',
					block_data: {
						result: {
							block_header: { height: 100, depth: o.depth ?? 4 },
							tx_hashes: o.inBlock === false ? ['ab'.repeat(32)] : ['cd'.repeat(32), v.txid]
						}
					}
				}
			};
		}
		return undefined;
	};
}

const cfg = (explorerUrls: string[], feeAddress: string, min = 1) => ({
	feeAddress,
	explorerUrls,
	minConfirmations: 1,
	requestTimeoutMs: 2_000,
	minSuccessfulResponses: min
});
function claim(v: { txid: string; tx_key: string }, o: Partial<FeeClaim> = {}): FeeClaim {
	return {
		feeMethod: 'xmr',
		expectedAmount: FEE,
		externalTxId: v.txid,
		txProof: null,
		txKey: v.tx_key,
		permlink: 'p',
		signer: 's',
		xmrBinding: null,
		...o
	};
}
const bindingFor = (account: string, permlink: string) => {
	const p = parseXmrAddress(V.treasury.primary);
	if (!p.ok) throw new Error('bad');
	return {
		primaryAddress: V.treasury.primary,
		viewPub: p.value.viewPub,
		paymentId: xmrFeePaymentId(account, permlink)
	};
};

describe('raw-tx explorer kind', () => {
	it('parses the explorer list: https = txprove, raw-tx+https = raw-tx, nothing else', () => {
		expect(parseXmrExplorer('https://xmrchain.net/')).toEqual({
			kind: 'txprove',
			base: 'https://xmrchain.net'
		});
		expect(parseXmrExplorer(RAW)).toEqual({ kind: 'raw-tx', base: 'https://moneroblocks.info' });
		expect(parseXmrExplorer('raw-tx+http://x.example')).toBeNull();
		expect(parseXmrExplorer('http://x.example')).toBeNull();
	});

	it('verifies an unbound payment to the (sub)address from the raw transaction alone', async () => {
		const v = byName('subaddress+change');
		const { f, urls } = fetcher(moneroblocks(v));
		const r = await new MoneroProofFeeVerifier(cfg([RAW], V.treasury.subaddress), f).verify(
			claim(v)
		);
		expect(r).toEqual({ kind: 'verified', observedAmount: FEE });
		// the tx key never goes to a raw-tx explorer: it is used HERE
		expect(urls.some((u) => u.includes(v.tx_key))).toBe(false);
	});

	it('bound: verified for the order whose payment ID the transaction carries, refused for another', async () => {
		const v = byName('integrated-primary+change');
		const { f } = fetcher(moneroblocks(v));
		const ver = new MoneroProofFeeVerifier(cfg([RAW], V.treasury.subaddress), f);
		expect(
			await ver.verify(claim(v, { xmrBinding: bindingFor('alice', 'order-kx2mq7p4n8za') }))
		).toEqual({
			kind: 'verified',
			observedAmount: FEE
		});
		expect(await ver.verify(claim(v, { xmrBinding: bindingFor('mallory', 'steal') }))).toEqual({
			kind: 'rejected',
			reason: 'payment_id_mismatch'
		});
	});

	it('counts as an independent answer in the quorum, next to a txprove explorer', async () => {
		const v = byName('subaddress+change');
		const txprove =
			(amount: number): Route =>
			(url) =>
				url.startsWith('https://xmrchain.net/api/outputs')
					? {
							json: {
								status: 'success',
								data: { tx_hash: v.txid, outputs: [{ amount, match: true }], tx_confirmations: 7 }
							}
						}
					: undefined;
		const both =
			(a: Route, b: Route): Route =>
			(u) =>
				a(u) ?? b(u);
		const agree = fetcher(both(txprove(781_250_000), moneroblocks(v)));
		expect(
			await new MoneroProofFeeVerifier(
				cfg(['https://xmrchain.net', RAW], V.treasury.subaddress, 2),
				agree.f
			).verify(claim(v))
		).toEqual({ kind: 'verified', observedAmount: FEE });
		// a txprove explorer claiming more than the chain commitment opens: no quorum of 2
		const lie = fetcher(both(txprove(999_999_999_999), moneroblocks(v)));
		expect(
			(
				await new MoneroProofFeeVerifier(
					cfg(['https://xmrchain.net', RAW], V.treasury.subaddress, 2),
					lie.f
				).verify(claim(v))
			).kind
		).toBe('pending_external');
	});

	it('refuses content that does not hash to the txid (an explorer serving another transaction)', async () => {
		const v = byName('subaddress+change');
		const other = byName('two-outputs-same-primary+change');
		const { f } = fetcher(moneroblocks(v, { tx: other.tx }));
		expect(
			(await new MoneroProofFeeVerifier(cfg([RAW], V.treasury.subaddress), f).verify(claim(v))).kind
		).toBe('pending_external');
	});

	it('depth comes from the block JSON: unconfirmed without a block link, unknown when the block does not list the tx', async () => {
		const v = byName('subaddress+change');
		const pool = fetcher(moneroblocks(v, { blockLink: false, depth: -1 }));
		expect(
			await new MoneroProofFeeVerifier(cfg([RAW], V.treasury.subaddress), pool.f).verify(claim(v))
		).toMatchObject({
			kind: 'pending_external',
			reason: expect.stringContaining('0 confirmations')
		});
		const wrong = fetcher(moneroblocks(v, { inBlock: false }));
		expect(
			await new MoneroProofFeeVerifier(cfg([RAW], V.treasury.subaddress), wrong.f).verify(claim(v))
		).toMatchObject({
			kind: 'pending_external',
			reason: expect.stringContaining('confirmations unknown')
		});
	});

	it('a quorum of "Transaction not found" is a definitive miss', async () => {
		const v = byName('subaddress+change');
		const { f } = fetcher(moneroblocks(v));
		expect(
			await new MoneroProofFeeVerifier(cfg([RAW], V.treasury.subaddress), f).verify(
				claim({ ...v, txid: 'ee'.repeat(32) })
			)
		).toMatchObject({
			kind: 'rejected',
			reason: expect.stringContaining('tx_not_found')
		});
	});

	it("the payer's key proves nothing for a payment to another address", async () => {
		const v = byName('subaddress+change');
		const { f } = fetcher(moneroblocks(v));
		expect(
			await new MoneroProofFeeVerifier(cfg([RAW], V.treasury.primary), f).verify(claim(v))
		).toEqual({
			kind: 'rejected',
			reason: 'tx_key_did_not_prove_any_match'
		});
	});
});
