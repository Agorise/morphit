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
	ownPublishedRecord,
	peekPostingKeyPin,
	pendingKeyChange,
	pendingPostingKeyChange,
	pinnedPostingFor,
	recordOwnPublished,
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
		expect(acceptKeyChange('bob', 'chat')).toBe(false);
		expect(pinnedPostingFor('bob')).toEqual([K1]);
		// The user compares the new safety number and accepts it.
		expect(acceptKeyChange('bob', 'posting')).toBe(true);
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
		expect(acceptKeyChange('bob', 'posting')).toBe(true);
		expect(pendingKeyChange('bob')?.pubB64).toBe('NEW');
		expect(acceptKeyChange('bob', 'chat')).toBe(true);
		expect(pendingKeyChange('bob')).toBeNull();
	});

	it('first use that needs consent (their chat key is pinned): held as pending, refused, nothing pinned', async () => {
		const err = await resolvePostingKeyPin('bob', [K1, K2], { needsConsent: true }).catch(
			(e: unknown) => e
		);
		expect((err as PubPinError).code).toBe(PUB_PIN_ERROR.posting_key_changed);
		expect(pinnedPostingFor('bob')).toEqual([]);
		expect(pendingPostingKeyChange('bob')).toEqual([K1, K2]);
		expect(acceptKeyChange('bob', 'posting')).toBe(true);
		// Once pinned, consent is not asked again for the same keys.
		expect(await resolvePostingKeyPin('bob', [K1, K2], { needsConsent: true })).toEqual([K1, K2]);
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

describe('own published record', () => {
	it('kept per account, wiped with the pins', () => {
		expect(ownPublishedRecord('anna')).toBeNull();
		recordOwnPublished('anna', 'PUB');
		expect(ownPublishedRecord('anna')).toBe('PUB');
		expect(ownPublishedRecord('bob')).toBeNull();
		clearAllPins();
		expect(ownPublishedRecord('anna')).toBeNull();
		recordOwnPublished('anna', 'PUB');
		dropReadablePins();
		expect(ownPublishedRecord('anna')).toBeNull();
	});
});

describe('lifecycle', () => {
	it('Sign Out wipes the readable posting pins', async () => {
		await resolvePostingKeyPin('bob', [K1]);
		clearAllPins();
		expect(pinnedPostingFor('bob')).toEqual([]);
	});
});
