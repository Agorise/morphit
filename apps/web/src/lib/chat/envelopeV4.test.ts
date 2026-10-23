/**
 * The posting-key envelope v4 (review C-M2): v3 bound to the ORDER it was sent
 * about and its SEND TIME.
 *
 * v3 authenticates the words only. The order travels beside the ciphertext
 * (the record's order_permlink) and the time is the indexer's created_at, so
 * an indexer — or anyone rebroadcasting the same bytes — could show an
 * authenticated "funds sent" under another order between the same two
 * people, or at another time. v4 opens only under the order and the time it
 * was sealed with, and the time shown stays near that time.
 *
 * Read first: this release reads v4 and still writes v3 (WRITE_ENVELOPE_V4);
 * the tests that write v4 turn it on for that controller.
 *
 * Real crypto, two real parties; only the network and the chain are fakes.
 *
 * (The v4 domain strings — "…-v4" in the KEK, wrap and commit labels — are
 * hygiene, not a guard: the order and time bytes in the AAD and the commit
 * already keep v3 and v4 apart, so no test here can fail on the labels
 * alone. Every other part of the binding is seen failing by mutation.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as secp from '@noble/secp256k1';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';
import {
	clearOwnSentPlaintextCache,
	createConversationController,
	postingEnvelopeCrypto,
	shownTime,
	ENVELOPE_TIME_EARLY_S,
	ENVELOPE_TIME_LATE_S,
	type ChatControllerDeps
} from './chatService';
import {
	DecryptError,
	decryptPostingEnvelope,
	decryptPostingSelfCopy,
	encryptToPostingKey,
	postingPubOf,
	postingReader,
	type PostingEnvelopeWire
} from './crypto';
import { clearAllPins } from './pubPin';
import { announceSettledElsewhere } from './settledElsewhere';
import { sendBinding, ENVELOPE_CLOCK_AGREE_S } from './envelopeBinding';
import { encodeAddressPayload } from './payload';
import { get } from 'svelte/store';
import * as ts from '$lib/trades/tradeStatus';

const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
	localStorage: {
		getItem: (k: string) => mem.get(k) ?? null,
		setItem: (k: string, v: string) => void mem.set(k, String(v)),
		removeItem: (k: string) => void mem.delete(k),
		clear: () => mem.clear(),
		key: (i: number) => [...mem.keys()][i] ?? null,
		get length() {
			return mem.size;
		}
	},
	sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
};

interface Party {
	name: string;
	priv: Uint8Array;
	pub: Uint8Array;
	live: LiveIdentity;
}
const party = (name: string): Party => {
	const priv = secp.utils.randomPrivateKey();
	const pub = postingPubOf(priv);
	return {
		name,
		priv,
		pub,
		live: {
			posting: { role: 'posting', privateKey: priv, publicKey: pub }
		} as unknown as LiveIdentity
	};
};

const buyer = party('buyer-anna');
const seller = party('seller-bo');
const keys = new Map<string, Uint8Array[]>([
	[buyer.name, [buyer.pub]],
	[seller.name, [seller.pub]]
]);

/** The chain's head time the sender reads when it seals (whole seconds). */
const T = Math.floor(Date.UTC(2026, 9, 20, 12, 0, 0) / 1000);
const iso = (s: number) => new Date(s * 1000).toISOString();

let chain: ChatMessageRecord[] = [];
let nextId = 1;
/** When the (honest) chain records a message: a few seconds after T. */
let recordedAt = T + 4;

