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
 * Privacy: what a row holds is the account, its push endpoint and
 * keys, a supported UI locale and the muted categories — no IP, no
 * User-Agent (the column stays for old relays and is always written
 * NULL), and no account name in the log. The endpoint URL itself
 * reveals which push service the user's browser uses, which is
 * unavoidable for Web Push to function.
 */

import type pg from 'pg';
import { ORDER_LANG_CODES } from '@morphit/operator-config';
import type { Database } from '$db/pool';
import { logger } from '$log';
import { isAllowedPushEndpoint } from './pushEndpoint.ts';

const log = logger('relay-push-subscriptions');

/** 'self_hosted' was never wired to anything (an operator push server that
 *  does not exist). The wire still accepts it from older cached clients, but
 *  every row is stored as 'standard'. */
export type PushPrivacyMode = 'standard' | 'self_hosted';

export interface PushSubscription {
	readonly account: string;
	readonly endpoint: string;
	readonly p256dh: string;
	readonly auth: string;
	readonly privacyMode: PushPrivacyMode;
	readonly createdAt: Date;
	readonly lastDeliveryAt: Date | null;
	readonly consecutiveFailures: number;
	/** Locale tag the user subscribed with (e.g. 'en', 'zh-CN').
	 *  Used by the push-sender to look up localized title/body
	 *  strings.  Defaults to 'en' when the client doesn't pass
	 *  one.. */
	readonly locale: string;
	/** Categories this device has OPTED OUT of (blocklist). Empty
	 *  means every category is on — the older behaviour. The
	 *  push-sender skips a device whose array contains the pending
	 *  notification's category, so the per-category Settings toggle
	 *  governs Web Push (tab-closed) as it already governs the
	 *  in-page (tab-open) path.. */
	readonly mutedCategories: readonly string[];
}

/** The UI locales push strings exist in: the 10 supported codes, from the
 *  shared list a parity smoke keeps equal to the web's SUPPORTED_LOCALES. */
const SUPPORTED_LOCALES: readonly string[] = ORDER_LANG_CODES;

/** Map a client locale tag to one of the supported codes — the same rule the
 *  indexer's pushLocalize uses and migration v66 applied to existing rows:
 *  an exact code is kept; a tag whose language is supported keeps only the
 *  language (`fa-IR` → `fa`); Chinese goes to zh-HK when the tag says
 *  Traditional / Taiwan / Hong Kong, else zh-CN; anything else is `en`.
 *  Storing the raw navigator.language narrowed the user's region. */
export function normalizePushLocale(tag: string | null | undefined): string {
	if (typeof tag !== 'string') return 'en';
	const t = tag.trim();
	const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
	if (exact !== undefined) return exact;
	const head = t.split(/[-_]/)[0]!.toLowerCase();
	if (head === 'zh') return /hant|tw|hk|mo/i.test(t) ? 'zh-HK' : 'zh-CN';
	return SUPPORTED_LOCALES.includes(head) ? head : 'en';
}

/** Maximum number of push subscriptions per account.
 *
 *  Without this cap, a single account can register thousands of
 *  `(account, endpoint)` pairs.  The push-sender's fan-out loop
 *  (`apps/relay/src/policy/pushSender.ts:190`) then awaits one
 *  POST per device per inbound message — amplifying every chat
 *  message they receive into a thrash of outbound HTTPS calls
 *  against arbitrary push services.  Concrete attack: a hostile
 *  user signs up many push endpoints, then asks a popular trader
 *  for a long conversation; every reply fans out and the relay
 *  ties up its outbound HTTPS pool for that account's queue.
 *
 *  20 is generous (a heavy user with 3 phones, 2 laptops, 2
 *  tablets sits well below it) AND prevents amplification.  If
 *  an account hits the cap, the OLDEST subscription is evicted
 *  before the new one is inserted — same as a sliding window.
 *  This guarantees that a user who switches devices regularly
 *  doesn't get permanently locked out by old/dead subscriptions
 *  occupying their slot.  Concurrent subscribes for one account are
 *  serialised by a transaction-scoped advisory lock (see upsert). */
const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 20;

