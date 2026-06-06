/**
 * Morphit frontend — orderbook SSE subscription composable (Phase E).
 *
 * Connects to /v1/orderbook/stream, applies snapshot + diff
 * events to the page's items array via a buffered render
 * trick (one DOM update per requestAnimationFrame regardless
 * of event arrival rate).
 *
 * Usage:
 *   const stream = createOrderbookStream({
 *     query: () => currentQuery(),
 *     applyUpsert: (entry) => { ...mutate items... },
 *     applyRemove: ({ account, permlink }) => { ...mutate items... },
 *     onSnapshot: (snapshot) => { ...replace items... }
 *   });
 *   stream.start();   // Open EventSource
 *   stream.stop();    // Close, called on unmount or filter change
 *
 * Buffer-and-flush rationale: a Blurt block can include
 * dozens of order ops at once.  Without buffering, each
 * SSE event triggers a Svelte rerender — 50 rerenders in
 * <100ms is visible jank.  Buffering coalesces into one
 * render per animation frame at the cost of ≤16ms latency.
 */

import { browser } from '$app/environment';
import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
import type { OrderRecord, OrderbookQuery } from '@morphit/indexer-client';

export interface OrderbookSnapshot {
	readonly items: readonly OrderRecord[];
	readonly indexed_block: number;
}

export interface OrderbookStreamHandlers {
	/** Called once on connect (or on each reconnect — the EventSource
	 *  auto-reconnects after a network blip).  Treat as authoritative
	 *  state; replace the items array. */
	onSnapshot: (snap: OrderbookSnapshot) => void;
	/** Called per applied diff event.  Find by (account, permlink),
	 *  replace if exists, otherwise insert at the right sort position. */
	applyUpsert: (entry: OrderRecord) => void;
	/** Called when an order is no longer visible to this filter. */
	applyRemove: (id: { account: string; permlink: string }) => void;
	/** Provide the current filter; called when start() runs (and
	 *  in theory could be called by a future "soft restart" if we
	 *  add filter-change handling without reconnect — not v1). */
	query: () => OrderbookQuery;
	/** Optional: called when the connection's connected/disconnected
	 *  state flips.  Used to render a "Live" pip in the page header. */
	onStreamingChange?: (streaming: boolean) => void;
}

export interface OrderbookStreamHandle {
	start(): void;
	stop(): void;
}

interface BufferedEvent {
	type: 'upsert' | 'remove';
	upsert?: OrderRecord;
	remove?: { account: string; permlink: string };
}

/** Construct the SSE URL for the given filter.  Mirrors the
 *  query-string format the REST orderbook endpoint accepts. */
function buildStreamUrl(query: OrderbookQuery): string {
	const params = new URLSearchParams();
	if (query.asset) params.set('asset', query.asset);
	if (query.side) params.set('side', query.side);
	if (query.fiat_currency) params.set('fiat_currency', query.fiat_currency);
	if (query.location_region) params.set('location_region', query.location_region);
	if (query.payment_methods) params.set('payment_methods', query.payment_methods);
	if (query.min_trades !== undefined && query.min_trades > 0) {
		params.set('min_trades', String(query.min_trades));
	}
	const qs = params.toString();
	// Root-absolute path + new URL() → `<origin>/v1/orderbook/stream`,
	// discarding any path on the configured origin. Append the query
	// via the URL object so we never string-concat a stale prefix.
	const u = new URL('/v1/orderbook/stream', resolveOrigin(MORPHIT_INDEXER_ORIGIN));
	u.search = qs;
	return u.href;
}

