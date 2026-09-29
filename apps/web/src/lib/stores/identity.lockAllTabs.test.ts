// @vitest-environment jsdom
/**
 * v1.20.0 review (F-5): an EXPLICIT "Lock session" (avatar menu) must lock
 * every open tab of this site, not just the one it was clicked in. Before,
 * the other tabs stayed unlocked, and because a freshly loaded tab asks its
 * siblings for a session, reloading the locked tab (or opening a new one)
 * got the keys straight back — no password.
 *
 * The idle auto-lock stays per-tab (lockSession) and is not tested here.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	identity,
	handleSessionHandoffMessage,
	lockAllTabs,
	reset,
	restoreSessionFromReloadStash
} from './identity';
import { ensureSodium } from '$crypto/sodium';

const STASH_KEY = 'morphit.session.reload-stash-v1';
const ENVELOPE = {
	v: 1,
	kdf: 'argon2id',
	kdfParams: { opslimit: 64, memlimit: 1 << 30 },
	salt: 'c2FsdA==',
	nonce: 'bm9uY2U=',
	ciphertext: 'Y3Q=',
	createdAt: 1
};

/** Put this "tab" in an unlocked state (via the reload-stash path). */
function unlock(): void {
	Object.defineProperty(navigator, 'serviceWorker', {
		configurable: true,
		value: { controller: {} }
	});
	vi.spyOn(performance, 'getEntriesByType').mockImplementation(((k: string) =>
		k === 'navigation'
			? [{ type: 'reload' }]
			: []) as unknown as typeof performance.getEntriesByType);
	window.localStorage.setItem('morphit.keystore.mode', 'password');
	window.localStorage.setItem('morphit.keystore.envelope', JSON.stringify(ENVELOPE));
	window.sessionStorage.setItem(
		STASH_KEY,
		JSON.stringify({
			at: Date.now(),
			live: {
				createdAt: 1,
				origin: 'posting-only',
				posting: {
					role: 'posting',
					publicKey: { __u8__: btoa('AB') },
					privateKey: { __u8__: btoa('CD') }
				},
				memo: null,
				ownerPublicKey: null,
				activePublicKey: null
			},
			envelope: ENVELOPE
		})
	);
	restoreSessionFromReloadStash();
	expect(get(identity).state).toBe('unlocked');
}

describe('explicit Lock reaches every tab', () => {
	beforeAll(async () => {
		await ensureSodium();
	});
	afterEach(() => {
		reset();
		window.localStorage.clear();
		window.sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it("a sibling tab that receives the Lock locks too (and keeps Remember-me's envelope)", () => {
		unlock();
		handleSessionHandoffMessage({ t: 'lock' }, () => {});
		expect(get(identity).state).toBe('locked');
		expect(window.localStorage.getItem('morphit.keystore.envelope')).not.toBeNull();
	});

	it('after the Lock, no tab has a session left to hand back on reload', () => {
		unlock();
		handleSessionHandoffMessage({ t: 'lock' }, () => {});
		const offers: unknown[] = [];
		handleSessionHandoffMessage({ t: 'request' }, (m) => offers.push(m));
		expect(offers).toEqual([]);
	});

	it('lockAllTabs() locks this tab and broadcasts the Lock to the others', () => {
		unlock();
		const sent: unknown[] = [];
		lockAllTabs((m) => sent.push(m));
		expect(get(identity).state).toBe('locked');
		expect(sent).toEqual([{ t: 'lock' }]);
		expect(window.localStorage.getItem('morphit.keystore.envelope')).not.toBeNull();
	});
});
