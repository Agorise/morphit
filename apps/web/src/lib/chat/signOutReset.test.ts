// @vitest-environment jsdom
/**
 * Signing out from inside a conversation leaves none of the account's chat
 * state on disk: a view that is still mounted (and marks the conversation read
 * as it unmounts) must not write the signed-out person's peers back.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { broadcastSignOut, reset } from '$stores/identity';
import { markConversationRead, readState } from './readState';
import { toggleStar } from './chatFolders';
import { ensureSodium } from '$crypto/sodium';
import { setPersonStorageTier } from '$lib/storage/personStorage';
import { getTradeState, recordAddressShared, tradeStates } from '$lib/trades/tradeStatus';
import { verifyBlurtTransfer } from './blurtVerify';
import { chainAckedFor, rememberChainAck } from './chainAckMemory';
import { _ledgerNow, recordLegPayment } from './legLedger';

/** Every transaction the chain relay was asked about. */
const relayAsked = vi.hoisted(() => [] as string[]);
vi.mock('$net/chainRelay', () => ({
	ChainRelayError: class extends Error {},
	chainRelay: async (method: string, params: unknown[]) => {
		relayAsked.push(params[0] as string);
		return method === 'get_transaction'
			? {
					operations: [['transfer', { from: 'bob', to: 'alice', amount: '5.000 BLURT', memo: '' }]]
				}
			: null;
	}
}));

/** Every account-derived chat key still in localStorage, with its value. */
function chatOnDisk(): string {
	let out = '';
	for (let i = 0; i < window.localStorage.length; i++) {
		const k = window.localStorage.key(i)!;
		if (k.startsWith('morphit.chat.')) out += `${k}=${window.localStorage.getItem(k)}\n`;
	}
	return out;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
	await ensureSodium();
});
afterEach(() => {
	reset();
	window.localStorage.clear();
});

describe('sign-out from an open conversation', () => {
	it("a late write from a mounted view carries none of the old account's threads", async () => {
		setPersonStorageTier('local'); // a remembered session
		markConversationRead('alice', 'sell-btc-1');
		toggleStar('carol', '');
		expect(chatOnDisk()).toContain('alice');
		broadcastSignOut();
		// The chat reset is loaded on demand; wait until it has run (bounded).
		await vi
			.waitFor(() => expect(Object.keys(get(readState))).toEqual([]), { timeout: 2_000 })
			.catch(() => undefined);
		// The conversation view unmounts and marks its thread read.
		markConversationRead('bob', '');
		expect(chatOnDisk()).not.toContain('alice');
		expect(chatOnDisk()).not.toContain('carol');
	});

	it('a second later, nothing of the account is left on disk', async () => {
		setPersonStorageTier('local');
		markConversationRead('alice', 'sell-btc-1');
		broadcastSignOut();
		await wait(20);
		markConversationRead('bob', '');
		await wait(1_000);
		expect(chatOnDisk()).toBe('');
	});

	it('the trades and payment checks of the old account are gone too', async () => {
		recordAddressShared({
			orderOwner: 'alice',
			orderPermlink: 'sell-blurt-1',
			peer: 'bob',
			method: 'blurt',
			address: 'alice',
			direction: 'outgoing'
		});
		const check = { recipient: 'alice', sender: 'bob', amountBlurt: 5, memo: '' };
		expect((await verifyBlurtTransfer('a'.repeat(40), check)).kind).toBe('verified');
		relayAsked.length = 0;
		broadcastSignOut();
		await vi.waitFor(() => expect(get(tradeStates).size).toBe(0), { timeout: 2_000 });
		expect(getTradeState('alice', 'sell-blurt-1')).toBeNull();
		// The cached answer is gone: the chain is asked again.
		await verifyBlurtTransfer('a'.repeat(40), check);
		expect(relayAsked).toEqual(['a'.repeat(40)]);
	});

	it('the payments made from this device and the chain read markers sent are gone too (v1.21.17)', async () => {
		setPersonStorageTier('local');
		recordLegPayment({
			orderPermlink: 'sell-blurt-1',
			peer: 'bob',
			method: 'blurt',
			txid: 'b'.repeat(40)
		});
		rememberChainAck('bob', 'sell-blurt-1', 1_000);
		broadcastSignOut();
		await vi.waitFor(() => expect(chainAckedFor('bob', 'sell-blurt-1')).toBeNull(), {
			timeout: 2_000
		});
		expect(_ledgerNow()).toEqual([]);
		expect(chatOnDisk()).not.toContain('leg_ledger');
	});
});
