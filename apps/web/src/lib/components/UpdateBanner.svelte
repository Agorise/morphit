<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import { runningVersion } from '$stores/release';
	import { fetchWithTimeout } from '$net/fetchWithTimeout';
	import {
		parseDeployedVersion,
		deployedVersionDiffers,
		verifyJsonPollUrl
	} from '$lib/updates/deployedVersion';

	let waitingWorker = $state<ServiceWorker | null>(null);
	// Set true the instant "Load it now" is clicked, so the snackbar vanishes
	// immediately. IN-MEMORY ONLY — never persisted. A reload resets it, so it
	// can't get stuck suppressing the snackbar after a reload that didn't fully
	// land the update (the PC bug, where a persisted "applying" flag kept the
	// snackbar hidden for minutes). If the update didn't actually apply, the
	// snackbar correctly reappears so the user can retry.
	let applying = $state(false);
	// Latest deployed bundle version seen via the verify.json poll. Drives the
	// version-aware "Later": dismissing snoozes the CURRENT version; a newer
	// deploy re-shows the snackbar.
	let deployedVersion = $state<string | null>(null);
	// The version the user clicked "Later" on (restored from sessionStorage on
	// mount). Null = never dismissed this session.
	let dismissedVersion = $state<string | null>(null);
	// Set when the deployed-version poll finds /verify.json reports a different
	// bundle than the one we're running — an update is available EVEN IF the
	// service-worker byte-diff was never seen (an upstream proxy served
	// /service-worker.js stale). This is the desktop-reliable detection path.
	let newerVersionDeployed = $state(false);

	const DISMISS_KEY = 'morphit.updateDismissed';
	// Stored when we dismiss an update detected only via the service worker
	// (no version string from verify.json yet).
	const SW_ONLY = '__sw__';

	// ── cp438: consent survives the reload ──────────────────────────────────
	// The "Load it now twice on mobile" bug: after the user consents, the
	// post-skipWaiting reload sometimes lands on the OLD worker anyway (mobile
	// throttles SW activation, so even the 12s controllerchange fallback can
	// reload before the new worker takes control). The old bundle then re-runs,
	// the verify.json poll re-detects the version mismatch, and the snackbar
	// re-offers — the user taps twice. Bumping the fallback (3s→12s, cp383)
	// didn't kill it on real devices.
	//
	// Fix: once the user consents, remember the TARGET version across the
	// reload. On the next load, if we're still NOT running that target, the
	// user already said yes — so we silently RESUME the handoff (re-send
	// APPLY_UPDATE + await controllerchange) instead of re-nagging. Bounded by
	// MAX_RESUME_ATTEMPTS so a genuinely stuck handoff still surfaces the
	// snackbar (never stranded — the exact failure the old persisted "applying"
	// flag caused). The marker is version-keyed and self-clearing: it clears
	// the instant runningVersion matches the target, and after the attempt cap.
	const RESUME_KEY = 'morphit.updateResume';
	const MAX_RESUME_ATTEMPTS = 2;
	// True while we're silently finishing a handoff the user already consented
	// to (before this reload). Keeps the snackbar hidden during the resume.
	let resuming = $state(false);

	type ResumeMark = { target: string; n: number };
	function readResume(): ResumeMark | null {
		try {
			const raw = window.sessionStorage.getItem(RESUME_KEY);
			if (raw === null) return null;
			const o = JSON.parse(raw) as { target?: unknown; n?: unknown };
			if (typeof o.target === 'string' && typeof o.n === 'number' && o.target.length > 0) {
				return { target: o.target, n: o.n };
			}
		} catch {
			// ignore — treat as no marker
		}
		return null;
	}
	function writeResume(target: string, n: number): void {
		try {
			window.sessionStorage.setItem(RESUME_KEY, JSON.stringify({ target, n }));
		} catch {
			// ignore — resume is best-effort
		}
	}
	function clearResume(): void {
		try {
			window.sessionStorage.removeItem(RESUME_KEY);
		} catch {
			// ignore
		}
	}

	// "Dismissed for the current update" only while the version the user said
	// "Later" to still matches what's deployed. A newer deploy (or no prior
	// dismissal) re-shows it. Closing + reopening the tab also resets it
	// (sessionStorage lifetime).
	const dismissedForCurrent = $derived(
		dismissedVersion !== null && dismissedVersion === (deployedVersion ?? SW_ONLY)
	);

	$effect(() => {
		if (!browser) return;
		if (!('serviceWorker' in navigator)) return;

		let cancelled = false;
		// Audit 2026-05 finding NEW-11-2: track listeners we add to the SW
		// registration so we can remove them on unmount, or repeated
		// mount/unmount accumulates 'updatefound'/'statechange' listeners.
		let trackedReg: ServiceWorkerRegistration | null = null;
		let onUpdateFound: (() => void) | null = null;
		let trackedNext: ServiceWorker | null = null;
		let onStateChange: (() => void) | null = null;

		async function check(): Promise<void> {
			if (cancelled) return;
			try {
				const reg = await navigator.serviceWorker.getRegistration();
				if (!reg) return;
				// Trigger an update check (no-op if already up to date).
				await reg.update().catch(() => {});
				if (reg.waiting) {
					waitingWorker = reg.waiting;
				} else if (!reg.installing) {
					// No worker waiting and none installing — nothing to apply, so
					// clear any stale reference (avoids a phantom "Load it now").
					waitingWorker = null;
				}
				// Watch for a new worker appearing later. Attach once per
				// registration to avoid duplicate listeners across check()s.
				if (trackedReg !== reg) {
					if (trackedReg !== null && onUpdateFound !== null) {
						trackedReg.removeEventListener('updatefound', onUpdateFound);
					}
					if (trackedNext !== null && onStateChange !== null) {
						trackedNext.removeEventListener('statechange', onStateChange);
						trackedNext = null;
						onStateChange = null;
					}
					trackedReg = reg;
					onUpdateFound = (): void => {
						const next = reg.installing;
						if (!next) return;
						if (trackedNext !== null && onStateChange !== null) {
							trackedNext.removeEventListener('statechange', onStateChange);
						}
						trackedNext = next;
						onStateChange = (): void => {
							if (next.state === 'installed' && navigator.serviceWorker.controller) {
								waitingWorker = next;
							}
						};
						next.addEventListener('statechange', onStateChange);
					};
					reg.addEventListener('updatefound', onUpdateFound);
				}
			} catch {
				// ignore; there's no update path to offer
			}
		}

		// Belt-and-suspenders detection that does NOT depend on the SW byte-diff
		// being seen by the browser. Poll the deployed bundle's own version from
		// /verify.json (cache-busted) and compare to the running bundle's
		// baked-in version. A mismatch = a different bundle is deployed = offer
		// the update, even when reg.update() found no new worker because a proxy
		// served /service-worker.js stale (the desktop case). Runs on mount, on
		// tab-foreground, on reconnect, and on a slow timer.
		async function pollDeployedVersion(): Promise<void> {
			if (cancelled) return;
			try {
				const res = await fetchWithTimeout(
					verifyJsonPollUrl(),
					{ cache: 'no-store', credentials: 'same-origin' },
					10_000
				);
				if (cancelled || !res.ok) return;
				const deployed = parseDeployedVersion(await res.text());
				deployedVersion = deployed;
				if (deployedVersionDiffers(deployed, runningVersion)) {
					newerVersionDeployed = true;
					// Nudge the SW to pick up the new worker too (best-effort).
					const reg = await navigator.serviceWorker.getRegistration();
					await reg?.update().catch(() => {});
				}
			} catch {
				// Network/timeout/parse error — stay silent.
			}
		}

		try {
			const remembered = window.sessionStorage.getItem(DISMISS_KEY);
			if (remembered !== null) dismissedVersion = remembered;
		} catch {
			// ignore
		}

		// cp438: honor consent given before a prior reload. If the user already
		// tapped "Load it now" for a target version and we're STILL not running
		// it, finish the handoff silently instead of re-offering the snackbar.
		const resume = readResume();
		if (resume !== null) {
			if (runningVersion === resume.target) {
				// The update landed — clear and behave normally.
				clearResume();
			} else if (resume.n < MAX_RESUME_ATTEMPTS) {
				// Still on the old bundle, but consent stands: re-drive the
				// handoff and keep the snackbar hidden while we do.
				resuming = true;
				void (async () => {
					await check(); // surface the waiting worker if there is one
					if (cancelled) return;
					applyUpdate(); // re-send APPLY_UPDATE, await controllerchange, reload
				})();
			} else {
				// Attempt cap reached — a genuinely stuck handoff. Stop resuming
				// so the snackbar can resurface; never strand the user silently.
				clearResume();
			}
		}

		void check();
		void pollDeployedVersion();
		// Re-check periodically while the tab is open.
		const timer = setInterval(check, 60_000);
		// Slower deployed-version poll: verify.json carries the full asset-hash
		// manifest and is large, but it's the only path that notices a deploy on
		// a long-open desktop tab whose SW byte-diff a proxy hid.
		const POLL_INTERVAL_MS = 5 * 60_000;
		const pollTimer = setInterval(() => void pollDeployedVersion(), POLL_INTERVAL_MS);

		// Mobile browsers throttle background timers, so re-check the instant the
		// tab is foregrounded and when connectivity returns.
		const onVisible = (): void => {
			if (document.visibilityState === 'visible') {
				void check();
				void pollDeployedVersion();
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		const onOnline = (): void => {
			void check();
			void pollDeployedVersion();
		};
		window.addEventListener('online', onOnline);

		// NOTE: there is deliberately NO AUTONOMOUS 'controllerchange' auto-reload.
		// The page refreshes ONLY after the user clicks "Load it now" (applyUpdate),
		// which is where the single controllerchange listener is registered — so a
		// new frontend still loads only on explicit user consent, never behind the
		// user's back. The service worker also waits for the APPLY_UPDATE message
		// before skipWaiting, so nothing activates unprompted either.

		return () => {
			cancelled = true;
			clearInterval(timer);
			clearInterval(pollTimer);
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('online', onOnline);
			if (trackedReg !== null && onUpdateFound !== null) {
				trackedReg.removeEventListener('updatefound', onUpdateFound);
			}
			if (trackedNext !== null && onStateChange !== null) {
				trackedNext.removeEventListener('statechange', onStateChange);
			}
		};
	});

	// The ONLY place the page reloads — never on its own. Clicking "Load it now"
	// hides the snackbar instantly and asks the waiting worker to take over
	// (skipWaiting via APPLY_UPDATE). When there's a waiting worker we wait for
	// it to actually take CONTROL (controllerchange) before reloading, so the
	// reload is served by the NEW worker and a single tap lands the new bundle.
	// Previously a fixed 250ms reload could fire before the worker had activated
	// (common on mobile, which throttles timers and activates more slowly),
	// leaving the tab on the old bundle — so the verify.json version poll
	// re-detected the mismatch and re-offered, and the user had to tap twice.
	// A timeout fallback still reloads if the handoff stalls, and the
	// version-poll-only path (no waiting worker, because a proxy hid the SW
	// byte-diff) reloads directly since there's no handoff to await — navigations
	// are network-first, so that reload still pulls the fresh shell.
	function applyUpdate(): void {
		applying = true;
		// cp438: record consent across the reload. If the handoff lands on the
		// old worker anyway (mobile), the next load RESUMES silently instead of
		// re-offering. Only when we know the target version — the poll-driven
		// re-offer is exactly the "twice" bug. Version-keyed + attempt-bounded,
		// so it self-clears on success and never wedges (unlike the old
		// persisted "applying" flag).
		if (deployedVersion !== null) {
			const prev = readResume();
			const n = prev !== null && prev.target === deployedVersion ? prev.n + 1 : 1;
			writeResume(deployedVersion, n);
		}
		let reloaded = false;
		const reloadOnce = (): void => {
			if (reloaded) return;
			reloaded = true;
			window.location.reload();
		};
		if (waitingWorker && 'serviceWorker' in navigator) {
			// Reload the instant the new worker takes control.
			navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, {
				once: true
			});
			waitingWorker.postMessage({ type: 'APPLY_UPDATE' });
			// Fallback ONLY for a genuinely stalled handoff — generous on
			// purpose. Mobile throttles skipWaiting + activate, so the
			// controllerchange handoff can take several seconds. The old 3s
			// fallback fired BEFORE the new worker took control on mobile: the
			// reload then landed on the OLD worker, the verify.json poll
			// re-detected the version mismatch, and the snackbar re-offered —
			// the "Load it now twice on mobile" bug (PC activates fast enough
			// that controllerchange always won the 3s race, so PC saw it once).
			// 12s lets the real controllerchange win in virtually every case;
			// this fallback only ever fires if the handoff never completes at
			// all. NOT a persisted flag — persisting an "applied"/"applying"
			// marker is what previously stranded the snackbar hidden for
			// minutes when an update didn't land, so we deliberately don't.
			setTimeout(reloadOnce, 12_000);
		} else {
			// No waiting worker to hand off — just reload to pull the new bundle.
			setTimeout(reloadOnce, 250);
		}
	}

	// "Later" just closes the snackbar — no reload, nothing loaded. It stays
	// hidden for the rest of this browser session (sessionStorage, so closing +
	// reopening the tab resets it), and reappears immediately if an even newer
	// version is deployed (dismissedForCurrent goes false).
	function dismiss(): void {
		// A manual "Later" overrides any in-flight resume consent.
		clearResume();
		dismissedVersion = deployedVersion ?? SW_ONLY;
		try {
			window.sessionStorage.setItem(DISMISS_KEY, dismissedVersion);
		} catch {
			// ignore
		}
	}
</script>

{#if (waitingWorker || newerVersionDeployed) && !applying && !resuming && !dismissedForCurrent}
	<div
		role="status"
		aria-live="polite"
		class="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-2xl rounded-2xl border border-morphit-emerald/30 bg-morphit-emerald/10 p-4 shadow-lg backdrop-blur-sm dark:bg-morphit-emerald/20"
	>
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center">
			<div class="flex-1">
				<p class="font-semibold text-morphit-emerald dark:text-morphit-emerald">
					{$_('update.title')}
				</p>
				<p class="mt-1 text-sm text-ink-700 dark:text-ink-200">
					{$_('update.body')}
				</p>
			</div>
			<div class="flex gap-2 sm:flex-none">
				<button type="button" class="btn-ghost text-sm" onclick={dismiss}>
					{$_('update.later')}
				</button>
				<button type="button" class="btn-primary text-sm" onclick={applyUpdate}>
					{$_('update.apply')}
				</button>
			</div>
		</div>
	</div>
{/if}
