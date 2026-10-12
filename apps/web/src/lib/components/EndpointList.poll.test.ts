// @vitest-environment jsdom
/**
 * EndpointList (v1.21.6): the stats page's RPC card shows the indexer's latest
 * figures from the first paint, re-reads them every 10 s while the page is
 * visible (and on return to the tab), stops when it leaves the page, and a
 * refresh asks the indexer to re-measure while the rows stay on screen.
 * Behaviour, not source text: the component is mounted against a fake indexer.
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
	_: readable((k: string, o?: { values?: Record<string, unknown> }) =>
		o?.values ? `${k}(${Object.values(o.values).join(',')})` : k
	),
	locale: readable('en')
}));

type Row = Record<string, unknown>;
interface Answer {
	ok: true;
	data: { network: 'morphit'; generated_at: string; endpoints: Row[] };
}
const calls: { probe: boolean }[] = [];
let next: (probe: boolean) => Promise<Answer> = async () => answer(0, []);
vi.mock('$lib/indexer/client', () => ({
	getRpcEndpoints: (o: { probe: boolean }) => {
		calls.push(o);
		return next(o.probe);
	}
}));

const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
function answer(at: number, endpoints: Row[]): Answer {
	return {
		ok: true,
		data: { network: 'morphit', generated_at: new Date(at).toISOString(), endpoints }
	};
}
function row(url: string, o: Row = {}): Row {
	return {
		url,
		transport: 'clearnet',
		healthy: true,
		latency_ms: 120,
		consecutive_failures: 0,
		cooldown_ms: 0,
		failure_reason: null,
		http_status: null,
		checked_at: new Date(T0).toISOString(),
		...o
	};
}

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
	vi.useFakeTimers({ now: T0 });
	calls.length = 0;
	visibility = 'visible';
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = '';
});

async function render(): Promise<{ el: HTMLElement; stop: () => void }> {
	const { mount, unmount, flushSync } = await import('svelte');
	const { default: List } = await import('./EndpointList.svelte');
	const el = document.createElement('div');
	document.body.appendChild(el);
	const c = mount(List, { target: el });
	await settle();
	return { el, stop: () => void unmount(c) };
	async function settle(): Promise<void> {
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
	}
}
async function advance(ms: number): Promise<void> {
	const { flushSync } = await import('svelte');
	await vi.advanceTimersByTimeAsync(ms);
	flushSync();
}

describe('EndpointList', () => {
	it('first paint: the measured figures, and "probing" (not offline) for a node not measured yet', async () => {
		next = async () =>
			answer(T0, [
				row('https://a.example', { latency_ms: 340 }),
				row('http://b.onion', {
					transport: 'tor',
					healthy: false,
					latency_ms: null,
					checked_at: null
				})
			]);
		const { el, stop } = await render();
		expect(calls).toEqual([{ probe: false }]);
		const rows = [...el.querySelectorAll('li')].map((li) => li.textContent ?? '');
		expect(rows[0]).toContain('0.34 s');
		expect(rows[1]).toContain('settings.endpoints.probing');
		expect(rows[1]).not.toContain('settings.endpoints.unreachable');
		expect(rows[1]).not.toContain('settings.endpoints.checked_ago');
		stop();
	});

	it('each row says how long ago it was measured, counting up', async () => {
		next = async () =>
			answer(T0, [row('https://a.example', { checked_at: new Date(T0 - 6000).toISOString() })]);
		const { el, stop } = await render();
		expect(el.textContent).toContain('settings.endpoints.checked_ago(6 s)');
		await advance(3000);
		expect(el.textContent).toContain('settings.endpoints.checked_ago(9 s)');
		stop();
	});

	it('re-reads every 10 s while visible, not while hidden, again on return, and never after unmount', async () => {
		next = async () => answer(Date.now(), [row('https://a.example')]);
		const { stop } = await render();
		expect(calls.length).toBe(1);
		await advance(10_000);
		expect(calls).toEqual([{ probe: false }, { probe: false }]);
		visibility = 'hidden';
		await advance(30_000);
		expect(calls.length).toBe(2);
		visibility = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		await advance(0);
		expect(calls.length).toBe(3);
		stop();
		await advance(60_000);
		document.dispatchEvent(new Event('visibilitychange'));
		expect(calls.length).toBe(3);
	});

	it('refresh asks for a re-measure and keeps the rows on screen until it arrives', async () => {
		next = async () => answer(T0, [row('https://a.example', { latency_ms: 100 })]);
		const { el, stop } = await render();
		let release: (a: Answer) => void = () => {};
		next = (probe) =>
			probe ? new Promise<Answer>((r) => (release = r)) : Promise.resolve(answer(T0, []));
		el.querySelector('button')!.click();
		await advance(0);
		expect(calls.at(-1)).toEqual({ probe: true });
		expect(el.textContent).toContain('0.10 s');
		release(answer(T0 + 2000, [row('https://a.example', { latency_ms: 250 })]));
		await advance(600);
		expect(el.textContent).toContain('0.25 s');
		stop();
	});
});
