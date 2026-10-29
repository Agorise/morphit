import { describe, expect, it } from 'vitest';
import { decodePayload, encodeFundsSentPayload } from './payload';

/** v1.21.17 — a Monero receipt may carry the payment's tx key, so the
 *  receiver's instance can check it reached his address. */
const TXID = 'b'.repeat(64);
const KEY = 'c'.repeat(64);

describe('funds-sent tx_key', () => {
	it('round-trips on a Monero receipt, one key or several (subaddress payments)', () => {
		for (const key of [KEY, KEY + 'd'.repeat(64), KEY.repeat(16), KEY.repeat(17)]) {
			const wire = encodeFundsSentPayload({
				v: 1,
				kind: 'morphit_funds_sent',
				method: 'xmr',
				txid: TXID,
				txKey: key
			});
			expect(JSON.parse(wire).tx_key).toBe(key);
			const d = decodePayload(wire);
			expect(d.kind).toBe('funds_sent');
			if (d.kind === 'funds_sent') expect(d.payload.txKey).toBe(key);
		}
	});
	it('a receipt without one is unchanged (no txKey, no tx_key on the wire)', () => {
		const wire = encodeFundsSentPayload({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'xmr',
			txid: TXID
		});
		expect(JSON.parse(wire)).not.toHaveProperty('tx_key');
		const d = decodePayload(wire);
		expect(d.kind === 'funds_sent' && d.payload.txKey).toBe(undefined);
	});
	it('refused: not Monero, not hex, not 64×n, upper-case, 18 keys (16 outputs + main = 17 at most)', () => {
		const bad = (method: string, tx_key: unknown) =>
			decodePayload(
				JSON.stringify({ v: 1, kind: 'morphit_funds_sent', method, txid: TXID, tx_key })
			).kind;
		expect(bad('btc', KEY)).toBe('plaintext');
		expect(bad('xmr', 'z'.repeat(64))).toBe('plaintext');
		expect(bad('xmr', 'c'.repeat(63))).toBe('plaintext');
		expect(bad('xmr', 'C'.repeat(64))).toBe('plaintext');
		expect(bad('xmr', KEY.repeat(18))).toBe('plaintext');
		expect(bad('xmr', 42)).toBe('plaintext');
		expect(() =>
			encodeFundsSentPayload({
				v: 1,
				kind: 'morphit_funds_sent',
				method: 'btc',
				txid: TXID,
				txKey: KEY
			})
		).toThrow();
	});
});
