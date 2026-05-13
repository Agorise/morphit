#!/usr/bin/env tsx
/**
 * scripts/canary/sign-with-posting-key.ts
 *
 * Standalone helper to sign a canary's sub-content with the
 * operator's BLURT posting key, producing an attestation block
 * that can be verified by anyone who knows the operator's
 * on-chain posting public key.
 *
 * Why this exists alongside the PGP signature:
 *
 *   The PGP signature attests "this canary was signed by the
 *   holder of THIS pgp key" — but the binding from "this PGP key"
 *   to "this Morphit operator" lives off-chain (in /pgp_keys.asc
 *   on the same instance, which the operator could swap at any
 *   time without the chain noticing).  An adversary who has
 *   compromised the operator's web server but NOT their Blurt
 *   posting key cannot forge the on-chain attestation, because
 *   the verifier checks the signature against the posting public
 *   key that's already published in
 *   `morphit_operator_register_v1` on the Blurt chain.  That
 *   chain record is itself signed by the operator's posting key
 *   and can't be changed without it.
 *
 *   So the two signatures complement each other: PGP gives
 *   off-chain readers a familiar verification path; posting-key
 *   gives chain-aware readers a strictly stronger guarantee
 *   tied to the operator's on-chain identity.
 *
 * Inputs:
 *   - WIF-encoded posting private key, via env var
 *     `MORPHIT_CANARY_POSTING_WIF`.  Never accept the key on
 *     argv (would leak via `ps`) or stdin alongside the
 *     payload (would conflate).
 *   - The "sub-content" to sign on stdin: the entire canary
 *     text BEFORE the BEGIN MORPHIT POSTING-KEY ATTESTATION
 *     block, with trailing newlines normalized.  The caller
 *     (generate.sh) is responsible for slicing the right
 *     piece — this helper just signs whatever comes in.
 *
 * Output (3 lines on stdout, in order):
 *   1. account: <operator account string>
 *   2. public_key: <BLT5...-prefixed public key from the WIF>
 *   3. signature: <base64-encoded 65-byte signature>
 *
 *   The 65-byte signature format is dblurt's canonical
 *   `Signature.toBuffer()` output: [recovery + 31] || data[64].
 *   Verifier reconstructs with
 *   `Signature.fromBuffer(Buffer.from(b64, 'base64'))` and then
 *   `.recover(digest)` to compare against the published public
 *   key.  The recovery byte is non-optional — without it,
 *   `fromBuffer()` rejects the 64-byte form and the verify side
 *   has no way to recover a public key for comparison.  Earlier
 *   drafts of this signer emitted just the 64-byte `data` field;
 *   that bug is fixed here by routing through `sig.toBuffer()`.
 *
 * Digest:
 *   sha256(payload).  No domain-separation prefix — the
 *   caller-supplied payload is the entire canary sub-content,
 *   which is already self-describing (it begins with
 *   "-----BEGIN MORPHIT CANARY-----" and contains
 *   "OPERATOR_ACCOUNT: ...").  A future v2 attestation could
 *   add a domain separator if we ever sign anything other than
 *   canary text with the same key.
 */

import { PrivateKey } from '@beblurt/dblurt';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface Args {
	readonly account: string;
}

function parseArgs(): Args {
	const account = process.argv[2];
	if (account === undefined || account.length === 0) {
		throw new Error('usage: sign-with-posting-key.ts <operator-account>');
	}
	// Sanity: Blurt account names are 3-16 chars, lowercase
	// alphanumeric + dashes + dots.  We don't enforce the full
	// regex — just refuse obviously-broken input.
	if (account.length < 3 || account.length > 16) {
		throw new Error(`account name length out of range: ${account!.length}`);
	}
	if (!/^[a-z0-9.-]+$/.test(account)) {
		throw new Error(`account name has invalid characters: ${account}`);
	}
	return { account };
}

function readWifFromEnv(): string {
	const wif = process.env['MORPHIT_CANARY_POSTING_WIF'];
	if (wif === undefined || wif.length === 0) {
		throw new Error(
			'MORPHIT_CANARY_POSTING_WIF env var is required.  This is the ' +
				'WIF-encoded posting private key for the operator account.  ' +
				'It must NOT be passed on argv (would leak via ps) or via stdin ' +
				'(stdin is the payload).'
		);
	}
	// Quick shape check: WIF starts with '5' (uncompressed) or 'K'/'L'
	// (compressed).  Posting keys for Blurt are typically '5J...' or
	// '5K...' length-51.  We don't enforce checksum here — dblurt's
	// `PrivateKey.fromString` does that and throws on mismatch.
	if (wif.length < 50 || wif.length > 53) {
		throw new Error(`MORPHIT_CANARY_POSTING_WIF has unexpected length: ${wif.length}`);
	}
	return wif;
}

function readPayloadFromStdin(): Buffer {
	// Read the entire stdin synchronously.  Canary sub-content is
	// O(few KB), so the simple sync read is fine.  fd 0 is stdin.
	return readFileSync(0);
}

function main(): void {
	const args = parseArgs();
	const wif = readWifFromEnv();
	const payload = readPayloadFromStdin();

	if (payload.length === 0) {
		throw new Error('stdin payload is empty — nothing to sign');
	}

	// Derive the dblurt PrivateKey from WIF.  Throws on bad WIF.
	const privKey = PrivateKey.fromString(wif);

	// Compute the digest.  dblurt's `PrivateKey.sign(message)`
	// expects a 32-byte buffer; sha256 gives us exactly that.
	const digest = createHash('sha256').update(payload).digest();
	if (digest.length !== 32) {
		throw new Error(`sha256 digest unexpected length: ${digest.length}`);
	}

	// Sign.  Result: dblurt Signature with .data (64 bytes) +
	// .recovery (number).
	const sig = privKey.sign(digest);

	// Canonical wire form: 65 bytes via toBuffer() = [recovery+31, data[64]].
	// That's what `Signature.fromBuffer()` expects on the verify side.
	const sigBuf = sig.toBuffer();
	if (sigBuf.length !== 65) {
		throw new Error(
			`Signature.toBuffer() returned ${sigBuf.length} bytes, expected 65 ` +
				'(dblurt protocol invariant violated; refusing to emit a malformed signature)'
		);
	}

	const sigB64 = sigBuf.toString('base64');

	// Derive the public key for the attestation block.  This MUST
	// match what the operator broadcast in
	// `morphit_operator_register_v1`.  If the operator rotated the
	// posting key without re-broadcasting, verifiers will fail —
	// which is the correct behavior.
	const pubKey = privKey.createPublic('BLT'); // BLT-prefixed for Blurt

	process.stdout.write(`account: ${args.account}\n`);
	process.stdout.write(`public_key: ${pubKey.toString()}\n`);
	process.stdout.write(`signature: ${sigB64}\n`);
}

try {
	main();
} catch (err) {
	process.stderr.write(
		`sign-with-posting-key: ${err instanceof Error ? err.message : String(err)}\n`
	);
	process.exit(1);
}
