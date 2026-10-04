<!--
	MorphitLogoBling — the site logo (the Morphit wordmark, or the operator's own
	logo on a re-branded instance — docs/BRANDING.md), with an OPTIONAL
	occasional "shine" that sweeps along the logo's shapes to draw the eye.

	HISTORY / WHY THIS IS NOW STATIC

	Earlier builds rendered a canvas element behind the wordmark running a
	slow 3-body particle dance (mutual spring + centroid gravity).  The maintainer retired
	that perpetual canvas motion.  The remaining effect is a single subtle
	glint every ~15s that traces the letterforms.  UPDATE: that glint
	(`shine`) is now enabled EVERYWHERE the wordmark appears — the top-left
	header, the homepage hero, AND the footer — at the request (earlier the
	hero/footer were static).  This component is therefore a PURE presentational
	wrapper
	— no canvas element, no requestAnimationFrame, no IntersectionObserver,
	no physics, no script logic at all — which also drops a chunk of
	per-frame CPU (priority #4) and JS off every page.

	USAGE

	  - Homepage hero (centre):  <MorphitLogoBling heightClass="…" shine />
	  - Header (top-left):       <MorphitLogoBling heightPx={32} shine />
	  - Footer (centre):         <MorphitLogoBling heightPx={40} variant="footer" shine />
	    → all three use the same `shine` glint with NO extra effects. Header +
	      hero show /brand/site-logo.svg; the footer shows
	      /brand/site-logo-footer.svg (identical on a canonical build; an
	      operator may give the footer its own wordmark).  (the footer's
	      former `animate-morphit-hue-shift` was dropped so the footer matches
	      the header exactly, at the request.  Only the display height
	      differs.)  Omitting `shine` still yields a fully static wordmark for
	      any future placement that wants one.

	THE SHINE (only rendered when `shine` is set)

	A single absolutely-positioned layer sits over the wordmark.  Its
	background is a narrow bright diagonal highlight band on an otherwise-
	transparent gradient; the layer is MASKED by the wordmark SVG itself
	(mask-image: <wordmark>), so the moving highlight is clipped to the
	letterforms — the glint "traces the shape of the paths" rather than
	sweeping a plain rectangle.  A keyframe parks the band off-screen for
	most of the ~15s cycle and sweeps it across exactly once, so the eye is
	drawn periodically without constant motion.

	BUDGET / ACCESSIBILITY (priorities #4 + #3 + #1)

	  - No canvas / RAF / observer.  The shine is pure CSS (a band slid
	    with transform, which the GPU composites — v1.20.2) and only mounts
	    its two extra <span>s when `shine` is set.
	  - The shine layer is aria-hidden="true" (decorative) and the logo <img>
	    carries alt=<the site's brand name>, so screen-reader output names the
	    site the visitor is on.
	  - `prefers-reduced-motion: reduce` removes the shine entirely (a plain
	    static wordmark) — serves vestibular-disorder accessibility and the
	    "no jittery motion on low-end devices" grandma-friendliness rule.
	  - The logo is ONE cached file per placement: every instance on a page (and
	    the shine mask, which points at the same URL) reuses the browser's copy.
	    It is no longer a fingerprinted import (an operator must be able to
	    replace it in place); the service worker serves it
	    stale-while-revalidate, so repeat visits cost no extra round trip.
-->
<script lang="ts">
	// Per-instance branding (docs/BRANDING.md). The logo is served from STABLE,
	// un-fingerprinted paths so an operator can replace it without rebuilding
	// the frontend (a local rebuild is not byte-reproducible and would trip the
	// on-chain build-integrity banner): `morphit-ops branding apply` overwrites
	// these two files in the served build, and nothing else. A canonical build
	// ships the Morphit wordmark at both paths.
	//   /brand/site-logo.svg         header (top-left) + homepage hero
	//   /brand/site-logo-footer.svg  footer
	// (These used to be one Vite-imported, fingerprinted asset — that import is
	// why a file swap could never give the footer its own logo. The service
	// worker serves both stale-while-revalidate, so a re-branded logo shows up
	// on the visitor's next load; see isBrandOverridablePath.)
	import { brandName } from '$lib/brand/brand';

	const SITE_LOGO_PATH = '/brand/site-logo.svg';
	const SITE_LOGO_FOOTER_PATH = '/brand/site-logo-footer.svg';

	interface Props {
		/** Which operator-overridable logo to show: `main` (header + hero) or
		 *  `footer`. Ignored when `wordmarkSrc` is given. */
		variant?: 'main' | 'footer';
		/** Explicit logo URL (overrides `variant`). */
		wordmarkSrc?: string;
		/** Display height of the logo in CSS pixels (Tailwind h-7 ≈ 28px). The
		 *  width follows the SVG's own aspect ratio (never stretched), so a
		 *  replacement logo fills the same height as the Morphit wordmark did. */
		heightPx?: number;
		/** Responsive height via Tailwind classes (e.g. "h-11 sm:h-16 lg:h-24").
		 *  When set, this WINS over heightPx so the logo scales across
		 *  breakpoints (used by the homepage hero). */
		heightClass?: string;
		/** Extra classes for the wrapping container. */
		class?: string;
		/** When true, overlay the occasional shape-tracing shine. Default OFF →
		 *  a fully static logo with no effects. */
		shine?: boolean;
		/** v1.20.2 — the logo is the first thing above the fold (header on
		 *  every page, hero on the homepage): fetch it ahead of other images
		 *  (fetchpriority="high"). The footer leaves this off and loads lazily. */
		priority?: boolean;
	}

	const {
		variant = 'main',
		wordmarkSrc,
		heightPx = 28,
		heightClass = '',
		class: cls = '',
		shine = false,
		priority = false
	}: Props = $props();

	// v1.20.2 — the Morphit wordmark's own proportions (viewBox 0 0 4306 739).
	// Given as width/height attributes so the browser reserves the logo's box
	// BEFORE the SVG arrives (no layout shift). CSS keeps width:auto, so once a
	// file loads its own proportions win — an operator's differently shaped
	// logo is never stretched (it can only shift once, as before).
	// crossorigin (same-origin logos only): the shine's mask-image is always
	// fetched in CORS mode, a plain <img> is not, so each logo used to be
	// downloaded — or, being no-cache, revalidated — twice. In the same mode
	// (and with app.html's matching preload) one download serves both.
	const LOGO_W = 4306;
	const LOGO_H = 739;
	const attrHeight = $derived(heightClass ? LOGO_H : heightPx);
	const attrWidth = $derived(heightClass ? LOGO_W : Math.round((heightPx * LOGO_W) / LOGO_H));

	const logoSrc = $derived(
		wordmarkSrc ?? (variant === 'footer' ? SITE_LOGO_FOOTER_PATH : SITE_LOGO_PATH)
	);

	// TEMPORARY beta marker. Small red "BETA" overlaid in the
	// bottom-right corner of the logo, everywhere it appears (header, footer,
	// hero). Sized relative to the logo so it stays proportional at every
	// placement. Per-instance: an operator turns it off with
	// MORPHIT_INSTANCE_BETA_BADGE=off (and it is off by default once they supply
	// their own logo) — `morphit-ops branding apply` stamps
	// <html data-brand-beta="off">, and a CSS rule below hides the marker, so it
	// never flashes on first paint. Remove this (the `beta` span + its style +
	// this size) at the stable public launch.
	const betaFontStyle = $derived(
		heightClass
			? // Responsive hero: scale with the viewport, roughly tracking the
				// wordmark's breakpoint sizes (h-11 → h-24).
				'font-size: clamp(0.6rem, 2vw, 1.4rem);'
			: `font-size: ${Math.max(7, Math.round(heightPx * 0.3))}px;`
	);
</script>

<div
	class={`morphit-logo-bling-host ${heightClass} ${cls}`}
	style={heightClass ? '' : `height: ${heightPx}px;`}
>
	<img
		src={logoSrc}
		alt={$brandName}
		class={`morphit-logo-bling-wordmark ${heightClass}`}
		style={heightClass ? 'max-width: 90vw;' : `height: ${heightPx}px;`}
		width={attrWidth}
		height={attrHeight}
		fetchpriority={priority ? 'high' : undefined}
		crossorigin={logoSrc.startsWith('/') ? 'anonymous' : undefined}
		loading={variant === 'footer' && !priority ? 'lazy' : undefined}
		decoding="async"
	/>
	{#if shine}
		<span
			class="morphit-logo-bling-shine"
			style={`--morphit-wordmark: url("${logoSrc}");`}
			aria-hidden="true"><span class="morphit-logo-bling-band"></span></span
		>
	{/if}
	<!-- TEMPORARY beta marker (remove at stable public launch). -->
	<span class="morphit-logo-bling-beta" style={betaFontStyle} aria-hidden="true">BETA</span>
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
		/* An operator's logo (docs/BRANDING.md) can be much wider than the
		 * Morphit wordmark at the same height; never let it push the header
		 * off a phone screen. contain keeps its proportions (and the sheen's
		 * mask-size: contain stays aligned with it). The Morphit wordmark
		 * (~5.8:1) is well inside these caps. */
		max-width: 60vw;
		object-fit: contain;
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
		overflow: hidden;
	}
	/* v1.20.2 — the moving highlight band. It used to be the shine layer's own
	 * background, swept by animating background-position, which repaints on
	 * the main thread every frame (PageSpeed: "non-composited animation", ×3 —
	 * header, hero, footer). Now the band is a child the GPU slides with
	 * transform; the mask on the parent still clips it to the letterforms.
	 * Same look: the band is 250% of the logo's width (as the old
	 * background-size was), so the old positions map exactly —
	 * background-position -20% ≡ translateX(12%), 120% ≡ translateX(-72%). */
	.morphit-logo-bling-band {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 250%;
		background-image: linear-gradient(
			105deg,
			transparent 36%,
			rgba(255, 255, 255, 0.6) 45%,
			rgba(255, 255, 255, 0.97) 50%,
			rgba(255, 255, 255, 0.6) 55%,
			transparent 64%
		);
		transform: translateX(12%);
		animation: morphit-logo-bling-sweep 15s ease-in-out infinite;
	}
	/* Park the highlight off the RIGHT for most of the cycle (-20%), sweep it
	 * across once to off the LEFT (120%) over 10%→20% of 15s (=1.5s — a touch
	 * slower than before so the eye has a moment to register the glint), then
	 * hold off-left until the loop restarts — at which point it jumps back to
	 * -20% while still off-screen, so only the single sweep is ever visible.
	 * (Band 250% wide: translateX(12%) ≈ band off the right edge, -72% ≈ off
	 * the left edge, -30% ≈ band centred over the wordmark.) */
	@keyframes morphit-logo-bling-sweep {
		0% {
			transform: translateX(12%);
		}
		10% {
			transform: translateX(12%);
		}
		20% {
			transform: translateX(-72%);
		}
		100% {
			transform: translateX(-72%);
		}
	}
	/* Vestibular-disorder accessibility + low-end-device calm: no shine. */
	@media (prefers-reduced-motion: reduce) {
		.morphit-logo-bling-shine,
		.morphit-logo-bling-band {
			animation: none;
			display: none;
		}
	}
	/* Per-instance: hidden when the operator turned the marker off (see the
	 * script block). The attribute is on <html>, outside this component. */
	:global(html[data-brand-beta='off']) .morphit-logo-bling-beta {
		display: none;
	}
	/* TEMPORARY beta marker. Small red "BETA" pinned to the wordmark's
	 * bottom-right corner. z-index 3 so it sits above the wordmark (1) and the
	 * shine (2); pointer-events:none so it never eats clicks on the wrapping
	 * <a>. Line-height 1 keeps it tight in the corner. Remove at stable
	 * public launch. */
	.morphit-logo-bling-beta {
		position: absolute;
		right: 0;
		bottom: 0;
		z-index: 3;
		pointer-events: none;
		font-weight: 800;
		line-height: 1;
		letter-spacing: 0.04em;
		color: #dc2626;
		text-shadow:
			0 0 2px rgba(255, 255, 255, 0.7),
			0 1px 1px rgba(255, 255, 255, 0.5);
	}
	:global(.dark) .morphit-logo-bling-beta {
		color: #f87171;
		text-shadow:
			0 0 2px rgba(0, 0, 0, 0.6),
			0 1px 1px rgba(0, 0, 0, 0.4);
	}
</style>
