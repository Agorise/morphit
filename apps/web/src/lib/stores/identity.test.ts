// @vitest-environment jsdom
/**
 * Cross-tab unlock state propagation tests (§F.17).
 *
 * In the browser the identity store registers handleStorageEvent as its
 * `storage` listener, mirroring envelope changes made by other tabs. These
 * tests hand it synthetic StorageEvents and assert the resulting identity
 * store state. (The reload stash is covered by identity.reloadStash.test.ts.)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

import {
	identity,
	bootFromPairedSession,
	broadcastSignOut,
	handleSessionHandoffMessage,
	handleStorageEvent,
	pairedReadOnly,
	reset
} from './identity';
import { KEYSTORE_ENVELOPE_STORAGE_KEY } from '$crypto/persistentKeystore';
import { type PairedSession, clearPairedSession, readPairedSession } from '$crypto/pairedSession';
import { ensureSodium } from '$crypto/sodium';

/** Structurally valid keystores (their contents are never decrypted here). */
const ENV = {
	v: 1,
	kdf: 'argon2id',
	kdfParams: { opslimit: 2, memlimit: 64 * 1024 * 1024 },
	salt: 'c2FsdA==',
	nonce: 'bm9uY2U=',
	ciphertext: 'Y3Q=',
	createdAt: 1
};
const ENV_NEW_PASSWORD = { ...ENV, salt: 'c2FsdDI=', ciphertext: 'Y3Qy', createdAt: 2 };

