<script lang="ts">
	/**
	 * BusyButton — a button grandma can trust.
	 *
	 * Every button that triggers an async action should use this
	 * component instead of a raw <button>. It guarantees:
	 *
	 *   - Press-depress micro-animation (scale 0.97 on :active)
	 *     so the click registers visually within a single frame
	 *   - Inline spinner when `busy` is true, replacing nothing
	 *     but joining the label so the button's width is stable
	 *   - aria-busy attribute for screen-readers
	 *   - Automatic disable while busy (can't double-submit)
	 *   - Consistent variant styling (primary/secondary/ghost)
	 *
	 * See docs/UX-STANDARD.md for the rules this component enforces.
	 */

	import type { Snippet } from 'svelte';

	interface Props {
		/** Primary CTA, secondary, ghost, or text-link (de-emphasized
		 *  back/cancel nav). Only one primary per screen. */
		variant?: 'primary' | 'secondary' | 'secondary-quiet' | 'ghost' | 'link' | 'danger';
		/** True while the action is in flight. Shows spinner, disables button. */
		busy?: boolean;
		/** True briefly after a just-completed success. Shows a
		 *  checkmark next to the label. Caller should flip this off
		 *  after 1-2 seconds. Mutually exclusive with busy. */
		done?: boolean;
		/** External disable (e.g. form not valid). Overridden by busy=true. */
		disabled?: boolean;
		/** Label shown while busy=true. Falls back to the main label. */
		busyLabel?: string;
		/** Button type; defaults to 'button' (not 'submit'). */
		type?: 'button' | 'submit' | 'reset';
		/** Full-width layout inside a container. */
		fullWidth?: boolean;
		/** Button size. 'md' (default) is the standard CTA. 'sm' is a compact
		 *  variant (~half the padding + smaller label + smaller spinner) for
		 *  dense per-row action rows like the my/orders card buttons
		 *  (t.txt v1.4.9 #4). Ignored for the 'link' variant. */
		size?: 'md' | 'sm';
		/** Click handler. Can be async — busy state handled by caller. */
		onclick?: (e: MouseEvent) => void;
		/** Main button label (children). */
		children: Snippet;
		/** Optional ARIA label override. */
		'aria-label'?: string;
	}

	let {
		variant = 'primary',
		busy = false,
		done = false,
		disabled = false,
		busyLabel,
		type = 'button',
		fullWidth = false,
		size = 'md',
		onclick,
		children,
		'aria-label': ariaLabel
	}: Props = $props();

	const effectivelyDisabled = $derived(busy || disabled);

	// Variant classes. Tailwind utility combos rather than CSS
	// component classes, so Tailwind tree-shakes unused variants.
	const variantClass = $derived.by(() => {
		switch (variant) {
			case 'primary':
				return 'bg-morphit-btn text-white font-bold shadow hover:brightness-110 disabled:bg-ink-300 disabled:text-ink-500 disabled:shadow-none';
			case 'secondary':
				return 'bg-white dark:bg-ink-900 text-morphit-emerald font-semibold border-2 border-morphit-emerald hover:bg-emerald-50 dark:hover:bg-ink-800 disabled:border-ink-300 disabled:text-ink-400';
			case 'secondary-quiet':
				// v1.5.0 — like `secondary` but a 1px (not 2px) border, for
				// save-in-place actions (Settings). Full-strength emerald: the
				// old 40%-opacity border read as washed-out/pink on some displays.
				return 'bg-white dark:bg-ink-900 text-morphit-emerald font-semibold border border-morphit-emerald hover:bg-emerald-100 dark:hover:bg-ink-800 disabled:border-ink-300 disabled:text-ink-400';
			case 'danger':
				// Outlined destructive action (cancel an order, etc.): dark-red
				// text + border with a faint red wash on hover. Outlined rather
				// than solid-red so it reads as deliberate, not alarming.
				return 'bg-white dark:bg-ink-900 text-red-700 dark:text-red-400 font-semibold border-2 border-red-300 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/40 hover:border-red-500 disabled:border-ink-300 disabled:text-ink-400';
			case 'ghost':
				return 'bg-transparent text-ink-700 dark:text-ink-200 font-medium hover:bg-ink-100 dark:hover:bg-ink-800 disabled:text-ink-400';
			case 'link':
				// De-emphasized text link (back/cancel nav): grey text, emerald
				// on hover, no button chrome (the layoutClass below drops the
				// padding/rounding/scale so it reads as a link, not a button).
				return 'bg-transparent text-ink-300 font-medium hover:text-morphit-emerald disabled:text-ink-500';
		}
	});

	// Layout differs for the link variant: no button padding/rounding/
	// scale, so it reads as an inline text link. For real buttons, `size`
	// selects standard vs compact chrome.
	const layoutClass = $derived.by(() => {
		if (variant === 'link') {
			return 'inline-flex items-center gap-1.5 text-base transition disabled:cursor-not-allowed';
		}
		const pad =
			size === 'sm'
				? 'gap-1.5 rounded-xl px-3 py-1.5 text-sm'
				: 'gap-2 rounded-2xl px-5 py-3 text-base';
		return `inline-flex items-center justify-center ${pad} transition active:scale-[0.97] disabled:cursor-not-allowed disabled:active:scale-100`;
	});
	// Spinner/checkmark glyph scales with the button size.
	const glyphClass = $derived(size === 'sm' ? 'h-4 w-4' : 'h-5 w-5');
</script>

<button
	{type}
	disabled={effectivelyDisabled}
	aria-busy={busy}
	aria-label={ariaLabel}
	{onclick}
	class="{layoutClass} {variantClass} {fullWidth ? 'w-full' : ''}"
>
	{#if busy}
		<!-- Inline spinner. Uses currentColor so it matches the button
		     variant automatically. Sized to match typography line-height. -->
		<svg class="{glyphClass} animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
			<path
				d="M21 12a9 9 0 0 0-9-9"
				stroke="currentColor"
				stroke-width="3"
				stroke-linecap="round"
			/>
		</svg>
		{busyLabel ?? ''}
		{#if !busyLabel}
			{@render children()}
		{/if}
	{:else if done}
		<!-- Checkmark celebrating a just-completed action. Tuned to be
		     visible without being cartoonish; the label stays primary. -->
		<svg class="{glyphClass}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="M5 12l4 4L19 7"
				stroke="currentColor"
				stroke-width="3"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
		{@render children()}
	{:else}
		{@render children()}
	{/if}
</button>
