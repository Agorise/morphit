/**
 * Morphit indexer — poller loop.
 *
 * Every `blockIntervalMs` ms, ask the chain where we are and apply
 * any irreversible blocks we haven't yet. Crash-safe: resumes from
 * `indexer_state.last_applied_block` on restart.
 *
 * The loop is a small state machine:
 *
 *   running        → normal polling (default)
 *   cooling_down   → transient error; sleep errorBackoffMs then try again
 *   stopping       → shutdown requested; finish current block then exit
 *
 * Per ADR-0008, we only apply blocks where
 *   block_num <= last_irreversible_block_num
 * so the DB never contains any op that could still be rolled back
 * by a fork. This makes reorg handling a non-concern.
 */

import type pg from 'pg';

import type { Config } from '$config';
import type { BlurtClient } from '$blurt/client';
import type { Database } from '$db/pool';
import { applyBlock } from '$indexer/dispatcher';
import { reconcileOperatorRegistrations } from '$indexer/reconcileRegistrations';
import { consumeInOrderWithPrefetch } from '$indexer/prefetch';
import { orderbookEventBus } from '$indexer/orderbookEventBus';
import { chatEventBus } from '$indexer/chatEventBus';
import { detectSuspiciousReciprocity, detectRelatedAccounts, detectOneWayPileOn, detectReviewConcentration, detectTradeConcentration } from '$indexer/signals';
import { WitnessFeePoller } from '$indexer/witnessFeePoller';
import { LowBalanceScanner } from '$indexer/lowBalanceScanner';
import { OperatorAccountBalanceScanner } from '$indexer/operatorAccountBalanceScanner';
import { FederationProbeScheduler } from '$indexer/federationProbe';
import { buildSignupAnomalyProbe } from '$indexer/signupAnomalyProbe';
import type { FeeVerifier } from '$indexer/fee/verifier';
import { BitcoinExplorerFeeVerifier } from '$indexer/fee/bitcoinExplorerVerifier';
import { MoneroProofFeeVerifier } from '$indexer/fee/moneroProofVerifier';
import type { EndpointState } from '@morphit/rpc-pool';
import { TreasurySource } from '$indexer/treasurySource';
import type { BlurtPriceSource } from '$indexer/price/source';
import type { FxRateSource } from '$indexer/fx/source';
import { logger } from '$log';

const log = logger('poller');

const INDEXER_STATE_ID = 1;

/** Describes how the poller was last initialized — exposed for the
 *  /v1/health endpoint via the PollerStatus accessor. */
export interface PollerStatus {
	readonly running: boolean;
	readonly chainHeadBlock: number;
	readonly indexedBlock: number;
	readonly startedAt: Date;
	readonly lastError: string | null;
	readonly lastErrorAt: Date | null;
}

/** Read or initialise the persistent state row. On first boot the
 *  row is created with `startBlock - 1` as last-applied, so the next
 *  block to process is exactly `startBlock`. */
async function ensureStateRow(
	db: Database,
	config: Config
): Promise<{ lastApplied: number; chainId: string }> {
	const existing = await db.query<{
		last_applied_block: string;
		chain_id: string;
	}>(
		`SELECT last_applied_block::text, chain_id
		 FROM indexer_state WHERE id = $1`,
		[INDEXER_STATE_ID]
	);
	if (existing.rowCount === 1) {
		const row = existing.rows[0]!;
		return {
			lastApplied: parseInt(row.last_applied_block, 10),
			chainId: row.chain_id
		};
	}
	// First boot — initialise.
	await db.query(
		`INSERT INTO indexer_state (id, last_applied_block, chain_id)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (id) DO NOTHING`,
		[INDEXER_STATE_ID, Math.max(0, config.startBlock - 1), config.chainId]
	);
	return {
		lastApplied: Math.max(0, config.startBlock - 1),
		chainId: config.chainId
	};
}

/** Update last_applied_block in the same transaction where the
 *  block's ops were written. Never call this outside a tx. */
async function markApplied(client: pg.PoolClient, blockNum: number): Promise<void> {
	await client.query(
		`UPDATE indexer_state SET
			last_applied_block = $1,
			last_applied_at = NOW()
		 WHERE id = $2`,
		[blockNum, INDEXER_STATE_ID]
	);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}

/** The Poller is a long-lived object — constructed once, `run()` is
 *  called to drive the loop, `stop()` triggers graceful shutdown. */
/** v1.7.5 (t.txt #4) — blocks per JSON-RPC batch during catch-up.
 *
 *  20 is a deliberate middle: it cuts catch-up request count by 20x (a 5,000
 *  block backlog goes from 5,000 requests to 250), while keeping any single
 *  response small enough that a node isn't asked to marshal megabytes at once
 *  and a timeout doesn't discard much work. It also stays well under the pool's
 *  per-endpoint budget, so one batch is one paced request, not a burst.
 *
 *  Not operator-tunable on purpose: the number that matters here belongs to the
 *  node operators we are asking to carry us, not to whoever runs this instance.
 */
const BLOCK_FETCH_BATCH = 20;

