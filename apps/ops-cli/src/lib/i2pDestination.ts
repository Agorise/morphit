/**
 * i2pDestination — derive the `.b32.i2p` address an i2pd private-key file hosts.
 *
 * WHY THIS EXISTS
 * Importing a privacy-network key was validated only by a length hint, and only
 * for Tor. An I2P key got no check at all, so pasting the wrong file imported
 * silently and the mistake surfaced much later as "peers cannot reach this box"
 * — which is exactly the failure one instance suffered when it advertised an
 * address its own router no longer hosted.
 *
 * A length check would be weak anyway. The strong check is to compute the
 * address the key ACTUALLY produces and show it to the operator, who can compare
 * it against the address they registered. A key that derives to a different
 * address is the wrong key, no matter how plausible its size.
 *
 * FORMAT (i2p private key file, as written by i2pd/Java I2P):
 *   [0..255]    public key (256 bytes, zero-padded for modern types)
 *   [256..383]  signing public key (128 bytes, zero-padded)
 *   [384]       certificate type
 *   [385..386]  certificate payload length (big-endian uint16)
 *   [387..]     certificate payload
 *   …then the private keys, which are NOT part of the destination.
 *
 * The destination is everything up to and including the certificate payload.
 * The address is base32(sha256(destination)) in lowercase, unpadded, 52 chars.
 */
import { createHash } from 'node:crypto';

/** Minimum bytes for a destination with an empty certificate. */
export const I2P_DESTINATION_MIN_BYTES = 387;

/** RFC 4648 base32 alphabet, lowercase, as I2P renders addresses. */
const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Base32-encode without padding, lowercase — I2P's address rendering. */
export function base32Lower(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/** Total bytes of the private key material that follows a destination in a real
 *  i2pd private-key file. Ed25519 destinations carry a 256-byte private key plus
 *  a 32-byte signing private key; older types differ, so this is the FLOOR used
 *  to tell "destination only" from "destination + private half". */
export const I2P_PRIVATE_TAIL_MIN_BYTES = 64;

/** I2P renders base64 with `-` and `~` in place of `+` and `/`. Accept both, so
 *  a key exported by any tool imports without the operator having to convert it. */
export function decodeMaybeBase64(input: Uint8Array): Uint8Array | null {
	const text = Buffer.from(input).toString('utf8').replace(/\s+/g, '');
	if (text.length === 0) return null;
	if (!/^[A-Za-z0-9+/\-~]+={0,2}$/.test(text)) return null;
	try {
		const std = text.replace(/-/g, '+').replace(/~/g, '/');
		const out = Buffer.from(std, 'base64');
		// Buffer.from is lenient; require the round trip to be sane.
		if (out.length < 16) return null;
		return out;
	} catch {
		return null;
	}
}

export interface I2pKeyInspection {
	/** The `.b32.i2p` address this key hosts, or null if the file is not one. */
	readonly address: string | null;
	/** Why it could not be read, for an operator-facing message. */
	readonly problem: string | null;
	/** Total destination length in bytes, when parseable. */
	readonly destinationBytes: number | null;
	/** True when the file carries ONLY the public destination — the address, not
	 *  the key. i2pd cannot host with this; the address would never serve. */
	readonly destinationOnly: boolean;
	/** True when the input arrived base64-encoded and was decoded first. */
	readonly wasBase64: boolean;
}

/**
 * Inspect an i2p private-key file and derive the address it hosts.
 *
 * Never throws: a bad file returns a `problem` string. Import decisions are the
 * caller's; this only reports what the bytes say.
 */
export function inspectI2pKeyFile(input: Uint8Array): I2pKeyInspection {
	// Accept base64 — it is a normal way to hand these around, and refusing it
	// with "decode it first" turns a working key into a support problem. Decode,
	// then judge the BYTES.
	let buf = input;
	let wasBase64 = false;
	const decoded = decodeMaybeBase64(input);
	if (decoded !== null && decoded.length >= I2P_DESTINATION_MIN_BYTES) {
		buf = decoded;
		wasBase64 = true;
	}
	if (buf.length < I2P_DESTINATION_MIN_BYTES) {
		return {
			address: null,
			problem:
				`file is ${buf.length} bytes; an I2P private-key file is at least ` +
				`${I2P_DESTINATION_MIN_BYTES}. This does not look like one.`,
			destinationBytes: null,
			destinationOnly: false,
			wasBase64
		};
	}
	// A key file is binary. A file that is entirely printable text is almost
	// certainly the wrong thing — a base64 export, a config, or a pasted note.
	// Only reject text we could NOT decode as base64 — decoded input is binary by
	// definition, so this now catches genuine mistakes (a pasted note, a config)
	// rather than a perfectly good base64 export.
	if (!wasBase64) {
		let printable = 0;
		for (let i = 0; i < Math.min(buf.length, 256); i++) {
			const c = buf[i]!;
			if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) printable++;
		}
		if (printable === Math.min(buf.length, 256)) {
			return {
				address: null,
				problem:
					'file is printable text that is not valid base64; an I2P key is either ' +
					'binary or a base64 export. This looks like neither.',
				destinationBytes: null,
				destinationOnly: false,
				wasBase64
			};
		}
	}
	const certLen = (buf[385]! << 8) | buf[386]!;
	const destLen = I2P_DESTINATION_MIN_BYTES + certLen;
	if (buf.length < destLen) {
		return {
			address: null,
			problem:
				`the certificate claims ${certLen} bytes, which runs past the end of a ` +
				`${buf.length}-byte file. The file looks truncated or is not an I2P key.`,
			destinationBytes: null,
			destinationOnly: false,
			wasBase64
		};
	}
	const dest = buf.subarray(0, destLen);
	const hash = createHash('sha256').update(dest).digest();
	// DESTINATION ONLY vs a real private key file.
	//
	// A destination is 256 (pub) + 128 (signing pub) + 3 + certLen — 391 bytes
	// for an Ed25519 key certificate. That is your ADDRESS, public, and safe to
	// publish. A private key file carries the private half after it (~663+ bytes
	// total). Feeding a bare destination to i2pd cannot host anything: the router
	// cannot prove ownership, so the address would simply never serve — silently.
	// The byte count settles which one you have, so say it outright.
	const tail = buf.length - destLen;
	return {
		address: `${base32Lower(hash)}.b32.i2p`,
		problem:
			tail < I2P_PRIVATE_TAIL_MIN_BYTES
				? `this is the PUBLIC destination (${buf.length} bytes) — your address, not a ` +
					`private key. i2pd cannot host with it. A private key file carries the ` +
					`private half too: Morphit's installer writes one at 679 bytes ` +
					`(908 base64 characters).`
				: null,
		destinationBytes: destLen,
		destinationOnly: tail < I2P_PRIVATE_TAIL_MIN_BYTES,
		wasBase64
	};
}
