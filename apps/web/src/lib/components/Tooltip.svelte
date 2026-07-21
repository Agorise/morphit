<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import type { LocaleCode } from '$i18n/locales';
	import type { FaqKey } from '$utils/faqIndex';
	import type { Snippet } from 'svelte';
	import { portal } from '$lib/ui/portal';

	interface Props {
		/** i18n key for the tooltip's explanation text. */
		textKey: string;
		/** Optional FAQ entry to deep-link into. */
		faqKey?: FaqKey;
		/** Label for screen readers describing what the tooltip is about. */
		ariaLabel?: string;
		/** Optional custom trigger. When provided, this content is rendered as
		 *  the hover/focus target INSTEAD of the default ⓘ icon button — the
		 *  wrapper still owns open/close, so the explainer surfaces on hover
		 *  (desktop) or focus-on-tap (mobile). The caller's element keeps its
		 *  own click handler (e.g. an asset block that selects on tap). When
		 *  omitted, the default ⓘ icon button renders (existing behavior). */
		trigger?: Snippet;
		/** cp406 (Ken) — delay, in ms, before a POINTER hover opens the tooltip.
		 *  0 (default) = open immediately (existing behavior). When > 0, the
		 *  tooltip only opens if the pointer stays over the trigger for this
		 *  long; a hover that leaves sooner never opens it (used on the /post
		 *  asset blocks, where a quick pass over the grid shouldn't flash a
		 *  tooltip). Only the mouse-hover path is delayed — keyboard focus and
		 *  tap-to-pin still open instantly, so touch + a11y are unaffected. */
		hoverOpenDelayMs?: number;
		/** cp511 — optional interpolation values for `textKey`, so a tooltip can
		 *  render a dynamic string (e.g. "+ 260.901 BP delegated to you"). When
		 *  omitted the key is rendered with no values, exactly as before. */
		textValues?: Record<string, string | number>;
	}

	let { textKey, faqKey, ariaLabel, trigger, hoverOpenDelayMs = 0, textValues }: Props = $props();

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
	// cp427 — the panel is PORTALED to <body> (below), so it no longer lives
	// inside the wrapper's hover/focus region. These mirror the wrapper flags
	// for the panel itself, so the "trigger → panel" pointer/keyboard journey
	// keeps the tooltip open (the exact hover-bridge cp249 protected, now
	// spanning the portal boundary).
	let panelHovering = false;
	let panelFocusWithin = false;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	// cp406 — pending hover-open timer (only used when hoverOpenDelayMs > 0).
	let openTimer: ReturnType<typeof setTimeout> | null = null;
	let wrapperEl = $state<HTMLSpanElement>();
	let panelEl = $state<HTMLDivElement>();
	// cp427 — computed FIXED coordinates for the portaled panel (viewport
	// space). `left` is clamped so the w-64 card never spills off either edge;
	// `top` anchors flush to the trigger (the transparent padding bridges the
	// 8px visual gap). Recomputed on open and on scroll/resize while open.
	let panelLeft = $state(0);
	let panelTop = $state(0);
	const PANEL_WIDTH = 256; // w-64
	const EDGE_MARGIN = 8; // keep this far from the viewport's left/right edge

	/** Svelte action: relocate the panel to <body> so it escapes every
	 *  ancestor's `overflow`/stacking context (an order card is a `relative`
	 *  `<li>` whose later siblings painted OVER an in-card absolute tooltip —
	 *  the "appears behind other elements" bug). Combined with `position:fixed`
	 *  + a high z-index below, the panel now floats above everything. */

	function clearCloseTimer(): void {
		if (closeTimer) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
	}

	function clearOpenTimer(): void {
		if (openTimer) {
			clearTimeout(openTimer);
			openTimer = null;
		}
	}

	// Position the portaled panel in viewport (fixed) space: flip ABOVE the
	// trigger when there isn't ~190px of room below (the w-64 card can be that
	// tall), and clamp the horizontal origin so the card stays fully on-screen
	// even when the trigger (e.g. an order card's right-edge hide eyeball) sits
	// near the viewport edge. `panelTop` anchors flush to the trigger edge; the
	// transparent padding in the markup bridges the 8px gap to the visible card.
	function computePosition(): void {
		if (!wrapperEl || typeof window === 'undefined') return;
		const rect = wrapperEl.getBoundingClientRect();
		const spaceBelow = window.innerHeight - rect.bottom;
		placement = spaceBelow < 200 ? 'above' : 'below';

		const triggerCenterX = rect.left + rect.width / 2;
		const maxLeft = window.innerWidth - PANEL_WIDTH - EDGE_MARGIN;
		// Center on the trigger, then clamp into [EDGE_MARGIN, maxLeft]. When the
		// viewport is narrower than the card + margins, maxLeft < EDGE_MARGIN, so
		// Math.max wins and the card pins to the left margin (still fully visible,
		// just not centered) rather than overflowing.
		panelLeft = Math.max(EDGE_MARGIN, Math.min(triggerCenterX - PANEL_WIDTH / 2, maxLeft));
		// 'below' → top edge just under the trigger; 'above' → flush to the
		// trigger's TOP (the panel is shifted up by its own height via a
		// translateY(-100%) in the markup, so variable panel height is handled).
		panelTop = placement === 'below' ? rect.bottom : rect.top;
	}

	function recompute(): void {
		if (hovering || focusWithin || panelHovering || panelFocusWithin || pinned) {
			clearCloseTimer();
			computePosition();
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
		if (hoverOpenDelayMs > 0) {
			// Arm the open: only mark as hovering (which opens via recompute)
			// once the pointer has dwelled for the full delay. A leave before
			// then clears this timer, so a quick pass never opens the tooltip.
			clearOpenTimer();
			openTimer = setTimeout(() => {
				openTimer = null;
				hovering = true;
				recompute();
			}, hoverOpenDelayMs);
			return;
		}
		hovering = true;
		recompute();
	}
	function onMouseLeave(): void {
		clearOpenTimer();
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
			panelHovering = false;
			panelFocusWithin = false;
			pinned = false;
			clearOpenTimer();
			clearCloseTimer();
			open = false;
		}
	}

	// cp427 — the portaled panel's own hover/focus, so pointer or keyboard can
	// move from the trigger onto the panel (e.g. to click "Learn more") without
	// the tooltip closing. The 140ms close-timer bridges the 8px gap during the
	// hand-off; the transparent padding in the markup keeps the hover region
	// continuous so the pointer never crosses dead space.
	function onPanelEnter(): void {
		panelHovering = true;
		recompute();
	}
	function onPanelLeave(): void {
		panelHovering = false;
		recompute();
	}
	function onPanelFocusIn(): void {
		panelFocusWithin = true;
		recompute();
	}
	function onPanelFocusOut(e: FocusEvent): void {
		const next = e.relatedTarget as Node | null;
		const wrap = e.currentTarget as HTMLElement | null;
		if (next && wrap && wrap.contains(next)) return;
		panelFocusWithin = false;
		recompute();
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
	// cp427 — the panel is now portaled OUTSIDE the wrapper, so a tap on the
	// panel itself must count as "inside" too, else tapping "Learn more" would
	// dismiss before the click lands.
	$effect(() => {
		if (!pinned) return;
		const onDocPointer = (e: Event): void => {
			const t = e.target as Node;
			const insideWrapper = wrapperEl?.contains(t);
			const insidePanel = panelEl?.contains(t);
			if (!insideWrapper && !insidePanel) {
				pinned = false;
				recompute();
			}
		};
		document.addEventListener('pointerdown', onDocPointer, true);
		return () => document.removeEventListener('pointerdown', onDocPointer, true);
	});

	// cp427 — while open, keep the fixed-positioned panel glued to the trigger
	// as the page scrolls or the window resizes (a fixed element does NOT move
	// with scroll on its own). Capture-phase scroll catches nested scroll
	// containers too; both listeners are passive (read-only) and torn down when
	// the tooltip closes.
	$effect(() => {
		if (!open || typeof window === 'undefined') return;
		const onReflow = (): void => computePosition();
		window.addEventListener('scroll', onReflow, { capture: true, passive: true });
		window.addEventListener('resize', onReflow, { passive: true });
		return () => {
			window.removeEventListener('scroll', onReflow, true);
			window.removeEventListener('resize', onReflow);
		};
	});

	// cp510 [9] — INSTANT dismiss when the pointer rests over NEITHER the
	// trigger nor the panel. With a portaled, fixed panel a plain mouseleave
	// can be missed — the pointer jumps to an element painted above, or the
	// w-64 card overlaps neighbouring chips — leaving `panelHovering` stuck
	// true so the tooltip lingers (Ken: "if my mouse is not resting over the
	// asset block or its tooltip, the tooltip needs to instantly disappear").
	// A capture-phase document `pointerover` fires on every element boundary
	// the pointer crosses; if the new target is inside neither region, close
	// now (no 140ms bridge). Skipped while pinned (tap) or keyboard-focused —
	// those have their own dismiss paths (outside-tap / blur / Escape) and a
	// roaming mouse must not yank a tooltip a keyboard user opened.
	$effect(() => {
		if (!open || typeof document === 'undefined') return;
		const onPointerOver = (e: Event): void => {
			if (pinned || focusWithin || panelFocusWithin) return;
			const t = e.target as Node | null;
			if (!t) return;
			const insideWrapper = wrapperEl?.contains(t) ?? false;
			const insidePanel = panelEl?.contains(t) ?? false;
			if (insideWrapper || insidePanel) return;
			hovering = false;
			panelHovering = false;
			clearOpenTimer();
			clearCloseTimer();
			open = false;
		};
		document.addEventListener('pointerover', onPointerOver, true);
		return () => document.removeEventListener('pointerover', onPointerOver, true);
	});

	onDestroy(() => {
		clearCloseTimer();
		clearOpenTimer();
	});

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
	{#if trigger}
		{@render trigger()}
	{:else}
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
	{/if}

	{#if open}
		<!-- cp427 — the panel is PORTALED to <body> and FIXED-positioned, so it
		     floats above every card / stacking context ("on top of everything")
		     and its horizontal origin is clamped to the viewport ("visible near
		     the edge / page fold"). The outer div anchors flush to the trigger
		     edge (panelTop) with transparent padding (pt-2 below / pb-2 above)
		     that BRIDGES the 8px visual gap so the pointer never crosses dead
		     space; its own hover/focus keep the tooltip open across the portal
		     seam. `placement` flips it above the trigger when there isn't room
		     below; for 'above' the panel is shifted up by its own height via
		     translateY(-100%) so variable panel heights are handled. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={panelEl}
			use:portal
			class="fixed z-50 {placement === 'above' ? 'pb-2' : 'pt-2'}"
			style="left: {panelLeft}px; top: {panelTop}px;{placement === 'above'
				? ' transform: translateY(-100%);'
				: ''}"
			onmouseenter={onPanelEnter}
			onmouseleave={onPanelLeave}
			onfocusin={onPanelFocusIn}
			onfocusout={onPanelFocusOut}
		>
			<div
				id="tip-{textKey}"
				role="tooltip"
				class="w-64 animate-fade-up rounded-xl border border-ink-200 bg-white p-3 text-sm shadow-morphit-card dark:border-ink-700 dark:bg-ink-900"
			>
				<p class="text-ink-800 dark:text-ink-100">
					{$_(textKey, textValues ? { values: textValues } : undefined)}
				</p>
				{#if faqKey}
					<button
						type="button"
						class="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-ink-900 transition-colors hover:text-morphit-emerald dark:text-white"
						onclick={openFaq}
					>
						{$_('common.learn_more')}
						<span class="nav-arrow nav-arrow-right" aria-hidden="true">⇨</span>
					</button>
				{/if}
			</div>
		</div>
	{/if}
</span>
