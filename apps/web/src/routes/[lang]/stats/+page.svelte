<script lang="ts">
	// human-readable companion to the /v1/stats JSON endpoint.
	// Fetches the same aggregate-only summary and shows it as headline tiles,
	// then links the raw JSON for aggregators/dashboards. Nothing here is
	// per-account — it mirrors the endpoint's privacy shape exactly.
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { formatDayMonthTime } from '$i18n/formatters';
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import EndpointList from '$components/EndpointList.svelte';
	import { getStats } from '$lib/indexer/client';
	import { disabledAssets } from '$lib/assets/acceptedCoins';
	import { ASSET_TICKERS, isGoodsAsset } from '@morphit/asset-registry';
	import type { StatsResponse } from '@morphit/indexer-client';

	let stats = $state<StatsResponse | null>(null);
	let loadError = $state<string>('');

	/** The figures the page shows, all present (an answer without them is an
	 *  error, not a crash). */
	function isStats(d: unknown): d is StatsResponse {
		const s = d as StatsResponse | null;
		const n = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
		return (
			typeof s === 'object' &&
			s !== null &&
			n(s.orders?.active) &&
			n(s.orders?.total) &&
			n(s.trades?.completed_total) &&
			n(s.trades?.completed_30d) &&
			n(s.assets?.with_active_orders) &&
			n(s.fiat_currencies?.with_active_orders) &&
			Array.isArray(s.assets?.supported) &&
			typeof s.generated_at === 'string'
		);
	}

	onMount(async () => {
		const res = await getStats();
		if (res.ok && isStats(res.data)) {
			stats = res.data;
		} else {
			loadError = $_('stats.error');
		}
	});

	// v1.21.6: the RPC card below is drawn at once, so while the figures load
	// their cards are drawn already, at their final size (the coin list is
	// this site's own, as /v1/stats derives it), and the RPC card does not
	// jump down when they arrive.
	const placeholderCoins = $derived(
		ASSET_TICKERS.filter((t) => !$disabledAssets.includes(t) && !isGoodsAsset(t))
	);

	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	// The six headline counts, in display order. Labels are resolved in the
	// template so they stay reactive to a locale switch.
	const TILES: readonly { key: string; count: (s: StatsResponse) => number }[] = [
		{ key: 'stats.orders_active', count: (s) => s.orders.active },
		{ key: 'stats.orders_total', count: (s) => s.orders.total },
		{ key: 'stats.trades_total', count: (s) => s.trades.completed_total },
		{ key: 'stats.trades_30d', count: (s) => s.trades.completed_30d },
		{ key: 'stats.assets_active', count: (s) => s.assets.with_active_orders },
		{ key: 'stats.fiats_active', count: (s) => s.fiat_currencies.with_active_orders }
	];
</script>

<Head routeKey="stats" />

<div class="mx-auto max-w-prose px-4 py-12 md:py-16">
	<header class="mb-8">
		<h1 class="font-display text-4xl font-extrabold">
			<span class="brand-gradient-text">{$_('stats.page_title')}</span>
		</h1>
		<p class="mt-3 text-ink-600 dark:text-ink-300">{$_('stats.page_intro')}</p>
	</header>

	{#if loadError}
		<StatusLine kind="error">{loadError}</StatusLine>
	{:else}
		<div class="js-only grid grid-cols-2 gap-4 sm:grid-cols-3" aria-busy={stats === null}>
			{#each TILES as tile (tile.key)}
				<div class="card text-center">
					<div
						class="font-display text-3xl font-extrabold text-morphit-teal dark:text-morphit-emerald"
					>
						{stats ? tile.count(stats).toLocaleString(currentLang) : '–'}
					</div>
					<div class="mt-1 text-sm text-ink-600 dark:text-ink-300">{$_(tile.key)}</div>
				</div>
			{/each}
		</div>
		{#if !stats}
			<p class="js-only sr-only" role="status">{$_('common.loading')}</p>
		{/if}

		<section class="js-only card mt-6">
			<h2 class="font-display text-lg font-bold">{$_('stats.assets_supported')}</h2>
			<div class="mt-3 flex flex-wrap gap-2" class:invisible={!stats} aria-hidden={!stats}>
				{#each stats ? stats.assets.supported : placeholderCoins as asset (asset)}
					<span
						class="rounded-full bg-ink-100 px-3 py-1 text-sm font-semibold text-ink-700 dark:bg-ink-800 dark:text-ink-200"
						>{asset}</span
					>
				{/each}
			</div>
		</section>

		<!-- The "updated" + aggregator/JSON note, on their own card. -->
		<section class="card mt-6">
			<p class="js-only text-sm text-ink-500" class:invisible={!stats}>
				{$_('stats.updated', {
					values: { time: stats ? formatDayMonthTime(stats.generated_at) : '–' }
				})}
			</p>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('stats.json_note')}
				<a
					href="/v1/stats"
					data-sveltekit-reload
					target="_blank"
					rel="noopener noreferrer"
					class="text-morphit-teal hover:underline dark:text-morphit-emerald">{$_('stats.json_link')}</a
				>
			</p>
		</section>
	{/if}

	<!-- RPC endpoints — the nodes this site syncs from (moved here from settings). Outside the
	     stats block: it loads its own data at once, so it never waits for /v1/stats (or
	     disappears when that fails). -->
	<section class="js-only card mt-6" aria-labelledby="endpoints-heading">
		<h2 id="endpoints-heading" class="font-display text-xl font-bold">
			{$_('settings.endpoints.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.endpoints.explain')}
		</p>

		<div class="mt-4">
			<EndpointList />
		</div>
	</section>
</div>
