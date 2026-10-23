/**
 * The trade store is keyed by the order's OWNER and permlink (review C-L3).
 *
 * A permlink is unique per owner only: two accounts can each post an order
 * with the same permlink. Keyed by permlink alone, the trade on one of them
 * (its address, its "funds sent", its verification, the peer it is engaged
 * with) was the trade on the other.
 *
 * The real store, the real chat controller and the real /my/orders rules; the
 * network and the chain are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$lib/chat/streamTicket', () => ({ withStreamTicket: (p: string) => `${p}?ticket=t` }));
vi.mock('$lib/chat/blurtVerify', () => ({
	verifyBlurtTransfer: async () => ({ kind: 'verified' })
}));
vi.mock('$lib/balance/bus', () => ({ triggerBalanceRefresh: () => undefined }));

import { createConversationController, type ChatControllerDeps } from '$lib/chat/chatService';
import { encodeAddressPayload, encodeFundsSentPayload } from '$lib/chat/payload';
import * as ts from '$lib/trades/tradeStatus';
import { autoCompleteCounterparty, paidPermlinksOf } from '$lib/orders/myOrdersActions';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { VerifyResult } from '$lib/chat/blurtVerify';

/** The same permlink, posted by alice and by us. */
const P = 'sell-blurt-1';
const TXID = 'a'.repeat(40);
const ME = 'myacct';

const entries = () => [...get(ts.tradeStates).values()];
const engagedWith = (peer: string) => entries().find((s) => s.engagedPeer === peer);
const verified = { kind: 'verified' } as VerifyResult;

beforeEach(() => {
	vi.useFakeTimers();
	ts.clearAllTradeStates();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('the store keeps one entry per owner and permlink', () => {
	it('our trade on alice’s order and bob’s trade on ours do not share state', () => {
		// We buy on alice's order P: her address, then our payment.
		ts.recordAddressShared({
			orderOwner: 'alice',
			orderPermlink: P,
			peer: 'alice',
			method: 'blurt',
			address: 'alice',
			expectedAmount: 5,
			expectedMemo: 'alicememo',
			direction: 'incoming'
		});
		ts.recordFundsSent({
			orderOwner: 'alice',
			orderPermlink: P,
			peer: 'alice',
			method: 'blurt',
			txid: TXID,
			amount: 5,
			direction: 'outgoing'
		});
		// Bob answers OUR order P: we share our address with him.
		ts.recordAddressShared({
			orderOwner: ME,
			orderPermlink: P,
			peer: 'bob',
			method: 'blurt',
			address: ME,
			expectedAmount: 9,
			expectedMemo: 'mymemo',
			direction: 'outgoing'
		});

		expect(get(ts.tradeStates).size).toBe(2);
		expect(engagedWith('alice')).toMatchObject({
			phase: 'paid',
			address: 'alice',
			expectedMemo: 'alicememo',
			txid: TXID
		});
		expect(engagedWith('bob')).toMatchObject({
			phase: 'address_shared',
			address: ME,
			expectedMemo: 'mymemo'
		});
		expect(engagedWith('bob')?.txid).toBeUndefined();

		expect(ts.getTradeState('alice', P)?.engagedPeer).toBe('alice');
		expect(ts.getTradeState(ME, P)?.engagedPeer).toBe('bob');
		expect(ts.tradeStateWith(get(ts.tradeStates), ME, P, 'bob')?.phase).toBe('address_shared');
		expect(ts.tradeStateWith(get(ts.tradeStates), 'alice', P, 'alice')?.phase).toBe('paid');
		expect(ts.tradeStateWith(get(ts.tradeStates), 'alice', P, 'bob')).toBeNull();
		expect(ts.tradeStateWith(get(ts.tradeStates), null, P, 'bob')).toBeNull();

		// A verification of our payment to alice verifies her order only.
		ts.recordVerification({
			orderOwner: 'alice',
			orderPermlink: P,
			verifyResult: verified,
			counterparty: 'alice',
			amountConfirmed: true
		});
		expect(engagedWith('alice')?.phase).toBe('paid_verified');
		expect(engagedWith('bob')?.phase).toBe('address_shared');

		ts.clearAllTradeStates();
		expect(get(ts.tradeStates).size).toBe(0);
	});

	it('an incoming payload on one owner’s order is not dropped for the peer engaged on the other', () => {
		// Engaged with alice on her order P.
		ts.recordFundsSent({
			orderOwner: 'alice',
			orderPermlink: P,
			peer: 'alice',
			method: 'blurt',
			txid: TXID,
			direction: 'outgoing'
		});
		// Bob pays for OUR order P.
		ts.recordFundsSent({
			orderOwner: ME,
			orderPermlink: P,
			peer: 'bob',
			method: 'btc',
			txid: 'b'.repeat(64),
			direction: 'incoming'
		});
		expect(entries().find((s) => s.peer === 'bob')?.txid).toBe('b'.repeat(64));
		expect(engagedWith('alice')?.txid).toBe(TXID);
		expect(ts.getTradeState(ME, P)?.peer).toBe('bob');
	});
});

describe('/my/orders reads only the trades on our own orders', () => {
	it('our verified payment on alice’s order P neither marks our order P paid nor completes it', () => {
		ts.recordAddressShared({
			orderOwner: 'alice',
			orderPermlink: P,
			peer: 'alice',
			method: 'blurt',
			address: 'alice',
			expectedAmount: 5,
			direction: 'incoming'
		});
		ts.recordFundsSent({
			orderOwner: 'alice',
			orderPermlink: P,
			peer: 'alice',
			method: 'blurt',
			txid: TXID,
			amount: 5,
			direction: 'outgoing'
		});
		ts.recordVerification({
			orderOwner: 'alice',
			orderPermlink: P,
			verifyResult: verified,
			counterparty: 'alice',
			amountConfirmed: true
		});
		const states = get(ts.tradeStates);
		// The page lists our orders.
		expect(paidPermlinksOf(states, ME).has(P)).toBe(false);
		expect(paidPermlinksOf(states, 'alice').has(P)).toBe(true);
		const ours = { status: 'live' as const };
		expect(autoCompleteCounterparty(ours, ts.getTradeState(ME, P) ?? undefined)).toBeNull();
		expect(autoCompleteCounterparty(ours, ts.getTradeState('alice', P) ?? undefined)).toBe('alice');
	});
});

// ─── The chat controller: whose order a thread's payload is about ───

const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
const unb64 = (c: string) =>
	new TextDecoder().decode(Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)));

