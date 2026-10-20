/**
 * The posting-key envelope (v3, v1.21.13): a message encrypted to the
 * recipient's POSTING keys, which every Blurt account has on chain from the
 * moment it exists — so a message reaches someone who never opened chat and
 * never published a chat key (a buyer's message to a new member failed with
 * "this recipient hasn't opened Morphit chat yet" and was never stored).
 *
 * One content key encrypts the message; it is wrapped for each of the
 * recipient's posting keys that can sign alone (a session holds one of them,
 * the sender cannot know which) and once for the sender's self-copy.
 *
 * Real secp256k1 keys throughout; nothing mocked.
 */
import { describe, expect, it } from 'vitest';
import * as secp from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import {
	DecryptError,
	MAX_RECIPIENT_KEYS,
	NotForThisKeyError,
	decodePostingPubBLT,
	decryptFromSender,
	decryptPostingEnvelope,
	decryptPostingSelfCopy,
	encryptToPostingKey,
	postingPubOf,
	postingReader,
	wipePostingReader,
	type PostingEnvelopeWire
} from './crypto';
import { base58Encode } from '$crypto/base58';
import { formatPublicKeyBLT } from '$crypto/keygen';

const key = () => {
	const priv = secp.utils.randomPrivateKey();
	return { priv, pub: postingPubOf(priv) };
};
/** A 33-byte compressed key whose x has no point on the curve (about half of
 *  all x values do, so search). */
const offCurveKey = (): Uint8Array => {
	for (let n = 3; ; n++) {
		const k = new Uint8Array(33).fill(n);
		k[0] = 2;
		try {
			secp.ProjectivePoint.fromHex(k);
		} catch {
			return k;
		}
	}
};
const alice = key();
const bob = key();
const bob2 = key(); // a second key on bob's account (another app holds it)
const mallory = key();
const R = (k: { priv: Uint8Array }) => postingReader(k.priv);

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const flip = (s: string, i = 0): string => {
	const b = Buffer.from(s, 'base64');
	b[i] = b[i]! ^ 1;
	return b.toString('base64');
};

