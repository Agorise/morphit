/**
 * Handler: morphit_chat_identity_v1
 *
 * Payload shape:
 *   {
 *     "chat_pub": string (base64-encoded 32-byte X25519 public key)
 *   }
 *
 * Effect: upsert into `chat_identities` for this account. The event
 * log keeps the full history; `chat_identities` keeps the latest.
 *
 * The signer is the account that owns the chat identity being
 * published. The indexer does NOT verify that `chat_pub` matches
 * any particular derivation — it's a client-side convention
 * (ADR-0015 specifies BLAKE2b of the posting priv, but the
 * indexer accepts whatever 32-byte point the signer claims).
 *
 * A signer who publishes a mismatched pubkey hurts only themselves:
 * senders will encrypt to that pubkey, but only whoever knows the
 * corresponding private key can decrypt. The legitimate owner of
 * the account will fail to decrypt their incoming messages and
 * notice immediately. There's no amplification attack vector.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** RFC 7748 §6.1: small-order points on Curve25519's Montgomery
 *  form whose DH output is predictable / zero. A pubkey equal to
 *  any of these represents either gross misconfiguration (a buggy
 *  client published an unfiltered identity-like value) or a
 *  malicious attempt to weaken the chat session.
 *
 *  The set:
 *    1. point-at-infinity (32 zero bytes)
 *    2. the order-1 base of the small subgroup
 *    3. the order-2 / order-4 / order-8 small-subgroup points
 *    4. the same with the high-bit "extra" bit set (X25519
 *       implementations mask bit 255 before scalarmult, so two
 *       inputs produce the same scalarmult output — both forms
 *       are rejected here at the intake layer for clarity)
 *
 *  Hex values per RFC 7748:
 *
 *    00 (×32)  — all-zero
 *    01 (×32)  — would not be encountered in practice but
 *                included by curve25519-dalek, libsodium, etc.
 *    e0 eb 7a 7c 3b 41 b8 ae 16 56 e3 fa f1 9f c4 6a
 *    da 09 8d eb 9c 32 b1 fd 86 62 05 16 5f 49 b8 00
 *    5f 9c 95 bc a3 50 8c 24 b1 d0 b1 55 9c 83 ef 5b
 *    04 44 5c c4 58 1c 8e 86 d8 22 4e dd d0 9f 11 57
 *    + same four with bit 255 set (high-bit ignore quirk)
 *
 *  Equality check is constant-time-friendly here because we're
 *  comparing against a small fixed set, but the input is already
 *  parsed and stored in a Buffer; this is intake-time validation
 *  rather than a critical-path crypto operation, so the standard
 *  byte-by-byte compare is appropriate. */
const LOW_ORDER_X25519_POINTS: ReadonlyArray<Uint8Array> = [
	// Point at infinity — all zeros.
	new Uint8Array(32),
	// Order-1 base.
	new Uint8Array([
		0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
	]),
	// Order-2 (the canonical low-order point per RFC 7748).
	new Uint8Array([
		0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a,
		0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00
	]),
	// Order-4.
	new Uint8Array([
		0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef, 0x5b,
		0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f, 0x11, 0x57
	]),
	// Order-8: prime - 1 == 2^255 - 19 - 1 == ec...ff7f
	new Uint8Array([
		0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f
	]),
	// Same as order-2 / order-4 / order-8 but with bit 255 set:
	// X25519 masks the high bit before scalarmult, so these
	// produce the same DH output as their bit-cleared form.
	// Reject them at intake too for normalization clarity.
	new Uint8Array([
		0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a,
		0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x80
	]),
	new Uint8Array([
		0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef, 0x5b,
		0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f, 0x11, 0xd7
	]),
	new Uint8Array([
		0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff
	])
];

function isLowOrderX25519Point(pub: Uint8Array): boolean {
	if (pub.length !== 32) return false;
	for (const lo of LOW_ORDER_X25519_POINTS) {
		let match = true;
		for (let i = 0; i < 32; i++) {
			if (pub[i] !== lo[i]) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}
	return false;
}

/** Decode a base64 string to a Uint8Array using Node's Buffer.
 *  Returns null on malformed input (rather than throwing) so the
 *  handler can reject cleanly. */
function tryBase64Decode(s: string): Uint8Array | null {
	// Validate first via regex — Buffer.from is lenient and will
	// silently ignore invalid chars / recover from malformed input.
	if (!/^[A-Za-z0-9+/]+=*$/.test(s)) return null;
	try {
		const buf = Buffer.from(s, 'base64');
		// Round-trip check: re-encode and compare to the input.
		// Buffer is lenient — "AAA=" and "AAA==" and "AAA" all
		// decode to the same 2 bytes but only one is canonical.
		// A strict check keeps the on-chain representation
		// deterministic.
		if (buf.toString('base64') !== s) return null;
		return new Uint8Array(buf);
	} catch {
		return null;
	}
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) {
		return { ok: false, reason: 'payload_not_object' };
	}
	const pubB64 = ctx.payload.chat_pub;
	if (typeof pubB64 !== 'string') {
		return { ok: false, reason: 'chat_pub_not_string' };
	}
	// Length bound to prevent accepting gigabyte base64 strings.
	// A 32-byte key encodes to 44 chars with padding; give a small
	// margin for URL-safe variants or future extensions (e.g. a
	// longer key type prefix). 64 is generous.
	if (pubB64.length > 64) {
		return { ok: false, reason: 'chat_pub_too_long' };
	}
	const pubBytes = tryBase64Decode(pubB64);
	if (pubBytes === null) {
		return { ok: false, reason: 'chat_pub_not_base64' };
	}
	if (pubBytes.length !== 32) {
		return { ok: false, reason: 'chat_pub_wrong_length' };
	}

	// All-zero pubkey would represent the point-at-infinity / low-
	// order edge cases of X25519. A legitimate BLAKE2b derivation
	// followed by scalarmult_base will never produce these
	// (cryptographic probability is negligible), so rejecting
	// here guards against a gross misconfiguration or a malicious
	// client publishing a low-order pubkey.
	//
	// The set of small-order points on Curve25519's montgomery
	// form is enumerated in RFC 7748 §6.1 — eight values total,
	// including the all-zero (point at infinity), the identity-
	// like values, and a couple of others that produce predictable
	// DH outputs. We hard-block all of them at intake.
	if (isLowOrderX25519Point(pubBytes)) {
		return { ok: false, reason: 'chat_pub_low_order' };
	}

	// Upsert on account: the signer's latest claim is canonical.
	await client.query(
		`INSERT INTO chat_identities (
			account, chat_pub, source_block_num, source_trx_id, updated_at
		) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (account) DO UPDATE SET
			chat_pub = EXCLUDED.chat_pub,
			source_block_num = EXCLUDED.source_block_num,
			source_trx_id = EXCLUDED.source_trx_id,
			updated_at = EXCLUDED.updated_at`,
		[ctx.signer, Buffer.from(pubBytes), ctx.blockNum, ctx.trxId, ctx.blockTime]
	);

	return { ok: true };
};

export default handle;
