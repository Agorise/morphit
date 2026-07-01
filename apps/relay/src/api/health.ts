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
const VERSION = '1.0.0-beta.43';
const POLL_INTERVAL_MS = 30_000;
/** Liquid-BLURT headroom (above the account_creation_fee) the relay
 *  must hold to accept a signup. Blurt disabled the ACT model at HF2,
 *  so the relay pays the fee inline per `account_create`; signup
 *  readiness is gated on liquid balance, not a pre-minted-token buffer.
 *  Covers the 2 BLURT signup dust plus a small buffer so a TOCTOU race
 *  between health refresh and broadcast can't start a signup we can't
 *  fund. */
const SIGNUP_LIQUID_MARGIN_BLURT = 3;

/** Parse a Graphene asset string ("9049.747 BLURT") to a number.
 *  Returns 0 for 'unknown'/unparseable — which fails the funding gate
 *  safely (we'd rather reject than start an unfundable signup). */
function parseBlurtAmount(s: string): number {
	const m = /^([\d.]+)\s+BLURT$/.exec(s.trim());
	return m ? Number(m[1]) : 0;
}

interface ChainSnapshot {
	blurt_balance: string;
	last_refresh_unix: number;
	/** True on the initial render before the first poll completes. */
	stale: boolean;
}

export class HealthService {
	private snapshot: ChainSnapshot = {
		blurt_balance: 'unknown',
		last_refresh_unix: 0,
		stale: true
	};
	private poller: NodeJS.Timeout | null = null;
	/** Hysteresis for the low-balance alert: true once we've alerted that
	 *  the relay's liquid BLURT is below the signup-funding threshold,
	 *  reset when it recovers. In memory only — a restart at worst
	 *  re-alerts once (cheap; a missed alert would be worse). */
	private lowBalanceAlerted = false;
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

	/** Returns true iff the relay holds enough liquid BLURT to fund a
	 *  new account creation (the account_creation_fee plus a small
	 *  margin). False means the create endpoint returns
	 *  relay_out_of_funds without touching the chain. During startup,
	 *  before the first poll lands, we don't know the balance; we choose
	 *  restrictive (the chain would reject an unfunded broadcast anyway). */
	canAcceptCreation(): boolean {
		if (this.snapshot.stale) return false;
		return (
			parseBlurtAmount(this.snapshot.blurt_balance) >=
			this.cfg.accountCreationFeeBlurt + SIGNUP_LIQUID_MARGIN_BLURT
		);
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
			last_refresh_unix: Math.floor(Date.now() / 1000),
			stale: false
		};

		// Low-balance alert (hysteresis). On Blurt the relay pays the
		// account_creation_fee inline per signup via account_create (the
		// ACT model was disabled at HF2), so signup readiness is gated on
		// the relay's LIQUID BLURT, not a token buffer. When it drops
		// below the funding floor the relay is ALREADY refusing signups
		// with relay_out_of_funds; we emit to the journal so the
		// matrix-bot routes it to the operator's Matrix DM and they can
		// top up. The indexer's operator-balance scanner also alerts on
		// low balance independently.
		const liquid = parseBlurtAmount(acct.balance);
		const fundingFloor = this.cfg.accountCreationFeeBlurt + SIGNUP_LIQUID_MARGIN_BLURT;
		if (liquid < fundingFloor) {
			if (!this.lowBalanceAlerted) {
				this.lowBalanceAlerted = true;
				log.error('relay_low_balance_for_signups', {
					account: this.cfg.relayAccount,
					blurt_balance: acct.balance,
					required_blurt: fundingFloor,
					hint:
						'The relay is refusing signups (relay_out_of_funds) — its liquid ' +
						'BLURT is below the account_creation_fee needed to create an ' +
						'account. Top up liquid BLURT in this account.'
				});
			}
		} else if (this.lowBalanceAlerted) {
			this.lowBalanceAlerted = false;
			log.info('relay_balance_recovered', {
				account: this.cfg.relayAccount,
				blurt_balance: acct.balance
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
				// Relay liquid-BLURT balance for operator triage: signups
				// pay the account_creation_fee inline per account_create
				// (the ACT model was disabled at HF2), so this balance —
				// not a token buffer — gates signup readiness.
				body.blurt_balance = this.snapshot.blurt_balance;
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
