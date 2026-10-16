// @vitest-environment jsdom
/**
 * A locked visitor on a page that needs a live session is sent to unlock,
 * with the whole address as `next` — query included. A notice's link
 * (/<lang>/chat?n=<token>) opened from a mail app on a locked device must
 * reach the login page with its token, so that the conversation opens after
 * she types her password.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
const unlocked = writable(false);
const pairedReadOnly = writable(false);
vi.mock('$stores/identity', () => ({ isUnlocked: unlocked, isPairedReadOnly: pairedReadOnly }));
const went: string[] = [];
vi.mock('$i18n/navigate', () => ({
	gotoLocale: async (p: string) => void went.push(p)
}));

afterEach(() => {
	document.body.innerHTML = '';
	went.length = 0;
	vi.useRealTimers();
});

async function visit(path: string): Promise<void> {
	history.replaceState(null, '', path);
	const { mount, flushSync } = await import('svelte');
	const { default: Guard } = await import('./RequireLiveSession.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Guard, { target });
	flushSync();
}

describe('RequireLiveSession', () => {
	it('a locked visit to a notice link goes to unlock, keeping the token in next', async () => {
		vi.useFakeTimers();
		unlocked.set(false);
		await visit('/es/chat?n=AbCdEfGhIjKlMnOpQrStUvWx');
		vi.advanceTimersByTime(300);
		expect(went).toEqual(['/login?next=%2Fes%2Fchat%3Fn%3DAbCdEfGhIjKlMnOpQrStUvWx']);
		const next = new URL(`https://site.test${went[0]}`).searchParams.get('next');
		expect(next).toBe('/es/chat?n=AbCdEfGhIjKlMnOpQrStUvWx');
	});

	it('an unlocked visit stays', async () => {
		vi.useFakeTimers();
		unlocked.set(true);
		await visit('/es/chat?n=AbCdEfGhIjKlMnOpQrStUvWx');
		vi.advanceTimersByTime(300);
		expect(went).toEqual([]);
	});
});
