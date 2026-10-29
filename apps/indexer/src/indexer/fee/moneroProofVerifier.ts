/**
 * Morphit indexer — Monero fee verifier.
 *
 * Proves an XMR listing-fee payment from public data and the payer's
 * per-payment TRANSACTION KEY r (in the order op since v1.20.0, M-X1). No
 * indexer holds any view key; every indexer verifies every payment on its own.
 *
 * Three kinds of source, one quorum (v1.20.0, wave 4; v1.20.2):
 *   - 'txprove' (`https://…`, or `http://<onion>`): an onion-monero-blockchain-explorer
 *     instance. `/api/outputs?txhash&address&viewkey=<r>&txprove=1` returns
 *     the outputs r proves for the address, with amounts and confirmations;
 *     for a bound fee `/api/transaction/<txid>` gives the encrypted payment
 *     ID (`payment_id8`) and the raw `extra`.
 *   - 'raw-tx' (`raw-tx+https://…`): an explorer that serves the RAW
 *     transaction (moneroblocks.info `/api/get_transaction_data/<txid>`) but
 *     no txprove. This node verifies the payment itself (xmrRawTx.ts): the
 *     served content must hash to the txid, outputs are matched with r, and
 *     every amount is opened against the chain's Pedersen commitment.
 *     Confirmations: the block the tx page links to, checked in the block's
 *     JSON (`/api/get_block_data/<height>`: tx_hashes, depth).
 *   - 'node' (`node+https://…`, v1.20.2): a public Monero node (monerod's
 *     restricted RPC). `POST /get_transactions` (decode_as_json) returns the
 *     same JSON a raw-tx explorer serves, with `confirmations`; it is verified
 *     here exactly the same way. A pruned node's copy lacks the signatures
 *     and comes with `prunable_hash`, which is enough for the txid check
 *     (xmrRawTx.ts moneroTxHash). Only the txid is sent; never the tx key.
 * All kinds reduce to the same answer — (amount proven for the address,
 * payment-ID verdict, confirmations) — and agreeing answers from ANY kind
 * count toward MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES alike.
 *
 * When the quorum cannot be met (v1.20.2). Two agreeing sources are asked
 * for, out of the tier's configured ones (fee/tieredFeeVerifier.ts: the
 * default onion and I2P explorers first, then all nine), fastest first. If only
 * ONE source can be reached for a long time, the payer is not left waiting
 * for days: once the order has waited `loneAnswerAfterMs` (2 h) its answer
 * alone is accepted — but only if the payment is at least
 * `loneAnswerMinConfirmations` (10) blocks deep and NO other source said
 * anything else (not "not found", not a different amount, not a malformed
 * answer). Every other source must simply have been unreachable. Sources
 * that disagree are never settled by one of them: the order waits for more
 * sources, and the disagreement is logged (`xmr_explorers_disagree`).
 *
 * Bound fees (MK-H2): the amount is proven at the pinned PRIMARY address and
 * the encrypted payment ID must decrypt, with the same r, to the order's ID.
 *
 * Defaults: config/xmrExplorers.ts (two onion xmrblocks explorers and one on
 * I2P, then the clearnet fallback). See docs/OPERATIONS.md §40.4.
 *
 * Privacy: the txid and r (both already public in the order op) go to each
 * explorer over Tor (an onion; the network encrypts end to end, on a fresh
 * circuit per request — indexer/sourceFetch.ts) or over HTTPS; only base URLs
 * are logged. Never plain HTTP over the open internet: enforced by the config
 * validator and again at construction.
 */

import type { FeeClaim, FeeVerifier, FeeVerifyResult, PaymentLookupResult } from './verifier';
import { paymentTimeOf } from './verifier';
import { EndpointPool, type EndpointState } from '@morphit/rpc-pool';
import { minAcceptablePiconero, FEE_PRICE_TOLERANCE } from '@morphit/asset-registry';
import { logger } from '../../log/index';
import { encryptedPaymentIdsFromExtra, xmrDecryptPaymentId } from './xmrPaymentId';
import { moneroTxHash, scanRawTxForAddress, XMR_TX_KEYS } from './xmrRawTx';
import { blockTimeOf, explorerInit, privateLogContext, readExplorerJson, readExplorerText } from './explorerHttp';
import { parseXmrAddress } from '@morphit/release-schema';
import { explorerOperatorOf } from '@morphit/operator-config/fee-sources';
import { DEFAULT_XMR_EXPLORERS, parseXmrExplorer, type XmrExplorerKind } from '../../config/xmrExplorers';

const log = logger('xmr-verify');

export interface MoneroProofFeeVerifierConfig {
	/** Destination primary address (public).  This is the value
	 *  the user paid TO; the verifier confirms the proof was
	 *  generated for this exact address. */
	readonly feeAddress: string;
	/** Explorers: `https://…` / `http://<onion>` = an
	 *  onion-monero-blockchain-explorer (txprove); `raw-tx+…` = an explorer
	 *  serving raw transactions (moneroblocks.info API), verified locally;
	 *  `node+…` = a public Monero node, verified locally. */
	readonly explorerUrls: readonly string[];
	/** Minimum confirmations required.  Default 1. */
	readonly minConfirmations: number;
	/** Per-explorer HTTP timeout.  Default 10_000ms. */
	readonly requestTimeoutMs: number;
	/** quorum gate.  Minimum number of explorers that
	 *  must return a successful, agreeing response before the
	 *  verifier promotes to `verified`.  When the bar isn't met
	 *  (degraded outage), the verifier returns `pending_external`
	 *  instead of trusting a single source.  Default 2 (two agreeing
	 *  sources; config resolveXmrQuorum lowers it to the number of
	 *  configured explorers when fewer are set). */
	readonly minSuccessfulResponses: number;
	/** (v1.20.2) How long an order must have waited before ONE reachable
	 *  source's answer is accepted on its own (all others unreachable).
	 *  Default 2 h. The waiting time comes from the claim (`waitedMs`). */
	readonly loneAnswerAfterMs?: number;
	/** (v1.20.2) Depth required for that lone answer. Default 10. */
	readonly loneAnswerMinConfirmations?: number;
	/** The txids and tx keys this verifier is asked about are not public (the
	 *  trade payment check, fee/paymentCheck.ts): its warnings name the
	 *  explorer and status only (explorerHttp.ts privateLogContext). */
	readonly privateLookups?: boolean;
}