export class Poller {
	private readonly startedAt = new Date();
	private status: PollerStatus;
	private readonly abort = new AbortController();
	/** Last time the signal-detection pass ran (or 0 if never). */
	private lastSignalsAt = 0;
	/** Witness-fee poller — hourly cadence baked in. Separate
	 *  tracker so it can evolve independently of the signal
	 *  cadence. */
	private readonly witnessFeePoller: WitnessFeePoller;
	private readonly lowBalanceScanner: LowBalanceScanner;
	private readonly operatorBalanceScanner: OperatorAccountBalanceScanner;
	private readonly federationProbe: FederationProbeScheduler;
	/** Fee verifiers for BTC/XMR orders. Built initially from
	 *  env-var fallbacks in the constructor; subsequently
	 *  rebuilt by `refreshFeeVerifiersFromTreasury()` whenever
	 *  the chain-pinned treasury (Part 106 — `releases.treasury`)
	 *  resolves to an address different from what the active
	 *  verifier was constructed with.  Mutable on purpose: the
	 *  fork-attack defense requires verifiers to follow the
	 *  chain-pinned canonical without an indexer restart.
	 *  Undefined entries mean the corresponding fee method has
	 *  no address available (chain or env) — the order handler
	 *  rejects orders claiming an unconfigured method with a
	 *  clear reason code. */
	private feeVerifiers: {
		btc?: BitcoinExplorerFeeVerifier;
		xmr?: MoneroProofFeeVerifier;
	};
	/** Tracks the address each active verifier was constructed
	 *  with, so refreshFeeVerifiersFromTreasury() can detect
	 *  when a rebuild is needed.  Undefined when no verifier
	 *  is currently active for that chain. */
	private feeVerifierAddresses: {
		btc?: string;
		xmr?: string;
	} = {};
	/** Part 106 — canonical fee amounts in the asset's smallest
	 *  unit, resolved from the same TreasurySource as the
	 *  verifiers above.  Threaded through to the order handler
	 *  via OpContext.feeAmounts so a hostile fork can't
	 *  underprice their env satoshis/piconero independently of
	 *  the chain-pinned address. */
	private feeAmounts: {
		btcSatoshis?: number;
		xmrPiconero?: bigint;
		/** cp372 — chain-pinned BLURT fee base (tier-1, pre-multiplier),
		 *  resolved chain-pin > env by the same TreasurySource.  Threaded
		 *  to the order handler so the BLURT floor is deterministic across
		 *  the federation rather than each node's own env value. */
		blurtBase?: number;
	} = {};
	/** Source of truth for "what address should the verifiers
	 *  be checking right now?" — chain-pinned takes precedence
	 *  over env, with env as bootstrap fallback.  See
	 *  treasurySource.ts for the resolution policy. */
	private readonly treasurySource: TreasurySource;

	/** Snapshot of every configured explorer's health (EWMA latency,
	 *  consecutive failures, cooldown deadline) merged across the
	 *  BTC and XMR verifiers.  `/v1/health?verbose=1` calls this to
	 *  render the per-explorer health table for the operator.
	 *
	 *  cp166 — replaces the old shared `explorerBreaker` field
	 *  (CircuitBreaker).  Each verifier now owns its own EndpointPool
	 *  with latency-aware ordering; this accessor merges their
	 *  snapshots into one list keyed by URL.  Strict superset of
	 *  what the breaker exposed — adds EWMA latency. */
	get explorerHealthSnapshot(): readonly EndpointState[] {
		const out: EndpointState[] = [];
		const btc = this.feeVerifiers.btc;
		if (btc !== undefined) {
			out.push(...btc.endpointSnapshot());
		}
		const xmr = this.feeVerifiers.xmr;
		if (xmr !== undefined) {
			out.push(...xmr.endpointSnapshot());
		}
		return out;
	}

	/** Health of the Blurt RPC endpoint pool that polls blocks — the
	 *  pool whose endpoints all going dead froze sync in the beta5
	 *  firefight.  Distinct from `explorerHealthSnapshot` (external
	 *  BTC/XMR fee-verification explorers); this is the chain feed the
	 *  indexer itself depends on.  Exposed on /v1/health so an operator
	 *  triaging a stalled sync can see at a glance whether their RPC
	 *  endpoints are reachable. */
	get rpcEndpointSnapshot(): readonly EndpointState[] {
		return this.blurt.endpointSnapshot();
	}

