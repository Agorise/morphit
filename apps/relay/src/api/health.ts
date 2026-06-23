/**
 * Morphit relay — health endpoint.
 *
 * GET /v1/health returns a liveness/readiness probe used by both
 * the frontend (to decide whether to show a "registration temporarily
 * unavailable" banner) and external monitoring.
 *
 * Verbose mode adds the relay's current BLURT balance and an estimate
 * of how many more account creations it can fund, polled every 30
 * seconds in the background. We do NOT query the chain on every
 * /v1/health request — that would make the endpoint latency a function
 * of whichever Blurt RPC node is healthiest today, and an external
 * monitor polling every 5 seconds would turn into 5 chain reads a
 * second.
 */

import type { Hono } from 'hono';
import type { Config } from '../config/index.ts';
import type { BlurtClient } from '../blurt/client.ts';
import type { GlobalDailyCeiling } from '../policy/globalDailyCeiling.ts';
import { logger } from '$log';

const log = logger('relay-acts');

// Keep in sync with the root package.json `version`.  The
// version-consistency-smoke (Part 122 cp20) fails the build if
// this constant drifts from any other package.json or from the
// indexer's INDEXER_VERSION constant.  When bumping for a new
// release, update all 10 package.json files + this constant +
// apps/indexer/src/api/health.ts INDEXER_VERSION + the example
// response in docs/API.md in the same commit.
const VERSION = '1.0.0-beta.27';
const POLL_INTERVAL_MS = 30_000;
/** When pending_claimed_accounts drops below this, the relay
 *  rejects new create requests with relay_out_of_funds.  This
 *  gives a buffer so a TOCTOU race between health refresh and
 *  signup broadcast can't deplete the last ACT.
 *  Per ADR-0010 §4 — the relay consumes ACTs, never pays the
 *  inline fee directly. */
const MIN_PENDING_CLAIMED_ACCOUNTS = 3;

interface ChainSnapshot {
	blurt_balance: string;
	pending_claimed_accounts: number;
	last_refresh_unix: number;
	/** True on the initial render before the first poll completes. */
	stale: boolean;
}

export class HealthService {
	private snapshot: ChainSnapshot = {
		blurt_balance: 'unknown',
		pending_claimed_accounts: 0,
		last_refresh_unix: 0,
		stale: true
	};
	private poller: NodeJS.Timeout | null = null;
	/** Hysteresis for the ACT-buffer alert: true once we've alerted that
	 *  the relay is at/below the reject gate, reset when it recovers. In
	 *  memory only — a restart at worst re-alerts once (cheap; a missed
	 *  alert would be worse). This is the signal that was MISSING when a
	 *  signup failed with relay_out_of_funds but the relay still held
	 *  plenty of BLURT (the gate is ACTs, not balance) — see ADR-0010. */
	private actBufferDepleted = false;
	/** Optional reference to the signup ceiling. When present,
	 *  /v1/health?verbose=1 includes signup_stats so the indexer-
	 *  side operator-balance scanner can detect anomalous signup
	 *  volume when it fires a LOW_BALANCE alert. */
	private ceiling: GlobalDailyCeiling | null = null;
	private signupEnabled: boolean = true;

	constructor(
		private readonly cfg: Config,
		private readonly blurt: BlurtClient,
		private readonly startedHrTime: bigint
	) {}

	/** Wire the signup-drain-prevention services into the health
	 *  endpoint AFTER their construction. Optional — omitted in
	 *  the existing health-service test fixture, which tests the
	 *  pre-phase-5d behavior. */
	setSignupContext(opts: { ceiling: GlobalDailyCeiling; signupEnabled: boolean }): void {
		this.ceiling = opts.ceiling;
		this.signupEnabled = opts.signupEnabled;
	}

	/** Returns the last known pending_claimed_accounts count.  Used
	 *  by the create endpoint to short-circuit when the relay has
	 *  no ACTs to consume.  Per ADR-0010 §4 the relay never pays
	 *  the inline fee — it consumes pre-minted ACTs.  Operators
	 *  refill ACTs via the weekly mint-acts.ts ceremony. */
	pendingClaimedAccounts(): number {
		return this.snapshot.pending_claimed_accounts;
	}

	/** Returns true iff the relay has enough ACTs to safely accept a
	 *  new creation request. False means the create endpoint should
	 *  return relay_out_of_funds without touching the chain. */
	canAcceptCreation(): boolean {
		// During startup before the first poll lands we don't know the
		// ACT count. Being permissive here would let the first request
		// through against an empty pool; being restrictive would
		// starve legitimate users during startup. We choose
		// restrictive — the chain would reject a no-ACT broadcast
		// anyway, so the user-visible behavior is the same and we
		// save the round-trip.
		if (this.snapshot.stale) return false;
		return this.snapshot.pending_claimed_accounts >= MIN_PENDING_CLAIMED_ACCOUNTS;
	}

	async startPolling(): Promise<void> {
		// Initial fetch so /v1/health has fresh data on first request.
		// Tolerate failure — a chain that's unreachable at startup is
		// reported via `stale: true` until the next poll succeeds.
		await this.refresh().catch(() => {});
		this.poller = setInterval(() => {
			this.refresh().catch(() => {
				// Background poll failures are expected (transient chain
				// hiccups). They flip snapshot.stale to true and the
				// health endpoint reports accordingly. No need to log
				// every one.
			});
		}, POLL_INTERVAL_MS);
		this.poller.unref?.();
	}

	close(): void {
		if (this.poller) {
			clearInterval(this.poller);
			this.poller = null;
		}
	}

