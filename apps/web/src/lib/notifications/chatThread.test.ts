/**
 * v1.24.1 — what the service worker tells the open tabs about a push
 * (chatPushTabMessage). The message's own time (`eventAt`) must reach the tab:
 * without it, a pushed message was dated by the device clock on arrival, which
 * the durable row never reaches, and a message read on another device stayed
 * on a background tab's badge.
 */
import { describe, expect, it } from 'vitest';
import { chatPushTabMessage } from './chatThread';

describe('chatPushTabMessage', () => {
	const AT = '2026-11-10T03:00:00.000Z';

	it("carries the thread and the message's own time", () => {
		expect(chatPushTabMessage('order', '/en/chat/alice?order=sell-1', AT)).toEqual({
			type: 'CHAT_PUSH',
			category: 'order',
			peer: 'alice',
			order: 'sell-1',
			at: Date.parse(AT)
		});
		expect(chatPushTabMessage('chat', '/es/chat/bob', AT)).toEqual({
			type: 'CHAT_PUSH',
			category: 'chat',
			peer: 'bob',
			order: '',
			at: Date.parse(AT)
		});
	});

	it('leaves the time out when the push carries none it can read', () => {
		for (const bad of [undefined, null, 42, 'not a date', '']) {
			expect(chatPushTabMessage('chat', '/en/chat/bob', bad)).not.toHaveProperty('at');
		}
	});

	it('names no thread for a feedback push, or a path that is not a thread', () => {
		expect(chatPushTabMessage('feedback', '/en/chat/bob', AT)).not.toHaveProperty('peer');
		expect(chatPushTabMessage('chat', '/en/chat', AT)).not.toHaveProperty('peer');
	});
});
