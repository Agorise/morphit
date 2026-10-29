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
const idState = vi.hoisted(() => ({ hasActive: true }));
vi.mock('$stores/identity', () => {
	const st = { state: 'unlocked', live: { activePublicKey: new Uint8Array(33) } };
	return {
		identity: readable(st),
		liveIdentity: {
			subscribe: (fn: (v: unknown) => void) => {
				fn({ activePublicKey: idState.hasActive ? new Uint8Array(33) : null });
				return () => {};
			}
		},
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
vi.mock('$blurt/ops/featureBid', () => ({
	broadcastFeatureBid,
	featureBidMemoFor: (p: string) => `morphit-feature:${p}`
}));
// The wallet's live balance (v1.21.17): a store the test sets.
const { writable: liquidWritable } = await import('svelte/store');
const liquid = liquidWritable<
	{ kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; liquidBlurt: number }
>({ kind: 'ok', liquidBlurt: 100_000 });
vi.mock('$lib/balance/liquidBlurt', () => ({ watchLiquidBlurt: () => liquid }));
vi.mock('$lib/prices', () => ({ symbolAmountToUsd: async () => ({ usd: null }) }));
vi.mock('$lib/orders/fx', () => ({
	fetchFxRates: async () => ({ kind: 'error' }),
	usdToFiat: () => null
}));
// A posting-only session's Active-key window: a stub that hands the test the
// callback it was given.
const unlock = vi.hoisted(() => ({
	onUnlocked: null as null | ((k: Uint8Array) => Promise<void>)
}));
vi.mock('$components/UnlockActiveKeyModal.svelte', () => ({
	default: (_anchor: unknown, props: { onUnlocked: (k: Uint8Array) => Promise<void> }) => {
		unlock.onUnlocked = props.onUnlocked;
	}
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
	idState.hasActive = true;
	unlock.onUnlocked = null;
	broadcastFeatureBid.mockClear();
	liquid.set({ kind: 'ok', liquidBlurt: 100_000 });
	orderStatus = 'live';
	history = [];
});
afterEach(() => {
	document.body.innerHTML = '';
	vi.useRealTimers();
});

async function mountForm(onSuccess = vi.fn(), onCancel?: () => void) {
	const { mount, flushSync } = await import('svelte');
	const { default: FeatureBidForm } = await import('./FeatureBidForm.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(FeatureBidForm, {
		target,
		props: { orderPermlink: 'o-1', feeBlurtPerHour: 50, onSuccess, onCancel }
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

	it('out of BLURT: the chain’s fee refusal reads "insufficient funds", any other refusal keeps its reason', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { ChainRejectedError } = await import('$blurt/broadcastTransport');
		broadcastFeatureBid.mockImplementationOnce(async () => {
			throw new ChainRejectedError(
				'Assert Exception:acnt.balance >= fee: Account does not have sufficient funds for transaction fee.'
			);
		});
		const { target } = await mountForm();
		clickPay(target);
		await vi.advanceTimersByTimeAsync(30);
		expect(target.textContent).toContain('common.broadcast_err.low_blurt');
		expect(target.textContent).not.toContain('feature_bid.error_chain_rejected');
		document.body.innerHTML = '';
		broadcastFeatureBid.mockImplementationOnce(async () => {
			throw new ChainRejectedError('missing required active authority');
		});
		const second = await mountForm();
		clickPay(second.target);
		await vi.advanceTimersByTimeAsync(30);
		expect(second.target.textContent).toContain('feature_bid.error_chain_rejected');
		expect(second.target.textContent).not.toContain('common.broadcast_err.low_blurt');
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

	it('shows the live balance beside the cost, and asks for nothing until it covers the bid and its network fee', async () => {
		// 24 h × 50 = 1200 BLURT, plus a network fee of well under 1 BLURT.
		liquid.set({ kind: 'ok', liquidBlurt: 1200 });
		const { target, flushSync } = await mountForm();
		const balance = target.querySelector('[data-testid="feature-balance"]');
		expect(balance?.textContent).toContain('feature_bid.balance_label');
		expect(balance?.textContent).toContain('1200.000 BLURT');
		expect(target.textContent).toContain('feature_bid.balance_short');
		const pay = () =>
			[...target.querySelectorAll('button')].find((b) =>
				(b.textContent ?? '').includes('feature_bid.submit_button')
			) as HTMLButtonElement;
		const pw = () => target.querySelector('input[type="password"]') as HTMLInputElement;
		expect(pay().disabled).toBe(true);
		expect(pw().disabled).toBe(true);
		pay().click();
		await new Promise((r) => setTimeout(r, 10));
		expect(broadcastFeatureBid).not.toHaveBeenCalled();
		// The wallet is topped up: the form follows at once.
		liquid.set({ kind: 'ok', liquidBlurt: 1201 });
		flushSync();
		expect(target.textContent).not.toContain('feature_bid.balance_short');
		expect(pay().disabled).toBe(false);
		expect(pw().disabled).toBe(false);
		// Still being read: nothing to type into yet.
		liquid.set({ kind: 'loading' });
		flushSync();
		expect(pay().disabled).toBe(true);
		// Could not be read: not blocked (the chain still refuses a payment the
		// account cannot make).
		liquid.set({ kind: 'error' });
		flushSync();
		expect(pay().disabled).toBe(false);
	});

	it('right after "Pay and Feature" the password, its label and both buttons are gone', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let finish: (v: { trx_id: string; blurtPaid: number }) => void = () => {};
		broadcastFeatureBid.mockImplementationOnce(() => new Promise((r) => (finish = r)));
		const { target } = await mountForm(vi.fn(), () => {});
		expect(target.textContent).toContain('feature_bid.cancel_button');
		expect(clickPay(target)).toBe(true);
		await vi.advanceTimersByTimeAsync(5);
		expect(target.querySelector('input[type="password"]')).toBeNull();
		expect(target.textContent).not.toContain('feature_bid.password_label');
		expect(target.textContent).not.toContain('feature_bid.submit_button');
		expect(target.textContent).not.toContain('feature_bid.cancel_button');
		expect(target.querySelector('[data-testid="feature-broadcasting"]')).not.toBeNull();
		// Sent; waiting for the indexer: still nothing to press.
		finish({ trx_id: 'abc', blurtPaid: 1200 });
		await vi.advanceTimersByTimeAsync(5);
		expect(target.textContent).toContain('feature_bid.confirming');
		expect(target.querySelector('input[type="password"]')).toBeNull();
		expect(target.textContent).not.toContain('feature_bid.submit_button');
	});

	it('a refused bid brings the password and buttons back to try again', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { ChainRejectedError } = await import('$blurt/broadcastTransport');
		broadcastFeatureBid.mockImplementationOnce(async () => {
			throw new ChainRejectedError('missing required active authority');
		});
		const { target } = await mountForm();
		clickPay(target);
		await vi.advanceTimersByTimeAsync(30);
		expect(target.querySelector('input[type="password"]')).not.toBeNull();
		expect(target.textContent).toContain('feature_bid.submit_button');
	});

	it('posting-only: no Active-key window while short, and a key that arrives after the balance dropped pays nothing', async () => {
		idState.hasActive = false;
		liquid.set({ kind: 'ok', liquidBlurt: 10 });
		const { flushSync } = await mountForm();
		expect(unlock.onUnlocked).toBeNull();
		liquid.set({ kind: 'ok', liquidBlurt: 5_000 });
		flushSync();
		const handOver = unlock.onUnlocked!;
		expect(handOver).not.toBeNull();
		// The wallet empties while the key is being checked.
		liquid.set({ kind: 'ok', liquidBlurt: 10 });
		flushSync();
		const key = new Uint8Array(32).fill(7);
		await handOver(key);
		expect(broadcastFeatureBid).not.toHaveBeenCalled();
		expect([...key].every((b) => b === 0)).toBe(true);
		// With the BLURT there, the same hand-over pays.
		liquid.set({ kind: 'ok', liquidBlurt: 5_000 });
		flushSync();
		void handOver(new Uint8Array(32).fill(7));
		await new Promise((r) => setTimeout(r, 10));
		expect(broadcastFeatureBid).toHaveBeenCalledTimes(1);
	});
});
