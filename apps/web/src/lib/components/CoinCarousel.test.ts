// @vitest-environment jsdom
/**
 * CoinCarousel (v1.21.5): the homepage marquee shows the coins THIS site
 * accepts, the networks those coins settle on, and barter only when accepted —
 * and its two rows stay balanced.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable, writable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k)
}));
const inst = writable({ disabled_assets: [] as string[] });
vi.mock('$stores/instance', () => ({ instance: { subscribe: inst.subscribe } }));

afterEach(() => {
	document.body.innerHTML = '';
});

/** The screen-reader list: one item per carousel slot (rendered before the
 *  lazy mount, so no IntersectionObserver is needed). */
async function slots(disabled: string[]): Promise<string[]> {
	inst.set({ disabled_assets: disabled });
	const { mount, flushSync } = await import('svelte');
	const { default: C } = await import('./CoinCarousel.svelte');
	(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
		observe(): void {}
		disconnect(): void {}
	};
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(C, { target });
	flushSync();
	return [...target.querySelectorAll('ul.sr-only li')].map((li) => li.textContent ?? '');
}

describe('CoinCarousel', () => {
	it('everything accepted: 16 coins, 5 networks, barter', async () => {
		const s = await slots([]);
		expect(s.length).toBe(22);
		expect(s).toContain('home.coin_carousel.networks.arbitrum_sr');
		expect(s).toContain('home.coin_carousel.barter.sr');
		expect(s.some((x) => x.includes('(BARTER)'))).toBe(false);
	});

	it('stablecoins off: their coins and their networks go', async () => {
		const s = await slots(['USDT', 'USDC', 'DAI']);
		expect(s.some((x) => x.includes('(USDT)'))).toBe(false);
		for (const n of ['arbitrum', 'base', 'bep20', 'polygon', 'trc20']) {
			expect(s).not.toContain(`home.coin_carousel.networks.${n}_sr`);
		}
		expect(s.length).toBe(14); // 13 coins + barter
	});

	it('only USDT keeps BEP-20 and TRC-20 (its networks), not Arbitrum/Base/Polygon', async () => {
		const s = await slots(['USDC', 'DAI']);
		expect(s).toContain('home.coin_carousel.networks.bep20_sr');
		expect(s).toContain('home.coin_carousel.networks.trc20_sr');
		expect(s).not.toContain('home.coin_carousel.networks.arbitrum_sr');
		expect(s).not.toContain('home.coin_carousel.networks.polygon_sr');
	});

	it('barter off: no barter slot', async () => {
		const s = await slots(['BARTER']);
		expect(s).not.toContain('home.coin_carousel.barter.sr');
	});
});
