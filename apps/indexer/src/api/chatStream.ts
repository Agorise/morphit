/**
 * Morphit indexer — /v1/chat/:a/:b/stream endpoint (Phase E.5).
 *
 * Server-Sent Events stream of new chat messages between two
 * accounts.  Frontend's ConversationView subscribes via
 * EventSource on chat-route mount; the user sees messages
 * appear in real time without polling.
 *
 * Wire protocol:
 *
 *   event: snapshot
 *   data: {"items":[<ChatMessageRecord>...],"indexed_block":12345}
 *
 *   event: message_appended
 *   data: {<single ChatMessageRecord>}
 *
 *   :keepalive
 *
 * Push mechanism: subscribes to the in-process chatEventBus.
 * The chat handler emits (lo, hi, messageId) on the bus AFTER
 * the block transaction commits, so SSE subscribers never see
 * phantom events from rolled-back ops.
 *
 * Filter is the canonical conversation pair (LEAST(a,b),
 * GREATEST(a,b)) parsed from URL path params.  Same
 * canonicalization the REST endpoint uses.  Server-side filter
 * means each connection only receives events for its specific
 * pair — the bus carries (lo, hi) in the payload so the listener
 * filters in-memory before issuing a row fetch.
 *
 * Defense-in-depth poll: every 60s, query for messages with
 * `id > latestEmittedId` for this pair.  Catches missed bus
 * emits from future code paths.  Chat messages are immutable
 * once inserted (no update path) so the watermark is sufficient
 * — no re-emit-on-update logic needed.
 *
 * No per-id serializer (unlike orderbookStream's
 * makeFetchSerializer): each chat message has a unique id and
 * fetches for different ids are independent.  Concurrent
 * fetches for distinct ids can race in delivery order, but the
 * frontend sorts by created_at, so a brief out-of-order delivery
 * is invisible.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import type { Poller } from '$indexer/poller';
import { logger } from '$log';
import { chatEventBus, type ChatEvent } from '$indexer/chatEventBus';
import { errorBody } from '$api/shared';
import {
	eventMatchesFilter,
	parseFilter,
	rowToWire,
	sseEvent,
	type ChatStreamFilter,
	type ChatStreamRow
} from '$api/chatStreamHelpers';

const log = logger('chat-stream');

/** Backstop poll interval — catches messages the bus missed.
 *  60s matches the orderbook stream; chat is more
 *  latency-sensitive but at <1msg/s typical the bus path is
 *  reliable enough that 60s is a safety net, not a primary
 *  channel. */
const FALLBACK_POLL_MS = 60_000;

/** Keep-alive comment every 25s to defeat proxy idle-killers. */
const KEEPALIVE_INTERVAL_MS = 25_000;

/** Snapshot LIMIT — initial page size sent on connect.  Same
 *  as the REST endpoint's default. */
const SNAPSHOT_LIMIT = 50;

/** P7-2 audit hardening: cap on the queue that buffers bus events
 *  arriving DURING the initial snapshot fetch.  Without a cap, a
 *  slow snapshot query against a hostile DB combined with a high-
 *  rate message stream could grow this array without bound. */
const PENDING_DURING_SNAPSHOT_CAP = 1000;

const ROW_SELECT = `
	SELECT id::text, sender, recipient, ciphertext, header, created_at
`;

async function fetchSnapshot(db: Database, f: ChatStreamFilter): Promise<ChatStreamRow[]> {
	const sql = `${ROW_SELECT}
		 FROM chat_messages
		 WHERE LEAST(sender, recipient) = $1
		   AND GREATEST(sender, recipient) = $2
		 ORDER BY created_at DESC, id ASC
		 LIMIT ${SNAPSHOT_LIMIT}`;
	const result = await db.query<{
		id: string;
		sender: string;
		recipient: string;
		ciphertext: string;
		header: unknown;
		created_at: Date;
	}>(sql, [f.lo, f.hi]);
	// pg returns BIGINT-as-string for id::text; coerce to JS number.
	// cp138 A-3 correction: schema declares chat_messages.id as
	// BIGSERIAL (not SERIAL as a prior comment claimed).  Range is
	// 2^63 (max ~9.2e18); JS Number.MAX_SAFE_INTEGER is 2^53 (~9e15).
	// At Morphit's projected message volume — even very optimistic
	// adoption scenarios — we won't reach 2^53 messages in a
	// generation, so parseInt is safe in practice.  If we ever
	// approach 2^53 messages, this codepath needs to switch to
	// string-based ids end-to-end (DB → wire → client) since JSON
	// has no native bigint.  cp138 R-1 tracks this in
	// REVISIT-LIST.md as "bigint id propagation, post-launch
	// scaling work."  Reverse the list to match the wire-format
	// expectation of newest-first.
	return result.rows.map((r) => ({
		id: parseInt(r.id, 10),
		sender: r.sender,
		recipient: r.recipient,
		ciphertext: r.ciphertext,
		header: r.header,
		created_at: r.created_at
	}));
}

