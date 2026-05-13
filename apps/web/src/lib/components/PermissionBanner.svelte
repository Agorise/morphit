<script lang="ts">
	/**
	 * PermissionBanner — point-of-relevance permission prompt.
	 *
	 * Rendered by the root layout when shouldShowPermissionBanner()
	 * is true AND at least one event has arrived during this session
	 * that would have fired a native notification if permission had
	 * been granted. That gating means the banner is never shown on a
	 * cold page load — it only shows after the user has already
	 * experienced something notification-worthy happening. This is
	 * the pattern with ~3x the grant rate of page-load prompts.
	 *
	 * Three actions: Enable (triggers permission prompt), Not now
	 * (decline with backoff — 1 week, then 1 month, then never),
	 * Never ask again (hard decline).
	 */
	import { _ } from 'svelte-i18n';
	import {
		requestPermission,
		declinePermissionBanner,
		neverAskAgain,
		shouldShowPermissionBanner,
		permission
	} from '$lib/notifications/native';

	interface Props {
		/** The category of the event that triggered this banner —
		 *  shown in the body copy so the user has concrete context. */
		category: 'order' | 'chat' | 'feedback';
		/** Called when banner should close (regardless of which
		 *  action the user took). Parent owns visibility. */
		onClose: () => void;
	}

	let { category, onClose }: Props = $props();

	let requesting = $state(false);

	async function onEnable(): Promise<void> {
		if (requesting) return;
		requesting = true;
		try {
			await requestPermission();
			// Regardless of the result — grant, deny — close the banner.
			// If denied, decline history was already recorded by
			// requestPermission. If granted, we're done.
			onClose();
		} finally {
			requesting = false;
		}
	}

	function onNotNow(): void {
		declinePermissionBanner();
		onClose();
	}

	function onNever(): void {
		neverAskAgain();
		onClose();
	}

	// Visibility guard: if the user granted permission in another tab
	// between the event firing and the banner rendering, don't show.
	// Also skip on unsupported browsers.
	const shouldShow = $derived(shouldShowPermissionBanner() && $permission === 'default');
</script>

{#if shouldShow}
	<div
		role="region"
		aria-label={$_('settings.notifications.permission_banner_title')}
		class="sticky top-[64px] z-30 mx-auto max-w-7xl px-4 py-3 md:px-6"
	>
		<div
			class="flex flex-wrap items-start gap-4 rounded-2xl border border-morphit-emerald/40 bg-morphit-emerald/5 p-4 shadow-morphit-card"
		>
			<div class="flex flex-none items-center justify-center">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
					class="text-morphit-emerald"
				>
					<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
					<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
				</svg>
			</div>
			<div class="min-w-0 flex-1">
				<h3 class="font-display font-bold">
					{$_('settings.notifications.permission_banner_title')}
				</h3>
				<p class="mt-1 text-sm text-ink-700 dark:text-ink-200">
					{$_('settings.notifications.permission_banner_body', {
						values: { category: $_(`avatar_menu.category.${category}`) }
					})}
				</p>
			</div>
			<div class="flex flex-none flex-wrap gap-2">
				<button
					type="button"
					onclick={onEnable}
					disabled={requesting}
					class="btn-primary btn-shine text-sm disabled:opacity-60"
				>
					{$_('settings.notifications.permission_banner_enable')}
				</button>
				<button
					type="button"
					onclick={onNotNow}
					class="rounded-xl border border-ink-300 bg-white px-4 py-2 text-sm font-semibold text-ink-700 transition hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200"
				>
					{$_('settings.notifications.permission_banner_later')}
				</button>
				<button
					type="button"
					onclick={onNever}
					class="rounded-xl px-2 py-2 text-xs font-semibold text-ink-500 transition hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400"
				>
					{$_('settings.notifications.permission_banner_never')}
				</button>
			</div>
		</div>
	</div>
{/if}
