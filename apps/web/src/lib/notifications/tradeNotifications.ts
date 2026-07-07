/**
 * tradeNotifications — opt-in toggle for OS-level browser
 * notifications about trade events.
 *
 * Phase F.5.  When enabled, the trade-event listener fires
 * `new Notification(...)` alongside the in-app toast for
 * relevant trade events (address shared, funds sent).  When
 * disabled (default), only in-app toasts surface.
 *
 * Why default OFF: aggressive notifications are an anti-
 * pattern.  Per the design discussion: "every project that
 * goes there ends up annoying users who actually want to
 * focus."  Make it opt-in via Settings, surface clearly when
 * the OS-level permission is granted vs revoked.
 *
 * Storage: localStorage key `morphit.tradeNotifications.enabled`,
 * boolean.  Survives session lock (lock is for crypto material;
 * this is a UX preference).  Cleared on full logout.
 */

import { writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'morphit.tradeNotifications.enabled';

function readPersisted(): boolean {
	if (!browser) return false;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		return raw === 'true';
	} catch {
		return false;
	}
}

const _enabled = writable<boolean>(readPersisted());

export const tradeNotificationsEnabled: Readable<boolean> = {
	subscribe: _enabled.subscribe
};

/** Permission state of the browser Notification API.  Tracked
 *  separately from the user's preference so the Settings UI can
 *  distinguish "user wants notifications but OS hasn't granted"
 *  from "user has notifications off."  */
export type NotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export function getNotificationPermission(): NotificationPermission {
	if (!browser) return 'unsupported';
	if (typeof Notification === 'undefined') return 'unsupported';
	const p = Notification.permission;
	if (p === 'granted') return 'granted';
	if (p === 'denied') return 'denied';
	return 'default';
}

/** Enable trade notifications.  Requests OS permission if not
 *  yet granted.  Returns the resulting permission state so
 *  callers can show a toast on denial.
 *
 *  MUST be called from a user gesture handler (button click,
 *  etc.) — browsers require this for permission requests. */
export async function enableTradeNotifications(): Promise<NotificationPermission> {
	if (!browser) return 'unsupported';
	if (typeof Notification === 'undefined') return 'unsupported';

	let perm = Notification.permission;
	if (perm === 'default') {
		try {
			perm = await Notification.requestPermission();
		} catch {
			perm = 'denied';
		}
	}

	if (perm === 'granted') {
		_enabled.set(true);
		try {
			window.localStorage.setItem(STORAGE_KEY, 'true');
		} catch {
			// Storage failures are non-fatal; in-memory state still
			// drives the runtime.
		}
		return 'granted';
	}

	// Denied or anything else — keep the preference off.
	_enabled.set(false);
	try {
		window.localStorage.setItem(STORAGE_KEY, 'false');
	} catch {
		// Silent.
	}
	return perm === 'denied' ? 'denied' : 'default';
}

/** Disable trade notifications.  Doesn't revoke OS permission
 *  (browsers don't expose a way to do that — user must do it
 *  via browser settings).  We just stop firing them. */
export function disableTradeNotifications(): void {
	_enabled.set(false);
	if (!browser) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, 'false');
	} catch {
		// Silent.
	}
}
