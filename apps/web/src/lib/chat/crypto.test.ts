/**
 * Tests for the chat crypto primitives.
 *
 * These tests verify the cryptographic properties the ADR-0015
 * design depends on:
 *   - Key derivation is deterministic
 *   - Public key correctly corresponds to the derived private
 *   - Encrypt → decrypt round-trips cleanly
 *   - Every form of tampering is detected
 *   - Wrong recipients / wrong AAD fail cleanly
 *   - No details leak through error messages
 *
 * A failing test in this file is a potential user-data integrity
 * problem. Treat accordingly.
 */

import { describe, it, expect } from 'vitest';

import {
	deriveChatIdentity,
	encryptToRecipient,
	decryptFromSender,
	encodeChatPub,
	decodeChatPub,
	wipeChatIdentity,
	DecryptError
} from './crypto';
import sodium from 'libsodium-wrappers-sumo';

/** Build a fake 32-byte posting priv. Value doesn't matter for
 *  tests — we just need something deterministic. Different per-
 *  test via the seed parameter. */
function fakePostingPriv(seed: number): Uint8Array {
	const buf = new Uint8Array(32);
	for (let i = 0; i < 32; i += 1) buf[i] = (seed + i * 7) & 0xff;
	// Avoid the all-zero case by setting at least one bit.
	buf[0] = (buf[0]! | 1) & 0xff;
	return buf;
}

describe('chat crypto — deriveChatIdentity', () => {
	it('is deterministic: same posting priv + account → same identity', async () => {
		const priv = fakePostingPriv(1);
		const a = await deriveChatIdentity(priv, 'alice');
		const b = await deriveChatIdentity(priv, 'alice');
		expect(a.priv).toEqual(b.priv);
		expect(a.pub).toEqual(b.pub);
	});

	it('produces 32-byte priv and pub halves', async () => {
		const id = await deriveChatIdentity(fakePostingPriv(2), 'alice');
		expect(id.priv.length).toBe(32);
		expect(id.pub.length).toBe(32);
	});

	it('applies X25519 clamping to priv', async () => {
		const id = await deriveChatIdentity(fakePostingPriv(3), 'alice');
		// Low 3 bits of byte 0 must be clear.
		expect(id.priv[0]! & 0b111).toBe(0);
		// High bit of byte 31 must be clear.
		expect(id.priv[31]! & 0b1000_0000).toBe(0);
		// Bit 6 of byte 31 must be set.
		expect(id.priv[31]! & 0b0100_0000).toBe(0b0100_0000);
	});

	it('pub = scalarmult_base(priv) — keypair is consistent', async () => {
		await sodium.ready;
		const id = await deriveChatIdentity(fakePostingPriv(4), 'alice');
		const expectedPub = sodium.crypto_scalarmult_base(id.priv);
		expect(id.pub).toEqual(expectedPub);
	});

	it('different accounts → different identities (same posting priv)', async () => {
		const priv = fakePostingPriv(5);
		const alice = await deriveChatIdentity(priv, 'alice');
		const bob = await deriveChatIdentity(priv, 'bob');
		expect(alice.priv).not.toEqual(bob.priv);
		expect(alice.pub).not.toEqual(bob.pub);
	});

	it('different posting privs → different identities (same account)', async () => {
		const a = await deriveChatIdentity(fakePostingPriv(6), 'alice');
		const b = await deriveChatIdentity(fakePostingPriv(7), 'alice');
		expect(a.priv).not.toEqual(b.priv);
		expect(a.pub).not.toEqual(b.pub);
	});

	it('rejects posting priv of wrong length', async () => {
		await expect(deriveChatIdentity(new Uint8Array(16), 'alice')).rejects.toThrow(/32 bytes/);
	});

	it('rejects empty account name', async () => {
		await expect(deriveChatIdentity(fakePostingPriv(8), '')).rejects.toThrow(/empty/);
	});
});

