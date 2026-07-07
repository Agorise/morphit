/**
 * Safe Web Storage wrapper.
 *
 * Why this exists: browsers have at least four failure modes for
 * Storage access that any real-world app hits:
 *
 *   1. Private / Incognito mode — Safari has historically thrown
 *      on localStorage.setItem. Firefox's Private Mode may throw
 *      on storage writes. Chrome's Incognito is usually fine but
 *      the storage is ephemeral.
 *   2. Tor Browser at high security level — disables storage.
 *   3. Storage quota exceeded — `QuotaExceededError` on setItem.
 *   4. Disabled via browser/user flag — storage may simply not
 *      exist, throwing `ReferenceError` on access.
 *
 * Any of these, unhandled, crashes the UI — often silently from
 * the user's perspective, who just sees "something went wrong."
 * This wrapper makes every call safe: get/set/remove all return
 * gracefully on failure, and `available()` lets a caller decide
 * whether to offer a feature (e.g. "remember this preference")
 * when persistence isn't possible.
 *
 * Contract:
 *   - get(key) → string | null. null means "not stored OR storage
 *     unavailable." Callers that care about distinguishing can
 *     check `.available()` first.
 *   - set(key, value) → boolean. false means the write failed
 *     (storage unavailable, quota exceeded, etc).
 *   - remove(key) → boolean. false means storage unavailable.
 *   - available() → boolean. true if storage is usable at all.
 *
 * The availability check is cached per-storage (so we don't
 * retry a broken storage on every call) and invalidated on a
 * write failure (so a caller can react to "ran out of room"
 * mid-session by stopping further writes).
 */

type StorageKind = 'local' | 'session';

class SafeStorage {
	#kind: StorageKind;
	#cachedAvailable: boolean | null = null;

	constructor(kind: StorageKind) {
		this.#kind = kind;
	}

	/** Resolve the underlying Storage object, or null if unavailable. */
	#raw(): Storage | null {
		try {
			if (typeof window === 'undefined') return null;
			const s = this.#kind === 'local' ? window.localStorage : window.sessionStorage;
			// Accessing the object itself can throw in some browsers.
			if (!s) return null;
			return s;
		} catch {
			return null;
		}
	}

	available(): boolean {
		if (this.#cachedAvailable !== null) return this.#cachedAvailable;
		const s = this.#raw();
		if (!s) {
			this.#cachedAvailable = false;
			return false;
		}
		// Probe by writing and immediately removing a canary key.
		// Safari Private Mode throws on setItem, not on access.
		const CANARY = '__morphit_probe__';
		try {
			s.setItem(CANARY, '1');
			s.removeItem(CANARY);
			this.#cachedAvailable = true;
			return true;
		} catch {
			this.#cachedAvailable = false;
			return false;
		}
	}

	get(key: string): string | null {
		const s = this.#raw();
		if (!s) return null;
		try {
			return s.getItem(key);
		} catch {
			return null;
		}
	}

	set(key: string, value: string): boolean {
		const s = this.#raw();
		if (!s) return false;
		try {
			s.setItem(key, value);
			return true;
		} catch {
			// Quota exceeded, storage disabled mid-session, etc.
			// Invalidate the availability cache so subsequent
			// probes return the current state.
			this.#cachedAvailable = null;
			return false;
		}
	}

	remove(key: string): boolean {
		const s = this.#raw();
		if (!s) return false;
		try {
			s.removeItem(key);
			return true;
		} catch {
			return false;
		}
	}
}

/** Safe localStorage — use this instead of window.localStorage. */
export const safeLocal = new SafeStorage('local');

/** Safe sessionStorage — use this instead of window.sessionStorage. */
export const safeSession = new SafeStorage('session');