function deps(
	me: Party,
	peer: string,
	order: string | null,
	over: Partial<ChatControllerDeps> = {}
): ChatControllerDeps & { sent: Record<string, unknown>[] } {
	const sent: Record<string, unknown>[] = [];
	let tag = 0;
	return {
		me: me.name,
		peer,
		orderPermlink: order,
		getLiveIdentity: () => me.live,
		now: () => new Date(),
		visibilityState: () => 'visible',
		onVisibilityChange: () => () => undefined,
		generateClientTag: () => `${me.name}-tag-${++tag}`.padEnd(32, '0'),
		fetchHistory: async (a, b) => ({
			ok: true,
			items: chain.filter(
				(r) => (r.sender === a && r.recipient === b) || (r.sender === b && r.recipient === a)
			),
			nextCursor: null
		}),
		broadcast: async (_live, payload) => {
			sent.push(payload);
			chain.push({
				id: nextId++,
				sender: me.name,
				recipient: payload.recipient as string,
				ciphertext: payload.ciphertext as string,
				header: payload.header as Record<string, unknown>,
				created_at: iso(recordedAt),
				...(typeof payload.order_permlink === 'string'
					? { order_permlink: payload.order_permlink }
					: {})
			} as ChatMessageRecord);
			return { block_num: null, trx_id: `trx${nextId}` };
		},
		fetchPeerChatPub: async () => null,
		deriveMyChatIdentity: async () => {
			throw new Error('no chat key in this test');
		},
		decrypt: async () => null,
		fetchPostingPubs: async (account) => keys.get(account) ?? null,
		...postingEnvelopeCrypto,
		chainNowSeconds: async () => T,
		onChange: () => undefined,
		...over,
		sent
	};
}
const v4 = { writeEnvelopeV4: true };

async function view(d: ChatControllerDeps) {
	const c = createConversationController(d);
	c.start();
	await vi.runOnlyPendingTimersAsync();
	return c;
}

beforeEach(() => {
	vi.useFakeTimers();
	// This device's clock agrees with the chain's head time (sendBinding).
	vi.setSystemTime(new Date(T * 1000 + 1500));
	clearOwnSentPlaintextCache();
	clearAllPins();
	chain = [];
	nextId = 1;
	recordedAt = T + 4;
});
afterEach(() => {
	vi.useRealTimers();
});

// ─── The construction ────────────────────────────────────────────────────
describe('v4 opens only under the order and the time it was sealed with', () => {
	/** The buyer writes to the seller; an order is the seller's unless said. */
	const seal = (order: string | null, t: number, owner: string | null = order && seller.name) =>
		encryptToPostingKey(
			'funds sent: 0xabc',
			[seller.pub],
			buyer.priv,
			buyer.name,
			seller.name,
			true,
			{
				order,
				owner,
				t
			}
		);
	const open = (env: PostingEnvelopeWire, order: string | null) =>
		decryptPostingEnvelope(
			env,
			postingReader(seller.priv),
			buyer.name,
			seller.name,
			[buyer.pub],
			order
		);
	const openOwn = (env: PostingEnvelopeWire, order: string | null) =>
		decryptPostingSelfCopy(env, postingReader(buyer.priv), buyer.name, seller.name, order);

	it('round trip: v 4 with its time; the recipient and the sender’s own copy open it, proved', async () => {
		const env = await seal('order-a', T);
		expect(env.v).toBe(4);
		expect(env.t).toBe(T);
		expect(await open(env, 'order-a')).toEqual({ text: 'funds sent: 0xabc', authenticated: true });
		expect(await openOwn(env, 'order-a')).toBe('funds sent: 0xabc');
	});

	it('under another order (or none): it does not open, for the recipient or the sender', async () => {
		const env = await seal('order-a', T);
		await expect(open(env, 'order-b')).rejects.toBeInstanceOf(DecryptError);
		await expect(open(env, null)).rejects.toBeInstanceOf(DecryptError);
		await expect(openOwn(env, 'order-b')).rejects.toBeInstanceOf(DecryptError);
		// A direct message moved INTO an order thread: the same.
		const direct = await seal(null, T);
		await expect(open(direct, 'order-a')).rejects.toBeInstanceOf(DecryptError);
		expect((await open(direct, null)).text).toBe('funds sent: 0xabc');
	});

	it('with another time: it does not open', async () => {
		const env = await seal('order-a', T);
		await expect(open({ ...env, t: T + 86_400 }, 'order-a')).rejects.toBeInstanceOf(DecryptError);
		await expect(openOwn({ ...env, t: T - 1 }, 'order-a')).rejects.toBeInstanceOf(DecryptError);
	});

	it('about the same permlink under ANOTHER owner: it does not open; an owner who is not a party is refused', async () => {
		const env = await seal('order-a', T); // the seller's order-a
		expect(env.o).toBe(seller.name);
		await expect(open({ ...env, o: buyer.name }, 'order-a')).rejects.toBeInstanceOf(DecryptError);
		await expect(openOwn({ ...env, o: buyer.name }, 'order-a')).rejects.toBeInstanceOf(
			DecryptError
		);
		await expect(open({ ...env, o: 'someone-else' }, 'order-a')).rejects.toBeInstanceOf(
			DecryptError
		);
		await expect(open({ ...env, o: undefined }, 'order-a')).rejects.toBeInstanceOf(DecryptError);
		// The buyer's own order by the same permlink: its own message, which opens.
		const mine = await seal('order-a', T, buyer.name);
		expect((await open(mine, 'order-a')).text).toBe('funds sent: 0xabc');
		// Sealing: an owner who is not a party, no owner for an order, or an
		// owner without an order are refused.
		await expect(seal('order-a', T, 'someone-else')).rejects.toThrow(/order binding/);
		await expect(seal('order-a', T, null)).rejects.toThrow(/order binding/);
		await expect(seal(null, T, seller.name)).rejects.toThrow(/order binding/);
	});

	it('relabelled v3 (its binding stripped): it does not open — v4 is not v3 with a label', async () => {
		const env = await seal('order-a', T);
		const { t: _t, o: _o, ...rest } = env;
		await expect(open({ ...rest, v: 3 }, 'order-a')).rejects.toBeInstanceOf(DecryptError);
		await expect(open({ ...rest, v: 3 }, null)).rejects.toBeInstanceOf(DecryptError);
	});

	it('a time that is not a plausible whole second is refused, sealing and reading', async () => {
		for (const bad of [T + 0.5, -1, 0, 4_102_444_800, Number.NaN])
			await expect(seal('order-a', bad)).rejects.toThrow(/time out of range/);
		const env = await seal('order-a', T);
		await expect(open({ ...env, t: undefined }, 'order-a')).rejects.toBeInstanceOf(DecryptError);
		await expect(
			open({ ...env, t: String(T) as unknown as number }, 'order-a')
		).rejects.toBeInstanceOf(DecryptError);
	});

	it('v3 is unchanged: no binding, opens under any order (the gap v4 closes)', async () => {
		const env = await encryptToPostingKey('hi', [seller.pub], buyer.priv, buyer.name, seller.name);
		expect(env.v).toBe(3);
		expect('t' in env).toBe(false);
		expect((await open(env, 'order-b')).text).toBe('hi');
	});
});

