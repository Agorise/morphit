/**
 * Client-side moderation (ADR-0013 Q1.4 ratified: b).
 *
 * Per-user, per-browser set of Blurt account names the user has
 * chosen to hide. Orderbook views filter these out; other surfaces
 * that render account names may also consult the list.
 *
 * Scope explicitly LIMITED to client-side filtering:
 *   - Hidden accounts' orders still exist on-chain.
 *   - Other operator instances and direct chain queries see them.
 *   - The hidden user has no signal anyone hid them — indistinguishable
 *     from "nobody loaded the page right now."
 *   - Unhide is always available — no timeout, no review queue.
 *
 * Storage:
 *   Key: morphit.hiddenAccounts.v1
 *   Value: JSON-stringified array of lowercase account names
 *
 * Case-insensitive: account names are stored lowercase regardless
 * of user input case. Blurt canonicalises to lowercase anyway, but
 * we belt-and-suspender this so a user typing "@Alice" hides
 * @alice correctly.
 */

import { writable, derived, type Readable } from 'svelte/store';
import { safeLocal } from './safeStorage';

const STORAGE_KEY = 'morphit.hiddenAccounts.v1';

function readHidden(): Set<string> {
	const raw = safeLocal.get(STORAGE_KEY);
	if (!raw) return new Set();
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		// Be defensive against corruption or manual edits; coerce
		// each entry to string and normalise.
		return new Set(
			parsed
				.filter((x): x is string => typeof x === 'string' && x.length > 0)
				.map((s) => s.toLowerCase())
		);
	} catch {
		// Corrupted payload. Wipe it — better to start fresh than
		// silently ignore every hide going forward because one was
		// bad.
		safeLocal.remove(STORAGE_KEY);
		return new Set();
	}
}

function persist(set: Set<string>): void {
	try {
		safeLocal.set(STORAGE_KEY, JSON.stringify([...set]));
	} catch {
		// Silent — safeStorage already handles Private Mode.
	}
}

// Internal writable; consumers only see the Readable + hidden-count
// derived view.
const internal = writable<Set<string>>(readHidden());

/** Readable view of the current hidden set. Components reading
 *  this re-render whenever hide/unhide mutates the set. */
export const hiddenAccounts: Readable<Set<string>> = {
	subscribe: internal.subscribe
};

/** Count of hidden accounts. Used by Settings to show "N hidden"
 *  or to show/hide empty states. */
export const hiddenCount: Readable<number> = derived(
	internal,
	($hidden: Set<string>) => $hidden.size
);

/** Hide all orders from this account. Idempotent — adding an
 *  already-hidden name is a no-op. */
export function hideAccount(account: string): void {
	const name = account.trim().toLowerCase();
	if (name.length === 0) return;
	internal.update((set: Set<string>) => {
		if (set.has(name)) return set;
		const next = new Set<string>(set);
		next.add(name);
		persist(next);
		return next;
	});
}

/** Unhide an account. Idempotent — unhiding a non-hidden name
 *  is a no-op. */
export function unhideAccount(account: string): void {
	const name = account.trim().toLowerCase();
	internal.update((set: Set<string>) => {
		if (!set.has(name)) return set;
		const next = new Set<string>(set);
		next.delete(name);
		persist(next);
		return next;
	});
}

/** Clear all hidden accounts. Used by the Settings "Unhide all"
 *  action. */
export function clearAllHidden(): void {
	internal.update((): Set<string> => {
		persist(new Set<string>());
		return new Set<string>();
	});
}

/**
 * v1.5.0 — re-read the hidden set from localStorage into the store. The store
 * already reacts to cross-tab storage events; a manual Refresh button in
 * Settings gives the same reassurance as the blocked-accounts one (and picks
 * up any change made outside this store's own mutators).
 */
export function refreshHidden(): void {
	internal.set(readHidden());
}

/** Pure check — is this account in the hidden set? Callers that
 *  need reactivity should subscribe to `hiddenAccounts` instead of
 *  calling this per render.
 *
 *  Provided for non-reactive code paths (e.g. a data-fetch hook
 *  that wants to drop hidden accounts before passing to UI). */
export function isHidden(account: string, hiddenSet: Set<string>): boolean {
	return hiddenSet.has(account.trim().toLowerCase());
}