/** (v1.20.2) Defaults for the lone-answer rule (see the header). */
export const LONE_ANSWER_AFTER_MS = 2 * 60 * 60 * 1000;
export const LONE_ANSWER_MIN_CONFIRMATIONS = 10;

export { DEFAULT_XMR_EXPLORERS, parseXmrExplorer, type XmrExplorerKind };

export const DEFAULT_MONERO_PROOF_VERIFIER_CONFIG: Omit<
	MoneroProofFeeVerifierConfig,
	'feeAddress'
> = {
	// The same list as MORPHIT_INDEXER_XMR_EXPLORER_URLS' default.
	explorerUrls: [...DEFAULT_XMR_EXPLORERS],
	minConfirmations: 1,
	requestTimeoutMs: 10_000,
	// Two agreeing sources: one explorer's word is not enough.
	minSuccessfulResponses: 2
};

/** Shape of xmrchain.net's /api/outputs response when called with
 *  `txprove=1`.  Other Monero block-explorer instances using the
 *  same `monero-block-explorer` reference codebase use the same
 *  JSON shape. */
interface ExplorerProofResponse {
	/** 'fail': the explorer's own "Cant find tx hash" (page.h json_outputs
	 *  starts every answer as fail); 'error': a bad request or proof. */
	readonly status: 'success' | 'error' | 'fail';
	readonly data?: {
		readonly address: string;
		readonly tx_hash: string;
		/** The "outputs" key in proof-mode contains entries with
		 *  `match: true` for outputs that the proof successfully
		 *  decoded as paying to the given address.  Each entry
		 *  has an amount in piconero. */
		readonly outputs: readonly {
			readonly amount: number | string;
			readonly match: boolean;
		}[];
		/** Confirmation count. */
		readonly tx_confirmations?: number;
		/** Unix seconds: the block's time once mined, the pool's receive time
		 *  before (page.h json_outputs, since 2020-08). */
		readonly tx_timestamp?: number;
	};
}

export class MoneroProofFeeVerifier implements FeeVerifier {
	readonly name = 'xmr-proof';
	private readonly pool: EndpointPool;

	constructor(
		private readonly config: MoneroProofFeeVerifierConfig,
		private readonly fetchImpl: typeof fetch = fetch,
		pool?: EndpointPool
	) {
		if (config.explorerUrls.length === 0) {
			throw new Error('MoneroProofFeeVerifier: at least one explorer URL required');
		}
		// Privacy invariant — every URL must be HTTPS, or plain HTTP to a
		// Tor/I2P hidden service (encrypted end to end by the network). The
		// config validator already rejects anything else; checked again here.
		for (const u of config.explorerUrls) {
			if (parseXmrExplorer(u) === null) {
				throw new Error(
					`MoneroProofFeeVerifier: explorer URL must be https://, or http:// to a .onion / .i2p service (optionally raw-tx+ / node+), got ${u}`
				);
			}
		}
		// Agreement counts OPERATORS, not URLs (feeSources.ts EXPLORER_OPERATORS):
		// one operator's onion, I2P and clearnet addresses are one answer. A
		// tier whose sources are fewer operators than minSuccessfulResponses can
		// then never agree — pending / no answer, never a verdict.
		this.pool =
			pool ?? new EndpointPool({ endpoints: [...config.explorerUrls], operatorOf: explorerOperatorOf });
	}

	/** The address the verifier was constructed with.  Surfaced
	 *  so the poller can detect when a treasury chain-pin updates
	 *  the address and rebuild — see. */
	get currentAddress(): string {
		return this.config.feeAddress;
	}

	/** Expose pool state for `/v1/health?verbose=1` diagnostics. */
	endpointSnapshot(): readonly EndpointState[] {
		return this.pool.snapshot();
	}

