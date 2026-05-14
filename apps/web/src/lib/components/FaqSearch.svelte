<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import {
		faqEntries,
		searchEntries,
		type FaqHit,
		type FaqEntry,
		type FaqKey
	} from '$utils/faqIndex';
	import { SUPPORTED_LOCALES, setLocale, currentLocale, type LocaleCode } from '$i18n';

	let query = $state('');
	let activeIndex = $state(0);
	let inputEl: HTMLInputElement;

	// Auto-expanded entries (by key) — a Set for quick toggles.
	let expanded = $state(new Set<FaqKey>());

	// Per-entry "copied" toast state.
	let copiedKey = $state<FaqKey | null>(null);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

	const hits: FaqHit[] = $derived(searchEntries($faqEntries, query, 20));

	/** Lookup map key → entry, used to resolve related-entry chips to
	 *  their localized question strings. Rebuilds when the locale
	 *  changes because $faqEntries does. */
	const entriesByKey: Map<FaqKey, FaqEntry> = $derived(new Map($faqEntries.map((e) => [e.key, e])));

	/**
	 * Handle deep links in two forms:
	 *   1. /faq#<key>             — legacy hash-based deep link
	 *   2. /faq?q=<key>&lang=<c>  — admin-share format (locale-aware)
	 */
	$effect(() => {
		if (!browser) return;

		const params = $page.url.searchParams;
		const qKey = params.get('q');
		const lang = params.get('lang');

		// Switch locale first, if the shared link carries one AND it's a
		// locale we support AND it's different from the current one.
		if (lang && lang !== $currentLocale && SUPPORTED_LOCALES.some((l) => l.code === lang)) {
			void setLocale(lang as LocaleCode);
		}

		const targetKey = qKey ?? $page.url.hash.replace(/^#/, '');
		if (!targetKey) return;

		const found = $faqEntries.find((e) => e.key === targetKey);
		if (!found) return;

		expanded.add(found.key);
		expanded = new Set(expanded);
		queueMicrotask(() => {
			document.getElementById(`faq-${found.key}`)?.scrollIntoView({
				behavior: 'smooth',
				block: 'start'
			});
		});
	});

	function toggle(entry: FaqEntry): void {
		if (expanded.has(entry.key)) expanded.delete(entry.key);
		else expanded.add(entry.key);
		expanded = new Set(expanded);
		// Keep the URL in sync for shareable state without forcing scroll.
		if (expanded.has(entry.key)) {
			const url = new URL(window.location.href);
			url.searchParams.set('q', entry.key);
			url.searchParams.set('lang', $currentLocale);
			url.hash = '';
			history.replaceState(null, '', url.toString());
		}
	}

	/**
	 * Navigate to a related FAQ entry. Expands the target (if it
	 * wasn't already), scrolls it into view, and syncs the URL.
	 * Called when the user clicks a chip in the "Related" row.
	 *
	 * We keep the source entry expanded too — the user came from
	 * there and might want to come back without losing their place.
	 */
	function goToRelated(targetKey: FaqKey): void {
		expanded.add(targetKey);
		expanded = new Set(expanded);
		const url = new URL(window.location.href);
		url.searchParams.set('q', targetKey);
		url.searchParams.set('lang', $currentLocale);
		url.hash = '';
		history.replaceState(null, '', url.toString());
		queueMicrotask(() => {
			document.getElementById(`faq-${targetKey}`)?.scrollIntoView({
				behavior: 'smooth',
				block: 'start'
			});
		});
	}

	/** Build the canonical shareable URL for an entry. */
	function shareUrl(entry: FaqEntry): string {
		if (!browser) return '';
		const url = new URL(window.location.href);
		url.search = '';
		url.hash = '';
		url.searchParams.set('q', entry.key);
		url.searchParams.set('lang', $currentLocale);
		return url.toString();
	}

	async function copyShareLink(entry: FaqEntry, e: Event): Promise<void> {
		e.stopPropagation();
		const link = shareUrl(entry);
		try {
			await navigator.clipboard.writeText(link);
			copiedKey = entry.key;
			if (copyTimeout) clearTimeout(copyTimeout);
			copyTimeout = setTimeout(() => (copiedKey = null), 2000);
		} catch {
			// Clipboard blocked — fall back to opening a share intent if the
			// browser supports it, otherwise just select-text the URL.
			if (typeof navigator.share === 'function') {
				try {
					await navigator.share({ title: entry.question, url: link });
					copiedKey = entry.key;
					if (copyTimeout) clearTimeout(copyTimeout);
					copyTimeout = setTimeout(() => (copiedKey = null), 2000);
				} catch {
					// User cancelled the share sheet; do nothing.
				}
			}
		}
	}

	function handleKey(e: KeyboardEvent): void {
		if (!hits.length) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, hits.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const hit = hits[activeIndex];
			if (hit) {
				expanded.add(hit.entry.key);
				expanded = new Set(expanded);
				document.getElementById(`faq-${hit.entry.key}`)?.scrollIntoView({
					behavior: 'smooth',
					block: 'center'
				});
			}
		} else if (e.key === 'Escape') {
			query = '';
			activeIndex = 0;
		}
	}

	$effect(() => {
		void query;
		activeIndex = 0;
	});

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<section class="mx-auto w-full max-w-prose">
	<header class="mb-8 text-center">
		<h1 class="font-display text-4xl font-bold tracking-tight md:text-5xl">
			<span class="brand-gradient-text">{$_('faq.title')}</span>
		</h1>
		<p class="mt-3 text-ink-600 dark:text-ink-300">{$_('faq.subtitle')}</p>
	</header>

	<div class="relative">
		<label for="faq-search" class="sr-only">{$_('faq.search_placeholder')}</label>
		<div class="relative">
			<span
				class="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-ink-500 dark:text-ink-400"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="7" />
					<path d="m21 21-4.3-4.3" />
				</svg>
			</span>
			<input
				bind:this={inputEl}
				bind:value={query}
				onkeydown={handleKey}
				type="search"
				id="faq-search"
				role="combobox"
				aria-expanded={query.length > 0 && hits.length > 0}
				aria-controls="faq-results"
				aria-autocomplete="list"
				autocomplete="off"
				placeholder={$_('faq.search_placeholder')}
				class="w-full rounded-2xl border-2 border-ink-200 bg-white py-4 pe-4 ps-12 text-base shadow-morphit-card transition focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
			/>
		</div>

		{#if query && hits.length > 0}
			<div
				id="faq-results"
				role="listbox"
				class="absolute inset-x-0 z-30 mt-2 max-h-80 overflow-y-auto rounded-2xl border border-ink-200 bg-white shadow-morphit-card dark:border-ink-700 dark:bg-ink-900"
			>
				{#each hits.slice(0, 8) as hit, i (hit.entry.key)}
					<button
						type="button"
						role="option"
						aria-selected={i === activeIndex}
						class="flex w-full flex-col gap-1 border-b border-ink-100 px-4 py-3 text-start last:border-b-0 hover:bg-ink-50 dark:border-ink-800 dark:hover:bg-ink-800 {i ===
						activeIndex
							? 'bg-ink-50 dark:bg-ink-800'
							: ''}"
						onclick={() => {
							expanded.add(hit.entry.key);
							expanded = new Set(expanded);
							queueMicrotask(() => {
								document.getElementById(`faq-${hit.entry.key}`)?.scrollIntoView({
									behavior: 'smooth',
									block: 'center'
								});
							});
							query = '';
						}}
					>
						<span class="font-semibold">{hit.entry.question}</span>
						<span class="line-clamp-2 text-sm text-ink-500 dark:text-ink-400"
							>{hit.entry.answer}</span
						>
					</button>
				{/each}
			</div>
		{:else if query && hits.length === 0}
			<div
				class="absolute inset-x-0 z-30 mt-2 rounded-2xl border border-ink-200 bg-white p-4 text-center text-sm text-ink-500 shadow-morphit-card dark:border-ink-700 dark:bg-ink-900 dark:text-ink-400"
			>
				{$_('faq.no_results')}
			</div>
		{/if}
	</div>

	<ol class="mt-10 space-y-3">
		{#each $faqEntries as entry (entry.key)}
			{@const isOpen = expanded.has(entry.key)}
			{@const justCopied = copiedKey === entry.key}
			<li id="faq-{entry.key}" class="card p-0">
				<!--
					Inline-anchor target without the `faq-` prefix.  Many
					internal "Learn more →" links spell their target as
					`/faq#{key}` (without the prefix) because that's the
					mental model — the FAQ key, no boilerplate.  We emit
					both anchor forms so both work; the prefixed `<li>`
					id stays primary for backwards-compatibility with
					anyone who bookmarked the prefixed form.  Visually
					hidden, no layout impact.  See find-broken-anchors.py
					(audit BATCH19B Pass B).
				-->
				<span id={entry.key} class="sr-only" aria-hidden="true"></span>
				<!-- Row container: question/toggle on the left, inline
				     share icon on the right. Two sibling buttons rather
				     than nested — nested <button> is invalid HTML, and
				     keeping the share action at the same visual level as
				     the toggle makes it equally discoverable. -->
				<div class="flex items-start">
					<button
						type="button"
						class="flex flex-1 items-start justify-between gap-4 px-5 py-4 text-left"
						aria-expanded={isOpen}
						aria-controls="faq-body-{entry.key}"
						onclick={() => toggle(entry)}
					>
						<span class="font-display text-lg font-semibold">{entry.question}</span>
						<span
							class="mt-1 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-ink-100 text-ink-600 transition-transform dark:bg-ink-800 dark:text-ink-300 {isOpen
								? 'rotate-45'
								: ''}"
							aria-hidden="true"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="3"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M12 5v14M5 12h14" />
							</svg>
						</span>
					</button>
					<!-- Inline share icon: copies the deep-link to this
					     entry without needing to expand it first. Tap
					     target 44px square per mobile a11y guidelines. -->
					<button
						type="button"
						class="me-3 mt-3 flex h-11 w-11 flex-none items-center justify-center rounded-full text-ink-500 transition hover:bg-emerald-50 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400 dark:hover:bg-ink-800"
						aria-label={$_('faq.share_aria', { values: { question: entry.question } })}
						onclick={(e) => copyShareLink(entry, e)}
					>
						{#if justCopied}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="3"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
								class="text-morphit-emerald"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
						{:else}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<circle cx="18" cy="5" r="3" />
								<circle cx="6" cy="12" r="3" />
								<circle cx="18" cy="19" r="3" />
								<path d="m8.59 13.51 6.83 3.98" />
								<path d="m15.41 6.51-6.82 3.98" />
							</svg>
						{/if}
					</button>
				</div>
				{#if isOpen}
					<div
						id="faq-body-{entry.key}"
						class="animate-fade-up px-5 pb-5 text-ink-700 dark:text-ink-200"
					>
						<p class="whitespace-pre-line leading-relaxed">{entry.answer}</p>

						{#if entry.related.length > 0}
							<!-- ─── Related row ───
							     Shows pill chips for entries curated as related
							     in FAQ_RELATED. Clicking one expands the target
							     and scrolls it into view, without collapsing
							     the current entry.
							     a11y: wrapped in <nav> with aria-labelledby
							     pointing at the section heading, so the chips
							     announce as a navigation landmark. Each chip's
							     aria-label specifies the target question and
							     the "Open related FAQ" verb so screen readers
							     make the navigation intent clear. -->
							<nav
								class="mt-5 border-t border-ink-100 pt-4 dark:border-ink-800"
								aria-labelledby="faq-related-heading-{entry.key}"
							>
								<p
									id="faq-related-heading-{entry.key}"
									class="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400"
								>
									{$_('faq.related_label')}
								</p>
								<div class="flex flex-wrap gap-2">
									{#each entry.related as relKey (relKey)}
										{@const relEntry = entriesByKey.get(relKey)}
										{#if relEntry}
											<button
												type="button"
												class="inline-flex items-center rounded-full border border-morphit-emerald/40 bg-emerald-50 px-3 py-1 text-sm text-ink-800 transition hover:border-morphit-emerald hover:bg-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-morphit-emerald/50 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700"
												aria-label={$_('faq.related_open_aria', {
													values: { question: relEntry.question }
												})}
												onclick={() => goToRelated(relKey)}
											>
												{relEntry.question}
											</button>
										{/if}
									{/each}
								</div>
							</nav>
						{/if}

						<!-- ─── Share row ─── -->
						<div
							class="mt-5 flex items-center gap-2 border-t border-ink-100 pt-4 dark:border-ink-800"
						>
							<button
								type="button"
								class="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-semibold text-ink-700 transition hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200"
								aria-label={$_('faq.share_aria', { values: { question: entry.question } })}
								onclick={(e) => copyShareLink(entry, e)}
							>
								{#if justCopied}
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="3"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
										class="text-morphit-emerald"
									>
										<path d="M20 6 9 17l-5-5" />
									</svg>
									<span>{$_('faq.share_copied')}</span>
								{:else}
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<circle cx="18" cy="5" r="3" />
										<circle cx="6" cy="12" r="3" />
										<circle cx="18" cy="19" r="3" />
										<path d="m8.59 13.51 6.83 3.98" />
										<path d="m15.41 6.51-6.82 3.98" />
									</svg>
									<span>{$_('faq.share_link')}</span>
								{/if}
							</button>
							<p class="ms-2 text-xs text-ink-500 dark:text-ink-400">
								{$_('faq.share_hint')}
							</p>
						</div>
					</div>
				{/if}
			</li>
		{/each}
	</ol>

	<footer class="mt-10 text-center text-sm text-ink-500 dark:text-ink-400">
		<p>{$_('faq.still_need_help')}</p>
		<button type="button" class="btn-secondary mt-3" onclick={() => goto(lp('/support'))}>
			{$_('faq.contact_support')}
		</button>
	</footer>
</section>
