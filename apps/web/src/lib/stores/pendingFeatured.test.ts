import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import {
	pendingFeatured,
	addPendingFeatured,
	mergeablePending,
	pendingFeaturedKey,
	PENDING_TTL_MS,
	type PendingFeaturedSlot
} from './pendingFeatured';
import type { FeaturedSlot, OrderRecord } from '@morphit/indexer-client';

const mkOrder = (account: string, permlink: string): OrderRecord =>
	({
		account,
		permlink,
		side: 'sell',
		asset: 'XMR',
		fiat_currency: 'MXN',
		amount_min: 200,
		amount_max: null,
		price_model: {},
		location_region: null,
		payment_methods: [],
		accepted_assets: null,
		terms: null
	}) as unknown as OrderRecord;

const mkPending = (account: string, permlink: string, addedAt: number): PendingFeaturedSlot => ({
	slot: { order: mkOrder(account, permlink), bid: {} as FeaturedSlot['bid'] },
	addedAt
});

describe('pendingFeatured', () => {
	it('pendingFeaturedKey builds account/permlink', () => {
		expect(pendingFeaturedKey({ account: 'alice', permlink: 'p1' })).toBe('alice/p1');
	});

	it('mergeablePending keeps an unconfirmed, unexpired entry', () => {
		const now = 1_000_000;
		const out = mergeablePending([mkPending('alice', 'p1', now)], new Set(), now + 1000);
		expect(out).toHaveLength(1);
		expect(out[0].order.account).toBe('alice');
	});

	it('mergeablePending drops an entry the indexer has confirmed (no flicker/dup)', () => {
		const now = 1_000_000;
		const out = mergeablePending([mkPending('alice', 'p1', now)], new Set(['alice/p1']), now + 1000);
		expect(out).toHaveLength(0);
	});

	it('mergeablePending drops an expired entry (losing bid fades on its own)', () => {
		const now = 1_000_000;
		const out = mergeablePending([mkPending('alice', 'p1', now)], new Set(), now + PENDING_TTL_MS + 1);
		expect(out).toHaveLength(0);
	});

	it("addPendingFeatured stages the user's order with the paid amount", () => {
		addPendingFeatured(mkOrder('bob', 'add-unique-1'), 42);
		const found = get(pendingFeatured).find(
			(p) => pendingFeaturedKey(p.slot.order) === 'bob/add-unique-1'
		);
		expect(found).toBeDefined();
		expect(found?.slot.bid.blurt_paid).toBe('42');
	});

	it('addPendingFeatured dedupes the same order, keeping the latest', () => {
		addPendingFeatured(mkOrder('carol', 'add-unique-2'), 1);
		addPendingFeatured(mkOrder('carol', 'add-unique-2'), 2);
		const matches = get(pendingFeatured).filter(
			(p) => pendingFeaturedKey(p.slot.order) === 'carol/add-unique-2'
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.slot.bid.blurt_paid).toBe('2');
	});
});
