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
 * for, out of the tier's configured ones (fee/tieredFeeVerifier.ts: the two
 * default onion explorers first, then all eight), fastest first. If only
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
 * Defaults: config/xmrExplorers.ts (two onion xmrblocks explorers, then the
 * clearnet fallback). See docs/OPERATIONS.md §40.4.
 *
 * Privacy: the txid and r (both already public in the order op) go to each
 * explorer over Tor (an onion; the network encrypts end to end, on a fresh
 * circuit per request — indexer/sourceFetch.ts) or over HTTPS; only base URLs
 * are logged. Never plain HTTP over the open internet: enforced by the config
 * validator and again at construction.
 */

import type { FeeClaim, FeeVerifier, FeeVerifyResult } from './verifier';
import { EndpointPool, type EndpointState } from '@morphit/rpc-pool';
import { minAcceptablePiconero, FEE_PRICE_TOLERANCE } from '@morphit/asset-registry';
import { logger } from '../../log/index';
import { encryptedPaymentIdsFromExtra, xmrDecryptPaymentId } from './xmrPaymentId';
import { moneroTxHash, scanRawTxForAddress } from './xmrRawTx';
import { explorerInit, readExplorerJson, readExplorerText } from './explorerHttp';
import { parseXmrAddress } from '@morphit/release-schema';
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
	readonly status: 'success' | 'error';
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
		this.pool = pool ?? new EndpointPool({ endpoints: [...config.explorerUrls] });
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
						log.warn('explorer_payment_id_not_in_extra', { explorer: base });
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

	/** (wave 4) A raw-tx explorer's answer, verified here (xmrRawTx.ts). */
	private async rawTxAnswer(
		base: string,
		txid: string,
		address: string,
		txKey: string,
		poolSignal?: AbortSignal
	): Promise<
		| { kind: 'ok'; amount: bigint; encryptedPaymentIds: readonly string[]; confirmations: number | null }
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
			log.warn('explorer_tx_content_mismatch', { explorer: base });
			return { kind: 'data_malformed' };
		}
		const scan = scanRawTxForAddress(b.transaction_data, txKey, {
			viewPub: dest.value.viewPub,
			spendPub: dest.value.spendPub
		});
		if ('error' in scan) {
			if (scan.error === 'commitment_mismatch') log.warn('explorer_commitment_mismatch', { explorer: base });
			return scan.error === 'bad_key' ? { kind: 'data_not_found' } : { kind: 'data_malformed' };
		}
		const confirmations = await this.rawTxConfirmations(base, txid, poolSignal);
		return { kind: 'ok', amount: scan.amount, encryptedPaymentIds: scan.encryptedPaymentIds, confirmations };
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
		| { kind: 'ok'; amount: bigint; encryptedPaymentIds: readonly string[]; confirmations: number | null }
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
			log.warn('explorer_tx_content_mismatch', { explorer: base });
			return { kind: 'data_malformed' };
		}
		const scan = scanRawTxForAddress(tx, txKey, {
			viewPub: dest.value.viewPub,
			spendPub: dest.value.spendPub
		});
		if ('error' in scan) {
			if (scan.error === 'commitment_mismatch') log.warn('explorer_commitment_mismatch', { explorer: base });
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
		return { kind: 'ok', amount: scan.amount, encryptedPaymentIds: scan.encryptedPaymentIds, confirmations };
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
			log.warn('explorer_fetch_failed', { explorer: new URL(url).origin }, err);
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
	 *  the page names no block (still in the pool); null when it cannot tell. */
	private async rawTxConfirmations(base: string, txid: string, poolSignal?: AbortSignal): Promise<number | null> {
		let page: string;
		try {
			const res = await this.fetchImpl(
				`${base}/tx/${txid}`,
				explorerInit({ method: 'GET', accept: 'text/html' }, poolSignal ?? null)
			);
			if (!res.ok) return null;
			page = await readExplorerText(res);
		} catch {
			return null;
		}
		const heights = [...new Set([...page.matchAll(/\/block\/(\d{1,9})(?!\d)/g)].map((m) => Number(m[1])))].slice(0, 3);
		if (heights.length === 0) return /\bconfirmations\b/i.test(page) ? 0 : null;
		for (const h of heights) {
			const got = await this.getJsonFrom(`${base}/api/get_block_data/${h}`, poolSignal);
			if (got.kind !== 'ok') continue;
			const result = (got.body as { block_data?: { result?: Record<string, unknown> } } | null)?.block_data?.result;
			const header = result?.block_header as { height?: unknown; depth?: unknown } | undefined;
			const hashes = result?.tx_hashes;
			if (
				header?.height === h &&
				typeof header.depth === 'number' &&
				Number.isSafeInteger(header.depth) &&
				header.depth >= 0 &&
				Array.isArray(hashes) &&
				hashes.some((x) => typeof x === 'string' && x.toLowerCase() === txid.toLowerCase())
			) {
				return header.depth + 1;
			}
		}
		return null;
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
			log.warn('explorer_fetch_failed', { explorer: new URL(url).origin }, err);
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
			if (res.status === 404) return { kind: 'data_not_found' };
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
			log.warn('explorer_fetch_failed', { explorer: baseUrl, txid }, err);
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
				log.warn('explorer_tx_not_found', { explorer: baseUrl, txid });
				return { kind: 'data_not_found' };
			}
			if (res.status >= 500) {
				log.warn('explorer_5xx', {
					explorer: baseUrl,
					txid,
					status: res.status
				});
				return { kind: 'transport_failure' };
			}
			if (!res.ok) {
				log.warn('explorer_bad_status', {
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
				log.warn('explorer_non_json', { explorer: baseUrl, txid });
				return { kind: 'data_malformed' };
			}
			if (!isExplorerProofResponse(body)) {
				log.warn('explorer_bad_shape', {
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
				log.warn('explorer_status_error', {
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
				log.warn('explorer_txid_mismatch', {
					explorer: baseUrl,
					expected: txid,
					got: echoedTxHash
				});
				return { kind: 'data_malformed' };
			}
			return { kind: 'ok', body };
		} catch (err) {
			log.warn('explorer_fetch_failed', { explorer: baseUrl, txid }, err);
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
	if (obj.status !== 'success' && obj.status !== 'error') return false;
	if (obj.data !== undefined) {
		if (typeof obj.data !== 'object' || obj.data === null) return false;
		const data = obj.data as Record<string, unknown>;
		if (data.outputs !== undefined && !Array.isArray(data.outputs)) return false;
	}
	return true;
}
