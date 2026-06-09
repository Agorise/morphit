<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { SUPPORTED_LOCALES, currentLocale, setLocale, type LocaleCode } from '$i18n';
	import { localePath, stripLocalePrefix } from '$i18n/path';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	let open = $state(false);
	let buttonEl: HTMLButtonElement;
	let menuEl: HTMLDivElement | undefined = $state();

	const currentMeta = $derived(
		SUPPORTED_LOCALES.find((l) => l.code === $currentLocale) ?? SUPPORTED_LOCALES[0]
	);

	// A compact 2-letter badge per locale. For unambiguous languages this is
	// the ISO 639-1 code (en→EN, es→ES, …). The two Chinese locales both map
	// to 639-1 "zh", so we fall back to the region subtag (zh-CN→CN, zh-HK→HK)
	// to keep them distinguishable in the list.
	function displayCode(code: string): string {
		return code.includes('-') ? code.split('-')[1]!.toUpperCase() : code.toUpperCase();
	}

	async function choose(code: LocaleCode): Promise<void> {
		// Part 121 cp7 — language switch is now a navigation, not
		// a runtime locale swap.  Each locale has its own
		// prerendered HTML at `/<lang>/<route>`, so switching
		// requires navigating to the equivalent path under the
		// new prefix.
		//
		// stripLocalePrefix + localePath together compose the
		// "same page, different locale" URL:
		//   /es/orderbook?asset=BTC#row-3
		//     → stripLocalePrefix → /orderbook?asset=BTC#row-3
		//     → localePath(_, 'pl') → /pl/orderbook?asset=BTC#row-3
		// Query strings and fragments are preserved.
		//
		// We still call setLocale() so the localStorage preference
		// updates immediately (for next visit's redirect-shell
		// detection on the bare /).  The navigation itself triggers
		// the [lang]/+layout.ts load() which re-runs initI18nFor
		// for the destination locale.
		const currentPath = $page.url.pathname + $page.url.search + $page.url.hash;
		const target = localePath(stripLocalePrefix(currentPath), code);
		await setLocale(code);
		open = false;
		buttonEl?.focus();
		await goto(target);
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			open = false;
			buttonEl?.focus();
		}
	}

	function handleClickOutside(e: MouseEvent): void {
		if (open && menuEl && !menuEl.contains(e.target as Node) && e.target !== buttonEl) {
			open = false;
		}
	}

	$effect(() => {
		if (open) {
			document.addEventListener('click', handleClickOutside);
			document.addEventListener('keydown', handleKeydown);
			return () => {
				document.removeEventListener('click', handleClickOutside);
				document.removeEventListener('keydown', handleKeydown);
			};
		}
	});
</script>

<div class="relative inline-block">
	<button
		bind:this={buttonEl}
		type="button"
		class="inline-flex items-center gap-1 rounded-xl border border-ink-200 bg-white px-2.5 py-2 text-sm font-semibold transition hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label={`${$_('locale.switcher_aria')} — ${currentMeta?.nativeName ?? ''}`}
		title={currentMeta?.nativeName}
		onclick={(e) => {
			e.stopPropagation();
			open = !open;
		}}
	>
		<!-- Current language shown as its 2-letter code (replaces the old
		     globe glyph). The full language name is still conveyed via the
		     aria-label and title for screen readers + hover. -->
		<span class="font-semibold tabular-nums">{displayCode(currentMeta?.code ?? 'en')}</span>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="10"
			height="10"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="m6 9 6 6 6-6" />
		</svg>
	</button>

	{#if open}
		<div
			bind:this={menuEl}
			role="listbox"
			aria-label={$_('nav.language')}
			class="fixed inset-x-3 top-16 z-50 grid max-h-[min(70vh,30rem)] grid-cols-2 gap-1 overflow-y-auto rounded-xl border border-ink-200 bg-white p-1.5 shadow-morphit-card sm:absolute sm:inset-x-auto sm:end-0 sm:top-auto sm:mt-2 sm:w-[min(92vw,30rem)] sm:origin-top-right sm:grid-cols-3 dark:border-ink-700 dark:bg-ink-900 ltr:sm:origin-top-right rtl:sm:origin-top-left"
		>
			{#each SUPPORTED_LOCALES as loc (loc.code)}
				{@const active = loc.code === $currentLocale}
				<button
					type="button"
					role="option"
					aria-selected={active}
					class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-ink-50 focus:bg-ink-50 focus:outline-none dark:hover:bg-ink-800 dark:focus:bg-ink-800 {active
						? 'bg-ink-50 font-semibold text-morphit-emerald ring-1 ring-inset ring-morphit-emerald/50 dark:bg-ink-800'
						: ''}"
					onclick={() => choose(loc.code)}
				>
					<span
						class="flex-none rounded-md bg-ink-100 px-1.5 py-0.5 font-mono text-xs font-bold tabular-nums text-ink-600 dark:bg-ink-800 dark:text-ink-300"
						aria-hidden="true">{displayCode(loc.code)}</span>
					<span class="flex min-w-0 flex-1 flex-col">
						<span class="truncate">{loc.nativeName}</span>
						<span class="truncate text-xs text-ink-500 dark:text-ink-400">{loc.englishName}</span>
					</span>
					{#if active}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
							class="flex-none text-morphit-emerald"
						>
							<path d="M20 6 9 17l-5-5" />
						</svg>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
