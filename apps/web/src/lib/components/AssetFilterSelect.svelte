<!--
	AssetFilterSelect — the orderbook's Asset filter.

	A native <select> can't render the per-coin SVG logos, so this is
	a small custom listbox: a trigger button + a popover list.  It
	mirrors CoinCarousel's sourcing and lazy posture:

	  - Options come from the frontend asset registry (ASSETS), so the
	    coin NAME + ticker + logo all stay in one source of truth.
	  - Coins are alphabetized BY NAME (not ticker) per Ken's ask —
	    "Bitcoin (BTC)", "Bitcoin Cash (BCH)", "Blurt (BLURT)", …,
	    "Pirate Chain (ARRR)", … "Zcash (ZEC)".
	  - Operator-disabled assets are filtered out (same rule as the
	    carousel: read $instance.disabled_assets).
	  - The logo <img>s live INSIDE the {#if open} block and carry
	    loading="lazy" decoding="async", so a visitor who never opens
	    the menu pays zero bytes for the coin icons (priorities #1/#4).

	"Barter (goods/services)" is appended last with the bundled
	gold-bars icon.  Barter is a PAYMENT METHOD (`barter_goods`), not a
	tradable asset, so selecting it sets the sentinel value 'barter';
	the orderbook page maps that to `payment_methods ⊇ barter_goods`
	rather than `q.asset` (the indexer has no "asset=barter").
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { ASSETS } from '$lib/assets/registry';
	import { instance } from '$stores/instance';
	import type { AssetTicker } from '@morphit/asset-registry';

	/** '' = Any · an uppercase ticker · 'barter' = goods/services. */
	type AssetFilterValue = '' | AssetTicker | 'barter';

	let { value = $bindable('' as AssetFilterValue) } = $props();

	let open = $state(false);
	let focused = $state(false);
	let rootEl = $state<HTMLDivElement>();
	let buttonEl = $state<HTMLButtonElement>();

	const disabled = $derived(
		new Set(($instance?.disabled_assets ?? []).map((t) => t.toUpperCase()))
	);

	// Tradable coins, operator-disabled filtered, alphabetized by name.
	const coins = $derived(
		ASSETS.filter((a) => a.canBeTraded && !disabled.has(a.displayTicker.toUpperCase()))
			.slice()
			.sort((a, b) => a.displayName.localeCompare(b.displayName))
	);

	// Label + icon for whatever is currently selected (drives the button).
	const selected = $derived.by(() => {
		if (value === 'barter') {
			return { label: $_('orderbook.filters.asset_barter'), icon: '/icons/icon-barter.svg' };
		}
		if (value !== '') {
			const a = ASSETS.find((x) => x.displayTicker === value);
			if (a) return { label: `${a.displayName} (${a.displayTicker})`, icon: a.logoSvgPath };
		}
		return { label: $_('orderbook.filters.asset_any'), icon: null };
	});

	function choose(v: AssetFilterValue): void {
		value = v;
		open = false;
		buttonEl?.focus();
	}

	function onWindowClick(e: MouseEvent): void {
		if (open && rootEl && !rootEl.contains(e.target as Node)) open = false;
	}

	function onWindowKeydown(e: KeyboardEvent): void {
		if (open && e.key === 'Escape') {
			open = false;
			buttonEl?.focus();
		}
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div class="relative" bind:this={rootEl}>
	<button
		bind:this={buttonEl}
		type="button"
		aria-haspopup="listbox"
		aria-expanded={open}
		onclick={() => (open = !open)}
		onfocus={() => (focused = true)}
		onblur={() => (focused = false)}
		class="flex w-full items-center gap-2 rounded-xl border-2 {focused || open
			? 'border-morphit-emerald'
			: 'border-ink-200 dark:border-ink-700'} bg-white px-3 py-2 text-left focus:outline-none dark:bg-ink-900"
	>
		{#if selected.icon}
			<img src={selected.icon} alt="" width="20" height="20" class="h-5 w-5 shrink-0 rounded-full" />
		{/if}
		<span class="grow truncate">{selected.label}</span>
		<svg class="h-4 w-4 shrink-0 opacity-60" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
			<path
				fill-rule="evenodd"
				d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
				clip-rule="evenodd"
			/>
		</svg>
	</button>

	{#if open}
		<ul
			role="listbox"
			aria-label={$_('orderbook.filters.asset_label')}
			class="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border-2 border-ink-200 bg-white py-1 shadow-lg dark:border-ink-700 dark:bg-ink-900"
		>
			<li role="option" aria-selected={value === ''}>
				<button
					type="button"
					onclick={() => choose('')}
					class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-ink-100 dark:hover:bg-ink-800 {value === ''
						? 'bg-ink-100 font-medium dark:bg-ink-800'
						: ''}"
				>
					<span class="h-5 w-5 shrink-0"></span>
					<span>{$_('orderbook.filters.asset_any')}</span>
				</button>
			</li>
			{#each coins as a (a.ticker)}
				<li role="option" aria-selected={value === a.displayTicker}>
					<button
						type="button"
						onclick={() => choose(a.displayTicker as AssetFilterValue)}
						class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-ink-100 dark:hover:bg-ink-800 {value ===
						a.displayTicker
							? 'bg-ink-100 font-medium dark:bg-ink-800'
							: ''}"
					>
						<img
							src={a.logoSvgPath}
							alt=""
							loading="lazy"
							decoding="async"
							width="20"
							height="20"
							class="h-5 w-5 shrink-0 rounded-full"
						/>
						<span>{a.displayName} <span class="opacity-60">({a.displayTicker})</span></span>
					</button>
				</li>
			{/each}
			<li role="option" aria-selected={value === 'barter'}>
				<button
					type="button"
					onclick={() => choose('barter')}
					class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-ink-100 dark:hover:bg-ink-800 {value ===
					'barter'
						? 'bg-ink-100 font-medium dark:bg-ink-800'
						: ''}"
				>
					<img
						src="/icons/icon-barter.svg"
						alt=""
						loading="lazy"
						decoding="async"
						width="20"
						height="20"
						class="h-5 w-5 shrink-0 rounded-full"
					/>
					<span>{$_('orderbook.filters.asset_barter')}</span>
				</button>
			</li>
		</ul>
	{/if}
</div>
