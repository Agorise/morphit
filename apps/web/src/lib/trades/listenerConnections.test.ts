/**
 * v1.21.14 full chat audit, W-H2 — long-lived connections to the site.
 *
 * A Tor or I2P instance is plain http:// (no HTTP/2), and a browser allows six
 * HTTP/1.1 connections per site. The app held seven EventSources open for an
 * unlocked user with five recent peers on a chat page (the activity stream,
 * the open conversation, five trade-listener streams), so sends, history
 * reads and the backup poll queued behind them. Now: the activity stream and
 * the open conversation, plus at most ONE short read by the trade listener,
 * whatever the number of peers or pings.
 *
 * The REAL activity stream, chat stream and listener; EventSource is a fake
 * that counts.
 */
import { describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$lib/chat/streamTicket', () => ({
	withStreamTicket: (p: string, a: string) => `${p}${p.includes('?') ? '&' : '?'}ticket=T-${a}`
}));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$lib/chat/recentPeers', () => ({
	loadRecentPeers: () => Array.from({ length: 20 }, (_, i) => `peer${i + 10}`),
	recordRecentPeer: () => undefined
}));
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'alice' }));
vi.mock('$stores/identity', () => ({
	hasAnySession: readable(true),
	liveIdentity: readable(null),
	identity: readable({ state: 'locked' })
}));
vi.mock('svelte-i18n', () => ({ _: readable((k: string) => k), locale: readable('en') }));
vi.mock('$lib/chat/chatFolders', () => ({
	folderOf: () => 'inbox',
	restoreThread: () => undefined
}));
vi.mock('$lib/notifications/chatThread', () => ({
	chatThreadFromClickPath: () => null,
	dismissChatNotificationsFor: async () => undefined
}));

class FakeES {
	static open = new Set<FakeES>();
	static peak = 0;
	readyState = 0;
	private l = new Map<string, ((ev: { data: string }) => void)[]>();
	constructor(readonly url: string) {
		FakeES.open.add(this);
		FakeES.peak = Math.max(FakeES.peak, FakeES.open.size);
	}
	addEventListener(type: string, fn: (ev: { data: string }) => void): void {
		this.l.set(type, [...(this.l.get(type) ?? []), fn]);
	}
	emit(type: string, data: unknown): void {
		for (const fn of this.l.get(type) ?? []) fn({ data: JSON.stringify(data) });
	}
	close(): void {
		this.readyState = 2;
		FakeES.open.delete(this);
	}
}
const g = globalThis as unknown as Record<string, unknown>;
g.EventSource = FakeES;
// One tab's own stream; the stream shared across tabs (C-L5) is tested in
// $lib/chat/globalChatActivityShared.test.ts. Node has a BroadcastChannel.
g.BroadcastChannel = undefined;
g.window = Object.assign(globalThis, {
	location: {
		origin: 'http://morphitxyz.onion',
		hostname: 'morphitxyz.onion',
		pathname: '/en/chat/p1'
	},
	setInterval,
	clearInterval
});
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

describe('W-H2: at most three long-lived connections to the site', () => {
	it('activity stream + open conversation + one listener read, with 20 recent peers and 12 pings', async () => {
		vi.useFakeTimers();
		const { startGlobalChatActivity } = await import('$lib/chat/globalChatActivityStream');
		const { startTradeEventListener, stopTradeEventListener } = await import(
			'$lib/trades/tradeEventListener'
		);
		const { createChatStream } = await import('$lib/chat/stream');
		const stopActivity = startGlobalChatActivity();
		startTradeEventListener('alice');
		const convo = createChatStream({
			me: 'alice',
			peer: 'p1',
			handlers: { onSnapshot: () => undefined, applyAppend: () => undefined }
		});
		convo.start();
		expect(FakeES.open.size).toBe(2);

		const activity = [...FakeES.open].find((e) => e.url.includes('/v1/chat-activity/'))!;
		for (let i = 0; i < 12; i++) {
			activity.emit('chat_activity', { peer: `peer${i + 10}`, order: '', inbound: true, at: null });
		}
		expect(FakeES.open.size).toBe(3);
		// Each read closes at its snapshot and the next one opens.
		for (let i = 0; i < 12; i++) {
			const read = [...FakeES.open].find(
				(e) => e !== activity && !e.url.includes('/alice/p1/stream?')
			)!;
			read.emit('snapshot', { items: [], indexed_block: 1 });
			await vi.advanceTimersByTimeAsync(0);
			expect(FakeES.open.size).toBeLessThanOrEqual(3);
		}
		expect(FakeES.peak).toBe(3);
		expect(FakeES.open.size).toBe(2);
		stopTradeEventListener();
		convo.stop();
		stopActivity();
		expect(FakeES.open.size).toBe(0);
		vi.useRealTimers();
	});
});
