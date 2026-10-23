// @vitest-environment jsdom
/**
 * v1.21.14 full chat audit, W-M5 — the chat forms check the real size budget
 * (the indexer's ciphertext cap) BEFORE anything is signed. A mailing address
 * every field of which the modal accepted was broadcast, the fee charged, and
 * then refused by the indexer; the sender only learned of it later, as "on
 * chain, not accepted". Now the form says so, with its own translated
 * message, and sends nothing. The REAL modals, mounted in the browser runtime.
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
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('svelte-i18n', () => ({ _: readable((k: string) => k), locale: readable('en') }));
vi.mock('$blurt/accountKeys', () => ({ fetchAccountKeys: async () => null }));

afterEach(() => {
	document.body.innerHTML = '';
});

async function mount(file: string, props: Record<string, unknown>) {
	const { mount: m, flushSync } = await import('svelte');
	const Comp = (await import(/* @vite-ignore */ file)).default;
	const target = document.createElement('div');
	document.body.appendChild(target);
	m(Comp, { target, props: props as never });
	flushSync();
	const set = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
		el.value = value;
		el.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	};
	return { target, set, flushSync };
}

describe('W-M5: forms refuse what the indexer would refuse', () => {
	it('mailing address: every field long — the "too long" reason is shown and Share stays off', async () => {
		const shared: string[] = [];
		const { target, set, flushSync } = await mount('./MailingAddressModal.svelte', {
			orderPermlink: 'sell-btc-1',
			onShare: (p: string) => void shared.push(p),
			onCancel: () => undefined
		});
		const country = target.querySelector('#ma-country') as HTMLSelectElement;
		country.value = 'US';
		country.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		const field = (id: string) => target.querySelector(`#${id}`) as HTMLInputElement;
		set(field('ma-street'), '北'.repeat(200));
		set(field('ma-street2'), '京'.repeat(200));
		set(field('ma-city'), '上'.repeat(100));
		set(field('ma-postal'), '200000');
		set(field('ma-note'), '请'.repeat(400));
		expect(target.textContent).toContain('mailing_address_modal.problem.too_long_to_send');
		const share = [...target.querySelectorAll('button')].find((b) =>
			(b.textContent ?? '').includes('mailing_address_modal.share_button')
		) as HTMLButtonElement;
		expect(share.disabled).toBe(true);
		share.click();
		expect(shared).toEqual([]);
		// Shortened: fine.
		set(field('ma-note'), 'timbre 2');
		set(field('ma-street2'), '');
		expect(target.textContent).not.toContain('too_long_to_send');
	});

	it('address share: a long PayJoin link makes it too long — said so, nothing sent', async () => {
		const shared: string[] = [];
		const { target, set, flushSync } = await mount('./AddressShareModal.svelte', {
			orderPermlink: 'sell-btc-' + 'x'.repeat(247),
			onShare: (p: string) => void shared.push(p),
			onCancel: () => undefined
		});
		const byPlaceholder = (p: string) =>
			target.querySelector(`input[placeholder="${p}"]`) as HTMLInputElement;
		set(
			byPlaceholder('chat.address.address_placeholder_btc'),
			'1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
		);
		const payjoin = target.querySelector('input[type="url"]') as HTMLInputElement;
		set(payjoin, 'https://payjoin.example.org/' + 'p'.repeat(480));
		set(byPlaceholder('chat.address.note_placeholder'), '请'.repeat(100));
		const send = [...target.querySelectorAll('button')].find((b) =>
			(b.textContent ?? '').includes('chat.address.send')
		) as HTMLButtonElement;
		send.click();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		flushSync();
		expect(shared).toEqual([]);
		expect(target.textContent).toContain('chat.address.too_long_to_send');
		// Without the long link it goes.
		set(payjoin, '');
		send.click();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(shared).toHaveLength(1);
	});
});
