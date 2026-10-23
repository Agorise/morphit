// @vitest-environment jsdom
/**
 * Posting-key pins (v1.21.13). The posting-key envelope encrypts to, and
 * proves a sender by, the peer's posting keys — the SET of their keys that can
 * sign alone; it gets the same protection as a chat key: the set first seen is
 * pinned, a key added to the account is refused until the user accepts the
 * new safety number, the pins are sealed on Lock and wiped on Sign Out.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	PUB_PIN_ERROR,
	PubPinError,
	acceptKeyChange,
	acceptPostingKeysShown,
	clearAllPins,
	dropReadablePins,
	peekPostingKeyPin,
	pendingKeyChange,
	pendingPostingKeyChange,
	pinnedPostingFor,
	resolvePostingKeyPin,
	setPin
} from './pubPin';

const K1 = 'Aj' + 'A'.repeat(42); // stand-ins: the store keeps base64 strings
const K2 = 'Az' + 'B'.repeat(42);
const K3 = 'Ax' + 'C'.repeat(42);

beforeEach(() => {
	localStorage.clear();
});

describe('resolvePostingKeyPin', () => {
	it('first contact pins the whole set; later the set is used while every key on the account is pinned', async () => {
		expect(pinnedPostingFor('bob')).toEqual([]);
		expect(await resolvePostingKeyPin('bob', [K1, K2])).toEqual([K1, K2]);
		expect(pinnedPostingFor('bob')).toEqual([K1, K2]);
		// Listed in another order: the same keys.
		expect(await resolvePostingKeyPin('bob', [K2, K1])).toEqual([K2, K1]);
		// A key REMOVED from the account narrows the pin (nothing is added).
		expect(await resolvePostingKeyPin('bob', [K2])).toEqual([K2]);
		expect(pinnedPostingFor('bob')).toEqual([K2]);
		// …and the removed key does not come back without the user.
		await expect(resolvePostingKeyPin('bob', [K1, K2])).rejects.toMatchObject({
			code: PUB_PIN_ERROR.posting_key_changed
		});
	});

	it('a key added to the account: refused as a changed key, held as pending, never used silently', async () => {
		await resolvePostingKeyPin('bob', [K1]);
		for (const chain of [[K3], [K1, K3]]) {
			localStorage.removeItem('morphit.chat.posting_pin_pending');
			const err = await resolvePostingKeyPin('bob', chain).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PubPinError);
			expect((err as PubPinError).code).toBe(PUB_PIN_ERROR.posting_key_changed);
			expect(pinnedPostingFor('bob')).toEqual([K1]);
			expect(pendingPostingKeyChange('bob')).toEqual(chain);
		}
		// Asked again: still refused.
		await expect(resolvePostingKeyPin('bob', [K1, K3])).rejects.toBeInstanceOf(PubPinError);
		// Accepting a CHAT key change accepts nothing here (a different kind).
		expect(acceptKeyChange('bob', 'chat', 'NEW')).toBe(false);
		expect(pinnedPostingFor('bob')).toEqual([K1]);
		// The user compares the new safety number and accepts it.
		expect(acceptKeyChange('bob', 'posting', pendingPostingKeyChange('bob')!)).toBe(true);
		expect(pinnedPostingFor('bob')).toEqual([K1, K3]);
		expect(pendingPostingKeyChange('bob')).toBeNull();
		expect(await resolvePostingKeyPin('bob', [K1, K3])).toEqual([K1, K3]);
	});

	it('accepting a posting change never accepts a pending chat-key change', async () => {
		setPin('bob', { blockNum: 1, trxId: 'a'.repeat(40), pubB64: 'OLD' });
		localStorage.setItem(
			'morphit.chat.pub_pin_pending',
			JSON.stringify({ bob: { blockNum: 2, trxId: 'b'.repeat(40), pubB64: 'NEW' } })
		);
		await resolvePostingKeyPin('bob', [K1]);
		await resolvePostingKeyPin('bob', [K2]).catch(() => undefined);
		expect(acceptKeyChange('bob', 'posting', pendingPostingKeyChange('bob')!)).toBe(true);
		expect(pendingKeyChange('bob')?.pubB64).toBe('NEW');
		expect(acceptKeyChange('bob', 'chat', 'NEW')).toBe(true);
		expect(pendingKeyChange('bob')).toBeNull();
	});

	it('first use is trusted whatever chat key of theirs is pinned (v1.21.14: no "consent" hold)', async () => {
		setPin('bob', { blockNum: 5, trxId: 'a'.repeat(40), pubB64: 'CHAT' });
		expect(await resolvePostingKeyPin('bob', [K1, K2])).toEqual([K1, K2]);
		expect(pinnedPostingFor('bob')).toEqual([K1, K2]);
		expect(pendingPostingKeyChange('bob')).toBeNull();
	});

	it('a pending entry the old hold left, with nothing pinned, is dropped at first use (it was never a change)', async () => {
		localStorage.setItem(
			'morphit.chat.posting_pin_pending',
			JSON.stringify({ bob: { blockNum: 0, trxId: '0'.repeat(40), pubB64: K3 } })
		);
		expect(await resolvePostingKeyPin('bob', [K1])).toEqual([K1]);
		expect(pendingPostingKeyChange('bob')).toBeNull();
		// A real change keeps its pending entry.
		await resolvePostingKeyPin('bob', [K2]).catch(() => undefined);
		expect(pendingPostingKeyChange('bob')).toEqual([K2]);
		expect(await resolvePostingKeyPin('bob', [K1])).toEqual([K1]);
		expect(pendingPostingKeyChange('bob')).toEqual([K2]);
	});

	it('no keys, or a name that is not an account: refused', async () => {
		await expect(resolvePostingKeyPin('bob', [])).rejects.toBeInstanceOf(PubPinError);
		await expect(resolvePostingKeyPin('Not An Account', [K1])).rejects.toBeInstanceOf(PubPinError);
	});
});

describe('peekPostingKeyPin (the Verify-peer panel)', () => {
	it('says what the chain set means against the pin, and changes nothing', async () => {
		expect(peekPostingKeyPin('bob', [K1])).toEqual({ kind: 'first_use', keys: [K1] });
		expect(pinnedPostingFor('bob')).toEqual([]);
		await resolvePostingKeyPin('bob', [K1, K2]);
		expect(peekPostingKeyPin('bob', [K2])).toEqual({ kind: 'pinned', keys: [K2] });
		expect(pinnedPostingFor('bob')).toEqual([K1, K2]);
		expect(peekPostingKeyPin('bob', [K1, K3])).toEqual({
			kind: 'changed',
			pinned: [K1, K2],
			chain: [K1, K3]
		});
		expect(pendingPostingKeyChange('bob')).toBeNull();
	});

	it('Accept in the panel pins exactly the keys whose number was shown', async () => {
		await resolvePostingKeyPin('bob', [K1]);
		await resolvePostingKeyPin('bob', [K2]).catch(() => undefined); // pending [K2]
		expect(acceptPostingKeysShown('bob', [K3])).toBe(true);
		expect(pinnedPostingFor('bob')).toEqual([K3]);
		expect(pendingPostingKeyChange('bob')).toBeNull();
		expect(acceptPostingKeysShown('bob', [])).toBe(false);
	});
});

describe('own published record (not written since v1.21.14; one from before)', () => {
	it('is wiped with the pins', () => {
		const OWN = 'morphit.chat.own_published';
		const rec = JSON.stringify({ anna: { blockNum: 0, trxId: '0'.repeat(40), pubB64: 'PUB' } });
		localStorage.setItem(OWN, rec);
		clearAllPins();
		expect(localStorage.getItem(OWN)).toBeNull();
		localStorage.setItem(OWN, rec);
		dropReadablePins();
		expect(localStorage.getItem(OWN)).toBeNull();
	});
});

describe('lifecycle', () => {
	it('Sign Out wipes the readable posting pins', async () => {
		await resolvePostingKeyPin('bob', [K1]);
		clearAllPins();
		expect(pinnedPostingFor('bob')).toEqual([]);
	});
});

// v1.21.14 full chat audit, W-M2: Accept pins exactly what was shown.
describe('acceptKeyChange pins only the key whose number was shown', () => {
	it('a chat key: a different pending key is not pinned', async () => {
		setPin('bob', { blockNum: 1, trxId: 'a'.repeat(40), pubB64: 'OLD' });
		localStorage.setItem(
			'morphit.chat.pub_pin_pending',
			JSON.stringify({ bob: { blockNum: 3, trxId: 'c'.repeat(40), pubB64: 'K2' } })
		);
		expect(acceptKeyChange('bob', 'chat', 'K1')).toBe(false);
		expect(pendingKeyChange('bob')?.pubB64).toBe('K2');
		expect(acceptKeyChange('bob', 'chat', 'K2')).toBe(true);
		expect(pendingKeyChange('bob')).toBeNull();
	});

	it('posting keys: the same set (in any order) or nothing', async () => {
		await resolvePostingKeyPin('bob', [K1]);
		await resolvePostingKeyPin('bob', [K1, K2]).catch(() => undefined);
		expect(acceptKeyChange('bob', 'posting', [K1])).toBe(false);
		expect(acceptKeyChange('bob', 'posting', [K1, K2, K3])).toBe(false);
		expect(acceptKeyChange('bob', 'posting', 'K1')).toBe(false);
		expect(pinnedPostingFor('bob')).toEqual([K1]);
		expect(acceptKeyChange('bob', 'posting', [K2, K1])).toBe(true);
		expect(pinnedPostingFor('bob')).toEqual([K1, K2]);
	});
});