describe('the posting-key envelope (v3)', () => {
	it('alice → bob: bob opens it with his posting key, and alice is proved by her pinned key', async () => {
		const env = await encryptToPostingKey('hello there', [bob.pub], alice.priv, 'alice', 'bob');
		expect(env.v).toBe(3);
		expect(env.senderKey).toBe(b64(alice.pub));
		expect(env.recipientKeys).toEqual([b64(bob.pub)]);
		expect(env.wraps).toHaveLength(1);
		expect(Buffer.from(env.ephemeralPub, 'base64')).toHaveLength(33);
		const opened = await decryptPostingEnvelope(env, R(bob), 'alice', 'bob', [alice.pub]);
		expect(opened).toEqual({ text: 'hello there', authenticated: true });
	});

	it('an account with several keys: whichever one the session holds opens it, with the same proof', async () => {
		const env = await encryptToPostingKey(
			'to all of bob',
			[bob.pub, bob2.pub],
			alice.priv,
			'alice',
			'bob'
		);
		expect(env.recipientKeys).toEqual([b64(bob.pub), b64(bob2.pub)]);
		for (const k of [bob, bob2]) {
			expect(await decryptPostingEnvelope(env, R(k), 'alice', 'bob', [alice.pub])).toEqual({
				text: 'to all of bob',
				authenticated: true
			});
		}
		// A key of the account that got no wrap: told apart from damage.
		const only1 = await encryptToPostingKey('x', [bob.pub], alice.priv, 'alice', 'bob');
		await expect(decryptPostingEnvelope(only1, R(bob2), 'alice', 'bob')).rejects.toBeInstanceOf(
			NotForThisKeyError
		);
		// At most MAX_RECIPIENT_KEYS wraps, whatever is passed.
		const many = await encryptToPostingKey(
			'x',
			[bob.pub, bob2.pub, key().pub, key().pub, key().pub],
			alice.priv,
			'alice',
			'bob'
		);
		expect(many.recipientKeys).toHaveLength(MAX_RECIPIENT_KEYS);
		expect(many.wraps).toHaveLength(MAX_RECIPIENT_KEYS);
	});

	it('a wrap moved to another key, or the keys reordered, opens nothing', async () => {
		const env = await encryptToPostingKey('x', [bob.pub, bob2.pub], alice.priv, 'alice', 'bob');
		const swapped: PostingEnvelopeWire = { ...env, wraps: [env.wraps[1]!, env.wraps[0]!] };
		await expect(decryptPostingEnvelope(swapped, R(bob), 'alice', 'bob')).rejects.toBeInstanceOf(
			DecryptError
		);
		const reordered: PostingEnvelopeWire = {
			...env,
			recipientKeys: [env.recipientKeys[1]!, env.recipientKeys[0]!]
		};
		await expect(decryptPostingEnvelope(reordered, R(bob), 'alice', 'bob')).rejects.toBeInstanceOf(
			DecryptError
		);
		// Mismatched counts are refused before any crypto.
		await expect(
			decryptPostingEnvelope({ ...env, wraps: [env.wraps[0]!] }, R(bob), 'alice', 'bob')
		).rejects.toBeInstanceOf(DecryptError);
	});

	it('readable but NOT proved when the key it was made with is not among the sender’s pinned keys', async () => {
		const env = await encryptToPostingKey('hi', [bob.pub], alice.priv, 'alice', 'bob');
		expect(await decryptPostingEnvelope(env, R(bob), 'alice', 'bob', [])).toEqual({
			text: 'hi',
			authenticated: false
		});
		expect(
			(await decryptPostingEnvelope(env, R(bob), 'alice', 'bob', [mallory.pub])).authenticated
		).toBe(false);
	});

	it('someone who knows only public keys cannot write a message that passes as alice’s', async () => {
		// Mallory makes one with her own key and claims to be alice: it opens, but
		// it is not proved by alice's key.
		const own = await encryptToPostingKey('send to me', [bob.pub], mallory.priv, 'alice', 'bob');
		expect(
			(await decryptPostingEnvelope(own, R(bob), 'alice', 'bob', [alice.pub])).authenticated
		).toBe(false);
		// And naming alice's key on it instead does not open at all.
		const forged: PostingEnvelopeWire = { ...own, senderKey: b64(alice.pub) };
		await expect(
			decryptPostingEnvelope(forged, R(bob), 'alice', 'bob', [alice.pub])
		).rejects.toBeInstanceOf(DecryptError);
	});

	it('only the recipient opens it: another key, the wrong names, any changed byte — all refused', async () => {
		const env = await encryptToPostingKey('only bob', [bob.pub], alice.priv, 'alice', 'bob');
		for (const bad of [
			() => decryptPostingEnvelope(env, R(mallory), 'alice', 'bob', [alice.pub]),
			() => decryptPostingEnvelope(env, R(bob), 'mallory', 'bob', [alice.pub]),
			() => decryptPostingEnvelope(env, R(bob), 'alice', 'carol', [alice.pub]),
			() =>
				decryptPostingEnvelope(
					{ ...env, ciphertext: flip(env.ciphertext) },
					R(bob),
					'alice',
					'bob'
				),
			() => decryptPostingEnvelope({ ...env, nonce: flip(env.nonce) }, R(bob), 'alice', 'bob'),
			() =>
				decryptPostingEnvelope({ ...env, wraps: [flip(env.wraps[0]!)] }, R(bob), 'alice', 'bob'),
			() =>
				decryptPostingEnvelope(
					{ ...env, ephemeralPub: flip(env.ephemeralPub, 5) },
					R(bob),
					'alice',
					'bob'
				),
			() => decryptPostingEnvelope({ ...env, v: 2 } as never, R(bob), 'alice', 'bob')
		])
			await expect(bad()).rejects.toBeInstanceOf(DecryptError);
		// And the chat-key path never opens a v3 message.
		await expect(
			decryptFromSender(
				env as never,
				{ priv: new Uint8Array(32).fill(1), pub: new Uint8Array(32).fill(2) },
				'alice',
				'bob'
			)
		).rejects.toBeInstanceOf(DecryptError);
	});

	it('alice rereads her own message from its self-copy; bob cannot open the self-copy', async () => {
		const env = await encryptToPostingKey(
			'my words',
			[bob.pub, bob2.pub],
			alice.priv,
			'alice',
			'bob'
		);
		expect(await decryptPostingSelfCopy(env, R(alice), 'alice', 'bob')).toBe('my words');
		for (const k of [bob, bob2]) {
			await expect(decryptPostingSelfCopy(env, R(k), 'alice', 'bob')).rejects.toBeInstanceOf(
				DecryptError
			);
		}
		await expect(
			decryptPostingSelfCopy(
				{ ...env, selfCiphertext: flip(env.selfCiphertext!) },
				R(alice),
				'alice',
				'bob'
			)
		).rejects.toBeInstanceOf(DecryptError);
		// The self-copy is not the message: alice holds no wrap meant for bob.
		await expect(decryptPostingEnvelope(env, R(alice), 'alice', 'bob')).rejects.toBeInstanceOf(
			DecryptError
		);
		// "Destroy" mode: no self-copy at all.
		const none = await encryptToPostingKey('gone', [bob.pub], alice.priv, 'alice', 'bob', false);
		expect(none.selfCiphertext).toBeUndefined();
		await expect(decryptPostingSelfCopy(none, R(alice), 'alice', 'bob')).rejects.toBeInstanceOf(
			DecryptError
		);
	});

	it('a reader reuses its per-sender secret across messages, and a wiped reader opens nothing', async () => {
		const reader = R(bob);
		const a = await encryptToPostingKey('one', [bob.pub], alice.priv, 'alice', 'bob');
		const b = await encryptToPostingKey('two', [bob.pub], alice.priv, 'alice', 'bob');
		expect((await decryptPostingEnvelope(a, reader, 'alice', 'bob')).text).toBe('one');
		expect(reader.dh2.size).toBe(1);
		expect((await decryptPostingEnvelope(b, reader, 'alice', 'bob')).text).toBe('two');
		expect(reader.dh2.size).toBe(1);
		// The cached secret is per sender key: mallory's message gets its own.
		const m = await encryptToPostingKey('three', [bob.pub], mallory.priv, 'mallory', 'bob');
		expect((await decryptPostingEnvelope(m, reader, 'mallory', 'bob')).text).toBe('three');
		expect(reader.dh2.size).toBe(2);
		wipePostingReader(reader);
		expect(reader.dh2.size).toBe(0);
	});

	it('a key that is not on the curve is refused on both sides', async () => {
		const offCurve = offCurveKey();
		expect(() => secp.ProjectivePoint.fromHex(offCurve)).toThrow();
		await expect(encryptToPostingKey('x', [offCurve], alice.priv, 'alice', 'bob')).rejects.toThrow(
			/not a usable secp256k1 key/
		);
		await expect(
			encryptToPostingKey('x', [bob.pub, offCurve], alice.priv, 'alice', 'bob')
		).rejects.toThrow(/not a usable secp256k1 key/);
		await expect(encryptToPostingKey('x', [], alice.priv, 'alice', 'bob')).rejects.toThrow(
			/not a usable secp256k1 key/
		);
		const env = await encryptToPostingKey('x', [bob.pub], alice.priv, 'alice', 'bob');
		await expect(
			decryptPostingEnvelope({ ...env, senderKey: b64(offCurve) }, R(bob), 'alice', 'bob')
		).rejects.toBeInstanceOf(DecryptError);
		await expect(
			decryptPostingEnvelope({ ...env, ephemeralPub: b64(offCurve) }, R(bob), 'alice', 'bob')
		).rejects.toBeInstanceOf(DecryptError);
	});

	it('two messages never share an ephemeral key, a nonce or a wrap', async () => {
		const a = await encryptToPostingKey('same', [bob.pub], alice.priv, 'alice', 'bob');
		const b = await encryptToPostingKey('same', [bob.pub], alice.priv, 'alice', 'bob');
		expect(a.ephemeralPub).not.toBe(b.ephemeralPub);
		expect(a.nonce).not.toBe(b.nonce);
		expect(a.ciphertext).not.toBe(b.ciphertext);
		expect(a.wraps[0]).not.toBe(b.wraps[0]);
	});
});

