<!--
	Morphit — private balance card.

	Renders the user's BLURT, BP (Blurt Power), and MANA on their own
	profile page.  Visible ONLY when `viewerAccount === profileAccount`
	(parent gate); never displayed to public viewers.

	Why:
	  - Users buy a small amount of BLURT at signup.  Each chain op
	    they perform consumes a tiny resource credit (MANA), and
	    transfers spend the liquid balance.  Without a visible
	    indicator, users won't realize they're running low until ops
	    start failing.
	  - The "Top up BLURT" button pre-fills a buy order so the user
	    doesn't retype known fields.

	Data flow:
	  1. On mount, fetch the chain's get_accounts + DGP in parallel.
	  2. Compute BP from VESTS via balanceMath.vestsToBlurtPower.
	  3. Compute MANA% via balanceMath.manaPercentage with the
	     present clock time.
	  4. Display.  Refresh once per minute while mounted (cheap; one
	     RPC call).

	Privacy posture: chain balances are public.  This card is private
	to the user only as a courtesy — anyone curious can fetch the
	account themselves.  No private data is exposed beyond what's
	already on chain.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import { getBlurtClient } from '$blurt/client';
	import { vestsToBlurtPower, manaPercentage, parseAssetAmount } from '$blurt/balanceMath';
	import { computeBlurtVestingApr, formatApr } from '$blurt/apr';
	import {
		categorizeOp,
		filterByDateRange,
		type HistoryOp,
		type CategorizerPredicates,
		type PnlRow
	} from '$lib/pnl/categorize';
	import { buildPnlCsv, downloadCsv } from '$lib/pnl/exportCsv';
	import { FEE_RECIPIENT } from '$lib/orders/fee';
	import { safeSession } from '$lib/utils/safeStorage';
	import { subscribeBalanceRefresh } from '$lib/balance/bus';
	import AnimatedNumber from '$components/AnimatedNumber.svelte';

	/** The canonical operator account name (Featured-listing
	 *  revenue sink, release-op signer).  Reused as the
	 *  categorizer's "operator" predicate. */
	const OPERATOR_ACCOUNT = 'morphit';

	interface Props {
		/** The account whose balances to display.  Caller is
		 *  responsible for ensuring this matches the signed-in
		 *  user; this component does NOT enforce that gate. */
		account: string;
	}
	const { account }: Props = $props();

	type LoadState = 'loading' | 'ready' | 'error';
	let loadState = $state<LoadState>('loading');
	let errorMsg = $state('');
	let blurtBalance = $state(NaN);
	let bpBalance = $state(NaN);
	let manaPct = $state(NaN);
	let vestingApr = $state(NaN);

	/** Refresh interval.  Aggressive at 5 seconds: Blurt blocks
	 *  every ~3 seconds, so a 5s poll gives near-real-time updates
	 *  for a user watching their wallet during an active trade.
	 *  At rest (tab not visible), polling pauses — we resume on
	 *  visibilitychange and immediately refresh.  Components that
	 *  trigger known balance changes (fee broadcast, mark-as-sent,
	 *  fund release ack) call `triggerBalanceRefresh()` to nudge
	 *  the next refresh without waiting for the tick. */
	const REFRESH_MS = 5_000;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	/** Per-component bus unsubscribe.  Set in onMount, called in
	 *  onDestroy. */
	let unsubscribeBus: (() => void) | null = null;
	/** Visibility handler captured at mount-time so we can remove
	 *  it cleanly in onDestroy. */
	let visibilityHandler: (() => void) | null = null;
	/** BATCH14-3 audit fix — flag indicating a refresh is currently
	 *  in flight.  When the polling tick fires (every 5s) AND the
	 *  bus also fires, two overlapping refreshes would otherwise
	 *  execute, doubling RPC traffic.  On a slow upstream this can
	 *  stack up.  We swallow extra triggers while one is pending —
	 *  the in-flight call will land soon enough; a missed nudge
	 *  is recovered by the next 5s tick. */
	let refreshInFlight = false;

	async function refresh(): Promise<void> {
		if (refreshInFlight) return;
		refreshInFlight = true;
		try {
			const client = getBlurtClient();
			const [acct, dgp] = await Promise.all([
				client.getAccount(account),
				client.getDynamicGlobalProperties()
			]);
			if (!acct) {
				throw new Error('account not found');
			}
			blurtBalance = parseAssetAmount(acct.balance);
			bpBalance = vestsToBlurtPower(
				acct.vesting_shares ?? '0 VESTS',
				dgp.total_vesting_fund_blurt,
				dgp.total_vesting_shares
			);
			manaPct = manaPercentage(
				acct.voting_manabar ?? null,
				acct.vesting_shares ?? '0 VESTS',
				Math.floor(Date.now() / 1000)
			);
			// Batch K: APR.  Cheap to recompute every refresh; the
			// inputs already came in with the same call.  Cache the
			// result for display; it doesn't change measurably
			// between minute-scale refreshes (the inflation curve
			// drifts by sub-basis-points per day) but the formula
			// is pure and trivial so we don't bother memoizing.
			vestingApr = computeBlurtVestingApr({
				head_block_number: dgp.head_block_number,
				current_supply: dgp.current_supply,
				total_vesting_fund_blurt: dgp.total_vesting_fund_blurt
			});
			loadState = 'ready';
		} catch (err) {
			console.warn('[MyBalanceCard] balance load failed:', err);
			errorMsg = $_('my_balance.error.load_failed');
			loadState = 'error';
		} finally {
			// BATCH14-3: clear the in-flight gate.  Must run on BOTH
			// success and error paths or a single failed refresh
			// would permanently lock subsequent refreshes.
			refreshInFlight = false;
		}
	}

	function topUpBlurt(): void {
		// Stash a one-shot prefill request in sessionStorage; the
		// post page reads + clears on mount.  We deliberately don't
		// use URL params because the post page already has its own
		// draft restoration logic — adding a second source of state
		// would race.  Session storage gives us a clean handoff that
		// expires when the tab closes.
		safeSession.set(
			'morphit.post.prefill',
			JSON.stringify({
				side: 'buy',
				asset: 'BLURT',
				amountMin: '10',
				amountMax: '10',
				reason: 'topup'
			})
		);
		void goto(lp('/post'));
	}

	// ─── P&L export ───────────────────────────────────────────────
	let exporting = $state(false);
	let exportError = $state('');

	/** Fetch the user's last 365 days of account history, paged
	 *  through the chain's get_account_history API.  Returns the
	 *  union of all returned ops in chronological order.
	 *
	 *  Pagination: the chain accepts up to 10_000 entries per call.
	 *  We page backward from the head until we hit ops older than
	 *  one year OR the start of history.  In practice an active
	 *  account does ~100s of ops/year; one page is usually enough.
	 *  We cap at 5 pages (50_000 ops) to bound the worst case —
	 *  someone with that much chain activity has unusual needs and
	 *  can ask for a larger window in the future. */
	async function fetchYearOfHistory(account: string): Promise<HistoryOp[]> {
		const client = getBlurtClient();
		const PAGE = 10_000;
		const MAX_PAGES = 5;
		const oneYearAgoSec = Math.floor(Date.now() / 1000) - 365 * 86_400;

		const collected: HistoryOp[] = [];
		// Walk backward.  `from = -1` means "most recent"; we
		// receive the latest PAGE ops in chronological order.  Then
		// `from = oldestSeen - 1` for the next page.
		let from = -1;
		for (let page = 0; page < MAX_PAGES; page++) {
			// condenser_api.get_account_history shape:
			//   [seq, { block, trx_id, timestamp, op: [name, body] }]
			const history = await client.call<Array<[number, HistoryOp]>>(
				'condenser_api.get_account_history',
				[account, from, PAGE]
			);
			if (!Array.isArray(history) || history.length === 0) break;

			// `history` is ordered oldest-first within the window.
			// `seq` is monotonically increasing across history.
			let oldestSeen = Number.POSITIVE_INFINITY;
			let pageHasYearOld = false;
			for (const entry of history) {
				if (!Array.isArray(entry) || entry.length !== 2) continue;
				const seq = entry[0];
				const op = entry[1];
				if (typeof seq !== 'number') continue;
				oldestSeen = Math.min(oldestSeen, seq);
				const ts = Date.parse(op.timestamp + (op.timestamp.endsWith('Z') ? '' : 'Z')) / 1000;
				if (Number.isFinite(ts) && ts < oneYearAgoSec) {
					pageHasYearOld = true;
				}
				collected.push(op);
			}

			// If this page reached year-old territory OR returned
			// fewer than the page size (start of history), stop.
			if (pageHasYearOld || history.length < PAGE) break;
			if (oldestSeen <= 0) break;
			from = oldestSeen - 1;
		}
		return collected;
	}

	async function exportPnl(): Promise<void> {
		if (exporting) return;
		exporting = true;
		exportError = '';
		try {
			const ops = await fetchYearOfHistory(account);
			const preds: CategorizerPredicates = {
				isFeesAccount: (n) => n === FEE_RECIPIENT,
				isOperatorAccount: (n) => n === OPERATOR_ACCOUNT,
				// Featured-bid memos use a documented prefix.  Keep
				// the predicate lenient so a future memo-format
				// change still lights up.
				isFeaturedBidMemo: (m) => /^featured-bid:/.test(m)
			};
			const rows: PnlRow[] = [];
			for (const op of ops) {
				const r = categorizeOp(op, account, preds);
				if (r) rows.push(r);
			}
			// Filter to past 365 days inclusive.  History fetch may
			// have returned a few ops slightly older than that
			// (page boundary effect); trim now.
			const nowSec = Math.floor(Date.now() / 1000);
			const startSec = nowSec - 365 * 86_400;
			const windowed = filterByDateRange(rows, startSec, nowSec);

			const csv = buildPnlCsv(
				windowed,
				{
					timestamp: $_('profile.pnl.csv_header.timestamp'),
					category: $_('profile.pnl.csv_header.category'),
					counterparty: $_('profile.pnl.csv_header.counterparty'),
					blurtAmount: $_('profile.pnl.csv_header.blurt_amount'),
					memo: $_('profile.pnl.csv_header.memo'),
					trxId: $_('profile.pnl.csv_header.trx_id'),
					block: $_('profile.pnl.csv_header.block')
				},
				{
					blurt_received: $_('profile.pnl.category.blurt_received'),
					blurt_sent: $_('profile.pnl.category.blurt_sent'),
					order_fee: $_('profile.pnl.category.order_fee'),
					featured_bid: $_('profile.pnl.category.featured_bid'),
					featured_payout: $_('profile.pnl.category.featured_payout')
				}
			);

			const today = new Date().toISOString().slice(0, 10);
			downloadCsv(csv, `morphit-pnl-${account}-${today}.csv`);
		} catch (err) {
			console.warn('[MyBalanceCard] PnL export failed:', err);
			exportError = $_('my_balance.error.export_failed');
		} finally {
			exporting = false;
		}
	}

	function startPolling(): void {
		if (refreshTimer !== null) return;
		refreshTimer = setInterval(() => {
			void refresh();
		}, REFRESH_MS);
	}

	function stopPolling(): void {
		if (refreshTimer !== null) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	}

	onMount(() => {
		void refresh();
		// Subscribe to the global balance-refresh bus so other
		// components (FundsSentModal, post-broadcast success, etc.)
		// can nudge an immediate refetch when they know a balance-
		// affecting op just landed.
		unsubscribeBus = subscribeBalanceRefresh(() => {
			void refresh();
		});
		// Only poll while the tab is visible — saves background
		// RPC traffic and battery.  When the tab comes back into
		// view, immediately refresh and restart the timer so the
		// user sees fresh data the moment they switch back.
		visibilityHandler = () => {
			if (typeof document === 'undefined') return;
			if (document.visibilityState === 'visible') {
				void refresh();
				startPolling();
			} else {
				stopPolling();
			}
		};
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', visibilityHandler);
			if (document.visibilityState === 'visible') {
				startPolling();
			}
		} else {
			// Non-browser (SSR): just kick the timer; visibility
			// API is not relevant.  startPolling() stays a no-op
			// in environments that lack setInterval.
			startPolling();
		}
	});

	onDestroy(() => {
		stopPolling();
		if (unsubscribeBus !== null) {
			unsubscribeBus();
			unsubscribeBus = null;
		}
		if (visibilityHandler !== null && typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', visibilityHandler);
			visibilityHandler = null;
		}
	});

	/** Threshold below which we show the "running low" hint.
	 *  Half of the typical $1-of-BLURT signup amount; enough to
	 *  remind the user without being naggy. */
	const LOW_BLURT_THRESHOLD = 5;
	const LOW_MANA_THRESHOLD = 25; // percent

	const showLowBalanceHint = $derived(
		Number.isFinite(blurtBalance) && blurtBalance < LOW_BLURT_THRESHOLD
	);
	const showLowManaHint = $derived(Number.isFinite(manaPct) && manaPct < LOW_MANA_THRESHOLD);

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<section
	class="card border border-morphit-emerald/30 bg-emerald-50/30 dark:border-morphit-emerald/40 dark:bg-emerald-950/20"
	aria-label={$_('profile.my_balance.section_label')}
