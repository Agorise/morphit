<!--
	StablecoinPriceSubline — renders a small live-price line under a
	USD-pegged stablecoin order row (USDT / USDC / DAI). Format:
		1 USDT = $1.00 live
	When the price feed is stale or unavailable, falls back to (title/body):
		USDT/USD price feed unavailable — last seen 12m ago.

	Why this exists (Ken's design Q9e, 2026-05-13): stablecoins peg to USD
	by DESIGN, but pegs break — USDT (2018, 2022), USDC (dipped to ~$0.87 in
	the March 2023 SVB scare), and DAI transitively (~$0.97 in the same
	episode, via its USDC-backed PSM). When the peg dips, a "1000 USDC" order's
	USD value shown in the row becomes a lie unless we surface the actual peg
	state. The subline lets traders SEE when a peg is off, not assume it's
	always $1.00.

	cp417: generalised from the old USDT-only UsdtPriceSubline. USDC and DAI
	already had their `assets.<t>.price_subline.*` strings (with translation
	coverage in i18n-translation-completeness-smoke) but no render path — this
	wires all three stablecoins, keyed off the `asset` prop.

	Pulls from the existing $lib/prices store (Coingecko on the live path,
	fallback static-1.00 when offline). Render-only — no state of its own;
	subscribes to priceStore and re-renders when the quote's fetchedAt changes.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { getPrice, priceStore } from '$lib/prices';
	import type { StablecoinSublineTicker } from '$lib/assets/stablecoinSubline';

	interface Props {
		/** Which stablecoin to price. */
		asset: StablecoinSublineTicker;
		compact?: boolean;
	}
	let { asset, compact = true }: Props = $props();

	let fetchFailed = $state(false);
	onMount(() => {
		getPrice(asset).catch(() => {
			fetchFailed = true;
		});
	});

	const quote = $derived($priceStore[asset]);
	const STALE_THRESHOLD_MS = 5 * 60 * 1000;
	const isStale = $derived(quote === null || Date.now() - quote.fetchedAt > STALE_THRESHOLD_MS);
	const stalenessString = $derived.by(() => {
		if (quote === null) return '?';
		const ageSeconds = Math.floor((Date.now() - quote.fetchedAt) / 1000);
		if (ageSeconds < 60) return `${ageSeconds}s`;
		if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`;
		return `${Math.floor(ageSeconds / 3600)}h`;
	});
	// Lowercase ticker → the i18n namespace (assets.usdt / assets.usdc / assets.dai).
	const ns = $derived(asset.toLowerCase());
	function formatPrice(usd: number): string {
		if (Math.abs(usd - 1.0) <= 0.005) return usd.toFixed(2);
		return usd.toFixed(4);
	}
</script>

{#if !isStale && quote !== null}
	<span
		class={compact
			? 'text-xs text-ink-400'
			: 'inline-flex items-center rounded-md border border-ink-200 bg-ink-50 px-2 py-0.5 text-xs text-ink-500 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-400'}
	>
		{$_(`assets.${ns}.price_subline.live`, {
			values: { price: formatPrice(quote.usd) }
		})}
	</span>
{:else if fetchFailed || quote !== null}
	<span
		class={compact
			? 'text-xs italic text-ink-500'
			: 'inline-flex items-center rounded-md border border-ink-400/30 bg-ink-400/5 px-2 py-0.5 text-xs italic text-ink-300'}
		title={$_(`assets.${ns}.price_subline.unavailable`, {
			values: { staleness: stalenessString }
		}) as string}
	>
		{$_(`assets.${ns}.price_subline.unavailable`, {
			values: { staleness: stalenessString }
		})}
	</span>
{/if}
