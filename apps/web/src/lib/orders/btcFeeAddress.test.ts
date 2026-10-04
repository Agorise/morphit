/**
 * v1.20.0 (MK-H2) — the browser's side of per-order BTC fee addresses.
 *
 * The indexer tells the browser "your order is #n, its address is A". The
 * browser re-derives address #n from the xpub in the chain-verified release op
 * (validated by @morphit/release-schema, signature-checked against the pinned
 * @morphit key) and shows the address ONLY if both agree — an indexer that
 * lies about the address gets a warning instead of the user's money.
 * Vectors: BIP84 "abandon … about", account 0 (bip-0084.mediawiki).
 */
import { describe, expect, it } from 'vitest';

import {
	btcFeeAddressMode,
	btcFeeKeyId,
	checkIndexerFeeAddress,
	externalTxidRequired,
	satsToBtc
} from './btcFeeAddress';

const XPUB =
	'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const XPUB_B =
	'xpub6DAQJuk3fp8AHZTEz7mx9KazuHD2LPT9GGmPLLbM2gv2sHmbnxPB615DomoH5wsFwXgNjREEh5XGDWssDJU68Pmy1kWDjDMx3YJmk7tfRk9';
const pinned = {
	btc: { address: 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk', satoshis: 1000, xpub: XPUB },
	xmr: null
};
const legacy = {
	btc: { address: 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk', satoshis: 1000 },
	xmr: null
};
const fee = (
	o: Partial<{
		index: number;
		address: string;
		sats: number;
		received_sats: number;
		unconfirmed_sats: number;
		xpub: string;
	}> = {}
) => ({
	index: 1,
	address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
	sats: 1000,
	received_sats: 0,
	unconfirmed_sats: 0,
	...o
});

describe('per-order BTC fee address in the browser', () => {
	it('knows when the chain pin switches BTC fees to per-order addresses', () => {
		expect(btcFeeAddressMode(pinned)).toBe(true);
		expect(btcFeeAddressMode(legacy)).toBe(false);
		expect(btcFeeAddressMode(null)).toBe(false);
	});

	it('shows the address only when its own derivation agrees with the indexer', () => {
		const r = checkIndexerFeeAddress(pinned, fee());
		expect(r).toMatchObject({
			ok: true,
			address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
			amountBtc: '0.00001',
			remainingSats: 1000,
			uri: 'bitcoin:bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g?amount=0.00001'
		});
	});

	it('refuses an address the pinned xpub does not produce at that index', () => {
		// The indexer claims index 1 but hands out receive #0 (another order's).
		expect(
			checkIndexerFeeAddress(pinned, fee({ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' }))
		).toEqual({
			ok: false,
			reason: 'mismatch'
		});
		expect(checkIndexerFeeAddress(legacy, fee())).toEqual({ ok: false, reason: 'no_pin' });
		expect(checkIndexerFeeAddress(pinned, fee({ index: -1 }))).toEqual({
			ok: false,
			reason: 'bad_data'
		});
		expect(checkIndexerFeeAddress(pinned, fee({ sats: 0 }))).toEqual({
			ok: false,
			reason: 'bad_data'
		});
	});

	it('asks only for what is still missing, counting money already on its way', () => {
		expect(checkIndexerFeeAddress(pinned, fee({ received_sats: 400 }))).toMatchObject({
			remainingSats: 600,
			amountBtc: '0.000006',
			uri: 'bitcoin:bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g?amount=0.000006'
		});
		expect(checkIndexerFeeAddress(pinned, fee({ unconfirmed_sats: 1000 }))).toMatchObject({
			remainingSats: 0
		});
	});

	it('formats satoshis as BTC without float drift', () => {
		expect(satsToBtc(1)).toBe('0.00000001');
		expect(satsToBtc(123_456_789)).toBe('1.23456789');
		expect(satsToBtc(100_000_000)).toBe('1');
		expect(satsToBtc(416)).toBe('0.00000416');
	});

	it('gives About-this-instance a short key id, not the whole xpub', () => {
		// HASH160(pubkey)[0:4] of the BIP84 test account (bip_utils agrees: fd13aac9).
		expect(btcFeeKeyId(pinned)).toBe('fd13aac9');
		expect(btcFeeKeyId(legacy)).toBeNull();
	});

	it('lets a BTC order go out without a txid only in per-order-address mode', () => {
		expect(externalTxidRequired('btc', true)).toBe(false);
		expect(externalTxidRequired('btc', false)).toBe(true);
		expect(externalTxidRequired('btc', undefined)).toBe(true);
		expect(externalTxidRequired('xmr', true)).toBe(true);
		expect(externalTxidRequired('blurt', true)).toBe(false);
		expect(externalTxidRequired('waived_first_buy', false)).toBe(false);
	});

	it('V3-5: never asks for more than the chain-pinned amount, whatever the indexer says', () => {
		expect(checkIndexerFeeAddress(pinned, fee({ sats: 5_000_000 }))).toMatchObject({
			ok: true,
			remainingSats: 1000,
			amountBtc: '0.00001'
		});
		// a LOWER posted amount (the pin was raised after posting) is what the indexers accept
		expect(checkIndexerFeeAddress(pinned, fee({ sats: 800 }))).toMatchObject({
			remainingSats: 800
		});
	});

	it("V3-10: after a key rotation, derives with the order's own key once the chain shows it was pinned", () => {
		const rotated = { btc: { ...pinned.btc, xpub: XPUB_B }, xmr: null };
		// not yet known to have been pinned: neither shown nor called a mismatch
		expect(checkIndexerFeeAddress(rotated, fee({ xpub: XPUB }))).toEqual({
			ok: false,
			reason: 'unverified_key'
		});
		expect(
			checkIndexerFeeAddress(rotated, fee({ xpub: XPUB }), { verifiedXpubs: new Set([XPUB]) })
		).toMatchObject({
			ok: true,
			address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'
		});
		// a key the chain never pinned stays refused
		expect(
			checkIndexerFeeAddress(rotated, fee({ xpub: XPUB }), { verifiedXpubs: new Set([XPUB_B]) })
		).toEqual({
			ok: false,
			reason: 'unverified_key'
		});
		// the current key needs no history
		expect(checkIndexerFeeAddress(pinned, fee({ xpub: XPUB }))).toMatchObject({ ok: true });
	});
});