describe('decodePostingPubBLT', () => {
	it('reads the key Blurt (dblurt) writes, byte for byte', async () => {
		const blt = await formatPublicKeyBLT(alice.pub);
		expect(blt.startsWith('BLT')).toBe(true);
		expect(decodePostingPubBLT(blt)).toEqual(alice.pub);
	});
	it('refuses a wrong prefix, checksum, length or a point off the curve', () => {
		const body = (k: Uint8Array) =>
			base58Encode(new Uint8Array([...k, ...ripemd160(k).slice(0, 4)]));
		expect(decodePostingPubBLT(`BLT${body(bob.pub)}`)).toEqual(bob.pub);
		expect(decodePostingPubBLT(`STM${body(bob.pub)}`)).toBeNull();
		const badSum = new Uint8Array([...bob.pub, 0, 0, 0, 0]);
		expect(decodePostingPubBLT(`BLT${base58Encode(badSum)}`)).toBeNull();
		expect(decodePostingPubBLT(`BLT${body(bob.pub.slice(0, 32))}`)).toBeNull();
		expect(decodePostingPubBLT(`BLT${body(offCurveKey())}`)).toBeNull();
		expect(decodePostingPubBLT('BLT0OIl')).toBeNull();
		expect(decodePostingPubBLT('')).toBeNull();
	});
});

