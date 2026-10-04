/**
 * The tamper alert's "what to do" actions lead somewhere: "Compare to source"
 * opens the published source's signed releases, "Try another operator" the
 * instance list in the reader's language.
 */
import { describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import { render } from 'svelte/server';
import { createRequire } from 'node:module';

vi.mock('svelte-i18n', () => ({
	_: readable((key: string) => key),
	locale: readable('de')
}));
vi.mock('$stores/release', () => ({
	release: readable({ kind: 'error', error: { kind: 'pubkey_mismatch' } }),
	assetCheck: readable({ kind: 'pending' }),
	staleBuild: readable(false)
}));
vi.mock('$lib/updates/tamperBannerGate', () => ({
	swUpdatePending: readable(false),
	tamperGraceElapsed: readable(true)
}));

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (html: string) => { window: Window & typeof globalThis };
};

describe('tamper alert actions', () => {
	it('each action is a link', async () => {
		const { default: TamperAlertBanner } = await import('./TamperAlertBanner.svelte');
		const { body } = render(TamperAlertBanner);
		const doc = new new JSDOM('').window.DOMParser().parseFromString(body, 'text/html');
		const linkFor = (key: string) =>
			Array.from(doc.querySelectorAll('a')).find((a) => a.textContent?.trim() === key);
		const source = linkFor('release.tamper_alert.action_compare_source');
		const other = linkFor('release.tamper_alert.action_try_other_instance');
		expect(source?.getAttribute('href')).toMatch(/^https:\/\/.+\/releases$/);
		expect(source?.getAttribute('rel')).toContain('noreferrer');
		expect(other?.getAttribute('href')).toBe('/de/instances');
	});
});
