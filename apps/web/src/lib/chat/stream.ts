/**
 * Morphit frontend — chat SSE subscription composable (Phase E.5).
 *
 * Connects to /v1/chat/:me/:peer/stream, applies snapshot +
 * message_appended events via a buffered render trick (one
 * DOM update per requestAnimationFrame regardless of event
 * arrival rate).
 *
 * Usage:
 *   const stream = createChatStream({
 *     me, peer,
 *     onSnapshot: (snap) => { ...replace messages... },
 *     applyAppend: (rec) => { ...append message... },
 *     onStreamingChange: (s) => { streaming = s; }
 *   });
 *   stream.start();
 *   stream.stop();    // on unmount
 *
 * Buffer-and-flush rationale: same as orderbook stream — a
 * burst of new messages (e.g., the user comes back from being
 * AFK and 5 messages have arrived during a single block)
 * shouldn't cause 5 separate Svelte rerenders.  Coalesce into
 * one render per animation frame at the cost of ≤16ms latency.
 *
 * Reconnect behavior: EventSource auto-reconnects on network
 * blip.  On each reconnect the server sends a fresh snapshot,
 * which we treat as authoritative — drop any pending buffered
 * appends, replace local state with the snapshot.  Subsequent
 * appends rebuild on top of that authoritative state.
 *
 * Differences from orderbook stream:
 *   - No filter object (URL is fixed at construction).
 *   - No applyRemove / applyUpsert — chat messages are
 *     append-only and immutable.
 *   - No restart-on-filter-change pattern (peer doesn't
 *     change without a route navigation, which destroys this
 *     stream entirely).
 */

import { browser } from '$app/environment';
import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import { chatDebug, tagPreview } from './debug';

function headerTag(header: unknown): string | null {
	if (header && typeof header === 'object' && 'client_tag' in header) {
		const t = (header as { client_tag?: unknown }).client_tag;
		return typeof t === 'string' ? t : null;
	}
	return null;
}

export interface ChatSnapshot {
	readonly items: readonly ChatMessageRecord[];
	readonly indexed_block: number;
}

export interface ChatStreamHandlers {
	/** Called once on connect (or on each reconnect — the
	 *  EventSource auto-reconnects after a network blip).  Treat
	 *  as authoritative state; replace whatever messages were
	 *  loaded with the snapshot's items. */
	onSnapshot: (snap: ChatSnapshot) => void;
	/** Called per appended message event.  Append to local list,
	 *  reconciling against any pending/broadcast outgoing message
	 *  by client_tag (the controller does this). */
	applyAppend: (rec: ChatMessageRecord) => void;
	/** Optional: called when the connection's connected/disconnected
	 *  state flips.  Used to render a "Live" pip in the page header. */
	onStreamingChange?: (streaming: boolean) => void;
}

export interface ChatStreamHandle {
	start(): void;
	stop(): void;
}

interface BufferedEvent {
	type: 'append';
	append: ChatMessageRecord;
}

/** Audit 2026-05 finding 2-11: cap the buffer so a hostile or
 *  malfunctioning indexer cannot drive unbounded memory growth
 *  by spamming `message_appended` events faster than the UI
 *  thread can drain them.  500 entries per frame is plenty for
 *  any honest workload; sustained overflow indicates abuse. */
const MAX_BUFFER_SIZE = 500;

function buildStreamUrl(me: string, peer: string): string {
	// Root-absolute path + new URL() resolves to `<origin>/v1/...`,
	// discarding any path on the configured origin (correct for both
	// colocated and split topologies). String-concat would re-introduce
	// a stale prefix on single-host deploys.
	return new URL(
		`/v1/chat/${encodeURIComponent(me)}/${encodeURIComponent(peer)}/stream`,
		resolveOrigin(MORPHIT_INDEXER_ORIGIN)
	).href;
}

export function createChatStream(args: {
	me: string;
	peer: string;
	handlers: ChatStreamHandlers;
}): ChatStreamHandle {
	const { me, peer, handlers } = args;

	let eventSource: EventSource | null = null;
	let rafHandle: number | null = null;
	const buffer: BufferedEvent[] = [];
	let started = false;

	function setStreaming(s: boolean): void {
		handlers.onStreamingChange?.(s);
	}

	function flushBuffer(): void {
		rafHandle = null;
		if (buffer.length === 0) return;
		// Drain into a local copy first so re-entry from inside an
		// applyAppend callback (e.g. a $derived recomputation)
		// doesn't re-process the same events.
		const drained = buffer.splice(0, buffer.length);
		for (const ev of drained) {
			if (ev.type === 'append') {
				handlers.applyAppend(ev.append);
			}
		}
	}

	function scheduleFlush(): void {
		if (rafHandle !== null) return;
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
			// No EventSource — graceful no-op.  The controller's
			// REST snapshot still fires (controller still calls
			// the indexer client at start time).  Real-time updates
			// are simply unavailable on this rare browser.
			return;
		}
		const url = buildStreamUrl(me, peer);
		chatDebug('sse.connect', { me, peer, url });
		eventSource = new EventSource(url);

		eventSource.addEventListener('open', () => {
			chatDebug('sse.open', { me, peer });
		});

		eventSource.addEventListener('snapshot', (ev: MessageEvent) => {
			try {
				const snap = JSON.parse(ev.data) as ChatSnapshot;
				chatDebug('sse.snapshot', {
					me,
					peer,
					count: snap.items.length,
					indexed_block: snap.indexed_block,
					items: snap.items.map((it) => ({
						id: it.id,
						sender: it.sender,
						recipient: it.recipient,
						order: it.order_permlink ?? null,
						tag: tagPreview(headerTag(it.header))
					}))
				});
				// Drop any pending buffered diffs — snapshot is
				// authoritative.
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
				// Bad JSON — server bug; the next snapshot will
				// reconcile.
			}
		});

		eventSource.addEventListener('message_appended', (ev: MessageEvent) => {
			try {
				const rec = JSON.parse(ev.data) as ChatMessageRecord;
				chatDebug('sse.appended', {
					me,
					peer,
					id: rec.id,
					provisional: rec.id === 0,
					sender: rec.sender,
					recipient: rec.recipient,
					order: rec.order_permlink ?? null,
					tag: tagPreview(headerTag(rec.header))
				});
				if (buffer.length >= MAX_BUFFER_SIZE) {
					// Drop oldest event to make room.  In a healthy
					// workload we never hit this path; if we do, the
					// indexer is misbehaving and the UI will catch up
					// when the indexer stops or we reconnect (which
					// triggers a fresh authoritative snapshot).
					buffer.shift();
				}
				buffer.push({ type: 'append', append: rec });
				scheduleFlush();
			} catch {
				// see above
			}
		});

		eventSource.addEventListener('error', () => {
			// EventSource auto-reconnects.  Mark streaming false
			// transiently so the UI can dim the "Live" pip; flips
			// back true when the next snapshot arrives.
			chatDebug('sse.error', {
				me,
				peer,
				readyState: eventSource?.readyState ?? -1 // 0=connecting,1=open,2=closed
			});
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
