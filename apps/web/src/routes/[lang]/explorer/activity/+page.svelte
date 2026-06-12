<!--
	Morphit block explorer — trading activity.

	Route: /explorer/activity

	Public.  Shows:
	  • Volume + trade-count by asset over 7d / 30d / 90d windows.
	    Volume is labeled "estimated" because the chain doesn't
	    carry exact fill amounts on feedback rows; we use the
	    midpoint of the order's amount range.
	  • Listings histogram: live buy vs sell counts per asset.
	    Deliberately NOT a depth chart — Morphit isn't a matching
	    engine and showing one would be misleading.

	Real-time: poll the volume endpoint every 30s, listings every
	30s.  Both are coarse-grained data; faster polling buys
	nothing.

	Lazy-loaded by virtue of being a separate route chunk.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { formatDayMonthTime } from '$i18n/formatters';
	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { getActivityVolume, getOrderbook, type ActivityVolumeWindow } from '$lib/indexer/client';
	import {
		aggregateListingHistogram,
		totalListings,
		type ListingsCount
	} from '$lib/explorer/listingsHistogram';
	import { formatBalance } from '$blurt/balanceMath';
	import Head from '$components/Head.svelte';

	type WindowKey = '7d' | '30d' | '90d';
	let activeWindow = $state<WindowKey>('30d');

	let volume7d = $state<ActivityVolumeWindow[]>([]);
	let volume30d = $state<ActivityVolumeWindow[]>([]);
	let volume90d = $state<ActivityVolumeWindow[]>([]);
	let volumeStatus: 'loading' | 'ok' | 'error' = $state('loading');
	let volumeError = $state('');
	let volumeGeneratedAt = $state('');

	let listings = $state<ListingsCount[]>([]);
	let listingsTotal = $state(0);
	let listingsStatus: 'loading' | 'ok' | 'error' = $state('loading');
	let listingsError = $state('');

	const POLL_MS = 30_000;
	let volumeTimer: ReturnType<typeof setInterval> | null = null;
	let listingsTimer: ReturnType<typeof setInterval> | null = null;

	async function refreshVolume(): Promise<void> {
		try {
			const r = await getActivityVolume();
			if (!r.ok) {
				throw new Error(r.code);
			}
			volume7d = [...r.data.window_7d];
			volume30d = [...r.data.window_30d];
			volume90d = [...r.data.window_90d];
			volumeGeneratedAt = r.data.generated_at;
			volumeStatus = 'ok';
		} catch (err) {
			console.warn('[explorer/activity] volume load failed:', err);
			volumeError = $_('explorer.activity.error.volume_load_failed');
			volumeStatus = 'error';
		}
	}

	async function refreshListings(): Promise<void> {
		try {
			// Pull a generous slice — orderbook supports limit up
			// to 100 per call.  For listings count we want the
			// current snapshot; if there are >100 listings of one
			// (asset, side), the histogram undercounts.  In
			// practice early-launch numbers fit easily; we'll
			// expand if needed.
			const r = await getOrderbook({ limit: 100 });
			if (!r.ok) {
				throw new Error(r.code);
			}
			const items = r.data.items.map((item) => ({
				side: item.side,
				asset: item.asset
			}));
			listings = aggregateListingHistogram(items);
			listingsTotal = totalListings(items);
			listingsStatus = 'ok';
		} catch (err) {
			console.warn('[explorer/activity] listings load failed:', err);
			listingsError = $_('explorer.activity.error.listings_load_failed');
			listingsStatus = 'error';
		}
	}

	function startPolling(): void {
		if (!volumeTimer) {
			volumeTimer = setInterval(() => {
				if (typeof document !== 'undefined' && document.hidden) return;
				void refreshVolume();
			}, POLL_MS);
		}
		if (!listingsTimer) {
			listingsTimer = setInterval(() => {
				if (typeof document !== 'undefined' && document.hidden) return;
				void refreshListings();
			}, POLL_MS);
		}
	}

	function stopPolling(): void {
		if (volumeTimer) {
			clearInterval(volumeTimer);
			volumeTimer = null;
		}
		if (listingsTimer) {
			clearInterval(listingsTimer);
			listingsTimer = null;
		}
	}

	onMount(() => {
		void Promise.all([refreshVolume(), refreshListings()]).then(startPolling);
	});

	onDestroy(stopPolling);

	const activeVolume = $derived(
		activeWindow === '7d' ? volume7d : activeWindow === '30d' ? volume30d : volume90d
	);

	const maxBuySell = $derived.by(() => {
		let max = 0;
		for (const l of listings) {
			if (l.buy_count > max) max = l.buy_count;
			if (l.sell_count > max) max = l.sell_count;
		}
		return Math.max(max, 1);
	});

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="explorer_activity" />

