import { describe, it, expect } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { encryptFolderState, decryptFolderState } from './folderCrypto';

// A deterministic 32-byte "posting private key" for the tests.
function key(seed: number): Uint8Array {
	const k = new Uint8Array(32);
	for (let i = 0; i < 32; i++) k[i] = (seed + i * 7) & 0xff;
	return k;
}

describe('folderCrypto', () => {
	it('round-trips a folder-state object', async () => {
		const state = { starred: ['carol\u0000order-c'], archived: ['alice\u0000order-a', 'bob\u0000'] };
		const blob = await encryptFolderState(key(1), 'me', state);
		const out = await decryptFolderState(key(1), 'me', blob);
		expect(out).toEqual(state);
	});

	it('produces an opaque base64 blob (no plaintext leakage)', async () => {
		const state = { inbox: ['alice\u0000order-secret'], starred: [] };
		const blob = await encryptFolderState(key(1), 'me', state);
		expect(blob).not.toContain('alice');
		expect(blob).not.toContain('order-secret');
		// base64 ORIGINAL alphabet only.
		expect(/^[A-Za-z0-9+/]+=*$/.test(blob)).toBe(true);
	});

	it('a different posting key cannot decrypt (returns null)', async () => {
		const blob = await encryptFolderState(key(1), 'me', { inbox: ['x\u0000'], starred: [] });
		expect(await decryptFolderState(key(2), 'me', blob)).toBeNull();
	});

	it('a different account cannot decrypt (domain separation → null)', async () => {
		const blob = await encryptFolderState(key(1), 'me', { inbox: ['x\u0000'], starred: [] });
		expect(await decryptFolderState(key(1), 'someone-else', blob)).toBeNull();
	});

	it('a tampered blob returns null (AEAD tag rejects it)', async () => {
		await sodium.ready;
		const blob = await encryptFolderState(key(1), 'me', { inbox: ['x\u0000'], starred: [] });
		const bytes = sodium.from_base64(blob, sodium.base64_variants.ORIGINAL);
		const last = bytes.length - 1;
		bytes[last] = (bytes[last] ?? 0) ^ 0xff; // flip a ciphertext/tag byte
		const tampered = sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
		expect(await decryptFolderState(key(1), 'me', tampered)).toBeNull();
	});

	it('corrupt / non-base64 input returns null (never throws)', async () => {
		expect(await decryptFolderState(key(1), 'me', 'not base64 {{')).toBeNull();
		expect(await decryptFolderState(key(1), 'me', '')).toBeNull();
		expect(await decryptFolderState(key(1), 'me', 'AAAA')).toBeNull();
	});

	it('the same input encrypts differently each time (random nonce)', async () => {
		const state = { inbox: ['a\u0000'], starred: [] };
		const b1 = await encryptFolderState(key(1), 'me', state);
		const b2 = await encryptFolderState(key(1), 'me', state);
		expect(b1).not.toEqual(b2);
		// …but both decrypt to the same thing.
		expect(await decryptFolderState(key(1), 'me', b1)).toEqual(state);
		expect(await decryptFolderState(key(1), 'me', b2)).toEqual(state);
	});

	// ── BACKWARD-COMPAT KAT (known-answer test) ──
	// A ciphertext frozen from the shipping wire format. If ANY change to the
	// key derivation (BLAKE2b tag), the nonce size, the AAD, the cipher, or the
	// base64 variant breaks this decryption, every folder blob already on chain
	// becomes unreadable — so this test MUST keep passing forever. Do NOT
	// regenerate it to "fix" a failure; a failure here means the format changed
	// and existing users' synced folders would break.
	it('decrypts a frozen ciphertext (on-chain backward-compat MUST NOT break)', async () => {
		const KAT_BLOB =
			'iX3xeyvLrHlxg5K1NgF4eL1TWm2oAW6p+gXYwMZkrlsoaIUdelIiPRsP0UTWcdy/HvSKMvOjzCIq9L9vtMJCrvYEe4YTJn8XoyqLoYzM/OcL3GT6ufwyYawE3crbnFqmSXc4iHi5WLhBELzrDkfQGgf+6PS5RCaIOHueF7QtpjjLiH0qtw==';
		const out = await decryptFolderState(key(9), 'katuser', KAT_BLOB);
		expect(out).toEqual({
			starred: ['alice\u0000buying-btc-permlink', 'carol\u0000'],
			archived: ['bob\u0000selling-xmr-permlink']
		});
	});

	// ── PRIVACY (priority #1): nothing sensitive may appear in the on-chain blob ──
	it('leaks no plaintext — no peer names, order permlinks, or folder labels in the blob', async () => {
		const state = {
			starred: ['secretpeer\u0000confidential-order-xyz'],
			archived: ['anotherpeer\u0000private-deal-42']
		};
		const blob = await encryptFolderState(key(3), 'privacyuser', state);
		for (const needle of [
			'secretpeer',
			'confidential-order-xyz',
			'anotherpeer',
			'private-deal-42',
			'starred',
			'archived'
		]) {
			expect(blob.includes(needle)).toBe(false);
		}
		// The account name is only in the (authenticated, non-secret) AAD, which
		// is NOT part of the emitted blob — verify it doesn't appear either.
		expect(blob.includes('privacyuser')).toBe(false);
		// And it must still be a clean base64 payload (nonce ‖ ciphertext).
		expect(/^[A-Za-z0-9+/]+=*$/.test(blob)).toBe(true);
	});
});
