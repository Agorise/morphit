// @vitest-environment jsdom
/**
 * The "🎉 Featured" card on the orderbook (v1.21.17): with a featured order
 * live, the "No featured-slot price history…" note under it is gone; the
 * orders it shows are handed to the page (which leaves them out of its list)
 * and the page's flash reaches them.
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
vi.mock('svelte-i18n', () => ({
	_: readable((k: string) => k),
	locale: readable('en')
}));
vi.mock('$lib/indexer/client', () => ({
	getClearingPriceHistory: async () => ({ ok: true, data: { points: [] } })
}));
const stub = vi.hoisted(() => ({
	live: 1,
	mounts: 0,
	props: null as null | { flashKeys?: ReadonlySet<string> }
}));
vi.mock('$components/FeaturedOrders.svelte', () => ({
	default: (
		_anchor: unknown,
		props: {
			oncount?: (n: number) => void;
			onkeys?: (k: readonly string[]) => void;
			flashKeys?: ReadonlySet<string>;
		}
	) => {
		stub.props = props;
		stub.mounts++;
		props.oncount?.(stub.live);
		props.onkeys?.(stub.live > 0 ? ['ann/o1'] : []);
	}
}));

afterEach(() => {
	document.body.innerHTML = '';
});

async function mountCard(extra: Record<string, unknown> = {}) {
	const { mount, flushSync } = await import('svelte');
	const { default: Card } = await import('./FeaturedAuctionHistory.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Card, { target, props: extra });
	await new Promise((r) => setTimeout(r, 10));
	flushSync();
	return target;
}

describe('FeaturedAuctionHistory', () => {
	it('no empty-history note while a featured order is shown', async () => {
		stub.live = 1;
		const keys = vi.fn();
		const flash = new Set(['ann/o1']);
		const target = await mountCard({ onFeaturedKeys: keys, flashKeys: flash });
		expect(target.textContent).not.toContain('clearing_price.no_history_yet');
		expect(keys).toHaveBeenCalledWith(['ann/o1']);
		expect(stub.props?.flashKeys).toBe(flash);
	});

	it('the note is there when nothing is featured', async () => {
		stub.live = 0;
		const target = await mountCard();
		expect(target.textContent).toContain('clearing_price.no_history_yet');
	});

	it('switching the 7/30/90-day window keeps the featured order on the page', async () => {
		stub.live = 1;
		stub.mounts = 0;
		const keys = vi.fn();
		const target = await mountCard({ onFeaturedKeys: keys });
		expect(stub.mounts).toBe(1);
		const ninety = [...target.querySelectorAll('button')].find((b) =>
			(b.textContent ?? '').includes('clearing_price.window_label')
		)!;
		[...target.querySelectorAll('button')].at(-1)!.click();
		await new Promise((r) => setTimeout(r, 10));
		expect(ninety).toBeDefined();
		expect(stub.mounts).toBe(1);
		expect(keys).not.toHaveBeenCalledWith([]);
		expect(target.textContent).not.toContain('clearing_price.no_history_yet');
	});
});
