/**
 * v1.24.0 — Hive (HIVE), Steem (STEEM) and BitShares (BTS): account names for
 * addresses, 40-hex transaction ids, their own amount jitter, no payment URI.
 */
import { describe, expect, it } from 'vitest';
import {
	buildPaymentUri,
	isValidAddress,
	isValidTxid,
	jitterAmountForAsset,
	jitterBtsAmount,
	jitterHiveSteemAmount
} from './payload';
import { getAsset } from '$lib/assets/registry';

const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const XMR =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const ETH = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('Hive and Steem account names', () => {
	for (const coin of ['hive', 'steem'] as const) {
		it(`${coin}: accepts real account names`, () => {
			for (const ok of ['hiveio', 'steemit', 'blocktrades', 'alice.trades', 'bob-42', 'abc']) {
				expect(isValidAddress(coin, ok), ok).toBe(true);
				expect(getAsset(coin).addressValidator(ok), ok).toBe(true);
			}
		});
		it(`${coin}: refuses near misses and other coins' addresses`, () => {
			for (const bad of [
				'ab',
				'Alice',
				'1alice',
				'alice-',
				'alice.',
				'a'.repeat(17),
				'@alice',
				'alice ',
				// v1.24.0 review: the chains' is_valid_account_name — every part
				// between dots has 3+ characters and starts with a letter.
				'a.b',
				'ab.cd',
				'abc.1de',
				'a..bc',
				'',
				BTC,
				XMR,
				ETH
			]) {
				expect(isValidAddress(coin, bad), bad).toBe(false);
				expect(getAsset(coin).addressValidator(bad), bad).toBe(false);
			}
		});
	}
});

describe('BitShares account names', () => {
	it('accepts real account names, 1 to 63 characters', () => {
		for (const ok of [
			'a',
			'b0',
			'open.ledger-dex',
			'bitshares-dex',
			'x'.repeat(63),
			'allo19kz7zwrlnmrm62z8u9gat8sn2qqlc5afy8d0e2'
		]) {
			expect(isValidAddress('bts', ok), ok).toBe(true);
			expect(getAsset('bts').addressValidator(ok), ok).toBe(true);
		}
	});
	it('refuses what bitshares-core refuses', () => {
		for (const bad of [
			'',
			'Alice',
			'1alice',
			'alice-',
			'alice.',
			'.alice',
			'a..b',
			'a.1b',
			'a.b-',
			'x'.repeat(64),
			XMR,
			ETH,
			'@alice'
		]) {
			expect(isValidAddress('bts', bad), bad).toBe(false);
			expect(getAsset('bts').addressValidator(bad), bad).toBe(false);
		}
	});
});

describe('transaction ids', () => {
	for (const coin of ['hive', 'steem', 'bts'] as const) {
		it(`${coin}: 40 hex characters, either case`, () => {
			expect(isValidTxid(coin, 'ab'.repeat(20))).toBe(true);
			expect(isValidTxid(coin, 'AB'.repeat(20))).toBe(true);
			expect(isValidTxid(coin, 'ab'.repeat(32))).toBe(false); // a Bitcoin-style txid
			expect(isValidTxid(coin, 'a'.repeat(39))).toBe(false);
			expect(isValidTxid(coin, 'g'.repeat(40))).toBe(false);
			expect(isValidTxid(coin, `0x${'ab'.repeat(20)}`)).toBe(false);
		});
	}
});

describe('amount jitter', () => {
	const units = (s: string, d: number) => {
		const [w = '0', f = ''] = s.split('.');
		return BigInt(w) * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d));
	};
	it('HIVE and STEEM: 3 decimals, adds 0 to 0.099, never less', () => {
		for (let i = 0; i < 300; i++) {
			for (const coin of ['hive', 'steem'] as const) {
				const out = jitterAmountForAsset(coin, '12.5');
				expect(out).toMatch(/^\d+\.\d{3}$/);
				const extra = units(out, 3) - units('12.5', 3);
				expect(extra >= 0n && extra <= 99n, out).toBe(true);
			}
		}
		expect(jitterHiveSteemAmount('0')).toMatch(/^0\.0\d\d$/);
	});
	it('BTS: 5 decimals, adds 0 to 0.00999, never less', () => {
		for (let i = 0; i < 300; i++) {
			const out = jitterAmountForAsset('bts', '1000');
			expect(out).toMatch(/^\d+\.\d{5}$/);
			const extra = units(out, 5) - units('1000', 5);
			expect(extra >= 0n && extra <= 999n, out).toBe(true);
		}
		expect(() => jitterBtsAmount('1e5')).toThrow();
	});
});

describe('v1.24.0 review: the trade memo', () => {
	it('an account-name coin’s address and receipt can carry the memo; another coin’s cannot', async () => {
		const { decodePayload, encodeAddressPayload, encodeFundsSentPayload } = await import(
			'./payload'
		);
		for (const method of ['hive', 'steem', 'bts'] as const) {
			const wire = encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method,
				address: 'alice-trader',
				memo: 'k3m9qz2a'
			});
			expect(decodePayload(wire)).toMatchObject({ payload: { method, memo: 'k3m9qz2a' } });
			const r = encodeFundsSentPayload({
				v: 1,
				kind: 'morphit_funds_sent',
				method,
				txid: 'ab'.repeat(20),
				memo: 'k3m9qz2a'
			});
			expect(decodePayload(r)).toMatchObject({ payload: { memo: 'k3m9qz2a' } });
		}
		expect(() =>
			encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'btc',
				address: BTC,
				memo: 'k3m9qz2a'
			})
		).toThrow();
	});
});

describe('payment link', () => {
	it('is the bare account name: no URI scheme any of these wallets agree on', () => {
		for (const coin of ['hive', 'steem', 'bts'] as const) {
			expect(
				buildPaymentUri({
					v: 1,
					kind: 'morphit_addr',
					method: coin,
					address: 'bob',
					amount: '1.000'
				})
			).toBe('bob');
		}
	});
});
