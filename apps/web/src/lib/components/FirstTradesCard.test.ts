// @vitest-environment jsdom
/**
 * FirstTradesCard (v1.21.5): the homepage invitation to sign in and make a
 * first few trades. The reward tiles appear only on a site whose relay pays
 * them (a site with an operator tag, as RewardsPanel); someone with an account
 * on this device is sent to post or browse, not to sign up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable, writable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/stores', () => ({ page: readable({ data: { lang: 'en' } }) }));
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k),
	locale: readable('en')
}));
const inst = writable({ loaded: true, operator_tag: 'morphit' as string | null });
vi.mock('$stores/instance', () => ({ instance: { subscribe: inst.subscribe } }));
const session = writable(false);
vi.mock('$stores/identity', () => ({ hasAnySession: { subscribe: session.subscribe } }));
let persisted = false;
vi.mock('$crypto/persistentKeystore', () => ({ hasPersistedKeystore: () => persisted }));

afterEach(() => {
	document.body.innerHTML = '';
});

async function render(): Promise<HTMLElement> {
	const { mount, flushSync } = await import('svelte');
	const { default: Card } = await import('./FirstTradesCard.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Card, { target });
	flushSync();
	return target;
}

describe('FirstTradesCard', () => {
	it('a visitor on a site that pays rewards: the rewards, and the free signup first', async () => {
		inst.set({ loaded: true, operator_tag: 'morphit' });
		session.set(false);
		persisted = false;
		const t = await render();
		expect(t.querySelector('[data-testid="first-trades-rewards"]')).not.toBeNull();
		const primary = t.querySelector<HTMLAnchorElement>('[data-testid="first-trades-primary"]')!;
		expect(primary.getAttribute('href')).toBe('/en/onboarding');
		expect(primary.textContent).toContain('home.first_trades.cta_signup_free');
		expect(t.querySelector('a[href="/en/login"]')).not.toBeNull();
	});

	it('a site without an operator tag claims no rewards', async () => {
		inst.set({ loaded: true, operator_tag: null });
		session.set(false);
		persisted = false;
		const t = await render();
		expect(t.querySelector('[data-testid="first-trades-rewards"]')).toBeNull();
		expect(t.textContent).not.toContain('home.first_trades.cta_signup_free');
		expect(t.textContent).toContain('home.first_trades.cta_signup');
	});

	it('someone with an account on this device (signed in or locked) is sent to trade', async () => {
		inst.set({ loaded: true, operator_tag: 'morphit' });
		for (const [s, p] of [
			[true, false],
			[false, true]
		] as const) {
			session.set(s);
			persisted = p;
			const t = await render();
			const primary = t.querySelector<HTMLAnchorElement>('[data-testid="first-trades-primary"]')!;
			expect(primary.getAttribute('href')).toBe('/en/post');
			expect(t.querySelector('a[href="/en/onboarding"]')).toBeNull();
			document.body.innerHTML = '';
		}
	});
});