/** This tab unlocked, the way a sibling tab's handoff unlocks it. */
function unlock(): void {
	handleSessionHandoffMessage(
		{
			t: 'offer',
			payload: {
				state: 'unlocked',
				envelope: ENV,
				live: {
					createdAt: 1,
					origin: 'posting-only',
					posting: {
						role: 'posting',
						publicKey: new Uint8Array(33).fill(2),
						privateKey: new Uint8Array(32).fill(7)
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

/** What another tab's write to localStorage delivers here. Production
 *  registers handleStorageEvent as the `storage` listener (browser only);
 *  the test calls it with the same event. */
function storageEventFromAnotherTab(opts: {
	key: string | null;
	newValue: string | null;
	oldValue?: string | null;
}): void {
	handleStorageEvent(
		new StorageEvent('storage', {
			key: opts.key,
			newValue: opts.newValue,
			oldValue: opts.oldValue ?? null,
			storageArea: window.localStorage
		})
	);
}

describe('§F.17 — cross-tab unlock state propagation', () => {
	// reset() wipes live key bytes with libsodium.
	beforeAll(async () => {
		await ensureSodium();
	});
	beforeEach(() => {
		reset();
	});
	afterEach(() => {
		reset();
	});

	it('envelope deletion in another tab (its sign-out) → this tab locks', () => {
		unlock();
		storageEventFromAnotherTab({
			key: KEYSTORE_ENVELOPE_STORAGE_KEY,
			newValue: null,
			oldValue: JSON.stringify(ENV)
		});
		expect(get(identity).state).toBe('locked');
	});

	it('envelope value change in another tab (its password change) → swaps envelope, keeps live keys', () => {
		unlock();
		const before = get(identity);
		if (before.state !== 'unlocked') throw new Error('precondition');
		storageEventFromAnotherTab({
			key: KEYSTORE_ENVELOPE_STORAGE_KEY,
			newValue: JSON.stringify(ENV_NEW_PASSWORD),
			oldValue: JSON.stringify(ENV)
		});
		const after = get(identity);
		if (after.state !== 'unlocked') throw new Error('post');
		expect(after.live).toBe(before.live);
		expect(after.envelope).toEqual(ENV_NEW_PASSWORD);
	});

	it('corrupted JSON in a storage event → ignored, state unchanged', () => {
		unlock();
		storageEventFromAnotherTab({
			key: KEYSTORE_ENVELOPE_STORAGE_KEY,
			newValue: '{this is not valid JSON',
			oldValue: JSON.stringify(ENV)
		});
		const after = get(identity);
		if (after.state !== 'unlocked') throw new Error('post');
		expect(after.envelope).toEqual(ENV);
	});

	it('storage event for an unrelated key → ignored', () => {
		unlock();
		storageEventFromAnotherTab({ key: 'some-other-localstorage-key', newValue: 'whatever' });
		expect(get(identity).state).toBe('unlocked');
	});

	it('storage event when already locked → no-op (no errors)', () => {
		expect(get(identity).state).toBe('locked');
		storageEventFromAnotherTab({
			key: KEYSTORE_ENVELOPE_STORAGE_KEY,
			newValue: null,
			oldValue: 'some-old-value'
		});
		expect(get(identity).state).toBe('locked');
	});
});

/**
 * Cross-tab session-handoff dispatch (BroadcastChannel) +
 * the follow-up sign-out propagation.
 *
 * Unlike the §F.17 block above, these drive the exported message
 * handler directly with synthetic payloads, so they need NO libsodium
 * (the realm conflict that skips §F.17) — a paired-readonly session is
 * a plain validated object, perfect as a stand-in for "any in-memory
 * session this tab holds / a sibling tab cloned over the channel".
 *
 * The gap these guard: the in-memory handoff can clone a session from
 * one tab into another, but the only PRE-cp290 cross-tab sign-out
 * mirror (handleStorageEvent) fires solely on an on-disk envelope
 * change — so an explicit Sign Out of an in-memory-only session (the
 * default, Remember-me unchecked) never reached the siblings. The
 * 'signout' message + broadcastSignOut() close it.
 */
describe('identity — cross-tab session handoff dispatch + sign-out propagation', () => {
	const PAIRED: PairedSession = {
		v: 1,
		account: 'alice',
		chatPubkey: 'STM5jZtLoV8YbxCxr4imnbWn61zMB24wwonpnVhfXRmv7j6fk3HVH',
		pairingId: 'pid-test-12345678',
		pairedAt: Math.floor(Date.now() / 1000)
	};

	async function flushMicrotasks(): Promise<void> {
		// reset() clears disk via dynamic imports (race-against-teardown).
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
	}

	beforeEach(() => {
		reset();
		clearPairedSession();
	});
	afterEach(() => {
		reset();
		clearPairedSession();
	});

	it("'signout' from a sibling tab wipes our in-memory session to locked", () => {
		bootFromPairedSession(PAIRED);
		expect(get(identity).state).toBe('paired-readonly');

		const posted: unknown[] = [];
		handleSessionHandoffMessage({ t: 'signout' }, (m) => posted.push(m));

		// THE FIX: the sibling's explicit sign-out revoked our session.
		expect(get(identity).state).toBe('locked');
		// signout handling never replies on the channel.
		expect(posted).toEqual([]);
	});

	it("'request' while holding a session replies with an offer carrying our state", () => {
		bootFromPairedSession(PAIRED);

		const posted: Array<{ t: string; payload?: { state?: string } }> = [];
		handleSessionHandoffMessage({ t: 'request' }, (m) => posted.push(m));

		expect(posted.length).toBe(1);
		const offer = posted[0];
		if (!offer) throw new Error('expected exactly one offer reply');
		expect(offer.t).toBe('offer');
		expect(offer.payload?.state).toBe('paired-readonly');
	});

	it("'request' while locked replies with nothing (we have no session to offer)", () => {
		expect(get(identity).state).toBe('locked');

		const posted: unknown[] = [];
		handleSessionHandoffMessage({ t: 'request' }, (m) => posted.push(m));

		expect(posted).toEqual([]);
	});

	it("'offer' adopts an offered session while we are locked", () => {
		expect(get(identity).state).toBe('locked');

		handleSessionHandoffMessage(
			{ t: 'offer', payload: { state: 'paired-readonly', paired: PAIRED } },
			() => {}
		);

		expect(get(identity).state).toBe('paired-readonly');
		expect(get(pairedReadOnly)).toEqual(PAIRED);
	});

	it("'offer' does NOT clobber a session we already hold", () => {
		bootFromPairedSession(PAIRED);
		const other: PairedSession = { ...PAIRED, account: 'bob' };

		handleSessionHandoffMessage(
			{ t: 'offer', payload: { state: 'paired-readonly', paired: other } },
			() => {}
		);

		// Unchanged — adopt fires only from the locked state.
		expect(get(pairedReadOnly)).toEqual(PAIRED);
	});

	it('malformed / unknown messages are ignored and never clobber state', () => {
		bootFromPairedSession(PAIRED);

		const posted: unknown[] = [];
		const post = (m: unknown) => posted.push(m);
		handleSessionHandoffMessage(null, post);
		handleSessionHandoffMessage({}, post);
		handleSessionHandoffMessage({ t: 42 }, post);
		handleSessionHandoffMessage({ t: 'bogus' }, post);

		expect(posted).toEqual([]);
		expect(get(identity).state).toBe('paired-readonly');
	});

	it('broadcastSignOut resets THIS tab (and disk) even when no channel is available', async () => {
		// Under vitest the SvelteKit `browser` flag is false, so
		// getSessionHandoffChannel() returns null — broadcastSignOut must
		// still perform the local sign-out (the post is best-effort; the
		// source-level wiring of the post is covered by the static smoke).
		bootFromPairedSession(PAIRED);
		expect(get(identity).state).toBe('paired-readonly');

		broadcastSignOut();

		expect(get(identity).state).toBe('locked');
		await flushMicrotasks();
		expect(readPairedSession()).toBeNull();
	});
});
