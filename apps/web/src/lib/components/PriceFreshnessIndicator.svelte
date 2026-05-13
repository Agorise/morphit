<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { onMount } from 'svelte';
	import { priceStore, currentProviderName } from '$prices';
	import type { PricedSymbol } from '$prices';
	import { ASSET_TICKERS } from '@morphit/asset-registry';

	interface Props {
		/** Which symbol's freshness to display. If omitted, shows the
		 *  oldest across all three. */
		symbol?: PricedSymbol;
	}
	let { symbol }: Props = $props();

	// 1Hz ticker so "X seconds ago" updates without manual action.
	let now = $state(Date.now());
	onMount(() => {
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	/** The relevant fetchedAt: either the specified symbol's, or the
	 *  oldest known. Returns null when no quote has been fetched yet. */
	const fetchedAt = $derived.by<number | null>(() => {
		const s = $priceStore;
		if (symbol) return s[symbol]?.fetchedAt ?? null;
		const times = (ASSET_TICKERS as readonly PricedSymbol[])
			.map((sym) => s[sym]?.fetchedAt)
			.filter((t): t is number => typeof t === 'number');
		return times.length ? Math.min(...times) : null;
	});

	const ageSeconds = $derived(fetchedAt == null ? null : Math.floor((now - fetchedAt) / 1000));

	/** Color tier: green fresh (<60s), amber stale (60s-10m), red very stale (>10m),
	 *  gray unknown (no quote yet). */
	const tier = $derived.by<'fresh' | 'stale' | 'very_stale' | 'unknown'>(() => {
		if (ageSeconds == null) return 'unknown';
		if (ageSeconds < 60) return 'fresh';
		if (ageSeconds < 600) return 'stale';
		return 'very_stale';
	});

	const colorClass = $derived(
		tier === 'fresh'
			? 'text-morphit-emerald'
			: tier === 'stale'
				? 'text-amber-600 dark:text-amber-400'
				: tier === 'very_stale'
					? 'text-red-600 dark:text-red-400'
					: 'text-ink-500 dark:text-ink-400'
	);

	/** Humanize: "just now" / "X seconds ago" / "X minutes ago" / "X hours ago" */
	const label = $derived.by(() => {
		if (ageSeconds == null) return $_('prices.updated_unknown');
		if (ageSeconds < 5) return $_('prices.updated_just_now');
		if (ageSeconds < 60) return $_('prices.updated_seconds_ago', { values: { n: ageSeconds } });
		if (ageSeconds < 3600)
			return $_('prices.updated_minutes_ago', { values: { n: Math.floor(ageSeconds / 60) } });
		return $_('prices.updated_hours_ago', { values: { n: Math.floor(ageSeconds / 3600) } });
	});

	const providerLabel = $derived(currentProviderName());
</script>

<span
	class="inline-flex items-center gap-1.5 text-xs font-medium {colorClass}"
	title={$_('prices.provider_tooltip', { values: { name: providerLabel } })}
>
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="12"
		height="12"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<circle cx="12" cy="12" r="10" />
		<polyline points="12 6 12 12 16 14" />
	</svg>
	{label}
</span>
