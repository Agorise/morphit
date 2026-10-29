import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { liquidOf, watchLiquidBlurt } from './liquidBlurt';
import { triggerBalanceRefresh } from './bus';

const ok = (balance: string) => ({ kind: 'ok', data: { account: { balance } } }) as never;

afterEach(() => vi.useRealTimers());

describe('watchLiquidBlurt (the Feature form follows the wallet, v1.21.17)', () => {
	it('reads at once, then on every tick and every balance nudge', async () => {
		vi.useFakeTimers();
		let n = 0;
		const read = vi.fn(async () => ok(`${(++n).toFixed(3)} BLURT`));
		const seen: unknown[] = [];
		const stop = watchLiquidBlurt('alice', { read, intervalMs: 5_000 }).subscribe((v) =>
			seen.push(v)
		);
		expect(seen[0]).toEqual({ kind: 'loading' });
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.at(-1)).toEqual({ kind: 'ok', liquidBlurt: 1 });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(seen.at(-1)).toEqual({ kind: 'ok', liquidBlurt: 2 });
		triggerBalanceRefresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.at(-1)).toEqual({ kind: 'ok', liquidBlurt: 3 });
		stop();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(read).toHaveBeenCalledTimes(3);
	});

	it('a failed read after a good one keeps the good one; a first failure is "error"', async () => {
		vi.useFakeTimers();
		const answers = [ok('5.000 BLURT'), { kind: 'error', message: 'x' } as never];
		const s = watchLiquidBlurt('alice', { read: async () => answers.shift()! });
		const stop = s.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(get(s)).toEqual({ kind: 'ok', liquidBlurt: 5 });
		stop();
		const bad = watchLiquidBlurt('bob', {
			read: async () => ({ kind: 'error', message: 'x' }) as never
		});
		const stop2 = bad.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(get(bad)).toEqual({ kind: 'error' });
		stop2();
	});

	it('a read that never answers counts as failed, and the next read is made', async () => {
		vi.useFakeTimers();
		let n = 0;
		const read = vi.fn(() =>
			++n === 1 ? new Promise<never>(() => {}) : Promise.resolve(ok('7.000 BLURT'))
		);
		const s = watchLiquidBlurt('alice', { read, intervalMs: 20_000, timeoutMs: 15_000 });
		const stop = s.subscribe(() => {});
		await vi.advanceTimersByTimeAsync(15_000);
		// First read stalled: "unknown", which does not block the form.
		expect(get(s)).toEqual({ kind: 'error' });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(get(s)).toEqual({ kind: 'ok', liquidBlurt: 7 });
		stop();
	});

	it('parses the liquid balance', () => {
		expect(liquidOf(ok('384.641 BLURT'))).toEqual({ kind: 'ok', liquidBlurt: 384.641 });
		expect(liquidOf({ kind: 'not_found' })).toEqual({ kind: 'error' });
	});
});
