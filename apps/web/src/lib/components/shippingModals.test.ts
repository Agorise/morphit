// @vitest-environment jsdom
/**
 * The mailing-address and shipment modals, mounted in the browser runtime:
 * a country outside the short list can be typed, country names are in the
 * reader's language, and a value the payload encoder refuses is caught by the
 * same rule before sending and explained with a translated message, never
 * the encoder's developer text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

// The browser build of svelte (vitest resolves the server one by default).
vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('svelte-i18n', () => ({
	_: readable((k: string) => k),
	locale: readable('de')
}));

afterEach(() => {
	document.body.innerHTML = '';
});

async function mountModal(which: 'mailing' | 'shipment') {
	const { mount, flushSync } = await import('svelte');
	const Comp =
		which === 'mailing'
			? (await import('./MailingAddressModal.svelte')).default
			: (await import('./ShipmentModal.svelte')).default;
	const shared: string[] = [];
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Comp, {
		target,
		props: { onShare: (p: string) => void shared.push(p), onCancel: () => {} }
	});
	flushSync();
	const set = (sel: string, value: string, ev = 'input') => {
		const el = target.querySelector(sel) as HTMLInputElement | HTMLSelectElement;
		el.value = value;
		el.dispatchEvent(new Event(ev, { bubbles: true }));
		flushSync();
	};
	const shareButton = () =>
		[...target.querySelectorAll('button')].find((b) =>
			/share_button|record_button|send/.test(b.textContent ?? '')
		) as HTMLButtonElement;
	return { target, set, shared, shareButton, flushSync };
}

describe('MailingAddressModal', () => {
	it('"Other" country: the ISO box stays while typing and its code is sent', async () => {
		const m = await mountModal('mailing');
		m.set('#ma-country', '__other__', 'change');
		const iso = () => m.target.querySelector('#ma-country-other') as HTMLInputElement | null;
		expect(iso()).not.toBeNull();
		m.set('#ma-country-other', 'n');
		expect(iso()).not.toBeNull();
		m.set('#ma-country-other', 'nz');
		m.set('#ma-street', '1 Example Street');
		m.set('#ma-city', 'Auckland');
		m.set('#ma-postal', '1010');
		expect(m.shareButton().disabled).toBe(false);
		m.shareButton().click();
		await Promise.resolve();
		expect(m.shared).toHaveLength(1);
		expect(JSON.parse(m.shared[0]!).country).toBe('NZ');
	});

	it('country names are in the reader’s language', async () => {
		const m = await mountModal('mailing');
		const de = m.target.querySelector('#ma-country option[value="DE"]')!;
		expect(de.textContent).toContain('Deutschland');
		expect(de.textContent).not.toContain('Germany');
	});

	it('a TAB in the note blocks sending with the translated reason', async () => {
		const m = await mountModal('mailing');
		m.set('#ma-country', 'US', 'change');
		m.set('#ma-street', '1 Main St');
		m.set('#ma-city', 'Springfield');
		m.set('#ma-postal', '12345');
		m.set('#ma-note', 'ring\tthe bell');
		expect(m.shareButton().disabled).toBe(true);
		const text = m.target.textContent ?? '';
		expect(text).toContain('mailing_address_modal.problem.note_forbidden_chars');
		expect(text).not.toContain('payload:');
	});

	it('a street of spaces is not an address', async () => {
		const m = await mountModal('mailing');
		m.set('#ma-country', 'US', 'change');
		m.set('#ma-street', '   ');
		m.set('#ma-city', 'Springfield');
		m.set('#ma-postal', '12345');
		expect(m.shareButton().disabled).toBe(true);
	});
});

describe('ShipmentModal', () => {
	it('a TAB in the note blocks sending with the translated reason', async () => {
		const m = await mountModal('shipment');
		m.set('#sh-carrier', 'usps', 'change');
		m.set('#sh-tracking', '9400100000000000000000');
		m.set('#sh-note', 'left at\tdoor');
		expect(m.shareButton().disabled).toBe(true);
		const text = m.target.textContent ?? '';
		expect(text).toContain('shipment_modal.problem.note_forbidden_chars');
		expect(text).not.toContain('payload:');
	});

	it('a send that fails shows a translated message, not the exception text', async () => {
		const { mount, flushSync } = await import('svelte');
		const { default: ShipmentModal } = await import('./ShipmentModal.svelte');
		const target = document.createElement('div');
		document.body.appendChild(target);
		mount(ShipmentModal, {
			target,
			props: {
				onShare: async () => {
					throw new Error('TypeError: Failed to fetch at chatService.ts:1203');
				},
				onCancel: () => {}
			}
		});
		flushSync();
		const set = (sel: string, value: string, ev = 'input') => {
			const el = target.querySelector(sel) as HTMLInputElement;
			el.value = value;
			el.dispatchEvent(new Event(ev, { bubbles: true }));
			flushSync();
		};
		set('#sh-carrier', 'usps', 'change');
		set('#sh-tracking', '9400100000000000000000');
		const btn = [...target.querySelectorAll('button')].find((b) =>
			/record_button|share_button/.test(b.textContent ?? '')
		) as HTMLButtonElement;
		btn.click();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		const text = target.textContent ?? '';
		expect(text).toContain('shipment_modal.send_failed');
		expect(text).not.toContain('Failed to fetch');
	});
});
