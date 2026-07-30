// @vitest-environment jsdom
/**
 * Tests for the chat read-state tracker (Phase A client-side).
 *
 * Covers: storage roundtrip, unread-predicate logic,
 * MAX_PEERS cap, graceful fallback on corrupt storage,
 * store reactivity, and full-clear semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';

import {
	PEER_WIDE,
	markConversationRead,
	getLastVisited,
	isUnread,
	clearReadState,
	readState,
	mergeRemoteReadState,
	__reloadFromStorage
} from './readState';

const KEY = 'morphit.chat.read_state';

/** cp446 — a read-state key is a DISCUSSION: peer + NUL + (permlink | '' | '*'). */
const tk = (peer: string, order = ''): string => `${peer}\u0000${order}`;

describe('readState', () => {
	beforeEach(() => {
		try {
			localStorage.removeItem(KEY);
		} catch {
			// best-effort
		}
		__reloadFromStorage();
	});
	afterEach(() => {
		try {
			localStorage.removeItem(KEY);
		} catch {
			// best-effort
		}
	});

	it('starts empty', () => {
		expect(get(readState)).toEqual({});
		expect(getLastVisited('alice', '')).toBeNull();
	});

	it('records and retrieves a visit', () => {
		const t = new Date('2026-04-24T12:00:00Z');
		markConversationRead('alice', '', t);
		expect(getLastVisited('alice', '')).toBe('2026-04-24T12:00:00.000Z');
	});

	it('supports multiple peers independently', () => {
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		markConversationRead('bob', '', new Date('2026-04-24T11:00:00Z'));
		expect(getLastVisited('alice', '')).toBe('2026-04-24T10:00:00.000Z');
		expect(getLastVisited('bob', '')).toBe('2026-04-24T11:00:00.000Z');
	});

	it('overwrites a previous visit with a later one', () => {
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		markConversationRead('alice', '', new Date('2026-04-24T15:00:00Z'));
		expect(getLastVisited('alice', '')).toBe('2026-04-24T15:00:00.000Z');
	});

	it('rejects invalid account names silently', () => {
		markConversationRead('TOO-UPPERCASE', '', new Date());
		markConversationRead('a', '', new Date()); // too short
		markConversationRead('with_underscore', '', new Date());
		markConversationRead('', '', new Date());
		expect(get(readState)).toEqual({});
	});

	it('isUnread returns true when never visited', () => {
		expect(isUnread('alice', '', '2026-04-24T12:00:00Z', false)).toBe(true);
	});

	it('isUnread returns true when message is newer than visit', () => {
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		expect(isUnread('alice', '', '2026-04-24T12:00:00Z', false)).toBe(true);
	});

	it('isUnread returns false when visit is newer than message', () => {
		markConversationRead('alice', '', new Date('2026-04-24T15:00:00Z'));
		expect(isUnread('alice', '', '2026-04-24T12:00:00Z', false)).toBe(false);
	});

	it('isUnread returns false for invalid account names', () => {
		expect(isUnread('', '', '2026-04-24T12:00:00Z', false)).toBe(false);
		expect(isUnread('TOO-UPPER', '', '2026-04-24T12:00:00Z', false)).toBe(false);
	});

	it('your own last word is never unread — on ANY device (t.txt #2)', () => {
		// Ken: signed in on a PC and a phone. He sends "badges test" from the PC;
		// his PHONE lights up unread. His own message, nagging him.
		//
		// The phone's read cursor is per-device and stale by definition — it has
		// no idea the PC just sent that. So the ownership check has to win outright
		// rather than being one input to the cursor comparison: a thread whose last
		// word is yours has nothing waiting to be read, no matter which device you
		// pick up or when it last looked.
		//
		// The old doc comment on isUnread had already spotted this and told callers
		// to "pass the last sender and filter" — which no caller could do, because
		// `ConversationSummary` carried no such field. It described the bug for
		// releases instead of fixing it.
		expect(isUnread('alice', '', '2026-04-24T12:00:00Z', true)).toBe(false);
	});

	it('ownership beats the cursor even when never visited', () => {
		// The never-visited branch returns true unconditionally, so it's the one
		// that would leak the bug back if the ownership check were placed after it.
		expect(isUnread('bob', 'order-xmr', '2026-04-24T12:00:00Z', false)).toBe(true);
		expect(isUnread('bob', 'order-xmr', '2026-04-24T12:00:00Z', true)).toBe(false);
	});

	it("the peer's reply after your message is unread again", () => {
		// The other direction: ownership must not sticky-mark a thread read. Once
		// they reply, the last word is theirs and it's unread.
		expect(isUnread('alice', '', '2026-04-24T12:00:00Z', false)).toBe(true);
	});

	it('clearReadState wipes everything', () => {
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		markConversationRead('bob', '', new Date('2026-04-24T11:00:00Z'));
		clearReadState();
		expect(get(readState)).toEqual({});
		expect(getLastVisited('alice', '')).toBeNull();
	});

	it('store is reactive to markConversationRead', () => {
		const observed: Record<string, string>[] = [];
		const unsub = readState.subscribe((s) => observed.push({ ...s }));
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		markConversationRead('bob', '', new Date('2026-04-24T11:00:00Z'));
		unsub();
		// Three states: initial empty, after alice, after bob.
		expect(observed.length).toBe(3);
		expect(observed[0]).toEqual({});
		expect(observed[1]).toEqual({ [tk('alice')]: '2026-04-24T10:00:00.000Z' });
		expect(observed[2]).toEqual({
			[tk('alice')]: '2026-04-24T10:00:00.000Z',
			[tk('bob')]: '2026-04-24T11:00:00.000Z'
		});
	});

	it('persists across reloads from storage', () => {
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		// Simulate a page reload: re-read from storage.
		__reloadFromStorage();
		expect(getLastVisited('alice', '')).toBe('2026-04-24T10:00:00.000Z');
	});

	it('gracefully handles corrupt JSON in storage', () => {
		localStorage.setItem(KEY, '{not valid json');
		__reloadFromStorage();
		expect(get(readState)).toEqual({});
	});

	it('gracefully handles array-shaped JSON (wrong structure)', () => {
		localStorage.setItem(KEY, '["alice", "bob"]');
		__reloadFromStorage();
		expect(get(readState)).toEqual({});
	});

	it('filters out invalid entries mid-load', () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({
				alice: '2026-04-24T10:00:00Z',
				'': 'bad-key',
				bob: 'not-a-date',
				charlie: 42 as unknown as string, // wrong type
				dave: '2026-04-24T12:00:00Z'
			})
		);
		__reloadFromStorage();
		// cp446 — the two well-formed LEGACY keys (bare peer names, written before
		// threading) are migrated to peer-wide acks rather than dropped. Dropping
		// them would light up every existing user's whole inbox as unread on the
		// morning they upgrade.
		expect(get(readState)).toEqual({
			[tk('alice', PEER_WIDE)]: '2026-04-24T10:00:00Z',
			[tk('dave', PEER_WIDE)]: '2026-04-24T12:00:00Z'
		});
	});

	it('a migrated peer-wide ack still marks that peer\u2019s threads read', () => {
		localStorage.setItem(KEY, JSON.stringify({ alice: '2026-04-24T12:00:00Z' }));
		__reloadFromStorage();
		// Every discussion with alice, whatever its order, is read up to that time.
		expect(isUnread('alice', '', '2026-04-24T11:00:00Z', false)).toBe(false);
		expect(isUnread('alice', 'order-xmr', '2026-04-24T11:00:00Z', false)).toBe(false);
		// …and anything newer is still unread.
		expect(isUnread('alice', 'order-xmr', '2026-04-24T13:00:00Z', false)).toBe(true);
	});

	// THE BEHAVIOUR KEN ASKED FOR: reading one thread must not read the others.
	it('reading one thread does not mark another thread with the same peer read', () => {
		markConversationRead('alice', 'order-xmr', new Date('2026-04-24T12:00:00Z'));
		expect(isUnread('alice', 'order-xmr', '2026-04-24T11:00:00Z', false)).toBe(false);
		expect(isUnread('alice', 'order-btc', '2026-04-24T11:00:00Z', false)).toBe(true);
		expect(isUnread('alice', '', '2026-04-24T11:00:00Z', false)).toBe(true);
	});

	it('the order-less thread is a thread of its own', () => {
		markConversationRead('alice', '', new Date('2026-04-24T12:00:00Z'));
		expect(isUnread('alice', '', '2026-04-24T11:00:00Z', false)).toBe(false);
		expect(isUnread('alice', 'order-xmr', '2026-04-24T11:00:00Z', false)).toBe(true);
	});

	it('a client cannot forge a peer-wide ack by naming the sentinel', () => {
		markConversationRead('alice', PEER_WIDE, new Date('2026-04-24T12:00:00Z'));
		expect(get(readState)).toEqual({});
		expect(isUnread('alice', 'order-xmr', '2026-04-24T11:00:00Z', false)).toBe(true);
	});

	it('caps at MAX_PEERS keeping the most-recently-visited', () => {
		// Store 550 peers with monotonically increasing timestamps.
		// After cap, we expect the 500 newest to remain.
		const base = Date.parse('2026-01-01T00:00:00Z');
		for (let i = 0; i < 550; i++) {
			// Use valid account-name pattern: starts with letter,
			// 3-16 chars, [a-z0-9-]. 'peer-000' through 'peer-549'.
			const name = `peer-${String(i).padStart(4, '0')}`;
			markConversationRead(name, '', new Date(base + i * 1000));
		}
		const state = get(readState);
		expect(Object.keys(state).length).toBe(500);
		// peer-0000 through peer-0049 (the oldest 50) should be dropped.
		expect(state[tk('peer-0000')]).toBeUndefined();
		expect(state[tk('peer-0049')]).toBeUndefined();
		// peer-0050 is the oldest remaining.
		expect(state[tk('peer-0050')]).toBeDefined();
		expect(state[tk('peer-0549')]).toBeDefined();
	});
});

