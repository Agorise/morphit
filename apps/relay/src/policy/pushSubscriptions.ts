/**
 * Morphit relay — Web Push subscription store.
 *
 * Thin DB layer over the `push_subscriptions` table (schema v33).
 * Owns:
 *   - upsert: client calls /v1/push/subscribe; we insert or refresh
 *     the row.  Idempotent — same (account, endpoint) yields the
 *     same row regardless of repeat calls (browsers re-subscribe on
 *     every page load to refresh stale endpoints).
 *   - listByAccount: push-sender worker needs all live
 *     subscriptions for an account when draining push_pending.
 *   - markDelivery: worker updates last_delivery_at and resets
 *     consecutive_failures on 2xx.
 *   - recordFailure: worker increments consecutive_failures; when
 *     it crosses MAX_CONSECUTIVE_FAILURES, the worker drops the row.
 *   - deleteByEndpoint: explicit unsubscribe (UI) OR the worker
 *     received 410 Gone / 404 from the push service.
 *
 * Privacy: no IP, no full user-agent free-text logging beyond the
 * 200-char column.  The endpoint URL itself reveals which push
 * service the user's browser uses, which is unavoidable for Web
 * Push to function.
 */

import type pg from 'pg';
import type { Database } from '$db/pool';
import { logger } from '$log';

const log = logger('relay-push-subscriptions');

export type PushPrivacyMode = 'standard' | 'self_hosted';

export interface PushSubscription {
	readonly account: string;
	readonly endpoint: string;
	readonly p256dh: string;
	readonly auth: string;
	readonly userAgent: string | null;
	readonly privacyMode: PushPrivacyMode;
	readonly createdAt: Date;
	readonly lastDeliveryAt: Date | null;
	readonly consecutiveFailures: number;
	/** Locale tag the user subscribed with (e.g. 'en', 'zh-CN').
	 *  Used by the push-sender to look up localized title/body
	 *  strings.  Defaults to 'en' when the client doesn't pass
	 *  one.  Part 122 cp14. */
	readonly locale: string;
}

/** Maximum length we accept for a user-agent string.  Bound on
 *  row size; anything beyond 200 chars is browser introspection
 *  cruft of no value. */
const MAX_USER_AGENT_LEN = 200;

export class PushSubscriptionStore {
	constructor(private readonly db: Database) {}

	/** Upsert one subscription.  Idempotent on (account, endpoint).
	 *  Returns the row that's now in the DB. */
	async upsert(input: {
		account: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		userAgent: string | null;
		privacyMode: PushPrivacyMode;
		locale: string;
	}): Promise<PushSubscription> {
		const ua =
			input.userAgent === null
				? null
				: input.userAgent.slice(0, MAX_USER_AGENT_LEN);

		const result = await this.db.query<RawRow>(
			`INSERT INTO push_subscriptions
			   (account, endpoint, p256dh, auth, user_agent, privacy_mode, locale)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (account, endpoint) DO UPDATE
			   SET p256dh = EXCLUDED.p256dh,
			       auth = EXCLUDED.auth,
			       user_agent = EXCLUDED.user_agent,
			       privacy_mode = EXCLUDED.privacy_mode,
			       locale = EXCLUDED.locale,
			       consecutive_failures = 0
			 RETURNING *`,
			[
				input.account,
				input.endpoint,
				input.p256dh,
				input.auth,
				ua,
				input.privacyMode,
				input.locale
			]
		);
		const row = result.rows[0];
		if (!row) {
			// Should be unreachable: INSERT ... ON CONFLICT ... RETURNING
			// always yields the inserted/updated row.  Defensive throw
			// instead of `!` so a future schema change can't quietly
			// hand back undefined.
			throw new Error('upsert returned no row');
		}
		log.info('upsert', { account: input.account, privacy_mode: input.privacyMode });
		return rowToSub(row);
	}

	/** All live subscriptions for an account.  Used by the push
	 *  sender when fanning out a notification to all of a user's
	 *  devices. */
	async listByAccount(account: string): Promise<readonly PushSubscription[]> {
		const result = await this.db.query<RawRow>(
			`SELECT * FROM push_subscriptions WHERE account = $1`,
			[account]
		);
		return result.rows.map(rowToSub);
	}

	/** Record a successful delivery.  Resets failure counter. */
	async markDelivery(account: string, endpoint: string): Promise<void> {
		await this.db.query(
			`UPDATE push_subscriptions
			    SET last_delivery_at = NOW(), consecutive_failures = 0
			  WHERE account = $1 AND endpoint = $2`,
			[account, endpoint]
		);
	}

	/** Increment consecutive_failures.  Returns the new count so
	 *  the caller can decide whether to delete the subscription. */
	async recordFailure(account: string, endpoint: string): Promise<number> {
		const result = await this.db.query<{ consecutive_failures: number }>(
			`UPDATE push_subscriptions
			    SET last_delivery_at = NOW(),
			        consecutive_failures = consecutive_failures + 1
			  WHERE account = $1 AND endpoint = $2
			 RETURNING consecutive_failures`,
			[account, endpoint]
		);
		return result.rows[0]?.consecutive_failures ?? 0;
	}

	/** Delete a subscription — explicit unsubscribe, or push service
	 *  returned 410 Gone / 404, or consecutive failures crossed
	 *  the limit. */
	async delete(account: string, endpoint: string): Promise<void> {
		await this.db.query(
			`DELETE FROM push_subscriptions WHERE account = $1 AND endpoint = $2`,
			[account, endpoint]
		);
		log.info('delete', { account });
	}

	/** Count for operator metrics / health endpoint. */
	async count(): Promise<number> {
		const result = await this.db.query<{ count: string }>(
			`SELECT COUNT(*)::TEXT AS count FROM push_subscriptions`
		);
		return Number(result.rows[0]?.count ?? '0');
	}
}

// ─── helpers ──────────────────────────────────────────────────────

interface RawRow {
	account: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	user_agent: string | null;
	privacy_mode: string;
	created_at: Date;
	last_delivery_at: Date | null;
	consecutive_failures: number;
	locale: string;
}

function rowToSub(r: RawRow): PushSubscription {
	return {
		account: r.account,
		endpoint: r.endpoint,
		p256dh: r.p256dh,
		auth: r.auth,
		userAgent: r.user_agent,
		privacyMode: r.privacy_mode as PushPrivacyMode,
		createdAt: r.created_at,
		lastDeliveryAt: r.last_delivery_at,
		consecutiveFailures: r.consecutive_failures,
		locale: r.locale
	};
}
