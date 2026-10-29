import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const answers: unknown[] = [];
const asks: unknown[] = [];
vi.mock('$lib/indexer/client', () => ({
	getPaymentCheck: vi.fn(async (q: unknown) => {
		asks.push(q);
		const next = answers.length > 1 ? answers.shift() : answers[0];
		if (next instanceof Error) throw next;
		return next;
	})
}));

import {
	checkOnce,
	isLess,
	PAYMENT_CHECK_FIRST_INTERVAL_MS,
	PAYMENT_CHECK_INTERVAL_MS,
	PAYMENT_CHECK_TIME_SLACK_MS,
	PAYMENT_CHECK_FIRST_PERIOD_MS,
	PAYMENT_CHECK_NOT_FOUND_FOR_MS,
	PAYMENT_CHECK_UNAVAILABLE_FOR_MS,
	verdictOf,
	watchPaymentCheck,
	type PaymentCheckInput,
	type PaymentCheckState
} from './paymentChecks';

const TXID = 'b'.repeat(64);
const found = (amount: string, confirmations: number) => ({
	ok: true,
	data: {
		asset: 'btc',
		txid: TXID,
		status: 'found',
		amount,
		confirmations,
		required_confirmations: 3,
		checked_at: '2026-10-26T00:00:00Z'
	}
});
const notFound = {
	ok: true,
	data: { ...found('0', 0).data, status: 'not_found', amount: null, confirmations: null }
};
const down = { ok: false, error: { code: 'network' } };

