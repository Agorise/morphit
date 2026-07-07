/**
 * Morphit relay — public key validation.
 *
 * We don't need to sign with user keys, just validate that the pubkey
 * strings the user sends are well-formed BLT keys. dblurt's
 * PublicKey.fromString does full checksum verification; we wrap it so
 * the API layer doesn't have to think about exceptions.
 */

import { PublicKey } from '@beblurt/dblurt';

/**
 * Check whether the string is a well-formed BLT public key.
 * Validates: BLT prefix, base58 encoding, RIPEMD160 checksum, and
 * that the decoded bytes represent a valid secp256k1 compressed
 * point.
 */
export function isValidPublicKey(s: unknown): s is string {
	if (typeof s !== 'string') return false;
	if (!s.startsWith('BLT')) return false;
	try {
		PublicKey.fromString(s);
		return true;
	} catch {
		return false;
	}
}
