// @vitest-environment jsdom
/**
 * The real RelativeTime, mounted (v1.21.17): an order posted 89.9 days ago
 * reads "3mo ago" (it read "2mo ago" on its expiry day), and a caller's
 * tooltip ("Posted on 28 July, 2026") replaces the default exact time.
 * `_` renders the key with its values so the unit and count are visible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string, o?: { values?: Record<string, unknown> }) =>
		o?.values ? `${k}${JSON.stringify(o.values)}` : k
	),
	locale: readable('en')
}));

afterEach(() => {
	document.body.innerHTML = '';
	vi.useRealTimers();
});

async function render(props: Record<string, unknown>): Promise<HTMLTimeElement> {
	const { mount, flushSync } = await import('svelte');
	const { default: RelativeTime } = await import('./RelativeTime.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(RelativeTime, { target, props: props as never });
	flushSync();
	return target.querySelector('time')!;
}

describe('RelativeTime', () => {
	it('89.9 days ago reads 3 months (terse, with "ago"), not 2', async () => {
		vi.useFakeTimers({ now: Date.parse('2026-10-26T16:29:00Z'), toFake: ['Date'] });
		const t = await render({ iso: '2026-07-28T18:47:30Z', format: 'terse', ago: true });
		expect(t.textContent).toBe(
			'relative_time.terse.ago{"t":"relative_time.terse.months{\\"n\\":3}"}'
		);
		expect(t.getAttribute('datetime')).toBe('2026-07-28T18:47:30Z');
	});
	it('descriptive: just now, then the same ladder', async () => {
		vi.useFakeTimers({ now: Date.parse('2026-10-26T16:29:00Z'), toFake: ['Date'] });
		expect((await render({ iso: '2026-10-26T16:28:30Z', format: 'descriptive' })).textContent).toBe(
			'relative_time.descriptive.just_now'
		);
		expect((await render({ iso: '2026-07-28T18:47:30Z', format: 'descriptive' })).textContent).toBe(
			'relative_time.descriptive.months{"n":3}'
		);
	});
	it('the tooltip is the caller’s when given, the exact time otherwise', async () => {
		const own = await render({ iso: '2026-07-28T18:47:30Z', title: 'Posted on 28 July, 2026' });
		expect(own.getAttribute('title')).toBe('Posted on 28 July, 2026');
		const dflt = await render({ iso: '2026-07-28T18:47:30Z' });
		expect(dflt.getAttribute('title')).toMatch(/2026 @ 18:47:30 UTC$/);
	});
});
