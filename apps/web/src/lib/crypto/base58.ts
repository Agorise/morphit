/**
 * Morphit — pure base58 (Bitcoin alphabet) decoder.
 *
 * Split from wif.ts so it can be smoke-tested without libsodium in
 * the sandbox.  No crypto, no I/O — just the Bitcoin base58 alphabet
 * and bigint long-division.
 *
 * Used by:
 *   - $crypto/wif (the WIF→scalar decoder, Batch H)
 *
 * If you need a public-key BLT-string encoder later, write its
 * complement (base58Encode) in this file.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP: Record<string, number> = (() => {
	const m: Record<string, number> = {};
	for (let i = 0; i < ALPHABET.length; i++) {
		const ch = ALPHABET.charAt(i);
		m[ch] = i;
	}
	return m;
})();

/** Decode a base58 (Bitcoin alphabet) string to bytes.
 *  Throws if the string contains a character outside the alphabet.
 *  Empty input returns an empty Uint8Array. */
export function base58Decode(s: string): Uint8Array {
	if (s.length === 0) return new Uint8Array(0);
	let zeros = 0;
	while (zeros < s.length && s.charAt(zeros) === '1') zeros++;

	const bytes: number[] = [];
	for (let i = zeros; i < s.length; i++) {
		const ch = s.charAt(i);
		const val = ALPHABET_MAP[ch];
		if (val === undefined) {
			throw new Error('non-base58 character');
		}
		let carry = val;
		for (let j = 0; j < bytes.length; j++) {
			carry += (bytes[j] ?? 0) * 58;
			bytes[j] = carry & 0xff;
			carry >>= 8;
		}
		while (carry > 0) {
			bytes.push(carry & 0xff);
			carry >>= 8;
		}
	}

	const out = new Uint8Array(zeros + bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		out[zeros + bytes.length - 1 - i] = bytes[i] ?? 0;
	}
	return out;
}

/** Encode bytes to a base58 (Bitcoin alphabet) string.  The complement of
 *  base58Decode that the header comment reserved for "later".  Leading
 *  0x00 bytes map to leading '1' characters, per the Bitcoin base58check
 *  convention, so encode∘decode and decode∘encode both round-trip.
 *
 *  Used by the WIF *encoder* (rawPrivateKeyToWif in wif.ts) to render a
 *  private scalar as the "5..."-prefixed WIF that blurtwallet.com and
 *  other Blurt tools accept — i.e. to make a Morphit-created account
 *  portable. No crypto here; just the alphabet + bigint-free long
 *  multiplication (mirror image of base58Decode's long division). */
export function base58Encode(bytes: Uint8Array): string {
	if (bytes.length === 0) return '';
	let zeros = 0;
	while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

	// digits[] accumulates the base-58 representation, least-significant
	// limb first; each input byte multiplies the running value by 256.
	const digits: number[] = [];
	for (let i = zeros; i < bytes.length; i++) {
		let carry = bytes[i] ?? 0;
		for (let j = 0; j < digits.length; j++) {
			carry += (digits[j] ?? 0) * 256;
			digits[j] = carry % 58;
			carry = (carry / 58) | 0;
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}

	let out = '';
	for (let i = 0; i < zeros; i++) out += ALPHABET.charAt(0);
	for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET.charAt(digits[i] ?? 0);
	return out;
}

/** Cheap shape check before invoking the (allocating) base58 decoder.
 *  Bitcoin/Blurt WIFs are 51-52 chars and always start with `5`, `K`, or `L`. */
export function looksLikeWif(s: string): boolean {
	const t = s.trim();
	if (t.length < 50 || t.length > 53) return false;
	if (!'5KL'.includes(t.charAt(0))) return false;
	return true;
}

/**
 * Pure WIF→scalar decode parameterized by a SHA-256 implementation.
 *
 * Splits cleanly from `wif.ts` so the entire decode path (base58 +
 * checksum + version + length checks) can be smoke-tested with a
 * Node `crypto.subtle` SHA-256 in the sandbox, while the production
 * caller wires in libsodium.  The verdict shape is identical to
 * what wif.ts surfaces; wif.ts just translates non-success into
 * a thrown WifDecodeError with a UI-friendly code.
 *
 * Returns either { ok: true, scalar } or { ok: false, code } with
 * the same code values as WifError in wif.ts.
 */
export type WifDecodeVerdict =
	| { ok: true; scalar: Uint8Array }
	| {
			ok: false;
			code:
				| 'too-short'
				| 'too-long'
				| 'bad-charset'
				| 'bad-version'
				| 'bad-checksum'
				| 'bad-length'
				| 'bad-scalar';
	  };

/** Memzero is best-effort here — pure JS can't truly zero a buffer
 *  the GC may have copied, but zeroing what we control reduces the
 *  window where almost-private-keys sit in heap. */
function zero(b: Uint8Array): void {
	for (let i = 0; i < b.length; i++) b[i] = 0;
}

export async function wifDecodePure(
	wif: string,
	sha256: (b: Uint8Array) => Promise<Uint8Array>
): Promise<WifDecodeVerdict> {
	const trimmed = wif.trim();
	if (trimmed.length < 50) return { ok: false, code: 'too-short' };
	if (trimmed.length > 53) return { ok: false, code: 'too-long' };

	let decoded: Uint8Array;
	try {
		decoded = base58Decode(trimmed);
	} catch {
		return { ok: false, code: 'bad-charset' };
	}

	if (decoded.length !== 37 && decoded.length !== 38) {
		return { ok: false, code: 'bad-length' };
	}
	if (decoded[0] !== 0x80) {
		return { ok: false, code: 'bad-version' };
	}

	const payloadLen = decoded.length - 4;
	const payload = decoded.subarray(0, payloadLen);
	const expected = decoded.subarray(payloadLen);
	const h1 = await sha256(payload);
	const h2 = await sha256(h1);
	zero(h1);
	let mismatch = 0;
	for (let i = 0; i < 4; i++) mismatch |= (h2[i] ?? 0) ^ (expected[i] ?? 0);
	zero(h2);
	if (mismatch !== 0) {
		zero(decoded);
		return { ok: false, code: 'bad-checksum' };
	}

	if (decoded.length === 38 && decoded[33] !== 0x01) {
		zero(decoded);
		return { ok: false, code: 'bad-length' };
	}

	const scalar = new Uint8Array(32);
	scalar.set(decoded.subarray(1, 33));
	zero(decoded);

	let allZero = 0;
	for (let i = 0; i < 32; i++) allZero |= scalar[i] ?? 0;
	if (allZero === 0) {
		zero(scalar);
		return { ok: false, code: 'bad-scalar' };
	}

	return { ok: true, scalar };
}
