/**
 * Morphit indexer — /v1/orderbook/stream endpoint (Phase E).
 *
 * Filter-aware Server-Sent Events for live orderbook updates.
 * Frontend subscribes via EventSource; the user sees new
 * orders pop in and stale ones drop out without page refresh.
 *
 * Wire protocol:
 *
 *   event: snapshot
 *   data: {"items":[<OrderRecord>...],"indexed_block":12345}
 *
 *   event: order_upserted
 *   data: {<single OrderRecord>}
 *
 *   event: order_removed
 *   data: {"account":"alice","permlink":"sell-btc-eur-..."}
 *
 *   :keepalive
 *
 * Push mechanism: subscribes to the in-process
 * orderbookEventBus.  Every order mutation site (order,
 * orderReplace, orderCancel, feeAttest handlers) calls
 * ctx.recordOrderbookChange(orderId), which the dispatcher
 * collects and the poller emits AFTER the block transaction
 * commits.  So SSE subscribers never see phantom events from
 * rolled-back ops.
 *
 * Filter is parsed from query string (same shape as REST
 * /v1/orderbook).  Server-side filtering means each
 * connection only receives events matching what the user is
 * currently viewing.  Filter changes require disconnect +
 * reconnect (the frontend handles this cleanly because
 * reconnecting is also when the snapshot reconciles state).
 *
 * Defense-in-depth poll: every 60s, query for orders updated
 * within the last 90s matching this filter.  Diff against the
 * per-connection cursor; emit any upserts/removes the bus
 * missed.  Catches missed-emit bugs in future code without
 * requiring perfect emit hygiene at every mutation site.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { ASSET_TICKERS } from '@morphit/asset-registry';
import type { Database } from '$db/pool';
import type { Poller } from '$indexer/poller';
import { logger } from '$log';
import { orderbookEventBus } from '$indexer/orderbookEventBus';
import { errorBody } from '$api/shared';
import {
	buildWhereClauses,
	makeFetchSerializer,
	rowToWire,
	sseEvent,
	type OrderbookStreamQuery,
	type OrderbookStreamRow
} from '$api/orderbookStreamHelpers';

const log = logger('orderbook-stream');

/** Backstop poll interval — catches order changes the bus
 *  missed (e.g., a future code path that mutates orders
 *  without calling recordOrderbookChange).  60s is well
 *  inside "real-time" UX while keeping DB load trivial. */
const FALLBACK_POLL_MS = 60_000;
/** Window for the fallback poll's "recently changed" filter.
 *  Slightly larger than FALLBACK_POLL_MS so two adjacent polls
 *  overlap; events near the boundary aren't missed. */
const FALLBACK_LOOKBACK_MS = 90_000;

/** Keep-alive comment every 25s to keep proxies/load balancers
 *  from idle-killing the connection. */
const KEEPALIVE_INTERVAL_MS = 25_000;

/** Per-connection cap on tracked-order set.  Without this, a
 *  long-lived connection that's seen lots of order churn
 *  accumulates ever-more orderIds in memory.  When we exceed
 *  the cap, drop oldest until we're back under.  The cap is
 *  permissive (1000) so users with tabs open all day still
 *  see correct state for everything they're plausibly looking
 *  at. */
const MAX_TRACKED_ORDERS = 1000;

/** Audit 2026-05 finding NEW-11-1: cap the per-connection
 *  pending-during-snapshot Set so a slow snapshot under heavy
 *  bus traffic can't grow memory unboundedly. Bounded in
 *  practice by total live-order count, but defense in depth.
 *  Mirror of chatStream PENDING_DURING_SNAPSHOT_CAP. */
const PENDING_DURING_SNAPSHOT_CAP = 1000;

/** Snapshot LIMIT — initial page size sent on connect.  Same
 *  default as the REST endpoint. */
const SNAPSHOT_LIMIT = 50;

/** Zod schema for query-string parsing.  Lives here (not in
 *  the helpers module) because the smoke runner doesn't have
 *  zod installed and the schema is only used by the route.
 *  The output type is structurally compatible with the plain
 *  OrderbookStreamQuery interface from helpers. */
