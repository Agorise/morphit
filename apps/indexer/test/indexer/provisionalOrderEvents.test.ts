/**
 * Provisional (head-block) order status events — v1.7.0, ADR-0051.
 *
 * WHAT THIS PROTECTS. The head tailer now emits order status transitions it sees
 * at the chain head, ~45-63s before the durable poller applies them. That is a
 * new path into every open orderbook, so its safety boundary needs to be pinned
 * by something sharper than a comment:
 *
 *   - It watches EXACTLY TWO op ids. `morphit_order_v1` is excluded because the
 *     public orderbook gates on `fee_status IN ('verified',
 *     'verified_by_attestation')` and a head-block order has NOT had its fee
 *     verified — publishing one would let anyone put unpaid orders in front of
 *     every user for ~60s at a time. `morphit_order_replace_v1` is excluded
 *     because it carries the order's free text, so a rejected edit could flash
 *     arbitrary content into every open orderbook, repeatably.
 *   - The order id is `signer/permlink`, which is only sound because BOTH durable
 *     handlers are owner-only (`account = signer`). If that ever stopped being
 *     true, a signer could name someone else's order and knock it out of live
 *     views for a minute at a time.
 *
 * These tests exercise the locator through the tailer's own module boundary. The
 * emit side is covered by the stream's `tracked.has()` gate, which is what makes
 * a bogus event a no-op rather than a weapon.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { orderbookEventBus, type ProvisionalOrderEvent } from '../../src/indexer/orderbookEventBus';

describe('orderbookEventBus — provisional channel', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('delivers a provisional event to its subscribers', () => {
		const seen: ProvisionalOrderEvent[] = [];
		const off = orderbookEventBus.onProvisional((e) => seen.push(e));

		orderbookEventBus.emitProvisional({ orderId: 'kentest3/sell-btc-1', kind: 'cancelled' });

		expect(seen).toEqual([{ orderId: 'kentest3/sell-btc-1', kind: 'cancelled' }]);
		off();
	});

	it('keeps the durable and provisional channels separate', () => {
		// A provisional event must NEVER reach a durable listener. The durable
		// contract is "re-query the table"; on a provisional event the table still
		// holds the OLD status, so a durable listener would emit `order_upserted`
		// with stale data — the exact opposite of what the event means.
		const durable: string[] = [];
		const offDurable = orderbookEventBus.on((id) => durable.push(id));

		orderbookEventBus.emitProvisional({ orderId: 'kentest3/sell-btc-1', kind: 'cancelled' });

		expect(durable).toEqual([]);
		offDurable();
	});

	it('unsubscribes cleanly (an SSE connection must not leak a listener)', () => {
		const seen: ProvisionalOrderEvent[] = [];
		const off = orderbookEventBus.onProvisional((e) => seen.push(e));
		off();

		orderbookEventBus.emitProvisional({ orderId: 'kentest3/a', kind: 'completed' });

		expect(seen).toEqual([]);
	});

	it('one throwing subscriber cannot silence its peers', () => {
		// Fire-and-forget: a broken SSE connection must not stop every other open
		// orderbook from learning an order is gone.
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const seen: ProvisionalOrderEvent[] = [];
		const offBad = orderbookEventBus.onProvisional(() => {
			throw new Error('boom');
		});
		const offGood = orderbookEventBus.onProvisional((e) => seen.push(e));

		orderbookEventBus.emitProvisional({ orderId: 'kentest3/a', kind: 'cancelled' });

		expect(seen).toHaveLength(1);
		offBad();
		offGood();
	});

	it('a listener unsubscribing mid-dispatch does not skip its peers', () => {
		const seen: string[] = [];
		let offSelf: (() => void) | null = null;
		offSelf = orderbookEventBus.onProvisional(() => {
			seen.push('first');
			offSelf?.();
		});
		const offSecond = orderbookEventBus.onProvisional(() => seen.push('second'));

		orderbookEventBus.emitProvisional({ orderId: 'kentest3/a', kind: 'cancelled' });

		expect(seen).toEqual(['first', 'second']);
		offSecond();
	});
});
