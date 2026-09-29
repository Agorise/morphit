/**
 * Morphit — BTC fee-address derivation from the treasury's pinned account
 * extended PUBLIC key (v1.20.0, MK-H2).
 *
 * WHY. A BTC listing fee used to be a payment to ONE treasury address, claimed
 * by pasting the txid into the order op. Anyone watching that address could
 * paste a victim's txid into their own order first. Now the release op pins
 * the treasury's BIP84 account xpub (`m/84'/0'/0'`), every BTC-fee order gets
 * its own address `m/84'/0'/0'/0/n` at a sequential index n that every indexer
 * computes the same way from chain replay, and a payment only ever counts for
 * the order its address belongs to.
 *
 * ONE implementation, three users: the release validator (web + indexer), the
 * indexer (address of each order) and the browser (derives the same address
 * locally to cross-check its indexer). Byte-for-byte agreement is therefore by
 * construction, not by keeping two copies in step.
 *
 * Pure; no I/O. Crypto: @noble/secp256k1 (point maths), @noble/hashes
 * (SHA-256, SHA-512/HMAC, RIPEMD-160), @scure/base (base58check, bech32) — the
 * audited, dependency-free libraries the frontend already ships. Verified
 * against the BIP84 test vectors and an independent implementation
 * (apps/indexer/test/lib/btcXpub.test.ts).
 *
 * Only PUBLIC derivation exists here. A private extended key (xprv/zprv/…) is
 * refused outright — it must never reach a release op, a repo, or a server.
 */

import { Point, CURVE } from '@noble/secp256k1';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { ripemd160 } from '@noble/hashes/legacy';
import { createBase58check, bech32 } from '@scure/base';

const b58c = createBase58check(sha256);

/** SLIP-132 / BIP32 / BIP49 / BIP84 version bytes we recognise. Only the two
 *  mainnet PUBLIC single-sig forms that describe a native-segwit (BIP84)
 *  account are accepted: `xpub` (generic BIP32 prefix; Sparrow and Bitcoin
 *  Core export it for a wpkh wallet) and `zpub` (the BIP84 prefix; Electrum
 *  and Sparrow's default). Everything else is refused with a reason a human
 *  can act on. */
const VERSIONS: Readonly<
	Record<number, { kind: 'accept' | 'private' | 'testnet' | 'wrong_script'; name: string }>
> = {
	0x0488b21e: { kind: 'accept', name: 'xpub' },
	0x04b24746: { kind: 'accept', name: 'zpub' },
	0x0488ade4: { kind: 'private', name: 'xprv' },
	0x049d7878: { kind: 'private', name: 'yprv' },
	0x04b2430c: { kind: 'private', name: 'zprv' },
	0x0295b005: { kind: 'private', name: 'Yprv' },
	0x02aa7a99: { kind: 'private', name: 'Zprv' },
	0x04358394: { kind: 'private', name: 'tprv' },
	0x044a4e28: { kind: 'private', name: 'uprv' },
	0x045f18bc: { kind: 'private', name: 'vprv' },
	0x024285b5: { kind: 'private', name: 'Uprv' },
	0x02575048: { kind: 'private', name: 'Vprv' },
	0x043587cf: { kind: 'testnet', name: 'tpub' },
	0x044a5262: { kind: 'testnet', name: 'upub' },
	0x045f1cf6: { kind: 'testnet', name: 'vpub' },
	0x024289ef: { kind: 'testnet', name: 'Upub' },
	0x02575483: { kind: 'testnet', name: 'Vpub' },
	0x049d7cb2: { kind: 'wrong_script', name: 'ypub' },
	0x0295b43f: { kind: 'wrong_script', name: 'Ypub' },
	0x02aa7ed3: { kind: 'wrong_script', name: 'Zpub' }
};

const XPUB_VERSION = 0x0488b21e;
const ZPUB_VERSION = 0x04b24746;

/** Highest usable non-hardened child index (BIP32: 0 … 2^31-1). */
export const BTC_FEE_MAX_INDEX = 0x7fffffff;

