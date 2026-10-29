import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const chain = vi.hoisted(() => ({ answers: [] as unknown[], asks: [] as unknown[] }));
vi.mock('./blurtVerify', () => ({
	verifyBlurtTransfer: vi.fn(async (txid: string, expect: Record<string, unknown>) => {
		chain.asks.push({ txid, ...expect });
		const next = chain.answers.length > 1 ? chain.answers.shift() : chain.answers[0];
		if (next instanceof Error) throw next;
		return next;
	})
}));

import {
	BLURT_LEG_INTERVAL_MS,
	BLURT_LEG_LONG_MS,
	blurtLegStateOf,
	blurtLegVerdict,
	recheckAmount,
	watchBlurtLeg,
	type BlurtLegInput
} from './blurtLegCheck';

const input = (o: Partial<BlurtLegInput> = {}): BlurtLegInput => ({
	txid: 'f'.repeat(40),
	payer: 'bob',
	payee: 'alice',
	asked: 500,
	memo: 'k7m2q9xa',
	...o
});

beforeEach(() => {
	chain.answers.length = 0;
	chain.asks.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('what the chain said, for the seller', () => {
	it('as asked: seen; "amount differs": looked at again only if paid in full or more', () => {
		expect(blurtLegVerdict(blurtLegStateOf({ kind: 'verified' }, input()))).toBe('seen');
		const diff = (received?: string) =>
			({ kind: 'mismatch', field: 'amount', ...(received ? { received } : {}) }) as const;
		expect(recheckAmount(diff('600.000'), input())).toBe(600);
		expect(recheckAmount(diff('500.000'), input())).toBe(500);
		expect(recheckAmount(diff('499.999'), input())).toBeNull();
		expect(recheckAmount(diff(), input())).toBeNull();
		expect(recheckAmount({ kind: 'mismatch', field: 'memo' }, input())).toBeNull();
		// Until looked at again, "amount differs" is no payment.
		expect(blurtLegVerdict(blurtLegStateOf(diff('600.000'), input()))).toBe('mismatch');
	});
	it('another payer, another payee, another memo, no transfer in it: mismatch', () => {
		for (const field of ['from', 'to', 'memo'] as const) {
			expect(blurtLegVerdict(blurtLegStateOf({ kind: 'mismatch', field }, input()))).toBe(
				'mismatch'
			);
		}
		expect(blurtLegVerdict(blurtLegStateOf({ kind: 'wrong_op' }, input()))).toBe('mismatch');
		// …also when no amount was asked: only the amount is his call.
		expect(
			blurtLegVerdict(
				blurtLegStateOf({ kind: 'mismatch', field: 'to' }, input({ asked: undefined }))
			)
		).toBe('mismatch');
	});
	it('no amount asked, or no memo asked: seen, but the seller’s call', () => {
		expect(
			blurtLegVerdict(blurtLegStateOf({ kind: 'verified' }, input({ asked: undefined })))
		).toBe('unasked');
		expect(
			recheckAmount(
				{ kind: 'mismatch', field: 'amount', received: '0.001' },
				input({ asked: undefined })
			)
		).toBe(0.001);
		// Without a memo an earlier transfer from the same payer would match.
		expect(blurtLegVerdict(blurtLegStateOf({ kind: 'verified' }, input({ memo: '' })))).toBe(
			'unasked'
		);
	});
	it('not on chain yet / node down: checking, until it lasts', () => {
		expect(blurtLegVerdict({ phase: 'not_found', long: false })).toBe('checking');
		expect(blurtLegVerdict({ phase: 'unavailable', long: false })).toBe('checking');
		expect(blurtLegVerdict({ phase: 'not_found', long: true })).toBe('unverifiable');
		expect(blurtLegVerdict({ phase: 'unavailable', long: true })).toBe('unverifiable');
	});
});

describe('watchBlurtLeg', () => {
	it('paid more than asked: looked at again with what arrived, every field checked', async () => {
		// First answer: amount differs (600 of 500). Second, asked with 600:
		// the memo differs — an earlier transfer, not this ask's.
		chain.answers.push(
			{ kind: 'mismatch', field: 'amount', received: '600.000' },
			{ kind: 'mismatch', field: 'memo' }
		);
		const w = watchBlurtLeg(input({ txid: 'e'.repeat(40) }));
		const stop = w.subscribe(() => {});
		await vi.waitFor(() => expect(get(w)).toEqual({ phase: 'mismatch' }));
		expect(chain.asks.map((a) => (a as { amountBlurt: number }).amountBlurt)).toEqual([500, 600]);
		stop();
		chain.answers.length = 0;
		chain.asks.length = 0;
		chain.answers.push(
			{ kind: 'mismatch', field: 'amount', received: '600.000' },
			{ kind: 'verified' }
		);
		const w2 = watchBlurtLeg(input({ txid: '9'.repeat(40) }));
		const stop2 = w2.subscribe(() => {});
		await vi.waitFor(() => expect(get(w2)).toEqual({ phase: 'seen', unasked: false }));
		stop2();
	});
	it('asks the chain with the seller’s ask and this payer', async () => {
		chain.answers.push({ kind: 'verified' });
		const w = watchBlurtLeg(input({ txid: 'a'.repeat(40) }));
		const stop = w.subscribe(() => {});
		await vi.waitFor(() => expect(get(w)).toEqual({ phase: 'seen', unasked: false }));
		expect(chain.asks[0]).toEqual({
			txid: 'a'.repeat(40),
			recipient: 'alice',
			sender: 'bob',
			amountBlurt: 500,
			memo: 'k7m2q9xa'
		});
		stop();
	});
	it('looks again while not on chain; "long" once it lasts; stops once answered', async () => {
		vi.useFakeTimers();
		chain.answers.push({ kind: 'not_found' });
		const w = watchBlurtLeg(input({ txid: 'b'.repeat(40) }));
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toEqual({ phase: 'not_found', long: false });
		await vi.advanceTimersByTimeAsync(BLURT_LEG_LONG_MS + BLURT_LEG_INTERVAL_MS);
		expect(get(w)).toEqual({ phase: 'not_found', long: true });
		chain.answers.length = 0;
		chain.answers.push({ kind: 'verified' });
		await vi.advanceTimersByTimeAsync(BLURT_LEG_INTERVAL_MS);
		expect(get(w)).toEqual({ phase: 'seen', unasked: false });
		const n = chain.asks.length;
		await vi.advanceTimersByTimeAsync(BLURT_LEG_INTERVAL_MS * 5);
		expect(chain.asks.length).toBe(n);
		stop();
	});
	it('a thrown error is "cannot ask", and looked at again', async () => {
		vi.useFakeTimers();
		chain.answers.push(new Error('down'));
		const w = watchBlurtLeg(input({ txid: 'c'.repeat(40) }));
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toEqual({ phase: 'unavailable', long: false });
		await vi.advanceTimersByTimeAsync(BLURT_LEG_INTERVAL_MS);
		expect(chain.asks.length).toBe(2);
		stop();
	});
});
