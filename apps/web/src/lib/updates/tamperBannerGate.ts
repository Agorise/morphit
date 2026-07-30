/**
 * Morphit — tamper-banner suppression gates (cp514 / t.txt A, v1.8.7).
 *
 * THE PROBLEM.  The "Build integrity check failed" banner (TamperAlertBanner)
 * fires on an asset-hash mismatch.  cp508 already gates the byte check on
 * `running === served === announced` to skip the routine deploy-skew, but on
 * some devices the scary red banner still flashes DURING an upgrade —
 * crucially, before the friendly "Load it now" snackbar (UpdateBanner) has a
 * chance to appear.  A byte mismatch while a new build is landing is a benign
 * deploy transition, not tampering: the correct response is the update
 * snackbar, not an "attacker" alarm.
 *
 * TWO SUPPRESSION SIGNALS (both belt-and-suspenders; genuine SAME-version
 * tamper on a fully-settled bundle still alarms once these clear):
 *
 *   1. `swUpdatePending` — true whenever the service worker has a NEW build
 *      waiting or installing.  That is exactly the window the "Load it now"
 *      snackbar owns; if the version gate mis-evaluates on some device, a
 *      pending worker still means "a newer bundle is landing," so we defer to
 *      the friendly path instead of crying wolf.
 *
 *   2. `tamperGraceElapsed` — false for a short window after boot, then true.
 *      The update-detection poll and the SW `reg.update()` check are async and
 *      can resolve a beat AFTER the byte check; the grace window lets the
 *      snackbar win the race rather than the banner flashing first.  A genuine
 *      tamper is not time-critical to surface, so a few seconds' delay is
 *      harmless.
 *
 * Only the ASSET-hash tamper case is gated on these — pubkey / invalid-payload
 * alarms are on-chain-signature problems unrelated to a frontend byte swap and
 * are never suppressed here.
 */

import { readable } from 'svelte/store';

/** Milliseconds after boot during which the asset-tamper banner stays
 *  suppressed so the update snackbar can win the race. */
export const TAMPER_BANNER_GRACE_MS = 8000;

/** True once a NEW service-worker build is waiting or installing (an update is
 *  landing).  Starts false; flips true on `updatefound` / an already-waiting
 *  worker, and back false if that worker is discarded.  Always false when
 *  service workers are unavailable (so the banner behaves exactly as before on
 *  no-SW browsers). */
export const swUpdatePending = readable<boolean>(false, (set) => {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
		return () => {};
	}
	let cancelled = false;
	const cleanups: Array<() => void> = [];

	const evaluate = (reg: ServiceWorkerRegistration): void => {
		if (cancelled) return;
		set(reg.waiting !== null || reg.installing !== null);
	};

	navigator.serviceWorker
		.getRegistration()
		.then((reg) => {
			if (cancelled || !reg) return;
			evaluate(reg);

			const onUpdateFound = (): void => {
				evaluate(reg);
				const installing = reg.installing;
				if (installing) {
					const onStateChange = (): void => evaluate(reg);
					installing.addEventListener('statechange', onStateChange);
					cleanups.push(() =>
						installing.removeEventListener('statechange', onStateChange)
					);
				}
			};
			reg.addEventListener('updatefound', onUpdateFound);
			cleanups.push(() => reg.removeEventListener('updatefound', onUpdateFound));

			// Nudge the browser to look for a waiting worker right away so the
			// signal is accurate on first paint (mirrors UpdateBanner's reg.update()).
			reg.update().catch(() => {});
		})
		.catch(() => {});

	return () => {
		cancelled = true;
		for (const c of cleanups) c();
	};
});

/** False for `TAMPER_BANNER_GRACE_MS` after subscription, then true forever.
 *  On the server (no timers needed) it resolves true immediately — SSR never
 *  renders the byte-check banner anyway. */
export const tamperGraceElapsed = readable<boolean>(false, (set) => {
	if (typeof window === 'undefined') {
		set(true);
		return () => {};
	}
	const id = window.setTimeout(() => set(true), TAMPER_BANNER_GRACE_MS);
	return () => window.clearTimeout(id);
});