	constructor(
		private readonly config: Config,
		private readonly db: Database,
		private readonly blurt: BlurtClient,
		private readonly priceSource: BlurtPriceSource | null,
		/** USD→fiat FX source for the FX-aware first-order floor.
		 *  null when the operator has disabled the FX feed — the
		 *  floor then falls back to USD-only treatment (see
		 *  fiatToUsd below). */
		private readonly fxSource: FxRateSource | null = null
	) {
		this.witnessFeePoller = new WitnessFeePoller(db, blurt);
		this.lowBalanceScanner = new LowBalanceScanner(
			db,
			blurt,
			config.relayAccount,
			{
				intervalMs: config.lowBalanceRefillIntervalMs,
				thresholdBlurt: config.lowBalanceThresholdBlurt,
				activityWindowDays: config.lowBalanceActivityWindowDays,
				refillCooldownDays: config.lowBalanceRefillCooldownDays,
				refillAmountBlurt: config.lowBalanceRefillAmountBlurt,
				maxBatch: config.lowBalanceMaxBatch
			},
			config.instanceOperatorTag
		);
		this.operatorBalanceScanner = new OperatorAccountBalanceScanner(blurt, {
			intervalMs: config.operatorBalanceIntervalMs,
			accounts: [
				{
					name: config.relayAccount,
					thresholdBlurt: config.operatorBalanceRelayThresholdBlurt,
					role: 'relay'
				},
				{
					name: config.feeRecipient,
					thresholdBlurt: config.operatorBalanceFeesThresholdBlurt,
					role: 'fees'
				}
			],
			failureAlertThreshold: config.operatorBalanceFailureAlertThreshold,
			// Wire the anomaly probe iff the operator set
			// MORPHIT_INDEXER_RELAY_HEALTH_URL. Empty string → no
			// probe → scanner attaches no anomaly field, which is
			// the same pre-feature behavior. When configured, the
			// probe fetches the relay's /v1/health?verbose=1 to
			// judge whether a LOW_BALANCE alert should carry a
			// kill-switch recommendation.
			signupAnomalyProbe:
				config.relayHealthUrl.length > 0
					? buildSignupAnomalyProbe(config.relayHealthUrl)
					: undefined
		});

		// Phase D.5 — federation probe scheduler.  Walks the
		// known_instances table picking instances due for probing,
		// fans out HTTP requests to /v1/instance + /v1/health +
		// /v1/orderbook, classifies status, persists.  Self-
		// throttling: scanOnce ticks once per intervalMs from the
		// poller loop.  No opt-out — federation discovery is
		// always-on so users on this instance can find others.
		//
		// 15-second tick keeps newly-registered peers visible
		// quickly: a register op landing on chain → another
		// indexer's chain replay (≤3s for the next block) →
		// known_instances row inserted with status='never' → next
		// scheduler tick (≤15s) sees it as probe-due and fires the
		// HTTP probe.  Median time from broadcast to peer-shows-up:
		// ~30 seconds.
		this.federationProbe = new FederationProbeScheduler(db, {
			intervalMs: 15_000,
			// Don't network-probe our own public URL (hairpin-NAT fragile).
			// Prefer the explicit instanceOrigin; otherwise derive the
			// instance origin from the indexer's public origin by stripping
			// a leading "indexer." subdomain (same transform the RSS
			// self-URL builder uses), so this matches the directory row for
			// both same-origin and indexer-subdomain deploys.
			selfOrigin: config.instanceOrigin ?? config.publicOrigin.replace(/\/\/indexer\./, '//'),
			// Our own chain lag, read straight from the poller state (no HTTP),
			// so the self-reachable row can show 'syncing' while catching up.
			localLagBlocks: () => {
				const st = this.getStatus();
				if (!st.running || st.chainHeadBlock <= 0) return null;
				return Math.max(0, st.chainHeadBlock - st.indexedBlock);
			},
			// cp311: our own branding, straight from config (same values
			// /v1/instance serves).  The self row is never network-probed,
			// so this is the ONLY way its cached_name/tagline/contact/alt
			// columns get populated — without it the operator's own
			// directory card is stuck on the operator-account fallback.
			selfBranding: () => ({
				name: config.instanceName ?? null,
				tagline: config.instanceTagline ?? null,
				contactUrl: config.instanceContactUrl ?? null,
				altNetworks: {
					tor: config.instanceTorAddress ?? null,
					lokinet: config.instanceLokinetAddress ?? null,
					i2p_b32: config.instanceI2pB32Address ?? null,
					i2p_name: config.instanceI2pNameAddress ?? null,
					ens: config.instanceEnsName ?? null,
					nostr: config.instanceNostrPubkey ?? null
				}
			}),
			// cp316: the resolved (chain-pin > env > canonical default)
			// treasury addresses THIS indexer verifies against.  The
			// probe compares each peer's advertised /v1/instance treasury
			// against this; a non-null divergence → 'mismatch' (a peer
			// trying to redirect fee payments to a non-canonical address).
			canonicalTreasury: () => this.currentTreasuryAddresses()
		});

		// ADR-0011 sub-phase 4b: fee verifiers. Build each only if
		// an address is available — initially from env-var
		// cp166 — each verifier now owns its own EndpointPool with
		// per-explorer latency tracking + cooldown ladder.  The
		// poller no longer instantiates a shared CircuitBreaker;
		// the `explorerHealthSnapshot` accessor above merges both
		// verifiers' pool snapshots into the unified per-URL view
		// `/v1/health?verbose=1` exposes.

		// TreasurySource is the resolution layer between "what
		// address should the verifier check?" and the two
		// possible answers (chain-pinned via release op,
		// env-var fallback otherwise).  See treasurySource.ts.
		// We pass env-var fallbacks here; refreshFeeVerifiers...()
		// queries the DB for chain-pinned values and prefers
		// those when present.
		this.treasurySource = new TreasurySource(db, {
			btcAddress: config.btcFeeAddress,
			btcSatoshis: config.btcFeeSatoshis,
			xmrAddress: config.xmrFeeAddress,
			xmrPiconero: config.xmrFeePiconero.toString(),
			blurtBase: config.feeBaseBlurt
		});

		// Initial verifiers — built from env-only at construction
		// time because we can't await in a constructor.  The first
		// poller-loop tick calls refreshFeeVerifiersFromTreasury()
		// which DOES await the DB and rebuilds with chain-pinned
		// addresses if a treasury-bearing release op is already
		// in the table.  Worst case: one block applied with the
		// env-var address before the chain-pin takes over.
		this.feeVerifiers = {};
		this.buildVerifiersFromBootstrap();

		this.status = {
			running: false,
			chainHeadBlock: 0,
			indexedBlock: 0,
			startedAt: this.startedAt,
			lastError: null,
			lastErrorAt: null
		};
	}

