<!--
	Morphit block explorer — account view.

	Route: /explorer/account/[name]

	Public.  Shows a Blurt account's:
	  • Identity (account name, identicon, current posting pubkey).
	  • Liquid balance, BP, MANA.
	  • Recent operations (custom_json + transfers + a few others),
	    decorated with Morphit-aware labels where applicable.
	  • Pagination via "load more" button.

	Real-time: polls every 5 seconds for new ops while the tab is
	visible.  Visibility-aware (no polling when the page is in
	background).

	Lazy-loaded by virtue of being a separate route chunk.
-->
<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { getBlurtClient } from '$blurt/client';
	import {
		parseAssetAmount,
		vestsToBlurtPower,
		manaPercentage,
		formatBalance,
		formatPercentage
	} from '$blurt/balanceMath';
	import { decorateOp } from '$lib/explorer/decorate';
	import {
		morphitExplorerTxUrl,
		morphitExplorerBlockUrl,
		blurtWalletExplorerFallbackUrl
	} from '$lib/explorer/urls';
	import { identiconDataUri } from '$crypto/identicon';
	import Head from '$components/Head.svelte';

	// name is a route parameter; always defined when this page
	// renders.  The non-null assertion is safe because SvelteKit
	// would not have routed here without it.
	const account = $derived($page.params.name!);

	type Status = 'loading' | 'ok' | 'not_found' | 'error';
	let status = $state<Status>('loading');
	let errorMsg = $state('');

	let blurt = $state(NaN);
	let bp = $state(NaN);
	let mana = $state(NaN);
	let postingPub = $state<string | null>(null);

	interface OpRow {
		readonly seq: number;
		readonly block: number;
		readonly trxId: string;
		readonly timestamp: string;
		readonly opName: string;
		readonly opBody: Record<string, unknown>;
	}
	let ops = $state<OpRow[]>([]);
	let oldestSeqLoaded = $state<number | null>(null);
	let loadingMore = $state(false);

	const POLL_MS_BASE = 5_000;
	/** Sally finding M9 (Part 68): backoff cap.  Five seconds is
	 *  fine when activity is happening, but a Sally watching her
	 *  own account that's been idle for an hour shouldn't be
	 *  hitting the indexer 720 times per hour for nothing.  Cap
	 *  at 60s when there's been no new op for several polls.
	 *  Reset to base on any new op. */
	const POLL_MS_MAX = 60_000;
	const PAGE_SIZE = 50;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	/** Current poll interval, may grow up to POLL_MS_MAX while
	 *  the account is idle. */
	let currentPollMs = POLL_MS_BASE;

	async function loadInitial(): Promise<void> {
		status = 'loading';
		try {
			const client = getBlurtClient();
			const [acct, dgp] = await Promise.all([
				client.getAccount(account),
				client.getDynamicGlobalProperties()
			]);
			if (!acct) {
				status = 'not_found';
				return;
			}
			if (acct.name !== account) {
				throw new Error(`RPC returned ${acct.name} but ${account} was requested`);
			}
			blurt = parseAssetAmount(acct.balance);
			bp = vestsToBlurtPower(
				acct.vesting_shares ?? '0 VESTS',
				dgp.total_vesting_fund_blurt,
				dgp.total_vesting_shares
			);
			mana = manaPercentage(
				acct.voting_manabar ?? null,
				acct.vesting_shares ?? '0 VESTS',
				Math.floor(Date.now() / 1000)
			);
			// Account.posting is an Authority object; extract the
			// first key for display.
			const keyAuths = acct.posting?.key_auths;
			if (Array.isArray(keyAuths) && keyAuths[0] && typeof keyAuths[0][0] === 'string') {
				postingPub = keyAuths[0][0];
			}

			// First page of history.
			await fetchHistory(-1);
			status = 'ok';
		} catch (err) {
			console.warn('[explorer/account] account load failed:', err);
			errorMsg = $_('explorer.account.error.load_failed');
			status = 'error';
		}
	}

	async function fetchHistory(from: number): Promise<void> {
		const client = getBlurtClient();
		// condenser_api.get_account_history shape:
		//   [seq, { block, trx_id, timestamp, op: [name, body] }]
		type HistoryEntry = [
			number,
			{ block: number; trx_id: string; timestamp: string; op: [string, Record<string, unknown>] }
		];
		const history = await client.call<HistoryEntry[]>('condenser_api.get_account_history', [
			account,
			from,
			PAGE_SIZE
		]);
		if (!Array.isArray(history)) return;

		const newOps: OpRow[] = [];
		for (const entry of history) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [seq, hop] = entry;
			if (typeof seq !== 'number') continue;
			if (!hop || !Array.isArray(hop.op) || hop.op.length !== 2) continue;
			newOps.push({
				seq,
				block: hop.block,
				trxId: hop.trx_id,
				timestamp: typeof hop.timestamp === 'string' ? hop.timestamp : '',
				opName: String(hop.op[0]),
				opBody: hop.op[1] ?? {}
			});
		}
		// History returns oldest-first; sort newest-first for
		// display.
		newOps.sort((a, b) => b.seq - a.seq);

		if (from === -1) {
			// Initial load OR poll-refresh: replace OR merge?
			// Replace if first call; merge new on subsequent polls
			// based on seq numbers we haven't seen.
			if (ops.length === 0) {
				ops = newOps;
			} else {
				const knownMaxSeq = ops[0]?.seq ?? -1;
				const fresher = newOps.filter((o) => o.seq > knownMaxSeq);
				if (fresher.length > 0) {
					ops = [...fresher, ...ops];
				}
			}
			if (newOps.length > 0) {
				const oldest = newOps[newOps.length - 1]!.seq;
				if (oldestSeqLoaded === null || oldest < oldestSeqLoaded) {
					oldestSeqLoaded = oldest;
				}
			}
		} else {
			// "Load more" — append older ops.
			ops = [...ops, ...newOps];
			if (newOps.length > 0) {
				oldestSeqLoaded = newOps[newOps.length - 1]!.seq;
			}
		}
	}

	async function loadMore(): Promise<void> {
		if (oldestSeqLoaded === null || oldestSeqLoaded <= 0 || loadingMore) return;
		loadingMore = true;
		try {
			await fetchHistory(oldestSeqLoaded - 1);
		} catch (err) {
			console.warn('[explorer/account] load-more failed:', err);
			errorMsg = $_('explorer.account.error.load_more_failed');
		} finally {
			loadingMore = false;
		}
	}

	function schedulePoll(): void {
		if (pollTimer) return;
		// Sally finding M9 (Part 68): recursive setTimeout instead
		// of setInterval so we can vary the interval based on
		// activity.  Pre-Part-68 this hammered every 5s forever
		// regardless of whether anything was happening.  When the
		// account is idle (no new op since last poll), the
		// interval grows; on any new op the interval resets to
		// POLL_MS_BASE.  Visibility-aware: hidden tabs skip the
		// fetch but still re-arm the timer at the current interval.
		pollTimer = setTimeout(async () => {
			pollTimer = null;
			if (typeof document !== 'undefined' && document.hidden) {
				schedulePoll();
				return;
			}
			const opCountBefore = ops.length;
			await fetchHistory(-1);
			if (ops.length > opCountBefore) {
				// Activity — snap back to base interval.
				currentPollMs = POLL_MS_BASE;
			} else {
				// No new ops — back off, capped.
				currentPollMs = Math.min(currentPollMs * 2, POLL_MS_MAX);
			}
			schedulePoll();
		}, currentPollMs);
	}

	function startPolling(): void {
		currentPollMs = POLL_MS_BASE;
		schedulePoll();
	}

	function stopPolling(): void {
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
	}

	onMount(() => {
		void loadInitial().then(() => {
			if (status === 'ok') startPolling();
		});
	});

	onDestroy(stopPolling);

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="explorer_account" titleValues={{ account }} descriptionValues={{ account }} />

