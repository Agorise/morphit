<script lang="ts">
	/**
	 * PartialStars — 0 to 5 gold stars, each full, two-thirds, one-third or empty
	 * (v1.23.0, the /witnesses page). The owner asked for the stars Morphit
	 * already shows, plus thirds; Morphit's stars are the ★ glyph, which cannot be
	 * part-filled, so this draws the same five-point shape as an SVG and clips the
	 * gold fill to the fraction. The outline stays visible on every star, so an
	 * empty one still reads as a star.
	 *
	 * Colour: gold (amber-400), as the owner asked for this page; it is not the
	 * emerald of the reputation ★ elsewhere, which marks something else.
	 */
	interface Props {
		/** 0..5, in thirds (what /v1/witnesses gives). */
		value: number;
		/** Pixel size of one star. */
		size?: number;
		/** Accessible label ("4⅔ of 5 stars"); the stars themselves are hidden. */
		label: string;
		/** Right-to-left text: a part-filled star fills from its right edge, next
		 *  to the full ones. The star is symmetric, so only the clip moves (no
		 *  mirroring transform: those are reserved for arrows, see
		 *  nav-arrow-consistency-smoke). */
		rtl?: boolean;
	}

	const { value, size = 15, label, rtl = false }: Props = $props();

	/** A five-point star in a 24×24 box. */
	const STAR =
		'M12 2.6l2.83 6.07 6.67.73-4.97 4.5 1.37 6.55L12 17.1l-5.9 3.35 1.37-6.55-4.97-4.5 6.67-.73z';
	/** A unique id per instance, so the clip paths of two rows never collide. */
	const uid = $props.id();

	const fills = $derived(
		[0, 1, 2, 3, 4].map((i) => Math.max(0, Math.min(1, (Number.isFinite(value) ? value : 0) - i)))
	);
</script>

<span class="inline-flex items-center gap-[2px] align-middle" role="img" aria-label={label}>
	{#each fills as f, i (i)}
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			{#if f > 0 && f < 1}
				<defs>
					<clipPath id="{uid}-{i}"
						><rect x={rtl ? 24 * (1 - f) : 0} y="0" width={24 * f} height="24" /></clipPath
					>
				</defs>
			{/if}
			<path
				d={STAR}
				fill="none"
				class="stroke-amber-400/60"
				stroke-width="1.6"
				stroke-linejoin="round"
			/>
			{#if f >= 1}
				<path
					d={STAR}
					class="fill-amber-400 stroke-amber-400"
					stroke-width="1.6"
					stroke-linejoin="round"
				/>
			{:else if f > 0}
				<path
					d={STAR}
					class="fill-amber-400 stroke-amber-400"
					stroke-width="1.6"
					stroke-linejoin="round"
					clip-path="url(#{uid}-{i})"
				/>
			{/if}
		</svg>
	{/each}
</span>
