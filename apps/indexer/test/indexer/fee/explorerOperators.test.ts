/**
 * One explorer OPERATOR is one vote. The BTC / XMR verifiers count a quorum by
 * operator (rpc-pool EndpointPool `operatorOf` = feeSources.ts
 * explorerOperatorOf), so one operator's onion, I2P and clearnet addresses —
 * runbtc's .onion and .b32.i2p, mempool.space's onion and its clearnet site —
 * can no longer make a two-explorer quorum on their own, for the trade
 * payment check (fee/paymentCheck.ts) and the listing fee alike. A tier that
 * holds fewer operators than the quorum gives no verdict at all: never
 * `found` / `verified`, never `not_found` / `rejected`.
 *
 * All HTTP is stubbed; the Esplora answers have the shape of
 * test/indexer/fee/paymentLookup.test.ts's.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	DEFAULT_BTC_CLEARNET_EXPLORERS,
	DEFAULT_BTC_FEE_EXPLORERS,
	DEFAULT_BTC_I2P_EXPLORERS,
	DEFAULT_BTC_ONION_EXPLORERS,
	DEFAULT_XMR_FEE_EXPLORERS,
	DEFAULT_XMR_I2P_EXPLORERS,
	DEFAULT_XMR_ONION_EXPLORERS,
	EXPLORER_OPERATORS,
	explorerOperatorOf,
	isHiddenSourceUrl
} from '@morphit/operator-config/fee-sources';
import { buildPaymentChecker, type PaymentQuery } from '$indexer/fee/paymentCheck';
import { BitcoinExplorerFeeVerifier } from '$indexer/fee/bitcoinExplorerVerifier';
import { MoneroProofFeeVerifier } from '$indexer/fee/moneroProofVerifier';
import { feeVerifierTiers } from '$indexer/fee/externalFeeVerifiers';
import type { FeeClaim } from '$indexer/fee/verifier';

const [MEMPOOL_ONION, EMZY_ONION, RUNBTC_ONION, BLOCKSTREAM_ONION] =
	DEFAULT_BTC_ONION_EXPLORERS as [string, string, string, string, string];
const RUNBTC_I2P = DEFAULT_BTC_I2P_EXPLORERS[0]!;
const [BLOCKSTREAM, MEMPOOL] = DEFAULT_BTC_CLEARNET_EXPLORERS as [string, string];

const TXID = 'ab'.repeat(32);
/** A real mainnet subaddress (the XMR test vectors' treasury). */
const XMR_ADDR: string = JSON.parse(
	readFileSync(resolve(__dirname, '../../fixtures/xmr-rawtx-vectors.json'), 'utf8')
).treasury.subaddress;
const ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

type Reply = { status?: number; json?: unknown; text?: string } | 'throw';

