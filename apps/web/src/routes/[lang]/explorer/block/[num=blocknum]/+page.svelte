<!--
	Morphit block explorer — block view.

	Route: /explorer/block/[num]

	Public.  Shows a Blurt block's:
	  • Number, ID, timestamp, witness, previous-block link.
	  • All transactions in the block.
	  • Decoded ops within each transaction (Morphit-aware where
	    possible, raw JSON otherwise).

	No polling on this page — blocks are immutable once produced.
	If the user is viewing a future block (block number > head),
	we surface "block doesn't exist yet" gracefully.
-->
<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { getBlurtClient, type BlurtBlock } from '$blurt/client';
	import { decorateOp } from '$lib/explorer/decorate';
	import {
		morphitExplorerTxUrl,
		morphitExplorerBlockUrl,
		blurtWalletExplorerFallbackUrl
	} from '$lib/explorer/urls';
	import Head from '$components/Head.svelte';

	const blockNumber = $derived(parseInt($page.params.num!, 10));

	type Status = 'loading' | 'ok' | 'not_found' | 'error';
	let status = $state<Status>('loading');
	let errorMsg = $state('');
	let block = $state<BlurtBlock | null>(null);

	async function load(): Promise<void> {
		status = 'loading';
		try {
			const client = getBlurtClient();
			const result = await client.getBlock(blockNumber);
			if (!result) {
				status = 'not_found';
				return;
			}
			block = result;
			status = 'ok';
		} catch (err) {
			console.warn('[explorer/block] load failed:', err);
			errorMsg = $_('explorer.block.error.load_failed');
			status = 'error';
		}
	}

	onMount(() => {
		void load();
	});

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head
	routeKey="explorer_block"
	titleValues={{ block: blockNumber }}
	descriptionValues={{ block: blockNumber }}
/>

<section class="mx-auto max-w-4xl px-4 py-8">
	<nav class="mb-4 text-sm">
		<a href={lp('/explorer')} class="text-ink-500 hover:text-morphit-emerald dark:text-ink-400">
			← {$_('explorer.nav.back_to_search')}
		</a>
	</nav>

	{#if status === 'loading'}
		<p class="text-ink-500">{$_('explorer.block.loading')}</p>
	{:else if status === 'not_found'}
		<div class="card">
			<h1 class="font-display text-xl font-bold">
				{$_('explorer.block.not_found_title')}
			</h1>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('explorer.block.not_found_body', { values: { block: blockNumber } })}
			</p>
			<a
				href={blurtWalletExplorerFallbackUrl('block', blockNumber)}
				target="_blank"
				rel="noopener noreferrer"
				class="mt-3 inline-block text-sm font-semibold underline-offset-2 hover:underline"
			>
				{$_('explorer.block.try_fallback')} ↗
			</a>
		</div>
	{:else if status === 'error'}
		<div class="card">
			<h1 class="font-display text-xl font-bold">
				{$_('explorer.block.error_title')}
			</h1>
			<p class="mt-2 text-sm text-amber-700 dark:text-amber-300">
				{errorMsg}
			</p>
		</div>
	{:else if block}
		<header class="mb-6">
			<h1 class="font-display text-2xl font-bold">
				{$_('explorer.block.heading', { values: { block: blockNumber } })}
			</h1>
		</header>

		<dl class="card mb-6 grid gap-3 sm:grid-cols-2">
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('explorer.block.timestamp_label')}
				</dt>
				<dd class="font-mono text-sm">
					{typeof block.timestamp === 'string' ? `${block.timestamp}Z` : '—'}
				</dd>
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('explorer.block.witness_label')}
				</dt>
				<dd class="font-mono text-sm">
					<a
						href={lp(`/explorer/account/${block.witness}`)}
						class="text-morphit-emerald underline-offset-2 hover:underline"
					>
						@{block.witness}
					</a>
				</dd>
			</div>
			<div class="sm:col-span-2">
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('explorer.block.id_label')}
				</dt>
				<dd class="break-all font-mono text-xs">{block.block_id}</dd>
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('explorer.block.previous_label')}
				</dt>
				<dd class="font-mono text-xs">
					{#if blockNumber > 1}
						<a
							href={morphitExplorerBlockUrl(blockNumber - 1) ?? '#'}
							class="text-morphit-emerald underline-offset-2 hover:underline"
						>
							{$_('explorer.block.previous_link', { values: { block: blockNumber - 1 } })}
						</a>
					{:else}
						—
					{/if}
				</dd>
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('explorer.block.tx_count_label')}
				</dt>
				<dd class="font-mono text-sm">{block.transactions?.length ?? 0}</dd>
			</div>
		</dl>

		<section>
			<h2 class="mb-3 font-display text-base font-bold">
				{$_('explorer.block.transactions_heading')}
			</h2>
			{#if !block.transactions || block.transactions.length === 0}
				<p class="card text-sm text-ink-500">
					{$_('explorer.block.no_transactions')}
				</p>
			{:else}
				<ul class="space-y-3">
					{#each block.transactions as tx, txIdx}
						{@const trxId = block.transaction_ids[txIdx]}
						<li class="card">
							<div class="mb-2 flex items-baseline justify-between">
								<span class="text-xs text-ink-500 dark:text-ink-400">
									{$_('explorer.block.tx_index', { values: { i: txIdx + 1 } })}
								</span>
								{#if trxId}
									<a
										href={morphitExplorerTxUrl(trxId) ?? '#'}
										class="font-mono text-xs text-morphit-emerald underline-offset-2 hover:underline"
									>
										{trxId.slice(0, 10)}…
									</a>
								{/if}
							</div>
							<ul class="space-y-2">
								{#each tx.operations ?? [] as op}
									{@const dec = decorateOp(op[0], op[1])}
									<li class="flex items-baseline gap-2">
										<span
											class="rounded-md px-2 py-0.5 text-xs font-semibold {dec.isMorphitOp
												? 'bg-morphit-emerald/15 text-morphit-emerald'
												: 'bg-ink-200 text-ink-700 dark:bg-ink-800 dark:text-ink-200'}"
										>
											{$_(`explorer.op.label.${dec.labelKey}`)}
										</span>
									</li>
								{/each}
							</ul>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</section>
