// @vitest-environment jsdom
/**
 * globalChatActivityStream — the browser half of "it appears in your inbox".
 *
 * WHY THIS FILE EXISTS
 *
 * The indexer's side of a first-contact notification is measured end to end
 * (apps/indexer/scripts/fastchat-instance-matrix-smoke.ts): a legitimate buyer
 * or seller message reaches the recipient's activity stream in well under six
 * seconds, on every kind of instance, in both directions.
 *
 * None of that helps if the browser does nothing with the ping. And this module
 * — the thing that turns the ping into a lit badge and an inbox card — had NO
 * test of any kind. The parse sits inside an EventSource listener, so the only
 * honest way to exercise it is to be the EventSource.
 *
 * WHAT IS BEING PINNED IS A CONTRACT ACROSS TWO WORKSPACES. The indexer emits
 * `{ peer, order, inbound, at }`; this module requires `inbound === true`, a
 * non-empty string `peer`, and a string `order` before it will light anything.
 * Rename or retype a field on either side and chat badges stop working
 * silently, for everyone, with no error anywhere — the worst failure shape
 * there is. The frame used below is the exact one the indexer's activity route
 * produces, and the matching indexer smoke asserts the route still produces
 * exactly these four keys, so the two halves cannot drift apart unnoticed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The module reads the signed-in account, and whether there is a session at
// all, to decide whether to connect.
vi.mock('$blurt/ops/profile', () => ({
	getUserBlurtAccount: () => 'bob'
}));
const session = vi.hoisted(() => ({ live: true }));
vi.mock('$stores/identity', async () => {
	const { readable } = await import('svelte/store');
	return { hasAnySession: readable(true, (set) => set(session.live)) };
});

// Folder state is per-thread browser storage; the default (inbox) is what a
// brand-new conversation has, and is all these cases need.
vi.mock('$lib/chat/chatFolders', () => ({
	folderOf: () => 'inbox',
	restoreThread: vi.fn()
}));

/** The EXACT frame apps/indexer/src/api/chatActivityStream.ts writes for an
 *  inbound fast-path message. Captured from the real route, not invented. */
const INDEXER_FRAME = {
	peer: 'alice',
	order: 'sell-usd-for-blurt-abc',
	inbound: true,
	at: null
};

/** A stand-in EventSource that lets a test deliver a frame. */
class FakeEventSource {
	static last: FakeEventSource | null = null;
	readonly listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
	onerror: (() => void) | null = null;
	closed = false;

	constructor(readonly url: string) {
		FakeEventSource.last = this;
	}
	addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	close(): void {
		this.closed = true;
	}
	/** Deliver an SSE event exactly as the browser would. */
	deliver(type: string, data: unknown): void {
		for (const fn of this.listeners.get(type) ?? []) {
			fn({ data: JSON.stringify(data) } as MessageEvent);
		}
	}
}

