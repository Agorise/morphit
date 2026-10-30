/**
 * The key envelope's off-the-event-loop variants (encryptEnvelopeAsync /
 * decryptEnvelopeAsync), used by `morphit-ops` so the braille spinner keeps
 * turning while scrypt works: they read and write exactly the same envelopes
 * as the sync ones, and a wrong passphrase is the same `decryption_failed`.
 */
import { describe, expect, it } from 'vitest';
import {
	decryptEnvelope,
	decryptEnvelopeAsync,
	encryptEnvelope,
	encryptEnvelopeAsync,
	KeyEnvelopeError
} from '../src/crypto/keyEnvelope.ts';

const WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
const PASS = 'a passphrase that is long enough';

describe('key envelope, async variants', () => {
	it('async-encrypted opens with the sync decrypt, and the other way round', async () => {
		expect(decryptEnvelope(await encryptEnvelopeAsync(WIF, PASS), PASS)).toBe(WIF);
		expect(await decryptEnvelopeAsync(encryptEnvelope(WIF, PASS), PASS)).toBe(WIF);
	}, 60_000);

	it('a wrong passphrase is decryption_failed, as with the sync decrypt', async () => {
		const env = encryptEnvelope(WIF, PASS);
		await expect(decryptEnvelopeAsync(env, 'not the passphrase')).rejects.toSatisfy(
			(e: unknown) => e instanceof KeyEnvelopeError && e.code === 'decryption_failed'
		);
	}, 60_000);

	it('does not block the event loop while it derives the key', async () => {
		const env = encryptEnvelope(WIF, PASS);
		let ticks = 0;
		const t = setInterval(() => ticks++, 10);
		await decryptEnvelopeAsync(env, PASS);
		clearInterval(t);
		expect(ticks).toBeGreaterThan(2);
	}, 60_000);
});