	async verify(claim: FeeClaim): Promise<FeeVerifyResult> {
		if (claim.feeMethod !== 'xmr') {
			return {
				kind: 'rejected',
				reason: `MoneroProofFeeVerifier cannot verify fee_method=${claim.feeMethod}`
			};
		}
		if (claim.externalTxId === null || claim.externalTxId.length === 0) {
			return { kind: 'rejected', reason: 'missing_external_tx_id' };
		}
		if (!/^[0-9a-f]{64}$/i.test(claim.externalTxId)) {
			return { kind: 'rejected', reason: 'malformed_tx_id' };
		}
		// (v1.20.0, M-X1) The explorer's txprove mode takes the transaction
		// PRIVATE key in its `viewkey` parameter and parses exactly 64 hex
		// (page.h json_outputs → parse_str_secret_key → parse_hash256). An
		// OutProof string cannot be parsed there, so it is never sent.
		const txKey = claim.txKey ?? null;
		if (txKey === null || txKey.length === 0) {
			return { kind: 'rejected', reason: 'missing_tx_key' };
		}
		if (!/^[0-9a-f]{64}$/i.test(txKey)) {
			return { kind: 'rejected', reason: 'malformed_tx_key' };
		}
		if (typeof claim.expectedAmount !== 'bigint') {
			return {
				kind: 'rejected',
				reason: 'expected_amount_not_bigint_for_xmr'
			};
		}
		// (v1.20.0, MK-H2) Bound fee: amount proven at the pinned PRIMARY
		// address, and the transaction's encrypted payment ID must decrypt
		// (with the same tx key) to this order's ID.
		const binding = claim.xmrBinding ?? null;
		const address = binding !== null ? binding.primaryAddress : this.config.feeAddress;

		const totalUrls = this.config.explorerUrls.length;
		const quorumTimeoutMs = this.config.requestTimeoutMs * 2;
		let notFoundCount = 0;
		/** (v1.20.2) Sources that answered but gave no usable answer (not
		 *  found, malformed, content that did not hash to the txid…). Any one
		 *  of these rules out accepting a lone answer. */
		let unusableAnswers = 0;
		const answeredBy: { base: string; key: string }[] = [];

		/** One explorer's answer, whatever its kind. `confirmations` null =
		 *  that explorer could not say (a raw-tx explorer whose tx page did
		 *  not lead to a block); it then does not vote on depth. */
		type Answer = { sum: bigint; pid: 'match' | 'mismatch' | 'unbound'; confirmations: number | null };
		const pidOf = (enc: string): 'match' | 'mismatch' => {
			if (binding === null || enc === '') return 'mismatch';
			return xmrDecryptPaymentId(binding.viewPub, txKey.toLowerCase(), enc) === binding.paymentId
				? 'match'
				: 'mismatch';
		};
		const quorumResult = await this.pool.quorumCall<Answer>(
			async (spec, signal) => {
				const ex = parseXmrExplorer(spec);
				if (ex === null) return null;
				if (ex.kind === 'raw-tx' || ex.kind === 'node') {
					const r =
						ex.kind === 'raw-tx'
							? await this.rawTxAnswer(ex.base, claim.externalTxId!, address, txKey.toLowerCase(), signal)
							: await this.nodeAnswer(ex.base, claim.externalTxId!, address, txKey.toLowerCase(), signal);
					switch (r.kind) {
						case 'transport_failure':
							throw new Error('transport_failure');
						case 'data_not_found':
							notFoundCount++;
							unusableAnswers++;
							return null;
						case 'data_malformed':
							unusableAnswers++;
							return null;
					}
					const a: Answer = {
						sum: r.amount,
						pid: binding === null ? 'unbound' : pidOf(r.encryptedPaymentIds[0] ?? ''),
						confirmations: r.confirmations
					};
					answeredBy.push({ base: ex.base, key: `${a.sum.toString()}|${a.pid}` });
					return a;
				}
				const base = ex.base;
				const r = await this.fetchProofVerification(
					base,
					claim.externalTxId!,
					address,
					txKey.toLowerCase(),
					signal
				);
				switch (r.kind) {
					case 'transport_failure':
						throw new Error('transport_failure');
					case 'data_not_found':
						notFoundCount++;
						unusableAnswers++;
						return null;
					case 'data_malformed':
						unusableAnswers++;
						return null;
				}
				const sum = this.sumMatchedOutputs(r.body);
				const confirmations = r.body.data?.tx_confirmations ?? 0;
				const answer = (a: Answer): Answer => {
					answeredBy.push({ base, key: `${a.sum.toString()}|${a.pid}` });
					return a;
				};
				if (binding === null) return answer({ sum, pid: 'unbound', confirmations });
				const t = await this.fetchTransaction(base, claim.externalTxId!, signal);
				switch (t.kind) {
					case 'transport_failure':
						throw new Error('transport_failure');
					case 'data_not_found':
						notFoundCount++;
						unusableAnswers++;
						return null;
					case 'data_malformed':
						unusableAnswers++;
						return null;
				}
				if (t.paymentId8 === '') return answer({ sum, pid: 'mismatch', confirmations });
				// Cross-check the explorer's payment_id8 against the raw extra
				// it returned: the ID must be the encrypted-ID nonce in there.
				if (t.extra !== '') {
					const inExtra = encryptedPaymentIdsFromExtra(t.extra);
					if (inExtra === null || !inExtra.includes(t.paymentId8)) {
						this.warn('explorer_payment_id_not_in_extra', { explorer: base });
						unusableAnswers++;
						return null;
					}
				}
				return answer({ sum, pid: pidOf(t.paymentId8), confirmations });
			},
			{
				equivalenceKey: (x) => `${x.sum.toString()}|${x.pid}`,
				minAgree: this.config.minSuccessfulResponses,
				timeoutMs: quorumTimeoutMs
			}
		);

		if (quorumResult.kind === 'no_endpoints') {
			return {
				kind: 'pending_external',
				reason: `all ${totalUrls} explorers in cooldown`
			};
		}

		/** (v1.20.2) Accepting ONE source's answer: see the header. */
		let lone = false;
		if (quorumResult.kind === 'all_responses_in') {
			// A quorum answering "no such tx" is
			// definitive only when nothing usable contradicted it.
			if (
				notFoundCount >= this.config.minSuccessfulResponses &&
				quorumResult.responses.length === 0
			) {
				return {
					kind: 'rejected',
					reason: `tx_not_found: ${notFoundCount} explorer(s) found no such transaction`
				};
			}
			const keys = new Set(answeredBy.map((a) => a.key));
			if (keys.size > 1) {
				log.warn('xmr_explorers_disagree', {
					permlink: claim.permlink,
					answers: answeredBy.map((a) => ({ explorer: a.base, answer: a.key }))
				});
			}
			const loneAfter = this.config.loneAnswerAfterMs ?? LONE_ANSWER_AFTER_MS;
			const waited = claim.waitedMs ?? 0;
			if (
				quorumResult.responses.length === 1 &&
				keys.size === 1 &&
				unusableAnswers === 0 &&
				waited >= loneAfter
			) {
				lone = true;
			} else {
				return {
					kind: 'pending_external',
					reason: `quorum not met: best group had < ${this.config.minSuccessfulResponses} agreeing explorers (${quorumResult.responses.length} usable responses, ${unusableAnswers} unusable, ${quorumResult.cooledDown} in cooldown)`
				};
			}
		}

		const agreedKey = lone
			? `${quorumResult.responses[0]!.sum.toString()}|${quorumResult.responses[0]!.pid}`
			: quorumResult.agreedKey!;
		const [sumStr, pidVerdict] = agreedKey.split('|') as [string, Answer['pid']];
		const successful = quorumResult.responses.filter((x) => `${x.sum.toString()}|${x.pid}` === agreedKey);

		const observed = BigInt(sumStr);
		if (observed === 0n) {
			return { kind: 'rejected', reason: 'tx_key_did_not_prove_any_match' };
		}
		if (pidVerdict === 'mismatch') {
			// A real payment to the treasury, but for another order (or none).
			return { kind: 'rejected', reason: 'payment_id_mismatch' };
		}
		const minPico = minAcceptablePiconero(claim.expectedAmount);
		if (observed < minPico) {
			return {
				kind: 'rejected',
				reason: `underpaid: observed ${observed} piconero, expected ${claim.expectedAmount} (min ${minPico} at ${FEE_PRICE_TOLERANCE * 100}% tolerance)`
			};
		}

		// Depth: the least any agreeing explorer that could say reports.
		const depths = successful.map((x) => x.confirmations).filter((c): c is number => c !== null);
		if (depths.length === 0) {
			return { kind: 'pending_external', reason: 'confirmations unknown (no agreeing explorer reported the block)' };
		}
		const minConfirmedAcross = Math.min(...depths);
		const needDepth = lone
			? Math.max(this.config.minConfirmations, this.config.loneAnswerMinConfirmations ?? LONE_ANSWER_MIN_CONFIRMATIONS)
			: this.config.minConfirmations;
		if (minConfirmedAcross < needDepth) {
			return {
				kind: 'pending_external',
				reason: lone
					? `only one explorer reachable; tx ${minConfirmedAcross} confirmations, need ${needDepth} to accept it alone`
					: `tx only ${minConfirmedAcross} confirmations, need ${needDepth}`
			};
		}
		if (lone) {
			log.info('xmr_fee_accepted_on_one_explorer', {
				permlink: claim.permlink,
				explorer: answeredBy[0]?.base,
				confirmations: minConfirmedAcross,
				waitedMinutes: Math.floor((claim.waitedMs ?? 0) / 60_000),
				contacted: quorumResult.contacted,
				cooledDown: quorumResult.cooledDown
			});
		}

		if (quorumResult.responses.length < quorumResult.contacted) {
			log.info('partial_explorer_agreement', {
				permlink: claim.permlink,
				contacted: quorumResult.contacted,
				cooledDown: quorumResult.cooledDown,
				agreed: successful.length
			});
		}

		return { kind: 'verified', observedAmount: observed };
	}

