/**
 * The alt-network keystore's KDF parameters come from the file:
 * a file whose scrypt parameters were lowered
 * is refused before any work; a well-formed file still opens.
 */
import { describe, expect, it } from 'vitest';
import { decryptAltKey, encryptAltKey } from '../src/init/altKeystore.ts';

const PASS = 'a long enough passphrase for the test';
const good = encryptAltKey(Buffer.from('secret key bytes'), PASS, 'tor');

describe('alt keystore scrypt floor', () => {
	it('opens a file written by this tool', () => {
		expect(decryptAltKey(good, PASS).toString()).toBe('secret key bytes');
	});

	it('refuses lowered parameters before deriving', () => {
		for (const kdf of [
			{ ...good.kdf_params, N: 2 },
			{ ...good.kdf_params, N: 1024 },
			{ ...good.kdf_params, r: 1 },
			{ ...good.kdf_params, N: 1 << 24 }
		]) {
			const t = Date.now();
			expect(() => decryptAltKey({ ...good, kdf_params: kdf }, PASS)).toThrow(/refusing scrypt/);
			expect(Date.now() - t).toBeLessThan(200);
		}
	});
});
