// @vitest-environment jsdom
/**
 * RewardsPanel ("What you get on {brand}", v1.21.3): rewards are paid by the
 * relay of the site whose operator tag is on the order, so a site without an
 * operator tag pays none and must not list them; on the orderbook the list
 * starts rolled up so the orders stay near the top, with the signup button
 * always there.
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

afterEach(() => {
	document.body.innerHTML = '';
});

async function render(props: Record<string, unknown>): Promise<HTMLElement> {
	const { mount, flushSync } = await import('svelte');
	const { default: RewardsPanel } = await import('./RewardsPanel.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(RewardsPanel, { target, props });
	flushSync();
	return target;
}

describe('RewardsPanel', () => {
	it('lists every reward on a site that pays them', async () => {
		inst.set({ loaded: true, operator_tag: 'morphit' });
		const t = await render({});
		for (const k of [
			'free_account',
			'free_buy',
			'welcome_stake',
			'first_trade',
			'loyalty',
			'top_up'
		])
			expect(t.textContent).toContain(`rewards.${k}_title`);
		expect(t.querySelector('a[href="/en/onboarding"]')).toBeNull();
	});

	it('is not shown on a site without an operator tag (its relay pays no rewards)', async () => {
		inst.set({ loaded: true, operator_tag: null });
		const t = await render({ showSignup: true });
		expect(t.querySelector('[data-testid="rewards-panel"]')).toBeNull();
	});

	it('on the orderbook: rolled up, signup button shown, the list opens on request', async () => {
		inst.set({ loaded: true, operator_tag: 'morphit' });
		const { flushSync } = await import('svelte');
		const t = await render({ showSignup: true, collapsible: true });
		expect(t.textContent).not.toContain('rewards.loyalty_title');
		expect(t.querySelector('a[href="/en/onboarding"]')).not.toBeNull();
		const toggle = t.querySelector<HTMLButtonElement>(
			'button[aria-controls="rewards-panel-list"]'
		)!;
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		toggle.click();
		flushSync();
		expect(t.textContent).toContain('rewards.loyalty_title');
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
	});
});