	/** Bootstrap-time verifier construction.  Called once from
	 *  the constructor with env-only values — no DB access, since
	 *  the constructor is sync.  The first poller-loop tick then
	 *  calls refreshFeeVerifiersFromTreasury() which does query
	 *  the DB and rebuilds with chain-pinned values when present.
	 *
	 *  Worst case: one block applied with the env-var address
	 *  before the chain-pin takes over.  In practice the loop
	 *  refresh happens before any block is processed in run(),
	 *  so even that one-block window is unlikely. */
	private buildVerifiersFromBootstrap(): void {
		const envBtcAddress = this.config.btcFeeAddress;
		const envBtcSatoshis = this.config.btcFeeSatoshis;
		if (envBtcAddress.length > 0 && this.config.btcExplorerUrls.length > 0) {
			this.feeVerifiers.btc = new BitcoinExplorerFeeVerifier(
				{
					feeAddress: envBtcAddress,
					explorerUrls: this.config.btcExplorerUrls,
					minConfirmations: 1,
					requestTimeoutMs: 5_000,
					minSuccessfulResponses: this.config.btcMinSuccessfulResponses
				}
			);
			this.feeVerifierAddresses.btc = envBtcAddress;
			this.feeAmounts.btcSatoshis = envBtcSatoshis;
		}
		if (
			this.config.xmrFeeAddress.length > 0 &&
			this.config.xmrExplorerUrls.length > 0
		) {
			// Part 108++ — no view key required.  Per-payment proof
			// verification is the new design; the indexer holds NO
			// xmr secrets.  Part 109 removed the `xmrFeeViewKey`
			// config field entirely.
			this.feeVerifiers.xmr = new MoneroProofFeeVerifier(
				{
					feeAddress: this.config.xmrFeeAddress,
					explorerUrls: this.config.xmrExplorerUrls,
					minConfirmations: 1,
					requestTimeoutMs: 10_000,
					minSuccessfulResponses: this.config.xmrMinSuccessfulResponses
				}
			);
			this.feeVerifierAddresses.xmr = this.config.xmrFeeAddress;
			this.feeAmounts.xmrPiconero = this.config.xmrFeePiconero;
		}
		// cp372 — BLURT is always an accepted fee method; seed the
		// base from env at bootstrap.  The first treasury refresh
		// replaces it with the chain-pinned value when one exists.
		this.feeAmounts.blurtBase = this.config.feeBaseBlurt;
	}

