// @vitest-environment jsdom
/**
 * The pay panel's calls to its own indexer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkFeeNow, crossCheckFeeAddress } from './btcFeeCheck';

afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: unknown) {
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' }
			});
		})
	);
	return calls;
}

describe('fee address cross-check', () => {
	it('passes the verdict through and asks its own indexer only', async () => {
		const calls = stub(200, { verdict: 'disagree', asked: 2, agreeing: 1 });
		expect(await crossCheckFeeAddress('alice', 'order-abc')).toBe('disagree');
		expect(calls[0]!.url).toMatch(/\/v1\/orders\/alice\/order-abc\/btc-fee-crosscheck$/);
	});
	it('treats anything unexpected as unchecked, never as agreement', async () => {
		stub(500, {});
		expect(await crossCheckFeeAddress('alice', 'order-abc')).toBe('unchecked');
		stub(200, { verdict: 'yes' });
		expect(await crossCheckFeeAddress('alice', 'order-abc')).toBe('unchecked');
	});
});

describe('check my payment now', () => {
	it('POSTs and reads the status and when to ask again', async () => {
		const calls = stub(200, {
			fee_status: 'verified',
			received_sats: 1000,
			unconfirmed_sats: 0,
			checked: true,
			retry_after_s: 60
		});
		expect(await checkFeeNow('alice', 'order-abc')).toEqual({
			feeStatus: 'verified',
			receivedSats: 1000,
			unconfirmedSats: 0,
			checked: true,
			retryAfterS: 60
		});
		expect(calls[0]!.init?.method).toBe('POST');
		expect(calls[0]!.url).toMatch(/\/v1\/orders\/alice\/order-abc\/check-fee$/);
	});

	it('is accepted by an indexer that refuses POSTs that are not JSON (415)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				const type = new Headers(init?.headers).get('content-type') ?? '';
				if (!type.startsWith('application/json')) return new Response('', { status: 415 });
				return new Response(JSON.stringify({ fee_status: 'awaiting_payment', retry_after_s: 30 }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			})
		);
		expect(await checkFeeNow('alice', 'order-abc')).not.toBeNull();
	});
});
