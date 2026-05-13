/**
 * Auto-lock idle timer.
 *
 * Starts a timer that fires after N minutes of no user interaction.
 * Default N = 9 hours (ratified Q5.2). User can change via Settings:
 * range 15 minutes → never, or explicit disable.
 *
 * "Interaction" means any of: keydown, mousemove, touchstart, scroll,
 * focus. The visibilitychange → visible event also resets (user came
 * back to the tab).
 *
 * The actual locking is done by a caller-supplied callback — this
 * module doesn't know about the identity store, it just fires the
 * timer. Clean separation of concerns.
 *
 * Persistence: the TIMEOUT setting is persisted here. The "was I
 * active recently?" state is NOT persisted — each session starts a
 * fresh timer. (Persisting the last-activity timestamp across tab
 * closes would confuse the "9 hours of idle" semantics, since a user
 * who closed the tab for 10 minutes would get auto-locked on reopen.)
 */

import { writable, type Readable, get } from 'svelte/store';
import { safeLocal } from '../utils/safeStorage';

const TIMEOUT_KEY = 'morphit.autoLock.timeoutMinutes';

/** Special sentinel value meaning "never auto-lock." Stored as
 *  the string 'never' in localStorage to distinguish from any
 *  numeric timeout. */
const NEVER = -1;

/** Default timeout in minutes. 9 hours = 540 minutes, per Q5.2
 *  ratification. Long enough for a full workday of idle without
 *  annoyance; short enough to protect an unlocked laptop left
 *  overnight. */
const DEFAULT_MINUTES = 540;

/** Read the persisted timeout. Returns minutes, or NEVER for disabled. */
export function readTimeoutMinutes(): number {
	const v = safeLocal.get(TIMEOUT_KEY);
	if (v === 'never') return NEVER;
	if (v === null) return DEFAULT_MINUTES;
	const n = parseInt(v, 10);
	if (isNaN(n) || n < 15) return DEFAULT_MINUTES;
	return n;
}

/** Persist the user's timeout choice. Pass NEVER to disable. */
export function writeTimeoutMinutes(minutes: number): void {
	if (minutes === NEVER) {
		safeLocal.set(TIMEOUT_KEY, 'never');
	} else {
		safeLocal.set(TIMEOUT_KEY, String(Math.max(15, Math.floor(minutes))));
	}
	timeoutStore.set(minutes);
}

/** Exported constant for consumers that want the sentinel without
 *  importing the internal value. */
export const NEVER_LOCK = NEVER;

/** Subscribable view of current timeout setting — Settings UI binds
 *  to this. */
const timeoutStore = writable<number>(readTimeoutMinutes());
export const autoLockTimeoutMinutes: Readable<number> = {
	subscribe: timeoutStore.subscribe
};

// ────────────────────────────────────────────────────────────────
// Timer lifecycle
// ────────────────────────────────────────────────────────────────

let timeoutId: ReturnType<typeof setTimeout> | null = null;

/** Events we treat as "user is active." Kept narrow: we don't want
 *  a stray IntersectionObserver or video ad to reset the timer. */
const ACTIVITY_EVENTS: Array<keyof DocumentEventMap> = [
	'keydown',
	'mousemove',
	'touchstart',
	'scroll',
	'click'
];

/** Start the auto-lock timer. Returns a stop() function that
 *  tears everything down — caller (typically identity store) invokes
 *  it on Lock / Sign Out / unmount.
 *
 *  Listener storage is per-call (closure-scoped, not module-scoped)
 *  so that calling startAutoLockTimer twice without an intervening
 *  teardown does not leave orphaned listeners pointing at the first
 *  call's arm() closure.  In practice the +layout effect always runs
 *  its return cleanup before re-running, but module-scoped storage
 *  was fragile to teardown ordering. */
export function startAutoLockTimer(onTimeout: () => void): () => void {
	if (typeof window === 'undefined') return () => undefined;

	const minutes = get(timeoutStore);
	if (minutes === NEVER || minutes <= 0) {
		// Disabled. Do nothing — no timer, no listeners.
		return () => undefined;
	}

	const teardowns: Array<() => void> = [];

	const timeoutMs = minutes * 60 * 1000;

	const arm = (): void => {
		if (timeoutId !== null) clearTimeout(timeoutId);
		timeoutId = setTimeout(() => {
			// Timer fired — invoke the caller's lock handler. They
			// manage identity state; we just detected idle.
			onTimeout();
		}, timeoutMs);
	};

	const resetOnActivity = (): void => {
		arm();
	};

	// Attach listeners. Using `passive: true` on pointer/touch events
	// so we don't accidentally block scroll perf.
	for (const ev of ACTIVITY_EVENTS) {
		document.addEventListener(ev, resetOnActivity, { passive: true });
		teardowns.push(() => document.removeEventListener(ev, resetOnActivity));
	}

	// Visibility: coming back to the tab resets the timer (user is
	// clearly present again). Leaving doesn't — the timer keeps
	// counting, because "closed tab and came back 10 hours later"
	// should auto-lock.
	const onVisibility = (): void => {
		if (document.visibilityState === 'visible') arm();
	};
	document.addEventListener('visibilitychange', onVisibility);
	teardowns.push(() => document.removeEventListener('visibilitychange', onVisibility));

	// Initial arm — timer starts from the moment startAutoLockTimer is called.
	arm();

	return (): void => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		for (const teardown of teardowns) teardown();
		teardowns.length = 0;
	};
}
