/**
 * Morphit chat — local secp256k1 verification of a chain op's signature.
 *
 * Fetches a transaction by id and the named account's posting authority —
 * both through the operator's chain relay (`/v1/chain/condenser`; the browser
 * does not contact Blurt nodes for chat) — and checks locally that the
 * transaction's signatures recover to keys in that authority meeting its
 * threshold (chainOpVerifyCore.ts, kept I/O-free so it can be unit-tested).
 *
 * Because the transaction AND the authority come from the same operator, this
 * catches a wrong or careless indexer answer, not an operator that forges
 * both. Callers must not treat a pass as proof against the operator (see
 * pubPin.ts: a changed chat key still needs the user's confirmation).
 *
 * Only `key_auths` are checked; `account_auths` (delegated authority) are not
 * descended, so an op signed through a delegated posting authority fails —
 * conservative, and rare for the accounts that publish these ops.
 *
 * Cost: one `get_transaction` and one `get_accounts` relay call per
 * verification, on the rare pin-mismatch path only.
 */

import type { AuthorityType, SignedTransaction } from '@beblurt/dblurt';
import { chainRelay } from '$net/chainRelay';

import { verifyTransactionSignatures, type ChainOpVerifyResult } from './chainOpVerifyCore';

export { verifyTransactionSignatures, type ChainOpVerifyResult };

/**
 * Verify locally that the transaction `trxId` was signed by
 * `expectedAccount`'s posting authority.
 *
 * A consistency check against the operator's relay (see the file
 * header for what it does and does not prove).
 *
 * Returns `{ok: true}` only if the cryptographic checks
 * succeed.  Returns `{ok: false}` with a specific code on any
 * failure path.
 *
 * Throws on a relay failure. The caller must treat a thrown error
 * as verification-failed.
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
