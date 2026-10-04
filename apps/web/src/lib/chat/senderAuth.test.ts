/**
 * A chat message must prove who sent it.
 *
 * Anyone who knows only Bob's PUBLIC chat key — a hostile indexer, for one —
 * could mint a message that decrypted fine "from @alice" (e.g. a new payout
 * address). Messages are now sent in the v2 envelope, whose key mixes a
 * static-static X25519 term DH(alice, bob): only alice's (or bob's) private
 * key can produce it. A v1 envelope still decrypts (older clients), but is
 * never reported as coming from the claimed sender.
 */
import { describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import * as chat from './crypto';

type Opened = { text: string; authenticated: boolean };
/** Whatever the module returns, read it as "text + is the sender proved". A
 *  bare string (the old API) is the old meaning: decrypting = from the sender. */
const asOpened = (r: unknown): Opened =>
	typeof r === 'string' ? { text: r, authenticated: true } : (r as Opened);

async function ids() {
	await sodium.ready;
	const alice = await chat.deriveChatIdentity(sodium.randombytes_buf(32), 'alice');
	const bob = await chat.deriveChatIdentity(sodium.randombytes_buf(32), 'bob');
	const mallory = await chat.deriveChatIdentity(sodium.randombytes_buf(32), 'mallory');
	return { alice, bob, mallory };
}
const m = chat as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;

describe('chat sender authentication', () => {
	it('a message made with only the recipient public key is never shown as from the claimed sender', async () => {
		const { alice, bob } = await ids();
		const legacy = m.encryptToRecipientV1 ?? m.encryptToRecipient;
		const forged = await legacy!('New payout address: bc1qmallory', bob.pub, 'alice', 'bob');
		let opened: Opened | null = null;
		try {
			opened = asOpened(
				await chat.decryptFromSender(forged as never, bob, 'alice', 'bob', [alice.pub] as never)
			);
		} catch {
			opened = null; // rejected: also fine
		}
		expect(opened === null || opened.authenticated === false).toBe(true);
	});

	it('a v2 envelope made with another static key and a claimed sender is rejected', async () => {
		const { alice, bob, mallory } = await ids();
		if (m.encryptToRecipientV1 === undefined) throw new Error('no v2 envelope in this build');
		const forged = await chat.encryptToRecipient(
			'pay here',
			bob.pub,
			mallory as never,
			'alice' as never,
			'bob' as never
		);
		await expect(
			chat.decryptFromSender(forged as never, bob, 'alice', 'bob', [alice.pub] as never)
		).rejects.toThrow();
	});

	it('a genuine v2 message from alice decrypts and is proved to be from alice', async () => {
		const { alice, bob } = await ids();
		if (m.encryptToRecipientV1 === undefined) throw new Error('no v2 envelope in this build');
		const env = await chat.encryptToRecipient(
			'hi bob',
			bob.pub,
			alice as never,
			'alice' as never,
			'bob' as never
		);
		expect((env as { v?: number }).v).toBe(2);
		const opened = asOpened(
			await chat.decryptFromSender(env as never, bob, 'alice', 'bob', [alice.pub] as never)
		);
		expect(opened).toEqual({ text: 'hi bob', authenticated: true });
	});

	it('stripping the version from a v2 envelope does not downgrade it to a readable v1 message', async () => {
		const { alice, bob } = await ids();
		if (m.encryptToRecipientV1 === undefined) throw new Error('no v2 envelope in this build');
		const env = (await chat.encryptToRecipient(
			'hi',
			bob.pub,
			alice as never,
			'alice' as never,
			'bob' as never
		)) as unknown as Record<string, unknown>;
		const { v: _v, ...stripped } = env;
		await expect(
			chat.decryptFromSender(stripped as never, bob, 'alice', 'bob', [alice.pub] as never)
		).rejects.toThrow();
	});

	it("the sender's own self-copy needs the peer's key too: one forged with only the sender's public key is rejected", async () => {
		const { alice, bob } = await ids();
		if (m.encryptToRecipientV1 === undefined) throw new Error('no v2 envelope in this build');
		const env = await chat.encryptToRecipient(
			'mine',
			bob.pub,
			alice as never,
			'alice' as never,
			'bob' as never,
			true as never
		);
		expect(
			await chat.decryptSelfCopy(env as never, alice, 'alice', 'bob', [bob.pub] as never)
		).toBe('mine');
		// The indexer knows alice's public key only: it can write a v1-style self-copy…
		const forgedV1 = await m.encryptToRecipientV1!(
			'fake',
			bob.pub,
			'alice',
			'bob',
			alice.pub,
			true
		);
		const forged = { ...(forgedV1 as object), v: 2 };
		await expect(
			chat.decryptSelfCopy(forged as never, alice, 'alice', 'bob', [bob.pub] as never)
		).rejects.toThrow();
	});
});

describe('v2 envelope round-trip and tampering', () => {
	it('round-trips unicode, and every tampered field is rejected', async () => {
		const { alice, bob } = await ids();
		const text = '👋 مرحبا こんにちは a​b';
		const env = await chat.encryptToRecipient(text, bob.pub, alice, 'alice', 'bob');
		expect(await chat.decryptFromSender(env, bob, 'alice', 'bob', [alice.pub])).toEqual({
			text,
			authenticated: true
		});
		const flip = (b64: string) => {
			const b = sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
			b[0] = b[0]! ^ 1;
			return sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
		};
		for (const tampered of [
			{ ...env, ciphertext: flip(env.ciphertext) },
			{ ...env, nonce: flip(env.nonce) },
			{ ...env, ephemeralPub: flip(env.ephemeralPub) }
		]) {
			await expect(
				chat.decryptFromSender(tampered, bob, 'alice', 'bob', [alice.pub])
			).rejects.toThrow(chat.DecryptError);
		}
		// re-attributed or re-addressed
		await expect(chat.decryptFromSender(env, bob, 'mallory', 'bob', [alice.pub])).rejects.toThrow();
		await expect(chat.decryptFromSender(env, bob, 'alice', 'carol', [alice.pub])).rejects.toThrow();
		// no pinned key for the sender: cannot be opened
		await expect(chat.decryptFromSender(env, bob, 'alice', 'bob', [])).rejects.toThrow();
	});

	it('an older pinned key in the candidate list still opens a message sent before a key change', async () => {
		const { alice, bob, mallory } = await ids();
		const env = await chat.encryptToRecipient('old', bob.pub, alice, 'alice', 'bob');
		const opened = await chat.decryptFromSender(env, bob, 'alice', 'bob', [mallory.pub, alice.pub]);
		expect(opened.authenticated).toBe(true);
	});

	it("'destroy' mode writes no self-copy; the recipient copy is not a self-copy", async () => {
		const { alice, bob } = await ids();
		const env = await chat.encryptToRecipient('x', bob.pub, alice, 'alice', 'bob', false);
		expect(env.selfCiphertext).toBeUndefined();
		await expect(chat.decryptSelfCopy(env, alice, 'alice', 'bob', [bob.pub])).rejects.toThrow();
		const keep = await chat.encryptToRecipient('x', bob.pub, alice, 'alice', 'bob', true);
		// the recipient cannot open the self-copy, the sender cannot open the recipient copy
		await expect(chat.decryptSelfCopy(keep, bob, 'alice', 'bob', [alice.pub])).rejects.toThrow();
		await expect(
			chat.decryptFromSender(keep, alice, 'alice', 'bob', [alice.pub])
		).rejects.toThrow();
	});
});
