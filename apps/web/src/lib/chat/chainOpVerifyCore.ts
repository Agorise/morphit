/**
 * Morphit chat — pure cryptographic verification of a Blurt
 * SignedTransaction against an Authority struct.
 *
 * This module is intentionally I/O-free.  It has no dependency
 * on SvelteKit ($app, $net, $stores, etc.); it consumes a
 * fully-fetched SignedTransaction + AuthorityType, performs
 * the secp256k1 signature recovery and weight-threshold
 * arithmetic, and returns a result.
 *
 * The wrapper that fetches via RPC (`verifyChainOpSignature`)
 * lives in chainOpVerify.ts and depends on the rotator.  The
 * split is to keep the cryptographic core unit-testable under
 * tsx without a SvelteKit-aware module resolver.
 *
 * See chainOpVerify.ts for the design rationale, multi-sig
 * notes, and the trust-vs-defense-in-depth narrative.
 */

import type { Buffer } from 'buffer';
import type { Client, AuthorityType, SignedTransaction } from '@beblurt/dblurt';

// dblurt is imported here as TYPES only (erased at compile time). The
// runtime values (`cryptoUtils`, `Signature`, `DEFAULT_CHAIN_ID` — the
// Blurt mainnet chain id, a module export) are loaded dynamically inside the
// verify function so the dblurt chunk stays off the chat page's first paint;
// verification only runs on the rare pin-mismatch path.

/** Result of a local signature verification. */
export type ChainOpVerifyResult =
	/** Signature(s) verify; the account's posting authority signed
	 *  this transaction.  Cleared at least the weight_threshold. */
	| { readonly ok: true; readonly weightSum: number; readonly threshold: number }
	/** Verification did not clear; weight_sum < threshold or the
	 *  transaction has no recoverable signatures from the named
	 *  account's posting authority. */
	| {
			readonly ok: false;
			readonly code:
				| 'tx_not_found'
				| 'no_account'
				| 'no_signatures'
				| 'weight_below_threshold'
				| 'rpc_error';
			readonly message: string;
	  };

/**
 * Pure verification: given a fetched SignedTransaction and an
 * Authority struct (typically the named account's `posting`),
 * verify that the transaction's signatures clear the
 * authority's weight_threshold.
 *
 * Returns ok=true iff the signatures recover to DISTINCT keys in
 * `authority.key_auths` whose weights sum to at least
 * `authority.weight_threshold`. Each key counts once: a signature
 * listed twice adds nothing (two signatures recovering to two
 * distinct keys, each weight 1, threshold 2, clear together; one
 * key's signature repeated does not). The digest uses the Blurt
 * chain id unless `chainId` is given.
 *
 * The function does NOT descend `account_auths` (delegated
 * authority).  An account whose posting authority delegates to
 * another account's posting key is treated as "no matching
 * key_auth signature found" — conservative but safe.
 *
 * Async because dblurt is loaded on first use.
 */
export async function verifyTransactionSignatures(
	tx: SignedTransaction,
	authority: AuthorityType,
	chainId?: Buffer
): Promise<ChainOpVerifyResult> {
	if (!Array.isArray(tx.signatures) || tx.signatures.length === 0) {
		return { ok: false, code: 'no_signatures', message: 'tx has no signatures' };
	}

	const { cryptoUtils, Signature, DEFAULT_CHAIN_ID } = await import('@beblurt/dblurt');
	type PublicKeyT = import('@beblurt/dblurt').PublicKey;

	let digest: Buffer;
	try {
		digest = cryptoUtils.transactionDigest(tx, chainId ?? DEFAULT_CHAIN_ID);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, code: 'rpc_error', message: `digest_failed: ${message}` };
	}

	// Build a lookup: BLT-prefixed pubkey string → weight.  This
	// is a Map because PublicKey objects don't have stable
	// reference equality across recover() calls.
	const keyToWeight = new Map<string, number>();
	for (const [keyOrString, weight] of authority.key_auths) {
		const keyStr = typeof keyOrString === 'string' ? keyOrString : keyOrString.toString();
		keyToWeight.set(keyStr, weight);
	}

	// Distinct recovered keys only: a repeated signature must not count twice
	// toward the threshold.
	const recoveredKeys = new Set<string>();
	for (const sigStr of tx.signatures) {
		try {
			const sig = Signature.fromString(sigStr);
			const recovered: PublicKeyT = sig.recover(digest);
			recoveredKeys.add(recovered.toString());
		} catch {
			// Malformed signature — skip it.  A real chain-accepted
			// transaction should never have malformed signatures, but
			// a hostile RPC could return one; ignoring it is the
			// conservative move.
			continue;
		}
	}

	let weightSum = 0;
	for (const k of recoveredKeys) weightSum += keyToWeight.get(k) ?? 0;
	const threshold = authority.weight_threshold;
	if (weightSum >= threshold) {
		return { ok: true, weightSum, threshold };
	}
	return {
		ok: false,
		code: 'weight_below_threshold',
		message: `weight_sum=${weightSum} below threshold=${threshold} (recovered: ${[...recoveredKeys].join(', ')})`
	};
}
