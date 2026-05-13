/**
 * Morphit indexer — operator-account balance scanner.
 *
 * Periodically checks the on-chain BLURT balance of the
 * operator's service accounts (typically @morphit-relay and
 * @morphit-fees) and fires admin-facing alerts when any of
 * them crosses below a configured threshold.
 *
 * Why this matters:
 *   - @morphit-relay needs BLURT to fund welcome bonuses,
 *     loyalty delegations, and dust refills. When it runs dry
 *     the relay silently stops processing
 *     relay_pending_transfers — users see missed bonuses, the
 *     operator sees nothing unless they monitor the logs.
 *   - @morphit-fees typically accumulates rather than drains,
 *     but a misconfigured auto-sweep or an account compromise
 *     can bleed it. Low-balance alerts catch both.
 *
 * Design constraints:
 *   - MUST NOT spam. An account sitting below threshold for
 *     days must not fire days of alerts. Hysteresis tracked
 *     in-memory: the alert fires once on the downward cross,
 *     stays quiet until the balance climbs back above, then
 *     arms again for the next cross.
 *   - MUST NOT gate indexer progress. Failure to check balance
 *     (RPC down, parse error) is logged, counted, surfaced via
 *     SUSTAINED alerts — but never bubbles up to the tick loop.
 *   - Operator override via alertSink. Default routes through
 *     the structured logger so operators can pick up alerts
 *     from systemd's JSON journal; richer integrations
 *     (Discord webhook, email, SMS) replace the sink.
 *
 * Opt-in by default: thresholds default to zero, which means
 * "don't monitor this account." An operator upgrading without
 * reading release notes will NOT be surprised by new alerts;
 * they see alerts only after explicitly setting a threshold.
 */

import type { BlurtClient } from '$blurt/client';
import { parseBlurtAmount } from '$indexer/fee-transfer';
import { logger } from '$log';

const log = logger('operator-balance');

/**
 * One account to monitor. Separate config per account so
 * operators can, say, alert at 100 BLURT for the relay (high
 * churn) and at 10 BLURT for fees (should never reach that
 * low unless something is wrong).
 */
export interface MonitoredAccount {
	/** Blurt account name. */
	readonly name: string;
	/** Alert fires when liquid BLURT drops strictly below this
	 *  value. Set to 0 to disable monitoring for this account
	 *  (the default when the env var isn't set). */
	readonly thresholdBlurt: number;
	/** Human-friendly role label included in the alert. e.g.
	 *  "relay" / "fees". */
	readonly role: string;
}

/**
 * Structured admin alert. Discriminated union so sinks can
 * route on `kind`. Shape deliberately JSON-serializable for
 * webhook/syslog integrations.
 */
export type OperatorBalanceAlert =
	| {
			kind: 'LOW_BALANCE';
			account: string;
			role: string;
			/** Current balance in BLURT (decimal). */
			balanceBlurt: number;
			/** The configured threshold this balance crossed below. */
			thresholdBlurt: number;
			at: Date;
			/** Optional: when the alert fires on the relay account
			 *  and a signup-anomaly probe is configured, this carries
			 *  "here's what we saw, here's what to do." Used by the
			 *  operator's alerting sink to append a recommendation
			 *  like "consider MORPHIT_RELAY_SIGNUP_ENABLED=false"
			 *  when a drain pattern is likely. See
			 *  docs/OPERATIONS.md §18. */
			signupAnomaly?: SignupAnomaly;
	  }
	| {
			kind: 'RECOVERED';
			account: string;
			role: string;
			/** Balance at the moment we noticed recovery. Useful for
			 *  operators debugging "did my refill actually land?" */
			balanceBlurt: number;
			thresholdBlurt: number;
			at: Date;
	  }
	| {
			kind: 'SUSTAINED_RPC_FAILURE';
			consecutiveFailures: number;
			lastError: string;
			at: Date;
	  }
	| {
			kind: 'SHAPE_ERROR';
			account: string;
			rawBalance: string;
			at: Date;
	  };

/** Result of probing the relay's /v1/health?verbose=1 for signup
 *  stats. When a drain pattern is likely, `recommendKillSwitch`
 *  is true and the alert sink surfaces the recommendation.
 *  Fields carried over from the relay so the sink has enough
 *  context for a human-readable message without a second fetch. */
export interface SignupAnomaly {
	/** Whether the anomaly detector was able to read relay stats.
	 *  False means the probe failed (relay unreachable, parse
	 *  error, etc.). When false, the other fields are undefined. */
	probed: boolean;
	/** Is signup currently enabled on the relay? */
	signupEnabled?: boolean;
	/** Signups completed in the current UTC hour. */
	currentHourCount?: number;
	/** Peak per-hour count seen today. */
	peakHourCount?: number;
	/** Total signups today. */
	successfulToday?: number;
	/** Daily ceiling configured on the relay. */
	dailyCeiling?: number;
	/** Our judgment: does this look like a drain? Set true when
	 *  the current hour's count is significantly higher than
	 *  recent norms AND balance is dropping. */
	recommendKillSwitch: boolean;
	/** Human-readable rationale for the kill-switch recommendation,
	 *  or an explanation of why we can't recommend one. */
	message: string;
}

