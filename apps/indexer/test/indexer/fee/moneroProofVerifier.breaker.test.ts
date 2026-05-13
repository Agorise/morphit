/**
 * Integration tests: MoneroProofFeeVerifier + CircuitBreaker.
 *
 * Proves the breaker gates real proof-verification calls
 * correctly — skipping open URLs, allowing probes, healing on
 * success.  Mirrors the BitcoinExplorerFeeVerifier breaker
 * tests for parity.
 */

import { describe, expect, it, vi } from 'vitest';

import { MoneroProofFeeVerifier } from '$indexer/fee/moneroProofVerifier';
import { CircuitBreaker } from '$indexer/fee/circuitBreaker';
import type { FeeClaim } from '$indexer/fee/verifier';

const FEE_ADDRESS =
	'4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2bYXZKK';
const VALID_TXID = 'a'.repeat(64);
const VALID_TX_PROOF =
	'OutProofV2' +
	'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' +
	'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' +
	'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

function claim(overrides: Partial<FeeClaim> = {}): FeeClaim {
	return {
		feeMethod: 'xmr',
		expectedAmount: 781_250_000n,
		externalTxId: VALID_TXID,
		txProof: VALID_TX_PROOF,
		permlink: 'x',
		signer: 'bob',
		...overrides
	};
}

function okBody() {
	return {
		status: 'success',
		data: {
			address: FEE_ADDRESS,
			tx_hash: VALID_TXID,
			outputs: [{ amount: 781_250_000, match: true }],
			tx_confirmations: 5
		}
	};
}

function makeClock(startEpoch = 1_700_000_000_000) {
	let now = startEpoch;
	return {
		now: () => now,
		tick: (ms: number) => {
			now += ms;
		}
	};
}

function throwingFetch(): typeof fetch {
	return vi.fn(async () => {
		throw new Error('ECONNREFUSED');
	}) as unknown as typeof fetch;
}

describe('XMR-proof verifier + CircuitBreaker — tripping', () => {
	it('after threshold failures, verifier skips the URL entirely', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const clock = makeClock();
			const cb = new CircuitBreaker({
				failureThreshold: 3,
				baseCooldownMs: 30_000,
				now: clock.now
			});
			const fetchImpl = throwingFetch();
			const v = new MoneroProofFeeVerifier(
				{
					feeAddress: FEE_ADDRESS,
					explorerUrls: ['https://bad.test'],
					minConfirmations: 1,
					requestTimeoutMs: 5_000,
     minSuccessfulResponses: 1
				},
				fetchImpl,
				cb
			);

			for (let i = 0; i < 3; i++) {
				const r = await v.verify(claim());
				expect(r.kind).toBe('pending_external');
			}
			expect(cb.stateOf('https://bad.test')).toBe('open');
			expect(fetchImpl).toHaveBeenCalledTimes(3);

			const r4 = await v.verify(claim());
			expect(r4.kind).toBe('pending_external');
			if (r4.kind === 'pending_external') {
				expect(r4.reason).toContain('cooldown');
			}
			expect(fetchImpl).toHaveBeenCalledTimes(3);
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe('XMR-proof verifier + CircuitBreaker — probe + recovery', () => {
	it('after cooldown, verifier probes again; success heals the circuit', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const clock = makeClock();
			const cb = new CircuitBreaker({
				failureThreshold: 3,
				baseCooldownMs: 30_000,
				now: clock.now
			});

			let healthy = false;
			const fetchImpl = vi.fn(async () => {
				if (!healthy) throw new Error('ECONNREFUSED');
				return { ok: true, status: 200, json: async () => okBody() };
			}) as unknown as typeof fetch;

			const v = new MoneroProofFeeVerifier(
				{
					feeAddress: FEE_ADDRESS,
					explorerUrls: ['https://flaky.test'],
					minConfirmations: 1,
					requestTimeoutMs: 5_000,
     minSuccessfulResponses: 1
				},
				fetchImpl,
				cb
			);

			for (let i = 0; i < 3; i++) await v.verify(claim());
			expect(cb.stateOf('https://flaky.test')).toBe('open');

			healthy = true;

			clock.tick(15_000);
			const skipped = await v.verify(claim());
			expect(skipped.kind).toBe('pending_external');
			if (skipped.kind === 'pending_external') {
				expect(skipped.reason).toContain('cooldown');
			}

			clock.tick(20_000);
			const recovered = await v.verify(claim());
			expect(recovered.kind).toBe('verified');
			expect(cb.stateOf('https://flaky.test')).toBe('closed');
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe('XMR-proof verifier + CircuitBreaker — partial cooldown', () => {
	it('with 2 explorers, one open one healthy, verifier uses the healthy one', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const clock = makeClock();
			const cb = new CircuitBreaker({
				failureThreshold: 3,
				baseCooldownMs: 30_000,
				now: clock.now
			});

			for (let i = 0; i < 3; i++) cb.recordFailure('https://xmrchain-a.test');

			const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
				const url = typeof input === 'string' ? input : input.toString();
				if (url.includes('xmrchain-a.test')) {
					throw new Error('should not be called');
				}
				return { ok: true, status: 200, json: async () => okBody() };
			}) as unknown as typeof fetch;

			const v = new MoneroProofFeeVerifier(
				{
					feeAddress: FEE_ADDRESS,
					explorerUrls: ['https://xmrchain-a.test', 'https://xmrchain-b.test'],
					minConfirmations: 1,
					requestTimeoutMs: 5_000,
     minSuccessfulResponses: 1
				},
				fetchImpl,
				cb
			);

			const r = await v.verify(claim());
			expect(r.kind).toBe('verified');

			expect(fetchImpl).toHaveBeenCalledTimes(1);
			const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
			const url = typeof call[0] === 'string' ? (call[0] as string) : String(call[0]);
			expect(url).toContain('xmrchain-b.test');
		} finally {
			warnSpy.mockRestore();
		}
	});
});