/** The notification categories the app can push.  A subscription's
 *  `muted_categories` is validated against this set: the relay is a
 *  trust boundary, so an untrusted client can't stuff arbitrary or
 *  unbounded strings into the row.  Unknown values are dropped (not
 *  rejected) — a forward-compatible client naming a category this
 *  relay build doesn't know about still subscribes cleanly. */
const KNOWN_PUSH_CATEGORIES: ReadonlySet<string> = new Set(['order', 'chat', 'feedback']);

/** Normalize a client-supplied muted-category list: keep only known
 *  categories, dedupe, and cap at the category count.  Returns a
 *  sorted array for a stable row value. */
function sanitizeMutedCategories(input: readonly string[] | undefined | null): string[] {
	if (!Array.isArray(input)) return [];
	const kept = new Set<string>();
	for (const c of input) {
		if (typeof c === 'string' && KNOWN_PUSH_CATEGORIES.has(c)) kept.add(c);
	}
	return [...kept].sort();
}

export class PushSubscriptionStore {
	constructor(private readonly db: Database) {}

	/** Upsert one subscription.  Idempotent on (account, endpoint).
	 *  Returns the row that's now in the DB.
	 *
	 *  enforces MAX_SUBSCRIPTIONS_PER_ACCOUNT.  If the
	 *  caller already has the max number of distinct endpoints and
	 *  this upsert would add a NEW one (no conflict on the unique
	 *  key), the oldest existing subscription is evicted first.
	 *  Existing-endpoint upserts (same account, same endpoint, just
	 *  refreshing keys / locale / privacy_mode) are unaffected by
	 *  the cap because they don't add a row. */
	async upsert(input: {
		account: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		privacyMode: PushPrivacyMode;
		locale: string;
		mutedCategories: readonly string[];
	}): Promise<PushSubscription> {
		const mutedCategories = sanitizeMutedCategories(input.mutedCategories);
		const locale = normalizePushLocale(input.locale);

		// eviction step.  ONLY runs when the incoming
		// endpoint is NEW for this account (the ON CONFLICT path
		// is a no-op for cap purposes since it doesn't add a row).
		// A READ COMMITTED transaction alone does NOT make the
		// COUNT → DELETE → INSERT atomic: two concurrent upserts both
		// counted "under the cap" and both inserted (40 concurrent
		// subscribes left 22+ rows). The advisory lock below, taken
		// first and held until COMMIT, serialises upserts for the same
		// account; other accounts are not blocked.
		return this.db.withTx(async (tx) => {
			await tx.query(`SELECT pg_advisory_xact_lock(hashtext('push_subscriptions:' || $1))`, [
				input.account
			]);
			// Step 1: count this account's existing subscriptions
			// (cheap — account is indexed).
			const countRes = await tx.query<{ c: string; has_endpoint: boolean }>(
				`SELECT
				   COUNT(*)::text AS c,
				   BOOL_OR(endpoint = $2) AS has_endpoint
				 FROM push_subscriptions
				 WHERE account = $1`,
				[input.account, input.endpoint]
			);
			const existingCount = Number(countRes.rows[0]?.c ?? '0');
			const hasEndpoint = countRes.rows[0]?.has_endpoint ?? false;

			// Step 2: if this would add a NEW endpoint and we're at
			// the cap, evict the oldest.  Use created_at DESC + LIMIT
			// rather than a tx-internal MIN() so the eviction is
			// deterministic even if multiple rows tie on created_at.
			if (!hasEndpoint && existingCount >= MAX_SUBSCRIPTIONS_PER_ACCOUNT) {
				const toEvict = existingCount - MAX_SUBSCRIPTIONS_PER_ACCOUNT + 1;
				await tx.query(
					`DELETE FROM push_subscriptions
					 WHERE (account, endpoint) IN (
					   SELECT account, endpoint
					   FROM push_subscriptions
					   WHERE account = $1
					   ORDER BY created_at ASC
					   LIMIT $2
					 )`,
					[input.account, toEvict]
				);
				log.info('evicted_for_cap', {
					evicted: toEvict,
					max_per_account: MAX_SUBSCRIPTIONS_PER_ACCOUNT
				});
			}

			// Step 3: the actual upsert. user_agent is always NULL and
			// privacy_mode always 'standard' (see the type comments).
			const result = await tx.query<RawRow>(
				`INSERT INTO push_subscriptions
				   (account, endpoint, p256dh, auth, user_agent, privacy_mode, locale, muted_categories)
				 VALUES ($1, $2, $3, $4, NULL, 'standard', $5, $6)
				 ON CONFLICT (account, endpoint) DO UPDATE
				   SET p256dh = EXCLUDED.p256dh,
				       auth = EXCLUDED.auth,
				       user_agent = NULL,
				       privacy_mode = 'standard',
				       locale = EXCLUDED.locale,
				       muted_categories = EXCLUDED.muted_categories,
				       consecutive_failures = 0
				 RETURNING *`,
				[input.account, input.endpoint, input.p256dh, input.auth, locale, mutedCategories]
			);
			const row = result.rows[0];
			if (!row) {
				// Should be unreachable: INSERT ... ON CONFLICT ... RETURNING
				// always yields the inserted/updated row.  Defensive throw
				// instead of `!` so a future schema change can't quietly
				// hand back undefined.
				throw new Error('upsert returned no row');
			}
			log.info('upsert', { new_device: !hasEndpoint });
			return rowToSub(row);
		});
	}

