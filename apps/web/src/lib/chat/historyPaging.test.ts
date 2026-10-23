/**
 * v1.21.6 — scrolling back and exporting reach the first message.
 *
 * Before, a conversation only ever read the pair's newest 50 messages: older
 * ones could not be reread or exported, and a thread whose messages were all
 * older than the newest 50 of the pair showed nothing. `loadOlder` reads the
 * thread further back page by page; `loadWholeConversation` reads every thread
 * of the pair, to its first message, for the PDF.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	ConversationIncompleteError,
	clearOwnSentPlaintextCache,
	chronological,
	createConversationController,
	type ChatControllerDeps,
	type HistoryState,
	type LocalMessage
} from './chatService';
import { encodeFundsSentPayload } from './payload';
import { clearAllTradeStates, getTradeState, recordFundsSent } from '$lib/trades/tradeStatus';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';

const fakeLive = {} as unknown as LiveIdentity;
const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
const unb64 = (c: string) =>
	new TextDecoder().decode(Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)));

/** A record whose ciphertext is its text (the decrypt fake reverses it). */
function rec(
	id: number,
	text: string,
	opts: { order?: string | null; from?: string; at?: number } = {}
): ChatMessageRecord {
	const from = opts.from ?? 'bob';
	return {
		id,
		sender: from,
		recipient: from === 'bob' ? 'alice' : 'bob',
		ciphertext: b64(text),
		header: {
			v: 2,
			ephemeral_pub: 'ZQ==',
			nonce: 'bg==',
			client_tag: `t${id}`,
			...(from === 'alice' ? { self_ciphertext: b64(text), self_nonce: 'bg==' } : {})
		},
		created_at: new Date(Date.UTC(2026, 0, 1) + (opts.at ?? id) * 1000).toISOString(),
		source_trx_id: `trx${id}`,
		order_permlink: opts.order === undefined ? null : opts.order
	} as ChatMessageRecord;
}

/** The indexer: newest first, `limit` per page, an opaque cursor, and the
 *  `order` filter (unless `ignoresOrder`, like an indexer that predates it). */
function fakeIndexer(all: ChatMessageRecord[], ignoresOrder = false) {
	const calls: { cursor?: string; limit?: number; order?: string | null }[] = [];
	const fetchHistory: ChatControllerDeps['fetchHistory'] = async (_a, _b, opts) => {
		calls.push({ cursor: opts.cursor, limit: opts.limit, order: opts.order });
		const newestFirst = [...all]
			.filter(
				(r) => ignoresOrder || opts.order === undefined || (r.order_permlink ?? null) === opts.order
			)
			.sort((x, y) =>
				x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : x.id - y.id
			);
		const start = opts.cursor ? Number(opts.cursor) : 0;
		const limit = opts.limit ?? 50;
		const items = newestFirst.slice(start, start + limit);
		const next = start + limit < newestFirst.length ? String(start + limit) : null;
		return { ok: true, items, nextCursor: next };
	};
	return { fetchHistory, calls };
}

function deps(over: Partial<ChatControllerDeps> = {}) {
	const emitted: LocalMessage[][] = [];
	const history: HistoryState[] = [];
	const d: ChatControllerDeps = {
		me: 'alice',
		peer: 'bob',
		orderPermlink: null,
		getLiveIdentity: () => fakeLive,
		now: () => new Date('2026-04-23T12:00:00Z'),
		visibilityState: () => 'visible',
		onVisibilityChange: () => () => undefined,
		generateClientTag: () => 'tag'.padEnd(32, '0'),
		fetchHistory: async () => ({ ok: true, items: [], nextCursor: null }),
		broadcast: async () => ({ block_num: null, trx_id: 'x' }),
		fetchPeerChatPub: async () => new Uint8Array(32).fill(7),
		deriveMyChatIdentity: async () => ({
			priv: new Uint8Array(32).fill(9),
			pub: new Uint8Array(32).fill(7)
		}),
		// Every message goes to the peer's posting keys (v1.21.14).
		fetchPostingPubs: async () => [new Uint8Array(33).fill(2)],
		encryptPosting: async (t: string) => ({
			ciphertext: b64(t),
			ephemeralPub: 'ZQ==',
			nonce: 'bg=='
		}),
		decrypt: async (env) => ({ text: unb64(env.ciphertext), authenticated: true }),
		decryptSelfCopy: async (env) => (env.selfCiphertext ? unb64(env.selfCiphertext) : null),
		sleep: async () => undefined,
		onChange: (m) => emitted.push([...m]),
		onHistoryChange: (h) => history.push(h),
		...over
	};
	return { d, emitted, history };
}

