/**
 * Integration tests: BitcoinExplorerFeeVerifier + CircuitBreaker.
 *
 * Proves the breaker gates real verifier calls correctly —
 * skipping open URLs, allowing probes, healing on success.
 */

import { describe, expect, it, vi } from 'vitest';

import { BitcoinExplorerFeeVerifier } from '$indexer/fee/bitcoinExplorerVerifier';
import { CircuitBreaker } from '$indexer/fee/circuitBreaker';
import type { FeeClaim } from '$indexer/fee/verifier';

const FEE_ADDRESS = 'bc1qfeeaddrexample000000000000000000000000';
const VALID_TXID = 'a'.repeat(64);

function claim(overrides: Partial<FeeClaim> = {}): FeeClaim {
	return {
		feeMethod: 'btc',
		expectedAmount: 2_500,
		externalTxId: VALID_TXID,
		permlink: 'x',
		signer: 'alice',
		txProof: null,
		...overrides
	};
}

function okBody() {
	return {
		txid: VALID_TXID,
		vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
		status: { confirmed: true }
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

/** Fetch that throws (simulates transport failure). */
function throwingFetch(): typeof fetch {
	return vi.fn(async () => {
		throw new Error('ECONNREFUSED');
	}) as unknown as typeof fetch;
}

/** Fetch that returns a healthy response. */
function healthyFetch(): typeof fetch {
	return vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => okBody()
	})) as unknown as typeof fetch;
}

describe('BTC verifier + CircuitBreaker — tripping', () => {
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
			const v = new BitcoinExplorerFeeVerifier(
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

			// First 3 attempts hit the network and fail.
			for (let i = 0; i < 3; i++) {
				const r = await v.verify(claim());
				expect(r.kind).toBe('pending_external');
			}
			expect(cb.stateOf('https://bad.test')).toBe('open');
			expect(fetchImpl).toHaveBeenCalledTimes(3);

			// 4th attempt: breaker is open — verifier skips the fetch.
			const r4 = await v.verify(claim());
			expect(r4.kind).toBe('pending_external');
			if (r4.kind === 'pending_external') {
				expect(r4.reason).toContain('cooldown');
			}
			// fetchImpl call count is still 3 — 4th was skipped.
			expect(fetchImpl).toHaveBeenCalledTimes(3);
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe('BTC verifier + CircuitBreaker — probe + recovery', () => {
	it('after cooldown, verifier probes again; success heals the circuit', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const clock = makeClock();
			const cb = new CircuitBreaker({
				failureThreshold: 3,
				baseCooldownMs: 30_000,
				now: clock.now
			});

			// Switchable fetch — throws until we flip it to healthy.
			let healthy = false;
			const fetchImpl = vi.fn(async () => {
				if (!healthy) throw new Error('ECONNREFUSED');
				return { ok: true, status: 200, json: async () => okBody() };
			}) as unknown as typeof fetch;

			const v = new BitcoinExplorerFeeVerifier(
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

			// Trip the breaker.
			for (let i = 0; i < 3; i++) await v.verify(claim());
			expect(cb.stateOf('https://flaky.test')).toBe('open');

			// Explorer comes back up behind the scenes.
			healthy = true;

			// During cooldown, verifier still skips.
			clock.tick(15_000);
			const skipped = await v.verify(claim());
			expect(skipped.kind).toBe('pending_external');
			if (skipped.kind === 'pending_external') {
				expect(skipped.reason).toContain('cooldown');
			}

			// After cooldown, verifier probes and succeeds.
			clock.tick(20_000); // total 35s, past 30s cooldown
			const recovered = await v.verify(claim());
			expect(recovered.kind).toBe('verified');
			expect(cb.stateOf('https://flaky.test')).toBe('closed');
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe('BTC verifier + CircuitBreaker — partial cooldown', () => {
	it('with 2 explorers, one open one healthy, verifier uses the healthy one', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const clock = makeClock();
			const cb = new CircuitBreaker({
				failureThreshold: 3,
				baseCooldownMs: 30_000,
				now: clock.now
			});

			// Pre-populate breaker to mark blockstream as open.
			for (let i = 0; i < 3; i++) cb.recordFailure('https://blockstream.test');

			const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
				const url = typeof input === 'string' ? input : input.toString();
				if (url.includes('blockstream.test')) {
					// Should never be called — circuit is open.
					throw new Error('should not be called');
				}
				return { ok: true, status: 200, json: async () => okBody() };
			}) as unknown as typeof fetch;

			const v = new BitcoinExplorerFeeVerifier(
				{
					feeAddress: FEE_ADDRESS,
					explorerUrls: ['https://blockstream.test', 'https://mempool.test'],
					minConfirmations: 1,
					requestTimeoutMs: 5_000,
     minSuccessfulResponses: 1
				},
				fetchImpl,
				cb
			);

			const r = await v.verify(claim());
			expect(r.kind).toBe('verified');

			// Only mempool was hit.
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
			const url = typeof call[0] === 'string' ? (call[0] as string) : String(call[0]);
			expect(url).toContain('mempool.test');
		} finally {
			warnSpy.mockRestore();
		}
	});
});
