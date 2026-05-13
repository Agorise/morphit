/**
 * Morphit relay — encrypted-key envelope format (ADR-0010 §4).
 *
 * An operator who runs the relay wants their active key protected
 * while the service is stopped. This module provides the format
 * and the primitives for reading/writing an encrypted-key file:
 *
 *   v1 envelope (JSON):
 *     {
 *       "v": 1,
 *       "kdf": "scrypt",
 *       "kdf_params": { "N": 131072, "r": 8, "p": 1, "salt": "<b64>" },
 *       "cipher": "aes-256-gcm",
 *       "iv": "<b64-12-bytes>",
 *       "ct": "<b64-ciphertext-with-tag-suffixed>"
 *     }
 *
 * Notes on the choices:
 *   - scrypt at N=2^17 takes ~500ms–1s to derive the key on a
 *     typical VPS, which makes brute-force painful for an
 *     attacker who has the file but not the passphrase. It's
 *     fast enough that operator reboots don't feel stuck.
 *   - AES-256-GCM is Node-native (no new deps), provides both
 *     confidentiality and integrity, and its nonce-reuse
 *     footgun doesn't apply here because we generate a fresh
 *     IV per encrypt call.
 *   - We store the auth tag suffixed on the ciphertext — 16
 *     bytes per GCM spec. This lets the envelope stay flat
 *     (one ct field) rather than splitting tag + ct.
 *
 * The envelope is human-readable JSON so an operator can verify
 * integrity with a Python one-liner if the relay code ever
 * becomes suspect:
 *
 *   python3 -c "import json,sys; print(json.load(open(sys.argv[1])))" file.enc
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Current envelope version. Bump on any breaking change. */
export const KEY_ENVELOPE_VERSION = 1;

/** scrypt parameters. N=2^17 chosen for ~500ms–1s on a modest
 *  VPS. If future hardware makes this too slow to tolerate,
 *  bump to N=2^16 in a v2 envelope. Never reduce below 2^15. */
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** scrypt's memory cost is ~128 × N × r bytes. For our chosen
 *  params that's 128 × 131072 × 8 ≈ 128 MB. OpenSSL defaults
 *  `maxmem` to 32 MB which would reject any N > ~32768.
 *  Bump it to 256 MB to give a margin and forward-compat for
 *  any future N=2^18 envelopes — still safely below typical
 *  VPS RAM. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/** 32-byte derived key (AES-256 requires 32 bytes). */
const KEY_LENGTH = 32;
/** 16-byte salt for scrypt (128 bits — plenty, per NIST). */
const SALT_LENGTH = 16;
/** 12-byte IV for AES-GCM per NIST SP 800-38D. */
const IV_LENGTH = 12;

/** Raw envelope object (as persisted to disk). */
export interface KeyEnvelope {
	readonly v: number;
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

export class KeyEnvelopeError extends Error {
	/** Machine-readable failure category. Callers should
	 *  branch on this rather than parsing `message`.
	 *
	 *  - `decryption_failed`: tag check or decipher failure
	 *    (wrong passphrase, tampered envelope, or both
	 *    indistinguishably — see GCM's authentication
	 *    semantics).
	 *  - `malformed`: shape, version, KDF / cipher choice, or
	 *    field length is unsupported / invalid. Cannot recover
	 *    by re-prompting for the passphrase.
	 *  - `weak_params`: scrypt N below the 2^15 floor. Treat
	 *    as malformed (won't decrypt regardless of passphrase). */
	readonly code: 'decryption_failed' | 'malformed' | 'weak_params';

