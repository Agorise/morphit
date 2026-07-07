// Basic (non-vanity) Tor v3 onion-service generation.
//
// The setup wizard gives every instance a working .onion by default
// (privacy is the project's first priority).  This generates the address
// AND the three files a Tor daemon needs to actually SERVE it, so the
// advertised onion (footer pill + Onion-Location auto-redirect) is real,
// not a dead pointer.
//
// What it produces, all derived from one fresh ed25519 keypair:
//   - the 56-char v3 address  (`<base32>.onion`),
//   - `hs_ed25519_secret_key` (Tor's 96-byte secret-key file),
//   - `hs_ed25519_public_key` (Tor's 64-byte public-key file),
//   - `hostname`              (the address + newline).
//
// Vanity addresses (choosing the leading letters) are deliberately OUT of
// scope here and in the main menu — they need a separate brute-force tool
// run on the operator's own hardware.  An operator who wants a vanity
// address generates it with `scripts/generate-onion.sh` and pastes it via
// `morphit-ops alt-address`, which (being a manual value) the wizard never
// overwrites.
//
// Algorithm: Tor rend-spec-v3 §6.
//   checksum = SHA3-256(".onion checksum" || PUBKEY || VERSION)[:2]
//   address  = base32(PUBKEY[32] || CHECKSUM[2] || VERSION[1]) + ".onion"
//   VERSION  = 0x03
// The secret-key file stores the *expanded* ed25519 secret key
// (clamp(SHA-512(seed))), which is what Tor's ref10 loader expects.

import { generateKeyPairSync, createHash } from 'node:crypto';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ONION_VERSION = 0x03;
const CHECKSUM_PREFIX = Buffer.from('.onion checksum', 'ascii');

// Tor HS key-file headers: a 29-byte ASCII tag NUL-padded to 32 bytes.
const SECRET_KEY_HEADER = padHeader('== ed25519v1-secret: type0 ==');
const PUBLIC_KEY_HEADER = padHeader('== ed25519v1-public: type0 ==');

function padHeader(tag: string): Buffer {
	const b = Buffer.alloc(32, 0);
	Buffer.from(tag, 'ascii').copy(b);
	return b;
}

/** RFC-4648 base32, lowercase, no padding (Tor's address encoding). */
export function base32Encode(data: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of data) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/** Inverse of base32Encode — used by the self-consistency check. */
export function base32Decode(str: string): Buffer {
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of str) {
		const idx = BASE32_ALPHABET.indexOf(ch);
		if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** Derive the v3 `.onion` address from a 32-byte ed25519 public key. */
export function onionAddressFromPubkey(pubkey: Buffer): string {
	if (pubkey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
	const version = Buffer.from([ONION_VERSION]);
	const checksum = createHash('sha3-256')
		.update(Buffer.concat([CHECKSUM_PREFIX, pubkey, version]))
		.digest()
		.subarray(0, 2);
	return base32Encode(Buffer.concat([pubkey, checksum, version])) + '.onion';
}

/** Decode a v3 `.onion` address back to its pubkey + validate the
 *  embedded checksum and version.  For tests / defensive validation. */
export function decodeOnionAddress(address: string): {
	pubkey: Buffer;
	version: number;
	checksumOk: boolean;
} {
	const body = address.toLowerCase().replace(/\.onion$/, '');
	const raw = base32Decode(body);
	if (raw.length !== 35) throw new Error(`decoded onion is ${raw.length} bytes, expected 35`);
	const pubkey = raw.subarray(0, 32);
	const checksum = raw.subarray(32, 34);
	const version = raw[34] ?? 0;
	const expected = createHash('sha3-256')
		.update(Buffer.concat([CHECKSUM_PREFIX, pubkey, Buffer.from([version])]))
		.digest()
		.subarray(0, 2);
	return { pubkey, version, checksumOk: checksum.equals(expected) };
}

export interface OnionV3 {
	/** `<56 base32 chars>.onion` */
	readonly address: string;
	/** Tor's `hs_ed25519_secret_key` (96 bytes: 32-byte header + 64-byte
	 *  expanded key).  SENSITIVE — install into the HiddenServiceDir 0600. */
	readonly secretKeyFile: Buffer;
	/** Tor's `hs_ed25519_public_key` (64 bytes: 32-byte header + pubkey). */
	readonly publicKeyFile: Buffer;
	/** Tor's `hostname` file content (address + newline). */
	readonly hostnameFile: string;
	/** Raw 32-byte ed25519 public key (for tests). */
	readonly publicKey: Buffer;
}

/** Expand a 32-byte ed25519 seed to Tor's 64-byte secret key:
 *  clamp(SHA-512(seed)) — the lower 32 bytes are the clamped scalar,
 *  the upper 32 bytes the deterministic nonce prefix. */
function expandSeed(seed: Buffer): Buffer {
	const h = createHash('sha512').update(seed).digest(); // 64 bytes
	h[0] = (h[0] ?? 0) & 248;
	h[31] = (h[31] ?? 0) & 127;
	h[31] = (h[31] ?? 0) | 64;
	return h;
}

/** Generate a fresh basic v3 onion service (address + the three Tor HS
 *  files).  Fast: a single keypair, no vanity brute force. */
export function generateOnionV3(): OnionV3 {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	// JWK export gives us the raw 32-byte seed (d) and pubkey (x).
	const jwkPriv = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string };
	const jwkPub = publicKey.export({ format: 'jwk' }) as { x?: string };
	if (!jwkPriv.d || !jwkPub.x) throw new Error('ed25519 key export missing seed/pubkey');
	const seed = Buffer.from(jwkPriv.d, 'base64url');
	const pub = Buffer.from(jwkPub.x, 'base64url');
	if (seed.length !== 32 || pub.length !== 32) {
		throw new Error('ed25519 seed/pubkey must be 32 bytes each');
	}

	const expanded = expandSeed(seed);
	const address = onionAddressFromPubkey(pub);

	return {
		address,
		secretKeyFile: Buffer.concat([SECRET_KEY_HEADER, expanded]),
		publicKeyFile: Buffer.concat([PUBLIC_KEY_HEADER, pub]),
		hostnameFile: address + '\n',
		publicKey: pub
	};
}
