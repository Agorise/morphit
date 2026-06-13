<!--
	FiatCurrencySelect — the orderbook's fiat filter.

	Type-ahead chips: type a currency NAME or ISO code, pick from the
	instant-filtered dropdown (mirrors the FAQ search UX), and selected
	currencies become removable "×" chips.  Supports ONE OR MORE
	currencies; the orderbook page joins them comma-separated into
	q.fiat_currency (the indexer matches any of them).

	LAZY: the ~150-entry currency dataset is `await import()`ed the
	FIRST time the field gets focus, so it's a separate Vite chunk
	(minified + gzipped on the wire) that ships ZERO bytes to a visitor
	who never touches the fiat filter (priorities #1/#4).

	Grandma-friendly: a plain "search by name or code" prompt, each
	dropdown row shows the code AND the full name, chips show the short
	code with the full name on hover, and there's keyboard support
	(↑/↓ to move, Enter to add, Backspace on an empty box to remove the
	last chip, Esc to close).
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import type { Currency } from '$lib/data/currencies';

	/** Selected ISO codes, uppercase (e.g. ["USD","EUR"]). */
	let { value = $bindable<string[]>([]) } = $props();

	let query = $state('');
	let open = $state(false);
	let focused = $state(false);
	let activeIndex = $state(0);
	let rootEl = $state<HTMLDivElement>();
	let inputEl = $state<HTMLInputElement>();

	// The currency dataset, lazily imported on first focus.
	let mod = $state<typeof import('$lib/data/currencies') | null>(null);
	let loading = $state(false);

	async function ensureLoaded(): Promise<void> {
		if (mod || loading) return;
		loading = true;
		try {
			mod = await import('$lib/data/currencies');
		} finally {
			loading = false;
		}
	}

	const hits = $derived.by<Currency[]>(() => {
		if (!mod) return [];
		// 50 (not 8): the field is scrollable (max-h-72), so an empty-focus
		// browse shows a generous list and typing narrows it — the old cap
		// of 8 made the field look like it only held 8 currencies.
		return mod.searchCurrencies(query, 50).filter((c) => !value.includes(c.code));
	});

	function nameFor(code: string): string {
		return mod?.CURRENCIES.find((c) => c.code === code)?.name ?? code;
	}

	function add(code: string): void {
		if (!value.includes(code)) value = [...value, code];
		query = '';
		activeIndex = 0;
		inputEl?.focus();
	}

	function remove(code: string): void {
		value = value.filter((c) => c !== code);
		inputEl?.focus();
	}

	function onFocus(): void {
		open = true;
		void ensureLoaded();
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
				if (pick) add(pick.code);
			}
		} else if (e.key === 'Escape') {
			open = false;
		} else if (e.key === 'Backspace' && query === '' && value.length) {
			remove(value[value.length - 1]);
		}
	}

	// Close on an outside press.  Uses `pointerdown` (not `click`)
	// deliberately: clicking an option runs add(), which removes that
	// option from `hits` and so detaches the clicked node from the DOM
	// before a `click` would bubble to here — at which point
	// rootEl.contains(detachedNode) is false and the menu would wrongly
	// close on every pick.  pointerdown fires BEFORE that re-render, so
	// the target is still inside rootEl and the menu stays open for the
	// next selection; an outside press still closes it.
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
		{#each value as code (code)}
			<span
				class="inline-flex items-center gap-1 rounded-lg bg-morphit-emerald/10 px-2 py-0.5 text-sm font-medium text-morphit-emerald"
				title={nameFor(code)}
			>
				{code}
				<button
					type="button"
					onclick={() => remove(code)}
					aria-label={`${$_('orderbook.filters.fiat_remove')} ${code}`}
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
			aria-controls="fiat-currency-listbox"
			onfocus={onFocus}
			oninput={() => {
				open = true;
				activeIndex = 0;
			}}
			onkeydown={onKeydown}
			placeholder={value.length ? '' : $_('orderbook.filters.fiat_search_placeholder')}
			class="grow border-0 bg-transparent px-1 py-0.5 text-sm focus:outline-none focus:ring-0"
		/>
	</div>

	{#if open && (loading || query !== '' || hits.length)}
		<ul
			id="fiat-currency-listbox"
			role="listbox"
			class="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border-2 border-ink-200 bg-white py-1 shadow-lg dark:border-ink-700 dark:bg-ink-900"
		>
			{#if loading}
				<li class="px-3 py-2 text-sm text-ink-500">…</li>
			{:else if hits.length === 0}
				<li class="px-3 py-2 text-sm text-ink-500">{$_('orderbook.filters.fiat_no_matches')}</li>
			{:else}
				{#each hits as c, i (c.code)}
					<li role="option" aria-selected={i === activeIndex}>
						<button
							type="button"
							onclick={() => add(c.code)}
							onmousemove={() => (activeIndex = i)}
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800 {i ===
							activeIndex
								? 'bg-ink-100 dark:bg-ink-800'
								: ''}"
						>
							<span class="w-12 shrink-0 font-mono font-semibold">{c.code}</span>
							<span class="truncate">{c.name}</span>
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>