	/**
	 * A trade payment, by txid and tx key (fee/paymentCheck.ts): how much
	 * `txid` provably pays to `address` (standard, subaddress or integrated),
	 * and how deep it is, as `minSuccessfulResponses` sources agree. Every kind
	 * of source serves the TRANSACTION and this node opens it with the key
	 * (xmrRawTx.ts) — a txprove explorer through its `/api/rawtransaction`
	 * (explorerRawTxAnswer), a raw-tx explorer, a node — so the key and the
	 * seller's address never leave this instance (v1.21.17; a txprove
	 * explorer's `/api/outputs` would need both). No payment ID is asked
	 * about: a trade address is the seller's own.
	 *
	 * `txKey` is what the wallet shows: the main key, or (a transaction with
	 * additional keys — a subaddress among several destinations) the main key
	 * followed by one key per output, 64 hex each (XMR_TX_KEYS).
	 *
	 * The agreement key is the amount (0 when the key proves nothing for the
	 * address). There is no XMR counterpart to BTC's "spends from the address"
	 * rule (bitcoinExplorerVerifier.ts lookupPayment): an input is a ring of
	 * decoys, so nobody can see which address it spends from, and an output is
	 * proven only with the key of the transaction that made it — the buyer
	 * holds the key of their own payment, never of the seller's own spend, so
	 * the seller's change cannot be presented as a payment.
	 *
	 * The depth is the least the agreeing sources allow, never overstated; a
	 * source that cannot tell its depth earns no agreement and another is asked
	 * (one such source must not block every answer), rather than counting as
	 * "0 confirmations" with no block time — which would let an old payment
	 * pass for a fresh one. The block time (json_transaction `timestamp`,
	 * monerod `block_timestamp`, the block header's `timestamp`) comes from
	 * paymentTimeOf over the sources that put it in a block: the earliest when
	 * they agree, none when they cannot both be true (`timeDisputed`), none
	 * when every agreeing source has it in the pool (whose timestamps are
	 * receive times). "Not found" needs a
	 * quorum of sources saying so and no usable answer otherwise; for a
	 * txprove explorer that includes its error answers, which do not tell "no
	 * such transaction" from "this key proves nothing here". A 429, a 5xx, a
	 * timeout or a busy / untrusted node is a transport failure: never an
	 * answer, never "not found". The lone-answer rule is not applied: it is
	 * for an order that has waited hours, and here one source's word is
	 * simply no answer yet.
	 */
	async lookupPayment(
		txid: string,
		address: string,
		txKey: string,
		signal?: AbortSignal
	): Promise<PaymentLookupResult> {
		if (!/^[0-9a-f]{64}$/i.test(txid) || !XMR_TX_KEYS.test(txKey)) return { kind: 'no_answer' };
		const key = txKey.toLowerCase();
		let notFoundCount = 0;
		type Answer = { sum: bigint; confirmations: number; blockTime: number | null };
		const depth = (c: unknown): number | null =>
			typeof c === 'number' && Number.isSafeInteger(c) && c >= 0 ? c : null;
		const quorum = await this.pool.quorumCall<Answer>(
			async (spec, signal) => {
				const ex = parseXmrExplorer(spec);
				if (ex === null) return null;
				// PRIVACY (v1.21.17): a TRADE payment's key never leaves
				// this instance. A txprove explorer is asked for the transaction
				// only (`/api/rawtransaction/<txid>`, explorerRawTxAnswer) and the
				// proof is made here — its `/api/outputs?…&viewkey=<tx key>&txprove=1`
				// would hand a third party the seller's address and a key proving
				// the amount, for a payment the parties keep in their encrypted
				// chat. (A LISTING FEE's key is public on chain; fee verification
				// keeps its own path.)
				const r =
					ex.kind === 'raw-tx'
						? await this.rawTxAnswer(ex.base, txid, address, key, signal)
						: ex.kind === 'node'
							? await this.nodeAnswer(ex.base, txid, address, key, signal)
							: await this.explorerRawTxAnswer(ex.base, txid, address, key, signal);
				switch (r.kind) {
					case 'transport_failure':
						throw new Error('transport_failure');
					case 'data_not_found':
						notFoundCount++;
						return null;
					case 'data_malformed':
						return null;
				}
				// An answer that cannot say how deep the transaction is earns no
				// agreement: another source is asked instead, so one source that
				// leaves the depth out cannot block every answer (v1.21.17).
				const d = depth(r.confirmations);
				if (d === null) return null;
				return { sum: r.amount, confirmations: d, blockTime: r.blockTime };
			},
			{
				equivalenceKey: (a) => a.sum.toString(),
				minAgree: this.config.minSuccessfulResponses,
				timeoutMs: this.config.requestTimeoutMs * 2,
				...(signal !== undefined ? { signal } : {})
			}
		);
		if (quorum.kind === 'no_endpoints') return { kind: 'no_answer' };
		if (quorum.kind === 'all_responses_in') {
			return notFoundCount >= this.config.minSuccessfulResponses && quorum.responses.length === 0
				? { kind: 'not_found' }
				: { kind: 'no_answer' };
		}
		const agreed = quorum.agreedKey!;
		const agreeing = quorum.responses.filter((a) => a.sum.toString() === agreed);
		const confirmations = Math.min(...agreeing.map((a) => a.confirmations));
		// Only a source that puts it in a block gives a block time (in the pool
		// the explorers' timestamps are receive times), and only times the
		// agreeing sources agree on are given (paymentTimeOf).
		const { blockTime, timeDisputed } = paymentTimeOf(
			agreeing.map((a) => ({ inBlock: a.confirmations > 0, time: a.blockTime })),
			Math.floor(Date.now() / 1000)
		);
		return {
			kind: 'found',
			amount: BigInt(agreed),
			confirmations,
			blockTime,
			...(timeDisputed ? { timeDisputed: true } : {})
		};
	}

