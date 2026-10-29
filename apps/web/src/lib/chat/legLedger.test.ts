// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

import { setPersonStorageTier } from '$lib/storage/personStorage';
import {
	LEG_LEDGER_KEY,
	_ledgerNow,
	clearLegLedger,
	legPaymentsFor,
	recordLegPayment
} from './legLedger';
import { resetChatOnSignOut } from './signOutReset';

const pay = (n: number, peer = 'bob') => ({
	orderPermlink: 'order-a',
	peer,
	method: 'blurt' as const,
	txid: n.toString(16).padStart(40, '0')
});

afterEach(() => {
	clearLegLedger();
	setPersonStorageTier(null);
	localStorage.clear();
	sessionStorage.clear();
});

describe('payments made from this device', () => {
	it('are kept per order and peer, once each', () => {
		setPersonStorageTier('local');
		recordLegPayment(pay(1));
		recordLegPayment(pay(1));
		recordLegPayment(pay(2, 'carol'));
		expect(legPaymentsFor(_ledgerNow(), 'order-a', 'bob')).toEqual([pay(1)]);
		expect(legPaymentsFor(_ledgerNow(), 'order-b', 'bob')).toEqual([]);
	});
	it('survive a reload of a remembered session', () => {
		setPersonStorageTier('local');
		recordLegPayment(pay(3));
		setPersonStorageTier(null);
		expect(_ledgerNow()).toEqual([]);
		setPersonStorageTier('local');
		expect(_ledgerNow()).toEqual([pay(3)]);
	});
	it('keep the newest 200', () => {
		setPersonStorageTier('local');
		for (let i = 0; i < 205; i++) recordLegPayment(pay(i));
		const kept = JSON.parse(localStorage.getItem(LEG_LEDGER_KEY)!);
		expect(kept).toHaveLength(200);
		expect(kept[0]).toEqual(pay(5));
	});
	it('are forgotten at sign-out, in memory and on disk', () => {
		setPersonStorageTier('local');
		recordLegPayment(pay(4));
		resetChatOnSignOut();
		expect(_ledgerNow()).toEqual([]);
		expect(localStorage.getItem(LEG_LEDGER_KEY)).toBeNull();
	});
});
