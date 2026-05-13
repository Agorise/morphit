/**
 * Morphit indexer — Monero fee verifier (Part 108++).
 *
 * This verifier confirms an XMR fee payment using the user's
 * per-payment `tx_proof` string — Monero's standard selective-
 * transparency mechanism for proof-of-payment.  No view key is
 * required by any indexer; canonical morphit.io is one indexer
 * among many, with no privileged role in verification.
 *
 * Replaces the Part 106/107-era `MoneroExplorerFeeVerifier` which
 * required the indexer to hold the treasury wallet's private view
 * key in env (read at boot, sent over HTTPS to the explorer for
 * each verification).  That design forced community operators
 * inheriting canonical's chain-pinned XMR address into one of
 * three options: trust canonical's verdict (federation-trust
 * path, never built), run their own treasury, or disable XMR.
 * Part 108++ eliminates that constraint: every indexer can verify
 * every payment independently, using the same public information.
 *
 * Verification flow:
 *   1. User pays Morphit's fee address from their own Monero
 *      wallet.
 *   2. User generates a tx_proof from their wallet via:
 *        - `monero-wallet-cli`: get_tx_proof <txid> <address>
 *        - Monero GUI: Advanced → Prove transaction
 *        - Cake Wallet: Settings → Privacy → Verify a transaction
 *        - Feather: Tools → Prove/check transaction
 *      The proof is a base58-ish string starting with
 *      'OutProofV1' or 'OutProofV2'.
 *   3. User posts an order op carrying fee_method='xmr', the
 *      txid in `external_tx_id`, and the proof in `tx_proof`.
 *   4. Indexer calls the explorer's `/api/outputs` endpoint with
 *      `txprove=1` and the tx_proof string in place of a viewkey.
 *      The explorer (or local monerod RPC) verifies the proof
 *      against the txid + address and returns the proven amount.
 *   5. Standard verified / underpaid / pending_external mapping.
 *
 * Privacy properties:
 *   - The proof reveals only "this txid paid this address this
 *     amount" — exactly the public information needed for
 *     verification, no more.
 *   - It does NOT reveal: other payments to the address, other
 *     transactions in the user's wallet, the user's other
 *     addresses, or wallet metadata.
 *   - One-time, per-payment.  Possessing one proof tells you
 *     nothing about other payments or future inflows.
 *   - The user is the ONLY party that needs to hold any
 *     verification secret (their tx key from their own wallet,
 *     never published).  The indexer holds NOTHING.
 *
 * Decentralization properties:
 *   - Every indexer in the federation can independently verify
 *     every order using publicly-available block data + the
 *     proof string included in the order op.
 *   - No central instance.  No "morphit.io must be up"
 *     dependency for XMR verification.
 *   - Self-hostable: operators can point at a local monerod
 *     RPC instead of a third-party explorer (recommended for
 *     maximum independence).
 *
 * Multi-explorer cross-check:
 *   Same pattern as the BTC verifier — multiple explorer URLs,
 *   results compared for agreement, single-source-of-truth
 *   manipulation rejected.  Default ships with FIVE
 *   independent Monero explorers (all running the
 *   `moneroexamples/onion-monero-blockchain-explorer`
 *   reference codebase, same `/api/outputs?txprove=1`
 *   surface): xmrchain.net, localmonero.co/blocks,
 *   monerohash.com/explorer, exploremonero.com,
 *   moneroexplorer.org.  Operators can substitute their
 *   own list via `MORPHIT_INDEXER_XMR_EXPLORER_URLS`,
 *   including self-hosted instances for priority #2
 *   maximum independence.
 *
 * Confirmations: default 1.  Monero blocks are ~2 min apart so
 * 1 confirm takes a few minutes.  Morphit's fee tier is small
 * enough (~$0.25) that deep-reorg anxiety doesn't apply.
 *
 * Operator-side constraint (privacy invariant):
 *   The proof string IS sent over HTTPS to the configured
 *   explorer (required by Monero's design — the explorer
 *   needs the proof to verify the transaction).  This is
 *   acceptable because the proof reveals only the public-
 *   verifiable claim about that one payment.  Compare with
 *   the Part 106/107 design where the VIEW KEY was sent over
 *   HTTPS to the explorer; the view key revealed the entire
 *   incoming history of the wallet.  Per-payment proofs are
 *   strictly less leaky than view keys.
 *
 *   HTTPS-only is enforced by the config validator — see
 *   apps/indexer/src/config/index.ts MORPHIT_INDEXER_XMR_EXPLORER_URLS.
 *
 *   For maximum independence (Priority #2 — decentralization),
 *   operators can run their own monerod + monero-block-explorer
 *   on the same box and point the verifier at it.  See
 *   docs/OPERATIONS.md §40.4.
 */

import type { FeeClaim, FeeVerifier, FeeVerifyResult } from '$indexer/fee/verifier';
import { CircuitBreaker } from '$indexer/fee/circuitBreaker';
import { logger } from '$log';

const log = logger('xmr-verify');

