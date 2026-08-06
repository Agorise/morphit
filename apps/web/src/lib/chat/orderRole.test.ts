/**
 * cp474 (t.txt #6) — the chat's crypto money-flow buttons must disappear once
 * the order is finished.
 *
 * THE BUG THIS GUARDS AGAINST. Ken, on live morphit.io: a fulfilled BLURT trade
 * where both parties already held a Payment Receipt was STILL showing the "Pay
 * now" / "Share crypto address" row across the bottom of the chatroom. That is
 * not just clutter — it invites a second payment on a closed trade.
 *
 * `chatMoneyFlow` tested `if (!order)` and nothing else, so "no longer live"
 * only held for a chat with no order at all. But the chat resolves its order
 * via `getOrdersByAccount`, which returns the account's orders in ANY state —
 * that's how the RE: line can read "(Cancelled)". A completed order therefore
 * arrived as a perfectly good `{ side }` and lit the row. cp406's comment had
 * claimed these were hidden for a dead order since cp406; the code never did it.
 *
 * The gate is a denylist, deliberately: `status` is OPTIONAL on OrderRecord, so
 * a federated peer on an older indexer omits it, and an `=== 'live'` allowlist
 * would silently strip the buttons from every chat against those instances.
 */

import { describe, expect, it } from 'vitest';
import { chatMoneyFlow, peerCryptoSide } from './orderRole';

describe('peerCryptoSide', () => {
	it("uses the owner's side as-is for the peer's order", () => {
		expect(peerCryptoSide('sell', false)).toBe('sell');
		expect(peerCryptoSide('buy', false)).toBe('buy');
	});

	it('flips the side when the order is mine', () => {
		expect(peerCryptoSide('sell', true)).toBe('buy');
		expect(peerCryptoSide('buy', true)).toBe('sell');
	});
});

describe('chatMoneyFlow', () => {
	it('shows exactly one button for a live order', () => {
		// Peer BUYS ⇒ I send the crypto ⇒ Pay now.
		expect(chatMoneyFlow({ side: 'buy', status: 'live' }, false)).toEqual({
			payNow: true,
			shareAddress: false
		});
		// Peer SELLS ⇒ I receive the crypto ⇒ Share address.
		expect(chatMoneyFlow({ side: 'sell', status: 'live' }, false)).toEqual({
			payNow: false,
			shareAddress: true
		});
	});

	it('shows nothing when there is no order at all', () => {
		// An unsolicited chat opened from a profile's Message button.
		expect(chatMoneyFlow(null, false)).toEqual({ payNow: false, shareAddress: false });
	});

	// ─── cp474 (t.txt #6) ─────────────────────────────────────────
	it('shows nothing for a COMPLETED order — the trade is paid and closed', () => {
		// Ken's exact case: the fulfilled BLURT trade, both parties holding a
		// Payment Receipt, still offering "Pay now".
		expect(chatMoneyFlow({ side: 'buy', status: 'completed' }, false)).toEqual({
			payNow: false,
			shareAddress: false
		});
		expect(chatMoneyFlow({ side: 'sell', status: 'completed' }, false)).toEqual({
			payNow: false,
			shareAddress: false
		});
	});

	it('shows nothing for a CANCELLED or EXPIRED order', () => {
		// Same class, and visible all over Ken's Archived tab, which is full of
		// "(Cancelled)" threads.
		expect(chatMoneyFlow({ side: 'buy', status: 'cancelled' }, false)).toEqual({
			payNow: false,
			shareAddress: false
		});
		expect(chatMoneyFlow({ side: 'sell', status: 'expired' }, false)).toEqual({
			payNow: false,
			shareAddress: false
		});
	});

	it('still shows buttons when status is ABSENT (older federated indexer)', () => {
		// `status` is optional on OrderRecord. An allowlist (`=== 'live'`) would
		// silently strip the money-flow controls from every chat against a peer
		// running an older indexer — a worse bug than the one being fixed.
		expect(chatMoneyFlow({ side: 'buy' }, false)).toEqual({
			payNow: true,
			shareAddress: false
		});
	});

	it('still shows buttons for a status this build does not know', () => {
		// Forward-compat: a newer peer inventing a state we've never heard of must
		// not blank the UI. Only states we positively know are finished hide it.
		expect(chatMoneyFlow({ side: 'sell', status: 'some_future_state' }, false)).toEqual({
			payNow: false,
			shareAddress: true
		});
	});

	it('applies the dead-order gate regardless of whose order it is', () => {
		expect(chatMoneyFlow({ side: 'buy', status: 'completed' }, true)).toEqual({
			payNow: false,
			shareAddress: false
		});
	});
});
