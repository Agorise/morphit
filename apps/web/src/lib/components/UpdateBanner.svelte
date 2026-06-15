<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';

	let waitingWorker = $state<ServiceWorker | null>(null);
	let dismissed = $state(false);
	// Set the instant "Load it now" is clicked so the snackbar disappears
	// immediately rather than after the reload round-trip. Persisted in
	// sessionStorage so a reload that lands BEFORE the new worker takes over
	// can't re-show it — that was the PC bug where the button reloaded the
	// page but the snackbar kept coming back, only clearing minutes later
	// once the browser activated the worker on its own. Cleared once the
	// update has actually landed (see check()).
	let applying = $state(false);
	// Guards against a double page reload: whichever fires first — the
	// controllerchange listener, the activated-statechange listener, or the
	// applyUpdate() fallback timer — sets this and the others become no-ops.
	// Resets on every page load, so it can never wedge across navigations.
	let refreshing = false;
	// The worker we've already wired an activated→reload listener onto, so
	// repeated check()s (and re-clicks) can't stack duplicate listeners.
	let armedWorker: ServiceWorker | null = null;

	const DISMISS_KEY = 'morphit.updateDismissed';
	const APPLYING_KEY = 'morphit.updateApplying';

	// Tell the waiting worker to skipWaiting() and reload the moment it
	// becomes the active worker. Idempotent per worker.
	function armActivation(worker: ServiceWorker): void {
		worker.postMessage({ type: 'APPLY_UPDATE' });
		if (armedWorker === worker) return;
		armedWorker = worker;
		worker.addEventListener('statechange', () => {
			if (worker.state === 'activated') {
				if (refreshing) return;
				refreshing = true;
				window.location.reload();
			}
		});
	}

	function clearApplying(): void {
		applying = false;
		try {
			window.sessionStorage.removeItem(APPLYING_KEY);
		} catch {
			// ignore
		}
	}

	$effect(() => {
		if (!browser) return;
		if (!('serviceWorker' in navigator)) return;

		let cancelled = false;
		// Audit 2026-05 finding NEW-11-2: track listeners we add to
		// the SW registration so we can remove them on unmount.
		// Without this, repeated mount/unmount of UpdateBanner
		// (e.g. during navigation) accumulates 'updatefound' and
		// 'statechange' listeners on the same registration, all
		// firing on every update event.
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
					// If we reloaded mid-apply but the new worker is still only
					// "waiting" (the reload raced ahead of activation — the PC
					// case), re-trigger skipWaiting and reload the moment it
					// activates, instead of leaving it to the browser's own slow
					// cycle (which is why it used to take minutes to clear).
					if (applying) armActivation(reg.waiting);
				} else if (!reg.installing) {
					// No worker waiting and none installing — there is nothing
					// to apply, so clear any stale reference. Without this the
					// snackbar could linger as a phantom "update available"
					// (e.g. after the waiting worker already activated or was
					// discarded) offering a "Load it now" button that can't act.
					waitingWorker = null;
					// If we were mid-apply, the update has now landed — let a
					// future update show its snackbar again.
					if (applying) clearApplying();
				}
				// Watch for a new worker appearing later. Only attach
				// once per registration to avoid duplicate listeners
				// across periodic check() invocations.
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
						// Replace any prior tracked installing worker.
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

		try {
			const remembered = window.sessionStorage.getItem(DISMISS_KEY);
			if (remembered === '1') dismissed = true;
			// If a reload landed mid-apply, keep the snackbar hidden until the
			// update has actually taken over (cleared in check()).
			if (window.sessionStorage.getItem(APPLYING_KEY) === '1') applying = true;
		} catch {
			// ignore
		}

		void check();
		// Re-check periodically while tab is open.
		const timer = setInterval(check, 60_000);

		// When a new controller takes over, reload so the new UI is shown.
		const onControllerChange = (): void => {
			if (refreshing) return;
			refreshing = true;
			window.location.reload();
		};
		navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

		return () => {
			cancelled = true;
			clearInterval(timer);
			navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
			if (trackedReg !== null && onUpdateFound !== null) {
				trackedReg.removeEventListener('updatefound', onUpdateFound);
			}
			if (trackedNext !== null && onStateChange !== null) {
				trackedNext.removeEventListener('statechange', onStateChange);
			}
		};
	});

	function applyUpdate(): void {
		const target = waitingWorker;
		if (!target) return;
		// Hide the snackbar instantly — it must disappear the moment you
		// click, on PC and mobile alike — and remember we're applying so a
		// reload that lands before the new worker takes over can't re-show it.
		applying = true;
		try {
			window.sessionStorage.setItem(APPLYING_KEY, '1');
		} catch {
			// ignore
		}
		// Ask the waiting worker to skipWaiting() and reload as soon as it
		// activates. The controllerchange listener above is the usual reload
		// trigger; the activated-statechange listener armActivation() wires up
		// is a faster, more reliable one on browsers where controllerchange
		// lags behind activation (the PC symptom).
		armActivation(target);
		// Fallback: if the page is uncontrolled (opened via a hard refresh,
		// which bypasses the service worker) or the worker is wedged, neither
		// controllerchange nor statechange may fire. Reload anyway after a
		// short grace period so the click always has an effect. The
		// `refreshing` guard keeps this to at most one reload, and the
		// APPLYING_KEY flag keeps the snackbar hidden across it.
		setTimeout(() => {
			if (refreshing) return;
			refreshing = true;
			window.location.reload();
		}, 3000);
	}

	function dismiss(): void {
		dismissed = true;
		try {
			window.sessionStorage.setItem(DISMISS_KEY, '1');
		} catch {
			// ignore
		}
	}
</script>

{#if waitingWorker && !dismissed && !applying}
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
