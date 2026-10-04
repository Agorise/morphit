/**
 * The backup page on a paired (read-only) device links to the backup page on
 * the main device. The link the page actually renders must survive the
 * `web+morphit:` protocol handler (`/pair?<encoded url>`) and land on the
 * backup page, not on home.
 */
import { describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import { render } from 'svelte/server';
import { createRequire } from 'node:module';
import { resolveWebMorphitTarget } from './resolveTarget';

vi.mock('$app/stores', () => ({
	page: readable({
		params: { lang: 'en' },
		data: { lang: 'en' },
		url: new URL('https://m.example/en/backup-keys')
	})
}));
vi.mock('svelte-i18n', async (actual) => ({
	...(await actual<typeof import('svelte-i18n')>()),
	_: readable((k: string) => k),
	locale: readable('en')
}));
vi.mock('$stores/identity', () => ({
	currentEnvelope: readable(null),
	isUnlocked: readable(false),
	isPairedReadOnly: readable(true),
	liveIdentity: readable(null),
	protectSessionWithPassword: vi.fn(),
	sessionPasswordIsEphemeral: () => false
}));

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (html: string) => { window: Window & typeof globalThis };
};

/** What the OS hands `/pair`: `?` + the percent-encoded link. */
const asPairQuery = (url: string): string => `?${encodeURIComponent(url)}`;

describe('the paired backup page link', () => {
	it('opens the backup page on the main device', async () => {
		const { default: BackupPage } = await import('../../routes/[lang]/backup-keys/+page.svelte');
		const { body } = render(BackupPage);
		const doc = new new JSDOM('').window.DOMParser().parseFromString(body, 'text/html');
		const link = Array.from(doc.querySelectorAll('a')).find((a) =>
			a.textContent?.includes('backup_keys.paired.deeplink_cta')
		);
		expect(link).toBeDefined();
		expect(resolveWebMorphitTarget(asPairQuery(link!.getAttribute('href')!))).toEqual({
			pathname: '/backup-keys',
			search: '',
			hash: ''
		});
	});

	it('stays closed to anything below it', () => {
		expect(resolveWebMorphitTarget(asPairQuery('web+morphit:///backup-keys/x'))).toBeNull();
	});
});
