// @vitest-environment jsdom
/**
 * cp475 (v1.7.0, "fastpostorder" / "fastcancelorder", ADR-0051).
 *
 * THE BUG THIS EXISTS TO KILL. The order detail page retried `8 × 3s ≈ 24s` and
 * then said **"Order not found"**, with a comment claiming 24s was "comfortably
 * longer than Blurt block time + indexer poll lag". It reasoned about POLL lag
 * (~3s) and never accounted for IRREVERSIBILITY (45-63s, ADR-0008). So a user
 * who posted an order and clicked "View my order" was told their order didn't
 * exist — the exact "my money vanished" moment the comment says it prevents,
 * arriving 24 seconds later instead of instantly.
 *
 * Lengthening the retry to 90s would have "fixed" it by making the user watch a
 * spinner for a minute and a half. The browser already KNOWS the order: it just
 * signed and broadcast it. There is nothing to wait for.
 *
 * These tests pin the merge rules, and specifically the three ways this store
 * could lie: showing an order twice, showing one that never confirms forever,
 * and letting a cancel flicker back to live at the handover.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { OrderRecord } from '@morphit/indexer-client';
import {
	pendingOrders,
	addPendingOrder,
	clearPendingOrders,
	mergePendingOrders,
	findOrderWithPending,
	pendingOrderKeys,
	pendingOrderKey,
	PENDING_TTL_MS
} from './pendingOrders';

/** A minimally-shaped OrderRecord. Cast rather than hand-filled: the fields this
 *  store touches are account/permlink/status, and hand-filling all ~28 would
 *  make this fixture a drift liability without testing anything more. */
function mkOrder(account: string, permlink: string, status: OrderRecord['status'] = 'live'): OrderRecord {
	return { account, permlink, status, side: 'sell', asset: 'BTC' } as unknown as OrderRecord;
}

const T0 = 1_700_000_000_000;

describe('pendingOrders', () => {
	beforeEach(() => {
		clearPendingOrders();
	});

	it('pendingOrderKey is account/permlink', () => {
		expect(pendingOrderKey({ account: 'kentest3', permlink: 'sell-btc-1' })).toBe(
			'kentest3/sell-btc-1'
		);
	});

	// ─── fastpostorder ────────────────────────────────────────────
	it('shows an order the indexer has never heard of (THE "Order not found" bug)', () => {
		// Ken posts, then immediately opens the detail page. The indexer knows
		// nothing and will know nothing for ~45-63s.
		addPendingOrder(mkOrder('kentest3', 'sell-btc-1'), T0);

		const found = findOrderWithPending([], get(pendingOrders), 'kentest3', 'sell-btc-1', T0 + 1_000);

		expect(found).not.toBeNull();
		expect(found?.permlink).toBe('sell-btc-1');
	});

	it('never shows the order twice once the indexer catches up', () => {
		// The single most likely way this store betrays the user: the real row
		// lands and now there are two.
		addPendingOrder(mkOrder('kentest3', 'sell-btc-1'), T0);
		const confirmed = [mkOrder('kentest3', 'sell-btc-1')];

		const merged = mergePendingOrders(confirmed, get(pendingOrders), T0 + 60_000);

		expect(merged).toHaveLength(1);
	});

	it('prefers the indexer copy over the staged one at the handover', () => {
		// The indexer's row carries derived fields (fee status, trade counts) the
		// staged copy never had. When both exist the authoritative one must win.
		addPendingOrder(mkOrder('kentest3', 'sell-btc-1', 'live'), T0);
		const confirmed = [mkOrder('kentest3', 'sell-btc-1', 'completed')];

		const merged = mergePendingOrders(confirmed, get(pendingOrders), T0 + 60_000);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.status).toBe('completed');
	});

	it('ages out an order that never confirms, rather than lying forever', () => {
		// A rejected op, or an order that lost a race. It must clear on its own.
		addPendingOrder(mkOrder('kentest3', 'sell-btc-1'), T0);

		const still = mergePendingOrders([], get(pendingOrders), T0 + PENDING_TTL_MS - 1);
		expect(still).toHaveLength(1);

		const gone = mergePendingOrders([], get(pendingOrders), T0 + PENDING_TTL_MS + 1);
		expect(gone).toHaveLength(0);
	});

	it('puts a just-posted order first, where a user looks for it', () => {
		const confirmed = [mkOrder('kentest3', 'old-order')];
		addPendingOrder(mkOrder('kentest3', 'brand-new'), T0);

		const merged = mergePendingOrders(confirmed, get(pendingOrders), T0 + 1_000);

		expect(merged.map((o) => o.permlink)).toEqual(['brand-new', 'old-order']);
	});

	// ─── fastcancelorder lives elsewhere, deliberately ────────────
	it('stages posts only — cancels are recentCancels\' job, not a second answer', async () => {
		// If someone adds a cancel path here, the app gains a SECOND answer to
		// "is this order cancelled?" alongside `recentCancels`, and they drift the
		// first time one gets a fix the other doesn't. recentCancels is also the
		// better home: it persists in sessionStorage, and for a cancel that
		// matters — falling back to the indexer after a reload shows the order as
		// LIVE. For a post the same fallback is harmless. Same lag, opposite
		// safe-failure directions.
		const mod = await import('./pendingOrders');
		expect('addPendingCancel' in mod).toBe(false);
	});

	// ─── badging + hygiene ────────────────────────────────────────
	it('reports which orders are still confirming, so the UI can say so', () => {
		addPendingOrder(mkOrder('kentest3', 'sell-btc-1'), T0);
		const keys = pendingOrderKeys(get(pendingOrders), new Set(), T0 + 1_000);
		expect(keys.has('kentest3/sell-btc-1')).toBe(true);
	});

	it('stops badging once the indexer confirms', () => {
		addPendingOrder(mkOrder('kentest3', 'sell-btc-1'), T0);
		const keys = pendingOrderKeys(get(pendingOrders), new Set(['kentest3/sell-btc-1']), T0 + 1_000);
		expect(keys.size).toBe(0);
	});

	it('clears on sign-out — a session must not inherit another account\'s orders', () => {
		addPendingOrder(mkOrder('kentest3', 'sell-btc-1'), T0);
		expect(get(pendingOrders)).toHaveLength(1);
		clearPendingOrders();
		expect(get(pendingOrders)).toHaveLength(0);
	});

	it('never mutates the confirmed list it was handed', () => {
		// It's the indexer's data. If this store edited or reordered it in place,
		// the change would leak into whatever else holds that array.
		const confirmed = [mkOrder('kentest3', 'old-1'), mkOrder('kentest3', 'old-2')];
		const snapshot = [...confirmed];
		addPendingOrder(mkOrder('kentest3', 'brand-new'), T0);

		const merged = mergePendingOrders(confirmed, get(pendingOrders), T0 + 1_000);

		expect(confirmed).toEqual(snapshot);
		expect(merged).not.toBe(confirmed);
		expect(merged).toHaveLength(3);
	});

	it('passes the indexer\'s records through untouched', () => {
		// The staged copy has no derived fields by design (ADR-0051 keeps money and
		// reputation durable-only). The confirmed rows that DO have them must come
		// out identical, not re-shaped.
		const real = mkOrder('kentest3', 'old-1');
		addPendingOrder(mkOrder('kentest3', 'brand-new'), T0);

		const merged = mergePendingOrders([real], get(pendingOrders), T0 + 1_000);

		expect(merged.find((o) => o.permlink === 'old-1')).toBe(real);
	});
});