describe('chat crypto — encrypt/decrypt round-trip', () => {
	it('Alice sends to Bob, Bob decrypts', async () => {
		await deriveChatIdentity(fakePostingPriv(10), 'alice');
		const bob = await deriveChatIdentity(fakePostingPriv(11), 'bob');

		const envelope = await encryptToRecipient('hello bob', bob.pub, 'alice', 'bob');
		const decrypted = await decryptFromSender(envelope, bob, 'alice', 'bob');
		expect(decrypted).toBe('hello bob');
	});

	it('empty plaintext round-trips', async () => {
		await deriveChatIdentity(fakePostingPriv(12), 'alice');
		const bob = await deriveChatIdentity(fakePostingPriv(13), 'bob');
		const envelope = await encryptToRecipient('', bob.pub, 'alice', 'bob');
		const decrypted = await decryptFromSender(envelope, bob, 'alice', 'bob');
		expect(decrypted).toBe('');
	});

	it('unicode plaintext round-trips (emoji, RTL, combining chars)', async () => {
		await deriveChatIdentity(fakePostingPriv(14), 'alice');
		const bob = await deriveChatIdentity(fakePostingPriv(15), 'bob');
		const samples = [
			'👋 hi 🌊',
			'مرحبا بك في Morphit',
			'こんにちは',
			'é́é́é́é́é́', // precomposed + combining
			'a\u200Bb\u200Cc' // zero-width joiners
		];
		for (const s of samples) {
			const env = await encryptToRecipient(s, bob.pub, 'alice', 'bob');
			const out = await decryptFromSender(env, bob, 'alice', 'bob');
			expect(out).toBe(s);
		}
	});

	it('each encrypt produces fresh ephemeralPub and nonce (non-deterministic)', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(16), 'bob');
		const env1 = await encryptToRecipient('same text', bob.pub, 'alice', 'bob');
		const env2 = await encryptToRecipient('same text', bob.pub, 'alice', 'bob');
		expect(env1.ephemeralPub).not.toBe(env2.ephemeralPub);
		expect(env1.nonce).not.toBe(env2.nonce);
		expect(env1.ciphertext).not.toBe(env2.ciphertext);
	});

	it('decrypts long plaintext (stress test: 200 codepoints)', async () => {
		await deriveChatIdentity(fakePostingPriv(17), 'alice');
		const bob = await deriveChatIdentity(fakePostingPriv(18), 'bob');
		const long = 'a'.repeat(200);
		const env = await encryptToRecipient(long, bob.pub, 'alice', 'bob');
		const out = await decryptFromSender(env, bob, 'alice', 'bob');
		expect(out).toBe(long);
	});
});

describe('chat crypto — tamper detection', () => {
	it('rejects flipped bit in ciphertext', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(20), 'bob');
		const env = await encryptToRecipient('secret', bob.pub, 'alice', 'bob');
		// Flip one bit in the ciphertext.
		const bytes = sodium.from_base64(env.ciphertext, sodium.base64_variants.ORIGINAL);
		bytes[0]! ^= 0x01;
		const tampered = {
			...env,
			ciphertext: sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
		};
		await expect(decryptFromSender(tampered, bob, 'alice', 'bob')).rejects.toThrow(DecryptError);
	});

	it('rejects flipped bit in auth tag', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(21), 'bob');
		const env = await encryptToRecipient('secret', bob.pub, 'alice', 'bob');
		const bytes = sodium.from_base64(env.ciphertext, sodium.base64_variants.ORIGINAL);
		// Tag is the last 16 bytes (Poly1305 output).
		bytes[bytes.length - 1]! ^= 0x80;
		const tampered = {
			...env,
			ciphertext: sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
		};
		await expect(decryptFromSender(tampered, bob, 'alice', 'bob')).rejects.toThrow(DecryptError);
	});

	it('rejects flipped bit in nonce', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(22), 'bob');
		const env = await encryptToRecipient('secret', bob.pub, 'alice', 'bob');
		const bytes = sodium.from_base64(env.nonce, sodium.base64_variants.ORIGINAL);
		bytes[5]! ^= 0x10;
		const tampered = {
			...env,
			nonce: sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
		};
		await expect(decryptFromSender(tampered, bob, 'alice', 'bob')).rejects.toThrow(DecryptError);
	});

	it('rejects flipped bit in ephemeralPub', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(23), 'bob');
		const env = await encryptToRecipient('secret', bob.pub, 'alice', 'bob');
		const bytes = sodium.from_base64(env.ephemeralPub, sodium.base64_variants.ORIGINAL);
		bytes[10]! ^= 0x04;
		const tampered = {
			...env,
			ephemeralPub: sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
		};
		await expect(decryptFromSender(tampered, bob, 'alice', 'bob')).rejects.toThrow(DecryptError);
	});

	it('rejects malformed base64 in ciphertext', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(24), 'bob');
		const env = await encryptToRecipient('secret', bob.pub, 'alice', 'bob');
		const tampered = { ...env, ciphertext: 'not valid base64 $$$' };
		await expect(decryptFromSender(tampered, bob, 'alice', 'bob')).rejects.toThrow(DecryptError);
	});

	it('rejects wrong-length ephemeralPub', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(25), 'bob');
		const env = await encryptToRecipient('secret', bob.pub, 'alice', 'bob');
		// Replace with a 16-byte pub (invalid).
		const shortPub = sodium.to_base64(new Uint8Array(16), sodium.base64_variants.ORIGINAL);
		const tampered = { ...env, ephemeralPub: shortPub };
		await expect(decryptFromSender(tampered, bob, 'alice', 'bob')).rejects.toThrow(DecryptError);
	});

	it('rejects wrong-length nonce', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(26), 'bob');
		const env = await encryptToRecipient('secret', bob.pub, 'alice', 'bob');
		const shortNonce = sodium.to_base64(new Uint8Array(8), sodium.base64_variants.ORIGINAL);
		const tampered = { ...env, nonce: shortNonce };
		await expect(decryptFromSender(tampered, bob, 'alice', 'bob')).rejects.toThrow(DecryptError);
	});
});