>
	<header class="mb-3 flex items-center justify-between">
		<h2 class="font-display text-base font-bold">
			{$_('profile.my_balance.title')}
		</h2>
		<span class="text-xs text-ink-500 dark:text-ink-400">
			{$_('profile.my_balance.private_label')}
		</span>
	</header>

	{#if loadState === 'loading'}
		<p class="text-sm text-ink-500 dark:text-ink-400">
			{$_('profile.my_balance.loading')}
		</p>
	{:else if loadState === 'error'}
		<p class="text-sm text-amber-700 dark:text-amber-300">
			{$_('profile.my_balance.error')}: {errorMsg}
		</p>
	{:else}
		<dl class="grid grid-cols-3 gap-3">
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('profile.my_balance.blurt_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold">
					<AnimatedNumber value={blurtBalance} decimals={3} />
				</dd>
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('profile.my_balance.bp_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold">
					<AnimatedNumber value={bpBalance} decimals={3} />
				</dd>
				{#if Number.isFinite(vestingApr)}
					<!-- Batch K: APR display.  Phrased as "Currently
					     earning N% APR" so users understand BP isn't
					     idle stake — it accrues yield from chain
					     inflation.  Computed pure-functionally from
					     DGP; no extra fetch. -->
					<dd class="text-xs text-ink-500 dark:text-ink-400">
						{$_('profile.my_balance.apr_label', {
							values: { apr: formatApr(vestingApr) }
						})}
					</dd>
				{/if}
			</div>
			<div>
				<dt class="text-xs text-ink-500 dark:text-ink-400">
					{$_('profile.my_balance.mana_label')}
				</dt>
				<dd class="font-mono text-lg font-semibold">
					<AnimatedNumber value={manaPct} decimals={1} />%
				</dd>
			</div>
		</dl>

		{#if showLowBalanceHint || showLowManaHint}
			<p class="mt-3 text-xs text-ink-600 dark:text-ink-300">
				{#if showLowBalanceHint}
					{$_('profile.my_balance.low_blurt_hint')}
				{:else}
					{$_('profile.my_balance.low_mana_hint')}
				{/if}
			</p>
		{/if}

		<div class="mt-4 flex flex-wrap items-center gap-2">
			<button
				type="button"
				onclick={topUpBlurt}
				class="rounded-xl bg-morphit-btn px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98]"
			>
				{$_('profile.my_balance.top_up_blurt')}
			</button>
			<span class="text-xs text-ink-500 dark:text-ink-400">
				{$_('profile.my_balance.top_up_hint')}
			</span>
		</div>

		<!-- P&L export — same row but visually subordinate to top-up. -->
		<div
			class="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-200 pt-3 dark:border-ink-700"
		>
			<button
				type="button"
				onclick={exportPnl}
				disabled={exporting}
				class="rounded-xl border border-ink-300 px-4 py-2 text-sm font-semibold transition hover:bg-ink-50 active:scale-[0.98] disabled:opacity-50 dark:border-ink-700 dark:hover:bg-ink-900"
			>
				{exporting ? $_('profile.pnl.exporting') : $_('profile.pnl.export_button')}
			</button>
			<span class="text-xs text-ink-500 dark:text-ink-400">
				{$_('profile.pnl.export_hint')}
			</span>
		</div>
		{#if exportError}
			<p class="mt-2 text-xs text-amber-700 dark:text-amber-300">
				{$_('profile.pnl.export_error')}: {exportError}
			</p>
		{/if}
	{/if}
</section>
