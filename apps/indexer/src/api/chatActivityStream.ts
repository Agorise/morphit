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
 *   data: {"peer":"<account>","order":"<permlink>|''|null","inbound":true|false,
 *          "at":<epoch-ms>|null}
 *
 *   `order` is the thread's order permlink ('' for an order-less thread), or
 *   null on the durable path where the event carries no order — the client
 *   treats null as "just reconcile". `inbound` is true when the message was sent
 *   TO this account; a participant stream also fires for what you SEND, and a
 *   client must not badge you about your own words.
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

				// Push a lightweight activity ping: the peer account, the order the
				// thread is about, and whether the message was INBOUND — all
				// on-chain-public metadata, never content.
				//
				// v1.7.5 (t.txt #1) — `order` and `inbound` are new, and they are what
				// make the badge fast for a user who has NOT granted push permission.
				// Before, this ping said only "something happened with <peer>", so the
				// client's only move was to re-poll `getConversations` — which reads
				// the durable table the fast path deliberately never writes, so the
				// poll returned the same stale `last_message_at` and the badge stayed
				// dark for ~45-63s. The Web Push carried the thread; this ping didn't,
				// so the badge was only ever as fast as the user's push permission.
				//
				// Both fields are strictly on-chain-public, so the header's privacy
				// argument is unchanged: the chat op itself names sender, recipient and
				// order_permlink on a public chain. Anyone who wants this can read
				// Blurt directly — this endpoint still exposes nothing the indexer (or
				// the chain) didn't already have, and still no ciphertext, header, or
				// message id.
				//
				// `inbound` matters as much as `order`: this stream fires for messages
				// the account SENT as well as received (it's a participant stream). A
				// client that lit its badge on every ping would nag the sender about
				// their own message on their other devices — exactly the bug t.txt #2
				// reports. The client uses this to light only what's genuinely waiting.
				const pushActivity = (
					peer: string,
					order: string | null,
					inbound: boolean,
					atMs?: number
				): void => {
					safePush(sseEvent('chat_activity', { peer, order, inbound, at: atMs ?? null }));
				};

				// Durable path — fires after the message is inserted. ChatEvent
				// carries the canonical pair (lo, hi); `account` is a participant
				// iff it equals one of them, and the peer is the other.
				unsubscribeBus = chatEventBus.on((ev) => {
					if (cancelled) return;
					if (ev.lo !== account && ev.hi !== account) return;
					// ChatEvent carries only the canonical pair, so there's no order and
					// no direction here — and none is needed: this fires AFTER the row is
					// inserted, so the client's re-poll reads the real thing. `order:
					// null` tells the client "no fast hint, just reconcile", which is
					// exactly right for the durable path.
					pushActivity(ev.lo === account ? ev.hi : ev.lo, null, false);
				});

				// Head-block fast path (ADR-0048) — sub-second, pre-DB. No-op
				// unless the operator enabled the tailer. Carries sender/recipient
				// directly, so the peer is the participant that isn't `account`.
				unsubscribeFastBus = chatEventBus.onFast((ev) => {
					if (cancelled) return;
					if (ev.lo !== account && ev.hi !== account) return;
					// The fast event carries sender/recipient/orderPermlink directly, so
					// this ping can name the exact thread — which is what lets the client
					// light the badge NOW instead of re-polling a table that won't know
					// about this message for another ~45-63s.
					pushActivity(
						ev.sender === account ? ev.recipient : ev.sender,
						ev.orderPermlink ?? '',
						ev.recipient === account
					);
				});

				// v1.7.5 (t.txt #1) — REPLAY before `ready`.
				//
				// Ken: "even when the browser itself or tab is closed completely, and
				// then I open a new tab and go to Morphit, I want the badges in 6
				// seconds or less."
				//
				// A cold start cannot learn this any other way. The page mounts and
				// reads `getConversations`, which is the durable table — and the fast
				// path deliberately never writes it (ADR-0051 invariant #1), so a
				// message younger than irreversibility is legitimately absent for
				// 45-63s. The live ping above only helps a client that was already
				// connected when it fired; a closed browser was not. So the events have
				// to be handed to whoever shows up next, which is what the ring is for
				// — it already does exactly this for a chatroom opened just after a
				// message lands (`recentFast`); this is the same hand-off for a badge.
				//
				// Ordering matters: replay FIRST, then `ready`. `ready` triggers the
				// client's reconciling poll, so this order means the badge is lit from
				// the ring and then confirmed against the indexer, never the reverse
				// (which would blink).
				//
				// `at` is the event's ORIGINAL block time, not now(). Replaying with
				// now() would date an old message to this instant and push it past the
				// user's read cursor — lighting a badge for something they already
				// read. The ring's whole purpose is to say what happened and WHEN.
				try {
					for (const ev of chatEventBus.recentFastForAccount(account)) {
						pushActivity(
							ev.sender === account ? ev.recipient : ev.sender,
							ev.orderPermlink ?? '',
							ev.recipient === account,
							ev.createdAt.getTime()
						);
					}
				} catch (err) {
					// A replay failure must never stop the live stream from starting.
					log.warn('chat_activity_replay_failed', {
						account,
						error: err instanceof Error ? err.message : String(err)
					});
				}

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
