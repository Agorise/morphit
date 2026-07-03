<script lang="ts">
	// cp406 — human-readable companion to the /v1/stats JSON endpoint.
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
	import { getStats } from '$lib/indexer/client';
	import type { StatsResponse } from '@morphit/indexer-client';

	let stats = $state<StatsResponse | null>(null);
	let loadError = $state<string>('');

	onMount(async () => {
		const res = await getStats();
		if (res.ok) {
			stats = res.data;
		} else {
			loadError = $_('stats.error');
		}
	});

	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	// The six headline counts, in display order. Labels are resolved in the
	// template so they stay reactive to a locale switch.
	const tiles = $derived(
		stats
			? [
					{ count: stats.orders.active, key: 'stats.orders_active' },
					{ count: stats.orders.total, key: 'stats.orders_total' },
					{ count: stats.trades.completed_total, key: 'stats.trades_total' },
					{ count: stats.trades.completed_30d, key: 'stats.trades_30d' },
					{ count: stats.assets.with_active_orders, key: 'stats.assets_active' },
					{ count: stats.fiat_currencies.with_active_orders, key: 'stats.fiats_active' }
				]
			: []
	);
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
	{:else if !stats}
		<p class="text-ink-500">{$_('common.loading')}</p>
	{:else}
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
			{#each tiles as tile (tile.key)}
				<div class="card text-center">
					<div
						class="font-display text-3xl font-extrabold text-morphit-teal dark:text-morphit-emerald"
					>
						{tile.count.toLocaleString(currentLang)}
					</div>
					<div class="mt-1 text-sm text-ink-600 dark:text-ink-300">{$_(tile.key)}</div>
				</div>
			{/each}
		</div>

		<section class="card mt-6">
			<h2 class="font-display text-lg font-bold">{$_('stats.assets_supported')}</h2>
			<div class="mt-3 flex flex-wrap gap-2">
				{#each stats.assets.supported as asset (asset)}
					<span
						class="rounded-full bg-ink-100 px-3 py-1 text-sm font-semibold text-ink-700 dark:bg-ink-800 dark:text-ink-200"
						>{asset}</span
					>
				{/each}
			</div>
		</section>

		<p class="mt-6 text-sm text-ink-500">
			{$_('stats.updated', { values: { time: formatDayMonthTime(stats.generated_at) } })}
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
	{/if}
</div>