export type XpubParseError =
	/** Not a string, empty, or longer than any extended key. */
	| 'xpub_not_string'
	/** Not base58check, or the checksum does not match (a typo). */
	| 'xpub_bad_checksum'
	/** Decodes, but is not the 78-byte BIP32 serialization. */
	| 'xpub_bad_length'
	/** A PRIVATE extended key (xprv/zprv/…). Never pin one. */
	| 'xpub_is_private'
	/** A testnet key (tpub/vpub/…). The treasury is mainnet. */
	| 'xpub_testnet'
	/** A nested-segwit (ypub) or multisig (Ypub/Zpub) key — not BIP84. */
	| 'xpub_wrong_script_type'
	/** A version prefix this code does not know. */
	| 'xpub_unknown_version'
	/** Not an ACCOUNT key (depth 3, hardened child, e.g. m/84'/0'/0'). A master
	 *  or address-level key would put the fee addresses on a path no standard
	 *  wallet scans. */
	| 'xpub_not_account_level'
	/** The key bytes are not a valid compressed secp256k1 point. */
	| 'xpub_bad_key';

export interface AccountXpub {
	/** Canonical form, always `xpub…` (version 0x0488B21E). This is what the
	 *  release op carries and what every consumer compares. */
	readonly xpub: string;
	/** The same key with the BIP84 `zpub…` prefix — what Electrum needs to
	 *  create a native-segwit watch-only wallet. */
	readonly zpub: string;
	/** The prefix the input used ('xpub' | 'zpub'). */
	readonly inputPrefix: string;
	readonly depth: number;
	/** BIP32 child number of this key (≥ 2^31: hardened). */
	readonly childNumber: number;
	/** First 4 bytes of HASH160(public key), hex — a short, public id for this
	 *  key, safe to show anywhere (the whole xpub is public on chain anyway). */
	readonly keyId: string;
	readonly publicKey: Uint8Array;
	readonly chainCode: Uint8Array;
}