	/** Per-cycle verifier refresh — Part 106.
	 *
	 *  Called from the poller loop on each iteration.  Asks the
	 *  TreasurySource for the currently-canonical addresses
	 *  (chain-pinned takes precedence over env-var), and rebuilds
	 *  whichever verifiers reference an address that no longer
	 *  matches.  No-op for the steady-state case where the chain
	 *  pin hasn't changed.
	 *
	 *  Why per-cycle and not per-block: release ops are signed
	 *  and rare (a few per year at most).  TreasurySource's
	 *  internal 30s cache absorbs the per-cycle hit so the DB
	 *  cost is bounded.  Even a 1Hz poll loop only generates one
	 *  DB query every 30 seconds.
	 *
	 *  Errors are caught and logged — a transient DB hiccup
	 *  shouldn't bring down the whole indexer.  If the source
	 *  fails to resolve, we keep using the existing verifier
	 *  (last-known-good).  The TreasurySource itself falls back
	 *  to env-only on DB errors, so this is double-belt safety.
	 */
	private async refreshFeeVerifiersFromTreasury(): Promise<void> {
		let snapshot;
		try {
			snapshot = await this.treasurySource.current();
		} catch (err) {
			log.warn('treasury_refresh_failed', {
				message: err instanceof Error ? err.message : String(err)
			});
			return;
		}

		// BTC.
		const btcWanted = snapshot.btc?.address;
		const btcCurrent = this.feeVerifierAddresses.btc;
		if (btcWanted !== btcCurrent) {
			if (btcWanted === undefined) {
				// Address withdrawn — disable BTC verification.
				this.feeVerifiers.btc = undefined;
				this.feeVerifierAddresses.btc = undefined;
				this.feeAmounts.btcSatoshis = undefined;
				log.info('btc_verifier_disabled', { reason: 'no_address_available' });
			} else {
				this.feeVerifiers.btc = new BitcoinExplorerFeeVerifier(
					{
						feeAddress: btcWanted,
						explorerUrls: this.config.btcExplorerUrls,
						minConfirmations: 1,
						requestTimeoutMs: 5_000,
						minSuccessfulResponses: this.config.btcMinSuccessfulResponses
					}
				);
				this.feeVerifierAddresses.btc = btcWanted;
				log.info('btc_verifier_rebuilt', {
					source: snapshot.btc?.source ?? 'unknown'
				});
			}
		}
		// Always sync amount even if address unchanged — operator
		// might rotate the amount on the same address (e.g. price
		// move).  Cheap to update; the order handler reads it.
		if (snapshot.btc !== null) {
			this.feeAmounts.btcSatoshis = snapshot.btc.satoshis;
		} else {
			this.feeAmounts.btcSatoshis = undefined;
		}

		// XMR — Part 108++.
		//
		// The verifier no longer needs (or accepts) a view key.  Per-
		// payment tx_proof verification means the indexer holds NO
		// xmr secrets at all.  The poller rebuilds the verifier
		// only when the chain-pinned (or env-fallback) ADDRESS
		// changes; viewkey rotation is no longer a concept that
		// affects the verifier.
		//
		// When no address is available (neither chain-pin nor env),
		// the verifier is left undefined and the order handler
		// rejects xmr orders with `fee_method_not_configured_xmr`.
		const xmrWanted = snapshot.xmr?.address;
		const xmrCurrent = this.feeVerifierAddresses.xmr;
		if (xmrWanted !== xmrCurrent) {
			if (xmrWanted === undefined) {
				this.feeVerifiers.xmr = undefined;
				this.feeVerifierAddresses.xmr = undefined;
				log.info('xmr_verifier_disabled', {
					reason: 'no_address_available'
				});
			} else {
				this.feeVerifiers.xmr = new MoneroProofFeeVerifier(
					{
						feeAddress: xmrWanted,
						explorerUrls: this.config.xmrExplorerUrls,
						minConfirmations: 1,
						requestTimeoutMs: 10_000,
						minSuccessfulResponses: this.config.xmrMinSuccessfulResponses
					}
				);
				this.feeVerifierAddresses.xmr = xmrWanted;
				log.info('xmr_verifier_rebuilt', {
					addressSource: snapshot.xmr?.addressSource ?? 'unknown'
				});
			}
		}
		// Always sync the piconero amount — handles rotation case
		// where address stays but amount changes (e.g. price
		// move).  Catch the case where a hand-crafted DB row has a
		// malformed value (validateTreasury rejected it at write
		// time, so this is defense-in-depth only).
		if (snapshot.xmr !== null) {
			try {
				this.feeAmounts.xmrPiconero = BigInt(snapshot.xmr.piconero);
			} catch (err) {
				log.warn('xmr_piconero_coercion_failed', {
					value: String(snapshot.xmr.piconero).slice(0, 32),
					message: err instanceof Error ? err.message : String(err)
				});
				this.feeAmounts.xmrPiconero = undefined;
			}
		} else {
			this.feeAmounts.xmrPiconero = undefined;
		}

		// cp372 — sync the BLURT base (chain-pin > env).  BLURT is
		// always an accepted method, so resolveBlurt yields a value
		// whenever the env fallback is positive; only an operator who
		// zeroed MORPHIT_INDEXER_FEE_BASE_BLURT (with no chain-pin)
		// produces null, in which case the order handler falls back to
		// its own config read.  Always synced so a chain re-pin (the
		// auto-re-pin daemon's whole purpose) propagates within one
		// poll cycle.
		if (snapshot.blurt !== null) {
			this.feeAmounts.blurtBase = snapshot.blurt.base;
		}
	}

