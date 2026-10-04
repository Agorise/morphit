// @vitest-environment jsdom
/**
 * A link in a chat message was written by the peer. Tapping it asks first
 * ("Leaving Morphit — visit <host>?", as order terms do) instead of opening
 * the peer's page at once; confirming opens it in a new tab without opener
 * or referrer.
 *
 * The real ChatMessage is mounted in the browser runtime; i18n and the
 * router are stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

// The browser build of svelte (vitest resolves the server one by default).
vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/stores', () => ({
	page: readable({
		params: { lang: 'en' },
		data: { lang: 'en' },
		url: new URL('https://m.example/en/chat/bob')
	})
}));
vi.mock('svelte-i18n', () => ({
	_: readable((k: string, o?: { values?: Record<string, unknown> }) =>
		o?.values ? `${k} ${JSON.stringify(o.values)}` : k
	),
	locale: readable('en'),
	date: readable(() => ''),
	time: readable(() => ''),
	number: readable((n: number) => String(n))
}));

const opened: { href: string; target: string; rel: string }[] = [];

afterEach(() => {
	document.body.innerHTML = '';
	opened.length = 0;
	vi.restoreAllMocks();
});

async function mountMessage(text: string) {
	const { mount, flushSync } = await import('svelte');
	const { default: ChatMessage } = await import('$components/ChatMessage.svelte');
	// jsdom has no showModal, and must not navigate
	HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
		this.setAttribute('open', '');
	};
	HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
		this.removeAttribute('open');
	};
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
		this: HTMLAnchorElement
	) {
		opened.push({ href: this.href, target: this.target, rel: this.rel });
	});
	const target = document.createElement('ul');
	document.body.append(target);
	mount(ChatMessage, {
		target,
		props: {
			me: 'alice',
			peer: 'bob',
			message: {
				id: 1,
				clientTag: null,
				text,
				sender: 'bob',
				state: 'confirmed',
				createdAt: new Date('2026-10-02T12:00:00Z'),
				orderPermlink: null,
				trxId: null,
				error: null
			} as never
		}
	});
	flushSync();
	return { target, flushSync };
}

describe('a link from the peer', () => {
	it('asks before leaving, naming the destination, and opens nothing until confirmed', async () => {
		const { target, flushSync } = await mountMessage('pay here: https://evil.example/pay');
		const link = target.querySelector<HTMLAnchorElement>('a[href^="https://evil.example"]')!;
		expect(link).not.toBeNull();
		const click = new MouseEvent('click', { bubbles: true, cancelable: true });
		link.dispatchEvent(click);
		flushSync();
		expect(click.defaultPrevented).toBe(true);
		const dialog = target.querySelector('dialog');
		expect(dialog).not.toBeNull();
		expect(dialog!.textContent).toContain('evil.example');
		expect(opened).toEqual([]);
	});

	it('confirming opens it in a new tab with no opener or referrer', async () => {
		const { target, flushSync } = await mountMessage('pay here: https://evil.example/pay');
		target
			.querySelector<HTMLAnchorElement>('a[href^="https://evil.example"]')!
			.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		flushSync();
		const confirm = Array.from(target.querySelectorAll('dialog button')).find((b) =>
			b.textContent?.includes('terms.leave_site.confirm')
		) as HTMLButtonElement;
		confirm.click();
		flushSync();
		expect(opened).toEqual([
			{ href: 'https://evil.example/pay', target: '_blank', rel: 'noopener noreferrer' }
		]);
	});
});