describe('globalChatActivityStream — an inbound ping becomes an inbox card', () => {
	let stop: (() => void) | null = null;

	beforeEach(() => {
		vi.resetModules();
		session.live = true;
		FakeEventSource.last = null;
		(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
	});

	afterEach(() => {
		stop?.();
		stop = null;
	});

	async function startAndDeliver(frame: unknown): Promise<{
		pending: { peer: string; orderPermlink: string; atMs: number }[];
		stop: () => void;
	}> {
		const { startGlobalChatActivity } = await import('./globalChatActivityStream');
		const { listFastPending, noteFastChatPush } = await import('$lib/notifications/chatUnread');
		void noteFastChatPush;

		// The inbox subscribes to fast pushes and files them; that subscription
		// normally lives in startChatUnreadChannel. Wire the same two pieces
		// together here so the assertion is about the real chain rather than a
		// re-implementation of it.
		const { subscribeFastPush } = await import('./globalChatActivityStream');
		const unsub = subscribeFastPush((peer, order, atMs) => {
			noteFastChatPush(peer, order, atMs);
		});

		stop = startGlobalChatActivity();
		const es = FakeEventSource.last;
		expect(es, 'the module should have opened a stream for the signed-in account').not.toBeNull();
		es?.deliver('chat_activity', frame);
		unsub();
		// Handed back so a caller that starts several streams in a loop can close
		// each one. Reassigning the outer `stop` leaks every stream but the last.
		const stopThis = stop ?? ((): void => undefined);
		return { pending: listFastPending(), stop: stopThis };
	}

	it('a locked or signed-out visit opens no stream naming the account', async () => {
		session.live = false;
		const { startGlobalChatActivity } = await import('./globalChatActivityStream');
		stop = startGlobalChatActivity();
		expect(FakeEventSource.last).toBeNull();
	});

	it('files a brand-new conversation so the inbox can draw a card for it', async () => {
		const { pending } = await startAndDeliver(INDEXER_FRAME);
		const hit = pending.find(
			(p) => p.peer === INDEXER_FRAME.peer && p.orderPermlink === INDEXER_FRAME.order
		);
		expect(
			hit,
			'without this the badge lights but the inbox stays empty until the durable row ' +
				'lands ~60s later — the exact symptom this whole path exists to remove'
		).toBeDefined();
	});

	it('ignores the account’s OWN outgoing message', async () => {
		// The activity stream is a participant stream: it fires for what you send
		// as well as what you receive. Badging on your own message nags you about
		// your own words on your other devices.
		const { pending } = await startAndDeliver({ ...INDEXER_FRAME, inbound: false });
		expect(pending.find((p) => p.peer === INDEXER_FRAME.peer)).toBeUndefined();
	});

	it('files an order-less thread too, keyed by an empty permlink', async () => {
		// A plain direct message carries no order. It still has to reach the inbox,
		// and its key has to match the durable twin that arrives later.
		const { pending } = await startAndDeliver({ ...INDEXER_FRAME, order: '' });
		const hit = pending.find((p) => p.peer === INDEXER_FRAME.peer && p.orderPermlink === '');
		expect(hit).toBeDefined();
	});

	it('survives a malformed frame without breaking the stream', async () => {
		// A ping that cannot be parsed must never take the badge channel down with
		// it; the backstop poll still has to run.
		const { startGlobalChatActivity } = await import('./globalChatActivityStream');
		stop = startGlobalChatActivity();
		const es = FakeEventSource.last;
		expect(() => {
			for (const fn of es?.listeners.get('chat_activity') ?? []) {
				fn({ data: 'not json at all' } as MessageEvent);
			}
		}).not.toThrow();
	});

	it('requires every field the indexer actually sends', async () => {
		// The cross-workspace contract, stated as a test rather than a comment: if
		// the indexer renames or retypes any of these, nothing lights up and
		// nothing errors. The indexer smoke asserts the other direction — that the
		// route still emits exactly these keys.
		//
		// NOTHING filed, not "nothing filed under this peer". The weaker form was
		// vacuous: with a field deleted there is no entry under that name whatever
		// the module does, so the assertion held without the module doing
		// anything. A field the module stopped requiring must now produce an empty
		// list to pass.
		//
		// `peer` is deliberately NOT in this loop. Its absence is prevented three
		// times over — here, in `noteFastChatPush`, and again in
		// `listFastPending` — and behind all three a missing peer makes the key
		// builder throw, which `emitFastPush` swallows. Verified by removing every
		// one of those guards: the outcome does not change. So an assertion about
		// `peer` here would be over-determined, and saying it proves this parse
		// requires a peer would be a claim this test cannot support. The two
		// fields below ARE single-guarded, and each was watched to fail.
		for (const missing of ['order', 'inbound'] as const) {
			const frame: Record<string, unknown> = { ...INDEXER_FRAME };
			delete frame[missing];
			const { pending, stop: stopThis } = await startAndDeliver(frame);
			expect(
				pending,
				`a frame missing '${missing}' must not light a card — and if this ever starts ` +
					'passing, the indexer and the browser have stopped agreeing on the wire format'
			).toHaveLength(0);
			stopThis();
		}
	});

	it('carries the message’s OWN time through, so a replay cannot re-light a read badge', async () => {
		// `at` is the fourth field in the frame and the only one whose SEMANTICS
		// were untested on either side. The indexer sends null on a live ping and
		// the event's real time on a replay — which is how a browser opening after
		// the fact learns when the thing it missed happened. Read as `now()`
		// instead, every replayed message is dated to this instant and pushed past
		// the reader's cursor, so opening a tab re-lights badges for conversations
		// they have already read. Nothing errors, and it looks like the badge
		// logic is broken rather than the timestamp.
		const at = Date.now() - 45_000;
		const { pending } = await startAndDeliver({ ...INDEXER_FRAME, at });
		const hit = pending.find((p) => p.peer === INDEXER_FRAME.peer);
		expect(hit, 'a replayed frame must still file a pending card').toBeDefined();
		expect(
			hit?.atMs,
			'the replayed time must be carried through, not replaced with the moment it was read'
		).toBe(at);
	});

	it('falls back to now() when the indexer sends no time at all', async () => {
		// The live case: `at: null`. There is no original time to carry, so the
		// moment of arrival IS the message's time — and a card with no time cannot
		// be compared against a read cursor at all.
		const before = Date.now();
		const { pending } = await startAndDeliver(INDEXER_FRAME);
		const hit = pending.find((p) => p.peer === INDEXER_FRAME.peer);
		expect(hit?.atMs).toBeGreaterThanOrEqual(before);
		expect(hit?.atMs).toBeLessThanOrEqual(Date.now());
	});
});
