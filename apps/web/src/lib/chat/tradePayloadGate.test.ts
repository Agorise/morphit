/**
 * v1.21.14 full chat audit, W-H1 — a structured trade payload (an address to
 * pay, a payment claim) moves the trade store only for the order of the thread
 * it arrived in, and only when that order belongs to its sender or to us.
 *
 * Before, the order named INSIDE the message was taken at its word: a proved
 * peer in an unrelated direct message could mark our trade with someone else
 * as paid (hiding Pay now and Share address, offering Leave feedback), or
 * replace the amount and memo that trade asked for — so our own correct
 * payment then checked as a "wrong memo".
 *
 * The real controller, the real trade store and the real payload codec; only
 * the network is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
// Stream tickets need the signed-in session (identity store); not under test here.
vi.mock('$lib/chat/streamTicket', () => ({ withStreamTicket: (p: string) => `${p}?ticket=t` }));
vi.mock('$lib/chat/blurtVerify', () => ({
	verifyBlurtTransfer: async () => ({ kind: 'verified' })
}));
const findOrder = vi.fn();
vi.mock('$lib/indexer/client', async (orig) => ({
	...((await orig()) as object),
	findOrder: (...a: unknown[]) => findOrder(...a)
}));

import {
	createConversationController,
	runtimeDeps,
	type ChatControllerDeps
} from '$lib/chat/chatService';
import { encodeAddressPayload, encodeFundsSentPayload } from '$lib/chat/payload';
import * as ts from '$lib/trades/tradeStatus';
import { recordAddressSharedPure, recordFundsSentPure } from '$lib/trades/tradeStatusPure';
import { orderOwnerOf, __resetOrderParties } from '$lib/trades/orderParties';
import type { ChatMessageRecord } from '@morphit/indexer-client';

const ORDER = 'seller-sells-blurt-x';
const OTHER = 'seller-sells-blurt-y';

const funds = (order: string, txid = 'f'.repeat(40)) =>
	encodeFundsSentPayload({
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'blurt',
		txid,
		amount: '1',
		memo: 'evilmemo1',
		orderPermlink: order
	});
const address = (order: string, to: string, memo: string) =>
	encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: to,
		amount: '1',
		memo,
		orderPermlink: order
	});

let seq = 0;
function rec(sender: string, thread: string | null, text: string): ChatMessageRecord {
	seq++;
	return {
		id: 100 + seq,
		sender,
		recipient: 'victim',
		ciphertext: btoa(`${seq}:${text}`),
		header: { v: 2, ephemeral_pub: `e${seq}`, nonce: `n${seq}`, client_tag: 'b'.repeat(31) + 'c' },
		created_at: '2026-10-21T12:00:00.000Z',
		order_permlink: thread
	} as ChatMessageRecord;
}

function controller(
	peer: string,
	thread: string | null,
	extra: Partial<ChatControllerDeps> = {}
): {
	deliver(items: ChatMessageRecord[]): Promise<void>;
	destroy(): void;
} {
	let snap: ((items: readonly ChatMessageRecord[]) => void) | null = null;
	const deps: ChatControllerDeps = {
		me: 'victim',
		peer,
		orderPermlink: thread,
		getLiveIdentity: () => ({}) as never,
		now: () => new Date('2026-10-21T12:00:00Z'),
		visibilityState: () => 'visible',
		onVisibilityChange: () => () => undefined,
		generateClientTag: () => 'a'.repeat(32),
		fetchHistory: async () => ({ ok: true, items: [], nextCursor: null }),
		broadcast: async () => ({ block_num: null, trx_id: 'x' }),
		fetchPeerChatPub: async () => new Uint8Array(32).fill(7),
		deriveMyChatIdentity: async () => ({ priv: new Uint8Array(32), pub: new Uint8Array(32) }),
		// Every message goes to the peer's posting keys (v1.21.14).
		fetchPostingPubs: async () => [new Uint8Array(33).fill(2)],
		encryptPosting: async () => ({ ciphertext: '', ephemeralPub: '', nonce: '' }),
		// A PROVED sender (v2, opened with the pinned key): the strongest case.
		decrypt: async (env) => ({
			text: atob(env.ciphertext).replace(/^\d+:/, ''),
			authenticated: true
		}),
		pinnedPeerPubs: () => [new Uint8Array(32).fill(7)],
		onChange: () => undefined,
		subscribeStream: (h) => {
			snap = h.onSnapshot;
			return () => undefined;
		},
		...extra
	};
	const c = createConversationController(deps);
	c.start();
	return {
		async deliver(items) {
			snap?.(items);
			await vi.advanceTimersByTimeAsync(0);
		},
		destroy: () => c.destroy()
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	ts.clearAllTradeStates();
	__resetOrderParties();
	findOrder.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('W-H1: a payload moves only the order of its own thread', () => {
	it('a payment claim in a DIRECT message (no order) cannot mark another order paid', async () => {
		const c = controller('mallory', null);
		await c.deliver([rec('mallory', null, funds(ORDER))]);
		expect(get(ts.tradeStates).size).toBe(0);
		c.destroy();
	});

	it('an address in one order’s thread naming ANOTHER order changes neither', async () => {
		const orderOwnerOf = vi.fn(async () => 'mallory');
		const c = controller('mallory', OTHER, { orderOwnerOf });
		await c.deliver([rec('mallory', OTHER, address(ORDER, 'mallory', 'evilmemo1'))]);
		expect(get(ts.tradeStates).size).toBe(0);
		c.destroy();
	});

	it('the order of the thread, but owned by neither of us: nothing is recorded', async () => {
		const orderOwnerOf = vi.fn(async () => false as const);
		const c = controller('mallory', ORDER, { orderOwnerOf });
		await c.deliver([rec('mallory', ORDER, funds(ORDER))]);
		expect(orderOwnerOf).toHaveBeenCalledWith(ORDER, 'mallory');
		expect(get(ts.tradeStates).size).toBe(0);
		c.destroy();
	});

	it('the order of the thread, owned by the sender or by us: recorded under that owner', async () => {
		const orderOwnerOf = vi.fn(async () => 'seller');
		const c = controller('seller', ORDER, { orderOwnerOf });
		await c.deliver([rec('seller', ORDER, address(ORDER, 'seller', 'realmemo1'))]);
		const st = ts.getTradeState('seller', ORDER);
		expect(st?.peer).toBe('seller');
		expect(st?.expectedMemo).toBe('realmemo1');
		expect(ts.getTradeState('victim', ORDER)).toBeNull();
		c.destroy();
	});

	it('whose order it is could not be told: nothing now, recorded when the message comes again', async () => {
		const answers: (string | null)[] = [null, 'seller'];
		const orderOwnerOf = vi.fn(async () => (answers.length > 0 ? answers.shift()! : 'seller'));
		const c = controller('seller', ORDER, { orderOwnerOf });
		const r = rec('seller', ORDER, address(ORDER, 'seller', 'realmemo1'));
		await c.deliver([r]);
		expect(get(ts.tradeStates).size).toBe(0);
		// The next fallback poll or reconnect snapshot carries it again.
		await c.deliver([r]);
		expect(ts.getTradeState('seller', ORDER)?.address).toBe('seller');
		c.destroy();
	});

	it('a lookup that throws is "could not be told", never "yes"', async () => {
		const orderOwnerOf = vi.fn(async (): Promise<string | false | null> => {
			throw new Error('relay down');
		});
		const c = controller('seller', ORDER, { orderOwnerOf });
		await c.deliver([rec('seller', ORDER, address(ORDER, 'seller', 'realmemo1'))]);
		expect(get(ts.tradeStates).size).toBe(0);
		c.destroy();
	});

	it('a lock while the owner is being looked up: nothing is recorded after it', async () => {
		let answer: (v: string) => void = () => undefined;
		const orderOwnerOf = vi.fn(
			() =>
				new Promise<string>((r) => {
					answer = r;
				})
		);
		const c = controller('seller', ORDER, { orderOwnerOf });
		await c.deliver([rec('seller', ORDER, address(ORDER, 'seller', 'realmemo1'))]);
		expect(orderOwnerOf).toHaveBeenCalled();
		const { clearOwnSentPlaintextCache } = await import('$lib/chat/chatService');
		clearOwnSentPlaintextCache(); // the session locks
		answer('seller');
		await vi.advanceTimersByTimeAsync(0);
		expect(get(ts.tradeStates).size).toBe(0);
		c.destroy();
	});

	it('the runtime asks the indexer who owns the order', () => {
		const deps = runtimeDeps('victim', 'seller', () => null, ORDER);
		expect(typeof deps.orderOwnerOf).toBe('function');
	});
});

describe('W-H1: whose order it is', () => {
	it('the sender’s order, or ours: its owner; anyone else’s: not', async () => {
		findOrder.mockImplementation(async (account: string) =>
			account === 'seller' ? { permlink: ORDER } : null
		);
		expect(await orderOwnerOf(ORDER, 'seller', 'victim', findOrder)).toBe('seller');
		expect(await orderOwnerOf(ORDER, 'mallory', 'victim', findOrder)).toBe(false);
		// Ours: any inquirer answering it is a party.
		expect(await orderOwnerOf(ORDER, 'buyer', 'seller', findOrder)).toBe('seller');
	});

	it('both have an order by that permlink: the sender’s, as the thread list and view take it', async () => {
		findOrder.mockImplementation(async () => ({ permlink: ORDER }));
		expect(await orderOwnerOf(ORDER, 'seller', 'victim', findOrder)).toBe('seller');
	});

	it('the sender’s order could not be told: whose it is cannot either, even if ours', async () => {
		findOrder.mockImplementation(async (account: string) =>
			account === 'victim' ? { permlink: ORDER } : undefined
		);
		expect(await orderOwnerOf(ORDER, 'seller', 'victim', findOrder)).toBeNull();
	});

	it('a read that fails is "unknown", never a guess', async () => {
		findOrder.mockImplementation(async () => undefined);
		expect(await orderOwnerOf(ORDER, 'seller', 'victim', findOrder)).toBeNull();
		findOrder.mockImplementation(async () => {
			throw new Error('tor timeout');
		});
		expect(await orderOwnerOf(ORDER, 'seller', 'victim', findOrder)).toBeNull();
	});

	it('a confirmed owner is remembered: one read per order', async () => {
		findOrder.mockImplementation(async (account: string) =>
			account === 'seller' ? { permlink: ORDER } : null
		);
		await orderOwnerOf(ORDER, 'seller', 'victim', findOrder);
		await orderOwnerOf(ORDER, 'seller', 'victim', findOrder);
		expect(findOrder).toHaveBeenCalledTimes(1);
	});

	it('by default the order is read from this instance’s indexer (findOrder)', async () => {
		findOrder.mockImplementation(async (account: string) =>
			account === 'victim' ? { permlink: ORDER } : null
		);
		expect(await orderOwnerOf(ORDER, 'mallory', 'victim')).toBe('victim');
		expect(findOrder).toHaveBeenCalledWith('victim', ORDER);
	});
});

describe('W-H1: the store keeps one peer’s trade per entry', () => {
	it('a second inquirer’s claim does not inherit — or leave behind — the first one’s state', () => {
		let m: ReadonlyMap<string, ts.TradeState> = new Map();
		// Peer Q shared an address for our order; nobody engaged yet.
		m = recordAddressSharedPure(m, {
			orderOwner: 'victim',
			orderPermlink: ORDER,
			peer: 'q',
			method: 'blurt',
			address: 'q',
			expectedAmount: 500,
			expectedMemo: 'qmemo',
			direction: 'incoming'
		});
		// Peer P claims a payment for it.
		m = recordFundsSentPure(m, {
			orderOwner: 'victim',
			orderPermlink: ORDER,
			peer: 'p',
			method: 'blurt',
			txid: 'a'.repeat(40),
			amount: 1,
			direction: 'incoming'
		});
		expect(ts.tradeStateOf(m, 'victim', ORDER)?.peer).toBe('p');
		expect(ts.tradeStateOf(m, 'victim', ORDER)?.expectedMemo).toBeUndefined();
		expect(ts.tradeStateOf(m, 'victim', ORDER)?.expectedAmount).toBe(1);
		// Q writes again: Q's trade, NOT "paid" because P said so.
		m = recordAddressSharedPure(m, {
			orderOwner: 'victim',
			orderPermlink: ORDER,
			peer: 'q',
			method: 'blurt',
			address: 'q',
			expectedAmount: 500,
			expectedMemo: 'qmemo',
			direction: 'incoming'
		});
		expect(ts.tradeStateOf(m, 'victim', ORDER)?.phase).toBe('address_shared');
		expect(ts.tradeStateOf(m, 'victim', ORDER)?.txid).toBeUndefined();
	});

	it('a thread reads the entry only when it is about that thread’s peer', () => {
		const m = recordFundsSentPure(new Map(), {
			orderOwner: 'victim',
			orderPermlink: ORDER,
			peer: 'p',
			method: 'blurt',
			txid: 'a'.repeat(40),
			direction: 'incoming'
		});
		expect(ts.tradeStateWith(m, 'victim', ORDER, 'p')?.phase).toBe('paid');
		expect(ts.tradeStateWith(m, 'victim', ORDER, 'q')).toBeNull();
		expect(ts.tradeStateWith(m, 'victim', undefined, 'p')).toBeNull();
		// Engaged: the engaged counterparty's thread, whoever wrote last.
		const engaged = recordAddressSharedPure(m, {
			orderOwner: 'victim',
			orderPermlink: ORDER,
			peer: 'p',
			method: 'blurt',
			address: 'me',
			direction: 'outgoing'
		});
		expect(ts.tradeStateWith(engaged, 'victim', ORDER, 'p')).not.toBeNull();
		// Our address shared with a second inquirer too: the entry is still the
		// trade with the ENGAGED one, and only that thread reads it.
		const twice = recordAddressSharedPure(engaged, {
			orderOwner: 'victim',
			orderPermlink: ORDER,
			peer: 'q',
			method: 'blurt',
			address: 'me',
			direction: 'outgoing'
		});
		expect(ts.tradeStateOf(twice, 'victim', ORDER)?.peer).toBe('q');
		expect(ts.tradeStateWith(twice, 'victim', ORDER, 'p')).not.toBeNull();
		expect(ts.tradeStateWith(twice, 'victim', ORDER, 'q')).toBeNull();
	});
});
