<!--
	Morphit block explorer — transaction view.

	Route: /explorer/tx/[id]

	Public.  Shows a Blurt transaction's:
	  • trx_id, block_num, timestamp, signers.
	  • Decoded operations with Morphit-aware decoration where
	    possible, raw JSON (collapsed) for everything else.

	Note: not all Blurt RPC nodes expose `get_transaction` (it
	requires the tx-index plugin).  When the lookup fails, we
	surface a friendly fallback to blocks.blurtwallet.com.

	No polling — transactions are immutable once produced.
-->
<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import type { BlurtTransaction } from '$blurt/client';
	import { fetchChainTx } from '$blurt/chainExplorer';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { decorateOp } from '$lib/explorer/decorate';
	import { morphitExplorerBlockUrl, blurtWalletExplorerFallbackUrl } from '$lib/explorer/urls';
	import Head from '$components/Head.svelte';

	const trxId = $derived($page.params.id!);

	type Status = 'loading' | 'ok' | 'not_found' | 'error';
	let status = $state<Status>('loading');
	let errorMsg = $state('');
	let tx = $state<BlurtTransaction | null>(null);
	let expandedOps = $state<Record<number, boolean>>({});

	async function load(): Promise<void> {
		status = 'loading';
		try {
			// Transaction via the indexer (privacy: no direct RPC from the
			// browser; also more reliable — the pool finds a node that
			// exposes get_transaction).
			const r = await fetchChainTx(resolveOrigin(MORPHIT_INDEXER_ORIGIN), trxId);
			if (r.kind === 'not_found') {
				status = 'not_found';
				return;
			}
			if (r.kind !== 'ok') throw new Error(r.message);
			tx = r.tx;
			status = 'ok';
		} catch (err) {
			console.warn('[explorer/tx] load failed:', err);
			errorMsg = $_('explorer.tx.error.load_failed');
			status = 'error';
		}
	}

	onMount(() => {
		void load();
	});

	function toggleOp(i: number): void {
		expandedOps = { ...expandedOps, [i]: !expandedOps[i] };
	}

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="explorer_tx" titleValues={{ trx: trxId.slice(0, 10) }} />

<section class="mx-auto max-w-4xl px-4 py-8">
	<nav class="mb-4 text-sm">
		<a href={lp('/explorer')} class="text-white hover:text-morphit-emerald">
			<span class="nav-arrow nav-arrow-left" aria-hidden="true">⇦</span>
			{$_('explorer.nav.back_to_search')}
		</a>
	</nav>

	{#if status === 'loading'}
		<p class="text-ink-500">{$_('explorer.tx.loading')}</p>
	{:else if status === 'not_found'}
		<div class="card">
			<h1 class="font-display text-xl font-bold">
				{$_('explorer.tx.not_found_title')}
			</h1>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('explorer.tx.not_found_body')}
			</p>
			<a
				href={blurtWalletExplorerFallbackUrl('tx', trxId)}
				target="_blank"
				rel="noopener noreferrer"
				class="mt-3 inline-block text-sm font-semibold underline-offset-2 hover:underline"
			>
				{$_('explorer.tx.try_fallback')} ↗
			</a>
		</div>
	{:else if status === 'error'}
		<div class="card">
			<h1 class="font-display text-xl font-bold">
				{$_('explorer.tx.error_title')}
			</h1>
			<p class="mt-2 text-sm text-red-700 dark:text-red-300">
				{errorMsg}
			</p>
		</div>
	{:else if tx}
		<header class="mb-6">
			<h1 class="font-display text-2xl font-bold">
				{$_('explorer.tx.heading')}
			</h1>
			<p class="mt-1 break-all font-mono text-xs text-ink-500">
				{trxId}
			</p>
		</header>

		<dl class="card mb-6 grid gap-3 sm:grid-cols-2">
			{#if tx.block_num}
				{@const blockUrl = morphitExplorerBlockUrl(tx.block_num)}
				<div>
					<dt class="text-xs text-ink-500 dark:text-ink-400">
						{$_('explorer.tx.block_label')}
					</dt>
					<dd class="font-mono text-sm">
						<a
							href={blockUrl ? lp(blockUrl) : '#'}
							class="text-morphit-emerald underline-offset-2 hover:underline"
						>
							{tx.block_num}
						</a>
					</dd>
				</div>
			{/if}
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('explorer.tx.expiration_label')}
				</dt>
				<dd class="font-mono text-sm">
					{typeof tx.expiration === 'string' ? `${tx.expiration}Z` : '—'}
				</dd>
			</div>
			<div class="sm:col-span-2">
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('explorer.tx.signatures_label', { values: { n: tx.signatures?.length ?? 0 } })}
				</dt>
				<dd class="space-y-1 font-mono text-xs">
					{#each tx.signatures ?? [] as sig}
						<div class="break-all">{sig}</div>
					{/each}
				</dd>
			</div>
		</dl>

		<section>
			<h2 class="mb-3 font-display text-base font-bold">
				{$_('explorer.tx.operations_heading')}
			</h2>
			<ul class="space-y-3">
				{#each tx.operations ?? [] as op, i}
					{@const dec = decorateOp(op[0], op[1])}
					<li class="card">
						<div class="flex items-baseline justify-between gap-2">
							<span
								class="rounded-md px-2 py-0.5 text-xs font-semibold {dec.isMorphitOp
									? 'bg-morphit-emerald/15 text-morphit-emerald'
									: 'bg-ink-200 text-ink-700 dark:bg-ink-800 dark:text-ink-200'}"
							>
								{$_(`explorer.op.label.${dec.labelKey}`)}
							</span>
							<button
								type="button"
								onclick={() => toggleOp(i)}
								class="text-xs font-semibold text-morphit-emerald underline-offset-2 hover:underline"
							>
								{expandedOps[i] ? $_('explorer.tx.hide_raw') : $_('explorer.tx.show_raw')}
							</button>
						</div>
						{#if expandedOps[i]}
							<pre
								class="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-ink-100 p-3 font-mono text-xs dark:bg-ink-900">{JSON.stringify(
									op[1],
									null,
									2
								)}</pre>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</section>