function readU32(b: Uint8Array, off: number): number {
	return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

function writeU32(b: Uint8Array, off: number, v: number): void {
	b[off] = (v >>> 24) & 0xff;
	b[off + 1] = (v >>> 16) & 0xff;
	b[off + 2] = (v >>> 8) & 0xff;
	b[off + 3] = v & 0xff;
}

function hex(b: Uint8Array): string {
	let s = '';
	for (const x of b) s += x.toString(16).padStart(2, '0');
	return s;
}

function hash160(b: Uint8Array): Uint8Array {
	return ripemd160(sha256(b));
}

/**
 * Parse an account-level BIP84 extended public key, `xpub…` or `zpub…`.
 * Returns the canonical `xpub` form plus the parts derivation needs, or the
 * reason it was refused. Whitespace around the key is ignored (copy-paste).
 */
export function parseAccountXpub(
	input: unknown
): { ok: true; value: AccountXpub } | { ok: false; reason: XpubParseError } {
	if (typeof input !== 'string') return { ok: false, reason: 'xpub_not_string' };
	const s = input.trim();
	// A 78-byte payload + 4-byte checksum is 111-112 base58 chars.
	if (s.length < 100 || s.length > 120) return { ok: false, reason: 'xpub_not_string' };
	let raw: Uint8Array;
	try {
		raw = b58c.decode(s);
	} catch {
		return { ok: false, reason: 'xpub_bad_checksum' };
	}
	if (raw.length !== 78) return { ok: false, reason: 'xpub_bad_length' };
	const version = readU32(raw, 0);
	const known = VERSIONS[version];
	if (known === undefined) return { ok: false, reason: 'xpub_unknown_version' };
	if (known.kind === 'private') return { ok: false, reason: 'xpub_is_private' };
	if (known.kind === 'testnet') return { ok: false, reason: 'xpub_testnet' };
	if (known.kind === 'wrong_script') return { ok: false, reason: 'xpub_wrong_script_type' };
	const depth = raw[4]!;
	const childNumber = readU32(raw, 9);
	// BIP84 account keys sit at m/84'/0'/account' — depth 3, hardened child.
	if (depth !== 3 || childNumber < 0x80000000) {
		return { ok: false, reason: 'xpub_not_account_level' };
	}
	const chainCode = raw.slice(13, 45);
	const publicKey = raw.slice(45, 78);
	if (publicKey[0] !== 0x02 && publicKey[0] !== 0x03) return { ok: false, reason: 'xpub_bad_key' };
	try {
		Point.fromHex(publicKey).assertValidity();
	} catch {
		return { ok: false, reason: 'xpub_bad_key' };
	}
	const asXpub = raw.slice();
	writeU32(asXpub, 0, XPUB_VERSION);
	const asZpub = raw.slice();
	writeU32(asZpub, 0, ZPUB_VERSION);
	return {
		ok: true,
		value: {
			xpub: b58c.encode(asXpub),
			zpub: b58c.encode(asZpub),
			inputPrefix: known.name,
			depth,
			childNumber,
			keyId: hex(hash160(publicKey).slice(0, 4)),
			publicKey,
			chainCode
		}
	};
}

/** BIP32 CKDpub: the non-hardened child `index` of (publicKey, chainCode). */
function ckdPub(
	publicKey: Uint8Array,
	chainCode: Uint8Array,
	index: number
): { publicKey: Uint8Array; chainCode: Uint8Array } {
	const data = new Uint8Array(37);
	data.set(publicKey, 0);
	writeU32(data, 33, index);
	const I = hmac(sha512, chainCode, data);
	const IL = I.slice(0, 32);
	const IR = I.slice(32);
	const il = BigInt(`0x${hex(IL)}`);
	// BIP32: an IL ≥ n or a child at infinity is invalid (probability < 2^-127).
	// Every consumer of this module hits the same case at the same index, so
	// throwing keeps them in agreement; nothing silently skips an index.
	if (il === 0n || il >= CURVE.n) throw new Error('bip32_invalid_child');
	const child = Point.BASE.multiply(il).add(Point.fromHex(publicKey));
	if (child.equals(Point.ZERO)) throw new Error('bip32_invalid_child');
	return { publicKey: child.toRawBytes(true), chainCode: IR };
}

/** The BIP32 serialization (`xpub…`) of the non-hardened child `index` of an
 *  account key. Not used for fee addresses (those go through
 *  deriveBtcFeeAddress); exported so the BIP32 test vectors can check the
 *  child-key maths and serialization directly. */
export function deriveChildXpub(acct: AccountXpub, index: number): string {
	if (!Number.isInteger(index) || index < 0 || index > BTC_FEE_MAX_INDEX) {
		throw new Error('btc_fee_index_out_of_range');
	}
	const child = ckdPub(acct.publicKey, acct.chainCode, index);
	const out = new Uint8Array(78);
	writeU32(out, 0, XPUB_VERSION);
	out[4] = acct.depth + 1;
	out.set(hash160(acct.publicKey).slice(0, 4), 5);
	writeU32(out, 9, index);
	out.set(child.chainCode, 13);
	out.set(child.publicKey, 45);
	return b58c.encode(out);
}

/** Cache of the external chain (m/…/0) per canonical xpub: the second-level
 *  derivation is the only per-order work. Bounded; the treasury has one key. */
const receiveChainCache = new Map<string, { publicKey: Uint8Array; chainCode: Uint8Array }>();

/** P2WPKH (native segwit v0) mainnet address for a compressed public key. */
export function p2wpkhAddress(compressedPubkey: Uint8Array): string {
	const words = bech32.toWords(hash160(compressedPubkey));
	return bech32.encode('bc', [0, ...words]);
}

/**
 * The BTC fee address for order index `index`: the P2WPKH address at
 * `<account>/0/index` — receive chain, exactly what Sparrow / Electrum /
 * Bitcoin Core (`wpkh(xpub/0/*)`) show as receive address #index for this
 * account. Throws on an unparsable xpub or an index outside 0 … 2^31-1.
 */
export function deriveBtcFeeAddress(xpub: string | AccountXpub, index: number): string {
	if (!Number.isInteger(index) || index < 0 || index > BTC_FEE_MAX_INDEX) {
		throw new Error('btc_fee_index_out_of_range');
	}
	let acct: AccountXpub;
	if (typeof xpub === 'string') {
		const parsed = parseAccountXpub(xpub);
		if (!parsed.ok) throw new Error(parsed.reason);
		acct = parsed.value;
	} else {
		acct = xpub;
	}
	let chain = receiveChainCache.get(acct.xpub);
	if (chain === undefined) {
		chain = ckdPub(acct.publicKey, acct.chainCode, 0);
		if (receiveChainCache.size > 16) receiveChainCache.clear();
		receiveChainCache.set(acct.xpub, chain);
	}
	const leaf = ckdPub(chain.publicKey, chain.chainCode, index);
	return p2wpkhAddress(leaf.publicKey);
}