export interface MoneroProofFeeVerifierConfig {
	/** Destination primary address (public).  This is the value
	 *  the user paid TO; the verifier confirms the proof was
	 *  generated for this exact address. */
	readonly feeAddress: string;
	/** Explorer base URLs that expose an /api/outputs endpoint
	 *  with `txprove=1` mode.  xmrchain.net is the reference;
	 *  operators can substitute their own self-hosted Monero
	 *  block-explorer instance for maximum independence. */
	readonly explorerUrls: readonly string[];
	/** Minimum confirmations required.  Default 1. */
	readonly minConfirmations: number;
	/** Per-explorer HTTP timeout.  Default 10_000ms. */
	readonly requestTimeoutMs: number;
	/** Part 109 quorum gate.  Minimum number of explorers that
	 *  must return a successful, agreeing response before the
	 *  verifier promotes to `verified`.  When the bar isn't met
	 *  (degraded outage), the verifier returns `pending_external`
	 *  instead of trusting a single source.  Default `1` preserves
	 *  pre-Part-109 behavior for back-compat; the default 5-way
	 *  explorer config makes a quorum of 2 (or 3) realistic for
	 *  production deployments. */
	readonly minSuccessfulResponses: number;
}

export const DEFAULT_MONERO_PROOF_VERIFIER_CONFIG: Omit<
	MoneroProofFeeVerifierConfig,
	'feeAddress'
