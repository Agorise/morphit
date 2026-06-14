<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import type { LocaleCode } from '$i18n/locales';
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

	// ── Open-state management (cp249 + cp257) ───────────────────────
	// Pre-cp249 the open/close handlers lived on the trigger button and
	// the panel floated below an 8px gap; moving the pointer toward the
	// panel fired the BUTTON's mouseleave and closed it before the pointer
	// arrived, so "Learn more" was unclickable.  Fix: track hover + focus
	// on the WRAPPER (which contains both trigger and panel), keep open
	// while EITHER is active, bridge the gap with transparent padding, and
	// defer close on a short timer so a brief edge-slip doesn't dismiss it.
	//
	// cp257 adds two things:
	//   • `pinned` — a tap/click toggle. iOS doesn't reliably focus a
	//     <button> on tap, so hover/focus alone left touch users unable to
	//     open the tooltip at all. Tapping the icon now pins it open (and an
	//     outside tap or Escape closes it).
	//   • viewport-aware `placement` — flip the panel ABOVE the trigger when
	//     there isn't room below, so it's never cut off at the bottom of the
	//     screen (the reported onboarding bug).
	let open = $state(false);
	let pinned = $state(false);
	let placement = $state<'above' | 'below'>('below');
	let hovering = false;
	let focusWithin = false;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	let wrapperEl = $state<HTMLSpanElement>();

	function clearCloseTimer(): void {
		if (closeTimer) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
	}

	// Open below the trigger by default; flip above when there isn't enough
	// room underneath. The panel can be ~190px tall (w-64 card: hint text +
	// "Learn more"), so if less than that remains below the icon, opening
	// downward would run off the bottom of the viewport.
	function computePlacement(): void {
		if (!wrapperEl || typeof window === 'undefined') return;
		const rect = wrapperEl.getBoundingClientRect();
		const spaceBelow = window.innerHeight - rect.bottom;
		placement = spaceBelow < 200 ? 'above' : 'below';
	}

	function recompute(): void {
		if (hovering || focusWithin || pinned) {
			clearCloseTimer();
			computePlacement();
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
			pinned = false;
			clearCloseTimer();
			open = false;
		}
	}

	// Tap/click the icon toggles the hint — the reliable open path on touch.
	// It deliberately does NOT navigate: navigation is the "Learn more"
	// link's job, and during onboarding a same-tab nav would trip the
	// leave-guard and discard the user's in-progress keys.
	function toggle(): void {
		pinned = !pinned;
		recompute();
	}

	// While pinned open (tapped), an outside tap dismisses it. Scoped to the
	// pinned window and self-cleaning, so no listener lingers after close.
	$effect(() => {
		if (!pinned) return;
		const onDocPointer = (e: Event): void => {
			if (wrapperEl && !wrapperEl.contains(e.target as Node)) {
				pinned = false;
				recompute();
			}
		};
		document.addEventListener('pointerdown', onDocPointer, true);
		return () => document.removeEventListener('pointerdown', onDocPointer, true);
	});

	onDestroy(clearCloseTimer);

	// "Learn more" opens the FAQ entry in a NEW TAB. This (1) keeps the user
	// on their current page — critical during onboarding, where a same-tab
	// nav would trigger the leave-confirmation modal and wipe generated keys
	// — and (2) is the conventional behaviour for a help reference. The FAQ
	// page reads the #<key> hash and expands + scrolls to that entry.
	function openFaq(): void {
		if (!faqKey || typeof window === 'undefined') return;
		const lang = get(page).params.lang as LocaleCode | undefined;
		window.open(localePath(`/faq#${faqKey}`, lang), '_blank', 'noopener,noreferrer');
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	bind:this={wrapperEl}
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
		aria-expanded={open}
		aria-describedby={open ? `tip-${textKey}` : undefined}
		onclick={toggle}
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
		<!-- Outer wrapper is positioned flush to the trigger with
		     transparent padding (pt-2 below / pb-2 above) that BRIDGES the
		     visual gap: the pointer can travel from the trigger into the
		     panel without leaving the wrapper's hover region, while the
		     visible card floats ~8px away. `placement` flips it above the
		     trigger when there isn't room below (viewport-bottom guard). -->
		<div
			class="absolute left-1/2 z-40 -translate-x-1/2 {placement === 'above'
				? 'bottom-full pb-2'
				: 'top-full pt-2'}"
		>
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
