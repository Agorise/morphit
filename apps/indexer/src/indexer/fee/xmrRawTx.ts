/**
 * Morphit indexer — verifying an XMR fee from the RAW transaction, locally
 * (v1.20.0, wave 4).
 *
 * Some explorers (moneroblocks.info) serve a transaction's full content but no
 * `txprove` endpoint. With the payer's transaction key r this node checks the
 * payment itself, so such an explorer is a real, independent answer in the
 * quorum — and cannot lie about it:
 *
 * 1. AUTHENTICITY. The served JSON is re-serialised and hashed exactly as
 *    monerod does (cryptonote_format_utils.cpp calculate_transaction_hash:
 *    txid = Keccak(Keccak(prefix) ‖ Keccak(rct base) ‖ Keccak(rct prunable));
 *    field order from cryptonote_basic.h / rctTypes.h serialize_rctsig_base
 *    and serialize_rctsig_prunable). It must equal the txid the payer named,
 *    so every byte below is the chain's, not the explorer's. Checked on a
 *    real mainnet transaction. Only RCT type 6 (BulletproofPlus, every
 *    transaction since the 2022 hard fork) is re-serialised; anything else is
 *    "no answer".
 *
 * 2. WHICH OUTPUTS ARE OURS. For destination (view key A, spend key B) — the
 *    primary address, or a subaddress with ITS view/spend public keys:
 *      D  = 8·r·A                           generate_key_derivation (crypto.cpp)
 *      Hs = Keccak(D ‖ varint(i)) mod l     derivation_to_scalar (crypto.cpp:252)
 *      P  = Hs·G + B                        derive_public_key
 *    Output i is ours iff its one-time key equals P. The 1-byte view tag
 *    Keccak("view_tag" ‖ D ‖ varint(i))[0] (derive_view_tag, crypto.cpp:851)
 *    is only a fast filter.
 *
 * 3. HOW MUCH. amount = ecdhInfo[i] XOR Keccak("amount" ‖ Hs)[0..8]
 *    (rctOps.cpp genAmountEncodingFactor / ecdhDecode, v2 "compact" amounts),
 *    and the commitment must hold:
 *      mask = Keccak("commitment_mask" ‖ Hs) mod l   (genCommitmentMask)
 *      outPk[i] == mask·G + amount·H                  (H: rctTypes.h)
 *    With 1., outPk is the chain's; a decoded amount that does not open it is
 *    refused ('commitment_mismatch') instead of trusted.
 *
 * 4. WHICH ORDER. The encrypted payment IDs in the same extra bytes are
 *    returned for the caller's binding check (xmrPaymentId.ts).
 *
 * Only the MAIN transaction key is used: a fee payment made on its own (one
 * destination + change) never has additional keys — wallet2 adds them only
 * for ≥1 subaddress destination together with another destination
 * (cryptonote_tx_utils.cpp classify_addresses, need_additional_txkeys; change
 * is not counted). Every step is checked against PyPI `monero` in
 * test/indexer/fee/xmrRawTx.test.ts.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';

import { encryptedPaymentIdsFromExtra } from './xmrPaymentId';

/** rctTypes.h `static const key H` — the amount generator of RingCT commitments. */
export const MONERO_H_HEX = '8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94';

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const G = ed25519.ExtendedPoint.BASE;
const H = ed25519.ExtendedPoint.fromHex(MONERO_H_HEX);
const HEX32 = /^[0-9a-f]{64}$/i;
const enc = new TextEncoder();

function fromHex(h: string): Uint8Array {
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
	return out;
}
function toHex(b: Uint8Array): string {
	let s = '';
	for (const x of b) s += x.toString(16).padStart(2, '0');
	return s;
}
function concat(...parts: Uint8Array[]): Uint8Array {
	const n = parts.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
/** Monero varint (tools::write_varint): 7 bits per byte, low first. */
function varint(n: number | bigint): Uint8Array {
	let v = BigInt(n);
	const out: number[] = [];
	for (;;) {
		const b = Number(v & 0x7fn);
		v >>= 7n;
		if (v > 0n) out.push(b | 0x80);
		else {
			out.push(b);
			return Uint8Array.from(out);
		}
	}
}
function leToBig(b: Uint8Array): bigint {
	let n = 0n;
	for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
	return n;
}
/** hash_to_scalar: Keccak-256, reduced mod l (sc_reduce32). */
function hashToScalar(data: Uint8Array): bigint {
	return leToBig(keccak_256(data)) % L;
}
function scalarBytes(s: bigint): Uint8Array {
	const out = new Uint8Array(32);
	let v = s;
	for (let i = 0; i < 32; i++) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}
function mulG(s: bigint): InstanceType<typeof ed25519.ExtendedPoint> {
	return s === 0n ? ed25519.ExtendedPoint.ZERO : G.multiply(s);
}

// ─── 1. txid of the served content ──────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function key32(v: unknown): Uint8Array {
	if (typeof v !== 'string' || !HEX32.test(v)) throw new Error('bad key');
	return fromHex(v.toLowerCase());
}
function uint(v: unknown): bigint {
	if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
	if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v);
	throw new Error('bad uint');
}
function arr(v: unknown): unknown[] {
	if (!Array.isArray(v)) throw new Error('bad array');
	return v;
}

