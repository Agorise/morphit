/**
 * Phase 4: mobile vibration cue.
 *
 * Triggers a short vibration pattern via navigator.vibrate() when
 * an event fires AND vibrate is enabled in preferences AND not
 * currently silenced.
 *
 * Desktop browsers expose navigator.vibrate as a no-op that
 * returns false — we feature-detect before calling to keep the
 * code path clean.
 *
 * Pattern: two short buzzes (80ms each with 60ms gap). Distinctive
 * but brief enough not to be annoying. Patterns longer than ~200ms
 * total risk feeling like a phone call or alarm.
 */

import { get } from 'svelte/store';
import { notificationPrefs, isCurrentlySilenced } from './preferences';

/** Two short buzzes pattern: buzz, pause, buzz. Values in ms. */
const CHIME_PATTERN: readonly number[] = [80, 60, 80];

/** Trigger the vibration if enabled and the device supports it.
 *  Silent no-op otherwise. */
export function maybeVibrate(): void {
	if (typeof navigator === 'undefined') return;
	if (typeof navigator.vibrate !== 'function') return;

	const prefs = get(notificationPrefs);
	if (!prefs.channels.vibrate) return;
	if (isCurrentlySilenced(prefs)) return;

	try {
		// navigator.vibrate accepts a single number or a pattern array.
		// Returns false if the vibration was blocked (e.g. user setting,
		// or call from inside a cross-origin iframe). We don't care
		// about the return value — caller already opted in.
		navigator.vibrate([...CHIME_PATTERN]);
	} catch {
		// Some embedded WebViews throw instead of returning false.
		// Silent — the other channels already fired.
	}
}
