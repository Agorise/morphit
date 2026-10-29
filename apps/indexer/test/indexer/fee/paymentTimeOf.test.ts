import { describe, expect, it } from 'vitest';

import { PAYMENT_TIME_SLACK_SEC, paymentTimeOf } from '$indexer/fee/verifier';

const NOW = 2_000_000_000;
const mined = (time: number | null) => ({ inBlock: true, time });
const pool = { inBlock: false, time: null };

describe('paymentTimeOf (one explorer must not date a payment, v1.21.17)', () => {
	it('agreeing times: the earliest', () => {
		expect(paymentTimeOf([mined(NOW - 600), mined(NOW - 500)], NOW)).toEqual({
			blockTime: NOW - 600,
			timeDisputed: false
		});
	});
	it('times further apart than the slack: disputed, no time', () => {
		expect(
			paymentTimeOf([mined(NOW - 600), mined(NOW - 600 - PAYMENT_TIME_SLACK_SEC - 1)], NOW)
		).toEqual({ blockTime: null, timeDisputed: true });
		expect(
			paymentTimeOf([mined(NOW - 600), mined(NOW - 600 - PAYMENT_TIME_SLACK_SEC)], NOW).timeDisputed
		).toBe(false);
	});
	it("in someone's mempool yet mined hours ago: disputed; mined minutes ago: fine", () => {
		expect(paymentTimeOf([mined(NOW - PAYMENT_TIME_SLACK_SEC - 1), pool], NOW)).toEqual({
			blockTime: null,
			timeDisputed: true
		});
		expect(paymentTimeOf([mined(NOW - 300), pool], NOW)).toEqual({
			blockTime: NOW - 300,
			timeDisputed: false
		});
	});
	it('no time from anyone, or in every mempool: none, not disputed', () => {
		expect(paymentTimeOf([pool, pool], NOW)).toEqual({ blockTime: null, timeDisputed: false });
		expect(paymentTimeOf([mined(null), mined(null)], NOW)).toEqual({
			blockTime: null,
			timeDisputed: false
		});
	});
});
