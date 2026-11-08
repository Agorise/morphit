/**
 * Morphit notifications system — foundation module.
 *
 * See docs/NOTIFICATIONS-DESIGN.md for the full design.
 *
 * This module is the ONE place call sites use to notify users. Call
 * sites don't know or care what channels are active — they just call
 * `notify({ category, title, body, id })` and this module fans out to
 * whatever the user has enabled.
 *
 * Phase 1 implementation (shipping now): zero-permission channels
 * only — title-bar prefix, favicon canvas badge, App Badging API.
 * Phases 2-4 add Notification API, Web Push, and audio/vibration.
 * Call sites don't change between phases.
 *
 * Annoyance-minimization rules enforced here:
 *   - Never fire a visible/audible alert when the tab is focused
 *     (ambient channels — title, favicon, badge — still update).
 *   - Coalesce same-category events within a 30s window.
 *   - Per-category opt-in (checked at notify() time, not subscribe
 *     time, so Settings toggles take effect immediately).
 */

import { writable, get, type Readable } from 'svelte/store';
import { notificationPrefs } from './preferences';
import { SUPPORTED_LOCALES } from '$i18n/locales';
import { maybeFireNativeNotification } from './native';
import { maybePlayChime } from './audio';
import { maybeVibrate } from './vibrate';

export type NotificationCategory = 'order' | 'chat' | 'feedback';

export interface NotificationEvent {
	/** Which category — drives which opt-in toggle applies. */
	category: NotificationCategory;
	/** Short headline shown in title-bar + native notification. */
	title: string;
	/** 1-2 sentence preview shown in the native notification body. */
	body: string;
	/** Where clicking the notification takes the user. Optional. */
	href?: string;
	/** Stable ID for dedup + coalescing. Using the same ID twice
	 *  within the coalesce window replaces rather than adds. */
	id: string;
}

/** Per-category unread count. Readable from the UI to render the
 *  title-bar prefix, favicon badge, and in-app notification widget. */
export type UnreadCounts = Record<NotificationCategory, number>;

function emptyCounts(): UnreadCounts {
	return { order: 0, chat: 0, feedback: 0 };
}

const counts = writable<UnreadCounts>(emptyCounts());

/** v1.23.4: the counted event-category notifications not yet read, by id: the
 *  page each points to, and how many times it was counted. */
const pendingPages: Record<
	'order' | 'feedback',
	Map<string, { href: string | null; n: number }>
> = { order: new Map(), feedback: new Map() };
export const unreadCount: Readable<UnreadCounts> = { subscribe: counts.subscribe };

/** Per-category coalescing: recent IDs we've seen in the last 30s. */
const COALESCE_WINDOW_MS = 30_000;
const recentIds: Record<NotificationCategory, Map<string, number>> = {
	order: new Map(),
	chat: new Map(),
	feedback: new Map()
};

/** Trim expired IDs out of a category's coalesce map. */
function pruneCoalesce(category: NotificationCategory): void {
	const now = Date.now();
	const m = recentIds[category];
	for (const [id, ts] of m) {
		if (now - ts > COALESCE_WINDOW_MS) m.delete(id);
	}
}

/** True when the page is currently focused by the user. When true,
 *  alert-class channels suppress; ambient channels still update. */
function pageIsFocused(): boolean {
	if (typeof document === 'undefined') return false;
	return document.visibilityState === 'visible' && document.hasFocus();
}

/** Notify the user of an event. Call sites should use stable IDs so
 *  the same underlying event (e.g. the same chat message redelivered)
 *  doesn't double-count.
 *
 *  Preference-gating: the ambient count (title prefix, favicon, app
 *  badge) always updates. The user's per-category opt-in, read at fire
 *  time from the preferences store, gates only the ALERTS (native
 *  notification, chime, vibrate). */
export function notify(event: NotificationEvent): void {
	if (typeof window === 'undefined') return;

	pruneCoalesce(event.category);
	const recent = recentIds[event.category];
	const isNew = !recent.has(event.id);
	recent.set(event.id, Date.now());

	// AMBIENT count — always update, regardless of opt-in, focus, or
	// permission. This is the peripheral badge / title prefix a user sees;
	// it just says "N things are waiting" and must show even for a category
	// whose ALERTS are off (the opt-in gates alerts, not the badge). Cheap
	// dedup keeps a redelivered event from double-counting.
	if (isNew) {
		counts.update((c: UnreadCounts) => ({
			...c,
			[event.category]: c[event.category] + 1
		}));
		// v1.23.4: remember the page it points to, so opening that page clears it.
		if (event.category !== 'chat') {
			const m = pendingPages[event.category];
			const prev = m.get(event.id);
			m.set(event.id, { href: event.href ?? null, n: (prev?.n ?? 0) + 1 });
		}
	}

	// ALERTS — native notification, chime, vibrate — ARE gated on the
	// per-category opt-in. Subscribe-peek via get() (fire-and-forget call).
	const prefs = get(notificationPrefs);
	if (!prefs.categories[event.category]) return;

	// All remaining alert gates (focus, channel opt-in, silencing, OS
	// permission) live inside maybeFireNativeNotification.
	maybeFireNativeNotification(event);

	// Audio + vibrate suppress when focused (user is looking). Each
	// feature-detects + checks its own channel opt-in + shared silencing.
	if (!pageIsFocused()) {
		maybePlayChime();
		maybeVibrate();
	}
}