	/** Start the loop. Resolves only when `stop()` is called (or on
	 *  a fatal, non-recoverable error). */
	async run(): Promise<void> {
		// Chain-id pinning — first-boot initialises, subsequent boots
		// defend against accidentally-switched networks.
		const { lastApplied, chainId } = await ensureStateRow(this.db, this.config);
		if (chainId !== this.config.chainId) {
			throw new Error(
				`chain_id mismatch: DB recorded ${chainId}, config says ${this.config.chainId}. ` +
					`Refusing to boot — resetting the DB is the correct fix if the chain really changed.`
			);
		}

		this.status = { ...this.status, indexedBlock: lastApplied, running: true };
		log.info('starting', {
			chain_id_prefix: chainId.slice(0, 8),
			last_applied_block: lastApplied
		});

		// cp710 — one-shot reconciliation of operator registrations this
		// indexer previously recorded as REJECTED.  Self-heals the case
		// where a validator bug (e.g. cp670 regional-brand names, cp671
		// Persian ZWNJ) wrongly rejected a valid registration: once the
		// fixed indexer boots, the already-rejected op is replayed through
		// the idempotent handler and materialised.  Safe no-op when there's
		// nothing to heal; never touches non-idempotent (order/fee) ops.
		// Best-effort: a failure here must not stop the poller from serving.
		try {
			await reconcileOperatorRegistrations({
				db: this.db,
				blurt: this.blurt,
				config: this.config,
				feeVerifiers: this.feeVerifiers,
				feeAmounts: this.feeAmounts,
				fiatToUsd: (amount: number, fiat: string): number | null => {
					if (this.fxSource) return this.fxSource.fiatToUsd(amount, fiat);
					if (fiat.trim().toUpperCase() === 'USD') return Number.isFinite(amount) ? amount : null;
					return null;
				},
				log: (msg, meta) => log.info(msg, meta ?? {})
			});
		} catch (err) {
			log.error('reconcile_registrations_failed', {}, err instanceof Error ? err : undefined);
		}

		while (!this.abort.signal.aborted) {
			try {
				// Part 106 — per-cycle treasury refresh.  Reads
				// the most recent valid release op's treasury
				// block and rebuilds the BTC/XMR verifiers if the
				// canonical address has changed.  TreasurySource
				// caches internally (30s default) so the DB cost
				// is amortized; this call is cheap.
				await this.refreshFeeVerifiersFromTreasury();
				await this.tick();
				await this.maybeRunSignals();
				// Witness fee poll is self-throttling (hourly). Safe
				// to call every tick; it no-ops between intervals.
				// Errors are captured by the poller itself and
				// surfaced via alert sink, so a propagated throw
				// here would be an unexpected bug worth seeing.
				await this.witnessFeePoller.maybePoll();
				// Low-balance refill scanner — self-throttling every
				// few hours. Same rationale as witnessFeePoller: safe
				// to call every tick, errors captured internally.
				await this.lowBalanceScanner.maybeScan();
				// Operator-account balance monitoring — self-
				// throttling every 15 min by default. Fires alerts
				// via the AlertSink when relay/fees cross below
				// operator-configured thresholds. Opt-in: disabled
				// when both thresholds are 0 (the default).
				await this.operatorBalanceScanner.maybeScan();
				// Federation probe — self-throttling per-instance
				// (10min for healthy, 1h for failing); the scheduler
				// itself ticks every minute, then internally decides
				// which (if any) instances are due.  Errors caught
				// internally and logged.
				await this.federationProbe.maybeScan();
			} catch (err) {
				this.status = {
					...this.status,
					lastError: err instanceof Error ? err.message : String(err),
					lastErrorAt: new Date()
				};
				log.error('tick_failed', { backoff_ms: this.config.errorBackoffMs }, err);
				await sleep(this.config.errorBackoffMs, this.abort.signal);
			}
		}

		this.status = { ...this.status, running: false };
		log.info('stopped_gracefully');
	}

