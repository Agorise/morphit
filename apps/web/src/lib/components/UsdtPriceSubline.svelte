<!--
	UsdtPriceSubline — renders a small live-price line under a
	USDT order row.  Format:

		1 USDT = $1.00 live

	When the price feed is stale or unavailable, falls back to:

		USDT/USD price feed unavailable — last seen 12m ago.

	Why this exists (Ken's design Q9e, 2026-05-13): USDT pegs to
	USD by design, but pegs break (2018, 2022 incidents).  When
	the peg dips to $0.97 or $0.94, a "1000 USDT" order's
	USD-value displayed in the order row becomes a lie unless we
	surface the actual peg state.  The subline lets traders see
	WHEN the peg is off, not just assume it's always $1.00.

	Pulls from the existing $lib/prices store (Coingecko on the
	live path, fallback static-1.00 when offline).  Refreshes on
	mount and every CACHE_TTL_MS via the store's existing
	caching layer.

	Render-only — no state of its own.  Subscribes to priceStore
	and re-renders when USDT.fetchedAt changes.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { getPrice, priceStore } from '$lib/prices';

	interface Props {
		/** Render the subline as compact (single-line, no border)
		 *  or as a small bordered chip.  Compact is the
		 *  orderbook-row default; the bordered variant fits the
		 *  order-detail page. */
		compact?: boolean;
	}

	let { compact = true }: Props = $props();

	let fetchFailed = $state(false);

	onMount(() => {
		// Kick the price store to populate.  Errors are swallowed
		// (the staleness fallback covers them); we don't want a
		// missed CG fetch to break the row render.
		getPrice('USDT').catch(() => {
			fetchFailed = true;
		});
	});

	// Reactive read from the price store.
	const usdtQuote = $derived($priceStore.USDT);

	// Staleness: prices older than 5 minutes are presented as
	// "feed unavailable, last seen X ago" rather than as live.
	// CACHE_TTL_MS in $lib/prices is 60s — anything older than
	// 5× that is firmly stale.
	const STALE_THRESHOLD_MS = 5 * 60 * 1000;
	const isStale = $derived(
		usdtQuote === null || Date.now() - usdtQuote.fetchedAt > STALE_THRESHOLD_MS
	);

	const stalenessString = $derived.by(() => {
		if (usdtQuote === null) return '?';
		const ageSeconds = Math.floor((Date.now() - usdtQuote.fetchedAt) / 1000);
		if (ageSeconds < 60) return `${ageSeconds}s`;
		if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`;
		return `${Math.floor(ageSeconds / 3600)}h`;
	});

	// Format the price.  USDT is expected ~$1.00; show 4 decimals
	// when the peg is meaningfully off so a $0.9742 dip is
	// visible (vs. rounding to a misleading "$0.97").
	function formatPrice(usd: number): string {
		// If within ±0.5% of 1.00, show 2 decimals.  Outside that
		// band the precision matters because the dip is the news.
		if (Math.abs(usd - 1.0) <= 0.005) return usd.toFixed(2);
		return usd.toFixed(4);
	}
</script>

{#if !isStale && usdtQuote !== null}
	<span
		class={compact
			? 'text-xs text-ink-400'
			: 'inline-flex items-center rounded-md border border-ink-200 bg-ink-50 px-2 py-0.5 text-xs text-ink-500 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-400'}
	>
		{$_('assets.usdt.price_subline.live', {
			values: { price: formatPrice(usdtQuote.usd) }
		})}
	</span>
{:else if fetchFailed || usdtQuote !== null}
	<span
		class={compact
			? 'text-xs italic text-ink-500'
			: 'inline-flex items-center rounded-md border border-amber-400/30 bg-amber-400/5 px-2 py-0.5 text-xs italic text-amber-300'}
		title={$_('assets.usdt.price_subline.unavailable', {
			values: { staleness: stalenessString }
		}) as string}
	>
		{$_('assets.usdt.price_subline.unavailable', {
			values: { staleness: stalenessString }
		})}
	</span>
{/if}