/** Set a STATE-based category's unread count to an absolute value.
 *  Unlike notify() (a stream of discrete events), some categories —
 *  chat — have a count that IS the number of unread conversations,
 *  recomputed from read-state by the chat-unread channel.
 *
 *  NOT gated on the per-category opt-in: the ambient count/badge is
 *  "always-on" (it just shows how many things are waiting) — the opt-in
 *  gates the ALERTS (native notification / chime), not the peripheral
 *  badge. (The badge stays always-on regardless of the opt-in; only the
 *  ALERTS are gated. Chat's category defaults ON now — see preferences.ts —
 *  but this must be always-on independent of that either way.) No-ops when
 *  unchanged so subscribers don't churn. */
export function setCategoryCount(category: NotificationCategory, n: number): void {
	if (typeof window === 'undefined') return;
	const value = Math.max(0, Math.floor(n));
	counts.update((c: UnreadCounts) => (c[category] === value ? c : { ...c, [category]: value }));
}

/** Mark a category (or all) as read — clears the unread count and
 *  removes the favicon badge / title prefix / app badge if this
 *  was the last unread category. */
export function markRead(category?: NotificationCategory): void {
	if (category === undefined || category === 'order') pendingPages.order.clear();
	if (category === undefined || category === 'feedback') pendingPages.feedback.clear();
	counts.update((c: UnreadCounts) => {
		if (category === undefined) {
			// Chat is STATE-based: its count is the live unread-conversation
			// total (chat-unread channel + read-state), cleared only when the
			// user actually READS a conversation. Opening the avatar menu must
			// not zero it while messages are still unread — so clear only the
			// event-based categories here.
			return { ...c, order: 0, feedback: 0 };
		}
		return { ...c, [category]: 0 };
	});
}

/** The event-based categories (chat is state-based: read by reading). */
export type EventCategory = Exclude<NotificationCategory, 'chat'>;

/**
 * Keep `categories` read while a page that shows them is open and in view
 * (v1.23.4, owner: "the green badge on my avatar did not disappear when i
 * clicked on Orders in that menu"). My orders shows the order events and the
 * leave-feedback reminders — which its own banner announces after it loads,
 * so clearing once on arrival was not enough. In a background tab the badge
 * still counts (the favicon and title are how a new fill gets noticed there),
 * and it clears when the tab is looked at again. Returns the stop function.
 */
export function keepReadWhileShown(categories: readonly EventCategory[]): () => void {
	if (typeof document === 'undefined') return () => {};
	const clear = (): void => {
		if (document.visibilityState !== 'visible') return;
		if (!categories.some((k) => get(counts)[k] !== 0)) return;
		for (const k of categories) pendingPages[k].clear();
		counts.update((c) => {
			const n = { ...c };
			for (const k of categories) n[k] = 0;
			return n;
		});
	};
	const unsubscribe = counts.subscribe(() => clear());
	document.addEventListener('visibilitychange', clear);
	return () => {
		unsubscribe();
		document.removeEventListener('visibilitychange', clear);
	};
}

/** A page path without its query, fragment or leading locale, for comparing
 *  a notification's link with the page shown. PURE. */
export function pageKey(path: string): string {
	let p = path.split(/[?#]/, 1)[0] ?? '';
	const seg = p.split('/')[1] ?? '';
	if (SUPPORTED_LOCALES.some((l) => l.code === seg)) p = p.slice(seg.length + 1) || '/';
	return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * v1.23.4 (independent review): an order notification links to the chat it is
 * about, and opening that chat later left the badge counting it. The page
 * shown (`pathname`), in view, reads every order or feedback notification that
 * points to it.
 */
export function markSeenAt(pathname: string): void {
	if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
	const here = pageKey(pathname);
	for (const k of ['order', 'feedback'] as const) {
		let read = 0;
		for (const [id, p] of pendingPages[k]) {
			if (p.href !== null && pageKey(p.href) === here) {
				read += p.n;
				pendingPages[k].delete(id);
			}
		}
		if (read > 0) counts.update((c) => ({ ...c, [k]: Math.max(0, c[k] - read) }));
	}
}

/** Sum across categories — used by title-bar + favicon + app badge.
 *  A single user-facing "N" is simpler than per-category counts, and
 *  the user gets the breakdown when they open the notification menu. */
export function totalUnread(c: UnreadCounts): number {
	return c.order + c.chat + c.feedback;
}