const texts = (ms: readonly { text: string }[]) => ms.map((m) => m.text);
/** Start, let the first poll land, and return the controller. */
async function started(d: ChatControllerDeps) {
	const c = createConversationController(d);
	c.start();
	await vi.advanceTimersByTimeAsync(0);
	return c;
}

/** The indexer exactly as the SQL pages: newest first, a block's messages in
 *  id order, and a keyset cursor ({c: created_at, i: id}). */
function keysetIndexer(all: ChatMessageRecord[]) {
	const calls: { cursor?: string; order?: string | null }[] = [];
	const fetchHistory: ChatControllerDeps['fetchHistory'] = async (_a, _b, opts) => {
		calls.push({ cursor: opts.cursor, order: opts.order });
		let rows = [...all]
			.filter((r) => opts.order === undefined || (r.order_permlink ?? null) === opts.order)
			.sort((x, y) =>
				x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : x.id - y.id
			);
		if (opts.cursor) {
			const cur = JSON.parse(opts.cursor) as { c: string; i: number };
			rows = rows.filter((r) => r.created_at < cur.c || (r.created_at === cur.c && r.id > cur.i));
		}
		const limit = opts.limit ?? 50;
		const page = rows.slice(0, limit + 1);
		let next: string | null = null;
		if (page.length > limit) {
			page.pop();
			const last = page[page.length - 1]!;
			next = JSON.stringify({ c: last.created_at, i: last.id });
		}
		return { ok: true, items: page, nextCursor: next };
	};
	return { fetchHistory, calls };
}

const claimFor = (txid: string, order: string) =>
	encodeFundsSentPayload({
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'btc',
		txid,
		orderPermlink: order
	});
