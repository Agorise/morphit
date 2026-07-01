<script lang="ts">
	/**
	 * FeaturedAuctionHistory — renders the daily clearing-price
	 * history for the featured-slot auction.
	 *
	 * Self-fetches /v1/orderbook/featured/clearing-price-history
	 * on mount and on the 5-minute backend cache window.  Used
	 * in two places:
	 *   - Below the live FeaturedOrders panel on /orderbook —
	 *     "is the auction competitive right now?"
	 *   - As an upsell context next to the FeatureBidForm —
	 *     "here's what bids have cleared for"
	 *
	 * Window selector: 7 / 30 / 90 days.  Defaults to 30.
	 *
	 * Visualization: SVG bar chart, no external library.  Each
	 * day is one bar; bar height encodes clearing_blurt_per_hour;
	 * bar color encodes whether the day was full (5/5 visible
	 * slots = saturated) or under-filled (faded — clearing price
	 * is 0 / "anyone wins").  The under-filled state is the most
	 * common case in early days, so it's the default visual.
	 *
	 * Empty / failed states render nothing rather than an error
	 * card — this is informational, not load-bearing.
	 */

	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { getClearingPriceHistory } from '$lib/indexer/client';
	import type { ClearingPricePoint } from '@morphit/indexer-client';

	type WindowDays = 7 | 30 | 90;

	let windowDays = $state<WindowDays>(30);
	let points = $state<readonly ClearingPricePoint[]>([]);
	let loaded = $state(false);
	let abortController: AbortController | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	const POLL_MS = 5 * 60 * 1000; // matches backend cache-control max-age=300

	async function refresh(): Promise<void> {
		// Cancel any in-flight request from a previous window
		// switch — the user may have flipped 7→90 fast.
		abortController?.abort();
		abortController = new AbortController();
		try {
			const result = await getClearingPriceHistory({
				window: windowDays,
				signal: abortController.signal
			});
			if (result.ok) {
				points = result.data.points;
			}
			loaded = true;
		} catch {
			// Aborted or network error.  Render nothing.  This is
			// an advertising surface; broken fetches shouldn't
			// leave an angry red box on the orderbook page.
			loaded = true;
		}
	}

	onMount(() => {
		refresh();
		pollTimer = setInterval(refresh, POLL_MS);
	});

	onDestroy(() => {
		abortController?.abort();
		if (pollTimer !== null) clearInterval(pollTimer);
	});

	function selectWindow(w: WindowDays): void {
		if (w === windowDays) return;
		windowDays = w;
		// Clear stale points so the chart doesn't flash old data
		// at the new x-axis scale.
		points = [];
		loaded = false;
		refresh();
	}

	// ─── Derived chart data ───────────────────────────────────

	/** Maximum clearing price across visible points; sets the
	 *  bar-height scale.  When all points are 0 (under-filled
	 *  every day), the chart renders flat-grey "no competitive
	 *  pressure yet" rather than a tall bar of nothing. */
	const maxClearing = $derived.by((): number => {
		let max = 0;
		for (const p of points) {
			if (p.clearing_blurt_per_hour > max) max = p.clearing_blurt_per_hour;
		}
		return max;
	});

	/** Whether the chart has ANY non-zero clearing price.  When
	 *  false we render a placeholder note instead of bars. */
	const hasAnyClearing = $derived.by((): boolean => {
		for (const p of points) {
			if (p.clearing_blurt_per_hour > 0) return true;
		}
		return false;
	});

	/** Most recent point (today's clearing price).  Used in the
	 *  one-line summary above the chart. */
	const latest = $derived.by((): ClearingPricePoint | null => {
		if (points.length === 0) return null;
		return points[points.length - 1] ?? null;
	});

	function formatBlurtPerHour(n: number): string {
		if (n === 0) return '0';
		if (n >= 100) return n.toFixed(0);
		if (n >= 10) return n.toFixed(1);
		return n.toFixed(2);
	}
