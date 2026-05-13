/**
 * Morphit indexer — TreasurySource (Part 106; refined through
 * Parts 107 / 108++ / 109).
 *
 * Single source of truth for "what BTC/XMR fee address should
 * THIS indexer be verifying against right now?"
 *
 * Why this abstraction exists.  Pre-Part-106, every operator's
 * indexer trusted its own MORPHIT_INDEXER_BTC_FEE_ADDRESS /
 * _XMR_FEE_ADDRESS env vars as gospel.  A hostile operator
 * who forked the codebase could change those env vars to a
 * hostile address and silently divert all BTC/XMR fees from
 * users on that instance.  The federated peer indexers would
 * then mark those fees `underpaid`/`missing` (because the txid
 * paid the wrong address from the canonical's perspective) and
 * the orders would never appear on the canonical instance.
 * Treasury chain-pin closes that gap by introducing an on-
 * chain authoritative source for the canonical addresses,
 * signed by the @morphit posting key via the same trust
 * anchor that already gates `morphit_release_v1` ops.
 *
 * **Privacy invariant (Part 107)**: the chain-pinned treasury
 * carries ONLY the address (and amount) — public information
 * that's part of every payment anyway.  The Monero PRIVATE
 * view key is NEVER chain-pinned.  Publishing the view key
 * would reveal every incoming payment, amount, timing, and
 * subaddress to the treasury wallet, forever, including
 * future inflows; that degrades privacy for the treasury and
 * for every fee-paying user.
 *
 * **Part 108++**: per-payment proof verification replaced
 * view-key-based decryption entirely.  No Morphit indexer
 * holds a view key, ever.  Every Morphit instance verifies
 * every XMR payment independently using user-submitted
 * tx_proof strings against public Monero block explorers.
 *
 * **Part 109**: the `MORPHIT_INDEXER_XMR_FEE_VIEWKEY` env
 * var was removed entirely; the `viewkey` field on the
 * XmrTreasury interface was removed; the
 * `TreasurySourceEnvFallback.xmrViewkey` field was removed.
 * Stale `viewkey` fields on historical chain-pin rows
 * (Part 106 transitional) are silently stripped at read
 * time and never propagate anywhere.
 *
 * Resolution policy — addresses + amounts (BTC and XMR alike):
 *
 *   1. Most recent valid `morphit_release_v1` row's
 *      `treasury.{btc|xmr}.address` field — chain-pinned
 *      canonical.
 *   2. The operator's MORPHIT_INDEXER_{BTC,XMR}_FEE_ADDRESS
 *      env var — fallback for fresh indexers that haven't
 *      seen a treasury-bearing release op yet.
 *   3. null — meaning that fee method is disabled on this
 *      instance.
 *
 * For canonical morphit.io:
 *   - Pre-launch: env-var set, no release op yet → step 2
 *     wins for address+amount.
 *   - At launch: operator broadcasts release op with
 *     treasury block (BTC + XMR addresses and amounts, no
 *     view-key field) → step 1 wins.
 *   - Post-launch address rotation: operator broadcasts a
 *     new release op with updated treasury → every
 *     federated indexer picks up the new address within one
 *     block.
 *
 * For community operators (Part 108++):
 *   - Encouraged to leave MORPHIT_INDEXER_XMR_FEE_ADDRESS
 *     empty so they automatically inherit the chain-pinned
 *     canonical address.
 *   - No view key needed.  Every operator verifies XMR fees
 *     independently using user-submitted per-payment proofs.
 *     The previous three-options dilemma is obsolete.
 *
 * Hot-rebuild semantics.  The poller asks the source for the
 * current treasury periodically (once per block-poll cycle is
 * fine — release ops are rare).  When the source's value
 * differs from what the active verifier was constructed with,
 * the poller rebuilds the verifier.  No restart needed.
 *
 * Caching.  The source caches the most recent DB lookup for a
 * configurable TTL (default 30s).  Release ops are signed
 * broadcasts that land at most a few times per year; we
 * absolutely don't need to re-query the DB every block.
 */

import type { Database } from '$db/pool';
import { logger } from '$log';

const log = logger('treasury-source');

/** What the verifier needs to know about the BTC treasury. */
export interface BtcTreasury {
	readonly address: string;
	readonly satoshis: number;
	/** Where this value came from.  'chain' = chain-pinned by
	 *  release op (authoritative); 'env' = env-var fallback;
	 *  'absent' = no value available (BTC fees disabled). */
	readonly source: 'chain' | 'env';
}

/** What the verifier needs to know about the XMR treasury.
 *
 *  Part 107: composite source.  The address and piconero come
 *  from the chain-pinned treasury when available (canonical),
 *  with env-var fallback.
 *
 *  Part 108++ / 109: there is no view-key field.  Per-payment
 *  proofs eliminate the need for any indexer to hold a view
 *  key; this interface reflects that.  Historical chain-pin
 *  rows (Part 106 transitional) that contained a `viewkey`
 *  field are silently stripped at parse time and never
 *  propagate here.
 *
 *  The `addressSource` field tracks where the address+
 *  piconero came from for /v1/health diagnostics. */
export interface XmrTreasury {
	readonly address: string;
	readonly piconero: string;
	/** Where the address+piconero came from.  'chain' = chain-
	 *  pinned via release op; 'env' = local fallback. */
	readonly addressSource: 'chain' | 'env';
}

