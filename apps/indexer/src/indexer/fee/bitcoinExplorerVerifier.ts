/**
 * Morphit indexer — Bitcoin fee verifier (ADR-0011 sub-phase 4b).
 *
 * Reads public block explorers to confirm a Bitcoin transaction
 * paid the Morphit fee address. Two explorers are queried in
 * parallel for cross-check — if they disagree on the transaction
 * or its outputs, we treat that as suspicious and reject.
 *
 * Why public explorers instead of a self-hosted Bitcoin node:
 * ADR-0011 §8 — self-hosted nodes are an operator burden (disk,
 * sync time, attack surface) that most community operators won't
 * accept. Public explorers are a pragmatic default; operators
 * who prefer self-hosting can substitute a custom verifier via
 * config.
 *
 * Tolerance: BTC has no on-chain fee mechanism that Morphit sets;
 * the PAYER is responsible for setting an on-chain fee to confirm
 * their tx. We check the output amount to Morphit's address,
 * which is not affected by miner fees. So the check is exact
 * (no tolerance), modulo the rare case where a payer pays a few
 * extra satoshis by accident — we accept overpayment but not
 * underpayment.
 */

import type { FeeClaim, FeeVerifier, FeeVerifyResult } from '$indexer/fee/verifier';
import { CircuitBreaker } from '$indexer/fee/circuitBreaker';
import { logger } from '$log';

const log = logger('btc-verify');

export interface BitcoinExplorerFeeVerifierConfig {
	/** Destination Bitcoin address. Outputs to this address count
	 *  toward the fee payment. Case-sensitive for bech32 addresses
	 *  (though Bitcoin normalises them to lowercase anyway). */
	readonly feeAddress: string;
	/** Explorer base URLs. Typically Blockstream + mempool.space.
	 *  Both expose the same /tx/{txid} JSON shape — we query both
	 *  and cross-check results. */
	readonly explorerUrls: readonly string[];
	/** Minimum confirmations required before a tx is considered
	 *  final. 1 is fine for small amounts; 3 for larger. Default 1. */
	readonly minConfirmations: number;
	/** Per-explorer HTTP timeout. Default 5000ms. */
	readonly requestTimeoutMs: number;
	/** Part 109 quorum gate.  Minimum number of explorers that
	 *  must return a successful, agreeing response before the
	 *  verifier promotes to `verified`.  When the bar isn't met
	 *  (degraded outage), the verifier returns `pending_external`
	 *  instead of trusting a single source.  Default `1` preserves
	 *  pre-Part-109 behavior for back-compat; operators with 3+
	 *  configured explorers should raise this to 2 (or higher)
	 *  for cross-source verification on every payment.  Bounded:
	 *  must be >= 1 and <= explorerUrls.length. */
	readonly minSuccessfulResponses: number;
}

export const DEFAULT_BITCOIN_EXPLORER_CONFIG: Omit<BitcoinExplorerFeeVerifierConfig, 'feeAddress'> =
	{
		explorerUrls: ['https://blockstream.info/api', 'https://mempool.space/api'],
		minConfirmations: 1,
		requestTimeoutMs: 5_000,
		// Default of 1 preserves pre-Part-109 behavior (any
		// successful response is enough).  Operators with 3+
		// explorers should bump to 2 for true cross-source check.
		minSuccessfulResponses: 1
	};

/** Minimal shape of the Blockstream/mempool.space /tx/{txid}
 *  response we rely on. Both APIs return the same structure. */
interface ExplorerTxResponse {
	readonly txid: string;
	readonly vout: readonly {
		readonly value: number; // satoshis
		readonly scriptpubkey_address?: string;
	}[];
	readonly status: {
		readonly confirmed: boolean;
		readonly block_height?: number;
	};
}

export class BitcoinExplorerFeeVerifier implements FeeVerifier {
	readonly name = 'btc-explorer';
	private readonly breaker: CircuitBreaker;