	/**
	 * A txprove explorer's answer for a tx key WITH additional keys. Its
	 * `/api/outputs` cannot check one: it parses exactly one 64-hex key there
	 * (page.h json_outputs → parse_str_secret_key → parse_hash256), so the
	 * longer form is an `error` answer — which would count as "not found" —
	 * and in prove mode it derives the additional outputs from the
	 * transaction's additional PUBLIC keys and the main key, which proves
	 * nothing. (Its HTML /prove page does take the long form; its JSON API
	 * does not.) So the transaction itself is taken from
	 * `/api/rawtransaction/<txid>` — monerod's JSON of it (json_rawtransaction,
	 * obj_to_json_str) — and verified here exactly like a raw-tx explorer's,
	 * sending only the txid; its depth comes from `/api/transaction/<txid>`
	 * (`confirmations`, 0 in the pool; json_transaction). Read in
	 * moneroexamples/onion-monero-blockchain-explorer, master, 2026-10-26.
	 */
	private async explorerRawTxAnswer(
		base: string,
		txid: string,
		address: string,
		txKey: string,
		poolSignal?: AbortSignal
	): Promise<
		| {
				kind: 'ok';
				amount: bigint;
				encryptedPaymentIds: readonly string[];
				confirmations: number | null;
				/** The source's time for the transaction (unix seconds): the block's
				 *  once mined — in the pool some sources give the receive time, so
				 *  lookupPayment reads it only at depth >= 1. Null when none. */
				blockTime: number | null;
		  }
		| { kind: 'transport_failure' }
		| { kind: 'data_not_found' }
		| { kind: 'data_malformed' }
	> {
		const dest = parseXmrAddress(address);
		if (!dest.ok) return { kind: 'data_malformed' };
		const got = await this.getJsonFrom(`${base}/api/rawtransaction/${txid}`, poolSignal);
		if (got.kind !== 'ok') return got;
		const b = got.body as { status?: unknown; data?: unknown } | null;
		if (b === null || typeof b !== 'object') return { kind: 'data_malformed' };
		// 'fail' is how json_rawtransaction answers "Cant find tx hash".
		if (b.status === 'fail') return { kind: 'data_not_found' };
		if (b.status !== 'success') return { kind: 'data_malformed' };
		if (moneroTxHash(b.data) !== txid.toLowerCase()) {
			this.warn('explorer_tx_content_mismatch', { explorer: base });
			return { kind: 'data_malformed' };
		}
		const scan = scanRawTxForAddress(b.data, txKey, {
			viewPub: dest.value.viewPub,
			spendPub: dest.value.spendPub
		});
		if ('error' in scan) {
			if (scan.error === 'commitment_mismatch') this.warn('explorer_commitment_mismatch', { explorer: base });
			return scan.error === 'bad_key' ? { kind: 'data_not_found' } : { kind: 'data_malformed' };
		}
		let confirmations: number | null = null;
		let blockTime: number | null = null;
		const t = await this.getJsonFrom(`${base}/api/transaction/${txid}`, poolSignal);
		if (t.kind === 'ok') {
			const tb = t.body as {
				status?: unknown;
				data?: { tx_hash?: unknown; confirmations?: unknown; timestamp?: unknown };
			} | null;
			const c = tb?.data?.confirmations;
			if (
				tb?.status === 'success' &&
				typeof tb.data?.tx_hash === 'string' &&
				tb.data.tx_hash.toLowerCase() === txid.toLowerCase() &&
				typeof c === 'number'
			) {
				// lookupPayment's depth() refuses a negative or fractional one.
				confirmations = c;
				// json_transaction's `timestamp`: the block's time once mined, the
				// pool's receive time before — lookupPayment uses a time only when
				// every agreeing source puts the transaction in a block.
				blockTime = blockTimeOf(tb.data.timestamp);
			}
		}
		return {
			kind: 'ok',
			amount: scan.amount,
			encryptedPaymentIds: scan.encryptedPaymentIds,
			confirmations,
			blockTime
		};
	}

	/** log.warn, reduced for a verifier that does private lookups. */
	private warn(event: string, ctx: Record<string, unknown>, err?: unknown): void {
		if (this.config.privateLookups === true) log.warn(event, privateLogContext(ctx, err));
		else log.warn(event, ctx, err);
	}

