<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * Morphit — orderbook page.
	 *
	 * Reads from the indexer over HTTP. The indexer is read-only;
	 * all trades actually settle via ops broadcast to Blurt through
	 * each user's session keys. The orderbook just shows WHO is
	 * advertising WHAT and HOW to reach them.
	 *
	 * State model:
	 *   phase:
	 *     - 'loading'   first fetch after mount or filter change
	 *     - 'ready'     results shown (may be empty list or items)
	 *     - 'error'     last fetch failed; retry surfaces the call
	 *   Pagination: cursor maintained across "load more" taps;
	 *   when cursor is null, we've reached the end of the list.
	 *
	 * Filter application: debounced by 250ms on any filter change
	 * to avoid hammering the indexer while the user tweaks things.
	 *
	 * Cancellation: each fetch gets its own AbortController; a
	 * new filter application cancels any in-flight request so
	 * stale results never overwrite fresh ones.
	 */

	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';

	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import NewTraderChip from '$components/NewTraderChip.svelte';
	import EngagementChip from '$components/EngagementChip.svelte';
	import OrderExpiryChip from '$components/OrderExpiryChip.svelte';
	import RatingChip from '$components/RatingChip.svelte';
	import UsdtPriceSubline from '$components/UsdtPriceSubline.svelte';
	import { isUsdtNetwork, isUsdcNetwork, isDaiNetwork } from '$lib/assets/networks';
	import FeaturedOrders from '$components/FeaturedOrders.svelte';
	import FeaturedAuctionHistory from '$components/FeaturedAuctionHistory.svelte';
	import WelcomeFirstBuyHero from '$components/WelcomeFirstBuyHero.svelte';
	import RelativeTime from '$components/RelativeTime.svelte';

	import { getOrderbook } from '$lib/indexer/client';
	import { displayNamesForMethods } from '$lib/payments/display';
	import { instanceAdditions, instanceNameLookup } from '$lib/stores/instanceAdditions';
	import { getProfilesBatch } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { createOrderbookStream } from '$lib/orderbook/stream';
	import type { AssetTicker } from '@morphit/asset-registry';
	import type { OrderbookQuery, OrderRecord, ProfileResponse } from '@morphit/indexer-client';

	import { hiddenAccounts, hideAccount } from '$lib/utils/hiddenAccounts';
	import { blockedAccounts, loadBlocks } from '$lib/chat/blocks';
	import { recordOrderView } from '$lib/orders/views';
	import { formatOrderPriceModel } from '$lib/orders/priceModelDisplay';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { isUnlocked, hasAnySession } from '$stores/identity';

	// ─── Filter state ────────────────────────────────────────────────
	type AssetFilter = '' | AssetTicker;
	type SideFilter = '' | 'buy' | 'sell';

	let asset = $state<AssetFilter>('');
	let side = $state<SideFilter>('');
	let fiat = $state('');
	let region = $state('');
	/** Batch L: payment-method display lookup.  Reading
	 *  `$instanceAdditions` here triggers the lazy fetch of the
	 *  instance-additions store; the value itself is ignored,
	 *  but the subscription ensures `instanceNameLookup` finds
	 *  populated data after the fetch resolves.  Svelte
	 *  re-renders on the store update, so the orderbook rows
	 *  pick up the proper display names automatically. */
	const instLookup = $derived.by(() => {
		// Read $instanceAdditions to register a reactive
		// dependency — the lookup helper is a stable function,
		// but it reads the store-backed cache, so we want this
		// derived to re-evaluate when additions change.
		void $instanceAdditions;
		return instanceNameLookup;
	});
	/** Comma-separated payment-method filter. Matches orders that
	 *  accept ANY of the listed methods (array-overlap semantics
	 *  on the indexer side). Case-insensitive match — the indexer
	 *  lowercases both sides, so "paypal" here finds orders posted
	 *  with "PayPal". */
	let paymentFilter = $state('');

	/** Discrete minimum-trades filter: show only orders from
	 *  accounts that have received at least this many feedback
	 *  rows. 0 = any (default). Other preset values chosen
	 *  deliberately — a free-form integer would invite
	 *  "reputation gate" misuse; presets keep the UX healthier. */
	type MinTradesFilter = 0 | 5 | 20;
	let minTrades = $state<MinTradesFilter>(0);

	/** Sort mode. "recent" (default) keeps the historical
	 *  behavior; "rating" surfaces highest-rated first; "trades"
	 *  surfaces most-experienced first. New traders remain
	 *  visible in all modes — sort is not a filter. */
	type SortMode = 'recent' | 'rating' | 'trades';
	let sortMode = $state<SortMode>('recent');

	/** When true, render orders from hidden accounts in-place (still
	 *  marked as hidden). Flipped by the transparency link under the
	 *  filter bar. Per-session only — doesn't touch the hidden set. */
	let showHiddenTemporarily = $state(false);

	// ─── Paging state ────────────────────────────────────────────────
	type Phase = 'loading' | 'ready' | 'error';
	let phase = $state<Phase>('loading');
	let items = $state<OrderRecord[]>([]);
	let cursor: string | null = $state(null);
	let indexedBlock = $state(0);
	let errorMessage = $state('');
	let loadingMore = $state(false);

	// ─── SSE streaming state (Phase E) ───────────────────────────────
	/** True while the orderbook stream is connected and fed.  Drives
	 *  the "Live" pip in the header so users know the page is
	 *  auto-updating; flips false on transient EventSource errors and
	 *  back true when the next snapshot arrives. */
	let streaming = $state(false);
	/** Set of (account/permlink) ids the SSE stream has told us about
	 *  since connect.  Used to know whether an order_removed event is
	 *  for something currently rendered.  Bounded by the indexer's
	 *  per-connection cap; we don't replicate that bound here because
	 *  the server enforces it.  Updated by the upsert/remove
	 *  callbacks below. */
	const streamedIds = new Set<string>();

	/** The signed-in user's Blurt account name, or null if signed
	 *  out / not yet registered.  Derived so the banner above and
	 *  the per-row Message CTA below re-evaluate when the user
	 *  unlocks/locks/registers within the same page mount.  Pre-
	 *  Part-68 this was a script-init `const` which was wrong for
	 *  the Sally-skipped-registration case (she could come back
	 *  and complete registration without a page reload). */
	const viewerAccount = $derived.by((): string | null => {
		// Read $isUnlocked to register a reactive dependency — when
		// the session locks/unlocks the account-name lookup re-runs.
		void $isUnlocked;
		return getUserBlurtAccount();
	});

	/** Profile data keyed by account. Populated asynchronously AFTER
	 *  the orderbook loads — orderbook rows render with identicons
	 *  first, then custom avatars swap in as profiles arrive. A null
	 *  value means the server confirmed no profile (cached so we
	 *  don't refetch). Missing key means we haven't tried yet.
	 *
	 *  Uses a plain Record rather than a Map because Svelte 5 $state
	 *  handles reactive deep-updates on plain objects well, and the
	 *  lookup idiom `profileMap[account]` in the template is natural. */
	let profileMap = $state<Record<string, ProfileResponse | null>>({});

	/** Items filtered by the user's hidden-accounts AND blocked-
	 *  accounts sets.  Hidden is local-only ("invisible to me on
	 *  this device"); blocked is chain-broadcast ("I want nothing
	 *  to do with this user, syncs across devices").  Both
	 *  represent intentional moderation choices and orderbook is
	 *  one of the surfaces that should respect them.
	 *
	 *  For unauthenticated viewers, $blockedAccounts is the empty
	 *  set (loadBlocks runs only when there's a logged-in user)
	 *  so the AND is a no-op for them.
	 *
	 *  When showHiddenTemporarily is true, we return `items`
	 *  unchanged (render path still shows the moderation marker
	 *  per-row).  Note the toggle reveals BOTH hidden and blocked
	 *  accounts since it's a "show me what I'd otherwise be
	 *  filtering" transparency control. */
	const visibleItems = $derived.by(() => {
		if (showHiddenTemporarily) return items;
		const hidden = $hiddenAccounts;
		const blocked = $blockedAccounts;
		return items.filter((o) => {
			const acct = o.account.toLowerCase();
			return !hidden.has(acct) && !blocked.has(acct);
		});
	});

	/** Count of items filtered out by the moderation sets. Surfaces
	 *  in the transparency line below the filters. */
	const hiddenInView = $derived.by(() => {
		const hidden = $hiddenAccounts;
		const blocked = $blockedAccounts;
		return items.filter((o) => {
			const acct = o.account.toLowerCase();
			return hidden.has(acct) || blocked.has(acct);
		}).length;
	});

	/** Cancels the in-flight fetch if any. Replaced on each new fetch. */
	let currentAbort: AbortController | null = null;
	/** Debounce handle for filter changes. */
	let filterDebounce: ReturnType<typeof setTimeout> | null = null;

	function currentQuery(): OrderbookQuery {
		// OrderbookQuery's public surface is `readonly` so callers
		// can't accidentally mutate after passing to the client.
		// We need a mutable shape for the piecemeal build below;
		// the assignment back to OrderbookQuery on return is a
		// type-level no-op (the values are identical).
		const q: { -readonly [K in keyof OrderbookQuery]: OrderbookQuery[K] } = {};
		if (asset) q.asset = asset;
		if (side) q.side = side;
		const fiatTrim = fiat.trim().toUpperCase();
		if (fiatTrim) q.fiat_currency = fiatTrim;
		const regionTrim = region.trim();
		if (regionTrim) q.location_region = regionTrim;
		const paymentTrim = paymentFilter.trim();
		if (paymentTrim) q.payment_methods = paymentTrim;
		if (minTrades > 0) q.min_trades = minTrades;
		if (sortMode !== 'recent') q.sort = sortMode;
		return q;
	}

	/** Fetch profile data for the accounts in the given order set,
	 *  deduplicated and batched via the shared profile cache. Merges
	 *  results into profileMap so the UI reactively swaps identicons
	 *  for custom avatars as data arrives.
	 *
	 *  Fire-and-forget: we do NOT await this from fetchFirstPage /
	 *  loadMore because blocking orderbook render on profile fetch
	 *  would delay the main content. The UI shows identicons first
	 *  and upgrades them once profiles land (typically < 300ms).
	 *
	 *  Errors are silently tolerated — the cache stores null for any
	 *  account that failed to fetch, so repeated hydrate calls
	 *  don't hammer the network. The UI keeps the identicon as
	 *  fallback.
	 *
	 *  Signal is optional and inherits from the page's currentAbort
	 *  so navigating or filtering aborts profile fetches too. */
	async function hydrateProfiles(
		orders: readonly OrderRecord[],
		signal?: AbortSignal
	): Promise<void> {
		const accounts = Array.from(new Set(orders.map((o) => o.account)));
		if (accounts.length === 0) return;
		const fetched = await getProfilesBatch(accounts, signal);
		if (signal?.aborted) return;
		const next = { ...profileMap };
		for (const [account, profile] of fetched) {
			next[account] = profile;
		}
		profileMap = next;
	}

	async function fetchFirstPage(): Promise<void> {
		if (currentAbort) currentAbort.abort();
		currentAbort = new AbortController();

		phase = 'loading';
		items = [];
		cursor = null;
		errorMessage = '';

		const result = await getOrderbook(currentQuery(), currentAbort.signal);
		if (currentAbort.signal.aborted) return;

		if (!result.ok) {
			console.warn('[orderbook] first-page fetch failed:', result.message);
			errorMessage = $_('orderbook.error.fetch_failed');
			phase = 'error';
			return;
		}
		items = [...result.data.items];
		cursor = result.data.next_cursor;
		indexedBlock = result.data.indexed_block;
		phase = 'ready';
		// Kick off profile hydration — deliberately not awaited.
		// The identicon fallback renders immediately; custom avatars
		// swap in as profiles arrive.
		void hydrateProfiles(result.data.items, currentAbort.signal);
	}

	async function loadMore(): Promise<void> {
		if (!cursor || loadingMore) return;
		loadingMore = true;
		const signal = currentAbort?.signal;
		const result = await getOrderbook({ ...currentQuery(), cursor }, signal);
		loadingMore = false;
		if (!result.ok) {
			// Non-fatal — show the error inline but keep the list so
			// the user doesn't lose scroll position.
			console.warn('[orderbook] load-more failed:', result.message);
			errorMessage = $_('orderbook.error.load_more_failed');
			return;
		}
		// Append rather than replace; dedupe by (account, permlink)
		// in case reordering caused overlap.
		const seen = new Set(items.map((o) => `${o.account}/${o.permlink}`));
		for (const o of result.data.items) {
			const key = `${o.account}/${o.permlink}`;
			if (!seen.has(key)) {
				items.push(o);
				seen.add(key);
			}
		}
		cursor = result.data.next_cursor;
		indexedBlock = result.data.indexed_block;
		void hydrateProfiles(result.data.items, signal);
	}

	function scheduleRefetch(): void {
		if (filterDebounce) clearTimeout(filterDebounce);
		filterDebounce = setTimeout(() => {
			fetchFirstPage();
			// Restart the SSE stream with the new filter.  EventSource
			// can't change its URL after construction, so we close the
			// old one and open a fresh one — same pattern the
			// instances stream uses.
			restartStream();
		}, 250);
	}

	// Re-fetch when any filter changes.
	$effect(() => {
		void asset;
		void side;
		void fiat;
		void region;
		void paymentFilter;
		void minTrades;
		void sortMode;
		scheduleRefetch();
	});

	// ─── SSE stream handle (Phase E) ─────────────────────────────────

	let streamHandle: ReturnType<typeof createOrderbookStream> | null = null;

	function buildStream(): ReturnType<typeof createOrderbookStream> {
		return createOrderbookStream({
			query: () => currentQuery(),
			onSnapshot: (snap) => {
				// Snapshot is authoritative: replace the live-page
				// portion of items with the server's view.  We don't
				// touch any rows the user has already paginated into
				// via loadMore (those live in items past the snapshot
				// boundary; the SSE stream doesn't track them).
				//
				// To stay simple: replace the first SNAPSHOT_SIZE
				// items with the snapshot, leave any later pages
				// alone.  If the user hasn't paginated, items.length
				// is at most SNAPSHOT_SIZE, so this is just "set
				// items = snapshot.items".
				const SNAPSHOT_SIZE = 50;
				const tail = items.slice(SNAPSHOT_SIZE);
				items = [...snap.items, ...tail];
				indexedBlock = snap.indexed_block;
				streamedIds.clear();
				for (const e of snap.items) {
					streamedIds.add(`${e.account}/${e.permlink}`);
				}
				// Hydrate profiles for any new accounts we hadn't seen.
				void hydrateProfiles(snap.items);
			},
			applyUpsert: (entry) => {
				const id = `${entry.account}/${entry.permlink}`;
				const idx = items.findIndex(
					(o) => o.account === entry.account && o.permlink === entry.permlink
				);
				if (idx >= 0) {
					// Replace in place; preserve list position.  The
					// REST endpoint sorts by updated_at desc, but
					// recomputing sort order here would cause rows
					// to jump around as they update — distracting.
					// Keep position; user-perceptible "new at top"
					// still happens via genuinely-new orders below.
					items[idx] = entry;
					items = items;
				} else {
					// New row — prepend (recent sort puts newest first).
					items = [entry, ...items];
				}
				if (!streamedIds.has(id)) {
					streamedIds.add(id);
					void hydrateProfiles([entry]);
				}
			},
			applyRemove: ({ account, permlink }) => {
				const id = `${account}/${permlink}`;
				items = items.filter((o) => !(o.account === account && o.permlink === permlink));
				streamedIds.delete(id);
			},
			onStreamingChange: (s) => {
				streaming = s;
			}
		});
	}

	function restartStream(): void {
		if (streamHandle !== null) {
			streamHandle.stop();
		}
		streamHandle = buildStream();
		streamHandle.start();
	}

	onMount(() => {
		fetchFirstPage();
		// Open the SSE stream alongside.  Snapshot will replace
		// items with the live-paged view shortly; diffs keep it
		// fresh.  See restartStream() above for the reconnect path
		// on filter change.
		streamHandle = buildStream();
		streamHandle.start();
		// Populate the blocked-accounts store if user is logged in,
		// so visibleItems can filter chain-blocked peers from the
		// orderbook view.  Fire-and-forget: the derived re-runs
		// reactively when blockedSet updates.  Anon viewers never
		// trigger this (no account → no fetch).
		const me = getUserBlurtAccount();
		if (me) void loadBlocks(me);
		return () => {
			if (currentAbort) currentAbort.abort();
			if (filterDebounce) clearTimeout(filterDebounce);
		};
	});

	onDestroy(() => {
		if (streamHandle !== null) {
			streamHandle.stop();
			streamHandle = null;
		}
	});

	function clearFilters(): void {
		asset = '';
		side = '';
		fiat = '';
		region = '';
		paymentFilter = '';
		minTrades = 0;
		sortMode = 'recent';
	}

	// ─── Formatting helpers ──────────────────────────────────────────

	function formatAmount(n: number | null): string {
		if (n === null) return '';
		return n % 1 === 0 ? String(n) : n.toFixed(2);
	}

	function formatRange(o: OrderRecord): string {
		const fiatCode = o.fiat_currency;
		if (o.amount_min !== null && o.amount_max !== null) {
			return $_('orderbook.order.range_both', {
				values: {
					min: formatAmount(o.amount_min),
					max: formatAmount(o.amount_max),
					fiat: fiatCode
				}
			});
		}
		if (o.amount_min !== null) {
			return $_('orderbook.order.range_min_only', {
				values: { min: formatAmount(o.amount_min), fiat: fiatCode }
			});
		}
		if (o.amount_max !== null) {
			return $_('orderbook.order.range_max_only', {
				values: { max: formatAmount(o.amount_max), fiat: fiatCode }
			});
		}
		return $_('orderbook.order.range_open', { values: { fiat: fiatCode } });
	}



	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head
	routeKey="orderbook"
	feeds={[{ title: $_('seo.site_name') + ' — orderbook', href: '/rss/orderbook.xml' }]}
