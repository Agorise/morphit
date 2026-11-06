/**
 * v1.23.2 — the funds-sent receipt of a BLURT payment carries the block its
 * transfer went into, so both screens can check it within seconds
 * (chat/blurtVerify.ts). Older readers ignore the field.
 */
import { describe, expect, it } from 'vitest';

import { decodePayload, encodeFundsSentPayload, type FundsSentPayload } from './payload';

const TXID = '165f16823c7b68f02d389a195ee10c73b37d25cf';
const base: FundsSentPayload = {
	v: 1,
	kind: 'morphit_funds_sent',
	method: 'blurt',
	txid: TXID,
	amount: '2743.000'
};

describe('funds-sent receipt: block (v1.23.2)', () => {
	it('round-trips', () => {
		const wire = encodeFundsSentPayload({ ...base, block: 65088600 });
		expect(JSON.parse(wire).block).toBe(65088600);
		const d = decodePayload(wire);
		expect(d.kind).toBe('funds_sent');
		expect(d.kind === 'funds_sent' && d.payload.block).toBe(65088600);
	});

	it('is optional: a receipt without it decodes as before', () => {
		const d = decodePayload(encodeFundsSentPayload(base));
		expect(d.kind === 'funds_sent' && d.payload.block).toBeUndefined();
	});

	it('only a positive whole block number, only on a BLURT receipt', () => {
		for (const bad of [0, -1, 1.5, '65088600', 2 ** 31, null]) {
			const raw = JSON.stringify({ ...JSON.parse(encodeFundsSentPayload(base)), block: bad });
			expect(decodePayload(raw).kind).toBe('plaintext');
		}
		const btc = JSON.stringify({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'btc',
			txid: 'f'.repeat(64),
			block: 900000
		});
		expect(decodePayload(btc).kind).toBe('plaintext');
		expect(() => encodeFundsSentPayload({ ...base, block: 0 })).toThrow();
		expect(() =>
			encodeFundsSentPayload({
				v: 1,
				kind: 'morphit_funds_sent',
				method: 'btc',
				txid: 'f'.repeat(64),
				block: 5
			})
		).toThrow();
	});
});