// ─── The time shown ──────────────────────────────────────────────────────
describe('the time shown for a v4 message', () => {
	it('the chain’s time while it agrees with the bound time; the bound time when it does not', () => {
		const at = (s: number) => shownTime(iso(s), T).getTime() / 1000;
		expect(at(T + 4)).toBe(T + 4);
		expect(at(T + ENVELOPE_TIME_LATE_S)).toBe(T + ENVELOPE_TIME_LATE_S);
		expect(at(T - ENVELOPE_TIME_EARLY_S)).toBe(T - ENVELOPE_TIME_EARLY_S);
		expect(at(T + ENVELOPE_TIME_LATE_S + 1)).toBe(T);
		expect(at(T - ENVELOPE_TIME_EARLY_S - 1)).toBe(T);
		expect(shownTime('not a date', T).getTime() / 1000).toBe(T);
		// An indexer may move it by at most a few minutes: ten minutes late, or
		// three early, and the bound time is shown.
		expect(at(T + 600)).toBe(T);
		expect(at(T - 180)).toBe(T);
		// No bound time (v3, older, unopened): the chain's time as before.
		expect(shownTime(iso(T + 86_400), undefined).getTime() / 1000).toBe(T + 86_400);
	});
});

// ─── In a conversation ───────────────────────────────────────────────────
describe('a conversation', () => {
	it('writes v3 by default (read first: v4 only once every instance reads it)', async () => {
		const d = deps(buyer, seller.name, 'order-a');
		const c = await view(d);
		await c.sendMessage('hello');
		const h = d.sent[0]!.header as Record<string, unknown>;
		expect(h.v).toBe(3);
		expect('t' in h).toBe(false);
		c.destroy();
	});

	it('v4 turned on: sealed with the chain’s time; the recipient reads it in the order thread, proved', async () => {
		const d = deps(buyer, seller.name, 'order-a', v4);
		const c = await view(d);
		await c.sendMessage('paid, see tx');
		const h = d.sent[0]!.header as Record<string, unknown>;
		expect(h.v).toBe(4);
		expect(h.t).toBe(T);
		expect(d.sent[0]!.order_permlink).toBe('order-a');
		// Three recipient keys, a self-copy: still a small header (the
		// indexer bounds it at 4,096 bytes).
		expect(JSON.stringify(h).length).toBeLessThan(1024);
		c.destroy();

		const r = await view(deps(seller, buyer.name, 'order-a'));
		const got = r.snapshot();
		expect(got.map((m) => [m.text, m.decryptFailed, m.senderUnverified ?? false])).toEqual([
			['paid, see tx', false, false]
		]);
		expect(got[0]!.createdAt!.getTime() / 1000).toBe(T + 4);
		r.destroy();
	});

	it('a direct message (no order) in v4 reads in the direct thread', async () => {
		const c = await view(deps(buyer, seller.name, null, v4));
		await c.sendMessage('hi direct');
		c.destroy();
		const r = await view(deps(seller, buyer.name, null));
		expect(r.snapshot().map((m) => [m.text, m.decryptFailed])).toEqual([['hi direct', false]]);
		r.destroy();
	});

	it('moved by the indexer to another order of the same two people: not shown as their words', async () => {
		const c = await view(deps(buyer, seller.name, 'order-a', v4));
		await c.sendMessage('funds sent for A');
		c.destroy();
		chain = chain.map((r) => ({ ...r, order_permlink: 'order-b' }));
		const r = await view(deps(seller, buyer.name, 'order-b'));
		const got = r.snapshot();
		expect(got).toHaveLength(1);
		expect(got[0]!.decryptFailed).toBe(true);
		expect(got[0]!.text).not.toContain('funds sent');
		r.destroy();
		// …and our own view of it, from its self-copy, refuses it the same way.
		clearOwnSentPlaintextCache();
		const own = await view(deps(buyer, seller.name, 'order-b'));
		expect(own.snapshot().map((m) => m.text)).not.toContain('funds sent for A');
		own.destroy();
	});

	it('a header time changed in transit: not shown as their words', async () => {
		const c = await view(deps(buyer, seller.name, 'order-a', v4));
		await c.sendMessage('at noon');
		c.destroy();
		chain = chain.map((r) => ({
			...r,
			header: { ...(r.header as Record<string, unknown>), t: T - 86_400 }
		}));
		const r = await view(deps(seller, buyer.name, 'order-a'));
		expect(r.snapshot().map((m) => m.decryptFailed)).toEqual([true]);
		r.destroy();
	});

	it('an indexer time a day off: the bound time is shown, for the recipient and for the sender', async () => {
		recordedAt = T + 86_400;
		const c = await view(deps(buyer, seller.name, 'order-a', v4));
		await c.sendMessage('when?');
		// Our live copy, confirmed by the record that came back.
		await vi.runOnlyPendingTimersAsync();
		const mine = c.snapshot()[0]!;
		expect(mine.createdAt!.getTime() / 1000).toBe(T);
		c.destroy();

		const r = await view(deps(seller, buyer.name, 'order-a'));
		expect(r.snapshot()[0]!.createdAt!.getTime() / 1000).toBe(T);
		r.destroy();

		clearOwnSentPlaintextCache();
		const own = await view(deps(buyer, seller.name, 'order-a'));
		expect(own.snapshot().map((m) => [m.text, m.createdAt!.getTime() / 1000])).toEqual([
			['when?', T]
		]);
		own.destroy();
	});

	it('our live copy confirmed by a provisional copy (fast path) a day off: the bound time', async () => {
		recordedAt = T + 86_400;
		const d = deps(buyer, seller.name, 'order-a', v4);
		const inner = d.broadcast;
		d.broadcast = async (live, payload, acct) => {
			const r = await inner(live, payload, acct);
			chain = chain.map((x) => ({ ...x, id: 0 })); // not yet irreversible
			return r;
		};
		const c = await view(d);
		await c.sendMessage('fast');
		await vi.runOnlyPendingTimersAsync();
		const mine = c.snapshot()[0]!;
		expect(mine.state).toBe('confirmed');
		expect(mine.createdAt!.getTime() / 1000).toBe(T);
		c.destroy();
	});

	it('a v3 message keeps the indexer’s time (nothing to bound it with)', async () => {
		recordedAt = T + 86_400;
		const c = await view(deps(buyer, seller.name, 'order-a'));
		await c.sendMessage('v3 time');
		c.destroy();
		const r = await view(deps(seller, buyer.name, 'order-a'));
		expect(r.snapshot()[0]!.createdAt!.getTime() / 1000).toBe(T + 86_400);
		r.destroy();
	});

	it('a retry is sealed afresh, with its own time', async () => {
		let now = T;
		let fail = true;
		const d = deps(buyer, seller.name, 'order-a', {
			...v4,
			chainNowSeconds: async () => now
		});
		const inner = d.broadcast;
		d.broadcast = async (live, payload, acct) => {
			if (fail) {
				fail = false;
				d.sent.push(payload);
				throw new Error('network down');
			}
			return inner(live, payload, acct);
		};
		const c = await view(d);
		await c.sendMessage('try again');
		expect(c.snapshot()[0]!.state).toBe('failed');
		now = T + 120;
		await c.retryMessage(c.snapshot()[0]!.localSeq);
		expect(d.sent.map((p) => (p.header as Record<string, unknown>).t)).toEqual([T, T + 120]);
		c.destroy();
	});
});

