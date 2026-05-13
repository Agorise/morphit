/**
 * Morphit — syndication preferences.
 *
 * Tracks user consent for the first-trade auto-announcement post
 * ("Post A" in syndication/publish.ts).  Defaults to ON to
 * preserve the promotional ecosystem-growth flow that the post
 * was designed for; users who don't want a public Blurt blog
 * post on their behalf can flip it off in Settings.
 *
 * Per-order syndication ("Post B") is a separate per-submission
 * checkbox on /post and is not governed by this store — that
 * flow is already opt-in default-off.
 *
 * Persistence: localStorage, single boolean key.  Survives
 * reloads and tab closes.  Cleared by Reset / Sign Out via the
 * normal localStorage cleanup paths.
 */

import { writable, type Readable, get } from 'svelte/store';
import { safeLocal } from './safeStorage';

const STORAGE_KEY = 'morphit.syndication.firstTradeAnnounce';

/** Read the persisted value.  Default true (auto-announce ON) so
 *  existing users see no behavior change unless they actively
 *  opt out.  Any non-'false' value reads as true — handles
 *  old/missing/garbled values without flipping the default. */
function read(): boolean {
	const v = safeLocal.get(STORAGE_KEY);
	if (v === 'false') return false;
	return true;
}

/** Persist the user's choice. */
export function setFirstTradeAnnounce(enabled: boolean): void {
	if (enabled) {
		// Storing the default isn't necessary, but doing it
		// explicitly makes the user's choice durable across
		// any future default change.
		safeLocal.set(STORAGE_KEY, 'true');
	} else {
		safeLocal.set(STORAGE_KEY, 'false');
	}
	store.set(enabled);
}

/** Read the current value once, without subscribing.  Used by
 *  the publish pipeline at fire time — there's no reactive
 *  context there. */
export function isFirstTradeAnnounceEnabled(): boolean {
	return get(store);
}

/** Internal writable; consumers subscribe via the readable
 *  view exported below. */
const store = writable<boolean>(read());

/** Subscribable view — Settings UI binds to this. */
export const firstTradeAnnounce: Readable<boolean> = {
	subscribe: store.subscribe
};
