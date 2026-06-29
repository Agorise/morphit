<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { goto, afterNavigate } from '$app/navigation';
	import { browser } from '$app/environment';
	import { SvelteSet } from 'svelte/reactivity';
	import { tick } from 'svelte';
	import {
		faqEntries,
		searchEntries,
		type FaqHit,
		type FaqEntry,
		type FaqKey
	} from '$utils/faqIndex';
	import { SUPPORTED_LOCALES, setLocale, currentLocale, type LocaleCode } from '$i18n';
	import { renderFaqInline } from '$lib/faq/renderInline';
	import { stripMarkdown } from '$lib/seo/stripMarkdown';

	let query = $state('');
	let activeIndex = $state(0);
	let inputEl: HTMLInputElement;

	// Search ergonomics (cp314, Ken):
	//  - Don't search until at least 3 chars are typed (1–2 chars match
	//    almost everything and just flicker a useless dropdown).
	//  - Cap the field at 24 chars (a real FAQ query is a couple of words;
	//    longer is almost always a paste accident).
	const MIN_QUERY_LEN = 3;
	const MAX_QUERY_LEN = 24;

	// Subtle in-place highlight of the searched term(s) via the CSS Custom
	// Highlight API — paints over the already-rendered dropdown + article
	// text WITHOUT mutating the DOM (so it never touches the {@html} answer
	// markup). `highlightTerms` is what's currently painted; it tracks the
	// query while searching and PERSISTS through a result-click (query is
	// cleared to close the dropdown, but the article you jumped to stays
	// highlighted) until the next search or an explicit dismiss.
	const HIGHLIGHT_NAME = 'faq-search';
	let highlightTerms = $state<string[]>([]);

	/** Lowercased, de-duped query tokens (≥2 chars) to highlight. */
	function highlightTokens(q: string): string[] {
		const toks = q
			.toLowerCase()
			.split(/\s+/)
			.map((t) => t.trim())
			.filter((t) => t.length >= 2);
		return Array.from(new Set(toks));
	}

	// Auto-expanded entries (by key). A SvelteSet so .has()/.add()/.delete()
	// are reactive in every context — at mount (deep-link), in event
	// handlers (toggle / related-chip / search-hit), without the awkward
	// "mutate then reassign a fresh Set" dance the plain-$state pattern needs.
	const expanded = new SvelteSet<FaqKey>();

	// Per-entry "copied" toast state.
	let copiedKey = $state<FaqKey | null>(null);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

	// Gate on MIN_QUERY_LEN: 1–2 char queries return nothing (and show no
	// dropdown at all — not even an empty-state — see the template).
	const hits: FaqHit[] = $derived(
		query.trim().length >= MIN_QUERY_LEN ? searchEntries($faqEntries, query, Infinity) : []
	);
	const showDropdown = $derived(query.trim().length >= MIN_QUERY_LEN);

	/** Lookup map key → entry, used to resolve related-entry chips to
	 *  their localized question strings. Rebuilds when the locale
	 *  changes because $faqEntries does. */
	const entriesByKey: Map<FaqKey, FaqEntry> = $derived(new Map($faqEntries.map((e) => [e.key, e])));

	/**
	 * Handle deep links in three forms:
	 *   1. /faq#<key>             — legacy hash-based deep link (matches an entry key)
	 *   2. /faq?q=<key>&lang=<c>  — admin-share format (locale-aware)
	 *   3. /faq?q=<query>         — Google sitelinks-search-box format (cp119-A2)
	 *                                — when ?q= is NOT an entry key, treat as a
	 *                                free-text search query and populate the search
	 *                                box.  This makes the WebSite.SearchAction
	 *                                JSON-LD declaration (urlTemplate: /faq?q=...)
	 *                                actually functional.
	 */
	afterNavigate(() => {
		const params = $page.url.searchParams;
		const qKey = params.get('q');
		const lang = params.get('lang');

		// Switch locale first, if the shared link carries one AND it's a
		// locale we support AND it's different from the current one.
		if (lang && lang !== $currentLocale && SUPPORTED_LOCALES.some((l) => l.code === lang)) {
			void setLocale(lang as LocaleCode);
		}

		const target = qKey ?? $page.url.hash.replace(/^#/, '');
		if (!target) return;

		// Form 1 + 2: target matches an FAQ entry key — expand + scroll.
		// This runs in afterNavigate (not a $effect) for two reasons: the
		// scroll must land AFTER SvelteKit's post-navigation scroll reset
		// (a ?q= link is a normal navigation, so SvelteKit otherwise yanks
		// the page to the top right after we scroll — the bug that made the
		// footer AGPL link land at the top instead of the article), and an
		// effect would re-fire on a locale switch and re-yank an already-open
		// entry back into view. cp338.
		const found = $faqEntries.find((e) => e.key === target);
		if (found) {
			expanded.add(found.key);
			void scrollToEntry(found.key);
			return;
		}

		// Form 3 (cp119-A2): target is NOT an entry key.  When it
		// came from ?q= (not from #hash), treat it as a search
		// query and populate the search box.  This is the Google
		// sitelinks-search-box workflow — a user types "monero
		// privacy" in the SERP search box, lands here, sees their
		// query already in the search input + relevant FAQ
		// matches surfaced.  We skip this for hash deep-links
		// since "/faq#unknown-key" is intentionally a no-op.
		if (qKey) {
			query = qKey;
			// Focus the input so the user can refine the query without
			// having to click it first.  Defer so the input is in the DOM.
			void tick().then(() => inputEl?.focus());
		}
	});

	/** Smooth-scroll a (now-expanded) FAQ entry to the top of the viewport.
	 *  `tick()` waits for the expanded answer to render so the target sits
	 *  at its final height; a double rAF then lets layout settle. When
	 *  called from afterNavigate (the ?q= deep link) this also lands after
	 *  SvelteKit's post-navigation scroll reset. Shared by the deep-link
	 *  handler, the related-entry chips, and search-result clicks. cp338. */
	async function scrollToEntry(key: FaqKey): Promise<void> {
		await tick();
		const align = (): void => {
			document.getElementById(`faq-${key}`)?.scrollIntoView({
				behavior: 'smooth',
				block: 'start'
			});
		};
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				align();
				// A long article low on a freshly-mounted, still-laying-out page
				// (e.g. the footer "API" deep link → wallet_developer_api, in
				// section 10 with a tall answer) can leave this first smooth
				// scroll SHORT of the target: when the scroll starts the entry's
				// final Y isn't settled — articles above are still being laid
				// out / images are still resolving — so the page shifts under the
				// animation and it lands above the entry. Re-align once layout has
				// settled, but ONLY if we're actually off target (>8px from the
				// top), so a first scroll that already landed isn't re-animated
				// and the user isn't yanked if they're already where they want.
				setTimeout(() => {
					const el = document.getElementById(`faq-${key}`);
					if (el && Math.abs(el.getBoundingClientRect().top) > 8) align();
				}, 400);
			});
		});
	}

	function toggle(entry: FaqEntry): void {
		if (expanded.has(entry.key)) expanded.delete(entry.key);
		else expanded.add(entry.key);
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
		const url = new URL(window.location.href);
		url.searchParams.set('q', targetKey);
		url.searchParams.set('lang', $currentLocale);
		url.hash = '';
		history.replaceState(null, '', url.toString());
		void scrollToEntry(targetKey);
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
		if (e.key === 'Escape') {
			query = '';
			activeIndex = 0;
			highlightTerms = [];
			return;
		}
		// Enter is intentionally disabled in the FAQ search. It used to jump the
		// page to the first result (hits[activeIndex]; activeIndex resets to 0 on
		// every keystroke), which felt like scrolling to a random location.
		// Selection is now click/tap-only — the user picks an entry from the
		// dropdown below. preventDefault stops the keypress from triggering any
		// implicit form submit or the browser's native type="search" behavior.
		if (e.key === 'Enter') {
			e.preventDefault();
			return;
		}
		if (!hits.length) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, hits.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
		}
	}

	$effect(() => {
		void query;
		activeIndex = 0;
	});

	// Track what to highlight. While a real search is active (≥ MIN chars)
	// the terms mirror the query. When the query drops below MIN — including
	// the query = '' a result-click does to close the dropdown — we leave
	// `highlightTerms` untouched, so the article you jumped to stays
	// highlighted. A new ≥ MIN search overwrites them (clear-then-rehighlight
	// is automatic: the applier rebuilds the highlight from scratch); Escape
	// clears them outright.
	$effect(() => {
		const q = query.trim();
		if (q.length >= MIN_QUERY_LEN) highlightTerms = highlightTokens(q);
	});

	/** Paint `highlightTerms` over the dropdown + every expanded article
	 *  using the CSS Custom Highlight API. No DOM mutation — it adds Ranges
	 *  to a document-level highlight, so it works over the {@html} answer
	 *  markup and is trivially cleared by replacing the highlight. Feature-
	 *  detected: where the API is absent (older browsers) it's a silent
	 *  no-op and search still works. */
	function applySearchHighlight(): void {
		if (!browser) return;
		if (
			typeof CSS === 'undefined' ||
			!CSS.highlights ||
			typeof Highlight === 'undefined' ||
			typeof Range === 'undefined'
		)
			return;
		CSS.highlights.delete(HIGHLIGHT_NAME);
		const terms = highlightTerms;
		if (terms.length === 0) return;

		const roots: Element[] = [];
		const dropdown = document.getElementById('faq-results');
		if (dropdown) roots.push(dropdown);
		for (const key of expanded) {
			const li = document.getElementById(`faq-${key}`);
			if (li) roots.push(li);
		}
		if (roots.length === 0) return;

		const ranges: Range[] = [];
		for (const root of roots) {
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let node: Node | null;
			while ((node = walker.nextNode())) {
				const text = node.nodeValue ?? '';
				if (!text.trim()) continue;
				const lower = text.toLowerCase();
				for (const term of terms) {
					let idx = lower.indexOf(term);
					while (idx !== -1) {
						const r = new Range();
						r.setStart(node, idx);
						r.setEnd(node, idx + term.length);
						ranges.push(r);
						idx = lower.indexOf(term, idx + term.length);
					}
				}
			}
		}
		if (ranges.length > 0) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
	}

	// Re-paint after the DOM settles whenever the terms, the dropdown
	// contents, or the set of expanded articles change. rAF defers past
	// Svelte's flush so the just-rendered dropdown / just-expanded article
	// is in the DOM when we walk it.
	$effect(() => {
		void highlightTerms;
		void hits;
		void Array.from(expanded).join('|');
		if (!browser) return;
		const raf = requestAnimationFrame(() => applySearchHighlight());
		return () => cancelAnimationFrame(raf);
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

	{#if query}
		<button
			type="button"
			aria-label={$_('faq.search_dismiss')}
			onclick={() => (query = '')}
			class="fixed inset-0 z-20 cursor-default bg-ink-900/5 backdrop-blur-sm"
		></button>
	{/if}
	<div class="relative z-30 mx-auto w-full sm:w-3/4">
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
				maxlength={MAX_QUERY_LEN}
				aria-expanded={showDropdown && hits.length > 0}
				aria-controls="faq-results"
				aria-autocomplete="list"
				autocomplete="off"
				placeholder={$_('faq.search_placeholder')}
				class="w-full rounded-2xl border-2 border-ink-200 bg-white py-4 pe-4 ps-12 text-base shadow-morphit-card transition hover:border-ink-300 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900 dark:hover:border-white/15"
			/>
		</div>

		{#if showDropdown && hits.length > 0}
			<div
				id="faq-results"
				role="listbox"
				class="absolute inset-x-0 z-30 mt-2 max-h-80 overflow-y-auto rounded-2xl border border-ink-200 bg-white shadow-morphit-card dark:border-ink-700 dark:bg-ink-900"
			>
				{#each hits as hit, i (hit.entry.key)}
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
							query = '';
							void scrollToEntry(hit.entry.key);
						}}
					>
						<span class="font-semibold">{hit.entry.question}</span>
						<span class="line-clamp-2 text-sm text-ink-500 dark:text-ink-400"
							>{stripMarkdown(hit.entry.answer)}</span
						>
					</button>
				{/each}
			</div>
		{:else if showDropdown && hits.length === 0}
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
			<li
				id="faq-{entry.key}"
				class="card hover-subtle scroll-mt-24 p-0 hover:border-morphit-emerald/20 hover:bg-emerald-50/30 dark:hover:border-morphit-emerald/15 dark:hover:bg-morphit-emerald/[0.05]"
			>
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
						<p class="whitespace-pre-line leading-relaxed">{@html renderFaqInline(entry.answer)}</p>

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
								class="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-semibold text-ink-700 transition hover:border-morphit-emerald hover:bg-emerald-50 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-ink-800"
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
		<div class="mt-3 flex flex-wrap items-center justify-center gap-3">
			<button type="button" class="btn-secondary" onclick={() => goto(lp('/support'))}>
				{$_('faq.contact_support')}
			</button>
			<a
				class="btn-secondary inline-flex items-center gap-2"
				href="https://matrix.to/#/#agorise:matrix.org"
				rel="noopener noreferrer"
				target="_blank"
			>
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
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
				</svg>
				<span>{$_('faq.matrix_room_cta')}</span>
			</a>
		</div>
		<p class="mt-2 text-xs">{$_('faq.matrix_room_blurb')}</p>
	</footer>
</section>

<style>
	/*
		Very subtle search highlight (cp314). Painted via the CSS Custom
		Highlight API — ::highlight() is document-global (it can't be scoped
		to a component or under the app's class-based .dark), and it only
		accepts a tiny set of properties (color, background-color, text-
		decoration, text-shadow). A low-opacity morphit-emerald tint reads
		gently on both the light and dark surfaces. :global() because the
		highlight pseudo lives on the document, not this component's subtree.
	*/
	:global(::highlight(faq-search)) {
		background-color: rgba(16, 185, 129, 0.28);
	}
</style>
