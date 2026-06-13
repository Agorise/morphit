<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { onDestroy } from 'svelte';
	import { gotoLocale } from '$i18n/navigate';
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

	// ── Open-state management (cp249) ───────────────────────────────
	// Pre-fix the open/close handlers lived on the trigger button and
	// the panel floated below an 8px gap (`mt-2`).  Moving the pointer
	// toward the panel fired the BUTTON's `mouseleave` the instant it
	// crossed off the icon — closing the tooltip before the pointer
	// reached the panel, so the "Learn more" link was impossible to
	// click.  The keyboard path had the mirror bug: Tab-ing from the
	// trigger to the link blurred the trigger and closed the panel.
	//
	// Fix: track hover + focus on the WRAPPER span (which contains both
	// the trigger and the panel), keep the panel open while EITHER is
	// active, bridge the visual gap with transparent padding (so the
	// hover region is continuous), and defer close on a short timer so
	// a brief edge-slip doesn't dismiss it.
	let open = $state(false);
	let hovering = false;
	let focusWithin = false;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	function clearCloseTimer(): void {
		if (closeTimer) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
	}

	function recompute(): void {
		if (hovering || focusWithin) {
			clearCloseTimer();
			open = true;
		} else {
			clearCloseTimer();
			closeTimer = setTimeout(() => {
				open = false;
				closeTimer = null;
			}, 140);
		}
	}

	function onMouseEnter(): void {
		hovering = true;
		recompute();
	}
	function onMouseLeave(): void {
		hovering = false;
		recompute();
	}
	function onFocusIn(): void {
		focusWithin = true;
		recompute();
	}
	function onFocusOut(e: FocusEvent): void {
		// focusin/focusout bubble, so the wrapper observes focus moving
		// among its descendants (trigger ⇄ "Learn more").  If focus
		// stays inside the wrapper, keep the tooltip open.
		const next = e.relatedTarget as Node | null;
		const wrap = e.currentTarget as HTMLElement | null;
		if (next && wrap && wrap.contains(next)) return;
		focusWithin = false;
		recompute();
	}
	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape' && open) {
			hovering = false;
			focusWithin = false;
			clearCloseTimer();
			open = false;
		}
	}

	onDestroy(clearCloseTimer);

	function openFaq(): void {
		if (!faqKey) return;
		gotoLocale(`/faq#${faqKey}`);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	class="relative inline-flex items-center"
	onmouseenter={onMouseEnter}
	onmouseleave={onMouseLeave}
	onfocusin={onFocusIn}
	onfocusout={onFocusOut}
	onkeydown={onKeydown}
>
	<button
		type="button"
		class="inline-flex h-6 w-6 items-center justify-center rounded-full border border-ink-300 text-ink-500 hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-600 dark:text-ink-400"
		aria-label={effectiveAriaLabel}
		aria-describedby={open ? `tip-${textKey}` : undefined}
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
		<!-- Outer wrapper is positioned flush to the trigger (top-full,
		     no margin) with transparent top padding (`pt-2`) that
		     BRIDGES the visual gap: the pointer can travel from the
		     trigger into the panel without ever leaving the wrapper's
		     hover region, while the visible card still floats ~8px
		     below.  The visible card is the inner div. -->
		<div class="absolute left-1/2 top-full z-40 -translate-x-1/2 pt-2">
			<div
				id="tip-{textKey}"
				role="tooltip"
				class="w-64 animate-fade-up rounded-xl border border-ink-200 bg-white p-3 text-sm shadow-morphit-card dark:border-ink-700 dark:bg-ink-900"
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
		</div>
	{/if}
</span>