async function fetchMessageById(
	db: Database,
	messageId: number,
	f: ChatStreamFilter
): Promise<ChatStreamRow | null> {
	// Filter the lookup by the canonical pair too — defense in depth
	// against a buggy emit that carried the wrong pair.  An out-of-
	// pair id silently no-ops rather than leaking another pair's
	// ciphertext to this subscriber.
	const sql = `${ROW_SELECT}
		 FROM chat_messages
		 WHERE id = $1
		   AND LEAST(sender, recipient) = $2
		   AND GREATEST(sender, recipient) = $3
		 LIMIT 1`;
	const result = await db.query<{
		id: string;
		sender: string;
		recipient: string;
		ciphertext: string;
		header: unknown;
		created_at: Date;
	}>(sql, [messageId, f.lo, f.hi]);
	const row = result.rows[0];
	if (row === undefined) return null;
	return {
		id: parseInt(row.id, 10),
		sender: row.sender,
		recipient: row.recipient,
		ciphertext: row.ciphertext,
		header: row.header,
		created_at: row.created_at
	};
}

async function fetchSinceId(
	db: Database,
	f: ChatStreamFilter,
	sinceId: number
): Promise<ChatStreamRow[]> {
	const sql = `${ROW_SELECT}
		 FROM chat_messages
		 WHERE LEAST(sender, recipient) = $1
		   AND GREATEST(sender, recipient) = $2
		   AND id > $3
		 ORDER BY id ASC
		 LIMIT 200`;
	const result = await db.query<{
		id: string;
		sender: string;
		recipient: string;
		ciphertext: string;
		header: unknown;
		created_at: Date;
	}>(sql, [f.lo, f.hi, sinceId]);
	return result.rows.map((r) => ({
		id: parseInt(r.id, 10),
		sender: r.sender,
		recipient: r.recipient,
		ciphertext: r.ciphertext,
		header: r.header,
		created_at: r.created_at
	}));
}

export function chatStreamRoute(db: Database, poller: Poller): Hono {
	const app = new Hono();

	app.get('/:a/:b/stream', (c) => {
		const a = c.req.param('a');
		const b = c.req.param('b');
		const parsed = parseFilter(a, b);
		if ('error' in parsed) {
			return c.json(errorBody('bad_request', parsed.error), 400);
		}
		const filter = parsed;

		const encoder = new TextEncoder();

		// Per-connection state.
		// snapshotSent flips true once we've pushed the snapshot
		// event.  Bus emits arriving before that go into
		// pendingDuringSnapshot; we drain them through the normal
		// processing path immediately after pushing snapshot.
		// Eliminates the F-5-class race (subscribe-after-snapshot
		// silently dropping events).
		let snapshotSent = false;
		const pendingDuringSnapshot: ChatEvent[] = [];

		// latestEmittedId — highest message id we've sent to this
		// subscriber (snapshot OR diff).  The fallback poll uses
		// this as a watermark to find any messages we missed.
		// Initialized to 0 (no messages emitted yet).
		let latestEmittedId = 0;

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

				/** Look up a single message by id and push if it
				 *  matches the filter.  Bumps latestEmittedId so
				 *  the fallback poll's watermark stays current.
				 *  Errors caught + logged; the stream stays alive.
				 */
				const processMessage = async (messageId: number): Promise<void> => {
					if (cancelled) return;
					try {
						const row = await fetchMessageById(db, messageId, filter);
						if (cancelled) return;
						if (row === null) return; // not for our pair (defensive)
						safePush(sseEvent('message_appended', rowToWire(row)));
						if (row.id > latestEmittedId) {
							latestEmittedId = row.id;
						}
					} catch (err) {
						log.warn('bus_lookup_failed', { messageId }, err);
					}
				};

				// ─── Bus subscription FIRST (F-5 audit pattern) ────
				// Subscribe before fetching snapshot so events
				// arriving during the snapshot get queued, not
				// dropped.
				unsubscribeBus = chatEventBus.on((ev) => {
					if (cancelled) return;
					if (!eventMatchesFilter(ev, filter)) return;
					if (!snapshotSent) {
						// P7-2 audit fix: drop events when cap hit.
						// The fallback poll picks them up via
						// latestEmittedId watermark.
						if (pendingDuringSnapshot.length >= PENDING_DURING_SNAPSHOT_CAP) {
							return;
						}
						pendingDuringSnapshot.push(ev);
						return;
					}
					void processMessage(ev.messageId);
				});

				// ─── Initial snapshot ────
				try {
					const rows = await fetchSnapshot(db, filter);
					const items = rows.map(rowToWire);
					// Track watermark from the snapshot's max id.
					for (const row of rows) {
						if (row.id > latestEmittedId) {
							latestEmittedId = row.id;
						}
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
				// Replay messages that arrived while snapshot was in
				// flight.  Each goes through processMessage, which
				// re-fetches the row and pushes message_appended.
				// Some may already be in the snapshot (the snapshot
				// committed after the emit landed); the frontend's
				// applyMessage is idempotent on id, so dup is fine.
				const drained = pendingDuringSnapshot.splice(0, pendingDuringSnapshot.length);
				for (const ev of drained) {
					void processMessage(ev.messageId);
				}

				// ─── Defense-in-depth fallback poll ────
				pollTimer = setInterval(async () => {
					if (cancelled) return;
					try {
						const rows = await fetchSinceId(db, filter, latestEmittedId);
						for (const row of rows) {
							safePush(sseEvent('message_appended', rowToWire(row)));
							if (row.id > latestEmittedId) {
								latestEmittedId = row.id;
							}
						}
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