// ─── What a send binds, or not ───────────────────────────────────────────
describe('sendBinding: v4 only when the order owner and the time can be bound', () => {
	const base = {
		write: true,
		order: 'order-a',
		ownerOf: async () => seller.name,
		chainNowSeconds: async () => T,
		deviceNowMs: () => T * 1000
	};
	it('all known and agreeing: bound to the order, its owner and the chain’s time', async () => {
		expect(await sendBinding(base)).toEqual({ order: 'order-a', owner: seller.name, t: T });
		expect(await sendBinding({ ...base, order: null })).toEqual({ order: null, owner: null, t: T });
	});
	it('writing off, the owner not known (or nobody’s), no head time: v3', async () => {
		expect(await sendBinding({ ...base, write: false })).toBeUndefined();
		expect(await sendBinding({ ...base, ownerOf: async () => null })).toBeUndefined();
		expect(await sendBinding({ ...base, ownerOf: async () => false })).toBeUndefined();
		expect(
			await sendBinding({ ...base, ownerOf: () => Promise.reject(new Error('x')) })
		).toBeUndefined();
		expect(
			await sendBinding({ ...base, chainNowSeconds: () => Promise.reject(new Error('x')) })
		).toBeUndefined();
	});
	it('a head time this device’s clock disagrees with (the instance chose it): v3', async () => {
		const at = (dev: number) => sendBinding({ ...base, deviceNowMs: () => dev * 1000 });
		expect(await at(T + ENVELOPE_CLOCK_AGREE_S)).toBeDefined();
		expect(await at(T - ENVELOPE_CLOCK_AGREE_S)).toBeDefined();
		expect(await at(T + ENVELOPE_CLOCK_AGREE_S + 1)).toBeUndefined();
		expect(await at(T - ENVELOPE_CLOCK_AGREE_S - 1)).toBeUndefined();
	});
	it('in a conversation: an instance’s head time a day off this device’s clock is not sealed in', async () => {
		const d = deps(buyer, seller.name, 'order-a', {
			...v4,
			chainNowSeconds: async () => T + 86_400
		});
		const c = await view(d);
		await c.sendMessage('hello');
		expect((d.sent[0]!.header as Record<string, unknown>).v).toBe(3);
		c.destroy();
	});
});

