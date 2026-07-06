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

	/** Selected ISO codes, uppercase (e.g. ["USD","EUR"]). In `single`
	 *  mode the array holds at most one code (picking replaces). */
	let {
		value = $bindable<string[]>([]),
		single = false,
		/** When true, marks the combobox input `aria-invalid` (the field
		 *  failed validation) — mirrors a native input's invalid state. */
		invalid = false,
		/** Id of an external error/description element to associate via
		 *  `aria-describedby` (e.g. the fiat StatusLine's `fiat-error`). */
		describedById = undefined as string | undefined
	} = $props();

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
		// No artificial cap: the field is scrollable (max-h-72) and the
		// dataset is small (~150 light rows in a lazily-imported chunk),
		// so an empty-focus browse must reach EVERY currency — a prior
		// cap of 50 silently stopped the list at the 50th name
		// (Georgian lari), making later currencies unreachable. Typing
		// still narrows the same full set.
		return mod
			.searchCurrencies(query, mod.CURRENCIES.length)
			.filter((c) => !value.includes(c.code));
	});

	function nameFor(code: string): string {
		return mod?.CURRENCIES.find((c) => c.code === code)?.name ?? code;
	}

	function add(code: string): void {
		if (single) {
			// Single-select: a pick REPLACES the current choice and closes
			// the menu (used by the compose-order page's fiat field).
			value = [code];
			query = '';
			activeIndex = 0;
			open = false;
			return;
		}
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

	// Robust outside-close. A document-level pointerdown listener (capture)
	// closes the menu when the press lands outside this component's root.
	// pointerdown (not click) fires BEFORE the picked option's add() detaches
	// its own node, so an option press is still seen as INSIDE rootEl — the
	// race the old window-click approach hit. The menu stays open for
	// multi-select until an OUTSIDE press. The blur scrim below is now purely
	// visual: relying on it to close was fragile because the sticky page
	// header (z-40) paints over the scrim (z-20), so a press in the header
	// strip never reached it and the menu stayed stuck open.
	$effect(() => {
		if (!open) return;
		const onDocPointerDown = (e: PointerEvent): void => {
			if (rootEl && !rootEl.contains(e.target as Node)) open = false;
		};
		document.addEventListener('pointerdown', onDocPointerDown, true);
		return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
	});

	// Single-select with a pre-filled value (draft restore / saved
	// preference) needs the currency dataset loaded so the inline label
	// can show the full NAME, not just the bare ISO code — otherwise the
	// field reads "MXN" until the user happens to focus it.  Cheap: one
	// lazy import on mount, only when there is something to label.
	$effect(() => {
		if (single && value.length > 0 && !mod) void ensureLoaded();
	});

	//
	// The root z is conditional — z-30 while open, z-10 while closed —
	// because the orderbook stacks three of these selects on one page
	// (asset / fiat / payment). Each is its own `relative` stacking
	// context, and sibling contexts at EQUAL z paint in DOM order, so a
	// bare `z-30` root let a later filter's field paint OVER this one's
	// open dropdown (the payment pills bled into the fiat list). Dropping
	// to z-10 when closed keeps every idle sibling BELOW the active
	// select's z-20 scrim, so the open dropdown overlays them cleanly and
	// a tap on an idle sibling hits the scrim and closes this one first.
</script>

{#if open}
	<!-- Full-screen blur scrim (mirrors FaqSearch): dims + blurs the page
	     behind the open listbox; an outside click closes it. -->
	<button
		type="button"
		tabindex="-1"
		aria-hidden="true"
		onclick={() => (open = false)}
		class="fixed inset-0 z-20 cursor-default bg-ink-900/5 backdrop-blur-sm"
	></button>
{/if}

<div class="relative {open ? 'z-30' : 'z-10'}" bind:this={rootEl}>
	<div
		onfocusin={() => (focused = true)}
		onfocusout={() => (focused = false)}
		class="flex flex-wrap items-center gap-1 rounded-xl border-2 border-ink-200 dark:border-ink-700 transition-colors duration-150 ease-out hover:border-ink-300 dark:hover:border-ink-600 {focused || open
			? 'ring-2 ring-morphit-emerald'
			: ''} bg-white px-2 py-1.5 dark:bg-ink-900"
	>
		{#if single}
			<!-- Single-select (compose-order fiat field): the one choice
			     reads as plain inline text, NOT a removable "×" chip,
			     because a chip implies you can add more than one.  While
			     the field is focused the label yields to the search box so
			     the user can type a replacement (picking one REPLACES). -->
			{#if value.length === 1 && !focused}
				<!-- A <label for> (not a bare <span>): clicking the visible
				     currency text focuses the search input, which reopens the
				     menu so the choice can be changed. As a plain span the
				     text was a dead zone and the field read as "stuck" once a
				     value was set (you could only reopen by hitting the thin
				     grow-input strip to its right). cursor-text signals it's
				     editable. -->
				<label
					for="fiat-currency-search"
					class="cursor-text px-1 py-0.5 text-sm font-medium text-ink-900 dark:text-ink-50"
				>
					{value[0]}{#if mod && nameFor(value[0]) !== value[0]} — {nameFor(value[0])}{/if}
				</label>
			{/if}
		{:else}
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
		{/if}
		<input
			bind:this={inputEl}
			bind:value={query}
			id="fiat-currency-search"
			name="fiat_currency_search"
			maxlength="64"
			type="text"
			autocomplete="off"
			role="combobox"
			aria-expanded={open}
			aria-controls="fiat-currency-listbox"
			aria-invalid={invalid || undefined}
			aria-describedby={describedById}
			onfocus={onFocus}
			oninput={() => {
				open = true;
				activeIndex = 0;
			}}
			onkeydown={onKeydown}
			placeholder={single
				? value.length === 0 || focused
					? ($_('orderbook.filters.fiat_search_placeholder') as string)
					: ''
				: value.length
					? ''
					: ($_('orderbook.filters.fiat_search_placeholder') as string)}
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
