// @vitest-environment jsdom
/**
 * The feature-bid form (mounted in the browser runtime) never signs a bid the
 * indexer will refuse — a bid on an order that is no longer live — because
 * the BLURT moves with the op and is not returned; and after a bid is sent it
 * reports what the indexer recorded, not "featured" on faith.
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
vi.mock('$app/stores', () => ({
	page: readable({
		params: { lang: 'en' },
		data: { lang: 'en' },
		url: new URL('https://m.example/en')
	})
}));
vi.mock('svelte-i18n', () => ({
	_: readable((k: string) => k),
	locale: readable('en'),
	date: readable(() => ''),
	time: readable(() => ''),
	number: readable((n: number) => String(n))
}));
vi.mock('$stores/identity', () => {
	const st = { state: 'unlocked', live: { activePublicKey: new Uint8Array(33) } };
	return {
		identity: readable(st),
		liveIdentity: readable(st.live),
		hasAnySession: readable(true),
		isUnlocked: readable(true),
		isPairedReadOnly: readable(false)
	};
});
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'alice' }));
vi.mock('$crypto/runWithActiveKey', () => ({
	runWithActiveKey: async () => ({ ok: true, value: {} })
}));
const broadcastFeatureBid = vi.fn(async () => ({ trx_id: 'abc', blurtPaid: 1200 }));
vi.mock('$blurt/ops/featureBid', () => ({ broadcastFeatureBid }));
vi.mock('$lib/prices', () => ({ symbolAmountToUsd: async () => ({ usd: null }) }));
vi.mock('$lib/orders/fx', () => ({
	fetchFxRates: async () => ({ kind: 'error' }),
	usdToFiat: () => null
}));
// The bid-history modal is not under test: an empty component.
vi.mock('$components/FeaturedBidHistory.svelte', () => ({ default: () => {} }));

let orderStatus = 'live';
let history: {
	order_permlink: string;
	effective_at: string;
	expires_at: string;
	is_visible: boolean;
}[] = [];
vi.mock('$lib/indexer/client', () => ({
	findOrder: async () => ({ status: orderStatus, fee_status: 'verified', expires_at: null }),
	getFeaturedOrderbook: async () => ({ ok: true, data: { featured: [], max_slots: 3 } }),
	getFeaturedBidHistory: async () => ({
		ok: true,
		data: { account: 'alice', bids: history, max_slots: 3 }
	})
}));

beforeEach(() => {
	broadcastFeatureBid.mockClear();
	orderStatus = 'live';
	history = [];
});
afterEach(() => {
	document.body.innerHTML = '';
	vi.useRealTimers();
});

async function mountForm(onSuccess = vi.fn()) {
	const { mount, flushSync } = await import('svelte');
	const { default: FeatureBidForm } = await import('./FeatureBidForm.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(FeatureBidForm, {
		target,
		props: { orderPermlink: 'o-1', feeBlurtPerHour: 50, onSuccess }
	});
	await new Promise((r) => setTimeout(r, 10));
	flushSync();
	return { target, flushSync, onSuccess };
}

function clickPay(target: HTMLElement): boolean {
	const pw = target.querySelector('input[type="password"]') as HTMLInputElement | null;
	if (pw) {
		pw.value = 'hunter2';
		pw.dispatchEvent(new Event('input', { bubbles: true }));
	}
	const btn = [...target.querySelectorAll('button')].find((b) =>
		(b.textContent ?? '').includes('feature_bid.submit_button')
	);
	btn?.click();
	return btn !== undefined;
}

describe('FeatureBidForm', () => {
	it('a bid on an order that is no longer live is never signed', async () => {
		orderStatus = 'cancelled';
		const { target } = await mountForm();
		clickPay(target);
		await new Promise((r) => setTimeout(r, 10));
		expect(broadcastFeatureBid).not.toHaveBeenCalled();
		expect(target.textContent).toContain('feature_bid.blocked_not_live');
	});

	it('after sending, it reports the bid the indexer recorded', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const onSuccess = vi.fn();
		const { target } = await mountForm(onSuccess);
		expect(clickPay(target)).toBe(true);
		await vi.advanceTimersByTimeAsync(10);
		expect(broadcastFeatureBid).toHaveBeenCalledTimes(1);
		// Not "featured" before the indexer has the bid.
		expect(onSuccess).not.toHaveBeenCalled();
		history = [
			{
				order_permlink: 'o-1',
				effective_at: new Date(Date.now() + 3_600_000).toISOString(),
				expires_at: new Date(Date.now() + 90_000_000).toISOString(),
				is_visible: false
			}
		];
		await vi.advanceTimersByTimeAsync(7_000);
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(onSuccess.mock.calls[0]![0].verdict.kind).toBe('queued');
	});
});
