// @vitest-environment jsdom
/**
 * AddressShareModal (v1.23.4): the address field's border flashes 3 times —
 * the Instances page's ?highlight=current pulse — so the eye goes straight to
 * where the receiving address is pasted. It starts once the field is on screen
 * (as the modal opens for most coins; for USDT, USDC and DAI, whose warning and
 * network picker sit above it, once scrolled to); picking another coin arms it
 * again until something is typed or pasted there; typing, pasting or focusing
 * ends it; it never glows around a field shown as invalid.
 * jsdom has no IntersectionObserver: there the field counts as on screen; the
 * observer's part is checked with a stand-in.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

import type { ChatAssetTicker } from '$lib/chat/payload';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k),
	locale: readable('en')
}));
const own = vi.hoisted(() => ({ account: 'kencode' }));
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => own.account }));
vi.mock('$blurt/accountKeys', () => ({ fetchAccountKeys: async () => null }));
vi.mock('$lib/privacy/addressHistory', () => ({
	wasSharedBefore: async () => false,
	shareAddress: async () => {}
}));

const { flushSync, mount, unmount, tick } = await import('svelte');
const { default: AddressShareModal } = await import('./AddressShareModal.svelte');

let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
	if (app) unmount(app);
	app = null;
	document.body.innerHTML = '';
	vi.useRealTimers();
	vi.unstubAllGlobals();
	own.account = 'kencode';
});

async function settle() {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
		await tick();
	}
	flushSync();
}

async function render(allowedMethods: ChatAssetTicker[] = ['btc', 'xmr']) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	app = mount(AddressShareModal, {
		target,
		props: {
			orderPermlink: 'order-8m8tafb2tsgt',
			onShare: () => {},
			onCancel: () => {},
			allowedMethods,
			coinValue: async () => null
		}
	});
	await settle();
	return target;
}

const field = (t: HTMLElement) =>
	t.querySelector('[data-testid="address-share-address"]') as HTMLInputElement;
const glows = (t: HTMLElement) => field(t).classList.contains('flash-address');
async function pick(t: HTMLElement, ticker: string) {
	(t.querySelector('button[aria-label="chat.address.asset_label"]') as HTMLButtonElement).click();
	await settle();
	const option = [...t.querySelectorAll('[role="option"] button')].find((b) =>
		b.textContent?.includes(`(${ticker})`)
	) as HTMLButtonElement;
	expect(option, ticker).toBeDefined();
	option.click();
	await settle();
}
async function type(t: HTMLElement, value: string) {
	const f = field(t);
	f.value = value;
	f.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

describe('AddressShareModal: the address field flashes (v1.23.4)', () => {
	it('from the moment the modal opens, for the three pulses', async () => {
		vi.useFakeTimers();
		const t = await render();
		expect(glows(t)).toBe(true);
		vi.advanceTimersByTime(6000);
		await settle();
		expect(glows(t)).toBe(true);
		vi.advanceTimersByTime(200);
		await settle();
		expect(glows(t)).toBe(false);
	});

	it('typing or pasting ends it, and picking another coin then does not start it again', async () => {
		vi.useFakeTimers();
		const t = await render();
		await type(t, 'bc1q');
		expect(glows(t)).toBe(false);
		await pick(t, 'XMR');
		expect(glows(t)).toBe(false);
	});

	it('focusing the field ends it (review: the pulse hid the focus ring)', async () => {
		vi.useFakeTimers();
		const t = await render();
		field(t).dispatchEvent(new FocusEvent('focus'));
		await settle();
		expect(glows(t)).toBe(false);
	});

	it('picking another coin before typing arms it again', async () => {
		vi.useFakeTimers();
		const t = await render();
		vi.advanceTimersByTime(6200);
		await settle();
		expect(glows(t)).toBe(false);
		await pick(t, 'XMR');
		expect(glows(t)).toBe(true);
	});

	it('never glows around a field shown as invalid (review)', async () => {
		vi.useFakeTimers();
		own.account = 'agorise-morphit';
		const t = await render(['btc', 'blurt']);
		// BLURT starts from the person's own account (no input event) …
		await pick(t, 'BLURT');
		expect(field(t).value).toBe('agorise-morphit');
		// … which is no BTC address: shown in red, and not glowing.
		await pick(t, 'BTC');
		expect(field(t).className).toContain('border-red-400');
		expect(glows(t)).toBe(false);
	});

	it('closing the modal mid-flash leaves no timer behind', async () => {
		vi.useFakeTimers();
		const t = await render();
		expect(glows(t)).toBe(true);
		unmount(app!);
		app = null;
		expect(vi.getTimerCount()).toBe(0);
		void t;
	});

	it("is the Instances page's pulse: brand emerald, 2 s, 3 times", () => {
		const src = readFileSync(
			resolve(process.cwd(), 'src/lib/components/AddressShareModal.svelte'),
			'utf8'
		);
		expect(src).toMatch(
			/\.flash-address\s*\{\s*animation:\s*flash-address-border\s+2s\s+ease-in-out\s+3\s*;/
		);
		expect(src).toMatch(
			/@keyframes\s+flash-address-border[\s\S]*?0 0 0 2px rgb\(var\(--brand-primary-rgb\)\)/
		);
	});
});

describe('AddressShareModal: the flash waits until the field is on screen (v1.23.4)', () => {
	const ios: FakeIO[] = [];
	class FakeIO {
		cb: IntersectionObserverCallback;
		options: IntersectionObserverInit | undefined;
		live = false;
		constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
			this.cb = cb;
			this.options = options;
			ios.push(this);
		}
		observe() {
			this.live = true;
		}
		disconnect() {
			this.live = false;
		}
		unobserve() {}
		takeRecords() {
			return [];
		}
		report(ratio: number, isIntersecting = ratio > 0) {
			if (!this.live) return;
			this.cb(
				[{ isIntersecting, intersectionRatio: ratio } as IntersectionObserverEntry],
				this as unknown as IntersectionObserver
			);
		}
	}
	const last = () => ios[ios.length - 1]!;
	const stub = () => {
		ios.length = 0;
		vi.stubGlobal('IntersectionObserver', FakeIO);
	};

	it('asks to hear at 0 and at 90 %: a field scrolled in from off-screen reports again', async () => {
		stub();
		await render();
		expect(last().options?.threshold).toEqual([0, 0.9]);
	});

	it("a stablecoin's warning and network picker above it: no flash until scrolled to, then once", async () => {
		vi.useFakeTimers();
		stub();
		const t = await render(['usdt']);
		expect(glows(t)).toBe(false);
		last().report(0.5); // half on screen: not yet
		await settle();
		expect(glows(t)).toBe(false);
		last().report(0.95, false); // not intersecting: not yet
		await settle();
		expect(glows(t)).toBe(false);
		last().report(1);
		await settle();
		expect(glows(t)).toBe(true);
		expect(last().live).toBe(false); // let go: once
		vi.advanceTimersByTime(6200);
		await settle();
		expect(glows(t)).toBe(false);
	});

	it('BTC to USDT inside the modal (review): the field glows again once scrolled to', async () => {
		vi.useFakeTimers();
		stub();
		const t = await render(['btc', 'usdt']);
		last().report(1);
		await settle();
		expect(glows(t)).toBe(true);
		await pick(t, 'USDT');
		// Pushed down by the warning and picker: off until it is on screen again.
		expect(glows(t)).toBe(false);
		expect(ios).toHaveLength(2);
		last().report(1);
		await settle();
		expect(glows(t)).toBe(true);
	});

	it('focused before it was on screen (tabbed to, which scrolls it there): it does not start', async () => {
		stub();
		const t = await render(['usdt']);
		field(t).dispatchEvent(new FocusEvent('focus'));
		await settle();
		last().report(1);
		await settle();
		expect(glows(t)).toBe(false);
	});

	it('typed into before it was ever on screen: it never glows', async () => {
		stub();
		const t = await render(['btc', 'usdt']);
		await type(t, '0xabc');
		last().report(1);
		await settle();
		expect(glows(t)).toBe(false);
		await pick(t, 'USDT');
		last().report(1);
		await settle();
		expect(glows(t)).toBe(false);
	});

	it('closing the modal lets the observer go', async () => {
		stub();
		await render();
		const io = last();
		expect(io.live).toBe(true);
		unmount(app!);
		app = null;
		expect(io.live).toBe(false);
	});
});