beforeEach(() => {
	answers.length = 0;
	asks.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('isLess — exact decimals', () => {
	it('compares without floating point', () => {
		expect(isLess('0.3', '0.30000001')).toBe(true);
		expect(isLess('0.30000000', '0.3')).toBe(false);
		expect(isLess('1', '0.99999999')).toBe(false);
		expect(isLess('.5', '0.5')).toBe(false);
		expect(isLess('0.00012', '0.0002')).toBe(true);
		// Monero has 12 decimals: 18 digits a float cannot tell apart.
		expect(isLess('123456.123456789012', '123456.123456789013')).toBe(true);
	});
});

describe('verdictOf', () => {
	it('maps each state to what the buttons go by', () => {
		const seen = (short: boolean): Extract<PaymentCheckState, { phase: 'seen' }> => ({
			phase: 'seen',
			amount: '1',
			confirmations: 0,
			required: 3,
			short
		});
		expect(verdictOf(seen(false))).toBe('seen');
		expect(verdictOf(seen(true))).toBe('mismatch');
		expect(verdictOf({ ...seen(false), old: true })).toBe('old');
		expect(verdictOf({ ...seen(true), old: true })).toBe('old');
		// No amount asked: the seller judges the amount himself.
		expect(verdictOf({ ...seen(false), unasked: true })).toBe('unasked');
		// Mined but undated: cannot be dated against the share, not seen yet.
		expect(verdictOf({ ...seen(false), undated: true })).toBe('checking');
		expect(verdictOf({ phase: 'not_found' })).toBe('checking');
		expect(verdictOf({ phase: 'not_found', long: true })).toBe('unverifiable');
		expect(verdictOf({ phase: 'no_key' })).toBe('unverifiable');
		// One "cannot check right now" is still checking; several in a row are not.
		expect(verdictOf({ phase: 'unavailable' })).toBe('checking');
		expect(verdictOf({ phase: 'unavailable', long: true })).toBe('unverifiable');
		expect(verdictOf({ phase: 'not_found' })).toBe('checking');
		expect(verdictOf({ phase: 'checking' })).toBe('checking');
	});
});

describe('checkOnce', () => {
	const btc: PaymentCheckInput = { asset: 'btc', txid: TXID, address: 'bc1qx', asked: '0.001' };
	it('a Monero payment without its key is not asked about', async () => {
		expect(await checkOnce({ asset: 'xmr', txid: TXID, address: '4x' })).toEqual({
			phase: 'no_key'
		});
		expect(asks).toHaveLength(0);
	});
	it('found in full, found short, nothing to this address, not found, instance down', async () => {
		answers.push(found('0.001', 1));
		expect(await checkOnce(btc)).toMatchObject({ phase: 'seen', confirmations: 1, short: false });
		answers.length = 0;
		answers.push(found('0.0009', 1));
		expect(await checkOnce(btc)).toMatchObject({ phase: 'seen', short: true });
		answers.length = 0;
		answers.push(found('0', 2));
		expect(await checkOnce({ ...btc, asked: undefined })).toMatchObject({ short: true });
		answers.length = 0;
		answers.push(notFound);
		expect(await checkOnce(btc)).toEqual({ phase: 'not_found' });
		answers.length = 0;
		answers.push(down);
		expect(await checkOnce(btc)).toEqual({ phase: 'unavailable' });
	});
	it('a payment in a block older than the address share is not this trade’s', async () => {
		const shared = Date.parse('2026-10-26T18:00:00Z');
		const at = (iso: string | null) => ({
			ok: true,
			data: { ...found('0.001', 3).data, tx_time: iso }
		});
		const input = { ...btc, sharedAtMs: shared };
		answers.push(at('2026-10-20T00:00:00Z'));
		expect(await checkOnce(input)).toMatchObject({ phase: 'seen', old: true });
		answers.length = 0;
		// Within the block-time slack, and unconfirmed (no time yet): not old.
		answers.push(at(new Date(shared - PAYMENT_CHECK_TIME_SLACK_MS + 60_000).toISOString()));
		expect(await checkOnce(input)).not.toHaveProperty('old');
		answers.length = 0;
		// Mined but no block time from any explorer: undated (not old, not seen).
		answers.push(at(null));
		expect(await checkOnce(input)).toMatchObject({ phase: 'seen', undated: true });
		expect(await checkOnce(input)).not.toHaveProperty('old');
		// In the mempool everywhere (0 confirmations, no time): new, not undated.
		answers.length = 0;
		answers.push({ ok: true, data: { ...found('0.001', 0).data, tx_time: null } });
		const fresh = await checkOnce(input);
		expect(fresh).not.toHaveProperty('undated');
		expect(fresh).not.toHaveProperty('old');
	});
	it('explorers disagreeing on its time: cannot be checked here, never "old" (v1.21.17)', async () => {
		const shared = Date.parse('2026-10-26T18:00:00Z');
		answers.push({
			ok: true,
			data: { ...found('0.001', 3).data, tx_time: null, tx_time_disputed: true }
		});
		const s = await checkOnce({ ...btc, sharedAtMs: shared });
		expect(s).toMatchObject({ phase: 'seen', disputed: true });
		expect(s).not.toHaveProperty('old');
		expect(s).not.toHaveProperty('undated');
		// The seller's own call ("I see it in my wallet"), not a hard stop.
		expect(verdictOf(s)).toBe('unverifiable');
		// Short still says so first.
		expect(verdictOf({ ...(s as Record<string, unknown>), short: true } as never)).toBe('mismatch');
	});
	it('no amount asked: seen, but marked so', async () => {
		answers.push(found('0.00000001', 0));
		expect(await checkOnce({ ...btc, asked: undefined })).toMatchObject({
			phase: 'seen',
			short: false,
			unasked: true
		});
		answers.length = 0;
		answers.push(found('0.001', 0));
		expect(await checkOnce(btc)).not.toHaveProperty('unasked');
	});
	it('the key goes along for Monero', async () => {
		answers.push(found('1', 0));
		await checkOnce({ asset: 'xmr', txid: TXID, address: '4x', txKey: 'c'.repeat(64) });
		expect(asks[0]).toMatchObject({ asset: 'xmr', txKey: 'c'.repeat(64) });
	});
});

describe('watchPaymentCheck', () => {
	it('checks again each minute until confirmed, then stops', async () => {
		vi.useFakeTimers();
		answers.push(found('0.001', 0), found('0.001', 1), found('0.001', 3), found('0.001', 3));
		const w = watchPaymentCheck({ asset: 'btc', txid: TXID, address: 'w1', asked: '0.001' });
		const seen: PaymentCheckState[] = [];
		const stop = w.subscribe((s) => seen.push(s));
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toMatchObject({ phase: 'seen', confirmations: 0 });
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_INTERVAL_MS);
		expect(get(w)).toMatchObject({ confirmations: 1 });
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_INTERVAL_MS);
		expect(get(w)).toMatchObject({ confirmations: 3 });
		const n = asks.length;
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_INTERVAL_MS * 5);
		expect(asks.length).toBe(n);
		expect(seen[0]).toEqual({ phase: 'checking' });
		stop();
	});
	it('asks sooner at first; "cannot check" turns long only once it has lasted', async () => {
		vi.useFakeTimers();
		answers.push(down);
		const w = watchPaymentCheck({ asset: 'btc', txid: TXID, address: 'w4', asked: '0.001' });
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toEqual({ phase: 'unavailable' });
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_FIRST_INTERVAL_MS);
		expect(asks).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(
			PAYMENT_CHECK_UNAVAILABLE_FOR_MS - 2 * PAYMENT_CHECK_FIRST_INTERVAL_MS
		);
		expect(get(w)).toEqual({ phase: 'unavailable' });
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_FIRST_INTERVAL_MS * 2);
		expect(get(w)).toEqual({ phase: 'unavailable', long: true });
		// After the first minutes it slows to once a minute.
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_FIRST_PERIOD_MS);
		const n = asks.length;
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_FIRST_INTERVAL_MS * 3);
		expect(asks.length).toBeLessThanOrEqual(n + 1);
		stop();
	});
	it('"not found" for minutes (a wrong Monero key, say) turns long', async () => {
		vi.useFakeTimers();
		answers.push(notFound);
		const w = watchPaymentCheck({ asset: 'btc', txid: TXID, address: 'w6', asked: '0.001' });
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(w)).toEqual({ phase: 'not_found' });
		await vi.advanceTimersByTimeAsync(
			PAYMENT_CHECK_NOT_FOUND_FOR_MS - PAYMENT_CHECK_FIRST_INTERVAL_MS
		);
		expect(get(w)).toEqual({ phase: 'not_found' });
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_INTERVAL_MS * 2);
		expect(get(w)).toEqual({ phase: 'not_found', long: true });
		stop();
	});
	it('a mined payment without a date keeps being asked about, even at full depth', async () => {
		vi.useFakeTimers();
		answers.push({ ok: true, data: { ...found('0.001', 3).data, tx_time: null } });
		const w = watchPaymentCheck({
			asset: 'btc',
			txid: TXID,
			address: 'w7',
			asked: '0.001',
			sharedAtMs: Date.parse('2026-10-26T18:00:00Z')
		});
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_INTERVAL_MS * 2);
		expect(asks.length).toBeGreaterThan(1);
		stop();
	});
	it('a payment whose time is disputed keeps being asked about (the dispute may clear)', async () => {
		vi.useFakeTimers();
		answers.push({
			ok: true,
			data: { ...found('0.001', 3).data, tx_time: null, tx_time_disputed: true }
		});
		const w = watchPaymentCheck({
			asset: 'btc',
			txid: TXID,
			address: 'w8',
			asked: '0.001',
			sharedAtMs: Date.parse('2026-10-26T18:00:00Z')
		});
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_INTERVAL_MS * 2);
		expect(asks.length).toBeGreaterThan(1);
		stop();
	});
	it('once seen, it is asked once a minute', async () => {
		vi.useFakeTimers();
		answers.push(found('0.001', 0));
		const w = watchPaymentCheck({ asset: 'btc', txid: TXID, address: 'w5', asked: '0.001' });
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_FIRST_INTERVAL_MS);
		expect(asks).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_INTERVAL_MS - PAYMENT_CHECK_FIRST_INTERVAL_MS);
		expect(asks).toHaveLength(2);
		stop();
	});
	it('an outage after the payment was seen does not unsee it', async () => {
		vi.useFakeTimers();
		answers.push(found('0.001', 0), down, down);
		const w = watchPaymentCheck({ asset: 'btc', txid: TXID, address: 'w2', asked: '0.001' });
		const stop = w.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_INTERVAL_MS);
		expect(asks.length).toBe(2);
		expect(get(w)).toMatchObject({ phase: 'seen', confirmations: 0 });
		stop();
	});
	it('one watcher per payment; nobody watching, no asking', async () => {
		vi.useFakeTimers();
		answers.push(found('0.001', 0));
		const input = { asset: 'btc', txid: TXID, address: 'w3', asked: '0.001' } as const;
		expect(watchPaymentCheck(input)).toBe(watchPaymentCheck({ ...input }));
		const stop = watchPaymentCheck(input).subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		stop();
		const n = asks.length;
		await vi.advanceTimersByTimeAsync(PAYMENT_CHECK_INTERVAL_MS * 3);
		expect(asks.length).toBe(n);
	});
});
