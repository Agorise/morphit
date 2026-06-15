<!--
	Morphit block explorer — landing / search page.

	Public.  No login required, lazy-loaded as a separate route
	chunk.  The user types a search term (Blurt account, trx_id, or
	block number) and gets routed to the appropriate detail page.

	This page is the frontmost surface of the explorer.  Tone is
	functional, not flashy — explorers are tools, not entertainment.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import { parseSearchInput, type ParsedSearchTarget } from '$lib/explorer/search';
	import {
		morphitExplorerAccountUrl,
		morphitExplorerTxUrl,
		morphitExplorerBlockUrl
	} from '$lib/explorer/urls';
	import Head from '$components/Head.svelte';

	let raw = $state('');
	let lastError = $state<string | null>(null);

	function submit(): void {
		lastError = null;
		const parsed: ParsedSearchTarget = parseSearchInput(raw);
		switch (parsed.kind) {
			case 'account': {
				const url = morphitExplorerAccountUrl(parsed.account);
				if (url) void goto(lp(url));
				else lastError = $_('explorer.search.error_invalid');
				return;
			}
			case 'txid': {
				const url = morphitExplorerTxUrl(parsed.txid);
				if (url) void goto(lp(url));
				else lastError = $_('explorer.search.error_invalid');
				return;
			}
			case 'block': {
				const url = morphitExplorerBlockUrl(parsed.blockNumber);
				if (url) void goto(lp(url));
				else lastError = $_('explorer.search.error_invalid');
				return;
			}
			case 'unknown':
				lastError = $_('explorer.search.error_unknown');
				return;
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter') submit();
	}

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="explorer_search" />

<section class="mx-auto max-w-3xl px-4 py-12">
	<header class="mb-8">
		<h1 class="font-display text-3xl font-bold">
			<span class="brand-gradient-text">{$_('explorer.search.heading')}</span>
		</h1>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('explorer.search.subheading')}
		</p>
	</header>

	<div class="card">
		<label for="search" class="mb-2 block text-sm font-semibold">
			{$_('explorer.search.label')}
		</label>
		<div class="flex gap-2">
			<input
				id="search"
				type="text"
				bind:value={raw}
				onkeydown={onKeydown}
				placeholder={$_('explorer.search.placeholder')}
				class="flex-1 rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
				autocomplete="off"
				autocapitalize="off"
				autocorrect="off"
				spellcheck="false"
			/>
			<button
				type="button"
				onclick={submit}
				class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98]"
			>
				{$_('explorer.search.submit')}
			</button>
		</div>
		<p class="mt-2 text-xs text-ink-500 dark:text-ink-400">
			{$_('explorer.search.hint')}
		</p>

		{#if lastError}
			<p class="mt-3 text-sm text-amber-700 dark:text-amber-300">
				{lastError}
			</p>
		{/if}
	</div>

	<aside class="mt-8 grid gap-4 sm:grid-cols-3">
		<a href={lp('/explorer/activity')} class="card transition hover:border-morphit-emerald">
			<h2 class="font-display text-base font-bold">
				{$_('explorer.nav.activity_title')}
			</h2>
			<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
				{$_('explorer.nav.activity_description')}
			</p>
		</a>
		<a
			href="https://blocks.blurtwallet.com"
			target="_blank"
			rel="noopener noreferrer"
			class="card transition hover:border-morphit-emerald"
		>
			<h2 class="font-display text-base font-bold">
				{$_('explorer.nav.fallback_title')} ↗
			</h2>
			<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
				{$_('explorer.nav.fallback_description')}
			</p>
		</a>
		<a href="/" class="card transition hover:border-morphit-emerald">
			<h2 class="font-display text-base font-bold">
				{$_('explorer.nav.home_title')}
			</h2>
			<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
				{$_('explorer.nav.home_description')}
			</p>
		</a>
	</aside>
</section>