	private async refresh(): Promise<void> {
		const acct = await this.blurt.getAccount(this.cfg.relayAccount);
		if (!acct) {
			// Relay account doesn't exist on-chain. Shouldn't happen
			// past initial setup, but mark stale so canAcceptCreation
			// returns false.
			this.snapshot = { ...this.snapshot, stale: true };
			return;
		}
		this.snapshot = {
			blurt_balance: acct.balance,
			pending_claimed_accounts: acct.pending_claimed_accounts,
			last_refresh_unix: Math.floor(Date.now() / 1000),
			stale: false
		};

		// ACT-buffer alert (hysteresis). When pending_claimed_accounts
		// falls below the reject gate, the relay is ALREADY refusing
		// signups with relay_out_of_funds — regardless of BLURT balance,
		// because account creation consumes ACTs, not BLURT. This is the
		// alert that was missing when kentest3 failed silently (the relay
		// held plenty of BLURT, so the balance scanner never fired). It is
		// emitted to the journal so the matrix-bot routes it to the
		// operator's Matrix DM (module=relay-acts). With auto-mint on this
		// should be rare; when it fires, auto-mint couldn't keep up (BLURT
		// out, disabled, or minting failing) and needs operator attention.
		const pca = acct.pending_claimed_accounts;
		if (pca < MIN_PENDING_CLAIMED_ACCOUNTS) {
			if (!this.actBufferDepleted) {
				this.actBufferDepleted = true;
				log.error('act_buffer_depleted', {
					account: this.cfg.relayAccount,
					pending_claimed_accounts: pca,
					reject_gate: MIN_PENDING_CLAIMED_ACCOUNTS,
					blurt_balance: acct.balance,
					automint_enabled: this.cfg.autoMintEnabled,
					hint:
						'The relay is refusing signups (relay_out_of_funds) — it is out of ' +
						'Account Creation Tokens, NOT BLURT. If auto-mint is on, it could not ' +
						'keep up (top up liquid BLURT in this account). If off, mint ACTs.'
				});
			}
		} else if (this.actBufferDepleted) {
			this.actBufferDepleted = false;
			log.info('act_buffer_recovered', {
				account: this.cfg.relayAccount,
				pending_claimed_accounts: pca
			});
		}
	}

	register(app: Hono): void {
		app.get('/v1/health', (c) => {
			// Compact Blurt RPC-pool health for at-a-glance triage. The
			// relay broadcasts through this pool; if every endpoint is
			// unreachable, signups/listings can't post. Per-endpoint
			// detail stays in the gated verbose block.
			const rpcSnap = this.blurt.endpointSnapshot();
			const nowMs = Date.now();
			const rpcEndpointsHealthy = rpcSnap.filter((e) => e.cooldownUntil <= nowMs).length;

			const body: Record<string, unknown> = {
				status: 'ok',
				rpc_endpoints_healthy: rpcEndpointsHealthy,
				rpc_endpoints_total: rpcSnap.length
			};
			if (this.cfg.verboseHealth) {
				const elapsedNs = process.hrtime.bigint() - this.startedHrTime;
				body.version = VERSION;
				body.uptime_sec = Number(elapsedNs / 1_000_000_000n);
				body.node_version = process.versions.node;
				// Web Push delivery capability — true only when all three
				// VAPID fields are configured.  Operator-triage signal that
				// order/chat push notifications can actually be sent.
				body.web_push = this.cfg.pushEnabled;
				// ACT auto-minter status (ADR-0010 §5) for operator triage:
				// whether self-refill is on, and the thresholds it tops up to.
				// `pending_claimed_accounts` below is the live count of ACTs
				// ready for use.
				body.automint_enabled = this.cfg.autoMintEnabled;
				body.automint_target_acts = this.cfg.autoMintTargetActs;
				body.automint_low_water_acts = this.cfg.autoMintLowWaterActs;
				body.blurt_balance = this.snapshot.blurt_balance;
				body.pending_claimed_accounts = this.snapshot.pending_claimed_accounts;
				body.last_refresh_unix = this.snapshot.last_refresh_unix;
				if (this.snapshot.stale) body.stale = true;

				// Full per-endpoint RPC health (same shape the indexer
				// exposes) for deep triage of broadcast failures.
				body.rpc_endpoints = rpcSnap.map((s) => {
					const cooldownRemaining = Math.max(0, s.cooldownUntil - nowMs);
					const state =
						cooldownRemaining > 0
							? 'open'
							: s.consecutiveFailures > 0
								? 'half_open'
								: 'closed';
					return {
						url: s.url,
						state,
						consecutive_failures: s.consecutiveFailures,
						cooldown_remaining_ms: cooldownRemaining,
						ewma_latency_ms: s.ewmaLatencyMs,
						last_success_age_s:
							s.lastSuccessAt > 0 ? Math.floor((nowMs - s.lastSuccessAt) / 1000) : null
					};
				});

				// Signup-drain-prevention stats. Present only when
				// setSignupContext() has wired the ceiling in — the
				// pre-phase-5d health-service callers still work.
				if (this.ceiling !== null) {
					body.signup_stats = {
						enabled: this.signupEnabled,
						daily_ceiling: this.ceiling.getCeiling(),
						successful_today: this.ceiling.currentCount(),
						current_hour_count: this.ceiling.currentHourCount(),
						peak_hour_count: this.ceiling.peakHourCount(),
						// Peak excluding the current hour.  The anomaly
						// probe uses this for its "current ≥ 2× peak"
						// threshold (Finding N22) — without it, a fresh
						// spike that becomes the new peak makes the
						// inequality structurally unreachable.
						peak_other_hours: this.ceiling.peakHourCountExcludingCurrent(),
						resets_at: this.ceiling.resetsAt().toISOString()
					};
				}
			}
			c.header('Cache-Control', 'no-store');
			return c.json(body);
		});
	}
}
