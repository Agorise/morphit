/**
 * Morphit — user preferences store.
 *
 * Tier 3.2 of the grandma-friendly investigation: a grandma
 * who's already posted an order in USD with region "US"
 * shouldn't have to refill those fields the next time she
 * posts.  The form should remember.
 *
 * Scope intentional: this store ONLY remembers values that
 * are unambiguously the user's general preference.  It does
 * NOT remember:
 *   - Per-order quantities (different orders, different
 *     amounts).
 *   - Payment methods (varies by order context — a Wise
 *     trade is different from a cash-in-person trade).
 *   - Spread / fixed price model (per-strategy, not
 *     per-user).
 *   - Listing-fee asset (BLURT vs BTC vs XMR — varies by
 *     what the user happens to have liquid).
 *
 * What IS remembered:
 *   - `fiat`: the user's preferred fiat currency
 *     (e.g. "USD", "EUR", "JPY").  Empty string means "no
 *     preference yet".
 *   - `region`: the user's region tag for filtering
 *     (e.g. "US", "EU", "Global").  Empty string means
 *     "no preference yet".
 *
 * Future fields may be added here.  The serialization
 * version (`v1`) lets us bump if the schema needs to
 * change incompatibly; readers of older versions just see
 * "no preference" for fields they don't understand.
 *
 * Persistence: localStorage under `morphit.userPreferences.v1`.
 * Synchronous read at module load, synchronous write on every
 * setter call.  Cheap; the data is tiny (<200 bytes).
 *
 * Privacy: this is local-first.  The preferences are NEVER
 * sent to any indexer or relay.  They never appear on chain.
 * They live only in the user's browser localStorage and are
 * cleared when the user clears site data or chooses
 * "Clear preferences" in /settings.
 */

import { writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'morphit.userPreferences.v1';

export interface UserPreferences {
	/** Preferred fiat currency code, e.g. "USD", "EUR".
	 *  Empty string means "not set / no preference". */
	fiat: string;
	/** Preferred region tag, e.g. "US", "EU", "Global".
	 *  Empty string means "not set / no preference". */
	region: string;
}

const EMPTY: UserPreferences = {
	fiat: '',
	region: ''
};

function readFromStorage(): UserPreferences {
	if (!browser) return { ...EMPTY };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...EMPTY };
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY };
		const o = parsed as Record<string, unknown>;
		return {
			fiat: typeof o.fiat === 'string' ? o.fiat : '',
			region: typeof o.region === 'string' ? o.region : ''
		};
	} catch {
		// Quota exceeded, JSON parse error, or other localStorage
		// failure — treat as no preferences.  Don't crash the page
		// just because the user disabled localStorage or hit a quota.
		return { ...EMPTY };
	}
}

function writeToStorage(prefs: UserPreferences): void {
	if (!browser) return;
	try {
		// Don't write the all-empty case; keeps localStorage
		// clean for users who haven't set any preferences yet
		// (e.g. someone using Morphit in private browsing mode
		// where localStorage clears anyway).
		if (!prefs.fiat && !prefs.region) {
			localStorage.removeItem(STORAGE_KEY);
			return;
		}
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Same rationale as readFromStorage's catch.
	}
}

const internalStore = writable<UserPreferences>(readFromStorage());

/** Read-only Svelte store of the current preferences.
 *  Subscribe with `$userPreferences` or `get(userPreferences)`.
 *  To mutate, use `setPreference` / `clearPreferences`. */
export const userPreferences: Readable<UserPreferences> = {
	subscribe: internalStore.subscribe
};

/** Set a single preference key; persists to localStorage and
 *  notifies subscribers.  Passing an empty string clears that
 *  key (returns to "no preference"). */
export function setPreference<K extends keyof UserPreferences>(
	key: K,
	value: UserPreferences[K]
): void {
	internalStore.update((current) => {
		const next: UserPreferences = { ...current, [key]: value };
		writeToStorage(next);
		return next;
	});
}

/** Clear all preferences and remove them from localStorage. */
export function clearPreferences(): void {
	internalStore.set({ ...EMPTY });
	writeToStorage(EMPTY);
}

/** Snapshot of the current preferences.  Use this when you
 *  need a synchronous read without subscribing (e.g. form
 *  pre-fill on mount). */
export function getPreferencesSnapshot(): UserPreferences {
	return readFromStorage();
}
