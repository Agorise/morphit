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
 *  Preference-gating: the user's per-category opt-in is consulted at
 *  fire time via the preferences store. If they've switched the
 *  category off in Settings, the event produces no ambient badge at
 *  all. */
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

/** Sum across categories — used by title-bar + favicon + app badge.
 *  A single user-facing "N" is simpler than per-category counts, and
 *  the user gets the breakdown when they open the notification menu. */
export function totalUnread(c: UnreadCounts): number {
	return c.order + c.chat + c.feedback;
}
