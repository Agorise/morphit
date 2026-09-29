/**
 * Morphit — Monero addresses for BOUND XMR listing fees (v1.20.0, MK-H2).
 *
 * Once the release op pins the treasury's PRIMARY Monero address
 * (`treasury.xmr.primary_address`, a `4…` standard address), every XMR fee is
 * paid to an INTEGRATED address: that primary address plus an 8-byte payment
 * ID computed from the order itself,
 *
 *     payment_id = Keccak-256("morphit-fee-v1|" + account + "/" + permlink)[0..8]
 *
 * The sending wallet encrypts that ID into the transaction with the
 * transaction key; the indexer decrypts it with the transaction key the payer
 * puts in the order op (apps/indexer/src/indexer/fee/xmrPaymentId.ts) and
 * accepts the payment only for the order whose ID it carries. A copied txid +
 * key therefore cannot pay for anybody else's order.
 *
 * This module is the part the browser also needs (no elliptic-curve maths):
 * Monero's block-wise base58, address parsing with checksum, the payment ID,
 * and the integrated address. Checked byte-for-byte against the PyPI `monero`
 * package (apps/indexer/test/lib/xmrAddress.test.ts).
 *
 * Constants from monero-project/monero src/cryptonote_config.h: mainnet
 * prefixes 18 (standard), 19 (integrated), 42 (subaddress); testnet 53/54/63;
 * stagenet 24/25/36. Checksum = first 4 bytes of Keccak-256 (cn_fast_hash).
 */
import { keccak_256 } from '@noble/hashes/sha3';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Encoded length of a block of n bytes (n = 0…8), from Monero's base58.cpp. */
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const FULL_BLOCK = 8;
const FULL_ENCODED = 11;

function encodeBlock(block: Uint8Array): string {
	let num = 0n;
	for (const b of block) num = (num << 8n) | BigInt(b);
	const size = ENCODED_BLOCK_SIZES[block.length]!;
	const out = new Array<string>(size).fill(ALPHABET[0]!);
	for (let i = size - 1; i >= 0 && num > 0n; i--) {
		out[i] = ALPHABET[Number(num % 58n)]!;
		num /= 58n;
	}
	return out.join('');
}

function decodeBlock(s: string, byteLen: number): Uint8Array | null {
	let num = 0n;
	for (const ch of s) {
		const v = ALPHABET.indexOf(ch);
		if (v < 0) return null;
		num = num * 58n + BigInt(v);
	}
	if (num >> BigInt(8 * byteLen) !== 0n) return null; // overflow
	const out = new Uint8Array(byteLen);
	for (let i = byteLen - 1; i >= 0; i--) {
		out[i] = Number(num & 0xffn);
		num >>= 8n;
	}
	return out;
}

/** Monero base58 (8-byte blocks → 11 chars; last block per the size table). */
export function moneroBase58Encode(data: Uint8Array): string {
	let s = '';
	for (let i = 0; i < data.length; i += FULL_BLOCK) s += encodeBlock(data.slice(i, i + FULL_BLOCK));
	return s;
}

export function moneroBase58Decode(s: string): Uint8Array | null {
	const full = Math.floor(s.length / FULL_ENCODED);
	const rest = s.length % FULL_ENCODED;
	const restBytes = ENCODED_BLOCK_SIZES.indexOf(rest);
	if (restBytes < 0) return null;
	const out = new Uint8Array(full * FULL_BLOCK + restBytes);
	for (let i = 0; i < full; i++) {
		const b = decodeBlock(s.slice(i * FULL_ENCODED, (i + 1) * FULL_ENCODED), FULL_BLOCK);
		if (b === null) return null;
		out.set(b, i * FULL_BLOCK);
	}
	if (rest > 0) {
		const b = decodeBlock(s.slice(full * FULL_ENCODED), restBytes);
		if (b === null) return null;
		out.set(b, full * FULL_BLOCK);
	}
	return out;
}

type Net = 'mainnet' | 'testnet' | 'stagenet';
type Kind = 'standard' | 'integrated' | 'subaddress';
const PREFIXES: Readonly<Record<number, { net: Net; kind: Kind }>> = {
	18: { net: 'mainnet', kind: 'standard' },
	19: { net: 'mainnet', kind: 'integrated' },
	42: { net: 'mainnet', kind: 'subaddress' },
	53: { net: 'testnet', kind: 'standard' },
	54: { net: 'testnet', kind: 'integrated' },
	63: { net: 'testnet', kind: 'subaddress' },
	24: { net: 'stagenet', kind: 'standard' },
	25: { net: 'stagenet', kind: 'integrated' },
	36: { net: 'stagenet', kind: 'subaddress' }
};

function hex(b: Uint8Array): string {
	let s = '';
	for (const x of b) s += x.toString(16).padStart(2, '0');
	return s;
}

function fromHex(h: string): Uint8Array {
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
	return out;
}

export interface XmrAddressParts {
	readonly net: Net;
	readonly kind: Kind;
	/** Public spend key, 64 hex. */
	readonly spendPub: string;
	/** Public view key, 64 hex. */
	readonly viewPub: string;
	/** Integrated addresses only: the 8-byte payment ID, 16 hex. */
	readonly paymentId?: string;
}

