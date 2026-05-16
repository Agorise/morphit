/**
 * Morphit relay — posting-key signature verification for the
 * Web Push subscribe endpoint (Part 122 cp14).
 *
 * Closes the cp13 trade-off: cp13 accepted subscriptions with no
 * cryptographic proof of account ownership, on the grounds that
 * the worst case ("an attacker subscribes to alice's account on
 * their own device") only leaked the timing of alice's PUBLIC
 * chain events.  cp14 tightens this: only the holder of alice's
 * posting key can subscribe a device as alice.
 *
 * Wire form: the client adds three fields to the subscribe body
 * when this verification is required:
 *
 *   - `timestamp`     : seconds-since-epoch when the signature
 *                       was produced.  Server rejects when the
 *                       skew exceeds ±5 minutes.
 *   - `signature`     : BLURT-prefix base58 signature over the
 *                       SHA-256 hash of the canonical message.
 *
 * Canonical message — joined by ':' with no surrounding
 * whitespace.  Hashed to a 32-byte SHA-256 digest BEFORE signing
 * (dblurt's PublicKey.verify expects a 32-byte buffer).
 *
 *   morphit:push:subscribe:<account>:<endpoint_sha256_hex>:<timestamp>
 *
 * Including `account` prevents replay against a different
 * account.  Including `endpoint_sha256_hex` (lowercase hex of
 * SHA-256(endpoint) so the canonical string is fixed-length and
 * trivially comparable) binds the signature to one push
 * subscription, so an attacker who captures a signature can't
 * use it to register a DIFFERENT endpoint as alice.  Including
 * `timestamp` bounds the replay window.
 *
 * Trust source: the account's posting public key is fetched from
 * the chain via BlurtClient.getAccount.  For accounts with a
 * multi-key posting authority (multisig), only the FIRST listed
 * key is accepted — Morphit user accounts are single-key in
 * practice, documented limitation.
 */

import { createHash } from 'node:crypto';
import { PublicKey, Signature } from '@beblurt/dblurt';
import type { BlurtClient } from '../blurt/client.ts';
import { logger } from '$log';

const log = logger('relay-push-sig');

/** Maximum acceptable skew between the signature timestamp and
 *  the relay's wall clock.  ±5 minutes is comfortable for legit
 *  clients (NTP-drift, mid-flight tab freeze) and tight enough
 *  that captured signatures expire fast. */
const MAX_SIG_SKEW_SECONDS = 5 * 60;

/** Reasons verification can fail.  Returned as the `reason` of
 *  the error response so the client can surface the right
 *  message in the UI. */
export type SigVerifyError =
	| 'timestamp_out_of_range'
	| 'unknown_account'
	| 'no_posting_key_on_chain'
	| 'malformed_signature'
	| 'signature_mismatch'
	| 'chain_unreachable';

export interface SigVerifyOk {
	readonly ok: true;
}
export interface SigVerifyFail {
	readonly ok: false;
	readonly reason: SigVerifyError;
}
export type SigVerifyResult = SigVerifyOk | SigVerifyFail;

export interface SubscribeSigInputs {
	readonly account: string;
	readonly endpoint: string;
	readonly timestamp: number;
	readonly signatureHex: string;
}

/** Verify a posting-key signature on a subscribe request.
 *  Pure-ish — does one chain query for the account's posting
 *  pubkey; everything else is in-process crypto. */
export async function verifyPushSubscribeSignature(
	blurt: BlurtClient,
	inputs: SubscribeSigInputs,
	nowEpochSec: number
): Promise<SigVerifyResult> {
	// Skew check.  Cheapest gate; runs before any chain query.
	if (
		!Number.isFinite(inputs.timestamp) ||
		Math.abs(nowEpochSec - inputs.timestamp) > MAX_SIG_SKEW_SECONDS
	) {
		return { ok: false, reason: 'timestamp_out_of_range' };
	}

	// Build canonical message.
	const endpointHash = createHash('sha256')
		.update(inputs.endpoint, 'utf-8')
		.digest('hex');
	const canonical = `morphit:push:subscribe:${inputs.account}:${endpointHash}:${inputs.timestamp}`;
	const messageHash = createHash('sha256').update(canonical, 'utf-8').digest();

	// Parse the wire signature.  dblurt's Signature.fromString
	// accepts BLURT-prefix base58 ('SIG_...' or raw hex per the
	// chain protocol).  Any parse error => malformed.
	let sig: Signature;
	try {
		sig = Signature.fromString(inputs.signatureHex);
	} catch {
		return { ok: false, reason: 'malformed_signature' };
	}

	// Look up the account's posting public key from chain.
	let postingPubkey: string | undefined;
	try {
		const acct = await blurt.getAccount(inputs.account);
		if (acct === null) {
			return { ok: false, reason: 'unknown_account' };
		}
		postingPubkey = acct.posting_pubkey;
	} catch (err) {
		log.warn('chain_unreachable_on_sig_verify', {
			account: inputs.account,
			err: String((err as Error)?.message ?? err)
		});
		return { ok: false, reason: 'chain_unreachable' };
	}

	if (!postingPubkey) {
		return { ok: false, reason: 'no_posting_key_on_chain' };
	}

	// Verify.  dblurt's PublicKey.fromString parses BLURT-prefix
	// base58.  PublicKey.verify(hash, sig) → boolean.
	let pubkey: PublicKey;
	try {
		pubkey = PublicKey.fromString(postingPubkey);
	} catch {
		// Chain returned a malformed pubkey — treat as
		// no_posting_key.  Defensive; shouldn't happen for
		// a real account.
		return { ok: false, reason: 'no_posting_key_on_chain' };
	}

	let valid = false;
	try {
		valid = pubkey.verify(messageHash, sig);
	} catch {
		// Verify itself can throw on edge-case malformed
		// signatures the parser accepted but the curve math
		// rejects.  Treat as a mismatch — neutral, neither
		// over- nor under-reporting.
		valid = false;
	}

	if (!valid) {
		return { ok: false, reason: 'signature_mismatch' };
	}
	return { ok: true };
}
