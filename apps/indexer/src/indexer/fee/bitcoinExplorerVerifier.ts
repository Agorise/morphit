/**
 * Morphit indexer — Bitcoin fee verifier (ADR-0011 sub-phase 4b).
 *
 * Reads public block explorers to confirm a Bitcoin transaction
 * paid the Morphit fee address.  Multiple explorers are queried in
 * parallel for cross-check; quorum forms when ≥minSuccessfulResponses
 * agree on the amount paid to the fee address.
 *
 * Why public explorers instead of a self-hosted Bitcoin node:
 * ADR-0011 §8 — self-hosted nodes are an operator burden (disk,
 * sync time, attack surface) that most community operators won't
 * accept.  Public explorers are a pragmatic default; operators
 * who prefer self-hosting can substitute a custom verifier via
 * config.
 *
 * Tolerance: BTC has no on-chain fee mechanism that Morphit sets;
 * the PAYER is responsible for setting an on-chain fee to confirm
 * their tx.  We check the output amount to Morphit's address,
 * which is not affected by miner fees.  So the check is exact
 * (no tolerance), modulo the rare case where a payer pays a few
 * extra satoshis by accident — we accept overpayment but not
 * underpayment.
 *
 * cp166 — migrated from `Promise.allSettled` + CircuitBreaker to
 * `@morphit/rpc-pool` + `quorumCall`.  The key behavioral change:
 * verification returns the moment ≥minSuccessfulResponses agree on
 * the same fee-address amount, instead of waiting for every
 * candidate explorer (or its timeout) to respond.  Same trust model
 * (cross-source agreement still required), much better latency
 * under degraded-explorer conditions.  Under the old behavior a
 * single dissenting explorer could DoS a legitimate trade by
 * forcing rejection on disagreement; under the new behavior that
 * dissenter is outvoted by the agreeing majority — strict
 * improvement on the attack surface too.
 */

