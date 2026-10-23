/**
 * The global trade listener (v1.21.14 full chat audit):
 *
 *   W-H2  it holds no stream of its own: an activity ping names a peer, and
 *         that peer's conversation is read once (a chat stream closed at its
 *         snapshot), one read at a time;
 *   W-M4  a message is known by its sender and encrypted bytes, not its id:
 *         every fast copy has id 0, so keying by id dropped every fast copy
 *         after the first and processed the durable copy a second time —
 *         putting a verified payment back to "Verifying…" for good;
 *   W-H1  a payload moves a trade only for the order of the thread it arrived
 *         in, when that order is the sender's or ours.
 *
 * The real listener, trade store and payload codec; the streams, the crypto
 * and the indexer are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, readable } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$stores/identity', () => ({
	liveIdentity: readable({ posting: { privateKey: new Uint8Array(32).fill(1) } })
}));
vi.mock('svelte-i18n', () => ({ _: readable((k: string) => k), locale: readable('en') }));
const toasts: string[] = [];
vi.mock('$lib/stores/toast', () => ({ showToast: (b: string) => void toasts.push(b) }));
vi.mock('$lib/notifications', () => ({ notify: () => undefined }));
vi.mock('$lib/balance/bus', () => ({ triggerBalanceRefresh: () => undefined }));
vi.mock('$lib/chat/blurtVerify', () => ({
	verifyBlurtTransfer: async () => ({ kind: 'verified' })
}));
vi.mock('$lib/chat/pubPin', () => ({
	pinnedPubsFor: () => ['AAAA'],
	pinnedPostingFor: () => ['AAAA']
}));
const texts = new Map<string, string>();
const decrypted: string[] = [];
vi.mock('$lib/chat/crypto', () => {
	class DecryptError extends Error {}
	return {
		DecryptError,
		decodeChatPub: () => new Uint8Array(32),
		deriveChatIdentity: async () => ({ priv: new Uint8Array(32), pub: new Uint8Array(32) }),
		decryptFromSender: async (env: { ciphertext: string }) => {
			decrypted.push(env.ciphertext);
			return { text: texts.get(env.ciphertext) ?? 'plain', authenticated: true };
		},
		// The posting-key envelope (v3/v4): opens as the test says.
		validEnvelopeTime: (t: unknown) => typeof t === 'number',
		postingReader: () => ({}),
		wipePostingReader: () => undefined,
		decryptPostingEnvelope: async (env: { ciphertext: string }) => {
			decrypted.push(env.ciphertext);
			return { text: texts.get(env.ciphertext) ?? 'plain', authenticated: true };
		}
	};
});
const findOrder = vi.fn();
vi.mock('$lib/indexer/client', () => ({ findOrder: (...a: unknown[]) => findOrder(...a) }));

/** Every chat stream the listener opens: its peer, and how to answer it. */
interface FakeRead {
	peer: string;
	open: boolean;
	snapshot(items: unknown[]): void;
	fail(): void;
}
const reads: FakeRead[] = [];
vi.mock('$lib/chat/stream', () => ({
	createChatStream: (a: {
		peer: string;
		handlers: {
			onSnapshot: (s: { items: unknown[] }) => void;
			onStreamingChange?: (s: boolean) => void;
		};
	}) => {
		const r: FakeRead = {
			peer: a.peer,
			open: false,
			snapshot: (items) => a.handlers.onSnapshot({ items }),
			fail: () => a.handlers.onStreamingChange?.(false)
		};
		reads.push(r);
		return {
			start: () => {
				r.open = true;
			},
			stop: () => {
				r.open = false;
			}
		};
	}
}));
type Ping = { peer: string; order: string | null; inbound: boolean };
let ping: ((p: Ping) => void) | null = null;
vi.mock('$lib/chat/globalChatActivityStream', () => ({
	subscribeChatActivityPings: (fn: (p: Ping) => void) => {
		ping = fn;
		return () => {
			ping = null;
		};
	}
}));
(globalThis as unknown as { window: unknown }).window = Object.assign(globalThis, {
	location: { pathname: '/en/orderbook' }
});

import { encodeAddressPayload, encodeFundsSentPayload } from '$lib/chat/payload';
const ts = await import('$lib/trades/tradeStatus');
const L = await import('$lib/trades/tradeEventListener');
const { __resetOrderParties } = await import('$lib/trades/orderParties');

