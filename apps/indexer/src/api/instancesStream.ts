/**
 * Morphit indexer — /v1/instances/stream endpoint (Phase D.5).
 *
 * Server-Sent Events stream of federation directory changes.
 * Frontend subscribes via EventSource on the /instances page so
 * users see registrations and status flips in real time, no
 * page refresh required.
 *
 * Wire protocol (standard SSE):
 *
 *   event: snapshot
 *   data: {"version":1,"directory_updated_at":"...","instances":[...]}
 *
 *   event: instance_added
 *   data: {<single InstanceDirectoryEntry>}
 *
 *   event: instance_updated
 *   data: {<single InstanceDirectoryEntry>}
 *
 *   event: instance_removed
 *   data: {"origin":"https://..."}
 *
 *   :keepalive
 *
 * Implementation strategy: poll-based.  Every POLL_INTERVAL_MS
 * the connection re-queries known_instances + operators and
 * diffs against its in-memory cursor.  Volume is low enough
 * (≤200 instances, infrequent state changes) that this is
 * cheaper than wiring an in-process EventEmitter through every
 * mutation site, and impossible to miss an event from a
 * forgotten emit() call.
 *
 * Phase E (orderbook SSE) will use push-based emission instead
 * because order volume is much higher and latency requirements
 * tighter.  These patterns can co-exist; the wire format is the
 * same.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { logger } from '$log';
import {
	rowToEntry,
	rowSignature,
	sseEvent,
	type DirectoryRow,
	type InstanceDirectoryEntry
} from '$api/instancesStreamHelpers';

const log = logger('instances-stream');

/** How often to re-query known_instances and diff against the
 *  per-connection cursor.  5s is well under "real-time" UX
 *  perception threshold while keeping DB load trivial. */
const POLL_INTERVAL_MS = 5_000;

/** SSE keepalive ping interval.  Most reverse proxies + load
 *  balancers idle-kill connections after 30-60s of silence;
 *  25s leaves margin and avoids browser-side reconnect
 *  thrashing. */
const KEEPALIVE_INTERVAL_MS = 25_000;

async function fetchAllRows(db: Database): Promise<DirectoryRow[]> {
	const result = await db.query<DirectoryRow>(
		`SELECT
			ki.origin,
			ki.operator_account,
			op.tag                AS operator_tag,
			op.display_name       AS operator_display_name,
			ki.cached_name,
			ki.cached_tagline,
			ki.cached_contact_url,
			ki.cached_alt_networks,
			ki.last_probe_status,
			ki.registered_at_time,
			ki.last_probed_at,
			ki.cached_indexed_block,
			ki.cached_chain_lag_sec,
			ki.consecutive_failures
		 FROM known_instances ki
		 LEFT JOIN operators op ON op.account = ki.operator_account
		 ORDER BY ki.registered_at_time DESC`,
		[]
	);
	return result.rows;
}

export function instancesStreamRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/', (c) => {
		const encoder = new TextEncoder();

		// Per-connection state.  Re-allocated per request so
		// connections don't share signature maps.
		const cursor = new Map<string, string>(); // origin → signature

		let pollTimer: ReturnType<typeof setInterval> | null = null;
		let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
		let cancelled = false;
		// In-flight guard: prevents overlapping poll ticks if a
		// poll runs longer than POLL_INTERVAL_MS (slow DB, large
		// directory, etc.).  Without this, two concurrent ticks
		// would both query and could race-emit the same diff
		// twice.  (F-15 audit fix.)
		let pollInFlight = false;

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const safePush = (chunk: string): void => {
					if (cancelled) return;
					try {
						controller.enqueue(encoder.encode(chunk));
					} catch (err) {
						// Controller closed (client disconnected) — clean up.
						cleanup();
					}
				};

				const cleanup = (): void => {
					cancelled = true;
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
						// already closed
					}
				};

				// ─── Initial snapshot ────
				try {
					const rows = await fetchAllRows(db);
					const entries: InstanceDirectoryEntry[] = rows.map(rowToEntry);
					for (const e of entries) {
						cursor.set(e.origin, rowSignature(e));
					}
					safePush(
						sseEvent('snapshot', {
							version: 1,
							directory_updated_at: new Date().toISOString(),
							instances: entries
						})
					);
				} catch (err) {
					log.error('snapshot_failed', {}, err);
					safePush(
						sseEvent('error', {
							message: 'failed to load initial snapshot'
						})
					);
					cleanup();
					return;
				}

				// ─── Diff polling loop ────
				pollTimer = setInterval(async () => {
					if (cancelled) return;
					if (pollInFlight) return; // previous tick still running
					pollInFlight = true;
					try {
						const rows = await fetchAllRows(db);
						const seen = new Set<string>();
						for (const r of rows) {
							const entry = rowToEntry(r);
							const sig = rowSignature(entry);
							seen.add(entry.origin);
							const prev = cursor.get(entry.origin);
							if (prev === undefined) {
								safePush(sseEvent('instance_added', entry));
								cursor.set(entry.origin, sig);
							} else if (prev !== sig) {
								safePush(sseEvent('instance_updated', entry));
								cursor.set(entry.origin, sig);
							}
						}
						// Detect removals: anything in our cursor that's
						// not in this poll's result has been deleted from
						// known_instances (probe scheduler dropped a peer
						// after 7 consecutive failure days).
						for (const origin of cursor.keys()) {
							if (!seen.has(origin)) {
								safePush(sseEvent('instance_removed', { origin }));
								cursor.delete(origin);
							}
						}
					} catch (err) {
						// Transient DB hiccup; log and keep the stream
						// alive — next poll will recover.  We do not
						// emit an 'error' event for these because they
						// don't reflect any user-actionable state.
						log.warn('poll_failed', {}, err);
					} finally {
						pollInFlight = false;
					}
				}, POLL_INTERVAL_MS);

				// ─── Keepalive ────
				keepaliveTimer = setInterval(() => {
					if (cancelled) return;
					// `:` prefix = SSE comment, ignored by EventSource.
					// Just keeps proxies from idling out the connection.
					safePush(':keepalive\n\n');
				}, KEEPALIVE_INTERVAL_MS);
			},

			cancel(): void {
				// Browser disconnected (tab closed, navigation,
				// network drop).  Clean up timers so we don't leak.
				cancelled = true;
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
		c.header('X-Accel-Buffering', 'no'); // disable nginx buffering
		// Connection: keep-alive is the HTTP/1 default and HTTP/2
		// ignores it.  Setting explicitly is harmless and helpful
		// for older proxies.
		c.header('Connection', 'keep-alive');
		return c.body(stream);
	});

	return app;
}