import type { FeeClaim, FeeVerifier, FeeVerifyResult } from '$indexer/fee/verifier';
import { EndpointPool, type EndpointState } from '@morphit/rpc-pool';
import { minAcceptableSatoshis, FEE_PRICE_TOLERANCE } from '@morphit/asset-registry';
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
	private readonly pool: EndpointPool;

	constructor(
		private readonly config: BitcoinExplorerFeeVerifierConfig,
		private readonly fetchImpl: typeof fetch = fetch,
		pool?: EndpointPool
	) {
		if (config.explorerUrls.length === 0) {
			throw new Error('BitcoinExplorerFeeVerifier: at least one explorer URL required');
		}
		this.pool = pool ?? new EndpointPool({ endpoints: [...config.explorerUrls] });
	}

	/** The address the verifier was constructed with.  Surfaced
	 *  so the poller can detect when a treasury chain-pin updates
	 *  the address and rebuild — see Part 106. */
	get currentAddress(): string {
		return this.config.feeAddress;
	}

	/** Expose pool state for `/v1/health?verbose=1` diagnostics.
	 *  Returns per-explorer EWMA latency, consecutive failures, and
	 *  cooldown deadline — strict superset of what the old breaker
	 *  exposed (which had no latency tracking). */
	endpointSnapshot(): readonly EndpointState[] {
		return this.pool.snapshot();
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

		// cp166: quorum-with-early-return.  Fire to all healthy
		// explorers in parallel; return the moment
		// `minSuccessfulResponses` agree on the amount paid to the
		// fee address.  Slow / dead explorers don't gate completion.
		//
		// Equivalence key = the satoshi amount paid to our fee
		// address as reported by that explorer.  Explorers that
		// agree on the amount form a quorum bucket.  Explorers that
		// disagree end up in their own buckets and need their own
		// quorum to overrule.
		//
		// Response classification mapped onto the quorumCall protocol:
		//   ok                → return the tx body
		//   data_not_found    → return null (healthy, non-contributing)
		//   data_malformed    → return null (healthy, non-contributing)
		//   transport_failure → throw (penalize endpoint cooldown)
		const totalUrls = this.config.explorerUrls.length;
		// Generous timeout: requestTimeoutMs is per-explorer; we
		// allow up to 2× that for the whole quorum call so a slow
		// (but eventually responding) explorer can still arrive
		// while we wait for the quorum to coalesce.
		const quorumTimeoutMs = this.config.requestTimeoutMs * 2;

		const quorumResult = await this.pool.quorumCall<{
			base: string;
			body: ExplorerTxResponse;
		}>(
			async (base, signal) => {
				const r = await this.fetchTx(base, claim.externalTxId!, signal);
				switch (r.kind) {
					case 'ok':
						return { base, body: r.body };
					case 'transport_failure':
						// Penalize the endpoint via the pool's cooldown ladder.
						throw new Error('transport_failure');
					case 'data_not_found':
					case 'data_malformed':
						// Explorer responded healthily; the data is the
						// user's problem.  Don't penalize the endpoint
						// (per Finding S12) and don't bucket this response.
						return null;
				}
			},
			{
				// The amount paid to the fee address is the
				// agreement key.  Explorers that compute the same
				// amount end up in the same bucket.
				equivalenceKey: (pair) => String(this.sumOutputsToFeeAddress(pair.body)),
				minAgree: this.config.minSuccessfulResponses,
				timeoutMs: quorumTimeoutMs
			}
		);

		// All explorers in cooldown.
		if (quorumResult.kind === 'no_endpoints') {
			return {
				kind: 'pending_external',
				reason: `all ${totalUrls} explorers in cooldown`
			};
		}

		// Quorum not met.  Either the responses disagreed (no group
		// reached minSuccessfulResponses) or too many transport-failed
		// or returned null.  Either way the verdict is pending.
		if (quorumResult.kind === 'all_responses_in') {
			return {
				kind: 'pending_external',
				reason: `quorum not met: best group had < ${this.config.minSuccessfulResponses} agreeing explorers (${quorumResult.responses.length} usable responses, ${quorumResult.cooledDown} in cooldown)`
			};
		}

		// Quorum met.  We have ≥minSuccessfulResponses explorers
		// agreeing on the same fee-address amount.  Use that bucket.
		const agreedSats = Number(quorumResult.agreedKey);
		const agreeingResponses = quorumResult.responses.filter(
			(p) => this.sumOutputsToFeeAddress(p.body) === agreedSats
		);
		const successful = agreeingResponses.map((p) => p.body);

		const observedSats = agreedSats;
		// Model-A tolerance (cp372): accept a payment within
		// FEE_PRICE_TOLERANCE below the chain-pinned expected amount,
		// so a user paying the live-displayed amount isn't rejected
		// when crypto has appreciated since the operator last re-pinned.
		// Overpayment is always fine (floor); only the lower bound
		// relaxes, by a fixed bounded 15% (not fork-controllable).
		const minSats = minAcceptableSatoshis(claim.expectedAmount);
		if (observedSats < minSats) {
			return {
				kind: 'rejected',
				reason: `underpaid: observed ${observedSats} sats, expected ${claim.expectedAmount} (min ${minSats} at ${FEE_PRICE_TOLERANCE * 100}% tolerance)`
			};
		}

		// Check confirmations across the agreeing-bucket responses.
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
			const tipBase = agreeingResponses[0]!.base;
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
		// not every explorer contributed to the agreeing bucket —
		// useful for operators debugging "why did this verify
		// slower than usual" concerns.  Under cp166's quorumCall,
		// `quorumResult.contacted` counts explorers we actually
		// reached out to, `quorumResult.responses.length` is total
		// usable responses (across all buckets), and
		// `successful.length` is the agreeing-bucket size.
		const usableContributors = quorumResult.responses.length;
		if (usableContributors < quorumResult.contacted) {
			log.info('partial_explorer_agreement', {
				permlink: claim.permlink,
				contacted: quorumResult.contacted,
				cooledDown: quorumResult.cooledDown,
				agreed: successful.length
			});
		}

		return { kind: 'verified', observedAmount: observedSats };
	}

	// ─── Internals ────────────────────────────────────────────────

	private async fetchTx(
		baseUrl: string,
		txid: string,
		poolSignal?: AbortSignal
	): Promise<
		| { kind: 'ok'; body: ExplorerTxResponse }
		| { kind: 'transport_failure' }
		| { kind: 'data_not_found' }
		| { kind: 'data_malformed' }
	> {
		const url = `${baseUrl.replace(/\/+$/, '')}/tx/${txid}`;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.config.requestTimeoutMs);
		// cp166 — wire the pool's AbortSignal through to fetch so
		// quorum-met cancellation aborts in-flight fetches and
		// frees up the socket.  Belt-and-braces: also abort on the
		// per-call timeout.
		const onPoolAbort = (): void => ac.abort();
		if (poolSignal !== undefined) {
			if (poolSignal.aborted) ac.abort();
			else poolSignal.addEventListener('abort', onPoolAbort, { once: true });
		}
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
			if (poolSignal !== undefined) {
				poolSignal.removeEventListener('abort', onPoolAbort);
			}
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