	/** One poll iteration. Fetches as many irreversible blocks as
	 *  are available and applies them. Exits when caught up, after
	 *  which the outer loop sleeps for one block interval. */
	private async tick(): Promise<void> {
		const dgp = await this.blurt.getDynamicGlobalProperties();
		this.status = {
			...this.status,
			chainHeadBlock: dgp.head_block_number
		};

		const irreversible = dgp.last_irreversible_block_num;
		const from = this.status.indexedBlock + 1;
		if (from > irreversible) {
			// Caught up — sleep and come back.
			await sleep(this.config.blockIntervalMs, this.abort.signal);
			return;
		}

		// ─── Concurrent prefetch, strictly in-order apply (cp664) ────────────
		// The DB write and the volunteer-run RPC nodes want opposite things: the
		// DB wants small, in-order transactions; the nodes want few, spread-out
		// requests. We satisfy both. The FETCH is parallelised — up to
		// `concurrency` windows are in flight AT ONCE, each fired at a DIFFERENT
		// endpoint (pool startOffset rotation) so no single node is dogpiled and a
		// stalled node's window transparently falls back through the pool to
		// another. The APPLY is unchanged: strictly ascending block order, one-
		// block-per-tx (so a long catch-up never holds a tx open for minutes,
		// holding locks + bloating WAL). The FIFO/in-order guarantee lives in the
		// `consumeInOrderWithPrefetch` helper (covered by prefetch-in-order-smoke);
		// this method supplies only the window fetch + the block apply.
		type FetchedBlocks = Awaited<ReturnType<BlurtClient['getBlocks']>>;
		const endpointCount = Math.max(1, this.blurt.endpointCount());
		const concurrency =
			this.config.backfillConcurrency > 0 ? this.config.backfillConcurrency : endpointCount;

		let nextLo = from;
		let windowSeq = 0;

		// Start the next window's fetch, rotating its STARTING endpoint so
		// concurrent windows spread across nodes. Returns null when the backlog to
		// `irreversible` is exhausted. Tagged with `lo` so the consumer knows each
		// block's number without re-deriving it.
		const startNextWindow = (): Promise<{ lo: number; blocks: FetchedBlocks }> | null => {
			if (nextLo > irreversible) return null;
			const lo = nextLo;
			const hi = Math.min(lo + BLOCK_FETCH_BATCH - 1, irreversible);
			const window: number[] = [];
			for (let b = lo; b <= hi; b++) window.push(b);
			const offset = windowSeq % endpointCount;
			windowSeq++;
			nextLo = hi + 1;
			return this.blurt.getBlocks(window, offset).then((blocks) => ({ lo, blocks }));
		};

		// Apply one fetched window's blocks in strict ascending order, in a SINGLE
		// bounded transaction per window (cp666 — the fetch batch is also the apply
		// batch). Wrapping the ≤BLOCK_FETCH_BATCH-block window in one withTx
		// amortises the per-commit fsync ~BLOCK_FETCH_BATCH× — the change that
		// turns a multi-hour backfill on a home-server disk into minutes. The tx
		// stays SHORT (one window, never the whole catch-up): a single tx spanning
		// the entire sync would hold locks for hours and keep bloating WAL, which
		// is exactly what we still refuse to do — so we cap the tx at one window.
		// Postgres makes this crash-safe for free: the window commits atomically or
		// not at all, so a crash mid-window rolls back cleanly and the outer loop
		// resumes from the persisted markApplied cursor — no partial or corrupt
		// state is possible. Returns false to STOP the pipeline (abort, or a node
		// returned a hole we must re-fetch next tick); the valid PREFIX applied
		// before the stop is COMMITTED, never discarded.
		const applyWindow = async ({
			lo,
			blocks
		}: {
			lo: number;
			blocks: FetchedBlocks;
		}): Promise<boolean> => {
			// Per-block side-effects (status advance + bus emissions + logs) are
			// COLLECTED here and flushed ONLY AFTER the window tx commits, so an SSE
			// subscriber never sees an event from a block that later rolled back and
			// indexedBlock never advances past a block that didn't commit.
			type Committed = {
				n: number;
				orderbookChanges: readonly string[];
				chatChanges: readonly { lo: string; hi: string; messageId: number }[];
				applied: number;
				rejected: number;
			};
			const committed: Committed[] = [];
			let stop = false; // hole or abort → commit the prefix, then stop the pipeline
			let holeBackoff = false;
			let lastAppliedN = -1;

			await this.db.withTx(async (client) => {
				for (let i = 0; i < blocks.length; i++) {
					// Abort mid-window: break so the tx COMMITS the prefix applied so
					// far (progress is saved), then stop the pipeline below. A throw
					// here would roll the whole window back — also safe, just wasteful
					// — so we prefer the clean commit-prefix.
					if (this.abort.signal.aborted) {
						stop = true;
						break;
					}
					const n = lo + i;
					const block = blocks[i]!;
					if (!block) {
						// Chain said it was irreversible but the node hasn't served it
						// yet — endpoint inconsistency. Commit the prefix (lo..n-1), back
						// off, and stop; the outer loop re-fetches from indexedBlock next
						// tick. Nothing at/after `n` is applied.
						log.warn('block_not_returned', { block: n });
						stop = true;
						holeBackoff = true;
						break;
					}

					const result = await applyBlock(
						client,
						n,
						block,
						this.blurt,
						this.config,
						this.feeVerifiers,
						this.feeAmounts,
						// FX-aware first-order floor converter.  When the FX
						// feed is live (default) this routes through the
						// composite FX source (which itself falls back to a
						// static rate table during an outage).  When the
						// operator has disabled the feed, it degrades to a
						// USD-only identity: USD converts 1:1, any other
						// currency returns null and the order handler falls
						// back to the documented direct comparison.
						(amount: number, fiat: string): number | null => {
							if (this.fxSource) return this.fxSource.fiatToUsd(amount, fiat);
							if (fiat.trim().toUpperCase() === 'USD') {
								return Number.isFinite(amount) ? amount : null;
							}
							return null;
						}
					);
					committed.push({
						n,
						orderbookChanges: result.orderbookChanges,
						chatChanges: result.chatChanges,
						applied: result.applied,
						rejected: result.rejected
					});
					lastAppliedN = n;
				}
				// Advance the persisted cursor ONCE, inside the same tx, so the
				// committed block range and the cursor move atomically. (No block
				// applied — e.g. the first block was a hole — leaves the cursor
				// untouched and the tx a no-op.)
				if (lastAppliedN >= 0) {
					await markApplied(client, lastAppliedN);
				}
			});

			// ── Post-commit (the withTx above COMMITTED the prefix) ──
			// Flush the collected side-effects for every block that actually
			// committed, in order. If withTx had THROWN (e.g. an applyBlock error),
			// execution would have propagated out of applyWindow before reaching
			// here — so nothing below runs for a rolled-back window, and no phantom
			// event or cursor advance escapes.
			for (const c of committed) {
				this.status = { ...this.status, indexedBlock: c.n, lastError: null };
				// Phase E — orderbook-change events on the in-process bus.
				for (const orderId of c.orderbookChanges) {
					orderbookEventBus.emit(orderId);
				}
				// Phase E.5 — same pattern for chat-message events.
				for (const ev of c.chatChanges) {
					chatEventBus.emit(ev);
				}
				// Only log non-trivial blocks to avoid spam; most blocks
				// have zero morphit ops.
				if (c.applied + c.rejected > 0) {
					log.info('block_applied', { block: c.n, applied: c.applied, rejected: c.rejected });
				}
			}

			if (holeBackoff) {
				await sleep(this.config.errorBackoffMs, this.abort.signal);
			}
			return !stop;
		};

		try {
			await consumeInOrderWithPrefetch(concurrency, startNextWindow, applyWindow);
		} catch (err) {
			// A window's fetch rejected — the pool exhausted every endpoint for it.
			// Blocks already applied this tick are committed; stop + back off and the
			// outer loop retries from indexedBlock next tick. No block is skipped.
			log.warn('backfill_window_unavailable', { error: String(err) });
			await sleep(this.config.errorBackoffMs, this.abort.signal);
			return;
		}
	}

