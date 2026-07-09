/**
 * Morphit indexer — /v1/chat-activity/:account/stream endpoint.
 *
 * A GLOBAL (all-conversations) Server-Sent Events stream for one account.
 * Where /v1/chat/:a/:b/stream is per-conversation (only the OPEN chat gets
 * real-time), this pushes a tiny "activity" ping whenever `account` is a
 * participant in ANY new chat message — so the inbox list, the avatar-menu
 * badge, and the browser-tab badge all update sub-second instead of on a poll.
 *
 * ── PRIVACY (priority #1) — why this leaks nothing new ──────────────────────
 *   - SAME-ORIGIN: the browser talks only to the operator's own indexer (the
 *     same one it already queries for getConversations). No third party.
 *   - The operator's indexer ALREADY indexes every on-chain chat op (it must,
 *     to serve conversations). This endpoint exposes nothing the indexer
 *     didn't already have.
 *   - The ping carries ONLY `{ peer }` — the other participant's account name,
 *     which is on-chain-PUBLIC metadata. It does NOT carry the ciphertext,
 *     the header, the message id, or any content. A conversation the user
 *     isn't viewing never has its ciphertext streamed here at all — strictly
 *     LESS data than the per-conversation stream.
 *   - Message CONTENT stays end-to-end encrypted; the client re-fetches its
 *     conversation summary via the existing same-origin getConversations on
 *     each ping and decrypts locally only what it chooses to open.
 *
 * Wire protocol:
 *
 *   event: ready
 *   data: {}
 *
 *   event: chat_activity
 *   data: {"peer":"<account>"}
 *
 *   :keepalive
 *
 * No snapshot and no fallback poll here: the client already holds its inbox
 * (from getConversations on mount) and keeps a ≤6s poll as its own backstop,
 * so this stream is purely the sub-second push. Subscribes to BOTH the durable
 * chatEventBus (post-DB-insert) and the head-block fast path (ADR-0048,
 * sub-second, when the operator enabled the tailer).
 */

import { Hono } from 'hono';

import { logger } from '$log';
import { chatEventBus } from '$indexer/chatEventBus';
import { errorBody, isAccountName } from '$api/shared';
import { sseEvent } from '$api/chatStreamHelpers';

const log = logger('chat-activity-stream');

/** Keep-alive comment every 25s to defeat proxy idle-killers. */
const KEEPALIVE_INTERVAL_MS = 25_000;

export function chatActivityStreamRoute(): Hono {
	const app = new Hono();

	app.get('/:account/stream', (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const encoder = new TextEncoder();
		let unsubscribeBus: (() => void) | null = null;
		let unsubscribeFastBus: (() => void) | null = null;
		let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
		let cancelled = false;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
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
					if (unsubscribeFastBus !== null) {
						unsubscribeFastBus();
						unsubscribeFastBus = null;
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

				// Push a lightweight activity ping: ONLY the peer account
				// (on-chain-public), never content. The client re-fetches its
				// conversation summary (same-origin) in response.
				const pushActivity = (peer: string): void => {
					safePush(sseEvent('chat_activity', { peer }));
				};

				// Durable path — fires after the message is inserted. ChatEvent
				// carries the canonical pair (lo, hi); `account` is a participant
				// iff it equals one of them, and the peer is the other.
				unsubscribeBus = chatEventBus.on((ev) => {
					if (cancelled) return;
					if (ev.lo !== account && ev.hi !== account) return;
					pushActivity(ev.lo === account ? ev.hi : ev.lo);
				});

				// Head-block fast path (ADR-0048) — sub-second, pre-DB. No-op
				// unless the operator enabled the tailer. Carries sender/recipient
				// directly, so the peer is the participant that isn't `account`.
				unsubscribeFastBus = chatEventBus.onFast((ev) => {
					if (cancelled) return;
					if (ev.lo !== account && ev.hi !== account) return;
					pushActivity(ev.sender === account ? ev.recipient : ev.sender);
				});

				// Tell the client the stream is live so it can do one immediate
				// sync (and re-sync after any auto-reconnect). No data.
				safePush(sseEvent('ready', {}));

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
				if (unsubscribeFastBus !== null) {
					unsubscribeFastBus();
					unsubscribeFastBus = null;
				}
				if (keepaliveTimer !== null) {
					clearInterval(keepaliveTimer);
					keepaliveTimer = null;
				}
			}
		});

		log.debug('activity_stream_open', { account });

		c.header('Content-Type', 'text/event-stream');
		c.header('Cache-Control', 'no-store, no-transform');
		c.header('X-Accel-Buffering', 'no');
		c.header('Connection', 'keep-alive');
		return c.body(stream);
	});

	return app;
}
