<!--
	CoinCarousel — below-the-fold marquee of supported assets +
	settlement networks + the "barter" option.

	WHY THIS COMPONENT EXISTS (Part 122 cp115)

	The home page's prior "3 featured assets" block (BTC/XMR/BLURT
	hardcoded) didn't reflect Morphit's actual breadth and made
	disabled-by-operator coins invisible.  This carousel renders
	three concatenated sources:

	  1. The 16 tradable coin assets, from the canonical registry,
	     filtered against the operator's disabled-asset list.
	  2. 5 settlement-network indicators (Arbitrum, Base, BEP-20,
	     Polygon, TRC-20) so users searching for "what networks
	     does this support?" see the answer in-flight.  ERC-20 and
	     SPL are deliberately excluded — they're already implicitly
	     represented by ETH and SOL in the coin source.
	  3. A "Barter" slot reminding users Morphit isn't only for
	     crypto — direct goods/services trades work too.

	WHY LAZY-MOUNT + LAZY-LOAD (priorities #1 + #4)

	  - The carousel sits BELOW the fold on the home page.  A first
	    visitor who never scrolls past the hero should pay ZERO bytes
	    for it.  IntersectionObserver defers mounting until the
	    carousel approaches the viewport, then images are fetched
	    on-demand with `loading="lazy" decoding="async"` on every
	    <img>.
	  - The marquee animation uses CSS `transform: translateX()`
	    against a duplicated track.  Zero JS in the animation loop —
	    the browser compositor moves the layer.  Pauses for free on
	    `prefers-reduced-motion: reduce`.
	  - When the carousel scrolls OUT of viewport, the animation
	    continues but the GPU compositor doesn't repaint to the
	    screen, so the cost is near-zero.

	NO USER INTERACTION

	No hover-pause, no click-to-navigate, no manual scroll.  This is
	a purely-decorative motion accent.  Clicks could be added later
	if a real "browse by asset" page demands it.

	DEDUPE RULE

	Build a Set<string> of seen icon basenames across the FULL
	sequence (coin + network + barter).  Any future shared icon —
	e.g. if the BTC mainnet ever gets a "btc-network" indicator
	reusing icon-btc.svg — collapses to one carousel slot.  The
	rule is currently uncontested (no two sources share a basename
	with the Ken-specified network list) but stays as defensive
	insurance.

	ACCESSIBILITY

	  - aria-hidden="true" on the marquee track (decorative).
	  - A separate visually-hidden <ul> announces each slot via the
	    longer `screenReaderName` form ("Bitcoin (BTC)" rather than
	    just "BTC") so the breadth is communicated via text, not
	    motion.
	  - prefers-reduced-motion: reduce => static row, no animation.
-->

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { ASSETS } from '$lib/assets/registry';
	import { instance } from '$stores/instance';

	let containerEl: HTMLElement | null = $state(null);
	let mounted = $state(false);
	let io: IntersectionObserver | null = null;

	/** A single carousel slot.
	 *
	 *  - `key` is the dedupe + Svelte-each-block key; must be unique
	 *    per slot across the full sequence (asset + network + barter).
	 *  - `label` is the visible text under the icon — already in the
	 *    presentation form the carousel renders.  Coin tickers come
	 *    as uppercase ("BTC"); network labels in title-case
	 *    ("Polygon"); barter as the localized noun.
	 *  - `screenReaderName` is the longer form announced to screen
	 *    readers via the hidden <ul>.  E.g. "Bitcoin (BTC)" reads
	 *    better than "BTC" alone.
	 *  - `iconPath` is the public URL of the SVG/PNG file.
	 *  - `iconWidth/Height` are intrinsic dimensions so the browser
	 *    reserves the right box before image load and doesn't reflow
	 *    when each lazy-loaded file resolves. */
	interface CarouselSlot {
		key: string;
		label: string;
		screenReaderName: string;
		iconPath: string;
		iconWidth: number;
		iconHeight: number;
	}

	// The 5 networks Ken specifically wants in the carousel (not all
	// 7 — `erc20` and `spl` are excluded since they're already
	// implicitly represented by ETH and SOL assets in the coin half
	// of the carousel).  Order: alphabetical by display label so the
	// visible sequence reads cleanly.
	const NETWORK_SLOTS: ReadonlyArray<{ key: string; iconBasename: string; labelKey: string; srKey: string }> = [
		{ key: 'net-arbitrum', iconBasename: 'icon-network-arbitrum.svg', labelKey: 'arbitrum', srKey: 'arbitrum_sr' },
		{ key: 'net-base',     iconBasename: 'icon-network-base.svg',     labelKey: 'base',     srKey: 'base_sr' },
		{ key: 'net-bep20',    iconBasename: 'icon-network-bep20.svg',    labelKey: 'bep20',    srKey: 'bep20_sr' },
		{ key: 'net-polygon',  iconBasename: 'icon-network-polygon.svg',  labelKey: 'polygon',  srKey: 'polygon_sr' },
		{ key: 'net-trc20',    iconBasename: 'icon-network-trc20.svg',    labelKey: 'trc20',    srKey: 'trc20_sr' }
	];

	/** Build the carousel sequence:
	 *
	 *    [16 tradable assets, registry-driven, operator-disabled-filtered]
	 *  + [5 network indicators]
	 *  + [barter]
	 *
	 *  Dedupe by icon-file basename across the entire sequence so any
	 *  future shared icon (eg ETH coin and ERC-20 network reusing the
	 *  same SVG) collapses to a single slot.  Today the 5 networks
	 *  Ken listed do NOT include erc20 or spl, so no collisions
	 *  occur — but the dedupe stays as defensive insurance against
	 *  registry drift. */
	const visibleSlots = $derived.by(() => {
		const disabled = new Set(
			($instance?.disabled_assets ?? []).map((t) => t.toUpperCase())
		);
		const seenBasenames = new Set<string>();
		const out: CarouselSlot[] = [];

		// Source 1 — coin assets from the canonical registry.
		for (const a of ASSETS) {
			if (!a.canBeTraded) continue;
			if (disabled.has(a.displayTicker.toUpperCase())) continue;
			const basename = a.logoSvgPath.split('/').pop() ?? '';
			if (basename === '' || seenBasenames.has(basename)) continue;
			seenBasenames.add(basename);
			out.push({
				key: `coin-${a.displayTicker}`,
				label: a.displayTicker,
				screenReaderName: `${a.displayName} (${a.displayTicker})`,
				iconPath: a.logoSvgPath,
				iconWidth: 40,
				iconHeight: 40
			});
		}

		// Source 2 — network indicators.
		for (const n of NETWORK_SLOTS) {
			if (seenBasenames.has(n.iconBasename)) continue;
			seenBasenames.add(n.iconBasename);
			out.push({
				key: n.key,
				label: $_(`home.coin_carousel.networks.${n.labelKey}`),
				screenReaderName: $_(`home.coin_carousel.networks.${n.srKey}`),
				iconPath: `/icons/networks/${n.iconBasename}`,
				iconWidth: 40,
				iconHeight: 40
			});
		}

		// Source 3 — barter (raster PNG; explicit dimensions so the
		// browser reserves the box before the lazy load resolves).
		if (!seenBasenames.has('icon-barter.svg')) {
			seenBasenames.add('icon-barter.svg');
			out.push({
				key: 'barter',
				label: $_('home.coin_carousel.barter.label'),
				screenReaderName: $_('home.coin_carousel.barter.sr'),
				iconPath: '/icons/icon-barter.svg',
				iconWidth: 40,
				iconHeight: 40
			});
		}

		return out;
	});

	/** Split visibleSlots ~50/50 into two rows by alternating
	 *  even-index → rowA and odd-index → rowB.
	 *
	 *  Why this strategy: the registry order today is BTC, XMR,
	 *  BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR,
	 *  SOL, ETH, XRP, [5 networks], barter.  Alternating means each
	 *  row sees a mixed-character set instead of one row of "the
	 *  important originals" + another of "the latest additions";
	 *  visually pleasant + every row stays representative as the
	 *  registry grows.  As long as the total count remains evenish,
	 *  the rows stay balanced ±1.
	 *
	 *  Today: 22 slots → rowA has 11, rowB has 11.  When a 23rd asset
	 *  lands rowA gets 12 and rowB stays 11; still balanced.
	 */
	const rowA = $derived(visibleSlots.filter((_, i) => i % 2 === 0));
	const rowB = $derived(visibleSlots.filter((_, i) => i % 2 === 1));

	onMount(() => {
		if (typeof window === 'undefined' || !containerEl) return;
		io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						mounted = true;
						// Once mounted, no need to keep observing — keep the
						// component live so reduced-motion + visibility-pause
						// behaviors can take over.
						io?.disconnect();
						io = null;
					}
				}
			},
			// Mount slightly BEFORE the carousel hits the viewport so the
			// first frame of motion isn't paint-blocked by image decode.
			{ rootMargin: '200px 0px', threshold: 0.01 }
		);
		io.observe(containerEl);
	});

	onDestroy(() => {
		io?.disconnect();
		io = null;
	});
