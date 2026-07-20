<script lang="ts">
	/**
	 * AltNetworkIcon — displays each network's authentic brand
	 * artwork for the networks Morphit is reachable via (Tor,
	 * Lokinet, I2P, Nostr, Blurt, ENS).
	 *
	 * Design decisions:
	 *
	 * 1. Icons are served as <img src="/icons/icon-{n}.svg">
	 *    from `apps/web/static/icons/`. This means the original
	 *    official SVG files ship unmodified — no inline-path
	 *    rewrites, no currentColor flattening, no risk of our
	 *    code distorting the brand artwork. Each network's
	 *    authentic colors render as the brand intends.
	 *
	 * 2. Default rendering is grayscale with slightly reduced
	 *    opacity, so an array of these in the footer reads as
	 *    calm "ambient" context rather than a distracting rainbow.
	 *
	 * 3. On hover or keyboard focus, the grayscale filter lifts
	 *    and the icon returns to full brand color at full opacity.
	 *    Gives users a rewarding interaction and surfaces the
	 *    authentic mark on intent.
	 *
	 * 4. Respects `prefers-reduced-motion` by shortening the
	 *    transition to near-instant for users who've asked for
	 *    reduced animation.
	 *
	 * 5. LOADING IS DEFERRED UNTIL THE ICON IS ACTUALLY VISIBLE
	 *    (cp388). These icons live in the footer / below-the-fold
	 *    panels; the native `loading="lazy"` hint has a generous
	 *    fetch distance on fast connections, so on a short page the
	 *    browser pulls them down on first paint anyway — wasting
	 *    bytes on artwork the user hasn't scrolled to (priority #4:
	 *    tiny footprint; "don't load what wasn't requested"). An
	 *    IntersectionObserver assigns `src` only once the wrapper
	 *    scrolls within 200px of the viewport, then disconnects.
	 *    A `<noscript>` fallback keeps the icon working for no-JS
	 *    visitors via the native lazy attribute. The text label
	 *    that always sits beside the chip means the icon is purely
	 *    decorative, so the JS-gated path never costs information.
	 *
	 * The files themselves live in `apps/web/static/icons/` and
	 * are referenced by absolute path so any call site inherits
	 * the same visual regardless of route depth.
	 */
	import { _ } from 'svelte-i18n';
	import { onMount, onDestroy } from 'svelte';

	interface Props {
		network: 'tor' | 'lokinet' | 'i2p' | 'nostr' | 'blurt' | 'ens' | 'globe' | 'play';
		/** Pixel size. Defaults to 24. */
		size?: number;
		/** Extra CSS classes on the wrapper for alignment overrides. */
		class?: string;
	}

	let { network, size = 24, class: cls = '' }: Props = $props();

	// Aria label key per network — used on the <img> alt for the
	// rare cases this icon renders without an adjacent text label.
	// In the footer/homepage contexts the chip text sits next to
	// the icon so the alt is largely redundant there, but it
	// doesn't hurt to have a real label for screen reader users
	// navigating by image.
	const ariaKey = $derived(`footer.${network}`);
	const iconSrc = $derived(`/icons/icon-${network}.svg`);

	// Deferred-load gate. Stays false through SSR and on first
	// client paint, so no `src` ships in the initial HTML and the
	// browser has nothing to fetch eagerly. Flipped true only when
	// the wrapper scrolls into view (or right away if the browser
	// lacks IntersectionObserver — graceful degradation).
	let wrapperEl = $state<HTMLSpanElement | undefined>(undefined);
	let shown = $state(false);
	let io: IntersectionObserver | null = null;

	onMount(() => {
		if (typeof IntersectionObserver === 'undefined') {
			// No IO support → just load it; correctness over thrift.
			shown = true;
			return;
		}
		io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						shown = true;
						io?.disconnect();
						io = null;
						break;
					}
				}
			},
			{ rootMargin: '200px 0px', threshold: 0.01 }
		);
		if (wrapperEl) io.observe(wrapperEl);
	});

	onDestroy(() => {
		io?.disconnect();
		io = null;
	});
</script>

<span
	class="alt-network-icon {cls}"
	style="width: {size}px; height: {size}px;"
	bind:this={wrapperEl}
>
	{#if shown}
		<img
			src={iconSrc}
			alt={$_(ariaKey)}
			width={size}
			height={size}
			draggable="false"
			decoding="async"
		/>
	{/if}
	<!-- No-JS fallback: the IntersectionObserver gate above never
	     runs without scripting, so render the icon directly (native
	     lazy) for those visitors. Browsers with JS enabled ignore
	     noscript content, so there is no double fetch. -->
	<noscript>
		<img
			src={iconSrc}
			alt={$_(ariaKey)}
			width={size}
			height={size}
			draggable="false"
			loading="lazy"
			decoding="async"
		/>
	</noscript>
</span>

<style>
	/* Wrapper so the hover state lifts grayscale on the image
	   inside, regardless of whether the consumer wraps the whole
	   chip in a link/button (standard case) or not. The parent
	   anchor's :hover is what actually fires, which is why the
	   :hover rule is on the wrapper, not the <img>. */
	.alt-network-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		line-height: 0;
	}
	.alt-network-icon img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		filter: grayscale(100%);
		opacity: 0.72;
		transition:
			filter 180ms ease-out,
			opacity 180ms ease-out;
	}
	/* Lift grayscale on:
	   - hover of the wrapper itself (homepage four-networks grid where
	     icons are standalone)
	   - hover of the enclosing clickable chip/link (footer case)
	   - keyboard focus on the enclosing chip/link (a11y parity with mouse) */
	.alt-network-icon:hover img,
	:global(.chip:hover) .alt-network-icon img,
	:global(.chip:focus-visible) .alt-network-icon img,
	:global(a:hover) .alt-network-icon img,
	:global(a:focus-visible) .alt-network-icon img,
	:global(button:hover) .alt-network-icon img,
	:global(button:focus-visible) .alt-network-icon img {
		filter: none;
		opacity: 1;
	}
	@media (prefers-reduced-motion: reduce) {
		.alt-network-icon img {
			transition-duration: 1ms;
		}
	}
</style>
