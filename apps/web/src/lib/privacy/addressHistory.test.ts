import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadAddressHistory,
	recordAddressShare,
	findPriorShare,
	clearAddressHistory,
	type AddressHistoryEntry
} from './addressHistory';

const KEY = 'morphit.address-history.v1';

// Map-backed localStorage stub on globalThis. addressHistory.ts uses the
// bare global `localStorage`, so we provide a minimal Storage shape that
// works regardless of the test environment (node or jsdom).
beforeEach(() => {
	const store = new Map<string, string>();
	(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
		key: (i: number) => [...store.keys()][i] ?? null,
		get length() {
			return store.size;
		}
	} as Storage;
});

const entry = (
	asset: string,
	address: string,
	sharedAt = '2026-05-17T20:00:00Z'
): AddressHistoryEntry => ({ asset, address, sharedAt });

describe('addressHistory', () => {
	it('loads an empty list when nothing is stored', () => {
		expect(loadAddressHistory()).toEqual([]);
	});

	it('records and loads an entry', () => {
		recordAddressShare(entry('BTC', '1A1z'));
		const all = loadAddressHistory();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ asset: 'BTC', address: '1A1z' });
	});

	it('dedupes (asset,address) and keeps the latest timestamp', () => {
		recordAddressShare(entry('BTC', '1A1z', '2026-05-17T20:00:00Z'));
		recordAddressShare(entry('BTC', '1A1z', '2026-05-18T20:00:00Z'));
		const all = loadAddressHistory();
		expect(all).toHaveLength(1);
		expect(all[0]?.sharedAt).toBe('2026-05-18T20:00:00Z');
	});

	it('findPriorShare returns a match or null', () => {
		recordAddressShare(entry('BTC', '1A1z'));
		expect(findPriorShare('BTC', '1A1z')).not.toBeNull();
		expect(findPriorShare('BTC', 'other')).toBeNull();
		expect(findPriorShare('LTC', '1A1z')).toBeNull();
	});

	// The function the Settings → Privacy "Forget address history"
	// control is wired to (cp242).
	it('clearAddressHistory wipes the whole history and is idempotent', () => {
		recordAddressShare(entry('BTC', '1A1z'));
		recordAddressShare(entry('LTC', 'Lxyz'));
		expect(loadAddressHistory()).toHaveLength(2);

		clearAddressHistory();
		expect(loadAddressHistory()).toEqual([]);
		expect(localStorage.getItem(KEY)).toBeNull();

		// Clearing an already-empty history is a no-op, not a throw.
		expect(() => clearAddressHistory()).not.toThrow();
		expect(loadAddressHistory()).toEqual([]);
	});

	it('ignores corrupt or wrong-version stored data (fail-open)', () => {
		localStorage.setItem(KEY, 'not json');
		expect(loadAddressHistory()).toEqual([]);
		localStorage.setItem(KEY, JSON.stringify({ v: 2, entries: [] }));
		expect(loadAddressHistory()).toEqual([]);
	});
});
