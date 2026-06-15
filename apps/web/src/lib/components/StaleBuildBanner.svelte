<!--
	Morphit — stale-build banner (Batch J).

	Renders at the top of the layout when the chain-announced release
	version differs from the running bundle's baked-in version.

	Tone: friendly, non-alarming.  An out-of-date bundle is annoying
	but not dangerous; the user just needs to reload.  We don't
	auto-reload — that interrupts whatever they were doing — but we
	provide a reload button.

	Hidden when:
	  • Release fetch hasn't completed.
	  • Release fetch failed (we can't tell — silent).
	  • Running version matches announced version.

	NOT a tamper warning.  See `TamperAlertBanner.svelte` for the
	critical alert when the running bundle's bytes don't match the
	signed manifest.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { release, staleBuild, runningVersion } from '$stores/release';

	// Only show when staleBuild === true (false or null → hide).
	const announcedVersion = $derived.by(() => {
		const r = $release;
		return r.kind === 'ok' ? r.release.payload.version : null;
	});

	function reload(): void {
		// Let the service worker activate the new bundle, then
		// hard-reload.  In environments without the SW, this is
		// just a reload.
		if (typeof navigator !== 'undefined' && navigator.serviceWorker?.ready) {
			void navigator.serviceWorker.ready
				.then((reg) => {
					reg.update?.();
				})
				.finally(() => {
					if (typeof window !== 'undefined') window.location.reload();
				});
			return;
		}
		if (typeof window !== 'undefined') window.location.reload();
	}
</script>

{#if $staleBuild === true && announcedVersion !== null}
	<aside
		role="status"
		aria-live="polite"
		class="border-b border-emerald-300 bg-emerald-50 px-4 py-2 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100"
	>
		<div class="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2">
			<p class="text-sm">
				{$_('release.stale_build.body', {
					values: {
						running: runningVersion,
						announced: announcedVersion
					}
				})}
			</p>
			<button
				type="button"
				onclick={reload}
				class="rounded-lg bg-morphit-btn px-3 py-1 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98]"
			>
				{$_('release.stale_build.reload')}
			</button>
		</div>
	</aside>
{/if}
