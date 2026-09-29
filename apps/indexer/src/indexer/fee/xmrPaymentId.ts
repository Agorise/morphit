/**
 * Morphit indexer — decrypting the payment ID of a BOUND XMR fee payment
 * (v1.20.0, MK-H2).
 *
 * A Monero wallet paying an integrated address writes the 8-byte payment ID
 * into the transaction's extra field ENCRYPTED (monero-project/monero
 * src/device/device_default.cpp encrypt_payment_id, called from
 * cryptonote_tx_utils.cpp with the destination's view public key and the
 * transaction secret key r):
 *
 *     derivation = 8·(r·A)                (generate_key_derivation, ge_mul8)
 *     mask       = Keccak-256(derivation ‖ 0x8d)[0..8]   (HASH_KEY_ENCRYPTED_PAYMENT_ID)
 *     encrypted  = payment_id XOR mask
 *
 * The payer puts r (the "transaction key" every wallet shows) in the order op,
 * so any indexer can undo the XOR with the treasury's public view key A. The
 * same r is what the explorer's `txprove` uses to prove the amount, so an r
 * that does not belong to the transaction proves nothing and decrypts nothing.
 *
 * Verified against the PyPI `monero` package (libsodium ed25519 + its Keccak):
 * apps/indexer/test/lib/xmrAddress.test.ts.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';

const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function fromHex(h: string): Uint8Array {
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
	return out;
}

function hex(b: Uint8Array): string {
	let s = '';
	for (const x of b) s += x.toString(16).padStart(2, '0');
	return s;
}

/** Monero secret keys are 32-byte little-endian scalars, reduced mod l. */
function scalarFromHex(h: string): bigint | null {
	if (!/^[0-9a-f]{64}$/i.test(h)) return null;
	const b = fromHex(h.toLowerCase());
	let n = 0n;
	for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
	if (n === 0n || n >= L) return null; // sc_check: must be reduced
	return n;
}

/** generate_key_derivation(A, r) = 8·(r·A), compressed, hex. Null when the
 *  key or point is not valid. */
export function xmrKeyDerivation(viewPubHex: string, txKeyHex: string): string | null {
	const r = scalarFromHex(txKeyHex);
	if (r === null || !/^[0-9a-f]{64}$/i.test(viewPubHex)) return null;
	let A;
	try {
		A = ed25519.ExtendedPoint.fromHex(viewPubHex.toLowerCase());
	} catch {
		return null;
	}
	return hex(A.multiply(r).multiply(8n).toRawBytes());
}

/** XOR the encrypted payment ID with Keccak(derivation ‖ 0x8d)[0..8].
 *  The operation is its own inverse (encrypt = decrypt). */
export function xmrDecryptPaymentId(
	viewPubHex: string,
	txKeyHex: string,
	encryptedHex: string
): string | null {
	if (!/^[0-9a-f]{16}$/i.test(encryptedHex)) return null;
	const der = xmrKeyDerivation(viewPubHex, txKeyHex);
	if (der === null) return null;
	const data = new Uint8Array(33);
	data.set(fromHex(der), 0);
	data[32] = 0x8d;
	const mask = keccak_256(data).slice(0, 8);
	const enc = fromHex(encryptedHex.toLowerCase());
	const out = new Uint8Array(8);
	for (let i = 0; i < 8; i++) out[i] = enc[i]! ^ mask[i]!;
	return hex(out);
}

/** The encrypted payment ID as carried in tx extra: a TX_EXTRA_NONCE field
 *  (tag 0x02, length 9) whose data is 0x01 (encrypted-ID marker) + 8 bytes.
 *  Returns every such ID found (normally one), walking the extra fields. */
export function encryptedPaymentIdsFromExtra(extraHex: string): string[] | null {
	if (!/^(?:[0-9a-f]{2})*$/i.test(extraHex)) return null;
	const b = fromHex(extraHex.toLowerCase());
	const found: string[] = [];
	let i = 0;
	const varint = (): number | null => {
		let v = 0;
		let shift = 0;
		while (i < b.length) {
			const x = b[i++]!;
			v |= (x & 0x7f) << shift;
			if ((x & 0x80) === 0) return v;
			shift += 7;
			if (shift > 28) return null;
		}
		return null;
	};
	while (i < b.length) {
		const tag = b[i++]!;
		if (tag === 0x00) continue; // padding
		if (tag === 0x01) {
			i += 32; // tx public key
		} else if (tag === 0x02) {
			const len = varint();
			if (len === null || i + len > b.length) return null;
			if (len === 9 && b[i] === 0x01) found.push(hex(b.slice(i + 1, i + 9)));
			i += len;
		} else if (tag === 0x03 || tag === 0xde) {
			// merge-mining tag / "mysterious minergate": varint length + data
			const len = varint();
			if (len === null) return null;
			i += len;
		} else if (tag === 0x04) {
			const n = varint();
			if (n === null) return null;
			i += 32 * n; // additional tx public keys
		} else {
			// Unknown field: its length is not self-describing, stop here.
			break;
		}
		if (i > b.length) return null;
	}
	return found;
}
