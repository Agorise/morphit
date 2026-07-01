/**
 * Phase 4: audio notification cue.
 *
 * Plays a short two-tone chime when an event fires AND audio is
 * enabled in preferences AND not currently silenced. Uses the Web
 * Audio API to synthesize the tone, so no binary asset ships.
 *
 * Autoplay policy: most browsers block AudioContext resumption
 * until after the first user gesture in the tab. We lazy-init the
 * context on first use; if playback fails, we silently no-op
 * (the visual channels still fire, so the user isn't left with
 * nothing).
 *
 * Duration: ~250ms total. Quieter than system notification sounds
 * on purpose — Morphit chimes are for peripheral-awareness, not
 * interruption. Users who want louder can turn up their system
 * volume.
 */

import { get } from 'svelte/store';
import { notificationPrefs, isCurrentlySilenced } from './preferences';

/** Singleton AudioContext. Lazily created on first play attempt so
 *  we don't spend resources before the user actually hears anything. */
let ctx: AudioContext | null = null;

/** Lazily create the audio context. Returns null if the browser
 *  doesn't support Web Audio (very old browsers, some exotic embedded
 *  WebViews). */
function getContext(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (ctx) return ctx;
	const AC =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!AC) return null;
	try {
		ctx = new AC();
	} catch {
		return null;
	}
	return ctx;
}

/** Schedule one tone on the shared context. Envelope shaping
 *  (attack + release) avoids the click that raw gate switching
 *  produces. */
function scheduleTone(
	context: AudioContext,
	startTime: number,
	durationSec: number,
	frequency: number,
	peakGain: number
): void {
	const osc = context.createOscillator();
	const gain = context.createGain();
	osc.type = 'sine';
	osc.frequency.value = frequency;
	// 10ms attack, 40ms release envelope.
	const attackEnd = startTime + 0.01;
	const releaseStart = startTime + durationSec - 0.04;
	const endTime = startTime + durationSec;
	gain.gain.setValueAtTime(0, startTime);
	gain.gain.linearRampToValueAtTime(peakGain, attackEnd);
	gain.gain.setValueAtTime(peakGain, releaseStart);
	gain.gain.linearRampToValueAtTime(0, endTime);
	osc.connect(gain);
	gain.connect(context.destination);
	osc.start(startTime);
	osc.stop(endTime);
}

/** Play the two-tone chime if audio is enabled and not silenced.
 *  Silent no-op otherwise — callers don't need to pre-check. */
export function maybePlayChime(): void {
	if (typeof window === 'undefined') return;

	const prefs = get(notificationPrefs);
	if (!prefs.channels.audio) return;
	if (isCurrentlySilenced(prefs)) return;

	const context = getContext();
	if (!context) return;

	// Some browsers park the context in 'suspended' state until a
	// user gesture. Try to resume; if it fails (no prior gesture),
	// silently skip this play.
	if (context.state === 'suspended') {
		void context.resume().catch(() => {
			// Autoplay blocked. No-op — visual channels still fired.
		});
		// Don't proceed this turn even if resume succeeds — the
		// user hasn't yet interacted with the page, so the tone
		// would be jarring anyway. They'll hear the chime next
		// time an event fires after they've gestured.
		return;
	}

	const now = context.currentTime;
	// Two-tone chime: 880Hz (A5) then 1318Hz (E6). Fifth interval,
	// ascending. Familiar-but-not-generic (avoiding the clichéd
	// major-third "bing").
	const toneDur = 0.12;
	const gap = 0.02;
	const peakGain = 0.12; // conservative volume
	scheduleTone(context, now, toneDur, 880, peakGain);
	scheduleTone(context, now + toneDur + gap, toneDur, 1318.51, peakGain);
}
