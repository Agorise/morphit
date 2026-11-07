// @vitest-environment jsdom
/**
 * v1.23.3 — an account's picture on every page: its Morphit avatar when the
 * page holds it; else, when the visitor turned pictures on and this instance
 * can serve them, this instance's /v1/avatars/<name>; else the identicon.
 * A miss draws the identicon and is remembered for the next label.
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
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k),
	locale: readable('en')
}));
const inst = vi.hoisted(() => ({ store: null as unknown }));
const profiles = vi.hoisted(() => new Map<string, unknown>());
vi.mock('$lib/indexer/profileSoon', () => ({
	profileSoon: async (a: string) => profiles.get(a) ?? null
}));
vi.mock('$lib/stores/instance', async () => {
	const { writable: w } = await import('svelte/store');
	const s = w({ blurt_pictures: true, loaded: true });
	inst.store = s;
	return { instance: { subscribe: s.subscribe } };
});

const { flushSync, mount, unmount } = await import('svelte');
const { default: IdentityLabel } = await import('./IdentityLabel.svelte');
const { setShowBlurtPictures } = await import('$lib/stores/blurtPictures');
const { _clearPictureMisses } = await import('$lib/avatar/blurtPicture');
const { blurtAccountName } = await import('$blurt/ops/profile');
void writable;

const apps: ReturnType<typeof mount>[] = [];
beforeEach(() => {
	localStorage.clear();
	_clearPictureMisses();
	(inst.store as { set: (v: unknown) => void }).set({ blurt_pictures: true, loaded: true });
	profiles.clear();
});
afterEach(() => {
	for (const a of apps.splice(0)) unmount(a);
	document.body.innerHTML = '';
});

function label(props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	apps.push(mount(IdentityLabel, { target, props: { account: 'alice', ...props } }));
	flushSync();
	return target;
}
const src = (t: HTMLElement) =>
	(t.querySelector('img') as HTMLImageElement | null)?.getAttribute('src') ?? '';

describe('IdentityLabel: the account picture (v1.23.3)', () => {
	it('off (the default): the identicon, and nothing asked of the instance', () => {
		expect(src(label({}))).toMatch(/^data:image\/svg\+xml/);
	});

	it("on: this instance's /v1/avatars/<name>", () => {
		setShowBlurtPictures(true);
		expect(src(label({}))).toMatch(/\/v1\/avatars\/alice$/);
	});

	it('a Morphit avatar in hand wins, on or off', () => {
		setShowBlurtPictures(true);
		const uri = 'data:image/webp;base64,UklGRgAAAABXRUJQ';
		expect(src(label({ avatarDataUri: uri }))).toBe(uri);
	});

	it('a hidden-only instance (no pictures there): the identicon even when on', () => {
		setShowBlurtPictures(true);
		(inst.store as { set: (v: unknown) => void }).set({ blurt_pictures: false, loaded: true });
		expect(src(label({}))).toMatch(/^data:image\/svg\+xml/);
	});

	it('a miss draws the identicon, and the next label of that account does not ask again', () => {
		setShowBlurtPictures(true);
		const first = label({});
		first.querySelector('img')!.dispatchEvent(new Event('error'));
		flushSync();
		expect(src(first)).toMatch(/^data:image\/svg\+xml/);
		expect(src(label({}))).toMatch(/^data:image\/svg\+xml/);
		// Another account still asks.
		expect(src(label({ account: 'bob' }))).toMatch(/\/v1\/avatars\/bob$/);
	});

	it('still loading the profile: the quiet placeholder, not a picture', () => {
		setShowBlurtPictures(true);
		expect(label({ pending: true }).querySelector('img')).toBeNull();
	});

	it('review: pictures on, this instance not heard from yet — the quiet circle, not the identicon then the picture', () => {
		setShowBlurtPictures(true);
		(inst.store as { set: (v: unknown) => void }).set({ blurt_pictures: false, loaded: false });
		const t = label({});
		expect(t.querySelector('img')).toBeNull();
		(inst.store as { set: (v: unknown) => void }).set({ blurt_pictures: true, loaded: true });
		flushSync();
		expect(src(t)).toMatch(/\/v1\/avatars\/alice$/);
	});

	it('review: noPicture (a private list) never asks this instance', () => {
		setShowBlurtPictures(true);
		expect(src(label({ noPicture: true }))).toMatch(/^data:image\/svg\+xml/);
	});

	it('review: hydrate reads the Morphit avatar itself — the circle until then, never the picture first', async () => {
		setShowBlurtPictures(true);
		const uri = 'data:image/webp;base64,UklGRgEAAABXRUJQCQ==';
		profiles.set('alice', {
			account: 'alice',
			display_name: null,
			json_metadata: { avatar_data_uri: uri }
		});
		const t = label({ hydrate: true });
		expect(t.querySelector('img')).toBeNull();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(src(t)).toBe(uri);
		// No Morphit avatar: then the picture.
		const t2 = label({ hydrate: true, account: 'bob' });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(src(t2)).toMatch(/\/v1\/avatars\/bob$/);
	});

	it('review: your own account before your profile is read — the circle, not a picture that your Morphit avatar then replaces', () => {
		setShowBlurtPictures(true);
		blurtAccountName.set('alice');
		try {
			expect(label({}).querySelector('img')).toBeNull();
			expect(src(label({ account: 'bob' }))).toMatch(/\/v1\/avatars\/bob$/);
		} finally {
			blurtAccountName.set(null);
		}
	});
});
