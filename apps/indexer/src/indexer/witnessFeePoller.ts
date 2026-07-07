/**
 * Morphit indexer — witness fee poller.
 *
 * Tracks the chain's account_creation_fee parameter, alerts
 * operators when it changes, and writes history rows for
 * post-incident analysis.  Pure operator-telemetry under the
 * §F.11 BLURT-native fee model — listing fees are denominated
 * directly in BLURT (operator-tunable via
 * MORPHIT_INDEXER_FEE_BASE_BLURT) and don't reference the
 * witness fee at all.
 *
 * Pre-§F.11 the listing-fee formula divided account_creation_fee
 * by an amortization factor; that formula has been deleted.
 * The poller is retained because operators still want to know
 * when witnesses change parameters that affect cost-of-attack
 * for Sybil defense (witness fee is the cost of creating a
 * Blurt account, which is the floor on Sybil cost).  Higher
 * witness fee → cheaper-than-it-looks Sybil defense → maybe
 * raise the listing fee.  Lower witness fee → reconsider.
 *
 * Usage: an instance is held by the Poller, which calls
 * `maybePoll()` from its tick loop. Polling is throttled by
 * `intervalMs` (default 1 hour). The cached value is accessible
 * via `getCurrentFee()` for operator dashboards and the
 * /v1/health endpoint.
 *
 * Failure handling:
 *   - Transport failures (network, RPC timeout): retained cache,
 *     incremented failure count. After 3 consecutive failures,
 *     emit a SUSTAINED_RPC_FAILURE alert. Keep trying.
 *   - Shape errors (unparseable response): treat like transport
 *     failure with a distinct alert kind SHAPE_ERROR.
 *   - Successful poll but same value as cache: no DB write, no
 *     alert. Cache observedAt timestamp updated so we can tell
 *     "we saw the same value" from "we haven't polled recently".
 */

import type pg from 'pg';
import type { BlurtClient } from '$blurt/client';
import type { Database } from '$db/pool';
import { ChainPropertiesShapeError, fetchChainProperties } from '$blurt/chainProperties';
import { logger } from '$log';

const log = logger('witness-fee');

/** What an operator-facing alert looks like. Structured JSON —
 *  consumable by syslog, Discord webhook, Matrix bot, etc.
 *  The alert sink is configurable; default routes through the
 *  structured logger (module `witness-fee`) so the alert lands
 *  in systemd's journal in JSON form in production. */
export type WitnessFeeAlert =
	| {
			kind: 'FEE_CHANGED';
			oldBlurt: number;
			newBlurt: number;
			/** Signed delta (newBlurt - oldBlurt).  Positive means
			 *  fee went up; negative means down.  Surfaced for
			 *  alert consumers that don't want to do their own
			 *  subtraction. */
			deltaBlurt: number;
			/** Magnitude of the change as a percentage of the OLD
			 *  fee, signed.  `+10` means "10% increase", `-25`
			 *  means "25% decrease".  null when oldBlurt was zero
			 *  (avoids division-by-zero; this is unusual in
			 *  practice — the chain's account_creation_fee has
			 *  been positive for years).  Operator-facing alerts
			 *  use this to decide urgency: a 1% drift is
			 *  cosmetic; a 25%+ change is "the witnesses voted
			 *  something significant." */
			deltaPct: number | null;
			/** 'up' | 'down' — convenience field so a Discord
			 *  webhook handler can pick an emoji without parsing
			 *  the sign of `deltaBlurt`. */
			direction: 'up' | 'down';
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
			message: string;
			at: Date;
	  };

/** Alert sink — injectable. Default routes through the structured
 *  logger (module `witness-fee`); tests can replace it to capture
 *  alerts without side effects. */
export type AlertSink = (alert: WitnessFeeAlert) => void;

export interface WitnessFeePollerConfig {
	/** Minimum ms between polls. Default 1 hour. */
	readonly intervalMs: number;
	/** Default fallback fee to use before the first successful
	 *  poll. At a fresh indexer start, we don't have chain data
	 *  yet; we use this so the listing-fee formula has something
	 *  sensible to compute from until the first poll lands. */
	readonly fallbackFeeBlurt: number;
	/** Consecutive-failure threshold before a
	 *  SUSTAINED_RPC_FAILURE alert fires. Reset to 0 on success. */
	readonly failureAlertThreshold: number;
}

export const DEFAULT_WITNESS_FEE_POLLER_CONFIG: WitnessFeePollerConfig = {
	intervalMs: 60 * 60 * 1000, // 1h
	fallbackFeeBlurt: 100, // Current witness-set value at writing
	failureAlertThreshold: 3
};