<section class="mx-auto max-w-4xl px-4 py-8">
	<nav class="mb-4 text-sm">
		<a href={lp('/explorer')} class="text-ink-500 hover:text-morphit-emerald dark:text-ink-400">
			← {$_('explorer.nav.back_to_search')}
		</a>
	</nav>

	<header class="mb-6">
		<h1 class="font-display text-2xl font-bold">
			{$_('explorer.activity.heading')}
		</h1>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('explorer.activity.subheading')}
		</p>
	</header>

	<!-- ─── Volume ──────────────────────────────────────────── -->
	<section class="card mb-6">
		<header class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
			<h2 class="font-display text-base font-bold">
				{$_('explorer.activity.volume_heading')}
			</h2>
			<div class="flex gap-1">
				{#each ['7d', '30d', '90d'] as w}
					<button
						type="button"
						onclick={() => (activeWindow = w as WindowKey)}
						class="rounded-md px-2 py-1 text-xs font-semibold transition {activeWindow === w
							? 'bg-morphit-emerald text-white'
							: 'bg-ink-200 text-ink-700 hover:bg-ink-300 dark:bg-ink-800 dark:text-ink-200'}"
					>
						{w}
					</button>
				{/each}
			</div>
		</header>

		<p class="mb-3 text-xs text-ink-500 dark:text-ink-400">
			{$_('explorer.activity.volume_caveat')}
		</p>

		{#if volumeStatus === 'loading'}
			<p class="text-sm text-ink-500">{$_('explorer.activity.loading')}</p>
		{:else if volumeStatus === 'error'}
			<p class="text-sm text-amber-700 dark:text-amber-300">
				{$_('explorer.activity.error_label')}: {volumeError}
			</p>
		{:else if activeVolume.length === 0}
			<p class="text-sm text-ink-500">
				{$_('explorer.activity.no_trades')}
			</p>
		{:else}
			<table class="w-full text-sm">
				<thead>
					<tr
						class="border-b border-ink-200 text-left text-xs uppercase text-ink-500 dark:border-ink-800 dark:text-ink-400"
					>
						<th class="py-2 font-semibold">
							{$_('explorer.activity.col_asset')}
						</th>
						<th class="py-2 text-right font-semibold">
							{$_('explorer.activity.col_trades')}
						</th>
						<th class="py-2 text-right font-semibold">
							{$_('explorer.activity.col_volume')}
						</th>
					</tr>
				</thead>
				<tbody>
					{#each activeVolume as row}
						<tr class="border-b border-ink-100 dark:border-ink-900">
							<td class="py-2 font-mono">{row.asset}</td>
							<td class="py-2 text-right font-mono">{row.trade_count}</td>
							<td class="py-2 text-right font-mono">
								{formatBalance(row.estimated_volume)}
								{row.asset}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if volumeGeneratedAt}
				<p class="mt-2 text-xs text-ink-500 dark:text-ink-400">
					{$_("explorer.activity.last_updated")}: {formatDayMonthTime(volumeGeneratedAt)}
				</p>
			{/if}
		{/if}
	</section>

	<!-- ─── Listings histogram ──────────────────────────────── -->
	<section class="card mb-6">
		<header class="mb-3">
			<h2 class="font-display text-base font-bold">
				{$_('explorer.activity.listings_heading')}
			</h2>
			<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
				{$_('explorer.activity.listings_caveat')}
			</p>
		</header>

		{#if listingsStatus === 'loading'}
			<p class="text-sm text-ink-500">{$_('explorer.activity.loading')}</p>
		{:else if listingsStatus === 'error'}
			<p class="text-sm text-amber-700 dark:text-amber-300">
				{$_('explorer.activity.error_label')}: {listingsError}
			</p>
		{:else if listings.length === 0}
			<p class="text-sm text-ink-500">
				{$_('explorer.activity.no_listings')}
			</p>
		{:else}
			<p class="mb-3 text-sm text-ink-600 dark:text-ink-300">
				{$_('explorer.activity.listings_total', { values: { n: listingsTotal } })}
			</p>
			<ul class="space-y-3">
				{#each listings as l}
					<li>
						<div class="mb-1 flex items-baseline justify-between text-sm">
							<span class="font-mono font-semibold">{l.asset}</span>
							<span class="text-xs text-ink-500 dark:text-ink-400">
								{$_('explorer.activity.listings_breakdown', {
									values: { buy: l.buy_count, sell: l.sell_count }
								})}
							</span>
						</div>
						<div class="flex h-2 overflow-hidden rounded-full bg-ink-200 dark:bg-ink-800">
							<div
								class="bg-morphit-emerald"
								style="width: {(l.buy_count / maxBuySell) * 50}%"
							></div>
							<div
								class="bg-morphit-coral"
								style="width: {(l.sell_count / maxBuySell) * 50}%"
							></div>
						</div>
					</li>
				{/each}
			</ul>
			<div class="mt-3 flex gap-4 text-xs text-ink-500 dark:text-ink-400">
				<span>
					<span class="inline-block h-2 w-2 rounded-full bg-morphit-emerald"></span>
					{$_('explorer.activity.legend_buy')}
				</span>
				<span>
					<span class="bg-morphit-coral inline-block h-2 w-2 rounded-full"></span>
					{$_('explorer.activity.legend_sell')}
				</span>
			</div>
		{/if}
	</section>
</section>