const orderbookStreamQuerySchema = z.object({
	asset: z.enum(ASSET_TICKERS).optional(),
	side: z.enum(['buy', 'sell']).optional(),
	fiat_currency: z
		.string()
		.min(1)
		.max(120)
		// One or more uppercase ISO codes, comma-separated (see REST).
		.regex(/^[A-Z]+(,[A-Z]+)*$/)
		.optional(),
	location_region: z.string().min(1).max(128).optional(),
	payment_methods: z.string().min(1).max(256).optional(),
	min_trades: z.coerce.number().int().min(0).max(100).optional()
});

const FEEDBACK_AGGREGATE_JOIN = `
	LEFT JOIN (
	  SELECT subject, COUNT(*)::int AS c,
	         -- cp123 H1: time-decay weighted rating with 365-day
	         -- half-life.  Mirrors apps/indexer/src/api/orderbook.ts
	         -- + apps/indexer/src/api/feedback.ts so the SSE stream
	         -- shows the same numbers as the polled API.
	         ROUND(
	           SUM(rating * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))) /
	           NULLIF(SUM(POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))), 0),
	           2
	         )::numeric AS r
	    FROM feedback fb
	   WHERE fb.order_permlink IS NOT NULL
	     AND NOT EXISTS (
	       SELECT 1 FROM suspicious_reciprocity sr
	        WHERE sr.account_a = LEAST(fb.reviewer, fb.subject)
	          AND sr.account_b = GREATEST(fb.reviewer, fb.subject)
	   )
	     AND NOT EXISTS (
	       SELECT 1 FROM related_accounts ra
	        WHERE ra.account_a = LEAST(fb.reviewer, fb.subject)
	          AND ra.account_b = GREATEST(fb.reviewer, fb.subject)
	   )
	     -- Signal C exclusion (Part 113): drop rows from coordinated
	     -- pile-on attackers.  Same filter as orderbook.ts.
	     AND NOT EXISTS (
	       SELECT 1 FROM one_way_pile_on owpo,
	                    jsonb_array_elements(owpo.attacking_reviewers) attacker
	        WHERE owpo.subject = fb.subject
	          AND attacker->>'reviewer' = fb.reviewer
	   )
	     -- Signal D exclusion (cp123 H2): drop rows from reviewers
	     -- flagged for concentrating ≥80% of their reviews on a
	     -- single subject.  See signals.ts: detectReviewConcentration.
	     AND NOT EXISTS (
	       SELECT 1 FROM review_concentration rc
	        WHERE rc.reviewer = fb.reviewer
	          AND rc.dominant_subject = fb.subject
	   )
	   GROUP BY subject
	) f ON f.subject = o.account
	LEFT JOIN (
	  -- Engagement counter (Q11 follow-up): mirrors the same
	  -- aggregate used in /v1/orderbook so the SSE stream stays
	  -- in sync with the polled list.  See orderbook.ts for the
	  -- privacy posture comment + BATCH14-2 sock-puppet filter
	  -- rationale.
	  SELECT recipient, order_permlink,
	         COUNT(DISTINCT sender)::int AS distinct_senders_24h
	    FROM chat_messages cm
	   WHERE order_permlink IS NOT NULL
	     AND created_at > NOW() - INTERVAL '24 hours'
	     AND sender <> recipient
	     AND EXISTS (
	       SELECT 1 FROM feedback fb_eng
	        WHERE fb_eng.subject = cm.sender
	          AND fb_eng.order_permlink IS NOT NULL
	     )
	   GROUP BY recipient, order_permlink
	) e ON e.recipient = o.account AND e.order_permlink = o.permlink
`;

const ROW_SELECT = `
	SELECT o.account, o.permlink, o.side, o.asset, o.fiat_currency,
	       o.amount_min::text, o.amount_max::text, o.price_model,
	       o.location_region, o.payment_methods, o.terms,
	       o.fee_method,
	       COALESCE(f.c, 0)::int AS feedback_count,
	       CASE WHEN f.r IS NOT NULL THEN f.r::text ELSE NULL END AS weighted_rating,
	       (COALESCE(f.c, 0) < 4) AS is_new_trader,
	       COALESCE(e.distinct_senders_24h, 0)::int AS engagement_24h,
	       o.created_at, o.updated_at, o.expires_at
`;