// ─── The order owner a v4 message was sealed about ───────────────────────
describe('a v4 trade message moves only the trade on the owner it names', () => {
	const addr = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: buyer.name,
		orderPermlink: 'order-a'
	});
	/** The buyer shares an address about order-a, which the BUYER's client
	 *  takes to be the buyer's own; the seller's lookup says `sellerSees`. */
	async function run(sellerSees: string) {
		const c = await view(
			deps(buyer, seller.name, 'order-a', { ...v4, orderOwnerOf: async () => buyer.name })
		);
		await c.sendMessage(addr);
		await vi.runOnlyPendingTimersAsync();
		c.destroy();
		ts.clearAllTradeStates(); // only the seller's side counts below
		let snap: ((items: readonly ChatMessageRecord[]) => void) | null = null;
		const r = await view(
			deps(seller, buyer.name, 'order-a', {
				fetchHistory: async () => ({ ok: true, items: [], nextCursor: null }),
				orderOwnerOf: async () => sellerSees,
				subscribeStream: (h) => {
					snap = h.onSnapshot;
					return () => undefined;
				}
			})
		);
		snap!([...chain]);
		await vi.runOnlyPendingTimersAsync();
		r.destroy();
		return [...get(ts.tradeStates).values()];
	}
	it('the owner as looked up is the one it names: recorded under it', async () => {
		const got = await run(buyer.name);
		expect(got.map((e) => [e.orderOwner, e.address])).toEqual([[buyer.name, buyer.name]]);
	});
	it('the same permlink looked up as OURS: not our trade, nothing recorded', async () => {
		expect(await run(seller.name)).toEqual([]);
	});
});

