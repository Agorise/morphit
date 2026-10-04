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
import { identity, handleSessionHandoffMessage, lockAllTabs, reset } from './identity';
import { ensureSodium } from '$crypto/sodium';

const ENVELOPE = {
	v: 1,
	kdf: 'argon2id',
	kdfParams: { opslimit: 2, memlimit: 64 * 1024 * 1024 },
	salt: 'c2FsdA==',
	nonce: 'bm9uY2U=',
	ciphertext: 'Y3Q=',
	createdAt: 1
};

/** Put this "tab" in an unlocked state with Remember-me on (a sibling tab
 *  hands its session over). */
function unlock(): void {
	window.localStorage.setItem('morphit.keystore.mode', 'password');
	window.localStorage.setItem('morphit.keystore.envelope', JSON.stringify(ENVELOPE));
	handleSessionHandoffMessage(
		{
			t: 'offer',
			payload: {
				state: 'unlocked',
				envelope: ENVELOPE,
				live: {
					createdAt: 1,
					origin: 'posting-only',
					posting: {
						role: 'posting',
						publicKey: new Uint8Array([65, 66]),
						privateKey: new Uint8Array([67, 68])
					},
					memo: null,
					ownerPublicKey: null,
					activePublicKey: null
				}
			}
		},
		() => {}
	);
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
