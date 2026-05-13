<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';

	let waitingWorker = $state<ServiceWorker | null>(null);
	let dismissed = $state(false);

	const DISMISS_KEY = 'morphit.updateDismissed';

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
				if (reg.waiting) waitingWorker = reg.waiting;
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
		} catch {
			// ignore
		}

		void check();
		// Re-check periodically while tab is open.
		const timer = setInterval(check, 60_000);

		// When a new controller takes over, reload so the new UI is shown.
		const onControllerChange = (): void => {
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
		if (!waitingWorker) return;
		// Ask the waiting worker to skipWaiting() — it has our APPLY_UPDATE
		// message protocol. The controllerchange listener above reloads
		// once the new worker takes over.
		waitingWorker.postMessage({ type: 'APPLY_UPDATE' });
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

{#if waitingWorker && !dismissed}
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
