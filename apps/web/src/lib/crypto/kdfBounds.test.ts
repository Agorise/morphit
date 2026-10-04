/**
 * A keyfile's stored Argon2id parameters are bounded on every path: a hostile
 * keyfile asking for gigabytes of memory is refused before any derivation
 * runs (it used to be run as asked on the YubiKey path, freezing or crashing
 * the tab), and an ordinary keystore still opens.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { blobToEnvelope, decryptIdentity, encryptIdentity, envelopeToBlob } from './keystore';
import { generateFullIdentity } from './keygen';
import { enrollYubikey, unlockWithYubikey } from './keystoreYubikey';

const PW = 'right-password-123';
const GIB4 = 4 * 1024 * 1024 * 1024;
const hmac = async (c: Uint8Array) =>
	new Uint8Array(createHmac('sha1', Buffer.alloc(20, 7)).update(c).digest());

describe('stored KDF parameters are bounded', () => {
	it('a keyfile asking for 4 GiB is refused, not run', async () => {
		const env = await encryptIdentity(await generateFullIdentity(), PW);
		const hostile = { ...env, kdfParams: { opslimit: 2, memlimit: GIB4 } };
		await expect(blobToEnvelope(envelopeToBlob(hostile as never))).rejects.toThrow();
		await expect(decryptIdentity(hostile as never, PW)).rejects.toThrow();
	});

	it('a YubiKey wrap asking for 1 GiB is refused, not run', async () => {
		const layered = await enrollYubikey(
			await encryptIdentity(await generateFullIdentity(), PW),
			PW,
			hmac,
			2 as never,
			'k'
		);
		const hostile = {
			...layered,
			wraps: layered.wraps.map((w) =>
				w.kind === 'yubikey' ? { ...w, kdfParams: { opslimit: 4, memlimit: GIB4 / 4 } } : w
			)
		};
		const started = Date.now();
		await expect(unlockWithYubikey(hostile as never, hmac)).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it('an ordinary keystore still opens', async () => {
		const env = await encryptIdentity(await generateFullIdentity(), PW);
		await expect(
			decryptIdentity(await blobToEnvelope(envelopeToBlob(env)), PW)
		).resolves.toBeTruthy();
	});
});