export type XmrAddressError =
	| 'xmr_address_not_string'
	| 'xmr_address_bad_encoding'
	| 'xmr_address_bad_checksum'
	| 'xmr_address_unknown_prefix';

/** Decode any Monero address (all prefixes above are single-byte varints). */
export function parseXmrAddress(
	input: unknown
): { ok: true; value: XmrAddressParts } | { ok: false; reason: XmrAddressError } {
	if (typeof input !== 'string') return { ok: false, reason: 'xmr_address_not_string' };
	const s = input.trim();
	if (s.length !== 95 && s.length !== 106) return { ok: false, reason: 'xmr_address_bad_encoding' };
	const raw = moneroBase58Decode(s);
	if (raw === null) return { ok: false, reason: 'xmr_address_bad_encoding' };
	const body = raw.slice(0, raw.length - 4);
	const sum = keccak_256(body).slice(0, 4);
	for (let i = 0; i < 4; i++) {
		if (raw[raw.length - 4 + i] !== sum[i])
			return { ok: false, reason: 'xmr_address_bad_checksum' };
	}
	const p = PREFIXES[raw[0]!];
	if (p === undefined) return { ok: false, reason: 'xmr_address_unknown_prefix' };
	const expectedLen = p.kind === 'integrated' ? 1 + 64 + 8 + 4 : 1 + 64 + 4;
	if (raw.length !== expectedLen) return { ok: false, reason: 'xmr_address_bad_encoding' };
	return {
		ok: true,
		value: {
			net: p.net,
			kind: p.kind,
			spendPub: hex(raw.slice(1, 33)),
			viewPub: hex(raw.slice(33, 65)),
			...(p.kind === 'integrated' ? { paymentId: hex(raw.slice(65, 73)) } : {})
		}
	};
}

export type XmrPrimaryError =
	| XmrAddressError
	/** An `8…` subaddress: integrated addresses can only be built on the
	 *  wallet's primary address. */
	| 'xmr_primary_is_subaddress'
	/** Already an integrated address. */
	| 'xmr_primary_is_integrated'
	/** testnet / stagenet. */
	| 'xmr_primary_wrong_network';

/** The pinned treasury primary address: mainnet, standard (`4…`), valid. */
export function parseXmrPrimaryAddress(
	input: unknown
):
	| { ok: true; value: XmrAddressParts & { address: string } }
	| { ok: false; reason: XmrPrimaryError } {
	const p = parseXmrAddress(input);
	if (!p.ok) return p;
	if (p.value.net !== 'mainnet') return { ok: false, reason: 'xmr_primary_wrong_network' };
	if (p.value.kind === 'subaddress') return { ok: false, reason: 'xmr_primary_is_subaddress' };
	if (p.value.kind === 'integrated') return { ok: false, reason: 'xmr_primary_is_integrated' };
	return { ok: true, value: { ...p.value, address: (input as string).trim() } };
}

/** The payment ID bound to one order, 16 hex. */
export function xmrFeePaymentId(account: string, permlink: string): string {
	const msg = new TextEncoder().encode(`morphit-fee-v1|${account}/${permlink}`);
	return hex(keccak_256(msg).slice(0, 8));
}

/** The integrated address (prefix 19) for a primary address + payment ID. */
export function xmrIntegratedAddress(primary: string, paymentIdHex: string): string {
	const p = parseXmrPrimaryAddress(primary);
	if (!p.ok) throw new Error(p.reason);
	if (!/^[0-9a-f]{16}$/.test(paymentIdHex)) throw new Error('xmr_payment_id_invalid');
	const body = new Uint8Array(1 + 64 + 8);
	body[0] = 19;
	body.set(fromHex(p.value.spendPub), 1);
	body.set(fromHex(p.value.viewPub), 33);
	body.set(fromHex(paymentIdHex), 65);
	const full = new Uint8Array(body.length + 4);
	full.set(body, 0);
	full.set(keccak_256(body).slice(0, 4), body.length);
	return moneroBase58Encode(full);
}

/** The primary (`4…`) address an integrated address was built on. Throws on
 *  anything that is not a mainnet integrated address. */
export function xmrPrimaryFromIntegrated(integrated: string): {
	primary: string;
	paymentId: string;
} {
	const p = parseXmrAddress(integrated);
	if (!p.ok) throw new Error(p.reason);
	if (
		p.value.net !== 'mainnet' ||
		p.value.kind !== 'integrated' ||
		p.value.paymentId === undefined
	) {
		throw new Error('xmr_address_not_integrated');
	}
	const body = new Uint8Array(1 + 64);
	body[0] = 18;
	body.set(fromHex(p.value.spendPub), 1);
	body.set(fromHex(p.value.viewPub), 33);
	const full = new Uint8Array(body.length + 4);
	full.set(body, 0);
	full.set(keccak_256(body).slice(0, 4), body.length);
	return { primary: moneroBase58Encode(full), paymentId: p.value.paymentId };
}
