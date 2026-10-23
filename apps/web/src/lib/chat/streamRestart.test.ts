/**
 * v1.21.14 full chat audit, W-L2 — live streams come back after an HTTP error.
 *
 * EventSource reconnects by itself after a dropped connection, but a reconnect
 * answered with an HTTP error (a 502 from a restarting indexer, a 429 from the
 * stream caps) CLOSES it for good — that is the HTML spec. Neither the
 * account-wide activity stream nor a conversation's stream handled that, so
 * the fast badges, the cross-page trade updates and the open chat's live
 * delivery stopped until the page was reloaded. Now each reopens after a pause
 * that doubles, reset once the stream works again.
 *
 * The real modules; EventSource is a fake whose state the test sets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

/** Whether this page has a stream ticket (S-M8): none while locked. */
let ticket = true;
vi.mock('$lib/chat/streamTicket', () => ({
	withStreamTicket: (p: string, a: string) =>
		ticket ? `${p}${p.includes('?') ? '&' : '?'}ticket=T-${a}` : null
}));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'bob' }));
vi.mock('$stores/identity', () => ({ hasAnySession: readable(true) }));
vi.mock('$lib/chat/chatFolders', () => ({ folderOf: () => 'inbox', restoreThread: vi.fn() }));
vi.mock('$lib/notifications/chatThread', () => ({
	chatThreadFromClickPath: () => null,
	dismissChatNotificationsFor: async () => undefined
}));

class FakeES {
	static all: FakeES[] = [];
	readyState = 0;
	private l = new Map<string, ((ev: { data: string }) => void)[]>();
	constructor(readonly url: string) {
		FakeES.all.push(this);
	}
	addEventListener(type: string, fn: (ev: { data: string }) => void): void {
		this.l.set(type, [...(this.l.get(type) ?? []), fn]);
	}
	emit(type: string, data: unknown = {}): void {
		for (const fn of this.l.get(type) ?? []) fn({ data: JSON.stringify(data) });
	}
	close(): void {
		this.readyState = 2;
	}
	/** The browser gave up (an HTTP error answer): CLOSED, then `error`. */
	httpError(): void {
		this.readyState = 2;
		this.emit('error');
	}
	/** A dropped connection the browser itself retries: CONNECTING, `error`. */
	blip(): void {
		this.readyState = 0;
		this.emit('error');
	}
}
const g = globalThis as unknown as Record<string, unknown>;
g.EventSource = FakeES;
// One tab's own stream; the stream shared across tabs (C-L5) is tested in
// $lib/chat/globalChatActivityShared.test.ts. Node has a BroadcastChannel.
g.BroadcastChannel = undefined;
g.window = Object.assign(globalThis, {
	location: { origin: 'https://m.example', hostname: 'm.example', pathname: '/en/orderbook' },
	setInterval,
	clearInterval
});

beforeEach(() => {
	vi.useFakeTimers();
	FakeES.all = [];
	ticket = true;
});
afterEach(() => {
	vi.useRealTimers();
});

const openOnes = (part: string) =>
	FakeES.all.filter((e) => e.url.includes(part) && e.readyState !== 2);

describe('W-L2: the account-wide activity stream', () => {
	it('closed by an HTTP error: reopened after 2 s, then 4 s…, and the pause resets once it works', async () => {
		const { startGlobalChatActivity, RECONNECT_MIN_MS } = await import(
			'$lib/chat/globalChatActivityStream'
		);
		const stop = startGlobalChatActivity();
		expect(FakeES.all.map((e) => e.url)).toEqual(['/v1/chat-activity/bob/stream?ticket=T-bob']);
		FakeES.all[0]!.httpError();
		await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS - 1);
		expect(openOnes('chat-activity')).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(openOnes('chat-activity')).toHaveLength(1);
		// Fails again: twice the pause.
		FakeES.all[1]!.httpError();
		await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS * 2 - 1);
		expect(openOnes('chat-activity')).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(openOnes('chat-activity')).toHaveLength(1);
		// It works (`ready`), then fails: back to the shortest pause.
		FakeES.all[2]!.emit('ready');
		FakeES.all[2]!.httpError();
		await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS);
		expect(openOnes('chat-activity')).toHaveLength(1);
		stop();
	});

	it('a blip the browser retries itself is left alone; stopping cancels a pending reopen', async () => {
		const { startGlobalChatActivity } = await import('$lib/chat/globalChatActivityStream');
		const stop = startGlobalChatActivity();
		FakeES.all[0]!.blip();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(FakeES.all).toHaveLength(1);
		FakeES.all[0]!.httpError();
		stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(FakeES.all).toHaveLength(1);
	});

	it('the pause stops growing at the maximum', async () => {
		const { startGlobalChatActivity, RECONNECT_MAX_MS } = await import(
			'$lib/chat/globalChatActivityStream'
		);
		const stop = startGlobalChatActivity();
		for (let i = 0; i < 8; i++) {
			FakeES.all[FakeES.all.length - 1]!.httpError();
			await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS);
		}
		expect(FakeES.all).toHaveLength(9);
		stop();
	});

	it('pings are passed on with the thread they name ("" a thread; null: reconcile only)', async () => {
		const { startGlobalChatActivity, subscribeChatActivityPings } = await import(
			'$lib/chat/globalChatActivityStream'
		);
		const pings: unknown[] = [];
		const unsub = subscribeChatActivityPings((p) => pings.push(p));
		const stop = startGlobalChatActivity();
		const es = FakeES.all[0]!;
		es.emit('chat_activity', { peer: 'alice', order: 'sell-1', inbound: true, at: null });
		es.emit('chat_activity', { peer: 'carol', order: null, inbound: true, at: null });
		es.emit('chat_activity', { peer: 'dave', order: '', inbound: false, at: null });
		es.emit('chat_activity', { peer: '', order: '', inbound: true, at: null });
		expect(pings).toEqual([
			{ peer: 'alice', order: 'sell-1', inbound: true },
			{ peer: 'carol', order: null, inbound: true },
			{ peer: 'dave', order: '', inbound: false }
		]);
		unsub();
		stop();
	});
});