// ─── Our own words, from memory ──────────────────────────────────────────
describe('the in-memory copy of what we sent', () => {
	it('is not shown for a record an indexer re-filed under another order, in the same session', async () => {
		const c = await view(deps(buyer, seller.name, 'order-a', v4));
		await c.sendMessage('funds sent for A');
		c.destroy();
		chain = chain.map((r) => ({ ...r, order_permlink: 'order-b' }));
		// No lock, no reload: the in-memory copy is still there.
		const own = await view(deps(buyer, seller.name, 'order-b'));
		expect(own.snapshot().map((m) => m.text)).not.toContain('funds sent for A');
		own.destroy();
	});
	it('a record without a self-copy is shown from memory in its own thread only', async () => {
		const c = await view(deps(buyer, seller.name, 'order-a', v4));
		await c.sendMessage('kept in memory');
		c.destroy();
		// An indexer strips the self-copy, so only the in-memory copy can say
		// what it was.
		const strip = (order: string) =>
			chain.map((r) => {
				const { self_ciphertext: _c, self_nonce: _n, ...h } = r.header as Record<string, unknown>;
				return { ...r, header: h, order_permlink: order };
			});
		const original = chain;
		chain = strip('order-a');
		const same = await view(deps(buyer, seller.name, 'order-a'));
		expect(same.snapshot().map((m) => m.text)).toEqual(['kept in memory']);
		same.destroy();
		chain = strip('order-b');
		const moved = await view(deps(buyer, seller.name, 'order-b'));
		expect(moved.snapshot().map((m) => m.text)).not.toContain('kept in memory');
		moved.destroy();
		chain = original;
	});
});

// ─── Retries ─────────────────────────────────────────────────────────────
describe('a retry folded into its first attempt', () => {
	it('shows the time of the attempt that landed, not the first one’s', async () => {
		let now = T;
		let n = 0;
		const d = deps(buyer, seller.name, 'order-a', {
			...v4,
			chainNowSeconds: async () => now,
			generateClientTag: () => String(++n).padStart(32, 'a') // tags are hex
		});
		let first = true;
		d.broadcast = async (_live, payload) => {
			d.sent.push(payload);
			chain.push({
				id: first ? 0 : nextId++, // the first only ever reached the fast path
				sender: buyer.name,
				recipient: seller.name,
				ciphertext: payload.ciphertext as string,
				header: payload.header as Record<string, unknown>,
				created_at: iso(recordedAt),
				order_permlink: 'order-a'
			} as ChatMessageRecord);
			if (first) {
				first = false;
				throw new Error('network down');
			}
			return { block_num: null, trx_id: 'trx-retry' };
		};
		const c = await view(d);
		await c.sendMessage('paid at last');
		// Three hours later the retry goes out, and lands.
		now = T + 3 * 3600;
		recordedAt = now + 4;
		vi.setSystemTime(new Date(now * 1000));
		await c.retryMessage(c.snapshot()[0]!.localSeq);
		c.destroy();
		// The recipient saw the first attempt live (fast path), then the retry.
		let snap: ((items: readonly ChatMessageRecord[]) => void) | null = null;
		const r = await view(
			deps(seller, buyer.name, 'order-a', {
				fetchHistory: async () => ({ ok: true, items: [], nextCursor: null }),
				subscribeStream: (h) => {
					snap = h.onSnapshot;
					return () => undefined;
				}
			})
		);
		snap!([chain[0]!]);
		await vi.runOnlyPendingTimersAsync();
		snap!([chain[1]!]);
		await vi.runOnlyPendingTimersAsync();
		const got = r.snapshot();
		expect(got.map((m) => m.text)).toEqual(['paid at last']);
		expect(got[0]!.createdAt!.getTime() / 1000).toBe(now + 4);
		r.destroy();
	});
});