describe('mergeRemoteReadState', () => {
	beforeEach(() => {
		try {
			localStorage.removeItem(KEY);
		} catch {
			// best-effort
		}
		__reloadFromStorage();
	});

	it('handles empty remote list', () => {
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		mergeRemoteReadState([]);
		expect(getLastVisited('alice', '')).toBe('2026-04-24T10:00:00.000Z');
	});

	it('adds new peers from remote', () => {
		mergeRemoteReadState([
			{ peer: 'alice', last_read_at: '2026-04-24T10:00:00Z' },
			{ peer: 'bob', last_read_at: '2026-04-24T11:00:00Z' }
		]);
		expect(getLastVisited('alice', '')).toBe('2026-04-24T10:00:00Z');
		expect(getLastVisited('bob', '')).toBe('2026-04-24T11:00:00Z');
	});

	it('advances when remote is newer than local', () => {
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		mergeRemoteReadState([{ peer: 'alice', last_read_at: '2026-04-24T15:00:00Z' }]);
		expect(getLastVisited('alice', '')).toBe('2026-04-24T15:00:00Z');
	});

	it('does NOT regress when remote is older than local', () => {
		markConversationRead('alice', '', new Date('2026-04-24T15:00:00Z'));
		mergeRemoteReadState([{ peer: 'alice', last_read_at: '2026-04-24T10:00:00Z' }]);
		// Local 15:00 wins over remote 10:00.
		expect(getLastVisited('alice', '')).toBe('2026-04-24T15:00:00.000Z');
	});

	it('preserves unrelated local entries', () => {
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		markConversationRead('bob', '', new Date('2026-04-24T11:00:00Z'));
		mergeRemoteReadState([{ peer: 'charlie', last_read_at: '2026-04-24T12:00:00Z' }]);
		expect(getLastVisited('alice', '')).toBe('2026-04-24T10:00:00.000Z');
		expect(getLastVisited('bob', '')).toBe('2026-04-24T11:00:00.000Z');
		expect(getLastVisited('charlie', '')).toBe('2026-04-24T12:00:00Z');
	});

	it('skips invalid peer names silently', () => {
		mergeRemoteReadState([
			{ peer: 'alice', last_read_at: '2026-04-24T10:00:00Z' },
			{ peer: 'TOO-UPPERCASE', last_read_at: '2026-04-24T10:00:00Z' },
			{ peer: '', last_read_at: '2026-04-24T10:00:00Z' }
		]);
		expect(getLastVisited('alice', '')).toBe('2026-04-24T10:00:00Z');
		expect(Object.keys(get(readState)).length).toBe(1);
	});

	it('skips entries with invalid timestamps silently', () => {
		markConversationRead('alice', '', new Date('2026-04-24T10:00:00Z'));
		mergeRemoteReadState([
			{ peer: 'alice', last_read_at: 'not-a-date' },
			{ peer: 'bob', last_read_at: 'also-bad' }
		]);
		// alice untouched; bob not added.
		expect(getLastVisited('alice', '')).toBe('2026-04-24T10:00:00.000Z');
		expect(getLastVisited('bob', '')).toBeNull();
	});

	it('is a no-op when all remote entries are older', () => {
		markConversationRead('alice', '', new Date('2026-04-24T15:00:00Z'));
		markConversationRead('bob', '', new Date('2026-04-24T16:00:00Z'));
		const before = JSON.stringify(get(readState));
		// cp446 — a remote ack names the discussion it acknowledges. These name the
		// same order-less threads the local acks cover, and are older, so nothing
		// moves. (An ack WITHOUT order_permlink is a legacy peer-wide ack: new
		// information, and it would legitimately be stored — see the test below.)
		mergeRemoteReadState([
			{ peer: 'alice', order_permlink: '', last_read_at: '2026-04-24T10:00:00Z' },
			{ peer: 'bob', order_permlink: '', last_read_at: '2026-04-24T11:00:00Z' }
		]);
		const after = JSON.stringify(get(readState));
		expect(after).toBe(before);
	});

	it('a remote ack for one thread leaves the peer\u2019s other threads unread', () => {
		mergeRemoteReadState([
			{ peer: 'alice', order_permlink: 'order-xmr', last_read_at: '2026-04-24T12:00:00Z' }
		]);
		expect(isUnread('alice', 'order-xmr', '2026-04-24T11:00:00Z', false)).toBe(false);
		expect(isUnread('alice', 'order-btc', '2026-04-24T11:00:00Z', false)).toBe(true);
	});

	it('a remote ack from a PRE-cp446 instance is peer-wide, not order-less', () => {
		// The old indexer has no order_permlink column; it sends none. Attributing
		// that to the order-less thread would leave the user's other threads
		// looking unread on this device, which is the exact bug we are fixing.
		mergeRemoteReadState([{ peer: 'alice', last_read_at: '2026-04-24T12:00:00Z' }]);
		expect(isUnread('alice', 'order-xmr', '2026-04-24T11:00:00Z', false)).toBe(false);
		expect(isUnread('alice', '', '2026-04-24T11:00:00Z', false)).toBe(false);
	});
});
