/**
 * crossPageTradeEvents — opt-in toggle for the global trade-
 * event listener.
 *
 * Phase F.5 audit fix (F-23).  The listener decrypts every
 * incoming chat message across the user's recent-peers list
 * just to check for structured Morphit payloads.  This is an
 * implicit privacy-vs-UX tradeoff: ambient decryption gives
 * cross-page trade-status updates, but means plaintext briefly
 * resides in memory for messages the user never reads.
 *
 * Default ON because the cross-page UX value (badge auto-flips
 * to "Paid" without visiting chat) is high.  Privacy-conscious
 * users can turn it OFF in Settings; the chat page's in-page
 * service still picks up trade events when the user is on
 * /chat/<peer> directly.
 *
 * Distinct from the notification prefs' `categories.order` /
 * `channels.native` (which gate the order badge + OS-level alert).
 * This setting gates whether the listener runs at all.
 *
 * Storage: localStorage key `morphit.crossPageTradeEvents.enabled`,
 * boolean.  Survives session lock; cleared on full logout.
 */

import { writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'morphit.crossPageTradeEvents.enabled';

function readPersisted(): boolean {
	if (!browser) return true; // default ON
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		// Default ON when key absent.  Only `'false'` opts out.
		return raw !== 'false';
	} catch {
		return true;
	}
}

const _enabled = writable<boolean>(readPersisted());

export const crossPageTradeEventsEnabled: Readable<boolean> = {
	subscribe: _enabled.subscribe
};

/** Enable the cross-page trade-event listener.  Caller is
 *  expected to remount the listener (the layout effect already
 *  re-runs when this store changes if subscribed). */
export function enableCrossPageTradeEvents(): void {
	_enabled.set(true);
	if (!browser) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, 'true');
	} catch {
		// Silent.
	}
}

/** Disable the listener.  Caller's responsibility to call
 *  stopTradeEventListener — but if the layout subscribes to
 *  this store, it will tear down on its own. */
export function disableCrossPageTradeEvents(): void {
	_enabled.set(false);
	if (!browser) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, 'false');
	} catch {
		// Silent.
	}
}
