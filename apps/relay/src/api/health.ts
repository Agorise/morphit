/**
 * Morphit relay — health endpoint.
 *
 * GET /v1/health returns a liveness/readiness probe used by both
 * the frontend (to decide whether to show a "registration temporarily
 * unavailable" banner) and external monitoring.
 *
 * WHO SEES WHAT. Anyone: `status`, `rpc_ok` (at least one RPC endpoint is
 * out of cooldown) and `hidden_only` — the same coarse shape as the
 * indexer's public health. The operator block — version and uptime,
 * Node.js version, relay balance and live fee, the healthy / total RPC
 * endpoint counts and the full per-endpoint list with each node's state, the payment queue and the signup counters —
 * only for a LOCAL caller: a request carrying `X-Morphit-Local-Health: 1` and
 * none of the forwarding headers every public edge adds (X-Forwarded-For,
 * X-Real-IP, X-Forwarded-Proto — ops/nginx/web.conf, relay.conf and the
 * BunkerWeb frontend each set at least one). The edges also overwrite the
 * local header with an empty value; either check alone keeps an anonymous
 * caller out. Local callers: the indexer's signup-anomaly probe and
 * `morphit-ops health`. MORPHIT_RELAY_VERBOSE_HEALTH=true is an
 * explicit operator opt-in to serve the block to everyone (default off). It
 * used to be on by default and public: live signup volume and headroom, the
 * node's RPC topology (on a hidden node, its own .onion/.b32.i2p endpoints)
 * and the exact Node.js version, to any anonymous caller.
 *
 * The balance and fee are polled every 30 seconds in the background. We do
 * NOT query the chain on every /v1/health request — that would make the
 * endpoint latency a function of whichever Blurt RPC node is healthiest
 * today, and an external monitor polling every 5 seconds would turn into 5
 * chain reads a second.
 */

import type { Context, Hono } from 'hono';
import type { Config } from '../config/index.ts';
import { FEE_REFUSE_MULTIPLIER, type BlurtClient } from '../blurt/client.ts';
import type { GlobalDailyCeiling } from '../policy/globalDailyCeiling.ts';
import { logger } from '$log';

const log = logger('relay-acts');

// Keep in sync with the root package.json `version`.  The
// version-consistency-smoke fails the build if
// this constant drifts from any other package.json or from the
// indexer's INDEXER_VERSION constant.  When bumping for a new
// release, update all 10 package.json files + this constant +
// apps/indexer/src/api/health.ts INDEXER_VERSION + the example
// response in docs/API.md in the same commit.
export const VERSION = '1.21.3';
const POLL_INTERVAL_MS = 30_000;
/** Liquid-BLURT headroom (above the account_creation_fee) the relay
 *  must hold to accept a signup. Blurt disabled the ACT model at HF2,
 *  so the relay pays the fee inline per `account_create`; signup
 *  readiness is gated on liquid balance, not a pre-minted-token buffer.
 *  Covers the 2 BLURT signup dust plus a small buffer so a TOCTOU race
 *  between health refresh and broadcast can't start a signup we can't
 *  fund. */
const SIGNUP_LIQUID_MARGIN_BLURT = 3;
/** A balance older than this (three missed polls) is no longer trusted:
 *  canAcceptCreation refuses and /v1/health says `stale: true` (v1.20.0, D10).
 *  It used to keep the last good balance forever once polls started failing. */
const STALE_AFTER_SEC = 3 * (POLL_INTERVAL_MS / 1000);

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
	/** True before the first poll completes, or when the relay account is
	 *  missing on chain. Age-based staleness is computed in isStale(). */
	stale: boolean;
	/** The chain's LIVE account_creation_fee in BLURT from the last poll that
	 *  could read it, or null (then the configured fee is used). */
	live_fee_blurt: number | null;
}

/** A request from this box, not through a public edge: it asks with
 *  X-Morphit-Local-Health: 1 and carries none of the headers the edges set. */
export function isLocalHealthCaller(c: Context): boolean {
	if (c.req.header('x-morphit-local-health') !== '1') return false;
	for (const h of ['x-forwarded-for', 'x-real-ip', 'x-forwarded-proto']) {
		if (c.req.header(h) !== undefined) return false;
	}
	return true;
}

export class HealthService {
	private snapshot: ChainSnapshot = {
		blurt_balance: 'unknown',
		last_refresh_unix: 0,
		stale: true,
		live_fee_blurt: null
	};
	private poller: NodeJS.Timeout | null = null;
	/** Hysteresis for the low-balance alert: true once we've alerted that
	 *  the relay's liquid BLURT is below the signup-funding threshold,
	 *  reset when it recovers. In memory only — a restart at worst
	 *  re-alerts once (cheap; a missed alert would be worse). */
	private lowBalanceAlerted = false;
	/** Optional reference to the signup ceiling. When present, the
	 *  operator block of /v1/health (local callers only) includes
	 *  signup_stats so the indexer-side operator-balance scanner can
	 *  detect anomalous signup volume when it fires a LOW_BALANCE alert. */
	private ceiling: GlobalDailyCeiling | null = null;
	/** Pending-transfer queue counts (unsettled / escalated) from the
	 *  drainer; null until wired. */
	private queueStats: (() => { unsettled: number; escalated: number } | null) | null = null;
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