	/** Periodic signal-detection pass (self-trade heuristics per
	 *  ADR-0009 §5). Runs at most once per SIGNALS_INTERVAL_MS.
	 *  Failures are logged but swallowed — signal detection is
	 *  advisory and must never halt block processing. */
	private async maybeRunSignals(): Promise<void> {
		const SIGNALS_INTERVAL_MS = 60 * 60 * 1000; // 1h
		const now = Date.now();
		if (now - this.lastSignalsAt < SIGNALS_INTERVAL_MS) return;
		this.lastSignalsAt = now;
		try {
			const flaggedA = await detectRelatedAccounts(this.db, {
				// Exclude the relay account from the "same creator"
				// pair signal — it creates the majority of onboarded
				// accounts, so creator-match against it is normal
				// coincidence, not evidence of relation (Finding N28).
				excludeCreators: [this.config.relayAccount]
			});
			if (flaggedA > 0) {
				log.info('signal_a_flagged', { new_pairs: flaggedA });
			}
		} catch (err) {
			log.error('signal_a_failed', {}, err);
		}
		try {
			const flaggedB = await detectSuspiciousReciprocity(this.db);
			if (flaggedB > 0) {
				log.info('signal_b_flagged', { new_pairs: flaggedB });
			}
		} catch (err) {
			log.error('signal_b_failed', {}, err);
		}
		try {
			// Signal C — one-way pile-on detection (Part 113).
			// Catches coordinated low-star attacks from clusters
			// of newly-active accounts with narrow review diversity.
			// Companion to Signals A and B; same advisory-not-
			// dispositive treatment.
			const flaggedC = await detectOneWayPileOn(this.db);
			if (flaggedC > 0) {
				log.info('signal_c_flagged', { new_subjects: flaggedC });
			}
		} catch (err) {
			log.error('signal_c_failed', {}, err);
		}
		try {
			// Signal D — review-concentration detection (cp123 H2).
			// Closes Part 113 A4 "Signal B evasion via diversification."
			// Catches reviewers who concentrate ≥80% of their reviews
			// on a single high-star target across a 30-day window,
			// even if they also reviewed a few throwaway third parties
			// to evade Signal B's stricter distinct_subjects=1 filter.
			const flaggedD = await detectReviewConcentration(this.db);
			if (flaggedD > 0) {
				log.info('signal_d_flagged', { new_pairs: flaggedD });
			}
		} catch (err) {
			log.error('signal_d_failed', {}, err);
		}
		try {
			// Signal E — completed-trade concentration (v1.5.5).
			// The TRADE analogue of Signal D. v1.5.5 credits the counterparty
			// an order owner NAMES, and the provable-counterparty bar it must
			// clear is per-PAIR, not per-trade — so after one genuine
			// conversation an owner could keep completing orders naming the
			// same confederate and mint a trade credit per listing fee,
			// forever. None of the review signals see it (suspicious_
			// reciprocity watches mutual REVIEWS). This flags an account whose
			// trade credits are ≥80% concentrated on one peer across the
			// window; TRADE_COUNT_SQL then stops counting those credits.
			const flaggedE = await detectTradeConcentration(this.db);
			if (flaggedE > 0) {
				log.info('signal_e_flagged', { new_pairs: flaggedE });
			}
		} catch (err) {
			log.error('signal_e_failed', {}, err);
		}
	}

	/** Ask the loop to stop at the next safe boundary. */
	stop(): void {
		log.info('stop_requested');
		this.abort.abort();
	}

	/** Current status snapshot — safe to call concurrently with
	 *  run(). Returned object is immutable. */
	getStatus(): PollerStatus {
		return this.status;
	}

	/** Current chain account_creation_fee snapshot. Returns the
	 *  fallback value if no successful poll has completed yet
	 *  (indicated by fromChain=false on the returned snapshot).
	 *  Safe to call concurrently with run(); does no I/O. */
	getCurrentFeeSnapshot() {
		return this.witnessFeePoller.getCurrentFee();
	}

	/** Current operator-account balance scanner state — a
	 *  snapshot of (account → {below, lastObservedBlurt}). Used
	 *  by /v1/health to surface which monitored accounts are
	 *  currently below threshold without waiting for the next
	 *  alert. Safe to call concurrently with run(); does no I/O. */
	getOperatorBalanceState() {
		return this.operatorBalanceScanner.getCurrentState();
	}

	/** cp316 — the RESOLVED treasury addresses the fee verifiers are
	 *  currently checking against: chain-pinned release op > operator
	 *  env > baked canonical default (treasurySource.ts resolution).
	 *  `feeVerifierAddresses` is re-synced every loop by
	 *  refreshFeeVerifiersFromTreasury(), so this follows a
	 *  chain-pin rotation within one poll cycle.  null = that method
	 *  has no address (disabled on this instance).  Surfaced on
	 *  /v1/instance (so peers can audit it) and used as the canonical
	 *  reference by the federation probe's treasury-mismatch check.
	 *  Safe to call concurrently with run(); does no I/O. */
	currentTreasuryAddresses(): { btc: string | null; xmr: string | null } {
		return {
			btc: this.feeVerifierAddresses.btc ?? null,
			xmr: this.feeVerifierAddresses.xmr ?? null
		};
	}
}
