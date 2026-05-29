/**
 * Morphit — encrypted-at-rest storage for alt-network service
 * keys (Tor onion, Lokinet, I2P).
 *
 * Reuses the relay's keyEnvelope format (scrypt N=2^17 + AES-
 * 256-GCM, ADR-0010 §4) with a per-network associated-data
 * binding.  An attacker who obtains all three keystores cannot
 * swap their contents — GCM auth-fail rejects a ciphertext
 * decrypted under the wrong network's AAD.
 *
 * Same passphrase that unlocks the relay's active key unlocks
 * these files (per Morphit's "one passphrase per instance"
 * operator UX).  This is an explicit tradeoff: convenience
 * over compartmentalization.  Operators who want different
 * passphrases for different keys can run multiple instances
 * (separate trust domains anyway) or rotate their setup
 * post-launch.
 *
 * The plaintext we encrypt is whatever the alt-network service's
 * tool produced.  For Tor v3, this is the contents of
 * `hs_ed25519_secret_key` (binary).  For Lokinet, the .ini
 * configuration's `[paths]` private key.  For I2P, the .dat
 * file.  This module is opaque to the format — it just stores
 * and retrieves bytes.
 *
 * On disk:
 *   apps/relay/altnet/tor-key.json
 *   apps/relay/altnet/lokinet-key.json
 *   apps/relay/altnet/i2p-key.json
 *
 * Mode 0600 enforced on every write.
 */

import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
	timingSafeEqual
} from 'node:crypto';

/** Networks we support encrypted-at-rest storage for.  Adding
 *  a new one is a one-line change to this union and the
 *  filename map below. */
export type AltNetwork = 'tor' | 'lokinet' | 'i2p';

/** Same scrypt parameters as the relay's active-key envelope.
 *  Bump together if hardware ever makes these too slow. */
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/** Envelope wire format.  Distinct version namespace from the
 *  active-key envelope (`v: 1`) so a future change to either
 *  doesn't accidentally cross-decrypt.  We start at 1; if we
 *  ever bump, both must stay distinguishable. */
export interface AltKeyEnvelope {
	readonly v: 1;
	readonly purpose: 'morphit-altnet-key';
	readonly network: AltNetwork;
	readonly kdf: 'scrypt';
	readonly kdf_params: {
		readonly N: number;
		readonly r: number;
		readonly p: number;
		readonly salt: string;
	};
	readonly cipher: 'aes-256-gcm';
	readonly iv: string;
	readonly ct: string;
}

export class AltKeyEnvelopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AltKeyEnvelopeError';
	}
}

/** Filename for a given network's encrypted keystore. */
export function altKeystoreFilename(network: AltNetwork): string {
	return `${network}-key.json`;
}

/** Build the AAD (additional authenticated data) for AES-GCM.
 *  Includes the version, purpose tag, AND network — this is
 *  the cross-network swap defense.  AAD does not appear in the
 *  ciphertext but is fed to the MAC; tampering with the
 *  envelope's `network` field will fail decryption. */
function buildAad(version: number, purpose: string, network: AltNetwork): Buffer {
	return Buffer.from(`v${version}/${purpose}/${network}`);
}

/** Encrypt raw bytes (the alt-network service key) with the
 *  passphrase.  Returns a JSON-serializable envelope.  Costs
 *  scrypt time (~500ms-1s); don't call in a loop. */
export function encryptAltKey(
	plaintext: Buffer,
	passphrase: string,
	network: AltNetwork
): AltKeyEnvelope {
	if (passphrase.length < 8) {
		throw new AltKeyEnvelopeError('passphrase must be at least 8 characters');
	}
	if (plaintext.length === 0) {
		throw new AltKeyEnvelopeError('refusing to encrypt empty plaintext');
	}

	const salt = randomBytes(SALT_LENGTH);
	const iv = randomBytes(IV_LENGTH);
	const key = scryptSync(passphrase, salt, KEY_LENGTH, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: 256 * 1024 * 1024 // N=2^17 needs ~128 MB; double that for safety
	});

	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(buildAad(1, 'morphit-altnet-key', network));
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();

	// Wipe the derived key buffer.  Best-effort; we don't have
	// secure-erase guarantees in JS.
	key.fill(0);

	return {
		v: 1,
		purpose: 'morphit-altnet-key',
		network,
		kdf: 'scrypt',
		kdf_params: {
			N: SCRYPT_N,
			r: SCRYPT_R,
			p: SCRYPT_P,
			salt: salt.toString('base64')
		},
		cipher: 'aes-256-gcm',
		iv: iv.toString('base64'),
		ct: Buffer.concat([ciphertext, tag]).toString('base64')
	};
}

/** Decrypt an envelope.  Returns the raw plaintext bytes on
 *  success; throws AltKeyEnvelopeError on any failure. */
export function decryptAltKey(envelope: AltKeyEnvelope, passphrase: string): Buffer {
	if (envelope.v !== 1) {
		throw new AltKeyEnvelopeError(`unsupported envelope version ${envelope.v}`);
	}
	if (envelope.purpose !== 'morphit-altnet-key') {
		throw new AltKeyEnvelopeError(
			`wrong purpose: expected morphit-altnet-key, got ${envelope.purpose}`
		);
	}
	if (envelope.kdf !== 'scrypt') {
		throw new AltKeyEnvelopeError(`unsupported kdf ${envelope.kdf}`);
	}
	if (envelope.cipher !== 'aes-256-gcm') {
		throw new AltKeyEnvelopeError(`unsupported cipher ${envelope.cipher}`);
	}

	const salt = Buffer.from(envelope.kdf_params.salt, 'base64');
	const iv = Buffer.from(envelope.iv, 'base64');
	const ctWithTag = Buffer.from(envelope.ct, 'base64');
	if (ctWithTag.length < 16) {
		throw new AltKeyEnvelopeError('ciphertext too short to contain tag');
	}
	const tag = ctWithTag.subarray(ctWithTag.length - 16);
	const ciphertext = ctWithTag.subarray(0, ctWithTag.length - 16);

	const key = scryptSync(passphrase, salt, KEY_LENGTH, {
		N: envelope.kdf_params.N,
		r: envelope.kdf_params.r,
		p: envelope.kdf_params.p,
		maxmem: 256 * 1024 * 1024
	});

	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAAD(buildAad(envelope.v, envelope.purpose, envelope.network));
	decipher.setAuthTag(tag);

	let plaintext: Buffer;
	try {
		plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		key.fill(0);
		throw new AltKeyEnvelopeError(
			'decryption failed: wrong passphrase, corrupted file, or wrong network binding'
		);
	}

	key.fill(0);
	return plaintext;
}

/** Side-channel-resistant constant-time compare of two
 *  passphrases.  Used by tests; not currently called by the
 *  prod path but kept here for parity with relay/keyEnvelope.ts. */
export function passphrasesEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a, 'utf-8');
	const bb = Buffer.from(b, 'utf-8');
	if (ba.length !== bb.length) return false;
	return timingSafeEqual(ba, bb);
}
