/**
 * The head tailer ticks at a FIXED RATE (v1.21.14 full chat audit, S-H4).
 *
 * A message the federation could not push reaches its recipient through this
 * scanner. It used to sleep a full interval AFTER each tick, so every tick's
 * own RPC round trips were added to the interval: with 2 s and slow calls the
 * measured worst case from broadcast to emit reached ~5.1 s before either
 * browser hop. Now the next tick is due one interval after the last one
 * STARTED, and the default interval is 1 s. And a tick asks for the next
 * block directly, rather than for the head number and then the block: one
 * round trip less before a message is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEAD_READ_EVERY_TICKS, HeadTailer } from '$indexer/headTailer';

describe('head tailer cadence', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('a slow tick does not push the next one back', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		let reads = 0;
		const slow = <T>(v: T) =>
			new Promise<T>((resolve) => {
				reads++;
				// Each RPC call takes 400 ms (a hidden-service round trip).
				setTimeout(() => resolve(v), 400);
			});
		const blurt = {
			getDynamicGlobalProperties: () => slow({ head_block_number: 1000 }),
			getBlock: () => slow(null)
		};
		const tailer = new HeadTailer(
			{ fastPathIntervalMs: 1000 } as never,
			{} as never,
			blurt as never
		);
		const running = tailer.run();
		// The startup read, then one tick per second.
		await vi.advanceTimersByTimeAsync(400);
		expect(reads).toBe(1);
		await vi.advanceTimersByTimeAsync(10_000);
		tailer.stop();
		await vi.advanceTimersByTimeAsync(2_000);
		await running;
		// 1 startup + at least 10 ticks in 10 s. Sleeping a full interval after
		// each 400 ms tick gave 1 + 7.
		expect(reads).toBeGreaterThanOrEqual(1 + 10);
	});

	it('a new block is read in one round trip; the head only now and then', async () => {
		const calls: string[] = [];
		const blocks = new Map<number, unknown>();
		const blurt = {
			getDynamicGlobalProperties: async () => {
				calls.push('head');
				return { head_block_number: 1000 + blocks.size };
			},
			getBlock: async (n: number) => {
				calls.push(`block ${n}`);
				return blocks.get(n) ?? null;
			}
		};
		const tailer = new HeadTailer(
			{ fastPathIntervalMs: 1000 } as never,
			{} as never,
			blurt as never
		);
		const running = tailer.run();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toEqual(['head']);
		calls.length = 0;
		// Idle: one cheap call per tick, and the head once in ten ticks.
		expect(HEAD_READ_EVERY_TICKS).toBe(10);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(calls.filter((c) => c === 'head').length).toBe(2);
		expect(calls.filter((c) => c === 'block 1001').length).toBe(20);
		calls.length = 0;
		// A block appears: the next tick's FIRST call returns it.
		blocks.set(1001, { timestamp: new Date().toISOString().slice(0, 19), transactions: [] });
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls[0]).toBe('block 1001');
		expect(tailer.getStatus().scannedHead).toBe(1001);
		tailer.stop();
		await vi.advanceTimersByTimeAsync(2_000);
		await running;
	});

	it('defaults to one tick per second', async () => {
		const { loadConfig } = await import('../../src/config/index');
		const saved = { ...process.env };
		try {
			for (const k of Object.keys(process.env)) if (k.startsWith('MORPHIT_')) delete process.env[k];
			Object.assign(process.env, {
				MORPHIT_INDEXER_DATABASE_URL: 'postgres://u:p@localhost:5432/morphit_indexer',
				MORPHIT_INDEXER_RELAY_ACCOUNT: 'tester',
				MORPHIT_INDEXER_FEE_RECIPIENT: 'tester',
				MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
				MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
					'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
				MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f'
			});
			expect(loadConfig().fastPathIntervalMs).toBe(1000);
		} finally {
			process.env = saved;
		}
	});
});
