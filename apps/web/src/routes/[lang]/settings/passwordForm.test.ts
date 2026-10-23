/**
 * The change-password fields are their own form, with the account as its
 * user name (v1.21.14). Outside a form, Firefox's password manager treated
 * every field of /settings as one login form and wrote the saved login name
 * into the "Also show orders in" language field as the page loaded — the
 * field's menu opened and the page stayed blurred until the next click. With
 * its own form and user-name field, the password manager fills only there.
 */
import { describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import { render } from 'svelte/server';
import { createRequire } from 'node:module';

vi.mock('$app/stores', () => ({
	page: readable({
		params: { lang: 'en' },
		data: { lang: 'en' },
		url: new URL('https://m.example/en/settings')
	})
}));
vi.mock('svelte-i18n', async (actual) => ({
	...(await actual<typeof import('svelte-i18n')>()),
	_: readable((k: string) => k),
	locale: readable('en')
}));
vi.mock('$stores/identity', async (actual) => ({
	...(await actual<typeof import('$stores/identity')>()),
	isUnlocked: readable(true),
	isPairedReadOnly: readable(false),
	hasAnySession: readable(true)
}));
vi.mock('$crypto/persistentKeystore', async (actual) => ({
	...(await actual<typeof import('$crypto/persistentKeystore')>()),
	hasPersistedKeystore: () => true,
	persistedKeystorePresent: readable(true)
}));
vi.mock('$stores/sessionAccount', async (actual) => ({
	...(await actual<typeof import('$stores/sessionAccount')>()),
	sessionAccountName: () => 'anna'
}));
// The user name follows the signed-in account (the store), so a name set on
// this page reaches the form at once.
vi.mock('$blurt/ops/profile', async (actual) => ({
	...(await actual<typeof import('$blurt/ops/profile')>()),
	blurtAccountName: readable('anna')
}));

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (html: string) => { window: Window & typeof globalThis };
};

describe('/settings password fields', () => {
	it('are one form of their own, with the account as its user name; no other field is in it', async () => {
		const { default: Page } = await import('./+page.svelte');
		const { body } = render(Page);
		const doc = new JSDOM(`<!doctype html><body>${body}</body>`).window.document;
		const pw = [...doc.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
		expect(pw.length).toBe(3);
		const form = pw[0]!.closest('form');
		expect(form).not.toBeNull();
		expect(pw.every((i) => i.closest('form') === form)).toBe(true);
		const user = form!.querySelector('input[autocomplete="username"]') as HTMLInputElement;
		expect(user?.getAttribute('value')).toBe('anna');
		// Every other text field of the page is outside it.
		const others = [
			...doc.querySelectorAll('input:not([type]), input[type="text"], textarea')
		].filter((i) => i !== user);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every((i) => i.closest('form') !== form)).toBe(true);
	});
});
