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

	// v1.1.5 — the "Load it now twice on mobile" bug was NOT the SW handoff
	// timing (cp364→438 all chased that and failed on-device). The real cause:
	// a reload could be answered from a stale HTTP-cached index.html, landing
	// on the OLD shell — so the poll re-detected the mismatch and re-offered.
	// The fix is upstream: the service worker now fetches navigations with
	// `cache:'reload'` (fresh shell from origin every time). With the reload
	// reliably landing on the new bytes, cp438's cross-reload "resume + attempt
	// cap" machinery is unnecessary — and it was itself the thing that
	// re-surfaced the snackbar at its cap (the visible SECOND fire), so it's
	// removed. Worst case now is ONE honest re-offer if a reload genuinely
	// can't reach the origin; never two.

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
		// v1.8.14 (Ken) — RECORD THE ACCEPTANCE BEFORE RELOADING.
		//
		// This is why "Load it now" kept appearing twice on mobile, and why the
		// previous fix (a more generous handoff timeout) never finished the job:
		// a timeout only NARROWS the race, it cannot remove it. Clicking accept
		// reloaded without noting that the user had already said yes to THIS
		// build, so whenever the reload landed before the new worker had taken
		// control, the verify.json poll re-detected the same mismatch and offered
		// the same update again. Slower devices lose that race more often —
		// exactly matching "still shows twice every time on mobile".
		//
		// Recording it makes the fix timing-INDEPENDENT: the second offer is
		// suppressed because the answer is already known, not because we hope the
		// handoff won. Safe by construction — it is sessionStorage (closing the
		// tab resets it) and keyed to the version, so a genuinely NEWER deploy
		// still prompts.
		rememberHandled();
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
	/** Remember that this build has been ANSWERED — accepted or postponed — so it
	 *  is not offered again this session. Shared by both paths so the two can
	 *  never drift apart. */
	function rememberHandled(): void {
		dismissedVersion = deployedVersion ?? SW_ONLY;
		try {
			window.sessionStorage.setItem(DISMISS_KEY, dismissedVersion);
		} catch {
			// ignore — a private-mode storage denial must not block the reload
		}
	}

	function dismiss(): void {
		rememberHandled();
	}
</script>

{#if (waitingWorker || newerVersionDeployed) && !applying && !dismissedForCurrent}
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
