<!--
	LanguageFilterSelect — the orderbook "Language" filter. A searchable
	multi-select mirroring PaymentFilterSelect: type to search the 10 supported
	languages (by native name, English name, or code), pick to add a removable
	"×" green chip. The orderbook page comma-joins the selected codes into the
	`langs` query param. Empty selection = all languages (no filter). Keyboard
	↑/↓/Enter/Backspace/Esc all work.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { SUPPORTED_LOCALES } from '$i18n/locales';

	/** Selected language codes (e.g. ["en","de"]). */
	let {
		value = $bindable<string[]>([]),
		placeholder = undefined as string | undefined
	} = $props();

	let query = $state('');
	let open = $state(false);
	let focused = $state(false);
	let activeIndex = $state(0);
	let rootEl = $state<HTMLDivElement>();
	let inputEl = $state<HTMLInputElement>();

	interface LangOpt {
		readonly code: string;
		readonly native: string;
		readonly english: string;
	}
	const ALL: readonly LangOpt[] = SUPPORTED_LOCALES.map((l) => ({
		code: l.code,
		native: l.nativeName,
		english: l.englishName
	}));

	const hits = $derived.by<LangOpt[]>(() => {
		const q = query.trim().toLowerCase();
		return ALL.filter((o) => !value.includes(o.code)).filter(
			(o) =>
				q === '' ||
				o.native.toLowerCase().includes(q) ||
				o.english.toLowerCase().includes(q) ||
				o.code.toLowerCase().includes(q)
		);
	});

	function nameFor(code: string): string {
		return ALL.find((o) => o.code === code)?.native ?? code;
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

	$effect(() => {
		if (!open) return;
		const onDocPointerDown = (e: PointerEvent): void => {
			if (rootEl && !rootEl.contains(e.target as Node)) open = false;
		};
		document.addEventListener('pointerdown', onDocPointerDown, true);
		return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
	});
</script>

{#if open}
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
		class="flex flex-wrap items-center gap-1 rounded-xl border border-ink-200 dark:border-ink-700 transition-colors duration-150 ease-out hover:border-ink-300 dark:hover:border-ink-600 {focused || open
			? 'border-morphit-emerald ring-1 ring-morphit-emerald'
			: ''} bg-white px-2 py-1.5 dark:bg-ink-900"
	>
		{#each value as code (code)}
			<span
				class="inline-flex items-center gap-1 rounded-lg bg-morphit-emerald/10 px-2 py-0.5 text-sm font-medium text-morphit-emerald"
			>
				{nameFor(code)}
				<button
					type="button"
					onclick={() => remove(code)}
					aria-label={`${$_('orderbook.filters.language_remove')} ${nameFor(code)}`}
					class="leading-none opacity-70 hover:opacity-100"
				>
					×
				</button>
			</span>
		{/each}
		<input
			bind:this={inputEl}
			bind:value={query}
			maxlength="32"
			type="text"
			autocomplete="off"
			role="combobox"
			aria-expanded={open}
			aria-controls="language-filter-listbox"
			onfocus={() => (open = true)}
			oninput={() => {
				open = true;
				activeIndex = 0;
			}}
			onkeydown={onKeydown}
			placeholder={value.length
				? ''
				: (placeholder ?? $_('orderbook.filters.language_placeholder'))}
			class="grow border-0 bg-transparent px-1 py-0.5 text-sm focus:outline-none focus:ring-0 no-app-focus-ring"
		/>
	</div>

	{#if open && (query !== '' || hits.length)}
		<ul
			id="language-filter-listbox"
			role="listbox"
			class="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border-2 border-ink-200 bg-white py-1 shadow-lg dark:border-ink-700 dark:bg-ink-900"
		>
			{#if hits.length === 0}
				<li class="px-3 py-2 text-sm text-ink-500">{$_('orderbook.filters.language_no_matches')}</li>
			{:else}
				{#each hits as o, i (o.code)}
					<li role="option" aria-selected={i === activeIndex}>
						<button
							type="button"
							onclick={() => add(o.code)}
							onmousemove={() => (activeIndex = i)}
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800 {i ===
							activeIndex
								? 'bg-ink-100 dark:bg-ink-800'
								: ''}"
						>
							<span class="font-medium">{o.native}</span>
							{#if o.english !== o.native}
								<span class="text-ink-500">· {o.english}</span>
							{/if}
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>
