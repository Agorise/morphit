/**
 * The local address-reuse history keeps WHICH addresses were shared, as
 * keyed one-way tags — never the address, a date or an order id — and an
 * older build's plaintext record is converted and deleted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ADDRESS_HISTORY_KEY,
	LEGACY_ADDRESS_HISTORY_KEY,
	addressHistoryCount,
	clearAddressHistory,
	hasLegacyAddressHistory,
	migrateLegacyAddressHistory,
	recordAddressShare,
	shareAddress,
	wasSharedBefore
} from './addressHistory';
import { ensureSodium } from '$crypto/sodium';

const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const XMR =
	'44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

let store: Map<string, string>;
beforeEach(() => {
	store = new Map<string, string>();
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

/** Everything in storage, as one string. */
const everything = (): string => [...store.entries()].map(([k, v]) => `${k}=${v}`).join('\n');

describe('what is stored', () => {
	it('no address, date or order id, in any part of storage', async () => {
		await recordAddressShare('BTC', BTC);
		await recordAddressShare('XMR', XMR);
		const all = everything();
		expect(all).not.toBe('');
		for (const fragment of [BTC, XMR, BTC.slice(0, 12), XMR.slice(-12), '2026-', '@alice']) {
			expect(all).not.toContain(fragment);
		}
	});

	it('remembers that an address was shared — and only that one', async () => {
		await recordAddressShare('BTC', BTC);
		expect(await wasSharedBefore('BTC', BTC)).toBe(true);
		expect(await wasSharedBefore('BTC', `${BTC.slice(0, -1)}x`)).toBe(false);
		expect(await wasSharedBefore('LTC', BTC)).toBe(false);
		expect(addressHistoryCount()).toBe(1);
	});

	it('the same address twice is one entry; the cap is 200', async () => {
		await recordAddressShare('BTC', BTC);
		await recordAddressShare('BTC', BTC);
		expect(addressHistoryCount()).toBe(1);
		for (let i = 0; i < 205; i++) await recordAddressShare('BTC', `addr-${i}`);
		expect(addressHistoryCount()).toBe(200);
		expect(await wasSharedBefore('BTC', 'addr-204')).toBe(true);
		expect(await wasSharedBefore('BTC', 'addr-0')).toBe(false);
	});

	it('two installs tag the same address differently (per-install salt)', async () => {
		await recordAddressShare('BTC', BTC);
		const first = JSON.parse(store.get(ADDRESS_HISTORY_KEY)!) as { tags: string[] };
		store.clear();
		await recordAddressShare('BTC', BTC);
		const second = JSON.parse(store.get(ADDRESS_HISTORY_KEY)!) as { tags: string[] };
		expect(second.tags[0]).not.toBe(first.tags[0]);
	});
});

describe("an older build's plaintext history", () => {
	const legacy = JSON.stringify({
		v: 1,
		entries: [
			{ asset: 'BTC', address: BTC, sharedAt: '2026-05-17T20:00:00Z', orderPermlink: '@alice/abc' },
			{ asset: 'XMR', address: XMR, sharedAt: '2026-05-18T20:00:00Z' }
		]
	});

	it('is converted to tags and deleted; reuse is still detected', async () => {
		store.set(LEGACY_ADDRESS_HISTORY_KEY, legacy);
		expect(hasLegacyAddressHistory()).toBe(true);
		await migrateLegacyAddressHistory();
		expect(store.has(LEGACY_ADDRESS_HISTORY_KEY)).toBe(false);
		expect(everything()).not.toContain(BTC);
		expect(everything()).not.toContain('@alice/abc');
		expect(addressHistoryCount()).toBe(2);
		expect(await wasSharedBefore('XMR', XMR)).toBe(true);
	});

	it('a lookup alone converts it', async () => {
		store.set(LEGACY_ADDRESS_HISTORY_KEY, legacy);
		expect(await wasSharedBefore('BTC', BTC)).toBe(true);
		expect(store.has(LEGACY_ADDRESS_HISTORY_KEY)).toBe(false);
	});

	it('an unreadable one is simply deleted', async () => {
		store.set(LEGACY_ADDRESS_HISTORY_KEY, 'not json');
		await migrateLegacyAddressHistory();
		expect(store.has(LEGACY_ADDRESS_HISTORY_KEY)).toBe(false);
		expect(addressHistoryCount()).toBe(0);
	});
});

describe('forgetting', () => {
	it('clears the history and any plaintext leftover', async () => {
		await recordAddressShare('BTC', BTC);
		store.set(LEGACY_ADDRESS_HISTORY_KEY, '{}');
		clearAddressHistory();
		expect(everything()).toBe('');
		expect(await wasSharedBefore('BTC', BTC)).toBe(false);
		expect(() => clearAddressHistory()).not.toThrow();
	});

	it('corrupt stored data reads as an empty history', async () => {
		store.set(ADDRESS_HISTORY_KEY, 'not json');
		expect(addressHistoryCount()).toBe(0);
		expect(await wasSharedBefore('BTC', BTC)).toBe(false);
	});
});

describe('sharing an address', () => {
	it('a share that failed to send is not remembered, so the retry does not warn', async () => {
		// With sodium loaded, recording is microtask-only (no I/O, no timer), so
		// one turn of the event loop below lets any stray write land.
		await ensureSodium();
		await expect(
			shareAddress('BTC', BTC, async () => {
				throw new Error('relay down');
			})
		).rejects.toThrow();
		await new Promise((r) => setTimeout(r, 0));
		expect(await wasSharedBefore('BTC', BTC)).toBe(false);
	});

	it('a share that was sent is remembered', async () => {
		await shareAddress('BTC', BTC, async () => {});
		await vi.waitFor(async () => expect(await wasSharedBefore('BTC', BTC)).toBe(true));
	});
});
