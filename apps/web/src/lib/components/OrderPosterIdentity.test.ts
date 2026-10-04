// @vitest-environment jsdom
/**
 * While the poster's profile is loading, the order's "posted by" row shows a
 * placeholder — not the bare @handle that then swaps to the display name,
 * the same rule IdentityLabel follows.
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
vi.mock('$blurt/postingKeyResolver', () => ({ resolvePostingKey: async () => null }));

afterEach(() => {
	document.body.innerHTML = '';
});

async function render(pending: boolean, displayName: string | null): Promise<HTMLElement> {
	const { mount, flushSync } = await import('svelte');
	const { default: OrderPosterIdentity } = await import('./OrderPosterIdentity.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(OrderPosterIdentity, {
		target,
		props: {
			order: { account: 'alice', posting_pubkey: null } as never,
			pending,
			displayName,
			profileHref: '/en/@alice'
		}
	});
	flushSync();
	return target;
}

describe('OrderPosterIdentity name while the profile loads', () => {
	it('pending: no @handle link yet', async () => {
		const t = await render(true, null);
		expect(t.querySelector('a[href="/en/@alice"]')).toBeNull();
		expect(t.textContent).not.toContain('@alice');
	});
	it('resolved without a display name: the @handle', async () => {
		const t = await render(false, null);
		expect(t.querySelector('a[href="/en/@alice"]')?.textContent?.trim()).toBe('@alice');
	});
	it('resolved with a display name: the name', async () => {
		const t = await render(false, 'Alice A.');
		expect(t.querySelector('a[href="/en/@alice"]')?.textContent?.trim()).toBe('Alice A.');
	});
});