type StreamHandlers = Parameters<NonNullable<ChatControllerDeps['subscribeStream']>>[0];
const settle = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('chat history paging (v1.21.6)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearOwnSentPlaintextCache();
		clearAllTradeStates();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('scrolling back reads this thread to its first message, a page at a time', async () => {
		// 260 messages in the order-less thread.
		const all = Array.from({ length: 260 }, (_, i) => rec(i + 1, `m${i + 1}`));
		const ix = fakeIndexer(all);
		const { d, history } = deps({ fetchHistory: ix.fetchHistory });
		const c = await started(d);
		expect(c.snapshot()).toHaveLength(50); // the live page
		expect(history.at(-1)).toMatchObject({ ready: true, complete: false });

		// One call adds one page's worth and stops (the newest 100 of the
		// thread, half of which the live page already had).
		await c.loadOlder();
		expect(c.snapshot()).toHaveLength(100);
		for (let i = 0; i < 10 && !history.at(-1)!.complete; i++) await c.loadOlder();
		expect(texts(c.snapshot())).toEqual(all.map((r) => unb64(r.ciphertext)));
		expect(history.at(-1)).toEqual({ ready: true, loading: false, complete: true, failed: false });
		// Thread reads ask the indexer for this thread, 100 at a time.
		const older = ix.calls.slice(1);
		expect(older.every((q) => q.order === null && q.limit === 100)).toBe(true);
		// Nothing more to read: no further requests.
		const n = ix.calls.length;
		await c.loadOlder();
		expect(ix.calls.length).toBe(n);
		c.destroy();
	});

	it('a thread older than the pair’s newest 50 messages is found, not shown empty', async () => {
		// order-a: 30 messages, then 80 newer ones about order-b.
		const a = Array.from({ length: 30 }, (_, i) => rec(i + 1, `a${i + 1}`, { order: 'order-a' }));
		const b = Array.from({ length: 80 }, (_, i) => rec(100 + i, `b${i}`, { order: 'order-b' }));
		const ix = fakeIndexer([...a, ...b]);
		const { d } = deps({ fetchHistory: ix.fetchHistory, orderPermlink: 'order-a' });
		const c = await started(d);
		expect(c.snapshot()).toHaveLength(0); // the newest 50 are all order-b
		await c.loadOlder();
		expect(texts(c.snapshot())).toEqual(a.map((r) => unb64(r.ciphertext)));
		c.destroy();
	});

	it('an indexer that ignores the thread filter: reads on until this thread’s older messages, and shows no other thread', async () => {
		const a = Array.from({ length: 30 }, (_, i) => rec(i + 1, `a${i + 1}`, { order: 'order-a' }));
		const b = Array.from({ length: 250 }, (_, i) => rec(100 + i, `b${i}`, { order: 'order-b' }));
		const ix = fakeIndexer([...a, ...b], true);
		const { d, history } = deps({ fetchHistory: ix.fetchHistory, orderPermlink: 'order-a' });
		const c = await started(d);
		await c.loadOlder();
		expect(texts(c.snapshot())).toEqual(a.map((r) => unb64(r.ciphertext)));
		expect(history.at(-1)!.complete).toBe(true);
		c.destroy();
	});

	it('an old payment claim read by scrolling back never replaces the newer one', async () => {
		const claim = (txid: string) =>
			encodeFundsSentPayload({
				v: 1,
				kind: 'morphit_funds_sent',
				method: 'btc',
				txid,
				orderPermlink: 'order-a'
			});
		const OLD = 'a'.repeat(64);
		const NEW = 'b'.repeat(64);
		const thread = [
			rec(1, claim(OLD), { order: 'order-a' }),
			...Array.from({ length: 120 }, (_, i) => rec(10 + i, `x${i}`, { order: 'order-a' })),
			rec(500, claim(NEW), { order: 'order-a' })
		];
		const { d } = deps({
			fetchHistory: fakeIndexer(thread).fetchHistory,
			orderPermlink: 'order-a'
		});
		const c = await started(d);
		expect(getTradeState('bob', 'order-a')?.txid).toBe(NEW);
		await c.loadOlder();
		await c.loadOlder();
		expect(c.snapshot()).toHaveLength(122);
		expect(getTradeState('bob', 'order-a')?.txid).toBe(NEW);
		// Backfill is marked, so the view does not count it as news.
		expect(c.snapshot()[0]!.backfilled).toBe(true);
		expect(c.snapshot().at(-1)!.backfilled).toBeUndefined();
		c.destroy();
	});

	it('the same record arriving twice at once (stream snapshot and append) is shown once', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => (release = r));
		const { d } = deps({
			decrypt: async (env) => {
				await gate;
				return { text: unb64(env.ciphertext), authenticated: true };
			},
			subscribeStream: (h) => {
				const r = rec(7, 'hello');
				h.onSnapshot([r]);
				h.onAppend(r);
				return () => undefined;
			}
		});
		const c = createConversationController(d);
		c.start();
		await vi.advanceTimersByTimeAsync(0);
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(texts(c.snapshot())).toEqual(['hello']);
		c.destroy();
	});

	it('a page that fails three times reports failure; the next try resumes where it stopped', async () => {
		const all = Array.from({ length: 200 }, (_, i) => rec(i + 1, `m${i + 1}`));
		const ix = fakeIndexer(all);
		let failing = false;
		const sleeps: number[] = [];
		const { d, history } = deps({
			fetchHistory: async (a, b, o) =>
				failing ? { ok: false, message: 'down' } : ix.fetchHistory(a, b, o),
			sleep: async (ms) => {
				sleeps.push(ms);
			}
		});
		const c = await started(d);
		await c.loadOlder(); // m51..m150 (overlapping the live page)
		const shown = c.snapshot().length;
		failing = true;
		await c.loadOlder();
		expect(history.at(-1)).toMatchObject({ loading: false, failed: true, complete: false });
		expect(sleeps).toEqual([2000, 5000]);
		expect(c.snapshot()).toHaveLength(shown);
		failing = false;
		await c.loadOlder();
		expect(texts(c.snapshot())).toEqual(all.map((r) => unb64(r.ciphertext)));
		expect(history.at(-1)).toMatchObject({ failed: false, complete: true });
		c.destroy();
	});

	it('a lock while a page is being read adds nothing, and scrolling back starts again', async () => {
		const all = Array.from({ length: 200 }, (_, i) => rec(i + 1, `m${i + 1}`));
		const ix = fakeIndexer(all);
		let hold: (() => void) | null = null;
		const { d } = deps({
			fetchHistory: async (a, b, o) => {
				if (o.cursor !== undefined || o.order !== undefined) {
					await new Promise<void>((r) => (hold = r));
				}
				return ix.fetchHistory(a, b, o);
			}
		});
		const c = await started(d);
		const p = c.loadOlder();
		await vi.advanceTimersByTimeAsync(0);
		clearOwnSentPlaintextCache() /* the session lock */;
		hold!();
		await p;
		expect(c.snapshot()).toHaveLength(0);
		c.destroy();
	});

	it('the whole conversation: every thread, to the first message, oldest first, without touching the view', async () => {
		const all = [
			rec(1, 'first, no order', { at: 1 }),
			rec(2, 'mine about a', { order: 'order-a', from: 'alice', at: 2 }),
			...Array.from({ length: 230 }, (_, i) =>
				rec(10 + i, `b${i}`, { order: 'order-b', at: 10 + i, from: i % 2 ? 'alice' : 'bob' })
			)
		];
		const ix = fakeIndexer(all);
		const { d } = deps({ fetchHistory: ix.fetchHistory, orderPermlink: 'order-a' });
		const c = await started(d);
		const before = c.snapshot();
		const whole = await c.loadWholeConversation();
		expect(texts(whole)).toEqual(all.map((r) => unb64(r.ciphertext)));
		expect(whole.map((m) => m.orderPermlink)).toEqual(all.map((r) => r.order_permlink ?? null));
		expect(whole.every((m) => m.trxId !== null && !m.decryptFailed)).toBe(true);
		expect(ix.calls.slice(1).every((q) => q.order === undefined)).toBe(true);
		expect(c.snapshot()).toEqual(before);
		c.destroy();
	});

	it('the whole conversation includes this thread’s unsent and failed messages, once', async () => {
		const { d } = deps({
			fetchHistory: fakeIndexer([rec(1, 'hi')]).fetchHistory,
			broadcast: async () => {
				throw new Error('chain down');
			}
		});
		const c = await started(d);
		await c.sendMessage('not sent');
		const whole = await c.loadWholeConversation();
		expect(texts(whole)).toEqual(['hi', 'not sent']);
		expect(whole[1]).toMatchObject({ state: 'failed', trxId: null, createdAt: null });
		c.destroy();
	});

	it('a copy shown before the chain made it irreversible is listed once, as the durable record', async () => {
		const durable = rec(5, 'quick');
		const { d } = deps({
			fetchHistory: fakeIndexer([durable]).fetchHistory,
			subscribeStream: (h) => {
				h.onAppend({ ...durable, id: 0, source_trx_id: '' } as ChatMessageRecord);
				return () => undefined;
			}
		});
		const c = await started(d);
		expect(c.snapshot()[0]!.id).toBeNull(); // the provisional copy
		const whole = await c.loadWholeConversation();
		expect(texts(whole)).toEqual(['quick']);
		expect(whole[0]!.trxId).toBe('trx5');
		c.destroy();
	});

	it('the whole conversation is all or nothing', async () => {
		const all = Array.from({ length: 250 }, (_, i) => rec(i + 1, `m${i + 1}`));
		const ix = fakeIndexer(all);
		const { d } = deps({
			fetchHistory: async (a, b, o) =>
				o.cursor === '200' ? { ok: false, message: 'down' } : ix.fetchHistory(a, b, o)
		});
		const c = await started(d);
		await expect(c.loadWholeConversation()).rejects.toBeInstanceOf(ConversationIncompleteError);

		// A lock part-way through: nothing is returned either.
		const { d: d2 } = deps({
			fetchHistory: async (a, b, o) => {
				if (o.cursor === '100') clearOwnSentPlaintextCache() /* the session lock */;
				return ix.fetchHistory(a, b, o);
			}
		});
		const c2 = await started(d2);
		const asked = ix.calls.length;
		await expect(c2.loadWholeConversation()).rejects.toBeInstanceOf(ConversationIncompleteError);
		// …and it stops reading at the lock.
		expect(ix.calls.slice(asked).map((q) => q.cursor)).toEqual([undefined, '100']);
		c.destroy();
		c2.destroy();
	});

	it('messages in one block keep the order they were recorded in, on screen and in the export', async () => {
		const block = [
			rec(5, 'first', { at: 9 }),
			rec(6, 'second', { at: 9, from: 'alice' }),
			rec(7, 'third', { at: 9 })
		];
		const { d } = deps({ fetchHistory: fakeIndexer(block).fetchHistory });
		const c = await started(d);
		expect(texts(c.snapshot())).toEqual(['first', 'second', 'third']);
		expect(texts(await c.loadWholeConversation())).toEqual(['first', 'second', 'third']);
		c.destroy();
	});

	it('a message shown when the export starts is in it, even if its durable copy lands mid-export', async () => {
		const all = Array.from({ length: 150 }, (_, i) => rec(i + 1, `m${i + 1}`));
		const ix = keysetIndexer(all);
		const M = rec(200, 'shown before export started', { at: 200 });
		let h: StreamHandlers | null = null;
		let pages = 0;
		const { d } = deps({
			fetchHistory: async (a, b, o) => {
				const r = await ix.fetchHistory(a, b, o);
				if (o.limit === 100 && ++pages === 2) {
					// While page 2 is read, the chain makes M irreversible.
					all.push(M);
					h!.onAppend(M);
					await settle();
				}
				return r;
			},
			subscribeStream: (handlers) => {
				h = handlers;
				return () => undefined;
			}
		});
		const c = createConversationController(d);
		c.start();
		h!.onSnapshot(all.slice(-50).reverse());
		h!.onAppend({ ...M, id: 0, source_trx_id: '' } as ChatMessageRecord); // provisional
		await vi.advanceTimersByTimeAsync(0);
		const whole = await c.loadWholeConversation();
		expect(texts(whole).filter((t) => t === 'shown before export started')).toHaveLength(1);
		expect(whole).toHaveLength(151);
		expect(whole.at(-1)!.trxId).toBe('trx200');
		c.destroy();
	});

	it('a new payment claim that a history page reads first still updates the trade, once the live path brings it', async () => {
		const NEW = 'c'.repeat(64);
		const thread = Array.from({ length: 60 }, (_, i) => rec(i + 1, `x${i}`, { order: 'order-a' }));
		let h: StreamHandlers | null = null;
		const { d } = deps({
			orderPermlink: 'order-a',
			fetchHistory: keysetIndexer(thread).fetchHistory,
			subscribeStream: (handlers) => {
				h = handlers;
				return () => undefined;
			}
		});
		const c = createConversationController(d);
		c.start();
		h!.onSnapshot(thread.slice(-50).reverse());
		await vi.advanceTimersByTimeAsync(0);
		// A newer message of ours is already shown (t=300).
		const N = rec(300, 'did you pay?', { order: 'order-a', from: 'alice', at: 300 });
		h!.onAppend({ ...N, id: 0, source_trx_id: '' } as ChatMessageRecord);
		await vi.advanceTimersByTimeAsync(0);
		// The peer's claim (t=250) lands; scrolling back reads it first…
		const M = rec(250, claimFor(NEW, 'order-a'), { order: 'order-a', at: 250 });
		thread.push(M);
		await c.loadOlder();
		expect(getTradeState('bob', 'order-a')?.txid).toBeUndefined();
		// …then the stream delivers it.
		h!.onAppend(M);
		await vi.advanceTimersByTimeAsync(0);
		expect(getTradeState('bob', 'order-a')?.txid).toBe(NEW);
		expect(c.snapshot().filter((m) => m.id === 250)).toHaveLength(1);
		c.destroy();
	});

	it('opening a thread older than the newest 50 never replays its old payment claims', async () => {
		const OLD = 'a'.repeat(64);
		const NEW = 'b'.repeat(64);
		recordFundsSent({
			orderOwner: 'bob',
			orderPermlink: 'order-x',
			peer: 'bob',
			method: 'btc',
			txid: NEW,
			direction: 'incoming'
		});
		const data = [
			rec(1, claimFor(OLD, 'order-x'), { at: 1 }), // in the order-less thread
			...Array.from({ length: 60 }, (_, i) =>
				rec(100 + i, `b${i}`, { order: 'order-b', at: 100 + i })
			)
		];
		const { d } = deps({ fetchHistory: keysetIndexer(data).fetchHistory });
		const c = await started(d);
		expect(c.snapshot()).toHaveLength(0);
		await c.loadOlder();
		expect(c.snapshot()).toHaveLength(1);
		expect(getTradeState('bob', 'order-x')?.txid).toBe(NEW);
		c.destroy();
	});

	it('transcript order is the same whatever order the messages come in', () => {
		const t = new Date(1000);
		const a = { createdAt: t, id: 10, localSeq: 1 };
		const b = { createdAt: t, id: null, localSeq: 2 };
		const c = { createdAt: t, id: 5, localSeq: 3 };
		const d = { createdAt: null, id: null, localSeq: 0 };
		const e = { createdAt: new Date(500), id: 99, localSeq: 4 };
		const results = new Set<string>();
		const perms = [
			[a, b, c, d, e],
			[b, c, a, e, d],
			[e, c, a, b, d],
			[d, a, c, b, e],
			[b, a, d, c, e],
			[c, d, e, b, a]
		];
		for (const p of perms)
			results.add(
				p
					.sort(chronological)
					.map((x) => x.localSeq)
					.join(',')
			);
		expect([...results]).toEqual(['4,2,3,1,0']);
	});

	it('copies of one block arriving out of order are shown in the order recorded once durable', async () => {
		let h: StreamHandlers | null = null;
		const { d } = deps({
			subscribeStream: (handlers) => {
				h = handlers;
				return () => undefined;
			}
		});
		const c = await started(d);
		const A = rec(10, 'first on chain', { at: 50 });
		const B = rec(11, 'second on chain', { at: 50 });
		h!.onAppend({ ...B, id: 0, source_trx_id: '' } as ChatMessageRecord);
		h!.onAppend({ ...A, id: 0, source_trx_id: '' } as ChatMessageRecord);
		await vi.advanceTimersByTimeAsync(0);
		h!.onSnapshot([A, B]);
		await vi.advanceTimersByTimeAsync(0);
		expect(texts(c.snapshot())).toEqual(['first on chain', 'second on chain']);
		c.destroy();
	});

	it('an indexer handing out fresh cursors with nothing new stops the reads', async () => {
		let n = 0;
		const { d, history } = deps({
			fetchHistory: async () => {
				n++;
				if (n > 50) return { ok: false, message: 'test bound' };
				return { ok: true, items: [rec(1, 'same')], nextCursor: `c${n}` };
			}
		});
		const c = await started(d);
		await expect(c.loadWholeConversation()).rejects.toBeInstanceOf(ConversationIncompleteError);
		expect(n).toBeLessThan(10);
		const before = n;
		await c.loadOlder(); // adds the one message, and stops there
		await c.loadOlder();
		expect(history.at(-1)).toMatchObject({ failed: true, loading: false });
		expect(n - before).toBeLessThan(10);
		c.destroy();
	});

	it('an empty page that says there is more stops the reads', async () => {
		let n = 0;
		const { d } = deps({
			fetchHistory: async () => {
				n++;
				if (n > 50) return { ok: false, message: 'test bound' };
				return { ok: true, items: [], nextCursor: `c${n}` };
			}
		});
		const c = await started(d);
		await expect(c.loadWholeConversation()).rejects.toBeInstanceOf(ConversationIncompleteError);
		expect(n).toBeLessThan(10);
		c.destroy();
	});

	it('an indexer that goes round in circles stops the reads instead of asking forever', async () => {
		let n = 0;
		const { d, history } = deps({
			fetchHistory: async (_a, _b, o) => {
				n++;
				// A bound for the test itself: without the guard, this would run on.
				if (n > 50) return { ok: false, message: 'test bound' };
				return {
					ok: true,
					// New rows every time, of another thread (so this one gains
					// nothing and reads on), while the cursor goes x, y, x, …
					items: [rec(1000 + n, `m${n}`, { order: 'order-z' })],
					nextCursor: o.cursor === 'x' ? 'y' : 'x'
				};
			}
		});
		const c = await started(d);
		await expect(c.loadWholeConversation()).rejects.toBeInstanceOf(ConversationIncompleteError);
		expect(n).toBeLessThan(10);
		n = 0;
		await c.loadOlder();
		await c.loadOlder();
		expect(history.at(-1)).toMatchObject({ failed: true, loading: false });
		expect(n).toBeLessThan(10);
		c.destroy();
	});

	it('the export of a long conversation outlasts the indexer rate limit (120 a minute)', async () => {
		const all = Array.from({ length: 12_500 }, (_, i) => rec(i + 1, `m${i + 1}`));
		const ix = keysetIndexer(all);
		let now = 0; // virtual ms
		const stamps: number[] = [];
		let limited = 0;
		const { d } = deps({
			fetchHistory: async (a, b, o) => {
				now += 60; // one round trip
				while (stamps.length && stamps[0]! <= now - 60_000) stamps.shift();
				if (stamps.length >= 120) {
					limited++;
					return { ok: false, message: 'rate limited' };
				}
				stamps.push(now);
				return ix.fetchHistory(a, b, o);
			},
			sleep: async (ms) => {
				now += ms;
			},
			decrypt: async () => ({ text: 'x', authenticated: true })
		});
		const c = await started(d);
		const whole = await c.loadWholeConversation();
		expect(whole).toHaveLength(12_500);
		expect(limited).toBeGreaterThan(0); // it did hit the limit, and read on
		c.destroy();
	});

	it('page boundaries inside a block: every message once, in the order recorded', async () => {
		// 7 messages per block, so the 50 and 100 boundaries fall inside blocks.
		const all = Array.from({ length: 333 }, (_, i) =>
			rec(i + 1, `m${i + 1}`, { at: Math.floor(i / 7), from: i % 3 ? 'bob' : 'alice' })
		);
		const { d } = deps({ fetchHistory: keysetIndexer(all).fetchHistory });
		const c = await started(d);
		for (let i = 0; i < 10; i++) await c.loadOlder();
		expect(c.snapshot().map((m) => m.id)).toEqual(all.map((r) => r.id));
		expect(texts(await c.loadWholeConversation())).toEqual(all.map((r) => unb64(r.ciphertext)));
		c.destroy();
	});

	it('the lock generation changes on a lock, so plaintext read before it can be refused after', async () => {
		const { d } = deps({ fetchHistory: fakeIndexer([rec(1, 'hi')]).fetchHistory });
		const c = await started(d);
		const g = c.lockGeneration();
		expect(c.lockGeneration()).toBe(g);
		clearOwnSentPlaintextCache(); /* the session lock */
		expect(c.lockGeneration()).not.toBe(g);
		c.destroy();
	});

	it('ready is said once the first live answer is in, even with nothing for this thread', async () => {
		const { d, history } = deps({
			fetchHistory: fakeIndexer([rec(1, 'other', { order: 'order-b' })]).fetchHistory,
			orderPermlink: 'order-a'
		});
		const c = await started(d);
		expect(c.snapshot()).toHaveLength(0);
		expect(history.at(-1)).toEqual({ ready: true, loading: false, complete: false, failed: false });
		c.destroy();
	});
});
