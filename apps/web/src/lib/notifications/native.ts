/**
 * Phase 2: Notification API integration (tab-open).
 *
 * Fires OS-native notifications via `new Notification(...)` when:
 *   - event arrives AND
 *   - tab is NOT focused AND
 *   - user has granted browser permission AND
 *   - category is opted-in in preferences AND
 *   - not currently silenced (mute-until + quiet hours)
 *
 * Permission-request UX: never on page-load. First time a relevant
 * event arrives and we'd fire a notification but don't have
 * permission, we show an in-app banner instead. Banner asks:
 * "You just got a new message. Want OS notifications for future ones?"
 * This has roughly 3× the grant rate of page-load prompts.
 *
 * Nag-avoidance: track the user's decline count + timestamp. Rule:
 *   1st decline → don't ask again for 1 week
 *   2nd decline → don't ask again for 1 month
 *   3rd decline → never ask again (honor their choice; Settings
 *     has a manual "enable" button for users who change their mind)
 */

import { writable, type Readable, get } from 'svelte/store';
import { safeLocal } from '../utils/safeStorage';
import { notificationPrefs, isCurrentlySilenced } from './preferences';
import type { NotificationEvent } from './index';

const DECLINE_KEY = 'morphit.notifications.declineState';

interface DeclineState {
	count: number;
	lastDeclinedAt: number; // unix ms
}

function readDecline(): DeclineState {
	const raw = safeLocal.get(DECLINE_KEY);
	if (!raw) return { count: 0, lastDeclinedAt: 0 };
	try {
		const parsed = JSON.parse(raw) as Partial<DeclineState>;
		return {
			count: typeof parsed.count === 'number' ? parsed.count : 0,
			lastDeclinedAt: typeof parsed.lastDeclinedAt === 'number' ? parsed.lastDeclinedAt : 0
		};
	} catch {
		return { count: 0, lastDeclinedAt: 0 };
	}
}

function writeDecline(s: DeclineState): void {
	safeLocal.set(DECLINE_KEY, JSON.stringify(s));
}

// ────────────────────────────────────────────────────────────────
// Permission state (browser-owned, we just read it)
// ────────────────────────────────────────────────────────────────

/** Current browser-level permission state. 'default' means we
 *  haven't asked yet; 'granted' and 'denied' are the two outcomes. */
export type PermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

function readPermission(): PermissionState {
	if (typeof Notification === 'undefined') return 'unsupported';
	return Notification.permission as PermissionState;
}

const permissionStore = writable<PermissionState>(
	typeof window === 'undefined' ? 'unsupported' : readPermission()
);

/** Subscribe-only view of current permission state. */
export const permission: Readable<PermissionState> = {
	subscribe: permissionStore.subscribe
};

/** Ask the browser for notification permission. Returns the new
 *  state. Caller typically uses this in response to a user gesture
 *  (button click in the permission banner), not on page-load. */
export async function requestPermission(): Promise<PermissionState> {
	if (typeof Notification === 'undefined') return 'unsupported';
	try {
		const result = await Notification.requestPermission();
		permissionStore.set(result as PermissionState);
		if (result === 'denied') {
			const s = readDecline();
			writeDecline({ count: s.count + 1, lastDeclinedAt: Date.now() });
		}
		return result as PermissionState;
	} catch {
		return readPermission();
	}
}

// ────────────────────────────────────────────────────────────────
// Permission-banner eligibility
// ────────────────────────────────────────────────────────────────

/** Should we show the permission banner right now? Consults:
 *   - current permission state (only show when 'default')
 *   - decline history (backoff after repeated declines)
 *   - native channel is enabled in Settings
 *
 *  Returns true only when ALL apply. */