/>

<div class="mx-auto max-w-4xl px-4 py-10 md:py-14">
	<header class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<div>
			<h1 class="font-display text-3xl font-extrabold">
				<span class="brand-gradient-text">{$_('orderbook.heading')}</span>
			</h1>
			<p class="mt-2 flex items-center gap-3 text-ink-700 dark:text-ink-200">
				<span>{$_('orderbook.subtitle')}</span>
				{#if streaming}
					<span class="inline-flex items-center gap-1.5 text-xs">
						<span class="relative inline-flex h-2 w-2">
							<span
								class="absolute inline-flex h-full w-full animate-ping rounded-full bg-morphit-emerald opacity-60"
							></span>
							<span class="relative inline-flex h-2 w-2 rounded-full bg-morphit-emerald"></span>
						</span>
						<span class="uppercase tracking-widest text-ink-500">{$_('orderbook.live')}</span>
					</span>
				{/if}
			</p>
		</div>
		<a href={lp('/post')} class="btn-primary self-start whitespace-nowrap">
			{$_('orderbook.post_cta')}
		</a>
	</header>

	<!-- Tier 2.7 (Part 91): a user who paid a listing fee and
	     doesn't see their order on the orderbook will assume
	     Morphit is broken — fee verification can fail (BTC
	     reorg, XMR tx-key mismatch, etc.) and the order silently
	     disappears from the public orderbook even though it's
	     visible on /my/orders with a fee-rejected chip.  Forward
	     link gives them a recovery path back to that view.
	     Only shown for signed-in users with a registered account
	     name, since anonymous browsers have no orders to recover. -->
	{#if $hasAnySession && viewerAccount !== null}
		<!-- Part 116: widened from $isUnlocked to $hasAnySession so
		     paired-readonly users (whose orders + fee-rejected chips
		     still render on /my/orders post-Part-116 shell refactor)
		     also see the recovery link. -->
		<p class="mb-4 text-xs text-ink-500 dark:text-ink-400">
			<a href={lp('/my/orders#fee-status')} class="underline hover:no-underline">
				{$_('orderbook.fee_rejected_check')}
			</a>
		</p>
	{/if}

	<WelcomeFirstBuyHero />

	<!-- Sally finding H4 (Part 68): if the user is unlocked but
	     hasn't completed account-name registration, the per-row
	     "Message" CTA is silently invisible (see line where
	     `viewerAccount !== null` gates it).  Without this banner
	     a Sally who skipped /onboarding/register-name can browse
	     orders but has no idea why she can't reach sellers.
	     Renders only when unlocked-without-account so it doesn't
	     bother signed-out browsers (who see the same gating but
	     get the home-page CTAs to onboard from). -->
	{#if $isUnlocked && viewerAccount === null}
		<section
			class="card mb-6 border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"
			role="status"
			aria-live="polite"
		>
			<div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex items-start gap-3">
					<span class="text-2xl" aria-hidden="true">👋</span>
					<div>
						<p class="font-semibold text-amber-900 dark:text-amber-100">
							{$_('orderbook.needs_account.title')}
						</p>
						<p class="mt-1 text-sm text-amber-800 dark:text-amber-200">
							{$_('orderbook.needs_account.body')}
						</p>
					</div>
				</div>
				<a href={lp('/onboarding/register-name')} class="btn-primary flex-none whitespace-nowrap">
					{$_('orderbook.needs_account.cta')}
				</a>
			</div>
		</section>
	{/if}

	<!-- Filters -->
	<section class="card mb-6" aria-labelledby="filters-heading">
		<h2 id="filters-heading" class="mb-4 font-display text-lg font-bold">
			{$_('orderbook.filters.heading')}
		</h2>
		<div class="grid gap-4 sm:grid-cols-2">
			<label class="block">
				<span class="mb-1 block text-sm font-semibold">
					{$_('orderbook.filters.side_label')}
				</span>
				<select
					bind:value={side}
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				>
					<option value="">{$_('orderbook.filters.side_any')}</option>
					<option value="buy">{$_('orderbook.filters.side_buy')}</option>
					<option value="sell">{$_('orderbook.filters.side_sell')}</option>
				</select>
				<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
					{$_('orderbook.filters.side_help')}
				</p>
			</label>

			<label class="block">
				<span class="mb-1 block text-sm font-semibold">
					{$_('orderbook.filters.asset_label')}
				</span>
				<select
					bind:value={asset}
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				>
					<option value="">{$_('orderbook.filters.asset_any')}</option>
					<option value="BTC">BTC</option>
					<option value="XMR">XMR</option>
					<option value="BLURT">BLURT</option>
				</select>
			</label>

			<label class="block">
				<span class="mb-1 block text-sm font-semibold">
					{$_('orderbook.filters.fiat_label')}
				</span>
				<input
					type="text"
					bind:value={fiat}
					maxlength="8"
					autocomplete="off"
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 uppercase focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
					placeholder={$_('orderbook.filters.fiat_placeholder')}
				/>
			</label>

			<label class="block">
				<span class="mb-1 block text-sm font-semibold">
					{$_('orderbook.filters.region_label')}
				</span>
				<input
					type="text"
					bind:value={region}
					maxlength="128"
					autocomplete="off"
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
					placeholder={$_('orderbook.filters.region_placeholder')}
				/>
			</label>
		</div>

		<label class="mt-4 block">
			<span class="mb-1 block text-sm font-semibold">
				{$_('orderbook.filters.payment_methods_label')}
			</span>
			<input
				type="text"
				bind:value={paymentFilter}
				maxlength="256"
				autocomplete="off"
				class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				placeholder={$_('orderbook.filters.payment_methods_placeholder')}
			/>
			<p class="mt-1 text-xs text-ink-500">
				{$_('orderbook.filters.payment_methods_hint')}
			</p>
		</label>

		<!-- Trader experience + sort. These two controls surface
		     reputation data without hiding newcomers — new traders
		     remain visible under every sort mode; the min-trades
		     filter defaults to "Any" so the default view never
		     excludes them. -->
		<div class="mt-4 grid gap-4 sm:grid-cols-2">
			<label class="block">
				<span class="mb-1 block text-sm font-semibold">
					{$_('orderbook.filters.min_trades_label')}
				</span>
				<select
					bind:value={minTrades}
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				>
					<option value={0}>{$_('orderbook.filters.min_trades_any')}</option>
					<option value={5}>{$_('orderbook.filters.min_trades_5')}</option>
					<option value={20}>{$_('orderbook.filters.min_trades_20')}</option>
				</select>
				<p class="mt-1 text-xs text-ink-500">
					{$_('orderbook.filters.min_trades_hint')}
				</p>
			</label>

			<label class="block">
				<span class="mb-1 block text-sm font-semibold">
					{$_('orderbook.filters.sort_label')}
				</span>
				<select
					bind:value={sortMode}
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				>
					<option value="recent">{$_('orderbook.filters.sort_recent')}</option>
					<option value="rating">{$_('orderbook.filters.sort_rating')}</option>
					<option value="trades">{$_('orderbook.filters.sort_trades')}</option>
				</select>
			</label>
		</div>

		{#if asset || side || fiat || region || paymentFilter || minTrades > 0 || sortMode !== 'recent'}
			<div class="mt-4 flex flex-wrap items-center gap-3">
				<BusyButton variant="ghost" onclick={clearFilters}>
					{$_('orderbook.filters.clear')}
				</BusyButton>

				<!-- Per-asset RSS subscribe link.
					Only meaningful when an asset is selected — without one,
					the global /rss/orderbook.xml from the footer already
					covers the use case. Keeps the URL space small (3 valid
					asset feeds) so a passive observer learns at most "this
					subscriber cares about <asset>."
					Privacy and use case documented in rss_feeds FAQ. -->
				{#if asset}
					<a
						href={`/rss/orderbook/by-asset/${asset.toLowerCase()}.xml`}
						title={$_('orderbook.filters.rss_asset_title', { values: { asset } }) as string}
						class="chip text-xs"
						rel="alternate"
						type="application/rss+xml"
					>
						<svg
							class="h-3.5 w-3.5"
							viewBox="0 0 24 24"
							xmlns="http://www.w3.org/2000/svg"
							aria-hidden="true"
						>
							<rect x="1.5" y="1.5" width="21" height="21" rx="4" fill="#F26522" />
							<circle cx="6.5" cy="17.5" r="2" fill="#fff" />
							<path
								d="M5 8.5 A 10.5 10.5 0 0 1 15.5 19"
								stroke="#fff"
								stroke-width="2.4"
								fill="none"
								stroke-linecap="round"
							/>
							<path
								d="M5 4.5 A 14.5 14.5 0 0 1 19.5 19"
								stroke="#fff"
								stroke-width="2.4"
								fill="none"
								stroke-linecap="round"
							/>
						</svg>
						{$_('orderbook.filters.rss_asset_label', { values: { asset } })}
					</a>
				{/if}
			</div>
		{/if}
	</section>

	<!-- Phase 5 item 5: Featured slots pinned above the main list.
	     'stack' variant to match the single-column orderbook row
	     layout below. Self-hides when empty so no promotional noise
	     on a fresh marketplace. -->
	<div class="mt-6">
		<FeaturedOrders variant="stack" />
	</div>

	<!-- Item 5 (Group 1 #2): clearing-price history for the
	     featured-slot auction.  Self-hides until there's at
	     least one bid in the window.  Below the live featured
	     panel because "is the auction competitive?" is more
	     interesting AFTER you've seen who's currently winning. -->
	<FeaturedAuctionHistory />

	<!-- Loading status -->
	{#if phase === 'loading'}
		<StatusLine kind="loading">{$_('orderbook.loading')}</StatusLine>
	{/if}

	<!-- Error -->
	{#if phase === 'error'}
		<section
			class="card mt-4 border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"
			role="alert"
			aria-live="assertive"
		>
			<h2 class="font-display text-lg font-bold text-amber-900 dark:text-amber-100">
				{$_('orderbook.error_title')}
			</h2>
			<p class="mt-2 text-sm text-amber-800 dark:text-amber-200">
				{$_('orderbook.error_body')}
			</p>
			<p class="mt-1 text-xs text-amber-700 dark:text-amber-300">
				{errorMessage}
			</p>
			<div class="mt-4">
				<BusyButton variant="primary" onclick={fetchFirstPage}>
					{$_('orderbook.retry')}
				</BusyButton>
			</div>
		</section>
	{/if}

	<!-- Ready: items or empty -->
	{#if phase === 'ready'}
		{#if visibleItems.length === 0 && items.length === 0}
			<section class="card text-center">
				<h2 class="font-display text-lg font-bold">
					{$_('orderbook.empty_title')}
				</h2>
				<p class="mt-2 text-ink-600 dark:text-ink-300">
					{$_('orderbook.empty_body')}
				</p>
			</section>
		{:else if visibleItems.length === 0 && hiddenInView > 0}
			<!-- Every item in the fetched page is from an account the
			     user has hidden. Offer the temporary-reveal escape
			     hatch rather than falsely claiming the orderbook is
			     empty. -->
			<section class="card text-center">
				<h2 class="font-display text-lg font-bold">
					{$_('orderbook.all_hidden_title')}
				</h2>
				<p class="mt-2 text-ink-600 dark:text-ink-300">
					{$_('orderbook.all_hidden_body', { values: { count: hiddenInView } })}
				</p>
				<button
					type="button"
					onclick={() => (showHiddenTemporarily = true)}
					class="mt-4 rounded-xl border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700"
				>
					{$_('orderbook.show_hidden_temporarily')}
				</button>
			</section>
		{:else}
			{#if hiddenInView > 0}
				<!-- Transparency line: some items filtered. Users can
				     toggle temporary-reveal to see them in-place (still
				     visually marked) or manage the list in Settings. -->
				<p class="mb-3 text-xs text-ink-500">
					{$_('orderbook.hidden_count_notice', { values: { count: hiddenInView } })}
					{#if !showHiddenTemporarily}
						<button
							type="button"
							onclick={() => (showHiddenTemporarily = true)}
							class="ml-2 font-semibold text-morphit-emerald hover:underline"
						>
							{$_('orderbook.show_hidden_temporarily')}
						</button>
					{:else}
						<button
							type="button"
							onclick={() => (showHiddenTemporarily = false)}
							class="ml-2 font-semibold text-morphit-emerald hover:underline"
						>
							{$_('orderbook.rehide')}
						</button>
					{/if}
				</p>
			{/if}
			<ul class="space-y-3">
				{#each visibleItems as o (o.account + '/' + o.permlink)}
					{@const accountIsHidden = $hiddenAccounts.has(o.account.toLowerCase())}
					{@const accountIsBlocked = $blockedAccounts.has(o.account.toLowerCase())}
					{@const priceModelLabel = formatOrderPriceModel(
						o,
						$_ as unknown as Parameters<typeof formatOrderPriceModel>[1]
					)}
					{@const labelProps = extractLabelPropsFromProfile(profileMap[o.account])}
					{@const usdtRowNetwork =
						o.asset === 'USDT' && o.asset_network && isUsdtNetwork(o.asset_network)
							? o.asset_network
							: null}
					{@const usdcRowNetwork =
						o.asset === 'USDC' && o.asset_network && isUsdcNetwork(o.asset_network)
							? o.asset_network
							: null}
					{@const daiRowNetwork =
						o.asset === 'DAI' && o.asset_network && isDaiNetwork(o.asset_network)
							? o.asset_network
							: null}
					<li
						class="card-interactive animate-fade-up {accountIsHidden || accountIsBlocked
							? 'opacity-50'
							: ''}"
					>
						<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
							<div class="flex-1">
								<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
									<span class="font-display text-lg font-bold">
										{o.side === 'buy'
											? $_('orderbook.order.buying', { values: { asset: o.asset } })
											: $_('orderbook.order.selling', { values: { asset: o.asset } })}
									</span>
									{#if usdtRowNetwork !== null}
										<!-- Part 121 — USDT network chip with the
										     "you need USDT on Tron for this trade"
										     hint via title-tooltip.  Renders only
										     for USDT rows; single-network assets
										     skip. -->
										<span
											class="rounded-md border border-amber-400/30 bg-amber-400/5 px-2 py-0.5 text-xs font-semibold text-amber-300"
											title={$_('assets.usdt.order_row.network_hint', {
												values: {
													network: $_(`assets.usdt.network.${usdtRowNetwork}.displayName`)
												}
											}) as string}
										>
											{$_(`assets.usdt.network.${usdtRowNetwork}.displayName`)}
										</span>
									{/if}
									{#if usdcRowNetwork !== null}
										<!-- Part 122 cp30 / cp34 closure — USDC
										     network chip.  Same shape as USDT;
										     three of USDC's four networks share
										     EVM 0x format so chip disambiguates
										     ERC-20/Base/Polygon on orderbook row.
										     Sky-blue (Circle brand) so USDT/USDC
										     are visually distinguishable. -->
										<span
											class="rounded-md border border-sky-400/30 bg-sky-400/5 px-2 py-0.5 text-xs font-semibold text-sky-300"
											title={$_('assets.usdc.order_row.network_hint', {
												values: {
													network: $_(`assets.usdc.network.${usdcRowNetwork}.displayName`)
												}
											}) as string}
										>
											{$_(`assets.usdc.network.${usdcRowNetwork}.displayName`)}
										</span>
									{/if}
									{#if daiRowNetwork !== null}
										<!-- Part 122 cp31 / cp34 closure — DAI
										     network chip.  ALL FOUR DAI networks
										     share EVM 0x format, so chip is the
										     ONLY thing telling a reader which
										     chain.  Yellow (MakerDAO brand). -->
										<span
											class="rounded-md border border-yellow-400/30 bg-yellow-400/5 px-2 py-0.5 text-xs font-semibold text-yellow-300"
											title={$_('assets.dai.order_row.network_hint', {
												values: {
													network: $_(`assets.dai.network.${daiRowNetwork}.displayName`)
												}
											}) as string}
										>
											{$_(`assets.dai.network.${daiRowNetwork}.displayName`)}
										</span>
									{/if}
									<span class="text-sm text-ink-600 dark:text-ink-300">
										{formatRange(o)}
									</span>
									{#if priceModelLabel !== null}
										<span
											class="text-sm text-ink-500 dark:text-ink-400"
											title={$_('orderbook.price_model.tooltip') as string}
										>
											· {priceModelLabel}
										</span>
									{/if}
									{#if o.asset === 'USDT'}
										<!-- Part 121 — live USDT/USD price subline.
										     Compact mode (no border) for in-row
										     placement.  Pegging health is news. -->
										<UsdtPriceSubline compact />
									{/if}
									{#if accountIsBlocked}
										<span
											class="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
										>
											{$_('orderbook.blocked_marker')}
										</span>
									{:else if accountIsHidden}
										<span
											class="rounded-full bg-ink-200 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-700 dark:bg-ink-800 dark:text-ink-300"
										>
											{$_('orderbook.hidden_marker')}
										</span>
									{/if}
								</div>
								<div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
									<IdentityLabel
										account={o.account}
										displayName={labelProps.displayName}
										avatarSvg={labelProps.avatarSvg}
										avatarDataUri={labelProps.avatarDataUri}
										nostrUrl={labelProps.nostrUrl}
										blurtMediaUrl={labelProps.blurtMediaUrl}
										href={`/@${o.account}`}
									/>
									{#if o.is_new_trader}
										<NewTraderChip />
									{/if}
									<RatingChip count={o.feedback_count ?? 0} rating={o.weighted_rating ?? null} />
									{#if (o.engagement_24h ?? 0) > 0}
										<!-- #5 — real-time engagement signal.  When
										     other users are actively messaging the
										     seller about THIS order, surface that
										     so the current viewer knows they're
										     not alone.  The chip pulses gently at
										     count >= 2 (the "competition is real"
										     tier) so a passing glance catches it.
										     Hidden entirely at 0; caller checks
										     before rendering. -->
										<EngagementChip count={o.engagement_24h ?? 0} />
									{/if}
									{#if o.expires_at}
										<!-- #6 — countdown chip with three tiers
										     (far / near / urgent).  Goes bold-red +
										     pulse at < 15 min so users feel the
										     deadline. -->
										<OrderExpiryChip expiresAt={o.expires_at} />
									{/if}
								</div>
								{#if o.location_region}
									<p class="mt-1 text-xs text-ink-500">
										<span class="font-semibold">{$_('orderbook.order.region_label')}:</span>
										{o.location_region}
									</p>
								{/if}
								{#if o.payment_methods.length > 0}
									<p class="mt-1 text-xs text-ink-500">
										<span class="font-semibold">{$_('orderbook.order.payment_label')}:</span>
										{displayNamesForMethods(o.payment_methods, instLookup).join(', ')}
									</p>
								{/if}
								{#if o.terms}
									<p class="mt-2 text-sm text-ink-700 dark:text-ink-200">
										{o.terms}
									</p>
								{/if}
							</div>
							<div
								class="flex flex-none flex-col items-end gap-2 text-xs text-ink-500 sm:text-right"
							>
								<span>
									{$_('orderbook.order.updated_prefix')}
									<RelativeTime iso={o.updated_at} format="terse" />
								</span>
								{#if !accountIsHidden && !accountIsBlocked && viewerAccount !== null && viewerAccount !== o.account}
									<!-- Message CTA: deep-links to /chat/[peer].
									     Only shown when the viewer is signed in
									     AND the order isn't theirs.  Anonymous
									     viewers don't see this — the profile
									     page is where they're nudged to onboard
									     (since chat fundamentally requires an
									     account).

									     Task #14 — fire-and-forget viewcount POST
									     on click.  Clicking Message indicates
									     real interest, so this is the right
									     trigger (vs. firing on every scroll-into-
									     view event).  The POST is non-blocking
									     and never surfaces errors; navigation
									     proceeds normally. -->
									<a
										href={`/chat/${o.account}?order=${encodeURIComponent(o.permlink)}`}
										class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-morphit-emerald hover:bg-morphit-emerald/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
										aria-label={$_('chat.message_button_aria', {
											values: { peer: o.account }
										})}
										onclick={() => {
											void recordOrderView(o.account, o.permlink);
										}}
									>
										<span aria-hidden="true">💬</span>
										{$_('chat.message_button_label')}
									</a>
								{/if}
								{#if !accountIsHidden && !accountIsBlocked}
									<!-- Per-row hide affordance. Reversible
									     via Settings; tooltip explains this
									     is local-only (no ban, no signal
									     to the hidden user).  Suppressed
									     when the user has already chain-
									     blocked this account — they've
									     done a stronger version already. -->
									<button
										type="button"
										onclick={() => hideAccount(o.account)}
										title={$_('orderbook.hide_button_tooltip')}
										class="rounded px-2 py-1 text-ink-400 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
										aria-label={$_('orderbook.hide_button_aria', {
											values: { account: o.account }
										})}
									>
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
											<path d="m15 18-.722-3.25" />
											<path d="M2 8a10.645 10.645 0 0 0 20 0" />
											<path d="m20 15-1.726-2.05" />
											<path d="m4 15 1.726-2.05" />
											<path d="m9 18 .722-3.25" />
										</svg>
									</button>
								{/if}
							</div>
						</div>
					</li>
				{/each}
			</ul>

			{#if cursor}
				<div class="mt-6 flex justify-center">
					<BusyButton
						variant="secondary"
						busy={loadingMore}
						busyLabel={$_('orderbook.load_more_pending')}
						onclick={loadMore}
					>
						{$_('orderbook.load_more')}
					</BusyButton>
				</div>
			{/if}

			<p class="mt-4 text-center text-xs text-ink-400">
				{$_('orderbook.indexed_block_label')}: #{indexedBlock}
			</p>
		{/if}
	{/if}
</div>
