import { describe, expect, it } from 'vitest';

import type { OrderRecord } from '@morphit/indexer-client';
import type { TradeState } from '$lib/trades/tradeStatusPure';

import {
	autoCompleteCounterparty,
	mergeNewestPage,
	paidPermlinksOf,
	parseMyOrdersHash
} from './myOrdersActions';

function st(over: Partial<TradeState>): TradeState {
	return {
		orderPermlink: 'ord-1',
		peer: 'bob',
		method: 'BLURT',
		phase: 'paid_verified',
		engagedPeer: 'bob',
		amountConfirmed: true,
		updatedAt: new Date(0),
		...over
	} as TradeState;
}

const live = { status: 'live' } as const;

describe('autoCompleteCounterparty', () => {
	it('completes a live order paid in full by the engaged counterparty, naming them', () => {
		expect(autoCompleteCounterparty(live, st({}))).toBe('bob');
	});
	it('does not complete when the payment was not checked against the asked amount', () => {
		expect(autoCompleteCounterparty(live, st({ amountConfirmed: false }))).toBeNull();
		expect(autoCompleteCounterparty(live, st({ amountConfirmed: undefined }))).toBeNull();
	});
	it('does not complete for a stranger (no engaged peer, or a different one)', () => {
		expect(autoCompleteCounterparty(live, st({ engagedPeer: undefined }))).toBeNull();
		expect(autoCompleteCounterparty(live, st({ peer: 'mallory' }))).toBeNull();
	});
	it('released / completed phases alone never trigger it', () => {
		expect(autoCompleteCounterparty(live, st({ phase: 'released' }))).toBeNull();
		expect(autoCompleteCounterparty(live, st({ phase: 'completed' }))).toBeNull();
	});
	it('mismatch and unverifiable never trigger it', () => {
		expect(autoCompleteCounterparty(live, st({ phase: 'paid_mismatch' }))).toBeNull();
		expect(autoCompleteCounterparty(live, st({ phase: 'paid_unverifiable' }))).toBeNull();
	});
	it('only live orders', () => {
		expect(autoCompleteCounterparty({ status: 'cancelled' }, st({}))).toBeNull();
		expect(autoCompleteCounterparty(live, undefined)).toBeNull();
	});
});

describe('parseMyOrdersHash', () => {
	it('reads every form the app emits', () => {
		expect(parseMyOrdersHash('#order-abc-1')).toEqual({ kind: 'order', permlink: 'abc-1' });
		expect(parseMyOrdersHash('#feedback=abc')).toEqual({ kind: 'feedback', permlink: 'abc' });
		expect(parseMyOrdersHash('#feature=abc')).toEqual({ kind: 'feature', permlink: 'abc' });
		expect(parseMyOrdersHash('#cancel=abc')).toEqual({ kind: 'cancel', permlink: 'abc' });
	});
	it('refuses anything else', () => {
		expect(parseMyOrdersHash('')).toBeNull();
		expect(parseMyOrdersHash('#cancel=')).toBeNull();
		expect(parseMyOrdersHash('#cancel=a"b')).toBeNull();
		expect(parseMyOrdersHash('#delete=abc')).toBeNull();
		expect(parseMyOrdersHash('#%E0%A4%A')).toBeNull();
	});
});

describe('mergeNewestPage (the poll re-reads one page, not all of them)', () => {
	const o = (permlink: string, updated_at: string, status = 'live') =>
		({ permlink, updated_at, status }) as unknown as OrderRecord;
	it('replaces rows from the fresh page and keeps older rows', () => {
		const existing = [o('b', '2026-01-02T00:00:00Z'), o('old', '2025-01-01T00:00:00Z')];
		const page = [o('new', '2026-01-03T00:00:00Z'), o('b', '2026-01-02T00:00:00Z', 'cancelled')];
		const merged = mergeNewestPage(existing, page);
		expect(merged.map((x) => x.permlink)).toEqual(['new', 'b', 'old']);
		expect(merged[1]!.status).toBe('cancelled');
	});
});

describe('paidPermlinksOf (VT1-8: what /my/orders counts as Paid)', () => {
	it('a payment checked against the amount the seller asked for is Paid', () => {
		const paid = paidPermlinksOf(
			new Map([['o-1', st({ phase: 'paid_verified', amountConfirmed: true })]])
		);
		expect(paid.has('o-1')).toBe(true);
	});
	it('a payment received with no amount asked is NOT Paid (Feature/Cancel stay available)', () => {
		const states = new Map([
			['o-1', st({ phase: 'paid_verified', amountConfirmed: false })],
			['o-2', st({ phase: 'paid_verified', amountConfirmed: undefined })]
		]);
		expect([...paidPermlinksOf(states)]).toEqual([]);
	});
	it('released and completed trades are Paid; other phases are not', () => {
		const states = new Map([
			['r', st({ phase: 'released' })],
			['c', st({ phase: 'completed' })],
			['s', st({ phase: 'paid' })],
			['m', st({ phase: 'paid_mismatch' })]
		]);
		expect([...paidPermlinksOf(states)].sort()).toEqual(['c', 'r']);
	});
});
