/**
 * Morphit — @noble/secp256k1-based Blurt transaction signer (opt-in).
 *
 * This is the durable replacement for @beblurt/dblurt's elliptic-based
 * signing, per ADR-0046.  `elliptic` (reached transitively through dblurt's
 * `ecurve` dependency and the `secp256k1` native package's pure-JS fallback)
 * is unmaintained and carries CVE-2025-14505 (an unfixed RFC-6979 nonce
 * mis-truncation flaw, all versions affected).  @noble/secp256k1 is
 * constant-time, actively maintained, and is ALREADY this app's keygen
 * library (ADR-0007).
 *
 * ── Why this is safe to swap ────────────────────────────────────────────
 * Graphene-lineage chains (Blurt / Steem / Hive) verify a signature by
 * RECOVERING the public key from it and checking that key against the
 * operation's required authority.  They do NOT require the specific
 * deterministic signature any particular library emits — any valid CANONICAL
 * ECDSA signature (low-S AND low-R) that recovers to an authorized key is
 * accepted.  So byte-equivalence with dblurt's signature is NOT required and
 * is in fact impossible (dblurt uses a bespoke per-attempt nonce —
 * `sha256(message || attemptByte)` — not standard RFC-6979).  See
 * `scripts/blurt-noble-signer-recovery-proof.ts` (300/300 noble signatures
 * recover to the correct key under dblurt's OWN verifier) and
 * `scripts/blurt-noble-tx-signature-proof.ts` (full-transaction digest path).
 *
 * ── What this module does and does NOT do ───────────────────────────────
 * It signs a 32-byte digest and returns the 65-byte graphene wire-format
 * signature hex.  It does NOT compute the digest itself — the caller passes
 * the digest produced by dblurt's `cryptoUtils.transactionDigest(tx, chainId)`
 * so the serialization + chain-id binding stays dblurt's well-tested code and
 * the ONLY thing that changes versus the dblurt path is which library runs the
 * ECDSA over that identical digest.
 *
 * ── Status ──────────────────────────────────────────────────────────────
 * Wired but NOT the default.  `SIGNER_BACKEND` in `$net/config` selects the
 * backend and defaults to `'dblurt'`.  Flipping it to `'noble'` is gated on a
 * real Blurt chain broadcast confirming end-to-end acceptance, which cannot be
 * done in a code-review sandbox (no chain access).  See ADR-0046 §"cutover".
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';

// RFC-6979 HMAC hook required by @noble/secp256k1 v2's synchronous sign().
// Uses @noble/hashes (already a transitive dep of @noble/secp256k1) so this
// works in the browser bundle without Node's crypto.
secp.etc.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]) =>
	hmac(sha256, key, secp.etc.concatBytes(...msgs));

/**
 * Sign a 32-byte transaction digest, returning the 65-byte graphene
 * wire-format signature as a hex string: [recovery+31] ++ r(32) ++ s(32).
 *
 * Canonical-signature discipline (matches what the chain accepts and what
 * dblurt's `isCanonicalSignature` enforces): re-derive with a bumped RFC-6979
 * extra-entropy counter until BOTH r and s have a clear high bit (graphene's
 * "low-R + low-S" canonical form), with low-S also enforced by noble.
 *
 * @param digest32  the 32-byte digest from cryptoUtils.transactionDigest()
 * @param priv      the 32-byte secp256k1 private scalar
 */
export function signDigestWithNoble(digest32: Uint8Array, priv: Uint8Array): string {
	if (!(digest32 instanceof Uint8Array) || digest32.length !== 32) {
		throw new Error('signDigestWithNoble: digest must be a 32-byte Uint8Array');
	}
	if (!(priv instanceof Uint8Array) || priv.length !== 32) {
		throw new Error('signDigestWithNoble: private key must be a 32-byte Uint8Array');
	}
	for (let nonce = 0; nonce < 1000; nonce++) {
		const opts: { lowS: boolean; extraEntropy?: Uint8Array } = { lowS: true };
		if (nonce > 0) {
			const extra = new Uint8Array(32);
			// little-endian counter in the low 4 bytes (matches the proof harness)
			extra[0] = nonce & 0xff;
			extra[1] = (nonce >>> 8) & 0xff;
			extra[2] = (nonce >>> 16) & 0xff;
			extra[3] = (nonce >>> 24) & 0xff;
			opts.extraEntropy = extra;
		}
		const sig = secp.sign(digest32, priv, opts);
		// toCompactRawBytes(): 64-byte r||s (type-correct, no-arg form).
		const compact = sig.toCompactRawBytes();
		const r0 = compact[0] ?? 0;
		const s0 = compact[32] ?? 0;
		// canonical: high bit of first byte of r and s must be clear (low-R, low-S)
		if ((r0 & 0x80) !== 0 || (s0 & 0x80) !== 0) continue;
		if (sig.recovery === undefined) continue; // recovery bit required for the wire format
		const wire = new Uint8Array(65);
		wire[0] = sig.recovery + 31; // graphene recovery byte: 27 + recid + 4 (compressed)
		wire.set(compact.slice(0, 32), 1);
		wire.set(compact.slice(32, 64), 33);
		// hex encode (noble's helper — browser-safe, no Buffer global needed)
		return secp.etc.bytesToHex(wire);
	}
	throw new Error('signDigestWithNoble: no canonical signature in 1000 iterations (astronomically unlikely)');
}
