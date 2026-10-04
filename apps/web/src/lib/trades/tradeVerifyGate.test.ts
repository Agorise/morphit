/**
 * A payment is "verified" only against what the SELLER asked for, from the
 * buyer the seller is actually trading with.
 *
 * Before: the verification used the claimant's own amount (and, for anyone but
 * the engaged buyer, the claimant's own memo) and recorded the result on the
 * order whoever sent it. A stranger who sent 0.001 BLURT and claimed "0.001"
 * turned the seller's order into "paid ✓ verified" — and /my/orders then
 * completed it on chain naming the real buyer. The real buyer could also pay
 * 1 of 500 and claim "1".
 *
 * Real tradeVerify → blurtVerify → tradeStatus; only the chain relay is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
const chainTxs = new Map<string, unknown>();
/** Every transaction id the chain relay was asked about. */
const relayAsked: string[] = [];
vi.mock('$net/chainRelay', () => ({
	ChainRelayError: class extends Error {},
	chainRelay: async (method: string, params: unknown[]) => {
		if (method !== 'get_transaction') return null;
		relayAsked.push(params[0] as string);
		return chainTxs.get(params[0] as string) ?? null;
	}
}));
vi.mock('$lib/balance/bus', () => ({ triggerBalanceRefresh: () => undefined }));

import { get } from 'svelte/store';
import { triggerBlurtVerification } from './tradeVerify';
import {
	recordAddressShared,
	recordFundsSent,
	tradeStates,
	clearAllTradeStates
} from './tradeStatus';

const P = 'order-abcdefghjkmn';
const transfer = (from: string, amount: string, memo: string) => ({
	operations: [['transfer', { from, to: 'sally', amount, memo }]]
});
const settle = () =>
	vi.waitFor(() => expect(get(tradeStates).get(P)?.verifyResult).not.toBe('pending'));

beforeEach(() => {
	clearAllTradeStates();
	chainTxs.clear();
	relayAsked.length = 0;
	// Sally (seller, this browser) shares her BLURT address with Bob, asking 500.
	recordAddressShared({
		orderPermlink: P,
		peer: 'bob',
		method: 'blurt',
		address: 'sally',
		expectedAmount: 500,
		expectedMemo: 'k7m2q9xa',
		direction: 'outgoing'
	});
});

function claim(sender: string, txid: string, amount: string, memo: string) {
	recordFundsSent({
		orderPermlink: P,
		peer: sender,
		method: 'blurt',
		txid,
		claimedMemo: memo,
		amount: Number(amount),
		direction: 'incoming'
	});
	triggerBlurtVerification({
		recipient: 'sally',
		sender,
		amountBlurt: Number(amount),
		echoedMemo: memo,
		orderPermlink: P,
		txid,
		direction: 'incoming'
	} as never);
}

describe('who and how much a verification counts for', () => {
	it("a stranger's tiny transfer with a matching claim does not mark the order paid", async () => {
		chainTxs.set('a'.repeat(40), transfer('mal', '0.001 BLURT', 'zz22zz22'));
		claim('mal', 'a'.repeat(40), '0.001', 'zz22zz22');
		// A verification would be promise-chained only (the relay is faked), so
		// one event-loop turn lets it finish if it ran at all.
		await new Promise((r) => setTimeout(r, 0));
		expect(relayAsked, "the stranger's transfer was looked up").toEqual([]);
		const st = get(tradeStates).get(P)!;
		expect(st.phase).toBe('address_shared');
		expect(st.peer).toBe('bob');
	});

	it('the buyer paying 1 of the 500 asked, claiming "1", is an amount mismatch — not verified', async () => {
		chainTxs.set('b'.repeat(40), transfer('bob', '1.000 BLURT', 'k7m2q9xa'));
		claim('bob', 'b'.repeat(40), '1', 'k7m2q9xa');
		await settle();
		const st = get(tradeStates).get(P)!;
		expect(st.phase).toBe('paid_mismatch');
		expect(st.mismatchField).toBe('amount');
	});

	it('the buyer paying the 500 asked with the right memo is verified, amount confirmed', async () => {
		chainTxs.set('c'.repeat(40), transfer('bob', '500.000 BLURT', 'k7m2q9xa'));
		claim('bob', 'c'.repeat(40), '500', 'k7m2q9xa');
		await settle();
		const st = get(tradeStates).get(P)! as { phase: string; amountConfirmed?: boolean };
		expect(st.phase).toBe('paid_verified');
		expect(st.amountConfirmed).toBe(true);
	});

	it('a mismatch already recorded (a claim that was not the real payment) is corrected by the real one', async () => {
		chainTxs.set('b'.repeat(40), transfer('bob', '1.000 BLURT', 'k7m2q9xa'));
		claim('bob', 'b'.repeat(40), '500', 'k7m2q9xa');
		await settle();
		expect(get(tradeStates).get(P)!.phase).toBe('paid_mismatch');
		chainTxs.set('d'.repeat(40), transfer('bob', '500.000 BLURT', 'k7m2q9xa'));
		claim('bob', 'd'.repeat(40), '500', 'k7m2q9xa');
		await vi.waitFor(() => expect(get(tradeStates).get(P)!.phase).toBe('paid_verified'));
		expect((get(tradeStates).get(P) as { amountConfirmed?: boolean }).amountConfirmed).toBe(true);
	});
});
