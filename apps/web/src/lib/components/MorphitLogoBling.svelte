<!--
	MorphitLogoBling — the Morphit wordmark, with an OPTIONAL occasional
	"shine" that sweeps along the letterforms to draw the eye.

	HISTORY / WHY THIS IS NOW STATIC (cp228)

	Earlier builds rendered a canvas element behind the wordmark running a
	slow 3-body particle dance (mutual spring + centroid gravity).  Ken retired
	that effect: the big hero logo on the homepage is now a plain static
	wordmark with no animation at all, and the small top-left header
	wordmark gets a single subtle glint every ~9s instead of perpetual
	motion.  This component is therefore now a PURE presentational wrapper
	— no canvas element, no requestAnimationFrame, no IntersectionObserver,
	no physics, no script logic at all — which also drops a chunk of
	per-frame CPU (priority #4) and JS off every page.

	USAGE

	  - Homepage hero (centre):  <MorphitLogoBling heightClass="…" />
	    → no `shine` → a completely static wordmark, no effects.
	  - Header (top-left):       <MorphitLogoBling heightPx={32} shine />
	    → `shine` enabled → an occasional glint tracing the letters.

	THE SHINE (only rendered when `shine` is set)

	A single absolutely-positioned layer sits over the wordmark.  Its
	background is a narrow bright diagonal highlight band on an otherwise-
	transparent gradient; the layer is MASKED by the wordmark SVG itself
	(mask-image: <wordmark>), so the moving highlight is clipped to the
	letterforms — the glint "traces the shape of the paths" rather than
	sweeping a plain rectangle.  A keyframe parks the band off-screen for
	most of the ~9s cycle and sweeps it across exactly once, so the eye is
	drawn periodically without constant motion.

	BUDGET / ACCESSIBILITY (priorities #4 + #3 + #1)

	  - No canvas / RAF / observer.  The shine is pure CSS (an animated
	    background-position) and only mounts its one extra <span> when
	    `shine` is set; the hero pays nothing.
	  - The shine layer is aria-hidden="true" (decorative) and the wordmark
	    <img> keeps alt="Morphit", so screen-reader output is unchanged.
	  - `prefers-reduced-motion: reduce` removes the shine entirely (a plain
	    static wordmark) — serves vestibular-disorder accessibility and the
	    "no jittery motion on low-end devices" grandma-friendliness rule.
	  - Lives in the Svelte bundle; Vite fingerprints + emits an immutable
	    Cache-Control so it never re-fetches after first paint.
-->
<script lang="ts">
	interface Props {
		/** Path to the wordmark SVG (defaults to the bundled brand asset). */
		wordmarkSrc?: string;
		/** Display height of the wordmark in CSS pixels (Tailwind h-7 ≈ 28px). */
		heightPx?: number;
		/** Responsive height via Tailwind classes (e.g. "h-11 sm:h-16 lg:h-24").
		 *  When set, this WINS over heightPx so the wordmark scales across
		 *  breakpoints (used by the homepage hero). */
		heightClass?: string;
		/** Extra classes for the wrapping container. */
		class?: string;
		/** When true, overlay the occasional letterform-tracing shine (used by
		 *  the small header wordmark).  Default OFF → a fully static wordmark
		 *  with no effects (used by the homepage hero). */
		shine?: boolean;
	}

	const {
		wordmarkSrc = '/brand/morphit-wordmark.svg',
		heightPx = 28,
		heightClass = '',
		class: cls = '',
		shine = false
	}: Props = $props();
</script>

<div
	class={`morphit-logo-bling-host ${heightClass} ${cls}`}
	style={heightClass ? '' : `height: ${heightPx}px;`}
>
	<img
		src={wordmarkSrc}
		alt="Morphit"
		class={`morphit-logo-bling-wordmark ${heightClass}`}
		style={heightClass ? '' : `height: ${heightPx}px;`}
		decoding="async"
	/>
	{#if shine}
		<span
			class="morphit-logo-bling-shine"
			style={`--morphit-wordmark: url("${wordmarkSrc}");`}
			aria-hidden="true"
		></span>
	{/if}
</div>

<style>
	.morphit-logo-bling-host {
		position: relative;
		display: inline-block;
		line-height: 0;
	}
	.morphit-logo-bling-wordmark {
		position: relative;
		display: block;
		width: auto;
		z-index: 1;
	}
	/* The shine layer sits OVER the wordmark (z-index 2) but is MASKED to the
	 * wordmark's own shape, so the moving highlight only shows on the
	 * letterforms.  pointer-events:none so it never eats clicks on the
	 * wrapping <a>. */
	.morphit-logo-bling-shine {
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
		-webkit-mask-image: var(--morphit-wordmark);
		mask-image: var(--morphit-wordmark);
		-webkit-mask-size: contain;
		mask-size: contain;
		-webkit-mask-repeat: no-repeat;
		mask-repeat: no-repeat;
		-webkit-mask-position: center;
		mask-position: center;
		background-image: linear-gradient(
			105deg,
			transparent 42%,
			rgba(255, 255, 255, 0.7) 50%,
			transparent 58%
		);
		background-repeat: no-repeat;
		background-size: 250% 100%;
		background-position: -20% 0;
		animation: morphit-logo-bling-sweep 9s ease-in-out infinite;
	}
	/* Park the highlight off the RIGHT for most of the cycle (-20%), sweep it
	 * across once to off the LEFT (120%) over ~10%→24% of 9s (≈1.3s), then
	 * hold off-left until the loop restarts — at which point it jumps back to
	 * -20% while still off-screen, so only the single sweep is ever visible.
	 * (background-size 250%: -20% ≈ band off the right edge, 120% ≈ off the
	 * left edge, 50% ≈ band centred over the wordmark.) */
	@keyframes morphit-logo-bling-sweep {
		0% {
			background-position: -20% 0;
		}
		10% {
			background-position: -20% 0;
		}
		24% {
			background-position: 120% 0;
		}
		100% {
			background-position: 120% 0;
		}
	}
	/* Vestibular-disorder accessibility + low-end-device calm: no shine. */
	@media (prefers-reduced-motion: reduce) {
		.morphit-logo-bling-shine {
			animation: none;
			display: none;
		}
	}
</style>
