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
	import { fetchAccountBalance } from '$blurt/accountBalance';
	import { fetchAccountHistory } from '$blurt/accountHistory';
	import { fetchAccountKeys } from '$blurt/accountKeys';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import {
		parseAssetAmount,
		vestsToBlurtPower,
		votingPowerPercent,
		formatBalance,
		formatPercentage
	} from '$blurt/balanceMath';
	import { computeBlurtVestingApr, formatApr } from '$blurt/apr';
	import { formatDayMonthTime } from '$i18n/formatters';
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
	/** Live BP (staked-BLURT) APR from chain inflation — same global rate
	 *  for every account; shown under the BP figure to make explicit that
	 *  staked BLURT accrues yield. Computed pure-functionally from the DGP
	 *  (no extra fetch). */
	let vestingApr = $state(NaN);
	/** Voting power %, regenerated to "now" from the chain's voting_manabar.
	 *  NOTE: Blurt exposes a single manabar — the voting manabar — and has
	 *  no separate resource-credit ("RC mana") system the way Hive does, so
	 *  this value IS the account's voting power. */
	let voting = $state(NaN);
	/** All four public keys (owner / active / posting / memo), fetched once
	 *  from the indexer's same-origin /keys proxy.  null until loaded or on
	 *  fetch failure (the card then simply doesn't render). */
	let keys = $state<{
		readonly owner: string | null;
		readonly active: string | null;
		readonly posting: string | null;
		readonly memo: string | null;
	} | null>(null);

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
	/** True while a manual "refresh now" is in flight (spins the icon,
	 *  disables the button). */
	let refreshing = $state(false);

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

	/** A successful balance fetch's payload. */
	type BalanceOkData = Extract<
		Awaited<ReturnType<typeof fetchAccountBalance>>,
		{ kind: 'ok' }
	>['data'];

	/** Map a successful balance fetch onto the page's balance state.
	 *  Shared by the initial load and the manual refresh so the two never
	 *  drift apart. */
	function applyBalanceData(d: BalanceOkData): void {
		const { account: acct, dgp } = d;
		blurt = parseAssetAmount(acct.balance);
		bp = vestsToBlurtPower(
			acct.vesting_shares ?? '0 VESTS',
			dgp.total_vesting_fund_blurt,
			dgp.total_vesting_shares
		);
		voting = votingPowerPercent(
			acct.voting_power ?? null,
			acct.last_vote_time ?? null,
			Math.floor(Date.now() / 1000)
		);
		vestingApr = computeBlurtVestingApr({
			head_block_number: dgp.head_block_number,
			current_supply: dgp.current_supply,
			total_vesting_fund_blurt: dgp.total_vesting_fund_blurt
		});
	}

	/** First public key in an authority's key_auths list (the account's
	 *  primary signer for that role), or null for an empty/absent authority. */
	function firstAuthKey(
		auth: { readonly key_auths?: ReadonlyArray<readonly [string, number]> } | null | undefined
	): string | null {
		const first = auth?.key_auths?.[0]?.[0];
		return typeof first === 'string' ? first : null;
	}

	async function loadInitial(): Promise<void> {
		status = 'loading';
		try {
			// Account + DGP via the indexer (privacy: no direct RPC from
			// the browser). The balance proxy returns balance / vesting /
			// manabar / dgp / posting_pub — everything this page renders.
			const r = await fetchAccountBalance(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account);
			if (r.kind === 'not_found') {
				status = 'not_found';
				return;
			}
			if (r.kind !== 'ok') {
				throw new Error(r.message);
			}
			const { account: acct } = r.data;
			if (acct.name !== account) {
				throw new Error(`indexer returned ${acct.name} but ${account} was requested`);
			}
			applyBalanceData(r.data);

			// All four public keys (owner / active / posting / memo) via the
			// indexer's same-origin /keys proxy. Non-fatal: a keys failure
			// must not blank a page that already loaded balances + history.
			try {
				const k = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account, fetch);
				if (k !== null) {
					keys = {
						owner: firstAuthKey(k.owner),
						active: firstAuthKey(k.active),
						posting: firstAuthKey(k.posting),
						memo: typeof k.memo_key === 'string' ? k.memo_key : null
					};
				}
			} catch (err) {
				console.warn('[explorer/account] keys load failed:', err);
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

	async function fetchHistory(from: number, noCache = false, limit = PAGE_SIZE): Promise<void> {
		// One page via the indexer (privacy: no direct RPC from the
		// browser). get_account_history shape per entry:
		//   [seq, { block, trx_id, timestamp, op: [name, body] }]
		const r = await fetchAccountHistory(
			resolveOrigin(MORPHIT_INDEXER_ORIGIN),
			account,
			from,
			limit,
			fetch,
			noCache
		);
		if (r.kind !== 'ok') return;
		const history = r.entries;

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
			// Blurt's get_account_history rejects `from < limit - 1` (it can't
			// return `limit` entries ending below sequence `limit-1`). Near the
			// start of an account's history `oldestSeqLoaded` can be smaller than
			// a full page, so clamp the page to what's actually available — else
			// the final "load older" call fails silently and the button looks
			// like it doesn't work.
			const limit = Math.min(PAGE_SIZE, oldestSeqLoaded);
			await fetchHistory(oldestSeqLoaded - 1, false, limit);
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

	/** Manual "refresh now". For when a user just made a transaction and
	 *  doesn't want to wait for the auto-poll, which backs off to a minute
	 *  on an idle account. Re-fetches balance + the latest history in
	 *  place (cache-bypassed, so it reflects the chain even within the
	 *  short proxy cache window), then restarts polling at the base
	 *  interval. Deliberately does NOT call loadInitial: that flips status
	 *  to 'loading' and blanks the page, which would feel like a
	 *  navigation rather than an in-place refresh. */
	async function manualRefresh(): Promise<void> {
		if (refreshing || status !== 'ok') return;
		refreshing = true;
		stopPolling();
		try {
			const r = await fetchAccountBalance(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account, fetch, true);
			if (r.kind === 'ok' && r.data.account.name === account) applyBalanceData(r.data);
			await fetchHistory(-1, true);
		} catch (err) {
			console.warn('[explorer/account] manual refresh failed:', err);
		} finally {
			refreshing = false;
			// Snap polling back to the base interval (startPolling resets
			// currentPollMs), so we keep watching closely right after a refresh.
			startPolling();
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
		<a href={lp('/explorer')} class="text-white hover:text-morphit-emerald">
			<span class="nav-arrow nav-arrow-left" aria-hidden="true">⇦</span> {$_('explorer.nav.back_to_search')}
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
				loading="lazy"
				decoding="async"
			/>
			<div>
				<h1 class="font-display text-2xl font-bold">@{account}</h1>
				<a
					href={lp(`/@${account}`)}
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
					{$_('profile.my_balance.bp_staked_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold">{formatBalance(bp)}</dd>
				{#if Number.isFinite(vestingApr)}
					<!-- Live BP APR from chain inflation. Phrased "Currently
					     earning N% APR" (same key as the private balance card)
					     so staked BLURT reads as yield-bearing, not idle. -->
					<dd class="text-xs text-ink-500 dark:text-ink-400">
						{$_('profile.my_balance.apr_label', {
							values: { apr: formatApr(vestingApr) }
						})}
					</dd>
				{/if}
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('explorer.account.voting_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold">{formatPercentage(voting)}</dd>
			</div>
		</dl>

		{#if keys}
			<section class="card mb-6">
				<h2 class="mb-3 font-display text-base font-bold">
					{$_('explorer.account.public_keys_heading')}
				</h2>
				<dl class="space-y-3">
					{#if keys.owner}
						<div>
							<dt class="text-xs text-ink-500 dark:text-ink-400">
								{$_('explorer.account.key_owner')}
							</dt>
							<dd class="break-all font-mono text-xs">{keys.owner}</dd>
						</div>
					{/if}
					{#if keys.active}
						<div>
							<dt class="text-xs text-ink-500 dark:text-ink-400">
								{$_('explorer.account.key_active')}
							</dt>
							<dd class="break-all font-mono text-xs">{keys.active}</dd>
						</div>
					{/if}
					{#if keys.posting}
						<div>
							<dt class="text-xs text-ink-500 dark:text-ink-400">
								{$_('explorer.account.key_posting')}
							</dt>
							<dd class="break-all font-mono text-xs">{keys.posting}</dd>
						</div>
					{/if}
					{#if keys.memo}
						<div>
							<dt class="text-xs text-ink-500 dark:text-ink-400">
								{$_('explorer.account.key_memo')}
							</dt>
							<dd class="break-all font-mono text-xs">{keys.memo}</dd>
						</div>
					{/if}
				</dl>
			</section>
		{/if}

		<section class="card">
			<div class="mb-1 flex items-center justify-between gap-2">
				<h2 class="font-display text-base font-bold">
					{$_('explorer.account.recent_ops_heading')}
					<span class="ml-2 text-xs font-normal text-ink-500">
						({$_('explorer.account.realtime_label')})
					</span>
				</h2>
				<button
					type="button"
					onclick={manualRefresh}
					disabled={refreshing}
					aria-label={$_('explorer.account.refresh_label')}
					title={$_('explorer.account.refresh_label')}
					class="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-ink-300 text-ink-600 transition hover:border-morphit-emerald hover:bg-ink-50 hover:text-morphit-emerald disabled:cursor-wait disabled:opacity-100 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-900"
				>
					<svg
						class="h-4 w-4 {refreshing ? 'animate-spin' : ''}"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M21 12a9 9 0 1 1-2.64-6.36" />
						<path d="M21 3v6h-6" />
					</svg>
				</button>
			</div>
			<p class="mb-3 text-xs text-ink-500">{$_('explorer.account.delay_notice')}</p>
			{#if ops.length === 0}
				<p class="text-sm text-ink-500">{$_('explorer.account.no_ops')}</p>
			{:else}
				<ul class="divide-y divide-ink-200 dark:divide-ink-800">
					{#each ops as op (op.seq)}
						{@const dec = decorateOp(op.opName, op.opBody)}
						{@const txUrl = morphitExplorerTxUrl(op.trxId)}
						{@const blockUrl = morphitExplorerBlockUrl(op.block)}
						{@const iso = op.timestamp.endsWith('Z') ? op.timestamp : `${op.timestamp}Z`}
						<li class="py-3">
							<div class="flex items-baseline justify-between gap-2">
								<span
									class="rounded-md px-2 py-0.5 text-xs font-semibold {dec.isMorphitOp
										? 'bg-morphit-emerald/15 text-morphit-emerald'
										: 'bg-ink-200 text-ink-700 dark:bg-ink-800 dark:text-ink-200'}"
								>
									{$_(`explorer.op.label.${dec.labelKey}`)}
								</span>
								<time datetime={iso} class="text-xs text-ink-500 dark:text-ink-400">
									{formatDayMonthTime(iso)}
								</time>
							</div>
							<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
								<a
									href={txUrl ? lp(txUrl) : '#'}
									class="font-mono text-morphit-emerald underline-offset-2 hover:underline"
								>
									tx: {op.trxId.slice(0, 10)}…
								</a>
								<a
									href={blockUrl ? lp(blockUrl) : '#'}
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
						class="mt-3 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-ink-300 px-3 py-2 text-sm font-semibold transition hover:border-morphit-emerald hover:bg-ink-50 disabled:cursor-wait disabled:opacity-70 dark:border-ink-700 dark:hover:bg-ink-900"
					>
						{#if loadingMore}
							<svg
								class="h-4 w-4 animate-spin"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M21 12a9 9 0 1 1-2.64-6.36" />
								<path d="M21 3v6h-6" />
							</svg>
							{$_('common.loading')}
						{:else}
							{$_('explorer.account.load_more')}
						{/if}
					</button>
				{/if}
			{/if}
		</section>
	{/if}
</section>
