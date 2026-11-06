// @vitest-environment jsdom
/**
 * AddressShareModal (v1.23.2), made grandma-friendly:
 *   - the "For order: order-…" box is gone; that text is the note's default;
 *   - "Amount you ask to be paid" is filled in for the chosen coin (11 BRL of
 *     BTC), with "BTC (≈11 BRL)" beside a shorter field, so "Share address"
 *     is ready without asking anyone "how much BTC is 11 BRL?";
 *   - only numbers can be typed, and a typed amount is never overwritten —
 *     for that coin: picking another coin fills in that coin's amount
 *     (review: 0.00003 typed for BTC is no amount of XMR).
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
	_: readable((k: string) => k),
	locale: readable('en')
}));
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'kencode' }));
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
});

/** 1 BTC = 413,505.6 BRL; 1 XMR = 3,402.3 BRL (the instance's live prices). */
const PER: Record<string, number | null> = { btc: 413505.6, xmr: 3402.3, doge: null };

async function render(props: Record<string, unknown> = {}) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	app = mount(AddressShareModal, {
		target,
		props: {
			orderPermlink: 'order-8m8tafb2tsgt',
			onShare: () => {},
			onCancel: () => {},
			allowedMethods: ['btc', 'xmr', 'doge'],
			requireAmount: true,
			orderValue: { amount: 11, currency: 'BRL' },
			coinValue: async (c: string) => PER[c] ?? null,
			...props
		}
	});
	await settle();
	return target;
}
async function settle() {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
		await tick();
	}
	flushSync();
}
const amountInput = (t: HTMLElement) =>
	t.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
const noteInput = (t: HTMLElement) =>
	t.querySelector('input[placeholder="chat.address.note_placeholder"]') as HTMLInputElement;

describe('AddressShareModal: what the trade is worth (v1.23.2)', () => {
	it("the order is the note's default text, not a box of its own", async () => {
		const t = await render();
		expect(noteInput(t).value).toBe('chat.address.pill_for_order: order-8m8tafb2tsgt');
		// The only "For order" left on screen is the note's text.
		const boxes = [...t.querySelectorAll('div')].filter(
			(d) =>
				d.children.length > 0 && d.textContent?.trim().startsWith('chat.address.pill_for_order')
		);
		expect(boxes).toHaveLength(0);
	});

	it('fills in the amount for the chosen coin, with "BTC (≈11 BRL)" beside it', async () => {
		const t = await render();
		expect(amountInput(t).value).toBe('0.0000266');
		expect(t.textContent).toContain('BTC');
		expect(t.textContent).toContain('(≈11 BRL)');
	});

	it('another coin: its own amount; a coin with no price: blank, ticker only', async () => {
		const t = await render();
		const pick = async (ticker: string) => {
			const trigger = t.querySelector(
				'button[aria-label="chat.address.asset_label"]'
			) as HTMLButtonElement;
			expect(trigger).not.toBeNull();
			trigger.click();
			await settle();
			const option = [...t.querySelectorAll('[role="option"] button')].find((b) =>
				b.textContent?.includes(`(${ticker})`)
			) as HTMLButtonElement;
			expect(option, ticker).toBeDefined();
			option.click();
			await settle();
		};
		await pick('XMR');
		expect(amountInput(t).value).toBe('0.00323311');
		expect(t.textContent).toContain('XMR');
		await pick('DOGE');
		expect(amountInput(t).value).toBe('');
		expect(t.textContent).not.toContain('(≈');
	});

	it("only numbers can be typed, and a typed amount is the person's own", async () => {
		const t = await render();
		const input = amountInput(t);
		input.value = '0.00003abc';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(input.value).toBe('0.00003');
		expect(t.textContent).toContain('(≈12.41 BRL)');
		// Another coin: its own amount, not the BTC figure.
		(t.querySelector('button[aria-label="chat.address.asset_label"]') as HTMLButtonElement).click();
		await settle();
		(
			[...t.querySelectorAll('[role="option"] button')].find((b) =>
				b.textContent?.includes('(XMR)')
			) as HTMLButtonElement
		).click();
		await settle();
		expect(amountInput(t).value).toBe('0.00323311');
	});

	it('"Share address" is ready once an address is given, without typing an amount', async () => {
		const t = await render();
		const address = t.querySelector(
			'input[autocomplete="off"]:not([inputmode])'
		) as HTMLInputElement;
		address.value = '198H97WFP6pKbQtt1WTdTVmRrPXRA7wcmW';
		address.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		const share = [...t.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'chat.address.send'
		) as HTMLButtonElement;
		expect(share).toBeDefined();
		expect(share.disabled).toBe(false);
	});
});