/** Fetch the snapshot — the "first page" matching the filter,
 *  sort=recent, limit=SNAPSHOT_LIMIT. */
async function fetchSnapshot(db: Database, q: OrderbookStreamQuery, operatorAccount: string): Promise<OrderbookStreamRow[]> {
	const { where, params } = buildWhereClauses(q, 0, operatorAccount);
	const sql = `${ROW_SELECT}
		 FROM orders o
		 ${FEEDBACK_AGGREGATE_JOIN}
		 WHERE ${where.join(' AND ')}
		 ORDER BY o.updated_at DESC, o.account ASC, o.permlink ASC
		 LIMIT ${SNAPSHOT_LIMIT}`;
	const result = await db.query<OrderbookStreamRow>(sql, params);
	return result.rows;
}

/** Look up a single order by orderId ("account/permlink") AND
 *  apply the filter.  If the row matches, returns it; otherwise
 *  returns null.  Used by the bus listener to decide whether
 *  to emit upsert or remove for a particular order change. */
async function fetchOrderIfMatchesFilter(
	db: Database,
	orderId: string,
	q: OrderbookStreamQuery,
	operatorAccount: string
): Promise<OrderbookStreamRow | null> {
	const slash = orderId.indexOf('/');
	if (slash < 0) return null;
	const account = orderId.slice(0, slash);
	const permlink = orderId.slice(slash + 1);
	if (account.length === 0 || permlink.length === 0) return null;

	// We bind account + permlink as $1, $2; filter params start at $3.
	const { where, params } = buildWhereClauses(q, 2, operatorAccount);
	const sql = `${ROW_SELECT}
		 FROM orders o
		 ${FEEDBACK_AGGREGATE_JOIN}
		 WHERE o.account = $1 AND o.permlink = $2
		   AND ${where.join(' AND ')}
		 LIMIT 1`;
	const result = await db.query<OrderbookStreamRow>(sql, [account, permlink, ...params]);
	return result.rows[0] ?? null;
}

/** Fallback poll: orders updated in the last FALLBACK_LOOKBACK_MS
 *  matching the filter.  Used to catch bus-missed events. */
async function fetchRecentlyChanged(
	db: Database,
	q: OrderbookStreamQuery,
	operatorAccount: string
): Promise<OrderbookStreamRow[]> {
	const { where, params } = buildWhereClauses(q, 1, operatorAccount);
	const sql = `${ROW_SELECT}
		 FROM orders o
		 ${FEEDBACK_AGGREGATE_JOIN}
		 WHERE o.updated_at > $1
		   AND ${where.join(' AND ')}
		 ORDER BY o.updated_at DESC, o.account ASC, o.permlink ASC
		 LIMIT ${MAX_TRACKED_ORDERS}`;
	const cutoff = new Date(Date.now() - FALLBACK_LOOKBACK_MS);
	const result = await db.query<OrderbookStreamRow>(sql, [cutoff, ...params]);
	return result.rows;
}

