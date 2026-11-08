// @vitest-environment jsdom
/**
 * v1.23.4 — owner: "i got a notification on my avatar though for the orders so
 * i clicked it, but the green badge on my avatar did not disappear when i
 * clicked on Orders in that menu. since there was only 1 notification, the
 * badge should have disappeared." The REAL AvatarMenu and notification store.
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
vi.mock('$app/stores', () => ({
	page: readable({
		params: { lang: 'en' },
		data: { lang: 'en' },
		url: new URL('https://m.example/en')
	})
}));
vi.mock('svelte-i18n', () => ({
	_: readable((k: string) => k),
	locale: readable('en')
}));
const went = vi.hoisted(() => [] as string[]);
vi.mock('$i18n/navigate', () => ({ gotoLocale: async (p: string) => void went.push(p) }));
vi.mock('$stores/identity', () => ({
	liveIdentity: readable(null),
	isPairedReadOnly: readable(false),
	pairedReadOnly: readable(null),
	hasAnySession: readable(true),
	broadcastSignOut: () => {},
	lockAllTabs: () => {}
}));
vi.mock('$crypto/persistentKeystore', () => ({ persistedKeystorePresent: readable(false) }));
vi.mock('$stores/backupPending', () => ({ backupMaterialPending: readable(false) }));
vi.mock('$utils/backupVisited', () => ({ backupVisited: writable(true) }));
vi.mock('$blurt/ops/profile', () => ({
	getUserBlurtAccount: () => 'kencode',
	blurtAccountName: readable('kencode')
}));
vi.mock('$lib/stores/selfProfile', () => ({
	selfProfile: readable({
		account: 'kencode',
		displayName: null,
		avatarSvg: null,
		avatarDataUri: null
	}),
	refreshSelfProfile: async () => {}
}));
vi.mock('$lib/notifications/native', () => ({ maybeFireNativeNotification: () => {} }));
vi.mock('$lib/notifications/audio', () => ({ maybePlayChime: () => {} }));
vi.mock('$lib/notifications/vibrate', () => ({ maybeVibrate: () => {} }));

afterEach(() => {
	document.body.innerHTML = '';
	went.length = 0;
});

describe('AvatarMenu → Notifications → Orders (v1.23.4)', () => {
	it('clears the one order notification, and the badge with it', async () => {
		const n = await import('$lib/notifications');
		n.markRead();
		n.notify({ category: 'order', title: 't', body: 'b', id: 'fill-1' });
		const { mount, flushSync } = await import('svelte');
		const { default: AvatarMenu } = await import('./AvatarMenu.svelte');
		const target = document.createElement('div');
		document.body.append(target);
		mount(AvatarMenu, { target });
		flushSync();
		const trigger = target.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
		expect(trigger.getAttribute('aria-label')).toBe('avatar_menu.open_with_count');
		trigger.click();
		flushSync();
		const byText = (t: string) =>
			[...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
				(b.textContent ?? '').includes(t)
			)!;
		byText('avatar_menu.notifications').click();
		flushSync();
		byText('avatar_menu.category.order_help').click();
		flushSync();
		expect(went).toEqual(['/my/orders']);
		const { get } = await import('svelte/store');
		expect(get(n.unreadCount).order).toBe(0);
		expect(trigger.getAttribute('aria-label')).toBe('avatar_menu.open');
	});

	it('the Feedback row clears feedback, not orders', async () => {
		const n = await import('$lib/notifications');
		n.markRead();
		n.notify({ category: 'order', title: 't', body: 'b', id: 'fill-2' });
		n.notify({ category: 'feedback', title: 't', body: 'b', id: 'fb-1' });
		const { mount, flushSync } = await import('svelte');
		const { default: AvatarMenu } = await import('./AvatarMenu.svelte');
		const target = document.createElement('div');
		document.body.append(target);
		mount(AvatarMenu, { target });
		flushSync();
		target.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click();
		flushSync();
		const byText = (t: string) =>
			[...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
				(b.textContent ?? '').includes(t)
			)!;
		byText('avatar_menu.notifications').click();
		flushSync();
		byText('avatar_menu.category.feedback_help').click();
		flushSync();
		const { get } = await import('svelte/store');
		expect(get(n.unreadCount)).toMatchObject({ order: 1, feedback: 0 });
	});
});
