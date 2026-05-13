<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import type { FaqKey } from '$utils/faqIndex';

	interface Props {
		/** i18n key for the tooltip's explanation text. */
		textKey: string;
		/** Optional FAQ entry to deep-link into. */
		faqKey?: FaqKey;
		/** Label for screen readers describing what the tooltip is about. */
		ariaLabel?: string;
	}

	let { textKey, faqKey, ariaLabel }: Props = $props();

	// Sally finding S-12 (Part 119): pre-fix this defaulted to the
	// English string 'More info', which leaked into ARIA labels for
	// non-English screen-reader users.  Default now reads from i18n.
	// Callers that explicitly pass a hardcoded string still win
	// (props override the default), but those are themselves fixable
	// (see /post asset-explainer tooltips).
	const effectiveAriaLabel = $derived(ariaLabel ?? ($_('a11y.tooltip_more_info') as string));

	let open = $state(false);
	let triggerEl: HTMLButtonElement;

	function openFaq(): void {
		if (!faqKey) return;
		goto(`/faq#${faqKey}`);
	}
</script>

<span class="relative inline-flex items-center">
	<button
		bind:this={triggerEl}
		type="button"
		class="inline-flex h-6 w-6 items-center justify-center rounded-full border border-ink-300 text-ink-500 hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:text-ink-400"
		aria-label={effectiveAriaLabel}
		aria-describedby={open ? `tip-${textKey}` : undefined}
		onmouseenter={() => (open = true)}
		onmouseleave={() => (open = false)}
		onfocus={() => (open = true)}
		onblur={() => (open = false)}
		onclick={openFaq}
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 16v-4" />
			<path d="M12 8h.01" />
		</svg>
	</button>

	{#if open}
		<div
			id="tip-{textKey}"
			role="tooltip"
			class="absolute left-1/2 top-full z-40 mt-2 w-64 -translate-x-1/2 animate-fade-up rounded-xl border border-ink-200 bg-white p-3 text-sm shadow-morphit-card dark:border-ink-700 dark:bg-ink-900"
		>
			<p class="text-ink-800 dark:text-ink-100">{$_(textKey)}</p>
			{#if faqKey}
				<button
					type="button"
					class="mt-2 text-sm font-semibold text-morphit-emerald hover:underline"
					onclick={openFaq}
				>
					{$_('tooltip.learn_more')} →
				</button>
			{/if}
		</div>
	{/if}
</span>