export interface FeeSnapshot {
	readonly feeBlurt: number;
	readonly observedAt: Date;
	/** True if this value came from a successful RPC poll, false
	 *  if it's still the fallback default because no poll has
	 *  succeeded yet. Downstream code may want to log a warning
	 *  if it's operating on fallback values. */
	readonly fromChain: boolean;
}

export class WitnessFeePoller {
	private cached: FeeSnapshot;
	private lastPollAt = 0;
	private consecutiveFailures = 0;

	constructor(
		private readonly db: Database,
		private readonly blurt: BlurtClient,
		private readonly config: WitnessFeePollerConfig = DEFAULT_WITNESS_FEE_POLLER_CONFIG,
		private readonly alertSink: AlertSink = defaultAlertSink
	) {
		this.cached = {
			feeBlurt: config.fallbackFeeBlurt,
			observedAt: new Date(0),
			fromChain: false
		};
	}

	/** Current cached fee — safe to call from anywhere, does no
	 *  I/O. Returns the fallback value until the first successful
	 *  poll. */
	getCurrentFee(): FeeSnapshot {
		return this.cached;
	}

	/** Perform one poll if enough time has elapsed since the last
	 *  one. No-op otherwise. Safe to call on every indexer tick.
	 *  Exceptions are not propagated — they're logged and counted
	 *  internally so the indexer's main loop isn't affected by
	 *  RPC hiccups. */
	async maybePoll(): Promise<void> {
		const now = Date.now();
		if (now - this.lastPollAt < this.config.intervalMs) return;
		this.lastPollAt = now;

		try {
			const properties = await fetchChainProperties(this.blurt);
			await this.ingest(properties.accountCreationFeeBlurt, properties.observedAt);
			this.consecutiveFailures = 0;
		} catch (err) {
			this.consecutiveFailures++;
			const message = err instanceof Error ? err.message : String(err);

			if (err instanceof ChainPropertiesShapeError) {
				// Shape errors are distinct — they indicate a node
				// returning unexpected data, which could be a config
				// mismatch or a chain upgrade. Alert every time so
				// the operator investigates.
				this.alertSink({
					kind: 'SHAPE_ERROR',
					message,
					at: new Date()
				});
			} else if (this.consecutiveFailures >= this.config.failureAlertThreshold) {
				this.alertSink({
					kind: 'SUSTAINED_RPC_FAILURE',
					consecutiveFailures: this.consecutiveFailures,
					lastError: message,
					at: new Date()
				});
			}
		}
	}

	/** Ingest a successful poll result. Writes witness_fee_history
	 *  if the value changed (or is the first observation), updates
	 *  the cache, emits FEE_CHANGED on changes. Extracted so the
	 *  polling loop and integration tests can use it directly. */
	async ingest(feeBlurt: number, observedAt: Date): Promise<void> {
		const prev = this.cached;
		const isFirstFromChain = !prev.fromChain;
		const changed = prev.feeBlurt !== feeBlurt;

		if (isFirstFromChain) {
			await this.writeHistory(feeBlurt, observedAt, 'initial');
		} else if (changed) {
			await this.writeHistory(feeBlurt, observedAt, 'change');
			const delta = feeBlurt - prev.feeBlurt;
			const deltaPct = prev.feeBlurt === 0 ? null : (delta / prev.feeBlurt) * 100;
			this.alertSink({
				kind: 'FEE_CHANGED',
				oldBlurt: prev.feeBlurt,
				newBlurt: feeBlurt,
				deltaBlurt: delta,
				deltaPct,
				direction: delta > 0 ? 'up' : 'down',
				at: observedAt
			});
		}
		// else: same value as cached, no-op except updating the
		// observedAt timestamp below.

		this.cached = {
			feeBlurt,
			observedAt,
			fromChain: true
		};
	}

	/** Write a witness_fee_history row. Separate transaction; no
	 *  interaction with the block-processing transaction. */
	private async writeHistory(
		feeBlurt: number,
		observedAt: Date,
		kind: 'initial' | 'change'
	): Promise<void> {
		await this.db.withTx(async (client: pg.PoolClient) => {
			await client.query(
				`INSERT INTO witness_fee_history
				   (observed_at, account_creation_fee_blurt, observation_kind)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (observed_at) DO NOTHING`,
				[observedAt, feeBlurt, kind]
			);
		});
	}
}

function defaultAlertSink(alert: WitnessFeeAlert): void {
	// Structured log so syslog-style aggregators can parse. Operators
	// wanting richer integration (Discord, email) can override with
	// a custom sink.
	switch (alert.kind) {
		case 'FEE_CHANGED':
			log.warn('fee_changed', {
				old_blurt: alert.oldBlurt,
				new_blurt: alert.newBlurt,
				delta_blurt: alert.deltaBlurt,
				delta_pct: alert.deltaPct,
				direction: alert.direction,
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
				message: alert.message,
				observed_at: alert.at.toISOString()
			});
			break;
	}
}