const MINE = 'alice-sells-blurt';
let n = 0;
function rec(id: number, ct: string, order: string | null = MINE, sender = 'bob') {
	return {
		id,
		sender,
		recipient: 'alice',
		ciphertext: ct,
		header: {
			v: 2,
			ephemeral_pub: `e-${ct}`,
			nonce: `n-${ct}`,
			client_tag: `${++n}`.padStart(32, '0')
		},
		created_at: '2026-10-21T12:00:00.000Z',
		order_permlink: order
	};
}
const fundsSent = (order: string, txid = 'a'.repeat(40)) =>
	encodeFundsSentPayload({
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'blurt',
		txid,
		amount: '5',
		memo: 'memo12345',
		orderPermlink: order
	});
const addressFor = (order: string, to: string) =>
	encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: to,
		orderPermlink: order
	});

const settle = () => vi.advanceTimersByTimeAsync(0);
const openReads = () => reads.filter((r) => r.open);
const lastRead = () => reads[reads.length - 1]!;

beforeEach(() => {
	vi.useFakeTimers();
	reads.length = 0;
	toasts.length = 0;
	decrypted.length = 0;
	texts.clear();
	ts.clearAllTradeStates();
	__resetOrderParties();
	findOrder.mockReset();
	// MINE is alice's own order (any inquirer is a party to it).
	findOrder.mockImplementation(async (account: string, permlink: string) =>
		account === 'alice' && permlink === MINE ? { permlink } : null
	);
	L.startTradeEventListener('alice');
});
afterEach(() => {
	L.stopTradeEventListener();
	vi.useRealTimers();
});

