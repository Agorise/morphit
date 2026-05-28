/**
 * Morphit chat — pure cryptographic verification of a Blurt
 * SignedTransaction against an Authority struct (S14, Audit
 * Part 26).
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

import { Buffer } from 'buffer';
import type {
	Client,
	AuthorityType,
	SignedTransaction
} from '@beblurt/dblurt';

// cp165 byte-budget: dblurt is statically imported here as TYPES
// ONLY (`import type` — erased at compile time, zero runtime cost).
// The runtime values (`cryptoUtils`, `PublicKey`, `Signature`, the
// Client.DEFAULT_CHAIN_ID constant) are pulled via dynamic import
// inside the verify function so the 2 MB dblurt chunk doesn't land
// on the chat page first-paint graph.  This file is reachable from
// chat/chainVerify → chatService + peerPubFetch, both of which load
// on /chat/* routes.  Verification only fires on a rare pin-mismatch
// path, so deferring the load until that path actually triggers is
// a strict improvement.

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

/** Cache for the chain-id buffer.  We resolve it once per
 *  module load via the dblurt default — runtime cost of repeat
 *  resolution is zero, but a let-cache makes it easy to override
 *  in tests if a future audit needs to verify against a custom
 *  chain id. */
let chainIdCache: Buffer | null = null;

async function getChainId(): Promise<Buffer> {
	if (chainIdCache !== null) return chainIdCache;
	// dblurt's DEFAULT_CHAIN_ID is exposed on the Client class.
	// We don't need a working Client instance to read it; the
	// constant is a module-level static.  cp165: dynamic import to
	// keep dblurt out of the first-paint chunk graph.
	const { Client } = await import('@beblurt/dblurt');
	const c = Client as unknown as { DEFAULT_CHAIN_ID: Buffer };
	chainIdCache = c.DEFAULT_CHAIN_ID;
	return chainIdCache;
}

/**
 * Pure verification: given a fetched SignedTransaction and an
 * Authority struct (typically the named account's `posting`),
 * verify that the transaction's signatures clear the
 * authority's weight_threshold.
 *
 * Returns ok=true iff at least one signature recovers to a key
 * in `authority.key_auths` and the sum of matching weights
 * meets or exceeds `authority.weight_threshold`.  Multi-sig
 * works correctly: two signatures recovering to two distinct
 * keys (each weight 1, threshold 2) clear together.
 *
 * The function does NOT descend `account_auths` (delegated
 * authority).  An account whose posting authority delegates to
 * another account's posting key is treated as "no matching
 * key_auth signature found" — conservative but safe.
 *
 * cp165: now async.  dblurt's runtime values (`cryptoUtils`,
 * `Signature`, `PublicKey`) are dynamically imported inside.
 * The only caller (`verifyChainOpSignature` in chainOpVerify.ts)
 * was already async, so this is a transparent refactor.
 */
export async function verifyTransactionSignatures(
	tx: SignedTransaction,
	authority: AuthorityType,
	chainId?: Buffer
): Promise<ChainOpVerifyResult> {
	if (!Array.isArray(tx.signatures) || tx.signatures.length === 0) {
		return { ok: false, code: 'no_signatures', message: 'tx has no signatures' };
	}

	const { cryptoUtils, Signature } = await import('@beblurt/dblurt');
	type PublicKeyT = import('@beblurt/dblurt').PublicKey;

	let digest: Buffer;
	try {
		digest = cryptoUtils.transactionDigest(tx, chainId ?? (await getChainId()));
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

	let weightSum = 0;
	const recoveredKeys: string[] = [];
	for (const sigStr of tx.signatures) {
		try {
			const sig = Signature.fromString(sigStr);
			const recovered: PublicKeyT = sig.recover(digest);
			const recoveredStr = recovered.toString();
			recoveredKeys.push(recoveredStr);
			const w = keyToWeight.get(recoveredStr);
			if (w !== undefined) {
				weightSum += w;
			}
		} catch {
			// Malformed signature — skip it.  A real chain-accepted
			// transaction should never have malformed signatures, but
			// a hostile RPC could return one; ignoring it is the
			// conservative move.
			continue;
		}
	}

	const threshold = authority.weight_threshold;
	if (weightSum >= threshold) {
		return { ok: true, weightSum, threshold };
	}
	return {
		ok: false,
		code: 'weight_below_threshold',
		message: `weight_sum=${weightSum} below threshold=${threshold} (recovered: ${recoveredKeys.join(', ')})`
	};
}
