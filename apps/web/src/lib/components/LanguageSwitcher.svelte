<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { SUPPORTED_LOCALES, currentLocale, setLocale, type LocaleCode } from '$i18n';

	let open = $state(false);
	let buttonEl: HTMLButtonElement;
	let menuEl: HTMLDivElement | undefined = $state();

	const currentMeta = $derived(
		SUPPORTED_LOCALES.find((l) => l.code === $currentLocale) ?? SUPPORTED_LOCALES[0]
	);

	async function choose(code: LocaleCode): Promise<void> {
		await setLocale(code);
		open = false;
		buttonEl?.focus();
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
		<!-- Minimalist globe glyph; no language name or code shown.
		     The current language is conveyed via aria-label (for
		     screen readers) and title (for sighted hover users).
		     The dropdown chevron is the only secondary affordance. -->
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="10" />
			<path d="M2 12h20" />
			<path
				d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
			/>
		</svg>
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
			class="absolute end-0 z-50 mt-2 w-56 origin-top-right overflow-hidden rounded-xl border border-ink-200 bg-white shadow-morphit-card dark:border-ink-700 dark:bg-ink-900 ltr:origin-top-right rtl:origin-top-left"
		>
			{#each SUPPORTED_LOCALES as loc (loc.code)}
				{@const active = loc.code === $currentLocale}
				<button
					type="button"
					role="option"
					aria-selected={active}
					class="flex w-full items-center gap-3 px-4 py-3 text-left text-base hover:bg-ink-50 focus:bg-ink-50 focus:outline-none dark:hover:bg-ink-800 dark:focus:bg-ink-800 {active
						? 'bg-ink-50 font-semibold text-morphit-emerald dark:bg-ink-800'
						: ''}"
					onclick={() => choose(loc.code)}
				>
					<span class="flex min-w-0 flex-1 flex-col">
						<span>{loc.nativeName}</span>
						<span class="text-xs text-ink-500 dark:text-ink-400">{loc.englishName}</span>
					</span>
					{#if active}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="18"
							height="18"
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
