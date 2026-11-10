// @vitest-environment jsdom
/**
 * AddressShareModal (v1.24.0): a Hive, Steem or BitShares "address" is the
 * account name, the same in every trade (a new one is a new account, which
 * costs a fee). So where a crypto-for-crypto seller asks to be paid, the
 * window does not demand a never-shared address for these coins as it does
 * for the others (v1.21.17): it lets the account be shared again and says to
 * check the payment in the wallet. An invalid account name shows its error
 * from 3 characters on, like a Blurt account's.
 */
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
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'kencode' }));
vi.mock('$blurt/accountKeys', () => ({ fetchAccountKeys: async () => null }));
// Every address was shared from this device before.
vi.mock('$lib/privacy/addressHistory', () => ({
	wasSharedBefore: async () => true,
	shareAddress: async (_coin: string, _address: string, send: () => Promise<void>) => send()
}));

const { flushSync, mount, unmount, tick } = await import('svelte');
const { default: AddressShareModal } = await import('./AddressShareModal.svelte');

let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
	if (app) unmount(app);
	app = null;
	document.body.innerHTML = '';
});
async function settle() {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
		await tick();
	}
	flushSync();
}
let shared: Array<{ text: string }> = [];
async function render(allowedMethods: ChatAssetTicker[], requireAmount = true) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	shared = [];
	app = mount(AddressShareModal, {
		target,
		props: {
			orderPermlink: 'order-8m8tafb2tsgt',
			onShare: (text: string) => {
				shared.push({ text });
			},
			onCancel: () => {},
			allowedMethods,
			requireAmount,
			orderValue: { amount: 11, currency: 'BRL' },
			coinValue: async () => 0.05
		}
	});
	await settle();
	return target;
}
const field = (t: HTMLElement) =>
	t.querySelector('[data-testid="address-share-address"]') as HTMLInputElement;
async function type(t: HTMLElement, value: string) {
	const f = field(t);
	f.value = value;
	f.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}
const shareButton = (t: HTMLElement) =>
	[...t.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'chat.address.send') as
		| HTMLButtonElement
		| undefined;

describe('AddressShareModal: account-name coins (v1.24.0)', () => {
	for (const [coin, note, other] of [
		// HIVE / STEEM: the chat checks the payment by its transaction id.
		['hive', 'chat.address.reuse_account_checked_body', 'chat.address.reuse_account_body'],
		['steem', 'chat.address.reuse_account_checked_body', 'chat.address.reuse_account_body'],
		// BTS: no lookup by transaction id; the seller checks his wallet.
		['bts', 'chat.address.reuse_account_body', 'chat.address.reuse_account_checked_body']
	] as const) {
		it(`${coin}: an account shared before can be shared again, with ${note}`, async () => {
			const t = await render([coin]);
			await type(t, 'bobtrader');
			expect(t.textContent).toContain(note);
			expect(t.textContent).not.toContain(other);
			expect(t.textContent).not.toContain('chat.address.reuse_blocked_body');
			expect(shareButton(t)?.disabled).toBe(false);
		});
	}

	it('a coin with fresh addresses is still blocked when the address was shared before', async () => {
		const t = await render(['btc']);
		await type(t, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
		expect(t.textContent).toContain('chat.address.reuse_blocked_body');
		expect(t.textContent).not.toContain('chat.address.reuse_account_body');
		expect(shareButton(t)?.disabled).toBe(true);
	});

	it('v1.24.0 review: a buyer sharing his receiving account (no amount required) gets no seller note', async () => {
		for (const coin of ['hive', 'steem', 'bts'] as const) {
			const t = await render([coin], false);
			await type(t, 'bobtrader');
			expect(t.textContent).not.toContain('chat.address.reuse_account_checked_body');
			expect(t.textContent).not.toContain('chat.address.reuse_account_body');
			if (app) unmount(app);
			app = null;
			document.body.innerHTML = '';
		}
	});

	it('v1.24.0 review: a paid seller’s HIVE ask carries a memo, shown in the window and required', async () => {
		const t = await render(['hive']);
		await type(t, 'bobtrader');
		expect(t.textContent).toContain('chat.address.memo_label');
		const code = [...t.querySelectorAll('code')].map((c) => c.textContent?.trim() ?? '');
		const memo = code.find((c) => /^[a-z0-9]{8}$/.test(c));
		expect(memo).toBeDefined();
		// No "skip memo" for a paid seller: the memo is what ties the payment.
		expect(t.textContent).not.toContain('chat.address.memo_skip');
		shareButton(t)!.click();
		await settle();
		const { decodePayload } = await import('$lib/chat/payload');
		const sent = decodePayload(shared[0]!.text);
		expect(sent).toMatchObject({ payload: { method: 'hive', address: 'bobtrader', memo } });
	});

	it('an invalid account name shows its error from 3 characters on', async () => {
		const t = await render(['hive']);
		await type(t, 'Bob');
		expect(t.textContent).toContain('chat.address.address_invalid_hive');
		// v1.24.0 review: the chains' own rule — every part between dots has 3+.
		await type(t, 'ab.cd');
		expect(t.textContent).toContain('chat.address.address_invalid_hive');
	});
});
