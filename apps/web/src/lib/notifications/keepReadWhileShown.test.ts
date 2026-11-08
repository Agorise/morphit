// @vitest-environment jsdom
/**
 * v1.23.4 — owner: "i got a notification on my avatar though for the orders so
 * i clicked it, but the green badge on my avatar did not disappear when i
 * clicked on Orders in that menu". My orders keeps the order and feedback
 * counts read while it is open and in view; a background tab still counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('./native', () => ({ maybeFireNativeNotification: () => {} }));
vi.mock('./audio', () => ({ maybePlayChime: () => {} }));
vi.mock('./vibrate', () => ({ maybeVibrate: () => {} }));

import { keepReadWhileShown, markRead, notify, setCategoryCount, unreadCount } from './index';

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
	visibility = 'visible';
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => visibility
	});
	markRead();
	setCategoryCount('chat', 0);
});
afterEach(() => markRead());

let n = 0;
const event = (category: 'order' | 'feedback' | 'chat') =>
	notify({ category, title: 't', body: 'b', id: `e${++n}` });

describe('keepReadWhileShown', () => {
	it('clears what was waiting the moment the page opens', () => {
		event('order');
		event('feedback');
		expect(get(unreadCount)).toMatchObject({ order: 1, feedback: 1 });
		const stop = keepReadWhileShown(['order', 'feedback']);
		expect(get(unreadCount)).toMatchObject({ order: 0, feedback: 0 });
		stop();
	});

	it('keeps it read while shown (the reminder banner announces after it loads)', () => {
		const stop = keepReadWhileShown(['order', 'feedback']);
		event('feedback');
		event('order');
		expect(get(unreadCount)).toMatchObject({ order: 0, feedback: 0 });
		stop();
	});

	it('never touches chat (cleared by reading)', () => {
		setCategoryCount('chat', 2);
		const stop = keepReadWhileShown(['order', 'feedback']);
		event('chat');
		expect(get(unreadCount).chat).toBe(3);
		stop();
	});

	it('a background tab still counts, and clears once looked at', () => {
		const stop = keepReadWhileShown(['order', 'feedback']);
		visibility = 'hidden';
		event('order');
		expect(get(unreadCount).order).toBe(1);
		visibility = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		expect(get(unreadCount).order).toBe(0);
		stop();
	});

	it('once the page closes, the badge counts again', () => {
		const stop = keepReadWhileShown(['order', 'feedback']);
		stop();
		event('order');
		expect(get(unreadCount).order).toBe(1);
		document.dispatchEvent(new Event('visibilitychange'));
		expect(get(unreadCount).order).toBe(1);
	});
});

describe('markSeenAt — the page a notification points to reads it (v1.23.4, review)', () => {
	it('pageKey: no query, fragment, locale or trailing slash', async () => {
		const { pageKey } = await import('./index');
		expect(pageKey('/en/chat/josiemoto?order=order-x')).toBe('/chat/josiemoto');
		expect(pageKey('/zh-CN/chat/josiemoto/')).toBe('/chat/josiemoto');
		expect(pageKey('/my/orders#feedback=order-x')).toBe('/my/orders');
		expect(pageKey('/en')).toBe('/');
		expect(pageKey('/chat')).toBe('/chat');
	});

	it('opening the chat an order notification links to reads that one only', async () => {
		const { markSeenAt } = await import('./index');
		notify({
			category: 'order',
			title: 't',
			body: 'b',
			id: 'o-a',
			href: '/en/chat/josiemoto?order=o1'
		});
		notify({
			category: 'order',
			title: 't',
			body: 'b',
			id: 'o-b',
			href: '/en/chat/carol?order=o2'
		});
		notify({
			category: 'feedback',
			title: 't',
			body: 'b',
			id: 'f-a',
			href: '/my/orders#feedback=o1'
		});
		expect(get(unreadCount)).toMatchObject({ order: 2, feedback: 1 });
		markSeenAt('/es/chat/josiemoto');
		expect(get(unreadCount)).toMatchObject({ order: 1, feedback: 1 });
		markSeenAt('/en/my/orders');
		expect(get(unreadCount)).toMatchObject({ order: 1, feedback: 0 });
		// Read once: the same page again changes nothing.
		markSeenAt('/es/chat/josiemoto');
		expect(get(unreadCount).order).toBe(1);
	});

	it('not while the tab is in the background; and "Mark all read" forgets them', async () => {
		const { markSeenAt } = await import('./index');
		notify({ category: 'order', title: 't', body: 'b', id: 'o-c', href: '/en/chat/dave' });
		visibility = 'hidden';
		markSeenAt('/en/chat/dave');
		expect(get(unreadCount).order).toBe(1);
		visibility = 'visible';
		markRead();
		notify({ category: 'order', title: 't', body: 'b', id: 'o-d', href: '/en/chat/erin' });
		markSeenAt('/en/chat/dave');
		expect(get(unreadCount).order).toBe(1);
	});
});
