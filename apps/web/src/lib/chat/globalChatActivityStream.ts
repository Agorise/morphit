/**
 * Morphit frontend — global chat-activity SSE subscription.
 *
 * A SINGLE EventSource to the operator's own indexer at
 * /v1/chat-activity/:me/stream. It fires a debounced callback whenever the
 * signed-in account is a participant in ANY new chat message, so the inbox
 * list and the notification badges update SUB-SECOND instead of waiting for
 * the ≤6s poll. The polls stay as the backstop if the stream is unavailable.
 *
 * PRIVACY: same-origin only (never a third party). The server pushes just a
 * peer-account ping (on-chain-public metadata) — no ciphertext, no content.
 * On a ping we re-fetch the conversation summary via the existing same-origin
 * getConversations; content stays end-to-end encrypted. See the indexer's
 * chatActivityStream.ts header for the full rationale.
 *
 * Lifecycle: `startGlobalChatActivity()` runs once (ambient, from
 * startAmbientChannels). It (re)connects when the signed-in account changes
 * and closes when logged out. EventSource auto-reconnects on transient
 * network errors. Consumers register via `subscribeChatActivity`.
 *
 * One stream per browser and account, not per tab (C-L5): one tab holds it
 * and relays its events to the others; see SHARED_ACTIVITY_PREFIX.
 */

import {
	chatThreadFromClickPath,
	dismissChatNotificationsFor
} from '$lib/notifications/chatThread';
import { blurtAccountName, getUserBlurtAccount } from '$blurt/ops/profile';
import { get } from 'svelte/store';
import { hasAnySession } from '$stores/identity';

import { folderOf, restoreThread } from '$lib/chat/chatFolders';
import { withStreamTicket } from './streamTicket';

type Listener = () => void;

const listeners = new Set<Listener>();

/** Register a callback fired (debounced) on each chat-activity ping.
 *  Returns an unsubscribe function. */