describe('W-L2: a conversation’s stream', () => {
	it('closed by an HTTP error: reopened after a growing pause; a snapshot resets it; stop cancels', async () => {
		const { createChatStream, STREAM_RESTART_MIN_MS } = await import('$lib/chat/stream');
		const live: boolean[] = [];
		const h = createChatStream({
			me: 'bob',
			peer: 'alice',
			handlers: {
				onSnapshot: () => undefined,
				applyAppend: () => undefined,
				onStreamingChange: (s) => live.push(s)
			}
		});
		h.start();
		expect(openOnes('/v1/chat/bob/alice/stream')).toHaveLength(1);
		FakeES.all[0]!.httpError();
		expect(live.at(-1)).toBe(false);
		await vi.advanceTimersByTimeAsync(STREAM_RESTART_MIN_MS - 1);
		expect(openOnes('/stream')).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(openOnes('/stream')).toHaveLength(1);
		FakeES.all[1]!.httpError();
		await vi.advanceTimersByTimeAsync(STREAM_RESTART_MIN_MS * 2 - 1);
		expect(openOnes('/stream')).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(openOnes('/stream')).toHaveLength(1);
		FakeES.all[2]!.emit('snapshot', { items: [], indexed_block: 1 });
		expect(live.at(-1)).toBe(true);
		FakeES.all[2]!.httpError();
		await vi.advanceTimersByTimeAsync(STREAM_RESTART_MIN_MS);
		expect(openOnes('/stream')).toHaveLength(1);
		// A blip is the browser's to retry.
		FakeES.all[3]!.blip();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(FakeES.all).toHaveLength(4);
		FakeES.all[3]!.httpError();
		h.stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(FakeES.all).toHaveLength(4);
	});

	it('the pause stops growing at the maximum', async () => {
		const { createChatStream, STREAM_RESTART_MAX_MS } = await import('$lib/chat/stream');
		const h = createChatStream({
			me: 'bob',
			peer: 'alice',
			handlers: { onSnapshot: () => undefined, applyAppend: () => undefined }
		});
		h.start();
		for (let i = 0; i < 8; i++) {
			FakeES.all[FakeES.all.length - 1]!.httpError();
			await vi.advanceTimersByTimeAsync(STREAM_RESTART_MAX_MS);
		}
		expect(FakeES.all).toHaveLength(9);
		h.stop();
	});
});

describe('S-M8: a stream opens only with a ticket', () => {
	it('the activity stream waits for a ticket, then opens with it', async () => {
		const { startGlobalChatActivity, NO_TICKET_RETRY_MS } = await import(
			'$lib/chat/globalChatActivityStream'
		);
		ticket = false;
		const stop = startGlobalChatActivity();
		await vi.advanceTimersByTimeAsync(NO_TICKET_RETRY_MS * 3);
		expect(FakeES.all).toHaveLength(0);
		ticket = true; // the session was unlocked
		await vi.advanceTimersByTimeAsync(NO_TICKET_RETRY_MS);
		expect(FakeES.all.map((e) => e.url)).toEqual(['/v1/chat-activity/bob/stream?ticket=T-bob']);
		stop();
	});

	it("a conversation's stream waits for a ticket, then opens with it", async () => {
		const { createChatStream, NO_TICKET_RETRY_MS } = await import('$lib/chat/stream');
		ticket = false;
		const h = createChatStream({
			me: 'bob',
			peer: 'alice',
			handlers: { onSnapshot: () => undefined, applyAppend: () => undefined }
		});
		h.start();
		await vi.advanceTimersByTimeAsync(NO_TICKET_RETRY_MS * 3);
		expect(FakeES.all).toHaveLength(0);
		ticket = true;
		await vi.advanceTimersByTimeAsync(NO_TICKET_RETRY_MS);
		expect(FakeES.all).toHaveLength(1);
		expect(FakeES.all[0]!.url).toMatch(/\/v1\/chat\/bob\/alice\/stream\?ticket=T-bob$/);
		h.stop();
		// Stopped while waiting: nothing opens later.
		ticket = false;
		const h2 = createChatStream({
			me: 'bob',
			peer: 'carol',
			handlers: { onSnapshot: () => undefined, applyAppend: () => undefined }
		});
		h2.start();
		h2.stop();
		ticket = true;
		await vi.advanceTimersByTimeAsync(NO_TICKET_RETRY_MS * 3);
		expect(FakeES.all).toHaveLength(1);
	});
});
