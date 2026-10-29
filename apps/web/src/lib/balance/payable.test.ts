import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BANDWIDTH_KBYTES_FEE_BLURT,
	DEFAULT_OPERATION_FLAT_FEE_BLURT,
	featureBidCost,
	networkFeeUpperBound,
	payableWith
} from './payable';

const chain = { operationFlatFeeBlurt: 0.05, bandwidthKbytesFeeBlurt: 0.2 };

describe('network fee upper bound (v1.21.17)', () => {
	it('a flat fee per operation plus whole kB of the transaction', () => {
		// 3 small ops: 0.15 + one kB at 0.2.
		expect(
			networkFeeUpperBound(
				[
					['a', {}],
					['b', {}],
					['c', {}]
				],
				chain
			)
		).toBe(0.35);
		// Over 1 kB of JSON → two kB.
		expect(networkFeeUpperBound([['x', { s: 'y'.repeat(1000) }]], chain)).toBe(0.45);
	});
	it('each part costs at least 0.001 BLURT, even at a rate of 0', () => {
		const free = { operationFlatFeeBlurt: 0, bandwidthKbytesFeeBlurt: 0 };
		expect(networkFeeUpperBound([['a', {}]], free)).toBe(0.002);
	});
	it('the chain values when /v1/chain-fee gave none', () => {
		const none = { operationFlatFeeBlurt: null, bandwidthKbytesFeeBlurt: null };
		expect(networkFeeUpperBound([['a', {}]], none)).toBe(
			DEFAULT_OPERATION_FLAT_FEE_BLURT + DEFAULT_BANDWIDTH_KBYTES_FEE_BLURT
		);
	});
});

describe('featureBidCost', () => {
	const base = {
		account: 'alice',
		orderPermlink: 'order-8hzh6aagkn79',
		hours: 72,
		feeBlurtPerHour: 50,
		fees: chain
	};
	it('a split fee is three operations (the bid and two transfers)', () => {
		const c = featureBidCost({ ...base, feeRecipient: 'some-instance' });
		expect(c.bidBlurt).toBe(3600);
		expect(c.networkFeeBlurt).toBe(0.35);
		expect(c.needBlurt).toBe(3600.35);
	});
	it('one transfer when the fee goes to the treasury alone', () => {
		const c = featureBidCost({ ...base, feeRecipient: 'alice' });
		expect(c.networkFeeBlurt).toBe(0.3);
	});
});

describe('payableWith', () => {
	it('enough only when the balance covers everything', () => {
		expect(payableWith({ kind: 'ok', liquidBlurt: 3600.35 }, 3600.35)).toEqual({ kind: 'enough' });
		expect(payableWith({ kind: 'ok', liquidBlurt: 384.641 }, 3600.35)).toEqual({
			kind: 'short',
			missingBlurt: 3215.709
		});
	});
	it('still reading, or could not read', () => {
		expect(payableWith({ kind: 'loading' }, 1)).toEqual({ kind: 'checking' });
		expect(payableWith({ kind: 'error' }, 1)).toEqual({ kind: 'unknown' });
	});
});