	constructor(
		message: string,
		code: 'decryption_failed' | 'malformed' | 'weak_params' = 'malformed'
	) {
		super(message);
		this.name = 'KeyEnvelopeError';
		this.code = code;
	}
}

/** Encrypt a plaintext string (the WIF) with the passphrase.
 *  Returns a JSON-serializable envelope. Side effect: costs
 *  scrypt time; don't call in a tight loop. */
export function encryptEnvelope(plaintext: string, passphrase: string): KeyEnvelope {
	if (plaintext.length === 0) {
		throw new KeyEnvelopeError('refuse to encrypt an empty plaintext');
	}
	if (passphrase.length < 8) {
		// An 8-char minimum isn't secure against a serious attack,
		// but it's a reasonable floor for operator typing errors.
		// Real security comes from scrypt cost + passphrase entropy.
		throw new KeyEnvelopeError('passphrase must be at least 8 characters');
	}
	const salt = randomBytes(SALT_LENGTH);
	const iv = randomBytes(IV_LENGTH);
	const key = scryptSync(passphrase, salt, KEY_LENGTH, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: SCRYPT_MAXMEM
	});
	try {
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		const ctBody = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		const tag = cipher.getAuthTag();
		return {
			v: KEY_ENVELOPE_VERSION,
			kdf: 'scrypt',
			kdf_params: {
				N: SCRYPT_N,
				r: SCRYPT_R,
				p: SCRYPT_P,
				salt: salt.toString('base64')
			},
			cipher: 'aes-256-gcm',
			iv: iv.toString('base64'),
			ct: Buffer.concat([ctBody, tag]).toString('base64')
		};
	} finally {
		// Zero the scrypt-derived key whether the encrypt succeeded
		// or threw.  Same rationale as decryptEnvelope's finally.
		key.fill(0);
	}
}

/** Decrypt an envelope. Returns the plaintext string on
 *  success. Throws KeyEnvelopeError on malformed envelope,
 *  version mismatch, or wrong passphrase. */
export function decryptEnvelope(envelope: unknown, passphrase: string): string {
	const e = asEnvelope(envelope);
	if (e.v !== KEY_ENVELOPE_VERSION) {
		throw new KeyEnvelopeError(`unsupported envelope version ${e.v}`);
	}
	if (e.kdf !== 'scrypt') {
		throw new KeyEnvelopeError(`unsupported kdf ${JSON.stringify(e.kdf)}`);
	}
	if (e.cipher !== 'aes-256-gcm') {
		throw new KeyEnvelopeError(`unsupported cipher ${JSON.stringify(e.cipher)}`);
	}
	const { N, r, p, salt: saltB64 } = e.kdf_params;
	if (!Number.isInteger(N) || N < 32_768) {
		throw new KeyEnvelopeError('refuse scrypt N below 2^15 (too weak)', 'weak_params');
	}
	// Audit 2026-05 finding 5-1: validate r and p too.  An attacker-
	// tampered envelope could set r=1 paired with the N floor to
	// degrade scrypt cost ~8x.  Defense-in-depth.
	if (!Number.isInteger(r) || r < 8) {
		throw new KeyEnvelopeError('refuse scrypt r below 8 (too weak)', 'weak_params');
	}
	if (!Number.isInteger(p) || p < 1 || p > 16) {
		throw new KeyEnvelopeError('refuse scrypt p out of range', 'weak_params');
	}
	let salt: Buffer, iv: Buffer, ctAndTag: Buffer;
	try {
		salt = Buffer.from(saltB64, 'base64');
		iv = Buffer.from(e.iv, 'base64');
		ctAndTag = Buffer.from(e.ct, 'base64');
	} catch {
		throw new KeyEnvelopeError('envelope contains non-base64 field');
	}
	if (salt.length !== SALT_LENGTH) {
		throw new KeyEnvelopeError(`bad salt length ${salt.length}`);
	}
	if (iv.length !== IV_LENGTH) {
		throw new KeyEnvelopeError(`bad iv length ${iv.length}`);
	}
	if (ctAndTag.length < 16) {
		throw new KeyEnvelopeError('ciphertext too short to contain a tag');
	}
	const tag = ctAndTag.subarray(ctAndTag.length - 16);
	const ct = ctAndTag.subarray(0, ctAndTag.length - 16);
	const key = scryptSync(passphrase, salt, KEY_LENGTH, { N, r, p, maxmem: SCRYPT_MAXMEM });
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	let plaintext: Buffer | undefined;
	try {
		plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
		// JS-string-immutability constraint (mirrored from
		// apps/web's keystore.ts SECURITY.md §1b note): the
		// .toString('utf8') below produces an immutable JS string
		// holding the WIF.  We can't zero strings — they live
		// until V8 GC.  We CAN zero the Buffer we own (below in
		// finally), shortening the duration during which the WIF
		// has TWO reachable copies in memory.  Same fundamental
		// limit applies to the returned string: callers (config
		// store, signTransaction) hold it for the lifetime of the
		// process; that's intentional for the relay's persistent-
		// signer role.
		return plaintext.toString('utf8');
	} catch {
		// GCM throws a generic "Unsupported state" on bad tag —
		// translate to a clearer message. This is the wrong-
		// passphrase path in practice. (Tag failure also triggers
		// here if the envelope was tampered — GCM auth doesn't
		// distinguish, and we don't either.)
		throw new KeyEnvelopeError(
			'decryption failed — wrong passphrase, or envelope was tampered with',
			'decryption_failed'
		);
	} finally {
		// Zero the scrypt-derived key whether we returned a WIF
		// or threw.  Best-effort: Node's Buffer.fill writes to the
		// underlying ArrayBuffer, but if Node's internal buffer
		// pool reuses that memory the bytes get overwritten on
		// next allocation anyway.  Pre-fix the key sat in the
		// pool until pool reuse, observable to a heap scraper.
		key.fill(0);
		// Zero the plaintext Buffer.  The returned JS string holds
		// the same bytes encoded as UTF-16 in the V8 string heap;
		// THAT cannot be zeroed.  But this Buffer was the only
		// readable-as-bytes copy and zeroing it removes the
		// shorter-lived dual-residue.
		if (plaintext) plaintext.fill(0);
	}
}

