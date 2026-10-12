// @vitest-environment jsdom
/**
 * Stats page (v1.21.6): the RPC endpoints card is drawn at once, below the
 * network figures. While /v1/stats is on its way the figures' cards are
 * already drawn at their final size (placeholders), so the RPC card does not
 * jump down when the figures arrive; an answer that is not the expected shape
 * reads as an error, never a crash or an endless "Loading…".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable, writable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/stores', () => ({ page: readable({ data: { lang: 'en' } }) }));
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k),
	locale: readable('en')
}));
vi.mock('$i18n/formatters', () => ({ formatDayMonthTime: () => '11 Oct 12:00' }));
vi.mock('$components/Head.svelte', () => ({ default: () => {} }));
vi.mock('$components/EndpointList.svelte', () => ({ default: () => {} }));
const disabled = writable<readonly string[]>([]);
vi.mock('$lib/assets/acceptedCoins', () => ({ disabledAssets: { subscribe: disabled.subscribe } }));
let statsAnswer: Promise<unknown> = new Promise(() => {});
vi.mock('$lib/indexer/client', () => ({ getStats: () => statsAnswer }));

afterEach(() => {
	document.body.innerHTML = '';
});

async function render(): Promise<HTMLElement> {
	const { mount, flushSync } = await import('svelte');
	const { default: Page } = await import('./+page.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Page, { target });
	flushSync();
	return target;
}
async function settle(): Promise<void> {
	const { flushSync } = await import('svelte');
	for (let i = 0; i < 5; i++) await Promise.resolve();
	flushSync();
}
/** The page's layout skeleton: every card and tile, and every chip. */
const shape = (t: HTMLElement): string[] =>
	[...t.querySelectorAll('.card, .grid > *, .rounded-full')].map(
		(e) => `${e.tagName}.${e.className.split(' ').filter((c) => c !== 'invisible')[0]}`
	);

const STATS = {
	network: 'morphit',
	generated_at: '2026-10-11T12:00:00.000Z',
	orders: { active: 12, total: 340 },
	trades: { completed_total: 55, completed_30d: 7 },
	assets: {
		supported: [
			'BTC',
			'XMR',
			'BLURT',
			'USDT',
			'USDC',
			'DAI',
			'BCH',
			'LTC',
			'DASH',
			'DOGE',
			'ZEC',
			'ARRR',
			'DCR',
			'SOL',
			'ETH',
			'XRP'
		],
		with_active_orders: 4
	},
	fiat_currencies: { with_active_orders: 3 }
};

describe('stats page', () => {
	it('while the figures load, the page already has their final layout', async () => {
		let resolve: (v: unknown) => void = () => {};
		statsAnswer = new Promise((r) => (resolve = r));
		const t = await render();
		const loading = shape(t);
		expect(t.querySelector('#endpoints-heading')).not.toBeNull();
		resolve({ ok: true, data: STATS });
		await settle();
		expect(t.textContent).toContain('340');
		expect(loading).toEqual(shape(t));
	});

	it('an answer of the wrong shape is an error, not a crash', async () => {
		for (const data of [{ network: 'morphit' }, null, { orders: {}, trades: {}, assets: {} }]) {
			statsAnswer = Promise.resolve({ ok: true, data });
			const t = await render();
			await settle();
			expect(t.textContent).toContain('stats.error');
			expect(t.querySelector('#endpoints-heading')).not.toBeNull();
			document.body.innerHTML = '';
		}
	});
});

describe('stats page — every figure is required', () => {
	it('an answer missing any one figure is an error, never a crash', async () => {
		const drops: ((d: any) => void)[] = [
			(d) => delete d.orders.active,
			(d) => delete d.orders.total,
			(d) => delete d.trades.completed_total,
			(d) => delete d.trades.completed_30d,
			(d) => delete d.assets.with_active_orders,
			(d) => delete d.fiat_currencies,
			(d) => (d.assets.supported = 'BTC'),
			(d) => (d.generated_at = 5)
		];
		for (const drop of drops) {
			const data = JSON.parse(JSON.stringify(STATS));
			drop(data);
			statsAnswer = Promise.resolve({ ok: true, data });
			const t = await render();
			await settle();
			expect(t.textContent).toContain('stats.error');
			document.body.innerHTML = '';
		}
	});
});