/** Snapshot of what the source resolved on its last refresh. */
export interface TreasurySnapshot {
	readonly btc: BtcTreasury | null;
	readonly xmr: XmrTreasury | null;
	/** Wall-clock time the snapshot was taken — used for
	 *  cache-staleness checks and /v1/health diagnostics. */
	readonly resolvedAt: Date;
	/** True iff at least one of btc/xmr came from chain-pinned
	 *  source.  Surfaced by /v1/health for operator visibility. */
	readonly hasChainPin: boolean;
}

/** Env-var fallback values, supplied by the indexer config. */
export interface TreasurySourceEnvFallback {
	readonly btcAddress: string;
	readonly btcSatoshis: number;
	readonly xmrAddress: string;
	readonly xmrPiconero: string;
}

/** Internal shape of the chain-pinned treasury value as it lives
 *  in the `releases.treasury` JSONB column.  Either chain may be
 *  null inside the object.
 *
 *  Part 107: XMR carries address+piconero only.  The view key
 *  is NEVER chain-pinned (privacy invariant).
 *
 *  Part 109: the view key concept is gone from the indexer
 *  entirely.  If a historical row still contains a `viewkey`
 *  field (Part 106 transitional), the resolver silently
 *  strips it — no path reads or stores it. */
interface ChainTreasuryRow {
	btc: { address: string; satoshis: number } | null;
	xmr: { address: string; piconero: string } | null;
}

export class TreasurySource {
	private cached: TreasurySnapshot | null = null;
	private inFlight: Promise<TreasurySnapshot> | null = null;

	constructor(
		private readonly db: Database,
		private readonly env: TreasurySourceEnvFallback,
		/** Cache TTL in milliseconds.  Default 30s.  Release ops
		 *  are signed and rare, so the cache absorbs most of the
		 *  per-poll-cycle hit count without the operator ever
		 *  noticing the latency. */
		private readonly cacheTtlMs: number = 30_000,
		/** Optional clock injection for tests. */
		private readonly now: () => number = () => Date.now()
	) {}

	/** Returns the current treasury snapshot, refreshing from the
	 *  DB if the cache has aged past the TTL.  Concurrent callers
	 *  share the same in-flight DB query (request-coalescing).
	 *
	 *  Never throws.  On a DB error, falls back to env-only and
	 *  logs the failure. */
	async current(): Promise<TreasurySnapshot> {
		const cached = this.cached;
		if (cached !== null && this.now() - cached.resolvedAt.getTime() < this.cacheTtlMs) {
			return cached;
		}

		// Coalesce concurrent refreshes.
		if (this.inFlight !== null) return this.inFlight;

		this.inFlight = this.refresh().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	/** Force-refresh past the cache.  Used by tests and by the
	 *  poller when it knows a release op was just processed. */
	async refresh(): Promise<TreasurySnapshot> {
		let chain: ChainTreasuryRow | null = null;
		try {
			const res = await this.db.query<{ treasury: ChainTreasuryRow | null }>(
				`SELECT treasury
				 FROM releases
				 WHERE valid = true AND treasury IS NOT NULL
				 ORDER BY created_at DESC
				 LIMIT 1`
			);
			if (res.rowCount !== null && res.rowCount > 0) {
				chain = res.rows[0]!.treasury;
			}
		} catch (err) {
			log.warn('treasury_db_query_failed', {
				message: err instanceof Error ? err.message : String(err)
			});
			// Fall through to env-only resolution.
			chain = null;
		}

		const btc = this.resolveBtc(chain);
		const xmr = this.resolveXmr(chain);
		const snapshot: TreasurySnapshot = {
			btc,
			xmr,
			resolvedAt: new Date(this.now()),
			hasChainPin: btc?.source === 'chain' || xmr?.addressSource === 'chain'
		};
		this.cached = snapshot;
		return snapshot;
	}

	private resolveBtc(chain: ChainTreasuryRow | null): BtcTreasury | null {
		if (chain?.btc != null) {
			return {
				address: chain.btc.address,
				satoshis: chain.btc.satoshis,
				source: 'chain'
			};
		}
		if (this.env.btcAddress.length > 0 && this.env.btcSatoshis > 0) {
			return {
				address: this.env.btcAddress,
				satoshis: this.env.btcSatoshis,
				source: 'env'
			};
		}
		return null;
	}

	private resolveXmr(chain: ChainTreasuryRow | null): XmrTreasury | null {
		// Address + piconero: prefer chain-pin, fall back to env.
		// Part 109: no view key field — per-payment proofs eliminate
		// the need for any indexer to hold one.  Historical
		// release-op rows that contain a stale `viewkey` field
		// (Part 106 transitional) are simply ignored at parse time;
		// the field never propagates anywhere.
		let address: string;
		let piconero: string;
		let addressSource: 'chain' | 'env';
		if (chain?.xmr != null) {
			address = chain.xmr.address;
			piconero = chain.xmr.piconero;
			addressSource = 'chain';
		} else if (this.env.xmrAddress.length > 0 && this.env.xmrPiconero.length > 0) {
			address = this.env.xmrAddress;
			piconero = this.env.xmrPiconero;
			addressSource = 'env';
		} else {
			// Neither chain nor env has an address — XMR fees
			// disabled entirely on this instance.
			return null;
		}
		return { address, piconero, addressSource };
	}
}