</script>

{#if loaded && points.length > 0}
	<section class="card mb-4" aria-labelledby="clearing-price-heading">
		<div class="mb-3 flex items-center justify-between gap-2">
			<h2 id="clearing-price-heading" class="font-display text-base font-bold">
				{$_('clearing_price.heading')}
			</h2>
			<div class="flex gap-1 rounded-lg bg-ink-100 p-1 dark:bg-ink-800">
				{#each [7, 30, 90] as w (w)}
					<button
						type="button"
						class="rounded-md px-2 py-1 text-xs font-semibold transition-colors {windowDays === w
							? 'bg-white text-morphit-emerald shadow-sm dark:bg-ink-700'
							: 'text-ink-500 hover:text-ink-700 dark:text-ink-400 dark:hover:text-ink-200'}"
						onclick={() => selectWindow(w as WindowDays)}
						aria-pressed={windowDays === w}
					>
						{$_('clearing_price.window_label', { values: { days: w } })}
					</button>
				{/each}
			</div>
		</div>

		{#if latest !== null && (latest.clearing_blurt_per_hour > 0 || latest.active_visible_count > 0)}
			<p class="mb-3 text-sm text-ink-600 dark:text-ink-300">
				{#if latest.clearing_blurt_per_hour > 0}
					{$_('clearing_price.summary_competitive', {
						values: {
							rate: formatBlurtPerHour(latest.clearing_blurt_per_hour),
							slots: latest.active_visible_count,
							max: latest.max_slots
						}
					})}
				{:else}
					{$_('clearing_price.summary_partial', {
						values: {
							slots: latest.active_visible_count,
							max: latest.max_slots
						}
					})}
				{/if}
			</p>
		{/if}

		{#if hasAnyClearing && maxClearing > 0}
			<!-- SVG bar chart.  viewBox-relative; scales with
			     parent width.  Width is points.length * (bar+gap).
			     Height fixed at 80; bars start from the bottom. -->
			<div
				class="overflow-x-auto"
				role="img"
				aria-label={$_('clearing_price.chart_aria', {
					values: { days: windowDays }
				}) as string}
			>
				<svg
					viewBox="0 0 {Math.max(points.length * 6, 100)} 100"
					preserveAspectRatio="none"
					class="h-20 w-full"
				>
					{#each points as p, i (p.day)}
						{@const isFull = p.active_visible_count >= p.max_slots}
						{@const isPartial = p.active_visible_count > 0 && p.active_visible_count < p.max_slots}
						{@const barHeight =
							p.clearing_blurt_per_hour > 0
								? Math.max(2, (p.clearing_blurt_per_hour / maxClearing) * 80)
								: 2}
						<rect
							x={i * 6}
							y={90 - barHeight}
							width="5"
							height={barHeight}
							class={isFull
								? 'fill-morphit-emerald'
								: isPartial
									? 'fill-morphit-emerald/50'
									: 'fill-ink-300 dark:fill-ink-600'}
						>
							<title
								>{p.day}: {formatBlurtPerHour(p.clearing_blurt_per_hour)} BLURT/hr · {p.active_visible_count}/{p.max_slots}
								slots filled</title
							>
						</rect>
					{/each}
				</svg>
			</div>
			<div class="mt-1 flex items-center justify-between text-xs text-ink-500 dark:text-ink-400">
				<span>{points[0]?.day ?? ''}</span>
				<span>{points[points.length - 1]?.day ?? ''}</span>
			</div>
			<p class="mt-2 text-xs text-ink-500 dark:text-ink-400">
				{$_('clearing_price.legend')}
			</p>
		{:else}
			<div class="rounded-lg bg-ink-50 p-3 text-sm text-ink-600 dark:bg-ink-800 dark:text-ink-300">
				{$_('clearing_price.no_history_yet', {
					values: { days: windowDays }
				})}
			</div>
		{/if}
	</section>
{/if}
