/**
 * v1.22.0 — every coin's chat messages work: an address and a "funds sent"
 * message for each coin encode, decode back to the same coin, and keep the
 * same address / transaction ID. Before, the encoders and the decoder each
 * carried a hand-written list of coins; adding eCash (ECX) showed that a new
 * coin could miss them with no error at all (its address refused when sent,
 * shown as plain text when received). SAMPLES is a Record over every coin, so
 * a coin added later does not compile until it has a sample here — and then
 * this test proves its messages round-trip.
 */
import { describe, expect, it } from 'vitest';
import {
	decodePayload,
	encodeAddressPayload,
	encodeFundsSentPayload,
	isChatPaymentMethod,
	type ChatAssetTicker
} from './payload';

const HEX64 = 'ab'.repeat(32);

/** A well-formed address and transaction ID per coin (shape only). */
const SAMPLES: Record<
	Exclude<ChatAssetTicker, 'barter'>,
	{ address: string; txid: string; network?: string }
> = {
	btc: { address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', txid: HEX64 },
	xmr: {
		address:
			'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe',
		txid: HEX64
	},
	blurt: { address: 'bob', txid: 'ab'.repeat(20) },
	usdt: {
		address: 'TRwBdHwgaTtSGyhz8XmFmcv8VspbXP7AwL',
		txid: HEX64,
		network: 'trc20'
	},
	usdc: {
		address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
		txid: `0x${HEX64}`,
		network: 'erc20'
	},
	dai: {
		address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
		txid: `0x${HEX64}`,
		network: 'erc20'
	},
	bch: { address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', txid: HEX64 },
	ltc: { address: 'ltc1qhgqd3p9hky4r29mxrkv0p38apgmt9rqxmf04qd', txid: HEX64 },
	dash: { address: 'XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc', txid: HEX64 },
	doge: { address: 'DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf', txid: HEX64 },
	zec: { address: 't1RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA', txid: HEX64 },
	arrr: { address: 'zs1' + 'q'.repeat(75), txid: HEX64 },
	dcr: { address: 'Dsmcfb6dGoZBaBdF8u1QFcKsuyaPgxR8N7d', txid: HEX64 },
	sol: {
		address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
		txid: '5'.repeat(88)
	},
	eth: { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', txid: `0x${HEX64}` },
	xrp: { address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', txid: HEX64.toUpperCase() },
	// eCash: a Bitcoin address IS an eCash address
	ecx: { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', txid: HEX64 },
	// Graphene chains: the account name is the address, 40-hex transaction ids
	hive: { address: 'hiveio', txid: 'ab'.repeat(20) },
	steem: { address: 'steemit', txid: 'cd'.repeat(20) },
	bts: { address: 'open.ledger-dex', txid: 'ef'.repeat(20) }
};

const COINS = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];

describe('every coin’s chat messages round-trip', () => {
	it('lists every coin but barter as a chat payment method', () => {
		for (const m of COINS) expect(isChatPaymentMethod(m), m).toBe(true);
		expect(isChatPaymentMethod('barter')).toBe(false);
		expect(isChatPaymentMethod('xec')).toBe(false);
		expect(isChatPaymentMethod('toString')).toBe(false);
		expect(isChatPaymentMethod(undefined)).toBe(false);
	});

	for (const m of COINS) {
		it(`${m}: an address message`, () => {
			const s = SAMPLES[m];
			const text = encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: m,
				address: s.address,
				...(s.network !== undefined ? { network: s.network } : {})
			} as never);
			const back = decodePayload(text);
			expect(back.kind, m).toBe('address');
			if (back.kind !== 'address') return;
			expect(back.payload.method).toBe(m);
			expect(back.payload.address).toBe(s.address);
		});

		it(`${m}: a funds-sent message`, () => {
			const s = SAMPLES[m];
			const text = encodeFundsSentPayload({
				v: 1,
				kind: 'morphit_funds_sent',
				method: m,
				txid: s.txid,
				...(s.network !== undefined ? { network: s.network } : {})
			} as never);
			const back = decodePayload(text);
			expect(back.kind, m).toBe('funds_sent');
			if (back.kind !== 'funds_sent') return;
			expect(back.payload.method).toBe(m);
			expect(back.payload.txid).toBe(s.txid);
		});
	}

	it('refuses barter and unknown coins on both sides', () => {
		expect(() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'barter',
				address: 'x'
			} as never)
		).toThrow('payload: invalid method');
		const forged = JSON.stringify({ v: 1, kind: 'morphit_addr', method: 'xec', address: 'x' });
		expect(decodePayload(forged).kind).toBe('plaintext');
	});
});