	/** All live subscriptions for an account.  Used by the push
	 *  sender when fanning out a notification to all of a user's
	 *  devices.
	 *
	 *  When `category` is given (the category of the pending push),
	 *  devices that OPTED OUT of it are excluded — this is where the
	 *  per-category Settings toggle takes effect for Web Push. An
	 *  unknown category matches nobody's blocklist, so it fans out to
	 *  every device (fail-open: a category this build doesn't model is
	 *  never silently swallowed).. */
	async listByAccount(
		account: string,
		category?: string
	): Promise<readonly PushSubscription[]> {
		if (category !== undefined) {
			const result = await this.db.query<RawRow>(
				`SELECT * FROM push_subscriptions
				  WHERE account = $1
				    AND NOT ($2 = ANY(muted_categories))`,
				[account, category]
			);
			return result.rows.map(rowToSub);
		}
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
		log.info('delete');
	}

	/** Delete every stored subscription whose endpoint the relay would no
	 *  longer send to (policy/pushEndpoint.ts) — rows taken before the policy
	 *  existed. Run at boot; returns how many were deleted. */
	async pruneEndpointsOutsidePolicy(extraHosts: readonly string[]): Promise<number> {
		const rows = await this.db.query<{ account: string; endpoint: string }>(
			`SELECT account, endpoint FROM push_subscriptions`
		);
		let n = 0;
		for (const r of rows.rows) {
			if (isAllowedPushEndpoint(r.endpoint, extraHosts)) continue;
			await this.db.query(`DELETE FROM push_subscriptions WHERE account = $1 AND endpoint = $2`, [
				r.account,
				r.endpoint
			]);
			n++;
		}
		return n;
	}

	/** Delete every subscription and every queued push. For a relay that will
	 *  never send push (hidden-only: every browser push service is a clearnet
	 *  host), the account ↔ device mapping is a liability with no use. */
	async deleteAll(): Promise<{ subscriptions: number; pending: number }> {
		const subs = await this.db.query(`DELETE FROM push_subscriptions`);
		const pending = await this.db.query(`DELETE FROM push_pending`);
		return { subscriptions: subs.rowCount ?? 0, pending: pending.rowCount ?? 0 };
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
	privacy_mode: string;
	created_at: Date;
	last_delivery_at: Date | null;
	consecutive_failures: number;
	locale: string;
	muted_categories: string[];
}

function rowToSub(r: RawRow): PushSubscription {
	return {
		account: r.account,
		endpoint: r.endpoint,
		p256dh: r.p256dh,
		auth: r.auth,
		privacyMode: r.privacy_mode as PushPrivacyMode,
		createdAt: r.created_at,
		lastDeliveryAt: r.last_delivery_at,
		consecutiveFailures: r.consecutive_failures,
		locale: r.locale,
		mutedCategories: Array.isArray(r.muted_categories) ? r.muted_categories : []
	};
}