> = {
	// Default explorer list — five independent instances all
	// running the same `onion-monero-blockchain-explorer`
	// reference codebase.  Multi-explorer cross-check rejects
	// single-source manipulation; if a verifier-construction
	// code path uses this default (vs. reading config), it
	// still gets a 5-way cross-check out of the box.
	explorerUrls: [
		'https://xmrchain.net',
		'https://localmonero.co/blocks',
		'https://monerohash.com/explorer',
		'https://exploremonero.com',
		'https://moneroexplorer.org'
	],
	minConfirmations: 1,
	requestTimeoutMs: 10_000,
	// Default of 1 preserves pre-Part-109 behavior.  Operators with
	// the default 5-explorer list should bump to 2 or 3 in their
	// indexer.env for true cross-source check on every payment.
	minSuccessfulResponses: 1
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
	private readonly breaker: CircuitBreaker;

	constructor(
		private readonly config: MoneroProofFeeVerifierConfig,
		private readonly fetchImpl: typeof fetch = fetch,
		breaker?: CircuitBreaker
	) {
		if (config.explorerUrls.length === 0) {
			throw new Error('MoneroProofFeeVerifier: at least one explorer URL required');
		}
		// Privacy-preservation invariant — every URL must be HTTPS.
		// The config validator should already reject non-HTTPS URLs
		// before we reach here, but defense-in-depth check at
		// construction.  The proof string is less sensitive than the
		// old view key (per-payment vs. wallet-lifetime), but still
		// publicly verifiable claim and still warrants TLS.
		for (const u of config.explorerUrls) {
			if (!u.startsWith('https://')) {
				throw new Error(
					`MoneroProofFeeVerifier: explorer URL must be https://, got ${u}`
				);
			}
		}
		this.breaker = breaker ?? new CircuitBreaker();
	}

	/** The address the verifier was constructed with.  Surfaced
	 *  so the poller can detect when a treasury chain-pin updates
	 *  the address and rebuild — see Part 106. */
	get currentAddress(): string {
		return this.config.feeAddress;
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
		// Monero tx hashes are 32-byte hex = 64 chars.
		if (!/^[0-9a-f]{64}$/i.test(claim.externalTxId)) {
			return { kind: 'rejected', reason: 'malformed_tx_id' };
		}
		// Part 108++ — tx_proof is required.
		if (claim.txProof === null || claim.txProof.length === 0) {
			return { kind: 'rejected', reason: 'missing_tx_proof' };
		}
		// Order-handler structural validator already enforced shape
		// (OutProofV1/V2 prefix, length, charset) but defense-in-
		// depth check here too — a verifier that trusts upstream
		// validation entirely is a verifier with a hidden
		// constraint.
		if (
			!claim.txProof.startsWith('OutProofV1') &&
			!claim.txProof.startsWith('OutProofV2')
		) {
			return { kind: 'rejected', reason: 'malformed_tx_proof_prefix' };
		}
		if (claim.txProof.length > 4096) {
			return { kind: 'rejected', reason: 'tx_proof_too_long' };
		}
		if (!/^[A-Za-z0-9]+$/.test(claim.txProof)) {
			return { kind: 'rejected', reason: 'malformed_tx_proof_charset' };
		}
		// claim.expectedAmount for XMR is a bigint in piconero.
		if (typeof claim.expectedAmount !== 'bigint') {
			return {
				kind: 'rejected',
				reason: 'expected_amount_not_bigint_for_xmr'
			};
		}

		// Filter explorers by circuit-breaker state.
		const openUrls = this.config.explorerUrls.filter((u) => !this.breaker.shouldAttempt(u));
		const candidateUrls = this.config.explorerUrls.filter((u) => this.breaker.shouldAttempt(u));

		if (candidateUrls.length === 0) {
			return {
				kind: 'pending_external',
				reason: `all ${this.config.explorerUrls.length} explorers in cooldown`
			};
		}

		const responses = await Promise.allSettled(
			candidateUrls.map(async (base) => {
				const r = await this.fetchProofVerification(
					base,
					claim.externalTxId!,
					claim.txProof!
				);
				switch (r.kind) {
					case 'ok':
						this.breaker.recordSuccess(base);
						return r.body;
					case 'transport_failure':
						this.breaker.recordFailure(base);
						return null;
					case 'data_not_found':
					case 'data_malformed':
						// Per Finding S12 (BTC verifier rationale): the
						// explorer responded with structured data; the
						// data issue is the user's claim, not the
						// explorer's health.  Don't open the breaker.
						this.breaker.recordSuccess(base);
						return null;
				}
			})
		);

		const successful = responses
			.filter(
				(r): r is PromiseFulfilledResult<ExplorerProofResponse> =>
					r.status === 'fulfilled' && r.value !== null
			)
			.map((r) => r.value);
		const failureCount = responses.length - successful.length + openUrls.length;

		if (successful.length === 0) {
			return {
				kind: 'pending_external',
				reason: `${responses.length} explorers queried, ${openUrls.length} in cooldown, none returned usable data`
			};
		}

		// Part 109 quorum gate.  When operator has configured
		// minSuccessfulResponses > 1, require at least that many
		// agreeing responses before promoting to `verified`.  Same
		// semantics as the BTC verifier: a 1-of-5 result during a
		// degraded outage is structurally weaker than the operator
		// signed up for, so return `pending_external` and let the
		// indexer's attestation path / next polling cycle pick it
		// up when more explorers come back.
		if (successful.length < this.config.minSuccessfulResponses) {
			return {
				kind: 'pending_external',
				reason: `quorum not met: ${successful.length}/${this.config.minSuccessfulResponses} explorers returned usable data (${responses.length} queried, ${openUrls.length} in cooldown)`
			};
		}

		// Sum matched outputs from each successful response.  BigInt
		// throughout — piconero can exceed Number.MAX_SAFE_INTEGER.
		const amounts: bigint[] = successful.map((r) => this.sumMatchedOutputs(r));
		const allMatch = amounts.every((a) => a === amounts[0]);
		if (!allMatch) {
			return {
				kind: 'rejected',
				reason: `explorer disagreement on proven amounts: ${amounts.map((a) => a.toString()).join(' vs ')}`
			};
		}

		const observed = amounts[0]!;
		if (observed === 0n) {
			// Proof verified to an existing tx but no outputs matched
			// our address — the proof is for a different payment, or
			// proves a payment to a different recipient.
			return { kind: 'rejected', reason: 'tx_proof_did_not_prove_any_match' };
		}
		if (observed < claim.expectedAmount) {
			return {
				kind: 'rejected',
				reason: `underpaid: observed ${observed} piconero, expected ${claim.expectedAmount}`
			};
		}

		// Confirmation check.
		const minConfirmedAcross = successful.reduce<number>((acc, r) => {
			const c = r.data?.tx_confirmations ?? 0;
			return acc === -1 ? c : Math.min(acc, c);
		}, -1);
		if (minConfirmedAcross < this.config.minConfirmations) {
			return {
				kind: 'pending_external',
				reason: `tx only ${minConfirmedAcross} confirmations, need ${this.config.minConfirmations}`
			};
		}

		if (failureCount > 0) {
			log.info('partial_explorer_agreement', {
				permlink: claim.permlink,
				failures: failureCount,
				agreed: successful.length
			});
		}

		return { kind: 'verified', observedAmount: observed };
	}

	// ─── Internals ────────────────────────────────────────────────

	private async fetchProofVerification(
		baseUrl: string,
		txid: string,
		txProof: string
	): Promise<
		| { kind: 'ok'; body: ExplorerProofResponse }
		| { kind: 'transport_failure' }
		| { kind: 'data_not_found' }
		| { kind: 'data_malformed' }
	> {
		// xmrchain endpoint with proof-mode:
		//   /api/outputs?txhash={txid}&address={addr}&viewkey={proof}&txprove=1
		//
		// In proof-mode, the `viewkey` query parameter actually
		// receives the tx_proof string (yes, the parameter name is
		// confusing; this is xmrchain.net's API surface, not ours).
		// The `txprove=1` flag tells the explorer to interpret the
		// value as a proof rather than a wallet view key.
		//
		// We do NOT log the full URL — only the base URL.  The
		// proof string is less sensitive than a view key (per-
		// payment, single-use), but still excluded from logs as
		// part of the project's privacy posture.
		const params = new URLSearchParams({
			txhash: txid,
			address: this.config.feeAddress,
			viewkey: txProof,
			txprove: '1'
		});
		const url = `${baseUrl.replace(/\/+$/, '')}/api/outputs?${params}`;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
		try {
			const res = await this.fetchImpl(url, {
				method: 'GET',
				headers: { accept: 'application/json' },
				signal: ac.signal
			});
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
				body = (await res.json()) as unknown;
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
			// Echo-check (Item 4 / Audit Part 26): if the explorer's
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