export function orderbookStreamRoute(db: Database, poller: Poller, operatorAccount: string): Hono {
	const app = new Hono();

	app.get('/', (c) => {
		// Validate filter early — we want to reject bad filters
		// with HTTP 400 rather than starting a doomed SSE stream.
		const parsed = orderbookStreamQuerySchema.safeParse(
			Object.fromEntries(new URL(c.req.url).searchParams)
		);
		if (!parsed.success) {
			return c.json(
				errorBody('bad_request', parsed.error.issues.map((i) => i.message).join('; ')),
				400
			);
		}
		const filter = parsed.data;

		// Post-parse: payment_methods must yield ≥1 valid token after
		// splitting.  Mirrors the REST orderbook's check (F-26 audit
		// fix).  Without this, `?payment_methods=,,,` parses OK by
		// length but the SQL clause silently drops, giving the user
		// unfiltered results when they thought they'd filtered.
		if (filter.payment_methods !== undefined) {
			const tokens = filter.payment_methods
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0 && s.length <= 32);
			if (tokens.length === 0) {
				return c.json(errorBody('bad_request', 'payment_methods: no valid tokens'), 400);
			}
		}

		const encoder = new TextEncoder();

		// Per-connection state.
		const tracked = new Set<string>(); // orderIds we've sent as upserts
		const insertOrder: string[] = []; // FIFO for MAX_TRACKED_ORDERS bound

		// F-5/F-6 audit fixes — concurrency control:
		//
		// snapshotSent flips true once we've pushed the snapshot
		// event.  Bus emits arriving before that go into
		// pendingDuringSnapshot; we drain it through the normal
		// processing path immediately after pushing snapshot.
		// Eliminates the F-5 race (subscribe-after-snapshot
		// silently dropped events between the two).
		//
		// processOrderChange (built from makeFetchSerializer below)
		// guarantees at-most-one concurrent fetch per orderId.
		// Concurrent emits for the same orderId coalesce into
		// "fetch again on completion" — out-of-order responses
		// for the same orderId are impossible.  (F-6 audit fix.)
		let snapshotSent = false;
		const pendingDuringSnapshot = new Set<string>();

		let unsubscribeBus: (() => void) | null = null;
		let pollTimer: ReturnType<typeof setInterval> | null = null;
		let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
		let cancelled = false;

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const safePush = (chunk: string): void => {
					if (cancelled) return;
					try {
						controller.enqueue(encoder.encode(chunk));
					} catch {
						cleanup();
					}
				};

				const cleanup = (): void => {
					cancelled = true;
					if (unsubscribeBus !== null) {
						unsubscribeBus();
						unsubscribeBus = null;
					}
					if (pollTimer !== null) {
						clearInterval(pollTimer);
						pollTimer = null;
					}
					if (keepaliveTimer !== null) {
						clearInterval(keepaliveTimer);
						keepaliveTimer = null;
					}
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				};

				const trackUpsert = (orderId: string): void => {
					if (!tracked.has(orderId)) {
						tracked.add(orderId);
						insertOrder.push(orderId);
						// Bound the set: when we exceed MAX_TRACKED_ORDERS,
						// drop oldest.  We don't notify the client about
						// drops — the order stays visible in the user's
						// already-rendered DOM; we just stop tracking it
						// for future updates.  Acceptable trade-off
						// because it only affects users with very long
						// sessions, and the visible orders they care
						// about are the recent ones.
						while (insertOrder.length > MAX_TRACKED_ORDERS) {
							const evicted = insertOrder.shift();
							if (evicted !== undefined) tracked.delete(evicted);
						}
					}
				};

				/** Per-orderId serialized fetch + emit.  At-most-one
				 *  fetch in flight per orderId; concurrent emits for
				 *  the same orderId coalesce into "fetch again when
				 *  current completes." */
				const { schedule: processOrderChange } = makeFetchSerializer(
					async (orderId: string) => {
						try {
							const row = await fetchOrderIfMatchesFilter(db, orderId, filter, operatorAccount);
							if (cancelled) return;
							if (row !== null) {
								trackUpsert(orderId);
								safePush(sseEvent('order_upserted', rowToWire(row)));
							} else if (tracked.has(orderId)) {
								tracked.delete(orderId);
								const idx = insertOrder.indexOf(orderId);
								if (idx >= 0) insertOrder.splice(idx, 1);
								const slash = orderId.indexOf('/');
								safePush(
									sseEvent('order_removed', {
										account: orderId.slice(0, slash),
										permlink: orderId.slice(slash + 1)
									})
								);
							}
							// If row is null AND not tracked: orderId
							// doesn't match filter AND wasn't visible
							// to this subscriber → nothing to send.
						} catch (err) {
							log.warn('bus_lookup_failed', { orderId }, err);
						}
					},
					() => cancelled
				);

				// ─── Bus subscription FIRST (F-5 audit fix) ────
				// Subscribing before the snapshot fetch eliminates the
				// race window where on-bus events would silently drop.
				// During the snapshot, we queue arrivals; right after
				// pushing snapshot we drain the queue through the
				// normal processing path.
				//
				// The bus listener is synchronous (matches the bus's
				// dispatch contract); it just decides whether to queue
				// or process.
				unsubscribeBus = orderbookEventBus.on((orderId) => {
					if (cancelled) return;
					if (!snapshotSent) {
						// Audit NEW-11-1: drop when cap hit. The fallback
						// poll picks up missed events via its
						// recently-changed window.
						if (pendingDuringSnapshot.size >= PENDING_DURING_SNAPSHOT_CAP) {
							return;
						}
						pendingDuringSnapshot.add(orderId);
						return;
					}
					processOrderChange(orderId);
				});

				// ─── Initial snapshot ────
				try {
					const rows = await fetchSnapshot(db, filter, operatorAccount);
					const items = rows.map(rowToWire);
					for (const row of rows) {
						trackUpsert(`${row.account}/${row.permlink}`);
					}
					const indexedBlock = poller.getStatus().indexedBlock;
					safePush(
						sseEvent('snapshot', {
							items,
							indexed_block: indexedBlock
						})
					);
					snapshotSent = true;
				} catch (err) {
					log.error('snapshot_failed', {}, err);
					safePush(sseEvent('error', { message: 'failed to load initial snapshot' }));
					cleanup();
					return;
				}

				// ─── Drain pendingDuringSnapshot ────
				// Replay every orderId that got buffered while snapshot
				// was in flight.  processOrderChange is idempotent for
				// already-tracked orders (the row's current state gets
				// re-fetched, signature hasn't moved → no diff sent).
				// So replaying snapshot-included orders is harmless,
				// at worst a tiny bandwidth waste.
				const pendingCopy = Array.from(pendingDuringSnapshot);
				pendingDuringSnapshot.clear();
				for (const orderId of pendingCopy) {
					processOrderChange(orderId);
				}

				// ─── Defense-in-depth fallback poll ────
				pollTimer = setInterval(async () => {
					if (cancelled) return;
					try {
						const rows = await fetchRecentlyChanged(db, filter, operatorAccount);
						for (const row of rows) {
							const orderId = `${row.account}/${row.permlink}`;
							// Always emit upsert for any matching row in
							// the recent window — not just rows we haven't
							// tracked.  This catches the F-13 case: a row
							// we already tracked whose state changed but
							// whose bus emit was dropped.  Frontend
							// applyUpsert is idempotent (find-by-key,
							// replace), so re-sending the latest state for
							// already-tracked rows is harmless bandwidth.
							trackUpsert(orderId);
							safePush(sseEvent('order_upserted', rowToWire(row)));
						}
						// We deliberately do NOT diff for removals here.
						// fetchRecentlyChanged only returns rows still
						// visible (status='live', fee_status verified);
						// removed rows fail the WHERE clause so they're
						// absent.  But "absent from this poll" doesn't
						// mean "removed" — it could mean "not changed in
						// the last 90s."  So removal detection happens
						// only via the bus path, not here.
					} catch (err) {
						log.warn('fallback_poll_failed', {}, err);
					}
				}, FALLBACK_POLL_MS);

				// ─── Keepalive ────
				keepaliveTimer = setInterval(() => {
					if (cancelled) return;
					safePush(':keepalive\n\n');
				}, KEEPALIVE_INTERVAL_MS);
			},

			cancel(): void {
				cancelled = true;
				if (unsubscribeBus !== null) {
					unsubscribeBus();
					unsubscribeBus = null;
				}
				if (pollTimer !== null) {
					clearInterval(pollTimer);
					pollTimer = null;
				}
				if (keepaliveTimer !== null) {
					clearInterval(keepaliveTimer);
					keepaliveTimer = null;
				}
			}
		});

		c.header('Content-Type', 'text/event-stream');
		c.header('Cache-Control', 'no-store, no-transform');
		c.header('X-Accel-Buffering', 'no');
		c.header('Connection', 'keep-alive');
		return c.body(stream);
	});

	return app;
}