	/** (wave 4) A raw-tx explorer's answer, verified here (xmrRawTx.ts). */
	private async rawTxAnswer(
		base: string,
		txid: string,
		address: string,
		txKey: string,
		poolSignal?: AbortSignal
	): Promise<
		| {
				kind: 'ok';
				amount: bigint;
				encryptedPaymentIds: readonly string[];
				confirmations: number | null;
				/** The source's time for the transaction (unix seconds): the block's
				 *  once mined — in the pool some sources give the receive time, so
				 *  lookupPayment reads it only at depth >= 1. Null when none. */
				blockTime: number | null;
		  }
		| { kind: 'transport_failure' }
		| { kind: 'data_not_found' }
		| { kind: 'data_malformed' }
	> {
		const dest = parseXmrAddress(address);
		if (!dest.ok) return { kind: 'data_malformed' };
		const got = await this.getJsonFrom(`${base}/api/get_transaction_data/${txid}`, poolSignal);
		if (got.kind !== 'ok') return got;
		const b = got.body as { status?: unknown; error?: unknown; transaction_data?: unknown } | null;
		if (b !== null && typeof b === 'object' && b.status === 'ERROR') {
			return /not found/i.test(String(b.error)) ? { kind: 'data_not_found' } : { kind: 'data_malformed' };
		}
		if (b === null || typeof b !== 'object' || b.status !== 'OK') return { kind: 'data_malformed' };
		// The served content must BE the transaction the payer named.
		if (moneroTxHash(b.transaction_data) !== txid.toLowerCase()) {
			this.warn('explorer_tx_content_mismatch', { explorer: base });
			return { kind: 'data_malformed' };
		}
		const scan = scanRawTxForAddress(b.transaction_data, txKey, {
			viewPub: dest.value.viewPub,
			spendPub: dest.value.spendPub
		});
		if ('error' in scan) {
			if (scan.error === 'commitment_mismatch') this.warn('explorer_commitment_mismatch', { explorer: base });
			return scan.error === 'bad_key' ? { kind: 'data_not_found' } : { kind: 'data_malformed' };
		}
		const { confirmations, blockTime } = await this.rawTxConfirmations(base, txid, poolSignal);
		return {
			kind: 'ok',
			amount: scan.amount,
			encryptedPaymentIds: scan.encryptedPaymentIds,
			confirmations,
			blockTime
		};
	}

	/** (v1.20.2) A public Monero node's answer (monerod restricted RPC),
	 *  verified here like a raw-tx explorer's. monerod's response (see
	 *  core_rpc_server_commands_defs.h COMMAND_RPC_GET_TRANSACTIONS):
	 *  `{status, untrusted, txs: [{tx_hash, as_json, prunable_hash, in_pool,
	 *  confirmations, …}], missed_tx: [txid…]}`; `confirmations` =
	 *  chain height − block height (1 in the top block), 0 in the pool. */
	private async nodeAnswer(
		base: string,
		txid: string,
		address: string,
		txKey: string,
		poolSignal?: AbortSignal
	): Promise<
		| {
				kind: 'ok';
				amount: bigint;
				encryptedPaymentIds: readonly string[];
				confirmations: number | null;
				/** The source's time for the transaction (unix seconds): the block's
				 *  once mined — in the pool some sources give the receive time, so
				 *  lookupPayment reads it only at depth >= 1. Null when none. */
				blockTime: number | null;
		  }
		| { kind: 'transport_failure' }
		| { kind: 'data_not_found' }
		| { kind: 'data_malformed' }
	> {
		const dest = parseXmrAddress(address);
		if (!dest.ok) return { kind: 'data_malformed' };
		const want = txid.toLowerCase();
		const got = await this.postJsonTo(
			`${base}/get_transactions`,
			{ txs_hashes: [want], decode_as_json: true, prune: false },
			poolSignal
		);
		if (got.kind !== 'ok') return got;
		const b = got.body as {
			status?: unknown;
			untrusted?: unknown;
			txs?: unknown;
			missed_tx?: unknown;
		} | null;
		if (b === null || typeof b !== 'object') return { kind: 'data_malformed' };
		// A node still syncing answers from another node ("bootstrap daemon"):
		// not its own word, so no answer from it this time.
		if (b.untrusted === true) return { kind: 'transport_failure' };
		// BUSY, "Too many transactions requested…", "Failed": the node, not the tx.
		if (b.status !== 'OK') return { kind: 'transport_failure' };
		if (
			Array.isArray(b.missed_tx) &&
			b.missed_tx.some((h) => typeof h === 'string' && h.toLowerCase() === want)
		) {
			return { kind: 'data_not_found' };
		}
		let entry: Record<string, unknown> | undefined;
		if (Array.isArray(b.txs)) {
			for (const t of b.txs as unknown[]) {
				if (
					typeof t === 'object' &&
					t !== null &&
					typeof (t as { tx_hash?: unknown }).tx_hash === 'string' &&
					(t as { tx_hash: string }).tx_hash.toLowerCase() === want
				) {
					entry = t as Record<string, unknown>;
					break;
				}
			}
		}
		if (entry === undefined || typeof entry.as_json !== 'string' || entry.as_json === '') {
			return { kind: 'data_malformed' };
		}
		let tx: unknown;
		try {
			tx = JSON.parse(entry.as_json);
		} catch {
			return { kind: 'data_malformed' };
		}
		const prunableHash = typeof entry.prunable_hash === 'string' ? entry.prunable_hash : undefined;
		if (moneroTxHash(tx, prunableHash) !== want) {
			this.warn('explorer_tx_content_mismatch', { explorer: base });
			return { kind: 'data_malformed' };
		}
		const scan = scanRawTxForAddress(tx, txKey, {
			viewPub: dest.value.viewPub,
			spendPub: dest.value.spendPub
		});
		if ('error' in scan) {
			if (scan.error === 'commitment_mismatch') this.warn('explorer_commitment_mismatch', { explorer: base });
			return scan.error === 'bad_key' ? { kind: 'data_not_found' } : { kind: 'data_malformed' };
		}
		let confirmations: number | null;
		if (entry.in_pool === true) confirmations = 0;
		else if (
			typeof entry.confirmations === 'number' &&
			Number.isSafeInteger(entry.confirmations) &&
			entry.confirmations >= 0
		) {
			confirmations = entry.confirmations;
		} else confirmations = null;
		// `block_timestamp`: the block's time, sent only for a mined transaction
		// (core_rpc_server.cpp on_get_transactions).
		const blockTime = blockTimeOf(entry.block_timestamp);
		return {
			kind: 'ok',
			amount: scan.amount,
			encryptedPaymentIds: scan.encryptedPaymentIds,
			confirmations,
			blockTime
		};
	}