/** Injectable alert sink. Default routes through the structured
 *  logger. Operators override to route to Discord / email /
 *  webhook / etc. */
export type OperatorBalanceAlertSink = (alert: OperatorBalanceAlert) => void;

export interface OperatorAccountBalanceScanConfig {
	/** Minimum ms between scans. */
	readonly intervalMs: number;
	/** Accounts to monitor. Entries with thresholdBlurt=0 are
	 *  skipped — this is how "not configured" is expressed. */
	readonly accounts: readonly MonitoredAccount[];
	/** Consecutive-failure threshold before a SUSTAINED_RPC_FAILURE
	 *  alert fires. Reset on first success. */
	readonly failureAlertThreshold: number;
	/** Optional: when a LOW_BALANCE alert fires on the relay
	 *  account, the scanner calls this probe to check for
	 *  anomalous signup volume and attach a kill-switch
	 *  recommendation to the alert. The probe fetches the
	 *  relay's /v1/health?verbose=1 and returns a structured
	 *  verdict. Omit (or return {probed:false}) to skip the
	 *  anomaly check — useful in tests and for operators who
	 *  don't have the relay on localhost. */
	readonly signupAnomalyProbe?: () => Promise<SignupAnomaly>;
}

export interface ScanResult {
	/** Accounts checked this cycle (after zero-threshold filter). */
	readonly accountsChecked: number;
	/** How many LOW_BALANCE alerts fired this cycle. */
	readonly alertsFired: number;
	/** How many RECOVERED alerts fired this cycle. */
	readonly recoveriesFired: number;
	/** RPC or parse errors encountered this cycle. */
	readonly errors: number;
}

/** Per-account hysteresis state — tracks whether we're
 *  currently below-threshold for this account. Transitions:
 *    above → below: fire LOW_BALANCE
 *    below → above: fire RECOVERED
 *    below → below: no-op (don't spam)
 *    above → above: no-op (normal) */
interface AccountState {
	below: boolean;
	lastObservedBlurt: number | null;
}

export class OperatorAccountBalanceScanner {
	private lastScanAt = 0;
	private consecutiveRpcFailures = 0;
	/** Per-account hysteresis map keyed by account name.
	 *  Intentionally in-memory: a process restart means "we
	 *  forget the previous state," which at worst fires one
	 *  extra LOW_BALANCE on first scan after restart if the
	 *  account is below threshold. That's acceptable — an extra
	 *  alert at startup is cheap; a missed alert because we
	 *  persisted stale "already warned" state would be harmful. */
	private readonly state = new Map<string, AccountState>();

	constructor(
		private readonly blurt: BlurtClient,
		private readonly config: OperatorAccountBalanceScanConfig,
		private readonly alertSink: OperatorBalanceAlertSink = defaultAlertSink
	) {}

	/** Throttled tick entry point. Safe to call on every tick
	 *  of the Poller loop; no-ops between intervals. */
	async maybeScan(): Promise<void> {
		const now = Date.now();
		if (now - this.lastScanAt < this.config.intervalMs) return;
		this.lastScanAt = now;
		try {
			await this.scanOnce();
		} catch (err) {
			// Unexpected. scanOnce already swallows RPC failures
			// internally and converts to alerts; anything reaching
			// here is a programmer error worth seeing.
			log.error('scan_unexpected_error', {}, err);
		}
	}