/** Explorers at the given bases, each answering `reply` for TXID, tip 800_002. */
function explorers(replies: Readonly<Record<string, Reply>>) {
	const asked: string[] = [];
	const f = (async (input: Parameters<typeof fetch>[0]) => {
		const url = String(input);
		asked.push(url);
		for (const [base, reply] of Object.entries(replies)) {
			if (url === `${base}/tx/${TXID}`) {
				if (reply === 'throw') throw new TypeError('fetch failed');
				return new Response(reply.text ?? JSON.stringify(reply.json), {
					status: reply.status ?? 200
				});
			}
			if (url === `${base}/blocks/tip/height`) return new Response('800002');
		}
		throw new TypeError('fetch failed');
	}) as typeof fetch;
	return { f, asked };
}
const PAYS: Reply = {
	json: {
		txid: TXID,
		vin: [
			{
				txid: 'ee'.repeat(32),
				vout: 0,
				is_coinbase: false,
				prevout: { scriptpubkey_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', value: 50_000 }
			}
		],
		vout: [{ value: 25_000, scriptpubkey_address: ADDR }],
		status: { confirmed: true, block_height: 800_000, block_time: 1_790_000_000 }
	}
};
const NOT_FOUND: Reply = { status: 404, text: 'Transaction not found' };

const config = (btcExplorerUrls: string[]) => ({
	blurtRpcEndpoints: ['https://rpc.example'],
	hiddenRpcEndpoints: [] as string[],
	btcExplorerUrls,
	xmrExplorerUrls: [] as string[],
	btcMinSuccessfulResponses: 2,
	xmrMinSuccessfulResponses: 2
});
const btcQ: PaymentQuery = { asset: 'btc', txid: TXID, address: ADDR, txKey: null };

describe('explorerOperatorOf', () => {
	it('every default hidden explorer has a named operator', () => {
		for (const url of [
			...DEFAULT_BTC_ONION_EXPLORERS,
			...DEFAULT_BTC_I2P_EXPLORERS,
			...DEFAULT_XMR_ONION_EXPLORERS,
			...DEFAULT_XMR_I2P_EXPLORERS
		]) {
			expect(isHiddenSourceUrl(url)).toBe(true);
			expect(Object.values(EXPLORER_OPERATORS)).toContain(explorerOperatorOf(url));
		}
	});
	it("one operator's addresses are one operator", () => {
		expect(explorerOperatorOf(RUNBTC_ONION)).toBe('runbtc');
		expect(explorerOperatorOf(RUNBTC_I2P)).toBe('runbtc');
		expect(explorerOperatorOf(MEMPOOL_ONION)).toBe(explorerOperatorOf(MEMPOOL));
		expect(explorerOperatorOf(BLOCKSTREAM_ONION)).toBe(explorerOperatorOf(BLOCKSTREAM));
		expect(explorerOperatorOf(EMZY_ONION)).toBe(explorerOperatorOf('https://mempool.emzy.de/api'));
	});
	it('the defaults are 5 BTC and 9 XMR operators', () => {
		expect(new Set(DEFAULT_BTC_FEE_EXPLORERS.map(explorerOperatorOf)).size).toBe(5);
		expect(DEFAULT_BTC_FEE_EXPLORERS.length).toBe(8);
		expect(new Set(DEFAULT_XMR_FEE_EXPLORERS.map(explorerOperatorOf)).size).toBe(9);
	});
	it('clearnet: the last two labels, any kind prefix and the port ignored', () => {
		expect(explorerOperatorOf('node+https://node.monero.fail')).toBe('monero.fail');
		expect(explorerOperatorOf('node+https://xmr.monero.fail:18089')).toBe('monero.fail');
		expect(explorerOperatorOf('raw-tx+https://moneroblocks.info')).toBe('moneroblocks.info');
		expect(explorerOperatorOf('https://WWW.Example.COM./api')).toBe('example.com');
		expect(explorerOperatorOf('https://203.0.113.7:3000/api')).toBe('203.0.113.7');
	});
	it('an unknown hidden service is its own operator; not a URL is itself', () => {
		const onion = `http://${'q'.repeat(56)}.onion/api`;
		expect(explorerOperatorOf(onion)).toBe(`${'q'.repeat(56)}.onion`);
		expect(explorerOperatorOf(`${onion.replace('/api', '/other')}`)).toBe(
			`${'q'.repeat(56)}.onion`
		);
		expect(explorerOperatorOf('not a url')).toBe('not a url');
	});
});

describe('payment check: one operator is not a quorum', () => {
	it("runbtc's onion and I2P both finding it: unavailable", async () => {
		const { f, asked } = explorers({ [RUNBTC_ONION]: PAYS, [RUNBTC_I2P]: PAYS });
		const r = await buildPaymentChecker(config([RUNBTC_ONION, RUNBTC_I2P]), f).check(btcQ);
		expect(r.status).toBe('unavailable');
		// One answer from the operator: its second address is only a fallback.
		expect(asked.filter((u) => u.endsWith(`/tx/${TXID}`))).toHaveLength(1);
	});
	it("runbtc's onion and I2P both saying not found: unavailable, not not_found", async () => {
		const { f } = explorers({ [RUNBTC_ONION]: NOT_FOUND, [RUNBTC_I2P]: NOT_FOUND });
		const r = await buildPaymentChecker(config([RUNBTC_ONION, RUNBTC_I2P]), f).check(btcQ);
		expect(r.status).toBe('unavailable');
	});
	it("mempool.space's onion and clearnet site (the all-explorers tier): unavailable", async () => {
		const { f } = explorers({ [MEMPOOL_ONION]: PAYS, [MEMPOOL]: PAYS });
		const r = await buildPaymentChecker(config([MEMPOOL_ONION, MEMPOOL]), f).check(btcQ);
		expect(r.status).toBe('unavailable');
	});
	it('a second operator agreeing makes the quorum', async () => {
		const { f } = explorers({ [RUNBTC_ONION]: PAYS, [RUNBTC_I2P]: PAYS, [EMZY_ONION]: PAYS });
		const r = await buildPaymentChecker(config([RUNBTC_ONION, RUNBTC_I2P, EMZY_ONION]), f).check(
			btcQ
		);
		expect(r).toEqual({
			status: 'found',
			amount: '0.00025',
			confirmations: 3,
			txTime: new Date(1_790_000_000_000).toISOString()
		});
	});
	it("an operator's other address answers when its first fails, and still counts once", async () => {
		const { f } = explorers({ [RUNBTC_ONION]: 'throw', [RUNBTC_I2P]: PAYS, [EMZY_ONION]: PAYS });
		const r = await buildPaymentChecker(config([RUNBTC_ONION, RUNBTC_I2P, EMZY_ONION]), f).check(
			btcQ
		);
		expect(r.status).toBe('found');
	});
	it('XMR: two nodes of one domain are one operator (two domains: a verdict)', async () => {
		const SUB_TXID = 'cd'.repeat(32);
		const f = (async () =>
			new Response(
				JSON.stringify({ status: 'OK', untrusted: false, missed_tx: [SUB_TXID] })
			)) as typeof fetch;
		const check = (xmrExplorerUrls: string[]) =>
			buildPaymentChecker({ ...config([]), xmrExplorerUrls }, f).check({
				asset: 'xmr',
				txid: SUB_TXID,
				address: XMR_ADDR,
				txKey: 'ef'.repeat(32)
			});
		expect(
			(await check(['node+https://node.monero.fail', 'node+https://xmr.monero.fail'])).status
		).toBe('unavailable');
		expect(
			(await check(['node+https://node.monero.fail', 'node+https://xmr.cryptostorm.is'])).status
		).toBe('not_found');
	});
});

describe('listing fee: one operator is not a quorum either', () => {
	const btcClaim: FeeClaim = {
		feeMethod: 'btc',
		expectedAmount: 25_000,
		externalTxId: TXID,
		txProof: null,
		permlink: 'p',
		signer: 's'
	};
	const btc = (urls: string[], f: typeof fetch) =>
		new BitcoinExplorerFeeVerifier(
			{
				feeAddress: ADDR,
				explorerUrls: urls,
				minConfirmations: 1,
				requestTimeoutMs: 1_000,
				minSuccessfulResponses: 2
			},
			f
		);
	it("BTC: runbtc's two addresses paying: pending, not verified", async () => {
		const { f } = explorers({ [RUNBTC_ONION]: PAYS, [RUNBTC_I2P]: PAYS });
		expect((await btc([RUNBTC_ONION, RUNBTC_I2P], f).verify(btcClaim)).kind).toBe(
			'pending_external'
		);
	});
	it("BTC: Blockstream's onion and clearnet both saying not found: pending, not rejected", async () => {
		const { f } = explorers({ [BLOCKSTREAM_ONION]: NOT_FOUND, [BLOCKSTREAM]: NOT_FOUND });
		expect((await btc([BLOCKSTREAM_ONION, BLOCKSTREAM], f).verify(btcClaim)).kind).toBe(
			'pending_external'
		);
	});
	it('BTC: two operators paying: verified', async () => {
		const { f } = explorers({ [RUNBTC_ONION]: PAYS, [EMZY_ONION]: PAYS });
		expect((await btc([RUNBTC_ONION, EMZY_ONION], f).verify(btcClaim)).kind).toBe('verified');
	});
	it('XMR: two nodes of one domain saying "missed": pending, not rejected', async () => {
		const f = (async () =>
			new Response(
				JSON.stringify({ status: 'OK', untrusted: false, missed_tx: ['cd'.repeat(32)] })
			)) as typeof fetch;
		const v = new MoneroProofFeeVerifier(
			{
				feeAddress: XMR_ADDR,
				explorerUrls: ['node+https://node.monero.fail', 'node+https://xmr.monero.fail'],
				minConfirmations: 1,
				requestTimeoutMs: 1_000,
				minSuccessfulResponses: 2
			},
			f
		);
		const r = await v.verify({
			feeMethod: 'xmr',
			expectedAmount: 1n,
			externalTxId: 'cd'.repeat(32),
			txProof: null,
			txKey: 'ef'.repeat(32),
			permlink: 'p',
			signer: 's',
			xmrBinding: null
		});
		expect(r.kind).toBe('pending_external');
	});
});

describe('tiers: the no-clearnet tier is built only when it holds enough OPERATORS', () => {
	const tiers = (first: string[], all: string[]) =>
		feeVerifierTiers({ off: null, explorerUrls: all, firstTierUrls: first }, 2);
	it('runbtc onion + I2P is one operator: straight to the all-explorers tier', () => {
		const first = [RUNBTC_ONION, RUNBTC_I2P];
		expect(tiers(first, [...first, BLOCKSTREAM, MEMPOOL])).toEqual([
			[...first, BLOCKSTREAM, MEMPOOL]
		]);
	});
	it('two operators: the no-clearnet tier first', () => {
		const first = [RUNBTC_ONION, EMZY_ONION];
		const all = [...first, BLOCKSTREAM];
		expect(tiers(first, all)).toEqual([first, all]);
	});
});
