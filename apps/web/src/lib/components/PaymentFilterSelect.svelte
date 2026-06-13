<!--
	PaymentFilterSelect — the orderbook's payment-methods filter.

	Same type-ahead chip UX as FiatCurrencySelect (Ken wanted both
	filters to behave like the FAQ search field): type to filter, pick
	from the dropdown, selected methods become removable "×" chips.
	The orderbook page comma-joins the selected method KEYS into
	q.payment_methods (the indexer matches orders accepting any of
	them).

	Reuses the canonical payment registry + searchPaymentMethods (the
	same matcher the post-order picker uses), so there's one source of
	truth for method names/keys.  Operator-defined instance additions
	are merged in via the `additions` prop so users can filter by them
	too.  The registry is small and already in the orderbook bundle, so
	this is NOT lazy-loaded (unlike the 150-entry currency list).

	Grandma-friendly: chips + dropdown show the human name ("PayPal",
	"Barter (goods/services)") not the internal key; keyboard ↑/↓/Enter/Backspace/
	Esc all work.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { PAYMENT_METHODS, type PaymentMethodEntry } from '$lib/payments/registry';
	import { searchPaymentMethods } from '$lib/payments/search';

	/** Selected payment-method keys (e.g. ["paypal","barter_goods"]). */
	let {
		value = $bindable<string[]>([]),
		additions = [] as readonly PaymentMethodEntry[],
		/** Canonical keys the operator disabled on this instance —
		 *  excluded from the dropdown so users can't filter by a
		 *  method this instance doesn't offer (e.g. "barter_goods"). */
		disabled = [] as readonly string[],
		/** Placeholder for the input when nothing is selected.  The
		 *  orderbook passes an animated typewriter string here (mirroring
		 *  the Region field), including '' on the blank beats — so we use
		 *  `?? fallback` (not `|| fallback`) below to honour an explicit
		 *  empty string.  Callers that omit this get the static localized
		 *  example. */
		placeholder = undefined as string | undefined
	} = $props();

	let query = $state('');
	let open = $state(false);
	let focused = $state(false);
	let activeIndex = $state(0);
	let rootEl = $state<HTMLDivElement>();
	let inputEl = $state<HTMLInputElement>();

	const all = $derived<PaymentMethodEntry[]>(
		[...PAYMENT_METHODS, ...additions].filter((e) => !disabled.includes(e.key))
	);

	const hits = $derived.by<PaymentMethodEntry[]>(() => {
		// lookupDescription → null: match on the method NAME only (a
		// filter doesn't need description matching).
		//
		// No result cap: the registry has grown past 50 methods, and any
		// fixed cap silently hid the tail of the alphabet (Ken: "the select
		// options only go as far as S").  The dropdown is scrollable and the
		// registry is bounded, so show EVERY matching method.
		return searchPaymentMethods(all, query, () => null)
			.map((r) => r.entry)
			.filter((e) => !value.includes(e.key));
	});

	function nameFor(key: string): string {
		return all.find((e) => e.key === key)?.name ?? key;
	}

	function add(key: string): void {
		if (!value.includes(key)) value = [...value, key];
		query = '';
		activeIndex = 0;
		inputEl?.focus();
	}

	function remove(key: string): void {
		value = value.filter((k) => k !== key);
		inputEl?.focus();
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			open = true;
			if (hits.length) activeIndex = (activeIndex + 1) % hits.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (hits.length) activeIndex = (activeIndex - 1 + hits.length) % hits.length;
		} else if (e.key === 'Enter') {
			if (open && hits.length) {
				e.preventDefault();
				const pick = hits[Math.min(activeIndex, hits.length - 1)];
				if (pick) add(pick.key);
			}
		} else if (e.key === 'Escape') {
			open = false;
		} else if (e.key === 'Backspace' && query === '' && value.length) {
			remove(value[value.length - 1]);
		}
	}

	// Close on an outside press.  pointerdown (not click) for the same
	// reason as FiatCurrencySelect: picking an option runs add(), which
	// drops it from `hits` and detaches the clicked node before a `click`
	// would bubble here (where rootEl.contains() would then be false and
	// close the menu on every pick).  pointerdown fires first, so the menu
	// stays open for multi-select; an outside press still closes it.
	function onWindowPointerDown(e: PointerEvent): void {
		if (open && rootEl && !rootEl.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="relative" bind:this={rootEl}>
	<div
		onfocusin={() => (focused = true)}
		onfocusout={() => (focused = false)}
		class="flex flex-wrap items-center gap-1 rounded-xl border-2 border-ink-200 dark:border-ink-700 {focused || open
			? 'ring-2 ring-morphit-emerald'
			: ''} bg-white px-2 py-1.5 dark:bg-ink-900"
	>
		{#each value as key (key)}
			<span
				class="inline-flex items-center gap-1 rounded-lg bg-morphit-emerald/10 px-2 py-0.5 text-sm font-medium text-morphit-emerald"
			>
				{nameFor(key)}
				<button
					type="button"
					onclick={() => remove(key)}
					aria-label={`${$_('orderbook.filters.fiat_remove')} ${nameFor(key)}`}
					class="leading-none opacity-70 hover:opacity-100"
				>
					×
				</button>
			</span>
		{/each}
		<input
			bind:this={inputEl}
			bind:value={query}
			type="text"
			autocomplete="off"
			role="combobox"
			aria-expanded={open}
			aria-controls="payment-method-listbox"
			onfocus={() => (open = true)}
			oninput={() => {
				open = true;
				activeIndex = 0;
			}}
			onkeydown={onKeydown}
			placeholder={value.length
				? ''
				: (placeholder ?? $_('orderbook.filters.payment_methods_placeholder'))}
			class="grow border-0 bg-transparent px-1 py-0.5 text-sm focus:outline-none focus:ring-0"
		/>
	</div>

	{#if open && (query !== '' || hits.length)}
		<ul
			id="payment-method-listbox"
			role="listbox"
			class="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border-2 border-ink-200 bg-white py-1 shadow-lg dark:border-ink-700 dark:bg-ink-900"
		>
			{#if hits.length === 0}
				<li class="px-3 py-2 text-sm text-ink-500">{$_('orderbook.filters.payment_no_matches')}</li>
			{:else}
				{#each hits as e, i (e.key)}
					<li role="option" aria-selected={i === activeIndex}>
						<button
							type="button"
							onclick={() => add(e.key)}
							onmousemove={() => (activeIndex = i)}
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800 {i ===
							activeIndex
								? 'bg-ink-100 dark:bg-ink-800'
								: ''}"
						>
							{#if e.category === 'crypto'}
								<!-- Crypto methods carry a `pay_<ticker>` key and every
								     ticker has a matching /icons/icon-<ticker>.svg, so the
								     coin icon is derived straight from the key. -->
								<img
									src={`/icons/icon-${e.key.slice(4)}.svg`}
									alt=""
									loading="lazy"
									decoding="async"
									width="20"
									height="20"
									class="h-5 w-5 shrink-0 rounded-full"
								/>
							{:else if e.icon}
								<!-- Non-crypto entry with an explicit glyph (e.g. Barter). -->
								<img
									src={e.icon}
									alt=""
									loading="lazy"
									decoding="async"
									width="20"
									height="20"
									class="h-5 w-5 shrink-0"
								/>
							{:else}
								<!-- Non-crypto (fiat rails, in-person, by-mail): no coin
								     icon, but keep a spacer so names stay column-aligned. -->
								<span class="h-5 w-5 shrink-0"></span>
							{/if}
							{e.name}
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>
