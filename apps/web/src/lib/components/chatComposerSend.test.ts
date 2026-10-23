// @vitest-environment jsdom
/**
 * The REAL ChatComposer (v1.21.14 full chat audit):
 *
 *   W-M6  the box is cleared and free for the next message at once; the send
 *         continues in the background in its bubble. It waited for the node
 *         (the chain-head read and the broadcast) with the text still in the
 *         box and the box disabled — seconds per message on Tor/I2P;
 *   W-L7  a draft belongs to its THREAD (peer + order), not to the peer: a
 *         draft typed about one order reappeared — and could be sent — in
 *         another thread with the same person.
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

describe('W-M6: the composer never waits for the node', () => {
	it('cleared and enabled at once while the send is still on its way; the next message goes too', async () => {
		const sent: string[] = [];
		const c = await mount({
			onSend: (t: string) => {
				sent.push(t);
				return new Promise<void>(() => undefined); // a slow Tor round trip
			}
		});
		c.type('first');
		await c.enter();
		expect(sent).toEqual(['first']);
		expect(c.box.value).toBe('');
		expect(c.box.disabled).toBe(false);
		c.type('second');
		await c.enter();
		expect(sent).toEqual(['first', 'second']);
	});

	it('a send that fails (its bubble keeps the words, with Retry) does not break the composer', async () => {
		const c = await mount({ onSend: async () => Promise.reject(new Error('node said no')) });
		c.type('hello');
		await c.enter();
		expect(c.box.value).toBe('');
		expect(c.box.disabled).toBe(false);
	});

	it('Enter twice on the same text sends it once', async () => {
		const sent: string[] = [];
		const c = await mount({ onSend: (t: string) => void sent.push(t) });
		c.type('once');
		await c.enter();
		await c.enter();
		expect(sent).toEqual(['once']);
	});

	it('the draft of a sent message is gone', async () => {
		const c = await mount({ orderPermlink: 'o1' });
		c.type('draft');
		await vi.advanceTimersByTimeAsync(600);
		expect(localStorage.getItem('morphit.draft.chat.bob#o1')).not.toBeNull();
		await c.enter();
		// At once — not after the save debounce: leaving the chat right after
		// sending must not leave the words behind as a draft.
		expect(localStorage.getItem('morphit.draft.chat.bob#o1')).toBeNull();
	});
});

describe('W-L7: one draft per thread', () => {
	it('a draft typed about one order is not in another order’s thread with the same person', async () => {
		const a = await mount({ orderPermlink: 'bob-sells-btc' });
		a.type('price for the BTC?');
		await vi.advanceTimersByTimeAsync(600);
		document.body.innerHTML = '';
		const b = await mount({ orderPermlink: 'bob-sells-xmr' });
		expect(b.box.value).toBe('');
		document.body.innerHTML = '';
		const direct = await mount({});
		expect(direct.box.value).toBe('');
		document.body.innerHTML = '';
		const again = await mount({ orderPermlink: 'bob-sells-btc' });
		expect(again.box.value).toBe('price for the BTC?');
	});

	it('the thread that cites no order keeps the old key (an existing draft is still there)', async () => {
		const direct = await mount({});
		direct.type('hi bob');
		await vi.advanceTimersByTimeAsync(600);
		expect(localStorage.getItem('morphit.draft.chat.bob')).not.toBeNull();
		document.body.innerHTML = '';
		const ordered = await mount({ orderPermlink: 'bob-sells-btc' });
		expect(ordered.box.value).toBe('');
	});
});
