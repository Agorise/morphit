/**
 * Morphit indexer — fee verifier abstraction (ADR-0011 §3, sub-phase 4b).
 *
 * The order handler doesn't care HOW a fee was paid — only whether
 * the payment matches the expected amount. Each fee_method has its
 * own verifier that produces one of three outcomes:
 *
 *   - `verified` — we observed the payment on chain, it matches
 *     the expected amount within tolerance, order is good to go
 *     live immediately.
 *   - `pending_external` — the verifier couldn't reach its data
 *     source (explorer down, RPC timeout). The order lands in
 *     `pending_external` fee_status; the counterparty can submit
 *     a `morphit_fee_attest_v1` to promote it, or it expires.
 *   - `rejected` — the payment doesn't exist, wrong amount, wrong
 *     destination. The order is not indexed as live.
 *
 * Verifier implementations:
 *   - `OnChainBlurtFeeVerifier` (4a, already exists inline in
 *     order.ts) — reads sibling transfer ops from the same tx.
 *   - `BitcoinExplorerFeeVerifier` (4b, new) — queries public
 *     Bitcoin block explorers (Blockstream, mempool.space).
 *   - `MoneroProofFeeVerifier` (Part 108++, REPLACES the old
 *     view-key-based MoneroExplorerFeeVerifier) — verifies a
 *     per-payment tx_proof submitted with the order op.  No
 *     view key required on any indexer.  Uses the explorer's
 *     `prove_tx`-style endpoint or local monerod RPC.
 *   - `AttestationFeeVerifier` (4b, new) — reads
 *     `morphit_fee_attest_v1` ops to promote `pending_external`
 *     orders.
 *
 * The order handler chooses a verifier based on `fee_method` in
 * the payload. Each verifier is stateless and pure-ish (it reads
 * external state but does no writes).
 */

/** What an order claims about its fee payment. */
export interface FeeClaim {
	readonly feeMethod: 'blurt' | 'btc' | 'xmr' | 'waived_first_buy';
	/** Expected amount in the native unit of the fee method:
	 *  - BLURT: BLURT amount as a float
	 *  - BTC:   satoshis as an integer
	 *  - XMR:   piconero as a bigint (Monero smallest unit is 1e-12)
	 *  - waived_first_buy: unused (any value; verifier ignores it) */
	readonly expectedAmount: number | bigint;
	/** The external transaction identifier claimed by the payer.
	 *  For BLURT, this is unused (sibling op is in the same tx).
	 *  For BTC/XMR, this is the txid the payer says landed their
	 *  payment. For waived_first_buy, unused. */
	readonly externalTxId: string | null;
	/** Per-payment Monero proof string (Part 108++).  Required
	 *  when feeMethod='xmr', null otherwise.  The MoneroProofFee-
	 *  Verifier uses this to verify the payment without holding
	 *  the treasury's view key.  Reveals only "this txid paid
	 *  this address this amount" — exactly the public information
	 *  needed for verification, no more.  See
	 *  apps/indexer/src/indexer/fee/moneroProofVerifier.ts. */
	readonly txProof: string | null;
	/** Permlink of the order — used in memos (BLURT) or to derive
	 *  per-order addresses (BTC/XMR if ever supported). */
	readonly permlink: string;
	/** The account that posted the order. Used by some verifiers
	 *  as a cross-check against observed transaction senders. */
	readonly signer: string;
}

/** Result shape a verifier returns. Discriminated by `kind`. */
export type FeeVerifyResult =
	| { readonly kind: 'verified'; readonly observedAmount: number | bigint }
	| { readonly kind: 'pending_external'; readonly reason: string }
	| { readonly kind: 'rejected'; readonly reason: string };

/** Interface every fee verifier implements. Async because some
 *  verifiers make external calls. */
export interface FeeVerifier {
	/** Called by the dispatcher for each order that claims this
	 *  fee method. Must not throw on expected failure paths —
	 *  return `rejected` or `pending_external` instead. A thrown
	 *  exception is treated as a bug and fails the containing
	 *  transaction. */
	verify(claim: FeeClaim): Promise<FeeVerifyResult>;

	/** Short human-readable name for logs. e.g. 'blurt', 'btc',
	 *  'xmr', 'attestation'. */
	readonly name: string;
}
