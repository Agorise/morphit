/**
 * Why a keyfile or seed is refused is told by the error's TYPE, so the import
 * page can say which instead of classifying English messages (a damaged file,
 * a newer version, a file far too large, a 2FA or YubiKey-only keyfile all
 * used to fall through to "it wasn't your key or password, try again").
 * Corpus: the QZ import-error probe.
 */
import { describe, expect, it } from 'vitest';
import {
	KeyfileFormatError,
	KeystoreError,
	blobToEnvelope,
	decryptIdentity,
	encryptIdentity,
	envelopeToBlob
} from './keystore';
import { SeedPhraseError, generateFullIdentity, importFullIdentityFromSeed } from './keygen';
import { enrollYubikey, hardenToYubikeyOnly } from './keystoreYubikey';
import { createHmac } from 'node:crypto';

const FORMAT = 'morphit-keystore-v1';
const blob = (s: string): Blob => new Blob([s]);

async function formatKind(body: string): Promise<string> {
	try {
		await blobToEnvelope(blob(body));
		return 'accepted';
	} catch (err) {
		return err instanceof KeyfileFormatError ? err.kind : `untyped: ${String(err)}`;
	}
}

describe('a file that is not a usable keyfile says why', () => {
	it.each([
		['not JSON (a screenshot)', '\x89PNG\r\n\x1a\n....', 'not_morphit'],
		['JSON, not a keyfile', '{"name":"x","version":"1.0.0"}', 'not_morphit'],
		[
			'a damaged keyfile',
			JSON.stringify({
				format: FORMAT,
				v: 1,
				kdf: 'argon2id',
				salt: '',
				nonce: 'a',
				ciphertext: 'b',
				createdAt: 1
			}),
			'corrupt'
		],
		[
			'a keyfile from a newer version',
			JSON.stringify({
				format: FORMAT,
				v: 2,
				kdf: 'argon2id',
				salt: 'a',
				nonce: 'a',
				ciphertext: 'b',
				createdAt: 1
			}),
			'too_new'
		],
		['a 70 KB file', 'x'.repeat(70_000), 'too_large']
	])('%s → %s', async (_label, body, kind) => {
		expect(await formatKind(body)).toBe(kind);
	});
});

describe('a keyfile that opens, but not with a password alone, says so', () => {
	it('a wrong password is a KeystoreError bad_password', async () => {
		const env = await blobToEnvelope(
			envelopeToBlob(await encryptIdentity(await generateFullIdentity(), 'right-password-123'))
		);
		await expect(decryptIdentity(env, 'wrong-password-123')).rejects.toMatchObject({
			kind: 'bad_password'
		});
	});

	it('a YubiKey-only keyfile is a KeystoreError no_passphrase_wrap', async () => {
		const hmac = async (c: Uint8Array) =>
			new Uint8Array(createHmac('sha1', Buffer.alloc(20, 3)).update(c).digest());
		const simple = await encryptIdentity(await generateFullIdentity(), 'right-password-123');
		const layered = await enrollYubikey(simple, 'right-password-123', hmac, 2 as never, 'k');
		const keyfile = await blobToEnvelope(envelopeToBlob(hardenToYubikeyOnly(layered)));
		const err = await decryptIdentity(keyfile, 'right-password-123').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(KeystoreError);
		expect((err as KeystoreError).kind).toBe('no_passphrase_wrap');
	});
});

describe('a seed phrase that is refused says why', () => {
	it('wrong number of words', async () => {
		await expect(importFullIdentityFromSeed('one two three')).rejects.toMatchObject({
			kind: 'word_count'
		});
	});
	it('not a valid phrase', async () => {
		const bad = Array(12).fill('zebra').join(' ');
		const err = await importFullIdentityFromSeed(bad).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SeedPhraseError);
		expect((err as SeedPhraseError).kind).toBe('invalid');
	});
});