export function subscribeChatActivity(fn: Listener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** v1.5.5 — fast-push observers, told WHICH thread a Web Push announced.
 *
 *  Separate from the plain activity ping above, which is content-free and only
 *  says "something happened, go refetch". A refetch is exactly what does NOT
 *  help here: the FAST path never writes chat_messages (it emits to SSE and
 *  enqueues the push, nothing more), so refetching at ~5s returns the same
 *  stale conversation list and the badge stays dark until the durable handler
 *  lands ~60s later. Subscribers get (peer, order) so they can act on the push
 *  itself.
 *
 *  Deliberately a subscription rather than importing chatUnread here:
 *  chatUnread already imports THIS module, so calling into it directly would
 *  close an import cycle. The dependency arrow stays one-way. */
/** v1.7.5 — `atMs` is the message's REAL time, present only on REPLAYED events
 *  (a browser that was closed when the message landed; see the indexer's
 *  chatActivityStream replay). Live pushes omit it and mean "now", which is true
 *  to within the push latency. Honouring it is what stops a replayed old message
 *  from being dated to this instant and lighting a badge already cleared. */
type FastPushListener = (peer: string, orderPermlink: string, atMs?: number) => void;
const fastPushListeners = new Set<FastPushListener>();

/** Register a callback fired for each Web Push naming a thread.
 *  Returns an unsubscribe function. */
export function subscribeFastPush(fn: FastPushListener): () => void {
	fastPushListeners.add(fn);
	return () => {
		fastPushListeners.delete(fn);
	};
}

function emitFastPush(peer: string, orderPermlink: string, atMs?: number): void {
	for (const fn of fastPushListeners) {
		try {
			fn(peer, orderPermlink, atMs);
		} catch {
			// A badge observer must never break push handling.
		}
	}
}

/**
 * v1.21.14 full chat audit, W-H2 — every ping, as it names a thread: the peer,
 * the order ('' = the thread that cites no order; null = not said, which is
 * the durable path's "something was stored, reconcile"), and whether it was
 * written TO this account (false also on the durable path of older
 * indexers, which did not say). The global trade listener reads the peers it
 * has to look at from here, instead of holding a chat stream open per recent
 * peer — on a Tor/I2P instance (plain HTTP/1.1, six connections per site)
 * those streams used up every connection the page had.
 */
export interface ChatActivityPing {
	readonly peer: string;
	readonly order: string | null;
	readonly inbound: boolean;
}
type PingListener = (ping: ChatActivityPing) => void;
const pingListeners = new Set<PingListener>();

/** Register a callback fired for EVERY activity ping (not debounced).
 *  Returns an unsubscribe function. */
export function subscribeChatActivityPings(fn: PingListener): () => void {
	pingListeners.add(fn);
	return () => {
		pingListeners.delete(fn);
	};
}

function emitPing(ping: ChatActivityPing): void {
	for (const fn of pingListeners) {
		try {
			fn(ping);
		} catch {
			// One observer must never break the stream for the others.
		}
	}
}

/** Coalesce bursts (e.g. a spammer sending rapidly, or a snapshot of several
 *  messages) into a single fire so subscribers don't refresh in a storm. */
const FIRE_DEBOUNCE_MS = 300;
let fireTimer: ReturnType<typeof setTimeout> | null = null;
function fire(): void {
	if (fireTimer !== null) return;
	fireTimer = setTimeout(() => {
		fireTimer = null;
		for (const l of listeners) {
			try {
				l();
			} catch {
				/* a listener throwing must not kill the stream */
			}
		}
	}, FIRE_DEBOUNCE_MS);
}

let es: EventSource | null = null;
let connectedMe: string | null = null;

/** The stream's URL: ONE place builds it (same-origin, the operator's own
 *  indexer), with the account's stream ticket (v1.21.14, S-M8: the stream
 *  answers 403 without one). Null when this page has no ticket for `me`
 *  (locked, nothing paired): then no stream is opened. Built fresh for every
 *  (re)open, so an expired ticket is replaced. */
export function chatActivityStreamUrl(me: string): string | null {
	return withStreamTicket(`/v1/chat-activity/${encodeURIComponent(me)}/stream`, me);
}

/** How often a page without a ticket looks again (a local check, no request):
 *  the stream opens soon after the session is unlocked. */
export const NO_TICKET_RETRY_MS = 2_000;

/**
 * v1.21.14 full chat audit, W-L2 — reconnecting after the stream was CLOSED.
 *
 * EventSource reconnects by itself after a dropped connection, but a
 * reconnect answered with an HTTP error (a 502 from a restarting indexer, a
 * 429 from the stream caps) closes it for good — that is the HTML spec. This
 * stream had no error handler and only reconnected when the signed-in account
 * changed, so the fast badges and the cross-page trade updates stopped until
 * the page was reloaded. Now a closed stream is opened again after a pause
 * that doubles (RECONNECT_MIN_MS … RECONNECT_MAX_MS) and is reset once the
 * stream says `ready`.
 */
export const RECONNECT_MIN_MS = 2_000;
export const RECONNECT_MAX_MS = 60_000;
let reconnectDelay = RECONNECT_MIN_MS;

function closeStream(): void {
	if (es !== null) {
		try {
			es.close();
		} catch {
			/* ignore */
		}
		es = null;
	}
	connectedMe = null;
}

function connectFor(me: string): void {
	closeStream();
	connectedMe = me;
	const url = chatActivityStreamUrl(me);
	if (url === null) {
		// Shared: no ticket in this tab, so let another tab try (C-L5).
		if (shared !== null && shared.me === me && shared.leading) {
			stepAside(shared);
			return;
		}
		setTimeout(() => {
			if (connectedMe === me && es === null) connectFor(me);
		}, NO_TICKET_RETRY_MS);
		return;
	}
	try {
		es = new EventSource(url);
	} catch {
		// Retried like a closed stream (C-L5 review): it used to be dropped
		// for good, and a holder then held the election with no stream.
		es = null;
		streamFailed(me);
		return;
	}
	const self = es;
	self.addEventListener('error', () => {
		// Still reconnecting by itself (CONNECTING): leave it to the browser.
		if (es !== self || self.readyState !== 2 /* CLOSED */) return;
		es = null;
		streamFailed(me);
	});
	es.addEventListener('chat_activity', (ev) => {
		fromOwnStream('chat_activity', (ev as MessageEvent).data as string);
	});
	es.addEventListener('ready', (ev) => {
		closesWithoutReady = 0;
		const data = (ev as MessageEvent).data as unknown;
		fromOwnStream('ready', typeof data === 'string' ? data : '{}');
	});
}

/** Times this tab's stream closed (or could not be made) since it last said
 *  `ready`. */
let closesWithoutReady = 0;
/** A holder whose stream closed this many times without `ready` lets
 *  another tab try (its ticket may be refused where another's is not). */
export const STEP_ASIDE_AFTER_CLOSES = 3;

/** The stream closed for good, or could not be made: open it again after a
 *  pause that doubles. Only if nothing changed meanwhile: a sign-out, a stop
 *  or another account (each goes through closeStream / connectFor) cancels
 *  it. */
function streamFailed(me: string): void {
	closesWithoutReady++;
	const wait = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	if (
		shared !== null &&
		shared.me === me &&
		shared.leading &&
		closesWithoutReady >= STEP_ASIDE_AFTER_CLOSES
	) {
		stepAside(shared, Math.max(NO_TICKET_RETRY_MS, wait));
		return;
	}
	setTimeout(() => {
		if (connectedMe === me && es === null) connectFor(me);
	}, wait);
}

/** An event this tab's own stream received: pass it to the account's other
 *  tabs when this tab holds the shared stream, then handle it here. */
function fromOwnStream(type: EventType, data: string): void {
	if (shared === null) {
		if (type === 'chat_activity') onActivity(data);
		else onReady();
		return;
	}
	const s = shared;
	relay(type, data);
	dispatchFrom(s, s.id, type, data);
}

/**
 * One `chat_activity` event, from this tab's stream or relayed by the tab
 * that holds it: the same handling either way.
 *
 * v1.7.5 — the ping now NAMES the thread, so act on it rather than
 * only re-polling.
 *
 * This is what makes the badge fast for a user who never granted push
 * permission. Before, this listener was just `fire` — a re-poll of
 * `getConversations`, which reads the durable table the fast path
 * deliberately never writes (ADR-0051 invariant #1). So the poll re-read the
 * same stale `last_message_at` and the badge sat dark for ~45-63s. The Web
 * Push carried the thread; this ping didn't. The badge was therefore only ever
 * as fast as the user's notification permission — and silently slow for
 * everyone else.
 *
 * Same handling as CHAT_PUSH, deliberately: resurrect an archived thread, then
 * light it. Two paths, one rule.
 */
function onActivity(data: string): void {
	try {
		const d = JSON.parse(data) as {
			peer?: unknown;
			order?: unknown;
			inbound?: unknown;
			at?: unknown;
		};
		// `inbound !== true` covers BOTH the durable path (which sends
		// inbound:false because its event carries no direction) and a message
		// this account SENT. Badging on either would nag the sender about their
		// own words on their other devices — . Falling through to
		// `fire()` still reconciles, which is all the durable path needs.
		if (d.inbound === true && typeof d.peer === 'string' && d.peer && typeof d.order === 'string') {
			if (folderOf(d.peer, d.order) === 'archived') restoreThread(d.peer, d.order);
			// `at` is present on REPLAYED events (a browser that was closed when the
			// message landed) and carries the message's real block time. Passing it
			// through is what stops a replayed old message from being dated to now
			// and lighting a badge the user already cleared.
			emitFastPush(d.peer, d.order, typeof d.at === 'number' ? d.at : undefined);
		}
		if (typeof d.peer === 'string' && d.peer) {
			emitPing({
				peer: d.peer,
				order: typeof d.order === 'string' ? d.order : null,
				inbound: d.inbound === true
			});
		}
	} catch {
		// A malformed ping must never break the backstop poll below.
	}
	fire();
}

/** `ready`: the stream (re)connected after the indexer's replay. */
function onReady(): void {
	reconnectDelay = RECONNECT_MIN_MS;
	fire();
}

/**
 * C-L5 — one activity stream per browser, not one per tab.
 *
 * Over Tor and I2P (plain HTTP/1.1) a browser allows about six connections
 * per site, and a stream per tab used them up: live chat stopped and page
 * requests stalled. Now, per account, ONE tab holds the stream and relays
 * each event to the account's other tabs on the BroadcastChannel
 * `morphit-chat-activity-v1:<account>` (same-origin, never leaves the
 * browser); they run it through the same handlers. When the holder closes,
 * crashes, locks or signs out, another tab opens the stream, and the new
 * connection gets what any reconnect gets: the indexer's replay of recent
 * messages, then `ready` (the reconciling poll), relayed to every tab.
 *
 * The tabs elect the holder over the channel itself (no Web Locks: a frozen
 * tab keeps a lock forever, and plain-HTTP pages have none). The holder
 * sends `hb` every ELECT_HEARTBEAT_MS and answers a `hello` at once. A tab
 * that hears nothing for ELECT_TAKEOVER_MS, or hears the holder's `bye`,
 * sends `hello` and takes the stream after ELECT_PROBE_MS unless a holder,
 * or a tab with a lower id asking at the same time, answers. Each new holder
 * takes a term one higher than any it heard, and says it with every
 * message. Two holders that hear each other keep the later term (a holder
 * frozen while another took over has the earlier one, whatever its id), in
 * one term the lower id; the other closes its stream at once. Tabs ignore
 * a holder of an earlier term. A hidden holder whose timers the browser
 * slows to once a minute still answers `hello` at once, so it keeps the
 * stream; no check of its own timer's lateness, which would take it from
 * every such tab. Without BroadcastChannel each tab keeps its own stream.
 *
 * A tab without a session, or whose account is not the channel's, neither
 * holds nor follows. A holder that locks or signs out closes the stream and
 * says `bye`. One with no ticket, or whose stream closed
 * STEP_ASIDE_AFTER_CLOSES times without `ready`, says `bye` and asks again
 * later.
 */
const SHARED_ACTIVITY_PREFIX = 'morphit-chat-activity-v1:';

/** The holder's heartbeat. */
export const ELECT_HEARTBEAT_MS = 1_000;
/** Silence after which a tab asks who holds the stream. */
export const ELECT_TAKEOVER_MS = 2_750;
/** How long a tab that asked waits for an answer. */
export const ELECT_PROBE_MS = 250;
/** How long after two holders were heard copies are matched (see
 *  dispatchFrom). */
const ELECT_DEDUPE_MS = 5_000;
/** How close two copies of one event arrive: relays of one event by two
 *  holders come within milliseconds of each other. */
const ELECT_TWIN_MS = 1_500;

type EventType = 'chat_activity' | 'ready';

interface Shared {
	readonly me: string;
	readonly channel: BroadcastChannel;
	/** This tab's random id on the channel. */
	readonly id: string;
	/** True while this tab holds the stream. */
	leading: boolean;
	/** This holder's term: one more than the highest it had heard. */
	term: number;
	/** The highest term heard on the channel. */
	maxTerm: number;
	/** The holder last heard, and when. */
	leaderId: string | null;
	leaderHeardAt: number;
	/** Asked `hello`, waiting for an answer. */
	probing: boolean;
	/** A tab with a lower id asked at the same time. */
	deferred: boolean;
	/** The probe, takeover or retry timer. */
	timer: ReturnType<typeof setTimeout> | null;
	heartbeat: ReturnType<typeof setInterval> | null;
}

/** This tab's part in the shared stream, or null (none, or per-tab mode). */
let shared: Shared | null = null;
/** The channel could not be opened: this page streams on its own. */
let channelBroken = false;
/** The account check (sync), while started. */
let resync: (() => void) | null = null;

function canShare(): boolean {
	try {
		return !channelBroken && typeof BroadcastChannel === 'function';
	} catch {
		return false;
	}
}

/** This tab still has a session for the channel's account. The session
 *  flips on before a sign-in records its account name, so a tab can join
 *  the channel of the name left from before; it must not handle that
 *  account's events. */
function accountOk(s: Shared): boolean {
	try {
		return get(hasAnySession) && getUserBlurtAccount() === s.me;
	} catch {
		return false;
	}
}

function newTabId(): string {
	const b = new Uint8Array(8);
	try {
		crypto.getRandomValues(b);
	} catch {
		for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
	}
	return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function post(s: Shared, msg: { type: string; data?: string }): void {
	try {
		s.channel.postMessage({ ...msg, from: s.id, term: s.leading ? s.term : s.maxTerm });
	} catch {
		// Channel closed: the other tabs fall back to their polls.
	}
}

/** Pass an event this tab's stream received to the account's other tabs. */
function relay(type: EventType, data: string): void {
	if (shared !== null && shared.leading) post(shared, { type, data });
}

/** Events handled lately, by the tab that sent them. While two holders were
 *  heard, the same event comes from both: the second copy, from the other
 *  holder within ELECT_TWIN_MS, is dropped. The frame carries no message
 *  id; its exact text and the sender are what identify a copy. Handling it
 *  twice re-dates the thread's fast badge, which can light it again after
 *  it was read. */
const recent: { data: string; src: string; at: number; used: boolean }[] = [];
let dedupeUntil = 0;

function dispatchFrom(s: Shared, src: string, type: EventType, data: string): void {
	if (!accountOk(s)) {
		resync?.();
		return;
	}
	if (type === 'ready') {
		onReady();
		return;
	}
	const now = Date.now();
	while (recent.length > 0 && (now - recent[0]!.at > ELECT_TWIN_MS || recent.length > 256))
		recent.shift();
	if (now < dedupeUntil) {
		const twin = recent.find((e) => !e.used && e.data === data && e.src !== src);
		if (twin !== undefined) {
			twin.used = true;
			return;
		}
	}
	recent.push({ data, src, at: now, used: false });
	onActivity(data);
}

function joinShared(me: string): boolean {
	let channel: BroadcastChannel;
	try {
		channel = new BroadcastChannel(SHARED_ACTIVITY_PREFIX + me);
	} catch {
		return false;
	}
	const s: Shared = {
		me,
		channel,
		id: newTabId(),
		leading: false,
		term: 0,
		maxTerm: 0,
		leaderId: null,
		leaderHeardAt: 0,
		probing: false,
		deferred: false,
		timer: null,
		heartbeat: null
	};
	shared = s;
	channel.onmessage = (ev: MessageEvent): void => {
		if (shared === s) onChannel(s, ev.data);
	};
	probe(s);
	return true;
}

function onChannel(s: Shared, raw: unknown): void {
	if (!accountOk(s)) {
		resync?.();
		return;
	}
	if (raw === null || typeof raw !== 'object') return;
	const m = raw as { type?: unknown; data?: unknown; from?: unknown; term?: unknown };
	if (typeof m.from !== 'string' || m.from === '' || m.from === s.id) return;
	const from = m.from;
	const term = typeof m.term === 'number' && Number.isFinite(m.term) ? m.term : 0;
	const type = m.type === 'chat_activity' || m.type === 'ready' ? m.type : null;
	const data = typeof m.data === 'string' ? m.data : null;
	if (m.type === 'hello') {
		if (s.leading) post(s, { type: 'hb' });
		else if (s.probing && from < s.id) s.deferred = true;
		return;
	}
	if (m.type === 'bye') {
		if (s.leading || (s.leaderId !== null && s.leaderId !== from)) return;
		s.leaderId = null;
		s.leaderHeardAt = 0;
		probe(s);
		return;
	}
	if (m.type !== 'hb' && (type === null || data === null)) return;
	const current = heardHolder(s, from, term);
	if (current && type !== null && data !== null && !s.leading) dispatchFrom(s, from, type, data);
}

/** Stop holding: close the stream and the heartbeat. */
function standDown(s: Shared): void {
	closeStream();
	s.leading = false;
	stopHeartbeat(s);
	dedupeUntil = Date.now() + ELECT_DEDUPE_MS;
}

/** Another tab says it holds the stream, in `term`. Returns whether it is
 *  a current holder (its events are handled). */
function heardHolder(s: Shared, from: string, term: number): boolean {
	const now = Date.now();
	if (s.leading) {
		// Two holders: the later term stays (a holder that was frozen while
		// another took over has the earlier one); in one term, the lower id.
		if (term > s.term || (term === s.term && from < s.id)) {
			standDown(s);
			s.maxTerm = Math.max(s.maxTerm, term);
			s.leaderId = from;
			s.leaderHeardAt = now;
			armTakeover(s);
			return true;
		}
		post(s, { type: 'hb' });
		return false;
	}
	// A holder from before a takeover: it hears the current one and yields.
	if (term < s.maxTerm) return false;
	if (term > s.maxTerm) {
		s.maxTerm = term;
		s.leaderId = null;
	}
	if (s.probing) {
		s.probing = false;
		clearTimer(s);
	}
	if (s.leaderId !== null && s.leaderId !== from && now - s.leaderHeardAt < ELECT_TAKEOVER_MS) {
		dedupeUntil = now + ELECT_DEDUPE_MS;
		if (from > s.leaderId) {
			armTakeover(s);
			return true;
		}
	}
	s.leaderId = from;
	s.leaderHeardAt = now;
	armTakeover(s);
	return true;
}

function clearTimer(s: Shared): void {
	if (s.timer !== null) {
		clearTimeout(s.timer);
		s.timer = null;
	}
}

function stopHeartbeat(s: Shared): void {
	if (s.heartbeat !== null) {
		clearInterval(s.heartbeat);
		s.heartbeat = null;
	}
}

function armTakeover(s: Shared): void {
	clearTimer(s);
	s.timer = setTimeout(() => {
		s.timer = null;
		probe(s);
	}, ELECT_TAKEOVER_MS);
}

/** Ask who holds the stream; take it if nobody answers. */
function probe(s: Shared): void {
	if (shared !== s || s.leading) return;
	clearTimer(s);
	s.probing = true;
	s.deferred = false;
	post(s, { type: 'hello' });
	s.timer = setTimeout(() => {
		s.timer = null;
		if (shared !== s || !s.probing) return;
		s.probing = false;
		if (s.deferred) armTakeover(s);
		else becomeHolder(s);
	}, ELECT_PROBE_MS);
}

function becomeHolder(s: Shared): void {
	clearTimer(s);
	s.term = s.maxTerm + 1;
	s.maxTerm = s.term;
	s.leading = true;
	s.leaderId = null;
	post(s, { type: 'hb' });
	s.heartbeat = setInterval(() => post(s, { type: 'hb' }), ELECT_HEARTBEAT_MS);
	connectFor(s.me);
}

/** No ticket, or a stream that keeps closing: close it, let another tab
 *  hold it, ask again after `wait`. */
function stepAside(s: Shared, wait: number = NO_TICKET_RETRY_MS): void {
	standDown(s);
	post(s, { type: 'bye' });
	clearTimer(s);
	s.timer = setTimeout(() => {
		s.timer = null;
		probe(s);
	}, wait);
}

/** Leave the shared stream: close it (if held), say `bye`, then stop
 *  listening. Closing first means two tabs never hold a stream at once. */
function leaveShared(): void {
	const s = shared;
	if (s === null) return;
	shared = null;
	const wasLeading = s.leading;
	closeStream();
	s.leading = false;
	stopHeartbeat(s);
	clearTimer(s);
	if (wasLeading) post(s, { type: 'bye' });
	try {
		s.channel.close();
	} catch {
		/* ignore */
	}
	recent.length = 0;
	dedupeUntil = 0;
}

/**
 * Start the ambient global chat-activity stream. Reconnects when the
 * signed-in account changes; closes when logged out. Returns a stop
 * function (clears the account-watch timer and closes the stream).
 */
export function startGlobalChatActivity(): () => void {
	if (typeof EventSource === 'undefined') return () => {};

	const sync = (): void => {
		// Only for a signed-in (unlocked or paired) session: a locked or
		// signed-out visit must not open a stream that names an account.
		const me = get(hasAnySession) ? getUserBlurtAccount() : null;
		if (!me) {
			leaveShared();
			closeStream();
			return;
		}
		if (canShare()) {
			if (shared !== null && shared.me === me) return;
			leaveShared();
			closeStream();
			if (joinShared(me)) return;
			channelBroken = true;
		}
		if (me !== connectedMe) connectFor(me);
	};

	sync();
	// Re-check the signed-in account so login/logout (re)connects promptly.
	const watch = window.setInterval(sync, 5_000);
	// Shared: a lock, a sign-out or a new account name in this tab is acted on
	// at once (the name is recorded after the session flips on).
	const sharing = canShare();
	resync = sharing ? sync : null;
	const unsubSession = sharing ? hasAnySession.subscribe(() => sync()) : null;
	const unsubAccount = sharing ? blurtAccountName.subscribe(() => sync()) : null;

	// the service worker receives Web Pushes even for a backgrounded
	// tab (it is not throttled) and postMessages every tab `{ type: 'CHAT_PUSH' }`.
	// Treat that exactly like an EventSource ping: refresh the conversation
	// summary so the unread badges (favicon + avatar dots) and the OS app-badge
	// update promptly even when this tab is inactive and its own stream/poll is
	// throttled. This is what lets an untouched tab badge like Element does.
	const onSwMessage = (ev: MessageEvent): void => {
		const data = ev.data as { type?: unknown; peer?: unknown; order?: unknown } | null;
		if (data && data.type === 'CHAT_PUSH') {
			// v1.5.0 fast archived-restore — if the push names an ARCHIVED thread,
			// pull it back into the Inbox immediately (Gmail-style) rather than
			// waiting ~irreversibility for getConversations to surface the message.
			if (typeof data.peer === 'string' && data.peer) {
				const order = typeof data.order === 'string' ? data.order : '';
				if (folderOf(data.peer, order) === 'archived') restoreThread(data.peer, order);
				// v1.5.5 — light the badge NOW, straight off the push, instead of
				// waiting for the indexer. `fire()` below only triggers a refetch,
				// and the FAST path never writes chat_messages (it emits to SSE +
				// enqueues the push and nothing else) — so the refetch at ~5s
				// returns the same stale last_message_at and the badge stayed dark
				// for ~60s. That's tester3, sitting on another tab with the
				// system notification already delivered.
				//
				// No spam risk and no gate duplicated here: the fast-notify gate
				// upstream refuses to push for anyone but an established
				// counterparty, so no push means no bump.
				emitFastPush(data.peer, order);
				// v1.8.9 — and if this tab is ALREADY showing that peer's thread,
				// take the OS notification back down.
				//
				// The worker is supposed to never raise it (it suppresses when a
				// client is open on the thread), but a service worker is the one
				// part of the app that does not update on reload: a new one installs
				// and WAITS while the old one keeps handling pushes. Three releases
				// of suppression fixes shipped and the maintainer still got buzzed by the person
				// he was actively chatting with, because the worker running on his
				// machines predated every one of them. Page code has no such problem
				// — it is fresh on every load — so it can undo what a stale worker
				// does. Only this peer's notifications, only while their thread is on
				// screen; everyone else's are untouched.
				const here = chatThreadFromClickPath(window.location.pathname);
				if (here !== null && here.peer.toLowerCase() === data.peer.toLowerCase()) {
					void dismissChatNotificationsFor(data.peer);
				}
			}
			fire();
		}
	};
	const swContainer = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
	swContainer?.addEventListener('message', onSwMessage);

	return () => {
		window.clearInterval(watch);
		unsubSession?.();
		unsubAccount?.();
		resync = null;
		swContainer?.removeEventListener('message', onSwMessage);
		if (fireTimer !== null) {
			clearTimeout(fireTimer);
			fireTimer = null;
		}
		leaveShared();
		closeStream();
	};
}
