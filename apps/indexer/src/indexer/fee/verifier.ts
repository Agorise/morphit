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
 *     payment with the payer's transaction key (v1.20.0, M-X1)
 *     submitted with the order op, and — once the treasury primary
 *     address is pinned — its order-bound payment ID (MK-H2).  No
 *     view key required on any indexer.  Uses the explorers'
 *     `/api/outputs?txprove=1` and `/api/transaction/<txid>`.
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
	/** Legacy per-payment Monero OutProof string (Part 108++). Kept on
	 *  the claim for the record only: since v1.20.0 (M-X1) no verifier
	 *  reads it — the explorers cannot check it — and orders that carry
	 *  only this are stored `proof_unsupported` without a verifier call. */
	readonly txProof: string | null;
	/** (v1.20.0, M-X1) XMR: the transaction PRIVATE key (64 hex) the payer
	 *  copied from their wallet. It is what the explorer's txprove mode can
	 *  actually check (an OutProof cannot be checked there). Optional so
	 *  non-XMR claims need not carry it. */
	readonly txKey?: string | null;
	/** (v1.20.0, MK-H2) XMR, only once the treasury primary address is
	 *  pinned: the payment must be to that primary address AND carry, in its
	 *  encrypted payment ID, this order's ID (xmrFeePaymentId). */
	readonly xmrBinding?: {
		readonly primaryAddress: string;
		/** Public view key of primaryAddress, 64 hex. */
		readonly viewPub: string;
		/** Expected payment ID, 16 hex. */
		readonly paymentId: string;
	} | null;
	/** Permlink of the order — used in memos (BLURT) and logs.  (Per-
	 *  order BTC addresses, v1.20.0, are numbered from the event log and
	 *  checked through checkAddressPayment, not through this claim.) */
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

	/** v1.20.0 (MK-H2) — BTC only: has this order's own fee address
	 *  (derived from the pinned treasury xpub) received the amount?
	 *  Present on the explorer-backed BTC verifier; the re-check loop
	 *  skips per-order-address rows when it is absent. */
	checkAddressPayment?(address: string, expectedSats: number): Promise<AddressPaymentResult>;
}

/** v1.20.0 (MK-H2) — outcome of checking a per-order BTC fee address.
 *  `confirmedSats` is the total a quorum of explorers agree the address
 *  received in blocks at least minConfirmations deep; `unconfirmedSats`
 *  is what they see still in the mempool (shown to the payer as "on its
 *  way"). */
export type AddressPaymentResult =
	| { readonly kind: 'paid'; readonly confirmedSats: number; readonly unconfirmedSats: number }
	| { readonly kind: 'not_yet'; readonly confirmedSats: number; readonly unconfirmedSats: number }
	| { readonly kind: 'no_answer'; readonly reason: string };
