<script lang="ts">
	/**
	 * AnimatedNumber — counts a displayed numeric value from its
	 * previous to its next value over ~1s, with a brief color
	 * flash on the wrapper to draw the eye.
	 *
	 * Why not "odometer-style per-digit roll": that style tends to
	 * look great when EVERY digit moves, but for a balance card
	 * showing e.g. "1,234.567 BLURT" → "1,734.567 BLURT", only the
	 * thousands digit changes — a per-digit-roll animation would
	 * look broken (one digit spinning, others static).  A
	 * tween-the-whole-number approach handles all magnitude
	 * changes uniformly: small deltas count fast, large deltas
	 * count slower (capped at the duration), and the color flash
	 * is what actually catches the eye.
	 *
	 * Behavior:
	 *   - First render: snaps to the value with no animation.
	 *     This avoids "every page load looks like a balance just
	 *     changed" misfires.
	 *   - Subsequent updates where the value changed by more than
	 *     `epsilon` (default 1e-9): runs the tween + color flash.
	 *   - Sub-epsilon "changes" (RPC float jitter): no animation.
	 *   - prefers-reduced-motion: skip the tween, just flash
	 *     briefly so something still acknowledges the change.
	 *   - NaN: rendered as `--` with no animation.
	 *
	 * Color semantics:
	 *   - Higher value than before → emerald (gain)
	 *   - Lower value than before  → red (loss / spend)
	 *   - Initial render or NaN     → no color
	 *
	 * The wrapper uses tabular-nums so digits don't shift width
	 * mid-tween (the BLURT amount section can have varying widths
	 * across "1.234" → "11.234" → "111.234").
	 *
	 * Props:
	 *   value      — the target number to display.
	 *   decimals   — fractional digits to render (default 3 to
	 *                match BLURT precision).
	 *   durationMs — tween duration in ms (default 1100 — long
	 *                enough to be noticed without being slow).
	 *   epsilon    — minimum delta to trigger animation; below
	 *                this we just snap (default 1e-9).
	 */
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { locale } from 'svelte-i18n';

	interface Props {
		value: number;
		decimals?: number;
		durationMs?: number;
		epsilon?: number;
		/** Whether to group thousands (1,234 vs 1234). Default true.
		 *  The compact mobile balance variant turns this off. */
		grouping?: boolean;
		/** Optional aria-label override.  By default the rendered
		 *  number is the accessible content. */
		ariaLabel?: string;
		/** cp433 — when true, a value change snaps in with NO color flash
		 *  and no tween (like the first render). Used to quietly apply the
		 *  tiny per-op fee debited on a power-down, which otherwise flashes
		 *  the BLURT balance red and alarms the user (the money that's
		 *  actually moving is BP, released weekly over 4 weeks). Normal
		 *  balance changes leave this false and animate as usual. */
		silent?: boolean;
	}
	let {
		value,
		decimals = 3,
		durationMs = 1100,
		epsilon = 1e-9,
		grouping = true,
		ariaLabel,
		silent = false
	}: Props = $props();

	/** The number currently shown.  Tweens between values.
	 *  Initializer reads `value` once on first render — the
	 *  reactive prop tracking happens in the $effect below
	 *  which calls tweenTo() on each change.  svelte-ignore is
	 *  correct here: this is intentional first-paint snapshot. */
	// svelte-ignore state_referenced_locally
	let displayed = $state(Number.isFinite(value) ? value : NaN);
	/** Previous "settled" value — the source of truth between
	 *  animations.  Updated when the tween completes.
	 *  Same one-shot-snapshot rationale as `displayed`. */
	// svelte-ignore state_referenced_locally
	let lastSettled = Number.isFinite(value) ? value : NaN;
	/** True between animation start and end. Drives the CSS class
	 *  that paints the color flash. */
	let flash: 'gain' | 'loss' | null = $state(null);
	/** Used to skip the very first prop application — first render
	 *  shouldn't look like a balance change. */
	let hasMounted = $state(false);
	let rafId: number | null = null;
	let flashTimer: ReturnType<typeof setTimeout> | null = null;

	onMount(() => {
		hasMounted = true;
		// Initial snap with no animation.  `lastSettled` already
		// matches `value` from the let-init above, but we guard
		// against NaN-to-finite transitions on first render.
		if (Number.isFinite(value) && !Number.isFinite(lastSettled)) {
			lastSettled = value;
			displayed = value;
		}
	});

	function prefersReducedMotion(): boolean {
		if (!browser) return false;
		try {
			return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		} catch {
			return false;
		}
	}

	function tweenTo(target: number, from: number): void {
		// Cancel any in-flight tween before starting a new one.
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		const start = performance.now();
		const delta = target - from;
		// Ease-out cubic: most of the visible movement happens
		// early, finishing with a soft landing.  Felt better than
		// linear in informal testing — linear felt mechanical, the
		// ease-out feels like "the number relaxed into place".
		const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

		function step(now: number): void {
			const elapsed = now - start;
			if (elapsed >= durationMs) {
				displayed = target;
				rafId = null;
				return;
			}
			const t = ease(elapsed / durationMs);
			displayed = from + delta * t;
			rafId = requestAnimationFrame(step);
		}
		rafId = requestAnimationFrame(step);
	}

	function startFlash(direction: 'gain' | 'loss'): void {
		flash = direction;
		if (flashTimer !== null) clearTimeout(flashTimer);
		// cp429 — the color lasts EXACTLY as long as the odometer tween, no
		// longer (was durationMs + 400, a tail that outlived the count).
		flashTimer = setTimeout(() => {
			flash = null;
			flashTimer = null;
		}, durationMs);
	}

	// React to value changes after first mount.
	$effect(() => {
		// Read the prop unconditionally so $effect tracks it.
		const next = value;
		if (!hasMounted) return;
		if (!Number.isFinite(next)) {
			// Transitioning to NaN: snap, no animation.
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			displayed = NaN;
			lastSettled = NaN;
			return;
		}
		if (!Number.isFinite(lastSettled)) {
			// Transitioning from NaN to a real value: snap, no
			// animation.  Treats first-real-value the same as
			// initial mount.
			lastSettled = next;
			displayed = next;
			return;
		}
		const diff = Math.abs(next - lastSettled);
		if (diff < epsilon) {
			// RPC float jitter or an unchanged value — no animation.
			lastSettled = next;
			displayed = next;
			return;
		}
		// cp429 — suppress the flash/tween when the change is imperceptible at
		// the DISPLAYED precision. BP is derived from VESTS via the global
		// vesting ratio, which drifts by sub-milli-BP every block, so each
		// wallet poll recomputed a bpBalance that differed BELOW the 3rd
		// decimal — above `epsilon` but invisible on screen. That re-flashed
		// the number green every few seconds, forever, even after a refresh.
		// If the digits the user actually SEES don't change, update silently.
		if (next.toFixed(decimals) === lastSettled.toFixed(decimals)) {
			lastSettled = next;
			displayed = next;
			return;
		}
		if (silent) {
			// cp433 — caller asked for a quiet update (the per-op fee on a
			// power-down). Snap to the new value with no color, no tween.
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			lastSettled = next;
			displayed = next;
			return;
		}
		const direction: 'gain' | 'loss' = next > lastSettled ? 'gain' : 'loss';
		startFlash(direction);
		if (prefersReducedMotion()) {
			// Skip the tween for users who asked for less motion;
			// the color flash still acknowledges the change.
			displayed = next;
		} else {
			tweenTo(next, lastSettled);
		}
		lastSettled = next;
	});

	// Cleanup on unmount.  Part 74: switched from a no-deps
	// `$effect(() => () => ...)` pattern to onDestroy.  The old
	// pattern relied on the effect's body containing no reactive
	// reads — a future edit adding any reactive dependency would
	// silently break the cleanup semantics (cleanup would re-run on
	// every dependency change instead of only on unmount).
	// onDestroy makes the unmount-only intent unambiguous.
	onDestroy(() => {
		if (rafId !== null) cancelAnimationFrame(rafId);
		if (flashTimer !== null) clearTimeout(flashTimer);
	});

	const formatted = $derived.by(() => {
		if (!Number.isFinite(displayed)) return '--';
		// Format per the APP's selected locale (the language the user picked in
		// the switcher), NOT the browser's — a German (de) user sees
		// "1.234,567" (dot thousands, comma decimal) even if their browser is
		// English. Falls back to the browser locale, then a plain toFixed.
		const appLocale = $locale ?? undefined;
		try {
			return displayed.toLocaleString(appLocale, {
				minimumFractionDigits: decimals,
				maximumFractionDigits: decimals,
				useGrouping: grouping
			});
		} catch {
			try {
				return displayed.toLocaleString(undefined, {
					minimumFractionDigits: decimals,
					maximumFractionDigits: decimals,
					useGrouping: grouping
				});
			} catch {
				return displayed.toFixed(decimals);
			}
		}
	});
</script>

<span
	class="animated-number tabular-nums transition-colors duration-300"
	class:flash-gain={flash === 'gain'}
	class:flash-loss={flash === 'loss'}
	aria-label={ariaLabel}
	aria-live="polite"
	aria-atomic="true"
>
	{formatted}
</span>

<style>
	.animated-number {
		/* tabular-nums also via Tailwind; this is belt+suspenders
		   to keep digit widths constant across the tween. */
		font-variant-numeric: tabular-nums;
		display: inline-block;
	}
	.flash-gain {
		color: rgb(16, 185, 129); /* matches morphit-emerald */
	}
	.flash-loss {
		color: rgb(220, 38, 38); /* tailwind red-600 */
	}
</style>
