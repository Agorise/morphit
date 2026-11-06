// @vitest-environment jsdom
/**
 * v1.23.2 review: a chat set to "Yes, delete it" (Chat Security) keeps no
 * draft on this computer. Drafts are saved to localStorage in plain text, so
 * an unsent message typed there would outlive leaving the chat — the very
 * thing that answer asks not to happen. The text stays in the box (memory)
 * while the chat is open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('svelte-i18n', () => ({ _: readable((k: string) => k), locale: readable('en') }));

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
});
afterEach(() => {
	document.body.innerHTML = '';
	vi.useRealTimers();
});

async function mount(props: Record<string, unknown>) {
	const { mount: m, flushSync } = await import('svelte');
	const { default: Composer } = await import('./ChatComposer.svelte');
	const target = document.createElement('div');
	document.body.append(target);
	m(Composer, { target, props: { peer: 'bob', onSend: () => undefined, ...props } as never });
	flushSync();
	const box = target.querySelector('textarea') as HTMLTextAreaElement;
	const type = (v: string) => {
		box.value = v;
		box.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	};
	const enter = async () => {
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
	};
	return { target, box, type, enter, flushSync };
}

const KEY = 'morphit.draft.chat.bob#order-x';

describe('ChatComposer: no draft kept for a chat that locks on leaving', () => {
	it('kept (the default): the typed text is saved as a draft', async () => {
		const c = await mount({ orderPermlink: 'order-x' });
		c.type('half a message');
		await vi.advanceTimersByTimeAsync(600);
		expect(localStorage.getItem(KEY)).toContain('half a message');
	});

	it('locks on leaving: nothing typed reaches storage, and an older draft is wiped (its text kept in the box)', async () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({
				v: 1,
				savedAt: Date.now(),
				exp: Date.now() + 1e9,
				value: { text: 'older draft' }
			})
		);
		const c = await mount({ orderPermlink: 'order-x', persistDraft: false });
		expect(c.box.value).toBe('older draft');
		// Wiped at once, not after the save delay.
		expect(localStorage.getItem(KEY)).toBeNull();
		c.type('half a message');
		await vi.advanceTimersByTimeAsync(600);
		expect(localStorage.getItem(KEY)).toBeNull();
		expect(Object.keys(localStorage).filter((k) => k.startsWith('morphit.draft.'))).toEqual([]);
	});
});