export function shouldShowPermissionBanner(): boolean {
	const perm = get(permissionStore);
	if (perm !== 'default') return false;

	const prefs = get(notificationPrefs);
	if (!prefs.channels.native) return false;

	const decline = readDecline();
	const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
	const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

	if (decline.count === 0) return true;
	if (decline.count === 1) {
		return Date.now() - decline.lastDeclinedAt > WEEK_MS;
	}
	if (decline.count === 2) {
		return Date.now() - decline.lastDeclinedAt > MONTH_MS;
	}
	// 3+ declines: never ask again.
	return false;
}

/** User dismissed the banner without granting. Record as decline
 *  so the backoff schedule applies. */
export function declinePermissionBanner(): void {
	const s = readDecline();
	writeDecline({ count: s.count + 1, lastDeclinedAt: Date.now() });
}

/** User clicked "never ask again." Clamp count to 3 so
 *  shouldShowPermissionBanner returns false forever. */
export function neverAskAgain(): void {
	writeDecline({ count: 3, lastDeclinedAt: Date.now() });
}

/** Reset decline history — used when the user toggles native
 *  channel from Settings manually (clears any prior soft-block). */
export function resetDeclineHistory(): void {
	writeDecline({ count: 0, lastDeclinedAt: 0 });
}

// ────────────────────────────────────────────────────────────────
// Firing native notifications
// ────────────────────────────────────────────────────────────────

/** True when the page is currently focused by the user. Alert-class
 *  channels suppress when focused — ambient channels still update. */
function pageIsFocused(): boolean {
	if (typeof document === 'undefined') return false;
	return document.visibilityState === 'visible' && document.hasFocus();
}

/** Fire an OS-native notification for this event IF all gates pass.
 *  Called by the notify() entry point in index.ts, gated on
 *  per-category opt-in already. This function adds the phase-2
 *  specific gates on top.
 *
 *  Side-effect: when an event would have fired but permission is
 *  'default' (i.e. never asked), publish to `bannerTriggered` so
 *  the root layout can render the permission banner. This gives us
 *  the point-of-relevance UX without coupling notify() to UI. */
export function maybeFireNativeNotification(event: NotificationEvent): void {
	if (typeof Notification === 'undefined') return;
	if (pageIsFocused()) return;

	const prefs = get(notificationPrefs);
	if (!prefs.channels.native) return;
	if (isCurrentlySilenced(prefs)) return;

	const perm = get(permissionStore);
	if (perm === 'default' && shouldShowPermissionBanner()) {
		// Would have fired — signal the banner. Note: native channel
		// has to be on in Settings for this path to trigger at all;
		// otherwise the banner has no handle for the user to grant
		// permission against.
		bannerTriggered.set({ category: event.category, at: Date.now() });
		return;
	}
	if (perm !== 'granted') return;

	try {
		// `renotify` is spec-defined (W3C Notifications API) but
		// missing from some versions of the DOM TS typings. Cast
		// the options through an unknown-typed intermediate to
		// placate typecheck without losing the field.
		const notif = new Notification(event.title, {
			body: event.body,
			tag: `morphit-${event.category}-${event.id}`,
			renotify: false
		} as unknown as NotificationOptions);

		if (event.href) {
			notif.onclick = (): void => {
				// Focus this tab and navigate. Browsers vary on
				// window.focus() reliability, but the standard path
				// is to open a location and trust the browser to
				// surface the tab.
				try {
					window.focus();
					window.location.href = event.href as string;
				} catch {
					// ignore
				}
			};
		}
	} catch {
		// Some browsers throw if the document isn't in an active
		// state when we try to fire. Silent — the ambient badge
		// already updated, user still sees something.
	}
}

/** Signal carried from notify() to the layout when a permission
 *  prompt should be shown. Value carries the category so the
 *  banner can render concrete copy ("You just got a new message...").
 *  null means no pending trigger. */
export const bannerTriggered = writable<{
	category: NotificationEvent['category'];
	at: number;
} | null>(null);

/** Called by the layout after the banner is dismissed or granted,
 *  so a fresh event later in the session can re-fire it. */
export function clearBannerTrigger(): void {
	bannerTriggered.set(null);
}