/** Sniff whether a file's contents look like an encrypted
 *  envelope (JSON with a `v` field) versus a raw WIF string.
 *  Lets the relay support both formats during the migration
 *  window. */
export function looksLikeEnvelope(content: string): boolean {
	// Quick and deterministic: check leading non-whitespace char.
	// A WIF starts with '5' (or 'K' for compressed) — never '{'.
	const trimmed = content.trimStart();
	return trimmed.startsWith('{');
}

function asEnvelope(raw: unknown): KeyEnvelope {
	if (typeof raw !== 'object' || raw === null) {
		throw new KeyEnvelopeError('envelope must be an object');
	}
	const e = raw as Record<string, unknown>;
	if (typeof e.v !== 'number') throw new KeyEnvelopeError('envelope.v missing or not number');
	if (typeof e.kdf !== 'string') throw new KeyEnvelopeError('envelope.kdf missing');
	if (typeof e.cipher !== 'string') throw new KeyEnvelopeError('envelope.cipher missing');
	if (typeof e.iv !== 'string') throw new KeyEnvelopeError('envelope.iv missing');
	if (typeof e.ct !== 'string') throw new KeyEnvelopeError('envelope.ct missing');
	const kp = e.kdf_params;
	if (typeof kp !== 'object' || kp === null) {
		throw new KeyEnvelopeError('envelope.kdf_params missing or not object');
	}
	const kpo = kp as Record<string, unknown>;
	if (typeof kpo.N !== 'number') throw new KeyEnvelopeError('kdf_params.N missing');
	if (typeof kpo.r !== 'number') throw new KeyEnvelopeError('kdf_params.r missing');
	if (typeof kpo.p !== 'number') throw new KeyEnvelopeError('kdf_params.p missing');
	if (typeof kpo.salt !== 'string') throw new KeyEnvelopeError('kdf_params.salt missing');
	return e as unknown as KeyEnvelope;
}
