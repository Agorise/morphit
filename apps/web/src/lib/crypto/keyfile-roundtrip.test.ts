import { describe, it, expect } from 'vitest';
import { importIdentityFromSeed } from './keygen';
import { encryptIdentity, decryptIdentity } from './keystore';
import { toLiveIdentity } from './identity-core';
import * as secp from '@noble/secp256k1';

// A valid BIP39 test mnemonic.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function pubFromPriv(priv: Uint8Array): Uint8Array {
	return secp.getPublicKey(priv, true); // compressed
}

describe('keyfile decrypt → toLiveIdentity posting keypair consistency (cp440)', () => {
	it('the live posting private key derives the live posting public key', async () => {
		const { full } = await importIdentityFromSeed(SEED);
		const env = await encryptIdentity(full, 'test-password-123');
		// keyfile login path: decrypt a fresh identity, then toLiveIdentity
		const full2 = await decryptIdentity(env, 'test-password-123');
		const live = toLiveIdentity(full2 as never);
		const derivedPub = pubFromPriv(live.posting.privateKey);
		expect(Array.from(derivedPub)).toEqual(Array.from(live.posting.publicKey));
		// also: posting private key must NOT be all zeros
		expect(live.posting.privateKey.some((b) => b !== 0)).toBe(true);
	});
});
