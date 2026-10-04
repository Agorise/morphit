/**
 * Morphit indexer — fee verifier abstraction (ADR-0011 §3, sub-phase 4b).
 *
 * A BTC/XMR order is stored `pending_external` by the order handler; the
 * verifier for its fee_method is run by the re-check job
 * ($indexer/fee/externalFeeRecheck), never inside a block transaction.
 * Each verifier produces one of three outcomes:
 *
 *   - `verified` — we observed the payment on chain and it matches
 *     the expected amount within tolerance; the order goes live.
 *   - `pending_external` — the verifier couldn't reach its data
 *     source (explorer down, RPC timeout). The order stays
 *     `pending_external`; independent attestors can promote it with
 *     `morphit_fee_attest_v1`, and later checks still overrule them.
 *   - `rejected` — the payment doesn't exist, wrong amount, wrong
 *     destination. The order is stored `missing` / `underpaid` and
 *     stays off the book.
 *
 * Verifier implementations:
 *   - `OnChainBlurtFeeVerifier` (4a, already exists inline in
 *     order.ts) — reads sibling transfer ops from the same tx.
 *   - `BitcoinExplorerFeeVerifier` (4b, new) — queries public
 *     Bitcoin block explorers (Blockstream, mempool.space).
 *   - `MoneroProofFeeVerifier` (later+, REPLACES the old
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
 * The verifier is chosen by the order's `fee_method`. Each verifier is stateless and pure-ish (it reads
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
	/** Legacy per-payment Monero OutProof string (later+). Kept on
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
	/** (v1.20.2) How long the order has been waiting for its fee to verify,
	 *  ms (the re-check loop: now − posted). Lets the XMR verifier accept the
	 *  one reachable explorer's answer once an order has waited long enough
	 *  (moneroProofVerifier.ts, "When the quorum cannot be met"). Absent = 0. */
	readonly waitedMs?: number;
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