	/** (v1.20.2) POST JSON with the verifier's timeout; never follows redirects. */
	private async postJsonTo(
		url: string,
		body: unknown,
		poolSignal?: AbortSignal
	): Promise<{ kind: 'ok'; body: unknown } | { kind: 'transport_failure' } | { kind: 'data_malformed' }> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
		const onPoolAbort = (): void => ac.abort();
		if (poolSignal !== undefined) {
			if (poolSignal.aborted) ac.abort();
			else poolSignal.addEventListener('abort', onPoolAbort, { once: true });
		}
		try {
			const res = await this.fetchImpl(
				url,
				explorerInit(
					{
						method: 'POST',
						accept: 'application/json',
						contentType: 'application/json',
						body: JSON.stringify(body)
					},
					ac.signal
				)
			);
			if (!res.ok) return { kind: 'transport_failure' };
			try {
				return { kind: 'ok', body: await readExplorerJson(res, ac) };
			} catch {
				return { kind: 'data_malformed' };
			}
		} catch (err) {
			this.warn('explorer_fetch_failed', { explorer: new URL(url).origin }, err);
			return { kind: 'transport_failure' };
		} finally {
			clearTimeout(timer);
			if (poolSignal !== undefined) poolSignal.removeEventListener('abort', onPoolAbort);
		}
	}

	/** Depth of `txid` on a raw-tx explorer: its API has no tx → block
	 *  lookup, so the block number comes from the explorer's tx page
	 *  (`/tx/<txid>` links `/block/<height>`), and is then CHECKED in the
	 *  block's JSON: `get_block_data/<height>` must list the txid and gives
	 *  the block's depth (confirmations = depth + 1, as monerod counts). 0 when
	 *  the page names no block (still in the pool); null when it cannot tell.
	 *  `blockTime`: that block's header `timestamp` (monerod get_block, as
	 *  moneroblocks.info serves it), null without a block. */
	private async rawTxConfirmations(
		base: string,
		txid: string,
		poolSignal?: AbortSignal
	): Promise<{ confirmations: number | null; blockTime: number | null }> {
		const unknown = { confirmations: null, blockTime: null };
		let page: string;
		try {
			const res = await this.fetchImpl(
				`${base}/tx/${txid}`,
				explorerInit({ method: 'GET', accept: 'text/html' }, poolSignal ?? null)
			);
			if (!res.ok) return unknown;
			page = await readExplorerText(res);
		} catch {
			return unknown;
		}
		const heights = [...new Set([...page.matchAll(/\/block\/(\d{1,9})(?!\d)/g)].map((m) => Number(m[1])))].slice(0, 3);
		if (heights.length === 0) {
			return /\bconfirmations\b/i.test(page) ? { confirmations: 0, blockTime: null } : unknown;
		}
		for (const h of heights) {
			const got = await this.getJsonFrom(`${base}/api/get_block_data/${h}`, poolSignal);
			if (got.kind !== 'ok') continue;
			const result = (got.body as { block_data?: { result?: Record<string, unknown> } } | null)?.block_data?.result;
			const header = result?.block_header as { height?: unknown; depth?: unknown; timestamp?: unknown } | undefined;
			const hashes = result?.tx_hashes;
			if (
				header?.height === h &&
				typeof header.depth === 'number' &&
				Number.isSafeInteger(header.depth) &&
				header.depth >= 0 &&
				Array.isArray(hashes) &&
				hashes.some((x) => typeof x === 'string' && x.toLowerCase() === txid.toLowerCase())
			) {
				return { confirmations: header.depth + 1, blockTime: blockTimeOf(header.timestamp) };
			}
		}
		return unknown;
	}

	/** GET JSON with the verifier's timeout; never follows redirects. */
	private async getJsonFrom(
		url: string,
		poolSignal?: AbortSignal
	): Promise<{ kind: 'ok'; body: unknown } | { kind: 'transport_failure' } | { kind: 'data_malformed' }> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
		const onPoolAbort = (): void => ac.abort();
		if (poolSignal !== undefined) {
			if (poolSignal.aborted) ac.abort();
			else poolSignal.addEventListener('abort', onPoolAbort, { once: true });
		}
		try {
			const res = await this.fetchImpl(
				url,
				explorerInit({ method: 'GET', accept: 'application/json' }, ac.signal)
			);
			if (!res.ok) return { kind: 'transport_failure' };
			try {
				return { kind: 'ok', body: await readExplorerJson(res, ac) };
			} catch {
				return { kind: 'data_malformed' };
			}
		} catch (err) {
			this.warn('explorer_fetch_failed', { explorer: new URL(url).origin }, err);
			return { kind: 'transport_failure' };
		} finally {
			clearTimeout(timer);
			if (poolSignal !== undefined) poolSignal.removeEventListener('abort', onPoolAbort);
		}
	}

	/** (v1.20.0, MK-H2) GET /api/transaction/<txid>: the RAW encrypted
	 *  payment ID (`payment_id8`, 16 hex, or '' when the tx has none) and the
	 *  tx extra hex, per page.h get_tx_json. */
	private async fetchTransaction(
		baseUrl: string,
		txid: string,
		poolSignal?: AbortSignal
	): Promise<
		| { kind: 'ok'; paymentId8: string; extra: string }
		| { kind: 'transport_failure' }
		| { kind: 'data_not_found' }
		| { kind: 'data_malformed' }
	> {
		const url = `${baseUrl.replace(/\/+$/, '')}/api/transaction/${txid}`;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
		const onPoolAbort = (): void => ac.abort();
		if (poolSignal !== undefined) {
			if (poolSignal.aborted) ac.abort();
			else poolSignal.addEventListener('abort', onPoolAbort, { once: true });
		}
		try {
			const res = await this.fetchImpl(
				url,
				explorerInit({ method: 'GET', accept: 'application/json' }, ac.signal)
			);
			// (v1.21.15 review) The explorer software (onion-monero-blockchain-
			// explorer) never answers 404 for a transaction — an unknown one is a
			// JSON error below. A 404 is a route it does not serve (its JSON API
			// off) or a page in front of it: no verdict on the transaction.
			if (res.status === 404) return { kind: 'data_malformed' };
			if (!res.ok) return { kind: 'transport_failure' };
			let body: unknown;
			try {
				body = await readExplorerJson(res, ac);
			} catch {
				return { kind: 'data_malformed' };
			}
			if (typeof body !== 'object' || body === null) return { kind: 'data_malformed' };
			const b = body as { status?: unknown; data?: Record<string, unknown> };
			if (b.status !== 'success') return { kind: 'data_not_found' };
			const d = b.data;
			if (typeof d !== 'object' || d === null) return { kind: 'data_malformed' };
			if (typeof d.tx_hash !== 'string' || d.tx_hash.toLowerCase() !== txid.toLowerCase()) {
				return { kind: 'data_malformed' };
			}
			const pid8 = typeof d.payment_id8 === 'string' ? d.payment_id8.toLowerCase() : '';
			if (pid8 !== '' && !/^[0-9a-f]{16}$/.test(pid8)) return { kind: 'data_malformed' };
			const extra = typeof d.extra === 'string' ? d.extra.toLowerCase() : '';
			return { kind: 'ok', paymentId8: pid8, extra };
		} catch (err) {
			this.warn('explorer_fetch_failed', { explorer: baseUrl, txid }, err);
			return { kind: 'transport_failure' };
		} finally {
			clearTimeout(timer);
			if (poolSignal !== undefined) poolSignal.removeEventListener('abort', onPoolAbort);
		}
	}

	private async fetchProofVerification(
		baseUrl: string,
		txid: string,
		address: string,
		txKey: string,
		poolSignal?: AbortSignal
	): Promise<
		| { kind: 'ok'; body: ExplorerProofResponse }
		| { kind: 'transport_failure' }
		| { kind: 'data_not_found' }
		| { kind: 'data_malformed' }
	> {
		// xmrchain endpoint with proof-mode:
		//   /api/outputs?txhash={txid}&address={addr}&viewkey={proof}&txprove=1
		//
		// In prove mode (`txprove=1`) the `viewkey` query parameter
		// carries the transaction PRIVATE key r (v1.20.0, M-X1: the
		// explorer parses exactly 64 hex there — page.h json_outputs;
		// the OutProof strings sent before could never parse). The
		// name is the explorer's API surface, not ours.
		//
		// We do NOT log the full URL — only the base URL. The tx key
		// is per-payment (it is also in the public order op), but is
		// still kept out of logs as part of the privacy posture.
		const params = new URLSearchParams({
			txhash: txid,
			address,
			viewkey: txKey,
			txprove: '1'
		});
		const url = `${baseUrl.replace(/\/+$/, '')}/api/outputs?${params}`;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
		try {
			const res = await this.fetchImpl(
				url,
				explorerInit({ method: 'GET', accept: 'application/json' }, ac.signal)
			);
			if (res.status === 404) {
				// (v1.21.15 review) Not "no such transaction": this explorer
				// software answers an unknown transaction or a bad proof with a JSON
				// error (below); a 404 is a route it does not serve (its JSON API
				// off) or a page in front of it — no verdict on the payment.
				this.warn('explorer_404_without_not_found', { explorer: baseUrl, txid });
				return { kind: 'data_malformed' };
			}
			if (res.status >= 500) {
				this.warn('explorer_5xx', {
					explorer: baseUrl,
					txid,
					status: res.status
				});
				return { kind: 'transport_failure' };
			}
			if (!res.ok) {
				this.warn('explorer_bad_status', {
					explorer: baseUrl,
					txid,
					status: res.status
				});
				return { kind: 'transport_failure' };
			}
			let body: unknown;
			try {
				body = await readExplorerJson(res, ac);
			} catch {
				this.warn('explorer_non_json', { explorer: baseUrl, txid });
				return { kind: 'data_malformed' };
			}
			if (!isExplorerProofResponse(body)) {
				this.warn('explorer_bad_shape', {
					explorer: baseUrl,
					txid,
					keys: typeof body === 'object' && body !== null ? Object.keys(body) : []
				});
				return { kind: 'data_malformed' };
			}
			if (body.status !== 'success') {
				// The explorer answered but reports an error — usually
				// "tx not found" or "invalid proof" or "proof did not
				// decode for this address".  All map to data_not_found:
				// the explorer is healthy, the user's claim is wrong.
				this.warn('explorer_status_error', {
					explorer: baseUrl,
					txid,
					status: body.status
				});
				return { kind: 'data_not_found' };
			}
			// Echo-check (Item 4): if the explorer's
			// returned tx_hash is present and doesn't case-insensitively
			// match what we asked about, treat as data_malformed.  This
			// catches both bugs (response routing issues) and
			// manipulation signals (an explorer trying to substitute a
			// different transaction's proof verdict for ours).  We don't
			// require the field to be present — some minimal explorer
			// implementations omit it — but if present, it must agree.
			const echoedTxHash = body.data?.tx_hash;
			if (
				typeof echoedTxHash === 'string' &&
				echoedTxHash.toLowerCase() !== txid.toLowerCase()
			) {
				this.warn('explorer_txid_mismatch', {
					explorer: baseUrl,
					expected: txid,
					got: echoedTxHash
				});
				return { kind: 'data_malformed' };
			}
			return { kind: 'ok', body };
		} catch (err) {
			this.warn('explorer_fetch_failed', { explorer: baseUrl, txid }, err);
			return { kind: 'transport_failure' };
		} finally {
			clearTimeout(timer);
		}
	}

	/** Sum the amounts of outputs the proof confirmed match our
	 *  address.  Returns 0n if no outputs matched.  Tolerant of
	 *  amounts arriving as either number or string (some explorers
	 *  serialize large piconero values as strings to avoid JSON
	 *  precision loss). */
	private sumMatchedOutputs(r: ExplorerProofResponse): bigint {
		const outputs = r.data?.outputs;
		if (!outputs) return 0n;
		let sum = 0n;
		for (const o of outputs) {
			if (!o.match) continue;
			let amt: bigint;
			try {
				amt = typeof o.amount === 'string' ? BigInt(o.amount) : BigInt(o.amount);
			} catch {
				// Non-numeric amount field — defensive skip rather
				// than throw, since the verifier must not throw on
				// expected-failure paths (per FeeVerifier contract).
				continue;
			}
			if (amt > 0n) sum += amt;
		}
		return sum;
	}
}

/** Type guard for ExplorerProofResponse.  Defensive: external
 *  data cannot be trusted to match our interface.  */
function isExplorerProofResponse(b: unknown): b is ExplorerProofResponse {
	if (typeof b !== 'object' || b === null) return false;
	const obj = b as Record<string, unknown>;
	// (v1.21.15 review) 'fail' too: it is how the explorer software answers a
	// transaction it cannot find (page.h json_outputs: "Cant find tx hash").
	if (obj.status !== 'success' && obj.status !== 'error' && obj.status !== 'fail') return false;
	if (obj.data !== undefined) {
		if (typeof obj.data !== 'object' || obj.data === null) return false;
		const data = obj.data as Record<string, unknown>;
		if (data.outputs !== undefined && !Array.isArray(data.outputs)) return false;
	}
	return true;
}
