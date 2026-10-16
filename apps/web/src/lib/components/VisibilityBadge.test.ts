// @vitest-environment jsdom
/**
 * VisibilityBadge says who can see a Settings section. Each scope has its own
 * words: "instance" (offline-notice addresses, kept by this site's server) is
 * not "this device only" — saying so would be a false privacy promise.
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
vi.mock('$lib/i18n', () => ({ t: readable((k: string) => `[${k}]`) }));

afterEach(() => {
	document.body.innerHTML = '';
});

type Scope = 'public' | 'private' | 'device' | 'instance';

async function badge(scope: Scope): Promise<string> {
	const { mount, flushSync } = await import('svelte');
	const { default: Badge } = await import('./VisibilityBadge.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Badge, { target, props: { scope } });
	flushSync();
	return target.textContent!.replace(/\s+/g, ' ').trim();
}

describe('VisibilityBadge', () => {
	for (const scope of ['public', 'private', 'device', 'instance'] as const) {
		it(`"${scope}" shows its own label and explanation, and no other scope's`, async () => {
			const text = await badge(scope);
			expect(text).toContain(`[settings.visibility.${scope}]`);
			expect(text).toContain(`[settings.visibility.${scope}_detail]`);
			for (const other of ['public', 'private', 'device', 'instance'].filter((s) => s !== scope))
				expect(text).not.toContain(`[settings.visibility.${other}`);
		});
	}

	it('public is marked with the globe; the others with the lock', async () => {
		expect(await badge('public')).toContain('🌐');
		document.body.innerHTML = '';
		expect(await badge('instance')).toContain('🔒');
	});
});