	constructor(
		private readonly config: BitcoinExplorerFeeVerifierConfig,
		private readonly fetchImpl: typeof fetch = fetch,
		breaker?: CircuitBreaker
	) {
		if (config.explorerUrls.length === 0) {
			throw new Error('BitcoinExplorerFeeVerifier: at least one explorer URL required');
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
		if (claim.feeMethod !== 'btc') {
			return {
				kind: 'rejected',
				reason: `BitcoinExplorerFeeVerifier cannot verify fee_method=${claim.feeMethod}`
			};
		}
		if (claim.externalTxId === null || claim.externalTxId.length === 0) {
			return { kind: 'rejected', reason: 'missing_external_tx_id' };
		}
		// Bitcoin txids are 32 bytes hex = 64 chars. Sanity check to
		// fail fast on obviously-bad input before hitting explorers.
		if (!/^[0-9a-f]{64}$/i.test(claim.externalTxId)) {
			return { kind: 'rejected', reason: 'malformed_tx_id' };
		}
		if (typeof claim.expectedAmount !== 'number') {
			return {
				kind: 'rejected',
				reason: 'expected_amount_not_number_for_btc'
			};
		}

		// Filter explorers by circuit-breaker state. Any URL in
		// cooldown is skipped entirely — saves us hammering a
		// rate-limited or down node, and avoids tripping
		// further alarms.
		const openUrls = this.config.explorerUrls.filter((u) => !this.breaker.shouldAttempt(u));
		const candidateUrls = this.config.explorerUrls.filter((u) => this.breaker.shouldAttempt(u));

		// If every configured explorer is in cooldown, there's
		// nothing to query. Land as pending_external so the
		// attestation path can resolve the order.
		if (candidateUrls.length === 0) {
			return {
				kind: 'pending_external',
				reason: `all ${this.config.explorerUrls.length} explorers in cooldown`
			};
		}

		// Query candidate explorers in parallel. Each branch
		// records success/failure into the breaker based on
		// whether we got a TRANSPORT failure (network / 5xx /
		// timeout) — NOT a data failure (404 / malformed body).
		// Per Finding S12: a flood of bogus user-supplied txids
		// would 404 across explorers and open the circuit, DoS-ing
		// the BTC verifier path for legitimate users.  The breaker
		// should only count health-of-explorer signals, not
		// validity-of-claim signals.
		const responses = await Promise.allSettled(
			candidateUrls.map(async (base) => {
				const r = await this.fetchTx(base, claim.externalTxId!);
				switch (r.kind) {
					case 'ok':
						this.breaker.recordSuccess(base);
						return { base, body: r.body };
					case 'transport_failure':
						this.breaker.recordFailure(base);
						return null;
					case 'data_not_found':
					case 'data_malformed':
						// Explorer responded; it's healthy.  The DATA
						// (or absence thereof) is the user's problem.
						// Don't penalize the explorer's reputation.
						this.breaker.recordSuccess(base);
						return null;
				}
			})
		);

		const successfulPairs = responses
			.filter(
				(
					r
				): r is PromiseFulfilledResult<{
					base: string;
					body: ExplorerTxResponse;
				}> => r.status === 'fulfilled' && r.value !== null
			)
			.map((r) => r.value);
		const successful = successfulPairs.map((p) => p.body);
		// Total "didn't contribute a valid response" count for the
		// operator log — includes candidates that threw OR candidates
		// that returned null (tx shape issue) plus explorers skipped
		// entirely by the breaker.
		const failureCount = responses.length - successful.length + openUrls.length;

		// All explorers failed or skipped → pending_external. The
		// attestation path can promote the order if the counterparty
		// cosigns.
		if (successful.length === 0) {
			return {
				kind: 'pending_external',
				reason: `${responses.length} explorers queried, ${openUrls.length} in cooldown, none returned usable data`
			};
		}

		// Part 109 quorum gate.  When the operator has configured
		// minSuccessfulResponses > 1, we require at least that many
		// agreeing responses before promoting to `verified`.  When
		// fewer than the threshold respond (degraded outage), return
		// `pending_external` so the attestation path can promote the
		// order if the counterparty cosigns — same fallback semantics
		// as "none returned usable data" above.  Note that defending
		// against agreement disagreement (multiple successful but
		// disagreeing amounts) happens AFTER this check; we want to
		// surface a quorum failure before a disagreement decision,
		// because a 1-of-2 result is structurally weaker even when
		// the single source happens to agree with itself.
		if (successful.length < this.config.minSuccessfulResponses) {
			return {
				kind: 'pending_external',
				reason: `quorum not met: ${successful.length}/${this.config.minSuccessfulResponses} explorers returned usable data (${responses.length} queried, ${openUrls.length} in cooldown)`
			};
		}

		// At least one explorer fetched. Cross-check: if we got >1
		// response and they disagree on the output paying our fee
		// address, reject. One explorer being wrong is a bigger
		// worry than one being down.
		const amountsToFeeAddress = successful.map((tx) => this.sumOutputsToFeeAddress(tx));
		const allMatch = amountsToFeeAddress.every((a) => a === amountsToFeeAddress[0]);
		if (!allMatch) {
			return {
				kind: 'rejected',
				reason: `explorer disagreement on output amounts: ${amountsToFeeAddress.join(' vs ')}`
			};
		}

		const observedSats = amountsToFeeAddress[0]!;
		if (observedSats < claim.expectedAmount) {
			return {
				kind: 'rejected',
				reason: `underpaid: observed ${observedSats} sats, expected ${claim.expectedAmount}`
			};
		}

		// Check confirmations.
		const minConfirmed = successful.every((tx) => tx.status.confirmed);
		if (!minConfirmed) {
			return {
				kind: 'pending_external',
				reason: 'tx not yet confirmed'
			};
		}

		// Min-confirmations depth check.  The /tx response carries
		// `status.block_height` for confirmed transactions; we
		// pair it with a /blocks/tip/height fetch to compute
		// current depth = (tip + 1) - block_height (the block the
		// tx is mined in counts as 1 confirmation).
		//
		// Skipped when minConfirmations <= 1: `confirmed: true`
		// already guarantees ≥1 confirmation, and tipping the
		// explorer for a redundant check costs latency without
		// adding defense.  Operators wanting deeper finality
		// (e.g. minConfirmations=3 for higher-value flows) get
		// real enforcement.
		//
		// If the depth check itself errors (transport/shape), we
		// return pending_external rather than verified — same
		// posture as "tx not yet confirmed" — so the attestor
		// re-tries later when the explorer is healthy.
		if (this.config.minConfirmations > 1) {
			const txBlockHeights = successful.map((tx) => tx.status.block_height);
			// Every successful tx response should carry block_height
			// when status.confirmed is true.  If any is missing,
			// the explorer's response is degenerate; treat as
			// pending and re-check.
			if (txBlockHeights.some((h) => typeof h !== 'number')) {
				return {
					kind: 'pending_external',
					reason: 'confirmed tx missing block_height in explorer response'
				};
			}
			// Use the lowest block_height across successful explorers
			// — that's the most conservative (smallest depth) read.
			const txBlock = Math.min(...(txBlockHeights as number[]));
			// Use the same explorer that gave us a /tx response for
			// the tip fetch — guarantees /tx and /tip see the same
			// chain view.  We don't cross-check tip across explorers;
			// a divergent tip is normal (one explorer trails by a
			// block) and we want to be lenient here, not introduce
			// false-pending failures from explorer lag.
			const tipBase = successfulPairs[0]!.base;
			const tipResult = await this.fetchTipHeight(tipBase);
			if (tipResult.kind !== 'ok') {
				return {
					kind: 'pending_external',
					reason: `tip-height fetch failed: ${tipResult.kind}`
				};
			}
			const depth = tipResult.tipHeight + 1 - txBlock;
			if (depth < this.config.minConfirmations) {
				return {
					kind: 'pending_external',
					reason: `depth ${depth} < minConfirmations ${this.config.minConfirmations}`
				};
			}
		}

		// Flag partial explorer agreement in the reason log if
		// we had any failures — useful for operators debugging
		// "why did this verify slower than usual" concerns.
		if (failureCount > 0) {
			log.info('partial_explorer_agreement', {
				permlink: claim.permlink,
				failures: failureCount,
				agreed: successful.length
			});
		}

		return { kind: 'verified', observedAmount: observedSats };
	}

	// ─── Internals ────────────────────────────────────────────────

	private async fetchTx(
		baseUrl: string,
		txid: string
	): Promise<
		| { kind: 'ok'; body: ExplorerTxResponse }
		| { kind: 'transport_failure' }
		| { kind: 'data_not_found' }
		| { kind: 'data_malformed' }
	> {
		const url = `${baseUrl.replace(/\/+$/, '')}/tx/${txid}`;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
		try {
			const res = await this.fetchImpl(url, {
				method: 'GET',
				headers: { accept: 'application/json' },
				signal: ac.signal
			});
			if (res.status === 404) {
				log.warn('explorer_tx_not_found', {
					explorer: baseUrl,
					txid
				});
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
				// Other 4xx — most commonly 429 rate-limit, which is
				// an explorer health signal (count toward breaker).
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
				log.warn('explorer_non_json', {
					explorer: baseUrl,
					txid
				});
				return { kind: 'data_malformed' };
			}
			if (!this.isExplorerTxResponse(body, txid)) {
				log.warn('explorer_bad_shape', {
					explorer: baseUrl,
					txid
				});
				return { kind: 'data_malformed' };
			}
			return { kind: 'ok', body };
		} catch (err) {
			// Network error, abort, DNS failure, etc. — transport.
			log.warn('explorer_fetch_failed', { explorer: baseUrl, txid }, err);
			return { kind: 'transport_failure' };
		} finally {
			clearTimeout(timer);
		}
	}

	private sumOutputsToFeeAddress(tx: ExplorerTxResponse): number {
		let total = 0;
		for (const out of tx.vout) {
			if (out.scriptpubkey_address !== this.config.feeAddress) continue;
			// Per Finding F7: defensive validation on out.value.  The
			// outer shape guard isExplorerTxResponse deliberately
			// doesn't drill into individual vout entries, so a malformed
			// or malicious explorer response could pass `value: NaN`
			// or string types here.  Without this guard, `NaN` would
			// propagate into observedSats, and `NaN < expected` is
			// always false → the verifier would wrongly return
			// {verified, observedAmount: NaN}.
			//
			// Skip non-finite or negative values — they don't contribute
			// to the sum.  If every output to our address has bad data,
			// total stays 0 → comparison rejects as underpaid.
			if (typeof out.value !== 'number') continue;
			if (!Number.isFinite(out.value)) continue;
			if (out.value < 0) continue;
			total += out.value;
		}
		return total;
	}

	/** Fetch the current tip block height from the same Esplora-
	 *  shape API we use for /tx.  Both blockstream.info and
	 *  mempool.space expose `/blocks/tip/height` as a plain-text
	 *  integer body.  Used by the depth check when
	 *  `minConfirmations > 1`.
	 *
	 *  Failure modes:
	 *  - transport (network/timeout/5xx) → 'transport_failure'
	 *  - non-integer body → 'data_malformed'
	 *
	 *  We do NOT touch the breaker here.  The breaker is sized for
	 *  the high-frequency /tx path; the tip fetch is rarer
	 *  (only on minConfirmations>1) and shouldn't influence the
	 *  /tx side's health view.
	 */
	private async fetchTipHeight(
		baseUrl: string
	): Promise<
		{ kind: 'ok'; tipHeight: number } | { kind: 'transport_failure' } | { kind: 'data_malformed' }
	> {
		const url = `${baseUrl.replace(/\/+$/, '')}/blocks/tip/height`;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
		try {
			const res = await this.fetchImpl(url, {
				method: 'GET',
				headers: { accept: 'text/plain' },
				signal: ac.signal
			});
			if (!res.ok) {
				return { kind: 'transport_failure' };
			}
			const body = await res.text();
			const parsed = parseInt(body.trim(), 10);
			if (!Number.isFinite(parsed) || parsed < 0) {
				return { kind: 'data_malformed' };
			}
			return { kind: 'ok', tipHeight: parsed };
		} catch {
			return { kind: 'transport_failure' };
		} finally {
			clearTimeout(timer);
		}
	}

	private isExplorerTxResponse(body: unknown, expectedTxid: string): body is ExplorerTxResponse {
		if (typeof body !== 'object' || body === null) return false;
		const b = body as Record<string, unknown>;
		if (typeof b.txid !== 'string') return false;
		// Item 4 (Audit Part 26) — txid-echo verification.  The
		// `/tx/{txid}` request URL embeds a txid; the response
		// JSON includes its own `txid` field.  An explorer
		// returning a tx whose echoed txid doesn't match what
		// we asked for is either buggy, hit a routing error, or
		// is actively trying to substitute a different tx.  All
		// three cases are reasons to reject.  The two-explorer
		// cross-check would catch coordinated substitution, but
		// a single bad explorer should still be guarded against
		// before its data even enters the cross-check pool.
		//
		// Bitcoin txids are case-insensitive in the protocol but
		// canonical lowercase in serialized form; we lowercase
		// both sides before comparing so an explorer returning
		// upper-case hex (rare but legal) is not rejected on
		// cosmetics alone.
		if (b.txid.toLowerCase() !== expectedTxid.toLowerCase()) {
			log.warn('explorer_txid_mismatch', {
				expected: expectedTxid,
				got: b.txid
			});
			return false;
		}
		if (!Array.isArray(b.vout)) return false;
		if (typeof b.status !== 'object' || b.status === null) return false;
		const s = b.status as Record<string, unknown>;
		if (typeof s.confirmed !== 'boolean') return false;
		// The vout elements are checked inside sumOutputsToFeeAddress
		// — the shape guard is deliberately lenient on optional fields
		// so a vout entry with a non-standard scriptpubkey type still
		// passes (we just ignore it).
		return true;
	}
}