<section class="mx-auto max-w-4xl px-4 py-8">
	<nav class="mb-4 text-sm">
		<a href={lp('/explorer')} class="text-ink-500 hover:text-morphit-emerald dark:text-ink-400">
			← {$_('explorer.nav.back_to_search')}
		</a>
	</nav>

	{#if status === 'loading'}
		<p class="text-ink-500">{$_('explorer.account.loading')}</p>
	{:else if status === 'not_found'}
		<div class="card">
			<h1 class="font-display text-xl font-bold">
				{$_('explorer.account.not_found_title')}
			</h1>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('explorer.account.not_found_body', { values: { account } })}
			</p>
			<a
				href={blurtWalletExplorerFallbackUrl('account', account)}
				target="_blank"
				rel="noopener noreferrer"
				class="mt-3 inline-block text-sm font-semibold underline-offset-2 hover:underline"
			>
				{$_('explorer.account.try_fallback')} ↗
			</a>
		</div>
	{:else if status === 'error'}
		<div class="card">
			<h1 class="font-display text-xl font-bold">
				{$_('explorer.account.error_title')}
			</h1>
			<p class="mt-2 text-sm text-amber-700 dark:text-amber-300">
				{errorMsg}
			</p>
		</div>
	{:else}
		<header class="mb-6 flex items-center gap-4">
			<!-- Sally finding L9 was investigated and reverted: the
			     profile page (`/@account`) also seeds the hero
			     identicon from account-name bytes, not the posting
			     pubkey.  Switching the explorer to pubkey-seeding
			     would make the explorer's identicon differ from the
			     profile's instead of matching it.  The deeper
			     inconsistency is between IdentityLabel (pubkey-
			     seeded for bytes-when-known) and the public surfaces
			     (always name-seeded) — that's a systemic ratification
			     for a future pass, not a Part 68 fix.  Documented in
			     REVISIT-LIST.md. -->
			<img
				src={identiconDataUri(new TextEncoder().encode(account))}
				alt=""
				class="h-16 w-16 rounded-xl"
			/>
			<div>
				<h1 class="font-display text-2xl font-bold">@{account}</h1>
				<a
					href="/@{account}"
					class="text-sm text-ink-500 hover:text-morphit-emerald dark:text-ink-400"
				>
					{$_('explorer.account.view_profile_link')} →
				</a>
			</div>
		</header>

		<dl class="card mb-6 grid grid-cols-3 gap-3">
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('profile.my_balance.blurt_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold">{formatBalance(blurt)}</dd>
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('profile.my_balance.bp_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold">{formatBalance(bp)}</dd>
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('profile.my_balance.mana_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold">{formatPercentage(mana)}</dd>
			</div>
		</dl>

		{#if postingPub}
			<dl class="card mb-6">
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('explorer.account.posting_pubkey_label')}
				</dt>
				<dd class="break-all font-mono text-xs">{postingPub}</dd>
			</dl>
		{/if}

		<section class="card">
			<h2 class="mb-3 font-display text-base font-bold">
				{$_('explorer.account.recent_ops_heading')}
				<span class="ml-2 text-xs font-normal text-ink-500">
					({$_('explorer.account.realtime_label')})
				</span>
			</h2>
			{#if ops.length === 0}
				<p class="text-sm text-ink-500">{$_('explorer.account.no_ops')}</p>
			{:else}
				<ul class="divide-y divide-ink-200 dark:divide-ink-800">
					{#each ops as op (op.seq)}
						{@const dec = decorateOp(op.opName, op.opBody)}
						<li class="py-3">
							<div class="flex items-baseline justify-between gap-2">
								<span
									class="rounded-md px-2 py-0.5 text-xs font-semibold {dec.isMorphitOp
										? 'bg-morphit-emerald/15 text-morphit-emerald'
										: 'bg-ink-200 text-ink-700 dark:bg-ink-800 dark:text-ink-200'}"
								>
									{$_(`explorer.op.label.${dec.labelKey}`)}
								</span>
								<time class="text-xs text-ink-500 dark:text-ink-400">
									{op.timestamp.endsWith('Z') ? op.timestamp : `${op.timestamp}Z`}
								</time>
							</div>
							<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
								<a
									href={morphitExplorerTxUrl(op.trxId) ?? '#'}
									class="font-mono text-morphit-emerald underline-offset-2 hover:underline"
								>
									tx: {op.trxId.slice(0, 10)}…
								</a>
								<a
									href={morphitExplorerBlockUrl(op.block) ?? '#'}
									class="font-mono text-morphit-emerald underline-offset-2 hover:underline"
								>
									block: {op.block}
								</a>
							</div>
						</li>
					{/each}
				</ul>
				{#if oldestSeqLoaded !== null && oldestSeqLoaded > 0}
					<button
						type="button"
						onclick={loadMore}
						disabled={loadingMore}
						class="mt-3 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm font-semibold transition hover:bg-ink-50 disabled:opacity-50 dark:border-ink-700 dark:hover:bg-ink-900"
					>
						{loadingMore ? $_('explorer.account.loading_more') : $_('explorer.account.load_more')}
					</button>
				{/if}
			{/if}
		</section>
	{/if}
</section>
