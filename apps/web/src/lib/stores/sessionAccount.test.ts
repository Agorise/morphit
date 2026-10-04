// @vitest-environment jsdom
/**
 * A browser that remembers an account name but holds no session (a locked
 * visit) must not name that account to the operator: the components that
 * read "my" data on every page stay silent until there is a session, and do
 * read it once there is one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const session = writable<'locked' | 'unlocked'>('locked');
vi.mock('$stores/identity', async () => {
	const { derived } = await import('svelte/store');
	return {
		identity: derived(session, (s) => ({ state: s })),
		liveIdentity: derived(session, (s) => (s === 'unlocked' ? { posting: {} } : null)),
		hasAnySession: derived(session, (s) => s === 'unlocked'),
		isUnlocked: derived(session, (s) => s === 'unlocked'),
		isPairedReadOnly: readable(false)
	};
});
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'alice' }));

const requested: string[] = [];
beforeEach(() => {
	requested.length = 0;
	session.set('locked');
	vi.stubGlobal('fetch', async (url: string) => {
		requested.push(String(url));
		return new Response(JSON.stringify({ blocked: false, items: [] }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = '';
});

async function mountComponent(path: string): Promise<void> {
	const { mount, flushSync } = await import('svelte');
	const mod = (await import(/* @vite-ignore */ path)) as { default: never };
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(mod.default, { target, props: {} as never });
	flushSync();
	// The mount effects ran inside flushSync, and each component reaches its
	// fetch synchronously from there; one event-loop turn also lets any
	// promise-deferred step run.
	await new Promise((r) => setTimeout(r, 0));
}

const namesAlice = () => requested.filter((u) => u.includes('alice'));

describe('locked visit with a remembered account name', () => {
	it('the operator-block banner asks nothing, then asks once a session exists', async () => {
		await mountComponent('$components/OperatorBlockBanner.svelte');
		expect(namesAlice()).toEqual([]);
		session.set('unlocked');
		await vi.waitFor(() => expect(namesAlice().length).toBeGreaterThan(0));
	});

	it('the first-buy hero on the orderbook asks nothing', async () => {
		await mountComponent('$components/WelcomeFirstBuyHero.svelte');
		expect(namesAlice()).toEqual([]);
	});

	it('the first-post starter pack asks nothing', async () => {
		await mountComponent('$components/FirstPostStarterPack.svelte');
		expect(namesAlice()).toEqual([]);
	});
});

describe('sessionAccountName', () => {
	it('is the account only while a session exists', async () => {
		const { sessionAccountName } = await import('./sessionAccount');
		expect(sessionAccountName()).toBeNull();
		session.set('unlocked');
		expect(sessionAccountName()).toBe('alice');
	});
});
