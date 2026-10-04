// @vitest-environment jsdom
/**
 * The 2FA page's "apps we suggest avoiding" disclosure: its summary says
 * "See which apps…" while closed and "Hide" while open.
 *
 * The real page is mounted in the browser runtime; the session, router and
 * i18n are stubbed.
 */
import { describe, expect, it, vi } from 'vitest';
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
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/stores', () => ({
	page: readable({
		params: { lang: 'en' },
		data: { lang: 'en' },
		url: new URL('https://m.example/en/settings/security/2fa')
	})
}));
vi.mock('svelte-i18n', () => ({ _: readable((k: string) => k), locale: readable('en') }));
vi.mock('$stores/identity', () => ({
	isUnlocked: readable(true),
	currentEnvelope: readable({
		v: 1,
		kdf: 'argon2id',
		salt: 'a',
		nonce: 'b',
		ciphertext: 'c',
		createdAt: 1
	}),
	commitSessionEnvelope: vi.fn()
}));
vi.mock('$components/RequireLiveSession.svelte', () => ({ default: () => {} }));

describe('2FA page: apps we suggest avoiding', () => {
	it('the summary follows the disclosure', async () => {
		const { mount, flushSync, tick } = await import('svelte');
		const { default: Page } = await import(
			'../../routes/[lang]/settings/security/2fa/+page.svelte'
		);
		const target = document.createElement('div');
		document.body.append(target);
		mount(Page, { target });
		await vi.waitFor(async () => {
			await tick();
			expect(target.querySelector('details.not-recommended')).not.toBeNull();
		});
		const details = target.querySelector<HTMLDetailsElement>('details.not-recommended')!;
		const summary = (): string => details.querySelector('summary')!.textContent!.trim();
		expect(summary()).toBe('settings.totp.not_recommended_apps.expand');
		details.open = true;
		details.dispatchEvent(new Event('toggle'));
		flushSync();
		expect(summary()).toBe('settings.totp.not_recommended_apps.collapse');
	});
});
