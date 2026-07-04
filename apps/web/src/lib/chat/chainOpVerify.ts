/**
 * Morphit chat — local secp256k1 verification of chain-op
 * signatures (S14, Audit Part 26).
 *
 * Companion to chainVerify.ts, addressing the deferred S14
 * hardening item documented at length in REVISIT-LIST §G.
 *
 *
 * Why this exists
 * ───────────────
 *
 * The chat-identity verifier in chainVerify.ts asks Blurt RPC
 * nodes for the latest `morphit_chat_identity_v1` op that an
 * account has published.  We trust the RPC's word that the op
 * exists in a finalized block — if the chain accepted it, the
 * chain's witnesses must have verified the signature against
 * the account's posting authority.
 *
 * That trust is reasonable given the existing defenses
 * (endpoint rotator, quorum verifier, user-controlled endpoint
 * list).  But a colluding RPC node could fabricate an op that
 * never actually landed in any block, claim it has a real
 * trx_id and block_num that the user can't easily cross-check,
 * and the quorum verifier would only catch this if the user's
 * other endpoints disagree.
 *
 * S14 closes that gap: instead of asking the RPC for op
 * metadata and trusting it, we ask for the full signed
 * transaction by trx_id, reconstruct the canonical message
 * digest the chain validators computed, and verify the
 * signature ourselves against the account's on-chain posting
 * authority.  The bar for forgery rises from "lie about a
 * JSON field" to "produce a secp256k1 signature against a key
 * we don't possess" — i.e., break the underlying crypto.
 *
 *
 * Module split
 * ────────────
 *
 * The pure cryptographic core lives in chainOpVerifyCore.ts so
 * it can be unit-tested under tsx without a SvelteKit-aware
 * module resolver.  This file is the thin wrapper that calls
 * the rotator to fetch the SignedTransaction + posting
 * authority, then delegates to the pure helper.
 *
 *
 * Multi-sig handling
 * ──────────────────
 *
 * Blurt accounts can have multiple posting keys with different
 * weights, requiring a sum of weights to clear the
 * `weight_threshold` for an op to be valid.  `account_auths`
 * (delegations to other accounts' posting keys) ARE permitted
 * in the authority shape but Morphit does not currently
 * descend into delegated authorities — we only verify against
 * direct `key_auths`.  An account that signed a chat_identity
 * op via a delegated posting authority would fail
 * verification here even though the chain accepted it.  This
 * is conservative: a defender unwilling to descend
 * delegation chains rejects ambiguous cases rather than
 * accepting them.  In practice posting-key delegation is rare
 * and uncommon for the kinds of accounts that publish
 * chat-identity ops.
 *
 *
 * Cost
 * ────
 *
 * One extra `get_transaction` RPC plus one `get_accounts` RPC
 * per verification.  The chat-identity verifier is called
 * rarely (only on pin-mismatch paths), so the cost is bounded.
 */

import type { AuthorityType, SignedTransaction } from '@beblurt/dblurt';
import { chainRelay } from '$net/chainRelay';

import { verifyTransactionSignatures, type ChainOpVerifyResult } from './chainOpVerifyCore';

export { verifyTransactionSignatures, type ChainOpVerifyResult };

/**
 * Verify locally that the transaction `trxId` was signed by
 * `expectedAccount`'s posting authority.
 *
 * This is a defense-in-depth verification.  It does NOT replace
 * the chain's own validation — the transaction must already be
 * present in a finalized block for `condenser_api.get_transaction`
 * to return it — but it confirms a hostile RPC didn't fabricate
 * the metadata returned in earlier history walks.
 *
 * Returns `{ok: true}` only if the cryptographic checks
 * succeed.  Returns `{ok: false}` with a specific code on any
 * failure path.
 *
 * Throws on RPC layer failures (all endpoints down) — same
 * contract as fetchLatestChatIdentityFromChain.  The caller
 * must treat a thrown error as verification-failed.
 */
export async function verifyChainOpSignature(
	trxId: string,
	expectedAccount: string
): Promise<ChainOpVerifyResult> {
	if (typeof trxId !== 'string' || trxId.length === 0) {
		return { ok: false, code: 'tx_not_found', message: 'empty trxId' };
	}
	if (typeof expectedAccount !== 'string' || expectedAccount.length === 0) {
		return { ok: false, code: 'no_account', message: 'empty account' };
	}

	// Step 1 — fetch the full signed transaction via the indexer relay. On a
	// relay/chain failure chainRelay throws and the caller treats as
	// verification-failed.
	let tx: SignedTransaction;
	const result = await chainRelay<SignedTransaction>('get_transaction', [trxId]);
	if (!result || typeof result !== 'object') {
		return { ok: false, code: 'tx_not_found', message: 'rpc returned non-object' };
	}
	tx = result;

	// Step 2 — fetch the expected account's posting authority.
	let posting: AuthorityType;
	const accounts = await chainRelay<Array<{ posting?: AuthorityType }>>('get_accounts', [
		[expectedAccount]
	]);
	if (!Array.isArray(accounts) || accounts.length === 0 || !accounts[0]?.posting) {
		return {
			ok: false,
			code: 'no_account',
			message: `account ${expectedAccount} not found or missing posting authority`
		};
	}
	posting = accounts[0].posting;

	// Step 3 — pure cryptographic verification.
	return await verifyTransactionSignatures(tx, posting);
}