let seq = 0;
function rec(sender: string, thread: string, text: string): ChatMessageRecord {
	seq++;
	return {
		id: 100 + seq,
		sender,
		recipient: ME,
		ciphertext: b64(text),
		header: {
			v: 2,
			ephemeral_pub: `e${seq}`,
			nonce: `n${seq}`,
			client_tag: `${seq}`.padEnd(32, 'c')
		},
		created_at: '2026-10-21T12:00:00.000Z',
		order_permlink: thread
	} as ChatMessageRecord;
}

const address = (to: string, memo: string) =>
	encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: to,
		amount: '5',
		memo,
		orderPermlink: P
	});
const funds = (txid: string) =>
	encodeFundsSentPayload({
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'btc',
		txid,
		orderPermlink: P
	});

/** A thread with `peer` about order P, which `owner` posted. */
function thread(peer: string, owner: string) {
	let snap: ((items: readonly ChatMessageRecord[]) => void) | null = null;
	const ownerAsked: [string, string][] = [];
	const deps: ChatControllerDeps = {
		me: ME,
		peer,
		orderPermlink: P,
		getLiveIdentity: () => ({}) as never,
		now: () => new Date('2026-10-21T12:00:00Z'),
		visibilityState: () => 'visible',
		onVisibilityChange: () => () => undefined,
		generateClientTag: () => `${peer}`.padEnd(32, '0'),
		fetchHistory: async () => ({ ok: true, items: [], nextCursor: null }),
		broadcast: async () => ({ block_num: null, trx_id: 'x' }),
		fetchPeerChatPub: async () => new Uint8Array(32).fill(7),
		deriveMyChatIdentity: async () => ({
			priv: new Uint8Array(32).fill(9),
			pub: new Uint8Array(32).fill(7)
		}),
		fetchPostingPubs: async () => [new Uint8Array(33).fill(2)],
		encryptPosting: async (t: string) => ({
			ciphertext: b64(t),
			ephemeralPub: 'ZQ==',
			nonce: 'bg=='
		}),
		decrypt: async (env) => ({ text: unb64(env.ciphertext), authenticated: true }),
		pinnedPeerPubs: () => [new Uint8Array(32).fill(7)],
		orderOwnerOf: async (order: string, sender: string) => {
			ownerAsked.push([order, sender]);
			return owner;
		},
		onChange: () => undefined,
		subscribeStream: (h) => {
			snap = h.onSnapshot;
			return () => undefined;
		}
	} as ChatControllerDeps;
	const c = createConversationController(deps);
	c.start();
	return {
		ownerAsked,
		async deliver(items: ChatMessageRecord[]) {
			snap?.(items);
			await vi.advanceTimersByTimeAsync(0);
		},
		async send(text: string) {
			await c.sendMessage(text);
			await vi.advanceTimersByTimeAsync(0);
		},
		destroy: () => c.destroy()
	};
}

describe('the chat controller records a payload under its thread’s order owner', () => {
	it('two threads about the same permlink, different owners: separate trades', async () => {
		const withBob = thread('bob', ME); // bob answers OUR order P
		const withAlice = thread('alice', 'alice'); // we answer alice's order P

		// We share our address with bob: engaged with bob on OUR order.
		await withBob.send(address(ME, 'mymemo'));
		// Alice shares hers on HER order: recorded, not dropped for bob.
		await withAlice.deliver([rec('alice', P, address('alice', 'alicememo'))]);
		// Bob says he paid.
		await withBob.deliver([rec('bob', P, funds('b'.repeat(64)))]);

		expect(get(ts.tradeStates).size).toBe(2);
		expect(entries().find((s) => s.peer === 'alice')).toMatchObject({
			address: 'alice',
			expectedMemo: 'alicememo',
			phase: 'address_shared'
		});
		expect(entries().find((s) => s.peer === 'alice')?.txid).toBeUndefined();
		expect(engagedWith('bob')).toMatchObject({
			address: ME,
			expectedMemo: 'mymemo',
			phase: 'paid',
			txid: 'b'.repeat(64)
		});

		expect(ts.getTradeState('alice', P)?.expectedMemo).toBe('alicememo');
		expect(ts.getTradeState(ME, P)?.txid).toBe('b'.repeat(64));
		// The owner was asked for the thread's order, with the thread's peer.
		expect(withBob.ownerAsked).toContainEqual([P, 'bob']);
		expect(withAlice.ownerAsked).toContainEqual([P, 'alice']);
		withBob.destroy();
		withAlice.destroy();
	});
});