</script>

<!--
	dir="ltr" is FORCED here regardless of the document direction.
	The marquee uses physical `transform: translateX()` keyframes
	(and the left/right edge-fade gradients are physically placed),
	but a `dir="rtl"` ancestor — set on <html> for the Farsi locale
	in hooks.client.ts + app.html — does NOT flip CSS transforms, so
	under RTL the track and its edge fades misalign.  The carousel's
	content (coin icons + uppercase tickers + network names) is
	language-neutral, so pinning it LTR is correct in every locale
	and keeps the animation geometry consistent (beta11 item 6).
-->
<section
	bind:this={containerEl}
	class="coin-carousel"
	dir="ltr"
	aria-label={$_('home.coin_carousel.aria_label')}
>
	<!-- Screen-reader-only enumeration of slots.  Conveys the
	     breadth without relying on the visual marquee. -->
	<ul class="sr-only">
		{#each visibleSlots as slot (slot.key)}
			<li>{slot.screenReaderName}</li>
		{/each}
	</ul>

	<div class="coin-carousel-edge-fade-left" aria-hidden="true"></div>
	<div class="coin-carousel-edge-fade-right" aria-hidden="true"></div>

	{#if mounted}
		<!-- Two marquee tracks, scrolling in opposite directions.
		     Each track is its own row at ~50% the slot count of the
		     full set.  Both tracks duplicate their content so the
		     CSS animation can scroll 0 → -50% (or -50% → 0 for the
		     reverse-direction track) and seamlessly loop. -->
		<div class="coin-carousel-track coin-carousel-track-a" aria-hidden="true">
			{#each [0, 1] as copy (copy)}
				<div class="coin-carousel-row">
					{#each rowA as slot (`a-${copy}-${slot.key}`)}
						<div class="coin-carousel-item">
							<img
								src={slot.iconPath}
								alt=""
								loading="lazy"
								decoding="async"
								width={slot.iconWidth}
								height={slot.iconHeight}
							/>
							<span class="coin-carousel-label">{slot.label}</span>
						</div>
					{/each}
				</div>
			{/each}
		</div>
		<div class="coin-carousel-track coin-carousel-track-b" aria-hidden="true">
			{#each [0, 1] as copy (copy)}
				<div class="coin-carousel-row">
					{#each rowB as slot (`b-${copy}-${slot.key}`)}
						<div class="coin-carousel-item">
							<img
								src={slot.iconPath}
								alt=""
								loading="lazy"
								decoding="async"
								width={slot.iconWidth}
								height={slot.iconHeight}
							/>
							<span class="coin-carousel-label">{slot.label}</span>
						</div>
					{/each}
				</div>
			{/each}
		</div>
	{:else}
		<!-- Pre-mount placeholder.  Reserves vertical space so the
		     page doesn't reflow when the carousel mounts. -->
		<div class="coin-carousel-placeholder" aria-hidden="true"></div>
	{/if}
</section>

<style>
	.coin-carousel {
		position: relative;
		overflow: hidden;
		/* cp115-cp6: two rows scrolling opposite directions.  Each row
		 * is 80px (40px icon + 14px label + 20px padding rounded up to
		 * 80 for breathing room); two rows = 160px total.  As the
		 * carousel grows past 22 slots, additional slots remain
		 * distributed across the two rows (even-index → rowA, odd →
		 * rowB) so the heights never need to change. */
		height: 160px;
		margin-top: 2rem;
		margin-bottom: 2rem;
		/* Stack the two tracks vertically with no gap — the per-row
		 * padding handles spacing. */
		display: flex;
		flex-direction: column;
	}

	.coin-carousel-edge-fade-left,
	.coin-carousel-edge-fade-right {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 64px;
		z-index: 2;
		pointer-events: none;
	}
	.coin-carousel-edge-fade-left {
		left: 0;
		background: linear-gradient(to right, var(--carousel-bg, transparent), transparent);
	}
	.coin-carousel-edge-fade-right {
		right: 0;
		background: linear-gradient(to left, var(--carousel-bg, transparent), transparent);
	}

	.coin-carousel-placeholder {
		height: 100%;
	}

	.coin-carousel-track {
		display: flex;
		width: max-content;
		/* Each row gets equal vertical share (50% of the 160px host). */
		height: 80px;
		animation: coin-carousel-scroll 60s linear infinite;
	}
	/* Row A scrolls left-to-right (default direction). */
	.coin-carousel-track-a {
		animation-direction: normal;
	}
	/* Row B scrolls right-to-left.  Reverses the same keyframes so
	 * the duplicated-track loop trick still works (track is twice as
	 * wide; reverse goes -50% → 0). */
	.coin-carousel-track-b {
		animation-direction: reverse;
	}

	.coin-carousel-row {
		display: flex;
		gap: 2.5rem;
		padding: 0 1.25rem;
		align-items: center;
	}

	.coin-carousel-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		/* Tight enough to fit ~22 items in a desktop hero width, wide
		 * enough to render "Arbitrum" and "Polygon" without ellipsis.
		 * Coin tickers (3-5 chars) sit centered within the same width
		 * for consistent rhythm.
		 *
		 * cp115-cp6: opacity 0.85 dims the carousel slightly so it sits
		 * as a decorative ribbon under the bolder priorities-cards above
		 * rather than competing for attention.  Icon ARTWORK is shipped
		 * full-color (Ken's rule cp115-cp4 "don't modify them"); this
		 * 0.85 is uniform per-item alpha applied at the stacking level,
		 * not a color modification.  The I-10 smoke pins this exact
		 * value so future drift gets caught. */
		min-width: 80px;
		opacity: 0.85;
	}

	.coin-carousel-item img {
		width: 40px;
		height: 40px;
		display: block;
	}

	.coin-carousel-label {
		font-size: 0.75rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		color: var(--carousel-text, rgb(100 116 139));
		/* Long network labels ("Arbitrum", "Polygon") will overrun a
		 * 64px min-width column on small screens; clamp + ellipsis
		 * keeps the row alignment honest without truncating mid-word
		 * for the short coin tickers. */
		max-width: 96px;
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	@keyframes coin-carousel-scroll {
		from {
			transform: translateX(0);
		}
		to {
			/* Translate exactly half the track width: the second copy
			 * of the row slides into the position the first copy
			 * vacated, creating a seamless infinite loop. */
			transform: translateX(-50%);
		}
	}

	/* Accessibility — both vestibular-disorder users (priority #3
	 * grandma-friendliness) and Tor-Browser-safest-mode get a
	 * static row. */
	@media (prefers-reduced-motion: reduce) {
		.coin-carousel-track {
			animation: none;
		}
	}

	/* Visually-hidden helper for the screen-reader enumeration. */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
