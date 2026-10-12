// @vitest-environment jsdom
/**
 * EndpointList (Stats → RPC endpoints, v1.21.6): what the card shows when the
 * indexer's answers arrive late, out of order, from a clock that differs from
 * the visitor's, or malformed. The rows must never go back to an older answer,
 * never freeze, never throw, and "measured N s ago" must count on the
 * indexer's clock (the visitor's clock may be off by any amount).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string, o?: { values?: Record<string, string> }) =>
		o?.values ? `${k}(${Object.values(o.values).join(',')})` : k
	),
	locale: readable('en')
}));

type Answer = { ok: true; data: unknown } | { ok: false; code: string; message: string };
/** Each call to getRpcEndpoints takes the next queued answer (a promise the test settles). */
const calls: { probe: boolean; settle: (a: Answer) => void }[] = [];
vi.mock('$lib/indexer/client', () => ({
	getRpcEndpoints: (opts?: { probe?: boolean }) =>
		new Promise<Answer>((settle) => calls.push({ probe: opts?.probe === true, settle }))
}));

const iso = (ms: number): string => new Date(ms).toISOString();
const row = (url: string, checkedAt: number): Record<string, unknown> => ({
	url,
	transport: 'clearnet',
	healthy: true,
	latency_ms: 150,
	consecutive_failures: 0,
	cooldown_ms: 0,
	failure_reason: null,
	http_status: null,
	checked_at: iso(checkedAt)
});
const answer = (generatedAt: number, urls: string[], checkedAt = generatedAt): Answer => ({
	ok: true,
	data: {
		network: 'morphit',
		generated_at: iso(generatedAt),
		endpoints: urls.map((u) => row(u, checkedAt))
	}
});

const T0 = Date.parse('2026-10-11T12:00:00Z');
const rejections: unknown[] = [];
const onRejection = (r: unknown): void => void rejections.push(r);

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
	});
	vi.setSystemTime(T0);
	calls.length = 0;
	rejections.length = 0;
	process.on('unhandledRejection', onRejection);
	Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
	process.off('unhandledRejection', onRejection);
	vi.useRealTimers();
	document.body.innerHTML = '';
});

async function flush(): Promise<void> {
	const { flushSync } = await import('svelte');
	for (let i = 0; i < 5; i++) await Promise.resolve();
	flushSync();
}
async function render(): Promise<{ target: HTMLElement; unmount: () => void }> {
	const { mount, unmount, flushSync } = await import('svelte');
	const { default: List } = await import('./EndpointList.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	const c = mount(List, { target });
	flushSync();
	return { target, unmount: () => unmount(c) };
}
const rows = (t: HTMLElement): string[] =>
	[...t.querySelectorAll('li')].map((li) => li.textContent!.replace(/\s+/g, ' ').trim());
const poke = (): void => void document.dispatchEvent(new Event('visibilitychange'));

describe('EndpointList', () => {
	it('an answer that arrives late with older figures never replaces newer ones', async () => {
		const { target, unmount } = await render();
		calls[0]!.settle(answer(T0, ['https://first.example']));
		await flush();
		vi.setSystemTime(T0 + 10_000);
		poke(); // a poll, slow to answer
		vi.setSystemTime(T0 + 11_000);
		target.querySelector('button')!.click(); // a refresh, answered at once
		expect(calls.map((c) => c.probe)).toEqual([false, false, true]);
		calls[2]!.settle(answer(T0 + 12_000, ['https://new.example']));
		await vi.advanceTimersByTimeAsync(600);
		await flush();
		calls[1]!.settle(answer(T0 + 10_000, ['https://old.example']));
		await flush();
		expect(rows(target).join()).toContain('new.example');
		expect(rows(target).join()).not.toContain('old.example');
		unmount();
	});

	it('counts "measured N s ago" on the indexer\'s clock, whatever the visitor\'s clock says', async () => {
		for (const skew of [-3_600_000, 3_600_000]) {
			vi.setSystemTime(T0);
			calls.length = 0;
			const { target, unmount } = await render();
			// The indexer's clock is `skew` away from the browser's; it measured
			// the node 7 s before it answered.
			calls[0]!.settle(answer(T0 + skew, ['https://skew.example'], T0 + skew - 7000));
			await flush();
			await vi.advanceTimersByTimeAsync(3000);
			await flush();
			expect(rows(target)[0]).toContain('settings.endpoints.checked_ago(10 s)');
			unmount();
			document.body.innerHTML = '';
		}
	});

	it('keeps following the indexer when its clock steps back (an answer to a later request is newer)', async () => {
		const { target, unmount } = await render();
		calls[0]!.settle(answer(T0, ['https://before.example']));
		await flush();
		vi.setSystemTime(T0 + 10_000);
		poke();
		calls[1]!.settle(answer(T0 - 300_000, ['https://after.example']));
		await flush();
		expect(rows(target).join()).toContain('after.example');
		unmount();
	});

	it('a malformed answer changes nothing, throws nothing; duplicate or url-less rows are dropped', async () => {
		const { target, unmount } = await render();
		calls[0]!.settle(answer(T0, ['https://good.example']));
		await flush();
		const bad: unknown[] = [
			{},
			null,
			{ generated_at: iso(T0 + 1), endpoints: null },
			{ generated_at: iso(T0 + 2), endpoints: 'abc' },
			{ generated_at: iso(T0 + 3), endpoints: [1, null, { url: 5 }] }
		];
		for (const data of bad) {
			poke();
			calls[calls.length - 1]!.settle({ ok: true, data });
			await flush();
			expect(rows(target).join()).toContain('good.example');
		}
		poke();
		calls[calls.length - 1]!.settle(
			answer(T0 + 10, ['https://d.example', 'https://d.example', 'https://e.example'])
		);
		await flush();
		expect(rows(target).map((r) => r.split(' ')[0])).toEqual([
			'https://d.example',
			'https://e.example'
		]);
		// Node reports an unhandled rejection after the current macrotask
		// (setImmediate is not faked here).
		await new Promise<void>((r) => setImmediate(r));
		expect(rejections).toEqual([]);
		unmount();
	});
});

describe('EndpointList — a slow refresh', () => {
	it('a refresh answer that arrives after polls were shown is kept when it is newer', async () => {
		const { target, unmount } = await render();
		calls[0]!.settle(answer(T0, ['https://first.example']));
		await flush();
		vi.setSystemTime(T0 + 1_000);
		target.querySelector('button')!.click(); // refresh: the indexer re-measures (slow)
		expect(calls.at(-1)!.probe).toBe(true);
		const probe = calls.at(-1)!;
		vi.setSystemTime(T0 + 10_000);
		poke(); // a poll sent and answered while the re-measure runs
		calls.at(-1)!.settle(answer(T0 + 10_000, ['https://poll.example']));
		await flush();
		expect(rows(target).join()).toContain('poll.example');
		vi.setSystemTime(T0 + 30_000);
		probe.settle(answer(T0 + 30_000, ['https://fresh.example']));
		await vi.advanceTimersByTimeAsync(600);
		await flush();
		expect(rows(target).join()).toContain('fresh.example');
		unmount();
	});
});