	/** Perform one scan. Exposed for tests and operator-
	 *  triggered runs. */
	async scanOnce(): Promise<ScanResult> {
		const monitored = this.config.accounts.filter((a) => a.thresholdBlurt > 0);
		if (monitored.length === 0) {
			return {
				accountsChecked: 0,
				alertsFired: 0,
				recoveriesFired: 0,
				errors: 0
			};
		}

		const names = monitored.map((a) => a.name);
		let balances: ReadonlyMap<string, string | undefined>;
		try {
			const accounts = await this.blurt.getAccounts(names);
			balances = new Map(
				Array.from(accounts.entries()).map(
					([name, acc]) => [name, acc.balance] as [string, string | undefined]
				)
			);
			// Success — reset the sustained-failure counter.
			this.consecutiveRpcFailures = 0;
		} catch (err) {
			this.consecutiveRpcFailures++;
			const msg = err instanceof Error ? err.message : String(err);
			log.warn('rpc_get_accounts_failed', {
				consecutive_failures: this.consecutiveRpcFailures,
				error: msg
			});
			if (this.consecutiveRpcFailures >= this.config.failureAlertThreshold) {
				this.alertSink({
					kind: 'SUSTAINED_RPC_FAILURE',
					consecutiveFailures: this.consecutiveRpcFailures,
					lastError: msg,
					at: new Date()
				});
			}
			return {
				accountsChecked: 0,
				alertsFired: 0,
				recoveriesFired: 0,
				errors: 1
			};
		}

		let alertsFired = 0;
		let recoveriesFired = 0;
		let errors = 0;

		for (const account of monitored) {
			const raw = balances.get(account.name);
			if (raw === undefined) {
				// Account missing from response — most likely misspelled
				// in config or doesn't exist on chain. Log once per
				// scan; don't alert the operator with a "missing
				// account" every scan (they may have typo'd on purpose
				// to disable and forgotten thresholdBlurt=0).
				log.warn('account_not_found', { account: account.name });
				errors++;
				continue;
			}

			const balance = parseBlurtAmount(raw);
			if (balance === null) {
				this.alertSink({
					kind: 'SHAPE_ERROR',
					account: account.name,
					rawBalance: raw,
					at: new Date()
				});
				errors++;
				continue;
			}

			const prev = this.state.get(account.name) ?? {
				below: false,
				lastObservedBlurt: null
			};
			const nowBelow = balance < account.thresholdBlurt;

			if (nowBelow && !prev.below) {
				// Downward cross — arm the alert. If this is the
				// relay account AND the operator configured a
				// signup-anomaly probe, call it to attach context
				// about "is this a drain in progress?" The probe
				// can fail (relay unreachable); we swallow and fire
				// the alert anyway — an uncontextualized LOW_BALANCE
				// is strictly better than no alert.
				let anomaly: SignupAnomaly | undefined;
				if (account.role === 'relay' && this.config.signupAnomalyProbe) {
					try {
						anomaly = await this.config.signupAnomalyProbe();
					} catch (err) {
						log.warn('signup_anomaly_probe_failed', {}, err);
					}
				}
				this.alertSink({
					kind: 'LOW_BALANCE',
					account: account.name,
					role: account.role,
					balanceBlurt: balance,
					thresholdBlurt: account.thresholdBlurt,
					at: new Date(),
					...(anomaly ? { signupAnomaly: anomaly } : {})
				});
				alertsFired++;
			} else if (!nowBelow && prev.below) {
				// Upward cross — recovery. Fires once per recovery so
				// operators see "crisis resolved" and know to stop
				// worrying.
				this.alertSink({
					kind: 'RECOVERED',
					account: account.name,
					role: account.role,
					balanceBlurt: balance,
					thresholdBlurt: account.thresholdBlurt,
					at: new Date()
				});
				recoveriesFired++;
			}
			// else: same side as last scan — no alert, avoid spam.

			this.state.set(account.name, {
				below: nowBelow,
				lastObservedBlurt: balance
			});
		}

		return {
			accountsChecked: monitored.length,
			alertsFired,
			recoveriesFired,
			errors
		};
	}

	/** Current hysteresis snapshot — exposed for /v1/health so
	 *  operators can see "which accounts are currently below
	 *  threshold" without waiting for the next alert. */
	getCurrentState(): ReadonlyMap<string, { below: boolean; lastObservedBlurt: number | null }> {
		return new Map(this.state);
	}
}

function defaultAlertSink(alert: OperatorBalanceAlert): void {
	// Structured log so JSON-parsing aggregators (journald,
	// Loki, etc.) can route on the `kind` field. Every alert is
	// written at WARN or ERROR level depending on severity —
	// operators filtering by level see the right things.
	switch (alert.kind) {
		case 'LOW_BALANCE':
			log.error('low_balance', {
				account: alert.account,
				role: alert.role,
				balance_blurt: alert.balanceBlurt,
				threshold_blurt: alert.thresholdBlurt,
				observed_at: alert.at.toISOString(),
				...(alert.signupAnomaly
					? {
							signup_anomaly: {
								probed: alert.signupAnomaly.probed,
								signup_enabled: alert.signupAnomaly.signupEnabled,
								current_hour: alert.signupAnomaly.currentHourCount,
								peak_hour: alert.signupAnomaly.peakHourCount,
								successful_today: alert.signupAnomaly.successfulToday,
								daily_ceiling: alert.signupAnomaly.dailyCeiling,
								recommend_kill_switch: alert.signupAnomaly.recommendKillSwitch,
								message: alert.signupAnomaly.message
							}
						}
					: {})
			});
			break;
		case 'RECOVERED':
			log.info('balance_recovered', {
				account: alert.account,
				role: alert.role,
				balance_blurt: alert.balanceBlurt,
				threshold_blurt: alert.thresholdBlurt,
				observed_at: alert.at.toISOString()
			});
			break;
		case 'SUSTAINED_RPC_FAILURE':
			log.error('rpc_sustained_failure', {
				consecutive_failures: alert.consecutiveFailures,
				last_error: alert.lastError,
				observed_at: alert.at.toISOString()
			});
			break;
		case 'SHAPE_ERROR':
			log.error('shape_error', {
				account: alert.account,
				raw_balance: alert.rawBalance,
				observed_at: alert.at.toISOString()
			});
			break;
	}
}