// ─── Our own trade record, while the order owner is looked up ────────────
describe('an outgoing trade record', () => {
	const addr = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: seller.name,
		orderPermlink: 'order-a'
	});
	it('the owner could not be told at first: asked again, then recorded', async () => {
		let answers: (string | null)[] = [null, null, seller.name];
		const c = await view(
			deps(seller, buyer.name, 'order-a', {
				orderOwnerOf: async () => answers.shift() ?? null
			})
		);
		ts.clearAllTradeStates();
		await c.sendMessage(addr);
		await vi.advanceTimersByTimeAsync(0);
		expect(get(ts.tradeStates).size).toBe(0);
		await vi.advanceTimersByTimeAsync(2_000 + 4_000);
		expect(ts.getTradeState(seller.name, 'order-a')?.engagedPeer).toBe(buyer.name);
		c.destroy();
		answers = [];
	});
	it('a lock or sign-out while it waits (even with the view closed): nothing is recorded', async () => {
		let release: (v: string) => void = () => undefined;
		const c = await view(
			deps(seller, buyer.name, 'order-a', {
				orderOwnerOf: () => new Promise<string>((res) => (release = res))
			})
		);
		ts.clearAllTradeStates();
		await c.sendMessage(addr);
		c.destroy();
		clearOwnSentPlaintextCache(); // the lock / sign-out hook
		release(seller.name);
		await vi.advanceTimersByTimeAsync(0);
		expect(get(ts.tradeStates).size).toBe(0);
	});
});

// ─── The settled-elsewhere notice ────────────────────────────────────────
describe('the "settled with someone else" notice', () => {
	const announce = (writeEnvelopeV4?: boolean) => {
		const sent: Record<string, unknown>[] = [];
		return announceSettledElsewhere(
			{
				fetchOrderInquirers: async () => [buyer.name],
				broadcast: async (_l, p) => {
					sent.push(p);
					return { block_num: null, trx_id: 't' };
				},
				generateClientTag: () => 'c'.repeat(32),
				fetchPostingPubs: async (a) => keys.get(a) ?? null,
				encryptPosting: postingEnvelopeCrypto.encryptPosting,
				chainNowSeconds: async () => T,
				...(writeEnvelopeV4 !== undefined ? { writeEnvelopeV4 } : {})
			},
			{ orderPermlink: 'order-a', counterparty: 'someone-else', me: seller.name, live: seller.live }
		).then(() => sent);
	};

	it('v3 by default; v4 bound to the order it names when turned on, and it opens there only', async () => {
		const plain = await announce();
		expect((plain[0]!.header as Record<string, unknown>).v).toBe(3);
		const bound = await announce(true);
		const h = bound[0]!.header as Record<string, unknown>;
		expect(h.v).toBe(4);
		expect(h.t).toBe(T);
		expect(h.o).toBe(seller.name); // the announcer's own order
		const env = {
			v: 4 as const,
			t: h.t as number,
			o: h.o as string,
			ciphertext: bound[0]!.ciphertext as string,
			ephemeralPub: h.ephemeral_pub as string,
			nonce: h.nonce as string,
			senderKey: h.sk as string,
			recipientKeys: h.rk as string[],
			wraps: h.wk as string[]
		};
		const reader = postingReader(buyer.priv);
		expect(
			(await decryptPostingEnvelope(env, reader, seller.name, buyer.name, [], 'order-a')).text
		).toContain('order-a');
		await expect(
			decryptPostingEnvelope(env, reader, seller.name, buyer.name, [], 'order-b')
		).rejects.toBeInstanceOf(DecryptError);
	});
});
