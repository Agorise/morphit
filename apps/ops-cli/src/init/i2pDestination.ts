// I2P destination → `.b32.i2p` address derivation.
//
// An I2P "b32" address is the standard hash-of-destination address:
//     b32 = base32( SHA-256( Destination ) ).lower() + ".b32.i2p"
// where Destination is the KeysAndCert public structure at the FRONT of an
// i2pd private-keys file (the private material follows and is NEVER hashed).
//
// Unlike Tor's onion (a lone ed25519 pubkey we can mint in Node), an I2P
// destination bundles an encryption key + a signing key + a certificate, and
// ElGamal keygen isn't in Node's crypto.  So i2pd — the authoritative I2P
// implementation — generates the keys; ops-cli configures its tunnel and
// derives the advertised address from the keyfile i2pd produces.
//
// KeysAndCert layout for i2pd's default new key (signature type 7
// EdDSA-Ed25519, from the i2pd log "Creating new one with signature type 7
// crypto type 0/4"):
//     publicKey         256   encryption key field (ElGamal fills it; X25519
//                             sits in the first 32 bytes, rest padded)
//     signingPublicKey  128   Ed25519 key (32 bytes) right-aligned + padding
//     KeyCertificate      7   type 5, length 4, sigType 2, cryptoType 2
//   ------------------------------
//     total             391
// The field sizes are fixed at 256/128 regardless of whether the crypto type
// is 0 (ElGamal) or 4 (ECIES-X25519) — only the trailing PRIVATE key length
// differs — so hashing the first 391 bytes yields the right address for both.
// VERIFIED byte-for-byte against real i2pd 2.49: i2pd names its LeaseSet
// cache files `<b32>.<N>.dat`, and base32(SHA-256(keyfile[0:391])) reproduced
// that b32 on two independent freshly-generated keyfiles.

import { createHash } from 'node:crypto';
import { base32Encode } from './torOnion.ts';

/** Byte length of the KeysAndCert (I2P Destination) at the front of an i2pd
 *  signature-type-7 keyfile: 256 + 128 + 7.  The SHA-256 of exactly these
 *  bytes is what the address hashes — matches `scripts/generate-i2p.sh`'s
 *  `head -c 391`. */
export const I2P_KEYS_AND_CERT_LEN = 391;

/** Offset of the certificate within the KeysAndCert (after the 256+128 key
 *  fields). */
const CERT_OFFSET = 384;
/** Certificate type 5 = KeyCertificate (carries the sig/crypto type). */
const KEY_CERTIFICATE_TYPE = 5;
/** Signature type 7 = EdDSA-SHA512-Ed25519 (i2pd's default; the only shape
 *  whose key fits the 128-byte field without spilling into the cert, keeping
 *  the KeysAndCert at exactly 391 bytes). */
const SIG_TYPE_ED25519 = 7;

export class I2pKeyfileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'I2pKeyfileError';
	}
}

/** True if the buffer begins with a well-formed signature-type-7
 *  KeysAndCert (length + KeyCertificate shape + Ed25519 sig type).  A cheap
 *  guard so we never derive an address from a truncated or wrong-format file
 *  and advertise a dead pointer. */
export function isSigType7Keyfile(keyfile: Buffer): boolean {
	if (keyfile.length < I2P_KEYS_AND_CERT_LEN) return false;
	if (keyfile[CERT_OFFSET] !== KEY_CERTIFICATE_TYPE) return false; // cert type 5
	if (keyfile[CERT_OFFSET + 1] !== 0x00 || keyfile[CERT_OFFSET + 2] !== 0x04) return false; // cert length 4
	const sigType = (keyfile[CERT_OFFSET + 3]! << 8) | keyfile[CERT_OFFSET + 4]!;
	return sigType === SIG_TYPE_ED25519;
}

/** Derive the `<b32>.b32.i2p` address from an i2pd private-keys file.  Hashes
 *  only the leading 391-byte KeysAndCert (Destination) — never the private
 *  material that follows.  Throws I2pKeyfileError if the buffer isn't a
 *  well-formed signature-type-7 keyfile. */
export function i2pB32FromKeyfile(keyfile: Buffer): string {
	if (keyfile.length < I2P_KEYS_AND_CERT_LEN) {
		throw new I2pKeyfileError(
			`i2pd keyfile is ${keyfile.length} bytes; need at least ${I2P_KEYS_AND_CERT_LEN} for a Destination`
		);
	}
	if (!isSigType7Keyfile(keyfile)) {
		throw new I2pKeyfileError(
			'i2pd keyfile is not a signature-type-7 (EdDSA-Ed25519) Destination — refusing to derive an address from an unexpected key format'
		);
	}
	const destination = keyfile.subarray(0, I2P_KEYS_AND_CERT_LEN);
	const hash = createHash('sha256').update(destination).digest();
	return base32Encode(hash) + '.b32.i2p';
}