describe('chat crypto — wrong-key/wrong-AAD rejection', () => {
	it('Bob cannot decrypt a message intended for Carol', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(30), 'bob');
		const carol = await deriveChatIdentity(fakePostingPriv(31), 'carol');
		// Alice encrypts to Carol.
		const env = await encryptToRecipient('for carol only', carol.pub, 'alice', 'carol');
		// Bob intercepts and tries to decrypt with his own key.
		await expect(decryptFromSender(env, bob, 'alice', 'carol')).rejects.toThrow(DecryptError);
	});

	it('rejects decrypt with mismatched senderAccount AAD (relay attack)', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(32), 'bob');
		// Alice encrypts to Bob.
		const env = await encryptToRecipient('from alice', bob.pub, 'alice', 'bob');
		// Attacker relays with senderAccount claimed as "mallory".
		await expect(decryptFromSender(env, bob, 'mallory', 'bob')).rejects.toThrow(DecryptError);
	});

	it('rejects decrypt with mismatched recipientAccount AAD', async () => {
		const bob = await deriveChatIdentity(fakePostingPriv(33), 'bob');
		const env = await encryptToRecipient('to bob', bob.pub, 'alice', 'bob');
		// Relay attacker re-addresses the envelope.
		await expect(decryptFromSender(env, bob, 'alice', 'carol')).rejects.toThrow(DecryptError);
	});
});

describe('chat crypto — public key encoding helpers', () => {
	it('encodeChatPub / decodeChatPub round-trip', () => {
		const id = new Uint8Array(32);
		for (let i = 0; i < 32; i += 1) id[i] = (i * 13) & 0xff;
		const encoded = encodeChatPub(id);
		const decoded = decodeChatPub(encoded);
		expect(decoded).toEqual(id);
	});

	it('encodeChatPub rejects wrong length', () => {
		expect(() => encodeChatPub(new Uint8Array(31))).toThrow(/32 bytes/);
		expect(() => encodeChatPub(new Uint8Array(33))).toThrow(/32 bytes/);
	});

	it('decodeChatPub rejects wrong-length base64', () => {
		const shortEncoded = sodium.to_base64(new Uint8Array(31), sodium.base64_variants.ORIGINAL);
		expect(() => decodeChatPub(shortEncoded)).toThrow(/32/);
	});
});

describe('chat crypto — wipeChatIdentity', () => {
	it('zeros the priv field of the identity', async () => {
		const id = await deriveChatIdentity(fakePostingPriv(40), 'alice');
		const privBefore = new Uint8Array(id.priv);
		expect(privBefore.some((b) => b !== 0)).toBe(true); // had content
		wipeChatIdentity(id);
		// The underlying buffer is now zeroed (memzero is in-place).
		expect(Array.from(id.priv).every((b) => b === 0)).toBe(true);
	});
});
