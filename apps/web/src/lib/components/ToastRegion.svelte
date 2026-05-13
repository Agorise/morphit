<script lang="ts">
	/**
	 * ToastRegion — renders the toast stack.
	 *
	 * Mount ONCE at the app root. The component subscribes to
	 * the toastStore, partitions toasts into polite (info,
	 * success) and assertive (warn, error) aria-live regions,
	 * and renders each as a card with its kind styling.
	 *
	 * Positioning: fixed bottom-right on desktop, bottom full-
	 * width on narrow viewports. The wrapping region has
	 * pointer-events: none so it doesn't eat clicks when empty;
	 * each toast card re-enables pointer events for its own
	 * footprint.
	 */

	import { _ } from 'svelte-i18n';
	import { toastStore, dismissToast, pauseToast, resumeToast, type Toast } from '$lib/stores/toast';

	/** Split the stack so we can feed each aria-live region
	 *  only its appropriate toasts. */
	const politeToasts = $derived(
		$toastStore.filter((t) => t.kind === 'info' || t.kind === 'success')
	);
	const assertiveToasts = $derived(
		$toastStore.filter((t) => t.kind === 'warn' || t.kind === 'error')
	);

	/** Kind → visual styling. Mirrors StatusLine's color
	 *  vocabulary so inline-vs-toast for the same event look
	 *  recognizably the same. */
	function borderClass(kind: Toast['kind']): string {
		switch (kind) {
			case 'success':
				return 'border-morphit-emerald';
			case 'info':
				return 'border-morphit-teal';
			case 'warn':
				return 'border-amber-500';
			case 'error':
				return 'border-red-500';
		}
	}

	function textClass(kind: Toast['kind']): string {
		switch (kind) {
			case 'success':
				return 'text-morphit-emerald';
			case 'info':
				return 'text-morphit-teal';
			case 'warn':
				return 'text-amber-700 dark:text-amber-300';
			case 'error':
				return 'text-red-700 dark:text-red-300';
		}
	}
</script>

<!-- Two regions for mixed politeness. Both are fixed-positioned
     at the same spot; the visible stack is the combined
     children. Since each region only holds its own politeness
     class, screen readers announce appropriately. -->
<div
	class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
	aria-hidden="false"
>
	<div role="status" aria-live="polite" class="flex flex-col gap-2">
		{#each politeToasts as toast (toast.id)}
			<div
				role="group"
				class="pointer-events-auto flex items-start gap-3 rounded-xl border-l-4 bg-white px-4 py-3 shadow-morphit-card-hover dark:bg-ink-900 {borderClass(
					toast.kind
				)}"
				onpointerenter={() => pauseToast(toast.id)}
				onpointerleave={() => resumeToast(toast.id)}
				onfocusin={() => pauseToast(toast.id)}
				onfocusout={() => resumeToast(toast.id)}
			>
				<!-- Kind icon. The dot is a lightweight substitute
				     for a full icon set — its color carries the
				     semantic signal, same as StatusLine. -->
				<span
					class="mt-1.5 h-2 w-2 flex-none rounded-full bg-current {textClass(toast.kind)}"
					aria-hidden="true"
				></span>
				<div class="min-w-0 flex-1">
					{#if toast.href}
						<a
							href={toast.href}
							onclick={() => dismissToast(toast.id)}
							class="block text-sm text-ink-800 hover:underline dark:text-ink-100"
						>
							{toast.message}
							<span class="ml-1 text-xs font-semibold text-morphit-emerald">
								{toast.actionLabel ?? $_('toast.view_action')}
								<!-- Phase F.5 audit fix (F-34, F-36) — arrow
								     is decorative (aria-hidden) and uses
								     `:dir(rtl)` so RTL locales (Persian)
								     see ← instead of →.  CSS-driven so
								     it stays logically-correct without
								     duplicating into i18n strings. -->
								<span aria-hidden="true" class="toast-arrow"></span>
							</span>
						</a>
					{:else}
						<p class="text-sm text-ink-800 dark:text-ink-100">
							{toast.message}
						</p>
					{/if}
				</div>
				<button
					type="button"
					onclick={() => dismissToast(toast.id)}
					class="flex-none rounded text-ink-500 hover:text-ink-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400 dark:hover:text-ink-100"
					aria-label={$_('toast.dismiss') as string}
				>
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<path
							d="M6 6L18 18M6 18L18 6"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
						/>
					</svg>
				</button>
			</div>
		{/each}
	</div>

	<div role="alert" aria-live="assertive" class="flex flex-col gap-2">
		{#each assertiveToasts as toast (toast.id)}
			<div
				role="group"
				class="pointer-events-auto flex items-start gap-3 rounded-xl border-l-4 bg-white px-4 py-3 shadow-morphit-card-hover dark:bg-ink-900 {borderClass(
					toast.kind
				)}"
				onpointerenter={() => pauseToast(toast.id)}
				onpointerleave={() => resumeToast(toast.id)}
				onfocusin={() => pauseToast(toast.id)}
				onfocusout={() => resumeToast(toast.id)}
			>
				<!-- Warning/error icon — a filled triangle with an
				     exclamation inside. aria-hidden because the
				     aria-live="assertive" region already conveys
				     the urgency semantic. -->
				<svg
					class="mt-0.5 h-5 w-5 flex-none {textClass(toast.kind)}"
					viewBox="0 0 24 24"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M12 3L2 20h20L12 3z"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linejoin="round"
					/>
					<path
						d="M12 10v4M12 17v.5"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
					/>
				</svg>
				<div class="min-w-0 flex-1">
					{#if toast.href}
						<a
							href={toast.href}
							onclick={() => dismissToast(toast.id)}
							class="block text-sm font-medium text-ink-800 hover:underline dark:text-ink-100"
						>
							{toast.message}
							<span class="ml-1 text-xs font-semibold text-morphit-emerald">
								{toast.actionLabel ?? $_('toast.view_action')}
								<span aria-hidden="true" class="toast-arrow"></span>
							</span>
						</a>
					{:else}
						<p class="text-sm font-medium text-ink-800 dark:text-ink-100">
							{toast.message}
						</p>
					{/if}
				</div>
				<button
					type="button"
					onclick={() => dismissToast(toast.id)}
					class="flex-none rounded text-ink-500 hover:text-ink-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400 dark:hover:text-ink-100"
					aria-label={$_('toast.dismiss') as string}
				>
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<path
							d="M6 6L18 18M6 18L18 6"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
						/>
					</svg>
				</button>
			</div>
		{/each}
	</div>
</div>

<style>
	/* Phase F.5 audit fix (F-36) — arrow that flips for RTL.
	   `:dir()` is supported in modern browsers; for older
	   browsers the LTR arrow shows in RTL but that's a graceful
	   degradation rather than broken rendering. */
	.toast-arrow::after {
		content: '→';
	}
	.toast-arrow:dir(rtl)::after {
		content: '←';
	}
</style>
