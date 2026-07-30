/**
 * signOutSweep — what an explicit Sign Out forgets.
 *
 * Ken's evidence (v1.8.11): after signing out of @kentest3 and into @kencode,
 * localStorage still held `morphit.shortBio.kentest3`, `displayName.kentest3`,
 * his chat peers, unsent feedback drafts, and — because it is not
 * account-scoped at all — `morphit.userPreferences.v1`, whose region value
 * carried straight from one account into the other.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sweepAccountStorageOnSignOut, DEVICE_KEYS } from './signOutSweep';

/** Minimal Storage stand-in — jsdom's is fine but this keeps the test honest
 *  about only using the Storage surface the sweep is allowed to touch. */
function makeStorage(seed: Record<string, string> = {}): Storage {
	const map = new Map<string, string>(Object.entries(seed));
	return {
		get length() {
			return map.size;
		},
		key: (i: number) => [...map.keys()][i] ?? null,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear()
	} as Storage;
}

const ACCOUNT_KEYS = {
	'morphit.blurtAccount': 'kentest3',
	'morphit.displayName.kentest3': 'ken doin testing',
	'morphit.displayName.kencode': 'kenCode@Agorise',
	'morphit.shortBio.kentest3': 'Here is my short bio…',
	'morphit.websiteUrl.kencode': 'https://blurt.blog/@kencode/posts',
	'morphit.streamingUrl.kencode': 'https://blurt.media/@agorise',
	'morphit.chatSecurity.mode.kentest3': 'keep',
	'morphit.syndication.firstTradeFired.kentest3': '1',
	'morphit.chat.recent_peers': '["kentest2","surfgrrl"]',
	'morphit.chat.pub_pins': '{"kentest2":{"blockNum":61471533}}',
	'morphit.draft.feedback.order-9pcvngg7segc': '{"subject":"kentest2"}',
	'morphit.userPreferences.v1': '{"fiat":"MXN","region":"Your place or mine, whatever."}',
	// Not user content, but its NAME reads as chat state, so it is swept —
	// see the note on DEVICE_KEYS about tightening rather than loosening.
	'morphit.debug.chat': '1'
};

const DEVICE_SEED = {
	'morphit.locale': 'en',
	'morphit.autoLock.timeoutMinutes': 'never',
	'morphit.rpcEndpoints': '["https://rpc.blurt.blog"]'
};

describe('sweepAccountStorageOnSignOut', () => {
	let store: Storage;
	beforeEach(() => {
		store = makeStorage({ ...ACCOUNT_KEYS, ...DEVICE_SEED });
	});

	it('forgets every account-derived key', () => {
		sweepAccountStorageOnSignOut(store);
		for (const key of Object.keys(ACCOUNT_KEYS)) {
			expect(store.getItem(key), `${key} survived sign-out`).toBeNull();
		}
	});

	it('THE LEAK KEN SAW: userPreferences does not survive into the next account', () => {
		// Not account-scoped, so it is shared outright — his kentest3 region
		// appeared in a fresh kencode session.
		expect(store.getItem('morphit.userPreferences.v1')).not.toBeNull();
		sweepAccountStorageOnSignOut(store);
		expect(store.getItem('morphit.userPreferences.v1')).toBeNull();
	});

	it('keeps device-level preferences, so the next sign-in is not punished', () => {
		sweepAccountStorageOnSignOut(store);
		for (const key of Object.keys(DEVICE_SEED)) {
			expect(store.getItem(key), `${key} should have been kept`).not.toBeNull();
		}
	});

	it('never touches another app on the same origin', () => {
		store.setItem('someOtherApp.token', 'not-ours');
		sweepAccountStorageOnSignOut(store);
		expect(store.getItem('someOtherApp.token')).toBe('not-ours');
	});

	it('fails CLOSED: an unknown new morphit key is forgotten by default', () => {
		// The allow-list direction is the whole point — a block-list would let
		// a newly-added per-account key survive until someone remembered it.
		store.setItem('morphit.somethingAddedNextYear.kentest3', 'secret');
		sweepAccountStorageOnSignOut(store);
		expect(store.getItem('morphit.somethingAddedNextYear.kentest3')).toBeNull();
	});

	it('removes EVERY doomed key, not every other one', () => {
		// Deleting while enumerating shifts indices and silently skips keys —
		// the classic bug in this shape. Assert nothing account-derived is left.
		sweepAccountStorageOnSignOut(store);
		const left: string[] = [];
		for (let i = 0; i < store.length; i++) {
			const k = store.key(i);
			if (k !== null) left.push(k);
		}
		expect(left.sort()).toEqual(Object.keys(DEVICE_SEED).sort());
	});

	it('no device key holds anything about a person', () => {
		// A guard on the list itself: these keys are kept on a SHARED machine
		// after someone signs out, so none may name a user or their content.
		for (const key of DEVICE_KEYS) {
			expect(key).not.toMatch(/name|bio|url|chat|draft|account|profile/i);
		}
	});

	it('is safe when storage throws (private mode / blocked)', () => {
		const hostile = {
			get length(): number {
				throw new Error('denied');
			},
			key: () => null,
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {}
		} as unknown as Storage;
		expect(() => sweepAccountStorageOnSignOut(hostile)).not.toThrow();
	});
});
