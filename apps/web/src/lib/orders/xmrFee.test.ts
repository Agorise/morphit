/**
 * v1.20.0 — XMR listing fees in the browser: the tx key the payer pastes
 * (M-X1) and the order-bound integrated address (MK-H2). Expected integrated
 * addresses come from the PyPI `monero` package (Address.with_payment_id),
 * not from our code.
 */
import { describe, expect, it } from 'vitest';

import { checkXmrTxKey, xmrBoundPrimary } from './xmrFeeMode';
import { xmrBoundPayTo } from './xmrFeeAddress';
import { buildOrderPayload } from './payload';

const PRIMARY =
	'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
const SUB =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const KEY = 'e5b4fe26ae0a3a2f7d2bbed8a0c2a1c6d66925ccdbcb6bcef67a0ad66a9b9807';

describe('tx key check', () => {
	it('accepts exactly one 64-hex key, with stray spaces and any case', () => {
		expect(checkXmrTxKey(`  ${KEY.toUpperCase()}\n`)).toBe('ok');
	});
	it('says "several" when the wallet shows extra keys (64 hex each)', () => {
		expect(checkXmrTxKey(KEY + KEY)).toBe('several');
	});
	it('refuses anything else, including an OutProof', () => {
		expect(checkXmrTxKey('')).toBe('empty');
		expect(checkXmrTxKey(KEY.slice(1))).toBe('malformed');
		expect(checkXmrTxKey('OutProofV2' + 'a'.repeat(60))).toBe('malformed');
		expect(checkXmrTxKey('g'.repeat(64))).toBe('malformed');
	});
});

describe('bound XMR fee address', () => {
	const pinned = {
		btc: null,
		xmr: { address: SUB, piconero: '781250000', primary_address: PRIMARY }
	};
	it('is off until the release pins a primary address', () => {
		expect(xmrBoundPrimary(null)).toBeNull();
		expect(xmrBoundPrimary({ btc: null, xmr: { address: SUB, piconero: '1' } })).toBeNull();
		expect(xmrBoundPrimary(pinned)).toBe(PRIMARY);
	});
	it('makes the same integrated address as PyPI monero for the order', () => {
		// keccak("morphit-fee-v1|morphit/treasury-check")[0:8] = 03159a89a2d9096c
		expect(xmrBoundPayTo(pinned, 'morphit', 'treasury-check')).toEqual({
			paymentId: '03159a89a2d9096c',
			address:
				'4Dp9BhCqXPR8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL4D3cDChHXgvUDJCUPuP'
		});
		expect(xmrBoundPayTo(pinned, 'morphit', 'other')!.address).not.toBe(
			xmrBoundPayTo(pinned, 'morphit', 'treasury-check')!.address
		);
	});
	it('never builds one on a subaddress', () => {
		expect(
			xmrBoundPayTo(
				{ btc: null, xmr: { address: SUB, piconero: '1', primary_address: SUB } },
				'a',
				'b'
			)
		).toBeNull();
	});
});

describe('order payload', () => {
	const base = {
		side: 'sell' as const,
		asset: 'BTC' as const,
		fiatCurrency: 'usd',
		amountMin: null,
		amountMax: null,
		priceModel: {},
		locationRegion: null,
		paymentMethods: ['cash'],
		terms: null,
		expiresAt: null
	};
	it('carries the tx key (lowercase) and no OutProof', () => {
		const p = buildOrderPayload('order-abc', {
			...base,
			feeMethod: 'xmr',
			externalTxId: 'A'.repeat(64),
			txKey: ` ${KEY.toUpperCase()} `
		});
		expect(p.tx_key).toBe(KEY);
		expect('tx_proof' in p).toBe(false);
	});
	it('omits tx_key for other fee methods', () => {
		const p = buildOrderPayload('order-abc', {
			...base,
			feeMethod: 'btc',
			externalTxId: 'a'.repeat(64),
			txKey: KEY
		});
		expect('tx_key' in p).toBe(false);
	});
});