	/** Wire the queue drainer's counts into /v1/health (verbose). */
	setQueueStatsProvider(fn: () => { unsettled: number; escalated: number } | null): void {
		this.queueStats = fn;
	}

	/** Returns true iff the relay holds enough liquid BLURT to fund a
	 *  new account creation (the account_creation_fee plus a small
	 *  margin). False means the create endpoint returns
	 *  relay_out_of_funds without touching the chain. When the balance is
	 *  unknown or too old (before the first poll, or after three missed
	 *  polls) we choose restrictive. The fee is the chain's LIVE fee when the
	 *  last poll could read it (v1.20.0, D4), else the configured one. */
	canAcceptCreation(): boolean {
		if (this.isStale()) return false;
		const fee = this.snapshot.live_fee_blurt ?? this.cfg.accountCreationFeeBlurt;
		return parseBlurtAmount(this.snapshot.blurt_balance) >= fee + SIGNUP_LIQUID_MARGIN_BLURT;
	}

	/** True when the last poll saw a live fee above FEE_REFUSE_MULTIPLIER × the
	 *  configured one — the create endpoint then answers `relay_fee_spike`
	 *  up front instead of a misleading `relay_out_of_funds` (D4). The
	 *  authoritative refusal is still in BlurtClient.broadcastAccountCreate. */
	liveFeeSpiked(): boolean {
		const f = this.snapshot.live_fee_blurt;
		return f !== null && f > this.cfg.accountCreationFeeBlurt * FEE_REFUSE_MULTIPLIER;
	}

	/** No trustworthy balance: never polled, account missing, or the last
	 *  successful poll is older than STALE_AFTER_SEC. */
	private isStale(): boolean {
		if (this.snapshot.stale) return true;
		return Math.floor(Date.now() / 1000) - this.snapshot.last_refresh_unix > STALE_AFTER_SEC;
	}

	async startPolling(): Promise<void> {
		// Initial fetch so /v1/health has fresh data on first request.
		// Tolerate failure — a chain that's unreachable at startup is
		// reported via `stale: true` until the next poll succeeds.
		await this.refresh().catch(() => {});
		this.poller = setInterval(() => {
			this.refresh().catch(() => {
				// Background poll failures are expected (transient chain
				// hiccups) and are not logged one by one. The snapshot keeps
				// its last_refresh_unix, so after STALE_AFTER_SEC without a
				// good poll isStale() turns true: signups are refused and
				// /v1/health reports stale.
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
		// Live fee (D4): best-effort — an unreadable fee keeps the last one.
		let liveFee = this.snapshot.live_fee_blurt;
		try {
			const f = parseBlurtAmount((await this.blurt.getChainProperties()).account_creation_fee);
			if (f > 0) liveFee = f;
		} catch {
			/* keep the previous live fee (or the configured one) */
		}
		this.snapshot = {
			blurt_balance: acct.balance,
			last_refresh_unix: Math.floor(Date.now() / 1000),
			stale: false,
			live_fee_blurt: liveFee
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
		const fundingFloor = (liveFee ?? this.cfg.accountCreationFeeBlurt) + SIGNUP_LIQUID_MARGIN_BLURT;
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
			// The relay broadcasts through this pool; if every endpoint is
			// unreachable, signups/listings can't post. Public: one boolean.
			// The counts and per-endpoint detail stay in the gated block.
			const rpcSnap = this.blurt.endpointSnapshot();
			const nowMs = Date.now();
			const rpcEndpointsHealthy = rpcSnap.filter((e) => e.cooldownUntil <= nowMs).length;

			const body: Record<string, unknown> = {
				status: 'ok',
				rpc_ok: rpcEndpointsHealthy > 0,
				// v1.18.0 (F32) — whether this relay reaches the chain ONLY over
				// hidden services. The indexer reads it to decide whether the
				// instance may claim "Zero use of clearnet internet": the relay is
				// the process that broadcasts, and the claim is about the node, not
				// just the indexer. Not sensitive — the claim itself is public.
				hidden_only: this.cfg.hiddenOnly
			};
			// Operator block: local callers only (see the header comment), unless
			// the operator explicitly chose to publish it.
			if (isLocalHealthCaller(c) || this.cfg.verboseHealth) {
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
				if (this.snapshot.live_fee_blurt !== null) body.account_creation_fee_blurt = this.snapshot.live_fee_blurt;
				if (this.isStale()) body.stale = true;

				body.rpc_endpoints_healthy = rpcEndpointsHealthy;
				body.rpc_endpoints_total = rpcSnap.length;
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

				// Pending-transfer queue (welcome bonus / dust / BP). `escalated`
				// rows are payments whose outcome no two RPC nodes could settle;
				// they are NOT re-sent and need the operator.
				const q = this.queueStats?.() ?? null;
				if (q !== null) body.transfer_queue = q;

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