export function createOrderbookStream(handlers: OrderbookStreamHandlers): OrderbookStreamHandle {
	let eventSource: EventSource | null = null;
	let rafHandle: number | null = null;
	const buffer: BufferedEvent[] = [];
	let started = false;

	/** Audit 2026-05 finding NEW-10-2 hardening (parity with chat
	 *  stream finding 2-11): cap the buffer to prevent unbounded
	 *  memory growth if the SSE source emits faster than rAF can
	 *  flush (paused tab, debugger break, background throttling, or
	 *  hostile server). On overflow, drop oldest events — the next
	 *  snapshot will reconcile.  Choice of 500 mirrors the chat
	 *  stream cap. */
	const MAX_BUFFER_SIZE = 500;

	function appendToBuffer(ev: BufferedEvent): void {
		buffer.push(ev);
		if (buffer.length > MAX_BUFFER_SIZE) {
			// Drop oldest. Splice rather than shift so we cap in one
			// op even if we've gone way over (defense in depth: a
			// burst from a non-cooperative server shouldn't trigger
			// quadratic shifting).
			buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
		}
	}

	function setStreaming(s: boolean): void {
		handlers.onStreamingChange?.(s);
	}

	function flushBuffer(): void {
		rafHandle = null;
		if (buffer.length === 0) return;
		// Drain buffer into a local copy first so re-entry from
		// inside an applyUpsert/applyRemove callback (e.g. a
		// $derived recomputation that schedules new work) doesn't
		// re-process the same events.
		const drained = buffer.splice(0, buffer.length);
		for (const ev of drained) {
			if (ev.type === 'upsert' && ev.upsert !== undefined) {
				handlers.applyUpsert(ev.upsert);
			} else if (ev.type === 'remove' && ev.remove !== undefined) {
				handlers.applyRemove(ev.remove);
			}
		}
	}

	function scheduleFlush(): void {
		if (rafHandle !== null) return; // already scheduled
		// requestAnimationFrame keeps DOM updates aligned with the
		// browser's render cycle; falls back to setTimeout(16) when
		// rAF isn't available (very rare; some headless contexts).
		if (typeof requestAnimationFrame === 'function') {
			rafHandle = requestAnimationFrame(flushBuffer);
		} else {
			rafHandle = setTimeout(flushBuffer, 16) as unknown as number;
		}
	}

	function start(): void {
		if (!browser) return;
		if (started) return;
		started = true;
		if (typeof EventSource === 'undefined') {
			// Browser without EventSource: graceful no-op.  The page
			// continues to work via its REST-based load + manual
			// refresh.  Modern browsers all support EventSource so
			// this branch rarely fires.
			return;
		}
		const url = buildStreamUrl(handlers.query());
		eventSource = new EventSource(url);

		eventSource.addEventListener('snapshot', (ev: MessageEvent) => {
			try {
				const snap = JSON.parse(ev.data) as OrderbookSnapshot;
				// Drop any pending buffered diffs — snapshot is
				// authoritative.  Subsequent diffs will rebuild on
				// top of this state.
				buffer.length = 0;
				if (rafHandle !== null) {
					if (typeof cancelAnimationFrame === 'function') {
						cancelAnimationFrame(rafHandle);
					} else {
						clearTimeout(rafHandle);
					}
					rafHandle = null;
				}
				handlers.onSnapshot(snap);
				setStreaming(true);
			} catch {
				// Bad JSON — server bug; let the next snapshot
				// reconcile.
			}
		});

		eventSource.addEventListener('order_upserted', (ev: MessageEvent) => {
			try {
				const entry = JSON.parse(ev.data) as OrderRecord;
				appendToBuffer({ type: 'upsert', upsert: entry });
				scheduleFlush();
			} catch {
				// see above
			}
		});

		eventSource.addEventListener('order_removed', (ev: MessageEvent) => {
			try {
				const remove = JSON.parse(ev.data) as {
					account: string;
					permlink: string;
				};
				appendToBuffer({ type: 'remove', remove });
				scheduleFlush();
			} catch {
				// see above
			}
		});

		eventSource.addEventListener('error', () => {
			// EventSource auto-reconnects.  Mark streaming false
			// transiently so the UI can dim the "Live" pip; it'll
			// flip back true when the next snapshot arrives.
			setStreaming(false);
		});
	}

	function stop(): void {
		started = false;
		if (eventSource !== null) {
			eventSource.close();
			eventSource = null;
		}
		if (rafHandle !== null) {
			if (typeof cancelAnimationFrame === 'function') {
				cancelAnimationFrame(rafHandle);
			} else {
				clearTimeout(rafHandle);
			}
			rafHandle = null;
		}
		buffer.length = 0;
		setStreaming(false);
	}

	return { start, stop };
}