describe('a listed key holder cannot forge (v1.21.13 review 2, H-1)', () => {
	it('K recovered from one wrap opens no NEW text under the other wraps or the sender’s copy', async () => {
		const sodium = (await import('libsodium-wrappers-sumo')).default;
		await sodium.ready;
		const te = new TextEncoder();
		const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
		const x = (priv: Uint8Array, pub: Uint8Array) => secp.getSharedSecret(priv, pub, true).slice(1);
		// Alice's view of bob's keys includes Mallory's (a substituted key, or a
		// second key of bob's account held by another app).
		const env = await encryptToPostingKey(
			'genuine hello',
			[bob.pub, mallory.pub],
			alice.priv,
			'alice',
			'bob'
		);
		const E = unb64(env.ephemeralPub);
		// Mallory derives her KEK and opens HER wrap — she can read the message…
		const kek = sodium.crypto_generichash(
			32,
			new Uint8Array([
				...te.encode('morphit-chat-wrap-v3/alice\u0000bob\u0000'),
				...alice.pub,
				...mallory.pub,
				...E
			]),
			new Uint8Array([...x(mallory.priv, E), ...x(mallory.priv, alice.pub)])
		);
		const commit = sodium.crypto_generichash(
			32,
			new Uint8Array([
				...te.encode('morphit-chat-commit-v3\u0000'),
				...unb64(env.nonce),
				...unb64(env.ciphertext),
				...E,
				...alice.pub,
				...bob.pub,
				...mallory.pub
			])
		);
		const K = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
			null,
			unb64(env.wraps[1]!),
			new Uint8Array([...te.encode('morphit-chat-wrap-aad-v3/alice\u0000bob'), ...commit]),
			new Uint8Array(12),
			kek
		);
		expect(K).toHaveLength(32);
		// …and writes new text under K, keeping every wrap of Alice's message.
		const nonce = sodium.randombytes_buf(12);
		const ct = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
			te.encode('PAYMENT SENT, release now'),
			te.encode('morphit-chat-aad-v3/alice\u0000bob'),
			null,
			nonce,
			K
		);
		const forged: PostingEnvelopeWire = {
			...env,
			ciphertext: Buffer.from(ct).toString('base64'),
			nonce: Buffer.from(nonce).toString('base64')
		};
		await expect(
			decryptPostingEnvelope(forged, R(bob), 'alice', 'bob', [alice.pub])
		).rejects.toBeInstanceOf(DecryptError);
		await expect(decryptPostingSelfCopy(forged, R(alice), 'alice', 'bob')).rejects.toBeInstanceOf(
			DecryptError
		);
		// The genuine message still opens for bob, proved.
		expect(await decryptPostingEnvelope(env, R(bob), 'alice', 'bob', [alice.pub])).toEqual({
			text: 'genuine hello',
			authenticated: true
		});
		// Nor can the recipient list be edited around the wraps.
		await expect(
			decryptPostingEnvelope(
				{ ...env, recipientKeys: [env.recipientKeys[0]!], wraps: [env.wraps[0]!] },
				R(bob),
				'alice',
				'bob'
			)
		).rejects.toBeInstanceOf(DecryptError);
	});
});