/** monerod's transaction hash of a decoded v2 / RCT-type-6 transaction (the
 *  JSON `get_transaction_data` / `decode_as_json` returns), or null when the
 *  shape is anything else.
 *
 *  (v1.20.2) A PRUNED node returns the transaction without its prunable part
 *  (`rctsig_prunable`: range proofs and ring signatures) and gives that part's
 *  hash instead (`prunable_hash`, monerod get_transaction_prunable_hash). The
 *  txid is still computed exactly: Keccak(H(prefix) ‖ H(rct base) ‖
 *  prunable_hash). If it equals the txid, the prefix and rct base — every
 *  field the payment check reads (outputs, extra, ecdhInfo, outPk) — are the
 *  chain's. Only used when the JSON has no prunable part. */
export function moneroTxHash(tx: unknown, prunableHashHex?: string): string | null {
	try {
		if (!isObj(tx) || tx.version !== 2) return null;
		const prefix: Uint8Array[] = [varint(2), varint(uint(tx.unlock_time))];
		const vin = arr(tx.vin);
		prefix.push(varint(vin.length));
		for (const i of vin) {
			if (!isObj(i) || !isObj(i.key)) return null;
			const k = i.key;
			const offs = arr(k.key_offsets);
			prefix.push(Uint8Array.of(0x02), varint(uint(k.amount)), varint(offs.length));
			for (const o of offs) prefix.push(varint(uint(o)));
			prefix.push(key32(k.k_image));
		}
		const vout = arr(tx.vout);
		prefix.push(varint(vout.length));
		for (const o of vout) {
			if (!isObj(o) || !isObj(o.target)) return null;
			prefix.push(varint(uint(o.amount)));
			const t = o.target;
			if (isObj(t.tagged_key)) {
				const vt = t.tagged_key.view_tag;
				if (typeof vt !== 'string' || !/^[0-9a-f]{2}$/i.test(vt)) return null;
				prefix.push(Uint8Array.of(0x03), key32(t.tagged_key.key), fromHex(vt.toLowerCase()));
			} else if (typeof t.key === 'string') {
				prefix.push(Uint8Array.of(0x02), key32(t.key));
			} else return null;
		}
		const extra = arr(tx.extra).map((x) => {
			if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > 255)
				throw new Error('bad extra');
			return x;
		});
		prefix.push(varint(extra.length), Uint8Array.from(extra));

		const rct = tx.rct_signatures;
		if (!isObj(rct) || rct.type !== 6) return null;
		const ecdh = arr(rct.ecdhInfo);
		const outPk = arr(rct.outPk);
		if (ecdh.length !== vout.length || outPk.length !== vout.length) return null;
		const base: Uint8Array[] = [Uint8Array.of(6), varint(uint(rct.txnFee))];
		for (const e of ecdh) {
			if (!isObj(e) || typeof e.amount !== 'string' || !/^[0-9a-f]{16}$/i.test(e.amount))
				return null;
			base.push(fromHex(e.amount.toLowerCase()));
		}
		for (const k of outPk) base.push(key32(k));

		const pr = tx.rctsig_prunable;
		if (pr === undefined && prunableHashHex !== undefined) {
			if (!HEX32.test(prunableHashHex) || /^0{64}$/.test(prunableHashHex)) return null;
			return toHex(
				keccak_256(
					concat(
						keccak_256(concat(...prefix)),
						keccak_256(concat(...base)),
						fromHex(prunableHashHex.toLowerCase())
					)
				)
			);
		}
		if (!isObj(pr)) return null;
		const bpp = arr(pr.bpp);
		const prunable: Uint8Array[] = [varint(bpp.length)];
		for (const b of bpp) {
			if (!isObj(b)) return null;
			for (const f of ['A', 'A1', 'B', 'r1', 's1', 'd1']) prunable.push(key32(b[f]));
			for (const f of ['L', 'R']) {
				const v = arr(b[f]);
				prunable.push(varint(v.length));
				for (const x of v) prunable.push(key32(x));
			}
		}
		const clsags = arr(pr.CLSAGs);
		if (clsags.length !== vin.length) return null;
		for (const c of clsags) {
			if (!isObj(c)) return null;
			for (const x of arr(c.s)) prunable.push(key32(x)); // no length prefix
			prunable.push(key32(c.c1), key32(c.D));
		}
		const pseudo = arr(pr.pseudoOuts);
		if (pseudo.length !== vin.length) return null;
		for (const x of pseudo) prunable.push(key32(x)); // no length prefix

		return toHex(
			keccak_256(
				concat(
					keccak_256(concat(...prefix)),
					keccak_256(concat(...base)),
					keccak_256(concat(...prunable))
				)
			)
		);
	} catch {
		return null;
	}
}