describe('W-H2: driven by the activity stream, one short read at a time', () => {
	it('starting opens nothing; a ping opens ONE read of that peer, closed at its snapshot', async () => {
		expect(reads).toHaveLength(0);
		ping!({ peer: 'bob', order: MINE, inbound: true });
		expect(openReads().map((r) => r.peer)).toEqual(['bob']);
		lastRead().snapshot([]);
		await settle();
		expect(openReads()).toHaveLength(0);
	});

	it('pings for many peers: never more than one read open', async () => {
		for (const p of ['bob', 'carol', 'dave', 'erin', 'frank', 'gina']) {
			ping!({ peer: p, order: '', inbound: true });
		}
		const order: string[] = [];
		for (let i = 0; i < 6; i++) {
			expect(openReads()).toHaveLength(1);
			order.push(openReads()[0]!.peer);
			openReads()[0]!.snapshot([]);
			await settle();
		}
		expect(order).toEqual(['bob', 'carol', 'dave', 'erin', 'frank', 'gina']);
		expect(openReads()).toHaveLength(0);
	});

	it('several pings for one waiting peer: one read', async () => {
		ping!({ peer: 'bob', order: '', inbound: true });
		ping!({ peer: 'carol', order: '', inbound: true });
		ping!({ peer: 'carol', order: '', inbound: true });
		lastRead().snapshot([]);
		await settle();
		lastRead().snapshot([]);
		await settle();
		expect(reads.map((r) => r.peer)).toEqual(['bob', 'carol']);
	});

	it('our own fast echo is not read; the durable "reconcile" ping (order null) is', () => {
		ping!({ peer: 'bob', order: MINE, inbound: false });
		expect(reads).toHaveLength(0);
		ping!({ peer: 'bob', order: null, inbound: false });
		expect(reads.map((r) => r.peer)).toEqual(['bob']);
	});

	it('nothing for ourselves or a malformed name', () => {
		ping!({ peer: 'alice', order: '', inbound: true });
		ping!({ peer: 'Not_An_Account', order: '', inbound: true });
		expect(reads).toHaveLength(0);
	});

	it('a read that fails is tried again after a pause; one that never answers is given up', async () => {
		ping!({ peer: 'bob', order: '', inbound: true });
		lastRead().fail();
		await settle();
		expect(openReads()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(reads).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(openReads().map((r) => r.peer)).toEqual(['bob']);
		// No snapshot ever: closed after the timeout, and retried later.
		await vi.advanceTimersByTimeAsync(L.LISTENER_READ_TIMEOUT_MS);
		expect(openReads()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(reads).toHaveLength(3);
	});

	it('stopping closes the read and forgets the queue', async () => {
		ping!({ peer: 'bob', order: '', inbound: true });
		ping!({ peer: 'carol', order: '', inbound: true });
		L.stopTradeEventListener();
		expect(openReads()).toHaveLength(0);
		expect(ping).toBeNull();
		L.startTradeEventListener('alice');
		ping!({ peer: 'dave', order: '', inbound: true });
		expect(openReads().map((r) => r.peer)).toEqual(['dave']);
	});
});

describe('W-M4: messages are known by their bytes, never by id', () => {
	it('the durable copy of a verified claim leaves it verified; a second fast copy still counts', async () => {
		ts.recordAddressShared({
			orderOwner: 'alice',
			orderPermlink: MINE,
			peer: 'bob',
			method: 'blurt',
			address: 'alice',
			expectedAmount: 5,
			expectedMemo: 'memo12345',
			direction: 'outgoing'
		});
		texts.set('fs', fundsSent(MINE));
		ping!({ peer: 'bob', order: MINE, inbound: true });
		lastRead().snapshot([rec(0, 'fs')]); // the fast copy
		await settle();
		await settle();
		expect(ts.getTradeState('alice', MINE)?.verifyResult).toEqual({ kind: 'verified' });
		expect(toasts).toHaveLength(1);

		// The durable copy of the SAME message, and a NEW message's fast copy.
		texts.set('addr', addressFor(MINE, 'bob'));
		ping!({ peer: 'bob', order: null, inbound: true });
		lastRead().snapshot([rec(0, 'addr'), rec(77, 'fs')]);
		await settle();
		await settle();
		expect(decrypted.filter((c) => c === 'fs')).toHaveLength(1);
		expect(ts.getTradeState('alice', MINE)?.verifyResult).toEqual({ kind: 'verified' });
		expect(decrypted).toContain('addr');
		expect(toasts).toHaveLength(2);
	});

	it('the store keeps a verification when the same claim is recorded again', () => {
		ts.recordAddressShared({
			orderOwner: 'alice',
			orderPermlink: MINE,
			peer: 'bob',
			method: 'blurt',
			address: 'alice',
			direction: 'outgoing'
		});
		const claim = {
			orderOwner: 'alice',
			orderPermlink: MINE,
			peer: 'bob',
			method: 'blurt' as const,
			txid: 'a'.repeat(40),
			direction: 'incoming' as const
		};
		ts.recordFundsSent(claim);
		ts.recordVerification({
			orderOwner: 'alice',
			orderPermlink: MINE,
			verifyResult: { kind: 'mismatch', field: 'memo' } as never,
			counterparty: 'bob',
			amountConfirmed: false
		});
		ts.recordFundsSent(claim);
		expect(ts.getTradeState('alice', MINE)?.verifyResult).toEqual({
			kind: 'mismatch',
			field: 'memo'
		});
		expect(ts.getTradeState('alice', MINE)?.mismatchField).toBe('memo');
		// A DIFFERENT claim is checked afresh.
		ts.recordFundsSent({ ...claim, txid: 'b'.repeat(40) });
		expect(ts.getTradeState('alice', MINE)?.verifyResult).toBe('pending');
	});

	it('the first read of a peer takes what is already durable as history', async () => {
		texts.set('old', fundsSent(MINE));
		ping!({ peer: 'bob', order: null, inbound: true });
		lastRead().snapshot([rec(5, 'old')]);
		await settle();
		expect(decrypted).toEqual([]);
		expect(ts.getTradeState('alice', MINE)).toBeNull();
		// …a durable message that is new on a LATER read is news.
		texts.set('new', addressFor(MINE, 'bob'));
		ping!({ peer: 'bob', order: null, inbound: true });
		lastRead().snapshot([rec(6, 'new'), rec(5, 'old')]);
		await settle();
		await settle();
		expect(decrypted).toEqual(['new']);
		expect(ts.getTradeState('alice', MINE)?.address).toBe('bob');
	});
});

describe('W-H1: only the thread’s own order, and only the sender’s or ours', () => {
	it('a payload naming another order than its thread moves nothing and raises no toast', async () => {
		texts.set('x', fundsSent(MINE));
		ping!({ peer: 'mallory', order: '', inbound: true });
		lastRead().snapshot([rec(0, 'x', null, 'mallory')]); // a direct message
		await settle();
		await settle();
		expect(ts.getTradeState('alice', MINE)).toBeNull();
		expect(toasts).toEqual([]);
	});

	it('the thread’s order, but nobody’s here: nothing', async () => {
		texts.set('x', fundsSent('carol-sells-blurt'));
		ping!({ peer: 'mallory', order: 'carol-sells-blurt', inbound: true });
		lastRead().snapshot([rec(0, 'x', 'carol-sells-blurt', 'mallory')]);
		await settle();
		await settle();
		expect(findOrder).toHaveBeenCalledWith('mallory', 'carol-sells-blurt');
		expect(get(ts.tradeStates).size).toBe(0);
		expect(toasts).toEqual([]);
	});

	it('the owner could not be told: looked at again on the next read', async () => {
		findOrder.mockImplementation(async () => undefined);
		texts.set('x', addressFor(MINE, 'bob'));
		ping!({ peer: 'bob', order: MINE, inbound: true });
		const r = rec(0, 'x');
		lastRead().snapshot([r]);
		await settle();
		await settle();
		expect(ts.getTradeState('alice', MINE)).toBeNull();
		findOrder.mockImplementation(async (account: string) =>
			account === 'alice' ? { permlink: MINE } : null
		);
		ping!({ peer: 'bob', order: MINE, inbound: true });
		lastRead().snapshot([r]);
		await settle();
		await settle();
		expect(ts.getTradeState('alice', MINE)?.address).toBe('bob');
	});

	it('stopped while the owner is looked up: nothing is written after it', async () => {
		let answer: (v: unknown) => void = () => undefined;
		findOrder.mockImplementation(
			() =>
				new Promise((r) => {
					answer = r;
				})
		);
		texts.set('x', addressFor(MINE, 'bob'));
		ping!({ peer: 'bob', order: MINE, inbound: true });
		lastRead().snapshot([rec(0, 'x')]);
		await settle();
		L.stopTradeEventListener();
		answer({ permlink: MINE });
		await settle();
		await settle();
		expect(ts.getTradeState('alice', MINE)).toBeNull();
	});
});

describe('C-L3: the trade is the one on the order’s owner and permlink', () => {
	it('a payload on our order is not merged into, or dropped for, our trade on another owner’s order with the same permlink', async () => {
		// We paid carol for HER order, which has the same permlink as ours.
		ts.recordFundsSent({
			orderOwner: 'carol',
			orderPermlink: MINE,
			peer: 'carol',
			method: 'blurt',
			txid: 'c'.repeat(40),
			direction: 'outgoing'
		});
		texts.set('x', addressFor(MINE, 'bob'));
		ping!({ peer: 'bob', order: MINE, inbound: true });
		lastRead().snapshot([rec(0, 'x')]);
		await settle();
		await settle();
		const all = [...get(ts.tradeStates).values()];
		expect(all).toHaveLength(2);
		expect(all.find((s) => s.peer === 'bob')?.address).toBe('bob');
		expect(all.find((s) => s.engagedPeer === 'carol')?.txid).toBe('c'.repeat(40));
		expect(all.find((s) => s.engagedPeer === 'carol')?.address).toBeUndefined();
		expect(ts.getTradeState('alice', MINE)?.peer).toBe('bob');
		expect(ts.getTradeState('carol', MINE)?.engagedPeer).toBe('carol');
	});
});

describe('C-M2: a v4 message is about the order owner it was sealed with', () => {
	/** bob's v4 record in our thread about MINE, sealed naming `owner`. */
	const v4rec = (ct: string, owner: string) => {
		const r = rec(0, ct);
		return {
			...r,
			header: { ...r.header, v: 4, t: 1_792_000_000, o: owner, sk: 's', rk: ['r'], wk: ['w'] }
		};
	};
	it('sealed about OUR order (as looked up): recorded', async () => {
		texts.set('v4-ours', addressFor(MINE, 'bob'));
		ping!({ peer: 'bob', order: MINE, inbound: true });
		lastRead().snapshot([v4rec('v4-ours', 'alice')]);
		await settle();
		await settle();
		expect(ts.getTradeState('alice', MINE)?.address).toBe('bob');
	});
	it('sealed about bob’s own order by the same permlink: not recorded as ours', async () => {
		texts.set('v4-his', addressFor(MINE, 'bob'));
		ping!({ peer: 'bob', order: MINE, inbound: true });
		lastRead().snapshot([v4rec('v4-his', 'bob')]);
		await settle();
		await settle();
		expect([...get(ts.tradeStates).values()]).toEqual([]);
	});
});
