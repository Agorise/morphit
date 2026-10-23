// @vitest-environment jsdom
/**
 * A search-and-pick field opens its menu — a `fixed inset-0 backdrop-blur-sm`
 * scrim over the whole page — only for the person's own typing (v1.21.14).
 *
 * Firefox's password manager wrote the saved login name into the "Also show
 * orders in" language field on /settings as the page loaded: an `input` event
 * (trusted, inputType insertReplacementText, field marked :autofill) while the
 * page itself had focus. The menu opened and the page stayed blurred until the
 * next click. Typing needs the field focused; autofill does not.
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
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k),
	locale: readable('en')
}));

afterEach(() => {
	document.body.innerHTML = '';
});

async function mount(name: 'LanguageFilterSelect' | 'FiatCurrencySelect' | 'PaymentFilterSelect') {
	const { mount: m, flushSync } = await import('svelte');
	const mod =
		name === 'LanguageFilterSelect'
			? await import('./LanguageFilterSelect.svelte')
			: name === 'FiatCurrencySelect'
				? await import('./FiatCurrencySelect.svelte')
				: await import('./PaymentFilterSelect.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	m(mod.default, { target, props: { value: [] } as never });
	flushSync();
	const input = target.querySelector('input[role="combobox"]') as HTMLInputElement;
	const scrim = () => document.querySelector('button.fixed.inset-0');
	const fill = (text: string) => {
		input.value = text;
		input.dispatchEvent(
			new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' })
		);
		flushSync();
	};
	return { input, scrim, fill, flushSync };
}

describe.each(['LanguageFilterSelect', 'FiatCurrencySelect', 'PaymentFilterSelect'] as const)(
	'%s',
	(name) => {
		it('text written in by a password manager (field not focused): no menu, no blur, field left empty', async () => {
			const { input, scrim, fill } = await mount(name);
			expect(document.activeElement).not.toBe(input);
			fill('morphit');
			expect(scrim()).toBeNull();
			expect(input.getAttribute('aria-expanded')).toBe('false');
			expect(input.value).toBe('');
		});

		it('the person typing (field focused): the menu opens, as before', async () => {
			const { input, scrim, fill } = await mount(name);
			input.focus();
			fill('e');
			expect(input.getAttribute('aria-expanded')).toBe('true');
			expect(scrim()).not.toBeNull();
			expect(input.value).toBe('e');
		});
	}
);