// ─── 2–4. outputs, amounts, payment IDs ─────────────────────────

export type RawTxScan =
	| {
			/** Indices of outputs paying the destination. */
			readonly outputs: readonly number[];
			/** Their total, piconero (each opened against its commitment). */
			readonly amount: bigint;
			/** Encrypted payment IDs in the extra field (16 hex each). */
			readonly encryptedPaymentIds: readonly string[];
	  }
	| { readonly error: 'malformed' | 'bad_key' | 'commitment_mismatch' };

export function scanRawTxForAddress(
	tx: unknown,
	txKeyHex: string,
	dest: { readonly viewPub: string; readonly spendPub: string }
): RawTxScan {
	if (!/^[0-9a-f]{64}$/i.test(txKeyHex)) return { error: 'bad_key' };
	const r = leToBig(fromHex(txKeyHex.toLowerCase()));
	if (r === 0n || r >= L) return { error: 'bad_key' };
	let A: InstanceType<typeof ed25519.ExtendedPoint>;
	let B: InstanceType<typeof ed25519.ExtendedPoint>;
	try {
		A = ed25519.ExtendedPoint.fromHex(dest.viewPub.toLowerCase());
		B = ed25519.ExtendedPoint.fromHex(dest.spendPub.toLowerCase());
	} catch {
		return { error: 'bad_key' };
	}
	try {
		if (!isObj(tx) || tx.version !== 2) return { error: 'malformed' };
		const vout = arr(tx.vout);
		const rct = tx.rct_signatures;
		if (!isObj(rct)) return { error: 'malformed' };
		const ecdh = arr(rct.ecdhInfo);
		const outPk = arr(rct.outPk);
		if (ecdh.length !== vout.length || outPk.length !== vout.length) return { error: 'malformed' };
		const extraBytes = arr(tx.extra).map((x) => {
			if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > 255)
				throw new Error('bad extra');
			return x;
		});
		const pids = encryptedPaymentIdsFromExtra(toHex(Uint8Array.from(extraBytes))) ?? [];

		const derivation = A.multiply(r).multiply(8n).toRawBytes(); // 8·r·A
		const outputs: number[] = [];
		let amount = 0n;
		for (let i = 0; i < vout.length; i++) {
			const o = vout[i];
			if (!isObj(o) || !isObj(o.target)) return { error: 'malformed' };
			const t = o.target;
			let keyHex: string;
			let viewTag: string | null = null;
			if (isObj(t.tagged_key)) {
				keyHex = String(t.tagged_key.key);
				viewTag =
					typeof t.tagged_key.view_tag === 'string' ? t.tagged_key.view_tag.toLowerCase() : null;
			} else keyHex = String(t.key);
			if (!HEX32.test(keyHex)) return { error: 'malformed' };
			const idx = varint(i);
			if (viewTag !== null) {
				const vt = keccak_256(concat(enc.encode('view_tag'), derivation, idx))[0]!;
				if (vt.toString(16).padStart(2, '0') !== viewTag) continue;
			}
			const hs = hashToScalar(concat(derivation, idx));
			const P = mulG(hs).add(B);
			if (toHex(P.toRawBytes()) !== keyHex.toLowerCase()) continue;
			// ours: open the amount against the chain's commitment
			const e = ecdh[i];
			if (!isObj(e) || typeof e.amount !== 'string' || !/^[0-9a-f]{16}$/i.test(e.amount)) {
				return { error: 'malformed' };
			}
			const hsb = scalarBytes(hs);
			const pad = keccak_256(concat(enc.encode('amount'), hsb));
			const encAmt = fromHex(e.amount.toLowerCase());
			const plain = new Uint8Array(8);
			for (let j = 0; j < 8; j++) plain[j] = encAmt[j]! ^ pad[j]!;
			const amt = leToBig(plain);
			const mask = hashToScalar(concat(enc.encode('commitment_mask'), hsb));
			const C = mulG(mask).add(amt === 0n ? ed25519.ExtendedPoint.ZERO : H.multiply(amt));
			const pk = outPk[i];
			if (typeof pk !== 'string' || toHex(C.toRawBytes()) !== pk.toLowerCase()) {
				return { error: 'commitment_mismatch' };
			}
			outputs.push(i);
			amount += amt;
		}
		return { outputs, amount, encryptedPaymentIds: pids };
	} catch {
		return { error: 'malformed' };
	}
}
